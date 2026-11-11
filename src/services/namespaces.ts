// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { signalOption } from "../internal/options.js";
import { decodeNamespace } from "../api/namespace.js";
import type {
  CreateNamespaceRequest,
  CreateNamespaceResponse,
  GetNamespaceResponse,
  ListNamespacesResponse,
  Namespace,
  UpdateNamespaceRequest,
  UpdateNamespaceResponse,
} from "../api/namespace.js";
import type { DeleteResponse, ListOptions } from "../api/types.js";
import { evaluateNamespaceWait } from "../api/wait.js";
import { account, accountResource } from "../internal/apipath.js";
import type { PlacementContext } from "../internal/context.js";
import { asRecord, listEnvelope } from "../internal/envelopes.js";
import { listQuery } from "../internal/listquery.js";
import type { RequestOptions } from "../request.js";
import type { AccountId } from "../resource/id.js";
import { waitForDeletion } from "../wait.js";
import type { WaitOptions } from "../wait.js";
import { computersService } from "./computers.js";
import type { ComputersService } from "./computers.js";

/**
 * Account-owned Namespace operations. Requests and responses are the `api`
 * envelopes verbatim, the served Namespace read through `decodeNamespace`;
 * the platform judges a Namespace name's format.
 */
export interface NamespacesService {
  /** Creates a Namespace in the Account. */
  create(
    request: CreateNamespaceRequest,
    options?: RequestOptions,
  ): Promise<CreateNamespaceResponse>;
  /**
   * Reads a Namespace by name within the Account. Throws a `TypeError` when
   * `name` is blank.
   */
  get(name: string, options?: RequestOptions): Promise<GetNamespaceResponse>;
  /**
   * Replaces the fields the request states; a field left `undefined` is
   * unchanged. A terminating Namespace refuses the update with HTTP 409 and
   * `ERROR_CODE_NAMESPACE_TERMINATING`, which `isApiCode` classifies.
   * Throws a `TypeError` when `name` is blank.
   */
  update(
    name: string,
    request: UpdateNamespaceRequest,
    options?: RequestOptions,
  ): Promise<UpdateNamespaceResponse>;
  /**
   * Starts releasing a Namespace. The platform records it as terminating
   * and answers 202 with `accepted` set and `deletedAt` stamped; it then
   * drains the Namespace's Computers and every Namespace-scoped resource and
   * finalizes on its own. Deleting a Namespace that is already terminating
   * is accepted again with the same answer. Once
   * finalized, the name resolves 404 and may be reused. The reserved
   * `default` Namespace is refused with HTTP 403.
   *
   * A caller that needs the Namespace gone follows with
   * {@link NamespacesService.waitUntilDeleted}. Throws a `TypeError` when
   * `name` is blank.
   */
  delete(name: string, options?: RequestOptions): Promise<DeleteResponse>;
  /** One page of the Account's Namespaces. */
  list(
    options?: ListOptions,
    request?: RequestOptions,
  ): Promise<ListNamespacesResponse>;
  /**
   * Reads the Namespace back until it resolves 404, judging each read with
   * `evaluateNamespaceWait`. It resolves once the Namespace is gone; an
   * exhausted timeout rejects with a `TimeoutError` `DOMException`,
   * cancellation with the signal's reason, and any other read failure with
   * its error. Nothing is deleted. Throws a `TypeError` when `name` is
   * blank.
   */
  waitUntilDeleted(name: string, options?: WaitOptions): Promise<void>;
  /**
   * The Computers of one Namespace, named explicitly, in the client's
   * resolved Subnet, as `AccountsService.computers` serves them. Throws a
   * `TypeError` when `namespace` is blank.
   */
  computers(namespace: string): ComputersService;
}

/**
 * Builds the Namespace service for `accountId` over a client's state and
 * placement, which its Computers services resolve.
 */
export function namespacesService(
  context: PlacementContext,
  accountId: AccountId,
): NamespacesService {
  const { transport, endpoints } = context.state;
  const service: NamespacesService = {
    async create(request, options = {}) {
      return namespaceEnvelope(
        await transport.json<unknown>(
          "POST",
          endpoints.api,
          account(accountId, "namespaces"),
          { body: request, ...signalOption(options.signal) },
        ),
      );
    },
    async get(name, options = {}) {
      return namespaceEnvelope(
        await transport.json<unknown>(
          "GET",
          endpoints.api,
          accountResource(accountId, "namespaces", requireName(name)),
          signalOption(options.signal),
        ),
      );
    },
    async update(name, request, options = {}) {
      return namespaceEnvelope(
        await transport.json<unknown>(
          "PUT",
          endpoints.api,
          accountResource(accountId, "namespaces", requireName(name)),
          { body: request, ...signalOption(options.signal) },
        ),
      );
    },
    async delete(name, options = {}) {
      return await transport.json<DeleteResponse>(
        "DELETE",
        endpoints.api,
        accountResource(accountId, "namespaces", requireName(name)),
        signalOption(options.signal),
      );
    },
    async list(options = {}, request = {}) {
      const query = listQuery(options);
      const page = listEnvelope<unknown>(
        await transport.json<unknown>(
          "GET",
          endpoints.api,
          account(accountId, "namespaces") + query,
          signalOption(request.signal),
        ),
        "namespaces",
      );
      return { ...page, items: page.items.map(decodeNamespace) };
    },
    async waitUntilDeleted(name, options = {}) {
      requireName(name);
      await waitForDeletion<Namespace>(options, {
        kind: "Namespace",
        name,
        read: async (signal) => (await service.get(name, { signal })).namespace,
        evaluate: (namespace) => evaluateNamespaceWait(namespace, "deleted"),
      });
    },
    computers(namespace) {
      return computersService(context, accountId, requireNamespace(namespace));
    },
  };
  return Object.freeze(service);
}

/** Throws a `TypeError` unless `name` names a Namespace. */
export function requireNamespace(name: string): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("namespace is required");
  }
  return name;
}

/**
 * The `{ namespace }` envelope with its Namespace read through
 * `decodeNamespace`; everything else in the envelope is carried as it
 * arrived.
 */
function namespaceEnvelope(response: unknown): { namespace: Namespace } {
  const envelope = asRecord(response);
  return { ...envelope, namespace: decodeNamespace(envelope["namespace"]) };
}

function requireName(name: string): string {
  return requireNamespace(name);
}
