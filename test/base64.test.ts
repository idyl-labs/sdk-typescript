// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "../src/resource/base64.js";

describe("base64", () => {
  // Contract: every byte value round-trips, and the spelling is standard
  // base64 with padding, the encoding a Go byte slice takes on the wire.
  it("round-trips bytes through the standard alphabet with padding", () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    const text = encodeBase64(bytes);
    expect(
      text.startsWith("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g"),
    ).toBe(true);
    expect(text.endsWith("+/w==")).toBe(true);
    expect(decodeBase64(text)).toEqual(bytes);
    expect(encodeBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
    expect(encodeBase64(new Uint8Array())).toBe("");
    expect(decodeBase64("")).toEqual(new Uint8Array());
  });

  // Contract: a file at the service's ceiling encodes in chunks that never
  // spread one call's arguments; the result is one contiguous encoding.
  it("encodes content larger than one chunk", () => {
    const bytes = new Uint8Array(70_001).map((_, index) => index % 251);
    const text = encodeBase64(bytes);
    expect(text).toHaveLength(Math.ceil(bytes.length / 3) * 4);
    expect(decodeBase64(text)).toEqual(bytes);
  });

  // Contract: decoding is as strict as the reference contract's: missing padding,
  // whitespace, the URL alphabet, and stray characters are refused.
  it("refuses text that is not standard base64", () => {
    for (const invalid of ["aGVsbG8", "aGVs bG8=", "aGVsbG8=\n", "-_-_", "a"]) {
      expect(() => decodeBase64(invalid), invalid).toThrow(
        new TypeError("invalid base64"),
      );
    }
  });
});
