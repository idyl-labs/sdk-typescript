// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * A Computer is awake while its execution runs and asleep while only its
 * saved files remain. It wakes by itself when a session needs it and sleeps
 * by itself after its idle timeout. A wake (ComputerWake) and a sleep
 * (ComputerSleep) do the same on request. Each is an operation resource:
 * creating one records it and answers at once, pending or already finished,
 * and the caller reads it until it is finished. No request is held open
 * while a Computer wakes or sleeps; the platform owns every deadline.
 *
 * Both need computer:update on the Namespace that owns the Computer. A wake
 * and a sleep of one Computer take effect in the order they were created:
 * each waits for the earlier pending operations of the other kind to finish.
 */
import {
  validateStatedClient,
  type ComputerSessionClient,
} from "./computer-session.js";
import {
  type Shape,
  always,
  boolean,
  decodeValue,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
} from "../internal/strictdecode.js";
import { parseJson, type Integer, type JsonObject } from "../resource/json.js";
import type { ComputerOperationId } from "../resource/uuid-id.js";

/**
 * Asks for a Computer to be woken. `idempotencyKey` makes an equal retry
 * return the same wake.
 */
export interface CreateComputerWakeRequest {
  readonly idempotencyKey?: string;
  /**
   * The kind of client sending the request. The journal entry it makes
   * records it, as `unknown` when it is absent; it is informative and never
   * authorizes anything.
   */
  readonly client?: ComputerSessionClient;
}

/**
 * A request to wake a Computer: start its execution with no session open.
 * A wake of an asleep Computer is `pending` until its execution has started
 * and is then `awake`; a wake of an awake Computer is `awake` at once.
 * Either way the Computer then stays awake for its idle timeout, counted
 * from the wake, and goes to sleep as it does after its last session.
 *
 * A `failed` wake carries `reason`, spelled as the error code that fails a
 * session for the same cause: `WAKE_TIMEOUT`, `PROFILE_FITS_NO_HOST`,
 * `INSUFFICIENT_CAPACITY`, `INSUFFICIENT_DISK`, `EXECUTION_NOT_ENABLED`,
 * `IMAGE_NOT_IN_CATALOG`, `NETWORK_CLASS_NOT_ADMITTED`,
 * `ISOLATION_CLASS_NOT_ADMITTED`, `VERSION_DAMAGED`, `OUT_OF_USAGE`,
 * `SIZE_NOT_IN_PLAN` or `VCPU_LIMIT_REACHED`. A pending or
 * awake wake carries no reason.
 *
 * A pending wake that cannot be placed yet, for a cause that can clear with no
 * change by the caller, carries `waitingFor`. It is spelled as the `reason`
 * the wake fails with if the cause holds until its deadline:
 * `INSUFFICIENT_CAPACITY` when no machine has room, `INSUFFICIENT_DISK` when
 * none has the disk, or `PROFILE_FITS_NO_HOST` when none can run it. The wake
 * keeps trying until then. `waitingFor` is absent once the Computer has a
 * place, and on an awake or failed wake.
 *
 * A wake that found the Computer asleep is recorded in its journal as a
 * `wake` entry.
 */
export interface ComputerWake {
  readonly id: ComputerOperationId;
  readonly state: ComputerWakeState;
  readonly reason?: string;
  readonly waitingFor?: string;
}

/**
 * Asks for a Computer to be put to sleep. `idempotencyKey` makes an equal
 * retry return the same sleep.
 */
export interface CreateComputerSleepRequest {
  readonly idempotencyKey?: string;
  /**
   * The kind of client sending the request. The journal entry it makes
   * records it, as `unknown` when it is absent; it is informative and never
   * authorizes anything.
   */
  readonly client?: ComputerSessionClient;
  /**
   * Puts the Computer to sleep without saving it: every change made since
   * its last saved version is discarded, and the sleep records no version.
   * Asked while a sleep of the Computer is pending, it ends that sleep's wait
   * for a save that has not published, such as one that keeps failing, and
   * the Computer goes to sleep with its unsaved changes discarded. The
   * journal's `sleep` entry records the discard (`JournalEntrySleep`).
   * `false` or absent saves the Computer first.
   */
  readonly discardUnsavedChanges?: boolean;
  /**
   * Puts the Computer to sleep as a machine that loses its power: its
   * programs are not ended or shut down before the save, the save holds what
   * they had written to the Computer's files when it was taken, and they are
   * then stopped without a shutdown. What a program synchronized to its
   * files before the save was taken is kept; what it held only in memory is
   * not. It is for a Computer whose programs or shutdown do not finish. The
   * journal's `sleep` entry records it (`JournalEntrySleep.forced`). `false`
   * or absent ends the Computer's programs before the save. It is never set
   * with `discardUnsavedChanges`.
   */
  readonly force?: boolean;
}

/**
 * A request to put a Computer to sleep. A sleep of an awake Computer first
 * saves its files, as an explicit save does, unless its `autoSave` is false
 * or the request asked to discard unsaved changes
 * (`CreateComputerSleepRequest.discardUnsavedChanges`): its unsaved changes
 * are then discarded and the sleep records no version. A save that fails is
 * asked for again until one publishes, and the Computer stays awake with its
 * changes meanwhile; IDYL never discards them because saving failed. It then
 * ends every open session and running notebook cell, then releases its
 * execution as its idle timeout does: background processes stop. An ended session reads the
 * reason `PutToSleep`; a notebook cell reads the error reason or the
 * termination `put-to-sleep`. While a sleep is pending, a new session waits
 * for it and then wakes the Computer again.
 *
 * `version` is the version the sleep's save recorded, present once the save
 * is known, version zero included. A sleep of an asleep Computer is
 * `asleep` at once, with no version and no save, as is a sleep of one whose
 * `autoSave` is false.
 *
 * A `failed` sleep carries `reason`: {@link COMPUTER_SLEEP_REASON_SAVE_FAILED}
 * when the save failed, in which case the Computer stays awake and its
 * sessions continue, or {@link COMPUTER_SLEEP_REASON_TIMEOUT} when the
 * Computer could not be released in time, in which case it stays awake and
 * goes to sleep after its idle timeout.
 *
 * A `pending` sleep whose last save was refused at a storage limit carries
 * `waitingFor`, spelled as that save's reason: `account-storage-limit`,
 * `computer-size` or `name-limit` (`SAVE_REASON_ACCOUNT_STORAGE_LIMIT`,
 * `SAVE_REASON_COMPUTER_SIZE`, `SAVE_REASON_NAME_LIMIT`). The Computer stays
 * awake with its unsaved files, and the sleep asks for a save again, after a
 * back-off, until one is saved. Two answers end the wait, each one call: deleting files, through the
 * files API or on the Computer, so that the next save passes; or a sleep with
 * `CreateComputerSleepRequest.discardUnsavedChanges`, which discards the
 * unsaved changes and puts the Computer to sleep at its last saved version.
 * `waitingFor` is absent once a save is saved, before any save failed, after a
 * save that failed for another reason, and on an asleep or failed sleep.
 *
 * A sleep that released the Computer is recorded in its journal as a
 * `sleep` entry.
 */
export interface ComputerSleep {
  readonly id: ComputerOperationId;
  readonly state: ComputerSleepState;
  readonly version?: Integer;
  readonly reason?: string;
  readonly waitingFor?: string;
}

/**
 * A sleep whose save of the Computer's files failed. Nothing was ended and
 * the Computer stays awake.
 */
export const COMPUTER_SLEEP_REASON_SAVE_FAILED = "SAVE_FAILED";

/**
 * A sleep whose Computer could not be released before the sleep's
 * deadline, as when saves at the end of its sessions kept failing.
 */
export const COMPUTER_SLEEP_REASON_TIMEOUT = "SLEEP_TIMEOUT";

/**
 * Where a wake is: `pending` until the Computer has started, then `awake`,
 * or `failed` when it could not be started. `pending` is the only state
 * that changes. Reads also carry newer tokens.
 */
export type ComputerWakeState =
  "pending" | "awake" | "failed" | (string & Record<never, never>);

/** Judges computer wake state membership without making decoding strict. */
export function validateComputerWakeState(value: ComputerWakeState): void {
  if (["pending", "awake", "failed"].includes(value)) return;
  if (value === "") throw new TypeError("computer wake state is required");
  throw new TypeError(`unknown computer wake state ${JSON.stringify(value)}`);
}

/**
 * Where a sleep is: `pending` while it saves, ends sessions or releases the
 * Computer, then `asleep`, or `failed` when it left the Computer awake.
 * `pending` is the only state that changes. Reads also carry newer tokens.
 */
export type ComputerSleepState =
  "pending" | "asleep" | "failed" | (string & Record<never, never>);

/** Judges computer sleep state membership without making decoding strict. */
export function validateComputerSleepState(value: ComputerSleepState): void {
  if (["pending", "asleep", "failed"].includes(value)) return;
  if (value === "") throw new TypeError("computer sleep state is required");
  throw new TypeError(`unknown computer sleep state ${JSON.stringify(value)}`);
}

/** The canonical wire fields of CreateComputerWakeRequest. */
export const createComputerWakeRequestFields = {
  idempotencyKey: omitEmpty(string()),
  client: omitEmpty(string<ComputerSessionClient>()),
};
/** The canonical wire shape of CreateComputerWakeRequest. */
export const createComputerWakeRequestShape: Shape<CreateComputerWakeRequest> =
  object<CreateComputerWakeRequest>(createComputerWakeRequestFields);

/** Checks that a stated client is one this SDK names. */
export function validateCreateComputerWakeRequest(
  request: CreateComputerWakeRequest,
): void {
  validateStatedClient(request.client);
}

/** The canonical wire fields of ComputerWake. */
export const computerWakeFields = {
  id: always(string<ComputerOperationId>()),
  state: always(string<ComputerWakeState>()),
  reason: omitEmpty(string()),
  waitingFor: omitEmpty(string()),
};
/** The canonical wire shape of ComputerWake. */
export const computerWakeShape: Shape<ComputerWake> =
  object<ComputerWake>(computerWakeFields);

/** The canonical wire fields of CreateComputerSleepRequest. */
export const createComputerSleepRequestFields = {
  idempotencyKey: omitEmpty(string()),
  client: omitEmpty(string<ComputerSessionClient>()),
  discardUnsavedChanges: omitEmpty(boolean()),
  force: omitEmpty(boolean()),
};
/** The canonical wire shape of CreateComputerSleepRequest. */
export const createComputerSleepRequestShape: Shape<CreateComputerSleepRequest> =
  object<CreateComputerSleepRequest>(createComputerSleepRequestFields);

/**
 * Checks that a stated client is one this SDK names, and that a sleep does
 * not both discard and force.
 */
export function validateCreateComputerSleepRequest(
  request: CreateComputerSleepRequest,
): void {
  validateStatedClient(request.client);
  if (request.force === true && request.discardUnsavedChanges === true) {
    throw new TypeError("force and discardUnsavedChanges cannot both be set");
  }
}

/** The canonical wire fields of ComputerSleep. */
export const computerSleepFields = {
  id: always(string<ComputerOperationId>()),
  state: always(string<ComputerSleepState>()),
  version: pointer(integer({ unsigned: false, bits: 64 })),
  reason: omitEmpty(string()),
  waitingFor: omitEmpty(string()),
};
/** The canonical wire shape of ComputerSleep. */
export const computerSleepShape: Shape<ComputerSleep> =
  object<ComputerSleep>(computerSleepFields);

/** Reads a served ComputerWake leniently, carrying unknown fields and tokens. */
export function decodeComputerWake(document: unknown): ComputerWake {
  return decodeValue(
    typeof document === "string" ? parseJson(document) : document,
    computerWakeShape,
    "lenient",
  );
}
/** Renders ComputerWake with the public wire omission rules. */
export function encodeComputerWake(value: ComputerWake): JsonObject {
  return computerWakeShape.encode(value) as JsonObject;
}

/** Reads a served ComputerSleep leniently, carrying unknown fields and tokens. */
export function decodeComputerSleep(document: unknown): ComputerSleep {
  return decodeValue(
    typeof document === "string" ? parseJson(document) : document,
    computerSleepShape,
    "lenient",
  );
}
/** Renders ComputerSleep with the public wire omission rules, version zero included. */
export function encodeComputerSleep(value: ComputerSleep): JsonObject {
  return computerSleepShape.encode(value) as JsonObject;
}
