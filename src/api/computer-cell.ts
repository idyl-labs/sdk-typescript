// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "../resource/json.js";
import {
  storageResourceReferenceFields,
  validateStorageResourceReference,
  type StorageResourceReference,
} from "../resource/storage.js";
import {
  validateComputerCellSave,
  computerCellSaveShape,
  type ComputerCellSave,
} from "./computer-cell-save.js";
import { validateComputerNotebookName } from "./computer-notebook-name.js";
import {
  always,
  array,
  boolean,
  fieldPath,
  integer,
  object,
  omitEmpty,
  omitZero,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { StrictDecodeError } from "../resource/decode-error.js";
import type { JsonObject, JsonValue } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";
import {
  parseJournalEntryId,
  parseComputerSessionId,
  type JournalEntryId,
  type ComputerSessionId,
} from "../resource/uuid-id.js";
import { prefixed } from "../resource/validation.js";
import {
  isZeroInstant,
  validateComputerSessionClient,
  type ComputerSessionClient,
} from "./computer-session.js";

/**
 * The most command bytes a Cell carries in a journal list: the bytes of an
 * exec command's arguments taken together. A listed command longer than
 * this is cut and marked truncated; reading the entry on its own returns
 * the whole command.
 */
export const MAX_COMPUTER_CELL_LISTED_COMMAND_BYTES = 4 << 10;

/**
 * How a Cell's session ran its process. It describes the session, and is
 * distinct from the kind of the journal entry that holds the Cell.
 *
 * - `exec`: a command run directly, with or without a terminal.
 *   Its command is the `exec` member.
 * - `endpoint-cell`: a notebook cell run over the Computer's own session
 *   endpoint. Its command travels end to end encrypted to the Computer,
 *   which alone records it, so the Cell's command carries no member.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateComputerCellMode} judges
 * membership.
 */
export type ComputerCellMode =
  "exec" | "endpoint-cell" | (string & Record<never, never>);

/**
 * Where a Cell is. A Cell is `running` from the moment its session is
 * permitted to start until its process is known to be over, and then
 * `ended`. A session that never ran its process is an `error` Cell from the
 * start, and a permitted session whose process failed to start becomes one.
 * `ended` and `error` are final.
 *
 * The union is open; {@link validateComputerCellState} judges membership.
 */
export type ComputerCellState =
  "running" | "ended" | "error" | (string & Record<never, never>);

/**
 * Why a Cell's session never ran its process.
 *
 * - `fits-no-host`: the Computer fits no host eligible to run it in its
 *   Subnet.
 * - `execution-not-enabled`: the Computer's Namespace stopped having
 *   execution turned on in the Subnet before the session started.
 * - `wake-timeout`: the Computer was not ready by the session's ready
 *   deadline.
 * - `out-of-usage`: the Computer's Account had used its month's allowance
 *   and its extra usage, as session reason `OUT_OF_USAGE` describes.
 * - `isolation-class-not-admitted`: the Computer runs in an isolation class
 *   its Subnet no longer admits, as session reason
 *   `ISOLATION_CLASS_NOT_ADMITTED` describes.
 * - `size-not-in-plan`: the Computer runs at a size larger than its
 *   Account's plan includes, as session reason `SIZE_NOT_IN_PLAN`
 *   describes.
 * - `vcpu-limit-reached`: the wake would take the vCPU of the Account's awake
 *   Computers past what its plan allows at once, as session reason
 *   `VCPU_LIMIT_REACHED` describes.
 * - `attach-timeout`: a ready session was not attached by its attach
 *   deadline.
 * - `cancelled`: the session was cancelled before it started.
 * - `revoked`: the session's authorization was revoked before it started,
 *   as when a newer execution of the Computer superseded the one it was
 *   granted on.
 * - `released`: the Computer's execution was released before the session
 *   started.
 * - `expired`: the session reached its expiry before it started.
 * - `ended`: the platform ended the session before it started.
 * - `start-failed`: the session was permitted to start but its process
 *   failed to start. The Cell keeps its place in the journal and its
 *   recording.
 * - `put-to-sleep`: the session's Computer was put to sleep on request
 *   before the session started.
 *
 * The union is open; {@link validateComputerCellErrorReason} judges
 * membership.
 */
export type ComputerCellErrorReason =
  | "fits-no-host"
  | "execution-not-enabled"
  | "wake-timeout"
  | "out-of-usage"
  | "isolation-class-not-admitted"
  | "size-not-in-plan"
  | "vcpu-limit-reached"
  | "attach-timeout"
  | "cancelled"
  | "revoked"
  | "released"
  | "expired"
  | "ended"
  | "start-failed"
  | "put-to-sleep"
  | (string & Record<never, never>);

/**
 * Whether the machine that ran a Cell's session recorded its facts.
 *
 * - `recorded`: the machine records the session: its start, its end, and its
 *   output byte counts arrive as the machine reports them.
 * - `not-recorded`: the session ran on a machine or path that does not record
 *   sessions. The Cell shows who ran what and when it was admitted; its
 *   process facts stay unknown.
 * - `lost`: the machine could not record the session, or its record never
 *   reached the platform before the Cell was closed.
 *
 * The union is open; {@link validateComputerCellRecording} judges
 * membership.
 */
export type ComputerCellRecording =
  "recorded" | "not-recorded" | "lost" | (string & Record<never, never>);

/**
 * How a Cell's process ended.
 *
 * - `exited`: the process exited on its own account; its exit code is
 *   reported when the machine observed it.
 * - `signaled`: the process was ended by a signal, which is reported when
 *   the machine observed it.
 * - `unknown`: the process's end was not observed. Nothing about it is
 *   invented.
 *
 * The union is open; {@link validateComputerCellProcessOutcome} judges
 * membership.
 */
export type ComputerCellProcessOutcome =
  | "exited"
  | "signaled"
  | "unknown"
  | "start-unknown"
  | (string & Record<never, never>);

/**
 * What ended a Cell's session, which is distinct from how its process
 * ended: a session ended at its deadline can still have a process that
 * exited with a code.
 *
 * - `exited`: the session ended because its process ended.
 * - `deadline`: the time the session was permitted to run lapsed.
 * - `client-disconnected`: the session's client disconnected.
 * - `runtime-error`: the runtime that ran the session failed.
 * - `node-restarted`: the IDYL software on the machine that ran the
 *   session restarted.
 * - `forked`: the Cell was copied into a fork of its Computer while it was
 *   still running; the copy is closed with this termination and an unknown
 *   outcome.
 * - `unknown`: the session's end was not reported: the platform closed the
 *   Cell when the session could no longer be running.
 * - `interrupted`: an explicit execution fence ended the work. An already
 *   observed process exit or signal remains unchanged.
 * - `put-to-sleep`: the session ended because its Computer was put to sleep
 *   on request. An already observed process exit or signal remains
 *   unchanged.
 *
 * The union is open; {@link validateComputerCellTermination} judges
 * membership.
 */
export type ComputerCellTermination =
  | "exited"
  | "deadline"
  | "client-disconnected"
  | "runtime-error"
  | "node-restarted"
  | "forked"
  | "unknown"
  | "interrupted"
  | "put-to-sleep"
  | (string & Record<never, never>);

/**
 * Retained output facts: none when no checkpoint is kept, empty for zero-byte
 * retained output, complete for the whole output, truncated for a retained
 * prefix and partial when its tail was not checkpointed. Availability at
 * read time is a distinct observation. Unknown tokens remain carried on read.
 */
export type ComputerCellOutputStored =
  | "none"
  | "empty"
  | "complete"
  | "truncated"
  | "partial"
  | (string & Record<never, never>);

/** A closed vocabulary's judgement: membership, the empty string reported as missing. */
function vocabulary(
  label: string,
  members: readonly string[],
): (value: string) => void {
  return (value) => {
    if (members.includes(value)) return;
    if (value === "") throw new TypeError(`${label} is required`);
    throw new TypeError(`unknown ${label} ${JSON.stringify(value)}`);
  };
}

/** Judges that the mode is one this SDK names. Throws a `TypeError`. */
export const validateComputerCellMode: (mode: ComputerCellMode) => void =
  vocabulary("computer cell mode", ["exec", "endpoint-cell"]);

/** Judges that the state is one this SDK names. Throws a `TypeError`. */
export const validateComputerCellState: (state: ComputerCellState) => void =
  vocabulary("computer cell state", ["running", "ended", "error"]);

/** Judges that the error reason is one this SDK names. Throws a `TypeError`. */
export const validateComputerCellErrorReason: (
  reason: ComputerCellErrorReason,
) => void = vocabulary("computer cell error reason", [
  "fits-no-host",
  "execution-not-enabled",
  "wake-timeout",
  "out-of-usage",
  "isolation-class-not-admitted",
  "size-not-in-plan",
  "vcpu-limit-reached",
  "attach-timeout",
  "cancelled",
  "revoked",
  "released",
  "expired",
  "ended",
  "start-failed",
  "put-to-sleep",
]);

/** Judges that the recording is one this SDK names. Throws a `TypeError`. */
export const validateComputerCellRecording: (
  recording: ComputerCellRecording,
) => void = vocabulary("computer cell recording", [
  "recorded",
  "not-recorded",
  "lost",
]);

/** Judges that the process outcome is one this SDK names. Throws a `TypeError`. */
export const validateComputerCellProcessOutcome: (
  outcome: ComputerCellProcessOutcome,
) => void = vocabulary("computer cell process outcome", [
  "exited",
  "signaled",
  "unknown",
  "start-unknown",
]);

/** Judges that the termination is one this SDK names. Throws a `TypeError`. */
export const validateComputerCellTermination: (
  termination: ComputerCellTermination,
) => void = vocabulary("computer cell termination", [
  "exited",
  "deadline",
  "client-disconnected",
  "runtime-error",
  "node-restarted",
  "forked",
  "unknown",
  "interrupted",
  "put-to-sleep",
]);

/** Judges that the output-stored value is one this SDK names. Throws a `TypeError`. */
export const validateComputerCellOutputStored: (
  stored: ComputerCellOutputStored,
) => void = vocabulary("computer cell output stored", [
  "none",
  "empty",
  "complete",
  "truncated",
  "partial",
]);

/** The command an exec session ran: the argument vector its request stated. */
export interface ComputerCellExecCommand {
  /** The command and its arguments. Always written. */
  readonly argv: readonly string[];
  /**
   * Whether `argv` is cut, as a journal list carries it: its leading
   * arguments, the last of them possibly shortened, holding at most
   * {@link MAX_COMPUTER_CELL_LISTED_COMMAND_BYTES} bytes together. Reading
   * the entry on its own returns the whole vector.
   */
  readonly truncated?: boolean;
}

/**
 * What a Cell's session ran. A Cell of mode `exec` carries its command in
 * `exec`; an endpoint cell carries no member, because the Computer alone
 * records its command.
 *
 * A read carries a member this SDK does not name rather than refusing it,
 * as a further property of the command, and encodes it again unchanged, so
 * a Cell read and written back loses nothing;
 * {@link computerCellCommandUnknownMembers} names such members, and
 * validation refuses a command carrying one.
 */
export interface ComputerCellCommand {
  readonly exec?: ComputerCellExecCommand;
}

const execCommandShape: Shape<ComputerCellExecCommand> =
  object<ComputerCellExecCommand>({
    argv: always(array(string())),
    truncated: omitEmpty(boolean()),
  });

/** The members this SDK names, in the order they are written. */
const COMMAND_MEMBERS: readonly [keyof ComputerCellCommand, Shape<unknown>][] =
  [["exec", execCommandShape as Shape<unknown>]];

/**
 * The names, in lexical order, of the members a read carried that this SDK
 * does not name. It is empty for a command this SDK can describe.
 */
export function computerCellCommandUnknownMembers(
  command: ComputerCellCommand,
): readonly string[] {
  const record = command as Readonly<Record<string, unknown>>;
  return Object.keys(record)
    .filter(
      (name) =>
        !COMMAND_MEMBERS.some(([known]) => known === name) &&
        record[name] !== undefined &&
        record[name] !== null,
    )
    .sort();
}

/**
 * A command is read as a reader of the journal routes reads it: the members
 * this SDK names are decoded, any other member is carried as it arrived, and
 * a member written as null is absent. It is written with the named members
 * first, then every carried member, unchanged.
 */
const commandShape: Shape<ComputerCellCommand> = {
  unknownFields: () => undefined,
  decode: (value, path, mode) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      if (mode === "lenient") return value as ComputerCellCommand;
      throw new StrictDecodeError({
        reason: "wrong_type",
        path,
        message: `${path}: expected an object`,
      });
    }
    const members = value as Readonly<Record<string, unknown>>;
    const decoded: Record<string, unknown> = {};
    for (const name of Object.keys(members)) {
      const raw = members[name];
      if (raw === null || raw === undefined) continue;
      const known = COMMAND_MEMBERS.find(([member]) => member === name);
      decoded[name] =
        known === undefined
          ? raw
          : known[1].decode(raw, fieldPath(path, name), mode);
    }
    return decoded;
  },
  encode: (command) => {
    const record = command as Readonly<Record<string, unknown>>;
    const encoded: Record<string, JsonValue> = {};
    for (const [name, shape] of COMMAND_MEMBERS) {
      const member = record[name];
      if (member !== undefined) encoded[name] = shape.encode(member);
    }
    for (const name of computerCellCommandUnknownMembers(command)) {
      encoded[name] = record[name] as JsonValue;
    }
    return encoded;
  },
  zero: () => ({}),
  isZero: (command) => Object.keys(command).length === 0,
  isEmpty: () => false,
};

/** Why a Cell's session never ran its process. */
export interface ComputerCellError {
  /** The cause, from a closed set a caller may branch on. Always written. */
  readonly reason: ComputerCellErrorReason;
}

/** How a Cell's process ended, as the machine observed it. */
export interface ComputerCellProcess {
  /** How the process ended. Always written. */
  readonly outcome: ComputerCellProcessOutcome;
  /**
   * The process's exit code, reported only with outcome `exited` and only
   * when the machine observed it; zero is a reading.
   */
  readonly exitCode?: Integer;
  /**
   * The signal that ended the process, as the machine reports it; reported
   * only with outcome `signaled` and only when the machine observed it.
   */
  readonly signal?: string;
}

/**
 * How much output a Cell's session wrote and what of it the platform keeps.
 * The counts are of the bytes the process wrote, before any framing; a
 * session with a terminal writes one stream, counted as standard output.
 */
export interface ComputerCellOutput {
  /** Bytes written to standard output; zero is a reading, `undefined` until reported. */
  readonly stdoutBytes?: Integer;
  /** Bytes written to standard error; zero is a reading, `undefined` until reported. */
  readonly stderrBytes?: Integer;
  /** What of the output is kept. Always written. */
  readonly stored: ComputerCellOutputStored;
}

/**
 * One recorded command in a Computer: who ran what, from which client, how
 * it ran, when it started and ended, how it ended, and how much output it
 * wrote. A notebook records the commands of the sessions that name it. Every
 * notebook session is one Cell, whatever the client, including one that
 * never ran its process, which is an error Cell holding its command and the
 * reason. A private session, one that names no notebook, is never a Cell.
 *
 * Anyone who may read the Computer may read the Cells of its journal,
 * whoever created them; a notebook's Cells are read through the notebook.
 * The material a session attaches with is never part of a Cell. Standard
 * input and keystrokes are never recorded.
 *
 * The process facts are reported by the machine that ran the session, are
 * filled in as they arrive, and never change once known. An unknown fact is
 * absent, never invented. Instants are RFC 3339 strings.
 *
 * A read decodes leniently: a field, a token, or a command member newer
 * than this SDK is carried rather than refused, and
 * {@link validateComputerCell} judges the Cell against this SDK's
 * contract.
 */
export interface ComputerCell extends StorageResourceReference {
  /** Applied version observed at process start; absent is unreported and zero is genesis. */
  readonly ranAt?: Integer;
  /** Reported save progress or a retained outcome. */
  readonly save?: ComputerCellSave;
  /** The ID of the journal entry that holds the Cell. */
  readonly id: JournalEntryId;
  /** The user Computer session, absent on copies. Historical origin metadata may retain its identity without a live session binding. */
  readonly session?: ComputerSessionId;
  /**
   * The notebook the Cell belongs to. `undefined` on a Cell of the
   * Computer's own history.
   */
  readonly notebook?: string;
  /** The admitting identity: the creator of the session. */
  readonly creator: string;
  /** The kind of client the session's request stated, or `unknown`; informative. */
  readonly client: ComputerSessionClient;
  /** How the session ran its process; it selects the member of `command` that carries it. */
  readonly mode: ComputerCellMode;
  /** Whether the session ran its process with a terminal. Always written. */
  readonly terminal: boolean;
  /** What the session ran. */
  readonly command: ComputerCellCommand;
  /** Where the Cell is. */
  readonly state: ComputerCellState;
  /** Why the session never ran its process; present exactly in state `error`. */
  readonly error?: ComputerCellError;
  /**
   * Whether the machine recorded the session; present on every Cell whose
   * session was permitted to start, and absent on an error Cell whose
   * session never was.
   */
  readonly recording?: ComputerCellRecording;
  /** When the session's process started, as the machine observed it; `undefined` until reported. */
  readonly startedAt?: string;
  /** When the session's process ended or failed to start, as the machine observed it; `undefined` until reported. */
  readonly endedAt?: string;
  /** How the session's process ended; `undefined` until known. */
  readonly process?: ComputerCellProcess;
  /** What ended the session; `undefined` until known. */
  readonly termination?: ComputerCellTermination;
  /** How much output the session wrote, and what of it is kept. */
  readonly output: ComputerCellOutput;
}

/** The wire shape of a Cell. */
export const computerCellShape: Shape<ComputerCell> = object<ComputerCell>({
  id: always(string<JournalEntryId>()),
  session: omitEmpty(string<ComputerSessionId>()),
  notebook: omitEmpty(string()),
  ...storageResourceReferenceFields,
  ranAt: pointer(integer({ unsigned: false, bits: 64 })),
  save: pointer(computerCellSaveShape),
  creator: always(string()),
  client: always(string<ComputerSessionClient>()),
  mode: always(string<ComputerCellMode>()),
  terminal: always(boolean()),
  command: always(commandShape),
  state: always(string<ComputerCellState>()),
  error: pointer(
    object<ComputerCellError>({
      reason: always(string<ComputerCellErrorReason>()),
    }),
  ),
  recording: omitEmpty(string<ComputerCellRecording>()),
  startedAt: omitZero(timestampShape),
  endedAt: omitZero(timestampShape),
  process: pointer(
    object<ComputerCellProcess>({
      outcome: always(string<ComputerCellProcessOutcome>()),
      exitCode: pointer(integer({ unsigned: false, bits: 64 })),
      signal: omitEmpty(string()),
    }),
  ),
  termination: omitEmpty(string<ComputerCellTermination>()),
  output: always(
    object<ComputerCellOutput>({
      stdoutBytes: pointer(integer({ unsigned: false, bits: 64 })),
      stderrBytes: pointer(integer({ unsigned: false, bits: 64 })),
      stored: always(string<ComputerCellOutputStored>()),
    }),
  ),
});

/** Renders a Cell as the document the platform emits. */
export function encodeComputerCell(cell: ComputerCell): JsonObject {
  return computerCellShape.encode(cell) as JsonObject;
}

/**
 * Judges the command against this SDK's contract: no member this SDK does
 * not name, and an `exec` member that follows its own rules. Throws a
 * `TypeError`.
 */
export function validateComputerCellCommand(
  command: ComputerCellCommand,
): void {
  const unknown = computerCellCommandUnknownMembers(command);
  if (unknown.length > 0) {
    throw new TypeError(
      `command member ${JSON.stringify(unknown[0])} is not one this version names`,
    );
  }
  if (command.exec === undefined) {
    throw new TypeError("command.exec is required");
  }
  validateExecCommand(command.exec);
}

function validateExecCommand(command: ComputerCellExecCommand): void {
  if (command.argv.length === 0) {
    throw new TypeError("command.exec.argv is required");
  }
  if (command.truncated !== true) return;
  const encoder = new TextEncoder();
  const total = command.argv.reduce(
    (sum, argument) => sum + encoder.encode(argument).byteLength,
    0,
  );
  if (total > MAX_COMPUTER_CELL_LISTED_COMMAND_BYTES) {
    throw new TypeError(
      `command.exec.argv must not exceed ${String(MAX_COMPUTER_CELL_LISTED_COMMAND_BYTES)} bytes when truncated`,
    );
  }
}

/**
 * Judges the Cell against this SDK's contract: canonical IDs, a creator, a
 * client, mode, state, and command this SDK names, an `exec` command on an
 * exec Cell and none on an endpoint cell, an error exactly on an error
 * Cell, a recording on every Cell that is not an error Cell, no end on a
 * running Cell, and process, termination, and output facts this SDK names.
 * Throws a `TypeError`.
 */
export function validateComputerCell(cell: ComputerCell): void {
  if (cell.ranAt !== undefined && cell.ranAt < 0)
    throw new TypeError("ranAt must be non-negative");
  const notebook = cell.notebook ?? "";
  if (notebook !== "") validateComputerNotebookName(notebook);
  if (cell.save !== undefined) validateComputerCellSave(cell.save);
  parseJournalEntryId(cell.id);
  const session = cell.session ?? "";
  if (session !== "") {
    prefixed("session", () => {
      parseComputerSessionId(session);
    });
  }
  prefixed("owner", () => {
    validateStorageResourceReference(cell);
  });
  if (cell.creator === "") throw new TypeError("creator is required");
  validateComputerSessionClient(cell.client);
  validateComputerCellMode(cell.mode);
  validateModeCommand(cell);
  validateComputerCellState(cell.state);
  validateState(cell);
  const startedAt = cell.startedAt ?? "";
  const endedAt = cell.endedAt ?? "";
  if (
    !isZeroInstant(startedAt) &&
    !isZeroInstant(endedAt) &&
    Date.parse(endedAt) < Date.parse(startedAt)
  ) {
    throw new TypeError("endedAt must not be before startedAt");
  }
  if (cell.process !== undefined) validateProcess(cell.process);
  const termination = cell.termination ?? "";
  if (termination !== "") validateComputerCellTermination(termination);
  validateOutput(cell.output);
}

/**
 * Judges the command against a mode already accepted: an endpoint cell
 * carries no member, and an exec Cell carries a valid `exec`.
 */
function validateModeCommand(cell: ComputerCell): void {
  if (cell.mode === "endpoint-cell") {
    if (
      COMMAND_MEMBERS.some(([name]) => cell.command[name] !== undefined) ||
      computerCellCommandUnknownMembers(cell.command).length > 0
    ) {
      throw new TypeError(
        "an endpoint cell carries no command: the Computer alone records it",
      );
    }
    return;
  }
  validateComputerCellCommand(cell.command);
}

function validateState(cell: ComputerCell): void {
  if (cell.state === "error") {
    if (cell.error === undefined) {
      throw new TypeError("error is required in state error");
    }
    const reason = cell.error.reason;
    prefixed("error.reason", () => {
      validateComputerCellErrorReason(reason);
    });
  } else if (cell.error !== undefined) {
    throw new TypeError(`error must be absent in state ${cell.state}`);
  }
  const recording = cell.recording ?? "";
  if (recording === "") {
    if (cell.state !== "error") {
      throw new TypeError(`recording is required in state ${cell.state}`);
    }
  } else {
    validateComputerCellRecording(recording);
  }
  if (
    cell.state === "running" &&
    (!isZeroInstant(cell.endedAt ?? "") ||
      cell.process !== undefined ||
      (cell.termination ?? "") !== "")
  ) {
    throw new TypeError(
      "endedAt, process, and termination must be absent in state running",
    );
  }
}

function validateProcess(process: ComputerCellProcess): void {
  prefixed("process.outcome", () => {
    validateComputerCellProcessOutcome(process.outcome);
  });
  if (process.exitCode !== undefined && process.outcome !== "exited") {
    throw new TypeError(
      `process.exitCode must be absent with outcome ${process.outcome}`,
    );
  }
  if ((process.signal ?? "") !== "" && process.outcome !== "signaled") {
    throw new TypeError(
      `process.signal must be absent with outcome ${process.outcome}`,
    );
  }
}

function validateOutput(output: ComputerCellOutput): void {
  if (output.stdoutBytes !== undefined && output.stdoutBytes < 0) {
    throw new TypeError("output.stdoutBytes must be non-negative");
  }
  if (output.stderrBytes !== undefined && output.stderrBytes < 0) {
    throw new TypeError("output.stderrBytes must be non-negative");
  }
  prefixed("output.stored", () => {
    validateComputerCellOutputStored(output.stored);
  });
}
