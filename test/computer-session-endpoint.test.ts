// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeComputerSession,
  encodeComputerSession,
  encodeCreateComputerSessionRequest,
  validateComputerSession,
  validateCreateComputerSessionRequest,
} from "../src/api/computer-session.js";
import type { CreateComputerSessionRequest } from "../src/api/computer-session.js";
import { parseComputerSessionId } from "../src/resource/uuid-id.js";

// The endpoint attachment's goldens, vendored from the reference contract.
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`fixtures-session/${name}`, import.meta.url), "utf8"),
  );
}

const request: CreateComputerSessionRequest = {
  operation: "shell",
  attachment: "endpoint",
  endpoint: { mode: "exec" },
  idempotencyKey: "01954e20-7540-7ec4-93ec-14f783e6ab70",
};

describe("endpoint attachment", () => {
  // Contract: an endpoint create encodes as the published request.
  it("encodes the create request as published", () => {
    validateCreateComputerSessionRequest(request);
    expect(encodeCreateComputerSessionRequest(request)).toEqual(
      fixture("computer-session.endpoint-create-request.json"),
    );
  });

  // Contract: a ready endpoint session reads, judges and re-encodes as
  // published, its place in status.endpoint.
  it("reads a ready endpoint session", () => {
    const document = fixture("computer-session.endpoint-ready.json");
    const session = decodeComputerSession(document);
    validateComputerSession(session);
    expect(session.status.endpoint?.epoch).toBe(12);
    expect(session.status.endpoint?.placement.sequence).toBe(3);
    expect(encodeComputerSession(session)).toEqual(document);
  });

  // Contract: a pending endpoint session bound to the Activation that will
  // serve it reads, judges and re-encodes as published, carrying its place
  // and no attach deadline or expiry; a pending session that states an
  // attach deadline is still refused.
  it("reads a pending endpoint session that carries its endpoint", () => {
    const document = fixture("computer-session.endpoint-pending.json") as {
      status: Record<string, unknown>;
    };
    const session = decodeComputerSession(document);
    validateComputerSession(session);
    expect(session.status.phase).toBe("pending");
    expect(session.status.endpoint?.epoch).toBe(12);
    expect(encodeComputerSession(session)).toEqual(document);

    const deadline = decodeComputerSession({
      ...document,
      status: { ...document.status, attachBy: "2026-01-02T03:06:09Z" },
    });
    expect(() => {
      validateComputerSession(deadline);
    }).toThrow("must be absent in phase pending");
  });

  // Contract: the endpoint arm's rules: the endpoint attachment and its
  // arm, the key the stream names, a session only for a reattach, a
  // notebook only for a cell or records stream; a files stream names none.
  it("refuses an endpoint create outside its rules", () => {
    const refused: CreateComputerSessionRequest[] = [
      {
        ...request,
        endpoint: undefined,
      } as unknown as CreateComputerSessionRequest,
      { ...request, idempotencyKey: "" },
      {
        ...request,
        endpoint: {
          mode: "exec",
          session: parseComputerSessionId(
            "01954e20-7540-7ec4-93ec-14f783e6ab20",
          ),
        },
      },
      { ...request, endpoint: { mode: "reattach" } },
      { ...request, notebook: "work" },
      { ...request, endpoint: { mode: "cell" } },
      { ...request, endpoint: { mode: "files" }, notebook: "work" },
      { ...request, endpoint: { mode: "teleport" } },
      { ...request, attachment: "ssh" },
    ];
    for (const r of refused) {
      expect(() => {
        validateCreateComputerSessionRequest(r);
      }).toThrow(TypeError);
    }
    validateCreateComputerSessionRequest({
      ...request,
      endpoint: { mode: "cell" },
      notebook: "work",
    });
    validateCreateComputerSessionRequest({
      ...request,
      endpoint: { mode: "files" },
    });
  });

  // Contract: a ready endpoint session states its place.
  it("requires status.endpoint once the session is ready", () => {
    const document = fixture("computer-session.endpoint-ready.json") as {
      status: Record<string, unknown>;
      spec: Record<string, unknown>;
    };
    const missing = decodeComputerSession({
      ...document,
      status: { ...document.status, endpoint: undefined },
    });
    expect(() => {
      validateComputerSession(missing);
    }).toThrow("status.endpoint is required in phase ready");
  });
});
