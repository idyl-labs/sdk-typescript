// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The proof of possession every authenticated request carries, judged by a
 * verifier written apart from the package (fakes/proof.ts) against the
 * request the recorded fetch saw.
 */
import { describe, expect, it, vi } from "vitest";
import type { Credential } from "../src/credential.js";
import { ApiError } from "../src/errors.js";
import { Transport } from "../src/internal/transport.js";
import { apiEndpoint, FetchQueue } from "./fakes/fetch-queue.js";
import { ed25519Key, p256Key, testCredential, testKey } from "./fakes/keys.js";
import {
  checkedProof,
  contentDigestOf,
  sha256url,
  verifyProof,
} from "./fakes/proof.js";

/** A credential source presenting `key`, counting its consultations. */
function sourceOf(key: CryptoKeyPair, accessToken = "test-token") {
  return {
    credential: vi.fn((): Credential => ({ accessToken, key })),
  };
}

function transport(
  queue: FetchQueue,
  key: CryptoKeyPair = testKey,
): { transport: Transport; source: ReturnType<typeof sourceOf> } {
  const source = sourceOf(key);
  return {
    transport: new Transport({ credential: source, fetch: queue.fetch }),
    source,
  };
}

/** The response a front door gives a proof it refused. */
function refusedProof(date?: Date): Response {
  return new Response(
    JSON.stringify({ error: "invalid proof", code: "UNAUTHENTICATED" }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate":
          'DPoP error="invalid_dpop_proof", algs="EdDSA ES256"',
        ...(date === undefined ? {} : { date: date.toUTCString() }),
      },
    },
  );
}

function only<T>(values: readonly T[], index = 0): T {
  const value = values[index];
  if (value === undefined) throw new Error(`no value at ${String(index)}`);
  return value;
}

describe("a request's proof", () => {
  // Contract: a proof is a dpop+jwt JWS that verifies with the public key
  // its header carries, the credential's own, under the algorithm that key
  // names: EdDSA for Ed25519 and ES256, a 64-byte r||s, for P-256. The
  // private key is non-extractable: only `crypto.subtle.sign` is used.
  it.each([
    ["Ed25519", ed25519Key, "EdDSA"],
    ["P-256", p256Key, "ES256"],
  ] as const)(
    "verifies with the %s JWK it carries",
    async (_label, generate, alg) => {
      const key = await generate();
      expect(key.privateKey.extractable).toBe(false);
      const queue = new FetchQueue();
      queue.respondJson({});
      await transport(queue, key).transport.json("GET", apiEndpoint, "/v1/a");
      const proof = await checkedProof(only(queue.requests), "access");
      expect(proof.header.alg).toBe(alg);
      const exported = await crypto.subtle.exportKey("jwk", key.publicKey);
      expect(proof.header.jwk).toEqual(
        exported.kty === "EC"
          ? { kty: "EC", crv: "P-256", x: exported.x, y: exported.y }
          : { kty: "OKP", crv: "Ed25519", x: exported.x },
      );
    },
  );

  // Contract: a proof names the method, the URL as scheme, lowercased host
  // and path with no query or fragment, the time in seconds, a 128-bit
  // `jti` and the access token's hash; `htq` appears exactly with a query,
  // as the hash of the raw query, and nothing else is claimed.
  it("names the request and only the bindings it has", async () => {
    const queue = new FetchQueue();
    queue.respondJson({});
    queue.respondJson({});
    const { transport: shared } = transport(queue);
    await shared.json("DELETE", "https://API.Example.test", "/v1/files/a%2Fb");
    await shared.json("GET", apiEndpoint, "/v1/parts/0?sha256=abc&b=%2F");
    const [bare, query] = queue.requests.map((request) => request);
    if (bare === undefined || query === undefined) throw new Error("missing");
    const first = await checkedProof(bare, "access");
    expect(first.claims["htu"]).toBe("https://api.example.test/v1/files/a%2Fb");
    expect(first.claims["ath"]).toBe(sha256url("test-token"));
    expect(Object.keys(first.claims).sort()).toEqual([
      "ath",
      "htm",
      "htu",
      "iat",
      "jti",
    ]);
    const second = await checkedProof(query, "access");
    expect(second.claims["htu"]).toBe(`${apiEndpoint}/v1/parts/0`);
    expect(second.claims["htq"]).toBe(sha256url("sha256=abc&b=%2F"));
    expect(
      Math.abs(Number(second.claims["iat"]) - Date.now() / 1000),
    ).toBeLessThan(5);
  });

  // Contract: a JSON body is sent with `Content-Digest: sha-256=:<base64>:`
  // over its exact bytes, and the proof's `htd` is that header.
  it("binds a JSON body through its Content-Digest", async () => {
    const queue = new FetchQueue();
    queue.respondJson({});
    const body = { name: "dév", count: 2 };
    await transport(queue).transport.json("POST", apiEndpoint, "/v1/b", {
      body,
    });
    const request = only(queue.requests);
    expect(request.body).toBe('{"name":"dév","count":2}');
    const digest = contentDigestOf(
      new TextEncoder().encode('{"name":"dév","count":2}'),
    );
    expect(request.headers.get("content-digest")).toBe(digest);
    const proof = await checkedProof(request, "access");
    expect(proof.claims["htd"]).toBe(digest);
  });

  // Contract: `hth` is the hash of `<name>:<value>\n` for each of
  // content-type, idempotency-key, if-match, if-none-match and
  // last-event-id the request carries, in that order, and is absent when
  // it carries none.
  it("covers the semantic headers exactly when there are some", async () => {
    const queue = new FetchQueue();
    queue.respondJson({});
    queue.respondJson({});
    const { transport: shared } = transport(queue);
    await shared.json("PUT", apiEndpoint, "/v1/c", {
      body: {},
      headers: {
        "last-event-id": "7",
        "if-match": '"v1"',
        "idempotency-key": "k-1",
        "x-unrelated": "ignored",
      },
    });
    await shared.json("GET", apiEndpoint, "/v1/c", {
      headers: { "x-unrelated": "ignored" },
    });
    const covered = await checkedProof(only(queue.requests, 0), "access");
    expect(covered.claims["hth"]).toBe(
      sha256url(
        'content-type:application/json\nidempotency-key:k-1\nif-match:"v1"\nlast-event-id:7\n',
      ),
    );
    const bare = await checkedProof(only(queue.requests, 1), "access");
    expect(bare.claims).not.toHaveProperty("hth");
  });

  // Contract: every proof carries a fresh identifier, so two proofs for the
  // same request at the same instant differ and neither replays the other.
  it("is fresh for every request", async () => {
    const queue = new FetchQueue();
    queue.respondJson({});
    queue.respondJson({});
    const { transport: shared } = transport(queue);
    await shared.json("GET", apiEndpoint, "/v1/d");
    await shared.json("GET", apiEndpoint, "/v1/d");
    const [a, b] = await Promise.all(
      queue.requests.map((request) => checkedProof(request, "access")),
    );
    expect(a?.claims["jti"]).not.toBe(b?.claims["jti"]);
  });
});

describe("a refused proof", () => {
  // Contract: a 401 naming `invalid_dpop_proof` is retried once, with a new
  // proof whose time is the clock the refusal's `Date` stated, the same
  // body and token, and the credential source consulted once.
  it("is retried once at the clock the refusal's Date set", async () => {
    const queue = new FetchQueue();
    const ahead = new Date(Date.now() + 3_600_000);
    queue.respond(() => refusedProof(ahead));
    queue.respondJson({ ok: true });
    const { transport: shared, source } = transport(queue);
    await expect(
      shared.json("POST", apiEndpoint, "/v1/e", { body: { a: 1 } }),
    ).resolves.toEqual({ ok: true });
    expect(queue.requests).toHaveLength(2);
    expect(source.credential).toHaveBeenCalledTimes(1);
    const [first, second] = await Promise.all(
      queue.requests.map((request) => checkedProof(request, "access")),
    );
    expect(first?.claims["jti"]).not.toBe(second?.claims["jti"]);
    expect(
      Math.abs(Number(first?.claims["iat"]) - Date.now() / 1000),
    ).toBeLessThan(5);
    expect(
      Math.abs(Number(second?.claims["iat"]) - ahead.getTime() / 1000),
    ).toBeLessThan(5);
    expect(only(queue.requests, 1).body).toBe(only(queue.requests, 0).body);
  });

  // Contract: the retry happens once: a second refusal, and any other 401,
  // reaches the caller as the ApiError it is.
  it("is retried only once, and only for a refused proof", async () => {
    const queue = new FetchQueue();
    queue.respond(() => refusedProof());
    queue.respond(() => refusedProof());
    queue.respondJson({ error: "expired", code: "UNAUTHENTICATED" }, 401, {
      "www-authenticate": 'DPoP error="invalid_token"',
    });
    const { transport: shared } = transport(queue);
    const twice = await shared
      .json("GET", apiEndpoint, "/v1/f")
      .catch((error: unknown) => error);
    expect(twice).toBeInstanceOf(ApiError);
    expect((twice as ApiError).status).toBe(401);
    expect(queue.requests).toHaveLength(2);
    const once = await shared
      .json("GET", apiEndpoint, "/v1/f")
      .catch((error: unknown) => error);
    expect(once).toBeInstanceOf(ApiError);
    expect(queue.requests).toHaveLength(3);
  });

  // Contract: an anonymous request carries no proof and is never retried.
  it("is never retried for an anonymous request", async () => {
    const queue = new FetchQueue();
    queue.respond(() => refusedProof());
    const { transport: shared } = transport(queue);
    await expect(
      shared.anonymousJson("POST", apiEndpoint, "/login/start", { body: {} }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(queue.requests).toHaveLength(1);
  });
});

describe("the clock proofs state", () => {
  // Contract: every response's `Date` sets the clock the next proof
  // states, so a local clock that is off does not make proofs stale.
  it("follows the API's Date header", async () => {
    const queue = new FetchQueue();
    const behind = new Date(Date.now() - 600_000);
    queue.respondJson({}, 200, { date: behind.toUTCString() });
    queue.respondJson({});
    const { transport: shared } = transport(queue);
    await shared.json("GET", apiEndpoint, "/v1/g");
    await shared.json("GET", apiEndpoint, "/v1/g");
    const proof = await checkedProof(only(queue.requests, 1), "access");
    expect(
      Math.abs(Number(proof.claims["iat"]) - behind.getTime() / 1000),
    ).toBeLessThan(5);
  });
});

describe("content transfers", () => {
  // Contract: a content stream's proof carries no `htd` and the request no
  // Content-Digest; a transfer part's integrity rides its `sha256` query,
  // which `htq` covers, and its content type is covered by `hth`.
  it("prove the query and type of a transfer without a digest", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ received: 3 });
    queue.respondText("bytes");
    const { transport: shared } = transport(queue);
    await shared.sendContent(
      apiEndpoint,
      "/v1/uploads/u/parts/0?sha256=abc",
      "application/octet-stream",
      new Uint8Array([1, 2, 3]),
      undefined,
    );
    const opened = await shared.openContent(
      apiEndpoint,
      "/v1/content",
      "application/octet-stream",
      undefined,
    );
    await opened.body?.cancel();
    const [part, read] = queue.requests;
    if (part === undefined || read === undefined) throw new Error("missing");
    expect(part.headers.has("content-digest")).toBe(false);
    const partProof = await checkedProof(part, "access");
    expect(partProof.claims["htq"]).toBe(sha256url("sha256=abc"));
    expect(partProof.claims["hth"]).toBe(
      sha256url("content-type:application/octet-stream\n"),
    );
    expect(partProof.claims).not.toHaveProperty("htd");
    const readProof = await checkedProof(read, "access");
    expect(readProof.claims).not.toHaveProperty("htd");
    expect(readProof.claims).not.toHaveProperty("hth");
  });

  // Contract: a refused proof is retried for bytes, which can be sent
  // again, and not for a stream, which was read as it was sent.
  it("retry a refused proof only for a body that can be sent again", async () => {
    const queue = new FetchQueue();
    queue.respond(() => refusedProof());
    queue.respondJson({ received: 1 });
    queue.respond(() => refusedProof());
    const { transport: shared } = transport(queue);
    await shared.sendContent(
      apiEndpoint,
      "/v1/parts/0",
      "application/octet-stream",
      new Uint8Array([1]),
      undefined,
    );
    expect(queue.requests).toHaveLength(2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    await expect(
      shared.sendContent(
        apiEndpoint,
        "/v1/parts/1",
        "application/octet-stream",
        stream,
        undefined,
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(queue.requests).toHaveLength(3);
  });
});

describe("the credential a source returns", () => {
  // Contract: a source that returns no key, or a key that cannot sign
  // proofs, is refused before anything is sent, naming the source.
  it("is judged before anything is sent", async () => {
    const queue = new FetchQueue();
    const noKey = new Transport({
      credential: { credential: () => ({ accessToken: "t" }) as Credential },
      fetch: queue.fetch,
    });
    await expect(noKey.json("GET", apiEndpoint, "/v1")).rejects.toThrow(
      "credential source returned no key",
    );
    const p384 = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-384" },
      false,
      ["sign", "verify"],
    );
    const wrongKey = new Transport({
      credential: { credential: () => ({ accessToken: "t", key: p384 }) },
      fetch: queue.fetch,
    });
    await expect(wrongKey.json("GET", apiEndpoint, "/v1")).rejects.toThrow(
      "credential source returned a key that must be an Ed25519 or ECDSA P-256 key pair",
    );
    const nothing = new Transport({
      credential: { credential: () => undefined as unknown as Credential },
      fetch: queue.fetch,
    });
    await expect(nothing.json("GET", apiEndpoint, "/v1")).rejects.toThrow(
      "credential source returned no credential",
    );
    expect(queue.requests).toHaveLength(0);
  });

  // Contract: the proof a test credential carries verifies, so the shared
  // fakes present what the API admits.
  it("is what the shared fakes present", async () => {
    const queue = new FetchQueue();
    queue.respondJson({});
    await new Transport({
      credential: testCredential,
      fetch: queue.fetch,
    }).json("GET", apiEndpoint, "/v1");
    const proof = await verifyProof(
      only(queue.requests).headers.get("dpop") ?? "",
    );
    expect(proof.header.typ).toBe("dpop+jwt");
  });
});
