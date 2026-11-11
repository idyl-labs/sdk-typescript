// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// A terminal in a browser page, end-to-end encrypted between the page and
// the Computer. `terminal` is an xterm.js `Terminal`, or anything with the
// same members. `connector` is the page's one `ComputerConnector`, built
// with `idyl.computers.connector` when the page loads, its `ready()`
// already called, so opening the terminal does only the terminal's own
// work.
import type { Computer, ComputerConnector } from "@idyl-sh/sdk";

/** The members of xterm.js's `Terminal` this example uses. */
export interface TerminalLike {
  readonly cols: number;
  readonly rows: number;
  write(data: Uint8Array): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: { cols: number; rows: number }) => void): {
    dispose(): void;
  };
}

/**
 * Connects `terminal` to a shell on `computer` until the shell exits, and
 * resolves with its exit code.
 */
export async function connect(
  terminal: TerminalLike,
  connector: ComputerConnector,
  computer: Computer,
): Promise<number | undefined> {
  const session = await connector.open(computer.id, {
    mode: "shell",
    tty: true,
    term: "xterm-256color",
    size: { cols: terminal.cols, rows: terminal.rows },
  });
  const encoder = new TextEncoder();
  const input = terminal.onData((data) => {
    session.write(encoder.encode(data));
  });
  const resize = terminal.onResize((size) => {
    session.resize(size);
  });
  const reader = session.output.getReader();
  let exitCode: number | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return exitCode;
      if (value.type === "stdout" || value.type === "stderr") {
        terminal.write(value.data);
      } else if (value.type === "exit") {
        exitCode = value.code;
      }
    }
  } finally {
    reader.releaseLock();
    input.dispose();
    resize.dispose();
    session.close();
  }
}
