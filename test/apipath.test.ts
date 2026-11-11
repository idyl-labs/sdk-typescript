// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseAccountId } from "../src/resource/id.js";
import type { NamespaceScope } from "../src/api/types.js";
import * as apipath from "../src/internal/apipath.js";

import { accountId, subnetSlug } from "./fakes/fetch-queue.js";

const namespaceScope: NamespaceScope = {
  accountId: parseAccountId(accountId),
  namespace: "agents",
};

describe("api paths", () => {
  // Contract: the containment model is assembled in one place and every
  // scope is addressed beneath its parent.
  it("assembles account, namespace, computer, and subnet paths", () => {
    expect(apipath.account(accountId)).toBe(`/v1/accounts/${accountId}`);
    expect(apipath.account(accountId, "namespaces")).toBe(
      `/v1/accounts/${accountId}/namespaces`,
    );
    expect(apipath.accountResource(accountId, "namespaces", "agents")).toBe(
      `/v1/accounts/${accountId}/namespaces/agents`,
    );
    expect(apipath.namespace(namespaceScope)).toBe(
      `/v1/accounts/${accountId}/namespaces/agents`,
    );
    expect(apipath.namespace(namespaceScope, "computers")).toBe(
      `/v1/accounts/${accountId}/namespaces/agents/computers`,
    );
    expect(apipath.namespaceResource(namespaceScope, "computers", "dev")).toBe(
      `/v1/accounts/${accountId}/namespaces/agents/computers/dev`,
    );
    expect(
      apipath.computerById(
        namespaceScope,
        "01954e20-7540-7ec4-93ec-14f783e6ab04",
      ),
    ).toBe(
      `/v1/accounts/${accountId}/namespaces/agents/computers/by-id/01954e20-7540-7ec4-93ec-14f783e6ab04`,
    );
    expect(apipath.accountSubnet(accountId, subnetSlug, "computers")).toBe(
      `/v1/accounts/${accountId}/subnets/${subnetSlug}/computers`,
    );
  });

  // Contract: a name carrying a slash, a percent sign, or a question mark
  // addresses the resource it names rather than a different route.
  it("escapes every interpolated segment", () => {
    const hostile = "a/b%c?d#e f";
    const escaped = "a%2Fb%25c%3Fd%23e%20f";
    expect(apipath.resourceWithin("/v1/x", "members", hostile)).toBe(
      `/v1/x/members/${escaped}`,
    );
    expect(apipath.accountResource(accountId, "namespaces", hostile)).toBe(
      `/v1/accounts/${accountId}/namespaces/${escaped}`,
    );
    expect(
      apipath.namespaceResource(
        { ...namespaceScope, namespace: hostile },
        "computers",
        hostile,
      ),
    ).toBe(
      `/v1/accounts/${accountId}/namespaces/${escaped}/computers/${escaped}`,
    );
    expect(
      apipath.computerById({ ...namespaceScope, namespace: hostile }, hostile),
    ).toBe(
      `/v1/accounts/${accountId}/namespaces/${escaped}/computers/by-id/${escaped}`,
    );
    expect(
      apipath.computerSessions(
        { ...namespaceScope, namespace: hostile },
        hostile,
        hostile,
      ),
    ).toBe(
      `/v1/accounts/${accountId}/namespaces/${escaped}/computers/${escaped}/sessions/${escaped}`,
    );
    expect(apipath.computerSessionsById(namespaceScope, hostile, hostile)).toBe(
      `/v1/accounts/${accountId}/namespaces/agents/computers/by-id/${escaped}/sessions/${escaped}`,
    );
    expect(apipath.computerJournal(namespaceScope, hostile, hostile)).toBe(
      `/v1/accounts/${accountId}/namespaces/agents/computers/${escaped}/journal/${escaped}`,
    );
    expect(apipath.computerJournalById(namespaceScope, hostile)).toBe(
      `/v1/accounts/${accountId}/namespaces/agents/computers/by-id/${escaped}/journal`,
    );
    expect(apipath.accountSubnet(hostile, hostile)).toBe(
      `/v1/accounts/${escaped}/subnets/${escaped}`,
    );
    const url = new URL(
      apipath.namespaceResource(namespaceScope, "computers", hostile),
      "https://api.example.test",
    );
    expect(url.pathname).toBe(
      `/v1/accounts/${accountId}/namespaces/agents/computers/${escaped}`,
    );
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });
});
