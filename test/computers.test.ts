// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  decodeComputer,
  encodeComputer,
  validateCreateComputerRequest,
  validateUpdateComputerRequest,
  validateComputerExecution,
  validateComputerPhase,
  type Computer,
} from "../src/api/computer.js";
import { evaluateComputerWait } from "../src/api/wait.js";
import { isNotFound } from "../src/errors.js";
import { type JsonObject } from "../src/resource/json.js";
import { isComputerId, parseComputerId } from "../src/resource/uuid-id.js";
import {
  FakeControlPlane,
  errorResponse,
  json,
  namespace,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
import type { RouteHandler } from "./fakes/control-plane.js";
import { accountId, otherSubnetSlug, subnetSlug } from "./fakes/fetch-queue.js";
import type { RecordedRequest } from "./fakes/fetch-queue.js";

const COMPUTER_ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const computersPath = `${namespacePathPrefix}/computers`;

/** A Computer as a Subnet API serves it, living in `subnet`. */
function served(
  overrides: Record<string, unknown> = {},
  subnet: string = subnetSlug,
): JsonObject {
  return {
    id: COMPUTER_ID,
    accountId,
    namespaceId: "01954e20-7540-7ec4-93ec-14f783e6ab06",
    namespace,
    subnet,
    name: "payments",
    phase: "active",
    execution: "dormant",
    headVersion: 0,
    spec: { idleTimeout: "300s" },
    createdAt: "2026-01-02T03:04:05Z",
    updatedAt: "2026-01-02T04:05:06Z",
    ...overrides,
  };
}

/**
 * Answers every Computer route on the Subnet's API host with `computer`:
 * a create with 201, a delete with 202, a collection with a one-item page,
 * and anything else with the one Computer.
 */
function computerRoutes(computer: JsonObject = served()): RouteHandler {
  return (request) => {
    if (request.url.host !== subnetHost) return undefined;
    if (!request.url.pathname.includes("/computers")) return undefined;
    if (request.method === "DELETE") {
      return json({ accepted: true, deletedAt: "2026-01-02T05:06:07Z" }, 202);
    }
    if (request.url.pathname.endsWith("/computers")) {
      return request.method === "POST"
        ? json({ computer }, 201)
        : json({ items: [computer], totalCount: 1 });
    }
    return json({ computer });
  };
}

function subnetCalls(requests: readonly RecordedRequest[]): string[] {
  return requests
    .filter((request) => request.url.host === subnetHost)
    .map(
      (request) =>
        `${request.method} ${request.url.pathname}${request.url.search}`,
    );
}

function refusal(validate: () => void): string {
  try {
    validate();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("served Computers", () => {
  const active: Computer = decodeComputer(served());

  // Contract: a live Computer writes its phase, its execution state, and
  // its head version, zero included, and omits the terminating instant; a
  // terminating one writes the instant its delete was recorded.
  it("writes the lifecycle fields the platform emits", () => {
    expect(encodeComputer(active)).toEqual(served());
    const terminating = encodeComputer({
      ...active,
      phase: "terminating",
      headVersion: 7,
      terminatingAt: "2026-01-02T05:06:07Z",
    });
    expect(terminating["terminatingAt"]).toBe("2026-01-02T05:06:07Z");
    expect(terminating["headVersion"]).toBe(7);
  });

  // Contract: a listed Computer carries when it was last used, as the
  // platform wrote it; a Computer without the value decodes and encodes
  // with the key absent.
  it("carries when a Computer was last used, only when reported", () => {
    const listed = served({ lastUsedAt: "2026-01-02T05:06:07Z" });
    const decoded = decodeComputer(listed);
    expect(decoded.lastUsedAt).toBe("2026-01-02T05:06:07Z");
    expect(encodeComputer(decoded)).toEqual(listed);
    expect(active.lastUsedAt).toBeUndefined();
    expect(encodeComputer(active)).not.toHaveProperty("lastUsedAt");
  });

  // Contract: the codec carries a phase or an execution state this SDK
  // does not name, so a read succeeds, and validation is the judgement; a
  // served Computer always carries both.
  it("carries unknown vocabulary and judges it on validate", () => {
    const read = decodeComputer(
      JSON.stringify(served({ phase: "archived", execution: "hibernating" })),
    );
    expect(read.execution).toBe("hibernating");
    expect(
      refusal(() => {
        validateComputerExecution(read.execution);
      }),
    ).toBe('unknown computer execution "hibernating"');
    expect(
      refusal(() => {
        validateComputerExecution("");
      }),
    ).toBe("computer execution is required");
    expect(
      refusal(() => {
        validateComputerPhase(read.phase);
      }),
    ).toBe('unknown computer phase "archived"');
    for (const execution of ["dormant", "running", "waiting"]) {
      expect(() => {
        validateComputerExecution(execution);
      }).not.toThrow();
    }
  });

  // Contract: a create request states a name and the Subnet the Computer
  // will live in; a blank name, a missing Subnet, and a Subnet that is not a
  // canonical slug are refused, and the name's format is the platform's.
  it("judges a create request", () => {
    expect(
      refusal(() => {
        validateCreateComputerRequest({ name: " ", subnet: subnetSlug });
      }),
    ).toBe("computer name is required");
    expect(
      refusal(() => {
        validateCreateComputerRequest({ name: "payments" });
      }),
    ).toBe("computer subnet is required");
    expect(
      refusal(() => {
        validateCreateComputerRequest({ name: "payments", subnet: "zone-a" });
      }),
    ).toBe("computer subnet: subnet slug must be exactly 12 characters");
    expect(() => {
      validateCreateComputerRequest({ name: "by-id", subnet: subnetSlug });
    }).not.toThrow();
    expect(
      refusal(() => {
        validateCreateComputerRequest({
          name: "payments",
          subnet: subnetSlug,
          spec: { idleTimeout: "-30s" },
        });
      }),
    ).toBe(
      'computer spec.idleTimeout: idle timeout must be "never" or a whole number followed by s, m, or h, such as "300s", "5m", or "1h"',
    );
    expect(() => {
      validateCreateComputerRequest({
        name: "payments",
        subnet: subnetSlug,
        spec: { idleTimeout: "never" },
      });
    }).not.toThrow();
  });

  // Contract: an update states at least one field, since one that states
  // none would change nothing, and every field it states is valid.
  it("judges an update request", () => {
    expect(
      refusal(() => {
        validateUpdateComputerRequest({});
      }),
    ).toBe("computer update states no field");
    expect(
      refusal(() => {
        validateUpdateComputerRequest({ idleTimeout: "5 minutes" });
      }),
    ).toBe(
      'computer update: idleTimeout: idle timeout must be "never" or a whole number followed by s, m, or h, such as "300s", "5m", or "1h"',
    );
    expect(() => {
      validateUpdateComputerRequest({ idleTimeout: "15m" });
    }).not.toThrow();
  });

  // Contract: only `deleted` applies. Every phase is pending while the
  // Computer can be read, a terminating one awaits finalization, and any
  // other condition fails as unsupported.
  it("evaluates the deleted wait", () => {
    expect(
      evaluateComputerWait({ ...active, phase: "terminating" }, "deleted"),
    ).toEqual({
      state: "pending",
      message: "computer payments is terminating: awaiting finalization",
    });
    expect(evaluateComputerWait(active, "ready")).toEqual({
      state: "failed",
      message: 'condition "ready" is not supported for Computer',
    });
  });

  // Contract: the identifier family admits only the canonical UUID form.
  it("parses the identifier family", () => {
    expect(isComputerId(COMPUTER_ID)).toBe(true);
    expect(isComputerId(COMPUTER_ID.toUpperCase())).toBe(false);
    expect(() => parseComputerId("payments")).toThrow(
      new TypeError("computer ID must be a canonical UUID"),
    );
  });
});

describe("Computers service", () => {
  // Contract: every operation maps onto its route and method on the API host
  // of the resolved Subnet. Create posts the name with the resolved Subnet
  // stamped; reads and deletes address the Computer by name or under the
  // reserved by-id segment; a Namespace list states the Subnet in its query
  // and the account-wide list addresses it in its path. The Namespace is the
  // one the accessor names, not the client's, every request carries the
  // client's credential, and a served Computer is read leniently.
  it("routes every operation to its method and path", async () => {
    const plane = new FakeControlPlane({
      routes: computerRoutes(served({ storageTier: "added-by-a-newer" })),
    });
    const computers = plane
      .client({ namespace: undefined })
      .account.namespaces.computers(namespace);

    const created = await computers.create({ name: "payments" });
    expect(created.computer.id).toBe(COMPUTER_ID);
    expect(
      (created.computer as unknown as Record<string, unknown>)["storageTier"],
    ).toBe("added-by-a-newer");
    expect((await computers.get("payments")).computer.execution).toBe(
      "dormant",
    );
    expect((await computers.getById(COMPUTER_ID)).computer.name).toBe(
      "payments",
    );
    expect((await computers.list({ limit: 3 })).totalCount).toBe(1);
    expect(
      (await computers.listAllNamespaces({ offset: 1 })).items[0]?.subnet,
    ).toBe(subnetSlug);
    expect(await computers.delete("payments")).toEqual({
      accepted: true,
      deletedAt: "2026-01-02T05:06:07Z",
    });
    expect(await computers.deleteById(COMPUTER_ID)).toEqual({
      accepted: true,
      deletedAt: "2026-01-02T05:06:07Z",
    });

    expect(subnetCalls(plane.requests)).toEqual([
      `POST ${computersPath}`,
      `GET ${computersPath}/payments`,
      `GET ${computersPath}/by-id/${COMPUTER_ID}`,
      `GET ${computersPath}?limit=3&subnet=${subnetSlug}`,
      `GET /v1/accounts/${accountId}/subnets/${subnetSlug}/computers?offset=1`,
      `DELETE ${computersPath}/payments`,
      `DELETE ${computersPath}/by-id/${COMPUTER_ID}`,
    ]);
    const posted = plane.requests.find((request) => request.method === "POST");
    expect(JSON.parse(posted?.body ?? "")).toEqual({
      name: "payments",
      subnet: subnetSlug,
    });
    for (const request of plane.requests) {
      expect(request.headers.get("authorization")).toBe("DPoP test-token");
    }
  });

  // Contract: a create writes a spec only when it states a field, so a
  // create without one is the name and the Subnet alone; an update PATCHes
  // the Computer by name with the spec it changes and reads back the
  // Computer as the update left it, its timeout in canonical seconds.
  it("creates with an optional spec and updates the spec by PATCH", async () => {
    const plane = new FakeControlPlane({
      routes: computerRoutes(served({ spec: { idleTimeout: "900s" } })),
    });
    const computers = plane
      .client({ namespace: undefined })
      .account.namespaces.computers(namespace);

    await computers.create({ name: "payments", spec: {} });
    await computers.create({
      name: "payments",
      spec: { idleTimeout: "15m" },
    });
    const updated = await computers.update("payments", {
      idleTimeout: "15m",
    });
    expect(updated.computer.spec).toEqual({ idleTimeout: "900s" });

    expect(subnetCalls(plane.requests)).toEqual([
      `POST ${computersPath}`,
      `POST ${computersPath}`,
      `PATCH ${computersPath}/payments`,
    ]);
    const bodies = plane.requests
      .filter((request) => request.url.host === subnetHost)
      .map((request) => JSON.parse(request.body ?? "") as unknown);
    expect(bodies).toEqual([
      { name: "payments", subnet: subnetSlug },
      { name: "payments", subnet: subnetSlug, spec: { idleTimeout: "15m" } },
      { idleTimeout: "15m" },
    ]);
  });

  // Contract: an update by ID sends the by-name update's body as a PATCH of
  // the Computer under the reserved by-id segment and reads back the
  // Computer as the update left it.
  it("updates a Computer by its stable identity", async () => {
    const plane = new FakeControlPlane({
      routes: computerRoutes(served({ spec: { idleTimeout: "900s" } })),
    });
    const computers = plane
      .client({ namespace: undefined })
      .account.namespaces.computers(namespace);

    const updated = await computers.updateById(COMPUTER_ID, {
      idleTimeout: "15m",
    });
    expect(updated.computer.id).toBe(COMPUTER_ID);
    expect(updated.computer.spec).toEqual({ idleTimeout: "900s" });

    expect(subnetCalls(plane.requests)).toEqual([
      `PATCH ${computersPath}/by-id/${COMPUTER_ID}`,
    ]);
    const patched = plane.requests.find(
      (request) => request.method === "PATCH",
    );
    expect(JSON.parse(patched?.body ?? "")).toEqual({ idleTimeout: "15m" });
  });

  // Contract: an update that states no field, states an invalid one, or
  // names no Computer, by name or by ID, is refused before anything is
  // sent.
  it("refuses an update it can judge before any request", async () => {
    const plane = new FakeControlPlane({ routes: computerRoutes() });
    const computers = plane
      .client({ namespace: undefined })
      .account.namespaces.computers(namespace);
    await expect(computers.update("payments", {})).rejects.toThrow(
      "computer update states no field",
    );
    await expect(
      computers.update("payments", { idleTimeout: "-1s" }),
    ).rejects.toThrow(TypeError);
    await expect(
      computers.update(" ", { idleTimeout: "never" }),
    ).rejects.toThrow(TypeError);
    await expect(
      computers.updateById("payments", { idleTimeout: "never" }),
    ).rejects.toThrow(new TypeError("computer ID must be a canonical UUID"));
    await expect(computers.updateById(COMPUTER_ID, {})).rejects.toThrow(
      "computer update states no field",
    );
    expect(subnetCalls(plane.requests)).toEqual([]);
  });

  // Contract: a Namespace and a Computer name are path segments, so a
  // value carrying a separator or a space addresses the resource it names
  // rather than a route beneath it.
  it("escapes every segment", async () => {
    const plane = new FakeControlPlane({ routes: computerRoutes() });
    const computers = plane.client().account.namespaces.computers("prod/eu");
    await computers.get("a b/c");
    await computers.delete("a b/c");
    expect(subnetCalls(plane.requests)).toEqual([
      `GET /v1/accounts/${accountId}/namespaces/prod%2Feu/computers/a%20b%2Fc`,
      `DELETE /v1/accounts/${accountId}/namespaces/prod%2Feu/computers/a%20b%2Fc`,
    ]);
  });

  // Contract: what the client can judge is judged before any request: a
  // blank name, an identifier that is not a canonical UUID, a create naming
  // a Subnet other than the resolved one, a list naming another Subnet, and
  // a service that addresses no Namespace.
  it("refuses what it can judge before any subnet request", async () => {
    const plane = new FakeControlPlane({ routes: computerRoutes() });
    const computers = plane.client().account.computers;
    await expect(computers.create({ name: " " })).rejects.toThrow(
      new TypeError("computer name is required"),
    );
    await expect(
      computers.create({ name: "payments", subnet: otherSubnetSlug }),
    ).rejects.toThrow(
      new TypeError("computer subnet does not match resolved placement subnet"),
    );
    await expect(computers.get("")).rejects.toThrow(
      new TypeError("computer name is required"),
    );
    await expect(computers.delete(" ")).rejects.toThrow(TypeError);
    await expect(computers.waitUntilDeleted("")).rejects.toThrow(TypeError);
    await expect(computers.getById("payments")).rejects.toThrow(
      new TypeError("computer ID must be a canonical UUID"),
    );
    await expect(computers.deleteById("payments")).rejects.toThrow(
      new TypeError("computer ID must be a canonical UUID"),
    );

    const unscoped = plane.client({ namespace: undefined }).account.computers;
    for (const attempt of [
      () => unscoped.list(),
      () => unscoped.get("payments"),
      () => unscoped.getById(COMPUTER_ID),
      () => unscoped.create({ name: "payments" }),
      () => unscoped.delete("payments"),
      () => unscoped.waitUntilDeleted("payments"),
    ]) {
      await expect(attempt()).rejects.toThrow(
        new TypeError("namespace is required"),
      );
    }
    expect(() => plane.client().account.namespaces.computers(" ")).toThrow(
      new TypeError("namespace is required"),
    );
    expect(subnetCalls(plane.requests)).toEqual([]);
  });

  // Contract: a Computer lives in exactly one Subnet and the client
  // addressed that Subnet's API, so a response in which any Computer names
  // another Subnet, or none, is refused on every route that returns one,
  // each item of a page included. The refusal names the Subnet the client
  // addressed and never repeats the value the response carried.
  it("refuses a response naming another subnet", async () => {
    for (const elsewhere of [
      served({}, otherSubnetSlug),
      served({ subnet: undefined }),
    ]) {
      const plane = new FakeControlPlane({
        routes: computerRoutes(elsewhere),
      });
      const computers = plane.client().account.computers;
      for (const attempt of [
        () => computers.create({ name: "payments" }),
        () => computers.get("payments"),
        () => computers.getById(COMPUTER_ID),
        () => computers.list(),
        () => computers.listAllNamespaces(),
      ]) {
        const error = await attempt().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "computer response names a placement other than the one addressed",
        );
        expect((error as Error).message).not.toContain(otherSubnetSlug);
      }
    }
  });

  // Contract: waitUntilDeleted reads the Computer back by name, pending
  // while it is terminating, and resolves once a read answers 404, which
  // isNotFound classifies.
  it("waits through terminating reads until the computer resolves 404", async () => {
    let reads = 0;
    const plane = new FakeControlPlane({
      routes: (request) => {
        if (request.url.host !== subnetHost) return undefined;
        if (request.method === "DELETE") {
          return json(
            { accepted: true, deletedAt: "2026-01-02T05:06:07Z" },
            202,
          );
        }
        reads += 1;
        return reads <= 2
          ? json({
              computer: served({
                phase: "terminating",
                terminatingAt: "2026-01-02T05:06:07Z",
              }),
            })
          : errorResponse(404, "NOT_FOUND", "computer not found");
      },
    });
    const computers = plane.client().account.computers;
    await computers.delete("payments");
    await computers.waitUntilDeleted("payments", { pollIntervalMs: 1 });
    expect(subnetCalls(plane.requests)).toEqual([
      `DELETE ${computersPath}/payments`,
      `GET ${computersPath}/payments`,
      `GET ${computersPath}/payments`,
      `GET ${computersPath}/payments`,
    ]);
    await expect(computers.get("payments")).rejects.toSatisfy(isNotFound);
  });

  // Contract: account.computers addresses the Namespace the client entered
  // and namespaces.computers names one explicitly; another Account's
  // service applies no Namespace of the client's own.
  it("addresses the client's namespace or the one named", async () => {
    const plane = new FakeControlPlane({ routes: computerRoutes() });
    const client = plane.client();
    await client.account.computers.list();
    await client.forNamespace("batch").account.computers.list();
    await client.account.namespaces.computers("backend").list();
    await expect(
      client.accountById("550000000009").computers.list(),
    ).rejects.toThrow(new TypeError("namespace is required"));
    expect(subnetCalls(plane.requests)).toEqual([
      `GET ${computersPath}?subnet=${subnetSlug}`,
      `GET /v1/accounts/${accountId}/namespaces/batch/computers?subnet=${subnetSlug}`,
      `GET /v1/accounts/${accountId}/namespaces/backend/computers?subnet=${subnetSlug}`,
    ]);
  });

  // Contract: the request signal reaches every Computer operation, and a
  // cancelled operation sends nothing to the Subnet.
  it("cancels through the request signal", async () => {
    const plane = new FakeControlPlane({ routes: computerRoutes() });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const computers = plane.client().account.computers;
    const signal = controller.signal;
    for (const attempt of [
      () => computers.create({ name: "payments" }, { signal }),
      () => computers.get("payments", { signal }),
      () => computers.getById(COMPUTER_ID, { signal }),
      () => computers.list({}, { signal }),
      () => computers.listAllNamespaces({}, { signal }),
      () => computers.delete("payments", { signal }),
      () => computers.deleteById(COMPUTER_ID, { signal }),
    ]) {
      await expect(attempt()).rejects.toThrow("cancelled");
    }
    expect(subnetCalls(plane.requests)).toEqual([]);
  });
});

describe("computer list filter", () => {
  // Contract: a list's filter selects ownership, the default or `unowned`,
  // or `all`; any other selector is refused before a request is sent.
  it("accepts the ownership selectors and refuses any other", async () => {
    const plane = new FakeControlPlane({ routes: computerRoutes() });
    const computers = plane.client().account.computers;
    for (const filter of ["", "unowned", "all"]) {
      await expect(computers.list({ filter })).resolves.toBeDefined();
      await expect(
        computers.listAllNamespaces({ filter }),
      ).resolves.toBeDefined();
    }
    const sent = plane.requests.length;
    await expect(computers.list({ filter: "owner=x" })).rejects.toThrow(
      new TypeError("invalid computer owner filter"),
    );
    await expect(
      computers.listAllNamespaces({ filter: "owner=x" }),
    ).rejects.toThrow(new TypeError("invalid computer owner filter"));
    expect(plane.requests).toHaveLength(sent);
  });
});
