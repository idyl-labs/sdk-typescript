// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "../resource/json.js";
import type { StorageOperationId } from "../resource/uuid-id.js";
import {
  always,
  decodeValue,
  integer,
  integerText,
  isUint64,
  jsonObject,
  numberOrBigInt,
  object,
  omitEmpty,
  omitZero,
  pointer,
  scalar,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import {
  filePathFields,
  uploadChangeReceiptShape,
  validateUploadArchiveOptions,
  validateUploadFileOptions,
  type FilePath,
  type UploadChangeReceipt,
} from "./files.js";
import type { ErrorResponse } from "./types.js";

/** Selects one file or POSIX tar stream within an Upload sequence. */
export type UploadTransferKind =
  "file" | "archive" | (string & Record<never, never>);
/** Reports durable receipt and ingestion; newer tokens remain readable. */
export type UploadTransferState =
  | "receiving"
  | "processing"
  | "complete"
  | "failed"
  | (string & Record<never, never>);
/** Reserves an Upload sequence. Equal sequence, kind, path and mode retries return the same transfer. */
export interface CreateUploadTransferRequest extends FilePath {
  readonly seq: Integer;
  readonly kind: UploadTransferKind;
  readonly mode?: number;
}
/** Records a contiguous plaintext prefix. Completion carries one accepted change receipt and does not publish the parent Upload. */
export interface UploadTransfer {
  readonly id: StorageOperationId;
  readonly seq: Integer;
  readonly state: UploadTransferState;
  readonly nextOffset: Integer;
  readonly prefixSHA256: string;
  readonly maxPartBytes: Integer;
  readonly receipt?: UploadChangeReceipt;
  readonly failure?: ErrorResponse;
}
/** Seals the exact length and digest. Equal retries retain the outcome; processing is polled until ingestion completes. */
export interface CompleteUploadTransferRequest {
  readonly length: Integer;
  readonly sha256: string;
}

/** Requires a supported stream kind before submission. */
export function validateUploadTransferKind(value: UploadTransferKind): void {
  if (value !== "file" && value !== "archive")
    throw new TypeError("unknown upload transfer kind");
}
/** Requires a recognized lifecycle state before acting on a response. */
export function validateUploadTransferState(value: UploadTransferState): void {
  if (!["receiving", "processing", "complete", "failed"].includes(value))
    throw new TypeError("unknown upload transfer state");
}
/** Tests the canonical lowercase hexadecimal spelling, without hashing bytes. */
export function validUploadSHA256(value: string): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
/** Checks the same path, permissions and sequence as its file or archive stream. */
export function validateCreateUploadTransferRequest(
  request: CreateUploadTransferRequest,
): void {
  validateUploadTransferKind(request.kind);
  if (request.kind === "file")
    validateUploadFileOptions({ ...request, mode: request.mode ?? 0 });
  else {
    if (request.mode !== undefined && request.mode !== 0)
      throw new TypeError("archive transfer has no file mode");
    validateUploadArchiveOptions(request);
  }
}
/** Requires an exact uint64 byte length and canonical SHA-256 spelling. */
export function validateCompleteUploadTransferRequest(
  request: CompleteUploadTransferRequest,
): void {
  if (!isUint64(request.length))
    throw new TypeError("upload length must fit uint64");
  if (!validUploadSHA256(request.sha256))
    throw new TypeError(
      "upload SHA-256 must be 64 lowercase hexadecimal digits",
    );
}

// Byte counts are exact unsigned decimal JSON strings, including zero.
const byteCountShape: Shape<Integer> = scalar({
  decode(value) {
    if (
      !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
      BigInt(value) > 18446744073709551615n
    )
      throw new TypeError("upload byte count must fit uint64");
    return numberOrBigInt(BigInt(value));
  },
  encode(value) {
    if (!isUint64(value))
      throw new TypeError("upload byte count must fit uint64");
    return integerText(value);
  },
  zero: () => 0,
  isZero: (value) => value === 0 || value === 0n,
});
const failureShape: Shape<ErrorResponse> = object<ErrorResponse>({
  error: always(string()),
  code: omitEmpty(string()),
  details: omitEmpty(jsonObject()),
});
/** The canonical creation request shape. */
export const createUploadTransferRequestShape: Shape<CreateUploadTransferRequest> =
  object({
    ...filePathFields,
    seq: always(integer({ unsigned: true, bits: 64 })),
    kind: always(string<UploadTransferKind>()),
    mode: omitZero(integer({ unsigned: true, bits: 32 })),
  });
/** The canonical transfer response shape, preserving exact byte counts. */
const transferShape: Shape<UploadTransfer> = object({
  id: always(string<StorageOperationId>()),
  seq: always(integer({ unsigned: true, bits: 64 })),
  state: always(string<UploadTransferState>()),
  nextOffset: always(byteCountShape),
  prefixSHA256: always(string()),
  maxPartBytes: always(byteCountShape),
  receipt: pointer(uploadChangeReceiptShape),
  failure: pointer(failureShape),
});
// Prefix offsets and budgets drive source reads and allocations. They must
// retain their exact decimal-string wire form even on a lenient observation.
export const uploadTransferShape: Shape<UploadTransfer> = {
  ...transferShape,
  decode(value, path, mode) {
    const result = transferShape.decode(value, path, mode);
    const raw = value as Record<string, unknown>;
    return {
      ...result,
      nextOffset: byteCountShape.decode(
        raw["nextOffset"],
        `${path}.nextOffset`,
      ),
      maxPartBytes: byteCountShape.decode(
        raw["maxPartBytes"],
        `${path}.maxPartBytes`,
      ),
    };
  },
};
/** The canonical completion request shape. */
export const completeUploadTransferRequestShape: Shape<CompleteUploadTransferRequest> =
  object({
    length: always(byteCountShape),
    sha256: always(string()),
  });
/** Reads a transfer while accepting newer fields and tokens. */
export function decodeUploadTransfer(value: unknown): UploadTransfer {
  return decodeValue(value, uploadTransferShape, "lenient");
}
/** Writes canonical transfer JSON, including exact decimal byte strings. */
export function encodeUploadTransfer(value: UploadTransfer): unknown {
  return uploadTransferShape.encode(value);
}
