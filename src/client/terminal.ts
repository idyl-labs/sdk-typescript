// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type {
  ComputerSessionStream,
  SessionOutput,
} from "../computer-connection/connector.js";
import type { TerminalSize } from "../computer-connection/frames.js";
import type { CallOptions } from "./common.js";
import type { ConnectionHold } from "./connections.js";
import { openSession } from "./exec.js";

/** The size a terminal opens at when its options state none. */
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };
/** The terminal type a terminal opens with when its options state none. */
const DEFAULT_TERM = "xterm-256color";

/** Opens a terminal. */
export interface TerminalOptions extends CallOptions {
  /** Its size, 1 to 10000 cells each way; 80 by 24 when absent. */
  readonly size?: TerminalSize;
  /** Its terminal type; `xterm-256color` when absent. */
  readonly term?: string;
  /**
   * The shell to run, an absolute path in the image; the Computer's default
   * shell when absent.
   */
  readonly shell?: string;
}

/**
 * Opens a terminal on `computer`, holding the connection `hold` gave until the
 * terminal has ended or is closed.
 */
export async function openTerminal(
  hold: ConnectionHold,
  computer: string,
  options: TerminalOptions,
): Promise<ComputerSessionStream> {
  let session: ComputerSessionStream;
  try {
    session = await openSession(
      hold.connector,
      computer,
      {
        mode: "shell",
        tty: true,
        size: options.size ?? DEFAULT_SIZE,
        term: options.term ?? DEFAULT_TERM,
        ...(options.shell === undefined ? {} : { shell: options.shell }),
      },
      options.signal,
    );
  } catch (error) {
    hold.release();
    throw error;
  }
  const reader = session.output.getReader();
  const end = (): void => {
    session.close();
    hold.release();
  };
  const output = new ReadableStream<SessionOutput>(
    {
      async pull(controller) {
        const { done, value } = await reader.read().catch((error: unknown) => {
          end();
          throw error;
        });
        if (done) {
          end();
          controller.close();
          return;
        }
        controller.enqueue(value);
        // A shell that exited has nothing more to say, and its stream may stay
        // open until it is closed.
        if (value.type === "exit") {
          end();
          controller.close();
          void reader.cancel().catch(() => undefined);
        }
      },
      async cancel(reason) {
        end();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return Object.freeze({
    requestId: session.requestId,
    output,
    get id() {
      return session.id;
    },
    get cell() {
      return session.cell;
    },
    write: (data: Uint8Array) => {
      session.write(data);
    },
    resize: (size: TerminalSize) => {
      session.resize(size);
    },
    closeInput: () => {
      session.closeInput();
    },
    close: end,
  });
}
