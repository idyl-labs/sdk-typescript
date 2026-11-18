// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComputerWatch } from "../src/api/computer-watch.js";
import {
  EventFrameReader,
  encodeTicketFrame,
} from "../src/computer-connection/events.js";
import { FrameError } from "../src/computer-connection/frames.js";
import { ApiError } from "../src/errors.js";
import {
  Listening,
  type ComputerChange,
  type ListeningPort,
} from "../src/computer-connection/listening.js";
import type { WorkerToPage } from "../src/computer-connection/messages.js";
import type { ComputerWatchId, NamespaceId } from "../src/resource/uuid-id.js";

const NAMESPACE = "01954e20-7540-7ec4-93ec-14f783e6ab10" as NamespaceId;
const OTHER_NAMESPACE = "01954e20-7540-7ec4-93ec-14f783e6ab11";
const COMPUTER = "01954e20-7540-7ec4-93ec-14f783e6ab41";
const SERVICE = "spiffe://zone-a.zone.example.test/service/computers";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** One length-prefixed frame holding `json`. */
function frame(json: unknown): Uint8Array {
  const body = enc.encode(JSON.stringify(json));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

function watch(n: number, expiresInMs = 3_600_000): ComputerWatch {
  return {
    id: `01954e20-7540-7ec4-93ec-14f783e6ab7${String(n)}` as ComputerWatchId,
    namespaceId: NAMESPACE,
    namespace: "default",
    subnet: "550000000002",
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    ticket: `ticket-${String(n)}`,
  };
}

/**
 * A connector's side of listening: a dock whose edge serves the profile, a
 * Worker that opens each lane and service at once, and the tickets the
 * page wrote. The test delivers the service's frames.
 */
class FakePort implements ListeningPort {
  readonly #listeners = new Set<(m: WorkerToPage) => void>();
  readonly tickets: { watch: string; ticket: string }[] = [];
  readonly closed: number[] = [];
  readonly lanes: string[] = [];
  /** When each lane was asked for, in milliseconds since the epoch. */
  readonly laneAt: number[] = [];
  /** A service that accepts each ticket and then ends the stream at once. */
  churn = false;
  released = 0;
  profile = "client-service-lanes/1";
  watches = 0;
  #handle = 1;
  service = 0;

  docked = (): ReturnType<ListeningPort["docked"]> =>
    Promise.resolve({
      dock: 1,
      chain: [Uint8Array.of(5)],
      serviceLaneProfile: this.profile,
      service: { principal: SERVICE, roots: [Uint8Array.of(2)] },
    });

  createWatch = (): Promise<ComputerWatch> =>
    Promise.resolve(watch(++this.watches));

  listen = (listener: (m: WorkerToPage) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  request: ListeningPort["request"] = (request) => {
    switch (request.type) {
      case "open-service-lane": {
        const lane = this.#handle++;
        this.lanes.push(request.principal);
        this.laneAt.push(Date.now());
        queueMicrotask(() => {
          this.emit({ type: "lane-ready", dock: 1, lane });
        });
        return Promise.resolve(lane);
      }
      case "open-service":
        this.service = this.#handle++;
        return Promise.resolve(this.service);
      case "service-write": {
        const text = dec.decode(request.bytes.subarray(4));
        this.tickets.push(
          JSON.parse(text) as { watch: string; ticket: string },
        );
        if (this.churn) {
          const service = request.service;
          queueMicrotask(() => {
            this.send({
              type: "event",
              namespaceId: NAMESPACE,
              part: "reread",
            });
            this.emit({
              type: "service-ended",
              dock: 1,
              service,
              reason: "closed",
            });
          });
        }
        return Promise.resolve(undefined);
      }
      case "close-service":
        this.closed.push(request.service);
        return Promise.resolve(undefined);
      case "service-release":
        this.released += 1;
        return Promise.resolve(undefined);
    }
  };

  emit(m: WorkerToPage): void {
    for (const listener of [...this.#listeners]) listener(m);
  }

  /** The service sends `json` as one frame on the stream in hand. */
  send(json: unknown): void {
    this.emit({
      type: "service-data",
      dock: 1,
      service: this.service,
      bytes: frame(json),
    });
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("event stream frames", () => {
  // Contract: a ticket frame is the 4-byte big-endian length of one JSON
  // object naming its type, its watch and its ticket.
  it("encodes a ticket frame", () => {
    const bytes = encodeTicketFrame({
      type: "ticket",
      watch: "w",
      ticket: "t",
    });
    const length = new DataView(bytes.buffer).getUint32(0);
    expect(length).toBe(bytes.length - 4);
    expect(JSON.parse(dec.decode(bytes.subarray(4)))).toEqual({
      type: "ticket",
      watch: "w",
      ticket: "t",
    });
  });

  // Contract: service frames are read as they arrive, whole frames only,
  // members this SDK does not know carried no further, and a frame of an
  // unknown type skipped.
  it("reads service frames across chunks and skips unknown types", () => {
    const reader = new EventFrameReader();
    const bytes = new Uint8Array([
      ...frame({
        type: "event",
        namespaceId: NAMESPACE,
        computer: COMPUTER,
        part: "computer",
        extra: 1,
      }),
      ...frame({ type: "hello" }),
      ...frame({ type: "ended", watch: "w" }),
      ...frame({
        type: "error",
        code: "COMPUTER_WATCH_TICKET_REFUSED",
        watch: "w",
      }),
    ]);
    expect(reader.push(bytes.subarray(0, 7))).toEqual([]);
    expect(reader.push(bytes.subarray(7))).toEqual([
      {
        type: "event",
        part: "computer",
        namespaceId: NAMESPACE,
        computer: COMPUTER,
        extra: 1,
      },
      { type: "ended", watch: "w" },
      { type: "error", code: "COMPUTER_WATCH_TICKET_REFUSED", watch: "w" },
    ]);
  });

  // Contract: a frame declaring no bytes or more than 4096 ends the stream
  // before its body is read.
  it("refuses a frame length out of bounds", () => {
    const zero = new Uint8Array(4);
    expect(() => new EventFrameReader().push(zero)).toThrow(FrameError);
    const large = new Uint8Array(4);
    new DataView(large.buffer).setUint32(0, 4097);
    expect(() => new EventFrameReader().push(large)).toThrow(FrameError);
  });
});

describe("listening", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Contract: listening creates a watch, opens a client service lane to the
  // exact service, presents the watch's ticket, and counts as listening
  // from the first frame the service sends, its `reread`.
  it("presents its ticket and listens from the reread", async () => {
    const port = new FakePort();
    const listening = new Listening(port);
    const states: string[] = [];
    const changes: ComputerChange[] = [];
    listening.subscribe({
      onListening: (on) => states.push(on),
      onChange: (change) => changes.push(change),
    });
    listening.start();
    await settle();
    expect(port.lanes).toEqual([SERVICE]);
    expect(port.tickets).toEqual([
      { type: "ticket", watch: watch(1).id, ticket: "ticket-1" },
    ]);
    expect(listening.listening).toBeUndefined();
    port.send({ type: "event", namespaceId: NAMESPACE, part: "reread" });
    port.send({
      type: "event",
      namespaceId: NAMESPACE,
      computer: COMPUTER,
      part: "version",
    });
    expect(listening.listening).toBe("listening");
    expect(states).toEqual(["listening"]);
    expect(changes).toEqual([
      { part: "reread" },
      { part: "version", computer: COMPUTER },
    ]);
  });

  // Contract: each batch the Worker hands over is handled at once, and
  // only then is the Worker told to read the stream again.
  it("releases the stream after handing on each batch", async () => {
    const port = new FakePort();
    const listening = new Listening(port);
    const seen: number[] = [];
    listening.subscribe({ onChange: () => seen.push(port.released) });
    listening.start();
    await settle();
    port.send({ type: "event", namespaceId: NAMESPACE, part: "reread" });
    expect(seen).toEqual([0]);
    expect(port.released).toBe(1);
  });

  // Contract: an event of another Namespace is not delivered, and a part
  // this SDK does not name is delivered as reread.
  it("drops other Namespaces and reads an unknown part as reread", async () => {
    const port = new FakePort();
    const listening = new Listening(port);
    const changes: ComputerChange[] = [];
    listening.subscribe({ onChange: (change) => changes.push(change) });
    listening.start();
    await settle();
    port.send({
      type: "event",
      namespaceId: OTHER_NAMESPACE,
      computer: COMPUTER,
      part: "computer",
    });
    port.send({
      type: "event",
      namespaceId: NAMESPACE,
      computer: COMPUTER,
      part: "notebook",
    });
    expect(changes).toEqual([{ part: "reread" }]);
  });

  // Contract: an edge whose welcome names no client service lane profile
  // is never asked for a lane, and no watch is created.
  it("does not ask an edge that serves no profile", async () => {
    const port = new FakePort();
    port.profile = "";
    const listening = new Listening(port);
    const states: string[] = [];
    listening.subscribe({ onListening: (on) => states.push(on) });
    listening.start();
    await settle();
    expect(port.lanes).toEqual([]);
    expect(port.watches).toBe(0);
    expect(states).toEqual(["unavailable"]);
  });

  // Contract: at a ticket's end the service's ended frame makes the
  // connector create the watch again and present the new ticket on the
  // stream it holds, keeping no clock of its own.
  it("creates the watch again when the service says its ticket ended", async () => {
    const port = new FakePort();
    const listening = new Listening(port);
    listening.start();
    await settle();
    port.send({ type: "event", namespaceId: NAMESPACE, part: "reread" });
    port.send({ type: "ended", watch: watch(1).id });
    await settle();
    expect(port.watches).toBe(2);
    expect(port.tickets.map((t) => t.watch)).toEqual([
      watch(1).id,
      watch(2).id,
    ]);
    expect(port.lanes).toHaveLength(1);
    expect(listening.listening).toBe("listening");
  });

  // Contract: an attempt whose stream delivers no reread within 30 s
  // fails: the connector has no event stream, and tries again after 0.5 s.
  it("fails an attempt with no reread within 30 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const port = new FakePort();
    const listening = new Listening(port);
    const states: string[] = [];
    listening.subscribe({ onListening: (on) => states.push(on) });
    listening.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(states).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(states).toEqual(["retrying"]);
    expect(port.closed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(port.lanes).toHaveLength(2);
  });

  // Contract: an attempt that settles after stop() tells its listeners
  // nothing, and the state reads undefined until the next start().
  it("tells nothing of an attempt that settles after stop", async () => {
    const port = new FakePort();
    let refuse: (error: Error) => void = () => undefined;
    port.createWatch = () =>
      new Promise<ComputerWatch>((_, reject) => {
        refuse = reject;
      });
    const listening = new Listening(port);
    const states: string[] = [];
    listening.subscribe({ onListening: (state) => states.push(state) });
    listening.start();
    await settle();
    listening.stop();
    refuse(new Error("unavailable"));
    await settle();
    expect(states).toEqual([]);
    expect(listening.listening).toBeUndefined();
  });

  // Contract: a watch create refused for a cause a retry cannot change,
  // as a Namespace not found, leaves the connector unavailable and is not
  // tried again on a timer; one a retry can change, as HTTP 429, leaves it
  // retrying on the steps.
  it("reports a refusal a retry cannot change as unavailable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    for (const [status, expected, creates] of [
      [404, "unavailable", 1],
      [429, "retrying", 2],
    ] as const) {
      const port = new FakePort();
      let made = 0;
      port.createWatch = () => {
        made += 1;
        return Promise.reject(
          new ApiError({ status, message: "", code: "REFUSED" }),
        );
      };
      const listening = new Listening(port);
      const states: string[] = [];
      listening.subscribe({ onListening: (state) => states.push(state) });
      listening.start();
      await vi.advanceTimersByTimeAsync(600);
      expect(states).toEqual([expected]);
      expect(listening.listening).toBe(expected);
      expect(made).toBe(creates);
      listening.stop();
    }
  });

  // Contract: a watch create refused for the caller's sign-in is not tried
  // again on a timer, only on the connector's next use.
  it("does not retry a refused sign-in on a timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const port = new FakePort();
    let creates = 0;
    port.createWatch = () => {
      creates += 1;
      return Promise.reject(
        new ApiError({ status: 401, message: "", code: "UNAUTHENTICATED" }),
      );
    };
    const listening = new Listening(port);
    listening.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(creates).toBe(1);
    listening.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(creates).toBe(2);
  });

  // Contract: a stream that ends after it carried events is opened again
  // at once with the watch in hand; the connector is not without a stream
  // meanwhile, and listening resumes with the new stream's reread.
  it("opens the stream again at once after it ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const port = new FakePort();
    const listening = new Listening(port);
    const states: string[] = [];
    listening.subscribe({ onListening: (on) => states.push(on) });
    listening.start();
    await vi.advanceTimersByTimeAsync(0);
    port.send({ type: "event", namespaceId: NAMESPACE, part: "reread" });
    // The stream outlives the first step, so it is opened again at once.
    await vi.advanceTimersByTimeAsync(1_000);
    const first = port.service;
    port.emit({
      type: "service-ended",
      dock: 1,
      service: first,
      reason: "closed",
    });
    expect(listening.listening).toBe("listening");
    await vi.advanceTimersByTimeAsync(0);
    expect(port.closed).toEqual([first]);
    expect(port.lanes).toHaveLength(2);
    expect(port.tickets.map((t) => t.watch)).toEqual([
      watch(1).id,
      watch(1).id,
    ]);
    expect(port.watches).toBe(1);
    port.send({ type: "event", namespaceId: NAMESPACE, part: "reread" });
    expect(listening.listening).toBe("listening");
    expect(states).toEqual(["listening"]);
  });

  // Contract: a service that accepts each ticket and ends the stream at
  // once is met on the retry steps, 0.5 s, 1, 2, 4 and on, each counted
  // from when the last attempt began, never in a tight loop.
  it("meets a stream that ends at once on the retry steps", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const port = new FakePort();
    port.churn = true;
    new Listening(port).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(port.lanes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500 + 1_000 + 2_000 + 4_000 + 8_000);
    const gaps = port.laneAt
      .slice(1)
      .map((at, i) => at - (port.laneAt[i] ?? 0));
    expect(gaps).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
  });

  // Contract: a stream that ends sooner than its step is a failed attempt
  // and the connector says it has no event stream, through the climbing
  // steps; a stream that then outlives its step says it has one again.
  it("reports no event stream while streams end sooner than their step", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const port = new FakePort();
    port.churn = true;
    const listening = new Listening(port);
    const states: string[] = [];
    const changes: ComputerChange[] = [];
    listening.subscribe({
      onListening: (on) => states.push(on),
      onChange: (change) => changes.push(change),
    });
    listening.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["listening", "retrying"]);
    await vi.advanceTimersByTimeAsync(500 + 1_000 + 2_000);
    expect(port.lanes).toHaveLength(4);
    expect(states).toEqual(["listening", "retrying"]);
    expect(listening.listening).toBe("retrying");
    // Each stream's reread was still handed on.
    expect(changes).toHaveLength(4);
    port.churn = false;
    await vi.advanceTimersByTimeAsync(4_000);
    port.send({ type: "event", namespaceId: NAMESPACE, part: "reread" });
    expect(states).toEqual(["listening", "retrying"]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(states).toEqual(["listening", "retrying", "listening"]);
    expect(listening.listening).toBe("listening");
  });

  // Contract: a stream that outlives its step is opened again at once,
  // and the steps start from the first again.
  it("opens a stream that outlived its step again at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const port = new FakePort();
    new Listening(port).start();
    await vi.advanceTimersByTimeAsync(0);
    port.send({ type: "event", namespaceId: NAMESPACE, part: "reread" });
    await vi.advanceTimersByTimeAsync(60_000);
    port.emit({
      type: "service-ended",
      dock: 1,
      service: port.service,
      reason: "closed",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(port.lanes).toHaveLength(2);
    expect((port.laneAt[1] ?? 0) - (port.laneAt[0] ?? 0)).toBe(60_000);
  });

  // Contract: an attempt that fails is tried again after 0.5 s, 1, 2, 4,
  // 8, 15, then every 30 s.
  it("tries a failed attempt again on the retry schedule", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const port = new FakePort();
    let attempts = 0;
    port.createWatch = () => {
      attempts += 1;
      return Promise.reject(new Error("unavailable"));
    };
    new Listening(port).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    for (const [pause, total] of [
      [500, 2],
      [1_000, 3],
      [2_000, 4],
      [4_000, 5],
      [8_000, 6],
      [15_000, 7],
      [30_000, 8],
      [30_000, 9],
    ] as const) {
      await vi.advanceTimersByTimeAsync(pause - 1);
      expect(attempts).toBe(total - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(total);
    }
  });

  // Contract: a refused ticket is answered once with a new watch, whose
  // ticket the same stream carries; a second refusal stops listening.
  it("creates the watch again once when its ticket is refused", async () => {
    const port = new FakePort();
    const listening = new Listening(port);
    listening.start();
    await settle();
    port.send({
      type: "error",
      code: "COMPUTER_WATCH_TICKET_REFUSED",
      watch: watch(1).id,
    });
    await settle();
    expect(port.watches).toBe(2);
    expect(port.tickets.map((t) => t.watch)).toEqual([
      watch(1).id,
      watch(2).id,
    ]);
    port.send({
      type: "error",
      code: "COMPUTER_WATCH_TICKET_REFUSED",
      watch: watch(2).id,
    });
    await settle();
    expect(port.closed).toHaveLength(1);
  });

  // Contract: a wait's events wake it for a change it matches and for
  // every reread, and the stream counts as carrying its events only while
  // the watch is of the wait's Namespace.
  it("wakes a wait for its change and for reread", async () => {
    const port = new FakePort();
    const listening = new Listening(port);
    listening.start();
    await settle();
    port.send({ type: "event", namespaceId: NAMESPACE, part: "reread" });
    const events = listening.waitEvents(
      (c) => c.part === "operation" && c.id === "op-1",
      "default",
    );
    let wakes = 0;
    const stop = events.listen(() => (wakes += 1));
    port.send({
      type: "event",
      namespaceId: NAMESPACE,
      computer: COMPUTER,
      part: "operation",
      id: "op-2",
    });
    port.send({
      type: "event",
      namespaceId: NAMESPACE,
      computer: COMPUTER,
      part: "operation",
      id: "op-1",
    });
    port.send({ type: "event", namespaceId: NAMESPACE, part: "reread" });
    expect(wakes).toBe(2);
    expect(events.streaming()).toBe(true);
    expect(listening.waitEvents(() => true, "research").streaming()).toBe(
      false,
    );
    stop();
    port.send({ type: "event", namespaceId: NAMESPACE, part: "reread" });
    expect(wakes).toBe(2);
  });
});
