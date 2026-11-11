// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  type FileEntry,
  type FileEntryType,
  type FilePath,
  filePathFields,
  filePathShape,
  validateFilePath,
} from "./files.js";
import {
  type Shape,
  always,
  array,
  boolean,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
} from "../internal/strictdecode.js";
import type { Integer } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";

/**
 * FileStatus says whether a file's content is safe in the store. A file's name
 * and status reach every client as soon as the name changes on a running
 * Computer; its content follows with the Computer's next save.
 *
 * - `synced`: content that is safe in the store.
 * - `syncing`: a name that exists on a running Computer whose content no
 *   saved version holds yet.
 * - `conflict`: a name where two changes collided and both copies were kept;
 *   its `statusReason` is `kept-both`.
 * - `failed`: content the Computer's save cannot finish; its `statusReason`
 *   is the failing save's reason, as its commit reports it.
 *
 * Responses also carry newer tokens.
 */
export type FileStatus =
  | "synced"
  | "syncing"
  | "conflict"
  | "failed"
  | (string & Record<never, never>);
/** Judges file status membership without making decoding strict. */
export function validateFileStatus(value: FileStatus): void {
  if (["synced", "syncing", "conflict", "failed"].includes(value)) return;
  if (value === "") throw new TypeError("file status is required");
  throw new TypeError(`unknown file status ${JSON.stringify(value)}`);
}

/**
 * FileListResponse is one page of a saved directory listing.
 *
 * `syncing` is stated when the listing reads the latest saved version: `true`
 * while the files' owner is a running Computer holding changes no saved
 * version holds yet, including changes written in place to files the listing
 * shows as `synced`, and `false` otherwise. When the service cannot tell, it
 * states `true`. It is `undefined` on a listing of a named version. `store`
 * is present on such a listing while the running Computer's reads wait for
 * the store.
 */
export interface FileListResponse {
  readonly items: readonly FileEntry[];
  readonly totalCount: Integer;
  readonly continue?: string;
  readonly syncing?: boolean;
  readonly store?: FileStoreWait;
}

/**
 * WatchFilesOptions selects the folder a file watch follows, the root when no
 * path is set, and `after`, the `cursor` of the answer the caller holds. An
 * absent or empty `after` asks for the current status at once.
 */
export interface WatchFilesOptions extends FilePath {
  readonly after?: string;
}

/**
 * WatchFilesResponse is one answer of a file watch: the whole current status
 * of the watched folder and everything below it, and the versions published
 * since the answer `after` named.
 *
 * A watch answers at once when the status or the published versions moved
 * past `after`. Otherwise the service holds the request until one does, for
 * at most 10 seconds, and then answers with the same `cursor`. A client
 * follows a folder by asking again with each answer's `cursor`; a request
 * held open is not a stream, and nothing is lost between two requests.
 *
 * `changes` lists every name below the folder that changed on a running
 * Computer since its last saved version, in byte order of path; it is the
 * whole set, not what changed since `after`. `published` lists the versions
 * published since `after`, oldest first, such as a save, an upload or a
 * restore. `relist` says that `after` is older than the service still
 * remembers, so the caller lists the folder again instead of applying
 * `published`. `syncing` has {@link FileListResponse}'s meaning. `store` is
 * present while the Computer's reads wait for the store.
 */
export interface WatchFilesResponse {
  readonly cursor: string;
  readonly syncing: boolean;
  readonly changes: readonly FileChange[];
  readonly published: readonly FilePublication[];
  readonly relist?: boolean;
  readonly store?: FileStoreWait;
}

/**
 * FileChangeKind says what changed at a {@link FileChange}'s path.
 *
 * - `changed`: a name created, replaced or moved to its path. `type`, `size`
 *   and `modified` are read from the file when its change is reported.
 * - `removed`: a saved name the running Computer no longer holds.
 * - `many`: a folder holding more changed names than are listed one by one.
 *   The empty path names the whole tree. The caller lists the folder to see
 *   them.
 *
 * Responses also carry newer tokens.
 */
export type FileChangeKind =
  "changed" | "removed" | "many" | (string & Record<never, never>);
/** Judges file change kind membership without making decoding strict. */
export function validateFileChangeKind(value: FileChangeKind): void {
  if (["changed", "removed", "many"].includes(value)) return;
  if (value === "") throw new TypeError("file change is required");
  throw new TypeError(`unknown file change ${JSON.stringify(value)}`);
}

/**
 * FileChange is one changed path of a file watch, relative to the root of the
 * files, not to the watched folder. `status` is `syncing`, `conflict` or
 * `failed`, with `statusReason` as on a {@link FileEntry}. `size` is in
 * bytes, and `modified` is an RFC 3339 timestamp.
 */
export interface FileChange extends FilePath {
  readonly change: FileChangeKind;
  readonly type?: FileEntryType;
  readonly size?: Integer;
  readonly modified?: string;
  readonly status: FileStatus;
  readonly statusReason?: string;
}

/**
 * FilePublication is one version published to the files. `paths` lists the
 * paths it changed, relative to the root of the files, when the service knows
 * them; `more` says it changed more than it lists, so the caller lists the
 * folders it shows again.
 */
export interface FilePublication {
  readonly version: Integer;
  readonly paths: readonly FilePath[];
  readonly more?: boolean;
}

/**
 * FileStoreWaitState says how a running Computer's reads wait for the store.
 *
 * - `waiting`: a read that has waited for the store for at least five
 *   seconds and is still trying.
 * - `unreachable`: a Computer whose first reads of files fail at once,
 *   because one read waited out its bound. One read is tried again every 30
 *   seconds, and its success ends this state.
 *
 * Responses also carry newer tokens.
 */
export type FileStoreWaitState =
  "waiting" | "unreachable" | (string & Record<never, never>);
/** Judges file store wait state membership without making decoding strict. */
export function validateFileStoreWaitState(value: FileStoreWaitState): void {
  if (["waiting", "unreachable"].includes(value)) return;
  if (value === "") throw new TypeError("file store wait state is required");
  throw new TypeError(`unknown file store wait state ${JSON.stringify(value)}`);
}

/**
 * FileStoreWait says a running Computer's reads wait for the store. `cause`
 * is `store` for a store that does not answer, and `connection` for a
 * Computer whose machine cannot reach the service to be let into the store.
 * `since` is when the wait began, as an RFC 3339 timestamp, and `waiting`
 * counts the reads waiting now. `fillDone` and `fillTotal` are the bytes the
 * largest waiting file has and needs, both zero when they are not known.
 */
export interface FileStoreWait {
  readonly state: FileStoreWaitState;
  readonly cause: string;
  readonly since: string;
  readonly waiting: Integer;
  readonly fillDone: Integer;
  readonly fillTotal: Integer;
}

/** The canonical wire fields of WatchFilesOptions. */
export const watchFilesOptionsFields = {
  ...filePathFields,
  after: omitEmpty(string()),
};
/** The canonical wire shape of WatchFilesOptions. */
export const watchFilesOptionsShape: Shape<WatchFilesOptions> =
  object<WatchFilesOptions>(watchFilesOptionsFields);

/** The canonical wire shape of FileChange. */
export const fileChangeShape: Shape<FileChange> = object<FileChange>({
  ...filePathFields,
  change: always(string<FileChangeKind>()),
  type: omitEmpty(string<FileEntryType>()),
  size: omitEmpty(integer({ unsigned: true, bits: 64 })),
  modified: pointer(timestampShape),
  status: always(string<FileStatus>()),
  statusReason: omitEmpty(string()),
});

/** The canonical wire shape of FilePublication. */
export const filePublicationShape: Shape<FilePublication> =
  object<FilePublication>({
    version: always(integer({ unsigned: false, bits: 64 })),
    paths: always(array(filePathShape)),
    more: omitEmpty(boolean()),
  });

/** The canonical wire shape of FileStoreWait. */
export const fileStoreWaitShape: Shape<FileStoreWait> = object<FileStoreWait>({
  state: always(string<FileStoreWaitState>()),
  cause: always(string()),
  since: always(timestampShape),
  waiting: always(integer({ unsigned: true, bits: 64 })),
  fillDone: always(integer({ unsigned: true, bits: 64 })),
  fillTotal: always(integer({ unsigned: true, bits: 64 })),
});

/** The canonical wire shape of WatchFilesResponse. */
export const watchFilesResponseShape: Shape<WatchFilesResponse> =
  object<WatchFilesResponse>({
    cursor: always(string()),
    syncing: always(boolean()),
    changes: always(array(fileChangeShape)),
    published: always(array(filePublicationShape)),
    relist: omitEmpty(boolean()),
    store: pointer(fileStoreWaitShape),
  });

/** Checks the byte path of a file watch when one is set. */
export function validateWatchFilesOptions(options: WatchFilesOptions): void {
  if (options.path === undefined && options.pathBase64 === undefined) return;
  validateFilePath(options);
}
