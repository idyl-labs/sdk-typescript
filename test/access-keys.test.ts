// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  Idyl,
  TransportError,
  accessKeyCredentials,
  encodeAccessKeyFile,
  keyThumbprint,
  parseAccessKeyFile,
  type AccessKeyFile,
  type AccessToken,
  type Identity,
} from "../src/index.js";
import { FetchQueue, accountId } from "./fakes/fetch-queue.js";
import { ed25519Key, p256Key, testCredential } from "./fakes/keys.js";
import { checkedProof, verifyProof } from "./fakes/proof.js";

const endpoints = {
  api: "https://api.example.test",
  identity: "https://identity.example.test",
  meta: "https://meta.example.test",
};
const network = "example.test";
const accessKeyId = "00000000-0000-4000-8000-0000000000a1";

afterEach(() => {
  vi.useRealTimers();
});

/** An access key file for a fresh key pair, extractable so it can be written. */
function fileFor(
  key: CryptoKeyPair,
  fields: Partial<AccessKeyFile> = {},
): AccessKeyFile {
  return { network, accessKeyId, account: accountId, key, ...fields };
}

/** A key pair whose private half a key file can be written from. */
async function extractableKey(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
}

/** The private member `d` of a key file's text, which no error may carry. */
function privateMember(text: string): string {
  const parsed = JSON.parse(text) as { privateKey: { d: string } };
  return parsed.privateKey.d;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

describe("access key files", () => {
  // Contract: a file is encoded with its members in the format's order and
  // parses back to the same key: text → parse → encode is the identity,
  // and a parsed key signs proofs that verify with its own public key.
  it.each([
    ["Ed25519", ed25519Key, '"kty":"OKP","crv":"Ed25519","x":"'],
    ["P-256", p256Key, '"kty":"EC","crv":"P-256","x":"'],
  ] as const)("round-trips an %s key", async (_label, generate, jwkPrefix) => {
    const key = await generate(true);
    const text = await encodeAccessKeyFile(fileFor(key));
    expect(
      text.startsWith(
        `{"type":"idyl-access-key","network":"${network}","accessKeyId":"${accessKeyId}","account":"${accountId}","privateKey":{${jwkPrefix}`,
      ),
    ).toBe(true);
    const again = await parseAccessKeyFile(text, { extractable: true });
    expect(await encodeAccessKeyFile(again)).toBe(text);
    const parsed = await parseAccessKeyFile(text);
    expect(parsed).toMatchObject({ network, accessKeyId, account: accountId });
    expect(parsed.key.privateKey.extractable).toBe(false);
    expect(await keyThumbprint(parsed.key.publicKey)).toBe(
      await keyThumbprint(key.publicKey),
    );
    await expect(encodeAccessKeyFile(parsed)).rejects.toThrow(
      "access key file private key is not extractable",
    );
  });

  // Contract: parsing is strict, and no refusal, its message or its cause,
  // carries key material.
  it("refuses bad input without echoing key material", async () => {
    const key = await ed25519Key(true);
    const other = await ed25519Key(true);
    const text = await encodeAccessKeyFile(fileFor(key));
    const d = privateMember(text);
    const otherD = privateMember(await encodeAccessKeyFile(fileFor(other)));
    const document = JSON.parse(text) as Record<string, unknown>;
    const jwk = document["privateKey"] as Record<string, string>;
    const variant = (fields: Record<string, unknown>): string =>
      JSON.stringify({ ...document, ...fields });
    const cases: readonly [string, string][] = [
      [text.slice(0, -1), "access key file is not one access key JSON object"],
      [`${text}{}`, "access key file is not one access key JSON object"],
      [
        text.replace('"type":', '"type":"x","type":'),
        "access key file is not one access key JSON object",
      ],
      [
        variant({ extra: true }),
        "access key file is not one access key JSON object",
      ],
      [
        JSON.stringify({ ...document, account: undefined }),
        "access key file is not one access key JSON object",
      ],
      [
        variant({ type: "idyl-token" }),
        'access key file type must be "idyl-access-key"',
      ],
      [
        variant({ network: "https://example.test" }),
        "access key file names no valid network",
      ],
      [
        variant({ accessKeyId: "not-a-uuid" }),
        "access key file access key ID must be a canonical UUID",
      ],
      [variant({ account: "1" }), "access key file names no valid account"],
      [
        variant({ privateKey: { ...jwk, d: otherD } }),
        "access key file private key is not a valid Ed25519 or P-256 key",
      ],
      [
        variant({ privateKey: { ...jwk, d: `${d}=` } }),
        "access key file private key is not a valid Ed25519 or P-256 key",
      ],
      [
        variant({ privateKey: { ...jwk, y: jwk["x"] } }),
        "access key file private key is not a valid Ed25519 or P-256 key",
      ],
      [
        variant({ privateKey: { ...jwk, kty: "EC" } }),
        "access key file private key is not a valid Ed25519 or P-256 key",
      ],
      [
        variant({ privateKey: { ...jwk, key_ops: ["sign"] } }),
        "access key file private key is not a valid Ed25519 or P-256 key",
      ],
      [`${text}${" ".repeat(4096)}`, "access key file exceeds 4096 bytes"],
    ];
    for (const [input, message] of cases) {
      const error = await rejection(parseAccessKeyFile(input));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(message);
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain(d);
      expect(String(error)).not.toContain(otherD);
    }
    await expect(parseAccessKeyFile(5 as never)).rejects.toThrow(
      "access key file must be text",
    );
  });
});

/** A fake identity that answers access key exchanges in order. */
function exchanges(answers: readonly (() => Promise<AccessToken>)[]): {
  identity: Identity;
  exchange: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const exchange = vi.fn(() => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer === undefined) throw new Error("no answer");
    return answer();
  });
  return {
    identity: { exchangeAccessKey: exchange } as unknown as Identity,
    exchange,
  };
}

function token(accessToken: string, expiresInMs: number): AccessToken {
  return {
    accessToken,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    accountId,
    accountName: "example",
    profileId: "",
    profileName: "",
  };
}

describe("new Idyl({ accessKey })", () => {
  // Contract: the client takes its network from the file and signs its
  // requests with the key, so an access key is the one option a program states.
  it("builds a client from the file's text alone", async () => {
    const key = await extractableKey();
    const accessKey = await encodeAccessKeyFile(fileFor(key));
    const hosts: string[] = [];
    const idyl = new Idyl({
      accessKey,
      fetch: (input) => {
        hosts.push(new URL(input as string).host);
        return Promise.reject(new Error("no network here"));
      },
    });
    await expect(idyl.account()).rejects.toThrow();
    expect(hosts).toEqual([`identity.${network}`]);
  });

  // Contract: a client has one credential and one network; a contradiction is
  // refused when the client is built.
  it("refuses a second credential or another network", async () => {
    const key = await extractableKey();
    const accessKey = await encodeAccessKeyFile(fileFor(key));
    expect(
      () =>
        new Idyl({
          accessKey,
          credential: { credential: () => Promise.reject(new Error("unused")) },
        }),
    ).toThrow("accessKey or credential");
    expect(() => new Idyl({ accessKey, network: "other.test" })).toThrow(
      "network",
    );
  });

  // Contract: an access key from a variable that is not set says so when the
  // client is built, rather than at the first request.
  it("refuses an accessKey that is undefined", () => {
    expect(() => new Idyl({ accessKey: undefined })).toThrow("not set");
  });

  // Contract: a file that cannot be read is refused when the client is built,
  // and the error names no key material.
  it("refuses an invalid file without quoting it", async () => {
    const key = await extractableKey();
    const text = await encodeAccessKeyFile(fileFor(key));
    const damaged = text.replace("idyl-access-key", "something-else");
    const error = ((): unknown => {
      try {
        return new Idyl({ accessKey: damaged });
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(privateMember(text));
  });
});

describe("accessKeyCredentials", () => {
  // Contract: concurrent requests that need a token share one exchange,
  // and the token is reused until five minutes before its expiry, when the
  // next request exchanges again.
  it("exchanges once for concurrent requests and renews in the background before expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const key = await ed25519Key();
    const { identity, exchange } = exchanges([
      () => Promise.resolve(token("first", 3_600_000)),
      () => Promise.resolve(token("second", 3_600_000)),
    ]);
    const source = accessKeyCredentials(fileFor(key), identity);
    const signal = new AbortController().signal;
    const credentials = await Promise.all([
      source.credential({ signal }),
      source.credential({ signal }),
      source.credential({ signal }),
    ]);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith(accessKeyId, key);
    for (const credential of credentials) {
      expect(credential).toEqual({ accessToken: "first", key });
    }
    vi.setSystemTime(new Date("2026-06-01T00:54:59Z"));
    expect((await source.credential({ signal })).accessToken).toBe("first");
    expect(exchange).toHaveBeenCalledTimes(1);
    // From five minutes before expiry the request still gets the current
    // token at once, and the next one is exchanged in the background.
    vi.setSystemTime(new Date("2026-06-01T00:55:00Z"));
    expect((await source.credential({ signal })).accessToken).toBe("first");
    expect(exchange).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      expect((await source.credential({ signal })).accessToken).toBe("second");
    });
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  // Contract: a background renewal that fails leaves the current token in
  // use until it expires; it is tried again no sooner than 30 seconds later.
  it("keeps a valid token when a background renewal fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const key = await ed25519Key();
    const refused = new ApiError({ status: 503, message: "unavailable" });
    const { identity, exchange } = exchanges([
      () => Promise.resolve(token("first", 3_600_000)),
      () => Promise.reject(refused),
      () => Promise.resolve(token("second", 3_600_000)),
    ]);
    const source = accessKeyCredentials(fileFor(key), identity);
    const signal = new AbortController().signal;
    await source.credential({ signal });
    vi.setSystemTime(new Date("2026-06-01T00:56:00Z"));
    expect((await source.credential({ signal })).accessToken).toBe("first");
    await Promise.resolve();
    expect((await source.credential({ signal })).accessToken).toBe("first");
    expect(exchange).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-06-01T00:56:31Z"));
    expect((await source.credential({ signal })).accessToken).toBe("first");
    expect(exchange).toHaveBeenCalledTimes(3);
    await vi.waitFor(async () => {
      expect((await source.credential({ signal })).accessToken).toBe("second");
    });
  });

  // Contract: an exchange whose expiry is already past is refused rather
  // than kept, so no request is handed a token that cannot work.
  it("refuses an exchange whose token has already expired", async () => {
    const key = await ed25519Key();
    const { identity } = exchanges([
      () => Promise.resolve(token("stale", -60_000)),
    ]);
    const source = accessKeyCredentials(fileFor(key), identity);
    await expect(
      source.credential({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  // Contract: a failed exchange rejects the requests that waited for it,
  // is not kept, and is tried again by the next request; a caller's signal
  // ends only its own wait.
  it("retries after a failure and honours each caller's signal", async () => {
    const key = await ed25519Key();
    let release: (value: AccessToken) => void = () => undefined;
    const refused = new ApiError({ status: 503, message: "unavailable" });
    const { identity, exchange } = exchanges([
      () => Promise.reject(refused),
      () =>
        new Promise<AccessToken>((resolve) => {
          release = resolve;
        }),
    ]);
    const source = accessKeyCredentials(fileFor(key), identity);
    const signal = new AbortController().signal;
    const failures = await Promise.all([
      rejection(Promise.resolve(source.credential({ signal }))),
      rejection(Promise.resolve(source.credential({ signal }))),
    ]);
    expect(failures).toEqual([refused, refused]);
    expect(exchange).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const leaving = Promise.resolve(
      source.credential({ signal: controller.signal }),
    );
    const staying = Promise.resolve(source.credential({ signal }));
    const reason = new Error("caller left");
    controller.abort(reason);
    await expect(leaving).rejects.toBe(reason);
    release(token("after", 3_600_000));
    expect((await staying).accessToken).toBe("after");
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  // Contract: an exchange answer without a readable expiry is unusable.
  it("refuses an answer without a valid expiry", async () => {
    const key = await ed25519Key();
    const { identity } = exchanges([
      () => Promise.resolve({ ...token("t", 1), expiresAt: "soon" }),
    ]);
    const error = await rejection(
      Promise.resolve(
        accessKeyCredentials(fileFor(key), identity).credential({
          signal: new AbortController().signal,
        }),
      ),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("invalid_response");
  });

  // Contract: an unusable file or identity is refused when the source is
  // built.
  it("refuses an unusable file or identity", async () => {
    const key = await ed25519Key();
    const { identity } = exchanges([]);
    expect(() =>
      accessKeyCredentials(
        { network, accessKeyId: "x", account: accountId, key },
        identity,
      ),
    ).toThrow("access key ID must be a canonical UUID");
    expect(() =>
      accessKeyCredentials(
        { network, accessKeyId, account: accountId, key: {} as CryptoKeyPair },
        identity,
      ),
    ).toThrow("access key file key must be a CryptoKeyPair");
    expect(() => accessKeyCredentials(fileFor(key), {} as Identity)).toThrow(
      "identity is required",
    );
  });

  // Contract: end to end, a client built on an access key exchanges it at
  // `POST /token/access-key` with a proof by the key alone, then presents
  // the token it obtained with a proof by the same key.
  it("drives a client end to end", async () => {
    const key = await ed25519Key(true);
    const file = await parseAccessKeyFile(
      await encodeAccessKeyFile(fileFor(key)),
    );
    const queue = new FetchQueue();
    queue.respondJson({
      accessToken: "key-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      accountId,
      accountName: "example",
    });
    queue.respondJson({ id: accountId, email: "", displayName: "" });
    const { identity } = new Idyl({ network, endpoints, fetch: queue.fetch });
    const idyl = new Idyl({
      network,
      endpoints,
      fetch: queue.fetch,
      credential: accessKeyCredentials(file, identity),
    });
    expect((await idyl.account()).id).toBe(accountId);
    const [exchange, read] = queue.requests;
    if (exchange === undefined || read === undefined)
      throw new Error("missing");
    expect(exchange.url.href).toBe(`${endpoints.identity}/token/access-key`);
    expect(exchange.body).toBe(`{"accessKeyId":"${accessKeyId}"}`);
    const exchangeProof = await checkedProof(exchange, "key");
    expect(read.headers.get("authorization")).toBe("DPoP key-token");
    const readProof = await checkedProof(read, "access");
    expect(readProof.header.jwk).toEqual(exchangeProof.header.jwk);
  });
});

describe("idyl.accessKeys", () => {
  const record = (fields: Record<string, unknown>) => ({
    id: accessKeyId,
    name: "ci",
    description: "",
    accessProfileId: "00000000-0000-4000-8000-0000000000c1",
    expiresAt: "2027-01-01T00:00:00Z",
    createdAt: "2026-01-02T03:04:05Z",
    lastUsedAt: "2026-01-03T03:04:05Z",
    ...fields,
  });

  function client(queue: FetchQueue): Idyl {
    return new Idyl({
      network,
      endpoints,
      credential: testCredential,
      fetch: queue.fetch,
    });
  }

  // Contract: create generates an Ed25519 key pair, registers only its
  // public JWK, and returns the record with the key file to save, whose
  // key is the registered one; the private key is never sent.
  it("registers a public key and returns the key file", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ id: accountId, email: "", displayName: "" });
    let sent: { publicKey: JsonWebKey } | undefined;
    queue.respond(async (request) => {
      sent = JSON.parse(request.body ?? "") as { publicKey: JsonWebKey };
      const imported = await crypto.subtle.importKey(
        "jwk",
        sent.publicKey,
        { name: "Ed25519" },
        true,
        ["verify"],
      );
      return new Response(
        JSON.stringify({
          accessKey: record({ keyThumbprint: await keyThumbprint(imported) }),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const created = await client(queue).accessKeys.create({
      name: "ci",
      description: "deploys",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    const create = queue.requests[1];
    if (create === undefined || sent === undefined) throw new Error("missing");
    expect(create.method).toBe("POST");
    expect(create.url.href).toBe(`${endpoints.api}/v1/access-keys`);
    expect(Object.keys(sent).sort()).toEqual([
      "description",
      "expiresAt",
      "name",
      "publicKey",
    ]);
    expect(Object.keys(sent.publicKey).sort()).toEqual(["crv", "kty", "x"]);
    expect(create.body).not.toContain(privateMember(created.keyFile));
    await checkedProof(create, "access");

    expect(created.accessKey).toEqual({
      id: accessKeyId,
      name: "ci",
      keyThumbprint: await keyThumbprint(created.file.key.publicKey),
      expiresAt: "2027-01-01T00:00:00Z",
      createdAt: "2026-01-02T03:04:05Z",
      lastUsedAt: "2026-01-03T03:04:05Z",
    });
    expect(created.file).toMatchObject({
      network,
      accessKeyId,
      account: accountId,
    });
    expect(created.file.key.privateKey.extractable).toBe(false);
    const parsed = await parseAccessKeyFile(created.keyFile);
    expect(await keyThumbprint(parsed.key.publicKey)).toBe(
      created.accessKey.keyThumbprint,
    );
    expect(Object.isFrozen(created)).toBe(true);
  });

  // Contract: list and revoke address the caller's keys without an
  // Account path; IDs are judged before any request.
  it("lists and revokes access keys", async () => {
    const queue = new FetchQueue();
    queue.respondJson({
      accessKeys: [
        record({ keyThumbprint: "t", revokedAt: "2026-02-01T00:00:00Z" }),
      ],
    });
    queue.respondJson(null, 204);
    const { accessKeys } = client(queue);
    expect(await accessKeys.list()).toEqual([
      {
        id: accessKeyId,
        name: "ci",
        keyThumbprint: "t",
        expiresAt: "2027-01-01T00:00:00Z",
        createdAt: "2026-01-02T03:04:05Z",
        lastUsedAt: "2026-01-03T03:04:05Z",
        revokedAt: "2026-02-01T00:00:00Z",
      },
    ]);
    await accessKeys.revoke(accessKeyId);
    expect(
      queue.requests.map((request) => [request.method, request.url.pathname]),
    ).toEqual([
      ["GET", "/v1/access-keys"],
      ["DELETE", `/v1/access-keys/${accessKeyId}`],
    ]);
    await expect(accessKeys.revoke("../accounts")).rejects.toThrow(
      "access key ID must be a canonical UUID",
    );
    expect(queue.requests).toHaveLength(2);
  });

  // Contract: invalid input, and a client with no network to name in the
  // file, are refused before any request.
  it("refuses invalid input before any request", async () => {
    const queue = new FetchQueue();
    const { accessKeys } = client(queue);
    await expect(accessKeys.create({ name: " " })).rejects.toThrow(
      "access key name is required",
    );
    await expect(
      accessKeys.create({ name: "ci", expiresAt: "tomorrow" }),
    ).rejects.toThrow("expiresAt must be a valid instant");
    const standalone = new Idyl({
      endpoints,
      credential: testCredential,
      fetch: queue.fetch,
    });
    await expect(standalone.accessKeys.create({ name: "ci" })).rejects.toThrow(
      "network is required to create an access key file",
    );
    expect(queue.requests).toHaveLength(0);
  });

  // Contract: an answer that does not name the registered key, or that is
  // not a key record, is an invalid response.
  it("refuses an answer that names another key", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ id: accountId, email: "", displayName: "" });
    queue.respondJson({ accessKey: record({ keyThumbprint: "another" }) }, 201);
    queue.respondJson({ accessKeys: [null] });
    const { accessKeys } = client(queue);
    const error = await rejection(accessKeys.create({ name: "ci" }));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("invalid_response");
    const listed = await rejection(accessKeys.list());
    expect(listed).toBeInstanceOf(TransportError);
  });

  // Contract: a proof's key is the key the access key file holds.
  it("signs with the key the file holds", async () => {
    const key = await ed25519Key(true);
    const file = await parseAccessKeyFile(
      await encodeAccessKeyFile(fileFor(key)),
    );
    const queue = new FetchQueue();
    queue.respondJson({ id: accountId, email: "", displayName: "" });
    await new Idyl({
      network,
      endpoints,
      fetch: queue.fetch,
      credential: {
        credential: () => ({ accessToken: "t", key: file.key }),
      },
    }).account();
    const proof = await verifyProof(
      queue.requests[0]?.headers.get("dpop") ?? "",
    );
    expect(proof.header.jwk["x"]).toBe(
      (await crypto.subtle.exportKey("jwk", key.publicKey)).x,
    );
  });
});
