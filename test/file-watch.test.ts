// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, TransportError, type Computer } from "../src/index.js";
import {
  FakeControlPlane,
  errorResponse,
  json,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
import { FakeNetwork, computerRecord, computersPath } from "./fakes/network.js";

const RESOURCE = "00000000-0000-4000-8000-000000000004";
const ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const watchPath = `${computersPath}/by-id/${ID}/files/watch`;

/** A watch answer with `cursor` and nothing else moved. */
function answer(
  cursor: string,
  fields: Record<string, unknown> = {},
): Response {
  return json({
    cursor,
    syncing: false,
    changes: [],
    published: [],
    ...fields,
  });
}

/**
 * A Computer handle on a fake network whose watch route answers with the
 * next of `answers`, and the `after` each watch request asked with.
 */
async function watched(
  answers: readonly (() => Response | Promise<Response>)[],
): Promise<{
  computer: Computer;
  network: FakeNetwork;
  afters: (string | null)[];
}> {
  const afters: (string | null)[] = [];
  const network = new FakeNetwork((request) => {
    const { pathname } = request.url;
    if (pathname === `${computersPath}/api-dev`) {
      return json({ computer: computerRecord() });
    }
    if (pathname === watchPath) {
      const next = answers[afters.length];
      afters.push(request.url.searchParams.get("after"));
      return next === undefined
        ? errorResponse(403, "FORBIDDEN", "unexpected watch request")
        : next();
    }
    return undefined;
  });
  return {
    computer: await network.client().computers.get("api-dev"),
    network,
    afters,
  };
}

/**
 * Lets the client's pending work run, a turn of the event loop at a time,
 * advancing the faked clock by `stepMs` after each turn, until `condition`
 * holds.
 */
async function until(condition: () => boolean, stepMs = 0): Promise<void> {
  for (let turn = 0; turn < 1_000 && !condition(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (stepMs > 0) await vi.advanceTimersByTimeAsync(stepMs);
  }
  expect(condition()).toBe(true);
}

/** Lets the client's pending work run for `turns` turns of the event loop. */
async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("file watch route", () => {
  // Contract: a watch asks `files/watch` of the addressed files, by name or
  // by identity, with `path` or `pathBase64` only when one is set and
  // `after` only when it is not empty, and reads the answer leniently.
  it("asks the watch route with its folder and cursor", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? json({
              cursor: "c-2",
              syncing: true,
              changes: [
                {
                  path: "a",
                  change: "changed",
                  type: "file",
                  size: 1,
                  status: "syncing",
                  future: true,
                },
              ],
              published: [],
            })
          : undefined,
    });
    const service = plane.client().account.computers;
    const answers = [
      await service.watchFiles("prod", { path: "src dir", after: "c-1" }),
      await service.watchFilesById(RESOURCE, {}),
      await service.watchFilesById(RESOURCE, { pathBase64: "/w==" }),
    ];
    for (const got of answers) {
      expect(got.cursor).toBe("c-2");
      expect(got.syncing).toBe(true);
      expect(got.changes[0]?.status).toBe("syncing");
      expect(got.changes[0]?.change).toBe("changed");
      expect(
        (got.changes[0] as unknown as Record<string, unknown>)["future"],
      ).toBe(true);
    }
    expect(
      plane.requests
        .filter((request) => request.url.host === subnetHost)
        .map(
          (request) =>
            `${request.method} ${request.url.pathname}${request.url.search}`,
        ),
    ).toEqual([
      `GET ${namespacePathPrefix}/computers/prod/files/watch?after=c-1&path=src+dir`,
      `GET ${namespacePathPrefix}/computers/by-id/${RESOURCE}/files/watch`,
      `GET ${namespacePathPrefix}/computers/by-id/${RESOURCE}/files/watch?pathBase64=%2Fw%3D%3D`,
    ]);
  });

  // Contract: a listing of the latest version carries each entry's status
  // and whether the files are syncing; a listing that states no `syncing`
  // carries none.
  it("reads status and syncing from a listing", async () => {
    const pages = [
      {
        items: [
          { name: "a", type: "file", mode: 420, size: 1, status: "syncing" },
          {
            name: "b",
            type: "file",
            mode: 420,
            size: 2,
            status: "failed",
            statusReason: "node-disk-failed",
          },
        ],
        totalCount: 2,
        continue: "page-2",
        syncing: true,
      },
      { items: [], totalCount: 0 },
    ];
    let served = 0;
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost ? json(pages[served++]) : undefined,
    });
    const service = plane.client().account.computers;
    const latest = await service.listFilesById(RESOURCE, { path: "" });
    expect(latest.syncing).toBe(true);
    expect(latest.continue).toBe("page-2");
    expect(latest.items.map((entry) => entry.status)).toEqual([
      "syncing",
      "failed",
    ]);
    expect(latest.items[1]?.statusReason).toBe("node-disk-failed");
    const named = await service.listFiles("prod", { path: "", version: "3" });
    expect(named.syncing).toBeUndefined();
    expect("syncing" in named).toBe(false);
  });

  // Contract: an answer that names no cursor cannot be followed, so it is
  // refused as an invalid response.
  it("refuses an answer with no cursor", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? json({ syncing: false, changes: [], published: [] })
          : undefined,
    });
    const error = await plane
      .client()
      .account.computers.watchFiles("prod", {})
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("invalid_response");
  });

  // Contract: a byte path that is not canonical is refused before any
  // request is made.
  it("refuses a malformed path before any request", async () => {
    const plane = new FakeControlPlane();
    await expect(
      plane.client().account.computers.watchFilesById(RESOURCE, {
        pathBase64: "not base64",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      plane.client().account.computers.watchFiles("prod", { path: "../up" }),
    ).rejects.toThrow(TypeError);
    expect(
      plane.requests.filter((request) => request.url.host === subnetHost),
    ).toEqual([]);
  });
});

describe("computer.files.list status", () => {
  // Contract: a listed entry carries its status and its reason when the
  // listing states them, and neither when it does not.
  it("passes each entry's status through", async () => {
    const network = new FakeNetwork((request) => {
      const { pathname } = request.url;
      if (pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (pathname === `${computersPath}/by-id/${ID}/files`) {
        return json({
          items: [
            { name: "src", type: "dir", mode: 493, size: 0, status: "syncing" },
            {
              name: "notes.md",
              type: "file",
              mode: 420,
              size: 12,
              status: "conflict",
              statusReason: "kept-both",
            },
            { name: "old.txt", type: "file", mode: 420, size: 3 },
          ],
          totalCount: 3,
          syncing: true,
        });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    const entries = [];
    for await (const entry of computer.files.list()) entries.push(entry);
    expect(entries).toEqual([
      { path: "src", type: "dir", size: 0, mode: 493, status: "syncing" },
      {
        path: "notes.md",
        type: "file",
        size: 12,
        mode: 420,
        status: "conflict",
        statusReason: "kept-both",
      },
      { path: "old.txt", type: "file", size: 3, mode: 420 },
    ]);
  });
});

describe("computer.files.watch", () => {
  // Contract: the first answer is delivered at once, an answer whose cursor
  // did not move is asked again without being delivered, a server error is
  // asked again after a wait with the cursor held, and a definite refusal
  // ends the iteration with that error.
  it("delivers moved answers, retries a server error and ends on a refusal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { computer, afters } = await watched([
      () => answer("c-1"),
      () => answer("c-1"),
      () => errorResponse(503, "UNAVAILABLE", "busy"),
      () =>
        answer("c-2", {
          syncing: true,
          changes: [
            {
              path: "notes.md",
              change: "changed",
              type: "file",
              size: 12,
              modified: "2026-01-02T03:04:05Z",
              status: "conflict",
              statusReason: "kept-both",
            },
            { pathBase64: "/w==", change: "removed", status: "syncing" },
          ],
          published: [
            { version: 7, paths: [{ path: "upload.bin" }] },
            { version: 8, paths: [], more: true },
          ],
          store: {
            state: "waiting",
            cause: "store",
            since: "2026-01-02T03:04:05Z",
            waiting: 2,
            fillDone: 3,
            fillTotal: 4,
          },
        }),
      () => errorResponse(403, "FORBIDDEN", "denied"),
    ]);
    const updates = computer.files.watch()[Symbol.asyncIterator]();
    const first = await updates.next();
    expect(first.value).toEqual({
      syncing: false,
      changes: [],
      published: [],
      relist: false,
    });
    const second = updates.next();
    await until(() => afters.length === 4, 10);
    expect((await second).value).toEqual({
      syncing: true,
      changes: [
        {
          path: "notes.md",
          change: "changed",
          type: "file",
          size: 12,
          modified: "2026-01-02T03:04:05Z",
          status: "conflict",
          statusReason: "kept-both",
        },
        { path: "�", change: "removed", status: "syncing" },
      ],
      published: [
        { version: 7, paths: ["upload.bin"], more: false },
        { version: 8, paths: [], more: true },
      ],
      relist: false,
      store: {
        state: "waiting",
        cause: "store",
        since: "2026-01-02T03:04:05Z",
        waiting: 2,
        fillDone: 3,
        fillTotal: 4,
      },
    });
    const ended = await updates.next().catch((error: unknown) => error);
    expect(ended).toBeInstanceOf(ApiError);
    expect((ended as ApiError).status).toBe(403);
    expect(afters).toEqual([null, "c-1", "c-1", "c-1", "c-2"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Contract: a watch of a folder names it as `path`, and the workspace
  // itself is asked with no path.
  it("names the folder it watches", async () => {
    const { computer, network } = await watched([
      () => answer("c-1"),
      () => answer("c-1"),
    ]);
    for await (const status of computer.files.watch("src/app")) {
      expect(status.syncing).toBe(false);
      break;
    }
    for await (const status of computer.files.watch()) {
      expect(status.relist).toBe(false);
      break;
    }
    expect(
      network.computerCalls().filter((call) => call.includes("/files/watch")),
    ).toEqual([`GET ${watchPath}?path=src%2Fapp`, `GET ${watchPath}`]);
  });

  // Contract: a consumer that stops iterating ends the watch: no further
  // request is made and no timer is left running.
  it("stops when the consumer stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { computer, afters } = await watched([
      () => answer("c-1", { relist: true }),
    ]);
    for await (const status of computer.files.watch()) {
      expect(status.relist).toBe(true);
      break;
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(afters).toEqual([null]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Contract: aborting the signal while a request is held rejects with the
  // signal's reason and leaves no timer running; the held answer arriving
  // later is never delivered.
  it("stops on abort while a request is held", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { computer, afters } = await watched([
      () => answer("c-1"),
      () => held,
    ]);
    const controller = new AbortController();
    const watching = computer.files.watch("", { signal: controller.signal });
    const updates = watching[Symbol.asyncIterator]();
    expect((await updates.next()).done).toBe(false);
    const pending = updates.next().catch((error: unknown) => error);
    await until(() => afters.length === 2);
    expect(afters).toEqual([null, "c-1"]);
    const reason = new DOMException("caller left", "AbortError");
    controller.abort(reason);
    expect(await pending).toBe(reason);
    release(answer("c-2"));
    expect(vi.getTimerCount()).toBe(0);
  });

  // Contract: aborting the signal while a failed request waits to be asked
  // again rejects with the signal's reason and clears the wait's timer.
  it("stops on abort while it waits to retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { computer, afters } = await watched([
      () => errorResponse(500, "INTERNAL", "failed"),
    ]);
    const controller = new AbortController();
    const watching = computer.files.watch("", { signal: controller.signal });
    const pending = watching[Symbol.asyncIterator]()
      .next()
      .catch((error: unknown) => error);
    await until(() => afters.length === 1);
    await turns(20);
    expect(vi.getTimerCount()).toBe(1);
    const reason = new DOMException("caller left", "AbortError");
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    expect(afters).toEqual([null]);
  });

  // Contract: a path that would leave the workspace is refused before any
  // request is made.
  it("refuses a path outside the workspace", async () => {
    const { computer, afters } = await watched([]);
    await expect(
      computer.files.watch("../up")[Symbol.asyncIterator]().next(),
    ).rejects.toThrow(TypeError);
    expect(afters).toEqual([]);
  });
});
