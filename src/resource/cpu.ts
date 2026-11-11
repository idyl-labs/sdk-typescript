// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "./json.js";
import {
  scalar,
  numberOrBigInt,
  integerText,
  type Shape,
} from "../internal/strictdecode.js";
import { MAX_UINT64 } from "./byte-quantity.js";

/**
 * The unit a {@link CpuQuantity} is denominated in: `m` for millicores,
 * thousandths of a vCPU, or `c` for whole vCPUs. Quantity strings only ever
 * carry the `m` suffix; a vCPU quantity renders as a bare number.
 */
export type CpuUnit = "m" | "c";

/**
 * An amount of CPU as a whole number of millicores or of vCPUs (1 vCPU =
 * 1000 millicores). It is the value form of the compact string a manifest
 * carries, `500m`, `4`, or `1.5`, which {@link decodeCpu} reads and
 * {@link formatCpu} writes; the wire never carries it as an object.
 *
 * Two quantities that name the same amount in different units are different
 * values: compare amounts with {@link compareCpu}, not by field. A `value` of
 * zero means no CPU in either unit.
 */
export interface CpuQuantity {
  readonly value: Integer;
  readonly unit: CpuUnit;
}

/**
 * Bounds an acceptable amount of CPU, inclusive at both ends. An end
 * left `undefined` is unconstrained.
 */
export interface CpuQuantityRange {
  readonly min?: CpuQuantity;
  readonly max?: CpuQuantity;
}

const MILLICORES_PER_VCPU = 1000n;
const MILLICORES = /^(\d+)m$/u;
const VCPUS = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;

/**
 * Parses a CPU string. It accepts millicores with an `m` suffix (`500m`) and
 * whole or decimal vCPU counts (`4`, `1.5`, `.25`). Decimal input is limited
 * to three fractional digits, the millicore resolution, and decodes to
 * millicores unless it reduces to a whole vCPU count. Surrounding whitespace
 * is ignored. Throws a `TypeError` for any other syntax, for a value that
 * would overflow a 64-bit millicore count.
 */
export function decodeCpu(text: string): CpuQuantity {
  const trimmed = text.trim();
  if (trimmed === "") throw new TypeError("empty CPU value");

  const millicores = MILLICORES.exec(trimmed);
  if (millicores !== null) {
    const value = BigInt(millicores[1] ?? "0");
    if (value > MAX_UINT64) {
      throw new TypeError(
        `invalid millicores value ${JSON.stringify(trimmed)}: value out of range`,
      );
    }
    return { value: numberOrBigInt(value), unit: "m" };
  }

  if (VCPUS.test(trimmed)) return parseVcpus(trimmed);

  throw new TypeError(`invalid CPU format: ${trimmed}`);
}

function parseVcpus(raw: string): CpuQuantity {
  const dot = raw.indexOf(".");
  const wholePart = dot === -1 ? raw : raw.slice(0, dot);
  const whole = wholePart === "" ? 0n : BigInt(wholePart);
  if (whole > MAX_UINT64) {
    throw new TypeError(
      `invalid CPU value ${JSON.stringify(raw)}: value out of range`,
    );
  }
  if (dot === -1) {
    if (whole > MAX_UINT64 / MILLICORES_PER_VCPU) {
      throw new TypeError(
        `invalid CPU value ${JSON.stringify(raw)}: CPU value overflows millicores`,
      );
    }
    return { value: numberOrBigInt(whole), unit: "c" };
  }

  const fractionalPart = raw.slice(dot + 1);
  if (fractionalPart.length > 3) {
    throw new TypeError(
      `invalid CPU value ${JSON.stringify(raw)}: fractional CPU precision exceeds millicores`,
    );
  }
  const fractionalMillicores = BigInt(fractionalPart.padEnd(3, "0"));
  if (whole > (MAX_UINT64 - fractionalMillicores) / MILLICORES_PER_VCPU) {
    throw new TypeError(
      `invalid CPU value ${JSON.stringify(raw)}: CPU value overflows millicores`,
    );
  }
  const millicores = whole * MILLICORES_PER_VCPU + fractionalMillicores;
  if (millicores % MILLICORES_PER_VCPU === 0n) {
    return {
      value: numberOrBigInt(millicores / MILLICORES_PER_VCPU),
      unit: "c",
    };
  }
  return { value: numberOrBigInt(millicores), unit: "m" };
}

/**
 * Renders the quantity in the syntax {@link decodeCpu} accepts. The
 * rendering is canonical as well as lossless: a whole vCPU amount renders
 * as a bare number (`4`) whichever unit it is held in, a sub-vCPU amount
 * renders in millicores (`500m`), and zero renders as `0` in every unit,
 * so one amount of CPU has one spelling.
 */
export function formatCpu(quantity: CpuQuantity): string {
  const value = BigInt(quantity.value);
  if (value === 0n) return "0";
  if (quantity.unit === "c") return integerText(quantity.value);
  if (value % 1000n === 0n) return String(value / 1000n);
  return `${integerText(quantity.value)}m`;
}

/**
 * The quantity in millicores, the common unit for comparison. A vCPU count
 * beyond what a `number` holds exactly is returned as the nearest
 * representable value.
 */
export function cpuMillicores(quantity: CpuQuantity): number {
  return Number(millicoresExact(quantity));
}

/** Whether the quantity requests no CPU, in whichever unit it is held. */
export function isZeroCpu(quantity: CpuQuantity): boolean {
  return BigInt(quantity.value) === 0n;
}

/**
 * Orders two quantities by amount, so 1 vCPU and `1000m` compare equal even
 * though their fields differ. Returns -1 when `left` is the smaller amount,
 * 0 when the two are equal, and 1 when `left` is the larger.
 */
export function compareCpu(left: CpuQuantity, right: CpuQuantity): -1 | 0 | 1 {
  const a = millicoresExact(left);
  const b = millicoresExact(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The wire shape of a CPU quantity: the compact string, or the bare number
 * a manifest converted from YAML carries for `cpu: 1`.
 */
export const cpuQuantityShape: Shape<CpuQuantity> = scalar<CpuQuantity>({
  decode: decodeCpu,
  encode: formatCpu,
  zero: () => ({ value: 0, unit: "m" }),
  isZero: isZeroCpu,
  acceptsNumber: true,
});

/** The exact millicore count, for arithmetic that must not round. */
export function millicoresExact(quantity: CpuQuantity): bigint {
  const value = BigInt(quantity.value);
  return quantity.unit === "c" ? value * MILLICORES_PER_VCPU : value;
}
