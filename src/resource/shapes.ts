// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * Wire shapes shared by more than one resource: identifiers whose codec
 * judges the spelling, and RFC 3339 instants. Each quantity declares its own
 * shape next to its type.
 */
import { scalar, type Shape } from "../internal/strictdecode.js";

/**
 * A twelve-digit public identifier as its Go codec reads it: either the
 * empty string, which is the unset zero value, or exactly twelve ASCII
 * digits. `parse` is the family's own parser and names the family in the
 * rejection.
 */
export function publicIdShape<T extends string>(
  parse: (value: string) => T,
): Shape<T> {
  return scalar<T>({
    decode: (text) => (text === "" ? ("" as T) : parse(text)),
    encode: (value) => value,
    zero: () => "" as T,
    isZero: (value) => value === "",
  });
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Parses an RFC 3339 instant such as `2026-01-02T03:04:05Z`, throwing a
 * `TypeError` for any other spelling or an out-of-range date. The value is
 * carried as the string it arrived as; a `Date` is one conversion away and
 * would lose the offset and any sub-millisecond precision.
 */
export function parseTimestamp(text: string): string {
  const match = RFC3339.exec(text);
  if (match === null) {
    throw new TypeError(
      `invalid timestamp ${JSON.stringify(text)}: must be RFC 3339`,
    );
  }
  const [, year, month, day, hour, minute, second] = match;
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const probe = new Date(utc);
  if (
    Number.isNaN(utc) ||
    probe.getUTCMonth() !== Number(month) - 1 ||
    probe.getUTCDate() !== Number(day) ||
    probe.getUTCHours() !== Number(hour) ||
    probe.getUTCMinutes() !== Number(minute) ||
    Number(second) > 60
  ) {
    throw new TypeError(
      `invalid timestamp ${JSON.stringify(text)}: out of range`,
    );
  }
  return text;
}

/** An RFC 3339 instant; empty is the unset zero the wire omits. */
export const timestampShape: Shape<string> = scalar<string>({
  decode: parseTimestamp,
  encode: (value) => value,
  zero: () => "",
  isZero: (value) => value === "",
});
