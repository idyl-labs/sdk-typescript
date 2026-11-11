// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { parseJson } from "../resource/json.js";
import type { Integer } from "../resource/json.js";
import { integer, explicitPointer } from "../internal/strictdecode.js";
import type { JournalEntryId } from "../resource/uuid-id.js";
import {
  always,
  decodeValue,
  object,
  omitEmpty,
  omitZero,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import type { ConditionReasonClass } from "../resource/condition.js";
import type { JsonObject } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";
import {
  parseComputerId,
  parseComputerSessionId,
  parseJournalEntryId,
  type ComputerId,
  type ComputerSessionId,
} from "../resource/uuid-id.js";
import { prefixed } from "../resource/validation.js";
import {
  computerCellSaveShape,
  validateComputerCellSave,
  type ComputerCellSave,
} from "./computer-cell-save.js";
import { validateComputerNotebookName } from "./computer-notebook-name.js";
import {
  computerSessionEndpointRequestShape,
  computerSessionEndpointShape,
  validateComputerSessionEndpoint,
  validateComputerSessionEndpointRequest,
} from "./computer-session-endpoint.js";
import type {
  ComputerSessionEndpoint,
  ComputerSessionEndpointRequest,
} from "./computer-session-endpoint.js";
import {
  shellRequestShape,
  validateShellExecutable,
  validateWorkloadSessionOperation,
  type WorkloadSessionAttachmentKind,
  type WorkloadSessionOperation,
  type WorkloadSessionShellRequest,
} from "./workload-session.js";

/** The most characters a Computer session `idempotencyKey` may hold. */
export const MAX_COMPUTER_SESSION_IDEMPOTENCY_KEY_BYTES = 64;

/**
 * How long a Computer session lives past its last successful renewal, or
 * past becoming ready before its first, in milliseconds: three minutes. A
 * session whose renewals stop ends about this long after the last one, with
 * reason `Expired`. See {@link ComputerSession}.
 */
export const COMPUTER_SESSION_LEASE_MS = 180_000;

/**
 * How often a client renews a session it keeps, in milliseconds: one
 * minute. Three renewals fall within one {@link COMPUTER_SESSION_LEASE_MS},
 * so a session outlives one or two renewals lost in transit.
 */
export const COMPUTER_SESSION_RENEW_INTERVAL_MS = 60_000;

/**
 * Creates one session in a Computer, run on the Computer's own session
 * endpoint. The create records the session's grant; the client opens the
 * session's stream on the endpoint, naming the create's `idempotencyKey` as
 * the stream's request ID, and the endpoint runs the session once its grant
 * is installed. A dormant Computer is woken to serve a session, except a
 * files stream, and the session counts toward the Computer's idle timeout
 * from its creation until it ends.
 *
 * Creating a session records it and answers at once with the
 * {@link ComputerSession}: `ready` when the Computer was awake or woke
 * quickly, and otherwise `pending` while the Computer wakes. Either answer
 * carries `status.endpoint` once the session is bound to the Activation
 * that will serve it, and the endpoint holds a stream until its grant is
 * installed, so a client opens the stream at once rather than waiting for
 * the session to be ready. No request is held open while the Computer
 * wakes.
 *
 * Every Computer session is operation `shell` with attachment `endpoint`,
 * and the route addresses the Computer, so there is no target or container
 * to name; any other operation or attachment is refused. `endpoint` states
 * the session's mode: an interactive `shell`, one command (`exec`), one
 * notebook `cell`, the resumption of a session whose stream was lost
 * (`reattach`), a read of a notebook's cell `records`, a listing of the
 * Computer's live `files`, or one SSH connection (`ssh`). A command, a
 * cell's script, and every byte of input travel only in the session's
 * stream, never in the request.
 *
 * An `ssh` session states no shell, no notebook and no session to resume;
 * its SSH connection's channels choose what runs. It cannot be reattached:
 * a reattach that names an `ssh` session is refused as an invalid request.
 *
 * ## Private sessions and notebooks
 *
 * A session that names no `notebook` is private: the platform keeps no
 * record of the command it runs, its input, its output, or its exit status.
 * Files the command changes persist through the Computer's saves.
 *
 * A cell and a records stream name a `notebook`, and no other mode does. A
 * cell is recorded as one cell of that notebook: its script, its output, its
 * exit status, and the file version saved after it. It runs with no
 * standard input and no terminal, so a notebook cell is always a single
 * command, never an interactive shell. A records stream reads the
 * notebook's cell records, their output included, from the Computer itself.
 * The notebook must exist in the Computer; a session naming one that does
 * not is refused with HTTP 404 and `ERROR_CODE_NOTEBOOK_NOT_FOUND`. A
 * notebook runs one cell at a time: a cell created while another cell of
 * the same notebook runs waits in phase `pending` with reason
 * `NotebookBusy` until that cell ends.
 *
 * Logs and Files sessions, the exec operation, and every attachment
 * other than `endpoint` are not offered for Computers; a platform refuses
 * them with {@link ERROR_CODE_OPERATION_UNSUPPORTED} and
 * {@link ERROR_CODE_ATTACHMENT_UNSUPPORTED}.
 *
 * ## Retrying a create
 *
 * `idempotencyKey` is required: it is the request ID the session's stream
 * names, and it makes the create safe to retry.
 *
 * Two requests are the same request when every field other than the key is
 * equal: the operation, the shell, the attachment, the endpoint arm, the
 * notebook, and the client, where a request that states no client is the
 * same as one that states `unknown`.
 *
 * A key deduplicates within a window that opens with the first request
 * carrying it. Within the window, the same request under the same key
 * returns the session the first request created, with the same ID, in
 * whatever phase it has reached, and the command is never run a second
 * time; a different request under the same key is refused with HTTP 409 and
 * {@link ERROR_CODE_IDEMPOTENCY_KEY_MISMATCH}. A session that failed or was
 * cancelled is returned as it ended, so a request that should run after one
 * uses a new key. The window closes ten minutes after the session ends,
 * fails, or is cancelled. A retry never extends it, and neither does a
 * renewal. Once it closes, the key is free: the same request creates a new
 * session.
 */
export interface CreateComputerSessionRequest {
  /** Process-start version floor; absent is unstated and zero explicitly requires genesis. */
  readonly atLeastVersion?: Integer;
  readonly operation: WorkloadSessionOperation;
  /**
   * The shell the session runs, an executable of the Computer's image. A
   * session that names none runs, in mode `shell`, the Computer's default
   * shell (`ComputerExecutionSettings.shell`), or, when that states none,
   * `/bin/bash` when the image holds it and `/bin/sh` otherwise; a command
   * runs with `/bin/sh -c`. An interactive session whose shell the image
   * does not hold ends before the shell starts: the endpoint answers its
   * stream with the error `shell_not_found`, and nothing is written to its
   * terminal. `undefined` names none, and none is written.
   */
  readonly shell?: WorkloadSessionShellRequest;
  /** Always `endpoint`. */
  readonly attachment: WorkloadSessionAttachmentKind;
  /**
   * The session's endpoint arm: the mode its grant admits and, for a
   * reattach, the session it resumes. The command never travels here; the
   * client sends it in the session stream.
   */
  readonly endpoint?: ComputerSessionEndpointRequest;
  /**
   * The notebook of the Computer that a cell records into or a records
   * stream reads, as {@link validateComputerNotebookName} describes.
   * `undefined` or empty makes the session private: nothing it runs is
   * recorded, and none is written.
   */
  readonly notebook?: string;
  /**
   * 1 to {@link MAX_COMPUTER_SESSION_IDEMPOTENCY_KEY_BYTES} ASCII letters,
   * digits, `.`, `_`, or `-`: the request ID the session's stream names.
   * Required; a served spec without one reads as empty, which
   * {@link validateCreateComputerSessionRequest} refuses.
   */
  readonly idempotencyKey?: string;
  /**
   * The kind of client sending the request. A notebook cell records it, as
   * `unknown` when it is absent; it is informative and never authorizes
   * anything. `undefined` or empty states no client, and none is written.
   */
  readonly client?: ComputerSessionClient;
}

/**
 * The kind of client that created a Computer session. It is informative:
 * the platform records what the request states and never authorizes or
 * routes on it.
 *
 * - `cli`: the `idyl` command-line client.
 * - `console`: the web console.
 * - `sdk`: a program through an IDYL SDK.
 * - `unknown`: a request that did not state its client.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateComputerSessionClient}
 * judges membership.
 */
export type ComputerSessionClient =
  "cli" | "console" | "sdk" | "unknown" | (string & Record<never, never>);

/**
 * Judges that the client is one this SDK names. The empty string is
 * reported as missing. Throws a `TypeError`.
 */
export function validateComputerSessionClient(
  client: ComputerSessionClient,
): void {
  switch (client) {
    case "cli":
    case "console":
    case "sdk":
    case "unknown":
      return;
    case "":
      throw new TypeError("computer session client is required");
    default:
      throw new TypeError(
        `unknown computer session client ${JSON.stringify(client)}`,
      );
  }
}

/**
 * Judges a client a request states, named `client` in a refusal: absent or
 * empty states none and passes, any other value must be one this SDK names.
 * Throws a `TypeError`.
 */
export function validateStatedClient(
  client: ComputerSessionClient | undefined,
): void {
  const stated = client ?? "";
  if (stated === "") return;
  prefixed("client", () => {
    validateComputerSessionClient(stated);
  });
}

/**
 * The wire shape of a create request: `operation` and `attachment` always
 * written, the shell and endpoint arms only when present, and `notebook`,
 * `idempotencyKey`, and `client` only when not empty.
 */
export const createComputerSessionRequestShape: Shape<CreateComputerSessionRequest> =
  object<CreateComputerSessionRequest>({
    atLeastVersion: explicitPointer(integer({ unsigned: false, bits: 64 })),
    operation: always(string<WorkloadSessionOperation>()),
    shell: pointer(shellRequestShape),
    attachment: always(string<WorkloadSessionAttachmentKind>()),
    endpoint: pointer(computerSessionEndpointRequestShape),
    notebook: omitEmpty(string()),
    idempotencyKey: omitEmpty(string()),
    client: omitEmpty(string<ComputerSessionClient>()),
  });

/**
 * Judges the one offered operation and attachment pair, `shell` with
 * `endpoint`, the endpoint arm, a notebook exactly for a cell or a records
 * stream, the idempotency key's presence and form, and, when one is
 * stated, a client this SDK names. A refusal of the key names the rule and
 * never repeats the key. Throws a `TypeError`.
 */
export function validateCreateComputerSessionRequest(
  request: CreateComputerSessionRequest,
): void {
  if (request.atLeastVersion !== undefined && request.atLeastVersion < 0)
    throw new TypeError("atLeastVersion must be non-negative");
  validateWorkloadSessionOperation(request.operation);
  if (request.operation !== "shell") {
    throw new TypeError(
      `operation ${JSON.stringify(request.operation)} is not offered for Computer sessions`,
    );
  }
  if (request.shell !== undefined) {
    validateShellExecutable(request.shell.executable);
  }
  if (request.attachment === "") {
    throw new TypeError("attachment is required");
  }
  if (request.attachment !== "endpoint") {
    throw new TypeError(
      `attachment ${JSON.stringify(request.attachment)} is not offered for Computer sessions`,
    );
  }
  validateEndpointAttachment(request);
}

/**
 * Judges a create of attachment `endpoint`: the endpoint arm, no shell for
 * an ssh session, a notebook exactly for a cell or a records stream, and
 * the idempotency key the session's stream names.
 */
function validateEndpointAttachment(
  request: CreateComputerSessionRequest,
): void {
  const endpoint = request.endpoint;
  if (endpoint === undefined) {
    throw new TypeError("an endpoint attachment requires the endpoint arm");
  }
  prefixed("endpoint", () => {
    validateComputerSessionEndpointRequest(endpoint);
  });
  if (endpoint.mode === "ssh" && request.shell !== undefined) {
    throw new TypeError(
      "an ssh session states no shell: its channels choose what runs",
    );
  }
  const notebookMode = endpoint.mode === "cell" || endpoint.mode === "records";
  const notebook = request.notebook ?? "";
  if (notebookMode !== (notebook !== "")) {
    throw new TypeError(
      "a cell or a records stream names its notebook, and only those do",
    );
  }
  if (notebook !== "") validateComputerNotebookName(notebook);
  if ((request.idempotencyKey ?? "") === "") {
    throw new TypeError(
      "an endpoint attachment requires the idempotency key its stream names",
    );
  }
  validateIdempotencyKey(request.idempotencyKey ?? "");
  validateStatedClient(request.client);
}

function validateIdempotencyKey(key: string): void {
  if (key === "") return;
  if (
    new TextEncoder().encode(key).byteLength >
    MAX_COMPUTER_SESSION_IDEMPOTENCY_KEY_BYTES
  ) {
    throw new TypeError(
      `idempotencyKey must not exceed ${String(MAX_COMPUTER_SESSION_IDEMPOTENCY_KEY_BYTES)} characters`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(key)) {
    throw new TypeError(
      "idempotencyKey must contain only ASCII letters, digits, '.', '_', or '-'",
    );
  }
}

/** Renders a create request as the document the route carries. */
export function encodeCreateComputerSessionRequest(
  request: CreateComputerSessionRequest,
): JsonObject {
  createComputerSessionRequestShape.unknownFields(request, "");
  const value = createComputerSessionRequestShape.encode(request);
  decodeValue(value, createComputerSessionRequestShape, "strict");
  return value as JsonObject;
}

/**
 * Where a Computer session is in its life. A session is created `pending`,
 * becomes `ready` once it can be attached, `attached` once its process has
 * started, and `ended` once that process is over. It may instead `fail`
 * before it is ready, or be `cancelled` before it is attached. `ended`,
 * `failed`, and `cancelled` are final;
 * {@link isComputerSessionPhaseTerminal} reports them.
 *
 * - `pending`: the platform has recorded the session and is preparing it:
 *   its Computer is waking, or capacity is being found for it. It counts
 *   against the session limits while it waits.
 * - `ready`: the session can be attached: its grant is installed on the
 *   endpoint its status carries.
 * - `attached`: the session's process has started. A session attaches once;
 *   a second attachment is refused with
 *   {@link ERROR_CODE_SESSION_ALREADY_ATTACHED}.
 * - `ended`: the session's process is over.
 * - `failed`: the session could not be made ready, and its reason says why.
 * - `cancelled`: the session was cancelled before it was attached: by its
 *   creator, when it states no reason, or by the platform with
 *   `ATTACH_TIMEOUT` when it was not attached in time.
 *
 * Every phase that is not final has a deadline the platform enforces, so a
 * session nobody attaches releases what it holds without the client's
 * help: a pending session that is not ready by
 * {@link ComputerSessionStatus.readyBy} fails with `WAKE_TIMEOUT`, a ready
 * session that is not attached by {@link ComputerSessionStatus.attachBy}
 * is cancelled with `ATTACH_TIMEOUT`, and an attached session that is not
 * renewed ends with `Expired` at {@link ComputerSessionStatus.expiresAt}.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateComputerSessionPhase} judges
 * membership, and a caller treats an unknown phase as one it cannot attach
 * in.
 */
export type ComputerSessionPhase =
  | "pending"
  | "ready"
  | "attached"
  | "ended"
  | "failed"
  | "cancelled"
  | (string & Record<never, never>);

/**
 * Judges that the phase is one this SDK names. The empty string is reported
 * as missing: a served session always carries a phase. Throws a
 * `TypeError`.
 */
export function validateComputerSessionPhase(
  phase: ComputerSessionPhase,
): void {
  switch (phase) {
    case "pending":
    case "ready":
    case "attached":
    case "ended":
    case "failed":
    case "cancelled":
      return;
    case "":
      throw new TypeError("computer session phase is required");
    default:
      throw new TypeError(
        `unknown computer session phase ${JSON.stringify(phase)}`,
      );
  }
}

/**
 * Whether the phase is final: `ended`, `failed`, or `cancelled`. It is false
 * for a phase this SDK does not name.
 */
export function isComputerSessionPhaseTerminal(
  phase: ComputerSessionPhase,
): boolean {
  return phase === "ended" || phase === "failed" || phase === "cancelled";
}

/**
 * Why a Computer session is in its phase, from a closed set of stable
 * codes a caller may branch on. A pending session carries the step it waits
 * on; a failed, cancelled, or ended session carries why it stopped. A
 * failure reason is spelled as the error code that refuses a create for the
 * same cause, so a client reads one code whether the platform refused the
 * session at once or failed it later.
 *
 * - `Waking`: a pending session whose Computer is starting.
 * - `WaitingForCapacity`: a pending session whose Computer waits for
 *   capacity in its Subnet to run on.
 * - `NotebookBusy`: a pending notebook session that waits for the cell
 *   before it in the same notebook to end.
 * - `PROFILE_FITS_NO_HOST`: a failed session whose Computer fits no host
 *   eligible to run it. The session fails as soon as that is
 *   known rather than waiting for its deadline.
 * - `WAKE_TIMEOUT`: a failed session whose Computer was not ready by
 *   {@link ComputerSessionStatus.readyBy}. A new session may succeed.
 * - `EXECUTION_NOT_ENABLED`: a failed session whose Computer's Namespace
 *   stopped having execution turned on in the Subnet while the session was
 *   pending.
 * - `OUT_OF_USAGE`: a failed session whose Computer's Account had used its
 *   month's allowance and its extra usage, as `ERROR_CODE_OUT_OF_USAGE`
 *   describes. A new session can succeed once the Account buys extra
 *   usage, upgrades, or starts its next period.
 * - `ISOLATION_CLASS_NOT_ADMITTED`: a failed session whose Computer runs in
 *   an isolation class its Subnet no longer admits, so the Computer could
 *   not start. Its files stay reachable and its settings writable. A new
 *   session can succeed once the Computer's isolation class is one the
 *   Subnet admits.
 * - `SIZE_NOT_IN_PLAN`: a failed session whose Computer runs at a size
 *   larger than its Account's plan includes, as
 *   `ERROR_CODE_SIZE_NOT_IN_PLAN` describes. A new session can succeed once
 *   the Computer is resized to a size the plan includes, or the plan is
 *   upgraded.
 * - `VCPU_LIMIT_REACHED`: a failed session whose wake would take the vCPU of
 *   its Account's awake Computers past what its plan allows at once, as
 *   `ERROR_CODE_VCPU_LIMIT_REACHED` describes. A new session can succeed once
 *   another Computer is asleep, or the plan is upgraded.
 * - `mode-unavailable`: a failed session whose mode the endpoint serving
 *   its Computer cannot serve. A pending or ready session fails with it
 *   before anything runs. A new session may succeed, as on the Computer's
 *   next Activation.
 * - `ATTACH_TIMEOUT`: a session the platform cancelled because it was not
 *   attached by {@link ComputerSessionStatus.attachBy}.
 * - `Exited`: an ended session whose process ended.
 * - `Expired`: an ended session that reached
 *   {@link ComputerSessionStatus.expiresAt}: its renewals stopped, or it
 *   reached the maximum duration a Subnet or Account policy sets. Its
 *   process was ended then. Idleness is never a reason: a session waiting
 *   for input is kept for as long as it is renewed.
 * - `Released`: an ended session whose Computer's execution was released
 *   or superseded while the session ran; its process was ended with it.
 * - `Revoked`: an ended session whose grant, the authorization it runs
 *   under, was revoked, or whose renewal was refused because its creator no
 *   longer holds the permission the session needs. Its process was ended at
 *   once.
 * - `PutToSleep`: an ended session whose Computer was put to sleep on
 *   request: its files were saved, then its process was ended and the
 *   Computer's execution released.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateComputerSessionReason}
 * judges membership, and {@link computerSessionReasonClass} says how to
 * read a reason without knowing it.
 */
export type ComputerSessionReason =
  | "Waking"
  | "WaitingForCapacity"
  | "NotebookBusy"
  | "WaitingForDisk"
  | "NoViewCapableNode"
  | "WaitingForVersion"
  | "PROFILE_FITS_NO_HOST"
  | "WAKE_TIMEOUT"
  | "EXECUTION_NOT_ENABLED"
  | "OUT_OF_USAGE"
  | "ISOLATION_CLASS_NOT_ADMITTED"
  | "SIZE_NOT_IN_PLAN"
  | "VCPU_LIMIT_REACHED"
  | "mode-unavailable"
  | "ATTACH_TIMEOUT"
  | "Exited"
  | "Expired"
  | "Released"
  | "Revoked"
  | "PutToSleep"
  | (string & Record<never, never>);

/**
 * Every reason and its class, in the classes conditions use, as one table
 * so the set and its classification cannot disagree. For a reason that
 * stopped a session, the class says what a new session would meet:
 * `transient` when a new session may succeed as things stand, `blocked`
 * when something has to change first, and `settled` when the session simply
 * ran its course.
 */
const REASON_CLASSES: ReadonlyMap<string, ConditionReasonClass> = new Map([
  ["Waking", "progressing"],
  ["WaitingForCapacity", "transient"],
  ["NotebookBusy", "progressing"],
  ["WaitingForDisk", "transient"],
  ["NoViewCapableNode", "transient"],
  ["WaitingForVersion", "progressing"],
  ["PROFILE_FITS_NO_HOST", "blocked"],
  ["WAKE_TIMEOUT", "transient"],
  ["EXECUTION_NOT_ENABLED", "blocked"],
  ["OUT_OF_USAGE", "blocked"],
  ["ISOLATION_CLASS_NOT_ADMITTED", "blocked"],
  ["SIZE_NOT_IN_PLAN", "blocked"],
  ["VCPU_LIMIT_REACHED", "blocked"],
  ["mode-unavailable", "transient"],
  ["ATTACH_TIMEOUT", "transient"],
  ["Exited", "settled"],
  ["Expired", "settled"],
  ["Released", "settled"],
  ["Revoked", "settled"],
  ["PutToSleep", "settled"],
]);

/** The closed set of Computer session reasons, in a stable order. */
export function allComputerSessionReasons(): readonly ComputerSessionReason[] {
  return [...REASON_CLASSES.keys()];
}

/**
 * How a caller should read the reason: `progressing` or `transient` while a
 * session waits, and, for a session that stopped, `transient`, `blocked`,
 * or `settled` as {@link ComputerSessionReason} describes. `undefined` for
 * a reason outside the closed set, which a caller must treat as something
 * it does not understand rather than as anything in particular.
 */
export function computerSessionReasonClass(
  reason: ComputerSessionReason,
): ConditionReasonClass | undefined {
  return REASON_CLASSES.get(reason);
}

/**
 * Judges that the reason is one this SDK names. The empty string is valid:
 * it is a session that states no reason. Throws a `TypeError`.
 */
export function validateComputerSessionReason(
  reason: ComputerSessionReason,
): void {
  if (reason === "" || REASON_CLASSES.has(reason)) return;
  throw new TypeError(
    `unknown computer session reason ${JSON.stringify(reason)}`,
  );
}

/**
 * Where a Computer session is, and where its grant is installed once it is
 * bound. Instants are RFC 3339 strings.
 */
export interface ComputerSessionStatus {
  /**
   * The notebook cell that records a notebook session; process and save
   * facts live there. A private session has none.
   */
  readonly cell?: JournalEntryId;
  /**
   * The save that covers the session's end: the files its command left
   * behind. It appears once the session ends and progresses to a final
   * state: `saved` with the version it published, `unchanged` when nothing
   * changed, `failed` with its reason, or `off` when the Computer does not
   * save automatically. `entry` names the Computer history entry that owns
   * a published version. A client waits for the save by reading the session
   * until the state is final. `undefined` until the session ends.
   */
  readonly save?: ComputerCellSave;
  /** Where the session is in its life. Always written. */
  readonly phase: ComputerSessionPhase;
  /**
   * Why the session is in its phase. A failed or ended session always
   * states one. A pending session states one when the platform names the
   * step it waits on. A session the platform cancelled states
   * `ATTACH_TIMEOUT`, and one its creator cancelled states none. A ready or
   * attached session states none. `undefined` states no reason.
   */
  readonly reason?: ComputerSessionReason;
  /**
   * The instant by which the session must be ready: its creation plus the
   * Subnet's wake timeout. A session still pending then fails with
   * `WAKE_TIMEOUT`. Always written.
   */
  readonly readyBy: string;
  /**
   * The instant by which a ready session must be attached. A session not
   * attached by then is cancelled with `ATTACH_TIMEOUT`. It is written from
   * the moment the session is ready; `undefined` while pending.
   */
  readonly attachBy?: string;
  /**
   * The session's current lease deadline: its last successful renewal, or
   * the moment it became ready before its first, plus
   * {@link COMPUTER_SESSION_LEASE_MS}, bounded by the maximum session
   * duration a Subnet or Account policy sets, when one does. Without such a
   * policy nothing else bounds it. Each renewal moves it forward. A session
   * not renewed by then ends with `Expired`. It is written from the moment
   * the session is ready; `undefined` while pending.
   */
  readonly expiresAt?: string;
  /**
   * Where the session's grant is installed. It is present from the moment
   * the session is bound to the Activation that will serve it, which can be
   * while the session is still pending: the Computer is placed and
   * running, and its endpoint may still be starting. Once present it
   * does not change. A client may connect to it at once; the endpoint holds
   * a session's stream until the session's grant is installed. `undefined`
   * for a pending session not yet bound, and for a session that failed
   * before it was bound.
   */
  readonly endpoint?: ComputerSessionEndpoint;
}

const computerSessionStatusShape: Shape<ComputerSessionStatus> =
  object<ComputerSessionStatus>({
    cell: omitEmpty(string<JournalEntryId>()),
    save: pointer(computerCellSaveShape),
    phase: always(string<ComputerSessionPhase>()),
    reason: omitEmpty(string<ComputerSessionReason>()),
    readyBy: always(timestampShape),
    attachBy: omitZero(timestampShape),
    expiresAt: omitZero(timestampShape),
    endpoint: pointer(computerSessionEndpointShape),
  });

/**
 * One session of a Computer as the platform records it, from its creation
 * until it is deleted. The Computer's API serves it: creating a session
 * returns it at once, already ready when the Computer was awake or woke
 * within the create's short wait and otherwise pending; a read returns it as
 * it now is; and a cancel ends it. `id` names it on those routes and is
 * fixed at creation. `computer` is the ID of the Computer the session
 * belongs to, whether it was created by the Computer's name or by its ID; a
 * Computer's ID never changes, so a client that reads, renews and cancels
 * the session through the by-ID session routes of `computer` keeps reaching
 * it when the Computer is renamed while the session runs. `spec` is the
 * request that created it, as {@link CreateComputerSessionRequest}
 * describes. `status` reports where it is.
 *
 * A session is readable only by the identity that created it. A final
 * session is deleted once the window of its idempotency key closes, and a
 * read of it then reports HTTP 404.
 *
 * A session is a lease its client keeps by renewing it every
 * {@link COMPUTER_SESSION_RENEW_INTERVAL_MS} from the moment it is ready.
 * Each renewal checks the caller's permission on the Computer again,
 * exactly as creating the session does, and moves `status.expiresAt` to
 * {@link COMPUTER_SESSION_LEASE_MS} from then. A session ends at the
 * earliest of:
 *
 * - its renewals stopping: it ends about {@link COMPUTER_SESSION_LEASE_MS}
 *   after the last one, with reason `Expired`;
 * - a refused renewal: it ends at once, with reason `Revoked`;
 * - its process ending, with reason `Exited`;
 * - the Computer's execution being released or superseded, with reason
 *   `Released`; and
 * - a maximum duration, only where a Subnet or Account policy sets one,
 *   with reason `Expired`.
 *
 * An idle session is not a lapse: a shell waiting for input is kept while
 * it is renewed. Renewing a session that is already final changes nothing
 * and is refused with HTTP 409 and {@link ERROR_CODE_SESSION_FINAL}.
 *
 * {@link decodeComputerSession} reads one leniently: a field, phase, or
 * reason newer than this SDK is carried rather than refused, the spec
 * included, and {@link validateComputerSession} judges the session against
 * this SDK's contract.
 */
export interface ComputerSession {
  readonly id: ComputerSessionId;
  readonly computer: ComputerId;
  readonly spec: CreateComputerSessionRequest;
  readonly status: ComputerSessionStatus;
}

const computerSessionShape: Shape<ComputerSession> = object<ComputerSession>({
  id: always(string<ComputerSessionId>()),
  computer: always(string<ComputerId>()),
  spec: always(createComputerSessionRequestShape),
  status: always(computerSessionStatusShape),
});

/**
 * Reads a Computer session the platform served, leniently. `document` is
 * JSON text or a value already parsed from JSON; a string is parsed once,
 * as a response is. Unknown fields, phases, and reasons are carried, not
 * refused, and the spec is read the same way, although the create route
 * binds a request under its exact schema.
 */
export function decodeComputerSession(document: unknown): ComputerSession {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, computerSessionShape, "lenient");
}

/**
 * Renders a Computer session as the document the platform emits: `id`,
 * `computer`, `spec`, and the status's `phase` and `readyBy` always written, and every
 * other status field only when present.
 */
export function encodeComputerSession(session: ComputerSession): JsonObject {
  return computerSessionShape.encode(session) as JsonObject;
}

/**
 * Judges the session against this SDK's contract: a canonical ID and
 * Computer, a valid spec, a phase and reason this SDK names, a ready
 * deadline, and the fields each phase carries. A failed or ended session
 * states a reason. A ready, attached, or ended session carries its attach
 * deadline, its expiry, and its endpoint; a pending session carries neither
 * deadline nor expiry, though it may carry its endpoint once it is bound.
 * Throws a `TypeError`.
 */
export function validateComputerSession(session: ComputerSession): void {
  parseComputerSessionId(session.id);
  prefixed("computer", () => {
    parseComputerId(session.computer);
  });
  prefixed("spec", () => {
    validateCreateComputerSessionRequest(session.spec);
  });
  validateStatus(session.status);
}

function validateStatus(status: ComputerSessionStatus): void {
  const cell = status.cell ?? "";
  if (cell !== "") parseJournalEntryId(cell);
  if (status.save !== undefined) validateComputerCellSave(status.save);
  validateComputerSessionPhase(status.phase);
  const reason = status.reason ?? "";
  validateComputerSessionReason(reason);
  if (isZeroInstant(status.readyBy)) {
    throw new TypeError("status.readyBy is required");
  }
  if (
    (status.phase === "failed" || status.phase === "ended") &&
    reason === ""
  ) {
    throw new TypeError(`status.reason is required in phase ${status.phase}`);
  }
  const hasAttachBy = !isZeroInstant(status.attachBy ?? "");
  const hasExpiresAt = !isZeroInstant(status.expiresAt ?? "");
  switch (status.phase) {
    case "pending":
      if (hasAttachBy || hasExpiresAt) {
        throw new TypeError(
          "status.attachBy and status.expiresAt must be absent in phase pending",
        );
      }
      break;
    case "ready":
    case "attached":
    case "ended":
      if (!hasAttachBy) {
        throw new TypeError(
          `status.attachBy is required in phase ${status.phase}`,
        );
      }
      if (!hasExpiresAt) {
        throw new TypeError(
          `status.expiresAt is required in phase ${status.phase}`,
        );
      }
      if (status.endpoint === undefined) {
        throw new TypeError(
          `status.endpoint is required in phase ${status.phase}`,
        );
      }
      break;
    default:
      break;
  }
  if (status.endpoint !== undefined) {
    validateComputerSessionEndpoint(status.endpoint);
  }
}

/** The instant the reference contract writes for a time it holds no value for. */
const ZERO_INSTANT_MS = Date.parse("0001-01-01T00:00:00Z");

/**
 * Whether an instant states no time: absent, or the zero instant the reference contract
 * writes for a time it holds no value for.
 */
export function isZeroInstant(instant: string): boolean {
  return instant === "" || Date.parse(instant) === ZERO_INSTANT_MS;
}

/**
 * Refuses a session because execution is not turned on for the Computer's
 * Namespace where the Computer lives. A session can be created once it is. A pending session that meets the same cause
 * fails with it as its reason.
 */
export const ERROR_CODE_EXECUTION_NOT_ENABLED = "EXECUTION_NOT_ENABLED";

/** Refuses a session in a Computer that is terminating. */
export const ERROR_CODE_COMPUTER_TERMINATING = "COMPUTER_TERMINATING";

/**
 * Names a session the capacity its Computer runs on can never serve,
 * because it fits no host eligible to provide it. The session
 * is refused, or failed with it as its reason, as soon as that is known,
 * rather than left waiting.
 */
export const ERROR_CODE_PROFILE_FITS_NO_HOST = "PROFILE_FITS_NO_HOST";

/**
 * Names a session whose Computer was not ready by the session's
 * {@link ComputerSessionStatus.readyBy}; the session fails with it as its
 * reason. A new session may succeed. Under the same idempotency key the
 * create returns the failed session until the key's window closes, so a
 * retry that should run uses a new key.
 */
export const ERROR_CODE_WAKE_TIMEOUT = "WAKE_TIMEOUT";

/**
 * Returned with HTTP 429 when a limit on concurrent sessions is reached. A
 * session can be created once one ends.
 */
export const ERROR_CODE_SESSION_BUDGET_EXCEEDED = "SESSION_BUDGET_EXCEEDED";

/**
 * Refuses an attachment Computer sessions do not offer: any attachment
 * other than `endpoint`.
 */
export const ERROR_CODE_ATTACHMENT_UNSUPPORTED = "ATTACHMENT_UNSUPPORTED";

/**
 * Refuses an operation Computer sessions do not offer, such as Logs and
 * Files.
 */
export const ERROR_CODE_OPERATION_UNSUPPORTED = "OPERATION_UNSUPPORTED";

/**
 * Returned with HTTP 409 when a request reuses an idempotency key within
 * its window with a different request. See
 * {@link CreateComputerSessionRequest}.
 */
export const ERROR_CODE_IDEMPOTENCY_KEY_MISMATCH = "IDEMPOTENCY_KEY_MISMATCH";

/**
 * Returned with HTTP 409 when a session that has already started its
 * process is attached again. A session runs its process once.
 */
export const ERROR_CODE_SESSION_ALREADY_ATTACHED = "SESSION_ALREADY_ATTACHED";

/**
 * Returned with HTTP 409 when a session that is already ended, failed, or
 * cancelled is renewed. The renewal changes nothing; a read of the session
 * reports its phase and reason.
 */
export const ERROR_CODE_SESSION_FINAL = "SESSION_FINAL";
