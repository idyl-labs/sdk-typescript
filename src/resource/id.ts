// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Branded } from "./brand.js";

/** The fixed character width of every twelve-digit public identifier. */
export const ID_LENGTH = 12;

/**
 * The canonical identifier of an Account: twelve non-sequential ASCII digits.
 */
export type AccountId = Branded<"AccountId">;

/**
 * The canonical identifier of an Organization: twelve non-sequential ASCII
 * digits.
 */
export type OrganizationId = Branded<"OrganizationId">;

/** The address of the place a Computer lives in: twelve ASCII digits. */
export type SubnetSlug = Branded<"SubnetSlug">;

/**
 * Reports what is wrong with `value` as a twelve-digit identifier, or
 * `undefined` when it is one. The message names the family through `label`.
 */
function publicIdProblem(value: string, label: string): string | undefined {
  if (value.length !== ID_LENGTH) {
    return `invalid ${label}: must be exactly ${String(ID_LENGTH)} digits, got ${String(value.length)} characters`;
  }
  if (!/^[0-9]{12}$/u.test(value)) {
    return `invalid ${label}: must contain only ASCII digits`;
  }
  return undefined;
}

function parsePublicId(value: string, label: string): string {
  const problem = publicIdProblem(value, label);
  if (problem !== undefined) throw new TypeError(problem);
  return value;
}

function isPublicId(value: unknown): value is string {
  return typeof value === "string" && publicIdProblem(value, "") === undefined;
}

/**
 * Converts a raw string to an {@link AccountId}.
 *
 * @param value An Account's identifier, as twelve ASCII digits.
 * @throws {@link TypeError} `value` is not exactly twelve ASCII digits; the
 *   message names the identifier's family
 */
export function parseAccountId(value: string): AccountId {
  return parsePublicId(value, "account ID") as AccountId;
}

/** Reports whether `value` is a string in {@link AccountId} form. */
export function isAccountId(value: unknown): value is AccountId {
  return isPublicId(value);
}

/**
 * Converts a raw string to a {@link SubnetSlug}. Throws a `TypeError` naming
 * the family when `value` is not exactly twelve ASCII digits.
 */
export function parseSubnetSlug(value: string): SubnetSlug {
  if (value.length !== ID_LENGTH) {
    throw new TypeError(
      `subnet slug must be exactly ${String(ID_LENGTH)} characters`,
    );
  }
  if (!/^[0-9]{12}$/u.test(value)) {
    throw new TypeError("subnet slug must match [0-9]{12}");
  }
  return value as SubnetSlug;
}

/** Reports whether `value` is a string in {@link SubnetSlug} form. */
export function isSubnetSlug(value: unknown): value is SubnetSlug {
  return isPublicId(value);
}
