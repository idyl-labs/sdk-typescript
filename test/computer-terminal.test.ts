// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { openTerminal } from "../src/client/terminal.js";
import type {
  ComputerConnector,
  ComputerSessionStream,
  SessionOpen,
  SessionOutput,
} from "../src/index.js";

const COMPUTER = "01954e20-7540-7ec4-93ec-14f783e6ab04";

/** A connector whose one session sends `frames`, ending unless `stayOpen`. */
function fake(frames: readonly SessionOutput[], stayOpen = false) {
  const opens: SessionOpen[] = [];
  const writes: Uint8Array[] = [];
  const close = vi.fn();
  const stream: ComputerSessionStream = {
    requestId: "request",
    id: "session",
    cell: undefined,
    output: new ReadableStream<SessionOutput>({
      start(controller) {
        for (const frame of frames) controller.enqueue(frame);
        if (!stayOpen) controller.close();
      },
    }),
    write: (data) => {
      writes.push(data);
    },
    resize: () => undefined,
    closeInput: () => undefined,
    close,
  };
  const connector = {
    open: (_computer: string, open: SessionOpen) => {
      opens.push(open);
      return Promise.resolve(stream);
    },
  } as unknown as ComputerConnector;
  const release = vi.fn();
  return { hold: { connector, release }, opens, writes, close, release };
}

describe("openTerminal", () => {
  // Contract: a terminal opens a shell on a terminal of a usable size with
  // nothing stated, and what is stated reaches the open.
  it("opens a shell with defaults and stated options", async () => {
    const first = fake([]);
    await openTerminal(first.hold, COMPUTER, {});
    expect(first.opens).toEqual([
      {
        mode: "shell",
        tty: true,
        size: { cols: 80, rows: 24 },
        term: "xterm-256color",
      },
    ]);
    const second = fake([]);
    await openTerminal(second.hold, COMPUTER, {
      size: { cols: 120, rows: 40 },
      term: "vt100",
      shell: "/usr/bin/zsh",
    });
    expect(second.opens).toEqual([
      {
        mode: "shell",
        tty: true,
        size: { cols: 120, rows: 40 },
        term: "vt100",
        shell: "/usr/bin/zsh",
      },
    ]);
  });

  // Contract: the connection stays held while the terminal runs, and is let
  // go, with the session closed, when its output ends.
  it("releases the connection when the output ends", async () => {
    const { hold, close, release } = fake([{ type: "opened", session: "s" }]);
    const terminal = await openTerminal(hold, COMPUTER, {});
    expect(release).not.toHaveBeenCalled();
    const reader = terminal.output.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect((await reader.read()).done).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  // Contract: a shell's exit ends the output, even when its stream stays open,
  // so reading a terminal to its end never hangs.
  it("ends the output at the shell's exit", async () => {
    const { hold, close, release } = fake([{ type: "exit", code: 5 }], true);
    const terminal = await openTerminal(hold, COMPUTER, {});
    const reader = terminal.output.getReader();
    expect((await reader.read()).value).toEqual({ type: "exit", code: 5 });
    expect((await reader.read()).done).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  // Contract: closing a terminal, or cancelling its output, lets the
  // connection go without the output being read.
  it("releases the connection when closed or cancelled", async () => {
    const closed = fake([], true);
    (await openTerminal(closed.hold, COMPUTER, {})).close();
    expect(closed.close).toHaveBeenCalled();
    expect(closed.release).toHaveBeenCalled();
    const cancelled = fake([], true);
    const terminal = await openTerminal(cancelled.hold, COMPUTER, {});
    await terminal.output.cancel();
    expect(cancelled.close).toHaveBeenCalled();
    expect(cancelled.release).toHaveBeenCalled();
  });

  // Contract: input reaches the session, and an open that fails holds nothing.
  it("forwards input and releases a failed open", async () => {
    const { hold, writes } = fake([], true);
    const terminal = await openTerminal(hold, COMPUTER, {});
    terminal.write(Uint8Array.of(1));
    expect(writes).toEqual([Uint8Array.of(1)]);
    const release = vi.fn();
    const refused = {
      release,
      connector: {
        open: () => Promise.reject(new Error("refused")),
      } as unknown as ComputerConnector,
    };
    await expect(openTerminal(refused, COMPUTER, {})).rejects.toThrow(
      "refused",
    );
    expect(release).toHaveBeenCalled();
  });
});
