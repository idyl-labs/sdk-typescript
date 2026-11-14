// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// A `files` session: the client names the folders it watches, and the
// endpoint lists each one from the Computer's live disk, then lists it
// again shortly after it changes. A listing arrives as a pass of one or
// more `listing` frames; the session hands the caller whole passes.

import { isWellFormed } from "../resource/validation.js";
import { FrameError, encodeFrame } from "./frames.js";
import type { EndpointFrame, FolderEntry, FolderProblem } from "./frames.js";

/** The longest folder path a `files` session takes, in UTF-8 bytes. */
const MAX_PATH_BYTES = 4096;
/** The longest path segment a `files` session takes, in UTF-8 bytes. */
const MAX_SEGMENT_BYTES = 255;
/** The most entries one pass lists. */
const MAX_PASS_ENTRIES = 10_000;

const utf8 = new TextEncoder();

/** One whole listing of a watched folder, replacing any earlier one. */
export interface FolderListing {
  /** The folder, relative to `/workspace`; `""` is the root. */
  readonly path: string;
  /**
   * The folder's entries, ordered by name in byte order. Empty when
   * `problem` is present. The root's listing never names `.runtime`.
   */
  readonly entries: readonly FolderEntry[];
  /** Why the folder could not be listed; absent when it was. */
  readonly problem?: FolderProblem;
  /**
   * Present and true when the folder holds more entries than one pass
   * lists: `entries` are the first 10,000 by name.
   */
  readonly truncated?: boolean;
}

/** What a `files` session calls as listings arrive. */
export interface FilesSessionHandlers {
  /**
   * Called with each whole pass of a watched folder, in the order the
   * endpoint sent them. A pass for a folder unwatched since is not
   * delivered. An exception it throws does not end the session.
   */
  onListing(listing: FolderListing): void;
}

/**
 * How a `files` session ended:
 *
 * - `closed`: closed by the caller.
 * - `ended`: the endpoint ended the stream, as when the session's grant
 *   ends or the Computer stops.
 * - `broken`: the connection to the Computer was lost.
 * - `error`: the endpoint ended the stream with an error frame; `code` is
 *   its stable code.
 * - `failed`: the session could not be opened or read; `error` is why. A
 *   refused create is an `ApiError`, a `ComputerNotAwakeError` when the
 *   Computer is not awake.
 */
export type FilesSessionEnding =
  | { readonly reason: "closed" }
  | { readonly reason: "ended" }
  | { readonly reason: "broken" }
  | { readonly reason: "error"; readonly code: string }
  | { readonly reason: "failed"; readonly error: unknown };

/**
 * A `files` session on a Computer: listings of the folders it watches,
 * from the Computer's live disk. It starts no process, saves nothing,
 * never wakes the Computer and never keeps it awake. It is renewed with
 * the connector's other sessions until it ends.
 */
export interface ComputerFilesSession {
  /** Resolves once, with how the session ended. It never rejects. */
  readonly ended: Promise<FilesSessionEnding>;
  /**
   * Watches the folder at `path`, relative to `/workspace` (`""` is the root),
   * and asks for a pass of that folder. Watching a folder already watched asks
   * for a fresh pass. A session watches at most 32 folders; a further watch is
   * answered with the problem `too_many`. A path the endpoint takes is segments
   * joined by `/`, no leading or trailing `/`, no empty, `.` or `..` segment,
   * well-formed text, at most 4096 bytes in UTF-8 and at most 255 bytes per
   * segment. Does nothing once the session has ended.
   *
   * @param path the folder, relative to `/workspace`
   * @throws TypeError `path` is not one the endpoint takes; nothing is sent
   */
  watch(path: string): void;
  /**
   * Stops watching the folder at `path`. Unwatching a folder not watched
   * does nothing.
   *
   * @param path the folder, relative to `/workspace`
   * @throws TypeError `path` is one {@link ComputerFilesSession.watch}
   *   refuses; nothing is sent
   */
  unwatch(path: string): void;
  /** Ends the session on purpose. */
  close(): void;
}

/** The session stream a `files` session reads and writes. */
export interface FilesStream {
  readonly output: ReadableStream<EndpointFrame | { readonly type: "broken" }>;
  /** Sends one encoded frame, unless the stream has ended. */
  sendFrame(frame: Uint8Array): void;
  /** Finishes the stream and stops renewing its session. */
  close(): void;
}

/**
 * Judges a folder path as a `files` session takes it. Throws a
 * `TypeError`.
 */
export function validateFolderPath(path: string): void {
  if (typeof path !== "string") {
    throw new TypeError("folder path must be a string");
  }
  if (path === "") return;
  if (!isWellFormed(path)) {
    throw new TypeError("folder path is not well-formed text");
  }
  if (utf8.encode(path).length > MAX_PATH_BYTES) {
    throw new TypeError(
      `folder path must not exceed ${String(MAX_PATH_BYTES)} bytes`,
    );
  }
  for (const segment of path.split("/")) {
    if (segment === "") {
      throw new TypeError(
        "folder path must not start or end with / or hold an empty segment",
      );
    }
    if (segment === "." || segment === "..") {
      throw new TypeError("folder path must not hold a . or .. segment");
    }
    if (utf8.encode(segment).length > MAX_SEGMENT_BYTES) {
      throw new TypeError(
        `folder path segment must not exceed ${String(MAX_SEGMENT_BYTES)} bytes`,
      );
    }
  }
}

/**
 * Gathers `listing` frames into whole passes. A pass is every frame for
 * one path up to and including the first whose `more` is false.
 */
export class ListingPasses {
  readonly #open = new Map<string, FolderEntry[]>();

  /**
   * Takes one `listing` frame; returns the pass it completes, if any.
   * Throws a {@link FrameError} for a pass longer than the endpoint may
   * send.
   */
  push(
    frame: Extract<EndpointFrame, { type: "listing" }>,
  ): FolderListing | undefined {
    const entries = this.#open.get(frame.path) ?? [];
    if (entries.length + frame.entries.length > MAX_PASS_ENTRIES) {
      this.#open.delete(frame.path);
      throw new FrameError("session frame listing exceeds the pass bound");
    }
    entries.push(...frame.entries);
    if (frame.more) {
      this.#open.set(frame.path, entries);
      return undefined;
    }
    this.#open.delete(frame.path);
    return Object.freeze({
      path: frame.path,
      entries: Object.freeze(entries),
      ...(frame.problem === undefined ? {} : { problem: frame.problem }),
      ...(frame.truncated === true ? { truncated: true } : {}),
    });
  }

  /** Drops any unfinished pass of `path`. */
  drop(path: string): void {
    this.#open.delete(path);
  }
}

/** Runs a `files` session over `stream`. */
export function filesSession(
  stream: FilesStream,
  handlers: FilesSessionHandlers,
): ComputerFilesSession {
  const watched = new Set<string>();
  const passes = new ListingPasses();
  let over = false;
  let settle: (ending: FilesSessionEnding) => void = () => undefined;
  const ended = new Promise<FilesSessionEnding>((resolve) => {
    settle = resolve;
  });
  const finish = (ending: FilesSessionEnding): void => {
    if (over) return;
    over = true;
    watched.clear();
    stream.close();
    settle(ending);
  };
  const deliver = (listing: FolderListing): void => {
    try {
      handlers.onListing(listing);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  };
  void (async () => {
    const reader = stream.output.getReader();
    let ending: FilesSessionEnding | undefined;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.type === "listing") {
          if (!watched.has(value.path)) {
            passes.drop(value.path);
            continue;
          }
          const listing = passes.push(value);
          if (listing !== undefined) deliver(listing);
        } else if (value.type === "error") {
          ending ??= { reason: "error", code: value.code };
        } else if (value.type === "broken") {
          ending ??= { reason: "broken" };
        }
      }
    } catch (error) {
      ending ??= { reason: "failed", error };
    }
    finish(ending ?? { reason: "ended" });
  })();
  return {
    ended,
    watch(path) {
      validateFolderPath(path);
      if (over) return;
      watched.add(path);
      stream.sendFrame(encodeFrame({ type: "watch", path }));
    },
    unwatch(path) {
      validateFolderPath(path);
      if (over || !watched.delete(path)) return;
      passes.drop(path);
      stream.sendFrame(encodeFrame({ type: "unwatch", path }));
    },
    close() {
      if (over) return;
      stream.sendFrame(encodeFrame({ type: "end" }));
      finish({ reason: "closed" });
    },
  };
}
