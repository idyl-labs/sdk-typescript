// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * How long a Computer keeps its execution after its last session ends.
 * Every session counts, exec and shell alike, from its creation until it
 * ends. When the timeout passes with no session, the platform releases the
 * compute held for the Computer and the Computer becomes dormant; its
 * durable state is retained, and the next session wakes it.
 *
 * The value is {@link IDLE_TIMEOUT_NEVER}, or a whole number followed by one
 * unit, `s` for seconds, `m` for minutes or `h` for hours, written without a
 * sign or leading zeros and totaling at least {@link MIN_IDLE_TIMEOUT_MS}:
 * `0s`, `90s`, `5m` and `2h` are timeouts. Zero releases execution as soon
 * as it is idle; never is spelled out. A value larger than a signed
 * 64-bit nanosecond count can hold, about 292 years, is refused.
 *
 * The platform states a Computer's timeout canonically, as a whole number
 * of seconds with `s` or as `never`, so a Computer declared with `5m` reads
 * back as `300s`. {@link parseIdleTimeout} returns the same canonical
 * spelling.
 *
 * The type is a string and has no codec of its own: the wire carries any
 * token it is given, and {@link validateIdleTimeout} judges it.
 */
export type IdleTimeout = string;

/**
 * The timeout that keeps a Computer awake: it is never released for being
 * idle, its execution is held, and billed, until a caller puts it to sleep
 * with `computer.sleep()` or deletes it. Processes left running in the
 * background keep running until then.
 */
export const IDLE_TIMEOUT_NEVER: IdleTimeout = "never";

/** The timeout of a Computer that states none. */
export const DEFAULT_IDLE_TIMEOUT: IdleTimeout = "300s";

/** The shortest finite idle timeout, in milliseconds: zero. */
export const MIN_IDLE_TIMEOUT_MS = 0;

const MIN_IDLE_TIMEOUT_SECONDS = 0n;

/** The largest whole number of seconds a signed 64-bit nanosecond count holds. */
const MAX_IDLE_TIMEOUT_SECONDS = ((1n << 63n) - 1n) / 1_000_000_000n;

const UNIT_SECONDS: ReadonlyMap<string, bigint> = new Map([
  ["s", 1n],
  ["m", 60n],
  ["h", 3600n],
]);

/**
 * Validates `raw` and returns it in the canonical spelling the platform
 * states: `never`, or the whole number of seconds followed by `s`. Throws a
 * `TypeError` with the sentence {@link validateIdleTimeout} would throw.
 */
export function parseIdleTimeout(raw: string): IdleTimeout {
  const seconds = idleTimeoutSeconds(raw);
  return seconds === undefined ? IDLE_TIMEOUT_NEVER : `${String(seconds)}s`;
}

/**
 * The canonical idle timeout of `milliseconds`, which must be a whole
 * number of seconds and at least {@link MIN_IDLE_TIMEOUT_MS}. Throws a
 * `TypeError` otherwise.
 */
export function idleTimeoutFromMilliseconds(milliseconds: number): IdleTimeout {
  if (!Number.isSafeInteger(milliseconds) || milliseconds % 1000 !== 0) {
    throw new TypeError("idle timeout must be a whole number of seconds");
  }
  if (milliseconds < MIN_IDLE_TIMEOUT_MS) {
    throw new TypeError("idle timeout must be non-negative");
  }
  return `${String(milliseconds / 1000)}s`;
}

/**
 * Judges that the timeout is `never` or a finite timeout in the grammar
 * {@link IdleTimeout} documents. The empty string is reported as missing.
 * Refusals are fixed sentences and never repeat the value. Throws a
 * `TypeError`.
 */
export function validateIdleTimeout(timeout: IdleTimeout): void {
  idleTimeoutSeconds(timeout);
}

/** Whether the timeout is {@link IDLE_TIMEOUT_NEVER}. */
export function isIdleTimeoutNever(timeout: IdleTimeout): boolean {
  return timeout === IDLE_TIMEOUT_NEVER;
}

/**
 * The length of a finite timeout in milliseconds. `never` has no length and
 * is refused, as is a value {@link validateIdleTimeout} refuses; both throw
 * a `TypeError`. A timeout longer than `Number.MAX_SAFE_INTEGER`
 * milliseconds is returned rounded to the nearest representable number.
 */
export function idleTimeoutMilliseconds(timeout: IdleTimeout): number {
  const seconds = idleTimeoutSeconds(timeout);
  if (seconds === undefined) {
    throw new TypeError("idle timeout never has no duration");
  }
  return Number(seconds * 1000n);
}

/**
 * Judges `raw` against the grammar and returns the timeout in seconds, or
 * `undefined` for never.
 */
function idleTimeoutSeconds(raw: string): bigint | undefined {
  if (raw === "") throw new TypeError("idle timeout is required");
  if (raw === IDLE_TIMEOUT_NEVER) return undefined;
  const digits = raw.slice(0, -1);
  const multiplier = UNIT_SECONDS.get(raw.slice(-1));
  if (
    multiplier === undefined ||
    !/^[0-9]+$/u.test(digits) ||
    (digits.length > 1 && digits.startsWith("0"))
  ) {
    throw new TypeError(
      'idle timeout must be "never" or a whole number followed by s, m, or h, such as "300s", "5m", or "1h"',
    );
  }
  const value = BigInt(digits);
  if (value > MAX_IDLE_TIMEOUT_SECONDS / multiplier) {
    throw new TypeError("idle timeout is longer than a duration can represent");
  }
  const seconds = value * multiplier;
  if (seconds < MIN_IDLE_TIMEOUT_SECONDS) {
    throw new TypeError("idle timeout must be non-negative");
  }
  return seconds;
}
