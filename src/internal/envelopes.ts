// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { TransportError } from "../errors.js";
import { isInt64, numberOrBigInt } from "./strictdecode.js";
/*
 * The judgement every list envelope receives before its items are handed
 * back. A response is read leniently and carried as it arrived; what is
 * judged is only what the SDK needs to hand back a usable page: `items` is
 * an array, absent or null reading as empty, and `totalCount` is an
 * integer, absent reading as zero.
 */
import type { ListEnvelope } from "../api/types.js";
import type { Integer } from "../resource/json.js";

/**
 * Reads a list envelope, throwing an `Error` prefixed `invalid list
 * <plural> response` when it is not one. Each item is handed back as it
 * arrived; `judgeItem`, when given, is called with each item and its index
 * and throws for one the caller cannot use.
 */
export function listEnvelope<T, Count = Integer>(
  response: unknown,
  plural: string,
  judgeItem?: (item: unknown, index: number) => void,
  decodeCount?: (value: unknown) => Count,
): ListEnvelope<T, Count> {
  const envelope = asRecord(response);
  const rawItems: unknown = envelope["items"] ?? [];
  if (!Array.isArray(rawItems)) {
    throw new TransportError(
      "invalid_response",
      `invalid list ${plural} response: items must be an array`,
    );
  }
  const items: readonly unknown[] = rawItems;
  const rawCount = envelope["totalCount"] ?? 0;
  if (decodeCount === undefined && !isInt64(rawCount)) {
    throw new TransportError(
      "invalid_response",
      `invalid list ${plural} response: totalCount must be an integer`,
    );
  }
  if (judgeItem !== undefined) {
    items.forEach((item: unknown, index) => {
      judgeItem(item, index);
    });
  }
  const snapshotCursor = envelope["snapshotCursor"];
  const position = envelope["continue"];
  return {
    items: items as readonly T[],
    totalCount:
      decodeCount === undefined
        ? (numberOrBigInt(BigInt(rawCount as Integer)) as Count)
        : decodeCount(envelope["totalCount"]),
    ...(typeof snapshotCursor === "string" && snapshotCursor !== ""
      ? { snapshotCursor }
      : {}),
    ...(typeof position === "string" && position !== ""
      ? { continue: position }
      : {}),
  };
}

/** Whether `value` is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `value` as a record, or an empty one when it is not an object. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * A response envelope with the field `key` read through `decode`, the
 * lenient typed decoder of the kind it carries; everything else in the
 * envelope is carried as it arrived.
 */
export function readEnvelope<K extends string, T>(
  response: unknown,
  key: K,
  decode: (document: unknown) => T,
): Record<string, unknown> & Record<K, T> {
  const envelope = asRecord(response);
  return {
    ...envelope,
    [key]: served(key, () => decode(envelope[key])),
  } as Record<string, unknown> & Record<K, T>;
}

/** A paged list whose items are read through `decode`, the lenient typed decoder of their kind. */
export function readList<T, Count = Integer>(
  response: unknown,
  plural: string,
  decode: (document: unknown) => T,
  decodeCount?: (value: unknown) => Count,
): ListEnvelope<T, Count> {
  const page = listEnvelope<unknown, Count>(
    response,
    plural,
    undefined,
    decodeCount,
  );
  return {
    ...page,
    items: page.items.map((item) =>
      served(plural, () => {
        if (!isRecord(item)) {
          throw new TransportError(
            "invalid_response",
            `invalid list ${plural} response: an item is not an object`,
          );
        }
        return decode(item);
      }),
    ),
  };
}

/**
 * Runs a decoder over served data. A document it cannot read at all is the
 * platform's fault, never the caller's, so it is an `invalid_response`
 * `TransportError` with a fixed sentence naming only the field.
 */
export function served<T>(field: string, decode: () => T): T {
  try {
    return decode();
  } catch (cause) {
    if (cause instanceof TransportError) throw cause;
    throw new TransportError("invalid_response", `invalid ${field} response`, {
      cause,
    });
  }
}
