// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * Saved content as the content routes serve it: strong entity tags, a piece
 * list, and one `Range` with `If-Range`.
 */
import { createHash } from "node:crypto";
import { FILE_PIECE_BYTES, fileEtag } from "../../src/api/files.js";
import type { RecordedRequest } from "./fetch-queue.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

/** A file's piece hashes laid end to end, in order. */
export function pieceHashesOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const count = Math.ceil(bytes.length / FILE_PIECE_BYTES);
  const hashes = new Uint8Array(count * 32);
  for (let index = 0; index < count; index += 1) {
    const at = index * FILE_PIECE_BYTES;
    hashes.set(sha256(bytes.subarray(at, at + FILE_PIECE_BYTES)), index * 32);
  }
  return hashes;
}

/** A file's strong entity tag. */
export function fileEtagOf(bytes: Uint8Array): string {
  const hashes = pieceHashesOf(bytes);
  const tag = hashes.length === 32 ? hashes : sha256(hashes);
  return fileEtag(Buffer.from(tag).toString("hex"), bytes.length);
}

/** One saved content, as a read of it answers. */
export interface ServedContent {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly version: number;
}

/** Answers `HEAD`, `GET`, and `GET` with `Range` and `If-Range`. */
export function serveContent(
  request: RecordedRequest,
  content: ServedContent,
): Response {
  const { bytes, etag, version } = content;
  const headers = {
    "content-type": "application/octet-stream",
    "Idyl-Saved-Version": String(version),
    ETag: etag,
  };
  if (request.method === "HEAD") {
    return new Response(null, {
      headers: { ...headers, "Content-Length": String(bytes.length) },
    });
  }
  const ifRange = request.headers.get("if-range");
  const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get("range") ?? "");
  if (range === null || (ifRange !== null && ifRange !== etag)) {
    return new Response(new Uint8Array(bytes), { headers });
  }
  const first = Number(range[1]);
  const last = Number(range[2]);
  return new Response(new Uint8Array(bytes.subarray(first, last + 1)), {
    status: 206,
    headers: {
      ...headers,
      "Content-Range": `bytes ${String(first)}-${String(last)}/${String(bytes.length)}`,
    },
  });
}
