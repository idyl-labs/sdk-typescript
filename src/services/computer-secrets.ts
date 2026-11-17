// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The reads of a Namespace's Computers by the Secrets they attach: the
 * state of each attachment of one Computer, and every attachment of one
 * Secret across the Computers the caller may read. Both are read when asked
 * for, on the API that serves the Computers; neither reads a Secret's value,
 * and no Computer read carries them.
 */
import {
  decodeListComputerSecretAttachmentsResponse,
  decodeListComputersBySecretResponse,
  type ListComputerSecretAttachmentsResponse,
  type ListComputersBySecretResponse,
} from "../api/computer-secrets.js";
import type { NamespaceScope } from "../api/types.js";
import { computerSecretUsage, computersBySecret } from "../internal/apipath.js";
import { usageVersionsQuery } from "../internal/listquery.js";
import {
  decodeComputerSecretUsageResponse,
  type ComputerSecretUsageResponse,
} from "../api/secret-usage.js";
import type { PlacementContext } from "../internal/context.js";
import { served } from "../internal/envelopes.js";
import { signalOption } from "../internal/options.js";
import { resolvePlacement } from "../internal/routing.js";
import type { Integer } from "../resource/json.js";
import { parseResourceId } from "../resource/uuid-id.js";

/** Reads the attachment states of the Computer `path` addresses. */
export async function listSecretAttachments(
  context: PlacementContext,
  path: (scope: NamespaceScope) => string,
  signal: AbortSignal | undefined,
): Promise<ListComputerSecretAttachmentsResponse> {
  const resolved = await resolvePlacement(context, signalOption(signal));
  const response = await context.state.transport.json<unknown>(
    "GET",
    resolved.endpoint,
    path(resolved.scope),
    signalOption(signal),
  );
  return served("computer secrets", () =>
    decodeListComputerSecretAttachmentsResponse(response),
  );
}

/**
 * Reads every attachment of the Secret with ID `secretId` across the
 * Namespace's Computers. Throws a `TypeError` before any request when the
 * ID is not a canonical UUID.
 */
export async function listComputersBySecret(
  context: PlacementContext,
  secretId: string,
  signal: AbortSignal | undefined,
): Promise<ListComputersBySecretResponse> {
  const id = parseResourceId(secretId);
  const resolved = await resolvePlacement(context, signalOption(signal));
  const response = await context.state.transport.json<unknown>(
    "GET",
    resolved.endpoint,
    computersBySecret(resolved.scope, id),
    signalOption(signal),
  );
  return served("computers by secret", () =>
    decodeListComputersBySecretResponse(response),
  );
}

/**
 * Counts, without listing them, the Computers of the Namespace the context
 * addresses whose settings attach the Secret with ID `secretId`, and those
 * pinned to each of `versions`. Throws a `TypeError` before any request when
 * `secretId` is not a canonical UUID or `versions` is not one a usage read
 * may name.
 */
export async function computerSecretUsageOf(
  context: PlacementContext,
  secretId: string,
  versions: readonly Integer[],
  signal: AbortSignal | undefined,
): Promise<ComputerSecretUsageResponse> {
  const id = parseResourceId(secretId);
  const query = usageVersionsQuery(versions);
  const resolved = await resolvePlacement(context, signalOption(signal));
  const response = await context.state.transport.json<unknown>(
    "GET",
    resolved.endpoint,
    computerSecretUsage(resolved.scope, id) + query,
    signalOption(signal),
  );
  return served("computer secret usage", () =>
    decodeComputerSecretUsageResponse(response),
  );
}
