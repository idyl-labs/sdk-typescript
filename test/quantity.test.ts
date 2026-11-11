// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  compareCpu,
  cpuMillicores,
  decodeCpu,
  formatCpu,
  isZeroCpu,
} from "../src/resource/cpu.js";
import {
  compareMemory,
  decodeMemory,
  formatMemory,
  isZeroMemory,
  memoryBytes,
} from "../src/resource/memory.js";
import {
  compareVolume,
  decodeVolume,
  formatVolume,
  isZeroVolume,
  volumeBytes,
} from "../src/resource/volume.js";

describe("CPU quantities", () => {
  // Contract: millicores and whole or decimal vCPUs decode to the unit they
  // reduce to, and whitespace around the value is ignored.
  it("decodes every spelling the reference contract accepts", () => {
    expect(decodeCpu("500m")).toEqual({ value: 500, unit: "m" });
    expect(decodeCpu("4")).toEqual({ value: 4, unit: "c" });
    expect(decodeCpu("1.5")).toEqual({ value: 1500, unit: "m" });
    expect(decodeCpu(".25")).toEqual({ value: 250, unit: "m" });
    expect(decodeCpu("2.000")).toEqual({ value: 2, unit: "c" });
    expect(decodeCpu("2.")).toEqual({ value: 2, unit: "c" });
    expect(decodeCpu("0")).toEqual({ value: 0, unit: "c" });
    expect(decodeCpu(" 1000m ")).toEqual({ value: 1000, unit: "m" });
  });

  // Contract: rejections name what is wrong, in the reference contract's words.
  it("refuses what the reference contract refuses", () => {
    expect(() => decodeCpu("")).toThrow("empty CPU value");
    expect(() => decodeCpu("1.2345")).toThrow(
      "fractional CPU precision exceeds millicores",
    );
    expect(() => decodeCpu("1c")).toThrow("invalid CPU format: 1c");
    expect(() => decodeCpu("-1")).toThrow("invalid CPU format: -1");
    expect(() => decodeCpu("18446744073709551616m")).toThrow(
      "value out of range",
    );
    expect(() => decodeCpu("18446744073709552")).toThrow(
      "CPU value overflows millicores",
    );
    expect(decodeCpu("9007199254740993m")).toEqual({
      value: 9007199254740993n,
      unit: "m",
    });
  });

  // Contract: rendering is canonical: whole vCPUs render bare in either
  // unit, sub-vCPU amounts render in millicores, and zero renders as 0.
  it("formats canonically", () => {
    expect(formatCpu({ value: 4, unit: "c" })).toBe("4");
    expect(formatCpu({ value: 4000, unit: "m" })).toBe("4");
    expect(formatCpu({ value: 500, unit: "m" })).toBe("500m");
    expect(formatCpu({ value: 0, unit: "m" })).toBe("0");
    expect(formatCpu({ value: 0, unit: "c" })).toBe("0");
    expect(formatCpu(decodeCpu("1.5"))).toBe("1500m");
  });

  // Contract: amounts compare across units; zero is zero in either.
  it("compares by amount", () => {
    expect(
      compareCpu({ value: 1, unit: "c" }, { value: 1000, unit: "m" }),
    ).toBe(0);
    expect(
      compareCpu({ value: 1, unit: "c" }, { value: 1001, unit: "m" }),
    ).toBe(-1);
    expect(
      compareCpu({ value: 2, unit: "c" }, { value: 1001, unit: "m" }),
    ).toBe(1);
    expect(cpuMillicores({ value: 2, unit: "c" })).toBe(2000);
    expect(isZeroCpu({ value: 0, unit: "c" })).toBe(true);
    expect(isZeroCpu({ value: 1, unit: "m" })).toBe(false);
  });
});

describe("memory quantities", () => {
  // Contract: binary and decimal suffixes decode to their own unit and a
  // suffixless value is bytes.
  it("decodes every spelling the reference contract accepts", () => {
    expect(decodeMemory("512Mi")).toEqual({ value: 512, unit: "Mi" });
    expect(decodeMemory("4G")).toEqual({ value: 4, unit: "G" });
    expect(decodeMemory("1048576")).toEqual({ value: 1048576, unit: "B" });
    expect(decodeMemory("2B")).toEqual({ value: 2, unit: "B" });
    expect(decodeMemory(" 1Ti ")).toEqual({ value: 1, unit: "Ti" });
    expect(decodeMemory("0")).toEqual({ value: 0, unit: "B" });
  });

  // Contract: a fraction is refused and the exact whole-unit spelling is
  // named when one exists, in the family the caller wrote.
  it("refuses fractions with an exact alternative", () => {
    expect(() => decodeMemory("1.5Gi")).toThrow(
      "memory value 1.5Gi is not a whole number of Gi; write 1536Mi",
    );
    expect(() => decodeMemory("1.5G")).toThrow(
      "memory value 1.5G is not a whole number of G; write 1500M",
    );
    expect(() => decodeMemory("0.9Mi")).toThrow(
      "memory value 0.9Mi is not a whole number of Mi; fractional quantities are not accepted",
    );
    expect(() => decodeMemory("1.5")).toThrow(
      "memory value 1.5 is not a whole number of bytes; fractional quantities are not accepted",
    );
    expect(() => decodeMemory("1.0Ki")).toThrow("write 1Ki");
  });

  // Contract: unknown suffixes, malformed input, and overflow are refused.
  it("refuses what the reference contract refuses", () => {
    expect(() => decodeMemory("1GiB")).toThrow("unsupported memory unit: GiB");
    expect(() => decodeMemory("abc")).toThrow(
      "invalid memory value format: abc",
    );
    expect(() => decodeMemory("-1Gi")).toThrow(
      "invalid memory value format: -1Gi",
    );
    expect(() => decodeMemory("16777216Ti")).toThrow(
      'memory value "16777216Ti" overflows bytes',
    );
    expect(() => decodeMemory("18446744073709551616")).toThrow(
      "value out of range",
    );
    expect(decodeMemory("9007199254740993")).toEqual({
      value: 9007199254740993n,
      unit: "B",
    });
  });

  // Contract: bytes promote to the largest exact binary unit; every other
  // unit renders as written.
  it("formats losslessly", () => {
    expect(formatMemory({ value: 4194304, unit: "B" })).toBe("4Mi");
    expect(formatMemory({ value: 1500, unit: "B" })).toBe("1500B");
    expect(formatMemory({ value: 1024, unit: "B" })).toBe("1Ki");
    expect(formatMemory({ value: 0, unit: "B" })).toBe("0B");
    expect(formatMemory({ value: 4, unit: "G" })).toBe("4G");
    expect(formatMemory({ value: 512, unit: "Mi" })).toBe("512Mi");
    expect(decodeMemory(formatMemory({ value: 1536, unit: "Mi" }))).toEqual({
      value: 1536,
      unit: "Mi",
    });
  });

  // Contract: amounts compare in bytes.
  it("compares by amount", () => {
    expect(
      compareMemory({ value: 4096, unit: "Ki" }, { value: 4, unit: "Mi" }),
    ).toBe(0);
    expect(
      compareMemory({ value: 1, unit: "G" }, { value: 1, unit: "Gi" }),
    ).toBe(-1);
    expect(memoryBytes({ value: 1, unit: "Gi" })).toBe(1073741824);
    expect(isZeroMemory({ value: 0, unit: "Gi" })).toBe(true);
  });
});

describe("volume quantities", () => {
  // Contract: the memory grammar, rendered without byte promotion.
  it("decodes and formats", () => {
    expect(decodeVolume("20Gi")).toEqual({ value: 20, unit: "Gi" });
    expect(decodeVolume("4096")).toEqual({ value: 4096, unit: "B" });
    expect(formatVolume({ value: 4096, unit: "B" })).toBe("4096");
    expect(formatVolume({ value: 100, unit: "G" })).toBe("100G");
    expect(() => decodeVolume("1.5Gi")).toThrow(
      "volume value 1.5Gi is not a whole number of Gi; write 1536Mi",
    );
    expect(() => decodeVolume("16777216Ti")).toThrow(
      'volume value "16777216Ti" overflows bytes',
    );
    expect(
      compareVolume({ value: 4096, unit: "Ki" }, { value: 4, unit: "Mi" }),
    ).toBe(0);
    expect(volumeBytes({ value: 2, unit: "Ki" })).toBe(2048);
    expect(isZeroVolume({ value: 0, unit: "B" })).toBe(true);
  });
});
