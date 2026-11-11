// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "../resource/json.js";
import type { AccountId } from "../resource/id.js";
import type { JsonObject } from "../resource/json.js";

/**
 * The common list parameters. Every field present here is encoded and
 * honored by the routes that accept it.
 *
 * Each field is sent as a query parameter only when it is set, so an unset
 * `limit` takes the server's page size.
 */
export interface ListOptions {
  /**
   * The maximum number of items to return in one page, sent as `limit`.
   * `undefined` omits the parameter and takes the server's default page size.
   * Both that default and the largest page the server will return are
   * server-defined and may change; read `totalCount` and page with `offset`
   * rather than assuming one request returns everything.
   */
  readonly limit?: Integer;
  /**
   * How many items to skip from the start of the server's ordering, sent as
   * `offset`. `undefined` omits the parameter and starts at the first item.
   * Offset paging reads a collection that may change between pages, so a
   * consumer that needs a point-in-time view should use a live-capable list
   * and its `snapshotCursor` instead.
   */
  readonly offset?: Integer;
  /**
   * Narrows the result, sent verbatim as `filter`. The expression grammar and
   * the attributes each route accepts are a server contract that this type
   * does not model or parse: the SDK forwards the string unchanged and the
   * server rejects what it does not understand. `undefined` omits the
   * parameter.
   */
  readonly filter?: string;
  /**
   * Orders the result, sent verbatim as `sort`, under the same server-defined
   * grammar as `filter`: the expression and the attributes a route can order
   * by belong to that route's public contract, not to this type. `undefined`
   * omits the parameter and takes the route's own ordering.
   */
  readonly sort?: string;
}

/**
 * The envelope every list route returns.
 *
 * `totalCount` is the total number of matches, not the page size.
 * `snapshotCursor` is present on the lists of resources a live stream
 * carries, and was read in the same snapshot as `items`. The cursor is
 * opaque and is passed back verbatim.
 */
export interface ListEnvelope<T, Count> {
  readonly items: readonly T[];
  readonly totalCount: Count;
  readonly snapshotCursor?: string;
  /**
   * The position the next page starts from, on the lists that page by
   * position rather than by offset, on every page but the last: opaque, and
   * passed back verbatim as that list's `continue` option.
   */
  readonly continue?: string;
}

/** List totals are JSON numbers. */
export type ListResponse<T> = ListEnvelope<T, Integer>;

/**
 * The body the API returns with a non-2xx status.
 *
 * `code` is the stable machine-readable classification and is what a caller
 * branches on. `error` is prose for a person: it is not a contract and is
 * never parsed. `details` carries per-code structured context and is present
 * only where a code documents it.
 */
export interface ErrorResponse {
  readonly error: string;
  readonly code?: string;
  readonly details?: JsonObject;
}

/**
 * The code on the refusal of a request whose `Idyl-Client` header names a
 * release of a product below the minimum version the API supports for that
 * product. It is returned with HTTP 426 Upgrade Required, and its details
 * carry the keys {@link CLIENT_UPGRADE_REQUIRED_DETAIL_PRODUCT},
 * {@link CLIENT_UPGRADE_REQUIRED_DETAIL_MINIMUM_VERSION},
 * {@link CLIENT_UPGRADE_REQUIRED_DETAIL_LATEST_VERSION}, and
 * {@link CLIENT_UPGRADE_REQUIRED_DETAIL_UPGRADE_URL}. The refused request
 * changes nothing. Clients classify on the code, never on the message.
 */
export const ERROR_CODE_CLIENT_UPGRADE_REQUIRED = "CLIENT_UPGRADE_REQUIRED";

/**
 * Refuses a Computer's execution settings that state a network class the
 * place the Computer lives in does not admit. It is returned with HTTP 403,
 * and its details name the refused class under `class` and the classes
 * admitted under `allowed`. Settings that state no network class receive
 * the default network and are not refused with this code. The refused
 * request changes nothing.
 */
export const ERROR_CODE_NETWORK_CLASS_NOT_ADMITTED =
  "NETWORK_CLASS_NOT_ADMITTED";

/**
 * Refuses a Computer whose isolation class the Subnet it lives in does not
 * admit, on a create or on an update that changes the class. It is returned
 * with HTTP 403, and its details name the refused class under
 * `isolation.class` and the classes admitted under
 * `allowedIsolationClasses`. A pending Computer session whose Computer's
 * isolation class the Subnet no longer admits fails with it as the session
 * reason `ISOLATION_CLASS_NOT_ADMITTED`. The refused request changes
 * nothing. Clients classify on the code, never on the message.
 */
export const ERROR_CODE_ISOLATION_CLASS_NOT_ADMITTED =
  "ISOLATION_CLASS_NOT_ADMITTED";

/**
 * The details key naming the refused product of a
 * {@link ERROR_CODE_CLIENT_UPGRADE_REQUIRED} refusal, as it appeared in the
 * request's `Idyl-Client` header. Its value is a string.
 */
export const CLIENT_UPGRADE_REQUIRED_DETAIL_PRODUCT = "product";
/**
 * The details key carrying the lowest release of the product the API
 * accepts. Its value is a string.
 */
export const CLIENT_UPGRADE_REQUIRED_DETAIL_MINIMUM_VERSION = "minimumVersion";
/**
 * The details key carrying the newest release of the product. Its value is
 * a string.
 */
export const CLIENT_UPGRADE_REQUIRED_DETAIL_LATEST_VERSION = "latestVersion";
/**
 * The details key carrying where the product's upgrade is described or
 * obtained. Its value is a string.
 */
export const CLIENT_UPGRADE_REQUIRED_DETAIL_UPGRADE_URL = "upgradeUrl";

/**
 * What a delete route returns.
 *
 * `accepted` reports that the platform recorded the deletion, not that the
 * resource is gone: release can continue after the call returns, so a caller
 * that needs the resource to be absent waits for it rather than inferring it
 * from this field. `deletedAt` is the RFC 3339 instant the deletion was
 * recorded, and is absent when the platform did not stamp one.
 */
export interface DeleteResponse {
  readonly accepted: boolean;
  readonly deletedAt?: string;
}

/**
 * Identifies a Namespace within an Account. Namespace names are unique within
 * their Account, so this pair is a complete organizational and authorization
 * address.
 */
export interface NamespaceScope {
  readonly accountId: AccountId;
  readonly namespace: string;
}
