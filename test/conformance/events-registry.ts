// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * The codecs of the change-event goldens: the watch's create request and
 * answer, the event stream's frames and their framing, and a session trust
 * bundle that names its event service. Frames are read through the
 * package's own frame reader from their bytes, and the ticket frame is the
 * package's own encoding; each encode writes the members the reference
 * contract declares, in its order.
 */
import {
  validateComputerWatch,
  type ComputerEventServiceFrame,
  type ComputerWatch,
} from "../../src/api/computer-watch.js";
import {
  EventFrameReader,
  encodeTicketFrame,
} from "../../src/computer-connection/events.js";
import { readComputerEvents } from "../../src/computer-connection/trust.js";
import type { ServedCodec } from "./served-registry.js";

type Doc = Record<string, unknown>;

const utf8 = new TextEncoder();

/** A golden's document from its text or as parsed, carried as it is. */
function documentOf(document: unknown): Doc {
  const value: unknown =
    typeof document === "string" ? JSON.parse(document) : document;
  return { ...(value as Doc) };
}

/** `json` as one length-prefixed frame of the event stream. */
function framed(json: unknown): Uint8Array {
  const body = utf8.encode(JSON.stringify(json));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

/** One service frame, read by the package's reader from its bytes. */
function readServiceFrame(json: unknown): ComputerEventServiceFrame {
  const [frame, ...rest] = new EventFrameReader().push(framed(json));
  if (frame === undefined || rest.length > 0) {
    throw new TypeError("not one service frame");
  }
  return frame;
}

/** The members of `value` named, in that order, each only when present. */
function pick(value: Doc, names: readonly string[]): Doc {
  const out: Doc = {};
  for (const name of names) {
    if (value[name] !== undefined) out[name] = value[name];
  }
  return out;
}

/** A service frame as the reference contract writes it. */
function encodeServiceFrame(frame: ComputerEventServiceFrame): Doc {
  const value = frame as unknown as Doc;
  switch (frame.type) {
    case "event":
      return pick(value, ["type", "namespaceId", "computer", "part", "id"]);
    case "ended":
      return pick(value, ["type", "watch"]);
    case "error":
      return pick(value, ["type", "code", "watch", "message"]);
  }
}

/** A golden of one service frame. */
const serviceFrame: ServedCodec<ComputerEventServiceFrame> = {
  decode: (document) => readServiceFrame(documentOf(document)),
  encode: encodeServiceFrame,
  validate: () => undefined,
};

/** A golden naming several service frames, each read and written as one. */
const serviceFrames: ServedCodec<Doc> = {
  decode: (document) => {
    const doc = documentOf(document);
    const out: Doc = {};
    for (const [name, entry] of Object.entries(doc)) {
      out[name] =
        typeof entry === "object" && entry !== null
          ? readServiceFrame(entry)
          : entry;
    }
    return out;
  },
  encode: (value) => {
    const out: Doc = {};
    for (const [name, entry] of Object.entries(value)) {
      if (typeof entry === "object" && entry !== null) {
        out[name] = encodeServiceFrame(entry as ComputerEventServiceFrame);
      }
    }
    return out;
  },
  validate: () => undefined,
};

/** The client's frames: a ticket, encoded by the package. */
const clientFrames: ServedCodec<Doc> = {
  decode: documentOf,
  encode: (value) => {
    const ticket = value["ticket"] as Doc;
    const bytes = encodeTicketFrame({
      type: "ticket",
      watch: String(ticket["watch"]),
      ticket: String(ticket["ticket"]),
    });
    return {
      ticket: JSON.parse(new TextDecoder().decode(bytes.subarray(4))) as Doc,
    };
  },
  validate: () => undefined,
};

/** One frame's body and its bytes, length prefix included, in hex. */
const framing: ServedCodec<Doc> = {
  decode: (document) => {
    const doc = documentOf(document);
    const hex = String(doc["bytes"]);
    const bytes = Uint8Array.from(hex.match(/../gu) ?? [], (pair) =>
      Number.parseInt(pair, 16),
    );
    const [body] = new EventFrameReader().push(bytes);
    return { ...doc, body };
  },
  encode: (value) => {
    const body = encodeServiceFrame(value["body"] as ComputerEventServiceFrame);
    const bytes = [...framed(body)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return { body, bytes };
  },
  validate: () => undefined,
};

/** The watch create's request: an empty object. */
const watchRequests: ServedCodec<Doc> = {
  decode: documentOf,
  encode: () => ({ create: {} }),
  validate: () => undefined,
};

/** The watch create's answer. */
const watchResponse: ServedCodec<ComputerWatch> = {
  decode: (document) => documentOf(document) as unknown as ComputerWatch,
  encode: (value) =>
    pick(value as unknown as Doc, [
      "id",
      "namespaceId",
      "namespace",
      "subnet",
      "expiresAt",
      "ticket",
    ]),
  validate: validateComputerWatch,
};

/** A session trust bundle that names its event service. */
const trustBundle: ServedCodec<Doc> = {
  decode: documentOf,
  encode: (value) =>
    pick(value, [
      "type",
      "network",
      "zone",
      "version",
      "issuedAt",
      "expiresAt",
      "pod",
      "dataFabric",
      "computerEvents",
    ]),
  validate: (value) => {
    const named = readComputerEvents(
      value,
      String(value["zone"]),
      String(value["network"]),
    );
    if (named === undefined) {
      throw new TypeError("the bundle names no event service");
    }
  },
};

/** The change-event codecs, keyed as the served suite keys each golden. */
export const eventsRegistry: ReadonlyMap<
  string,
  ServedCodec<unknown>
> = new Map<string, ServedCodec<unknown>>([
  ["computer-watch.requests", watchRequests],
  ["computer-watch.create-response", watchResponse],
  ["computer-event.client-frames", clientFrames],
  ["computer-event.service-frames", serviceFrames],
  ["computer-event.ended-frame", serviceFrame],
  ["computer-event.error-frame", serviceFrame],
  ["computer-event.framing", framing],
  ["session-trust.bundle-computer-events", trustBundle],
]);
