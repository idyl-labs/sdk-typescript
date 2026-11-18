// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The frames of `computer-events/json-v1`, the event stream a client holds
// to its Zone's Computer service: each frame is a 4-byte big-endian length,
// then that many bytes of one JSON object with a `type` member, at least
// one byte and at most MAX_COMPUTER_EVENT_FRAME_BYTES. The client sends
// `ticket` frames; the service sends `event`, `ended` and `error` frames. A service
// frame is read leniently: members this SDK does not know are carried, and
// a frame of a `type` it does not know is skipped.

import {
  MAX_COMPUTER_EVENT_FRAME_BYTES,
  type ComputerEventServiceFrame,
  type ComputerWatchTicketFrame,
} from "../api/computer-watch.js";
import { FrameError } from "./frames.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** One length-prefixed `ticket` frame. */
export function encodeTicketFrame(frame: ComputerWatchTicketFrame): Uint8Array {
  const body = encoder.encode(
    JSON.stringify({
      type: "ticket",
      watch: frame.watch,
      ticket: frame.ticket,
    }),
  );
  if (body.length > MAX_COMPUTER_EVENT_FRAME_BYTES) {
    throw new FrameError("event stream frame exceeds the frame size limit");
  }
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

/**
 * Reads the service's frames from the bytes of the event stream as they
 * arrive. A frame declaring no bytes or more than
 * MAX_COMPUTER_EVENT_FRAME_BYTES, or whose body is not one JSON object with
 * a string `type`, throws a `FrameError` before anything more is read; the
 * stream is then ended.
 */
export class EventFrameReader {
  #buffer = new Uint8Array(0);

  /** Takes in bytes and returns every complete frame of a known `type`. */
  push(chunk: Uint8Array): ComputerEventServiceFrame[] {
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.length);
    const frames: ComputerEventServiceFrame[] = [];
    let at = 0;
    for (;;) {
      if (joined.length - at < 4) break;
      const length = new DataView(
        joined.buffer,
        joined.byteOffset + at,
        4,
      ).getUint32(0);
      if (length === 0 || length > MAX_COMPUTER_EVENT_FRAME_BYTES) {
        throw new FrameError("event stream frame length is out of bounds");
      }
      if (joined.length - at - 4 < length) break;
      const frame = serviceFrame(joined.subarray(at + 4, at + 4 + length));
      if (frame !== undefined) frames.push(frame);
      at += 4 + length;
    }
    this.#buffer = joined.slice(at);
    return frames;
  }
}

/**
 * One service frame from its body: an `event` with a string `part`, an
 * `ended` with a string `watch`, or an `error` with a string `code`; `undefined` for a `type` this SDK does not
 * name. Optional members that are not strings read as absent.
 */
function serviceFrame(body: Uint8Array): ComputerEventServiceFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(body));
  } catch (cause) {
    throw new FrameError("event stream frame is not JSON", { cause });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FrameError("event stream frame is not a JSON object");
  }
  const o = value as Record<string, unknown>;
  const type = o["type"];
  if (typeof type !== "string") {
    throw new FrameError("event stream frame names no type");
  }
  const text = (key: string): Record<string, string> => {
    const member = o[key];
    return typeof member === "string" && member !== "" ? { [key]: member } : {};
  };
  switch (type) {
    case "event": {
      const part = o["part"];
      if (typeof part !== "string" || part === "") {
        throw new FrameError("event frame names no part");
      }
      return {
        type: "event",
        part,
        ...text("namespaceId"),
        ...text("computer"),
        ...text("id"),
      };
    }
    case "ended": {
      const watch = o["watch"];
      if (typeof watch !== "string" || watch === "") {
        throw new FrameError("ended frame names no watch");
      }
      return { type: "ended", watch };
    }
    case "error": {
      const code = o["code"];
      if (typeof code !== "string" || code === "") {
        throw new FrameError("error frame names no code");
      }
      return { type: "error", code, ...text("watch"), ...text("message") };
    }
    default:
      return undefined;
  }
}
