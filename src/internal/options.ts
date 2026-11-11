// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The per-call arguments a service judges before any request: the signal
 * it forwards to the transport and the name it requires. A service passes
 * only the signal it was given, never the caller's object itself, so a
 * property a caller did not mean for the transport cannot reach it.
 */

/** The `signal` option alone: present when set, absent otherwise. */
export function signalOption(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

/**
 * Judges a caller-supplied name before any request: throws a `TypeError`
 * reading `<label> is required` unless `value` is a string with something
 * other than whitespace in it, and returns it unchanged. The path builder
 * escapes it; nothing here does.
 */
export function requireNonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} is required`);
  }
  return value;
}
