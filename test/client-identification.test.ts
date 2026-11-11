// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { testClient, type TestClient } from "./fakes/client.js";
import {
  CLIENT_UPGRADE_REQUIRED_DETAIL_LATEST_VERSION,
  CLIENT_UPGRADE_REQUIRED_DETAIL_MINIMUM_VERSION,
  CLIENT_UPGRADE_REQUIRED_DETAIL_PRODUCT,
  CLIENT_UPGRADE_REQUIRED_DETAIL_UPGRADE_URL,
  ERROR_CODE_CLIENT_UPGRADE_REQUIRED,
} from "../src/api/types.js";
import { testCredential } from "./fakes/keys.js";
import {
  ApiError,
  InvalidClientProductError,
  isClientUpgradeRequired,
} from "../src/errors.js";
import type { ClientProduct } from "../src/client-product.js";
import { Transport } from "../src/internal/transport.js";
import { SDK_VERSION } from "../src/internal/version.js";
import {
  accountId,
  apiEndpoint,
  FetchQueue,
  network,
} from "./fakes/fetch-queue.js";

const sdkIdentification = `idyl-sdk-typescript/${SDK_VERSION}`;

function client(queue: FetchQueue, clientProduct?: ClientProduct): TestClient {
  return testClient({
    network,
    accountId,
    credential: testCredential,
    fetch: queue.fetch,
    ...(clientProduct === undefined ? {} : { clientProduct }),
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (error: unknown) => error,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client identification", () => {
  // Contract: with no client product configured, every request names the
  // SDK itself and the package version in Idyl-Client: authenticated API
  // requests and anonymous ones alike.
  it("names the SDK on every request by default", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ items: [], totalCount: 0 });
    queue.respondJson({ message: "sent" });
    await client(queue).account.namespaces.list();
    await new Transport({
      credential: testCredential,
      fetch: queue.fetch,
    }).anonymousJson("POST", apiEndpoint, "/v1/auth/start", {
      body: { email: "developer@example.com" },
    });
    expect(queue.requests).toHaveLength(2);
    for (const request of queue.requests) {
      expect(request.headers.get("idyl-client"), request.url.href).toBe(
        sdkIdentification,
      );
    }
  });

  // Contract: a configured client product replaces the SDK's own on every
  // request, so the minimum version that applies is the embedding
  // product's.
  it("names a configured product instead of the SDK", async () => {
    const product = { name: "idyl-console", version: "1.4.0-rc.2+build.7" };
    const queue = new FetchQueue();
    queue.respondJson({ items: [], totalCount: 0 });
    queue.respondJson({ items: [], totalCount: 0 });
    await client(queue, product).account.namespaces.list();
    await client(queue, product).account.namespaces.list({ limit: 1 });
    expect(
      queue.requests.map((request) => request.headers.get("idyl-client")),
    ).toEqual([
      "idyl-console/1.4.0-rc.2+build.7",
      "idyl-console/1.4.0-rc.2+build.7",
    ]);
    queue.assertExhausted();
  });

  // Contract: a browser document cannot set User-Agent, which is why the
  // product is carried by Idyl-Client; the header is sent there too.
  it("sends Idyl-Client from a browser document", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const queue = new FetchQueue();
    queue.respondJson({ items: [], totalCount: 0 });
    await client(queue, {
      name: "idyl-console",
      version: "dev",
    }).account.namespaces.list();
    const [request] = queue.requests;
    expect(request?.headers.has("user-agent")).toBe(false);
    expect(request?.headers.get("idyl-client")).toBe("idyl-console/dev");
  });

  // Contract: a product with neither field set is the zero value and names
  // the SDK, as an absent one does.
  it("reads an empty product as the SDK default", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ items: [], totalCount: 0 });
    await client(queue, { name: "", version: "" }).account.namespaces.list();
    expect(queue.requests[0]?.headers.get("idyl-client")).toBe(
      sdkIdentification,
    );
  });

  // Contract: a product name is a lowercase letter and at most 63 more
  // lowercase letters, digits, or hyphens, and a version is `dev` or a
  // Semantic Versioning 2.0.0 version without a leading `v`; anything else,
  // or a product with one field set, is refused by every client before
  // any request, as an InvalidClientProductError that
  // is also a TypeError.
  it("refuses a partial or malformed product at construction", () => {
    const refused: readonly (readonly [ClientProduct, string])[] = [
      [
        { name: "idyl-console", version: "" },
        "name and version must both be set",
      ],
      [{ name: "", version: "1.0.0" }, "name and version must both be set"],
      [
        { name: "Idyl-Console", version: "1.0.0" },
        'product "Idyl-Console" must be a lowercase letter followed by at most 63 lowercase letters, digits, or hyphens',
      ],
      [
        { name: "1console", version: "1.0.0" },
        'product "1console" must be a lowercase letter followed by at most 63 lowercase letters, digits, or hyphens',
      ],
      [
        { name: `a${"b".repeat(64)}`, version: "1.0.0" },
        `product "a${"b".repeat(64)}" must be a lowercase letter followed by at most 63 lowercase letters, digits, or hyphens`,
      ],
      [
        { name: "idyl/console", version: "1.0.0" },
        'product "idyl/console" must be a lowercase letter followed by at most 63 lowercase letters, digits, or hyphens',
      ],
      [
        { name: "idyl-console", version: "v1.0.0" },
        'version "v1.0.0" must be "dev" or a semantic version without a leading v',
      ],
      [
        { name: "idyl-console", version: "1.0" },
        'version "1.0" must be "dev" or a semantic version without a leading v',
      ],
      [
        { name: "idyl-console", version: "01.0.0" },
        'version "01.0.0" must be "dev" or a semantic version without a leading v',
      ],
      [
        { name: "idyl-console", version: "1.0.0-01" },
        'version "1.0.0-01" must be "dev" or a semantic version without a leading v',
      ],
      [
        { name: "idyl-console", version: "1.0.0\n" },
        'version "1.0.0\\n" must be "dev" or a semantic version without a leading v',
      ],
      [
        { name: "idyl-console", version: "Dev" },
        'version "Dev" must be "dev" or a semantic version without a leading v',
      ],
    ];
    for (const [product, reason] of refused) {
      const builders = [() => client(new FetchQueue(), product)];
      for (const build of builders) {
        let caught: unknown;
        try {
          build();
        } catch (error) {
          caught = error;
        }
        expect(caught, reason).toBeInstanceOf(InvalidClientProductError);
        expect(caught, reason).toBeInstanceOf(TypeError);
        expect((caught as Error).message).toBe(
          `invalid client product: ${reason}`,
        );
      }
    }
  });

  // Contract: every name and version the grammar admits builds a client.
  it("admits every product the grammar allows", () => {
    for (const product of [
      { name: "a", version: "dev" },
      { name: `a${"b".repeat(63)}`, version: "0.0.0" },
      { name: "idyl-cli", version: "10.20.30" },
      { name: "x-1", version: "1.0.0-alpha.1" },
      { name: "x", version: "1.0.0-0.3.7" },
      { name: "x", version: "1.0.0-x-y-z.--" },
      { name: "x", version: "1.0.0+20130313144700" },
      { name: "x", version: "1.0.0-beta+exp.sha.5114f85" },
    ]) {
      expect(
        () => client(new FetchQueue(), product),
        product.version,
      ).not.toThrow();
    }
  });
});

describe("client upgrade refusal", () => {
  // Contract: the API's refusal of a product release below its minimum is
  // an ApiError with HTTP 426 and the code CLIENT_UPGRADE_REQUIRED, whose
  // details carry the product, the minimum and latest versions, and the
  // upgrade URL as strings under the published keys;
  // isClientUpgradeRequired classifies it by code.
  it("classifies the refusal and carries its details", async () => {
    const queue = new FetchQueue();
    queue.respondJson(
      {
        error: "client upgrade required",
        code: ERROR_CODE_CLIENT_UPGRADE_REQUIRED,
        details: {
          product: "idyl-sdk-typescript",
          minimumVersion: "0.2.0",
          latestVersion: "0.3.1",
          upgradeUrl: "https://example.test/upgrade",
        },
      },
      426,
    );
    const error = await failure(client(queue).account.namespaces.list());
    expect(error).toBeInstanceOf(ApiError);
    expect(isClientUpgradeRequired(error)).toBe(true);
    const refusal = error as ApiError;
    expect(refusal.status).toBe(426);
    expect(refusal.details?.[CLIENT_UPGRADE_REQUIRED_DETAIL_PRODUCT]).toBe(
      "idyl-sdk-typescript",
    );
    expect(
      refusal.details?.[CLIENT_UPGRADE_REQUIRED_DETAIL_MINIMUM_VERSION],
    ).toBe("0.2.0");
    expect(
      refusal.details?.[CLIENT_UPGRADE_REQUIRED_DETAIL_LATEST_VERSION],
    ).toBe("0.3.1");
    expect(refusal.details?.[CLIENT_UPGRADE_REQUIRED_DETAIL_UPGRADE_URL]).toBe(
      "https://example.test/upgrade",
    );
  });

  // Contract: the constants spell the wire tokens the reference contract
  // publishes, and nothing but an ApiError carrying the code is a client
  // upgrade refusal.
  it("spells the wire tokens and classifies by code only", () => {
    expect(ERROR_CODE_CLIENT_UPGRADE_REQUIRED).toBe("CLIENT_UPGRADE_REQUIRED");
    expect([
      CLIENT_UPGRADE_REQUIRED_DETAIL_PRODUCT,
      CLIENT_UPGRADE_REQUIRED_DETAIL_MINIMUM_VERSION,
      CLIENT_UPGRADE_REQUIRED_DETAIL_LATEST_VERSION,
      CLIENT_UPGRADE_REQUIRED_DETAIL_UPGRADE_URL,
    ]).toEqual(["product", "minimumVersion", "latestVersion", "upgradeUrl"]);
    expect(
      isClientUpgradeRequired(
        new ApiError({ status: 426, message: "upgrade", code: "OTHER" }),
      ),
    ).toBe(false);
    expect(
      isClientUpgradeRequired(new Error(ERROR_CODE_CLIENT_UPGRADE_REQUIRED)),
    ).toBe(false);
  });
});
