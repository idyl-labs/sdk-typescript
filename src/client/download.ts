// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * One download: a single stream over a saved file or tree that survives
 * breaks inside itself. The content is resolved once, every read is pinned to
 * that version and entity tag, and a cut asks for the rest from where the
 * stream stopped. A file is checked piece by piece as it arrives, so a break
 * costs only the piece in progress and no unchecked byte reaches the caller.
 * An archive has no piece list: it resumes by offset, and each file's tag
 * rides inside it in a PAX record for whoever unpacks it.
 */
import { ERROR_CODE_DOWNLOAD_LIMIT_REACHED } from "../api/billing-errors.js";
import {
  FILE_PIECE_BYTES,
  FILE_PIECE_HASH_BYTES,
  fileTagOfPieces,
  hexOf,
  parseFileEtag,
  type ContentFacts,
  type FileReadOptions,
  type StoredContent,
} from "../api/files.js";
import { ERROR_CODE_VERSION_NOT_FOUND } from "../api/storage-errors.js";
import { ApiError, TransportError } from "../errors.js";
import { abortable, delay } from "../internal/abort.js";
import { bodyFailure } from "../internal/transport.js";
import type { ComputersService } from "../services/computers.js";
import type { CallOptions } from "./common.js";
import { numberOf } from "./records.js";

/** A stream that delivers nothing for this long is cut. */
const SILENT_STREAM_MS = 30_000;
/** The first wait after a failed read, doubled up to `LAST_RETRY_WAIT_MS`. */
const FIRST_RETRY_WAIT_MS = 1_000;
const LAST_RETRY_WAIT_MS = 30_000;
/** A download that gains no byte for this long while asked for one stops. */
const NO_GAIN_LIMIT_MS = 15 * 60_000;

/** How far a download has come: bytes handed over, of the content's length. */
export interface DownloadProgress {
  readonly done: number;
  readonly total: number;
}

/** Downloads a file or a directory. */
export interface DownloadOptions extends CallOptions {
  /** Downloads the directory `path` names as a POSIX tar archive. */
  readonly archive?: boolean;
  /**
   * The saved version to read, by number or name; the latest when absent.
   * A named version that stops being kept ends the download. The latest,
   * when it stops being kept, is asked for once more: the download goes on
   * if the content is unchanged, and otherwise ends.
   */
  readonly version?: number | string;
  /**
   * Called with `{ done: 0, total }` when reading starts and again as bytes
   * are handed to the reader, in order, one call at a time. A file counts
   * only bytes that have been checked. A throw ends the stream with that
   * error.
   */
  readonly onProgress?: (progress: DownloadProgress) => void;
}

/**
 * A downloaded file or archive, read the way a `fetch` response is read:
 * once, by one of `stream`, `bytes`, `text`, `json` or `blob`. It is
 * streamed one piece at a time, never buffered beyond the piece in progress,
 * at most 4 MiB, until a reader asks for the whole of it. Nothing is
 * connected until the first read, so a body never read needs no cleanup; a
 * stream abandoned partway should be cancelled with `cancel()`.
 *
 * The stream survives breaks. A cut, a silent connection (30 s) or a server
 * error is retried from the byte the stream reached, waiting 1 s doubling to
 * 30 s with half of it random, or as long as `Retry-After` asks. It ends
 * with an error after 15 minutes of being read without gaining a byte, and
 * at once on a refusal another try cannot change: an `ApiError` such as
 * status 401, 403 or 404, or `DOWNLOAD_LIMIT_REACHED`. A saved version that
 * stops being kept ends it with `VERSION_NOT_FOUND`, or with a
 * `TransportError` with code `invalid_response` when the answer shows the
 * bytes changed, since bytes already handed over cannot be taken back. The
 * caller's `signal` ends it at any point with the signal's reason.
 *
 * A file's bytes are checked against its tag as they arrive, so none reaches
 * the reader unchecked. An archive is checked by whoever unpacks it, against
 * the `comment` PAX record each file carries.
 */
export interface FileBody {
  /** The saved version resolved for the content when the download started. */
  readonly version: number;
  /** The content's strong entity tag: for a file, its tag and length. */
  readonly etag: string;
  /** The content's length in bytes. */
  readonly size: number;
  /** Whether the body has been read. */
  readonly bodyUsed: boolean;
  stream(): ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
  /** The content decoded as UTF-8. */
  text(): Promise<string>;
  /** The content parsed as JSON. */
  json(): Promise<unknown>;
  blob(): Promise<Blob>;
}

/** What one download reads. */
export interface DownloadRequest extends CallOptions {
  /** The path, already held to the workspace. */
  readonly path: string;
  readonly archive: boolean;
  /** The version the caller named, by number or name. */
  readonly version?: string;
  readonly onProgress?: ((progress: DownloadProgress) => void) | undefined;
}

/** The time a download keeps: its clock, its waits and its silence timer. */
export interface DownloadPacing {
  now(): number;
  /** A number from 0 up to 1, the random part of a wait. */
  random(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  /** Runs `run` after `milliseconds`; the function returned cancels it. */
  after(milliseconds: number, run: () => void): () => void;
}

const systemPacing: DownloadPacing = {
  now: Date.now,
  random: Math.random,
  wait: delay,
  after(milliseconds, run) {
    const timer = setTimeout(run, milliseconds);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** A read that broke: a cut, a silent stream, a short body or wrong bytes. */
class BrokenRead extends Error {}

/** An answer that shows the version or bytes being read are not served. */
const CONTENT_MOVED = new Error();

/** One request's body, read under the silence limit. */
interface OpenRead {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  end(): void;
}

/**
 * Resolves the content with `HEAD`, rejecting on a refusal, and returns its
 * body. No content is requested until the body is first read.
 */
export async function openDownload(
  service: ComputersService,
  computerId: string,
  request: DownloadRequest,
  pacing: DownloadPacing = systemPacing,
): Promise<FileBody> {
  const { path, archive, signal, onProgress } = request;
  const kind = archive ? "archive" : "file";
  // The version every read names; empty asks for the latest.
  let pinned = request.version ?? "";
  const named = pinned !== "";
  const readOptions = (): FileReadOptions => ({ path, version: pinned });

  const cancelled = new AbortController();
  const stop = AbortSignal.any(
    signal === undefined ? [cancelled.signal] : [signal, cancelled.signal],
  );

  /** One request's abort: the download's, or its own when it goes silent. */
  const requestScope = () => {
    const controller = new AbortController();
    const scoped = AbortSignal.any([stop, controller.signal]);
    const end = (): void => {
      controller.abort(new BrokenRead());
    };
    return {
      signal: scoped,
      end,
      async watched<T>(work: Promise<T>): Promise<T> {
        work.catch(() => undefined);
        const cancel = pacing.after(SILENT_STREAM_MS, end);
        try {
          return await abortable(work, scoped);
        } finally {
          cancel();
        }
      },
    };
  };

  /** Opens one request, or fails as moved when it answers `undefined`. */
  const open = async (
    send: (signal: AbortSignal) => Promise<StoredContent | undefined>,
  ): Promise<OpenRead> => {
    const scope = requestScope();
    try {
      const content = await scope.watched(send(scope.signal));
      if (content === undefined) {
        throw CONTENT_MOVED;
      }
      const reader = content.body.getReader();
      return {
        read: async () => {
          try {
            return await scope.watched(reader.read());
          } catch (error) {
            throw new BrokenRead(undefined, { cause: error });
          }
        },
        end: () => {
          reader.cancel().catch(() => undefined);
          scope.end();
        },
      };
    } catch (error) {
      scope.end();
      throw error;
    }
  };

  const resolveHead = async (): Promise<ContentFacts> => {
    const scope = requestScope();
    return await scope.watched(
      service.headContentById(computerId, kind, readOptions(), {
        signal: scope.signal,
      }),
    );
  };

  let etag = "";
  let size = 0;
  let current: OpenRead | undefined;
  let rest: Uint8Array | undefined;
  const dropRead = (): void => {
    current?.end();
    current = undefined;
    rest = undefined;
  };

  /**
   * Runs `work` until it succeeds. It stops at once on an answer another try
   * cannot change, and after `NO_GAIN_LIMIT_MS`. The limit is measured from
   * this call, so time a reader spends away from the stream does not count.
   */
  const gaining = async <T>(work: () => Promise<T>): Promise<T> => {
    const since = pacing.now();
    let wait = FIRST_RETRY_WAIT_MS;
    let followed = false;
    for (;;) {
      try {
        return await work();
      } catch (error) {
        dropRead();
        if (stop.aborted) throw stop.reason;
        if (
          error === CONTENT_MOVED ||
          (error instanceof ApiError &&
            error.code === ERROR_CODE_VERSION_NOT_FOUND)
        ) {
          // Only the latest is followed, once in each stretch without a gain.
          if (named || followed) throw movedFailure(error);
          followed = true;
          pinned = "";
          const facts = await gaining(resolveHead);
          if (facts.etag !== etag) {
            throw movedFailure(error);
          }
          pinned = String(facts.version);
          continue;
        }
        if (!retryable(error)) throw error;
        if (pacing.now() - since >= NO_GAIN_LIMIT_MS) {
          throw bodyFailure("download stalled for 15 minutes", error);
        }
        await pacing.wait(
          Math.max(
            (wait * (1 + pacing.random())) / 2,
            (error as ApiError).retryAfterMs ?? 0,
          ),
          stop,
        );
        wait = Math.min(wait * 2, LAST_RETRY_WAIT_MS);
      }
    }
  };

  const facts = await gaining(resolveHead);
  etag = facts.etag;
  size = facts.size;
  const stated = archive ? undefined : parseFileEtag(etag);
  if (!archive && stated?.size !== size) {
    throw new TransportError(
      "invalid_response",
      "content response does not state its length, entity tag and version",
    );
  }
  const tag = stated?.tag ?? "";
  pinned = String(facts.version);

  let offset = 0;
  const openRest = async (): Promise<OpenRead> =>
    await open(
      async (signal) =>
        await service.readContentRangeById(
          computerId,
          kind,
          readOptions(),
          { offset, length: size - offset, etag },
          { signal },
        ),
    );

  /** Fills `buffer` from `read`, keeping what arrived beyond it for the next. */
  const fill = async (read: OpenRead, buffer: Uint8Array): Promise<void> => {
    let filled = 0;
    while (filled < buffer.length) {
      let chunk = rest;
      rest = undefined;
      if (chunk === undefined) {
        const { done, value } = await read.read();
        if (done) throw new BrokenRead();
        chunk = value;
      }
      const taken = Math.min(chunk.length, buffer.length - filled);
      buffer.set(chunk.subarray(0, taken), filled);
      filled += taken;
      if (taken < chunk.length) rest = chunk.subarray(taken);
    }
  };

  let hashes: string | undefined;
  /** The file's piece hashes in hexadecimal, read once and checked against its tag. */
  const pieceHashes = async (): Promise<string> => {
    if (hashes !== undefined) return hashes;
    const count = Math.ceil(size / FILE_PIECE_BYTES);
    if (count === 1) return tag;
    const list = new Uint8Array(count * FILE_PIECE_HASH_BYTES);
    const read = await open(async (signal) => {
      const content = await service.readFilePiecesById(
        computerId,
        readOptions(),
        { signal },
      );
      if (content.etag === etag) return content;
      await content.close();
      return undefined;
    });
    try {
      await fill(read, list);
    } finally {
      read.end();
      rest = undefined;
    }
    if ((await fileTagOfPieces(list)) !== tag) throw new BrokenRead();
    hashes = hexOf(list);
    return hashes;
  };

  /** The next piece, whole and checked; a piece is a new buffer it hands over. */
  const nextPiece = async (): Promise<Uint8Array> => {
    const expected = await pieceHashes();
    const read = (current ??= await openRest());
    const piece = new Uint8Array(Math.min(FILE_PIECE_BYTES, size - offset));
    await fill(read, piece);
    const at = (offset / FILE_PIECE_BYTES) * 2 * FILE_PIECE_HASH_BYTES;
    const digest = await crypto.subtle.digest("SHA-256", piece);
    if (!expected.startsWith(hexOf(new Uint8Array(digest)), at)) {
      throw new BrokenRead();
    }
    return piece;
  };

  /** The next bytes of an archive, as they arrive. */
  const nextChunk = async (): Promise<Uint8Array> => {
    const read = (current ??= await openRest());
    const { done, value } = await read.read();
    if (done) throw new BrokenRead();
    return value.subarray(0, size - offset);
  };

  let started = false;
  const source = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          stop.throwIfAborted();
          if (!started) {
            started = true;
            onProgress?.({ done: 0, total: size });
          }
          if (offset < size) {
            const bytes = await gaining(archive ? nextChunk : nextPiece);
            offset += bytes.length;
            controller.enqueue(bytes);
            onProgress?.({ done: offset, total: size });
          }
          if (offset === size) {
            dropRead();
            controller.close();
          }
        } catch (error) {
          dropRead();
          controller.error(error);
        }
      },
      cancel(reason) {
        dropRead();
        cancelled.abort(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return fileBody(source, { version: numberOf(facts.version), etag, size });
}

/** Whether another try can change a failed read's outcome. */
function retryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (
      error.code !== ERROR_CODE_DOWNLOAD_LIMIT_REACHED &&
      (error.status === 429 || error.status >= 500)
    );
  }
  if (error instanceof TransportError) {
    return error.code === "network_error" || error.code === "timeout";
  }
  return error instanceof BrokenRead;
}

/** What a caller sees when the content being read cannot be followed. */
function movedFailure(error: unknown): unknown {
  return error instanceof ApiError
    ? error
    : new TransportError(
        "invalid_response",
        "saved content changed during the read",
      );
}

/** A body read once, the way a `fetch` response is. */
function fileBody(
  source: ReadableStream<Uint8Array>,
  facts: Pick<FileBody, "version" | "etag" | "size">,
): FileBody {
  let used = false;
  const take = (): ReadableStream<Uint8Array> => {
    if (used) throw new TypeError("the body has already been read");
    used = true;
    return source;
  };
  const response = (): Response => new Response(take());
  return Object.freeze({
    ...facts,
    get bodyUsed() {
      return used;
    },
    stream: take,
    bytes: async () => new Uint8Array(await response().arrayBuffer()),
    text: async () => await response().text(),
    json: async (): Promise<unknown> => await response().json(),
    blob: async () => await response().blob(),
  });
}
