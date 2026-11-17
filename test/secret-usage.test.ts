// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { Computer } from "../src/index.js";
import { json } from "./fakes/control-plane.js";
import { accountId } from "./fakes/fetch-queue.js";
import { FakeNetwork, computerRecord, computersPath } from "./fakes/network.js";

const SECRET_ID = "01954e20-7540-7ec4-93ec-14f783e6ab1a";
const COMPUTER_ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const secretsPath = `/v1/accounts/${accountId}/namespaces/default/vault/secrets`;

describe("a Secret's usage", () => {
  // Contract: the openings are read on the Secret's usage route with one
  // version parameter per version asked about, in order, and every count
  // comes back bounded.
  it("counts a Secret's openings and states each version's last opening", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${secretsPath}/git/usage`
        ? json({
            opened: { count: 1000, isLowerBound: true },
            refused: { count: 12 },
            failed: { count: 0 },
            versions: [
              { version: 4, lastOpenedAt: "2026-01-02T03:04:05Z" },
              { version: 3 },
            ],
          })
        : undefined,
    );
    const usage = await network
      .client()
      .secrets.usage("git", { versions: [4, 3] });
    expect(usage).toEqual({
      opened: { count: 1000, isLowerBound: true },
      refused: { count: 12 },
      failed: { count: 0 },
      versions: [
        { version: 4, lastOpenedAt: "2026-01-02T03:04:05Z" },
        { version: 3 },
      ],
    });
    const [sent] = network.plane.requests.filter((r) =>
      r.url.pathname.endsWith("/usage"),
    );
    expect(sent?.url.search).toBe("?version=4&version=3");
  });

  // Contract: versions a usage read cannot name are refused before any
  // request: not whole numbers of at least 1, named twice, or more than 100.
  it("refuses versions a usage read cannot name before any request", async () => {
    const network = new FakeNetwork(() => undefined);
    const secrets = network.client().secrets;
    await expect(secrets.usage("git", { versions: [0] })).rejects.toThrow(
      TypeError,
    );
    await expect(secrets.usage("git", { versions: [2, 2] })).rejects.toThrow(
      new TypeError("version 2 is named twice"),
    );
    await expect(
      secrets.usage("git", {
        versions: Array.from({ length: 101 }, (_, i) => i + 1),
      }),
    ).rejects.toThrow(new TypeError("a usage read names at most 100 versions"));
    expect(
      network.plane.requests.filter((r) => r.url.pathname.includes("usage")),
    ).toEqual([]);
  });

  // Contract: the decryption record narrowed to one outcome sends the
  // outcome filter the reference contract names.
  it("reads the decryptions of one outcome", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${secretsPath}/git/decryptions`
        ? json({ items: [], totalCount: 0 })
        : undefined,
    );
    await network
      .client()
      .secrets.decryptionsPage("git", { outcome: "refused", limit: 20 });
    const [sent] = network.plane.requests.filter((r) =>
      r.url.pathname.endsWith("/decryptions"),
    );
    expect(sent?.url.searchParams.get("filter")).toBe("outcome=refused");
    expect(sent?.url.searchParams.get("limit")).toBe("20");
  });

  // Contract: the Computers that use a Secret are counted on their own
  // route with the versions asked about, each count bounded.
  it("counts the Computers that use a Secret", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/secret-usage/${SECRET_ID}`
        ? json({
            computers: { count: 1000, isLowerBound: true },
            notAttached: { count: 4 },
            following: { count: 1000, isLowerBound: true },
            pinned: [
              { version: 4, count: { count: 0 } },
              { version: 3, count: { count: 21 } },
            ],
          })
        : undefined,
    );
    const usage = await network
      .client()
      .computers.secretUsage(SECRET_ID, { versions: [4, 3] });
    expect(usage).toEqual({
      computers: { count: 1000, isLowerBound: true },
      notAttached: { count: 4 },
      following: { count: 1000, isLowerBound: true },
      pinned: [
        { version: 4, count: { count: 0 } },
        { version: 3, count: { count: 21 } },
      ],
    });
    const [sent] = network.plane.requests.filter((r) =>
      r.url.pathname.includes("/secret-usage/"),
    );
    expect(sent?.url.searchParams.getAll("version")).toEqual(["4", "3"]);
  });

  // Contract: a Computer is read by its ID on the by-id route, and an ID
  // that is not a canonical UUID is refused before any request.
  it("reads a Computer by its ID", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/by-id/${COMPUTER_ID}`
        ? json({ computer: computerRecord({ name: "renamed" }) })
        : undefined,
    );
    const computers = network.client().computers;
    const computer = await computers.getById(COMPUTER_ID);
    expect(computer).toBeInstanceOf(Computer);
    expect(computer.name).toBe("renamed");
    await expect(computers.getById("not-an-id")).rejects.toThrow(
      new TypeError("computer ID must be a canonical UUID"),
    );
    await expect(computers.secretUsage("not-an-id")).rejects.toThrow(
      new TypeError("secret ID must be a canonical UUID"),
    );
  });
});
