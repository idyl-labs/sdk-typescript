// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  always,
  array,
  decodeValue,
  integer,
  object,
  omitEmpty,
  boolean,
  pointer,
  type Shape,
} from "../internal/strictdecode.js";
import { parseJson, type Integer } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";
import { errorMessage } from "../resource/validation.js";
import { LIST_COUNT_BOUND } from "./computer.js";
import type { VaultDecryptionOutcome } from "./vault.js";

/**
 * BoundedCount is a count that stops at `LIST_COUNT_BOUND`: `count` is
 * exact up to the bound, and when there are more, `count` is the bound and
 * `isLowerBound` is `true`, which a client shows as "1,000+".
 */
export interface BoundedCount {
  readonly count: Integer;
  readonly isLowerBound?: boolean;
}

/** The most versions one usage read asks about. */
export const MAX_USAGE_VERSIONS = 100;

/**
 * Judges the versions a usage read names: at most {@link MAX_USAGE_VERSIONS},
 * each a whole number of at least 1, none named twice. Throws a `TypeError`.
 */
export function validateUsageVersions(versions: readonly Integer[]): void {
  if (versions.length > MAX_USAGE_VERSIONS) {
    throw new TypeError(
      `a usage read names at most ${String(MAX_USAGE_VERSIONS)} versions`,
    );
  }
  const seen = new Set<string>();
  versions.forEach((version, index) => {
    const value = BigInt(version);
    if (value < 1n) {
      throw new TypeError(`version ${String(index)}: a version is at least 1`);
    }
    if (seen.has(value.toString())) {
      throw new TypeError(`version ${value.toString()} is named twice`);
    }
    seen.add(value.toString());
  });
}

/**
 * ComputerSecretUsageResponse counts the Computers of one Namespace and
 * Subnet whose execution settings attach one Secret, without listing them.
 * Each count is bounded. `computers` counts every such Computer;
 * `notAttached` those with an attachment of the Secret that is not attached
 * there, whose value is not sent; `following` those with an attachment that
 * follows the Secret's current version. `pinned` holds, for each version the
 * request names, the Computers with an attachment pinned to it, in the
 * request's order.
 */
export interface ComputerSecretUsageResponse {
  readonly computers: BoundedCount;
  readonly notAttached: BoundedCount;
  readonly following: BoundedCount;
  readonly pinned: readonly ComputerSecretPinnedCount[];
}

/** The bounded count of Computers with an attachment pinned to one version of a Secret. */
export interface ComputerSecretPinnedCount {
  readonly version: Integer;
  readonly count: BoundedCount;
}

/** How far back a usage read counts openings, in milliseconds: the record's whole retention of 90 days. */
export const VAULT_USAGE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * VaultSecretUsageResponse counts the openings of one Secret's values in the
 * last {@link VAULT_USAGE_WINDOW_MS} by outcome, without listing them; each
 * count is bounded. `versions` holds, for each version the request names,
 * when a value of that version was last opened, in the request's order.
 */
export interface VaultSecretUsageResponse {
  readonly opened: BoundedCount;
  readonly refused: BoundedCount;
  readonly failed: BoundedCount;
  readonly versions: readonly VaultVersionLastOpened[];
}

/**
 * When a value of one version was last opened; `lastOpenedAt` is absent
 * when none was within {@link VAULT_USAGE_WINDOW_MS}.
 */
export interface VaultVersionLastOpened {
  readonly version: Integer;
  readonly lastOpenedAt?: string;
}

/**
 * The list `filter` that narrows a decryption record to one outcome, such
 * as `outcome=refused`.
 */
export function vaultDecryptionOutcomeFilter(
  outcome: VaultDecryptionOutcome,
): string {
  return `outcome=${outcome}`;
}

const boundedCountShape: Shape<BoundedCount> = object<BoundedCount>({
  count: always(integer({ unsigned: false, bits: 64 })),
  isLowerBound: omitEmpty(boolean()),
});

const computerSecretPinnedCountShape: Shape<ComputerSecretPinnedCount> =
  object<ComputerSecretPinnedCount>({
    version: always(integer({ unsigned: true, bits: 64 })),
    count: always(boundedCountShape),
  });

const computerSecretUsageResponseShape: Shape<ComputerSecretUsageResponse> =
  object<ComputerSecretUsageResponse>({
    computers: always(boundedCountShape),
    notAttached: always(boundedCountShape),
    following: always(boundedCountShape),
    pinned: always(array(computerSecretPinnedCountShape)),
  });

const vaultVersionLastOpenedShape: Shape<VaultVersionLastOpened> =
  object<VaultVersionLastOpened>({
    version: always(integer({ unsigned: true, bits: 64 })),
    lastOpenedAt: pointer(timestampShape),
  });

const vaultSecretUsageResponseShape: Shape<VaultSecretUsageResponse> =
  object<VaultSecretUsageResponse>({
    opened: always(boundedCountShape),
    refused: always(boundedCountShape),
    failed: always(boundedCountShape),
    versions: always(array(vaultVersionLastOpenedShape)),
  });

/** Reads the Computer usage of a Secret leniently; {@link validateComputerSecretUsageResponse} judges it. */
export function decodeComputerSecretUsageResponse(
  document: unknown,
): ComputerSecretUsageResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, computerSecretUsageResponseShape, "lenient");
}

/** Renders the Computer usage of a Secret as the document the platform emits. */
export function encodeComputerSecretUsageResponse(
  usage: ComputerSecretUsageResponse,
): unknown {
  return computerSecretUsageResponseShape.encode(usage);
}

/** Reads the openings of a Secret leniently; {@link validateVaultSecretUsageResponse} judges it. */
export function decodeVaultSecretUsageResponse(
  document: unknown,
): VaultSecretUsageResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, vaultSecretUsageResponseShape, "lenient");
}

/** Renders the openings of a Secret as the document the platform emits. */
export function encodeVaultSecretUsageResponse(
  usage: VaultSecretUsageResponse,
): unknown {
  return vaultSecretUsageResponseShape.encode(usage);
}

/**
 * Judges a bounded count: between zero and `LIST_COUNT_BOUND`, and exactly
 * the bound when it is a lower bound. Throws a `TypeError`.
 */
export function validateBoundedCount(count: BoundedCount): void {
  const value = Number(count.count);
  if (value < 0 || value > LIST_COUNT_BOUND) {
    throw new TypeError(
      `count must be between 0 and ${String(LIST_COUNT_BOUND)}`,
    );
  }
  if (count.isLowerBound === true && value !== LIST_COUNT_BOUND) {
    throw new TypeError(
      `a lower-bound count must be ${String(LIST_COUNT_BOUND)}`,
    );
  }
}

/** Judges each count of a Computer usage read. Throws a `TypeError` naming the field. */
export function validateComputerSecretUsageResponse(
  usage: ComputerSecretUsageResponse,
): void {
  judged("computers", () => {
    validateBoundedCount(usage.computers);
  });
  judged("notAttached", () => {
    validateBoundedCount(usage.notAttached);
  });
  judged("following", () => {
    validateBoundedCount(usage.following);
  });
  usage.pinned.forEach((pinned, index) => {
    judged(`pinned[${String(index)}].count`, () => {
      validateBoundedCount(pinned.count);
    });
  });
}

/** Judges each count of a Secret's openings. Throws a `TypeError` naming the field. */
export function validateVaultSecretUsageResponse(
  usage: VaultSecretUsageResponse,
): void {
  judged("opened", () => {
    validateBoundedCount(usage.opened);
  });
  judged("refused", () => {
    validateBoundedCount(usage.refused);
  });
  judged("failed", () => {
    validateBoundedCount(usage.failed);
  });
}

function judged(field: string, judge: () => void): void {
  try {
    judge();
  } catch (cause) {
    throw new TypeError(`${field}: ${errorMessage(cause)}`, { cause });
  }
}
