// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  validateStatedClient,
  type ComputerSessionClient,
} from "./computer-session.js";
import { integerText, isUint64 } from "../internal/strictdecode.js";
import { parseJson } from "../resource/json.js";
import type { Integer } from "../resource/json.js";
import { encodeBase64, decodeBase64 } from "../resource/base64.js";
import { isWellFormed, prefixed } from "../resource/validation.js";
import {
  type Shape,
  always,
  array,
  decodeValue,
  integer,
  object,
  omitEmpty,
  omitZero,
  pointer,
  string,
} from "../internal/strictdecode.js";
import { type JsonObject } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";
import { type StorageOperationId } from "../resource/uuid-id.js";
import { type PageOptions, pageOptionsFields } from "./storage.js";
import type { FileStatus } from "./file-status.js";

/**
 * The length of every piece of a file but its last. A file of `size` bytes has
 * `size / FILE_PIECE_BYTES` pieces, rounded up, and an empty file has none.
 */
export const FILE_PIECE_BYTES = 4 * 1024 * 1024;

/** The length of one piece hash in a pieces list. */
export const FILE_PIECE_HASH_BYTES = 32;

/** The PAX record that states a regular file's tag in a saved tree archive. */
export const ARCHIVE_TAG_RECORD = "comment";

/** FilePath preserves a relative POSIX path as UTF-8 or standard padded base64, exactly one. A pointer to an empty Path explicitly addresses the root. Existing byte names may be read or deleted without normalization. */
export interface FilePath {
  readonly path?: string;
  readonly pathBase64?: string;
}

/**
 * FileEntry is one saved child, preserving names and symlink targets as exact UTF-8 or padded base64. Size is the logical file length, not the size measure. Mode contains permission bits only; zero sizes are written.
 *
 * `sha256` is the SHA-256 of a file's bytes and `tag` its public content hash, the value `fileTagOfPieces` computes. Either may be absent from a listing where stating it would take more than the listing reads. A read's `ETag` always states the tag.
 *
 * `status` says whether the entry's content is safe in the store, and `statusReason` why it is not when `status` is `conflict` or `failed`. A listing of the latest saved version states it on every entry. A listing of a named version omits it, since every entry of a saved version is in the store.
 */
export interface FileEntry {
  readonly name?: string;
  readonly nameBase64?: string;
  readonly type: FileEntryType;
  readonly mode: number;
  readonly size: Integer;
  readonly sha256?: string;
  readonly tag?: string;
  readonly target?: string;
  readonly targetBase64?: string;
  readonly status?: FileStatus;
  readonly statusReason?: string;
}

/** FileListOptions selects children of a saved path, or save-first with update permission. Version omitted means the latest saved version. */
export interface FileListOptions extends PageOptions, FilePath {
  readonly version?: string;
}

/** FileReadOptions selects saved content or a POSIX archive. Save-first reads exactly the version returned by its save, reported in Idyl-Saved-Version. */
export interface FileReadOptions extends FilePath {
  readonly version?: string;
}

/**
 * CreateFileDownloadLinkRequest names one saved file or directory at one version, for a link that a browser or another program without credentials can read. Version omitted means the latest saved version, and the link stays on the version it resolved to.
 */
export interface CreateFileDownloadLinkRequest extends FilePath {
  readonly version?: string;
}

/**
 * FileDownloadLink is a read-only address of one saved file or directory at one version. Whoever holds `url` can read those bytes until `expiresAt`, with no other credential, so it is handled as a secret. A directory is served as a POSIX tar archive. The link answers range requests, so a browser's download manager can resume it. Its bytes count as the Account's downloads.
 */
export interface FileDownloadLink {
  readonly url: string;
  readonly expiresAt: string;
  readonly version: Integer;
}

/** ContentFacts is what a read of saved content would serve: its strong entity tag, its length in bytes, and the saved version it belongs to. */
export interface ContentFacts {
  readonly etag: string;
  readonly size: number;
  readonly version: Integer;
}

/** ContentRange asks for `length` bytes from `offset` of the bytes `etag` names. */
export interface ContentRange {
  readonly offset: number;
  readonly length: number;
  readonly etag: string;
}

/** CreateUploadRequest chooses a base version; undefined uses the current files head. An equal `idempotencyKey` retry returns its recorded outcome without a new effect. */
export interface CreateUploadRequest {
  readonly base?: Integer;
  readonly idempotencyKey?: string;
  /**
   * The kind of client sending the request. The journal entry it makes
   * records it, as `unknown` when it is absent; it is informative and never
   * authorizes anything.
   */
  readonly client?: ComputerSessionClient;
}

/**
 * UploadDelivery reports the running writer's application of a published
 * upload. `reason` states why the last attempt failed while `state` is
 * `retrying`, and why the delivery ended while it is `failed`.
 *
 * `replacedCount` counts the delivered paths that met the running
 * Computer's unsaved work, and `replaced` names the first 100 of them in
 * byte order of their path; the replaced paths listing pages through all of
 * them. Both are reported once `state` is `applied`. A publish to a running
 * Computer answers once the writer applied the upload or its delivery
 * failed, waiting at most 10 seconds; past that wait `state` is `pending`
 * or `retrying` and the writer receives the upload later, in publication
 * order.
 */
export interface UploadDelivery {
  readonly state: DeliveryState;
  readonly replacedCount: Integer;
  readonly replaced?: readonly UploadReplacedPath[];
  readonly reason?: string;
}

/**
 * UploadReplacedPath is one delivered path that met unsaved work on the
 * running Computer. When `landedAt` is set, both copies are kept: the
 * Computer's own copy keeps the path and the uploaded copy is at
 * `landedAt`, in the same folder. When it is absent, the uploaded copy
 * replaced the Computer's copy at the path.
 */
export interface UploadReplacedPath extends FilePath {
  readonly landedAt?: FilePath;
}

/** Upload reports staging activity, its terminal outcome and optional delivery. While bytes arrive there is no elapsed transfer limit; inactivity is measured by the server, independently of the caller's context deadline. */
export interface Upload {
  readonly id: StorageOperationId;
  readonly state: UploadState;
  readonly base: Integer;
  readonly lastActivityAt?: string;
  readonly idleExpiresAt?: string;
  readonly version?: Integer;
  readonly delivery?: UploadDelivery;
  readonly reason?: string;
}

/** UploadFileOptions identifies one sequenced file stream. Resume verifies the accepted prefix from byte zero before sending further bounded parts. */
export interface UploadFileOptions extends FilePath {
  readonly mode: number;
  readonly seq: Integer;
}

/** UploadArchiveOptions streams a POSIX tar rooted at Path. Each archive entry is validated by the server; the SDK retains one bounded part without unpacking the stream. */
export interface UploadArchiveOptions extends FilePath {
  readonly seq: Integer;
}

/** FileRename moves an existing byte path to a new UTF-8 NFC path. */
export interface FileRename {
  readonly from: FilePath;
  readonly to: FilePath;
}

/** UploadChangesRequest records one ordered page of deletes and renames. */
export interface UploadChangesRequest {
  readonly seq: Integer;
  readonly delete?: readonly FilePath[];
  readonly rename?: readonly FileRename[];
}

/** UploadChangeReceipt records atomic acceptance and the server-computed payload fingerprint. A repeated sequence with different content is refused. */
export interface UploadChangeReceipt {
  readonly seq: Integer;
  readonly fingerprint: string;
}

/** PublishUploadRequest gives publication an optional retained retry identity. */
export interface PublishUploadRequest {
  readonly idempotencyKey?: string;
}

/** Supported file entry type tokens; responses also carry newer tokens. */
export type FileEntryType =
  "file" | "dir" | "symlink" | (string & Record<never, never>);
/** Judges file entry type membership without rejecting newer values on read. */
export function validateFileEntryType(value: FileEntryType): void {
  if (["file", "dir", "symlink"].includes(value)) return;
  if (value === "") throw new TypeError("file entry type is required");
  throw new TypeError(`unknown file entry type ${JSON.stringify(value)}`);
}

/** Supported upload state tokens; responses also carry newer tokens. */
export type UploadState =
  | "open"
  | "published"
  | "cancelled"
  | "expired"
  | "conflict"
  | "failed"
  | (string & Record<never, never>);
/** Judges upload state membership without rejecting newer values on read. */
export function validateUploadState(value: UploadState): void {
  if (
    [
      "open",
      "published",
      "cancelled",
      "expired",
      "conflict",
      "failed",
    ].includes(value)
  )
    return;
  if (value === "") throw new TypeError("upload state is required");
  throw new TypeError(`unknown upload state ${JSON.stringify(value)}`);
}

/** Supported delivery state tokens; responses also carry newer tokens. */
export type DeliveryState =
  "pending" | "applied" | "retrying" | (string & Record<never, never>);
/** Judges delivery state membership without rejecting newer values on read. */
export function validateDeliveryState(value: DeliveryState): void {
  if (["pending", "applied", "retrying"].includes(value)) return;
  if (value === "") throw new TypeError("delivery state is required");
  throw new TypeError(`unknown delivery state ${JSON.stringify(value)}`);
}

/** The canonical wire fields of FilePath. */
export const filePathFields = {
  path: pointer(string()),
  pathBase64: pointer(string()),
};
/** The canonical wire shape of FilePath. */
export const filePathShape: Shape<FilePath> = object<FilePath>(filePathFields);

/** The canonical wire fields of FileEntry. */
export const fileEntryFields = {
  name: pointer(string()),
  nameBase64: pointer(string()),
  type: always(string<FileEntryType>()),
  mode: always(integer({ unsigned: true, bits: 32 })),
  size: always(integer({ unsigned: true, bits: 64 })),
  sha256: omitEmpty(string()),
  tag: omitEmpty(string()),
  target: pointer(string()),
  targetBase64: pointer(string()),
  status: omitEmpty(string<FileStatus>()),
  statusReason: omitEmpty(string()),
};
/** The canonical wire shape of FileEntry. */
export const fileEntryShape: Shape<FileEntry> =
  object<FileEntry>(fileEntryFields);

/** The canonical wire shape of CreateFileDownloadLinkRequest. */
export const createFileDownloadLinkRequestShape: Shape<CreateFileDownloadLinkRequest> =
  object<CreateFileDownloadLinkRequest>({
    ...filePathFields,
    version: omitEmpty(string()),
  });

/** The canonical wire shape of FileDownloadLink. */
export const fileDownloadLinkShape: Shape<FileDownloadLink> =
  object<FileDownloadLink>({
    url: always(string()),
    expiresAt: always(timestampShape),
    version: always(integer({ unsigned: false, bits: 64 })),
  });

/** The canonical wire fields of CreateUploadRequest. */
export const createUploadRequestFields = {
  base: pointer(integer({ unsigned: false, bits: 64 })),
  idempotencyKey: omitEmpty(string()),
  client: omitEmpty(string<ComputerSessionClient>()),
};
/** The canonical wire shape of CreateUploadRequest. */
export const createUploadRequestShape: Shape<CreateUploadRequest> =
  object<CreateUploadRequest>(createUploadRequestFields);

/** The canonical wire fields of UploadReplacedPath. */
export const uploadReplacedPathFields = {
  ...filePathFields,
  landedAt: pointer(filePathShape),
};
/** The canonical wire shape of UploadReplacedPath. */
export const uploadReplacedPathShape: Shape<UploadReplacedPath> =
  object<UploadReplacedPath>(uploadReplacedPathFields);

/** The canonical wire fields of UploadDelivery. */
export const uploadDeliveryFields = {
  state: always(string<DeliveryState>()),
  replacedCount: always(integer({ unsigned: true, bits: 64 })),
  replaced: omitEmpty(array(uploadReplacedPathShape)),
  reason: omitEmpty(string()),
};
/** The canonical wire shape of UploadDelivery. */
export const uploadDeliveryShape: Shape<UploadDelivery> =
  object<UploadDelivery>(uploadDeliveryFields);

/** The canonical wire fields of UploadChangeReceipt. */
export const uploadChangeReceiptFields = {
  seq: always(integer({ unsigned: true, bits: 64 })),
  fingerprint: always(string()),
};
/** The canonical wire shape of UploadChangeReceipt. */
export const uploadChangeReceiptShape: Shape<UploadChangeReceipt> =
  object<UploadChangeReceipt>(uploadChangeReceiptFields);

/** The canonical wire fields of PublishUploadRequest. */
export const publishUploadRequestFields = {
  idempotencyKey: omitEmpty(string()),
};
/** The canonical wire shape of PublishUploadRequest. */
export const publishUploadRequestShape: Shape<PublishUploadRequest> =
  object<PublishUploadRequest>(publishUploadRequestFields);

/** The canonical wire fields of FileListOptions. */
export const fileListOptionsFields = {
  ...pageOptionsFields,
  ...filePathFields,
  version: omitEmpty(string()),
};
/** The canonical wire shape of FileListOptions. */
export const fileListOptionsShape: Shape<FileListOptions> =
  object<FileListOptions>(fileListOptionsFields);

/** The canonical wire fields of FileReadOptions. */
export const fileReadOptionsFields = {
  ...filePathFields,
  version: omitEmpty(string()),
};
/** The canonical wire shape of FileReadOptions. */
export const fileReadOptionsShape: Shape<FileReadOptions> =
  object<FileReadOptions>(fileReadOptionsFields);

/** The canonical wire fields of Upload. */
export const uploadFields = {
  id: always(string<StorageOperationId>()),
  state: always(string<UploadState>()),
  base: always(integer({ unsigned: false, bits: 64 })),
  lastActivityAt: omitZero(timestampShape),
  idleExpiresAt: omitZero(timestampShape),
  version: pointer(integer({ unsigned: false, bits: 64 })),
  delivery: pointer(uploadDeliveryShape),
  reason: omitEmpty(string()),
};
/** The canonical wire shape of Upload. */
export const uploadShape: Shape<Upload> = object<Upload>(uploadFields);

/** The canonical wire fields of UploadFileOptions. */
export const uploadFileOptionsFields = {
  ...filePathFields,
  mode: always(integer({ unsigned: true, bits: 32 })),
  seq: always(integer({ unsigned: true, bits: 64 })),
};
/** The canonical wire shape of UploadFileOptions. */
export const uploadFileOptionsShape: Shape<UploadFileOptions> =
  object<UploadFileOptions>(uploadFileOptionsFields);

/** The canonical wire fields of UploadArchiveOptions. */
export const uploadArchiveOptionsFields = {
  ...filePathFields,
  seq: always(integer({ unsigned: true, bits: 64 })),
};
/** The canonical wire shape of UploadArchiveOptions. */
export const uploadArchiveOptionsShape: Shape<UploadArchiveOptions> =
  object<UploadArchiveOptions>(uploadArchiveOptionsFields);

/** The canonical wire fields of FileRename. */
export const fileRenameFields = {
  from: always(filePathShape),
  to: always(filePathShape),
};
/** The canonical wire shape of FileRename. */
export const fileRenameShape: Shape<FileRename> =
  object<FileRename>(fileRenameFields);

/** The canonical wire fields of UploadChangesRequest. */
export const uploadChangesRequestFields = {
  seq: always(integer({ unsigned: true, bits: 64 })),
  delete: omitEmpty(array(filePathShape)),
  rename: omitEmpty(array(fileRenameShape)),
};
/** The canonical wire shape of UploadChangesRequest. */
export const uploadChangesRequestShape: Shape<UploadChangesRequest> =
  object<UploadChangesRequest>(uploadChangesRequestFields);

/** Reads a served FileEntry leniently, carrying unknown fields and tokens. */
export function decodeFileEntry(document: unknown): FileEntry {
  return decodeValue(
    typeof document === "string" ? parseJson(document) : document,
    fileEntryShape,
    "lenient",
  );
}
/** Renders FileEntry with the public wire omission rules and explicit zero counts. */
export function encodeFileEntry(value: FileEntry): JsonObject {
  return fileEntryShape.encode(value) as JsonObject;
}

/** Reads a served Upload leniently, carrying unknown fields and tokens. */
export function decodeUpload(document: unknown): Upload {
  return decodeValue(
    typeof document === "string" ? parseJson(document) : document,
    uploadShape,
    "lenient",
  );
}
/** Renders Upload with the public wire omission rules and explicit zero counts. */
export function encodeUpload(value: Upload): JsonObject {
  return uploadShape.encode(value) as JsonObject;
}

/** Copies path bytes into their lossless UTF-8 or canonical padded-base64 representation. */
export function newFilePath(bytes: Uint8Array): FilePath {
  try {
    return {
      path: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
    };
  } catch {
    return { pathBase64: encodeBase64(bytes) };
  }
}
/** Checks an existing relative POSIX path and returns independently owned bytes. */
export function filePathBytes(path: FilePath): Uint8Array {
  if ((path.path !== undefined) === (path.pathBase64 !== undefined))
    throw new TypeError("exactly one path or pathBase64 is required");
  let bytes: Uint8Array;
  if (path.path !== undefined) {
    if (!isWellFormed(path.path))
      throw new TypeError("path must be UTF-8; use pathBase64 for byte names");
    bytes = new TextEncoder().encode(path.path);
  } else {
    const base64 = path.pathBase64 ?? "";
    if (base64.length > 5460)
      throw new TypeError("path exceeds the Linux path bound");
    try {
      bytes = decodeBase64(base64);
    } catch {
      throw new TypeError("pathBase64 must be canonical padded base64");
    }
    if (encodeBase64(bytes) !== base64)
      throw new TypeError("pathBase64 must be canonical padded base64");
  }
  if (bytes.length > 4095)
    throw new TypeError("path exceeds the Linux path bound");
  if (bytes.includes(0) || bytes[0] === 47)
    throw new TypeError("path must be relative and contain no NUL");
  if (bytes.length !== 0) {
    let start = 0;
    for (let index = 0; index <= bytes.length; index += 1) {
      if (index !== bytes.length && bytes[index] !== 47) continue;
      const length = index - start;
      if (
        length === 0 ||
        length > 255 ||
        (length === 1 && bytes[start] === 46) ||
        (length === 2 && bytes[start] === 46 && bytes[start + 1] === 46)
      )
        throw new TypeError("path has an invalid Linux component");
      start = index + 1;
    }
  }
  return bytes;
}
/** Checks an existing path without imposing new-name normalization. */
export function validateFilePath(path: FilePath): void {
  filePathBytes(path);
}
/** Refuses authority-owned runtime paths while retaining existing byte names. */
export function validateFilePathMutation(path: FilePath): void {
  const bytes = filePathBytes(path);
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  if (text === ".runtime" || text.startsWith(".runtime/"))
    throw new TypeError("path names authority-owned runtime state");
}
/** Requires UTF-8 NFC for new names without normalizing their bytes. */
export function validateFilePathCreate(path: FilePath): void {
  validateFilePathMutation(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      filePathBytes(path),
    );
  } catch {
    throw new TypeError("new path names must be UTF-8 NFC");
  }
  if (text.normalize("NFC") !== text)
    throw new TypeError("new path names must be UTF-8 NFC");
}
/** Checks a listed saved byte path; version resolution remains a server decision. */
export function validateFileListOptions(options: FileListOptions): void {
  if (options.version !== undefined)
    fileListOptionsFields.version.shape.decode(options.version, "version");
  validateFilePath(options);
}
/** Checks an existing byte path for content or archive reads. */
export function validateFileReadOptions(options: FileReadOptions): void {
  if (options.version !== undefined)
    fileReadOptionsFields.version.shape.decode(options.version, "version");
  validateFilePath(options);
}
/** Checks the path, and refuses a save, which a link must not start. */
export function validateCreateFileDownloadLinkRequest(
  request: CreateFileDownloadLinkRequest,
): void {
  if (request.version === "save-first")
    throw new TypeError("a download link cannot save first");
  validateFilePath(request);
}
/** Checks a requested upload base and a stated client before submission. */
export function validateCreateUploadRequest(
  request: CreateUploadRequest,
): void {
  if (request.base !== undefined && request.base < 0)
    throw new TypeError("upload base must be non-negative");
  validateStatedClient(request.client);
}
/** Checks a new file's byte path, permission bits and positive sequence. */
export function validateUploadFileOptions(options: UploadFileOptions): void {
  if (!isUint64(options.seq) || options.seq <= 0)
    throw new TypeError("upload sequence must be positive");
  uploadFileOptionsFields.mode.shape.decode(options.mode, "mode");
  if (options.mode > 0o777)
    throw new TypeError("mode contains non-permission bits");
  validateFilePathCreate(options);
  if (filePathBytes(options).length === 0)
    throw new TypeError("file path must not be the root");
}
/** Checks an archive prefix and positive sequence without buffering or unpacking the stream. */
export function validateUploadArchiveOptions(
  options: UploadArchiveOptions,
): void {
  if (!isUint64(options.seq) || options.seq <= 0)
    throw new TypeError("upload sequence must be positive");
  validateFilePathCreate(options);
}
/** Checks ordered delete/rename operands; conflicts remain server decisions. */
export function validateUploadChangesRequest(
  request: UploadChangesRequest,
): void {
  if (!isUint64(request.seq) || request.seq <= 0)
    throw new TypeError("upload sequence must be positive");
  (request.delete ?? []).forEach((path, index) => {
    prefixed(`delete[${String(index)}]`, () => {
      validateFilePathMutation(path);
    });
  });
  (request.rename ?? []).forEach((path, index) => {
    prefixed(`rename[${String(index)}].from`, () => {
      validateFilePathMutation(path.from);
    });
    prefixed(`rename[${String(index)}].to`, () => {
      validateFilePathCreate(path.to);
    });
  });
}
/** Owns one raw streaming response; version zero remains distinct from an unreported version. */
export interface StoredContent {
  readonly body: ReadableStream<Uint8Array>;
  readonly etag: string;
  readonly version?: Integer;
  /** Releases the body without changing the remote resource. */
  close(): Promise<void>;
}

/**
 * A file's tag, its public content hash, from its piece hashes laid end to end
 * in order. A file of one piece has the SHA-256 of its bytes, which is that
 * piece's hash. An empty file has the SHA-256 of no bytes. A file of several
 * pieces has the SHA-256 of its piece hashes, which no tool hashing the file's
 * bytes computes.
 *
 * A tag covers content, not length, so a large file and a small file holding
 * the bytes of its piece hashes share a tag. Their lengths differ, and a length
 * fixes a file's number of pieces, so a tag and a length together identify the
 * bytes: see `fileEtag`.
 */
export async function fileTagOfPieces(
  pieceHashes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return hexOf(
    pieceHashes.length === FILE_PIECE_HASH_BYTES
      ? pieceHashes
      : new Uint8Array(await crypto.subtle.digest("SHA-256", pieceHashes)),
  );
}

/** Bytes in lowercase hexadecimal, the spelling of a tag. */
export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * A saved file's strong entity tag, the tag and the length together. Two files
 * with one entity tag hold the same bytes, and the entity tag is the same in
 * every version that holds them. `tag` must be lowercase hexadecimal.
 */
export function fileEtag(tag: string, size: Integer): string {
  return `"${tag}-${integerText(size)}"`;
}

/**
 * Reads an entity tag `fileEtag` wrote, and returns `undefined` for any other
 * value, or a length beyond 2^53 - 1, which no `number` states exactly. A tree
 * archive's entity tag is not one, and has no parts to read.
 */
export function parseFileEtag(
  etag: string,
): { readonly tag: string; readonly size: number } | undefined {
  const match = /^"([0-9a-f]{64})-(0|[1-9][0-9]*)"$/u.exec(etag);
  if (match === null) return undefined;
  const size = Number(match[2]);
  return Number.isSafeInteger(size) ? { tag: match[1] ?? "", size } : undefined;
}
