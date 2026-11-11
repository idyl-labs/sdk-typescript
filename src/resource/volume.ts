// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "./json.js";
import { scalar, integerText, type Shape } from "../internal/strictdecode.js";
import {
  compareBytes,
  parseByteQuantity,
  unitBytes,
  type ByteUnit,
} from "./byte-quantity.js";

/**
 * The unit a {@link VolumeQuantity} is denominated in. Both the binary (IEC,
 * powers of 1024) family, `Ki`, `Mi`, `Gi`, and `Ti`, and the decimal (SI,
 * powers of 1000) family, `K`, `M`, `G`, and `T`, are supported; `B` is raw
 * bytes. The token of each unit is exactly the suffix {@link decodeVolume}
 * accepts for it.
 */
export type VolumeUnit = ByteUnit;

/**
 * An amount of storage as a whole number in a declared unit, used to size
 * volumes and disks. It is the value form of the compact string a manifest
 * carries, `20Gi` or `100G`, which {@link decodeVolume} reads and
 * {@link formatVolume} writes; the wire never carries it as an object.
 *
 * Two quantities that name the same amount in different units are different
 * values: compare amounts with {@link compareVolume}, not by field. A
 * `value` of zero means no storage, which validators treat as a missing
 * size where one is required.
 */
export interface VolumeQuantity {
  readonly value: Integer;
  readonly unit: VolumeUnit;
}

/**
 * Bounds an acceptable amount of storage, inclusive at both ends. An end
 * left `undefined` is unconstrained.
 */
export interface VolumeQuantityRange {
  readonly min?: VolumeQuantity;
  readonly max?: VolumeQuantity;
}

/**
 * Parses a storage size string such as `20Gi`, `100G`, or `4096`. The value
 * is a whole non-negative number optionally followed by one of the
 * supported unit suffixes; no suffix means bytes. A fractional quantity is
 * refused rather than truncated, and the error names the exact whole-unit
 * spelling when one exists. Throws a `TypeError` for an unknown suffix,
 * malformed input, a byte count that would overflow 64 bits.
 */
export function decodeVolume(text: string): VolumeQuantity {
  return parseByteQuantity("volume", text);
}

/**
 * Renders the quantity in the syntax {@link decodeVolume} accepts: value and
 * suffix for a unit-bearing quantity, and a bare number for a byte
 * quantity. Unlike memory, a byte count is not promoted to a larger unit.
 * The rendering is lossless: decoding it yields the same number of bytes.
 */
export function formatVolume(quantity: VolumeQuantity): string {
  if (quantity.unit === "B") return integerText(quantity.value);
  return `${integerText(quantity.value)}${quantity.unit}`;
}

/**
 * The quantity in bytes, the common unit for comparison. A byte count
 * beyond what a `number` holds exactly is returned as the nearest
 * representable value.
 */
export function volumeBytes(quantity: VolumeQuantity): number {
  return Number(volumeBytesExact(quantity));
}

/** Whether the quantity requests no storage, in whichever unit it is held. */
export function isZeroVolume(quantity: VolumeQuantity): boolean {
  return BigInt(quantity.value) === 0n;
}

/**
 * Orders two quantities by amount, so `4096Ki` and `4Mi` compare equal even
 * though their fields differ. Returns -1 when `left` is the smaller amount,
 * 0 when the two are equal, and 1 when `left` is the larger.
 */
export function compareVolume(
  left: VolumeQuantity,
  right: VolumeQuantity,
): -1 | 0 | 1 {
  return compareBytes(volumeBytesExact(left), volumeBytesExact(right));
}

/**
 * The wire shape of a storage quantity: the compact string, or the bare
 * number a manifest converted from YAML carries for a byte count.
 */
export const volumeQuantityShape: Shape<VolumeQuantity> =
  scalar<VolumeQuantity>({
    decode: decodeVolume,
    encode: formatVolume,
    zero: () => ({ value: 0, unit: "B" }),
    isZero: isZeroVolume,
    acceptsNumber: true,
  });

/** The exact byte count, for arithmetic that must not round. */
export function volumeBytesExact(quantity: VolumeQuantity): bigint {
  return BigInt(quantity.value) * unitBytes(quantity.unit);
}

/** Checks a known unit and exact unsigned 64-bit byte count; zero is valid and policy belongs to the caller. */
export function validateVolumeQuantity(quantity: VolumeQuantity): void {
  if (
    !["", "B", "Ki", "Mi", "Gi", "Ti", "K", "M", "G", "T"].includes(
      quantity.unit,
    )
  )
    throw new TypeError(`unknown volume unit ${JSON.stringify(quantity.unit)}`);
  decodeVolume(formatVolume(quantity));
}
