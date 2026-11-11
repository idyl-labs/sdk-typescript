// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * A recorded fake IDYL network for the public client: the current-account
 * route on the identity host, the network's public metadata on the meta
 * host, the Account's discovery on the API host, and whatever Computer
 * routes a test registers on the Computer API host. Every request is
 * recorded before it is answered.
 */
import { Idyl, type IdylOptions } from "../../src/index.js";
import { FakeControlPlane, json, type RouteHandler } from "./control-plane.js";
import { accountId, subnetEndpoint, subnetSlug } from "./fetch-queue.js";
import { testCredential } from "./keys.js";
import type { RecordedRequest } from "./fetch-queue.js";

/** The endpoints the public client is given. */
export const endpoints = {
  api: "https://api.example.test",
  identity: "https://identity.example.test",
  meta: "https://meta.example.test",
};

/** The host of the Computer API. */
export const computerHost = new URL(subnetEndpoint).host;

/** The Namespace the public client addresses. */
export const namespace = "default";

/** The path of the Namespace's Computers. */
export const computersPath = `/v1/accounts/${accountId}/namespaces/${namespace}/computers`;

/** A served Computer, with `fields` over the defaults. */
export function computerRecord(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "01954e20-7540-7ec4-93ec-14f783e6ab04",
    accountId,
    namespaceId: "01954e20-7540-7ec4-93ec-14f783e6ab06",
    namespace,
    subnet: subnetSlug,
    name: "api-dev",
    phase: "active",
    execution: "dormant",
    headVersion: 3,
    spec: { idleTimeout: "300s" },
    createdAt: "2026-01-02T03:04:05Z",
    updatedAt: "2026-01-02T04:05:06Z",
    ...fields,
  };
}

/** A fake network and a public client of it. */
export class FakeNetwork {
  readonly plane: FakeControlPlane;

  /**
   * `zone` is the Zone the Account's discovery names for its Subnet, and
   * empty to name none.
   */
  constructor(
    routes: RouteHandler = () => undefined,
    options: { readonly zone?: string } = {},
  ) {
    const zone = options.zone ?? "zone-a";
    this.plane = new FakeControlPlane({
      routes: async (request, body) => {
        const { host, pathname } = request.url;
        if (host === "identity.example.test" && pathname === "/account") {
          return json({
            id: accountId,
            email: "owner@example.com",
            displayName: "Example",
          });
        }
        if (host === "meta.example.test" && pathname === "/v1/network") {
          return json({ computerSubnet: subnetSlug });
        }
        if (
          host === "api.example.test" &&
          pathname === `/v1/accounts/${accountId}/deployable-subnet-identities`
        ) {
          return json({
            identities: [
              {
                slug: subnetSlug,
                status: "active",
                hosts: { api: computerHost },
                ...(zone === "" ? {} : { zone }),
                regionEnabled: true,
                approvedForAccount: true,
                developerAdmitted: true,
              },
            ],
          });
        }
        if (host !== computerHost) return undefined;
        return await routes(request, body);
      },
    });
  }

  /** A public client of this network. */
  client(options: Partial<IdylOptions> = {}): Idyl {
    return new Idyl({
      credential: testCredential,
      endpoints,
      fetch: this.plane.fetch,
      ...options,
    });
  }

  /** The requests sent to the Computer API, as `METHOD path?query`. */
  computerCalls(): string[] {
    return this.plane.requests
      .filter((request) => request.url.host === computerHost)
      .map(
        (request) =>
          `${request.method} ${request.url.pathname}${request.url.search}`,
      );
  }

  /** The requests sent to the Computer API. */
  computerRequests(): RecordedRequest[] {
    return this.plane.requests.filter(
      (request) => request.url.host === computerHost,
    );
  }
}
