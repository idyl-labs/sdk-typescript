// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The platform requests of Computer connections, on the Subnet API that
// serves the Account: the client certificate for the connection's key, the
// signed session trust, endpoint session creates, reads and
// cancels, and their renewal, each session on its own renew route.
// Each request carries the client's credential and its proof.

import type { PlacementContext } from "../internal/context.js";
import { accountSubnet } from "../internal/apipath.js";
import { resolvePlacement } from "../internal/routing.js";
import { TransportError } from "../errors.js";
import { decodeBase64, encodeBase64 } from "../resource/base64.js";
import type {
  ConnectorApi,
  IssuedCertificate,
  PlacedSessionTrust,
} from "../computer-connection/connector.js";
import type { SessionTrustResponse } from "../computer-connection/trust.js";
import {
  cancelSession,
  createSession,
  getSession,
  renewSessions,
  sessionsById,
} from "./computer-sessions.js";

/** The connector's platform requests in `context`. */
export function computerEndpointApi(
  context: () => Promise<PlacementContext>,
): ConnectorApi {
  return {
    async certify(request: Uint8Array): Promise<IssuedCertificate> {
      const c = await context();
      const resolved = await resolvePlacement(c);
      const answer = await c.state.transport.json<unknown>(
        "POST",
        resolved.endpoint,
        accountSubnet(
          c.scope.accountId,
          resolved.subnet,
          "client-certificates",
        ),
        { body: { csr: encodeBase64(request) } },
      );
      return issued(answer);
    },
    async sessionTrust(): Promise<PlacedSessionTrust> {
      const c = await context();
      const resolved = await resolvePlacement(c);
      const response = await c.state.transport.json<SessionTrustResponse>(
        "GET",
        resolved.endpoint,
        "/v1/session-trust",
      );
      return { scope: resolved.zone, response };
    },
    async createSession(computer, request) {
      return await createSession(
        await context(),
        sessionsById(computer),
        request,
        undefined,
      );
    },
    async readSession(computer, session, signal) {
      return await getSession(
        await context(),
        sessionsById(computer),
        session,
        signal,
      );
    },
    async renewSessions(computer, sessions) {
      return await renewSessions(
        await context(),
        sessionsById(computer),
        sessions,
      );
    },
    async cancelSession(computer, session) {
      await cancelSession(
        await context(),
        sessionsById(computer),
        session,
        undefined,
      );
    },
  };
}

/**
 * Reads the client certificate answer: the chain (base64 DER, leaf first),
 * the admission lease and the expiry.
 */
function issued(answer: unknown): IssuedCertificate {
  const a = (
    typeof answer === "object" && answer !== null ? answer : {}
  ) as Record<string, unknown>;
  const chain = a["chain"];
  const lease = a["admissionLease"];
  const notAfter =
    typeof a["notAfter"] === "string" ? Date.parse(a["notAfter"]) : Number.NaN;
  if (
    !Array.isArray(chain) ||
    chain.length === 0 ||
    !chain.every((c) => typeof c === "string") ||
    typeof lease !== "string" ||
    Number.isNaN(notAfter)
  ) {
    throw new TransportError(
      "invalid_response",
      "client certificate response is invalid",
    );
  }
  return {
    chain: chain.map((c: string) => decodeBase64(c)),
    admissionLease: decodeBase64(lease),
    notAfterMs: notAfter,
  };
}
