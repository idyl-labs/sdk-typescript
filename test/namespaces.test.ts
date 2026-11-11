// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ERROR_CODE_NAMESPACE_TERMINATING } from "../src/api/namespace.js";
import { ApiError, isApiCode, isApiStatus, isNotFound } from "../src/errors.js";
import { errorResponse, json } from "./fakes/control-plane.js";
import { FakeAccountPlane, namespacesPath } from "./fakes/account-plane.js";

describe("namespaces service", () => {
  // Contract: create and list address the Account's Namespace collection;
  // get, update, and delete address one Namespace by name within it; the
  // envelopes come back as the platform served them.
  it("routes create, get, update, delete, and list onto the account's namespace collection", async () => {
    const plane = new FakeAccountPlane();
    const namespaces = plane.client().account.namespaces;

    const created = await namespaces.create({
      name: "production",
      description: "Production services",
    });
    expect(created.namespace.name).toBe("production");
    expect(created.namespace.phase).toBe("active");
    expect(created.namespace.description).toBe("Production services");

    const read = await namespaces.get("production");
    expect(read.namespace.id).toBe(created.namespace.id);

    const updated = await namespaces.update("production", {
      description: "Payments",
    });
    expect(updated.namespace.description).toBe("Payments");

    const deleted = await namespaces.delete("production");
    expect(deleted.accepted).toBe(true);
    expect(deleted.deletedAt).toBe("2026-01-02T05:06:07Z");

    const listed = await namespaces.list({ limit: 10, offset: 0 });
    expect(listed.items.map((namespace) => namespace.name)).toEqual([
      "agents",
      "default",
    ]);
    expect(listed.totalCount).toBe(2);

    expect(plane.calls()).toEqual([
      `POST ${namespacesPath}`,
      `GET ${namespacesPath}/production`,
      `PUT ${namespacesPath}/production`,
      `DELETE ${namespacesPath}/production`,
      `GET ${namespacesPath}?limit=10&offset=0`,
    ]);
    expect(plane.requests[0]?.body).toBe(
      JSON.stringify({
        name: "production",
        description: "Production services",
      }),
    );
    expect(plane.requests[2]?.body).toBe(
      JSON.stringify({ description: "Payments" }),
    );
    for (const request of plane.requests) {
      expect(request.headers.get("authorization")).toBe("DPoP test-token");
    }
  });

  // Contract: a Namespace name is one path segment, so a name carrying a
  // separator addresses the Namespace it names rather than a route beneath
  // it.
  it("escapes the namespace name as one path segment", async () => {
    const plane = new FakeAccountPlane();
    await expect(
      plane.client().account.namespaces.get("prod/eu"),
    ).rejects.toSatisfy(isNotFound);
    expect(plane.requests[0]?.url.pathname).toBe(`${namespacesPath}/prod%2Feu`);
  });

  // Contract: a blank name never reaches the network; every operation that
  // takes one reports it as required.
  it("refuses a blank name before any request", async () => {
    const plane = new FakeAccountPlane();
    const namespaces = plane.client().account.namespaces;
    for (const name of ["", "  "]) {
      await expect(namespaces.get(name)).rejects.toThrow(
        new TypeError("namespace is required"),
      );
      await expect(namespaces.update(name, {})).rejects.toThrow(TypeError);
      await expect(namespaces.delete(name)).rejects.toThrow(TypeError);
      await expect(namespaces.waitUntilDeleted(name)).rejects.toThrow(
        TypeError,
      );
      expect(() => namespaces.computers(name)).toThrow(
        new TypeError("namespace is required"),
      );
    }
    expect(plane.requests).toHaveLength(0);
  });

  // Contract: a list envelope is read leniently; a null items list is an
  // empty page, an absent totalCount reads as zero, and a totalCount that
  // is not an integer is refused by name.
  it("reads the list envelope leniently and judges only its shape", async () => {
    const answers = [
      json({ items: null, totalCount: 0, extra: true }),
      json({ items: [], totalCount: "1" }),
      json({ items: [] }),
      json({ items: {}, totalCount: 0 }),
    ];
    const plane = new FakeAccountPlane({ routes: () => answers.shift() });
    const namespaces = plane.client().account.namespaces;
    expect(await namespaces.list()).toEqual({ items: [], totalCount: 0 });
    await expect(namespaces.list()).rejects.toThrow(
      "invalid list namespaces response: totalCount must be an integer",
    );
    expect(await namespaces.list()).toEqual({ items: [], totalCount: 0 });
    await expect(namespaces.list()).rejects.toThrow(
      "invalid list namespaces response: items must be an array",
    );
  });

  // Contract: accountById addresses another Account's Namespaces.
  it("addresses another account by ID", async () => {
    const plane = new FakeAccountPlane();
    await plane.client().accountById("550000000009").namespaces.list();
    expect(plane.requests[0]?.url.pathname).toBe(
      "/v1/accounts/550000000009/namespaces",
    );
  });

  // Contract: the request signal reaches every Namespace operation.
  it("cancels through the request signal", async () => {
    const plane = new FakeAccountPlane();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const namespaces = plane.client().account.namespaces;
    await expect(
      namespaces.get("default", { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    await expect(
      namespaces.list({}, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(plane.requests).toHaveLength(0);
  });
});

describe("namespace deletion lifecycle", () => {
  // Contract: delete answers 202 with accepted set and deletedAt stamped
  // once the Namespace is terminating; a repeated delete is accepted again
  // with the same answer, and the Namespace still reads, reporting its
  // phase, the terminating instant, and what holds finalization back.
  it("accepts the delete once terminating and again when repeated", async () => {
    const plane = new FakeAccountPlane({ readsUntilFinalized: 5 });
    const namespaces = plane.client().account.namespaces;
    await namespaces.create({ name: "production" });

    const first = await namespaces.delete("production");
    const second = await namespaces.delete("production");
    expect(first).toEqual({
      accepted: true,
      deletedAt: "2026-01-02T05:06:07Z",
    });
    expect(second).toEqual(first);

    const read = await namespaces.get("production");
    expect(read.namespace.phase).toBe("terminating");
    expect(read.namespace.terminatingAt).toBe("2026-01-02T05:06:07Z");
    expect(read.namespace.termination).toEqual({
      computersRemaining: 0,
      zones: [],
    });
    expect(read.namespace.deletedAt).toBeUndefined();
  });

  // Contract: the reserved default Namespace refuses deletion with HTTP 403,
  // and the SDK adds no guard of its own: the request is sent and the
  // platform's refusal is what the caller sees.
  it("relays the platform's 403 for the default namespace", async () => {
    const plane = new FakeAccountPlane();
    const namespaces = plane.client().account.namespaces;
    const refusal = await namespaces.delete("default").catch((e: unknown) => e);
    expect(isApiStatus(refusal, 403)).toBe(true);
    expect(isNotFound(refusal)).toBe(false);
    expect(plane.calls()).toEqual([`DELETE ${namespacesPath}/default`]);
  });

  // Contract: an edit of a terminating Namespace is refused with HTTP 409
  // and the stable code, which isApiCode classifies; the details name the
  // Namespace.
  it("classifies the terminating refusal on its code", async () => {
    const plane = new FakeAccountPlane({ readsUntilFinalized: 5 });
    const namespaces = plane.client().account.namespaces;
    await namespaces.create({ name: "production" });
    await namespaces.delete("production");

    const refusal = await namespaces
      .update("production", { description: "x" })
      .catch((e: unknown) => e);
    expect(isApiCode(refusal, ERROR_CODE_NAMESPACE_TERMINATING)).toBe(true);
    expect(refusal).toBeInstanceOf(ApiError);
    const error = refusal as ApiError;
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ namespace: "production" });
  });

  // Contract: waitUntilDeleted reads the Namespace back, judging each read
  // as pending while it is terminating, and resolves once a read answers
  // 404.
  it("waits through terminating reads until the namespace resolves 404", async () => {
    const plane = new FakeAccountPlane({ readsUntilFinalized: 2 });
    const namespaces = plane.client().account.namespaces;
    await namespaces.create({ name: "production" });
    await namespaces.delete("production");

    await namespaces.waitUntilDeleted("production", { pollIntervalMs: 1 });

    expect(plane.calls()).toEqual([
      `POST ${namespacesPath}`,
      `DELETE ${namespacesPath}/production`,
      `GET ${namespacesPath}/production`,
      `GET ${namespacesPath}/production`,
      `GET ${namespacesPath}/production`,
    ]);
    expect(plane.namespaces.has("production")).toBe(false);
  });

  // Contract: a Namespace that already resolves 404 is already gone; the
  // wait ends on its first read.
  it("resolves at once when the namespace is already gone", async () => {
    const plane = new FakeAccountPlane();
    await plane
      .client()
      .account.namespaces.waitUntilDeleted("missing", { pollIntervalMs: 1 });
    expect(plane.calls()).toEqual([`GET ${namespacesPath}/missing`]);
  });

  // Contract: an active Namespace is pending, never met; the wait runs out
  // its timeout with a TimeoutError naming the Namespace and the bound.
  it("times out while the namespace stays readable", async () => {
    const plane = new FakeAccountPlane();
    const namespaces = plane.client().account.namespaces;
    await namespaces.create({ name: "production" });
    const failure = await namespaces
      .waitUntilDeleted("production", { timeoutMs: 20, pollIntervalMs: 1 })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe("TimeoutError");
    expect((failure as DOMException).message).toBe(
      'wait for namespace "production" deletion exceeded 20 ms',
    );
    expect(plane.namespaces.has("production")).toBe(true);
  });

  // Contract: cancellation rejects with the signal's own reason while a read
  // is held open on a promise the test owns; the fake is released afterwards
  // and no timer is left running.
  it("cancels a wait with the signal's reason", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<Response>((resolve) => {
      release = () => {
        resolve(json({ namespace: { name: "production", phase: "active" } }));
      };
    });
    const plane = new FakeAccountPlane({
      routes: (request) =>
        request.method === "GET" && request.url.pathname.endsWith("/production")
          ? held
          : undefined,
    });
    const controller = new AbortController();
    const reason = new Error("stop waiting");
    const waiting = plane
      .client()
      .account.namespaces.waitUntilDeleted("production", {
        signal: controller.signal,
        pollIntervalMs: 1,
      });
    await Promise.resolve();
    controller.abort(reason);
    const failure = await waiting.catch((e: unknown) => e);
    expect(failure).toBe(reason);
    release?.();
    await held;
  });

  // Contract: a read failure other than 404 ends the wait with that error.
  it("propagates a read failure other than not-found", async () => {
    const plane = new FakeAccountPlane({
      routes: (request) =>
        request.method === "GET"
          ? errorResponse(503, "unavailable", "try again")
          : undefined,
    });
    const failure = await plane
      .client()
      .account.namespaces.waitUntilDeleted("production", { pollIntervalMs: 1 })
      .catch((e: unknown) => e);
    expect(isApiStatus(failure, 503)).toBe(true);
    expect(plane.calls()).toEqual([`GET ${namespacesPath}/production`]);
  });
});
