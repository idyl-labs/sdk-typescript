// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  SESSION_TRUST_TYPE,
  SessionTrustError,
  TRUST_KEY_TYPE,
  verifySessionTrust,
} from "../src/computer-connection/trust.js";
import type {
  SessionTrustResponse,
  SignedTrustDocument,
  TrustKey,
} from "../src/computer-connection/trust.js";
import { encodeBase64 } from "../src/resource/base64.js";

const enc = new TextEncoder();
const NOW = Date.parse("2026-01-02T03:00:00Z");

interface Signer {
  readonly key: TrustKey;
  readonly sign: (type: string, payload: Uint8Array) => Promise<string>;
}

async function signer(keyId: string): Promise<Signer> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    key: { keyId, publicKey: raw },
    sign: async (type, payload) => {
      const message = new Uint8Array([...enc.encode(`${type}\n`), ...payload]);
      return encodeBase64(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "Ed25519" },
            pair.privateKey,
            message,
          ),
        ),
      );
    },
  };
}

async function document(
  type: string,
  body: unknown,
  by: readonly Signer[],
): Promise<SignedTrustDocument> {
  const payload = enc.encode(JSON.stringify(body));
  return {
    payload: encodeBase64(payload),
    signatures: await Promise.all(
      by.map(async (s) => ({
        keyId: s.key.keyId,
        signature: await s.sign(type, payload),
      })),
    ),
  };
}

const PEM = `-----BEGIN CERTIFICATE-----\n${encodeBase64(Uint8Array.of(0x30, 1, 2))}\n-----END CERTIFICATE-----\n`;

function bundle(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: SESSION_TRUST_TYPE,
    network: "example.test",
    zone: "zone-a",
    version: 7,
    issuedAt: "2026-01-02T00:00:00Z",
    expiresAt: "2026-01-03T00:00:00Z",
    pod: {
      zone: "zone-a",
      generations: [{ certificateDer: encodeBase64(Uint8Array.of(0x30, 9)) }],
    },
    dataFabric: {
      endpoint: "data.zone-a.zone.example.test:443",
      serverId: "spiffe://zone-a.zone.example.test/fabric/data",
      serverRoots: PEM,
    },
    ...overrides,
  };
}

async function response(
  body: Record<string, unknown>,
  by: readonly Signer[],
  keys: SignedTrustDocument[] = [],
): Promise<SessionTrustResponse> {
  return { bundle: await document(SESSION_TRUST_TYPE, body, by), keys };
}

describe("session trust", () => {
  // Contract: a bundle signed by the pinned key is accepted, its roots and
  // data edge read.
  it("accepts a bundle the pinned key signed", async () => {
    const pinned = await signer("k1");
    const trust = await verifySessionTrust(await response(bundle(), [pinned]), {
      network: "example.test",
      keys: [pinned.key],
      minVersion: 0,
      nowMs: NOW,
    });
    expect(trust.zone).toBe("zone-a");
    expect(trust.version).toBe(7);
    expect(trust.podRoots).toEqual([Uint8Array.of(0x30, 9)]);
    expect(trust.dataFabric.serverRoots).toEqual([Uint8Array.of(0x30, 1, 2)]);
  });

  // Contract: a bundle signed by any other key, or substituted after
  // signing, is refused.
  it("refuses a bundle no trusted key signed", async () => {
    const pinned = await signer("k1");
    const stranger = await signer("k1");
    const policy = {
      network: "example.test",
      keys: [pinned.key],
      minVersion: 0,
      nowMs: NOW,
    };
    await expect(
      verifySessionTrust(await response(bundle(), [stranger]), policy),
    ).rejects.toThrow(SessionTrustError);
    const signed = await response(bundle(), [pinned]);
    const swapped = {
      ...signed,
      bundle: {
        ...signed.bundle,
        payload: encodeBase64(
          enc.encode(JSON.stringify(bundle({ version: 8 }))),
        ),
      },
    };
    await expect(verifySessionTrust(swapped, policy)).rejects.toThrow(
      "not signed by a trusted",
    );
  });

  // Contract: another Network or Zone, a rolled-back version, and a bundle
  // outside its validity are refused with their reasons.
  it("refuses another Network, a rollback and an expired bundle", async () => {
    const pinned = await signer("k1");
    const policy = {
      network: "example.test",
      zone: "zone-a",
      keys: [pinned.key],
      minVersion: 7,
      nowMs: NOW,
    };
    const cases: [Record<string, unknown>, string][] = [
      [
        bundle({ network: "other.test" }),
        "trust document names another network, zone or role",
      ],
      [
        bundle({ zone: "zone-b" }),
        "trust document names another network, zone or role",
      ],
      [
        bundle({ version: 6 }),
        "session trust bundle is older than one already accepted",
      ],
      [bundle({ expiresAt: "2026-01-02T02:00:00Z" }), "outside its validity"],
      [bundle({ pod: { generations: [] } }), "no Pod roots"],
    ];
    for (const [body, reason] of cases) {
      await expect(
        verifySessionTrust(await response(body, [pinned]), policy),
      ).rejects.toThrow(reason);
    }
  });

  // Contract: the browser listener's URL is read when the Zone names one,
  // and a value that is not a wss URL with a path is refused.
  it("reads the browser endpoint and refuses a bad one", async () => {
    const pinned = await signer("k1");
    const policy = {
      network: "example.test",
      keys: [pinned.key],
      minVersion: 0,
      nowMs: NOW,
    };
    const fabric = bundle()["dataFabric"] as Record<string, unknown>;
    const named = await verifySessionTrust(
      await response(
        bundle({
          dataFabric: {
            ...fabric,
            browserEndpoint:
              "wss://edge.zone-a.zone.example.test/hyperplane/fallback/1",
          },
        }),
        [pinned],
      ),
      policy,
    );
    expect(named.dataFabric.browserEndpoint).toBe(
      "wss://edge.zone-a.zone.example.test/hyperplane/fallback/1",
    );
    for (const bad of [
      "https://edge.example.test/x",
      "wss://edge.example.test",
      "wss://edge.example.test/x?y",
      7,
    ]) {
      await expect(
        verifySessionTrust(
          await response(
            bundle({ dataFabric: { ...fabric, browserEndpoint: bad } }),
            [pinned],
          ),
          policy,
        ),
      ).rejects.toThrow("not a wss URL");
    }
  });

  // Contract: a successor key announced by the pinned key, from its
  // notBefore, signs bundles; one announced by a stranger does not.
  it("follows successor keys the pinned key announced", async () => {
    const pinned = await signer("k1");
    const next = await signer("k2");
    const stranger = await signer("k9");
    const statement = (by: Signer, notBefore: string) =>
      document(
        TRUST_KEY_TYPE,
        {
          type: TRUST_KEY_TYPE,
          network: "example.test",
          role: "network-trust",
          keyId: "k2",
          publicKey: encodeBase64(next.key.publicKey),
          notBefore,
        },
        [by],
      );
    const policy = {
      network: "example.test",
      keys: [pinned.key],
      minVersion: 0,
      nowMs: NOW,
    };
    await expect(
      verifySessionTrust(
        await response(
          bundle(),
          [next],
          [await statement(pinned, "2026-01-01T00:00:00Z")],
        ),
        policy,
      ),
    ).resolves.toMatchObject({ version: 7 });
    await expect(
      verifySessionTrust(
        await response(
          bundle(),
          [next],
          [await statement(stranger, "2026-01-01T00:00:00Z")],
        ),
        policy,
      ),
    ).rejects.toThrow(SessionTrustError);
    await expect(
      verifySessionTrust(
        await response(
          bundle(),
          [next],
          [await statement(pinned, "2026-02-01T00:00:00Z")],
        ),
        policy,
      ),
    ).rejects.toThrow(SessionTrustError);
  });
});
