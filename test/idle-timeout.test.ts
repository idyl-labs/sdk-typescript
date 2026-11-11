// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEFAULT_IDLE_TIMEOUT,
  IDLE_TIMEOUT_NEVER,
  MIN_IDLE_TIMEOUT_MS,
  idleTimeoutFromMilliseconds,
  idleTimeoutMilliseconds,
  isIdleTimeoutNever,
  parseIdleTimeout,
  validateIdleTimeout,
} from "../src/resource/idle-timeout.js";

const GRAMMAR =
  'idle timeout must be "never" or a whole number followed by s, m, or h, such as "300s", "5m", or "1h"';

function refusal(judge: () => unknown): string {
  try {
    judge();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("idle timeouts", () => {
  // Contract: a timeout is `never` or a whole number with one unit of s, m,
  // or h totaling a non-negative duration, and parsing returns the canonical
  // spelling the platform states: whole seconds with `s`, or `never`.
  it("parses to the canonical spelling", () => {
    expect(parseIdleTimeout("5m")).toBe("300s");
    expect(parseIdleTimeout("60s")).toBe("60s");
    expect(parseIdleTimeout("1m")).toBe("60s");
    expect(parseIdleTimeout("2h")).toBe("7200s");
    expect(parseIdleTimeout("never")).toBe(IDLE_TIMEOUT_NEVER);
    expect(DEFAULT_IDLE_TIMEOUT).toBe("300s");
    expect(MIN_IDLE_TIMEOUT_MS).toBe(0);
    expect(parseIdleTimeout("0s")).toBe("0s");
    expect(parseIdleTimeout("0m")).toBe("0s");
    expect(parseIdleTimeout("0h")).toBe("0s");
    expect(parseIdleTimeout("59s")).toBe("59s");
    expect(isIdleTimeoutNever("never")).toBe(true);
    expect(isIdleTimeoutNever("300s")).toBe(false);
  });

  // Contract: every refusal is a fixed sentence that never repeats the
  // value: the empty string is missing, any other spelling breaks the
  // grammar, a negative duration is invalid, and one a signed 64-bit
  // nanosecond count cannot hold is unrepresentable.
  it("refuses what the reference contract refuses, without echoing the value", () => {
    expect(refusal(() => parseIdleTimeout(""))).toBe(
      "idle timeout is required",
    );
    for (const malformed of [
      "0",
      "300",
      "s",
      "05m",
      "+5m",
      "-5m",
      "5 m",
      "1.5h",
      "5M",
      "1d",
      "Never",
      "1h30m",
      "5µs",
    ]) {
      expect(
        refusal(() => parseIdleTimeout(malformed)),
        malformed,
      ).toBe(GRAMMAR);
    }
    for (const longest of ["9223372036s", "153722867m", "2562047h"]) {
      expect(() => parseIdleTimeout(longest), longest).not.toThrow();
    }
    for (const tooLong of [
      "9223372037s",
      "153722868m",
      "2562048h",
      "99999999999999999999999h",
    ]) {
      expect(
        refusal(() => parseIdleTimeout(tooLong)),
        tooLong,
      ).toBe("idle timeout is longer than a duration can represent");
    }
    expect(() => {
      validateIdleTimeout("30s");
    }).not.toThrow();
    expect(() => {
      validateIdleTimeout("15m");
    }).not.toThrow();
  });

  // Contract: a client-side length in milliseconds converts to the
  // canonical timeout when it is a non-negative whole number of seconds, and a
  // finite timeout converts back; never has no length.
  it("converts to and from milliseconds", () => {
    expect(idleTimeoutFromMilliseconds(900_000)).toBe("900s");
    expect(idleTimeoutFromMilliseconds(60_000)).toBe("60s");
    expect(refusal(() => idleTimeoutFromMilliseconds(90_500))).toBe(
      "idle timeout must be a whole number of seconds",
    );
    expect(idleTimeoutFromMilliseconds(59_000)).toBe("59s");
    expect(idleTimeoutFromMilliseconds(0)).toBe("0s");
    expect(refusal(() => idleTimeoutFromMilliseconds(-1_000))).toBe(
      "idle timeout must be non-negative",
    );
    expect(idleTimeoutMilliseconds("5m")).toBe(300_000);
    expect(idleTimeoutMilliseconds("300s")).toBe(300_000);
    expect(refusal(() => idleTimeoutMilliseconds("never"))).toBe(
      "idle timeout never has no duration",
    );
  });
});
