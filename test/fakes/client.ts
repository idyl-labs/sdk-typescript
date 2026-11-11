// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * A test client over the internal services: the transport, the resolved
 * endpoints, and the place the Account's Computers live in, wired the way
 * the package's client wires them, so a test drives a service exactly as a
 * caller of the client would.
 */
import type { ClientProduct } from "../../src/client-product.js";
import type { CredentialSource } from "../../src/credential.js";
import { testCredential } from "./keys.js";
import type {
  PlacementContext,
  ServiceState,
} from "../../src/internal/context.js";
import type { PlacementSource } from "../../src/internal/placement.js";
import {
  resolveEndpointSet,
  type EndpointSet,
} from "../../src/internal/endpoints.js";
import { Transport, type Fetch } from "../../src/internal/transport.js";
import { parseAccountId, parseSubnetSlug } from "../../src/resource/id.js";
import type { AccountId } from "../../src/resource/id.js";
import { computersService } from "../../src/services/computers.js";
import type { ComputersService } from "../../src/services/computers.js";
import { namespacesService } from "../../src/services/namespaces.js";
import type { NamespacesService } from "../../src/services/namespaces.js";
import {
  accountId,
  network,
  subnetEndpoint,
  subnetSlug,
} from "./fetch-queue.js";

/** What a test client is built from; every field has a test default. */
export interface TestClientConfig {
  readonly network?: string | undefined;
  readonly endpoints?: EndpointSet | undefined;
  readonly accountId?: string | undefined;
  readonly namespace?: string | undefined;
  readonly subnet?: string | undefined;
  readonly subnetEndpoint?: string | undefined;
  /**
   * Replaces the fake placement source the other two fields build, given
   * the client's state.
   */
  readonly placement?: ((state: ServiceState) => PlacementSource) | undefined;
  readonly credential?: CredentialSource | undefined;
  readonly fetch?: Fetch | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly userAgent?: string | undefined;
  readonly clientProduct?: ClientProduct | undefined;
  readonly allowHttp?: boolean | undefined;
}

/** The Account-scoped services a test drives. */
export interface TestAccount {
  readonly accountId: AccountId;
  readonly computers: ComputersService;
  readonly namespaces: NamespacesService;
}

/** A test client: its state, its context, and its services. */
export interface TestClient {
  readonly state: ServiceState;
  readonly context: PlacementContext;
  readonly account: TestAccount;
  /** The same client in another Namespace. */
  forNamespace(namespace: string): TestClient;
  /**
   * The services of another Account the credential manages; the client's
   * Namespace belongs to its own Account and is not applied.
   */
  accountById(accountId: string): TestAccount;
}

/** Builds a test client; a field left unset takes the test default. */
export function testClient(config: TestClientConfig = {}): TestClient {
  const endpoints = resolveEndpointSet(
    config.network ?? (config.endpoints === undefined ? network : undefined),
    config.endpoints,
    config.allowHttp ?? false,
    "API",
  );
  const transport = new Transport({
    credential: config.credential ?? testCredential,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(config.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: config.requestTimeoutMs }),
    ...(config.userAgent === undefined ? {} : { userAgent: config.userAgent }),
    ...(config.clientProduct === undefined
      ? {}
      : { clientProduct: config.clientProduct }),
    ...(config.allowHttp === undefined ? {} : { allowHttp: config.allowHttp }),
  });
  const scheme = new URL(endpoints.api).protocol as "https:" | "http:";
  const state: ServiceState = { endpoints, scheme, transport };
  const placement =
    config.placement?.(state) ??
    fixedPlacement(
      config.subnet ?? subnetSlug,
      config.subnetEndpoint ?? subnetEndpoint,
    );
  return build(
    state,
    parseAccountId(config.accountId ?? accountId),
    config.namespace,
    placement,
  );
}

function build(
  state: ServiceState,
  account: AccountId,
  namespace: string | undefined,
  placement: PlacementSource,
): TestClient {
  const context: PlacementContext = {
    state,
    scope: {
      accountId: account,
      ...(namespace === undefined ? {} : { namespace }),
    },
    placement,
  };
  return {
    state,
    context,
    account: {
      accountId: account,
      computers: computersService(context, account, namespace),
      namespaces: namespacesService(context, account),
    },
    forNamespace(next) {
      return build(state, account, next, placement);
    },
    accountById(id) {
      return build(state, parseAccountId(id), undefined, placement).account;
    },
  };
}

/**
 * A placement source that answers every resolution with one place at once,
 * as a client whose Account's placement is already known does.
 */
export function fixedPlacement(
  subnet: string,
  endpoint: string,
): PlacementSource {
  const assigned = {
    subnet: parseSubnetSlug(subnet),
    endpoint,
    zone: "zone-a",
  };
  return {
    resolve: () => Promise.resolve(assigned),
  };
}
