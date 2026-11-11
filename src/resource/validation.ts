// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * Helpers the resource validators share. Every validator throws a
 * `TypeError` whose message names the first violation, and a validator that
 * delegates to another prefixes the delegate's message with the field it
 * was checking, so a message reads from the manifest root down:
 * `spec: invalid template spec: containers[0].name is required`.
 */

/**
 * Runs `validate` and rethrows its `TypeError` with `prefix` and a colon in
 * front of the message, keeping the original as the cause.
 */
export function prefixed(prefix: string, validate: () => void): void {
  try {
    validate();
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError(`${prefix}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Runs `validate` and rethrows its `TypeError` with `prefix` and a dot in
 * front of the message, keeping the original as the cause, so a delegate
 * that names its own field reads as one path: `spec.idleTimeout: ...`.
 */
export function pathPrefixed(prefix: string, validate: () => void): void {
  try {
    validate();
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError(`${prefix}.${error.message}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Whether `value` is well-formed: every surrogate code unit is part of a
 * pair, so the string encodes as valid UTF-8.
 */
export function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** The message of `error` when it is an `Error`, or its string form otherwise. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
