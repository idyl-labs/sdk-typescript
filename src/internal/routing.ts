// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * Placement resolution. A Computer lives in the place IDYL assigns its
 * Account, and that place's public API serves it. Every Computer operation
 * resolves it through the client's one placement source, judged at the bar
 * the operation needs, and builds the Namespace scope every Namespace-scoped
 * route is built from.
 */
import type { NamespaceScope } from "../api/types.js";
import type { SubnetSlug } from "../resource/id.js";
import type { PlacementContext } from "./context.js";

/** How a resolution is to be judged. */
export interface ResolvePlacementOptions {
  /**
   * Requires the client to have a Namespace. `undefined` requires one; an
   * account-wide operation passes `false`.
   */
  readonly requireNamespace?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Where a Computer operation is sent and what it is stamped with.
 *
 * `subnet` is the canonical slug of the place the Computer lives in and
 * `endpoint` the origin of its public API; `zone` is the trust scope
 * discovery names for the place, empty when it names none. `scope` is the
 * Namespace address
 * every Namespace-scoped route is built from; its `namespace` is empty when
 * the resolution did not require one.
 */
export interface ResolvedPlacement {
  readonly subnet: SubnetSlug;
  readonly endpoint: string;
  readonly zone: string;
  readonly scope: NamespaceScope;
}

/**
 * Resolves the client's placement to the API that serves it. Throws a
 * `TypeError` when a Namespace is required and the client has none, before
 * any request.
 */
export async function resolvePlacement(
  context: PlacementContext,
  options: ResolvePlacementOptions = {},
): Promise<ResolvedPlacement> {
  const requireNamespace = options.requireNamespace ?? true;
  const namespace = context.scope.namespace ?? "";
  if (requireNamespace && namespace.trim() === "") {
    throw new TypeError("namespace is required");
  }
  const assigned = await context.placement.resolve(context.scope.accountId, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    subnet: assigned.subnet,
    endpoint: assigned.endpoint,
    zone: assigned.zone,
    scope: { accountId: context.scope.accountId, namespace },
  };
}
