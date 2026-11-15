// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TransportError } from "../src/index.js";
import { json } from "./fakes/control-plane.js";
import { accountId } from "./fakes/fetch-queue.js";
import { FakeNetwork, computerRecord, computersPath } from "./fakes/network.js";

const COMPUTER_ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const vaultPath = `/v1/accounts/${accountId}/namespaces/default/vault`;
const secretDecryptionsPath = `${vaultPath}/secrets/database/decryptions`;
const computerDecryptionsPath = `${vaultPath}/computers/${COMPUTER_ID}/decryptions`;

/** The reference contract's golden page of the record. */
function goldenPage(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(
        "./conformance/fixtures/api/testdata/golden/vault-decryptions.list-page.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

/** The golden page's two records as the public type reads them. */
const publicRecords = [
  {
    at: "2026-01-02T03:04:07Z",
    kind: "Secret",
    resourceId: "01954e20-7540-7ec4-93ec-14f783e6ab20",
    name: "database",
    version: 3,
    activation: "01954e20-7540-7ec4-93ec-14f783e6ab21.2",
    outcome: "opened",
    reportedBy: "kms",
    kmsRequestId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  },
  {
    at: "2026-01-02T03:04:05Z",
    kind: "Secret",
    resourceId: "01954e20-7540-7ec4-93ec-14f783e6ab20",
    name: "database",
    version: 3,
    computerId: COMPUTER_ID,
    activation: "01954e20-7540-7ec4-93ec-14f783e6ab21.2",
    outcome: "opened",
    reportedBy: "both",
    kmsRequestId: "6f0a4e47-1c55-4f4e-8f5a-0c6f2c8f2a11",
  },
];

describe("idyl.secrets.decryptions", () => {
  // Contract: a Secret's record is read by the Secret's name under the
  // Namespace's vault path, on the API that serves its Computers, with
  // `limit` and an offset carried as `continue`; each record reads as the
  // public type, and a record only the key service reported names no
  // Computer.
  it("reads a Secret's record page by page", async () => {
    const network = new FakeNetwork((request) =>
      request.method === "GET" && request.url.pathname === secretDecryptionsPath
        ? json(goldenPage())
        : undefined,
    );
    const { secrets } = network.client();
    const page = await secrets.decryptionsPage("database", { limit: 2 });
    expect(page.items).toEqual(publicRecords);
    expect(page.continue).toBe("2");
    const next = await secrets.decryptionsPage("database", {
      limit: 2,
      continue: "2",
    });
    expect(next.items).toHaveLength(2);
    expect(network.computerCalls()).toEqual([
      `GET ${secretDecryptionsPath}?limit=2`,
      `GET ${secretDecryptionsPath}?limit=2&offset=2`,
    ]);
  });

  // Contract: the walk reads every page until the platform's total is
  // reached.
  it("walks a Secret's record", async () => {
    const network = new FakeNetwork((request) => {
      if (request.url.pathname !== secretDecryptionsPath) return undefined;
      const page = goldenPage();
      return json({ ...page, totalCount: 2 });
    });
    const walked: string[] = [];
    for await (const record of network
      .client()
      .secrets.decryptions("database")) {
      walked.push(record.reportedBy);
    }
    expect(walked).toEqual(["kms", "both"]);
  });

  // Contract: a blank name and an invalid limit are refused before any
  // request.
  it("refuses a blank name and an invalid limit before any request", async () => {
    const network = new FakeNetwork(() => undefined);
    const { secrets } = network.client();
    expect(await rejection(secrets.decryptionsPage(" "))).toBeInstanceOf(
      TypeError,
    );
    expect(
      await rejection(secrets.decryptionsPage("database", { limit: 0 })),
    ).toBeInstanceOf(TypeError);
    expect(network.computerCalls()).toEqual([]);
  });

  // Contract: a record outside the addressed Subnet is never handed back,
  // and the control is read. A record is read leniently: an outcome or a
  // reporter this package does not name is carried unchanged, and a field
  // the public type does not declare is left out.
  it("refuses a record of another Subnet and carries an unnamed outcome", async () => {
    const page = (fields: Record<string, unknown>) =>
      new FakeNetwork((request) => {
        if (request.url.pathname !== secretDecryptionsPath) return undefined;
        const golden = goldenPage();
        const [first] = golden["items"] as Record<string, unknown>[];
        return json({ items: [{ ...first, ...fields }], totalCount: 1 });
      });
    const error = await rejection(
      page({ subnet: "550000000099" })
        .client()
        .secrets.decryptionsPage("database"),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toBe(
      "decryption list names a record outside the addressed subnet",
    );
    const carried = await page({ outcome: "withheld", extra: true })
      .client()
      .secrets.decryptionsPage("database");
    expect(carried.items).toEqual([
      { ...publicRecords[0], outcome: "withheld" },
    ]);
  });
});

describe("computer.decryptions", () => {
  // Contract: a Computer's record is read by the Computer's stable ID under
  // the Namespace's vault path, never by its name, and only when asked for:
  // reading the Computer does not read it.
  it("reads a Computer's record by its ID", async () => {
    const network = new FakeNetwork((request) => {
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.url.pathname === computerDecryptionsPath) {
        const golden = goldenPage();
        const [, second] = golden["items"] as Record<string, unknown>[];
        return json({ items: [second], totalCount: 1 });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    expect(
      network
        .computerCalls()
        .some((call) => call.includes("/vault/computers/")),
    ).toBe(false);
    const page = await computer.decryptionsPage({ limit: 5 });
    expect(page.items).toEqual([publicRecords[1]]);
    expect(page.continue).toBeUndefined();
    expect(network.computerCalls().at(-1)).toBe(
      `GET ${computerDecryptionsPath}?limit=5`,
    );
    const walked = [];
    for await (const record of computer.decryptions()) walked.push(record);
    expect(walked).toEqual([publicRecords[1]]);
  });
});
