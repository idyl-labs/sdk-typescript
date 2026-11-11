// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ComputerNotAwakeError,
  ERROR_CODE_COMPUTER_NOT_AWAKE,
  Idyl,
  NotebookNotFoundError,
  isApiCode,
  TransportError,
  credentialSourceFunc,
  type CredentialSource,
  type IdylOptions,
} from "../src/index.js";
import { DEFAULT_USER_AGENT } from "../src/internal/version.js";
import { FetchQueue, accountId } from "./fakes/fetch-queue.js";
import { testCredential, testKey } from "./fakes/keys.js";
import { checkedProof } from "./fakes/proof.js";

const endpoints = {
  api: "https://api.example.test",
  identity: "https://identity.example.test",
  meta: "https://meta.example.test",
};

function client(queue: FetchQueue, options: Partial<IdylOptions> = {}): Idyl {
  return new Idyl({
    credential: testCredential,
    endpoints,
    fetch: queue.fetch,
    ...options,
  });
}

/** Queues the current-account read every Account-scoped call starts with. */
function respondAccount(queue: FetchQueue): void {
  queue.respondJson({
    id: accountId,
    email: "owner@example.com",
    displayName: "Example",
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

describe("Idyl options", () => {
  // Contract: a credential, when given, is judged when the client is
  // built; a client without one refuses every authenticated call with a
  // TypeError before anything is sent.
  it("refuses a malformed credential and calls that need a missing one", async () => {
    const queue = new FetchQueue();
    expect(() =>
      client(queue, { credential: "token" as unknown as CredentialSource }),
    ).toThrow("credential must be a CredentialSource");
    expect(() => new Idyl(null as unknown as IdylOptions)).toThrow(TypeError);
    const anonymous = new Idyl({ endpoints, fetch: queue.fetch });
    const error = await rejection(anonymous.account());
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "credential is required for authenticated requests",
    );
    expect(queue.requests).toHaveLength(0);
  });

  // Contract: without endpoints, the client derives them from the
  // production network, and from a named network when one is given.
  it("derives the endpoints from the network", async () => {
    const queue = new FetchQueue();
    respondAccount(queue);
    await new Idyl({
      credential: testCredential,
      fetch: queue.fetch,
    }).account();
    expect(queue.requests[0]?.url.href).toBe(
      "https://identity.idyl.sh/account",
    );
    respondAccount(queue);
    await new Idyl({
      credential: testCredential,
      network: "example.test",
      fetch: queue.fetch,
    }).account();
    expect(queue.requests[1]?.url.href).toBe(
      "https://identity.example.test/account",
    );
  });

  // Contract: explicit endpoints without a network name all three origins;
  // none is filled in from the production network.
  it("refuses partial endpoints without a network", () => {
    const queue = new FetchQueue();
    expect(() =>
      client(queue, { endpoints: { api: "https://api.example.test" } }),
    ).toThrow("endpoints.identity is required");
  });

  // Contract: cleartext endpoints are refused unless allowed explicitly.
  it("refuses http endpoints unless allowHttp is set", () => {
    const queue = new FetchQueue();
    const local = {
      api: "http://localhost:8080",
      identity: "http://localhost:8081",
      meta: "http://localhost:8082",
    };
    expect(() => client(queue, { endpoints: local })).toThrow(TypeError);
    expect(() =>
      client(queue, { endpoints: local, allowHttp: true }),
    ).not.toThrow();
  });

  // Contract: userAgent is appended to the package's own identification.
  it("appends userAgent to the package's own", async () => {
    const queue = new FetchQueue();
    respondAccount(queue);
    await client(queue, { userAgent: "example-app/2.0" }).account();
    expect(queue.requests[0]?.headers.get("user-agent")).toBe(
      `${DEFAULT_USER_AGENT} example-app/2.0`,
    );
    expect(() => client(queue, { userAgent: "two\nlines" })).toThrow(TypeError);
  });

  // Contract: a credential source is consulted for every request under
  // that request's signal, and each request presents its token in the
  // DPoP scheme with a proof of its own.
  it("consults the credential source for every request", async () => {
    const queue = new FetchQueue();
    const source = vi.fn(({ signal }: { signal: AbortSignal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve({ accessToken: "callback-token", key: testKey });
    });
    const idyl = client(queue, { credential: credentialSourceFunc(source) });
    respondAccount(queue);
    queue.respondJson({ accessKeys: [] });
    await idyl.account();
    await idyl.accessKeys.list();
    expect(source).toHaveBeenCalledTimes(2);
    for (const request of queue.requests) {
      expect(request.headers.get("authorization")).toBe("DPoP callback-token");
      await checkedProof(request, "access");
    }
  });
});

describe("Idyl.account", () => {
  // Contract: the Account is read once and kept; concurrent calls share
  // one read.
  it("reads the current account once", async () => {
    const queue = new FetchQueue();
    respondAccount(queue);
    const idyl = client(queue);
    const [first, second] = await Promise.all([idyl.account(), idyl.account()]);
    expect(first).toEqual({
      id: accountId,
      email: "owner@example.com",
      displayName: "Example",
    });
    expect(second).toBe(first);
    expect(await idyl.account()).toBe(first);
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]?.url.pathname).toBe("/account");
  });

  // Contract: a failed read is not kept.
  it("reads again after a failure", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ error: "down", code: "UNAVAILABLE" }, 503);
    respondAccount(queue);
    const idyl = client(queue);
    expect(await rejection(idyl.account())).toBeInstanceOf(ApiError);
    expect((await idyl.account()).id).toBe(accountId);
  });

  // Contract: a response that names no valid Account is unusable.
  it("refuses a response with no valid account", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ id: "not-an-account" });
    const error = await rejection(client(queue).account());
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("invalid_response");
  });

  // Contract: a caller's signal ends its own wait.
  it("honours the caller's signal", async () => {
    const queue = new FetchQueue();
    queue.respond(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const pending = client(queue).account({ signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});

describe("errors from the platform", () => {
  // Contract: NOTEBOOK_NOT_FOUND is always a NotebookNotFoundError, an
  // ApiError whose message says how to create the notebook.
  it("classifies a missing notebook", async () => {
    const queue = new FetchQueue();
    respondAccount(queue);
    queue.respondJson(
      { error: "notebook not found", code: "NOTEBOOK_NOT_FOUND" },
      404,
    );
    const error = await rejection(client(queue).computers.get("team"));
    expect(error).toBeInstanceOf(NotebookNotFoundError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toContain("computer.notebooks.create");
  });

  // Contract: COMPUTER_NOT_AWAKE is always a ComputerNotAwakeError, an
  // ApiError that carries the code and the 409.
  it("classifies a Computer that is not awake", async () => {
    const queue = new FetchQueue();
    respondAccount(queue);
    queue.respondJson(
      { error: "the Computer is not awake", code: "COMPUTER_NOT_AWAKE" },
      409,
    );
    const error = await rejection(client(queue).computers.get("team"));
    expect(error).toBeInstanceOf(ComputerNotAwakeError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect(isApiCode(error, ERROR_CODE_COMPUTER_NOT_AWAKE)).toBe(true);
  });

  // Contract: no error message names the endpoint the request went to.
  it("names no host in a network failure", async () => {
    const queue = new FetchQueue();
    queue.respond(() => Promise.reject(new TypeError("refused")));
    const error = await rejection(client(queue).account());
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toBe("GET request failed");
  });
});
