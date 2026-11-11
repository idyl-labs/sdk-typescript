// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { connections } from "../src/client/connections.js";
import type { ComputerConnector } from "../src/index.js";
import type { ThreadConnection } from "../src/computer-connection/in-thread.js";

const trustKeys = [{ keyId: "key", publicKey: new Uint8Array(32) }];
const thread = {
  worker: {},
  module: {},
} as unknown as ThreadConnection;

function connector(): ComputerConnector & { closes: number } {
  const made = {
    closes: 0,
    close() {
      made.closes += 1;
    },
  };
  return made as unknown as ComputerConnector & { closes: number };
}

function subject(connect = vi.fn(() => Promise.resolve(thread))) {
  const built: (ComputerConnector & { closes: number })[] = [];
  const source = connections({
    network: "example.test",
    trustKeys,
    connect,
    build: () => {
      const made = connector();
      built.push(made);
      return made;
    },
  });
  return { source, built, connect };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connections", () => {
  // Contract: commands at the same time and commands in a row share one
  // connection, so a second command pays for no second dock.
  it("shares one connector across commands", async () => {
    const { source, built, connect } = subject();
    const seen = await Promise.all([
      source.use((c) => Promise.resolve(c)),
      source.use((c) => Promise.resolve(c)),
    ]);
    await source.use((c) => Promise.resolve(c));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(built).toHaveLength(1);
    expect(seen[0]).toBe(seen[1]);
  });

  // Contract: the connection closes a moment after the last command, as an
  // open connection keeps a Node.js process alive; the next command starts
  // another.
  it("closes the connector once idle and starts another when needed", async () => {
    vi.useFakeTimers();
    const { source, built } = subject();
    await source.use(() => Promise.resolve());
    expect(built[0]?.closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(built[0]?.closes).toBe(1);
    await source.use(() => Promise.resolve());
    expect(built).toHaveLength(2);
  });

  // Contract: a command that starts within the idle moment keeps the
  // connection, and a command still running holds it open.
  it("keeps the connector while commands run", async () => {
    vi.useFakeTimers();
    const { source, built } = subject();
    await source.use(() => Promise.resolve());
    let finish: () => void = () => undefined;
    const running = source.use(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(built[0]?.closes).toBe(0);
    finish();
    await running;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(built[0]?.closes).toBe(1);
  });

  // Contract: a failed start is not kept: the next command tries again, and
  // the failure reaches the caller.
  it("does not keep a failed start", async () => {
    const connect = vi
      .fn<() => Promise<ThreadConnection>>()
      .mockRejectedValueOnce(new Error("no module"))
      .mockResolvedValue(thread);
    const { source, built } = subject(connect);
    await expect(source.use(() => Promise.resolve())).rejects.toThrow(
      "no module",
    );
    await source.use(() => Promise.resolve());
    expect(built).toHaveLength(1);
  });

  // Contract: a hold, as a terminal takes, keeps the connector open past the
  // call that took it, until it is released; a second release changes nothing.
  it("keeps the connector until a hold is released", async () => {
    vi.useFakeTimers();
    const { source, built } = subject();
    const hold = await source.hold();
    await source.use(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(built[0]?.closes).toBe(0);
    hold.release();
    hold.release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(built[0]?.closes).toBe(1);
  });

  // Contract: a connector the application built is used as it is, and its life
  // is the application's.
  it("runs on an adopted connector and leaves it open", async () => {
    vi.useFakeTimers();
    const { source, connect } = subject();
    const own = connector();
    expect(source.adopt(own)).toBe(own);
    await expect(source.use((c) => Promise.resolve(c))).resolves.toBe(own);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(own.closes).toBe(0);
    expect(connect).not.toHaveBeenCalled();
  });

  // Contract: a page's connection holds its key in a dedicated Worker, which
  // only the application can start, so a page is never connected in its own
  // thread.
  it("refuses to start in a browser page", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const { source, connect } = subject();
    await expect(source.use(() => Promise.resolve())).rejects.toThrow(
      "idyl.computers.connector",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  // Contract: a session trust that cannot be verified opens no session, so a
  // client with no trust keys or no network refuses before connecting.
  it("refuses without trust keys or a network", async () => {
    const connect = vi.fn(() => Promise.resolve(thread));
    const build = () => connector();
    await expect(
      connections({
        network: "example.test",
        trustKeys: undefined,
        connect,
        build,
      }).use(() => Promise.resolve()),
    ).rejects.toThrow("trustKeys");
    await expect(
      connections({ network: undefined, trustKeys, connect, build }).use(() =>
        Promise.resolve(),
      ),
    ).rejects.toThrow("no network");
    expect(connect).not.toHaveBeenCalled();
  });
});
