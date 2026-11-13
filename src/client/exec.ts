// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { ComputerSession } from "../api/computer-session.js";
import type {
  ComputerConnector,
  ComputerSessionStream,
  SessionOpen,
} from "../computer-connection/connector.js";
import {
  CommandSaveError,
  CommandSessionError,
  ExitError,
  type CommandOutput,
} from "../errors.js";
import { abortable, delay } from "../internal/abort.js";
import type { CallOptions } from "./common.js";
import { optionalNumber } from "./records.js";

/** The most output of one stream a command keeps, in bytes. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * How long a command that reported no save result waits for its session to
 * state one, in milliseconds. A read of the session is repeated until then.
 */
const SAVE_WAIT_MS = 30_000;
/** The interval between those reads, in milliseconds. */
const SAVE_POLL_MS = 250;

const NEVER_ABORTED = new AbortController().signal;

/** Runs a command. */
export interface ExecOptions extends CallOptions {
  /**
   * Ends the command when aborted: the session closes and the call rejects
   * with the signal's reason.
   */
  readonly signal?: AbortSignal;
}

/** What became of the files a command wrote. */
export type CommandSave =
  /** Its changes are saved, as the version `version`. */
  | "published"
  /** There was nothing to save. */
  | "unchanged"
  /** The Computer does not save automatically; nothing was saved. */
  | "off"
  /** The outcome could not be read. Its save remains the platform's to finish. */
  | "unconfirmed";

/** A command that ran to its end, with exit code 0, and whose save did not fail. */
export interface ExecResult extends CommandOutput {
  /** Always 0: any other exit rejects with {@link ExitError}. */
  readonly exitCode: 0;
  /** What became of the files the command wrote. */
  readonly save: CommandSave;
  /** The saved version its changes became, when `save` is `published`. */
  readonly version?: number;
}

/**
 * The argument list of a command: a string runs through `/bin/sh -c`, so its
 * pipes, quotes and variables work; a list runs its program as given. Throws a
 * `TypeError` for an empty string; the session open judges a list.
 */
export function commandOf(command: string | readonly string[]): string[] {
  if (typeof command === "string") {
    if (command.trim() === "") throw new TypeError("command is required");
    return ["/bin/sh", "-c", command];
  }
  if (!Array.isArray(command)) {
    throw new TypeError("command must be a string or a list of arguments");
  }
  return [...(command as readonly string[])];
}

/** One stream's output, held up to its bound. */
class Collected {
  readonly #decoder = new TextDecoder();
  #text = "";
  #bytes = 0;

  /** Adds `data`; returns whether the stream is still within its bound. */
  add(data: Uint8Array): boolean {
    this.#bytes += data.byteLength;
    if (this.#bytes > MAX_OUTPUT_BYTES) return false;
    this.#text += this.#decoder.decode(data, { stream: true });
    return true;
  }

  get text(): string {
    return this.#text + this.#decoder.decode();
  }
}

/** What is known of a session's save. */
interface SaveState {
  readonly outcome: string;
  readonly revision?: number;
  readonly reason?: string;
  /** The notebook cell the session recorded. */
  readonly cell?: string;
}

type SaveRead = (
  session: string,
  signal: AbortSignal | undefined,
) => Promise<ComputerSession>;

/**
 * Opens a session on `computer`. A session that opens only after `signal`
 * aborted is closed, since the caller has already left.
 */
export async function openSession(
  connector: ComputerConnector,
  computer: string,
  open: SessionOpen,
  signal: AbortSignal | undefined,
): Promise<ComputerSessionStream> {
  signal?.throwIfAborted();
  const opening = connector.open(computer, open);
  return await bounded(opening, signal).catch((error: unknown) => {
    opening.then(
      (late) => {
        late.close();
      },
      () => undefined,
    );
    throw error;
  });
}

/**
 * Runs `open`, a command or a notebook cell, on the Computer `computer` and
 * returns once it has ended and its changes are saved, so a read of the files
 * after it sees what it wrote. The session is closed however the call ends.
 */
export async function runCommand(
  connector: ComputerConnector,
  computer: string,
  open: SessionOpen,
  readSession: SaveRead,
  signal: AbortSignal | undefined,
): Promise<ExecResult> {
  const session = await openSession(connector, computer, open, signal);
  const stdout = new Collected();
  const stderr = new Collected();
  // The session's create may answer before it names the cell, so a read of
  // the session can be what names it.
  let cell: string | undefined;
  const output = (): CommandOutput => {
    const recorded = cell ?? session.cell;
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      ...(recorded === undefined ? {} : { cell: recorded }),
    };
  };
  const reader = session.output.getReader();
  let id = session.id;
  let exit: { readonly code?: number; readonly signal?: string } | undefined;
  let saved:
    | {
        readonly outcome: string;
        readonly revision?: number;
        readonly reason?: string;
      }
    | undefined;
  try {
    for (;;) {
      const { done, value: frame } = await bounded(reader.read(), signal);
      if (done) break;
      switch (frame.type) {
        case "opened":
          id = frame.session;
          break;
        case "stdout":
        case "stderr":
          if (!(frame.type === "stdout" ? stdout : stderr).add(frame.data)) {
            throw new CommandSessionError("output_too_large", output());
          }
          break;
        case "exit":
          exit = frame;
          break;
        case "saved":
          saved = frame;
          break;
        case "error":
          throw new CommandSessionError(frame.code, output());
        case "broken":
          if (exit === undefined) {
            throw new CommandSessionError("broken", output());
          }
          break;
        default:
          break;
      }
    }
    if (exit === undefined) {
      throw new CommandSessionError("no_exit", output());
    }
    const recordsCell = open.mode === "cell" && session.cell === undefined;
    const state: SaveState =
      saved === undefined || recordsCell
        ? await sessionSave(id, readSession, signal)
        : saved;
    cell = state.cell;
    if (state.outcome === "failed") {
      throw new CommandSaveError(state.reason, exit.code, output());
    }
    if (exit.code !== 0 || exit.signal !== undefined) {
      throw new ExitError(exit.code, exit.signal, output());
    }
    return Object.freeze({
      exitCode: 0,
      ...output(),
      save: saveOf(state.outcome),
      ...(state.revision === undefined ? {} : { version: state.revision }),
    });
  } finally {
    session.close();
    void reader.cancel().catch(() => undefined);
  }
}

function saveOf(outcome: string): CommandSave {
  return outcome === "published" || outcome === "unchanged" || outcome === "off"
    ? outcome
    : "unconfirmed";
}

/**
 * The save of a session that sent no save result, as the platform records it.
 * Reads that fail are repeated within the bound; a save that stays unknown is
 * `unconfirmed`, and the command's own outcome stands.
 */
async function sessionSave(
  session: string | undefined,
  read: SaveRead,
  signal: AbortSignal | undefined,
): Promise<SaveState> {
  if (session === undefined) return { outcome: "unconfirmed" };
  const deadline = Date.now() + SAVE_WAIT_MS;
  for (;;) {
    try {
      const { status } = await read(session, signal);
      const save = status.save;
      const cell = status.cell === undefined ? {} : { cell: status.cell };
      switch (save?.state) {
        case "saved": {
          const version = optionalNumber(save.version);
          return {
            outcome: "published",
            ...(version === undefined ? {} : { revision: version }),
            ...cell,
          };
        }
        case "unchanged":
        case "off":
          return { outcome: save.state, ...cell };
        case "failed":
          return {
            outcome: "failed",
            ...(save.reason === undefined ? {} : { reason: save.reason }),
            ...cell,
          };
        default:
          break;
      }
    } catch (error) {
      if (signal?.aborted === true) throw error;
    }
    if (Date.now() >= deadline) return { outcome: "unconfirmed" };
    await delay(SAVE_POLL_MS, signal ?? NEVER_ABORTED);
  }
}

async function bounded<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  return signal === undefined ? await work : await abortable(work, signal);
}
