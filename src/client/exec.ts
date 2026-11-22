// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { ComputerSession } from "../api/computer-session.js";
import type {
  ComputerConnector,
  ComputerSessionStream,
  SessionOpen,
  SessionOutput,
} from "../computer-connection/connector.js";
import {
  CommandSaveError,
  CommandSessionError,
  ExitError,
  type CommandOutput,
} from "../errors.js";
import { abortable, managedSignal } from "../internal/abort.js";
import { pollUntil, saveResultPauses, type WaitEvents } from "../wait.js";
import { connectorWaitEvents } from "../computer-connection/connector.js";
import { sessionChange } from "./changes.js";
import type { CallOptions } from "./common.js";
import { optionalNumber } from "./records.js";

/** The most output of one stream a command keeps, in bytes. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * The total time after process exit to confirm a save, in milliseconds.
 */
const SAVE_WAIT_MS = 30_000;

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
 * Runs the command `open` names on the Computer `computer` and
 * returns once it has ended and its changes are saved, so a read of the files
 * after it sees what it wrote. The session is closed however the call ends.
 */
export async function runCommand(
  connector: ComputerConnector,
  computer: string,
  open: SessionOpen,
  readSession: SaveRead,
  signal: AbortSignal | undefined,
  expectSaveFrame = true,
): Promise<ExecResult> {
  const session = await openSession(connector, computer, open, signal);
  const stdout = new Collected();
  const stderr = new Collected();
  const output = (): CommandOutput => ({
    stdout: stdout.text,
    stderr: stderr.text,
  });
  const reader = session.output.getReader();
  let id = session.id;
  let exit: { readonly code?: number; readonly signal?: string } | undefined;
  let saved: SaveState | undefined;
  try {
    while (exit === undefined) {
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
          // The endpoint sends all stdout and stderr before exit. Only its
          // save result can follow a successful process exit.
          exit = frame;
          break;
        case "saved":
          saved = frame;
          break;
        case "error":
          throw new CommandSessionError(frame.code, output());
        case "broken":
          throw new CommandSessionError("broken", output());
        default:
          break;
      }
    }
    if (exit === undefined) {
      throw new CommandSessionError("no_exit", output());
    }
    const state: SaveState =
      saved ??
      (await saveAfterExit(
        reader,
        connector,
        id,
        readSession,
        output,
        signal,
        expectSaveFrame,
      ));
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

/** The endpoint can keep its stream open after exit while the session already
 * records a final save outcome. Either source can confirm the result. */
async function saveAfterExit(
  reader: ReadableStreamDefaultReader<SessionOutput>,
  connector: ComputerConnector,
  id: string | undefined,
  read: SaveRead,
  output: () => CommandOutput,
  signal: AbortSignal | undefined,
  expectSaveFrame: boolean,
): Promise<SaveState> {
  signal?.throwIfAborted();
  const until = performance.now() + SAVE_WAIT_MS;
  const streamed = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value.type === "broken") return undefined;
      if (value.type === "saved") return value;
      if (value.type === "error")
        throw new CommandSessionError(value.code, output());
    }
  })();

  if (expectSaveFrame || id === undefined) {
    const wait = managedSignal(
      signal,
      SAVE_WAIT_MS,
      "command save wait expired",
    );
    try {
      const frame = await abortable(streamed, wait.signal);
      if (frame !== undefined) return frame;
    } catch (error) {
      signal?.throwIfAborted();
      if (!wait.signal.aborted) throw error;
      return { outcome: "unconfirmed" };
    } finally {
      wait.cleanup();
    }
  }

  // With saving disabled the endpoint can stay open without a save frame.
  // A read can start at once in that case. Otherwise only loss of the
  // stream brings us here, with the remainder of the same exit deadline.
  const remaining = until - performance.now();
  if (id === undefined || remaining <= 0) return { outcome: "unconfirmed" };
  const stop = new AbortController();
  const checking = signal
    ? AbortSignal.any([stop.signal, signal])
    : stop.signal;
  try {
    const recorded = sessionSave(
      id,
      read,
      checking,
      remaining,
      connectorWaitEvents(connector, undefined, sessionChange(id)),
    );
    return (await Promise.race([streamed, recorded])) ?? (await recorded);
  } finally {
    stop.abort();
  }
}

function saveOf(outcome: string): CommandSave {
  return outcome === "published" || outcome === "unchanged" || outcome === "off"
    ? outcome
    : "unconfirmed";
}

/**
 * The save of a session that sent no save result, as the platform records it.
 * The session is read until it states its save or {@link SAVE_WAIT_MS} has
 * passed, pausing by {@link saveResultPauses}; a read that fails is repeated
 * at the next pause. A save that stays unknown is `unconfirmed`, and the
 * command's own outcome stands.
 */
async function sessionSave(
  session: string,
  read: SaveRead,
  signal: AbortSignal,
  remaining: number,
  events: WaitEvents | undefined,
): Promise<SaveState> {
  let stated: SaveState | undefined;
  try {
    await pollUntil<true>(
      { timeoutMs: remaining, signal },
      {
        pauses: saveResultPauses(),
        ...(events === undefined ? {} : { events }),
        read: async (readSignal) => {
          try {
            readSignal.throwIfAborted();
            const result = await abortable(
              Promise.resolve().then(() => {
                readSignal.throwIfAborted();
                return read(session, readSignal);
              }),
              readSignal,
            );
            stated = statedSave(result.status.save);
          } catch (error) {
            if (readSignal.aborted) throw error;
          }
          return true;
        },
        met: () => stated !== undefined,
        timeoutMessage: () => "",
      },
    );
  } catch (error) {
    // Every read failure is repeated, so the wait ends early only when it
    // is cancelled or runs out of time.
    if (signal.aborted) throw error;
  }
  return stated ?? { outcome: "unconfirmed" };
}

/** The most recent save state the session reported. */
function statedSave(
  save: ComputerSession["status"]["save"],
): SaveState | undefined {
  switch (save?.state) {
    case "saved": {
      const version = optionalNumber(save.version);
      return {
        outcome: "published",
        ...(version === undefined ? {} : { revision: version }),
      };
    }
    case "unchanged":
    case "off":
      return { outcome: save.state };
    case "failed":
      return {
        outcome: "failed",
        ...(save.reason === undefined ? {} : { reason: save.reason }),
      };
    default:
      return undefined;
  }
}

async function bounded<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  return signal === undefined ? await work : await abortable(work, signal);
}
