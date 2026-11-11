// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The Vault management routes' bounds and error vocabulary. A management
 * request carries secret material, so its body is bounded before it is
 * sent and an error it receives relays the platform's message only under a
 * code this vocabulary names.
 */
import {
  always,
  boolean,
  decodeValue,
  integer,
  isUint64,
  numberOrBigInt,
  object,
  omitEmpty,
  omitZero,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { parseJson, type Integer } from "../resource/json.js";
import {
  secretSpecShape,
  type RedactedSecret,
  type SecretSpec,
} from "../resource/secret.js";
import { timestampShape } from "../resource/shapes.js";
import { errorMessage } from "../resource/validation.js";
import type { ListResponse } from "./types.js";

/**
 * The most bytes the encoded JSON body of one Vault management request may
 * take. It bounds the encoded body, not the value it carries.
 */
export const MAX_VAULT_MANAGEMENT_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The stable codes a Vault refusal carries. Each is safe to show: none
 * discloses whether an unrelated resource exists.
 */
export const VAULT_ERROR_CODES: readonly string[] = Object.freeze([
  "VAULT_POLICY_DISABLED",
  "VAULT_RESOURCE_NOT_FOUND",
  "VAULT_VERSION_NOT_FOUND",
  "VAULT_KEY_NOT_FOUND",
  "VAULT_KIND_MISMATCH",
  "VAULT_RESOURCE_VERSION_CONFLICT",
  "VAULT_RESOURCE_DELETED",
  "VAULT_ACTIVE_BINDINGS",
  "VAULT_RUNTIME_CAPABILITY_MISSING",
  "VAULT_NODE_NOT_AUTHORIZED",
  "VAULT_ASSIGNMENT_STALE",
  "VAULT_PROJECTION_NOT_AUTHORIZED",
  "VAULT_PROJECTION_INVALID",
  "VAULT_AUTHORITY_UNAVAILABLE",
  "VAULT_STORAGE_UNAVAILABLE",
  "VAULT_ENCRYPTION_UNAVAILABLE",
  "VAULT_DECRYPTION_UNAVAILABLE",
  "VAULT_CERTIFICATE_INVALID",
  "VAULT_PAYLOAD_LIMIT_EXCEEDED",
  "VAULT_RESOURCE_LIMIT_EXCEEDED",
  "VAULT_DELIVERY_FAILED",
]);

const vaultErrorCodes: ReadonlySet<string> = new Set(VAULT_ERROR_CODES);

/** Whether `code` is one of {@link VAULT_ERROR_CODES}. */
export function isVaultErrorCode(code: string): boolean {
  return vaultErrorCodes.has(code);
}

/**
 * The request header naming a caller-chosen key that makes a rotation safe
 * to retry: repeating the same key cannot append a second version.
 */
export const VAULT_HEADER_IDEMPOTENCY_KEY = "Idempotency-Key";

/**
 * The request header carrying the strong resource-version ETag a rotation
 * is conditioned on: a stale value fails the rotation with
 * `VAULT_RESOURCE_VERSION_CONFLICT` instead of losing a concurrent change.
 */
export const VAULT_HEADER_IF_MATCH = "If-Match";

/**
 * The page of redacted Secrets a list returns. `totalCount` counts every
 * Secret of the Namespace in the addressed Subnet. No item carries a value.
 */
export type ListVaultSecretsResponse = ListResponse<RedactedSecret>;

/**
 * Appends one version to a Secret. Concurrency and idempotency travel only
 * in the `If-Match` and `Idempotency-Key` headers, never in the body.
 */
export interface RotateVaultSecretRequest {
  /** The new version's content, judged as a write. Always written. */
  readonly spec: SecretSpec;
}

/**
 * Permanently removes every version of a Vault resource. `confirm` must be
 * {@link VAULT_PURGE_CONFIRMATION}; any other value is refused with
 * `VAULT_PROJECTION_INVALID`. `force` purges a resource that live bindings
 * still hold; without it such a purge is refused with
 * `VAULT_ACTIVE_BINDINGS`.
 */
export interface PurgeVaultResourceRequest {
  /** Always written. */
  readonly confirm: string;
  /** `undefined` reads as `false`. */
  readonly force?: boolean;
}

/**
 * The word a purge states as its explicit confirmation. A purge cannot be
 * undone: no later write restores the resource or its ID.
 */
export const VAULT_PURGE_CONFIRMATION = "purge";

/** Whether a purge was accepted and, once it has completed, when. */
export interface PurgeVaultResourceResponse {
  /** Always written. */
  readonly accepted: boolean;
  /** When the purge completed, an RFC 3339 time; `undefined` until it has. */
  readonly purgedAt?: string;
}

/** One stored version of a Vault resource, as metadata only. */
export interface VaultVersionMetadata {
  /** The version number, from 1. Always written. */
  readonly version: Integer;
  /** When the version was written, an RFC 3339 time. */
  readonly createdAt?: string;
  /** Whether it is the resource's current version. Always written. */
  readonly current: boolean;
}

/** The page of a Vault resource's versions a version list returns. */
export type ListVaultVersionsResponse = ListResponse<VaultVersionMetadata>;

/**
 * The two headers every rotation carries; both are required. They travel
 * only as headers, never in a request body.
 */
export interface VaultRotateOptions {
  /**
   * A caller-chosen key, unique to one intended rotation, sent as
   * {@link VAULT_HEADER_IDEMPOTENCY_KEY}. Retrying with the same key cannot
   * append a second version.
   */
  readonly idempotencyKey: string;
  /**
   * The strong ETag of the resource version the rotation expects, such as
   * `"4"`, sent as {@link VAULT_HEADER_IF_MATCH};
   * {@link formatVaultResourceVersionETag} builds it.
   */
  readonly ifMatch: string;
}

/**
 * Judges a rotation's headers: a key with no surrounding whitespace and no
 * line break, and an `If-Match` that
 * {@link parseVaultResourceVersionETag} admits. Throws a `TypeError`.
 */
export function validateVaultRotateOptions(options: VaultRotateOptions): void {
  const { idempotencyKey, ifMatch } = options;
  if (idempotencyKey.trim() === "") {
    throw new TypeError(`${VAULT_HEADER_IDEMPOTENCY_KEY} header is required`);
  }
  if (idempotencyKey.trim() !== idempotencyKey) {
    throw new TypeError(
      `${VAULT_HEADER_IDEMPOTENCY_KEY} header must not contain surrounding whitespace`,
    );
  }
  if (ifMatch.trim() === "") {
    throw new TypeError(`${VAULT_HEADER_IF_MATCH} header is required`);
  }
  if (/[\r\n]/u.test(idempotencyKey)) {
    throw new TypeError(
      `${VAULT_HEADER_IDEMPOTENCY_KEY} header contains invalid characters`,
    );
  }
  if (/[\r\n]/u.test(ifMatch)) {
    throw new TypeError(
      `${VAULT_HEADER_IF_MATCH} header contains invalid characters`,
    );
  }
  try {
    parseVaultResourceVersionETag(ifMatch);
  } catch (cause) {
    throw new TypeError(
      `${VAULT_HEADER_IF_MATCH} header: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

/**
 * The canonical strong ETag of a resource version, such as `"4"`, which a
 * rotation's `If-Match` states. Throws a `TypeError` when the version is
 * not a positive integer.
 */
export function formatVaultResourceVersionETag(
  resourceVersion: Integer,
): string {
  const version = isUint64(resourceVersion) ? BigInt(resourceVersion) : 0n;
  if (version === 0n) {
    throw new TypeError("resource version must be greater than zero");
  }
  return `"${version.toString()}"`;
}

/**
 * Reads a strong ETag in its one canonical form, a quoted positive decimal
 * with no leading zero, as the resource version it states. A weak, wildcard,
 * unquoted, zero or otherwise non-canonical value is refused with a
 * `TypeError`.
 */
export function parseVaultResourceVersionETag(value: string): Integer {
  if (value.length < 3 || !value.startsWith('"') || !value.endsWith('"')) {
    throw new TypeError("must be a strong quoted decimal ETag");
  }
  const decimal = value.slice(1, -1);
  if (!/^[1-9][0-9]*$/u.test(decimal) || BigInt(decimal) >= 1n << 64n) {
    throw new TypeError(
      "must contain a canonical positive decimal resource version",
    );
  }
  return numberOrBigInt(BigInt(decimal));
}

const vaultVersionMetadataShape: Shape<VaultVersionMetadata> =
  object<VaultVersionMetadata>({
    version: always(integer({ unsigned: true, bits: 64 })),
    createdAt: omitZero(timestampShape),
    current: always(boolean()),
  });

/**
 * Reads one version's metadata leniently: a field newer than this package
 * is carried rather than refused.
 */
export function decodeVaultVersionMetadata(
  document: unknown,
): VaultVersionMetadata {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, vaultVersionMetadataShape, "lenient");
}

const purgeVaultResourceRequestShape: Shape<PurgeVaultResourceRequest> =
  object<PurgeVaultResourceRequest>({
    confirm: always(string()),
    force: omitEmpty(boolean()),
  });

/** Renders a purge request as the document the route reads. */
export function encodePurgeVaultResourceRequest(
  request: PurgeVaultResourceRequest,
): unknown {
  return purgeVaultResourceRequestShape.encode(request);
}

const rotateVaultSecretRequestShape: Shape<RotateVaultSecretRequest> =
  object<RotateVaultSecretRequest>({
    spec: always(secretSpecShape),
  });

/** Renders a rotation request as the document the route reads. */
export function encodeRotateVaultSecretRequest(
  request: RotateVaultSecretRequest,
): unknown {
  return rotateVaultSecretRequestShape.encode(request);
}
