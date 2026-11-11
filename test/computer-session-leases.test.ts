// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_SESSION_LEASE_MS,
  ERROR_CODE_SESSION_FINAL,
} from "../src/api/computer-session.js";
import { isApiCode } from "../src/errors.js";
import { type JsonObject } from "../src/resource/json.js";
import {
  FakeControlPlane,
  errorResponse,
  json,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
import type { RecordedRequest } from "./fakes/fetch-queue.js";
import { computerEndpointApi } from "../src/services/computer-endpoint-sessions.js";

const COMPUTER_ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const SESSION_ID = "01954e20-7540-7ec4-93ec-14f783e6ab20";
const sessionsPath = `${namespacePathPrefix}/computers/payments/sessions`;
const sessionsByIdPath = `${namespacePathPrefix}/computers/by-id/${COMPUTER_ID}/sessions`;
const renewPath = `${sessionsPath}/${SESSION_ID}/renew`;

/** An RFC 3339 instant `ms` milliseconds from now. */
function future(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** A Computer session golden, as the platform serves it. */
function golden(state: string): JsonObject {
  return JSON.parse(
    readFileSync(
      new URL(
        `./conformance/fixtures/api/testdata/golden/computer-session.${state}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as JsonObject;
}

/** The attached golden as a renewal answers it: its lease moved to a full lease from now. */
function renewed(): JsonObject {
  const document = golden("attached");
  return {
    ...document,
    id: SESSION_ID,
    computer: COMPUTER_ID,
    status: {
      ...(document["status"] as JsonObject),
      expiresAt: future(COMPUTER_SESSION_LEASE_MS),
    },
  };
}

/** Answers every renewal with the next of `answers`; the last repeats. */
function renewals(answers: readonly (() => Response)[]): {
  readonly plane: FakeControlPlane;
  readonly renews: () => RecordedRequest[];
} {
  let answered = 0;
  const plane = new FakeControlPlane({
    routes: (request) => {
      if (request.url.host !== subnetHost) return undefined;
      if (!request.url.pathname.endsWith("/renew")) return undefined;
      const answer = answers[Math.min(answered, answers.length - 1)];
      answered += 1;
      return answer?.();
    },
  });
  return {
    plane,
    renews: () =>
      plane.requests.filter(
        (request) =>
          request.url.host === subnetHost &&
          request.url.pathname.endsWith("/renew"),
      ),
  };
}

describe("computers.renewSession", () => {
  // Contract: a renewal is a POST with no body to the session's renew
  // route, by Computer name or stable identity, and returns the session as
  // the renewal left it.
  it("renews a session by name or identity", async () => {
    const { plane, renews } = renewals([() => json(renewed())]);
    const computers = plane.client().account.computers;
    const session = await computers.renewSession("payments", SESSION_ID);
    expect(session.id).toBe(SESSION_ID);
    expect(session.status.phase).toBe("attached");
    await computers.renewSessionById(COMPUTER_ID, SESSION_ID);
    expect(
      renews().map((request) => [
        request.method,
        request.url.pathname,
        request.body,
      ]),
    ).toEqual([
      ["POST", renewPath, undefined],
      ["POST", `${sessionsByIdPath}/${SESSION_ID}/renew`, undefined],
    ]);
  });

  // Contract: renewing a final session is relayed with its code; a
  // response naming another session is refused; a malformed session ID is
  // refused before any request.
  it("relays a final session and refuses another session", async () => {
    const final = renewals([
      () => errorResponse(409, ERROR_CODE_SESSION_FINAL, "session ended"),
    ]);
    const error = await final.plane
      .client()
      .account.computers.renewSession("payments", SESSION_ID)
      .catch((caught: unknown) => caught);
    expect(isApiCode(error, ERROR_CODE_SESSION_FINAL)).toBe(true);

    const other = renewals([
      () => json({ ...renewed(), id: "01954e20-7540-7ec4-93ec-14f783e6ab21" }),
    ]);
    await expect(
      other.plane
        .client()
        .account.computers.renewSession("payments", SESSION_ID),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "renew computer session response names a different session",
    });

    const none = renewals([() => json(renewed())]);
    await expect(
      none.plane.client().account.computers.renewSession("payments", "s-1"),
    ).rejects.toThrow(TypeError);
    expect(none.plane.requests).toEqual([]);
  });
});

describe("Computer connection renewals", () => {
  const OTHER_ID = "01954e20-7540-7ec4-93ec-14f783e6ab21";

  // Contract: a Computer connection renews each session it holds with its
  // own POST, with no body, to that session's renew route by the
  // Computer's stable identity, the one renewal route the platform serves.
  it("renews each session on its own renew route", async () => {
    const plane = new FakeControlPlane({
      routes: (request) => {
        if (request.url.host !== subnetHost) return undefined;
        const id = [SESSION_ID, OTHER_ID].find(
          (session) =>
            request.url.pathname === `${sessionsByIdPath}/${session}/renew`,
        );
        return id === undefined ? undefined : json({ ...renewed(), id });
      },
    });
    const { context } = plane.client();
    const api = computerEndpointApi(() => Promise.resolve(context));
    await api.renewSessions(COMPUTER_ID, [SESSION_ID, OTHER_ID]);
    expect(
      plane.requests
        .filter((request) => request.url.host === subnetHost)
        .map((request) => [request.method, request.url.pathname, request.body])
        .sort(),
    ).toEqual([
      ["POST", `${sessionsByIdPath}/${SESSION_ID}/renew`, undefined],
      ["POST", `${sessionsByIdPath}/${OTHER_ID}/renew`, undefined],
    ]);
  });

  // Contract: no session's failure keeps the others from being sent, and
  // the call resolves to the sessions renewing again cannot keep: HTTP
  // 404, HTTP 409 with SESSION_FINAL, and a session answered in a final
  // phase. A network-class failure (HTTP 429, a server error) and any
  // other conflict leave the session to be renewed again.
  it("reports the sessions renewing cannot keep", async () => {
    const id = (n: number): string =>
      `01954e20-7540-7ec4-93ec-14f783e6ab${String(30 + n)}`;
    const answers: readonly (() => Response)[] = [
      () => errorResponse(404, "COMPUTER_SESSION_NOT_FOUND", "not found"),
      () => errorResponse(409, ERROR_CODE_SESSION_FINAL, "session ended"),
      () => errorResponse(503, "UNAVAILABLE", "unavailable"),
      () => errorResponse(429, "RATE_LIMITED", "slow down"),
      () => errorResponse(409, "CONFLICT", "conflict"),
      () => json({ ...renewed(), id: id(5) }),
      () => {
        const ended = golden("ended");
        return json({ ...ended, id: id(6), computer: COMPUTER_ID });
      },
    ];
    const ids = answers.map((_, n) => id(n));
    const plane = new FakeControlPlane({
      routes: (request) => {
        if (request.url.host !== subnetHost) return undefined;
        const n = ids.findIndex(
          (session) =>
            request.url.pathname === `${sessionsByIdPath}/${session}/renew`,
        );
        return n < 0 ? undefined : answers[n]?.();
      },
    });
    const { context } = plane.client();
    const api = computerEndpointApi(() => Promise.resolve(context));
    const over = await api.renewSessions(COMPUTER_ID, ids);
    expect([...over].sort()).toEqual([id(0), id(1), id(6)]);
    expect(
      plane.requests
        .filter(
          (request) =>
            request.url.host === subnetHost &&
            request.url.pathname.endsWith("/renew"),
        )
        .map((request) => request.url.pathname)
        .sort(),
    ).toEqual(ids.map((session) => `${sessionsByIdPath}/${session}/renew`));
  });

  // Contract: an ID that is not a canonical UUID is never sent and is
  // reported as one renewing cannot keep; the other sessions are still
  // renewed.
  it("renews the others when one ID is not canonical", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost ? json(renewed()) : undefined,
    });
    const client = plane.client();
    const over = await computerEndpointApi(() =>
      Promise.resolve(client.context),
    ).renewSessions(COMPUTER_ID, ["s-1", SESSION_ID]);
    expect(over).toEqual(["s-1"]);
    expect(
      plane.requests
        .filter((request) => request.url.host === subnetHost)
        .map((request) => request.url.pathname),
    ).toEqual([`${sessionsByIdPath}/${SESSION_ID}/renew`]);
  });

  // Contract: when no ID is a canonical UUID nothing is sent, not even the
  // placement read, and every ID is reported as one renewing cannot keep.
  it("sends nothing when no ID is canonical", async () => {
    const plane = new FakeControlPlane({
      routes: () => json(renewed()),
    });
    const client = plane.client();
    const over = await computerEndpointApi(() =>
      Promise.resolve(client.context),
    ).renewSessions(COMPUTER_ID, ["s-1", "s-2"]);
    expect(over).toEqual(["s-1", "s-2"]);
    expect(plane.requests).toEqual([]);
  });
});
