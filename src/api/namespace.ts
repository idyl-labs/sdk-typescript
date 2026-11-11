// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { parseJson } from "../resource/json.js";
import type { Integer } from "../resource/json.js";
import {
  always,
  array,
  boolean,
  decodeValue,
  integer,
  object,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { parseAccountId, type AccountId } from "../resource/id.js";
import type { JsonObject } from "../resource/json.js";
import { publicIdShape, timestampShape } from "../resource/shapes.js";
import type { NamespaceId } from "../resource/uuid-id.js";
import type { ListResponse } from "./types.js";

/**
 * The lifecycle state of a Namespace.
 *
 * - `active`: in service; it resolves, and every Namespace-scoped operation
 *   is accepted subject to authorization.
 * - `terminating`: deletion has been accepted and not yet finalized. It
 *   still resolves: reads and deletes are accepted, and creates and edits
 *   are refused with {@link ERROR_CODE_NAMESPACE_TERMINATING}.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateNamespacePhase} judges
 * membership.
 */
export type NamespacePhase =
  "active" | "terminating" | (string & Record<never, never>);

/**
 * Judges that the phase is one this SDK names. The empty string is reported
 * as missing: a served Namespace always carries a phase. Throws a
 * `TypeError`.
 */
export function validateNamespacePhase(phase: NamespacePhase): void {
  switch (phase) {
    case "active":
    case "terminating":
      return;
    case "":
      throw new TypeError("namespace phase is required");
    default:
      throw new TypeError(`unknown namespace phase ${JSON.stringify(phase)}`);
  }
}

/**
 * The code on the HTTP 409 that refuses a create or an edit because the
 * Namespace it addresses is terminating. The error's `details` carry
 * `namespace`, the name of that Namespace. Classify on the code with
 * `isApiCode`, never on the message.
 */
export const ERROR_CODE_NAMESPACE_TERMINATING = "NAMESPACE_TERMINATING";

/**
 * A Namespace as the platform serves it: the Account-scoped organizational
 * boundary that Computers are named within.
 *
 * `name` is what every Namespace-scoped route addresses beneath its
 * Account. It is unique among the Account's live Namespaces, fixed at
 * creation, and free to reuse once a previous holder has been finalized.
 * `description` is the only field an update can change.
 *
 * `phase` is the lifecycle state: `active` for a Namespace in service,
 * `terminating` from the moment a delete is accepted until the platform
 * finalizes the release. Deletion is asynchronous: the platform drains the
 * Namespace's Computers and every Namespace-scoped resource in every zone,
 * then finalizes, and a finalized Namespace no longer resolves.
 * `terminatingAt` is the instant the delete was recorded, the same instant
 * the delete response reported as `deletedAt`, and `termination` reports
 * what still holds finalization back; both are present only while
 * terminating. While terminating, reads and deletes are accepted and creates
 * and edits, in the Namespace or of it, are refused with HTTP 409 and
 * {@link ERROR_CODE_NAMESPACE_TERMINATING}.
 *
 * `deletedAt` is the instant the platform finalized the release. A
 * finalized Namespace resolves 404, so a Namespace a client can read has no
 * `deletedAt`; `phase`, not `deletedAt`, reports a release in progress.
 */
export interface Namespace {
  readonly id: NamespaceId;
  readonly accountId: AccountId;
  readonly name: string;
  readonly description: string;
  readonly phase: NamespacePhase;
  /** When the delete was recorded, as an RFC 3339 instant; present only while terminating. */
  readonly terminatingAt?: string;
  /** What still holds finalization back; present only while terminating. */
  readonly termination?: NamespaceTermination;
  /** When the platform created the Namespace, as an RFC 3339 instant. */
  readonly createdAt: string;
  /** When the platform last updated the Namespace, as an RFC 3339 instant. */
  readonly updatedAt: string;
  /** When the platform finalized the release, as an RFC 3339 instant. */
  readonly deletedAt?: string;
}

/**
 * What still holds a terminating Namespace back from finalization. The
 * platform finalizes only once `computersRemaining` is zero and every zone
 * in `zones` has acknowledged and reports nothing remaining; a zone that
 * cannot be reached holds the Namespace in terminating.
 */
export interface NamespaceTermination {
  /** The Namespace's Computers not yet finalized. Zero is a reading and is always emitted. */
  readonly computersRemaining: Integer;
  /**
   * Every zone that must drain the Namespace's resources and acknowledge, in
   * the platform's order. Always an array, never null; a Namespace with no
   * zone to drain carries an empty array.
   */
  readonly zones: readonly NamespaceZoneDrain[];
}

/** One zone's progress draining a terminating Namespace. */
export interface NamespaceZoneDrain {
  /** The zone's name as the platform reports it. */
  readonly zone: string;
  /**
   * Whether the zone has answered at all. A zone that has not is a holdout
   * whatever `remaining` says.
   */
  readonly acknowledged: boolean;
  /** The instant of the zone's latest report; absent until it has acknowledged. */
  readonly reportedAt?: string;
  /**
   * The Namespace-scoped resources still live in the zone, one entry per
   * kind. Always an array, never null; a drained zone carries an empty array
   * or only zero counts.
   */
  readonly remaining: readonly NamespaceResourceCount[];
}

/** How many resources of one kind remain. */
export interface NamespaceResourceCount {
  /**
   * The resource family, spelled as its kind. A kind this SDK does
   * not name is carried as reported.
   */
  readonly kind: string;
  /** The number still live. Zero is a reading and is always emitted. */
  readonly count: Integer;
}

const namespaceResourceCountShape: Shape<NamespaceResourceCount> =
  object<NamespaceResourceCount>({
    kind: always(string()),
    count: always(integer({ unsigned: false, bits: 64 })),
  });

const namespaceZoneDrainShape: Shape<NamespaceZoneDrain> =
  object<NamespaceZoneDrain>({
    zone: always(string()),
    acknowledged: always(boolean()),
    reportedAt: pointer(timestampShape),
    remaining: always(array(namespaceResourceCountShape)),
  });

const namespaceTerminationShape: Shape<NamespaceTermination> =
  object<NamespaceTermination>({
    computersRemaining: always(integer({ unsigned: false, bits: 64 })),
    zones: always(array(namespaceZoneDrainShape)),
  });

const namespaceShape: Shape<Namespace> = object<Namespace>({
  id: always(string<NamespaceId>()),
  accountId: always(publicIdShape(parseAccountId)),
  name: always(string()),
  description: always(string()),
  phase: always(string<NamespacePhase>()),
  terminatingAt: pointer(timestampShape),
  termination: pointer(namespaceTerminationShape),
  createdAt: always(timestampShape),
  updatedAt: always(timestampShape),
  deletedAt: pointer(timestampShape),
});

/**
 * Renders a served Namespace as the document the platform emits: `phase` is
 * always written, `terminatingAt` and `termination` only when present, and
 * the termination counts and arrays always, zero and empty included.
 */
export function encodeNamespace(namespace: Namespace): JsonObject {
  return namespaceShape.encode(namespace) as JsonObject;
}

/**
 * Reads a Namespace the platform served, leniently. `document` is JSON text
 * or a value already parsed from JSON; a string is parsed once, as a
 * response is. A field this SDK does not declare is carried as it arrived,
 * a value the shape cannot read is carried as it arrived, and a missing
 * field reads as its zero value, as the reference contract reads it. Nothing is judged;
 * `validateNamespacePhase` judges the phase on the result.
 */
export function decodeNamespace(document: unknown): Namespace {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, namespaceShape, "lenient");
}

/**
 * Creates a Namespace in the Account the request addresses. `name` is
 * immutable after creation, must be 3 to 63 characters in the platform's
 * namespace-name format, and is unique among the Account's live Namespaces;
 * the platform judges the format.
 */
export interface CreateNamespaceRequest {
  readonly name: string;
  readonly description?: string;
}

/** The created Namespace, including its server-assigned ID. */
export interface CreateNamespaceResponse {
  readonly namespace: Namespace;
}

/** One Namespace, addressed by name within its Account. */
export interface GetNamespaceResponse {
  readonly namespace: Namespace;
}

/**
 * A partial Namespace update. Only the description can change; a field
 * left `undefined` is unchanged. An update of a terminating Namespace is
 * refused with {@link ERROR_CODE_NAMESPACE_TERMINATING}.
 */
export interface UpdateNamespaceRequest {
  readonly description?: string;
}

/** The Namespace after the update was applied. */
export interface UpdateNamespaceResponse {
  readonly namespace: Namespace;
}

/** The paged list of one Account's Namespaces. */
export type ListNamespacesResponse = ListResponse<Namespace>;
