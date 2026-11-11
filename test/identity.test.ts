// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  Idyl,
  TransportError,
  keyThumbprint,
  parseAccountId,
  parseProfileId,
  type IdylOptions,
} from "../src/index.js";
import { FetchQueue, accountId } from "./fakes/fetch-queue.js";
import { ed25519Key, p256Key, testKey } from "./fakes/keys.js";
import { checkedProof, sha256url } from "./fakes/proof.js";

const endpoints = {
  api: "https://api.example.test",
  identity: "https://identity.example.test",
  meta: "https://meta.example.test",
};

const profileId = "00000000-0000-4000-8000-000000000002";
const accessKeyId = "00000000-0000-4000-8000-0000000000a1";

/** A client whose credential source counts, and must never be, consulted. */
function client(queue: FetchQueue): {
  idyl: Idyl;
  credential: ReturnType<typeof vi.fn>;
} {
  const credential = vi.fn(() => ({ accessToken: "unused", key: testKey }));
  const options: IdylOptions = {
    credential: { credential },
    endpoints,
    fetch: queue.fetch,
  };
  return { idyl: new Idyl(options), credential };
}

function accessTokenRecord(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    accessToken: "access",
    expiresAt: "2026-01-01T01:00:00Z",
    accountId,
    accountName: "example",
    profileId,
    profileName: "owner",
    ...fields,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

describe("starting a sign-in", () => {
  // Contract: the reader fields go on the wire as the person's browser
  // gave them, beside the email, on both the first code and a resend; an
  // empty field is left out, because the server reads it as not known.
  it("sends the reader's time zone, language and browser", async () => {
    const queue = new FetchQueue();
    const { idyl } = client(queue);
    queue.respondJson({ message: "sent" });
    queue.respondJson({ message: "sent" });
    queue.respondJson({ message: "sent" });

    await idyl.identity.startSignIn("person@example.com", {
      timeZone: "Europe/Berlin",
      locale: "de-DE",
      userAgent: "ExampleBrowser/1.0",
    });
    await idyl.identity.resendCode("person@example.com", {
      timeZone: "+05:30",
      locale: "",
    });
    await idyl.identity.startSignIn("person@example.com");

    expect(
      queue.requests.map((request) => [
        request.url.href,
        JSON.parse(request.body ?? "") as unknown,
      ]),
    ).toEqual([
      [
        `${endpoints.identity}/login/start`,
        {
          email: "person@example.com",
          timeZone: "Europe/Berlin",
          locale: "de-DE",
          userAgent: "ExampleBrowser/1.0",
        },
      ],
      [
        `${endpoints.identity}/login/resend`,
        { email: "person@example.com", timeZone: "+05:30" },
      ],
      [`${endpoints.identity}/login/start`, { email: "person@example.com" }],
    ]);
  });
});

describe("the public identifier parsers", () => {
  // Contract: the package's ID parsers accept exactly the contract's forms
  // and throw a TypeError naming the family otherwise.
  it("accept the canonical forms and refuse every other", () => {
    expect(parseAccountId(accountId)).toBe(accountId);
    expect(parseProfileId(profileId)).toBe(profileId);
    expect(() => parseAccountId("12345")).toThrow(TypeError);
    expect(() => parseAccountId("12345")).toThrow(/account ID/);
    expect(() => parseProfileId(profileId.replaceAll("-", ""))).toThrow(
      TypeError,
    );
    expect(() => parseProfileId("not-a-uuid")).toThrow(/profile ID/);
  });
});

describe("identity exchanges that prove a key", () => {
  // Contract: verifying a code, redeeming a browser code and exchanging an
  // access key present no token: each carries a proof by the key whose
  // tokens it obtains, covering its exact body, and never consults the
  // client's credential. Starting sign-in is anonymous: no token, no proof.
  it("proves the key alone and never the client's credential", async () => {
    const queue = new FetchQueue();
    const { idyl, credential } = client(queue);
    const key = await ed25519Key();
    const browserKey = await p256Key();
    queue.respondJson({ message: "sent" });
    queue.respondJson({ message: "sent" });
    queue.respondJson({
      refreshToken: "refresh",
      expiresAt: "2026-02-01T00:00:00Z",
    });
    queue.respondJson(
      accessTokenRecord({
        refreshToken: "browser-refresh",
        refreshExpiresAt: "2026-02-01T00:00:00Z",
      }),
    );
    queue.respondJson(
      accessTokenRecord({
        accessToken: "key-access",
        profileId: "",
        profileName: "",
      }),
    );

    await idyl.identity.startSignIn("person@example.com");
    await idyl.identity.resendCode("person@example.com");
    const signIn = await idyl.identity.verifyCode(
      "person@example.com",
      "123456",
      key,
    );
    expect(signIn.refreshToken).toBe("refresh");
    const exchanged = await idyl.identity.exchangeBrowser(
      {
        code: "code",
        clientId: "console",
        redirectUri: "https://app.example.com/callback",
        state: "state",
        codeVerifier: "verifier",
      },
      browserKey,
    );
    expect(exchanged).toMatchObject({
      accessToken: "access",
      refreshToken: "browser-refresh",
      refreshExpiresAt: "2026-02-01T00:00:00Z",
    });
    const fromKey = await idyl.identity.exchangeAccessKey(accessKeyId, key);
    expect(fromKey.accessToken).toBe("key-access");

    expect(credential).not.toHaveBeenCalled();
    expect(
      queue.requests.map((request) => [request.method, request.url.href]),
    ).toEqual([
      ["POST", `${endpoints.identity}/login/start`],
      ["POST", `${endpoints.identity}/login/resend`],
      ["POST", `${endpoints.identity}/login/verify`],
      ["POST", `${endpoints.identity}/browser/exchange`],
      ["POST", `${endpoints.identity}/token/access-key`],
    ]);
    for (const request of queue.requests.slice(0, 2)) {
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("dpop")).toBe(false);
      expect(request.headers.has("content-digest")).toBe(false);
    }
    const [, , verify, browser, access] = queue.requests;
    if (verify === undefined || browser === undefined || access === undefined) {
      throw new Error("requests missing");
    }
    for (const [request, proving] of [
      [verify, key],
      [browser, browserKey],
      [access, key],
    ] as const) {
      const proof = await checkedProof(request, "key");
      expect(sha256url(canonicalJwk(proof.header.jwk))).toBe(
        await keyThumbprint(proving.publicKey),
      );
      expect(proof.claims["htd"]).toBe(request.headers.get("content-digest"));
    }
    expect(JSON.parse(verify.body ?? "")).toEqual({
      email: "person@example.com",
      code: "123456",
    });
    expect(access.body).toBe(`{"accessKeyId":"${accessKeyId}"}`);
  });
});

/** The RFC 7638 member order of a public JWK, written independently. */
function canonicalJwk(jwk: Readonly<Record<string, string>>): string {
  return jwk["y"] === undefined
    ? `{"crv":"${jwk["crv"] ?? ""}","kty":"${jwk["kty"] ?? ""}","x":"${jwk["x"] ?? ""}"}`
    : `{"crv":"${jwk["crv"] ?? ""}","kty":"${jwk["kty"] ?? ""}","x":"${jwk["x"] ?? ""}","y":"${jwk["y"]}"}`;
}

describe("identity exchanges that present a refresh token", () => {
  // Contract: every call that presents a refresh token sends it as
  // `Authorization: DPoP <token>` with a proof by its key that names no
  // `ath`, for that request only; the exchanges that mint a token return
  // the successor, and a browser authorization names the page's key.
  it("presents the refresh token with its key and no token hash", async () => {
    const queue = new FetchQueue();
    const { idyl, credential } = client(queue);
    const key = await ed25519Key();
    const refresh = { refreshToken: "refresh", key };
    const dpopJkt = await keyThumbprint((await p256Key()).publicKey);
    queue.respondJson({ profiles: [] });
    queue.respondJson(
      accessTokenRecord({
        refreshToken: "refresh-2",
        refreshExpiresAt: "2026-02-01T00:00:00Z",
      }),
    );
    queue.respondJson({
      code: "one-use",
      expiresAt: "2026-01-01T00:01:00Z",
      refreshToken: "refresh-3",
      refreshExpiresAt: "2026-02-01T00:00:00Z",
    });
    queue.respondJson({
      account: { id: accountId, displayName: "Example" },
      namespace: { id: "n", name: "default" },
      profile: {
        accountId,
        accountName: "example",
        profileId: "p",
        profileName: "owner",
      },
    });
    queue.respondJson(null, 204);

    expect(await idyl.identity.profiles(refresh)).toEqual([]);
    const access = await idyl.identity.accessToken(refresh, { accountId });
    expect(access.refreshToken).toBe("refresh-2");
    expect(access.refreshExpiresAt).toBe("2026-02-01T00:00:00Z");
    const authorized = await idyl.identity.authorizeBrowser(refresh, {
      clientId: "console",
      redirectUri: "https://app.example.com/callback",
      state: "state",
      codeChallenge: "challenge",
      dpopJkt,
      profile: { accountId, profileId },
    });
    expect(authorized).toEqual({
      code: "one-use",
      expiresAt: "2026-01-01T00:01:00Z",
      refreshToken: "refresh-3",
      refreshExpiresAt: "2026-02-01T00:00:00Z",
    });
    await idyl.identity.signUp(refresh, { acceptedTerms: true });
    await idyl.identity.signOut(refresh);

    expect(credential).not.toHaveBeenCalled();
    expect(
      queue.requests.map((request) => [
        request.method,
        request.url.href,
        request.headers.get("authorization"),
      ]),
    ).toEqual([
      ["GET", `${endpoints.identity}/token/profiles`, "DPoP refresh"],
      ["POST", `${endpoints.identity}/token/profile`, "DPoP refresh"],
      ["POST", `${endpoints.identity}/browser/authorize`, "DPoP refresh"],
      ["POST", `${endpoints.api}/v1/signup`, "DPoP refresh"],
      ["POST", `${endpoints.identity}/logout`, "DPoP refresh"],
    ]);
    for (const request of queue.requests) {
      const proof = await checkedProof(request, "refresh");
      expect(proof.claims).not.toHaveProperty("ath");
    }
    expect(JSON.parse(queue.requests[1]?.body ?? "")).toEqual({ accountId });
    expect(JSON.parse(queue.requests[2]?.body ?? "")).toEqual({
      clientId: "console",
      redirectUri: "https://app.example.com/callback",
      state: "state",
      codeChallenge: "challenge",
      dpopJkt,
      profile: { accountId, profileId },
    });
  });

  // Contract: a browser authorization whose answer carries no successor is
  // unusable, and the error names no token.
  it("requires the successor of a browser authorization", async () => {
    const queue = new FetchQueue();
    const { idyl } = client(queue);
    queue.respondJson({ code: "one-use", expiresAt: "2026-01-01T00:01:00Z" });
    const error = await rejection(
      idyl.identity.authorizeBrowser(
        { refreshToken: "refresh", key: testKey },
        {
          clientId: "console",
          redirectUri: "https://app.example.com/callback",
          state: "state",
          codeChallenge: "challenge",
          dpopJkt: await keyThumbprint(testKey.publicKey),
          profile: { accountId, profileId },
        },
      ),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toBe(
      "browser authorization response has no refreshToken",
    );
  });
});

describe("identity input", () => {
  // Contract: invalid input, a missing key, or a refresh token that cannot
  // be presented is refused before any request, and no refusal names the
  // token.
  it("refuses invalid input before any request", async () => {
    const queue = new FetchQueue();
    const { idyl } = client(queue);
    const { identity } = idyl;
    const refresh = { refreshToken: "refresh", key: testKey };
    await expect(identity.startSignIn(" ")).rejects.toThrow(
      "email is required",
    );
    await expect(
      identity.verifyCode("a@example.com", "", testKey),
    ).rejects.toThrow("code is required");
    await expect(
      identity.verifyCode("a@example.com", "123456", undefined as never),
    ).rejects.toThrow("key is required");
    const publicOnly = {
      publicKey: testKey.publicKey,
      privateKey: testKey.publicKey,
    };
    await expect(
      identity.verifyCode("a@example.com", "123456", publicOnly),
    ).rejects.toThrow("key must be a CryptoKeyPair");
    await expect(
      identity.signUp(refresh, { acceptedTerms: false }),
    ).rejects.toThrow("terms must be accepted");
    const refused = await rejection(
      identity.profiles({ refreshToken: "secret value", key: testKey }),
    );
    expect(refused).toBeInstanceOf(TypeError);
    expect((refused as Error).message).toBe(
      "refresh token contains whitespace",
    );
    await expect(
      identity.signOut({ refreshToken: "", key: testKey }),
    ).rejects.toThrow("refresh token is empty");
    await expect(identity.signOut(undefined as never)).rejects.toThrow(
      "refresh credential is required",
    );
    await expect(
      identity.accessToken(refresh, { accountId: "1" }),
    ).rejects.toThrow(TypeError);
    await expect(
      identity.authorizeBrowser(refresh, {
        clientId: "console",
        redirectUri: "https://app.example.com/callback",
        state: "state",
        codeChallenge: "challenge",
        dpopJkt: "not-a-thumbprint",
        profile: { accountId, profileId },
      }),
    ).rejects.toThrow("dpopJkt must be a SHA-256 key thumbprint");
    await expect(
      identity.exchangeAccessKey("not-a-uuid", testKey),
    ).rejects.toThrow("access key ID must be a canonical UUID");
    expect(queue.requests).toHaveLength(0);
  });

  // Contract: a sign-in record is built field by field; one without a
  // required field is unusable, and fields outside the product are not
  // carried.
  it("judges and trims served sign-in records", async () => {
    const queue = new FetchQueue();
    const { idyl } = client(queue);
    queue.respondJson({ refreshToken: "refresh" });
    const missing = await rejection(
      idyl.identity.verifyCode("person@example.com", "123456", testKey),
    );
    expect(missing).toBeInstanceOf(TransportError);
    expect((missing as Error).message).toBe(
      "sign-in response has no expiresAt",
    );
    queue.respondJson(accessTokenRecord({ note: "newer" }));
    const token = await idyl.identity.accessToken({
      refreshToken: "refresh",
      key: testKey,
    });
    expect(token).not.toHaveProperty("note");
    expect(token).not.toHaveProperty("refreshToken");
    expect(Object.isFrozen(token)).toBe(true);
  });

  // Contract: the offer is read from the API endpoint with the refresh
  // credential and reserves nothing. It carries a reason this SDK does not
  // name, and an offer of a trial carries no reason.
  it("reads what a new Account would start with", async () => {
    const queue = new FetchQueue();
    const { idyl } = client(queue);
    queue.respondJson({ trial: true });
    const offered = await idyl.identity.signUpOffer({
      refreshToken: "refresh",
      key: testKey,
    });
    expect(offered).toEqual({ trial: true });
    expect(Object.isFrozen(offered)).toBe(true);
    expect(queue.requests[0]?.method).toBe("GET");
    expect(queue.requests[0]?.url.pathname).toBe("/v1/signup/offer");
    expect(queue.requests[0]?.headers.get("authorization")).toBe(
      "DPoP refresh",
    );

    queue.respondJson({ trial: false, trialWithheld: "waitlist" });
    const withheld = await idyl.identity.signUpOffer({
      refreshToken: "refresh",
      key: testKey,
    });
    expect(withheld).toEqual({ trial: false, trialWithheld: "waitlist" });
  });
});
