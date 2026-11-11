// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { parseJson, type Integer, type JsonObject } from "../resource/json.js";
import {
  validateComputerSize,
  type ComputerSize,
} from "../resource/computer-execution-settings.js";
import {
  cpuQuantityShape,
  isZeroCpu,
  type CpuQuantity,
} from "../resource/cpu.js";
import {
  isZeroMemory,
  memoryQuantityShape,
  type MemoryQuantity,
} from "../resource/memory.js";
import { prefixed } from "../resource/validation.js";
import {
  isZeroVolume,
  volumeQuantityShape,
  type VolumeQuantity,
} from "../resource/volume.js";
import {
  always,
  array,
  boolean,
  decodeValue,
  integer,
  object,
  omitEmpty,
  string,
  type Shape,
} from "../internal/strictdecode.js";

/**
 * One size a Computer can run at, as the platform offers it. A read carries a
 * field newer than this SDK; {@link validateComputerSizeInfo} judges.
 */
export interface ComputerSizeInfo {
  /** The size's name, which a Computer's create and update state. */
  readonly name: ComputerSize;
  /** The size's name for display, such as `Small`. */
  readonly label: string;
  /** The CPU limit of a Computer of this size. */
  readonly cpu: CpuQuantity;
  /** The memory limit of a Computer of this size. */
  readonly memory: MemoryQuantity;
  /** The most a Computer of this size can store. */
  readonly disk: VolumeQuantity;
  /**
   * The most files, folders and links a Computer of this size holds. A save
   * or an upload that adds names past it fails with `SAVE_REASON_NAME_LIMIT`.
   * `undefined` when the size has no such limit.
   */
  readonly names?: Integer;
  /** Whether a Computer that states no size, CPU or memory runs at this size. Always written. */
  readonly default: boolean;
}

const computerSizeInfoShape: Shape<ComputerSizeInfo> = object<ComputerSizeInfo>(
  {
    name: always(string()),
    label: always(string()),
    cpu: always(cpuQuantityShape),
    memory: always(memoryQuantityShape),
    disk: always(volumeQuantityShape),
    names: omitEmpty(integer({ unsigned: false, bits: 64 })),
    default: always(boolean()),
  },
);

/**
 * Every size a Computer can run at, smallest first, as `GET /v1/computer-sizes`
 * serves it. The read needs no credential.
 */
export interface ListComputerSizesResponse {
  /** Every size, smallest first. Always written, empty rather than omitted. */
  readonly items: readonly ComputerSizeInfo[];
}

const listComputerSizesResponseShape: Shape<ListComputerSizesResponse> =
  object<ListComputerSizesResponse>({
    items: always(array(computerSizeInfoShape)),
  });

/**
 * Judges the size: a name in identifier form, a label, a CPU, memory and
 * disk greater than zero, and a name limit that is not negative. Throws a
 * `TypeError`.
 */
export function validateComputerSizeInfo(size: ComputerSizeInfo): void {
  prefixed("name", () => {
    validateComputerSize(size.name);
  });
  if (size.label === "") throw new TypeError("label is required");
  if (isZeroCpu(size.cpu)) {
    throw new TypeError("cpu must be greater than zero");
  }
  if (isZeroMemory(size.memory)) {
    throw new TypeError("memory must be greater than zero");
  }
  if (isZeroVolume(size.disk)) {
    throw new TypeError("disk must be greater than zero");
  }
  if (size.names !== undefined && BigInt(size.names) < 0n) {
    throw new TypeError("names must not be negative");
  }
}

/**
 * Judges the list: valid sizes, each named once, and at most one default.
 * Throws a `TypeError`.
 */
export function validateListComputerSizesResponse(
  response: ListComputerSizesResponse,
): void {
  const names = new Set<ComputerSize>();
  let hasDefault = false;
  response.items.forEach((item, index) => {
    const at = `items[${String(index)}]`;
    prefixed(at, () => {
      validateComputerSizeInfo(item);
    });
    if (names.has(item.name)) {
      throw new TypeError(
        `${at}: size ${JSON.stringify(item.name)} is listed twice`,
      );
    }
    names.add(item.name);
    if (item.default && hasDefault) {
      throw new TypeError(`${at}: only one size can be the default`);
    }
    hasDefault ||= item.default;
  });
}

/**
 * Reads the list as served, leniently. `document` is JSON text or a value
 * already parsed from JSON.
 */
export function decodeListComputerSizesResponse(
  document: unknown,
): ListComputerSizesResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, listComputerSizesResponseShape, "lenient");
}

/** Renders the list as the document the platform emits. */
export function encodeListComputerSizesResponse(
  response: ListComputerSizesResponse,
): JsonObject {
  return listComputerSizesResponseShape.encode(response) as JsonObject;
}
