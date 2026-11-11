// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { SessionTrustError } from "../src/computer-connection/trust.js";
import {
  TRUST_ROLLBACK,
  indexedDbTrustFloor,
  memoryTrustFloor,
  type TrustFloor,
} from "../src/computer-connection/trust-floor.js";
import { FakeIndexedDb } from "./fakes/indexeddb.js";

const NETWORK = "example.test";

/** What `accept` settled with: `ok`, or the rejection. */
async function outcome(accepting: Promise<void>): Promise<unknown> {
  return await accepting.then(
    () => "ok",
    (error: unknown) => error,
  );
}

function isRollback(value: unknown): boolean {
  return value instanceof SessionTrustError && value.message === TRUST_ROLLBACK;
}

/** The floor's version for `scope`: the lowest version it accepts. */
async function kept(floor: TrustFloor, scope: string): Promise<number> {
  for (let version = 0; ; version += 1) {
    if ((await outcome(floor.accept(NETWORK, scope, version))) === "ok") {
      return version;
    }
  }
}

function store(idb: FakeIndexedDb): Map<string, unknown> {
  const floors = idb.databases.get("idyl-session-trust")?.stores.get("floors");
  if (floors === undefined) throw new Error("the floor store was not made");
  return floors.records;
}

describe("trust floors", () => {
  // Contract: a floor accepts any version for a Network and scope it has
  // not seen, keeps the highest it accepted, accepts that version again,
  // refuses a lower one as a rollback, and keeps each Network and scope
  // apart.
  it("accept, keep the highest and refuse a rollback, in memory", async () => {
    const floor = memoryTrustFloor();
    await floor.accept(NETWORK, "scope-a", 5);
    await floor.accept(NETWORK, "scope-a", 5);
    expect(isRollback(await outcome(floor.accept(NETWORK, "scope-a", 4)))).toBe(
      true,
    );
    await floor.accept(NETWORK, "scope-b", 1);
    await floor.accept("other.test", "scope-a", 1);
    expect(await kept(floor, "scope-a")).toBe(5);
  });

  // Contract: the IndexedDB floor keeps the same rule in its database,
  // where a floor over the same database, as a later page load makes,
  // finds it.
  it("keep the highest version in IndexedDB across page loads", async () => {
    const idb = new FakeIndexedDb();
    const floor = indexedDbTrustFloor(idb.factory, memoryTrustFloor());
    await floor.accept(NETWORK, "scope-a", 5);
    await floor.accept(NETWORK, "scope-a", 5);
    const reloaded = indexedDbTrustFloor(idb.factory, memoryTrustFloor());
    expect(
      isRollback(await outcome(reloaded.accept(NETWORK, "scope-a", 4))),
    ).toBe(true);
    expect([...store(idb).values()]).toEqual([
      { network: NETWORK, scope: "scope-a", version: 5 },
    ]);
  });

  // Contract: each accept is one readwrite transaction, so concurrent
  // accepts, as two pages make, never lower the floor: of a higher and a
  // lower version sent together, the lower is refused, and equal versions
  // both pass.
  it("accept concurrently without lowering the floor", async () => {
    const idb = new FakeIndexedDb();
    const one = indexedDbTrustFloor(idb.factory, memoryTrustFloor());
    const two = indexedDbTrustFloor(idb.factory, memoryTrustFloor());
    const results = await Promise.all([
      outcome(one.accept(NETWORK, "scope-a", 9)),
      outcome(two.accept(NETWORK, "scope-a", 8)),
      outcome(one.accept(NETWORK, "scope-a", 9)),
    ]);
    expect(results[0]).toBe("ok");
    expect(isRollback(results[1])).toBe(true);
    expect(results[2]).toBe("ok");
    expect(store(idb).get(JSON.stringify([NETWORK, "scope-a"]))).toEqual({
      network: NETWORK,
      scope: "scope-a",
      version: 9,
    });
  });

  // Contract: a database asked to make way for a newer version is closed,
  // and one closed under the floor, as clearing site data does, is opened
  // again on the next accept, which then succeeds.
  it("reopen after a version change or a close", async () => {
    const idb = new FakeIndexedDb();
    const floor = indexedDbTrustFloor(idb.factory, memoryTrustFloor());
    await floor.accept(NETWORK, "scope-a", 3);
    idb.versionChange();
    expect(idb.connections.every((connection) => connection.closed)).toBe(true);
    await floor.accept(NETWORK, "scope-a", 4);
    idb.closeAll();
    await floor.accept(NETWORK, "scope-a", 5);
    expect(idb.opens).toBe(3);
    // A connection closed with no close event is found closed by its next
    // transaction, and the accept opens again once and succeeds.
    const last = idb.connections.at(-1);
    if (last !== undefined) last.closed = true;
    await floor.accept(NETWORK, "scope-a", 6);
    expect(idb.opens).toBe(4);
    expect(isRollback(await outcome(floor.accept(NETWORK, "scope-a", 5)))).toBe(
      true,
    );
  });

  // Contract: an open blocked by another page waits until it proceeds,
  // and the accept then completes.
  it("wait for a blocked open", async () => {
    const idb = new FakeIndexedDb();
    idb.blockOpen = true;
    const floor = indexedDbTrustFloor(idb.factory, memoryTrustFloor());
    let settled = false;
    const accepting = floor.accept(NETWORK, "scope-a", 2).then(() => {
      settled = true;
    });
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(settled).toBe(false);
    idb.unblock();
    await accepting;
    expect(settled).toBe(true);
  });

  // Contract: only an `open` that throws hands the floor to the fallback,
  // which still refuses a rollback for the life of the page; an open that
  // fails rejects the accept, and the next accept opens again.
  it("fall back only when open throws, and retry a failed open", async () => {
    const throwing = new FakeIndexedDb();
    throwing.throwOnOpen = true;
    const fallback = memoryTrustFloor();
    const floor = indexedDbTrustFloor(throwing.factory, fallback);
    await floor.accept(NETWORK, "scope-a", 4);
    expect(
      isRollback(await outcome(fallback.accept(NETWORK, "scope-a", 3))),
    ).toBe(true);

    const failing = new FakeIndexedDb();
    failing.failOpen = true;
    const strict = indexedDbTrustFloor(failing.factory, memoryTrustFloor());
    await expect(strict.accept(NETWORK, "scope-a", 1)).rejects.toMatchObject({
      name: "UnknownError",
    });
    failing.failOpen = false;
    await strict.accept(NETWORK, "scope-a", 1);
  });

  // Contract: a transaction that fails, and a stored record that is not a
  // whole, non-negative version, reject: nothing is assumed in their place.
  it("reject a failed transaction and a malformed record", async () => {
    const idb = new FakeIndexedDb();
    const floor = indexedDbTrustFloor(idb.factory, memoryTrustFloor());
    await floor.accept(NETWORK, "scope-a", 2);
    idb.failTransactions = true;
    await expect(floor.accept(NETWORK, "scope-a", 3)).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
    idb.failTransactions = false;
    for (const version of [-1, 1.5, "7", null]) {
      store(idb).set(JSON.stringify([NETWORK, "scope-a"]), {
        network: NETWORK,
        scope: "scope-a",
        version,
      });
      await expect(floor.accept(NETWORK, "scope-a", 9)).rejects.toThrow(
        "trust floor record is malformed",
      );
    }
  });

  // Contract: once the page has opened the database, an `open` that throws
  // rejects rather than leaving the floor to an empty memory; and the
  // page's memory refuses a version below one the page accepted even when
  // the database no longer holds it.
  it("never accept below what the page accepted", async () => {
    const idb = new FakeIndexedDb();
    const floor = indexedDbTrustFloor(idb.factory, memoryTrustFloor());
    await floor.accept(NETWORK, "scope-a", 5);
    store(idb).clear();
    expect(isRollback(await outcome(floor.accept(NETWORK, "scope-a", 4)))).toBe(
      true,
    );
    idb.closeAll();
    idb.throwOnOpen = true;
    await expect(floor.accept(NETWORK, "scope-a", 6)).rejects.toMatchObject({
      name: "SecurityError",
    });
  });

  // Contract: the database is opened at whatever version it has, so a
  // newer client's version locks no page out, and a database without the
  // floor store gains it at the next version.
  it("open any version and add a missing store", async () => {
    const newer = new FakeIndexedDb();
    newer.create("idyl-session-trust", 7);
    const floor = indexedDbTrustFloor(newer.factory, memoryTrustFloor());
    await floor.accept(NETWORK, "scope-a", 2);
    expect(newer.databases.get("idyl-session-trust")?.version).toBe(8);
    expect(store(newer).size).toBe(1);
    const reloaded = indexedDbTrustFloor(newer.factory, memoryTrustFloor());
    await reloaded.accept(NETWORK, "scope-a", 3);
    expect(newer.databases.get("idyl-session-trust")?.version).toBe(8);
  });

  // Contract: accepts that find the database closed at the same time open
  // it again once between them, and every one of them completes.
  it("recover once from a close met by concurrent accepts", async () => {
    const idb = new FakeIndexedDb();
    const floor = indexedDbTrustFloor(idb.factory, memoryTrustFloor());
    await floor.accept(NETWORK, "scope-a", 1);
    const first = idb.connections.at(-1);
    if (first !== undefined) first.closed = true;
    await Promise.all([
      floor.accept(NETWORK, "scope-a", 2),
      floor.accept(NETWORK, "scope-b", 2),
    ]);
    expect(idb.opens).toBe(2);
    expect(idb.connections.filter((c) => !c.closed)).toHaveLength(1);
  });
});
