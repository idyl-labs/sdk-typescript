// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  always,
  array,
  boolean,
  decodeValue,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { parseJson, type Integer } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";
import { validateComputerEnvironmentVariableName } from "../resource/computer-execution-settings.js";
import {
  isComputerId,
  isResourceId,
  type ComputerId,
  type ResourceId,
} from "../resource/uuid-id.js";
import { errorMessage } from "../resource/validation.js";

/**
 * Whether an attachment's value can be sent: `healthy`, `expiring` within
 * seven days, or `broken`. Open, as the platform may name more; the
 * validator judges membership.
 */
export type ComputerSecretAttachmentHealth =
  "healthy" | "expiring" | "broken" | (string & Record<never, never>);

/**
 * Why an attachment is not healthy. `expiring` goes with the health of that
 * name; every other reason goes with `broken`:
 *
 * - `secret_deleted`: the attached Secret was deleted; writing to its name
 *   within seven days of the delete restores it, and the attachment resumes;
 * - `secret_not_found`: no Secret with the attachment's ID exists in the
 *   Computer's Namespace and Subnet;
 * - `not_attached`: the attachment came with a fork's or a restore's
 *   settings and was never attached to this Computer;
 * - `no_egress`: the Secret no longer states a source and an egress;
 * - `expired`: the value has expired;
 * - `source_failed`: the Secret's source cannot produce a value.
 *
 * Open, as the platform may name more; the validator judges membership.
 */
export type ComputerSecretAttachmentReason =
  | "secret_deleted"
  | "secret_not_found"
  | "not_attached"
  | "no_egress"
  | "expiring"
  | "expired"
  | "source_failed"
  | (string & Record<never, never>);

/** The state of one Secret attachment of a Computer. */
export interface ComputerSecretAttachmentStatus {
  /** The environment variable that holds the placeholder. Always written. */
  readonly env: string;
  /** The ID of the Secret the attachment holds. Always written. */
  readonly secret: ResourceId;
  /** Whether the attachment's value can be sent. Always written. */
  readonly health: ComputerSecretAttachmentHealth;
  /** Why the health is not `healthy`; `undefined` when it is. */
  readonly reason?: ComputerSecretAttachmentReason;
  /**
   * When the value the attachment sends stops being valid, an RFC 3339
   * time; `undefined` while no expiry is known.
   */
  readonly expiresAt?: string;
}

/**
 * The state of each Secret attachment of a Computer, one item per attachment
 * in its execution settings in force, in their order. It is read on its own
 * route when asked for; a Computer read never carries it.
 */
export interface ListComputerSecretAttachmentsResponse {
  /** One status per attachment. Always written, empty when none. */
  readonly items: readonly ComputerSecretAttachmentStatus[];
}

const computerSecretAttachmentStatusShape: Shape<ComputerSecretAttachmentStatus> =
  object<ComputerSecretAttachmentStatus>({
    env: always(string()),
    secret: always(string<ResourceId>()),
    health: always(string<ComputerSecretAttachmentHealth>()),
    reason: omitEmpty(string<ComputerSecretAttachmentReason>()),
    expiresAt: pointer(timestampShape),
  });

const listComputerSecretAttachmentsResponseShape: Shape<ListComputerSecretAttachmentsResponse> =
  object<ListComputerSecretAttachmentsResponse>({
    items: always(array(computerSecretAttachmentStatusShape)),
  });

/**
 * Reads an attachment-state list leniently: a field, health or reason newer
 * than this SDK is carried rather than refused, and
 * {@link validateListComputerSecretAttachmentsResponse} judges it.
 */
export function decodeListComputerSecretAttachmentsResponse(
  document: unknown,
): ListComputerSecretAttachmentsResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(
    value,
    listComputerSecretAttachmentsResponseShape,
    "lenient",
  );
}

/** Renders an attachment-state list as the document the platform emits. */
export function encodeListComputerSecretAttachmentsResponse(
  page: ListComputerSecretAttachmentsResponse,
): unknown {
  return listComputerSecretAttachmentsResponseShape.encode(page);
}

const BROKEN_REASONS: ReadonlySet<string> = new Set([
  "secret_deleted",
  "secret_not_found",
  "not_attached",
  "no_egress",
  "expired",
  "source_failed",
]);

/**
 * Judges one attachment's state: a well-formed variable, a Secret ID in
 * canonical form, a health this SDK names, and a reason exactly when the
 * health is not `healthy`: `expiring` with the health of that name, any
 * other reason with `broken`. Throws a `TypeError`.
 */
export function validateComputerSecretAttachmentStatus(
  status: ComputerSecretAttachmentStatus,
): void {
  try {
    validateComputerEnvironmentVariableName(status.env);
  } catch (cause) {
    throw new TypeError(`env: ${errorMessage(cause)}`, { cause });
  }
  if (!isResourceId(status.secret)) {
    throw new TypeError("secret: resource ID must be a canonical UUID");
  }
  const reason = status.reason ?? "";
  switch (status.health) {
    case "healthy":
      if (reason !== "") {
        throw new TypeError("reason must be absent when healthy");
      }
      return;
    case "expiring":
      if (reason !== "expiring") {
        throw new TypeError("reason must be expiring when expiring");
      }
      return;
    case "broken":
      if (reason === "") throw new TypeError("reason is required when broken");
      if (!BROKEN_REASONS.has(reason)) {
        throw new TypeError(
          `unknown attachment reason ${JSON.stringify(reason)}`,
        );
      }
      return;
    case "":
      throw new TypeError("health is required");
    default:
      throw new TypeError(
        `unknown attachment health ${JSON.stringify(status.health)}`,
      );
  }
}

/**
 * Judges every item with {@link validateComputerSecretAttachmentStatus}, and
 * that no variable is listed twice. Throws a `TypeError` naming the item.
 */
export function validateListComputerSecretAttachmentsResponse(
  page: ListComputerSecretAttachmentsResponse,
): void {
  const seen = new Map<string, number>();
  page.items.forEach((item, index) => {
    try {
      validateComputerSecretAttachmentStatus(item);
    } catch (cause) {
      throw new TypeError(`items[${String(index)}]: ${errorMessage(cause)}`, {
        cause,
      });
    }
    const previous = seen.get(item.env);
    if (previous !== undefined) {
      throw new TypeError(
        `items[${String(index)}].env duplicates items[${String(previous)}]`,
      );
    }
    seen.set(item.env, index);
  });
}

/**
 * One attachment of a Secret in one Computer's execution settings: which
 * Computer, through which variable, whether it is attached there, and
 * whether it is pinned to a version.
 */
export interface ComputerSecretUse {
  /** The stable ID of the Computer that holds the attachment. Always written. */
  readonly computer: ComputerId;
  /** The Computer's name within its Namespace and Subnet. Always written. */
  readonly computerName: string;
  /** The environment variable that holds the placeholder. Always written. */
  readonly env: string;
  /**
   * Whether the attachment was attached to this Computer by a caller who
   * held `vaultsecret:reference` on the Secret. An attachment that came with
   * the settings of a fork or a restore, and was never attached here, reads
   * `false`: its value is not sent, and its health reads `not_attached`,
   * until it is attached here. Always written.
   */
  readonly attached: boolean;
  /**
   * The version of the Secret the attachment is pinned to. `undefined` when
   * the attachment follows the Secret's current version, so a rotation
   * reaches it; a pinned attachment keeps its version.
   */
  readonly version?: Integer;
}

/**
 * Every attachment of one Secret in the execution settings of the Computers
 * the caller may read: one item per attachment that holds the Secret's ID,
 * ordered by Computer name and then by variable.
 *
 * It lists the settings in force, which a Computer applies from its next
 * start, so sleeping and awake Computers are listed alike; an awake Computer
 * keeps the attachments it started with until it next starts. It is read at
 * one moment, and one response holds every item, so it is not paged.
 * Computers the caller may not read are left out. The Secret itself is not
 * read: an ID that no readable Computer attaches reads as no items, whether
 * or not a Secret has it.
 */
export interface ListComputersBySecretResponse {
  /** One item per attachment. Always written, empty when none. */
  readonly items: readonly ComputerSecretUse[];
}

const computerSecretUseShape: Shape<ComputerSecretUse> =
  object<ComputerSecretUse>({
    computer: always(string<ComputerId>()),
    computerName: always(string()),
    env: always(string()),
    attached: always(boolean()),
    version: omitEmpty(integer({ unsigned: true, bits: 64 })),
  });

const listComputersBySecretResponseShape: Shape<ListComputersBySecretResponse> =
  object<ListComputersBySecretResponse>({
    items: always(array(computerSecretUseShape)),
  });

/**
 * Reads the attachments of a Secret leniently: a field newer than this SDK
 * is carried rather than refused, and
 * {@link validateListComputersBySecretResponse} judges it.
 */
export function decodeListComputersBySecretResponse(
  document: unknown,
): ListComputersBySecretResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, listComputersBySecretResponseShape, "lenient");
}

/** Renders the attachments of a Secret as the document the platform emits. */
export function encodeListComputersBySecretResponse(
  page: ListComputersBySecretResponse,
): unknown {
  return listComputersBySecretResponseShape.encode(page);
}

/**
 * Judges one attachment of a Secret: a Computer ID in canonical form, a
 * Computer name, and a well-formed variable. Throws a `TypeError`.
 */
export function validateComputerSecretUse(use: ComputerSecretUse): void {
  if (!isComputerId(use.computer)) {
    throw new TypeError("computer: computer ID must be a canonical UUID");
  }
  if (use.computerName === "") {
    throw new TypeError("computerName is required");
  }
  try {
    validateComputerEnvironmentVariableName(use.env);
  } catch (cause) {
    throw new TypeError(`env: ${errorMessage(cause)}`, { cause });
  }
}

/**
 * Judges every item with {@link validateComputerSecretUse}, and that no
 * Computer lists one variable twice; one Computer may attach the Secret
 * through two variables. Throws a `TypeError` naming the item.
 */
export function validateListComputersBySecretResponse(
  page: ListComputersBySecretResponse,
): void {
  const seen = new Map<string, number>();
  page.items.forEach((item, index) => {
    try {
      validateComputerSecretUse(item);
    } catch (cause) {
      throw new TypeError(`items[${String(index)}]: ${errorMessage(cause)}`, {
        cause,
      });
    }
    const key = `${item.computer} ${item.env}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new TypeError(
        `items[${String(index)}] duplicates items[${String(previous)}]`,
      );
    }
    seen.set(key, index);
  });
}
