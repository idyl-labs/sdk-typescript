// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { handleStateOf } from "../src/client/computer.js";
import { FrameError } from "../src/computer-connection/frames.js";
import { commandOf, runCommand } from "../src/client/exec.js";
import type {
  ComputerConnector,
  ComputerSessionStream,
  SessionOpen,
  SessionOutput,
} from "../src/index.js";
import {
  CommandSaveError,
  CommandSessionError,
  ExitError,
  TransportError,
} from "../src/index.js";
import { json } from "./fakes/control-plane.js";
import { FakeNetwork, computerRecord } from "./fakes/network.js";

const COMPUTER = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const SESSION = "01954e20-7540-7ec4-93ec-14f783e6ab05";
const enc = new TextEncoder();

const data = (type: "stdout" | "stderr", text: string): SessionOutput => ({
  type,
  data: enc.encode(text),
});
const opened: SessionOutput = { type: "opened", session: SESSION };
const exit0: SessionOutput = { type: "exit", code: 0 };
const published: SessionOutput = {
  type: "saved",
  outcome: "published",
  revision: 7,
};

/** A connector whose one session sends `frames`, then ends unless `open`. */
function fake(
  frames: readonly SessionOutput[],
  options: { readonly stayOpen?: boolean } = {},
): {
  readonly connector: ComputerConnector;
  readonly opens: SessionOpen[];
  closed: () => number;
  send: (frame: SessionOutput) => void;
  fail: (error: Error) => void;
} {
  let closes = 0;
  let writer: ReadableStreamDefaultController<SessionOutput>;
  const opens: SessionOpen[] = [];
  const stream: ComputerSessionStream = {
    requestId: "request",
    id: undefined,
    output: new ReadableStream<SessionOutput>({
      start(controller) {
        writer = controller;
        for (const frame of frames) controller.enqueue(frame);
        if (options.stayOpen !== true) controller.close();
      },
    }),
    write: () => undefined,
    resize: () => undefined,
    closeInput: () => undefined,
    close: () => {
      closes += 1;
    },
  };
  return {
    opens,
    closed: () => closes,
    send: (frame) => {
      writer.enqueue(frame);
    },
    fail: (error) => {
      writer.error(error);
    },
    connector: {
      open: (_computer: string, open: SessionOpen) => {
        opens.push(open);
        return Promise.resolve(stream);
      },
    } as unknown as ComputerConnector,
  };
}

const noRead = (): Promise<never> =>
  Promise.reject(new Error("the session was read"));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

describe("commandOf", () => {
  // Contract: a string runs through the shell, so its pipes and quotes work;
  // a list reaches the Computer as given.
  it("runs a string through the shell and a list as given", () => {
    expect(commandOf("a | b")).toEqual(["/bin/sh", "-c", "a | b"]);
    expect(commandOf(["printf", "%s", "a b"])).toEqual(["printf", "%s", "a b"]);
  });

  // Contract: a command with nothing to run is refused before anything is sent.
  it("refuses an empty command", () => {
    expect(() => commandOf(" ")).toThrow(TypeError);
    expect(() => commandOf(7 as unknown as string)).toThrow(TypeError);
  });
});

describe("runCommand", () => {
  // Contract: a command returns its output and the version its changes became,
  // and its session is closed.
  it("returns the output and the saved version", async () => {
    const { connector, opens, closed } = fake([
      opened,
      data("stdout", "out"),
      data("stderr", "err"),
      data("stdout", "put"),
      exit0,
      published,
    ]);
    const result = await runCommand(
      connector,
      COMPUTER,
      { mode: "exec", command: ["true"] },
      noRead,
      undefined,
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: "output",
      stderr: "err",
      save: "published",
      version: 7,
    });
    expect(opens).toEqual([{ mode: "exec", command: ["true"] }]);
    expect(closed()).toBe(1);
  });

  // Contract: a character split across two frames is decoded whole.
  it("decodes UTF-8 split across frames", async () => {
    const euro = enc.encode("€");
    const { connector } = fake([
      opened,
      { type: "stdout", data: euro.slice(0, 1) },
      { type: "stdout", data: euro.slice(1) },
      exit0,
      published,
    ]);
    const { stdout } = await runCommand(
      connector,
      COMPUTER,
      { mode: "exec", command: ["true"] },
      noRead,
      undefined,
    );
    expect(stdout).toBe("€");
  });

  // Contract: any exit but 0 rejects with its code and the output so far.
  it("rejects a failed command with ExitError", async () => {
    const { connector, closed } = fake([
      opened,
      data("stderr", "oops"),
      { type: "exit", code: 3 },
      { type: "saved", outcome: "unchanged" },
    ]);
    const error = await rejection(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["false"] },
        noRead,
        undefined,
      ),
    );
    expect(error).toBeInstanceOf(ExitError);
    expect(error).toMatchObject({ code: 3, stderr: "oops" });
    expect(closed()).toBe(1);
  });

  // Contract: a command ended by a signal is not a success, whatever code it
  // reports.
  it("rejects a command ended by a signal", async () => {
    const { connector } = fake([
      opened,
      { type: "exit", signal: "KILL" },
      { type: "saved", outcome: "unchanged" },
    ]);
    const error = await rejection(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["x"] },
        noRead,
        undefined,
      ),
    );
    expect(error).toBeInstanceOf(ExitError);
    expect(error).toMatchObject({ signal: "KILL" });
  });

  // Contract: changes that were not saved are an error even after exit 0, as a
  // read of the files would not show them. The platform's reason is a property
  // and never part of the message.
  it("rejects a failed save with CommandSaveError", async () => {
    const { connector } = fake([
      opened,
      exit0,
      { type: "saved", outcome: "failed", reason: "secret-detail" },
    ]);
    const error = await rejection(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        noRead,
        undefined,
      ),
    );
    expect(error).toBeInstanceOf(CommandSaveError);
    expect(error).toMatchObject({ reason: "secret-detail", exitCode: 0 });
    expect((error as Error).message).not.toContain("secret-detail");
  });

  // Contract: the session's error code decides; its message is never echoed,
  // and a code that is not a plain token stays out of the error's message.
  it("rejects an error frame with CommandSessionError", async () => {
    const { connector } = fake([
      { type: "error", code: "shell_not_found", message: "secret-detail" },
    ]);
    const error = await rejection(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        noRead,
        undefined,
      ),
    );
    expect(error).toBeInstanceOf(CommandSessionError);
    expect((error as CommandSessionError).code).toBe("shell_not_found");
    expect((error as Error).message).not.toContain("secret-detail");
    const odd = fake([{ type: "error", code: "Bad <code>" }]);
    const refused = await rejection(
      runCommand(
        odd.connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        noRead,
        undefined,
      ),
    );
    expect((refused as Error).message).toBe("command session failed");
  });

  // Contract: a connection that ended before the exit is never reported as
  // success.
  it("rejects a session that ended without an exit", async () => {
    const quiet = await rejection(
      runCommand(
        fake([opened]).connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        noRead,
        undefined,
      ),
    );
    expect(quiet).toMatchObject({ code: "no_exit" });
    const broken = await rejection(
      runCommand(
        fake([opened, { type: "broken" }]).connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        noRead,
        undefined,
      ),
    );
    expect(broken).toMatchObject({ code: "broken" });
  });

  // Contract: a stream holds at most 16 MiB; past that the session closes.
  it("bounds the output it keeps", async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    const { connector, closed } = fake(
      [...Array<number>(5)].map(() => ({ type: "stdout", data: chunk })),
    );
    const error = await rejection(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["yes"] },
        noRead,
        undefined,
      ),
    );
    expect(error).toMatchObject({ code: "output_too_large" });
    expect(closed()).toBe(1);
  });

  // Contract: with no save result on the stream, the session's recorded save
  // decides, read until it is final.
  it("reads the session's save when the stream reports none", async () => {
    const { connector, opens } = fake([opened, exit0]);
    const reads: string[] = [];
    const states = [
      {},
      { save: { state: "pending" } },
      { save: { state: "saved", version: 9 } },
    ];
    const result = await runCommand(
      connector,
      COMPUTER,
      { mode: "exec", command: ["true"] },
      (session) => {
        reads.push(session);
        return Promise.resolve({ status: states.shift() } as never);
      },
      undefined,
    );
    expect(reads).toEqual([SESSION, SESSION, SESSION]);
    expect(opens).toHaveLength(1);
    expect(result).toMatchObject({ save: "published", version: 9 });
  });

  // Contract: a Computer that does not save reports so, and is not an error.
  it("reports a Computer that does not save", async () => {
    const { connector } = fake([opened, exit0]);
    const result = await runCommand(
      connector,
      COMPUTER,
      { mode: "exec", command: ["true"] },
      () => Promise.resolve({ status: { save: { state: "off" } } } as never),
      undefined,
    );
    expect(result.save).toBe("off");
    expect(result).not.toHaveProperty("version");
  });

  it.each([true, false])(
    "uses the stream's off outcome when the handle has autoSave %s",
    async (autoSave) => {
      const network = new FakeNetwork((request) =>
        request.url.pathname.endsWith("/api-dev")
          ? json({
              computer: computerRecord({
                spec: { idleTimeout: "300s", autoSave },
              }),
            })
          : undefined,
      );
      const computer = await network.client().computers.get("api-dev");
      expect(computer.snapshot.autoSave).toBe(autoSave);
      const before = network.computerCalls();
      const { connector, opens, send } = fake(
        [opened, data("stdout", "done"), exit0],
        { stayOpen: true },
      );
      handleStateOf(computer).state.connections.adopt(connector);
      const result = computer.exec(["example"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      send({ type: "saved", outcome: "off" });
      await expect(result).resolves.toEqual({
        exitCode: 0,
        stdout: "done",
        stderr: "",
        save: "off",
      });
      expect(opens).toEqual([{ mode: "exec", command: ["example"] }]);
      expect(network.computerCalls()).toEqual(before);
    },
  );

  it("returns a queued save frame without a status read or stream closure", async () => {
    const { connector } = fake([opened, exit0, published], { stayOpen: true });
    const read = vi.fn(noRead);
    const result = await runCommand(
      connector,
      COMPUTER,
      { mode: "exec", command: ["true"] },
      read,
      undefined,
    );
    expect(result).toMatchObject({ save: "published", version: 7 });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns unconfirmed when the saved frame carries an unknown outcome", async () => {
    const { connector, closed } = fake([
      opened,
      exit0,
      { type: "saved", outcome: "pending" },
    ]);
    const read = vi.fn(noRead);
    const result = await runCommand(
      connector,
      COMPUTER,
      { mode: "exec", command: ["true"] },
      read,
      undefined,
    );
    expect(result.save).toBe("unconfirmed");
    expect(read).not.toHaveBeenCalled();
    expect(closed()).toBe(1);
  });

  it("preserves a nonzero exit and its output after transport loss", async () => {
    const { connector, opens, fail } = fake(
      [opened, data("stderr", "diagnostic"), { type: "exit", code: 3 }],
      { stayOpen: true },
    );
    const read = vi.fn(() =>
      Promise.resolve({ status: { save: { state: "off" } } } as never),
    );
    const failure = rejection(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["example"] },
        read,
        undefined,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fail(new TransportError("network_error", "connection lost"));
    const error = await failure;
    expect(error).toBeInstanceOf(ExitError);
    expect(error).toMatchObject({ code: 3, stderr: "diagnostic" });
    expect(opens).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(SESSION, expect.any(AbortSignal));
  });

  it("preserves a session error reported after exit", async () => {
    const { connector } = fake([
      opened,
      data("stdout", "done"),
      exit0,
      { type: "error", code: "invalid_request" },
    ]);
    const read = vi.fn(noRead);
    const error = await rejection(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        read,
        undefined,
      ),
    );
    expect(error).toBeInstanceOf(CommandSessionError);
    expect(error).toMatchObject({ code: "invalid_request", stdout: "done" });
    expect(read).not.toHaveBeenCalled();
  });

  it("propagates a malformed frame after exit without reading status", async () => {
    const { connector, fail } = fake([opened, exit0], { stayOpen: true });
    const read = vi.fn(noRead);
    const error = new FrameError("invalid frame");
    const failure = rejection(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        read,
        undefined,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fail(error);
    expect(await failure).toBe(error);
    expect(read).not.toHaveBeenCalled();
  });

  it("uses the stream alone for a delayed save and keeps all output preceding exit", async () => {
    vi.useFakeTimers();
    try {
      const { connector, send } = fake(
        [
          opened,
          data("stdout", "first"),
          data("stderr", "diagnostic"),
          data("stdout", " last"),
          exit0,
        ],
        { stayOpen: true },
      );
      const read = vi.fn(noRead);
      const result = runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        read,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(read).not.toHaveBeenCalled();
      send(published);
      await expect(result).resolves.toMatchObject({
        stdout: "first last",
        stderr: "diagnostic",
        save: "published",
        version: 7,
      });
      expect(read).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses only the remaining exit deadline if the stream breaks", async () => {
    vi.useFakeTimers();
    try {
      const { connector, send, closed } = fake([opened, exit0], {
        stayOpen: true,
      });
      let checking: AbortSignal | undefined;
      const read = vi.fn((_id: string, signal: AbortSignal | undefined) => {
        checking = signal;
        return new Promise<never>(() => undefined);
      });
      const result = runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        read,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(29_900);
      expect(read).not.toHaveBeenCalled();
      send({ type: "broken" });
      await vi.advanceTimersByTimeAsync(99);
      expect(read).toHaveBeenCalledTimes(1);
      expect(closed()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ save: "unconfirmed" });
      expect(checking?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an open stream without a session ID", async () => {
    vi.useFakeTimers();
    try {
      const { connector, closed } = fake([exit0], { stayOpen: true });
      const read = vi.fn(noRead);
      const result = runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        read,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toMatchObject({ save: "unconfirmed" });
      expect(read).not.toHaveBeenCalled();
      expect(closed()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates cancellation while waiting for the save frame", async () => {
    const { connector, closed } = fake([opened, exit0], { stayOpen: true });
    const controller = new AbortController();
    const read = vi.fn(noRead);
    const reason = new Error("stop");
    const failure = rejection(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        read,
        controller.signal,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(reason);
    expect(await failure).toBe(reason);
    expect(read).not.toHaveBeenCalled();
    expect(closed()).toBe(1);
  });

  it("aborts a recovery read with the caller's reason", async () => {
    const { connector, opens, closed } = fake([opened, exit0]);
    const controller = new AbortController();
    const reason = new Error("stop");
    let checking: AbortSignal | undefined;
    const read = vi.fn((_id: string, signal: AbortSignal | undefined) => {
      checking = signal;
      controller.abort(reason);
      return new Promise<never>(() => undefined);
    });
    await expect(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        read,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(checking?.aborted).toBe(true);
    expect(opens).toHaveLength(1);
    expect(closed()).toBe(1);
  });

  // Contract: a save that cannot be read is unconfirmed; the command's own
  // outcome stands.
  it("reports an unknown save as unconfirmed", async () => {
    const { connector } = fake([exit0]);
    const result = await runCommand(
      connector,
      COMPUTER,
      { mode: "exec", command: ["true"] },
      noRead,
      undefined,
    );
    expect(result.save).toBe("unconfirmed");
  });

  // Contract: a signal aborted before the call sends nothing.
  it("opens nothing when already aborted", async () => {
    const { connector, opens } = fake([opened, exit0, published]);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      runCommand(
        connector,
        COMPUTER,
        { mode: "exec", command: ["true"] },
        noRead,
        controller.signal,
      ),
    ).rejects.toThrow("stop");
    expect(opens).toEqual([]);
  });

  // Contract: an abort while the command runs closes its session and rejects
  // with the signal's reason.
  it("ends the command when aborted", async () => {
    const { connector, closed } = fake([opened], { stayOpen: true });
    const controller = new AbortController();
    const running = runCommand(
      connector,
      COMPUTER,
      { mode: "exec", command: ["sleep", "60"] },
      noRead,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort(new Error("stop"));
    await expect(running).rejects.toThrow("stop");
    expect(closed()).toBe(1);
  });

  // Contract: a session that opens only after the abort is still closed.
  it("closes a session that opens after an abort", async () => {
    const session = fake([], { stayOpen: true });
    let opening: (stream: ComputerSessionStream) => void = () => undefined;
    const stream = await session.connector.open(COMPUTER, {
      mode: "exec",
      command: ["x"],
    });
    const connector = {
      open: () =>
        new Promise<ComputerSessionStream>((resolve) => {
          opening = resolve;
        }),
    } as unknown as ComputerConnector;
    const controller = new AbortController();
    const running = runCommand(
      connector,
      COMPUTER,
      { mode: "exec", command: ["x"] },
      noRead,
      controller.signal,
    );
    controller.abort(new Error("stop"));
    await expect(running).rejects.toThrow("stop");
    opening(stream);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.closed()).toBe(1);
  });
});
