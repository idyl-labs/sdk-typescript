// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The session routes of a Computer: create, read, cancel and renew. A
 * session runs on the Computer's own session endpoint, over the client's
 * Computer connection; these routes record its grant and keep its lease. A
 * create answers at once, and no request is held open while the Computer
 * wakes.
 *
 * Every call addresses the Computer either by name or by its stable
 * identity, and every request of one call addresses the Subnet its single
 * placement resolution named.
 */
import type { NamespaceScope } from "../api/types.js";
import {
  decodeListComputerSessionsResponse,
  type ListComputerSessionsResponse,
} from "../api/computer-awake.js";
import {
  ERROR_CODE_SESSION_FINAL,
  decodeComputerSession,
  encodeCreateComputerSessionRequest,
  isComputerSessionPhaseTerminal,
  validateCreateComputerSessionRequest,
  type CreateComputerSessionRequest,
  type ComputerSession,
} from "../api/computer-session.js";
import { ApiError, TransportError, isApiCode } from "../errors.js";
import { computerSessions, computerSessionsById } from "../internal/apipath.js";
import type { PlacementContext } from "../internal/context.js";
import { requireNonBlank, signalOption } from "../internal/options.js";
import {
  resolvePlacement,
  type ResolvedPlacement,
} from "../internal/routing.js";
import {
  parseComputerId,
  parseComputerSessionId,
  type ComputerSessionId,
} from "../resource/uuid-id.js";
import { prefixed } from "../resource/validation.js";

/**
 * One Computer's session collection, built from the scope the resolution
 * named; with `sessionId`, one session in it.
 */
type SessionCollection = (
  scope: NamespaceScope,
  sessionId?: ComputerSessionId,
) => string;

/**
 * The session collection of the Computer addressed by name. Throws a
 * `TypeError` when `name` is blank.
 */
export function sessionsByName(name: string): SessionCollection {
  requireNonBlank(name, "computer name");
  return (scope, sessionId) => computerSessions(scope, name, sessionId);
}

/**
 * The session collection of the Computer addressed by its stable identity.
 * Throws a `TypeError` when `id` is not a canonical UUID.
 */
export function sessionsById(id: string): SessionCollection {
  const computerId = parseComputerId(id);
  return (scope, sessionId) =>
    computerSessionsById(scope, computerId, sessionId);
}

/**
 * Creates a session in the collection on a fresh resolution and returns it
 * as the platform answered. The request is judged before anything is sent,
 * and a response that does not carry a canonical session ID and its
 * Computer's ID is refused.
 */
export async function createSession(
  context: PlacementContext,
  collection: SessionCollection,
  request: CreateComputerSessionRequest,
  signal: AbortSignal | undefined,
): Promise<ComputerSession> {
  prefixed("create computer session request is invalid", () => {
    validateCreateComputerSessionRequest(request);
    encodeCreateComputerSessionRequest(request);
  });
  const resolved = await resolvePlacement(context, signalOption(signal));
  const value = await context.state.transport.json<unknown>(
    "POST",
    resolved.endpoint,
    collection(resolved.scope),
    {
      body: encodeCreateComputerSessionRequest(request),
      ...signalOption(signal),
    },
  );
  const session = servedSession(value);
  try {
    parseComputerSessionId(session.id);
    parseComputerId(session.computer);
  } catch (cause) {
    throw new TransportError(
      "invalid_response",
      "create computer session response is invalid",
      { cause },
    );
  }
  return session;
}

/**
 * A served session, read leniently. A session the package cannot read is
 * the platform's failure, never the caller's, so it is an
 * `invalid_response` `TransportError`.
 */
function servedSession(value: unknown): ComputerSession {
  try {
    return decodeComputerSession(value);
  } catch (cause) {
    throw new TransportError(
      "invalid_response",
      "computer session response is invalid",
      { cause },
    );
  }
}

/**
 * Reads one session of the collection, as it now is, on a fresh
 * resolution. A response naming another session is refused.
 */
export async function getSession(
  context: PlacementContext,
  collection: SessionCollection,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<ComputerSession> {
  const id = parseComputerSessionId(sessionId);
  const resolved = await resolvePlacement(context, signalOption(signal));
  const value = await context.state.transport.json<unknown>(
    "GET",
    resolved.endpoint,
    collection(resolved.scope, id),
    signalOption(signal),
  );
  return sameSession(servedSession(value), id, "read");
}

/**
 * Lists the open sessions of the collection's Computer on a fresh
 * resolution, as anyone who may read the Computer sees them.
 */
export async function listSessions(
  context: PlacementContext,
  collection: SessionCollection,
  signal: AbortSignal | undefined,
): Promise<ListComputerSessionsResponse> {
  const resolved = await resolvePlacement(context, signalOption(signal));
  return decodeListComputerSessionsResponse(
    await context.state.transport.json<unknown>(
      "GET",
      resolved.endpoint,
      collection(resolved.scope),
      signalOption(signal),
    ),
  );
}

/** Cancels one session of the collection on a fresh resolution. */
export async function cancelSession(
  context: PlacementContext,
  collection: SessionCollection,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const id = parseComputerSessionId(sessionId);
  const resolved = await resolvePlacement(context, signalOption(signal));
  await context.state.transport.json<undefined>(
    "DELETE",
    resolved.endpoint,
    collection(resolved.scope, id),
    { response: "none", ...signalOption(signal) },
  );
}

/**
 * Renews one session of the collection on a fresh resolution, with a POST
 * that has no body, and returns the session as the renewal left it. A
 * response naming another session is refused.
 */
export async function renewSession(
  context: PlacementContext,
  collection: SessionCollection,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<ComputerSession> {
  const id = parseComputerSessionId(sessionId);
  const resolved = await resolvePlacement(context, signalOption(signal));
  return await renewAt(context, resolved, collection, id, signal);
}

/**
 * Renews several sessions of the collection on one placement resolution:
 * each session is renewed by its own POST to its renew route, all at once,
 * and no session's failure keeps the others from being sent.
 *
 * Resolves to the sessions that renewing again cannot keep, so the caller
 * stops renewing them: an ID that is not a canonical UUID, which is never
 * sent; a renewal answered with HTTP 404, the session or its Computer not
 * found; a renewal refused with HTTP 409 and `SESSION_FINAL`; and a renewal
 * that answers the session in a final phase. Every other failure, such as a
 * network failure, HTTP 429 or a server error, leaves its session out of
 * the result, to be renewed again. Placement is resolved only when an ID
 * is valid, and the call rejects only when that resolution fails.
 */
export async function renewSessions(
  context: PlacementContext,
  collection: SessionCollection,
  sessionIds: readonly string[],
): Promise<string[]> {
  const over: string[] = [];
  const ids: ComputerSessionId[] = [];
  for (const sessionId of sessionIds) {
    try {
      ids.push(parseComputerSessionId(sessionId));
    } catch {
      over.push(sessionId);
    }
  }
  if (ids.length === 0) return over;
  const resolved = await resolvePlacement(context);
  const outcomes = await Promise.allSettled(
    ids.map((id) => renewAt(context, resolved, collection, id, undefined)),
  );
  outcomes.forEach((outcome, index) => {
    const id = ids[index];
    if (id === undefined) return;
    if (
      outcome.status === "fulfilled"
        ? isComputerSessionPhaseTerminal(outcome.value.status.phase)
        : sessionOver(outcome.reason)
    ) {
      over.push(id);
    }
  });
  return over;
}

/**
 * Whether a renewal's failure says the session can never be renewed: HTTP
 * 404, or HTTP 409 with `SESSION_FINAL`.
 */
function sessionOver(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.status === 404) ||
    (isApiCode(error, ERROR_CODE_SESSION_FINAL) && error.status === 409)
  );
}

/**
 * Renews one session of the collection on `resolved` with a POST that has
 * no body. A response naming another session is refused.
 */
async function renewAt(
  context: PlacementContext,
  resolved: ResolvedPlacement,
  collection: SessionCollection,
  id: ComputerSessionId,
  signal: AbortSignal | undefined,
): Promise<ComputerSession> {
  const value = await context.state.transport.json<unknown>(
    "POST",
    resolved.endpoint,
    `${collection(resolved.scope, id)}/renew`,
    signalOption(signal),
  );
  return sameSession(servedSession(value), id, "renew");
}

/** `session`, refused when it is not the session `id` the call addressed. */
function sameSession(
  session: ComputerSession,
  id: ComputerSessionId,
  call: "read" | "renew",
): ComputerSession {
  if (session.id !== id) {
    throw new TransportError(
      "invalid_response",
      `${call} computer session response names a different session`,
    );
  }
  return session;
}
