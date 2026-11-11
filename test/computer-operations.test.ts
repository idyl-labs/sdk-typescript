// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  ERROR_CODE_INSUFFICIENT_CAPACITY,
  ERROR_CODE_SAVE_FAILED,
  TransportError,
  isApiCode,
} from "../src/index.js";
import {
  createComputerSleepRequestShape,
  validateCreateComputerSleepRequest,
} from "../src/api/computer-operations.js";
import { type JsonObject } from "../src/resource/json.js";
import {
  FakeControlPlane,
  json,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
import { subnetSlug } from "./fakes/fetch-queue.js";
import { FakeNetwork, computerRecord, computersPath } from "./fakes/network.js";

/** A served-object golden, as the platform sends it. */
function golden(name: string): JsonObject {
  return JSON.parse(
    readFileSync(
      new URL(
        `./conformance/fixtures/api/testdata/golden/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as JsonObject;
}

const COMPUTER = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const OPERATION = "01954e20-7540-7ec4-93ec-14f783e6ab41";
const OTHER_OPERATION = "01954e20-7540-7ec4-93ec-14f783e6ab42";
const byId = `${computersPath}/by-id/${COMPUTER}`;
const requests = golden("computer-operation.requests");

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

interface RouteCase {
  readonly method: string;
  readonly verb: string;
  readonly suffix: string;
  readonly args: readonly unknown[];
  readonly status: number;
  readonly response: JsonObject;
  readonly body?: unknown;
}

const cases: readonly RouteCase[] = [
  {
    method: "createWake",
    verb: "POST",
    suffix: "/wakes",
    args: [requests["wake"]],
    body: requests["wake"],
    status: 202,
    response: golden("computer-wake.pending"),
  },
  {
    method: "createWake",
    verb: "POST",
    suffix: "/wakes",
    args: [requests["wakeMinimal"]],
    body: requests["wakeMinimal"],
    status: 200,
    response: golden("computer-wake.awake"),
  },
  {
    method: "getWake",
    verb: "GET",
    suffix: `/wakes/${OPERATION}`,
    args: [OPERATION],
    status: 200,
    response: golden("computer-wake.failed"),
  },
  {
    method: "createSleep",
    verb: "POST",
    suffix: "/sleeps",
    args: [requests["sleep"]],
    body: requests["sleep"],
    status: 202,
    response: golden("computer-sleep.pending"),
  },
  {
    method: "createSleep",
    verb: "POST",
    suffix: "/sleeps",
    args: [requests["sleepMinimal"]],
    body: requests["sleepMinimal"],
    status: 200,
    response: golden("computer-sleep.asleep-unchanged"),
  },
  {
    method: "getSleep",
    verb: "GET",
    suffix: `/sleeps/${OPERATION}`,
    args: [OPERATION],
    status: 200,
    response: golden("computer-sleep.asleep"),
  },
];

describe("wake and sleep routes", () => {
  // Contract: wakes and sleeps are created and read at the Computer's
  // `wakes` and `sleeps` collections, by name and by stable ID; a create
  // sends its request document verbatim, and a pending answer (202) is a
  // result, not an error.
  for (const byIdentity of [false, true]) {
    it(`uses the ${byIdentity ? "identity" : "name"} routes`, async () => {
      for (const test of cases) {
        const plane = new FakeControlPlane({
          routes: (request) =>
            request.url.host === subnetHost
              ? json(test.response, test.status)
              : undefined,
        });
        const service = plane.client().account.computers;
        const method = test.method + (byIdentity ? "ById" : "");
        const callable = (
          service as unknown as Record<
            string,
            ((...args: unknown[]) => Promise<unknown>) | undefined
          >
        )[method];
        if (callable === undefined)
          throw new Error(`missing service method ${method}`);
        const result = await callable(
          byIdentity ? COMPUTER : "research",
          ...test.args,
        );
        expect(result, method).toEqual(test.response);
        const request = plane.requests.find(
          (value) => value.url.host === subnetHost,
        );
        expect(request?.method, method).toBe(test.verb);
        expect(request?.url.pathname, method).toBe(
          `${namespacePathPrefix}/computers/${byIdentity ? `by-id/${COMPUTER}` : "research"}${test.suffix}`,
        );
        expect(
          request?.body === undefined ? undefined : JSON.parse(request.body),
          method,
        ).toEqual(test.body);
        expect(request?.init.redirect, method).toBe("manual");
      }
    });
  }

  // Contract: a read answered with another operation's identity is refused
  // as an invalid response, by name and by ID, for wakes and sleeps.
  it("refuses a read that names another operation", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? json({ id: OTHER_OPERATION, state: "awake" })
          : undefined,
    });
    const service = plane.client().account.computers;
    for (const read of [
      () => service.getWake("research", OPERATION),
      () => service.getWakeById(COMPUTER, OPERATION),
      () => service.getSleep("research", OPERATION),
      () => service.getSleepById(COMPUTER, OPERATION),
    ]) {
      const error = await rejection(read());
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).code).toBe("invalid_response");
      expect((error as Error).message).toContain(
        "operation response names a different identity",
      );
    }
  });

  // Contract: an operation ID, a Computer ID or a name that is not valid,
  // and a request field the contract does not declare, are refused before
  // any request is sent.
  it("refuses invalid addresses before any request", async () => {
    const plane = new FakeControlPlane();
    const service = plane.client().account.computers;
    await expect(service.getWake("research", "not-an-id")).rejects.toThrow(
      "computer operation ID must be a canonical UUID",
    );
    await expect(
      service.getSleepById(COMPUTER, OPERATION.toUpperCase()),
    ).rejects.toThrow("computer operation ID must be a canonical UUID");
    await expect(service.createSleepById("not-an-id", {})).rejects.toThrow(
      "computer ID must be a canonical UUID",
    );
    await expect(service.createWake(" ", {})).rejects.toThrow(
      "computer name is required",
    );
    await expect(
      service.createWake("research", { force: true } as never),
    ).rejects.toThrow("unknown field");
    expect(plane.requests).toEqual([]);
  });
});

/**
 * A network serving one Computer whose wakes and sleeps answer `created`
 * on create and then each read in `reads` in turn, the last repeated.
 */
function operations(
  collection: "wakes" | "sleeps",
  created: JsonObject,
  reads: readonly JsonObject[],
): FakeNetwork {
  let read = 0;
  return new FakeNetwork((request) => {
    const { pathname } = request.url;
    if (pathname === `${computersPath}/api-dev`) {
      return json({ computer: computerRecord() });
    }
    if (pathname === `${byId}/${collection}` && request.method === "POST") {
      return json(created, created["state"] === "pending" ? 202 : 200);
    }
    if (pathname === `${byId}/${collection}/${OPERATION}`) {
      const answer = reads[Math.min(read, reads.length - 1)];
      read += 1;
      return json(answer);
    }
    return undefined;
  });
}

describe("Computer.wake", () => {
  // Contract: wake creates a wake by the Computer's ID with the caller's
  // key and client and reads it until it is awake.
  it("waits until the Computer is awake", async () => {
    const network = operations("wakes", golden("computer-wake.pending"), [
      golden("computer-wake.awake"),
    ]);
    const computer = await network.client().computers.get("api-dev");
    expect(
      await computer.wake({ idempotencyKey: "wake-1", client: "console" }),
    ).toEqual({
      state: "awake",
    });
    expect(network.computerCalls()).toEqual([
      `GET ${computersPath}/api-dev`,
      `POST ${byId}/wakes`,
      `GET ${byId}/wakes/${OPERATION}`,
    ]);
    const create = network
      .computerRequests()
      .find((request) => request.method === "POST");
    expect(JSON.parse(create?.body ?? "null")).toEqual(requests["wake"]);
  });

  // Contract: onWaiting hears when a wake starts and stops waiting, once for
  // each change, including what the create already reports; a wake that never
  // waits never calls it.
  it("says when a wake starts and stops waiting", async () => {
    const waiting = golden("computer-wake.waiting");
    const network = operations("wakes", golden("computer-wake.pending"), [
      waiting,
      waiting,
      golden("computer-wake.pending"),
      golden("computer-wake.awake"),
    ]);
    const computer = await network.client().computers.get("api-dev");
    const heard: (string | undefined)[] = [];
    await computer.wake({
      onWaiting: (waitingFor) => heard.push(waitingFor),
    });
    expect(heard).toEqual(["INSUFFICIENT_CAPACITY", undefined]);

    const direct = operations("wakes", golden("computer-wake.pending"), [
      golden("computer-wake.awake"),
    ]);
    const quiet = await direct.client().computers.get("api-dev");
    const never: unknown[] = [];
    await quiet.wake({ onWaiting: (waitingFor) => never.push(waitingFor) });
    expect(never).toEqual([]);
  });

  // Contract: a Computer from the listing wakes with its wake alone; it is
  // not read again before the wake is created.
  it("wakes a listed Computer without reading it again", async () => {
    const network = new FakeNetwork((request) => {
      const { pathname } = request.url;
      if (pathname === computersPath) {
        return json({ items: [computerRecord()], totalCount: 1 });
      }
      if (pathname === `${byId}/wakes` && request.method === "POST") {
        return json(golden("computer-wake.awake"));
      }
      return undefined;
    });
    const page = await network.client().computers.listPage();
    const [computer] = page.items;
    expect(await computer?.wake({ client: "console" })).toEqual({
      state: "awake",
    });
    expect(network.computerCalls()).toEqual([
      `GET ${computersPath}?subnet=${subnetSlug}`,
      `POST ${byId}/wakes`,
    ]);
  });

  // Contract: a wake already awake when created is not read again.
  it("returns at once for an awake Computer", async () => {
    const network = operations("wakes", golden("computer-wake.awake"), []);
    const computer = await network.client().computers.get("api-dev");
    expect(await computer.wake()).toEqual({ state: "awake" });
    expect(network.computerCalls()).toEqual([
      `GET ${computersPath}/api-dev`,
      `POST ${byId}/wakes`,
    ]);
  });

  // Contract: a failed wake rejects with an ApiError (409) carrying its
  // reason as code and detail, so it is classified as a refused session
  // would be.
  it("rejects a failed wake with its reason", async () => {
    const network = operations("wakes", golden("computer-wake.pending"), [
      golden("computer-wake.failed"),
    ]);
    const computer = await network.client().computers.get("api-dev");
    const error = await rejection(computer.wake());
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("INSUFFICIENT_CAPACITY");
    expect((error as ApiError).detail).toBe("INSUFFICIENT_CAPACITY");
    expect(isApiCode(error, ERROR_CODE_INSUFFICIENT_CAPACITY)).toBe(true);
  });

  // Contract: a timeout that is not a non-negative number is refused
  // before anything is sent.
  it("judges its wait before waking", async () => {
    const network = operations("wakes", golden("computer-wake.pending"), []);
    const computer = await network.client().computers.get("api-dev");
    await expect(computer.wake({ timeoutMs: -1 })).rejects.toThrow(TypeError);
    expect(
      network.computerCalls().filter((call) => call.startsWith("POST")),
    ).toEqual([]);
  });

  // Contract: a zero timeout judges the created wake once; a pending wake
  // rejects with a TimeoutError and is not read again.
  it("gives up on a pending wake when its time runs out", async () => {
    const network = operations("wakes", golden("computer-wake.pending"), []);
    const computer = await network.client().computers.get("api-dev");
    const error = await rejection(computer.wake({ timeoutMs: 0 }));
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("TimeoutError");
    expect(network.computerCalls()).toEqual([
      `GET ${computersPath}/api-dev`,
      `POST ${byId}/wakes`,
    ]);
  });
});

describe("Computer.sleep", () => {
  // Contract: sleep creates a sleep by the Computer's ID with the caller's
  // key and client and reads it until it is asleep, returning the version
  // its save recorded, zero included.
  it("waits until the Computer is asleep", async () => {
    const network = operations("sleeps", golden("computer-sleep.pending"), [
      golden("computer-sleep.asleep"),
    ]);
    const computer = await network.client().computers.get("api-dev");
    expect(
      await computer.sleep({ idempotencyKey: "sleep-1", client: "cli" }),
    ).toEqual({
      state: "asleep",
      version: 0,
    });
    expect(network.computerCalls()).toEqual([
      `GET ${computersPath}/api-dev`,
      `POST ${byId}/sleeps`,
      `GET ${byId}/sleeps/${OPERATION}`,
    ]);
    const create = network
      .computerRequests()
      .find((request) => request.method === "POST");
    expect(JSON.parse(create?.body ?? "null")).toEqual(requests["sleep"]);
  });

  // Contract: a sleep asked to discard unsaved changes states it on the
  // wire as the reference contract does, with the caller's key and client;
  // a sleep that does not ask states nothing of it.
  it("asks to discard unsaved changes only when told to", async () => {
    const network = operations(
      "sleeps",
      golden("computer-sleep.asleep-unchanged"),
      [],
    );
    const computer = await network.client().computers.get("api-dev");
    expect(
      await computer.sleep({
        idempotencyKey: "sleep-2",
        client: "cli",
        discardUnsavedChanges: true,
      }),
    ).toEqual({ state: "asleep" });
    await computer.sleep({ discardUnsavedChanges: false });
    const [discarding, saving] = network
      .computerRequests()
      .filter((request) => request.method === "POST")
      .map((request) => JSON.parse(request.body ?? "null") as unknown);
    expect(discarding).toEqual(requests["sleepDiscard"]);
    expect(saving).not.toHaveProperty("discardUnsavedChanges");
  });

  // Contract: onWaiting hears when a sleep starts and stops waiting at a
  // storage limit, once for each change, with the refused save's reason; the
  // sleep goes on until it is asleep.
  it("says when a sleep waits at a storage limit", async () => {
    const waiting = golden("computer-sleep.waiting");
    const network = operations("sleeps", golden("computer-sleep.pending"), [
      waiting,
      waiting,
      golden("computer-sleep.pending"),
      golden("computer-sleep.asleep"),
    ]);
    const computer = await network.client().computers.get("api-dev");
    const heard: (string | undefined)[] = [];
    expect(
      await computer.sleep({
        onWaiting: (waitingFor) => heard.push(waitingFor),
      }),
    ).toEqual({ state: "asleep", version: 0 });
    expect(heard).toEqual(["account-storage-limit", undefined]);
  });

  // Contract: a Computer already asleep is asleep at once, with no version.
  it("reports no version when nothing was saved", async () => {
    const network = operations(
      "sleeps",
      golden("computer-sleep.asleep-unchanged"),
      [],
    );
    const computer = await network.client().computers.get("api-dev");
    expect(await computer.sleep()).toEqual({ state: "asleep" });
    expect(network.computerCalls()).toEqual([
      `GET ${computersPath}/api-dev`,
      `POST ${byId}/sleeps`,
    ]);
  });

  // Contract: a failed sleep rejects with an ApiError (409) carrying its
  // reason as code and detail.
  it("rejects a failed sleep with its reason", async () => {
    const network = operations("sleeps", golden("computer-sleep.pending"), [
      golden("computer-sleep.failed"),
    ]);
    const computer = await network.client().computers.get("api-dev");
    const error = await rejection(computer.sleep());
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).detail).toBe("SAVE_FAILED");
    expect(isApiCode(error, ERROR_CODE_SAVE_FAILED)).toBe(true);
  });

  // Contract: a read that names another sleep ends the wait as an invalid
  // response rather than reporting another operation's outcome.
  it("refuses a read that names another sleep", async () => {
    const network = operations("sleeps", golden("computer-sleep.pending"), [
      { ...golden("computer-sleep.asleep"), id: OTHER_OPERATION },
    ]);
    const computer = await network.client().computers.get("api-dev");
    const error = await rejection(computer.sleep());
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("invalid_response");
  });
});

describe("a forced sleep", () => {
  // Contract: a sleep may force or discard, never both, and a journal sleep
  // entry that records both is refused.
  it("refuses forcing beside discarding", () => {
    expect(() => {
      validateCreateComputerSleepRequest({ force: true });
    }).not.toThrow();
    expect(() => {
      validateCreateComputerSleepRequest({
        force: true,
        discardUnsavedChanges: true,
      });
    }).toThrow("force and discardUnsavedChanges cannot both be set");
    expect(
      JSON.stringify(createComputerSleepRequestShape.encode({ force: true })),
    ).toBe('{"force":true}');
  });
});
