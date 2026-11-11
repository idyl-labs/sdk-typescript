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
import { computersBySecret } from "../internal/apipath.js";
import type { PlacementContext } from "../internal/context.js";
import { served } from "../internal/envelopes.js";
import { signalOption } from "../internal/options.js";
import { resolvePlacement } from "../internal/routing.js";
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
