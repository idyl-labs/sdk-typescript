// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allComputerSessionReasons,
  decodeComputerSession,
  encodeCreateComputerSessionRequest,
  encodeComputerSession,
  isComputerSessionPhaseTerminal,
  validateCreateComputerSessionRequest,
  validateComputerSession,
  validateComputerSessionPhase,
  validateComputerSessionReason,
  computerSessionReasonClass,
  ERROR_CODE_EXECUTION_NOT_ENABLED,
  type CreateComputerSessionRequest,
  type ComputerSession,
  type ComputerSessionReason,
} from "../src/api/computer-session.js";
import { evaluateComputerSessionWait } from "../src/api/wait.js";
import { ApiError, isApiCode, isNotFound } from "../src/errors.js";
import { type JsonObject } from "../src/resource/json.js";
import {
  isComputerSessionId,
  parseComputerSessionId,
} from "../src/resource/uuid-id.js";
import {
  FakeControlPlane,
  errorResponse,
  json,
  namespace,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
import type { RecordedRequest } from "./fakes/fetch-queue.js";

const COMPUTER_ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const SESSION_ID = "01954e20-7540-7ec4-93ec-14f783e6ab20";
const sessionsPath = `${namespacePathPrefix}/computers/payments/sessions`;
const sessionsByIdPath = `${namespacePathPrefix}/computers/by-id/${COMPUTER_ID}/sessions`;

/** A golden of the reference contract, as the platform serves it. */
function golden(name: string): JsonObject {
  return JSON.parse(
    readFileSync(
      new URL(
        `./conformance/fixtures/api/testdata/golden/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as JsonObject;
}

const readyDocument = golden("computer-session.ready");
const pendingDocument = golden("computer-session.pending");
const ready = decodeComputerSession(readyDocument);
const pending = decodeComputerSession(pendingDocument);
const execSpec = ready.spec;
const shellSpec = pending.spec;
const cellSpec = decodeComputerSession({
  ...readyDocument,
  spec: golden("computer.session-notebook-request"),
}).spec;

/** The pending golden as the session the exec spec created. */
const pendingExecDocument: JsonObject = {
  ...pendingDocument,
  spec: readyDocument["spec"] ?? null,
};

function refusal(validate: () => void): string {
  try {
    validate();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

/** `request` without its `key` arm. */
function without(
  request: CreateComputerSessionRequest,
  key: "shell" | "endpoint",
): CreateComputerSessionRequest {
  return Object.fromEntries(
    Object.entries(request).filter(([name]) => name !== key),
  ) as unknown as CreateComputerSessionRequest;
}

function withStatus(
  session: ComputerSession,
  status: Partial<ComputerSession["status"]>,
): ComputerSession {
  return { ...session, status: { ...session.status, ...status } };
}

function subnetCalls(requests: readonly RecordedRequest[]): string[] {
  return requests
    .filter((request) => request.url.host === subnetHost)
    .map((request) => `${request.method} ${request.url.pathname}`);
}

describe("Computer session requests", () => {
  // Contract: the one offered pair, shell with the endpoint attachment, is
  // accepted for a shell, a command and a notebook cell, and a stated
  // client is accepted with it.
  it("accepts the endpoint attachment in each mode", () => {
    for (const spec of [execSpec, shellSpec, cellSpec]) {
      expect(() => {
        validateCreateComputerSessionRequest(spec);
      }).not.toThrow();
    }
    expect(() => {
      validateCreateComputerSessionRequest({ ...cellSpec, client: "console" });
    }).not.toThrow();
  });

  // Contract: a session may name no shell, in any mode: it then runs the
  // Computer's default shell, or the shell the platform chooses, and the
  // request carries no shell arm. A shell it names is still judged.
  it("accepts a session that names no shell", () => {
    for (const spec of [execSpec, shellSpec]) {
      const request = without(spec, "shell");
      expect(() => {
        validateCreateComputerSessionRequest(request);
      }).not.toThrow();
      expect(encodeCreateComputerSessionRequest(request)).not.toHaveProperty(
        "shell",
      );
    }
    expect(
      refusal(() => {
        validateCreateComputerSessionRequest({
          ...execSpec,
          shell: { executable: "zsh" },
        });
      }),
    ).toBe("shell.executable must be a clean absolute POSIX path");
  });

  // Contract: Logs, Files, and exec operations, every attachment other than
  // the endpoint, a missing endpoint arm, a notebook outside a cell or a
  // records stream, a cell without one, an invalid notebook name, and a
  // create without the key its stream names are refused with the sentences
  // the reference contract refuses them with.
  it("refuses what Computer sessions do not offer", () => {
    const cases: readonly [CreateComputerSessionRequest, string][] = [
      [
        { ...execSpec, operation: "logs" },
        'operation "logs" is not offered for Computer sessions',
      ],
      [
        { ...execSpec, operation: "exec" },
        'operation "exec" is not offered for Computer sessions',
      ],
      [
        { ...execSpec, attachment: "ssh" },
        'attachment "ssh" is not offered for Computer sessions',
      ],
      [
        { ...execSpec, attachment: "direct-fabric" },
        'attachment "direct-fabric" is not offered for Computer sessions',
      ],
      [
        { ...execSpec, attachment: "framed-websocket" },
        'attachment "framed-websocket" is not offered for Computer sessions',
      ],
      [{ ...execSpec, attachment: "" }, "attachment is required"],
      [
        without(execSpec, "endpoint"),
        "an endpoint attachment requires the endpoint arm",
      ],
      [
        { ...shellSpec, notebook: "build" },
        "a cell or a records stream names its notebook, and only those do",
      ],
      [
        { ...cellSpec, notebook: "" },
        "a cell or a records stream names its notebook, and only those do",
      ],
      [
        { ...cellSpec, notebook: "Build" },
        "notebook name must contain only lowercase letters, digits, or '-'",
      ],
      [
        { ...execSpec, idempotencyKey: "" },
        "an endpoint attachment requires the idempotency key its stream names",
      ],
    ];
    for (const [request, message] of cases) {
      expect(
        refusal(() => {
          validateCreateComputerSessionRequest(request);
        }),
      ).toBe(message);
    }
  });

  // Contract: the notebook is written only when it is named, and the
  // request carries no arm but the shell and the endpoint.
  it("writes the notebook only when one is named", () => {
    expect(
      encodeCreateComputerSessionRequest({ ...execSpec, notebook: "" }),
    ).not.toHaveProperty("notebook");
    const encoded = encodeCreateComputerSessionRequest(cellSpec);
    expect(encoded["notebook"]).toBe("build");
    expect(Object.keys(encoded).sort()).toEqual([
      "attachment",
      "client",
      "endpoint",
      "idempotencyKey",
      "notebook",
      "operation",
      "shell",
    ]);
  });

  // Contract: an idempotency key is at most 64 bytes of ASCII letters,
  // digits, '.', '_', or '-', and a refusal names the rule and never the
  // key; an empty key is not written.
  it("judges the idempotency key and omits an empty one", () => {
    expect(
      refusal(() => {
        validateCreateComputerSessionRequest({
          ...execSpec,
          idempotencyKey: "k".repeat(65),
        });
      }),
    ).toBe("idempotencyKey must not exceed 64 characters");
    const secret = "build key/with spaces";
    const message = refusal(() => {
      validateCreateComputerSessionRequest({
        ...execSpec,
        idempotencyKey: secret,
      });
    });
    expect(message).toBe(
      "idempotencyKey must contain only ASCII letters, digits, '.', '_', or '-'",
    );
    expect(message).not.toContain(secret);
    expect(() => {
      validateCreateComputerSessionRequest({
        ...execSpec,
        idempotencyKey: "k".repeat(64),
      });
    }).not.toThrow();
    expect(
      encodeCreateComputerSessionRequest({ ...execSpec, idempotencyKey: "" }),
    ).not.toHaveProperty("idempotencyKey");
  });
});

describe("Computer sessions", () => {
  // Contract: the phase set is closed for validation and open for the
  // codec; ended, failed, and cancelled are final and nothing else is.
  it("judges phases and reports the final ones", () => {
    for (const phase of ["pending", "ready", "attached"]) {
      expect(isComputerSessionPhaseTerminal(phase)).toBe(false);
    }
    for (const phase of ["ended", "failed", "cancelled"]) {
      expect(isComputerSessionPhaseTerminal(phase)).toBe(true);
    }
    expect(isComputerSessionPhaseTerminal("suspended")).toBe(false);
    expect(
      refusal(() => {
        validateComputerSessionPhase("");
      }),
    ).toBe("computer session phase is required");
    expect(
      refusal(() => {
        validateComputerSessionPhase("suspended");
      }),
    ).toBe('unknown computer session phase "suspended"');
  });

  // Contract: every reason in the closed set has a class and every reason
  // outside it has none; the empty reason is valid and an unknown one is
  // refused.
  it("classifies every reason in the closed set", () => {
    const expected: Readonly<Record<string, string>> = {
      Waking: "progressing",
      WaitingForCapacity: "transient",
      NotebookBusy: "progressing",
      WaitingForDisk: "transient",
      NoViewCapableNode: "transient",
      WaitingForVersion: "progressing",
      PROFILE_FITS_NO_HOST: "blocked",
      WAKE_TIMEOUT: "transient",
      EXECUTION_NOT_ENABLED: "blocked",
      OUT_OF_USAGE: "blocked",
      ISOLATION_CLASS_NOT_ADMITTED: "blocked",
      SIZE_NOT_IN_PLAN: "blocked",
      VCPU_LIMIT_REACHED: "blocked",
      "mode-unavailable": "transient",
      ATTACH_TIMEOUT: "transient",
      Exited: "settled",
      Expired: "settled",
      Released: "settled",
      Revoked: "settled",
      PutToSleep: "settled",
    };
    expect(allComputerSessionReasons()).toEqual(Object.keys(expected));
    for (const reason of allComputerSessionReasons()) {
      expect(computerSessionReasonClass(reason)).toBe(expected[reason]);
      expect(() => {
        validateComputerSessionReason(reason);
      }).not.toThrow();
    }
    expect(computerSessionReasonClass("Queued")).toBeUndefined();
    expect(() => {
      validateComputerSessionReason("");
    }).not.toThrow();
    expect(
      refusal(() => {
        validateComputerSessionReason("Queued");
      }),
    ).toBe('unknown computer session reason "Queued"');
    const reason: ComputerSessionReason = ERROR_CODE_EXECUTION_NOT_ENABLED;
    expect(computerSessionReasonClass(reason)).toBe("blocked");
  });

  // Contract: a read carries a field, a phase, and a reason this SDK does
  // not name, and encodes the declared fields back as served.
  it("reads a session leniently", () => {
    const read = decodeComputerSession(
      JSON.stringify({
        ...pendingDocument,
        lease: "added-by-a-newer",
        status: { ...(pendingDocument["status"] as JsonObject), phase: "x" },
      }),
    );
    expect((read as unknown as Record<string, unknown>)["lease"]).toBe(
      "added-by-a-newer",
    );
    expect(read.status.phase).toBe("x");
    expect(encodeComputerSession(pending)).toEqual(pendingDocument);
  });

  // Contract: a valid golden validates, and the session ID family admits
  // only the canonical UUID form.
  it("validates a served session and its identifier", () => {
    expect(() => {
      validateComputerSession(ready);
    }).not.toThrow();
    expect(isComputerSessionId(SESSION_ID)).toBe(true);
    expect(isComputerSessionId(SESSION_ID.toUpperCase())).toBe(false);
    expect(() => parseComputerSessionId("sess_01954e20")).toThrow(
      new TypeError("computer session ID must be a canonical UUID"),
    );
  });

  // Contract: only ready applies. Ready meets it; pending and a phase this
  // SDK does not name are pending; attached, ended, failed, and cancelled
  // fail it; a named reason is appended in parentheses.
  it("evaluates the ready wait", () => {
    expect(evaluateComputerSessionWait(ready, "ready")).toEqual({
      state: "met",
      message: "computer session is ready",
    });
    expect(evaluateComputerSessionWait(pending, "ready")).toEqual({
      state: "pending",
      message: "computer session is pending (Waking)",
    });
    expect(
      evaluateComputerSessionWait(
        withStatus(pending, { reason: "Queued" }),
        "ready",
      ),
    ).toEqual({ state: "pending", message: "computer session is pending" });
    expect(
      evaluateComputerSessionWait(withStatus(ready, { phase: "x" }), "ready"),
    ).toEqual({
      state: "pending",
      message: "computer session is in a phase this version does not name",
    });
    const finals: readonly [string, string | undefined, string][] = [
      ["attached", undefined, "computer session is already attached"],
      ["ended", "Exited", "computer session has ended (Exited)"],
      ["failed", "WAKE_TIMEOUT", "computer session failed (WAKE_TIMEOUT)"],
      ["cancelled", undefined, "computer session was cancelled"],
    ];
    for (const [phase, reason, message] of finals) {
      expect(
        evaluateComputerSessionWait(
          withStatus(ready, {
            phase,
            ...(reason === undefined ? {} : { reason }),
          }),
          "ready",
        ),
      ).toEqual({ state: "failed", message });
    }
    expect(evaluateComputerSessionWait(ready, "deleted")).toEqual({
      state: "failed",
      message: 'condition "deleted" is not supported for ComputerSession',
    });
  });
});

describe("Computer session operations", () => {
  // Contract: create posts the encoded request to the Computer's session
  // collection by name or under the reserved by-id segment, reads and
  // cancels address one session in it, every request carries the
  // credential, and the answer is the session as served.
  it("routes create, read, and cancel by name and by ID", async () => {
    const plane = new FakeControlPlane({
      routes: (request) => {
        if (request.url.host !== subnetHost) return undefined;
        if (request.method === "POST") return json(pendingExecDocument, 202);
        if (request.method === "DELETE")
          return new Response(null, { status: 204 });
        return json(readyDocument);
      },
    });
    const computers = plane.client().account.computers;

    const created = await computers.createSession("payments", execSpec);
    expect(created.status.phase).toBe("pending");
    await computers.createSessionById(COMPUTER_ID, execSpec);
    expect((await computers.getSession("payments", SESSION_ID)).id).toBe(
      SESSION_ID,
    );
    await computers.getSessionById(COMPUTER_ID, SESSION_ID);
    await computers.cancelSession("payments", SESSION_ID);
    await computers.cancelSessionById(COMPUTER_ID, SESSION_ID);

    expect(subnetCalls(plane.requests)).toEqual([
      `POST ${sessionsPath}`,
      `POST ${sessionsByIdPath}`,
      `GET ${sessionsPath}/${SESSION_ID}`,
      `GET ${sessionsByIdPath}/${SESSION_ID}`,
      `DELETE ${sessionsPath}/${SESSION_ID}`,
      `DELETE ${sessionsByIdPath}/${SESSION_ID}`,
    ]);
    const posted = plane.requests.find((request) => request.method === "POST");
    expect(JSON.parse(posted?.body ?? "")).toEqual(readyDocument["spec"]);
    for (const request of plane.requests) {
      expect(request.headers.get("authorization")).toBe("DPoP test-token");
    }
  });

  // Contract: a blank name, an ID that is not canonical, an invalid
  // request, and a service without a Namespace are refused before any
  // request is sent.
  it("refuses what it can judge before any request", async () => {
    const plane = new FakeControlPlane();
    const computers = plane.client().account.computers;
    await expect(computers.createSession(" ", execSpec)).rejects.toThrow(
      new TypeError("computer name is required"),
    );
    await expect(
      computers.createSessionById("payments", execSpec),
    ).rejects.toThrow(new TypeError("computer ID must be a canonical UUID"));
    await expect(
      computers.getSession("payments", "sess_01954e20"),
    ).rejects.toThrow(
      new TypeError("computer session ID must be a canonical UUID"),
    );
    await expect(
      computers.createSession("payments", { ...execSpec, operation: "files" }),
    ).rejects.toThrow(
      new TypeError(
        'create computer session request is invalid: operation "files" is not offered for Computer sessions',
      ),
    );
    const unscoped = plane.client({ namespace: undefined }).account.computers;
    await expect(unscoped.createSession("payments", execSpec)).rejects.toThrow(
      new TypeError("namespace is required"),
    );
    expect(subnetCalls(plane.requests)).toEqual([]);
  });

  // Contract: a refusal carries its status and code, and a read of a
  // session that is gone reports 404.
  it("relays refusals with their code", async () => {
    const plane = new FakeControlPlane({
      routes: (request) => {
        if (request.url.host !== subnetHost) return undefined;
        return request.method === "POST"
          ? errorResponse(
              409,
              ERROR_CODE_EXECUTION_NOT_ENABLED,
              "no supervisor",
            )
          : errorResponse(404, "not_found", "not found");
      },
    });
    const computers = plane.client().account.computers;
    const created = await computers
      .createSession("payments", execSpec)
      .catch((caught: unknown) => caught);
    expect(created).toBeInstanceOf(ApiError);
    expect(isApiCode(created, ERROR_CODE_EXECUTION_NOT_ENABLED)).toBe(true);
    const read = await computers
      .getSession("payments", SESSION_ID)
      .catch((caught: unknown) => caught);
    expect(isNotFound(read)).toBe(true);
  });

  // Contract: a create response or a read that names no canonical session,
  // or another session, is refused, since nothing could address it.
  it("refuses a response that names the wrong session", async () => {
    const plane = new FakeControlPlane({
      routes: (request) => {
        if (request.url.host !== subnetHost) return undefined;
        return request.method === "POST"
          ? json({ ...pendingExecDocument, id: "" }, 202)
          : json({ ...readyDocument, id: COMPUTER_ID });
      },
    });
    const computers = plane.client().account.computers;
    await expect(
      computers.createSession("payments", execSpec),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "create computer session response is invalid",
    });
    await expect(
      computers.getSession("payments", SESSION_ID),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "read computer session response names a different session",
    });
  });

  // Contract: a session is addressed in its own Namespace's collection, so
  // a namespace other than the client's is the one the accessor names.
  it("addresses the Namespace the accessor names", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost ? json(readyDocument) : undefined,
    });
    await plane
      .client({ namespace: undefined })
      .account.namespaces.computers(namespace)
      .getSession("payments", SESSION_ID);
    expect(subnetCalls(plane.requests)).toEqual([
      `GET ${sessionsPath}/${SESSION_ID}`,
    ]);
  });
});
