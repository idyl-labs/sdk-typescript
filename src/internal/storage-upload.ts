// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  ApiError,
  UploadTransferFailedError,
  TransportError,
} from "../errors.js";
import { Sha256, sha256Hex } from "../resource/sha256.js";
import { parseStorageOperationId } from "../resource/uuid-id.js";
import { integerEqual, isUint64 } from "./strictdecode.js";
import { abortable, delay } from "./abort.js";
import { isFetchFailure } from "./transport.js";
import {
  validUploadSHA256,
  validateUploadTransferState,
  type CreateUploadTransferRequest,
  type UploadTransfer,
  type CompleteUploadTransferRequest,
} from "../api/upload-transfer.js";
import type { UploadChangeReceipt } from "../api/files.js";

export interface UploadTransferCalls {
  create(request: CreateUploadTransferRequest): Promise<UploadTransfer>;
  get(id: string): Promise<UploadTransfer>;
  part(
    id: string,
    offset: bigint,
    digest: string,
    body: Uint8Array,
  ): Promise<UploadTransfer>;
  complete(
    id: string,
    request: CompleteUploadTransferRequest,
  ): Promise<UploadTransfer>;
}
export function checkUploadTransfer(
  value: UploadTransfer,
  id?: string,
  seq?: number | bigint,
): UploadTransfer {
  parseStorageOperationId(value.id);
  if (id !== undefined && value.id !== id)
    throw new TransportError(
      "invalid_response",
      "upload transfer response names a different identity",
    );
  if (!isUint64(value.nextOffset) || !isUint64(value.maxPartBytes))
    throw new TransportError(
      "invalid_response",
      "upload transfer response has invalid byte counts",
    );
  if (
    !isUint64(value.seq) ||
    value.seq <= 0 ||
    (seq !== undefined && !integerEqual(value.seq, seq)) ||
    (value.receipt !== undefined && !integerEqual(value.receipt.seq, value.seq))
  )
    throw new TransportError(
      "invalid_response",
      "upload transfer response names a different sequence",
    );
  return value;
}
function retryable(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (error instanceof ApiError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  return isFetchFailure(error);
}
async function retry<T>(
  call: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      if (attempt === 2 || !retryable(error, signal)) throw error;
      await delay(
        Math.max(
          (attempt + 1) * 100,
          error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0,
        ),
        signal,
      );
    }
  }
}
function progress(
  value: UploadTransfer,
  id: string,
  seq: number | bigint,
  offset: bigint,
  digest: string,
): void {
  checkUploadTransfer(value, id, seq);
  validateUploadTransferState(value.state);
  if (value.state === "failed") throw new UploadTransferFailedError(value);
  if (BigInt(value.nextOffset) !== offset || value.prefixSHA256 !== digest)
    throw new TransportError(
      "invalid_response",
      "upload transfer progress differs from the verified source prefix",
    );
  if (value.maxPartBytes <= 0)
    throw new TransportError(
      "invalid_response",
      "upload transfer response has a zero part budget",
    );
  if (value.state === "complete" && value.receipt === undefined)
    throw new TransportError(
      "invalid_response",
      "completed upload transfer has no change receipt",
    );
}
const MAX_PART_BYTES = 4 * 1024 * 1024;
const UINT64_MAX = 18446744073709551615n;

/**
 * Retains one bounded part and verifies every accepted prefix against the
 * source from byte zero. `accepted` receives the byte count the platform
 * holds after the verified prefix and after each accepted part; an exception
 * it throws ends the upload with that exception.
 */
export async function uploadStream(
  request: CreateUploadTransferRequest,
  body: ReadableStream<Uint8Array>,
  calls: UploadTransferCalls,
  signal: AbortSignal,
  accepted?: (bytes: bigint) => void,
): Promise<UploadChangeReceipt> {
  let value = await retry(() => calls.create(request), signal);
  checkUploadTransfer(value, undefined, request.seq);
  validateUploadTransferState(value.state);
  if (value.state === "failed") throw new UploadTransferFailedError(value);
  if (!validUploadSHA256(value.prefixSHA256) || value.maxPartBytes <= 0)
    throw new TransportError(
      "invalid_response",
      "upload transfer has invalid prefix metadata",
    );
  const id = value.id;
  const reader = body.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  let eof = false;
  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  async function readPart(length: number): Promise<Uint8Array> {
    const part = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      signal.throwIfAborted();
      if (pending.byteLength === 0) {
        if (eof) break;
        const read = await abortable(reader.read(), signal);
        if (read.done) {
          eof = true;
          break;
        }
        if (!(read.value instanceof Uint8Array))
          throw new TypeError("upload source must yield Uint8Array chunks");
        pending = read.value;
      }
      const copied = Math.min(length - filled, pending.byteLength);
      part.set(pending.subarray(0, copied), filled);
      pending = pending.subarray(copied);
      filled += copied;
    }
    return part.subarray(0, filled);
  }
  function sourceEnded(): boolean {
    return eof;
  }
  function budget(): number {
    return Number(
      BigInt(value.maxPartBytes) < BigInt(MAX_PART_BYTES)
        ? BigInt(value.maxPartBytes)
        : BigInt(MAX_PART_BYTES),
    );
  }
  try {
    signal.throwIfAborted();
    const hash = new Sha256();
    let offset = BigInt(value.nextOffset);
    for (let remaining = offset; remaining !== 0n;) {
      const size = Number(
        remaining < BigInt(budget()) ? remaining : BigInt(budget()),
      );
      const part = await readPart(size);
      if (part.byteLength !== size)
        throw new TypeError(
          "source is shorter than the accepted upload prefix",
        );
      hash.update(part);
      remaining -= BigInt(part.byteLength);
    }
    progress(value, id, request.seq, offset, hash.hex());
    accepted?.(offset);
    for (;;) {
      const part = await readPart(budget());
      if (part.byteLength !== 0) {
        if (value.state !== "receiving")
          throw new TypeError(
            "source is longer than the sealed upload transfer",
          );
        const next = offset + BigInt(part.byteLength);
        if (next > UINT64_MAX)
          throw new TypeError("upload stream length overflows uint64");
        const before = hash.hex();
        hash.update(part);
        const after = hash.hex();
        const digest = sha256Hex(part);
        value = await retry(async () => {
          try {
            return await calls.part(id, offset, digest, part);
          } catch (error) {
            if (retryable(error, signal)) {
              let observed: UploadTransfer | undefined;
              try {
                observed = await calls.get(id);
              } catch (readError) {
                if (!retryable(readError, signal)) throw readError;
              }
              if (observed !== undefined) {
                if (BigInt(observed.nextOffset) === next) {
                  progress(observed, id, request.seq, next, after);
                  return observed;
                }
                progress(observed, id, request.seq, offset, before);
              }
            }
            throw error;
          }
        }, signal);
        progress(value, id, request.seq, next, after);
        offset = next;
        accepted?.(offset);
      }
      if (sourceEnded()) break;
    }
    if (value.state === "complete") return receipt(value);
    const sealed = { length: offset, sha256: hash.hex() };
    value = await retry(() => calls.complete(id, sealed), signal);
    for (;;) {
      progress(value, id, request.seq, offset, sealed.sha256);
      if (value.state === "complete") return receipt(value);
      if (value.state !== "processing")
        throw new TransportError(
          "invalid_response",
          "sealed upload transfer did not enter processing",
        );
      await delay(1000, signal);
      value = await retry(() => calls.get(id), signal);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function receipt(value: UploadTransfer): UploadChangeReceipt {
  if (value.receipt === undefined)
    throw new TransportError(
      "invalid_response",
      "completed upload transfer has no change receipt",
    );
  return value.receipt;
}
