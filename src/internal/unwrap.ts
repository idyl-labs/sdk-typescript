// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The judgement a response envelope receives when a service hands back one
 * of its fields rather than the envelope itself, as the reference contract's identity
 * services do. The response is read leniently and carried as it arrived;
 * what is judged is only what the caller is handed: a collection is an
 * array, absent or null reading as empty, and an object is an object.
 */
import { TransportError } from "../errors.js";
import { isRecord } from "./envelopes.js";

/**
 * The collection under `key` of the envelope `response`. An absent or null
 * collection reads as empty. Throws an `Error` prefixed
 * `invalid <label> response` when the envelope is not an object or the
 * collection is not an array.
 */
export function unwrapCollection(
  response: unknown,
  key: string,
  label: string,
): readonly unknown[] {
  const value: unknown = envelope(response, label)[key] ?? [];
  if (!Array.isArray(value)) {
    throw new TransportError(
      "invalid_response",
      `invalid ${label} response: ${key} must be an array`,
    );
  }
  return value;
}

/**
 * The object under `key` of the envelope `response`. Throws an `Error`
 * prefixed `invalid <label> response` when the envelope is not an object or
 * the field is absent or not an object.
 */
export function unwrapObject(
  response: unknown,
  key: string,
  label: string,
): unknown {
  const value: unknown = envelope(response, label)[key];
  if (!isRecord(value)) {
    throw new TransportError(
      "invalid_response",
      `invalid ${label} response: ${key} must be an object`,
    );
  }
  return value;
}

function envelope(response: unknown, label: string): Record<string, unknown> {
  if (!isRecord(response)) {
    throw new TransportError(
      "invalid_response",
      `invalid ${label} response: expected an object`,
    );
  }
  return response;
}
