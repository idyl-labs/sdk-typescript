// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_TAG_RECORD,
  FILE_PIECE_BYTES,
  decodeFileEntry,
  fileEtag,
  fileTagOfPieces,
  parseFileEtag,
} from "../src/api/files.js";
import {
  openDownload,
  type DownloadPacing,
  type DownloadRequest,
  type FileBody,
} from "../src/client/download.js";
import { ApiError, TransportError } from "../src/index.js";
import {
  fileEtagOf,
  pieceHashesOf,
  serveContent,
  type ServedContent,
} from "./fakes/content.js";
import { FakeControlPlane, json } from "./fakes/control-plane.js";
import type { RecordedRequest } from "./fakes/fetch-queue.js";

const ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const SAVED_VERSION = 7;
const VERSION_NOT_FOUND = "VERSION_NOT_FOUND";
const LIMIT_REACHED = "DOWNLOAD_LIMIT_REACHED";

/** What one scripted request does instead of answering plainly. */
type Step =
  | { readonly cutAfter: number }
  | {
      readonly refuse: number;
      readonly code?: string;
      readonly retryAfter?: string;
    }
  | { readonly flip: number }
  | { readonly hold: true }
  | { readonly hang: true }
  | { readonly reset: true }
  | { readonly whole: true }
  | { readonly wrongRange: true }
  | { readonly etag: string }
  | { readonly answer: () => Response };

/** Deterministic synthetic content of `length` bytes. */
function contentOf(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + (index >>> 12)) & 255;
  }
  return bytes;
}

/** A pacing a test drives: no real time passes. */
class Pacing implements DownloadPacing {
  clock = 1_000_000;
  fraction = 1;
  readonly waits: number[] = [];
  readonly timers = new Set<{ ms: number; run: () => void }>();
  /** When set, a wait stays pending until its signal aborts. */
  holdWaits = false;

  now = (): number => this.clock;
  random = (): number => this.fraction;
  wait = async (ms: number, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    this.waits.push(ms);
    if (this.holdWaits) {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(signal.reason as Error);
        });
      });
    }
    this.clock += ms;
  };
  after = (ms: number, run: () => void): (() => void) => {
    const timer = { ms, run };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  };
  /** Fires the one silence timer running now. */
  fireSilence(): void {
    const [timer] = this.timers;
    expect(timer?.ms).toBe(30_000);
    timer?.run();
  }
}

/** A Computer's content behind the routes, with scripted faults. */
class Harness {
  readonly pacing = new Pacing();
  readonly plane: FakeControlPlane;
  readonly heads: Step[] = [];
  readonly reads: Step[] = [];
  readonly pieces: Step[] = [];
  content: ServedContent;
  /** The step every read takes once `reads` runs out. */
  always: Step | undefined;
  /** Whether the content is served at `files/archive`. */
  archive = false;

  constructor(bytes: Uint8Array, etag = fileEtagOf(bytes)) {
    this.content = { bytes, etag, version: SAVED_VERSION };
    this.plane = new FakeControlPlane({
      routes: async (request) => await this.#route(request),
    });
  }

  async open(options: Partial<DownloadRequest> = {}): Promise<FileBody> {
    return await openDownload(
      this.plane.client().account.computers,
      ID,
      { path: "data.bin", archive: this.archive, ...options },
      this.pacing,
    );
  }

  /** The requests to one content route, by method. */
  requests(route: string, method = "GET"): RecordedRequest[] {
    return this.plane
      .subnetRequests()
      .filter(
        (request) =>
          request.url.pathname.endsWith(route) && request.method === method,
      );
  }

  get contentRoute(): string {
    return this.archive ? "/files/archive" : "/files/content";
  }

  /** The `Range` each content read asked for. */
  ranges(): (string | null)[] {
    return this.requests(this.contentRoute).map((request) =>
      request.headers.get("range"),
    );
  }

  async #route(request: RecordedRequest): Promise<Response | undefined> {
    const { pathname } = request.url;
    if (pathname.endsWith("/files/pieces")) {
      const list = pieceHashesOf(this.content.bytes);
      return await this.#answer(this.pieces.shift(), () => {
        return new Response(list, {
          headers: {
            ETag: this.content.etag,
            "Idyl-Saved-Version": String(this.content.version),
          },
        });
      });
    }
    if (pathname.endsWith(this.contentRoute)) {
      const plain = (): Response => serveContent(request, this.content);
      if (request.method === "HEAD") {
        return await this.#answer(this.heads.shift(), plain);
      }
      return await this.#answer(this.reads.shift() ?? this.always, plain);
    }
    return undefined;
  }

  async #answer(
    step: Step | undefined,
    plain: () => Response,
  ): Promise<Response> {
    if (step === undefined) return plain();
    if ("answer" in step) return step.answer();
    if ("hang" in step) return await new Promise<Response>(() => undefined);
    if ("reset" in step) throw new TypeError("connection reset");
    if ("refuse" in step) {
      return new Response(
        step.code === undefined
          ? null
          : JSON.stringify({ error: "refused", code: step.code }),
        {
          status: step.refuse,
          headers:
            step.retryAfter === undefined
              ? {}
              : { "Retry-After": step.retryAfter },
        },
      );
    }
    if ("whole" in step) {
      return new Response(new Uint8Array(this.content.bytes), {
        headers: { ETag: this.content.etag },
      });
    }
    const answered = plain();
    if ("wrongRange" in step) {
      return new Response(answered.body, {
        status: 206,
        headers: {
          ETag: this.content.etag,
          "Content-Range": "bytes 1-1/2",
        },
      });
    }
    if ("etag" in step) {
      const headers = new Headers(answered.headers);
      headers.set("ETag", step.etag);
      return new Response(answered.body, {
        status: answered.status,
        headers,
      });
    }
    const bytes = new Uint8Array(await answered.arrayBuffer());
    if ("flip" in step) {
      const changed = new Uint8Array(bytes);
      changed[step.flip] = (changed[step.flip] ?? 0) ^ 1;
      return new Response(changed, {
        status: answered.status,
        headers: answered.headers,
      });
    }
    if ("hold" in step) {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull: async () => {
            await new Promise<void>(() => undefined);
          },
        }),
        { status: answered.status, headers: answered.headers },
      );
    }
    // A cut delivers its bytes and then breaks, on a later pull so that the
    // bytes are not discarded with the stream.
    let sent = false;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent) {
              controller.error(new TypeError("terminated"));
              return;
            }
            sent = true;
            controller.enqueue(bytes.slice(0, step.cutAfter));
          },
        },
        { highWaterMark: 0 },
      ),
      { status: answered.status, headers: answered.headers },
    );
  }
}

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.compare(a, b) === 0;

async function drain(body: FileBody): Promise<Uint8Array> {
  return new Uint8Array(await body.bytes());
}

/** Reads a stream to its end, keeping what arrived and how it ended. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<{
  chunks: Uint8Array[];
  error: unknown;
}> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { chunks, error: undefined };
      chunks.push(value);
    }
  } catch (error) {
    return { chunks, error };
  }
}

describe("file downloads", () => {
  // Contract: bytes are exact through several cuts, a cut costs only the
  // piece in progress, and every read is pinned to one version and entity
  // tag with the one HEAD and the one piece list it resolved.
  it("delivers exact bytes through several cuts", async () => {
    const bytes = contentOf(2 * FILE_PIECE_BYTES + 1_000);
    const harness = new Harness(bytes);
    harness.reads.push(
      { cutAfter: FILE_PIECE_BYTES + 5 },
      { cutAfter: 100 },
      { cutAfter: FILE_PIECE_BYTES + 1 },
    );
    const body = await harness.open();
    expect(body.version).toBe(SAVED_VERSION);
    expect(body.size).toBe(bytes.length);
    expect(body.etag).toBe(harness.content.etag);
    expect(same(await drain(body), bytes)).toBe(true);
    const last = bytes.length - 1;
    expect(harness.ranges()).toEqual([
      `bytes=0-${String(last)}`,
      `bytes=${String(FILE_PIECE_BYTES)}-${String(last)}`,
      `bytes=${String(FILE_PIECE_BYTES)}-${String(last)}`,
      `bytes=${String(2 * FILE_PIECE_BYTES)}-${String(last)}`,
    ]);
    for (const read of harness.requests("/files/content")) {
      expect(read.headers.get("if-range")).toBe(harness.content.etag);
      expect(read.headers.get("accept")).toBe("application/octet-stream");
      expect(read.url.searchParams.get("version")).toBe(String(SAVED_VERSION));
      expect(read.url.searchParams.get("path")).toBe("data.bin");
      expect(read.headers.get("dpop")).not.toBeNull();
    }
    expect(harness.requests("/files/content", "HEAD")).toHaveLength(1);
    expect(harness.requests("/files/pieces")).toHaveLength(1);
    expect(harness.pacing.waits).toEqual([1_000, 2_000, 1_000]);
    expect(harness.pacing.timers.size).toBe(0);
  });

  // Contract: an archive resumes by offset with If-Range on the bytes its
  // opaque entity tag names, with no piece list and no check of its own.
  it("resumes an archive with If-Range from the byte it reached", async () => {
    const bytes = contentOf(5_000);
    const etag = '"tar1-0a1b2c"';
    const harness = new Harness(bytes, etag);
    harness.archive = true;
    harness.reads.push({ cutAfter: 1_234 });
    const body = await harness.open({ path: "src" });
    expect(body.etag).toBe(etag);
    expect(same(await drain(body), bytes)).toBe(true);
    const reads = harness.requests("/files/archive");
    expect(reads.map((read) => read.headers.get("range"))).toEqual([
      "bytes=0-4999",
      "bytes=1234-4999",
    ]);
    expect(reads[1]?.headers.get("if-range")).toBe(etag);
    expect(reads[1]?.headers.get("accept")).toBe("application/x-tar");
    expect(harness.requests("/files/pieces")).toHaveLength(0);
  });

  // Contract: a piece whose bytes do not match its hash never reaches the
  // caller: it is asked for again, and what the caller holds is verified.
  it("never hands over a wrong piece", async () => {
    const bytes = contentOf(2 * FILE_PIECE_BYTES);
    const harness = new Harness(bytes);
    harness.reads.push({ flip: FILE_PIECE_BYTES + 9 });
    const body = await harness.open();
    const { chunks, error } = await readAll(body.stream());
    expect(error).toBeUndefined();
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      FILE_PIECE_BYTES,
      FILE_PIECE_BYTES,
    ]);
    expect(same(Buffer.concat(chunks), bytes)).toBe(true);
    expect(harness.ranges().at(-1)).toBe(
      `bytes=${String(FILE_PIECE_BYTES)}-${String(bytes.length - 1)}`,
    );
  });

  // Contract: a file of one piece is checked against its tag.
  it("checks a one-piece file against its tag", async () => {
    const bytes = contentOf(1_000);
    const harness = new Harness(bytes);
    harness.always = { flip: 3 };
    harness.pacing.fraction = 1;
    const { chunks, error } = await readAll((await harness.open()).stream());
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("network_error");
  });

  // Contract: a piece that stays wrong ends the download after the no-gain
  // limit, and the pieces before it are all the caller ever saw.
  it("ends with only verified bytes when a piece stays wrong", async () => {
    const bytes = contentOf(FILE_PIECE_BYTES + 10);
    const harness = new Harness(bytes);
    harness.reads.push({ cutAfter: FILE_PIECE_BYTES });
    harness.always = { flip: 0 };
    const { chunks, error } = await readAll((await harness.open()).stream());
    expect(chunks.map((chunk) => chunk.length)).toEqual([FILE_PIECE_BYTES]);
    expect(
      same(chunks[0] ?? new Uint8Array(), bytes.subarray(0, FILE_PIECE_BYTES)),
    ).toBe(true);
    expect((error as Error).message).toBe("download stalled for 15 minutes");
  });

  // Contract: a file of one piece and an empty file need no piece list; an
  // empty file asks for no content at all and still completes.
  it("makes no pieces request for one piece or an empty file", async () => {
    const one = new Harness(contentOf(FILE_PIECE_BYTES));
    expect(
      same(await drain(await one.open()), contentOf(FILE_PIECE_BYTES)),
    ).toBe(true);
    expect(one.requests("/files/pieces")).toHaveLength(0);
    expect(one.ranges()).toHaveLength(1);

    const empty = new Harness(new Uint8Array());
    const seen: unknown[] = [];
    const body = await empty.open({
      onProgress: (progress) => seen.push(progress),
    });
    expect(body.size).toBe(0);
    expect(await drain(body)).toEqual(new Uint8Array());
    expect(empty.requests("/files/pieces")).toHaveLength(0);
    expect(empty.requests("/files/content")).toHaveLength(0);
    expect(seen).toEqual([{ done: 0, total: 0 }]);
  });

  // Contract: a piece list is checked against the tag before any content is
  // read; a wrong or short list is asked for again.
  it("checks the piece list against the tag", async () => {
    const bytes = contentOf(FILE_PIECE_BYTES + 1);
    const harness = new Harness(bytes);
    const list = pieceHashesOf(bytes);
    const wrong = new Uint8Array(list);
    wrong[0] = (wrong[0] ?? 0) ^ 1;
    const headers = { ETag: harness.content.etag };
    harness.pieces.push(
      { answer: () => new Response(wrong, { headers }) },
      { answer: () => new Response(list.slice(0, 32), { headers }) },
    );
    expect(same(await drain(await harness.open()), bytes)).toBe(true);
    expect(harness.requests("/files/pieces")).toHaveLength(3);
    expect(harness.ranges()).toHaveLength(1);
    expect(harness.pacing.waits).toEqual([1_000, 2_000]);
  });

  // Contract: a refusal another try cannot change stops at once, with the
  // refusal the server gave, no wait, no second request.
  it.each([
    [401, undefined],
    [403, undefined],
    [404, undefined],
    [429, LIMIT_REACHED],
  ])("stops at once on %i %s", async (status, code) => {
    const harness = new Harness(contentOf(100));
    harness.reads.push({
      refuse: status,
      ...(code === undefined ? {} : { code }),
    });
    const { error } = await readAll((await harness.open()).stream());
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    expect(harness.ranges()).toHaveLength(1);
    expect(harness.pacing.waits).toEqual([]);
  });

  // Contract: HEAD resolves with the same retry rule: a refusal rejects the
  // download at once, and a server error is waited out.
  it("retries a failing HEAD and rejects a refused one", async () => {
    const refused = new Harness(contentOf(10));
    refused.heads.push({ refuse: 404 });
    await expect(refused.open()).rejects.toMatchObject({ status: 404 });
    expect(refused.requests("/files/content", "HEAD")).toHaveLength(1);
    expect(refused.pacing.waits).toEqual([]);

    const failing = new Harness(contentOf(10));
    failing.heads.push({ refuse: 503 }, { reset: true });
    const body = await failing.open();
    expect(body.size).toBe(10);
    expect(failing.pacing.waits).toEqual([1_000, 2_000]);
  });

  // Contract: a response that cannot state what the content is rejects at
  // once rather than being retried.
  it("refuses content that does not state itself", async () => {
    const noEtag = new Harness(contentOf(10));
    noEtag.heads.push({
      answer: () =>
        new Response(null, {
          headers: { "Content-Length": "10", "Idyl-Saved-Version": "1" },
        }),
    });
    await expect(noEtag.open()).rejects.toMatchObject({
      code: "invalid_response",
    });

    const opaque = new Harness(contentOf(10), '"opaque"');
    await expect(opaque.open()).rejects.toMatchObject({
      code: "invalid_response",
    });
    const wrongLength = new Harness(contentOf(10), fileEtagOf(contentOf(11)));
    await expect(wrongLength.open()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(wrongLength.pacing.waits).toEqual([]);
  });

  // Contract: the wait starts at 1 s and doubles to 30 s, half of it random;
  // the wait is the full one at the random's top and half at its bottom.
  it("backs off 1 s doubling to 30 s with half of it random", async () => {
    const top = new Harness(contentOf(10));
    top.reads.push(...Array<Step>(7).fill({ refuse: 503 }));
    await drain(await top.open());
    expect(top.pacing.waits).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);

    const bottom = new Harness(contentOf(10));
    bottom.pacing.fraction = 0;
    bottom.reads.push(...Array<Step>(3).fill({ refuse: 503 }));
    await drain(await bottom.open());
    expect(bottom.pacing.waits).toEqual([500, 1_000, 2_000]);
  });

  // Contract: fifteen minutes of asking with no byte gained ends the
  // download, the last failure kept as the cause.
  it("stops after 15 minutes with no byte gained", async () => {
    const harness = new Harness(contentOf(10));
    harness.always = { refuse: 503 };
    const started = harness.pacing.clock;
    const { error } = await readAll((await harness.open()).stream());
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("network_error");
    expect((error as Error).cause).toBeInstanceOf(ApiError);
    const spent = harness.pacing.clock - started;
    expect(spent).toBeGreaterThanOrEqual(15 * 60_000);
    expect(spent).toBeLessThan(15 * 60_000 + 30_000);
  });

  // Contract: only time spent asking counts: a reader away from the stream
  // for longer than the limit loses nothing to a cut on its return.
  it("does not count a reader's own absence as no gain", async () => {
    const bytes = contentOf(FILE_PIECE_BYTES + 10);
    const harness = new Harness(bytes);
    harness.reads.push({ cutAfter: FILE_PIECE_BYTES });
    const reader = (await harness.open()).stream().getReader();
    await reader.read();
    harness.pacing.clock += 60 * 60_000;
    const { value } = await reader.read();
    expect(value?.length).toBe(10);
    expect((await reader.read()).done).toBe(true);
    expect(harness.pacing.waits).toEqual([1_000]);
  });

  // Contract: Retry-After is obeyed when longer than the wait, and the wait
  // stands when it is shorter.
  it("obeys Retry-After", async () => {
    const harness = new Harness(contentOf(10));
    harness.reads.push(
      { refuse: 429, retryAfter: "120" },
      { refuse: 503, retryAfter: "1" },
    );
    await drain(await harness.open());
    expect(harness.pacing.waits).toEqual([120_000, 2_000]);
  });

  // Contract: a failed connection and a stream silent for 30 s are breaks:
  // the read resumes from where it stopped, and no timer is left running.
  it("cuts a silent stream after 30 s and resumes", async () => {
    const bytes = contentOf(10);
    const harness = new Harness(bytes);
    harness.reads.push({ hang: true }, { hold: true }, { reset: true });
    const body = await harness.open();
    const read = drain(body);
    await vi.waitFor(() => {
      expect(harness.ranges()).toHaveLength(1);
      expect(harness.pacing.timers.size).toBe(1);
    });
    harness.pacing.fireSilence();
    await vi.waitFor(() => {
      expect(harness.ranges()).toHaveLength(2);
      expect(harness.pacing.timers.size).toBe(1);
    });
    harness.pacing.fireSilence();
    expect(same(await read, bytes)).toBe(true);
    expect(harness.pacing.timers.size).toBe(0);
  });

  // Contract: a named version that stops being kept ends the download with
  // that refusal, and the reads named its number throughout.
  it("stops when a named version stops being kept", async () => {
    const harness = new Harness(contentOf(10));
    harness.reads.push({ refuse: 404, code: VERSION_NOT_FOUND });
    const body = await harness.open({ version: "release" });
    const { error } = await readAll(body.stream());
    expect(error).toMatchObject({ status: 404, code: VERSION_NOT_FOUND });
    expect(
      harness
        .requests("/files/content", "HEAD")[0]
        ?.url.searchParams.get("version"),
    ).toBe("release");
    expect(
      harness.requests("/files/content")[0]?.url.searchParams.get("version"),
    ).toBe(String(SAVED_VERSION));
    expect(harness.requests("/files/content", "HEAD")).toHaveLength(1);
    expect(harness.pacing.waits).toEqual([]);
  });

  // Contract: the latest version that stops being kept is resolved once
  // more, and the stream goes on from where it stopped while the entity tag
  // is unchanged, on the version that now holds those bytes.
  it("follows the latest version while its bytes are unchanged", async () => {
    const bytes = contentOf(FILE_PIECE_BYTES + 10);
    const harness = new Harness(bytes);
    harness.reads.push(
      { cutAfter: FILE_PIECE_BYTES },
      {
        answer: () => {
          harness.content = { ...harness.content, version: 9 };
          return new Response(
            JSON.stringify({ error: "gone", code: VERSION_NOT_FOUND }),
            { status: 404 },
          );
        },
      },
    );
    const body = await harness.open();
    expect(same(await drain(body), bytes)).toBe(true);
    expect(body.version).toBe(SAVED_VERSION);
    const heads = harness.requests("/files/content", "HEAD");
    expect(heads).toHaveLength(2);
    expect(heads[1]?.url.searchParams.get("version")).toBeNull();
    const reads = harness.requests("/files/content");
    expect(reads.at(-1)?.url.searchParams.get("version")).toBe("9");
    expect(reads.at(-1)?.headers.get("range")).toBe(
      `bytes=${String(FILE_PIECE_BYTES)}-${String(bytes.length - 1)}`,
    );
  });

  // Contract: when the bytes did change, the stream ends with the refusal:
  // what it already handed over cannot be taken back.
  it("ends when the latest version's bytes changed", async () => {
    const bytes = contentOf(FILE_PIECE_BYTES + 10);
    const harness = new Harness(bytes);
    harness.reads.push(
      { cutAfter: FILE_PIECE_BYTES },
      {
        answer: () => {
          const other = contentOf(FILE_PIECE_BYTES + 11);
          harness.content = {
            bytes: other,
            etag: fileEtagOf(other),
            version: 9,
          };
          return new Response(
            JSON.stringify({ error: "gone", code: VERSION_NOT_FOUND }),
            { status: 404 },
          );
        },
      },
    );
    const { chunks, error } = await readAll((await harness.open()).stream());
    expect(chunks).toHaveLength(1);
    expect(error).toMatchObject({ status: 404, code: VERSION_NOT_FOUND });
  });

  // Contract: following is bounded: a version refused again with no byte
  // gained ends the download rather than looping.
  it("does not follow twice without a gain", async () => {
    const harness = new Harness(contentOf(10));
    harness.always = { refuse: 404, code: VERSION_NOT_FOUND };
    const { error } = await readAll((await harness.open()).stream());
    expect(error).toMatchObject({ code: VERSION_NOT_FOUND });
    expect(harness.requests("/files/content", "HEAD")).toHaveLength(2);
    expect(harness.ranges()).toHaveLength(2);
  });

  // Contract: an answer other than exactly the range asked for is never
  // read: a stale If-Range's whole content, a range starting elsewhere, or
  // other bytes' entity tag. A named version ends there, with no byte of it
  // handed over.
  it.each<[string, Step]>([
    ["whole content", { whole: true }],
    ["another range", { wrongRange: true }],
    ["another entity tag", { etag: '"other"' }],
  ])("refuses %s for a named version", async (_, step) => {
    const harness = new Harness(contentOf(10));
    harness.reads.push(step);
    const { chunks, error } = await readAll(
      (await harness.open({ version: "3" })).stream(),
    );
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({
      code: "invalid_response",
      message: "saved content changed during the read",
    });
  });

  // Contract: the same answer for the latest version is resolved once more,
  // and goes on only while the entity tag is unchanged.
  it("follows the latest version past a stale answer", async () => {
    const bytes = contentOf(10);
    const harness = new Harness(bytes);
    harness.reads.push({ whole: true });
    expect(same(await drain(await harness.open()), bytes)).toBe(true);
    expect(harness.requests("/files/content", "HEAD")).toHaveLength(2);
  });

  // Contract: a piece list that belongs to other bytes is the same answer.
  it("refuses a piece list of other bytes", async () => {
    const harness = new Harness(contentOf(FILE_PIECE_BYTES + 1));
    harness.pieces.push({ etag: '"other"' });
    const { error } = await readAll(
      (await harness.open({ version: "3" })).stream(),
    );
    expect(error).toMatchObject({ code: "invalid_response" });
    expect(harness.ranges()).toHaveLength(0);
  });

  // Contract: a redirect is never followed or retried.
  it("does not retry a refused redirect", async () => {
    const harness = new Harness(contentOf(10));
    harness.reads.push({
      answer: () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://elsewhere.example.test/" },
        }),
    });
    const { error } = await readAll((await harness.open()).stream());
    expect(error).toMatchObject({ code: "redirect_refused" });
    expect(harness.ranges()).toHaveLength(1);
  });

  // Contract: onProgress counts only bytes handed over, from zero, with the
  // content's length, resets nothing across a cut, and ends at the total.
  it("reports progress in verified bytes", async () => {
    const bytes = contentOf(FILE_PIECE_BYTES + 10);
    const harness = new Harness(bytes);
    harness.reads.push({ cutAfter: FILE_PIECE_BYTES + 3 });
    const seen: unknown[] = [];
    await drain(
      await harness.open({ onProgress: (progress) => seen.push(progress) }),
    );
    expect(seen).toEqual([
      { done: 0, total: bytes.length },
      { done: FILE_PIECE_BYTES, total: bytes.length },
      { done: bytes.length, total: bytes.length },
    ]);
  });

  // Contract: a throwing onProgress ends the stream with that error, not a
  // retry.
  it("ends the stream when onProgress throws", async () => {
    const harness = new Harness(contentOf(10));
    const failure = new RangeError("from the caller");
    const body = await harness.open({
      onProgress: () => {
        throw failure;
      },
    });
    const { error } = await readAll(body.stream());
    expect(error).toBe(failure);
    expect(harness.pacing.waits).toEqual([]);
  });

  // Contract: no content is requested, and no listener held, until the body
  // is read; a body never read holds nothing.
  it("opens nothing until the body is read", async () => {
    const harness = new Harness(contentOf(10));
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener");
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    await harness.open({ signal: caller.signal });
    expect(harness.ranges()).toEqual([]);
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
    expect(harness.pacing.timers.size).toBe(0);
  });

  // Contract: the caller's signal stops a read in progress with its reason,
  // leaving no timer and no listener behind.
  it("aborts a read in progress", async () => {
    const harness = new Harness(contentOf(10));
    harness.reads.push({ hold: true });
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener");
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const read = readAll(
      (await harness.open({ signal: caller.signal })).stream(),
    );
    await vi.waitFor(() => {
      expect(harness.pacing.timers.size).toBe(1);
      expect(harness.ranges()).toHaveLength(1);
    });
    const reason = new Error("stopped by the caller");
    caller.abort(reason);
    expect((await read).error).toBe(reason);
    expect(harness.pacing.timers.size).toBe(0);
    expect(harness.pacing.waits).toEqual([]);
    expect(harness.requests("/files/content")[0]?.signal?.aborted).toBe(true);
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
  });

  // Contract: the signal also stops a wait between tries, and a HEAD.
  it("aborts a wait and a HEAD", async () => {
    const waiting = new Harness(contentOf(10));
    waiting.always = { refuse: 503 };
    waiting.pacing.holdWaits = true;
    const during = new AbortController();
    const read = readAll(
      (await waiting.open({ signal: during.signal })).stream(),
    );
    await vi.waitFor(() => {
      expect(waiting.pacing.waits).toHaveLength(1);
    });
    const reason = new Error("stopped while waiting");
    during.abort(reason);
    expect((await read).error).toBe(reason);
    expect(waiting.ranges()).toHaveLength(1);

    const heading = new Harness(contentOf(10));
    heading.heads.push({ hang: true });
    const before = new AbortController();
    const opening = heading.open({ signal: before.signal });
    await vi.waitFor(() => {
      expect(heading.requests("/files/content", "HEAD")).toHaveLength(1);
    });
    const headReason = new Error("stopped while resolving");
    before.abort(headReason);
    await expect(opening).rejects.toBe(headReason);
    expect(heading.pacing.timers.size).toBe(0);
  });

  // Contract: a signal aborted before the first read ends it with no
  // content request.
  it("aborts before the first read", async () => {
    const harness = new Harness(contentOf(10));
    const caller = new AbortController();
    const body = await harness.open({ signal: caller.signal });
    const reason = new Error("stopped early");
    caller.abort(reason);
    expect((await readAll(body.stream())).error).toBe(reason);
    expect(harness.ranges()).toEqual([]);
  });

  // Contract: cancelling the stream ends the request in progress and leaves
  // nothing running, and is not treated as a break to retry.
  it("cancels", async () => {
    const harness = new Harness(contentOf(10));
    harness.reads.push({ hold: true });
    const reader = (await harness.open()).stream().getReader();
    const pending = reader.read();
    await vi.waitFor(() => {
      expect(harness.pacing.timers.size).toBe(1);
      expect(harness.ranges()).toHaveLength(1);
    });
    await reader.cancel();
    expect((await pending).done).toBe(true);
    await vi.waitFor(() => {
      expect(harness.pacing.timers.size).toBe(0);
    });
    expect(harness.requests("/files/content")[0]?.signal?.aborted).toBe(true);
    expect(harness.ranges()).toHaveLength(1);
    expect(harness.pacing.waits).toEqual([]);
  });
});

describe("download link requests", () => {
  // Contract: a save-first selector is refused before any request, and a
  // link is sent as the path alone when no version is named.
  it("sends a link's request and refuses a save", async () => {
    const link = {
      url: "https://download.example.test/link",
      expiresAt: "2026-01-02T03:04:05Z",
      version: 4,
    };
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.pathname.endsWith("/files/download-link")
          ? json(link, 201)
          : undefined,
    });
    const service = plane.client().account.computers;
    const request = { path: "data.bin" };
    expect(await service.createFileDownloadLinkById(ID, request)).toEqual(link);
    const sent = plane.subnetRequests();
    expect(sent.map((one) => one.method)).toEqual(["POST"]);
    expect(sent[0]?.url.pathname).toContain(`/computers/by-id/${ID}/`);
    expect(JSON.parse(sent[0]?.body ?? "null")).toEqual(request);
    await expect(
      service.createFileDownloadLinkById(ID, {
        ...request,
        version: "save-first",
      }),
    ).rejects.toThrow("a download link cannot save first");
    expect(plane.subnetRequests()).toHaveLength(1);
  });
});

describe("file tags and entity tags", () => {
  const EMPTY_TAG =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  // Contract: a file's tag is the SHA-256 of its bytes for one piece, of no
  // bytes for none, and of its piece hashes for several.
  it("computes a file's tag from its piece hashes", async () => {
    expect(await fileTagOfPieces(new Uint8Array())).toBe(EMPTY_TAG);
    const one = pieceHashesOf(contentOf(10));
    expect(await fileTagOfPieces(one)).toBe(Buffer.from(one).toString("hex"));
    const large = contentOf(FILE_PIECE_BYTES + 1);
    expect(fileEtagOf(large)).toBe(
      fileEtag(await fileTagOfPieces(pieceHashesOf(large)), large.length),
    );
  });

  // Contract: an entity tag is read only as `fileEtag` writes it, so an
  // archive's opaque one, or any other spelling, has no parts.
  it("reads only a file's entity tag", () => {
    const tag = "a".repeat(64);
    expect(fileEtag(tag, 12)).toBe(`"${tag}-12"`);
    expect(parseFileEtag(`"${tag}-12"`)).toEqual({ tag, size: 12 });
    expect(parseFileEtag(`"${tag}-0"`)).toEqual({ tag, size: 0 });
    for (const value of [
      "",
      `${tag}-12`,
      `W/"${tag}-12"`,
      `"${tag}"`,
      `"${tag}-"`,
      `"${tag}-012"`,
      `"${tag}--1"`,
      `"${"A".repeat(64)}-1"`,
      `"${"a".repeat(63)}-1"`,
      `"${tag}-18446744073709551616"`,
      '"tar1-0a1b2c"',
    ]) {
      expect(parseFileEtag(value)).toBeUndefined();
    }
  });

  // Contract: the record that carries a file's tag in an archive has a
  // public name.
  it("names the archive's tag record", () => {
    expect(ARCHIVE_TAG_RECORD).toBe("comment");
  });

  // Contract: a listing entry carries `tag` where given, and `sha256` may be
  // absent.
  it("reads a listing entry with a tag and no sha256", () => {
    const tag = "b".repeat(64);
    expect(
      decodeFileEntry({ name: "a", type: "file", mode: 420, size: 1, tag }),
    ).toMatchObject({ tag });
    expect(
      decodeFileEntry({ name: "a", type: "file", mode: 420, size: 1 }).sha256,
    ).toBeUndefined();
  });
});
