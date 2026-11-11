// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ListingPasses,
  filesSession,
  validateFolderPath,
} from "../src/computer-connection/files.js";
import type {
  FilesStream,
  FolderListing,
} from "../src/computer-connection/files.js";
import { FrameError } from "../src/computer-connection/frames.js";
import type {
  EndpointFrame,
  FolderEntry,
} from "../src/computer-connection/frames.js";

type Listing = Extract<EndpointFrame, { type: "listing" }>;

function entry(name: string): FolderEntry {
  return { name, type: "file", size: 1, mode: 0o644, modified: 1761650000000 };
}

function listing(
  path: string,
  names: readonly string[],
  more: boolean,
  extra: Partial<Listing> = {},
): Listing {
  return { type: "listing", path, entries: names.map(entry), more, ...extra };
}

/**
 * A session stream whose output the test feeds and whose sent frames it
 * reads back as JSON.
 */
class FakeStream implements FilesStream {
  readonly sent: unknown[] = [];
  closes = 0;
  readonly output: ReadableStream<EndpointFrame | { readonly type: "broken" }>;
  #controller!: ReadableStreamDefaultController<
    EndpointFrame | { readonly type: "broken" }
  >;

  constructor() {
    this.output = new ReadableStream({
      start: (controller) => {
        this.#controller = controller;
      },
    });
  }

  push(frame: EndpointFrame | { readonly type: "broken" }): void {
    this.#controller.enqueue(frame);
  }

  end(): void {
    this.#controller.close();
  }

  fail(error: unknown): void {
    this.#controller.error(error);
  }

  sendFrame(frame: Uint8Array): void {
    this.sent.push(JSON.parse(new TextDecoder().decode(frame.subarray(4))));
  }

  close(): void {
    this.closes += 1;
  }
}

/** Lets the session's reader take every frame queued so far. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("folder paths", () => {
  // Contract: a files session takes the root, and paths of segments joined
  // by `/` within the published byte bounds.
  it("accepts the root and relative paths", () => {
    for (const path of ["", "src", "src/app", "a b/ü", "x".repeat(255)]) {
      expect(() => {
        validateFolderPath(path);
      }, path).not.toThrow();
    }
    const deep = Array.from({ length: 16 }, () => "x".repeat(255)).join("/");
    expect(new TextEncoder().encode(deep).length).toBe(4095);
    expect(() => {
      validateFolderPath(deep);
    }).not.toThrow();
  });

  // Contract: a path the endpoint would refuse is refused before it is
  // sent: a leading, trailing or doubled `/`, a `.` or `..` segment,
  // ill-formed text, a segment over 255 bytes or a path over 4096 bytes.
  it("refuses paths that break a rule", () => {
    const tooLong = Array.from({ length: 18 }, () => "x".repeat(240)).join("/");
    for (const path of [
      "/src",
      "src/",
      "/",
      "src//app",
      ".",
      "src/..",
      "./src",
      "\ud800",
      "x".repeat(256),
      "é".repeat(128),
      tooLong,
    ]) {
      expect(() => {
        validateFolderPath(path);
      }, path).toThrow(TypeError);
    }
  });
});

describe("listing passes", () => {
  // Contract: frames with `more` gather into one pass, delivered whole
  // when the frame without `more` arrives; passes of different folders
  // gather apart.
  it("gathers frames into whole passes", () => {
    const passes = new ListingPasses();
    expect(passes.push(listing("src", ["a", "b"], true))).toBeUndefined();
    expect(passes.push(listing("lib", ["z"], true))).toBeUndefined();
    expect(passes.push(listing("src", ["c"], false))).toEqual({
      path: "src",
      entries: ["a", "b", "c"].map(entry),
    });
    expect(passes.push(listing("lib", [], false))).toEqual({
      path: "lib",
      entries: [entry("z")],
    });
    expect(passes.push(listing("src", ["d"], false))).toEqual({
      path: "src",
      entries: [entry("d")],
    });
  });

  // Contract: a pass's problem and truncation come with it.
  it("carries the problem and the truncation", () => {
    const passes = new ListingPasses();
    expect(
      passes.push(listing("gone", [], false, { problem: "not_found" })),
    ).toEqual({ path: "gone", entries: [], problem: "not_found" });
    passes.push(listing("big", ["a"], true));
    expect(
      passes.push(listing("big", ["b"], false, { truncated: true })),
    ).toEqual({
      path: "big",
      entries: [entry("a"), entry("b")],
      truncated: true,
    });
  });

  // Contract: a pass longer than the endpoint may send is refused, and
  // nothing of it is kept.
  it("refuses a pass beyond the entry bound", () => {
    const passes = new ListingPasses();
    const names = Array.from({ length: 5_000 }, (_, i) => String(i));
    passes.push(listing("big", names, true));
    passes.push(listing("big", names, true));
    expect(() => passes.push(listing("big", ["x"], false))).toThrow(FrameError);
    expect(passes.push(listing("big", ["y"], false))).toEqual({
      path: "big",
      entries: [entry("y")],
    });
  });

  // Contract: a delivered pass is the caller's and cannot be changed.
  it("hands out frozen passes", () => {
    const pass = new ListingPasses().push(listing("src", ["a"], false));
    expect(Object.isFrozen(pass)).toBe(true);
    expect(Object.isFrozen(pass?.entries)).toBe(true);
  });
});

describe("files session", () => {
  // Contract: watch and unwatch send their frames; a watched folder's
  // passes reach the handler whole; a pass of a folder not watched does
  // not; unwatching a folder not watched sends nothing.
  it("watches folders and delivers their passes", async () => {
    const stream = new FakeStream();
    const seen: FolderListing[] = [];
    const session = filesSession(stream, {
      onListing: (l) => seen.push(l),
    });
    session.watch("");
    session.watch("src");
    stream.push({ type: "opened", session: "s-1" });
    stream.push(listing("", ["src"], false));
    stream.push(listing("src", ["a"], true));
    stream.push(listing("other", ["x"], false));
    stream.push(listing("src", ["b"], false));
    await drain();
    expect(seen).toEqual([
      { path: "", entries: [entry("src")] },
      { path: "src", entries: [entry("a"), entry("b")] },
    ]);
    session.unwatch("src");
    session.unwatch("never");
    stream.push(listing("src", ["c"], false));
    await drain();
    expect(seen).toHaveLength(2);
    expect(stream.sent).toEqual([
      { type: "watch", path: "" },
      { type: "watch", path: "src" },
      { type: "unwatch", path: "src" },
    ]);
  });

  // Contract: watching a folder already watched asks again, which the
  // endpoint answers with a fresh pass.
  it("asks for a fresh pass when a folder is watched again", () => {
    const stream = new FakeStream();
    const session = filesSession(stream, { onListing: () => undefined });
    session.watch("src");
    session.watch("src");
    expect(stream.sent).toEqual([
      { type: "watch", path: "src" },
      { type: "watch", path: "src" },
    ]);
  });

  // Contract: an invalid path throws and sends nothing.
  it("refuses an invalid path without sending it", () => {
    const stream = new FakeStream();
    const session = filesSession(stream, { onListing: () => undefined });
    expect(() => {
      session.watch("../etc");
    }).toThrow(TypeError);
    expect(() => {
      session.unwatch("/src");
    }).toThrow(TypeError);
    expect(stream.sent).toEqual([]);
  });

  // Contract: close sends `end`, finishes the stream once, and ends the
  // session as closed; nothing is sent after it.
  it("closes with end", async () => {
    const stream = new FakeStream();
    const session = filesSession(stream, { onListing: () => undefined });
    session.close();
    session.close();
    session.watch("src");
    stream.end();
    expect(await session.ended).toEqual({ reason: "closed" });
    expect(stream.sent).toEqual([{ type: "end" }]);
    expect(stream.closes).toBe(1);
  });

  // Contract: how the stream ended is reported, and the stream is
  // finished so the session is no longer renewed.
  it("reports how the stream ended", async () => {
    const cases: [
      (s: FakeStream) => void,
      Awaited<ReturnType<typeof filesSession>["ended"]>,
    ][] = [
      [
        (s) => {
          s.push({ type: "error", code: "invalid_request", message: "x" });
          s.end();
        },
        { reason: "error", code: "invalid_request" },
      ],
      [
        (s) => {
          s.push({ type: "broken" });
          s.end();
        },
        { reason: "broken" },
      ],
      [
        (s) => {
          s.end();
        },
        { reason: "ended" },
      ],
    ];
    for (const [act, ending] of cases) {
      const stream = new FakeStream();
      const session = filesSession(stream, { onListing: () => undefined });
      act(stream);
      expect(await session.ended).toEqual(ending);
      expect(stream.closes).toBe(1);
    }
  });

  // Contract: a session whose create was refused ends `failed` with the
  // refusal as its error.
  it("reports a refused session as failed", async () => {
    const stream = new FakeStream();
    const session = filesSession(stream, { onListing: () => undefined });
    const refusal = new Error("refused");
    stream.fail(refusal);
    expect(await session.ended).toEqual({ reason: "failed", error: refusal });
    expect(stream.closes).toBe(1);
  });

  // Contract: an oversized pass ends the session as failed with a frame
  // error.
  it("ends on a pass beyond the bound", async () => {
    const stream = new FakeStream();
    const session = filesSession(stream, { onListing: () => undefined });
    session.watch("big");
    const names = Array.from({ length: 10_001 }, (_, i) => String(i));
    stream.push(listing("big", names, false));
    const ending = await session.ended;
    expect(ending.reason).toBe("failed");
    expect(ending.reason === "failed" && ending.error).toBeInstanceOf(
      FrameError,
    );
  });
});
