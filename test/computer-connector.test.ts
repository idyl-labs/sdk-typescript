// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { computerConnector } from "../src/computer-connection/connector.js";
import type {
  ComputerConnector,
  ConnectorApi,
  SessionOpen,
  SessionOutput,
  WorkerPort,
} from "../src/computer-connection/connector.js";
import type {
  PageToWorker,
  WorkerToPage,
} from "../src/computer-connection/messages.js";
import {
  SESSION_TRUST_TYPE,
  SessionTrustError,
} from "../src/computer-connection/trust.js";
import {
  memoryTrustFloor,
  type TrustFloor,
} from "../src/computer-connection/trust-floor.js";
import { FakeIndexedDb } from "./fakes/indexeddb.js";
import { json } from "./fakes/control-plane.js";
import { accountId, subnetSlug } from "./fakes/fetch-queue.js";
import { FakeNetwork } from "./fakes/network.js";
import type {
  SessionTrustResponse,
  TrustKey,
} from "../src/computer-connection/trust.js";
import {
  ERROR_CODE_SESSION_FINAL,
  type ComputerSession as ServedSession,
  type CreateComputerSessionRequest,
} from "../src/api/computer-session.js";
import { encodeBase64 } from "../src/resource/base64.js";
import { FrameError } from "../src/computer-connection/frames.js";
import { ApiError, ComputerNotAwakeError } from "../src/errors.js";
import { ComputerSessionEndedError } from "../src/index.js";
import type { FolderListing } from "../src/computer-connection/files.js";
import { computerEndpointApi } from "../src/services/computer-endpoint-sessions.js";
import {
  FakeControlPlane,
  errorResponse,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";

const enc = new TextEncoder();
const COMPUTER = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const NODE = "ERERERERERERERERERERERERERERERERERERERERERE";

async function signedTrust(
  version = 1,
  zone = "zone-a",
): Promise<{
  key: TrustKey;
  response: SessionTrustResponse;
}> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const payload = enc.encode(
    JSON.stringify({
      type: SESSION_TRUST_TYPE,
      network: "example.test",
      zone,
      version,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      pod: {
        generations: [{ certificateDer: encodeBase64(Uint8Array.of(1)) }],
      },
      dataFabric: {
        endpoint: "data.zone-a.zone.example.test:443",
        serverId: "spiffe://zone-a.zone.example.test/fabric/data",
        serverRoots: `-----BEGIN CERTIFICATE-----\n${encodeBase64(Uint8Array.of(2))}\n-----END CERTIFICATE-----`,
      },
    }),
  );
  const message = new Uint8Array([
    ...enc.encode(`${SESSION_TRUST_TYPE}\n`),
    ...payload,
  ]);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message),
  );
  return {
    key: { keyId: "k1", publicKey: raw },
    response: {
      bundle: {
        payload: encodeBase64(payload),
        signatures: [{ keyId: "k1", signature: encodeBase64(signature) }],
      },
    },
  };
}

function frame(json: unknown): Uint8Array {
  const body = enc.encode(JSON.stringify(json));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

/**
 * A Worker that answers like the real one: it docks, opens lanes and
 * Computer connections, and runs an endpoint that answers `open` with
 * `opened` and echoes stdin as stdout. Every request is recorded.
 */
class FakeWorker implements WorkerPort {
  readonly requests: PageToWorker[] = [];
  /**
   * What the next Computer connections reach, in order: an epoch or a
   * refusal; after the list, epoch 12.
   */
  readonly next: ({ epoch: number } | { refuse: string })[] = [];
  /** The frames each stream was sent, as JSON, by stream handle. */
  readonly sent = new Map<number, unknown[]>();
  /** The frame the endpoint answers each `open` with. */
  answerOpen: unknown = { type: "opened", session: "s-1" };
  #listener: ((event: MessageEvent<WorkerToPage>) => void) | undefined;
  #last: { dock: number; computer: number; stream: number } | undefined;
  #handle = 1;
  #dock = 0;
  readonly #ended = new Set<number>();

  /** Sends `json` as one frame on the last stream opened. */
  deliver(json: unknown): void {
    if (this.#last === undefined) throw new Error("no stream is open");
    this.#emit({ type: "data", ...this.#last, bytes: frame(json) });
  }

  /** Ends the last stream opened, as the Computer ending it does. */
  endStream(): void {
    if (this.#last === undefined) throw new Error("no stream is open");
    this.#emit({ type: "stream-ended", ...this.#last, broken: false });
  }

  /** Ends the current dock, as a closed WebSocket does. */
  endDock(retryAfterMs?: number): void {
    this.#ended.add(this.#dock);
    this.#emit({
      type: "dock-ended",
      dock: this.#dock,
      reason: "connection closed",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<WorkerToPage>) => void,
  ): void {
    this.#listener = listener;
  }

  postMessage(message: PageToWorker): void {
    this.requests.push(message);
    queueMicrotask(() => {
      this.#answer(message);
    });
  }

  #emit(message: WorkerToPage): void {
    this.#listener?.({ data: message } as MessageEvent<WorkerToPage>);
  }

  #answer(m: PageToWorker): void {
    const reply = (value?: unknown): void => {
      this.#emit({ type: "reply", ref: m.ref, value });
    };
    if ("dock" in m && this.#ended.has(m.dock)) {
      this.#emit({ type: "reply", ref: m.ref, error: "no such dock" });
      return;
    }
    switch (m.type) {
      case "start":
        reply();
        this.#emit({
          type: "key",
          certificateRequest: Uint8Array.of(9, 9),
          publicKey: Uint8Array.of(7),
        });
        return;
      case "dock": {
        const dock = ++this.#dock;
        reply(dock);
        this.#emit({ type: "docked", dock });
        return;
      }
      case "open-lane": {
        const lane = this.#handle++;
        reply(lane);
        this.#emit({ type: "lane-ready", dock: m.dock, lane });
        return;
      }
      case "open-computer": {
        const computer = this.#handle++;
        reply(computer);
        const next = this.next.shift() ?? { epoch: 12 };
        if ("epoch" in next) {
          this.#emit({
            type: "computer-established",
            dock: m.dock,
            computer,
            epoch: String(next.epoch),
          });
        } else {
          this.#emit({
            type: "computer-ended",
            dock: m.dock,
            computer,
            reason: next.refuse,
            refusal: 3,
          });
        }
        return;
      }
      case "open-stream": {
        const stream = this.#handle++;
        reply(stream);
        return;
      }
      case "write": {
        reply();
        const text = new TextDecoder().decode(m.bytes.subarray(4));
        const sent = JSON.parse(text) as { type: string; data?: string };
        const log = this.sent.get(m.stream) ?? [];
        log.push(sent);
        this.sent.set(m.stream, log);
        if (sent.type === "open") {
          this.#last = { dock: m.dock, computer: m.computer, stream: m.stream };
          this.#emit({
            type: "data",
            dock: m.dock,
            computer: m.computer,
            stream: m.stream,
            bytes: frame(this.answerOpen),
          });
        } else if (sent.type === "stdin") {
          this.#emit({
            type: "data",
            dock: m.dock,
            computer: m.computer,
            stream: m.stream,
            bytes: frame({ type: "stdout", data: sent.data }),
          });
        }
        return;
      }
      default:
        reply();
    }
  }
}

function served(
  request: CreateComputerSessionRequest,
  epoch = 12,
  sequence = 3,
): ServedSession {
  return {
    id: "01954e20-7540-7ec4-93ec-14f783e6ab20" as ServedSession["id"],
    computer: COMPUTER as ServedSession["computer"],
    spec: request,
    status: {
      phase: "ready",
      readyBy: "2026-01-02T03:06:05Z",
      endpoint: {
        requestId: request.idempotencyKey ?? "",
        mode: request.endpoint?.mode ?? "",
        epoch,
        runtimeInstance: "task-3",
        placement: {
          node: NODE,
          hostPod: "01954e20-7540-7ec4-93ec-14f783e6ab17",
          sequence,
        },
      },
    },
  };
}

interface Harness {
  readonly connector: ComputerConnector;
  readonly worker: FakeWorker;
  readonly creates: CreateComputerSessionRequest[];
  /** The session reads the connector made, in order. */
  readonly reads: {
    readonly computer: string;
    readonly session: string;
    readonly signal: AbortSignal;
  }[];
  release: (() => void) | undefined;
}

/**
 * One answer of the fake session read: the session as it now is, derived
 * from the session the create's request would serve ready, or a failure.
 */
type ReadAnswer = (session: ServedSession) => ServedSession | Error;

async function harness(
  options: {
    holdCreate?: boolean;
    answer?: (session: ServedSession) => ServedSession;
    known?: { epoch: number; sequence: number };
    failTrustOnce?: boolean;
    refuseCreate?: Error;
    renewals?: string[][];
    renew?: ConnectorApi["renewSessions"];
    /** Records each cancel as [computer, session]. */
    cancels?: string[][];
    client?: "sdk" | "console" | "cli";
    trustVersion?: number;
    trustZone?: string;
    scope?: string;
    trustFloor?: TrustFloor | "default";
    pinAnotherKey?: boolean;
    build?: typeof computerConnector;
    /** The reads' answers in order; the last one repeats. */
    reads?: readonly ReadAnswer[];
  } = {},
): Promise<Harness> {
  const trust = await signedTrust(options.trustVersion, options.trustZone);
  const pinned =
    options.pinAnotherKey === true ? (await signedTrust()).key : trust.key;
  const worker = new FakeWorker();
  const h: Harness = {
    connector: undefined as unknown as ComputerConnector,
    worker,
    creates: [],
    reads: [],
    release: undefined,
  };
  const api: ConnectorApi = {
    certify: (request) => {
      expect(request).toEqual(Uint8Array.of(9, 9));
      return Promise.resolve({
        chain: [Uint8Array.of(5)],
        admissionLease: Uint8Array.of(6),
        notAfterMs: Date.now() + 3_600_000,
      });
    },
    sessionTrust: () => {
      if (options.failTrustOnce === true) {
        options.failTrustOnce = false;
        return Promise.reject(new Error("unavailable"));
      }
      return Promise.resolve({
        scope: options.scope ?? "zone-a",
        response: trust.response,
      });
    },
    createSession: (_computer, request) => {
      h.creates.push(request);
      if (options.refuseCreate !== undefined) {
        return Promise.reject(options.refuseCreate);
      }
      const answer = (options.answer ?? ((s) => s))(served(request));
      if (!options.holdCreate) return Promise.resolve(answer);
      return new Promise((resolve) => {
        h.release = () => {
          resolve(answer);
        };
      });
    },
    readSession: (computer, session, signal) => {
      h.reads.push({ computer, session, signal });
      const answers = options.reads ?? [];
      const answer = answers[Math.min(h.reads.length, answers.length) - 1];
      const request = h.creates.at(-1);
      if (answer === undefined || request === undefined) {
        return Promise.reject(new Error("the test states no read answer"));
      }
      const read = answer(served(request));
      return read instanceof Error
        ? Promise.reject(read)
        : Promise.resolve(read);
    },
    renewSessions: (computer, sessions) => {
      options.renewals?.push([...sessions]);
      return options.renew?.(computer, sessions) ?? Promise.resolve([]);
    },
    cancelSession: (computer, session) => {
      options.cancels?.push([computer, session]);
      return Promise.resolve();
    },
  };
  const known = options.known;
  const build = options.build ?? computerConnector;
  (h as { connector: ComputerConnector }).connector = build({
    worker,
    module: {},
    network: "example.test",
    trustKeys: [pinned],
    ...(options.trustFloor === "default"
      ? {}
      : { trustFloor: options.trustFloor ?? memoryTrustFloor() }),
    account: () => Promise.resolve("550000000001"),
    api,
    ...(options.client === undefined ? {} : { client: options.client }),
    edgeUrl: (zone) =>
      `wss://edge.${zone}.zone.example.test/hyperplane/fallback/1`,
    ...(known === undefined
      ? {}
      : {
          placements: {
            load: () =>
              JSON.stringify({
                requestId: "old",
                mode: "shell",
                epoch: known.epoch,
                runtimeInstance: "task-2",
                placement: {
                  node: NODE,
                  hostPod: "01954e20-7540-7ec4-93ec-14f783e6ab17",
                  sequence: known.sequence,
                },
              }),
            save: () => undefined,
          },
        }),
  });
  return h;
}

/** What a terminal session states. */
const TERMINAL = {
  tty: true,
  size: { cols: 80, rows: 24 },
  term: "xterm",
} as const;

async function first(
  output: ReadableStream<SessionOutput>,
  n: number,
): Promise<SessionOutput[]> {
  const reader = output.getReader();
  const out: SessionOutput[] = [];
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  reader.releaseLock();
  return out;
}

describe("computer connector", () => {
  // Contract: ready docks with the certificate issued for the Worker's
  // request, to the Zone's edge named by the verified trust.
  it("docks with the issued certificate at the trusted edge", async () => {
    const { connector, worker } = await harness();
    await connector.ready();
    const dock = worker.requests.find((r) => r.type === "dock");
    expect(dock).toMatchObject({
      type: "dock",
      url: "wss://edge.zone-a.zone.example.test/hyperplane/fallback/1",
      serverName: "data.zone-a.zone.example.test",
      edgeId: "spiffe://zone-a.zone.example.test/fabric/data",
      chain: [Uint8Array.of(5)],
      lease: Uint8Array.of(6),
    });
  });

  // Contract: a reader that cancels the output ends it: a later end of the
  // stream reaches nothing and throws nothing.
  it("takes a stream's end after its output was cancelled", async () => {
    const { connector, worker } = await harness();
    const session = await connector.open(COMPUTER, {
      mode: "exec",
      command: ["true"],
    });
    await session.output.cancel();
    expect(() => {
      worker.endStream();
    }).not.toThrow();
  });

  // Contract: with no place known, the session waits for the create, then
  // opens the lane to the answered machine's data dock, the connection to the
  // answered Micropod and Activation, and a stream whose open names the
  // create's request ID; output flows back as frames.
  it("opens a session where the create placed it", async () => {
    const { connector, worker, creates } = await harness();
    const session = await connector.open(COMPUTER, {
      mode: "shell",
      tty: true,
      size: { cols: 80, rows: 24 },
      term: "xterm",
    });
    expect(creates[0]).toMatchObject({
      attachment: "endpoint",
      endpoint: { mode: "shell" },
      idempotencyKey: session.requestId,
    });
    expect(worker.requests.find((r) => r.type === "open-lane")).toMatchObject({
      principal: `spiffe://zone-a.zone.example.test/node/${NODE}/data-dock`,
    });
    expect(
      worker.requests.find((r) => r.type === "open-computer"),
    ).toMatchObject({
      hostPod: "01954e20-7540-7ec4-93ec-14f783e6ab17",
      sequence: "3",
      epoch: "12",
      minEpoch: "12",
      trustDomain: "zone-a.zone.example.test",
      account: "550000000001",
      computer: COMPUTER,
    });
    const open = worker.requests.find((r) => r.type === "write");
    const text = new TextDecoder().decode(
      (open as { bytes: Uint8Array }).bytes.subarray(4),
    );
    expect(JSON.parse(text)).toMatchObject({
      type: "open",
      requestID: session.requestId,
      mode: "shell",
      tty: true,
    });
    session.write(enc.encode("hi"));
    expect(await first(session.output, 2)).toEqual([
      { type: "opened", session: "s-1" },
      { type: "stdout", data: enc.encode("hi") },
    ]);
  });

  // Contract: a create answered pending with the session's endpoint, bound
  // to the Activation that will serve it, is connected to at once, as a
  // ready one is: the lane, the connection and the stream go to the place
  // the pending answer names, and the session keeps that answer's ID.
  it("opens a session where a pending answer placed it", async () => {
    const { connector, worker } = await harness({
      answer: (s) => ({
        ...s,
        status: { ...s.status, phase: "pending", reason: "Waking" },
      }),
    });
    const session = await connector.open(COMPUTER, {
      mode: "shell",
      tty: true,
      size: { cols: 80, rows: 24 },
      term: "xterm",
    });
    expect(
      worker.requests.find((r) => r.type === "open-computer"),
    ).toMatchObject({
      hostPod: "01954e20-7540-7ec4-93ec-14f783e6ab17",
      sequence: "3",
      epoch: "12",
    });
    expect(worker.requests.some((r) => r.type === "write")).toBe(true);
    await Promise.resolve();
    expect(session.id).toBe("01954e20-7540-7ec4-93ec-14f783e6ab20");
  });

  // Contract: a create that answers with the session's endpoint, ready or
  // pending, is connected to with no read of the session.
  it("reads no session a create answered with its endpoint", async () => {
    for (const phase of ["ready", "pending"] as const) {
      const h = await harness({
        answer: (s) => ({ ...s, status: { ...s.status, phase } }),
      });
      await h.connector.open(COMPUTER, { mode: "exec", command: ["true"] });
      expect(h.reads).toEqual([]);
      expect(
        h.worker.requests.filter((r) => r.type === "open-computer"),
      ).toHaveLength(1);
    }
  });

  // Contract: an open asks only for the features its mode takes at the
  // endpoint: an exec asks for its save result; a shell and a cell ask for
  // none, so the endpoint never refuses them for a feature.
  it("asks for the features each mode takes", async () => {
    const features = new Map<string, unknown>();
    for (const mode of ["shell", "exec", "cell"] as const) {
      const { connector, worker } = await harness();
      await connector.open(COMPUTER, {
        mode,
        ...(mode === "shell" ? TERMINAL : {}),
        ...(mode === "exec" ? { command: ["true"] } : {}),
        ...(mode === "cell" ? { notebook: "notes", script: "true" } : {}),
      });
      const open = worker.requests.find((r) => r.type === "write");
      const text = new TextDecoder().decode(
        (open as { bytes: Uint8Array }).bytes.subarray(4),
      );
      features.set(mode, (JSON.parse(text) as { features?: unknown }).features);
    }
    expect(Object.fromEntries(features)).toEqual({
      shell: undefined,
      exec: ["save-result"],
      cell: undefined,
    });
  });

  // Contract: with the Computer's place known, the stream is sent without
  // waiting for the create: the create and the stream travel together.
  it("sends the stream before the create answers when the place is known", async () => {
    const h = await harness({
      holdCreate: true,
      known: { epoch: 12, sequence: 3 },
    });
    const session = await h.connector.open(COMPUTER, {
      mode: "shell",
      tty: true,
      size: { cols: 80, rows: 24 },
      term: "xterm",
    });
    expect(h.release).toBeDefined();
    expect(h.worker.requests.some((r) => r.type === "write")).toBe(true);
    expect(session.id).toBeUndefined();
    h.release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.id).toBe("01954e20-7540-7ec4-93ec-14f783e6ab20");
  });

  // Contract: a stale place is refused fast, and the session reopens where
  // the create answered.
  it("reopens at the answered place after a stale one", async () => {
    const h = await harness({ known: { epoch: 11, sequence: 2 } });
    h.worker.next.push({ refuse: "stale-epoch" });
    const session = await h.connector.open(COMPUTER, {
      mode: "shell",
      tty: true,
      size: { cols: 80, rows: 24 },
      term: "xterm",
    });
    const computers = h.worker.requests.filter(
      (r) => r.type === "open-computer",
    );
    expect(computers.map((c) => (c as { epoch: string }).epoch)).toEqual([
      "11",
      "12",
    ]);
    expect(await first(session.output, 1)).toEqual([
      { type: "opened", session: "s-1" },
    ]);
  });

  // Contract: when the dock ends, its sessions end as broken, and the next
  // session docks again with a new certificate and opens its own lane and
  // connection instead of using the ended dock.
  it("docks again for the next session after the dock ends", async () => {
    const { connector, worker } = await harness();
    const before = await connector.open(COMPUTER, {
      mode: "shell",
      ...TERMINAL,
    });
    expect(await first(before.output, 1)).toEqual([
      { type: "opened", session: "s-1" },
    ]);
    worker.endDock();
    expect(await first(before.output, 2)).toEqual([{ type: "broken" }]);
    const after = await connector.open(COMPUTER, {
      mode: "shell",
      ...TERMINAL,
    });
    after.write(enc.encode("hi"));
    expect(await first(after.output, 2)).toEqual([
      { type: "opened", session: "s-1" },
      { type: "stdout", data: enc.encode("hi") },
    ]);
    const docks = worker.requests.filter((r) => r.type === "dock");
    expect(docks).toHaveLength(2);
    expect(worker.requests.filter((r) => r.type === "start")).toHaveLength(1);
    const lanes = worker.requests.filter((r) => r.type === "open-lane");
    expect(lanes.map((r) => (r as { dock: number }).dock)).toEqual([1, 2]);
    const streams = worker.requests.filter((r) => r.type === "open-stream");
    expect(streams.map((r) => (r as { dock: number }).dock)).toEqual([1, 2]);
  });

  // Contract: a dock that could not be made is not kept; the next session
  // tries again.
  it("tries to dock again after a failed dock", async () => {
    const { connector, worker } = await harness({ failTrustOnce: true });
    await expect(connector.ready()).rejects.toThrow("unavailable");
    await connector.ready();
    expect(worker.requests.filter((r) => r.type === "dock")).toHaveLength(1);
    expect(worker.requests.filter((r) => r.type === "start")).toHaveLength(1);
  });
});

/** `session` pending and not yet bound to an Activation: no endpoint. */
function unbound(session: ServedSession): ServedSession {
  return {
    ...session,
    status: {
      phase: "pending",
      reason: "Waking",
      readyBy: session.status.readyBy,
    },
  };
}

/** `unbound(session)` with the readyBy the platform states for it. */
function unboundUntil(session: ServedSession, readyBy: string): ServedSession {
  const pending = unbound(session);
  return { ...pending, status: { ...pending.status, readyBy } };
}

/** `session` cancelled by a sleep before it started: no endpoint. */
function putToSleep(session: ServedSession): ServedSession {
  return {
    ...session,
    status: {
      phase: "cancelled",
      reason: "PutToSleep",
      readyBy: session.status.readyBy,
    },
  };
}

/** The open's rejection, or `undefined` when it opened. */
async function refusal(opening: Promise<unknown>): Promise<unknown> {
  return await opening.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("a pending answer without its endpoint", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Contract: a create answered pending without the session's endpoint, as
  // while the Computer's previous Activation is released after it went to
  // sleep, is read again on the session's read route until the session
  // names its endpoint; a read that failed in passing is tried again; the
  // open then connects where the read placed the session, and the session
  // keeps the create's ID.
  it("opens where the session is bound once a read names its endpoint", async () => {
    const h = await harness({
      answer: unbound,
      reads: [
        () => new ApiError({ status: 503, message: "", code: "UNAVAILABLE" }),
        unbound,
        (s) => s,
      ],
    });
    const session = await h.connector.open(COMPUTER, {
      mode: "shell",
      ...TERMINAL,
    });
    expect(
      h.reads.map(({ computer, session }) => ({ computer, session })),
    ).toEqual(
      Array(3).fill({
        computer: COMPUTER,
        session: "01954e20-7540-7ec4-93ec-14f783e6ab20",
      }),
    );
    expect(
      h.worker.requests.filter((r) => r.type === "open-computer"),
    ).toMatchObject([
      { hostPod: "01954e20-7540-7ec4-93ec-14f783e6ab17", epoch: "12" },
    ]);
    expect(await first(session.output, 1)).toEqual([
      { type: "opened", session: "s-1" },
    ]);
    expect(session.id).toBe("01954e20-7540-7ec4-93ec-14f783e6ab20");
  });

  // Contract: after the Computer went to sleep, the place the client knew
  // refuses the connection, and the open connects where the session's
  // read places it once it is bound.
  it("reopens where the session is bound after a stale place", async () => {
    const h = await harness({
      known: { epoch: 11, sequence: 2 },
      answer: unbound,
      reads: [(s) => s],
    });
    h.worker.next.push({ refuse: "stale-epoch" });
    const session = await h.connector.open(COMPUTER, {
      mode: "shell",
      ...TERMINAL,
    });
    expect(
      h.worker.requests
        .filter((r) => r.type === "open-computer")
        .map((r) => (r as { epoch: string }).epoch),
    ).toEqual(["11", "12"]);
    expect(h.reads).toHaveLength(1);
    expect(await first(session.output, 1)).toEqual([
      { type: "opened", session: "s-1" },
    ]);
  });

  // Contract: a session read final without its endpoint, as one a sleep
  // cancelled before it started, rejects the open with a
  // ComputerSessionEndedError carrying its ID, phase and reason, and no
  // connection is opened; a create that answers so is not read at all.
  it("rejects with the ended session when it is final", async () => {
    const read = await harness({ answer: unbound, reads: [putToSleep] });
    const answered = await harness({ answer: putToSleep });
    for (const h of [read, answered]) {
      const error = await refusal(
        h.connector.open(COMPUTER, { mode: "exec", command: ["true"] }),
      );
      expect(error).toBeInstanceOf(ComputerSessionEndedError);
      expect(error).toMatchObject({
        name: "ComputerSessionEndedError",
        session: "01954e20-7540-7ec4-93ec-14f783e6ab20",
        phase: "cancelled",
        reason: "PutToSleep",
        message:
          "the Computer session 01954e20-7540-7ec4-93ec-14f783e6ab20 ended before it opened: cancelled (PutToSleep)",
      });
      expect(h.worker.requests.some((r) => r.type === "open-computer")).toBe(
        false,
      );
    }
    expect(read.reads).toHaveLength(1);
    expect(answered.reads).toEqual([]);
  });

  // Contract: a stream sent to the Computer's known place before the
  // create answered fails with the ComputerSessionEndedError as soon as the
  // create answers the session final without its endpoint.
  it("fails a stream already sent when the session ended", async () => {
    const h = await harness({
      known: { epoch: 12, sequence: 3 },
      answer: putToSleep,
    });
    const session = await h.connector.open(COMPUTER, {
      mode: "shell",
      ...TERMINAL,
    });
    const reader = session.output.getReader();
    const ending = await (async (): Promise<unknown> => {
      for (;;) {
        const step = await reader.read().then(
          (r) => r,
          (error: unknown) => ({ error }),
        );
        if ("error" in step) return step.error;
        if (step.done) return undefined;
      }
    })();
    expect(ending).toBeInstanceOf(ComputerSessionEndedError);
    expect(h.reads).toEqual([]);
  });

  // Contract: the reads are bounded: a session still unbound 30 s after
  // its create answered, its readyBy already past, rejects the open with a
  // TimeoutError naming that readyBy, the reads' pauses grow from 100 ms to
  // at most 1 s, and no connection is opened.
  it("gives up on a session that stays unbound", async () => {
    const h = await harness({ answer: unbound, reads: [unbound] });
    await h.connector.ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opening = refusal(
      h.connector.open(COMPUTER, { mode: "exec", command: ["true"] }),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.reads.length).toBeGreaterThan(20);
    expect(h.reads.length).toBeLessThan(40);
    await vi.advanceTimersByTimeAsync(1);
    const error = await opening;
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "TimeoutError",
      message:
        "computer session 01954e20-7540-7ec4-93ec-14f783e6ab20 was not bound to an Activation by its ready-by time 2026-01-02T03:06:05Z",
    });
    expect(h.reads.every(({ signal }) => signal.aborted)).toBe(true);
    expect(h.worker.requests.some((r) => r.type === "open-computer")).toBe(
      false,
    );
  });

  // Contract: a session whose readyBy is still ahead is read past 30 s, as
  // while its Computer's files are fetched: the platform keeps it pending
  // only while the wake makes progress, so the open connects once a read
  // names the session's endpoint instead of giving up.
  it("waits past 30 s while the session's readyBy is ahead", async () => {
    const ahead = new Date(Date.now() + 60_000).toISOString();
    const pending = (s: ServedSession): ServedSession => unboundUntil(s, ahead);
    const h = await harness({
      answer: pending,
      reads: [...Array<ReadAnswer>(40).fill(pending), (s) => s],
    });
    await h.connector.ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let settled = false;
    const opening = h.connector
      .open(COMPUTER, { mode: "exec", command: ["true"] })
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();
    const session = await opening;
    expect(h.reads.length).toBe(41);
    expect(
      h.worker.requests.filter((r) => r.type === "open-computer"),
    ).toHaveLength(1);
    session.close();
  });

  // Contract: a pending session's readyBy moves forward while its wake
  // makes progress; the reads follow the latest one read and stop once it
  // has passed by 30 s, rejecting with a TimeoutError naming that readyBy.
  it("follows a moving readyBy and then gives up", async () => {
    const first = Date.now() + 5_000;
    const moved = first + 30_000;
    const iso = (ms: number): string => new Date(ms).toISOString();
    const h = await harness({
      answer: (s) => unboundUntil(s, iso(first)),
      reads: [(s) => unboundUntil(s, iso(moved))],
    });
    await h.connector.ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let settled = false;
    const opening = refusal(
      h.connector
        .open(COMPUTER, { mode: "exec", command: ["true"] })
        .finally(() => {
          settled = true;
        }),
    );
    // The first readyBy's bound, 35 s, has passed; the moved one holds.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await opening;
    const named = new Date(Math.floor(moved / 1_000) * 1_000)
      .toISOString()
      .replace(".000Z", "Z");
    expect(error).toMatchObject({
      name: "TimeoutError",
      message: `computer session 01954e20-7540-7ec4-93ec-14f783e6ab20 was not bound to an Activation by its ready-by time ${named}`,
    });
    expect(h.worker.requests.some((r) => r.type === "open-computer")).toBe(
      false,
    );
  });

  // Contract: closing the connector ends the reads at once: the open
  // rejects with an AbortError and no read follows.
  it("stops reading when the connector closes", async () => {
    const h = await harness({ answer: unbound, reads: [unbound] });
    await h.connector.ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opening = refusal(
      h.connector.open(COMPUTER, { mode: "exec", command: ["true"] }),
    );
    await vi.advanceTimersByTimeAsync(350);
    const reads = h.reads.length;
    expect(reads).toBe(2);
    h.connector.close();
    expect(await opening).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.reads).toHaveLength(reads);
  });

  // Contract: a read that the platform refuses for good, such as HTTP 404,
  // fails the open with that refusal, and no read follows it.
  it("fails the open on a read the platform refuses", async () => {
    const gone = new ApiError({
      status: 404,
      message: "",
      code: "COMPUTER_SESSION_NOT_FOUND",
    });
    const h = await harness({ answer: unbound, reads: [() => gone] });
    expect(
      await refusal(
        h.connector.open(COMPUTER, { mode: "exec", command: ["true"] }),
      ),
    ).toBe(gone);
    expect(h.reads).toHaveLength(1);
  });

  // Contract: the connector reads a session with one GET on its
  // Computer's by-ID session route, and refuses an answer naming another
  // session.
  it("reads the session on its by-ID route", async () => {
    const id = "01954e20-7540-7ec4-93ec-14f783e6ab20";
    const sessions = `${namespacePathPrefix}/computers/by-id/${COMPUTER}/sessions/`;
    const path = `${sessions}${id}`;
    const body = served({
      operation: "shell",
      attachment: "endpoint",
      endpoint: { mode: "exec" },
      idempotencyKey: "request-1",
    });
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost &&
        request.url.pathname.startsWith(sessions)
          ? json(body)
          : undefined,
    });
    const { context } = plane.client();
    const api = computerEndpointApi(() => Promise.resolve(context));
    const signal = new AbortController().signal;
    expect(await api.readSession(COMPUTER, id, signal)).toEqual(body);
    const sent = plane.subnetRequests();
    expect(sent.map((r) => [r.method, r.url.pathname])).toEqual([
      ["GET", path],
    ]);
    await expect(
      api.readSession(COMPUTER, "01954e20-7540-7ec4-93ec-14f783e6ab21", signal),
    ).rejects.toThrow(
      "read computer session response names a different session",
    );
  });
});

describe("computer files sessions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Contract: a files session is created as an endpoint session of mode
  // `files` naming no notebook, and its stream opens with mode `files`,
  // no terminal and no features, exactly the published open.
  it("opens a files session", async () => {
    const { connector, worker, creates } = await harness();
    await connector.openFiles(COMPUTER, { onListing: () => undefined });
    expect(creates).toHaveLength(1);
    expect(creates[0]?.endpoint).toEqual({ mode: "files" });
    expect(creates[0]?.notebook).toBeUndefined();
    const [open] = [...worker.sent.values()][0] ?? [];
    expect(open).toEqual({
      type: "open",
      profile: "workload-session/json-v2",
      requestID: creates[0]?.idempotencyKey,
      mode: "files",
      tty: false,
    });
  });

  // Contract: watch and unwatch travel on the session's stream, passes
  // arrive whole, and close sends `end` and finishes the stream.
  it("watches, lists and closes over the stream", async () => {
    const { connector, worker } = await harness();
    const seen: FolderListing[] = [];
    const files = await connector.openFiles(COMPUTER, {
      onListing: (l) => seen.push(l),
    });
    files.watch("src");
    worker.deliver({
      type: "listing",
      path: "src",
      entries: [{ name: "a", type: "file", size: 1, mode: 420, modified: 5 }],
      more: true,
    });
    worker.deliver({ type: "listing", path: "src", entries: [], more: false });
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(seen[0]).toEqual({
      path: "src",
      entries: [{ name: "a", type: "file", size: 1, mode: 420, modified: 5 }],
    });
    files.unwatch("src");
    files.close();
    expect(await files.ended).toEqual({ reason: "closed" });
    const stream = [...worker.sent.keys()][0] ?? 0;
    expect(worker.sent.get(stream)?.slice(1)).toEqual([
      { type: "watch", path: "src" },
      { type: "unwatch", path: "src" },
      { type: "end" },
    ]);
    expect(worker.requests.filter((r) => r.type === "finish")).toHaveLength(1);
  });

  // Contract: a Computer that is not awake refuses the session; it ends
  // failed with the typed refusal.
  it("ends failed when the Computer is not awake", async () => {
    const refusal = new ComputerNotAwakeError({
      status: 409,
      message: "",
      code: "COMPUTER_NOT_AWAKE",
    });
    const { connector } = await harness({
      known: { epoch: 12, sequence: 3 },
      refuseCreate: refusal,
    });
    const files = await connector.openFiles(COMPUTER, {
      onListing: () => undefined,
    });
    expect(await files.ended).toEqual({ reason: "failed", error: refusal });
  });

  // Contract: a files session is renewed with the connector's sessions
  // while open and no longer once closed, including when it is closed
  // before its create answers.
  it("is renewed while open and not after it closes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const renewals: string[][] = [];
    const open = await harness({ renewals });
    const files = await open.connector.openFiles(COMPUTER, {
      onListing: () => undefined,
    });
    vi.advanceTimersByTime(60_000);
    expect(renewals).toEqual([["01954e20-7540-7ec4-93ec-14f783e6ab20"]]);
    files.close();
    vi.advanceTimersByTime(60_000);
    expect(renewals).toHaveLength(1);
    open.connector.close();

    const held: string[][] = [];
    const h = await harness({
      holdCreate: true,
      known: { epoch: 12, sequence: 3 },
      renewals: held,
    });
    const early = await h.connector.openFiles(COMPUTER, {
      onListing: () => undefined,
    });
    early.close();
    h.release?.();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(60_000);
    expect(held).toEqual([]);
    h.connector.close();
  });

  // Contract: a session whose renewal the platform answers with HTTP 404,
  // or with HTTP 409 and SESSION_FINAL, is never renewed again, and its
  // stream is left open for the endpoint to end; a session whose renewal
  // failed with a server error is renewed at the next interval.
  it("stops renewing a session the platform no longer holds", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const [unknown, final, failing] = [
      "01954e20-7540-7ec4-93ec-14f783e6ab21",
      "01954e20-7540-7ec4-93ec-14f783e6ab22",
      "01954e20-7540-7ec4-93ec-14f783e6ab23",
    ] as const;
    const sessions = `${namespacePathPrefix}/computers/by-id/${COMPUTER}/sessions`;
    const plane = new FakeControlPlane({
      routes: (request) => {
        if (request.url.host !== subnetHost) return undefined;
        switch (request.url.pathname) {
          case `${sessions}/${unknown}/renew`:
            return errorResponse(404, "COMPUTER_SESSION_NOT_FOUND", "gone");
          case `${sessions}/${final}/renew`:
            return errorResponse(409, ERROR_CODE_SESSION_FINAL, "ended");
          case `${sessions}/${failing}/renew`:
            return errorResponse(503, "UNAVAILABLE", "unavailable");
          default:
            return undefined;
        }
      },
    });
    const { context } = plane.client();
    const endpoint = computerEndpointApi(() => Promise.resolve(context));
    // The renewals the connector sent, held so the test waits for each
    // round to settle before the next interval.
    const sent: Promise<readonly string[]>[] = [];
    const renewals: string[][] = [];
    const ids = [unknown, final, failing];
    const h = await harness({
      known: { epoch: 12, sequence: 3 },
      answer: (session) => ({
        ...session,
        id: (ids.shift() ?? "") as ServedSession["id"],
      }),
      renewals,
      renew: (computer, held) => {
        const renewed = endpoint.renewSessions(computer, held);
        sent.push(renewed);
        return renewed;
      },
    });
    for (let n = 0; n < 3; n++) {
      await h.connector.open(COMPUTER, {
        mode: "exec",
        command: ["true"],
      });
    }
    await Promise.resolve();
    vi.advanceTimersByTime(60_000);
    await Promise.allSettled(sent.splice(0));
    vi.advanceTimersByTime(60_000);
    await Promise.allSettled(sent.splice(0));
    vi.advanceTimersByTime(60_000);
    await Promise.allSettled(sent.splice(0));
    expect(renewals.map((round) => [...round].sort())).toEqual([
      [unknown, final, failing],
      [failing],
      [failing],
    ]);
    expect(h.worker.requests.filter((r) => r.type === "finish")).toEqual([]);
    h.connector.close();
  });

  // Contract: a session whose stream the endpoint answers first with an
  // error it sends only before a session starts (invalid_request,
  // unsupported, busy, not_granted) is cancelled once and never renewed, so
  // it holds nothing, such as its notebook's turn, until its attach
  // deadline. Any other first error leaves the session to the platform.
  it("cancels a session whose open the endpoint refused before it started", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const id = "01954e20-7540-7ec4-93ec-14f783e6ab20";
    const codes = [
      ["invalid_request", true],
      ["unsupported", true],
      ["busy", true],
      ["not_granted", true],
      ["refused", false],
      ["start_failed", false],
      ["shell_not_found", false],
      ["ended", false],
    ] as const;
    for (const [code, cancels] of codes) {
      const cancelled: string[][] = [];
      const renewals: string[][] = [];
      const h = await harness({ cancels: cancelled, renewals });
      h.worker.answerOpen = { type: "error", code, message: "refused" };
      const session = await h.connector.open(COMPUTER, {
        mode: "cell",
        notebook: "notes",
        script: "echo hi > out.txt",
      });
      expect(await first(session.output, 1)).toEqual([
        { type: "error", code, message: "refused" },
      ]);
      await vi.waitFor(() => {
        expect(session.id).toBe(id);
      });
      expect(cancelled, code).toEqual(cancels ? [[COMPUTER, id]] : []);
      vi.advanceTimersByTime(60_000);
      expect(renewals, code).toEqual(cancels ? [] : [[id]]);
      h.connector.close();
    }
  });

  // Contract: an opened that does not answer its open's mode, as one
  // carrying an SSH host key on a stream that is not ssh, errors the output
  // with a fixed sentence, finishes the stream, and leaves the session
  // unrenewed; the opened of the stream's own mode is taken.
  it("refuses an opened that carries a host key on a stream that is not ssh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const renewals: string[][] = [];
    const h = await harness({ renewals });
    h.worker.answerOpen = {
      type: "opened",
      session: "s-1",
      hostKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBfLefsrQSDysexl5BmNbgiyjoE/6wHkpACDm4XhgIDO",
    };
    const session = await h.connector.open(COMPUTER, {
      mode: "exec",
      command: ["true"],
    });
    const reader = session.output.getReader();
    const read = reader.read();
    await expect(read).rejects.toThrow(
      new FrameError("the endpoint's opened does not answer the stream's mode"),
    );
    const error: unknown = await read.catch((e: unknown) => e);
    expect(String(error)).not.toContain("AAAAC3Nza");
    expect(h.worker.requests.filter((r) => r.type === "finish")).toHaveLength(
      1,
    );
    await vi.waitFor(() => {
      expect(session.id).toBe("01954e20-7540-7ec4-93ec-14f783e6ab20");
    });
    vi.advanceTimersByTime(60_000);
    expect(renewals).toEqual([]);
    h.connector.close();
  });

  // Contract: a refusal that arrives before the create answers cancels the
  // session once the answer names it.
  it("cancels a refused session once its create answers", async () => {
    const cancelled: string[][] = [];
    const h = await harness({
      holdCreate: true,
      known: { epoch: 12, sequence: 3 },
      cancels: cancelled,
    });
    h.worker.answerOpen = { type: "error", code: "not_granted", message: "x" };
    const session = await h.connector.open(COMPUTER, {
      mode: "exec",
      command: ["true"],
    });
    expect(await first(session.output, 1)).toEqual([
      { type: "error", code: "not_granted", message: "x" },
    ]);
    expect(cancelled).toEqual([]);
    h.release?.();
    await vi.waitFor(() => {
      expect(cancelled).toEqual([
        [COMPUTER, "01954e20-7540-7ec4-93ec-14f783e6ab20"],
      ]);
    });
    h.connector.close();
  });

  // Contract: every create states the client the connector was given, and
  // `sdk` when it was given none.
  it("states its client on every create", async () => {
    const plain = await harness();
    await plain.connector.open(COMPUTER, { mode: "exec", command: ["true"] });
    expect(plain.creates[0]?.client).toBe("sdk");
    const named = await harness({ client: "console" });
    await named.connector.open(COMPUTER, {
      mode: "exec",
      command: ["true"],
    });
    expect(named.creates[0]?.client).toBe("console");
  });

  // Contract: an open is judged before anything is sent, its stream as the
  // endpoint judges it and its create as the platform does: a cell or a
  // records stream without its notebook, a notebook on any other mode, a
  // shell without a terminal, a terminal size, type or locale out of
  // bounds, a relative shell, an exec without a command and a records
  // position that is not an integer are refused with no create, no dock
  // and no stream.
  it("refuses an invalid open before anything is sent", async () => {
    const { connector, worker, creates } = await harness();
    const refused: readonly [SessionOpen, string][] = [
      [
        { mode: "cell", script: "true" },
        "a cell or a records stream names its notebook, and only those do",
      ],
      [
        {
          mode: "records",
          notebookId: "01954e20-7540-7ec4-93ec-14f783e6ab30",
        },
        "a cell or a records stream names its notebook, and only those do",
      ],
      [
        { mode: "exec", command: ["true"], notebook: "notes" },
        "a cell or a records stream names its notebook, and only those do",
      ],
      [
        { mode: "shell" },
        "a shell session runs on a terminal and names no command or script",
      ],
      [
        { mode: "shell", tty: true, term: "xterm" },
        "a terminal session states its size, and only a terminal session does",
      ],
      [
        { mode: "exec", command: [] },
        "an exec's command must hold 1 to 1024 arguments",
      ],
      [
        { mode: "cell", notebook: "notes", script: "" },
        "a cell's script must be 1 to 32768 bytes without NUL",
      ],
      [
        { ...TERMINAL, mode: "shell", size: { cols: 0, rows: 24 } },
        "terminal size 0x24 is outside 1 to 10000",
      ],
      [
        { ...TERMINAL, mode: "shell", size: { cols: 80, rows: 10_001 } },
        "terminal size 80x10001 is outside 1 to 10000",
      ],
      [
        { ...TERMINAL, mode: "shell", term: "kitty" },
        "unsupported terminal.type",
      ],
      [
        { ...TERMINAL, mode: "shell", locale: "en US" },
        "terminal.locale is invalid",
      ],
      [
        { ...TERMINAL, mode: "shell", shell: "zsh" },
        'shell "zsh" is not a clean absolute path',
      ],
      [
        {
          mode: "records",
          notebook: "notes",
          notebookId: "01954e20-7540-7ec4-93ec-14f783e6ab30",
          after: 1.5,
        },
        "after must be an integer",
      ],
      [
        {
          mode: "records",
          notebook: "notes",
          notebookId: "01954e20-7540-7ec4-93ec-14f783e6ab30",
          after: -1,
        },
        "after must not be negative",
      ],
      [
        { ...TERMINAL, mode: "shell", shell: "/bin//zsh" },
        'shell "/bin//zsh" is not a clean absolute path',
      ],
    ];
    for (const [open, message] of refused) {
      await expect(connector.open(COMPUTER, open)).rejects.toThrow(
        new TypeError(message),
      );
    }
    expect(creates).toEqual([]);
    expect(worker.requests).toEqual([]);
  });

  // Contract: the connector never opens an ssh stream, whose bytes after
  // opened are raw SSH rather than frames, and never reattaches, so no
  // reattach can name an ssh session: either open is refused with a fixed
  // sentence before any create, dock or stream, and the Computer is
  // neither woken nor reached.
  it("refuses an ssh or a reattach open before anything is sent", async () => {
    const { connector, worker, creates } = await harness();
    const ssh = { mode: "ssh" } as unknown as SessionOpen;
    await expect(connector.open(COMPUTER, ssh)).rejects.toThrow(
      new TypeError(
        "an ssh session carries raw bytes after opened and opens with OpenSSH",
      ),
    );
    const reattach = {
      mode: "reattach",
      session: "01954e20-7540-7ec4-93ec-14f783e6ab21",
    } as unknown as SessionOpen;
    await expect(connector.open(COMPUTER, reattach)).rejects.toThrow(
      new TypeError("unsupported mode"),
    );
    expect(creates).toEqual([]);
    expect(worker.requests).toEqual([]);
  });

  // Contract: a shell is judged by the stream's rule alone: an absolute,
  // clean path without NUL, the root included; and a resize outside 1 to
  // 10000 cells each way is refused and sends nothing.
  it("judges a shell by the stream rule and refuses a resize out of bounds", async () => {
    const { connector, worker } = await harness();
    const session = await connector.open(COMPUTER, {
      ...TERMINAL,
      mode: "shell",
      shell: "/",
    });
    const writes = (): number =>
      worker.requests.filter((r) => r.type === "write").length;
    const before = writes();
    expect(() => {
      session.resize({ cols: 0, rows: 24 });
    }).toThrow(new TypeError("terminal size 0x24 is outside 1 to 10000"));
    expect(writes()).toBe(before);
    session.resize({ cols: 120, rows: 40 });
    expect(writes()).toBe(before + 1);
  });
});

describe("session trust floor", () => {
  const docks = (worker: { requests: readonly { type: string }[] }): number =>
    worker.requests.filter((r) => r.type === "dock").length;

  /** `floor`, recording every version it accepted, with its key. */
  function recording(floor: TrustFloor): {
    readonly floor: TrustFloor;
    readonly accepted: [string, string, number][];
  } {
    const accepted: [string, string, number][] = [];
    return {
      accepted,
      floor: {
        accept: async (network, scope, version) => {
          await floor.accept(network, scope, version);
          accepted.push([network, scope, version]);
        },
      },
    };
  }

  /** What `ready` settled with: `ok`, or the rejection. */
  async function readied(h: Harness): Promise<unknown> {
    return await h.connector.ready().then(
      () => "ok",
      (error: unknown) => error,
    );
  }

  // Contract: a bundle older than one a connector of the same floor
  // accepted is refused with the rollback sentence, and nothing docks.
  it("refuses a rollback across connectors sharing a floor", async () => {
    const { floor, accepted } = recording(memoryTrustFloor());
    const newer = await harness({ trustVersion: 7, trustFloor: floor });
    expect(await readied(newer)).toBe("ok");
    const older = await harness({ trustVersion: 6, trustFloor: floor });
    const refused = await readied(older);
    expect(refused).toBeInstanceOf(SessionTrustError);
    expect((refused as Error).message).toBe(
      "session trust bundle is older than one already accepted",
    );
    expect(docks(older.worker)).toBe(0);
    expect(accepted).toEqual([["example.test", "zone-a", 7]]);
  });

  // Contract: the scope is the client's own: a server that replays an old,
  // validly signed bundle naming a Zone this page never accepted is refused
  // because the bundle names another Zone than the client's placement, and
  // its version never reaches the floor.
  it("refuses an old bundle naming another Zone", async () => {
    const { floor, accepted } = recording(memoryTrustFloor());
    expect(
      await readied(await harness({ trustVersion: 7, trustFloor: floor })),
    ).toBe("ok");
    const replayed = await harness({
      trustVersion: 1,
      trustZone: "zone-b",
      trustFloor: floor,
    });
    const refused = await readied(replayed);
    expect(refused).toBeInstanceOf(SessionTrustError);
    expect((refused as Error).message).toBe(
      "trust document names another network, zone or role",
    );
    expect(docks(replayed.worker)).toBe(0);
    expect(accepted).toEqual([["example.test", "zone-a", 7]]);
  });

  // Contract: a bundle of the version accepted before, or a higher one,
  // docks, each held to the floor of the client's Zone.
  it("accepts an equal or a higher version", async () => {
    const { floor, accepted } = recording(memoryTrustFloor());
    for (const version of [4, 4, 9]) {
      const h = await harness({ trustVersion: version, trustFloor: floor });
      expect(await readied(h)).toBe("ok");
      expect(docks(h.worker)).toBe(1);
    }
    expect(accepted.map(([, , version]) => version)).toEqual([4, 4, 9]);
  });

  // Contract: only a bundle that verified reaches the floor: one no pinned
  // key signed is refused before it.
  it("holds only a verified bundle to the floor", async () => {
    const { floor, accepted } = recording(memoryTrustFloor());
    const forged = await harness({
      trustVersion: 12,
      trustFloor: floor,
      pinAnotherKey: true,
    });
    expect(await readied(forged)).toMatchObject({
      message: "session trust is not signed by a trusted Network key",
    });
    expect(accepted).toEqual([]);
    expect(docks(forged.worker)).toBe(0);
  });

  // Contract: a floor that cannot be read or written refuses the bundle
  // with a SessionTrustError carrying the failure, and nothing docks; a
  // placement that names no trust scope refuses it before the floor.
  it("refuses the dock when the floor is unavailable", async () => {
    const failure = new Error("storage unavailable");
    const h = await harness({
      trustFloor: { accept: () => Promise.reject(failure) },
    });
    const refused = await readied(h);
    expect(refused).toBeInstanceOf(SessionTrustError);
    expect(refused).toMatchObject({
      message: "session trust floor is unavailable",
      cause: failure,
    });
    expect(docks(h.worker)).toBe(0);
    const unscoped = await harness({ scope: "" });
    expect(await readied(unscoped)).toMatchObject({
      message: "the client's placement names no session trust scope",
    });
  });

  // Contract: a connector given no floor uses the page's one default
  // floor, kept in IndexedDB where the page offers it: two connectors of
  // the page share it, a rollback is refused across them, and the floor's
  // record is in the database.
  it("uses one IndexedDB floor per page by default", async () => {
    const idb = new FakeIndexedDb();
    vi.resetModules();
    vi.stubGlobal("indexedDB", idb.factory);
    try {
      const fresh = await import("../src/computer-connection/connector.js");
      const first = await harness({
        trustVersion: 5,
        trustFloor: "default",
        build: fresh.computerConnector,
      });
      expect(await readied(first)).toBe("ok");
      const second = await harness({
        trustVersion: 4,
        trustFloor: "default",
        build: fresh.computerConnector,
      });
      expect(await readied(second)).toMatchObject({
        name: "SessionTrustError",
        message: "session trust bundle is older than one already accepted",
      });
      expect(idb.opens).toBe(1);
      const records = idb.databases
        .get("idyl-session-trust")
        ?.stores.get("floors")?.records;
      expect([...(records?.values() ?? [])]).toEqual([
        { network: "example.test", scope: "zone-a", version: 5 },
      ]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  // Contract: the scope comes from the Account's own discovery, through the
  // public client: a bundle naming another Zone than discovery names is
  // refused, and discovery that names no Zone refuses the dock before any
  // bundle is judged.
  it("takes the scope from discovery", async () => {
    const network = async (
      bundleZone: string,
      discoveryZone: string,
    ): Promise<{ readonly ready: unknown; readonly worker: FakeWorker }> => {
      const trust = await signedTrust(3, bundleZone);
      const plane = new FakeNetwork(
        (request) => {
          const { pathname } = request.url;
          if (pathname === "/v1/session-trust") return json(trust.response);
          if (
            pathname ===
            `/v1/accounts/${accountId}/subnets/${subnetSlug}/client-certificates`
          ) {
            return json({
              chain: [encodeBase64(Uint8Array.of(5))],
              admissionLease: encodeBase64(Uint8Array.of(6)),
              notAfter: new Date(Date.now() + 3_600_000).toISOString(),
            });
          }
          return undefined;
        },
        { zone: discoveryZone },
      );
      const worker = new FakeWorker();
      const connector = plane.client().computers.connector({
        worker,
        module: {},
        network: "example.test",
        trustKeys: [trust.key],
        trustFloor: memoryTrustFloor(),
      });
      const ready = await connector.ready().then(
        () => "ok",
        (error: unknown) => error,
      );
      return { ready, worker };
    };
    expect((await network("zone-a", "zone-a")).ready).toBe("ok");
    const other = await network("zone-b", "zone-a");
    expect(other.ready).toMatchObject({
      name: "SessionTrustError",
      message: "trust document names another network, zone or role",
    });
    expect(docks(other.worker)).toBe(0);
    const none = await network("zone-a", "");
    expect(none.ready).toMatchObject({
      name: "SessionTrustError",
      message: "the client's placement names no session trust scope",
    });
    expect(docks(none.worker)).toBe(0);
  });
});
