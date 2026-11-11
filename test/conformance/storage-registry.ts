// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * The codecs of the storage observation goldens: saved versions, saves,
 * restores, uploads, file entries, Cells, and journal entries, and of the
 * Computer's wakes and sleeps, each read through its canonical shape.
 */
import {
  computerCellShape,
  validateComputerCell,
} from "../../src/api/computer-cell.js";
import {
  computerCellSaveShape,
  validateComputerCellSave,
} from "../../src/api/computer-cell-save.js";
import {
  createComputerSessionRequestShape,
  validateCreateComputerSessionRequest,
} from "../../src/api/computer-session.js";
import * as operations from "../../src/api/computer-operations.js";
import * as files from "../../src/api/files.js";
import * as fileStatus from "../../src/api/file-status.js";
import {
  decodeJournalEntry,
  encodeJournalEntry,
  validateJournalEntry,
} from "../../src/api/journal.js";
import * as storage from "../../src/api/storage.js";
import * as enums from "../../src/api/storage-enums.js";
import {
  always,
  array,
  boolean,
  decodeValue,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../../src/internal/strictdecode.js";
import type { ListResponse } from "../../src/api/types.js";
import { parseJson } from "../../src/resource/json.js";
import type { ServedCodec } from "./served-registry.js";

/** One page of a saved directory listing, as the listing serves it. */
const fileListPageShape: Shape<fileStatus.FileListResponse> =
  object<fileStatus.FileListResponse>({
    items: always(array(files.fileEntryShape)),
    totalCount: always(integer({ unsigned: false, bits: 64 })),
    continue: omitEmpty(string()),
    syncing: pointer(boolean()),
    store: pointer(fileStatus.fileStoreWaitShape),
  });

/** One page of an upload's replaced paths, as the listing serves it. */
const uploadReplacedPageShape: Shape<ListResponse<files.UploadReplacedPath>> =
  object<ListResponse<files.UploadReplacedPath>>({
    items: always(array(files.uploadReplacedPathShape)),
    totalCount: always(integer({ unsigned: false, bits: 64 })),
    snapshotCursor: omitEmpty(string()),
    continue: omitEmpty(string()),
  });

/** A served file entry: its type, and its status when the listing states one. */
function validateServedFileEntry(entry: files.FileEntry): void {
  files.validateFileEntryType(entry.type);
  if (entry.status !== undefined) fileStatus.validateFileStatus(entry.status);
}

function codec<T>(
  shape: Shape<T>,
  validate?: (value: T) => void,
): ServedCodec<unknown> {
  return {
    decode: (value) =>
      decodeValue(
        typeof value === "string" ? parseJson(value) : value,
        shape,
        "lenient",
      ),
    encode: (value) => shape.encode(value as T),
    validate: (value) => {
      validate?.(value as T);
    },
  };
}

/**
 * The create requests of a wake and a sleep, with and without a key, and a
 * sleep asked to discard unsaved changes, and a forced sleep.
 */
interface ComputerOperationRequests {
  readonly wake: operations.CreateComputerWakeRequest;
  readonly wakeMinimal: operations.CreateComputerWakeRequest;
  readonly sleep: operations.CreateComputerSleepRequest;
  readonly sleepMinimal: operations.CreateComputerSleepRequest;
  readonly sleepDiscard: operations.CreateComputerSleepRequest;
  readonly sleepForce: operations.CreateComputerSleepRequest;
}

const computerOperationRequestsShape = object<ComputerOperationRequests>({
  wake: always(operations.createComputerWakeRequestShape),
  wakeMinimal: always(operations.createComputerWakeRequestShape),
  sleep: always(operations.createComputerSleepRequestShape),
  sleepMinimal: always(operations.createComputerSleepRequestShape),
  sleepDiscard: always(operations.createComputerSleepRequestShape),
  sleepForce: always(operations.createComputerSleepRequestShape),
});

/** Canonical storage and observation fixture codecs. */
export const storageRegistry: ReadonlyMap<
  string,
  ServedCodec<unknown>
> = new Map([
  ["version", codec(storage.versionShape, storage.validateVersion)],
  [
    "commit",
    codec(storage.commitShape, (value) => {
      enums.validateCommitState(value.state);
    }),
  ],
  [
    "restore",
    codec(storage.restoreShape, (value) => {
      enums.validateRestoreState(value.state);
    }),
  ],
  [
    "upload",
    codec(files.uploadShape, (value) => {
      files.validateUploadState(value.state);
    }),
  ],
  ["upload.change-receipt", codec(files.uploadChangeReceiptShape)],
  [
    "upload-replaced.list-page",
    codec(uploadReplacedPageShape, (page) => {
      for (const item of page.items) {
        files.validateFilePath(item);
        if (item.landedAt !== undefined) files.validateFilePath(item.landedAt);
      }
    }),
  ],
  [
    "computer-wake",
    {
      decode: operations.decodeComputerWake,
      encode: (value) =>
        operations.encodeComputerWake(value as operations.ComputerWake),
      validate: (value) => {
        operations.validateComputerWakeState(
          (value as operations.ComputerWake).state,
        );
      },
    },
  ],
  [
    "computer-sleep",
    {
      decode: operations.decodeComputerSleep,
      encode: (value) =>
        operations.encodeComputerSleep(value as operations.ComputerSleep),
      validate: (value) => {
        operations.validateComputerSleepState(
          (value as operations.ComputerSleep).state,
        );
      },
    },
  ],
  [
    "computer-operation.requests",
    codec(computerOperationRequestsShape, (value) => {
      // Each request is a submission: it reads back through the strict
      // decoder exactly as the service sends it.
      const wake = operations.createComputerWakeRequestShape;
      const sleep = operations.createComputerSleepRequestShape;
      for (const request of [value.wake, value.wakeMinimal])
        decodeValue(wake.encode(request), wake, "strict");
      for (const request of [
        value.sleep,
        value.sleepMinimal,
        value.sleepDiscard,
        value.sleepForce,
      ])
        decodeValue(sleep.encode(request), sleep, "strict");
    }),
  ],
  ["file", codec(files.fileEntryShape, validateServedFileEntry)],
  [
    "files",
    codec(fileListPageShape, (page) => {
      page.items.forEach(validateServedFileEntry);
      if (page.store !== undefined)
        fileStatus.validateFileStoreWaitState(page.store.state);
    }),
  ],
  [
    "files-watch",
    codec(fileStatus.watchFilesResponseShape, (answer) => {
      if (answer.cursor === "") throw new TypeError("cursor is required");
      for (const change of answer.changes) {
        files.validateFilePath(change);
        fileStatus.validateFileChangeKind(change.change);
        fileStatus.validateFileStatus(change.status);
        if (change.type !== undefined) files.validateFileEntryType(change.type);
      }
      for (const publication of answer.published)
        publication.paths.forEach(files.validateFilePath);
      if (answer.store !== undefined)
        fileStatus.validateFileStoreWaitState(answer.store.state);
    }),
  ],
  ["computer-cell", codec(computerCellShape, validateComputerCell)],
  [
    "computer-cell.save-minimal",
    codec(computerCellSaveShape, validateComputerCellSave),
  ],
  [
    "computer-session.version-floor-request",
    codec(
      createComputerSessionRequestShape,
      validateCreateComputerSessionRequest,
    ),
  ],
  [
    "journal",
    {
      decode: decodeJournalEntry,
      encode: (value) =>
        encodeJournalEntry(value as ReturnType<typeof decodeJournalEntry>),
      validate: (value) => {
        validateJournalEntry(value as ReturnType<typeof decodeJournalEntry>);
      },
    },
  ],
]);
