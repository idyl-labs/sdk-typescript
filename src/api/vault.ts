// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The Vault management routes' bounds and error vocabulary. A management
 * request carries secret material, so its body is bounded before it is
 * sent and an error it receives relays the platform's message only under a
 * code this vocabulary names.
 */
import {
  always,
  array,
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
import {
  isComputerId,
  isResourceId,
  isUuidId,
  type ComputerId,
  type ResourceId,
} from "../resource/uuid-id.js";
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

/**
 * Whether a decryption opened its value: `opened`; `refused`, the key
 * service refused, for example because the session was not entitled to the
 * value; or `failed`, Vault's request received no answer from the key
 * service, so whether the value was opened is not known to Vault, and the key
 * service's report of the same request replaces it. Open, as the platform
 * may name more; {@link validateVaultDecryption} judges membership.
 */
export type VaultDecryptionOutcome =
  "opened" | "refused" | "failed" | (string & Record<never, never>);

/**
 * Who reported a decryption: `vault`, Vault reported it and the key
 * service's report has not arrived; `kms`, only the key service reported
 * it, so Vault's code did not; or `both`. Open, as the platform may name
 * more; {@link validateVaultDecryption} judges membership.
 */
export type VaultDecryptionReportedBy =
  "vault" | "kms" | "both" | (string & Record<never, never>);

/** The most bytes {@link VaultDecryption.activation} holds. */
export const MAX_VAULT_DECRYPTION_ACTIVATION_BYTES = 64;

/** The most bytes {@link VaultDecryption.kmsRequestId} holds. */
export const MAX_VAULT_DECRYPTION_KMS_REQUEST_ID_BYTES = 128;

/**
 * One decryption of a stored Secret or TLSCertificate value: the record IDYL
 * keeps for the Account of every time the key that seals Vault values was
 * asked to open one. It never carries the value.
 *
 * Vault reports a decryption when it opens a value for a Computer or Pod
 * that is starting, and the key service's own log reports every decryption;
 * the two reports of one decryption share `kmsRequestId` and are one record.
 * A record only the key service reported names the value, the version and
 * the activation the key service saw, and no Computer, Pod or machine. Records
 * are kept for 90 days and removed with the Account.
 */
export interface VaultDecryption {
  /** When the decryption was made, an RFC 3339 time. Always written. */
  readonly at: string;
  /** `Secret` or `TLSCertificate`: the kind whose value was opened. Always written. */
  readonly kind: string;
  /** The opened resource's ID. Always written. */
  readonly resourceId: ResourceId;
  /**
   * The resource's name within its Namespace and Subnet when the value was
   * opened. A resource deleted and created again under the name has another
   * `resourceId`. Always written.
   */
  readonly name: string;
  /** The stored version whose value was opened, from 1. Always written. */
  readonly version: Integer;
  /** The canonical slug of the Subnet the resource resides in. Always written. */
  readonly subnet: string;
  /**
   * The Computer the value was opened for; `undefined` for a Pod's
   * decryption and for a record only the key service reported.
   */
  readonly computerId?: ComputerId;
  /**
   * The Pod instance the value was opened for; `undefined` for a Computer's
   * decryption and for a record only the key service reported.
   */
  readonly podId?: string;
  /**
   * The start the value was opened for: a Computer's activation or a Pod's
   * assignment; `undefined` when it was opened under no start's session.
   */
  readonly activation?: string;
  /**
   * The ID of the machine the value was released to; `undefined` for a
   * record only the key service reported.
   */
  readonly nodeId?: string;
  /** Whether the value was opened. Always written. */
  readonly outcome: VaultDecryptionOutcome;
  /** Who reported the decryption. Always written. */
  readonly reportedBy: VaultDecryptionReportedBy;
  /**
   * The key service's ID of the request; `undefined` only when Vault's
   * request received no answer that named one.
   */
  readonly kmsRequestId?: string;
}

/**
 * One page of decryption records, newest first. `totalCount` counts every
 * record of the listing, so a page that holds fewer is followed by another.
 */
export type ListVaultDecryptionsResponse = ListResponse<VaultDecryption>;

const vaultDecryptionShape: Shape<VaultDecryption> = object<VaultDecryption>({
  at: always(timestampShape),
  kind: always(string()),
  resourceId: always(string<ResourceId>()),
  name: always(string()),
  version: always(integer({ unsigned: true, bits: 64 })),
  subnet: always(string()),
  computerId: omitEmpty(string<ComputerId>()),
  podId: omitEmpty(string()),
  activation: omitEmpty(string()),
  nodeId: omitEmpty(string()),
  outcome: always(string<VaultDecryptionOutcome>()),
  reportedBy: always(string<VaultDecryptionReportedBy>()),
  kmsRequestId: omitEmpty(string()),
});

const listVaultDecryptionsResponseShape: Shape<ListVaultDecryptionsResponse> =
  object<ListVaultDecryptionsResponse>({
    items: always(array(vaultDecryptionShape)),
    totalCount: always(integer({ unsigned: false, bits: 64 })),
    snapshotCursor: omitEmpty(string()),
    continue: omitEmpty(string()),
  });

/**
 * Reads one decryption record leniently: a field, outcome or reporter newer
 * than this SDK is carried rather than refused, and
 * {@link validateVaultDecryption} judges it. `document` is JSON text or a
 * parsed value.
 */
export function decodeVaultDecryption(document: unknown): VaultDecryption {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, vaultDecryptionShape, "lenient");
}

/** Renders a decryption record as the document the platform emits. */
export function encodeVaultDecryption(record: VaultDecryption): unknown {
  return vaultDecryptionShape.encode(record);
}

/** Reads a page of decryption records leniently. */
export function decodeListVaultDecryptionsResponse(
  document: unknown,
): ListVaultDecryptionsResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, listVaultDecryptionsResponseShape, "lenient");
}

/** Renders a page of decryption records as the document the platform emits. */
export function encodeListVaultDecryptionsResponse(
  page: ListVaultDecryptionsResponse,
): unknown {
  return listVaultDecryptionsResponseShape.encode(page);
}

/** A machine ID: the unpadded base64url spelling of a 32-byte Ed25519 key. */
const NODE_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/**
 * Judges a decryption record's own shape, as the reference contract does:
 * a time; a kind of `Secret` or `TLSCertificate`; a canonical resource ID; a
 * name; a version from 1; a Subnet; at most one of a Computer and a Pod, each
 * a canonical ID; an activation and a key service request ID within their
 * bounds; a well-formed machine ID; an outcome and a reporter this SDK names;
 * and a key service request ID whenever the key service reported it. It does
 * not judge whether the named resource, Computer, Pod or machine still exists.
 * Throws a `TypeError`.
 */
export function validateVaultDecryption(record: VaultDecryption): void {
  if (record.at === "") throw new TypeError("vault decryption at is required");
  if (record.kind !== "Secret" && record.kind !== "TLSCertificate") {
    throw new TypeError(
      record.kind === ""
        ? "vault decryption kind is required"
        : `unknown vault decryption kind ${JSON.stringify(record.kind)}`,
    );
  }
  if (!isResourceId(record.resourceId)) {
    throw new TypeError("vault decryption resourceId must be a canonical UUID");
  }
  if (record.name === "") {
    throw new TypeError("vault decryption name is required");
  }
  if (BigInt(record.version) < 1n) {
    throw new TypeError("vault decryption version must be at least 1");
  }
  if (record.subnet === "") {
    throw new TypeError("vault decryption subnet is required");
  }
  const computerId = record.computerId ?? "";
  const podId = record.podId ?? "";
  if (computerId !== "" && podId !== "") {
    throw new TypeError("vault decryption names a Computer and a Pod");
  }
  if (computerId !== "" && !isComputerId(computerId)) {
    throw new TypeError("vault decryption computerId must be a canonical UUID");
  }
  if (podId !== "" && !isUuidId(podId)) {
    throw new TypeError("vault decryption podId must be a canonical UUID");
  }
  if (
    utf8Length(record.activation ?? "") > MAX_VAULT_DECRYPTION_ACTIVATION_BYTES
  ) {
    throw new TypeError(
      `vault decryption activation exceeds ${String(MAX_VAULT_DECRYPTION_ACTIVATION_BYTES)} bytes`,
    );
  }
  const nodeId = record.nodeId ?? "";
  if (nodeId !== "" && !NODE_ID.test(nodeId)) {
    throw new TypeError("vault decryption nodeId is malformed");
  }
  switch (record.outcome) {
    case "opened":
    case "refused":
    case "failed":
      break;
    case "":
      throw new TypeError("vault decryption outcome is required");
    default:
      throw new TypeError(
        `unknown vault decryption outcome ${JSON.stringify(record.outcome)}`,
      );
  }
  switch (record.reportedBy) {
    case "vault":
    case "kms":
    case "both":
      break;
    case "":
      throw new TypeError("vault decryption reportedBy is required");
    default:
      throw new TypeError(
        `unknown vault decryption reportedBy ${JSON.stringify(record.reportedBy)}`,
      );
  }
  const requestId = record.kmsRequestId ?? "";
  if (utf8Length(requestId) > MAX_VAULT_DECRYPTION_KMS_REQUEST_ID_BYTES) {
    throw new TypeError(
      `vault decryption kmsRequestId exceeds ${String(MAX_VAULT_DECRYPTION_KMS_REQUEST_ID_BYTES)} bytes`,
    );
  }
  if (requestId === "" && record.reportedBy !== "vault") {
    throw new TypeError(
      "vault decryption kmsRequestId is required when the key service reported it",
    );
  }
}

/**
 * Judges every record with {@link validateVaultDecryption}. Throws a
 * `TypeError` naming the item.
 */
export function validateListVaultDecryptionsResponse(
  page: ListVaultDecryptionsResponse,
): void {
  page.items.forEach((record, index) => {
    try {
      validateVaultDecryption(record);
    } catch (cause) {
      throw new TypeError(`items[${String(index)}]: ${errorMessage(cause)}`, {
        cause,
      });
    }
  });
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
