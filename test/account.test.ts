// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getCurrentAccount } from "../src/services/account.js";
import { testClient } from "./fakes/client.js";
import { accountId, FetchQueue, network } from "./fakes/fetch-queue.js";

describe("current account", () => {
  // Contract: the Account a credential acts as is read from the identity
  // API's current-account route with the DPoP credential, and returned
  // as the platform answered.
  it("reads the account the credential acts as", async () => {
    const queue = new FetchQueue();
    const account = {
      id: accountId,
      email: "developer@example.com",
      displayName: "Developer",
    };
    queue.respondJson(account);
    const { state } = testClient({ fetch: queue.fetch });
    await expect(getCurrentAccount(state)).resolves.toEqual(account);
    const [request] = queue.requests;
    expect(request?.method).toBe("GET");
    expect(request?.url.href).toBe(`https://identity.${network}/account`);
    expect(request?.headers.get("authorization")).toBe("DPoP test-token");
  });

  // Contract: a client configured without an identity endpoint is refused
  // before any request.
  it("requires an identity endpoint", async () => {
    const queue = new FetchQueue();
    const { state } = testClient({
      network: undefined,
      endpoints: { api: "https://api.example.com" },
      fetch: queue.fetch,
    });
    await expect(getCurrentAccount(state)).rejects.toThrow(
      new TypeError(
        "identity endpoint is required; configure network or endpoints.identity",
      ),
    );
    expect(queue.requests).toEqual([]);
  });
});
