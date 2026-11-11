// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { parseText, renderValue } from "../internal/strictdecode.js";

/**
 * An integral value. Values within the safe JavaScript range are normally
 * numbers; larger values are bigint so every digit remains exact.
 */
export type Integer = number | bigint;

/** A JSON scalar; bigint is written as an unquoted integral JSON number. */
export type JsonPrimitive = string | number | bigint | boolean | null;

/** A JSON array, read-only once received. */
export type JsonArray = readonly JsonValue[];

/** A JSON object, read-only once received. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any JSON value, read-only once received. */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/**
 * Reads one JSON value without rounding integral tokens. Ordinary safe
 * integers are numbers and larger integral tokens are bigint. Fractions and
 * exponent-form values keep their floating-point number representation.
 * Duplicate object keys retain their last value, as on a lenient response read.
 */
export function parseJson(text: string): JsonValue {
  return parseText(text, "lenient");
}

/**
 * Writes JSON with bigint as unquoted numeric tokens. An integral number is
 * written as its actual exact integer value; use bigint when constructing
 * a value that cannot be represented exactly as a JavaScript number.
 * Non-finite numbers render as null, as with JSON.stringify. Circular
 * values cannot be written as JSON.
 */
export function stringifyJson(
  value: JsonValue,
  space?: number | string,
): string {
  return renderValue(value, space);
}
