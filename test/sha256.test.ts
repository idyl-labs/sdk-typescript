// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex, Sha256 } from "../src/resource/sha256.js";

describe("sha256Hex", () => {
  // Contract: the published FIPS 180-4 test vectors digest to their
  // published values.
  it("digests the published vectors", () => {
    const encoder = new TextEncoder();
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(encoder.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      sha256Hex(
        encoder.encode(
          "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        ),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  // Contract: every length around a block and padding boundary, and a
  // 256 KiB input, digest as Node.js's SHA-256 does.
  it("agrees with the Node.js digest at every padding boundary", () => {
    for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 262_144]) {
      const data = new Uint8Array(length).map((_, index) => index % 256);
      expect(sha256Hex(data), String(length)).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
    }
  });
});

// Contract: prefix reads do not seal the hash, and arbitrary stream chunking
// produces the same result as the independent native implementation.
it("hashes incremental chunks across block and padding boundaries", () => {
  const data = Uint8Array.from({ length: 1048589 }, (_, index) => index % 251);
  for (const chunk of [1, 55, 64, 4093, 1048589]) {
    const hash = new Sha256();
    const native = createHash("sha256");
    for (let start = 0; start < data.length; start += chunk) {
      const part = data.subarray(start, start + chunk);
      hash.update(part);
      native.update(part);
      if (start % 10000 === 0)
        expect(hash.hex()).toBe(native.copy().digest("hex"));
    }
    expect(hash.hex()).toBe(native.digest("hex"));
  }
});
