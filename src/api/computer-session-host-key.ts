// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { decodeBase64, encodeBase64 } from "../resource/base64.js";

/**
 * The one SSH host key algorithm a session endpoint uses, and the type name
 * OpenSSH writes before the key.
 */
const HOST_KEY_TYPE = "ssh-ed25519";

/** The bytes of {@link HOST_KEY_TYPE}, as the key's wire encoding names it. */
const HOST_KEY_TYPE_BYTES = new TextEncoder().encode(HOST_KEY_TYPE);

/** The length of an Ed25519 public key, in bytes. */
const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * Judges an endpoint's SSH host key as the `opened` frame of an `ssh`
 * session stream carries it: exactly one OpenSSH public key line,
 * `ssh-ed25519 ` followed by the standard base64, with padding, of the key
 * in SSH's wire encoding (the string `ssh-ed25519`, then the 32-byte
 * Ed25519 public key, each with its four-byte big-endian length), and
 * nothing else: no comment, no other whitespace and no line ending. The
 * base64 must be the one canonical spelling of those 51 bytes: its
 * re-encoding must equal it byte for byte, so no character carries stray
 * bits and no carriage return or line feed hides inside it. The type name
 * inside the wire encoding is compared byte for byte, so no byte-order mark
 * or other byte precedes it. The refusal names the rule and never repeats
 * the line. Throws a `TypeError`.
 */
export function validateComputerSessionHostKey(line: string): void {
  const prefix = `${HOST_KEY_TYPE} `;
  if (!line.startsWith(prefix)) {
    throw new TypeError("a host key is an ssh-ed25519 public key line");
  }
  const encoded = line.slice(prefix.length);
  let blob: Uint8Array;
  try {
    blob = decodeBase64(encoded);
  } catch (cause) {
    throw new TypeError("a host key's key is canonical standard base64", {
      cause,
    });
  }
  if (encodeBase64(blob) !== encoded) {
    throw new TypeError("a host key's key is canonical standard base64");
  }
  const name = cutSshString(blob, 0);
  if (name === undefined || !sameBytes(name.value, HOST_KEY_TYPE_BYTES)) {
    throw new TypeError("a host key's key names ssh-ed25519");
  }
  const key = cutSshString(blob, name.next);
  if (
    key?.value.byteLength !== ED25519_PUBLIC_KEY_BYTES ||
    key.next !== blob.byteLength
  ) {
    throw new TypeError(
      `a host key's key is one ${String(ED25519_PUBLIC_KEY_BYTES)}-byte Ed25519 public key and nothing else`,
    );
  }
}

/** Whether `a` and `b` hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, at) => byte === b[at]);
}

/**
 * Reads one SSH wire string, a four-byte big-endian length and that many
 * bytes, at `offset` of `blob`: its bytes and the offset after it, or
 * `undefined` when `blob` holds less than it declares.
 */
function cutSshString(
  blob: Uint8Array,
  offset: number,
): { readonly value: Uint8Array; readonly next: number } | undefined {
  if (blob.byteLength - offset < 4) return undefined;
  const length = new DataView(
    blob.buffer,
    blob.byteOffset + offset,
    4,
  ).getUint32(0);
  const start = offset + 4;
  if (length > blob.byteLength - start) return undefined;
  return { value: blob.subarray(start, start + length), next: start + length };
}
