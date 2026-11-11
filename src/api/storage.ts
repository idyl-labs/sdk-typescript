// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  validateStatedClient,
  type ComputerSessionClient,
} from "./computer-session.js";
import { integerEqual } from "../internal/strictdecode.js";
import { parseJson } from "../resource/json.js";
import type { Integer } from "../resource/json.js";
import {
  parseJournalEntryId,
  parseStorageOperationId,
} from "../resource/uuid-id.js";
import { validateForkState, validateVersionOrigin } from "./storage-enums.js";
import {
  type Shape,
  always,
  decodeValue,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
} from "../internal/strictdecode.js";
import { type JsonObject } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";
import {
  type JournalEntryId,
  type StorageOperationId,
} from "../resource/uuid-id.js";
import {
  type CommitState,
  type ForkState,
  type RestoreState,
  type VersionOrigin,
} from "./storage-enums.js";

/**
 * StorageUsage distinguishes the enforced on-disk measure, summed logical file
 * lengths and stored object bytes. Every count, including zero, is written.
 *
 * `names` is how many files, folders and links the newest saved version holds,
 * counted as the name limit of the Computer's size counts them
 * (`ComputerSizeInfo.names`). A save that adds names past that limit is refused
 * with `SAVE_REASON_NAME_LIMIT`. It is absent when no save has counted it yet;
 * the next save counts it.
 */
export interface StorageUsage {
  readonly referencedBytes: Integer;
  readonly logicalBytes: Integer;
  readonly storedBytes: Integer;
  readonly names?: Integer;
}

/** StorageStatus carries fork copying progress only when one was reported. */
export interface StorageStatus {
  readonly fork?: ForkProgress;
}

/** ForkProgress reports copying independently of historical ForkOf provenance. */
export interface ForkProgress {
  readonly state: ForkState;
  readonly copied: Integer;
  readonly total: Integer;
}

/** PageOptions selects a continuation page. Limit zero takes the route's default, and Continue is opaque and passed back verbatim. These options do not expose offset, filter or sort on routes that do not serve them. */
export interface PageOptions {
  readonly limit?: Integer;
  readonly continue?: string;
}

/** Version is a saved state owned by one journal entry. Number zero is genesis; numbers are never reused. Names are optional and unique within the resource. */
export interface Version {
  readonly number: Integer;
  readonly name?: string;
  readonly createdAt: string;
  readonly origin: VersionOrigin;
  /**
   * The immutable journal entry that owns this saved version. `undefined`
   * or empty means the owner was not reported. It conveys no execution
   * authority.
   */
  readonly entry?: JournalEntryId;
  readonly operation?: StorageOperationId;
  readonly parent?: Integer;
  readonly logicalBytes: Integer;
}

/** UpdateVersionRequest sets a unique name; an empty name removes it. */
export interface UpdateVersionRequest {
  readonly name: string;
}

/** CreateCommitRequest gives an optional retry identity to one explicit save. */
export interface CreateCommitRequest {
  readonly idempotencyKey?: string;
  /**
   * The kind of client sending the request. The journal entry it makes
   * records it, as `unknown` when it is absent; it is informative and never
   * authorizes anything.
   */
  readonly client?: ComputerSessionClient;
}

/*
 * The reasons a save or an upload fails for size. Each is the `reason` of a
 * failed `Commit` or a failed `Upload`, and a save refused for one of them
 * leaves the Computer awake with its unsaved files. A `pending` sleep whose
 * save is refused for one carries it as `ComputerSleep.waitingFor` and asks
 * for a save again. Freeing files, or a sleep that discards unsaved changes,
 * lets the Computer sleep.
 */

/**
 * A save or an upload that would take the data the Account stores past its
 * plan's limit (`BillingPlanOffer.storedData`). Saved history counts toward
 * it, and the total is measured hourly. A save that does not grow the
 * Computer's files is never refused with it, so an Account past its limit
 * can still delete files and save.
 */
export const SAVE_REASON_ACCOUNT_STORAGE_LIMIT = "account-storage-limit";

/**
 * A save or an upload that would take the Computer's files more than 64 MiB
 * past its disk (`ComputerSizeInfo.disk`). The 64 MiB is room the Computer's
 * own bookkeeping can use once its disk is full, so a Computer that fills its
 * disk while nobody is there still saves and sleeps.
 */
export const SAVE_REASON_COMPUTER_SIZE = "computer-size";

/**
 * A save or an upload that adds names past the most files, folders and links
 * the Computer's size holds (`ComputerSizeInfo.names`).
 */
export const SAVE_REASON_NAME_LIMIT = "name-limit";

/** Whether `reason` is one of the reasons a save or an upload fails for size. */
export function isSaveSizeReason(reason: string | undefined): reason is string {
  return (
    reason === SAVE_REASON_ACCOUNT_STORAGE_LIMIT ||
    reason === SAVE_REASON_COMPUTER_SIZE ||
    reason === SAVE_REASON_NAME_LIMIT
  );
}

/** Commit reports a saved, unchanged or failed result. Version zero is retained with a pointer; pending work carries neither a final version nor a reason. */
export interface Commit {
  readonly id: StorageOperationId;
  readonly state: CommitState;
  readonly version?: Integer;
  readonly reason?: string;
}

/**
 * Restores a saved version, selected by `from` as a version number or
 * name. History only moves forward: the restore appends a `restore` entry
 * to the journal, owning a new version that holds the selected version's
 * files, and every entry before it is kept. A restore is undone by
 * restoring the version before it.
 *
 * On a Computer the restore also sets the execution settings to those in
 * force at the selected version's entry. They apply at the Computer's next
 * start, as every settings change does, and the restore entry's
 * `executionSettings` records them. Sessions running on the Computer
 * continue: the restored files reach the running machine as a published
 * upload does, replacing unsaved changes to the same paths.
 *
 * `idempotencyKey` makes an equal retry return the same restore.
 */
export interface CreateRestoreRequest {
  readonly from: string;
  readonly idempotencyKey?: string;
  /**
   * The kind of client sending the request. The journal entry it makes
   * records it, as `unknown` when it is absent; it is informative and never
   * authorizes anything.
   */
  readonly client?: ComputerSessionClient;
}

/**
 * A restore's publication: `pending` until the new version is published,
 * then `published` with `version`, or `failed` with `reason`. Publication
 * is independent of the files' later delivery to a running machine and of
 * the restored execution settings, which apply at the Computer's next
 * start.
 */
export interface Restore {
  readonly id: StorageOperationId;
  readonly state: RestoreState;
  readonly version?: Integer;
  readonly reason?: string;
}

/** The canonical wire fields of StorageUsage. */
export const storageUsageFields = {
  referencedBytes: always(integer({ unsigned: true, bits: 64 })),
  logicalBytes: always(integer({ unsigned: true, bits: 64 })),
  storedBytes: always(integer({ unsigned: true, bits: 64 })),
  names: pointer(integer({ unsigned: true, bits: 64 })),
};
/** The canonical wire shape of StorageUsage. */
export const storageUsageShape: Shape<StorageUsage> =
  object<StorageUsage>(storageUsageFields);

/** The canonical wire fields of ForkProgress. */
export const forkProgressFields = {
  state: always(string<ForkState>()),
  copied: always(integer({ unsigned: true, bits: 64 })),
  total: always(integer({ unsigned: true, bits: 64 })),
};
/** The canonical wire shape of ForkProgress. */
export const forkProgressShape: Shape<ForkProgress> =
  object<ForkProgress>(forkProgressFields);

/** The canonical wire fields of PageOptions. */
export const pageOptionsFields = {
  limit: omitEmpty(integer({ unsigned: true, bits: 64 })),
  continue: omitEmpty(string()),
};
/** The canonical wire shape of PageOptions. */
export const pageOptionsShape: Shape<PageOptions> =
  object<PageOptions>(pageOptionsFields);

/** The canonical wire fields of Version. */
export const versionFields = {
  number: always(integer({ unsigned: false, bits: 64 })),
  name: omitEmpty(string()),
  createdAt: always(timestampShape),
  origin: always(string<VersionOrigin>()),
  entry: omitEmpty(string<JournalEntryId>()),
  operation: omitEmpty(string<StorageOperationId>()),
  parent: pointer(integer({ unsigned: false, bits: 64 })),
  logicalBytes: always(integer({ unsigned: false, bits: 64 })),
};
/** The canonical wire shape of Version. */
export const versionShape: Shape<Version> = object<Version>(versionFields);

/** The canonical wire fields of UpdateVersionRequest. */
export const updateVersionRequestFields = {
  name: always(string()),
};
/** The canonical wire shape of UpdateVersionRequest. */
export const updateVersionRequestShape: Shape<UpdateVersionRequest> =
  object<UpdateVersionRequest>(updateVersionRequestFields);

/** The canonical wire fields of CreateCommitRequest. */
export const createCommitRequestFields = {
  idempotencyKey: omitEmpty(string()),
  client: omitEmpty(string<ComputerSessionClient>()),
};
/** The canonical wire shape of CreateCommitRequest. */
export const createCommitRequestShape: Shape<CreateCommitRequest> =
  object<CreateCommitRequest>(createCommitRequestFields);

/** The canonical wire fields of Commit. */
export const commitFields = {
  id: always(string<StorageOperationId>()),
  state: always(string<CommitState>()),
  version: pointer(integer({ unsigned: false, bits: 64 })),
  reason: omitEmpty(string()),
};
/** The canonical wire shape of Commit. */
export const commitShape: Shape<Commit> = object<Commit>(commitFields);

/** The canonical wire fields of CreateRestoreRequest. */
export const createRestoreRequestFields = {
  from: always(string()),
  idempotencyKey: omitEmpty(string()),
  client: omitEmpty(string<ComputerSessionClient>()),
};
/** The canonical wire shape of CreateRestoreRequest. */
export const createRestoreRequestShape: Shape<CreateRestoreRequest> =
  object<CreateRestoreRequest>(createRestoreRequestFields);

/** The canonical wire fields of Restore. */
export const restoreFields = {
  id: always(string<StorageOperationId>()),
  state: always(string<RestoreState>()),
  version: pointer(integer({ unsigned: false, bits: 64 })),
  reason: omitEmpty(string()),
};
/** The canonical wire shape of Restore. */
export const restoreShape: Shape<Restore> = object<Restore>(restoreFields);

/** The canonical wire fields of StorageStatus. */
export const storageStatusFields = {
  fork: pointer(forkProgressShape),
};
/** The canonical wire shape of StorageStatus. */
export const storageStatusShape: Shape<StorageStatus> =
  object<StorageStatus>(storageStatusFields);

/** Reads a served Version leniently, carrying unknown fields and tokens. */
export function decodeVersion(document: unknown): Version {
  return decodeValue(
    typeof document === "string" ? parseJson(document) : document,
    versionShape,
    "lenient",
  );
}
/** Renders Version with the public wire omission rules and explicit zero counts. */
export function encodeVersion(value: Version): JsonObject {
  return versionShape.encode(value) as JsonObject;
}

/** Reads a served Commit leniently, carrying unknown fields and tokens. */
export function decodeCommit(document: unknown): Commit {
  return decodeValue(
    typeof document === "string" ? parseJson(document) : document,
    commitShape,
    "lenient",
  );
}
/** Renders Commit with the public wire omission rules and explicit zero counts. */
export function encodeCommit(value: Commit): JsonObject {
  return commitShape.encode(value) as JsonObject;
}

/** Reads a served Restore leniently, carrying unknown fields and tokens. */
export function decodeRestore(document: unknown): Restore {
  return decodeValue(
    typeof document === "string" ? parseJson(document) : document,
    restoreShape,
    "lenient",
  );
}
/** Renders Restore with the public wire omission rules and explicit zero counts. */
export function encodeRestore(value: Restore): JsonObject {
  return restoreShape.encode(value) as JsonObject;
}

/** Checks fork state and progress arithmetic. */
export function validateForkProgress(progress: ForkProgress): void {
  validateForkState(progress.state);
  if (progress.copied > progress.total)
    throw new TypeError("fork copied exceeds total");
}
/** Checks saved version counts, the reported owning entry and operation identities, and origin vocabulary. */
export function validateVersion(version: Version): void {
  if (
    version.number < 0 ||
    version.logicalBytes < 0 ||
    (version.parent !== undefined && version.parent < 0)
  )
    throw new TypeError("version counts must be non-negative");
  if (integerEqual(version.number, 0) && version.parent !== undefined)
    throw new TypeError("genesis has no parent");
  if ((version.entry ?? "") !== "") parseJournalEntryId(version.entry ?? "");
  if ((version.operation ?? "") !== "")
    parseStorageOperationId(version.operation ?? "");
  validateVersionOrigin(version.origin);
}
/**
 * Requires a selected restore version and a stated client this SDK names;
 * membership is resolved by the server.
 */
export function validateCreateRestoreRequest(
  request: CreateRestoreRequest,
): void {
  if (request.from === "") throw new TypeError("restore from is required");
  validateStatedClient(request.client);
}

/** Checks that a stated client is one this SDK names. */
export function validateCreateCommitRequest(
  request: CreateCommitRequest,
): void {
  validateStatedClient(request.client);
}
