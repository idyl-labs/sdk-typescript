// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { TransportError } from "../errors.js";
import * as transfers from "../api/upload-transfer.js";
import {
  checkUploadTransfer,
  uploadStream,
} from "../internal/storage-upload.js";
import { sha256Hex } from "../resource/sha256.js";
import { isUint64 } from "../internal/strictdecode.js";
import { integerEqual } from "../internal/strictdecode.js";
import type { Integer } from "../resource/json.js";
import * as storage from "../api/storage.js";
import * as files from "../api/files.js";
import * as fileStatus from "../api/file-status.js";
import type { ListResponse, NamespaceScope } from "../api/types.js";
import type { PlacementContext } from "../internal/context.js";
import {
  namespaceResource,
  computerById,
  storageChild,
} from "../internal/apipath.js";
import {
  fileQuery,
  pageQuery,
  fileListQuery,
  watchFilesQuery,
} from "../internal/listquery.js";
import { asRecord, readList } from "../internal/envelopes.js";
import { requireNonBlank, signalOption } from "../internal/options.js";
import { resolvePlacement } from "../internal/routing.js";
import {
  decodeValue,
  isInt64,
  integerText,
  numberOrBigInt,
  type Shape,
} from "../internal/strictdecode.js";
import {
  parseComputerId,
  parseStorageOperationId,
} from "../resource/uuid-id.js";
import type { RequestOptions } from "../request.js";

/**
 * What a file or archive upload accepts beyond a call's options: `accepted`
 * receives the byte count the platform holds after each accepted part.
 */
export interface UploadRequestOptions extends RequestOptions {
  readonly accepted?: (bytes: bigint) => void;
}

/** Which read of saved content: one file's bytes, or a tree's POSIX tar archive. */
export type ContentKind = "file" | "archive";

/** The route and media type of each kind of content read. */
const CONTENT_ROUTES = {
  file: { suffix: "files/content", accept: "application/octet-stream" },
  archive: { suffix: "files/archive", accept: "application/x-tar" },
} as const;

/** Saved-state operations of a Computer's files. */
export interface StorageMethods {
  /** Reads saved versions newest first; pass `continue` back unchanged to resume the listing. */
  listVersions(
    address: string,
    options?: storage.PageOptions,
    requestOptions?: RequestOptions,
  ): Promise<ListResponse<storage.Version>>;
  /** Reads one saved version by number or name, without changing the current files. Addresses the resource by stable identity. */
  getVersionById(
    address: string,
    version: string,
    requestOptions?: RequestOptions,
  ): Promise<storage.Version>;
  /** Reads saved versions newest first; pass `continue` back unchanged to resume the listing. Addresses the resource by stable identity. */
  listVersionsById(
    address: string,
    options?: storage.PageOptions,
    requestOptions?: RequestOptions,
  ): Promise<ListResponse<storage.Version>>;
  /** Names a saved version by its non-negative number; empty removes the name. */
  updateVersion(
    address: string,
    number: Integer,
    request: storage.UpdateVersionRequest,
    requestOptions?: RequestOptions,
  ): Promise<storage.Version>;
  /** Names a saved version by its non-negative number; empty removes the name. Addresses the resource by stable identity. */
  updateVersionById(
    address: string,
    number: Integer,
    request: storage.UpdateVersionRequest,
    requestOptions?: RequestOptions,
  ): Promise<storage.Version>;
  /** Saves the files or records unchanged; an idempotency key retains the effect. */
  createCommit(
    address: string,
    request: storage.CreateCommitRequest,
    requestOptions?: RequestOptions,
  ): Promise<storage.Commit>;
  /** Saves the files or records unchanged; an idempotency key retains the effect. Addresses the resource by stable identity. */
  createCommitById(
    address: string,
    request: storage.CreateCommitRequest,
    requestOptions?: RequestOptions,
  ): Promise<storage.Commit>;
  /** Reads the recorded save outcome; nonterminal means it continues. */
  getCommit(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<storage.Commit>;
  /** Reads the recorded save outcome; nonterminal means it continues. Addresses the resource by stable identity. */
  getCommitById(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<storage.Commit>;
  /**
   * Appends a `restore` entry owning a new version with the selected
   * version's files, keeping every earlier entry. On a Computer it also
   * restores the execution settings in force at that version's entry, which
   * apply at the Computer's next start; running sessions continue. See
   * {@link storage.CreateRestoreRequest}.
   */
  createRestore(
    address: string,
    request: storage.CreateRestoreRequest,
    requestOptions?: RequestOptions,
  ): Promise<storage.Restore>;
  /** Restores a saved version as {@link StorageMethods.createRestore} does. Addresses the resource by stable identity. */
  createRestoreById(
    address: string,
    request: storage.CreateRestoreRequest,
    requestOptions?: RequestOptions,
  ): Promise<storage.Restore>;
  /** Reads a retained restore outcome by stable operation identity. */
  getRestore(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<storage.Restore>;
  /** Reads a retained restore outcome by stable operation identity. Addresses the resource by stable identity. */
  getRestoreById(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<storage.Restore>;
  /** Reads saved children with byte-safe names; omitted version selects the saved head, whose listing states each entry's status and whether the files are syncing. */
  listFiles(
    address: string,
    options: files.FileListOptions,
    requestOptions?: RequestOptions,
  ): Promise<fileStatus.FileListResponse>;
  /** Reads saved children with byte-safe names; omitted version selects the saved head, whose listing states each entry's status and whether the files are syncing. Addresses the resource by stable identity. */
  listFilesById(
    address: string,
    options: files.FileListOptions,
    requestOptions?: RequestOptions,
  ): Promise<fileStatus.FileListResponse>;
  /**
   * Asks once for the status of a folder of the files, as
   * {@link fileStatus.WatchFilesResponse} describes: at once when it moved
   * past `options.after`, otherwise after the service held the request for at
   * most 10 seconds. An answer that names no cursor cannot be followed and is
   * refused as an invalid response.
   */
  watchFiles(
    address: string,
    options: fileStatus.WatchFilesOptions,
    requestOptions?: RequestOptions,
  ): Promise<fileStatus.WatchFilesResponse>;
  /** Asks once for the status of a folder of the files, as {@link StorageMethods.watchFiles} does. Addresses the resource by stable identity. */
  watchFilesById(
    address: string,
    options: fileStatus.WatchFilesOptions,
    requestOptions?: RequestOptions,
  ): Promise<fileStatus.WatchFilesResponse>;
  /** Opens staging on a saved base; omitted base selects the current head. */
  createUpload(
    address: string,
    request: files.CreateUploadRequest,
    requestOptions?: RequestOptions,
  ): Promise<files.Upload>;
  /** Opens staging on a saved base; omitted base selects the current head. Addresses the resource by stable identity. */
  createUploadById(
    address: string,
    request: files.CreateUploadRequest,
    requestOptions?: RequestOptions,
  ): Promise<files.Upload>;
  /** Reads upload activity, terminal outcome and optional delivery. */
  getUpload(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<files.Upload>;
  /** Reads upload activity, terminal outcome and optional delivery. Addresses the resource by stable identity. */
  getUploadById(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<files.Upload>;
  /** Ends open staging so it cannot publish, preserving terminal outcome arbitration. */
  cancelUpload(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<files.Upload>;
  /** Ends open staging so it cannot publish, preserving terminal outcome arbitration. Addresses the resource by stable identity. */
  cancelUploadById(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<files.Upload>;
  /** Publishes accepted changes as one version, preserving the server conflict outcome. */
  publishUpload(
    address: string,
    operation: string,
    request: files.PublishUploadRequest,
    requestOptions?: RequestOptions,
  ): Promise<files.Upload>;
  /** Publishes accepted changes as one version, preserving the server conflict outcome. Addresses the resource by stable identity. */
  publishUploadById(
    address: string,
    operation: string,
    request: files.PublishUploadRequest,
    requestOptions?: RequestOptions,
  ): Promise<files.Upload>;
  /** Submits one sequenced page of deletes and renames, checking its receipt sequence. */
  uploadChanges(
    address: string,
    operation: string,
    request: files.UploadChangesRequest,
    requestOptions?: RequestOptions,
  ): Promise<files.UploadChangeReceipt>;
  /** Submits one sequenced page of deletes and renames, checking its receipt sequence. Addresses the resource by stable identity. */
  uploadChangesById(
    address: string,
    operation: string,
    request: files.UploadChangesRequest,
    requestOptions?: RequestOptions,
  ): Promise<files.UploadChangeReceipt>;
  /** Reads the byte paths replaced when publication was delivered to the running writer, each with where the uploaded copy landed when both copies are kept. */
  listUploadReplaced(
    address: string,
    operation: string,
    options?: storage.PageOptions,
    requestOptions?: RequestOptions,
  ): Promise<ListResponse<files.UploadReplacedPath>>;
  /** Reads the byte paths replaced when publication was delivered to the running writer, each with where the uploaded copy landed when both copies are kept. Addresses the resource by stable identity. */
  listUploadReplacedById(
    address: string,
    operation: string,
    options?: storage.PageOptions,
    requestOptions?: RequestOptions,
  ): Promise<ListResponse<files.UploadReplacedPath>>;
  /** Asks what a read of a saved file or tree would serve, reading no content. Addresses the resource by stable identity. */
  headContentById(
    address: string,
    kind: ContentKind,
    options: files.FileReadOptions,
    requestOptions?: RequestOptions,
  ): Promise<files.ContentFacts>;
  /** Opens one range of the bytes an entity tag names, or `undefined`, with the response discarded unread, when the answer is anything but exactly that range of those bytes. Addresses the resource by stable identity. */
  readContentRangeById(
    address: string,
    kind: ContentKind,
    options: files.FileReadOptions,
    range: files.ContentRange,
    requestOptions?: RequestOptions,
  ): Promise<files.StoredContent | undefined>;
  /** Opens a saved file's raw 32-byte piece hashes in order, with the file's entity tag; close the returned content. Addresses the resource by stable identity. */
  readFilePiecesById(
    address: string,
    options: files.FileReadOptions,
    requestOptions?: RequestOptions,
  ): Promise<files.StoredContent>;
  /** Creates a link that reads one saved file or directory at one version with no other credential; the link is handled as a secret. Addresses the resource by stable identity. */
  createFileDownloadLinkById(
    address: string,
    request: files.CreateFileDownloadLinkRequest,
    requestOptions?: RequestOptions,
  ): Promise<files.FileDownloadLink>;
  /** Reserves one immutable Upload sequence; equal retries return its transfer. */
  createUploadTransfer(
    address: string,
    operation: string,
    request: transfers.CreateUploadTransferRequest,
    requestOptions?: RequestOptions,
  ): Promise<transfers.UploadTransfer>;
  /** Reserves one immutable Upload sequence; equal retries return its transfer. Addresses the resource by stable identity. */
  createUploadTransferById(
    address: string,
    operation: string,
    request: transfers.CreateUploadTransferRequest,
    requestOptions?: RequestOptions,
  ): Promise<transfers.UploadTransfer>;
  /** Reads the durable accepted prefix and ingestion outcome. */
  getUploadTransfer(
    address: string,
    operation: string,
    transfer: string,
    requestOptions?: RequestOptions,
  ): Promise<transfers.UploadTransfer>;
  /** Reads the durable accepted prefix and ingestion outcome. Addresses the resource by stable identity. */
  getUploadTransferById(
    address: string,
    operation: string,
    transfer: string,
    requestOptions?: RequestOptions,
  ): Promise<transfers.UploadTransfer>;
  /** Sends one nonempty bounded part at its exact offset; equal bytes replay safely. */
  uploadTransferPart(
    address: string,
    operation: string,
    transfer: string,
    offset: Integer,
    sha256: string,
    body: Uint8Array,
    requestOptions?: RequestOptions,
  ): Promise<transfers.UploadTransfer>;
  /** Sends one nonempty bounded part at its exact offset; equal bytes replay safely. Addresses the resource by stable identity. */
  uploadTransferPartById(
    address: string,
    operation: string,
    transfer: string,
    offset: Integer,
    sha256: string,
    body: Uint8Array,
    requestOptions?: RequestOptions,
  ): Promise<transfers.UploadTransfer>;
  /** Seals exact length and digest without publishing the parent Upload. */
  completeUploadTransfer(
    address: string,
    operation: string,
    transfer: string,
    request: transfers.CompleteUploadTransferRequest,
    requestOptions?: RequestOptions,
  ): Promise<transfers.UploadTransfer>;
  /** Seals exact length and digest without publishing the parent Upload. Addresses the resource by stable identity. */
  completeUploadTransferById(
    address: string,
    operation: string,
    transfer: string,
    request: transfers.CompleteUploadTransferRequest,
    requestOptions?: RequestOptions,
  ): Promise<transfers.UploadTransfer>;
  /** Sends bounded parts and verifies accepted bytes from the source beginning on resume. */
  uploadFile(
    address: string,
    operation: string,
    options: files.UploadFileOptions,
    body: ReadableStream<Uint8Array>,
    requestOptions?: UploadRequestOptions,
  ): Promise<files.UploadChangeReceipt>;
  /** Sends bounded parts and verifies accepted bytes from the source beginning on resume. Addresses the resource by stable identity. */
  uploadFileById(
    address: string,
    operation: string,
    options: files.UploadFileOptions,
    body: ReadableStream<Uint8Array>,
    requestOptions?: UploadRequestOptions,
  ): Promise<files.UploadChangeReceipt>;
  /** Sends a POSIX tar in bounded parts; the server validates entries and resume verifies the accepted prefix. */
  uploadArchive(
    address: string,
    operation: string,
    options: files.UploadArchiveOptions,
    body: ReadableStream<Uint8Array>,
    requestOptions?: UploadRequestOptions,
  ): Promise<files.UploadChangeReceipt>;
  /** Sends a POSIX tar in bounded parts; the server validates entries and resume verifies the accepted prefix. Addresses the resource by stable identity. */
  uploadArchiveById(
    address: string,
    operation: string,
    options: files.UploadArchiveOptions,
    body: ReadableStream<Uint8Array>,
    requestOptions?: UploadRequestOptions,
  ): Promise<files.UploadChangeReceipt>;
}

/**
 * The wire form of a submission: refused with a `TypeError` for a field its
 * shape does not declare or a value `validate` refuses, and otherwise
 * encoded and read back strictly, so nothing is sent that the strict
 * decoder would refuse.
 */
export function submission<T>(
  value: T,
  shape: Shape<T>,
  validate?: (value: T) => void,
): unknown {
  shape.unknownFields(value, "");
  validate?.(value);
  const encoded = shape.encode(value);
  decodeValue(encoded, shape, "strict");
  return encoded;
}

/**
 * `result`, when it names the operation that was read; a response naming
 * another is refused as an invalid response.
 */
export function sameOperation<T extends { readonly id: string }>(
  result: T,
  operation: string,
): T {
  if (result.id !== operation)
    throw new TransportError(
      "invalid_response",
      "operation response names a different identity",
    );
  return result;
}

type ResourcePath = (scope: NamespaceScope) => string;
/** Composes canonical storage operations with one existing placement/credential transport. */
export function storageMethods(
  context: PlacementContext,
  family: "computers",
): StorageMethods {
  function resourcePath(address: string, byId: boolean): ResourcePath {
    if (byId) {
      const id = parseComputerId(address);
      return (scope) => computerById(scope, id);
    }
    requireNonBlank(address, "computer name");
    return (scope) => namespaceResource(scope, family, address);
  }
  async function exchange<T>(
    path: ResourcePath,
    method: string,
    collection: string,
    shape: Shape<T>,
    requestOptions: RequestOptions,
    member?: string,
    suffix = "",
    query = "",
    body?: unknown,
  ): Promise<T> {
    const resolved = await resolvePlacement(
      context,
      signalOption(requestOptions.signal),
    );
    const value = await context.state.transport.json<unknown>(
      method,
      resolved.endpoint,
      storageChild(path(resolved.scope), collection, member, suffix) + query,
      {
        ...signalOption(requestOptions.signal),
        ...(body === undefined ? {} : { body }),
      },
    );
    return decodeValue(value, shape, "lenient");
  }
  /** The response of a read of one storage child, as it arrived. */
  async function served(
    path: ResourcePath,
    collection: string,
    query: string,
    options: RequestOptions,
    member?: string,
    suffix = "",
  ): Promise<unknown> {
    const resolved = await resolvePlacement(
      context,
      signalOption(options.signal),
    );
    return await context.state.transport.json<unknown>(
      "GET",
      resolved.endpoint,
      storageChild(path(resolved.scope), collection, member, suffix) + query,
      signalOption(options.signal),
    );
  }
  async function list<T>(
    path: ResourcePath,
    collection: string,
    decode: (value: unknown) => T,
    query: string,
    options: RequestOptions,
    member?: string,
    suffix = "",
  ): Promise<ListResponse<T>> {
    return readList(
      await served(path, collection, query, options, member, suffix),
      collection,
      decode,
    );
  }
  /** One page of saved children, with whether the files are syncing and the wait for the store when the listing states them. */
  async function listFiles(
    path: ResourcePath,
    options: files.FileListOptions,
    requestOptions: RequestOptions,
  ): Promise<fileStatus.FileListResponse> {
    submission(
      options,
      files.fileListOptionsShape,
      files.validateFileListOptions,
    );
    const value = await served(
      path,
      "files",
      fileListQuery(options),
      requestOptions,
    );
    const {
      items,
      totalCount,
      continue: next,
    } = readList(value, "files", files.decodeFileEntry);
    const { syncing, store } = asRecord(value);
    return {
      items,
      totalCount,
      ...(next === undefined ? {} : { continue: next }),
      ...(typeof syncing === "boolean" ? { syncing } : {}),
      ...(store === undefined || store === null
        ? {}
        : {
            store: decodeValue(store, fileStatus.fileStoreWaitShape, "lenient"),
          }),
    };
  }
  /** One answer of a file watch, refused when it names no cursor to ask again with. */
  async function watchFiles(
    path: ResourcePath,
    options: fileStatus.WatchFilesOptions,
    requestOptions: RequestOptions,
  ): Promise<fileStatus.WatchFilesResponse> {
    submission(
      options,
      fileStatus.watchFilesOptionsShape,
      fileStatus.validateWatchFilesOptions,
    );
    const answer = await exchange(
      path,
      "GET",
      "files/watch",
      fileStatus.watchFilesResponseShape,
      requestOptions,
      undefined,
      "",
      watchFilesQuery(options),
    );
    if (answer.cursor === "")
      throw new TransportError(
        "invalid_response",
        "file watch answer names no cursor",
      );
    return answer;
  }
  /** Where one content read goes, its options judged before any request. */
  async function contentTarget(
    path: ResourcePath,
    suffix: string,
    options: files.FileReadOptions,
    requestOptions: RequestOptions,
  ): Promise<{ readonly endpoint: string; readonly target: string }> {
    submission(
      options,
      files.fileReadOptionsShape,
      files.validateFileReadOptions,
    );
    const resolved = await resolvePlacement(
      context,
      signalOption(requestOptions.signal),
    );
    return {
      endpoint: resolved.endpoint,
      target: storageChild(path(resolved.scope), suffix) + fileQuery(options),
    };
  }
  async function read(
    path: ResourcePath,
    suffix: string,
    options: files.FileReadOptions,
    requestOptions: RequestOptions,
    accept: string,
  ): Promise<files.StoredContent> {
    const { endpoint, target } = await contentTarget(
      path,
      suffix,
      options,
      requestOptions,
    );
    return await storedContent(
      await context.state.transport.openContent(
        endpoint,
        target,
        accept,
        requestOptions.signal,
      ),
    );
  }
  async function readRange(
    path: ResourcePath,
    kind: ContentKind,
    options: files.FileReadOptions,
    range: files.ContentRange,
    requestOptions: RequestOptions,
  ): Promise<files.StoredContent | undefined> {
    const { suffix, accept } = CONTENT_ROUTES[kind];
    const { endpoint, target } = await contentTarget(
      path,
      suffix,
      options,
      requestOptions,
    );
    const response = await context.state.transport.openContent(
      endpoint,
      target,
      accept,
      requestOptions.signal,
      {
        range: `bytes=${String(range.offset)}-${String(range.offset + range.length - 1)}`,
        "if-range": range.etag,
      },
    );
    if (!servesRange(response, range)) {
      await response.body?.cancel();
      return undefined;
    }
    return await storedContent(response);
  }
  async function head(
    path: ResourcePath,
    kind: ContentKind,
    options: files.FileReadOptions,
    requestOptions: RequestOptions,
  ): Promise<files.ContentFacts> {
    const { endpoint, target } = await contentTarget(
      path,
      CONTENT_ROUTES[kind].suffix,
      options,
      requestOptions,
    );
    const response = await context.state.transport.openContent(
      endpoint,
      target,
      "*/*",
      requestOptions.signal,
      undefined,
      "HEAD",
    );
    const version = await savedVersion(response);
    const etag = response.headers.get("ETag");
    const length = response.headers.get("Content-Length");
    if (
      version === undefined ||
      etag === null ||
      length === null ||
      !/^[0-9]+$/u.test(length)
    )
      throw new TransportError(
        "invalid_response",
        "content response does not state its length, entity tag and version",
      );
    return { etag, size: Number(length), version };
  }
  async function createTransfer(
    path: ResourcePath,
    operation: string,
    creation: transfers.CreateUploadTransferRequest,
    options: RequestOptions,
  ): Promise<transfers.UploadTransfer> {
    const id = parseStorageOperationId(operation);
    const body = submission(
      creation,
      transfers.createUploadTransferRequestShape,
      transfers.validateCreateUploadTransferRequest,
    );
    const result = await exchange<transfers.UploadTransfer>(
      path,
      "POST",
      "uploads",
      transfers.uploadTransferShape,
      options,
      id,
      "transfers",
      "",
      body,
    );
    return checkUploadTransfer(result, undefined, creation.seq);
  }
  async function getTransfer(
    path: ResourcePath,
    operation: string,
    transfer: string,
    options: RequestOptions,
  ): Promise<transfers.UploadTransfer> {
    const id = parseStorageOperationId(operation);
    const child = parseStorageOperationId(transfer);
    return checkUploadTransfer(
      await exchange(
        path,
        "GET",
        "uploads",
        transfers.uploadTransferShape,
        options,
        id,
        `transfers/${child}`,
      ),
      child,
    );
  }
  async function partTransfer(
    path: ResourcePath,
    operation: string,
    transfer: string,
    offset: Integer,
    digest: string,
    body: Uint8Array,
    options: RequestOptions,
  ): Promise<transfers.UploadTransfer> {
    const id = parseStorageOperationId(operation);
    const child = parseStorageOperationId(transfer);
    if (
      !isUint64(offset) ||
      !(body instanceof Uint8Array) ||
      body.byteLength === 0 ||
      BigInt(offset) + BigInt(body.byteLength) > 18446744073709551615n
    )
      throw new TypeError(
        "upload part must be nonempty and its end must fit uint64",
      );
    if (!transfers.validUploadSHA256(digest) || sha256Hex(body) !== digest)
      throw new TypeError("upload part SHA-256 differs from its bytes");
    const resolved = await resolvePlacement(
      context,
      signalOption(options.signal),
    );
    // A part is already in memory, so it is sent as bytes: a streaming
    // request body is not supported by every browser.
    const content = new Uint8Array(body);
    const wire = await context.state.transport.sendContent(
      resolved.endpoint,
      storageChild(
        path(resolved.scope),
        "uploads",
        id,
        `transfers/${child}/parts/${integerText(offset)}`,
      ) + `?sha256=${digest}`,
      "application/octet-stream",
      content,
      options.signal,
    );
    return checkUploadTransfer(transfers.decodeUploadTransfer(wire), child);
  }
  async function completeTransfer(
    path: ResourcePath,
    operation: string,
    transfer: string,
    completion: transfers.CompleteUploadTransferRequest,
    options: RequestOptions,
  ): Promise<transfers.UploadTransfer> {
    const id = parseStorageOperationId(operation);
    const child = parseStorageOperationId(transfer);
    const body = submission(
      completion,
      transfers.completeUploadTransferRequestShape,
      transfers.validateCompleteUploadTransferRequest,
    );
    return checkUploadTransfer(
      await exchange(
        path,
        "POST",
        "uploads",
        transfers.uploadTransferShape,
        options,
        id,
        `transfers/${child}/complete`,
        "",
        body,
      ),
      child,
    );
  }
  async function streamUpload(
    path: ResourcePath,
    operation: string,
    options: files.UploadArchiveOptions | files.UploadFileOptions,
    body: ReadableStream<Uint8Array>,
    requestOptions: UploadRequestOptions,
    archive: boolean,
  ): Promise<files.UploadChangeReceipt> {
    requireContentStream(body);
    parseStorageOperationId(operation);
    if (archive)
      submission(
        options,
        files.uploadArchiveOptionsShape,
        files.validateUploadArchiveOptions,
      );
    else
      submission(
        options as files.UploadFileOptions,
        files.uploadFileOptionsShape,
        files.validateUploadFileOptions,
      );
    const creation: transfers.CreateUploadTransferRequest = {
      ...options,
      kind: archive ? "archive" : "file",
    };
    return await uploadStream(
      creation,
      body,
      {
        create: (value) =>
          createTransfer(path, operation, value, requestOptions),
        get: (id) => getTransfer(path, operation, id, requestOptions),
        part: (id, offset, digest, content) =>
          partTransfer(
            path,
            operation,
            id,
            offset,
            digest,
            content,
            requestOptions,
          ),
        complete: (id, value) =>
          completeTransfer(path, operation, id, value, requestOptions),
      },
      requestOptions.signal ?? new AbortController().signal,
      requestOptions.accepted,
    );
  }
  return {
    async createUploadTransfer(address, operation, creation, options = {}) {
      return await createTransfer(
        resourcePath(address, false),
        operation,
        creation,
        options,
      );
    },
    async createUploadTransferById(address, operation, creation, options = {}) {
      return await createTransfer(
        resourcePath(address, true),
        operation,
        creation,
        options,
      );
    },
    async getUploadTransfer(address, operation, transfer, options = {}) {
      return await getTransfer(
        resourcePath(address, false),
        operation,
        transfer,
        options,
      );
    },
    async getUploadTransferById(address, operation, transfer, options = {}) {
      return await getTransfer(
        resourcePath(address, true),
        operation,
        transfer,
        options,
      );
    },
    async uploadTransferPart(
      address,
      operation,
      transfer,
      offset,
      digest,
      body,
      options = {},
    ) {
      return await partTransfer(
        resourcePath(address, false),
        operation,
        transfer,
        offset,
        digest,
        body,
        options,
      );
    },
    async uploadTransferPartById(
      address,
      operation,
      transfer,
      offset,
      digest,
      body,
      options = {},
    ) {
      return await partTransfer(
        resourcePath(address, true),
        operation,
        transfer,
        offset,
        digest,
        body,
        options,
      );
    },
    async completeUploadTransfer(
      address,
      operation,
      transfer,
      completion,
      options = {},
    ) {
      return await completeTransfer(
        resourcePath(address, false),
        operation,
        transfer,
        completion,
        options,
      );
    },
    async completeUploadTransferById(
      address,
      operation,
      transfer,
      completion,
      options = {},
    ) {
      return await completeTransfer(
        resourcePath(address, true),
        operation,
        transfer,
        completion,
        options,
      );
    },
    async listVersions(address, options = {}, requestOptions = {}) {
      const path = resourcePath(address, false);
      submission(options, storage.pageOptionsShape);
      return await list(
        path,
        "versions",
        storage.decodeVersion,
        pageQuery(options),
        requestOptions,
      );
    },
    async getVersionById(address, version, requestOptions = {}) {
      requireNonBlank(version, "version");
      return await exchange(
        resourcePath(address, true),
        "GET",
        "versions",
        storage.versionShape,
        requestOptions,
        version,
      );
    },
    async listVersionsById(address, options = {}, requestOptions = {}) {
      const path = resourcePath(address, true);
      submission(options, storage.pageOptionsShape);
      return await list(
        path,
        "versions",
        storage.decodeVersion,
        pageQuery(options),
        requestOptions,
      );
    },
    async updateVersion(address, number, request, requestOptions = {}) {
      const path = resourcePath(address, false);
      if (!isInt64(number) || number < 0)
        throw new TypeError("version must be a non-negative integer");
      return await exchange(
        path,
        "PATCH",
        "versions",
        storage.versionShape,
        requestOptions,
        integerText(number),
        "",
        "",
        submission(request, storage.updateVersionRequestShape),
      );
    },
    async updateVersionById(address, number, request, requestOptions = {}) {
      const path = resourcePath(address, true);
      if (!isInt64(number) || number < 0)
        throw new TypeError("version must be a non-negative integer");
      return await exchange(
        path,
        "PATCH",
        "versions",
        storage.versionShape,
        requestOptions,
        integerText(number),
        "",
        "",
        submission(request, storage.updateVersionRequestShape),
      );
    },
    async createCommit(address, request, requestOptions = {}) {
      const path = resourcePath(address, false);
      const result = await exchange(
        path,
        "POST",
        "commits",
        storage.commitShape,
        requestOptions,
        undefined,
        "",
        "",
        submission(request, storage.createCommitRequestShape),
      );
      return result;
    },
    async createCommitById(address, request, requestOptions = {}) {
      const path = resourcePath(address, true);
      const result = await exchange(
        path,
        "POST",
        "commits",
        storage.commitShape,
        requestOptions,
        undefined,
        "",
        "",
        submission(request, storage.createCommitRequestShape),
      );
      return result;
    },
    async getCommit(address, operation, requestOptions = {}) {
      const path = resourcePath(address, false);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "GET",
        "commits",
        storage.commitShape,
        requestOptions,
        id,
        "",
        "",
        undefined,
      );
      return sameOperation(result, id);
    },
    async getCommitById(address, operation, requestOptions = {}) {
      const path = resourcePath(address, true);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "GET",
        "commits",
        storage.commitShape,
        requestOptions,
        id,
        "",
        "",
        undefined,
      );
      return sameOperation(result, id);
    },
    async createRestore(address, request, requestOptions = {}) {
      const path = resourcePath(address, false);
      const result = await exchange(
        path,
        "POST",
        "restores",
        storage.restoreShape,
        requestOptions,
        undefined,
        "",
        "",
        submission(
          request,
          storage.createRestoreRequestShape,
          storage.validateCreateRestoreRequest,
        ),
      );
      return result;
    },
    async createRestoreById(address, request, requestOptions = {}) {
      const path = resourcePath(address, true);
      const result = await exchange(
        path,
        "POST",
        "restores",
        storage.restoreShape,
        requestOptions,
        undefined,
        "",
        "",
        submission(
          request,
          storage.createRestoreRequestShape,
          storage.validateCreateRestoreRequest,
        ),
      );
      return result;
    },
    async getRestore(address, operation, requestOptions = {}) {
      const path = resourcePath(address, false);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "GET",
        "restores",
        storage.restoreShape,
        requestOptions,
        id,
        "",
        "",
        undefined,
      );
      return sameOperation(result, id);
    },
    async getRestoreById(address, operation, requestOptions = {}) {
      const path = resourcePath(address, true);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "GET",
        "restores",
        storage.restoreShape,
        requestOptions,
        id,
        "",
        "",
        undefined,
      );
      return sameOperation(result, id);
    },
    async listFiles(address, options, requestOptions = {}) {
      return await listFiles(
        resourcePath(address, false),
        options,
        requestOptions,
      );
    },
    async listFilesById(address, options, requestOptions = {}) {
      return await listFiles(
        resourcePath(address, true),
        options,
        requestOptions,
      );
    },
    async watchFiles(address, options, requestOptions = {}) {
      return await watchFiles(
        resourcePath(address, false),
        options,
        requestOptions,
      );
    },
    async watchFilesById(address, options, requestOptions = {}) {
      return await watchFiles(
        resourcePath(address, true),
        options,
        requestOptions,
      );
    },
    async createUpload(address, request, requestOptions = {}) {
      const path = resourcePath(address, false);
      const result = await exchange(
        path,
        "POST",
        "uploads",
        files.uploadShape,
        requestOptions,
        undefined,
        "",
        "",
        submission(
          request,
          files.createUploadRequestShape,
          files.validateCreateUploadRequest,
        ),
      );
      return result;
    },
    async createUploadById(address, request, requestOptions = {}) {
      const path = resourcePath(address, true);
      const result = await exchange(
        path,
        "POST",
        "uploads",
        files.uploadShape,
        requestOptions,
        undefined,
        "",
        "",
        submission(
          request,
          files.createUploadRequestShape,
          files.validateCreateUploadRequest,
        ),
      );
      return result;
    },
    async getUpload(address, operation, requestOptions = {}) {
      const path = resourcePath(address, false);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "GET",
        "uploads",
        files.uploadShape,
        requestOptions,
        id,
        "",
        "",
        undefined,
      );
      return sameOperation(result, id);
    },
    async getUploadById(address, operation, requestOptions = {}) {
      const path = resourcePath(address, true);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "GET",
        "uploads",
        files.uploadShape,
        requestOptions,
        id,
        "",
        "",
        undefined,
      );
      return sameOperation(result, id);
    },
    async cancelUpload(address, operation, requestOptions = {}) {
      const path = resourcePath(address, false);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "DELETE",
        "uploads",
        files.uploadShape,
        requestOptions,
        id,
        "",
        "",
        undefined,
      );
      return sameOperation(result, id);
    },
    async cancelUploadById(address, operation, requestOptions = {}) {
      const path = resourcePath(address, true);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "DELETE",
        "uploads",
        files.uploadShape,
        requestOptions,
        id,
        "",
        "",
        undefined,
      );
      return sameOperation(result, id);
    },
    async publishUpload(address, operation, request, requestOptions = {}) {
      const path = resourcePath(address, false);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "POST",
        "uploads",
        files.uploadShape,
        requestOptions,
        id,
        "publish",
        "",
        submission(request, files.publishUploadRequestShape),
      );
      return sameOperation(result, id);
    },
    async publishUploadById(address, operation, request, requestOptions = {}) {
      const path = resourcePath(address, true);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "POST",
        "uploads",
        files.uploadShape,
        requestOptions,
        id,
        "publish",
        "",
        submission(request, files.publishUploadRequestShape),
      );
      return sameOperation(result, id);
    },
    async uploadChanges(address, operation, request, requestOptions = {}) {
      const path = resourcePath(address, false);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "POST",
        "uploads",
        files.uploadChangeReceiptShape,
        requestOptions,
        id,
        "changes",
        "",
        submission(
          request,
          files.uploadChangesRequestShape,
          files.validateUploadChangesRequest,
        ),
      );
      if (!integerEqual(result.seq, request.seq))
        throw new TransportError(
          "invalid_response",
          "change receipt names a different sequence",
        );
      return result;
    },
    async uploadChangesById(address, operation, request, requestOptions = {}) {
      const path = resourcePath(address, true);
      const id = parseStorageOperationId(operation);
      const result = await exchange(
        path,
        "POST",
        "uploads",
        files.uploadChangeReceiptShape,
        requestOptions,
        id,
        "changes",
        "",
        submission(
          request,
          files.uploadChangesRequestShape,
          files.validateUploadChangesRequest,
        ),
      );
      if (!integerEqual(result.seq, request.seq))
        throw new TransportError(
          "invalid_response",
          "change receipt names a different sequence",
        );
      return result;
    },
    async listUploadReplaced(
      address,
      operation,
      options = {},
      requestOptions = {},
    ) {
      const path = resourcePath(address, false);
      const id = parseStorageOperationId(operation);
      return await list(
        path,
        "uploads",
        (value) => decodeValue(value, files.uploadReplacedPathShape, "lenient"),
        pageQuery(options),
        requestOptions,
        id,
        "replaced",
      );
    },
    async listUploadReplacedById(
      address,
      operation,
      options = {},
      requestOptions = {},
    ) {
      const path = resourcePath(address, true);
      const id = parseStorageOperationId(operation);
      return await list(
        path,
        "uploads",
        (value) => decodeValue(value, files.uploadReplacedPathShape, "lenient"),
        pageQuery(options),
        requestOptions,
        id,
        "replaced",
      );
    },
    async headContentById(address, kind, options, requestOptions = {}) {
      return await head(
        resourcePath(address, true),
        kind,
        options,
        requestOptions,
      );
    },
    async readContentRangeById(
      address,
      kind,
      options,
      range,
      requestOptions = {},
    ) {
      return await readRange(
        resourcePath(address, true),
        kind,
        options,
        range,
        requestOptions,
      );
    },
    async readFilePiecesById(address, options, requestOptions = {}) {
      return await read(
        resourcePath(address, true),
        "files/pieces",
        options,
        requestOptions,
        "application/octet-stream",
      );
    },
    async createFileDownloadLinkById(address, request, requestOptions = {}) {
      const body = submission(
        request,
        files.createFileDownloadLinkRequestShape,
        files.validateCreateFileDownloadLinkRequest,
      );
      return await exchange(
        resourcePath(address, true),
        "POST",
        "files",
        files.fileDownloadLinkShape,
        requestOptions,
        "download-link",
        "",
        "",
        body,
      );
    },
    async uploadFile(address, operation, options, body, requestOptions = {}) {
      const path = resourcePath(address, false);
      return await streamUpload(
        path,
        operation,
        options,
        body,
        requestOptions,
        false,
      );
    },
    async uploadFileById(
      address,
      operation,
      options,
      body,
      requestOptions = {},
    ) {
      const path = resourcePath(address, true);
      return await streamUpload(
        path,
        operation,
        options,
        body,
        requestOptions,
        false,
      );
    },
    async uploadArchive(
      address,
      operation,
      options,
      body,
      requestOptions = {},
    ) {
      const path = resourcePath(address, false);
      return await streamUpload(
        path,
        operation,
        options,
        body,
        requestOptions,
        true,
      );
    },
    async uploadArchiveById(
      address,
      operation,
      options,
      body,
      requestOptions = {},
    ) {
      const path = resourcePath(address, true);
      return await streamUpload(
        path,
        operation,
        options,
        body,
        requestOptions,
        true,
      );
    },
  };
}

/** The saved version a content response states, if it states one. */
async function savedVersion(response: Response): Promise<Integer | undefined> {
  const raw = response.headers.get("Idyl-Saved-Version");
  if (raw === null) return undefined;
  if (
    !/^[+-]?[0-9]+$/u.test(raw) ||
    !isInt64(BigInt(raw)) ||
    BigInt(raw) < 0n
  ) {
    await response.body?.cancel();
    throw new TransportError(
      "invalid_response",
      "content response has an invalid saved version",
    );
  }
  return numberOrBigInt(BigInt(raw));
}

/** Whether a response is exactly `range` of the bytes its entity tag names. */
function servesRange(response: Response, range: files.ContentRange): boolean {
  const served = /^bytes ([0-9]+)-([0-9]+)\/[0-9]+$/u.exec(
    response.headers.get("Content-Range") ?? "",
  );
  return (
    response.status === 206 &&
    response.headers.get("ETag") === range.etag &&
    Number(served?.[1]) === range.offset &&
    Number(served?.[2]) === range.offset + range.length - 1
  );
}

/** Takes ownership of a content response's body as one closeable stream. */
async function storedContent(response: Response): Promise<files.StoredContent> {
  const version = await savedVersion(response);
  if (response.body === null)
    throw new TransportError(
      "invalid_response",
      "content response has no body",
    );
  const reader = response.body.getReader();
  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (closed) {
          controller.close();
          return;
        }
        try {
          const value = await reader.read();
          if (value.done) {
            closed = true;
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(value.value);
        } catch (error) {
          closed = true;
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel() {
        await close();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    etag: response.headers.get("ETag") ?? "",
    ...(version === undefined ? {} : { version }),
    close,
  };
}

function requireContentStream(
  value: unknown,
): asserts value is ReadableStream<Uint8Array> {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { getReader?: unknown }).getReader !== "function"
  )
    throw new TypeError("content stream is required");
}
