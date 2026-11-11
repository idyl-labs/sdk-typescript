// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  credentialSourceFunc,
  keyThumbprint,
  staticCredential,
} from "../src/credential.js";
import { ed25519Key, p256Key, testKey } from "./fakes/keys.js";
import { sha256url } from "./fakes/proof.js";

const signal = new AbortController().signal;

describe("credential sources", () => {
  // Contract: a fixed credential is judged when the source is built, so a
  // client never holds a token or a key it cannot present.
  it("validates a fixed credential before it is used", async () => {
    const source = staticCredential("test-token", testKey);
    expect(await source.credential({ signal })).toEqual({
      accessToken: "test-token",
      key: testKey,
    });
    expect(Object.isFrozen(source)).toBe(true);
    expect(() => staticCredential("", testKey)).toThrow(
      "credential access token is empty",
    );
    expect(() => staticCredential("two words", testKey)).toThrow(
      "credential access token contains whitespace",
    );
    const bell = `bell${String.fromCharCode(7)}`;
    expect(() => staticCredential(bell, testKey)).toThrow(
      "credential access token contains control characters",
    );
    expect(() => staticCredential("t", undefined as never)).toThrow(
      "credential key is required",
    );
    const swapped = {
      publicKey: testKey.privateKey,
      privateKey: testKey.publicKey,
    };
    expect(() => staticCredential("t", swapped)).toThrow(
      "credential key must be a CryptoKeyPair",
    );
    const mixed = {
      publicKey: (await p256Key()).publicKey,
      privateKey: testKey.privateKey,
    };
    expect(() => staticCredential("t", mixed)).toThrow(
      "credential key must be an Ed25519 or ECDSA P-256 key pair",
    );
  });

  // Contract: only Ed25519 and ECDSA P-256 keys are admitted.
  it("refuses keys of other algorithms", async () => {
    const p384 = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-384" },
      false,
      ["sign", "verify"],
    );
    expect(() => staticCredential("t", p384)).toThrow(
      "credential key must be an Ed25519 or ECDSA P-256 key pair",
    );
    const rsa = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 1024,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      false,
      ["sign", "verify"],
    );
    expect(() => staticCredential("t", rsa)).toThrow(
      "credential key must be an Ed25519 or ECDSA P-256 key pair",
    );
    await expect(keyThumbprint(rsa.publicKey)).rejects.toThrow(TypeError);
  });

  // Contract: a function is adapted into a source and receives the request
  // context on every call.
  it("adapts a function into a source", async () => {
    const signals: AbortSignal[] = [];
    const source = credentialSourceFunc((context) => {
      signals.push(context.signal);
      return Promise.resolve({
        accessToken: `token-${String(signals.length)}`,
        key: testKey,
      });
    });
    await expect(source.credential({ signal })).resolves.toMatchObject({
      accessToken: "token-1",
    });
    await expect(source.credential({ signal })).resolves.toMatchObject({
      accessToken: "token-2",
    });
    expect(signals).toEqual([signal, signal]);
    expect(() => credentialSourceFunc(undefined as never)).toThrow(
      "credential source function is required",
    );
  });
});

describe("keyThumbprint", () => {
  // Contract: the thumbprint is RFC 7638's over the required members in
  // lexicographic order: the Ed25519 key of RFC 8037 appendix A.3 has the
  // thumbprint printed there.
  it("is RFC 7638's thumbprint for the RFC 8037 key", async () => {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "OKP",
        crv: "Ed25519",
        x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
      },
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    expect(await keyThumbprint(publicKey)).toBe(
      "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
    );
  });

  // Contract: a P-256 key's thumbprint covers crv, kty, x and y, and a
  // generated key's thumbprint is computed from its exported public JWK.
  it("covers every required member of a P-256 and an Ed25519 key", async () => {
    for (const key of [await p256Key(), await ed25519Key()]) {
      const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
      const canonical =
        jwk.kty === "EC"
          ? `{"crv":"P-256","kty":"EC","x":"${jwk.x ?? ""}","y":"${jwk.y ?? ""}"}`
          : `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x ?? ""}"}`;
      expect(await keyThumbprint(key.publicKey)).toBe(sha256url(canonical));
    }
  });
});
