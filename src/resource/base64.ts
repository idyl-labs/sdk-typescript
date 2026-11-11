// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * Standard base64 with padding, the encoding a Go byte slice takes on the
 * wire. It is implemented over `btoa` and `atob`, which every supported
 * runtime provides, in chunks so a value at a service's ceiling never
 * spreads one call's arguments. `bytesShape` is how a byte field declares
 * itself in a wire shape: bytes in hand, base64 text on the wire.
 */
import { scalar, type Shape } from "../internal/strictdecode.js";

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const CHUNK = 0x8000;

/** Renders bytes as standard base64 with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * Reads standard base64 with padding, as strictly as the reference contract reads it: no
 * whitespace, no URL alphabet, no missing padding. Throws a `TypeError` for
 * any other text.
 */
export function decodeBase64(text: string): Uint8Array {
  if (!BASE64.test(text)) throw new TypeError("invalid base64");
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * A byte field as its Go codec reads it: `Uint8Array` in hand and standard
 * base64 with padding on the wire, empty being the zero value an `omitempty`
 * tag omits. Text that is not base64 is refused by the field's path.
 */
export const bytesShape: Shape<Uint8Array> = scalar<Uint8Array>({
  decode: decodeBase64,
  encode: encodeBase64,
  zero: () => new Uint8Array(),
  isZero: (value) => value.byteLength === 0,
});
