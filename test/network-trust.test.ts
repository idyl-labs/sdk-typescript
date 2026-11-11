// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pinnedTrustKeys } from "../src/client/network-trust.js";
import type { TrustKey } from "../src/computer-connection/trust.js";

/** The keys pinned for idyl.sh, which must be at least one. */
function idylSh(): TrustKey[] {
  const keys = pinnedTrustKeys("idyl.sh") ?? [];
  expect(keys.length).toBeGreaterThan(0);
  return keys;
}

/** The RFC 7638 thumbprint of an Ed25519 public key's JWK. */
function thumbprint(publicKey: Uint8Array): string {
  const x = Buffer.from(publicKey).toString("base64url");
  return createHash("sha256")
    .update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`)
    .digest("base64url");
}

describe("pinned trust keys", () => {
  // Contract: idyl.sh has pinned keys, each a 32-byte Ed25519 public key
  // whose ID is its JWK thumbprint, the ID a signature names.
  it("pins idyl.sh keys whose IDs are their thumbprints", () => {
    for (const key of idylSh()) {
      expect(key.publicKey).toHaveLength(32);
      expect(key.keyId).toBe(thumbprint(key.publicKey));
    }
  });

  // Contract: no other Network has pinned keys.
  it("pins nothing for any other network", () => {
    expect(pinnedTrustKeys("example.test")).toBeUndefined();
    expect(pinnedTrustKeys("IDYL.SH")).toBeUndefined();
  });

  // Contract: each call returns copies, so a caller that changes one
  // changes nothing another caller receives.
  it("returns fresh copies", () => {
    for (const key of idylSh()) key.publicKey.fill(0);
    for (const key of idylSh()) {
      expect(key.keyId).toBe(thumbprint(key.publicKey));
    }
  });
});
