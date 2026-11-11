// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The receiver rule. The `fetch` the SDK is given is called with no
 * receiver, exactly as a caller writing `fetch(url, init)` would call it,
 * and is bound to nothing. A browser implements `fetch` as an operation of
 * its global object and rejects a call through any other receiver with
 * `TypeError: Illegal invocation`, so an SDK that invoked the `fetch` it
 * holds as a method of its own would make no request from a page. The fakes
 * here refuse every receiver but `undefined`.
 */
import { describe, expect, it } from "vitest";
import { testClient } from "./fakes/client.js";
import { staticCredential } from "../src/credential.js";
import { ApiError } from "../src/errors.js";
import { testCredential, testKey } from "./fakes/keys.js";
import { Transport } from "../src/internal/transport.js";
import {
  accountId,
  apiEndpoint,
  FetchQueue,
  network,
  receiverCheckedFetch,
} from "./fakes/fetch-queue.js";

const credential = testCredential;

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (error: unknown) => error,
  );
}

describe("fetch is called with no receiver", () => {
  // Contract: a JSON request reaches the injected fetch with an undefined
  // receiver, as a browser's fetch requires, and its response is decoded.
  it("sends a JSON request", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ ok: true });
    const checked = receiverCheckedFetch(queue);
    const transport = new Transport({ credential, fetch: checked.fetch });
    await expect(
      transport.json("GET", apiEndpoint, "/v1/example"),
    ).resolves.toEqual({ ok: true });
    expect(checked.receivers).toEqual([undefined]);
    expect(queue.requests[0]?.headers.get("authorization")).toBe(
      "DPoP test-token",
    );
  });

  // Contract: an error response reaches the error decoder through the same
  // receiverless call, so a browser sees the ApiError and not a refused call.
  it("decodes an error response", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ error: "not found", code: "NOT_FOUND" }, 404);
    const checked = receiverCheckedFetch(queue);
    const transport = new Transport({ credential, fetch: checked.fetch });
    const error = await failure(transport.json("GET", apiEndpoint, "/v1/x"));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe("NOT_FOUND");
    expect(checked.receivers).toEqual([undefined]);
  });

  // Contract: the anonymous identity path is the same receiverless call
  // without a credential.
  it("starts sign-in anonymously", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ message: "sent" });
    const checked = receiverCheckedFetch(queue);
    const transport = new Transport({ credential, fetch: checked.fetch });
    await expect(
      transport.anonymousJson("POST", apiEndpoint, "/v1/auth/start", {
        body: { email: "developer@example.com" },
      }),
    ).resolves.toEqual({ message: "sent" });
    expect(checked.receivers).toEqual([undefined]);
    expect(queue.requests[0]?.headers.has("authorization")).toBe(false);
  });

  // Contract: a service call from a configured client reaches the injected
  // fetch end to end with an undefined receiver, as a page's client must.
  it("lists Namespaces from a client", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ items: [], totalCount: 0 });
    const checked = receiverCheckedFetch(queue);
    const idyl = testClient({
      network,
      accountId,
      credential: staticCredential("t", testKey),
      fetch: checked.fetch,
    });
    const listed = await idyl.account.namespaces.list();
    expect(listed.items).toEqual([]);
    expect(listed.totalCount).toBe(0);
    expect(checked.receivers).toEqual([undefined]);
    expect(queue.requests[0]?.url.href).toBe(
      `${apiEndpoint}/v1/accounts/${accountId}/namespaces`,
    );
    expect(queue.requests[0]?.headers.get("authorization")).toBe("DPoP t");
  });
});
