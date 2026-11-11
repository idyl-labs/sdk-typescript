// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { scalar, type Shape } from "../internal/strictdecode.js";

/**
 * A span of time as a manifest states it, held to nanosecond precision:
 * whole `seconds` plus `nanoseconds` in the range −999 999 999 to
 * 999 999 999, both carrying the same sign. It is the value form of the Go
 * duration string a manifest carries, `15m` or `2h`, which
 * {@link parseDuration} reads and {@link formatDuration} writes; the wire
 * never carries it as a number.
 *
 * A duration whose two parts are both zero is unset, which validators treat
 * as missing where a duration is required.
 */
export interface Duration {
  readonly seconds: number;
  readonly nanoseconds: number;
}

const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const MAX_INT64 = (1n << 63n) - 1n;

/** The units Go duration syntax accepts, each in nanoseconds. */
const UNITS: ReadonlyMap<string, bigint> = new Map([
  ["ns", 1n],
  ["us", 1_000n],
  ["µs", 1_000n],
  ["μs", 1_000n],
  ["ms", 1_000_000n],
  ["s", NANOSECONDS_PER_SECOND],
  ["m", 60n * NANOSECONDS_PER_SECOND],
  ["h", 3600n * NANOSECONDS_PER_SECOND],
]);

/**
 * Parses a Go duration string: a possibly signed sequence of decimal
 * numbers, each with an optional fraction and a unit suffix, such as `15m`,
 * `2h`, `1h30m`, or `1.5s`. The units are `ns`, `us` (or `µs`), `ms`, `s`,
 * `m`, and `h`; `0` alone is accepted without a unit. Throws a `TypeError`
 * for any other syntax, a missing or unknown unit, and a value that would
 * overflow a signed 64-bit nanosecond count.
 */
export function parseDuration(text: string): Duration {
  let rest = text;
  let negative = false;
  if (rest.startsWith("-") || rest.startsWith("+")) {
    negative = rest.startsWith("-");
    rest = rest.slice(1);
  }
  if (rest === "0") return { seconds: 0, nanoseconds: 0 };
  if (rest === "") throw invalidDuration(text, undefined);

  let total = 0n;
  while (rest !== "") {
    const first = rest[0] ?? "";
    if (first !== "." && !isDigit(first))
      throw invalidDuration(text, undefined);

    const wholeDigits = leadingDigits(rest);
    rest = rest.slice(wholeDigits.length);
    const whole = wholeDigits === "" ? 0n : BigInt(wholeDigits);
    if (whole > 1n << 63n) throw invalidDuration(text, undefined);

    let fraction = 0n;
    let scale = 1;
    let fractionDigits = "";
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      fractionDigits = leadingDigits(rest);
      rest = rest.slice(fractionDigits.length);
      [fraction, scale] = leadingFraction(fractionDigits);
    }
    if (wholeDigits === "" && fractionDigits === "") {
      throw invalidDuration(text, undefined);
    }

    let unitLength = 0;
    while (unitLength < rest.length) {
      const character = rest[unitLength] ?? "";
      if (character === "." || isDigit(character)) break;
      unitLength += 1;
    }
    if (unitLength === 0) throw invalidDuration(text, "missing unit");
    const unitToken = rest.slice(0, unitLength);
    rest = rest.slice(unitLength);
    const unit = UNITS.get(unitToken);
    if (unit === undefined) {
      throw invalidDuration(text, `unknown unit ${JSON.stringify(unitToken)}`);
    }

    if (whole > (1n << 63n) / unit) throw invalidDuration(text, undefined);
    let value = whole * unit;
    if (fraction > 0n) {
      value += BigInt(Math.trunc(Number(fraction) * (Number(unit) / scale)));
      if (value > 1n << 63n) throw invalidDuration(text, undefined);
    }
    total += value;
    if (total > 1n << 63n) throw invalidDuration(text, undefined);
  }

  if (negative) return fromNanoseconds(-total);
  if (total > MAX_INT64) throw invalidDuration(text, undefined);
  return fromNanoseconds(total);
}

function leadingDigits(text: string): string {
  let length = 0;
  while (length < text.length && isDigit(text[length] ?? "")) length += 1;
  return text.slice(0, length);
}

/**
 * Reads the digits after a decimal point as a numerator and the power of ten
 * that scales it. Digits beyond what a 64-bit value holds are consumed but
 * do not change the result, as in Go's parser.
 */
function leadingFraction(digits: string): [bigint, number] {
  let numerator = 0n;
  let scale = 1;
  let overflow = false;
  for (const digit of digits) {
    if (overflow) continue;
    if (numerator > MAX_INT64 / 10n) {
      overflow = true;
      continue;
    }
    const next = numerator * 10n + BigInt(digit);
    if (next > 1n << 63n) {
      overflow = true;
      continue;
    }
    numerator = next;
    scale *= 10;
  }
  return [numerator, scale];
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function invalidDuration(text: string, detail: string | undefined): TypeError {
  const quoted = JSON.stringify(text);
  return new TypeError(
    detail === undefined
      ? `invalid duration ${quoted}`
      : `invalid duration ${quoted}: ${detail}`,
  );
}

function fromNanoseconds(total: bigint): Duration {
  return {
    seconds: Number(total / NANOSECONDS_PER_SECOND),
    nanoseconds: Number(total % NANOSECONDS_PER_SECOND),
  };
}

function toNanoseconds(duration: Duration): bigint {
  return (
    BigInt(duration.seconds) * NANOSECONDS_PER_SECOND +
    BigInt(duration.nanoseconds)
  );
}

/**
 * Renders the duration in compact Go syntax: hours, minutes, and seconds
 * with trailing zero components trimmed, so two hours render as `2h` and
 * ninety minutes as `1h30m`; a duration under one second renders in the
 * largest of `ms`, `µs`, and `ns` that expresses it, with a fraction where
 * needed. Zero renders as `0s`. The result always re-parses through
 * {@link parseDuration} to the same value.
 */
export function formatDuration(duration: Duration): string {
  let out = goDurationString(toNanoseconds(duration));
  if (out.endsWith("m0s")) out = `${out.slice(0, -3)}m`;
  if (out.endsWith("h0m")) out = `${out.slice(0, -3)}h`;
  if (out === "" || out === "-") return "0s";
  return out;
}

/** Go's `time.Duration.String`, over a nanosecond count. */
function goDurationString(total: bigint): string {
  const negative = total < 0n;
  let u = negative ? -total : total;
  let out: string;
  if (u < NANOSECONDS_PER_SECOND) {
    if (u === 0n) return "0s";
    let precision: number;
    let suffix: string;
    if (u < 1_000n) {
      precision = 0;
      suffix = "ns";
    } else if (u < 1_000_000n) {
      precision = 3;
      suffix = "µs";
    } else {
      precision = 6;
      suffix = "ms";
    }
    const [fraction, remaining] = formatFraction(u, precision);
    out = `${String(remaining)}${fraction}${suffix}`;
  } else {
    const [fraction, seconds] = formatFraction(u, 9);
    out = `${String(seconds % 60n)}${fraction}s`;
    u = seconds / 60n;
    if (u > 0n) {
      out = `${String(u % 60n)}m${out}`;
      u /= 60n;
      if (u > 0n) out = `${String(u)}h${out}`;
    }
  }
  return negative ? `-${out}` : out;
}

/**
 * Splits `value` into its fraction over `10^precision`, rendered with the
 * decimal point and trailing zeros omitted, and the whole part that remains.
 */
function formatFraction(value: bigint, precision: number): [string, bigint] {
  let digits = "";
  let remaining = value;
  let print = false;
  for (let i = 0; i < precision; i += 1) {
    const digit = remaining % 10n;
    print = print || digit !== 0n;
    if (print) digits = `${String(digit)}${digits}`;
    remaining /= 10n;
  }
  return [print ? `.${digits}` : "", remaining];
}

/**
 * The duration in milliseconds, fractional when it holds sub-millisecond
 * precision.
 */
export function durationMilliseconds(duration: Duration): number {
  return duration.seconds * 1000 + duration.nanoseconds / 1_000_000;
}

/**
 * A duration of `milliseconds`, which must be a finite number of whole
 * nanoseconds; throws a `TypeError` otherwise.
 */
export function durationFromMilliseconds(milliseconds: number): Duration {
  const nanoseconds = milliseconds * 1_000_000;
  if (!Number.isFinite(nanoseconds) || !Number.isSafeInteger(nanoseconds)) {
    throw new TypeError(
      `invalid duration of ${String(milliseconds)} milliseconds: must be a whole number of nanoseconds`,
    );
  }
  return fromNanoseconds(BigInt(nanoseconds));
}

/**
 * The wire shape of a duration: the compact Go duration string. A number
 * is refused, as the reference contract refuses it, because a bare `30` names no unit.
 */
export const durationShape: Shape<Duration> = scalar<Duration>({
  decode: parseDuration,
  encode: formatDuration,
  zero: () => ({ seconds: 0, nanoseconds: 0 }),
  isZero: isZeroDuration,
});

/** Whether the duration is unset or explicitly zero. */
export function isZeroDuration(duration: Duration): boolean {
  return duration.seconds === 0 && duration.nanoseconds === 0;
}

/**
 * Orders two durations. Returns -1 when `left` is the shorter, 0 when the
 * two are equal, and 1 when `left` is the longer.
 */
export function compareDuration(left: Duration, right: Duration): -1 | 0 | 1 {
  const a = toNanoseconds(left);
  const b = toNanoseconds(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
