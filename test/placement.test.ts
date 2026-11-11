// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { networkPlacement } from "../src/internal/placement.js";
import type { TestClient } from "./fakes/client.js";
import {
  errorResponse,
  FakeControlPlane,
  json,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
import type { RouteHandler } from "./fakes/control-plane.js";
import {
  accountId,
  network,
  otherSubnetSlug,
  subnetEndpoint,
  subnetSlug,
} from "./fakes/fetch-queue.js";
import type { RecordedRequest } from "./fakes/fetch-queue.js";

const metaHost = `meta.${network}`;
const apiHost = `api.${network}`;
const discoveryPath = `/v1/accounts/${accountId}/deployable-subnet-identities`;
const otherAccountId = "550000000009";
const computer = {
  id: "01954e20-7540-7ec4-93ec-14f783e6ab04",
  accountId,
  namespaceId: "01954e20-7540-7ec4-93ec-14f783e6ab06",
  namespace: "agents",
  subnet: subnetSlug,
  name: "payments",
  phase: "active",
  execution: "dormant",
  headVersion: 0,
  spec: {},
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-01-02T04:05:06Z",
};

type Identity = Record<string, unknown>;

/** A discovery identity of the network's Computer place, ready for creates. */
function identity(fields: Identity = {}): Identity {
  return {
    slug: subnetSlug,
    status: "active",
    hosts: { api: subnetHost },
    regionEnabled: true,
    approvedForAccount: true,
    developerAdmitted: true,
    ...fields,
  };
}

interface Plane {
  readonly plane: FakeControlPlane;
  readonly client: () => TestClient;
  readonly reads: (host: string) => RecordedRequest[];
}

/**
 * A network whose metadata answers with `metadata` (a body, or a function
 * of the read number), whose discovery lists `identities`, and whose
 * Computer API serves one Computer.
 */
function networkPlane(
  options: {
    readonly metadata?: (read: number) => Response;
    readonly identities?: (read: number) => readonly Identity[];
    readonly routes?: RouteHandler;
  } = {},
): Plane {
  let metadataReads = 0;
  let discoveryReads = 0;
  const plane = new FakeControlPlane({
    routes: async (request, body) => {
      const custom = await options.routes?.(request, body);
      if (custom !== undefined) return custom;
      const { host, pathname } = request.url;
      if (host === metaHost && pathname === "/v1/network") {
        metadataReads += 1;
        return (
          options.metadata?.(metadataReads) ??
          json({ computerSubnet: subnetSlug })
        );
      }
      if (
        host === apiHost &&
        pathname.endsWith("/deployable-subnet-identities")
      ) {
        discoveryReads += 1;
        return json({
          identities: options.identities?.(discoveryReads) ?? [identity()],
        });
      }
      if (host === subnetHost && pathname.includes("/computers")) {
        return request.method === "POST"
          ? json({ computer }, 201)
          : json({ computer });
      }
      return undefined;
    },
  });
  return {
    plane,
    client: () => plane.client({ placement: networkPlacement }),
    reads: (host) => plane.requests.filter((r) => r.url.host === host),
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the operation to fail");
    },
    (error: unknown) => error,
  );
}

describe("computer placement", () => {
  // Contract: the place is read from the network's public metadata,
  // anonymously, then confirmed by the Account's discovery with the
  // credential, and the operation goes to the API host discovery
  // advertised.
  it("resolves through the network metadata and discovery", async () => {
    const { plane, client } = networkPlane();
    await client().account.computers.get("payments");
    expect(
      plane.requests.map((r) => `${r.method} ${r.url.origin}${r.url.pathname}`),
    ).toEqual([
      `GET https://${metaHost}/v1/network`,
      `GET https://${apiHost}${discoveryPath}`,
      `GET ${subnetEndpoint}${namespacePathPrefix}/computers/payments`,
    ]);
    const [metadata, discovery, served] = plane.requests;
    expect(metadata?.headers.has("authorization")).toBe(false);
    expect(discovery?.headers.get("authorization")).toBe("DPoP test-token");
    expect(served?.headers.get("authorization")).toBe("DPoP test-token");
  });

  // Contract: a resolved place is kept for the client, so later operations
  // and concurrent ones read neither the metadata nor discovery again.
  it("keeps the resolved place per client", async () => {
    const { client, reads } = networkPlane();
    const computers = client().account.computers;
    await Promise.all([
      computers.get("payments"),
      computers.get("payments"),
      computers.listAllNamespaces(),
    ]);
    await computers.get("payments");
    expect(reads(metaHost)).toHaveLength(1);
    expect(reads(apiHost)).toHaveLength(1);
    expect(reads(subnetHost)).toHaveLength(4);
  });

  // Contract: a create uses the kept place too; whether the Account may
  // create is the platform's decision, made on the create itself.
  it("uses the kept place for creates", async () => {
    const { client, reads } = networkPlane();
    const computers = client().account.computers;
    await computers.create({ name: "payments" });
    await computers.create({ name: "payments" });
    expect(reads(metaHost)).toHaveLength(1);
    expect(reads(apiHost)).toHaveLength(1);
  });

  // Contract: a failed read is never kept: the next operation reads again.
  it("does not keep a failed read", async () => {
    const { client, reads } = networkPlane({
      metadata: (read) =>
        read === 1
          ? errorResponse(503, "unavailable", "try again")
          : json({ computerSubnet: subnetSlug }),
      identities: (read) => (read === 1 ? [] : [identity()]),
    });
    const computers = client().account.computers;
    await expect(computers.get("payments")).rejects.toMatchObject({
      detail: "try again",
    });
    const unavailable = await failure(computers.get("payments"));
    expect((unavailable as Error).message).toBe(
      "IDYL advertises no computer API for this account",
    );
    await expect(computers.get("payments")).resolves.toBeDefined();
    expect(reads(metaHost)).toHaveLength(2);
    expect(reads(apiHost)).toHaveLength(2);
  });

  // Contract: each Account is confirmed by its own discovery, and the
  // network's place is read once for all of them.
  it("confirms each account through its own discovery", async () => {
    const { client, reads } = networkPlane();
    const one = client();
    await one.account.computers.get("payments");
    await one.accountById(otherAccountId).computers.listAllNamespaces();
    expect(reads(metaHost)).toHaveLength(1);
    expect(reads(apiHost).map((r) => r.url.pathname)).toEqual([
      discoveryPath,
      `/v1/accounts/${otherAccountId}/deployable-subnet-identities`,
    ]);
  });

  // Contract: the package judges nothing about whether the Account may use
  // the place: a place discovery advertises with an API host is used, and
  // the platform refuses what it refuses. Discovery that advertises no API
  // host for it is a plain Error that names no place.
  it.each([
    ["not approved", identity({ approvedForAccount: false })],
    ["inactive", identity({ status: "inactive" })],
    ["in a disabled region", identity({ regionEnabled: false })],
    ["with the developer not admitted", identity({ developerAdmitted: false })],
  ])("leaves a place that is %s to the platform", async (_name, served) => {
    const { client, reads } = networkPlane({ identities: () => [served] });
    await client().account.computers.create({ name: "payments" });
    expect(reads(subnetHost)).toHaveLength(1);
  });

  it.each([
    ["not listed", [identity({ slug: otherSubnetSlug })]],
    ["without hosts", [identity({ hosts: undefined })]],
    ["with an empty API host", [identity({ hosts: { api: "" } })]],
  ])("refuses discovery %s", async (_name, identities) => {
    const { client, reads } = networkPlane({ identities: () => identities });
    const error = await failure(
      client().account.computers.create({ name: "payments" }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("Error");
    expect((error as Error).message).toBe(
      "IDYL advertises no computer API for this account",
    );
    expect(reads(subnetHost)).toHaveLength(0);
  });

  // Contract: metadata that names no place, or not a canonical one, is
  // refused in a fixed sentence before any discovery read.
  it.each([
    ["names none", json({})],
    ["names an empty one", json({ computerSubnet: "" })],
    ["names an invalid one", json({ computerSubnet: "550000000002x" })],
  ])("refuses metadata that %s", async (_name, response) => {
    const { client, reads } = networkPlane({
      metadata: () => response.clone(),
    });
    const error = await failure(client().account.computers.get("payments"));
    expect(error).toMatchObject({
      code: "invalid_response",
      message: "network metadata names no valid place for computers",
    });
    expect(reads(apiHost)).toHaveLength(0);
  });

  // Contract: an advertised API host that is not a bare hostname is
  // refused without naming the place.
  it("refuses an advertised host that is not a bare hostname", async () => {
    const { client, reads } = networkPlane({
      identities: () => [
        identity({ hosts: { api: "https://zone-a.example.com/x" } }),
      ],
    });
    const error = await failure(client().account.computers.get("payments"));
    expect((error as Error).message).toMatch(/^computer API host: /u);
    expect((error as Error).message).not.toMatch(/subnet/iu);
    expect(reads(subnetHost)).toHaveLength(0);
  });

  // Contract: a caller's signal ends only its own wait; the shared read
  // goes on and serves the operations still waiting for it.
  it("ends only the cancelled caller's wait", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, reads } = networkPlane({
      routes: async (request) => {
        if (request.url.host !== metaHost) return undefined;
        await held;
        return json({ computerSubnet: subnetSlug });
      },
    });
    const computers = client().account.computers;
    const controller = new AbortController();
    const cancelled = computers.get("payments", { signal: controller.signal });
    const waiting = computers.get("payments");
    controller.abort(new Error("stop"));
    await expect(cancelled).rejects.toThrow("stop");
    release?.();
    await expect(waiting).resolves.toBeDefined();
    expect(reads(metaHost)).toHaveLength(1);
  });

  // Contract: a client configured without a meta endpoint is refused
  // before any request, in the endpoint's own words.
  it("requires the meta endpoint", async () => {
    const plane = new FakeControlPlane();
    const computers = plane.client({
      network: undefined,
      endpoints: { api: "https://api.example.com" },
      placement: networkPlacement,
    }).account.computers;
    await expect(computers.get("payments")).rejects.toThrow(
      new TypeError(
        "meta endpoint is required; configure network or endpoints.meta",
      ),
    );
    expect(plane.requests).toEqual([]);
  });
});
