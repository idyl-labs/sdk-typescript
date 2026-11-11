// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "./json.js";
import { scalar, integerText, type Shape } from "../internal/strictdecode.js";
import {
  BINARY_LADDER,
  compareBytes,
  parseByteQuantity,
  unitBytes,
  type ByteUnit,
} from "./byte-quantity.js";

/**
 * The unit a {@link MemoryQuantity} is denominated in. Both the binary (IEC,
 * powers of 1024) family, `Ki`, `Mi`, `Gi`, and `Ti`, and the decimal (SI,
 * powers of 1000) family, `K`, `M`, `G`, and `T`, are supported; `B` is raw
 * bytes. The token of each unit is exactly the suffix {@link decodeMemory}
 * accepts for it.
 */
export type MemoryUnit = ByteUnit;

/**
 * An amount of memory as a whole number in a declared unit, so 4 GiB is
 * `{ value: 4, unit: "Gi" }`. It is the value form of the compact string a
 * manifest carries, `512Mi` or `4G`, which {@link decodeMemory} reads and
 * {@link formatMemory} writes; the wire never carries it as an object.
 *
 * Two quantities that name the same amount in different units are different
 * values: compare amounts with {@link compareMemory}, not by field. A
 * `value` of zero means no memory in every unit.
 */
export interface MemoryQuantity {
  readonly value: Integer;
  readonly unit: MemoryUnit;
}

/**
 * Bounds an acceptable amount of memory, inclusive at both ends. An end
 * left `undefined` is unconstrained.
 */
export interface MemoryQuantityRange {
  readonly min?: MemoryQuantity;
  readonly max?: MemoryQuantity;
}

/**
 * Parses a memory string such as `512Mi`, `4G`, or `1048576`. The value is
 * a whole non-negative number optionally followed by one of the supported
 * unit suffixes; no suffix means bytes. A fractional quantity is refused
 * rather than truncated, and the error names the exact whole-unit spelling
 * when one exists (`1.5Gi` is refused in favour of `1536Mi`). Throws a
 * `TypeError` for an unknown suffix, malformed input, a byte count that
 * would overflow 64 bits.
 */
export function decodeMemory(text: string): MemoryQuantity {
  return parseByteQuantity("memory", text);
}

/**
 * Renders the quantity in the syntax {@link decodeMemory} accepts. A byte
 * quantity is promoted to the largest binary unit that represents it
 * exactly, so 4194304 bytes render as `4Mi` while 1500 bytes render as
 * `1500B`; every other unit renders as its value and suffix. The rendering
 * is lossless: decoding it yields the same number of bytes.
 */
export function formatMemory(quantity: MemoryQuantity): string {
  if (quantity.unit === "B") {
    const bytes = BigInt(quantity.value);
    for (const rung of BINARY_LADDER) {
      if (bytes >= rung.factor && bytes % rung.factor === 0n) {
        return `${String(bytes / rung.factor)}${rung.suffix}`;
      }
    }
    return `${integerText(quantity.value)}B`;
  }
  return `${integerText(quantity.value)}${quantity.unit}`;
}

/**
 * The quantity in bytes, the common unit for comparison. A byte count
 * beyond what a `number` holds exactly is returned as the nearest
 * representable value.
 */
export function memoryBytes(quantity: MemoryQuantity): number {
  return Number(bytesExact(quantity));
}

/** Whether the quantity requests no memory, in whichever unit it is held. */
export function isZeroMemory(quantity: MemoryQuantity): boolean {
  return BigInt(quantity.value) === 0n;
}

/**
 * Orders two quantities by amount, so `4096Ki` and `4Mi` compare equal even
 * though their fields differ. Returns -1 when `left` is the smaller amount,
 * 0 when the two are equal, and 1 when `left` is the larger.
 */
export function compareMemory(
  left: MemoryQuantity,
  right: MemoryQuantity,
): -1 | 0 | 1 {
  return compareBytes(bytesExact(left), bytesExact(right));
}

/**
 * The wire shape of a memory quantity: the compact string, or the bare
 * number a manifest converted from YAML carries for a byte count.
 */
export const memoryQuantityShape: Shape<MemoryQuantity> =
  scalar<MemoryQuantity>({
    decode: decodeMemory,
    encode: formatMemory,
    zero: () => ({ value: 0, unit: "B" }),
    isZero: isZeroMemory,
    acceptsNumber: true,
  });

/** The exact byte count, for arithmetic that must not round. */
export function bytesExact(quantity: MemoryQuantity): bigint {
  return BigInt(quantity.value) * unitBytes(quantity.unit);
}
