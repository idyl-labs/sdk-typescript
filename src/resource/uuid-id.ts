// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Branded } from "./brand.js";

/*
 * The identifiers below name platform records whose public form is a UUID
 * string. Each is a distinct family, so an ID of one kind cannot be passed
 * where an ID of another kind is expected, and each admits one spelling: the
 * canonical lowercase 8-4-4-4-12 form. The braced, URN, and unhyphenated forms
 * that general UUID parsers accept, and uppercase hexadecimal, are second
 * spellings of the same value.
 *
 * None of these families carries a codec: the string is the wire form, and
 * `parse*` judges a value where a caller is about to send one.
 */

const CANONICAL_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

/**
 * Identifies a Computer. A Computer is addressed by name or by this ID on
 * the public routes; the ID is the record's server-assigned identifier and
 * outlives any reuse of the name.
 */
export type ComputerId = Branded<"ComputerId">;

/**
 * Identifies a session of a Computer. It is assigned when the session is
 * created and names it on the Computer's session routes for the whole of
 * its life, before and after it is attached. It is not the identifier of
 * the attachment the session carries once it is ready.
 */
export type ComputerSessionId = Branded<"ComputerSessionId">;

/**
 * Identifies a notebook of a Computer. It is assigned when the notebook is
 * created and never changes, while the notebook's name may.
 */
export type ComputerNotebookId = Branded<"ComputerNotebookId">;

/**
 * Identifies a requested change of an Account's plan and its retained
 * result.
 */
export type BillingPlanChangeId = Branded<"BillingPlanChangeId">;

/** Identifies a purchase of extra usage by an Account. */
export type BillingPurchaseId = Branded<"BillingPurchaseId">;

/**
 * Identifies one entry of a Computer's journal. It is assigned when the
 * entry is admitted and never changes; an entry that records a Computer
 * session's Cell carries the same ID as that Cell.
 */
export type JournalEntryId = Branded<"JournalEntryId">;

/**
 * Identifies a Namespace. A Namespace is addressed by name within its Account
 * on public routes; this is the record's server-assigned stable identifier.
 */
export type NamespaceId = Branded<"NamespaceId">;

/**
 * Identifies an access key: a public key registered for a person or a
 * service account. It names the key's record; the private key never leaves
 * its holder.
 */
export type AccessKeyId = Branded<"AccessKeyId">;

/**
 * Identifies an access profile as the sign-in and token-exchange surface
 * names it, wherever a caller chooses which profile to assume.
 */
export type ProfileId = Branded<"ProfileId">;

/**
 * Converts a raw string to an {@link AccessKeyId}, admitting only the
 * canonical UUID form. Throws a `TypeError` naming the family otherwise.
 */
export function parseAccessKeyId(value: string): AccessKeyId {
  return parseUuidId(value, "access key ID") as AccessKeyId;
}

/**
 * Converts a raw string to a {@link ProfileId}, admitting only the canonical
 * UUID form.
 *
 * @param value A profile's identifier, as a lowercase canonical UUID.
 * @throws {@link TypeError} `value` is not a lowercase canonical UUID; the
 *   message names the identifier's family
 */
export function parseProfileId(value: string): ProfileId {
  return parseUuidId(value, "profile ID") as ProfileId;
}

function parseUuidId(value: string, label: string): string {
  if (!CANONICAL_UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

/**
 * Identifies one platform resource record, such as a Vault Secret, by the ID
 * its metadata reports. The ID outlives any reuse of the resource's name.
 */
export type ResourceId = Branded<"ResourceId">;

/**
 * Converts a raw string to a {@link ResourceId}, admitting only the
 * canonical UUID form. Throws a `TypeError` naming the family otherwise.
 */
export function parseResourceId(value: string): ResourceId {
  return parseUuidId(value, "resource ID") as ResourceId;
}

/** Reports whether `value` is a string in canonical {@link ResourceId} form. */
export function isResourceId(value: unknown): value is ResourceId {
  return isUuidId(value);
}

/** Reports whether `value` is a string in canonical UUID form. */
export function isUuidId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

/**
 * Converts a raw string to a {@link ComputerId}, admitting only the
 * canonical UUID form. Throws a `TypeError` naming the family otherwise.
 */
export function parseComputerId(value: string): ComputerId {
  return parseUuidId(value, "computer ID") as ComputerId;
}

/** Reports whether `value` is a string in canonical {@link ComputerId} form. */
export function isComputerId(value: unknown): value is ComputerId {
  return isUuidId(value);
}

/**
 * Converts a raw string to a {@link ComputerSessionId}, admitting only the
 * canonical UUID form. Throws a `TypeError` naming the family otherwise.
 */
export function parseComputerSessionId(value: string): ComputerSessionId {
  return parseUuidId(value, "computer session ID") as ComputerSessionId;
}

/** Reports whether `value` is a string in canonical {@link ComputerSessionId} form. */
export function isComputerSessionId(
  value: unknown,
): value is ComputerSessionId {
  return isUuidId(value);
}

/**
 * Converts a raw string to a {@link ComputerNotebookId}, admitting only the
 * canonical UUID form. Throws a `TypeError` naming the family otherwise.
 */
export function parseComputerNotebookId(value: string): ComputerNotebookId {
  return parseUuidId(value, "computer notebook ID") as ComputerNotebookId;
}

/**
 * Converts a raw string to a {@link JournalEntryId}, admitting only
 * the canonical UUID form. Throws a `TypeError` naming the family otherwise.
 */
export function parseJournalEntryId(value: string): JournalEntryId {
  return parseUuidId(value, "journal entry ID") as JournalEntryId;
}

/** Reports whether `value` is a string in canonical {@link JournalEntryId} form. */
export function isJournalEntryId(value: unknown): value is JournalEntryId {
  return isUuidId(value);
}

/**
 * Converts a raw string to a {@link NamespaceId}, admitting only the
 * canonical UUID form. Throws a `TypeError` naming the family otherwise.
 */
export function parseNamespaceId(value: string): NamespaceId {
  return parseUuidId(value, "namespace ID") as NamespaceId;
}

/** Reports whether `value` is a string in canonical {@link NamespaceId} form. */
export function isNamespaceId(value: unknown): value is NamespaceId {
  return isUuidId(value);
}

/** Identifies one storage operation by its stable canonical UUID. */
export type StorageOperationId = Branded<"StorageOperationId">;

/** Parses the canonical UUID of one storage operation; throws a TypeError otherwise. */
export function parseStorageOperationId(value: string): StorageOperationId {
  return parseUuidId(value, "storage operation ID") as StorageOperationId;
}

/** Reports whether value is a canonical storage operation identity. */
export function isStorageOperationId(
  value: unknown,
): value is StorageOperationId {
  return isUuidId(value);
}

/**
 * Identifies one wake or sleep of a Computer, and its retained result, by
 * its stable canonical UUID.
 */
export type ComputerOperationId = Branded<"ComputerOperationId">;

/** Parses the canonical UUID of one wake or sleep; throws a TypeError otherwise. */
export function parseComputerOperationId(value: string): ComputerOperationId {
  return parseUuidId(value, "computer operation ID") as ComputerOperationId;
}

/** Reports whether value is a canonical computer operation identity. */
export function isComputerOperationId(
  value: unknown,
): value is ComputerOperationId {
  return isUuidId(value);
}

/**
 * Converts a raw string to a {@link BillingPlanChangeId}, admitting only the
 * canonical UUID form. Throws a `TypeError` naming the family otherwise.
 */
export function parseBillingPlanChangeId(value: string): BillingPlanChangeId {
  return parseUuidId(value, "billing plan change ID") as BillingPlanChangeId;
}

/** Reports whether `value` is a string in canonical {@link BillingPlanChangeId} form. */
export function isBillingPlanChangeId(
  value: unknown,
): value is BillingPlanChangeId {
  return isUuidId(value);
}

/**
 * Converts a raw string to a {@link BillingPurchaseId}, admitting only the
 * canonical UUID form. Throws a `TypeError` naming the family otherwise.
 */
export function parseBillingPurchaseId(value: string): BillingPurchaseId {
  return parseUuidId(value, "billing purchase ID") as BillingPurchaseId;
}

/** Reports whether `value` is a string in canonical {@link BillingPurchaseId} form. */
export function isBillingPurchaseId(
  value: unknown,
): value is BillingPurchaseId {
  return isUuidId(value);
}
