// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// `workload-session/json-v2`: the frames of one session stream on a
// Computer connection, as the reference contract defines them. A frame is a
// big-endian uint32 length, then that many bytes of JSON whose first member
// names the frame's type. Byte fields are standard base64. A client encodes
// its frames in the published member order and reads the endpoint's
// frames leniently: an unknown member is ignored, and a frame of an unknown
// type is returned as such for the caller to judge.

import { validateComputerSessionHostKey } from "../api/computer-session-host-key.js";
import { decodeBase64, encodeBase64 } from "../resource/base64.js";

/** The profile every `open` names. */
export const SESSION_STREAM_PROFILE = "workload-session/json-v2";
/** The largest frame on a session stream, in bytes. */
export const MAX_FRAME_BYTES = 64 << 10;
/** The largest payload of one stdin, stdout or stderr frame, in bytes. */
export const MAX_DATA_BYTES = 32 << 10;

/**
 * The additions a client asks for in `open.features`: `save-result`, the
 * save that covers an exec, after its exit; `reattach`, a session that
 * survives the loss of its stream; and `raw-after-opened`, raw bytes in
 * both directions from the byte after `opened`, the one feature of an `ssh`
 * stream, which no other mode takes.
 */
export type SessionFeature = "save-result" | "reattach" | "raw-after-opened";

/**
 * What a session stream runs. An `ssh` stream carries one SSH connection:
 * its `opened` frame is the last frame in either direction, and from the
 * byte after it both directions carry raw SSH bytes.
 */
export type SessionMode =
  "shell" | "exec" | "cell" | "reattach" | "records" | "files" | "ssh";

/**
 * A terminal's size in character cells: `cols` and `rows` are whole
 * numbers from 1 to 10000 each.
 */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** A session stream's first frame. */
export interface OpenFrame {
  readonly requestID: string;
  readonly mode: SessionMode;
  readonly shell?: string;
  readonly command?: readonly string[];
  readonly script?: string;
  readonly tty: boolean;
  readonly size?: TerminalSize;
  readonly term?: string;
  readonly locale?: string;
  readonly session?: string;
  readonly cursor?: number;
  readonly notebook?: string;
  readonly after?: number;
  readonly features?: readonly SessionFeature[];
}

/** A frame the client sends. */
export type ClientFrame =
  | ({ readonly type: "open" } & OpenFrame)
  | { readonly type: "stdin"; readonly data: Uint8Array }
  | { readonly type: "resize"; readonly size: TerminalSize }
  | { readonly type: "close_input" }
  | { readonly type: "end" }
  | { readonly type: "watch"; readonly path: string }
  | { readonly type: "unwatch"; readonly path: string };

/**
 * What a folder entry is: `file`, `dir`, `symlink`, or `other` (a fifo, a
 * socket or a device). The union is open: an endpoint may name a newer
 * type, which a reader shows as it would `other`.
 */
export type FolderEntryType =
  "file" | "dir" | "symlink" | "other" | (string & Record<never, never>);

/** One entry of a folder on a Computer's live disk. */
export interface FolderEntry {
  /** The entry's name within its folder. */
  readonly name: string;
  readonly type: FolderEntryType;
  /** The size in bytes; 0 for a folder. */
  readonly size: number;
  /** The permission bits (`st_mode & 0o7777`). */
  readonly mode: number;
  /** The modification time, in milliseconds since the Unix epoch. */
  readonly modified: number;
  /** Where a symlink points, as stored; only a symlink has one. */
  readonly target?: string;
}

/**
 * Why a watched folder could not be listed: `not_found` (it is missing or
 * was removed or moved away; it stays watched and is listed again if it
 * reappears), `not_folder` (the path names a file, a symlink or another
 * entry), `denied` (the Computer's user cannot read it), `too_many` (the
 * stream already watches the most folders it may; the watch was not
 * taken). The union is open for later reasons.
 */
export type FolderProblem =
  | "not_found"
  | "not_folder"
  | "denied"
  | "too_many"
  | (string & Record<never, never>);

/** A frame the endpoint sends, as read. */
export type EndpointFrame =
  | {
      readonly type: "opened";
      readonly session: string;
      readonly shell?: string;
      readonly cursor?: number;
      readonly dropped?: boolean;
      /**
       * The SSH host key of the endpoint serving an `ssh` stream, one
       * `ssh-ed25519 <base64>` line; only an `ssh` stream's `opened`
       * carries one, and it always does.
       */
      readonly hostKey?: string;
    }
  | { readonly type: "stdout" | "stderr"; readonly data: Uint8Array }
  | { readonly type: "exit"; readonly code?: number; readonly signal?: string }
  | {
      readonly type: "saved";
      readonly outcome: string;
      readonly revision?: number;
      readonly reason?: string;
    }
  | { readonly type: "error"; readonly code: string; readonly message?: string }
  | {
      readonly type: "record";
      readonly cell: string;
      readonly order: number;
      readonly meta: unknown;
    }
  | {
      readonly type: "record_output";
      readonly cell: string;
      readonly stream: string;
      readonly data: Uint8Array;
    }
  | { readonly type: "records_end"; readonly count: number }
  | {
      readonly type: "listing";
      /** The folder, relative to `/workspace`; `""` is the root. */
      readonly path: string;
      /** This frame's entries, ordered by name in byte order. */
      readonly entries: readonly FolderEntry[];
      /** Whether more frames of the same pass follow. */
      readonly more: boolean;
      readonly problem?: FolderProblem;
      /** Present and true when the folder holds more entries than a pass lists. */
      readonly truncated?: boolean;
    }
  | { readonly type: "unknown"; readonly frameType: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The JSON text of `frame`, members in the published order. */
export function frameJson(frame: ClientFrame): string {
  switch (frame.type) {
    case "open": {
      const o: Record<string, unknown> = {
        type: "open",
        profile: SESSION_STREAM_PROFILE,
        requestID: frame.requestID,
        mode: frame.mode,
      };
      if (frame.shell !== undefined) o["shell"] = frame.shell;
      if (frame.command !== undefined && frame.command.length > 0) {
        o["command"] = frame.command;
      }
      if (frame.script !== undefined) o["script"] = frame.script;
      o["tty"] = frame.tty;
      if (frame.size !== undefined) {
        o["size"] = { cols: frame.size.cols, rows: frame.size.rows };
      }
      if (frame.term !== undefined) o["term"] = frame.term;
      if (frame.locale !== undefined) o["locale"] = frame.locale;
      if (frame.session !== undefined) o["session"] = frame.session;
      if (frame.cursor !== undefined) o["cursor"] = frame.cursor;
      if (frame.notebook !== undefined) o["notebook"] = frame.notebook;
      if (frame.after !== undefined) o["after"] = frame.after;
      if (frame.features !== undefined && frame.features.length > 0) {
        o["features"] = frame.features;
      }
      return JSON.stringify(o);
    }
    case "stdin":
      return JSON.stringify({ type: "stdin", data: encodeBase64(frame.data) });
    case "resize":
      return JSON.stringify({
        type: "resize",
        size: { cols: frame.size.cols, rows: frame.size.rows },
      });
    case "close_input":
    case "end":
      return JSON.stringify({ type: frame.type });
    case "watch":
    case "unwatch":
      return JSON.stringify({ type: frame.type, path: frame.path });
  }
}

/**
 * The bytes of `frame` on the stream: its length, then its JSON. Throws a
 * `RangeError` for a frame larger than {@link MAX_FRAME_BYTES}.
 */
export function encodeFrame(frame: ClientFrame): Uint8Array {
  const body = encoder.encode(frameJson(frame));
  if (body.length > MAX_FRAME_BYTES) {
    throw new RangeError("session frame exceeds the frame size limit");
  }
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

/** Frames of stdin for `data`, each within {@link MAX_DATA_BYTES}. */
export function stdinFrames(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += MAX_DATA_BYTES) {
    frames.push(
      encodeFrame({
        type: "stdin",
        data: data.subarray(at, at + MAX_DATA_BYTES),
      }),
    );
  }
  return frames;
}

/**
 * A session frame that cannot be read: one longer than the frame bound, not
 * UTF-8 JSON, not an object, or with a field of the wrong form. The stream
 * it arrived on ends, and the session's `output` errors with it. The
 * message is a fixed sentence naming the rule; it never carries the
 * frame's bytes.
 */
export class FrameError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FrameError";
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function bytes(value: unknown): Uint8Array {
  if (typeof value !== "string") {
    throw new FrameError("session frame data is not base64 text");
  }
  try {
    return decodeBase64(value);
  } catch (cause) {
    throw new FrameError("session frame data is not base64 text", { cause });
  }
}

/** Reads one entry of a `listing` frame. An entry must be an object. */
function folderEntry(value: unknown): FolderEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FrameError("session frame listing entry is not an object");
  }
  const e = value as Record<string, unknown>;
  const target = text(e["target"]);
  return {
    name: text(e["name"]) ?? "",
    type: text(e["type"]) ?? "",
    size: integer(e["size"]) ?? 0,
    mode: integer(e["mode"]) ?? 0,
    modified: integer(e["modified"]) ?? 0,
    ...(target === undefined ? {} : { target }),
  };
}

/** An `opened` frame, as read. */
export type OpenedFrame = Extract<EndpointFrame, { readonly type: "opened" }>;

/**
 * Judges an `opened` frame as the answer to an open of `mode`: an `ssh`
 * stream's carries its session and host key and nothing else, and every
 * other mode's carries no host key. Throws a `TypeError`.
 */
export function validateOpenedFor(
  opened: OpenedFrame,
  mode: SessionMode,
): void {
  if (mode !== "ssh") {
    if (opened.hostKey !== undefined) {
      throw new TypeError("only an ssh stream's opened carries a host key");
    }
    return;
  }
  if (opened.hostKey === undefined) {
    throw new TypeError("an ssh stream's opened carries its host key");
  }
  if (
    opened.shell !== undefined ||
    opened.cursor !== undefined ||
    opened.dropped !== undefined
  ) {
    throw new TypeError(
      "an ssh stream's opened carries its session and host key alone",
    );
  }
}

/**
 * Reads one endpoint frame from its JSON text, leniently. A host key an
 * `opened` frame carries must be text, absent or null when there is none,
 * and one `ssh-ed25519` public key line, as `validateComputerSessionHostKey`
 * judges it.
 */
export function readFrame(json: string): EndpointFrame {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new FrameError("session frame is not JSON", { cause });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FrameError("session frame is not an object");
  }
  const f = value as Record<string, unknown>;
  const type = text(f["type"]) ?? "";
  switch (type) {
    case "opened": {
      const shell = text(f["shell"]);
      const cursor = integer(f["cursor"]);
      const member = f["hostKey"];
      if (
        member !== undefined &&
        member !== null &&
        typeof member !== "string"
      ) {
        throw new FrameError("session frame host key is not text");
      }
      const hostKey = member ?? "";
      if (hostKey !== "") {
        try {
          validateComputerSessionHostKey(hostKey);
        } catch (cause) {
          throw new FrameError(
            "session frame host key is not one ssh-ed25519 public key line",
            { cause },
          );
        }
      }
      return {
        type,
        session: text(f["session"]) ?? "",
        ...(shell === undefined ? {} : { shell }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(f["dropped"] === true ? { dropped: true } : {}),
        ...(hostKey === "" ? {} : { hostKey }),
      };
    }
    case "stdout":
    case "stderr":
      return { type, data: bytes(f["data"]) };
    case "exit": {
      const code = integer(f["code"]);
      const signal = text(f["signal"]);
      return {
        type,
        ...(code === undefined ? {} : { code }),
        ...(signal === undefined ? {} : { signal }),
      };
    }
    case "saved": {
      const revision = integer(f["revision"]);
      const reason = text(f["reason"]);
      return {
        type,
        outcome: text(f["outcome"]) ?? "",
        ...(revision === undefined ? {} : { revision }),
        ...(reason === undefined ? {} : { reason }),
      };
    }
    case "error": {
      const message = text(f["message"]);
      return {
        type,
        code: text(f["code"]) ?? "",
        ...(message === undefined ? {} : { message }),
      };
    }
    case "record":
      return {
        type,
        cell: text(f["cell"]) ?? "",
        order: integer(f["order"]) ?? 0,
        meta: f["meta"],
      };
    case "record_output":
      return {
        type,
        cell: text(f["cell"]) ?? "",
        stream: text(f["stream"]) ?? "",
        data: bytes(f["data"]),
      };
    case "records_end":
      return { type, count: integer(f["count"]) ?? 0 };
    case "listing": {
      const problem = text(f["problem"]);
      return {
        type,
        path: text(f["path"]) ?? "",
        entries: Array.isArray(f["entries"])
          ? f["entries"].map(folderEntry)
          : [],
        more: f["more"] === true,
        ...(problem === undefined || problem === "" ? {} : { problem }),
        ...(f["truncated"] === true ? { truncated: true } : {}),
      };
    }
    default:
      return { type: "unknown", frameType: type };
  }
}

/**
 * Splits a session stream's bytes into frames as they arrive. A frame that
 * declares more than {@link MAX_FRAME_BYTES} is refused before it is
 * buffered.
 */
export class FrameReader {
  #buffer = new Uint8Array(0);

  /** Takes in bytes and returns every complete frame. */
  push(chunk: Uint8Array): EndpointFrame[] {
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.length);
    const frames: EndpointFrame[] = [];
    let at = 0;
    for (;;) {
      if (joined.length - at < 4) break;
      const length = new DataView(
        joined.buffer,
        joined.byteOffset + at,
        4,
      ).getUint32(0);
      if (length > MAX_FRAME_BYTES) {
        throw new FrameError("session frame exceeds the frame size limit");
      }
      if (joined.length - at - 4 < length) break;
      let json: string;
      try {
        json = decoder.decode(joined.subarray(at + 4, at + 4 + length));
      } catch (cause) {
        throw new FrameError("session frame is not UTF-8", { cause });
      }
      frames.push(readFrame(json));
      at += 4 + length;
    }
    this.#buffer = joined.slice(at);
    return frames;
  }
}
