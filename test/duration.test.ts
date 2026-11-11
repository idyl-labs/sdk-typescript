// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  compareDuration,
  durationFromMilliseconds,
  durationMilliseconds,
  formatDuration,
  isZeroDuration,
  parseDuration,
} from "../src/resource/duration.js";

describe("durations", () => {
  // Contract: Go duration syntax parses to exact seconds and nanoseconds.
  it("parses every form Go accepts", () => {
    expect(parseDuration("2h")).toEqual({ seconds: 7200, nanoseconds: 0 });
    expect(parseDuration("15m")).toEqual({ seconds: 900, nanoseconds: 0 });
    expect(parseDuration("1h30m")).toEqual({ seconds: 5400, nanoseconds: 0 });
    expect(parseDuration("1.5s")).toEqual({
      seconds: 1,
      nanoseconds: 500_000_000,
    });
    expect(parseDuration("500ms")).toEqual({
      seconds: 0,
      nanoseconds: 500_000_000,
    });
    expect(parseDuration("1500ns")).toEqual({ seconds: 0, nanoseconds: 1500 });
    expect(parseDuration("2µs")).toEqual({ seconds: 0, nanoseconds: 2000 });
    expect(parseDuration("2us")).toEqual({ seconds: 0, nanoseconds: 2000 });
    expect(parseDuration("0")).toEqual({ seconds: 0, nanoseconds: 0 });
    expect(parseDuration("-1h")).toEqual({ seconds: -3600, nanoseconds: 0 });
    expect(parseDuration("+1h")).toEqual({ seconds: 3600, nanoseconds: 0 });
    expect(parseDuration(".5h")).toEqual({ seconds: 1800, nanoseconds: 0 });
    expect(parseDuration("8760h")).toEqual({
      seconds: 31_536_000,
      nanoseconds: 0,
    });
  });

  // Contract: a missing unit, an unknown unit, malformed text, and overflow
  // are refused with the reason named.
  it("refuses what Go refuses", () => {
    expect(() => parseDuration("30")).toThrow(
      'invalid duration "30": missing unit',
    );
    expect(() => parseDuration("5x")).toThrow(
      'invalid duration "5x": unknown unit "x"',
    );
    expect(() => parseDuration("")).toThrow('invalid duration ""');
    expect(() => parseDuration("abc")).toThrow('invalid duration "abc"');
    expect(() => parseDuration("1h-")).toThrow('invalid duration "1h-"');
    expect(() => parseDuration(".h")).toThrow('invalid duration ".h"');
    expect(() => parseDuration("9223372036854775808ns")).toThrow(
      'invalid duration "9223372036854775808ns"',
    );
    expect(() => parseDuration("-9223372036854775808ns")).not.toThrow();
  });

  // Contract: formatting is Go's compact form, trailing zero components
  // trimmed, and it re-parses to the same value.
  it("formats compactly and round-trips", () => {
    const cases: readonly [string, string][] = [
      ["2h", "2h"],
      ["2h0m0s", "2h"],
      ["15m", "15m"],
      ["90m", "1h30m"],
      ["1h30m0s", "1h30m"],
      ["1.5s", "1.5s"],
      ["1500ms", "1.5s"],
      ["500ms", "500ms"],
      ["1500ns", "1.5µs"],
      ["1500000ns", "1.5ms"],
      ["999ns", "999ns"],
      ["0", "0s"],
      ["0s", "0s"],
      ["-1h", "-1h"],
      ["-1.5s", "-1.5s"],
      ["1h0m1s", "1h0m1s"],
      ["3601s", "1h0m1s"],
      ["24h", "24h"],
      ["100h", "100h"],
    ];
    for (const [input, expected] of cases) {
      const formatted = formatDuration(parseDuration(input));
      expect(formatted, input).toBe(expected);
      expect(parseDuration(formatted), input).toEqual(parseDuration(input));
    }
  });

  // Contract: milliseconds convert exactly in both directions and a
  // sub-nanosecond value is refused.
  it("converts milliseconds", () => {
    expect(durationMilliseconds(parseDuration("1.5s"))).toBe(1500);
    expect(durationMilliseconds(parseDuration("2h"))).toBe(7_200_000);
    expect(durationFromMilliseconds(30 * 60_000)).toEqual(parseDuration("30m"));
    expect(durationFromMilliseconds(0.5)).toEqual(parseDuration("500µs"));
    expect(() => durationFromMilliseconds(Number.NaN)).toThrow(TypeError);
    expect(() => durationFromMilliseconds(0.0000001)).toThrow(
      "must be a whole number of nanoseconds",
    );
  });

  // Contract: ordering and the zero test.
  it("compares", () => {
    expect(compareDuration(parseDuration("1h"), parseDuration("60m"))).toBe(0);
    expect(compareDuration(parseDuration("1s"), parseDuration("1.5s"))).toBe(
      -1,
    );
    expect(compareDuration(parseDuration("2s"), parseDuration("1.5s"))).toBe(1);
    expect(isZeroDuration(parseDuration("0"))).toBe(true);
    expect(isZeroDuration(parseDuration("1ns"))).toBe(false);
  });
});
