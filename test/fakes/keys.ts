// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * Key pairs for tests, generated afresh on every run so the tree holds no
 * private key, and the credential every fake client presents.
 */
import { vi } from "vitest";
import { keyThumbprint, staticCredential } from "../../src/credential.js";

/** A fresh Ed25519 key pair; its private key is non-extractable unless asked. */
export async function ed25519Key(extractable = false): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey({ name: "Ed25519" }, extractable, [
    "sign",
    "verify",
  ]);
}

/** A fresh ECDSA P-256 key pair; its private key is non-extractable unless asked. */
export async function p256Key(extractable = false): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    extractable,
    ["sign", "verify"],
  );
}

/** The key every fake client's access token is bound to. */
export const testKey = await ed25519Key();

/** The access token every fake client presents. */
export const testToken = "test-token";

/** The credential every fake client presents. */
export const testCredential = staticCredential(testToken, testKey);

/**
 * Lets a test that drives time with fake timers decide alone when each
 * request is sent. WebCrypto completes its operations on the runtime's own
 * threads, outside the fake clock's reach, so a request whose proof is
 * being signed when the clock is advanced would be sent after the advance
 * returns. This replaces `sign` and `digest` with answers that settle as
 * microtasks, after the test key's JWK is exported once with the real
 * implementation. The proofs such a test sends are not verifiable; the
 * proof tests verify them. `vi.restoreAllMocks` puts the real ones back.
 */
export async function proofsOnFakeTime(): Promise<void> {
  await keyThumbprint(testKey.publicKey);
  vi.spyOn(crypto.subtle, "sign").mockImplementation(() =>
    Promise.resolve(new ArrayBuffer(64)),
  );
  vi.spyOn(crypto.subtle, "digest").mockImplementation(() =>
    Promise.resolve(new ArrayBuffer(32)),
  );
}
