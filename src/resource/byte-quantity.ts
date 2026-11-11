// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { numberOrBigInt } from "../internal/strictdecode.js";
import type { Integer } from "./json.js";
/*
 * The syntax shared by memory and volume quantities: a whole number followed
 * by an optional unit suffix from the binary (IEC) or decimal (SI) family.
 * Nothing here is public; `memory.ts` and `volume.ts` own the exported
 * codecs and differ only in which suffixes they accept and how they render
 * a byte count.
 */

/** Byte counts for the supported IEC (binary) and SI (decimal) prefixes. */
export const BYTES_PER_KIB = 1024n;
export const BYTES_PER_MIB = 1024n * BYTES_PER_KIB;
export const BYTES_PER_GIB = 1024n * BYTES_PER_MIB;
export const BYTES_PER_TIB = 1024n * BYTES_PER_GIB;
export const BYTES_PER_KB = 1000n;
export const BYTES_PER_MB = 1000n * BYTES_PER_KB;
export const BYTES_PER_GB = 1000n * BYTES_PER_MB;
export const BYTES_PER_TB = 1000n * BYTES_PER_GB;

/** The largest value a Go `uint64` holds, which bounds every quantity. */
export const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * The unit suffixes memory and volume quantities share, each paired with the
 * number of bytes one unit represents. The suffix is the unit's wire token.
 */
export type ByteUnit = "Ki" | "Mi" | "Gi" | "Ti" | "B" | "K" | "M" | "G" | "T";

const UNIT_BYTES: Readonly<Record<ByteUnit, bigint>> = {
  Ki: BYTES_PER_KIB,
  Mi: BYTES_PER_MIB,
  Gi: BYTES_PER_GIB,
  Ti: BYTES_PER_TIB,
  B: 1n,
  K: BYTES_PER_KB,
  M: BYTES_PER_MB,
  G: BYTES_PER_GB,
  T: BYTES_PER_TB,
};

/** Whether `suffix` names a supported unit. */
export function isByteUnit(suffix: string): suffix is ByteUnit {
  return Object.hasOwn(UNIT_BYTES, suffix);
}

/** The number of bytes one unit of `unit` represents. */
export function unitBytes(unit: ByteUnit): bigint {
  return UNIT_BYTES[unit];
}

interface ByteLadderRung {
  readonly suffix: ByteUnit;
  readonly factor: bigint;
}

/**
 * The binary and decimal ladders spell an exact byte count in the largest
 * unit that divides it, largest unit first.
 */
export const BINARY_LADDER: readonly ByteLadderRung[] = [
  { suffix: "Ti", factor: BYTES_PER_TIB },
  { suffix: "Gi", factor: BYTES_PER_GIB },
  { suffix: "Mi", factor: BYTES_PER_MIB },
  { suffix: "Ki", factor: BYTES_PER_KIB },
];

const DECIMAL_LADDER: readonly ByteLadderRung[] = [
  { suffix: "T", factor: BYTES_PER_TB },
  { suffix: "G", factor: BYTES_PER_GB },
  { suffix: "M", factor: BYTES_PER_MB },
  { suffix: "K", factor: BYTES_PER_KB },
];

/**
 * Bounds how many digits of a rejected fractional quantity are examined when
 * looking for an exact alternative. Twenty digits cover every `uint64`, so a
 * longer part cannot produce a spelling that decodes.
 */
const MAX_SUGGESTION_DIGITS = 20;

const BYTE_QUANTITY = /^(\d+)(?:\.(\d+))?([A-Za-z]*)$/u;

/** A parsed byte-denominated quantity: a whole value in a unit. */
export interface ParsedByteQuantity {
  readonly value: Integer;
  readonly unit: ByteUnit;
}

/**
 * Parses `raw` as a whole number with an optional unit suffix; no suffix
 * means bytes. Fractional quantities are refused rather than truncated, and
 * when the written value is a whole number of bytes the error names the
 * exact whole-unit spelling. `kind` names the quantity in errors (`memory`,
 * `volume`). Values and byte counts that do not fit a `uint64` are refused.
 */
export function parseByteQuantity(
  kind: string,
  raw: string,
): ParsedByteQuantity {
  const written = raw.trim();
  const match = BYTE_QUANTITY.exec(written);
  if (match === null) {
    throw new TypeError(`invalid ${kind} value format: ${written}`);
  }
  const wholePart = match[1] ?? "";
  const fractionalPart = match[2] ?? "";
  const suffix = match[3] ?? "";
  let unit: ByteUnit = "B";
  if (suffix !== "") {
    if (!isByteUnit(suffix)) {
      throw new TypeError(`unsupported ${kind} unit: ${suffix}`);
    }
    unit = suffix;
  }
  const factor = unitBytes(unit);
  if (fractionalPart !== "") {
    throw fractionalQuantityError(
      kind,
      written,
      wholePart,
      fractionalPart,
      suffix,
      factor,
    );
  }
  const value = BigInt(wholePart);
  if (value > MAX_UINT64) {
    throw new TypeError(
      `invalid ${kind} value ${JSON.stringify(written)}: value out of range`,
    );
  }
  if (value * factor > MAX_UINT64) {
    throw new TypeError(
      `${kind} value ${JSON.stringify(written)} overflows bytes`,
    );
  }
  return { value: numberOrBigInt(value), unit };
}

function fractionalQuantityError(
  kind: string,
  written: string,
  wholePart: string,
  fractionalPart: string,
  suffix: string,
  factor: bigint,
): TypeError {
  const unitName = suffix === "" ? "bytes" : suffix;
  const alternative = exactWholeQuantity(wholePart, fractionalPart, factor);
  if (alternative !== undefined) {
    return new TypeError(
      `${kind} value ${written} is not a whole number of ${unitName}; write ${alternative}`,
    );
  }
  return new TypeError(
    `${kind} value ${written} is not a whole number of ${unitName}; fractional quantities are not accepted`,
  );
}

/**
 * Renders `<wholePart>.<fractionalPart>` scaled by `factor` as a whole
 * quantity string, when the scaled value is a whole number of bytes that
 * fits a `uint64`, so the suggestion always decodes to exactly the value
 * the caller wrote.
 */
function exactWholeQuantity(
  wholePart: string,
  fractionalPart: string,
  factor: bigint,
): string | undefined {
  if (
    wholePart.length > MAX_SUGGESTION_DIGITS ||
    fractionalPart.length > MAX_SUGGESTION_DIGITS
  ) {
    return undefined;
  }
  const digits = BigInt(wholePart + fractionalPart) * factor;
  const scale = 10n ** BigInt(fractionalPart.length);
  if (digits % scale !== 0n) return undefined;
  const bytes = digits / scale;
  if (bytes > MAX_UINT64) return undefined;
  return spellExactBytes(bytes, ladderFor(factor));
}

/**
 * Picks the unit family a suggestion is spelled in from the unit the caller
 * wrote, so a decimal suffix is suggested back with a decimal suffix. Bytes
 * and every binary unit fall through to the binary ladder.
 */
function ladderFor(factor: bigint): readonly ByteLadderRung[] {
  return DECIMAL_LADDER.some((rung) => rung.factor === factor)
    ? DECIMAL_LADDER
    : BINARY_LADDER;
}

/**
 * Renders a byte count in the largest unit of the ladder that divides it
 * exactly, falling back to an explicit byte count.
 */
export function spellExactBytes(
  bytes: bigint,
  ladder: readonly ByteLadderRung[],
): string {
  for (const rung of ladder) {
    if (bytes >= rung.factor && bytes % rung.factor === 0n) {
      return `${String(bytes / rung.factor)}${rung.suffix}`;
    }
  }
  return `${String(bytes)}B`;
}

/**
 * Compares two byte counts, returning -1, 0, or 1. It is the ordering every
 * byte-denominated quantity uses once normalized to bytes.
 */
export function compareBytes(left: bigint, right: bigint): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
