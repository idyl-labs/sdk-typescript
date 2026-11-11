// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * Where an Account's Computers live. IDYL assigns the place, and a client
 * learns it in two reads: the network's public metadata names the Subnet
 * every Account's Computers live in, and the Account's deployable-Subnet
 * discovery advertises the host of its API. The package never lists Subnets
 * to choose one, never guesses one, and names none in an option, a type, or
 * a message.
 *
 * Whether the Account may use the place is the platform's decision: the
 * package judges nothing about it, and a refusal arrives as the `ApiError`
 * of the request it refused. Discovery that names no API host for the
 * place is IDYL's misconfiguration, which no caller can act on, and is a
 * plain `Error` that names no place.
 *
 * A resolved place is kept for the life of the client, per Account. A
 * failed read is never kept: the next operation reads again.
 */
import { decodeNetwork, validateNetwork } from "../api/network.js";
import { TransportError } from "../errors.js";
import { parseSubnetSlug } from "../resource/id.js";
import type { AccountId, SubnetSlug } from "../resource/id.js";
import { errorMessage } from "../resource/validation.js";
import { abortable } from "./abort.js";
import { account, NETWORK_METADATA } from "./apipath.js";
import type { ServiceState } from "./context.js";
import { endpointForHost, requireMeta } from "./endpoints.js";

/**
 * The place an Account's Computers live in, and the origin of its API.
 * `zone` is the trust scope discovery names for the place, which a
 * Computer connection holds its session trust to; empty when discovery
 * names none.
 */
export interface AssignedPlacement {
  readonly subnet: SubnetSlug;
  readonly endpoint: string;
  readonly zone: string;
}

/** What one resolution takes. */
export interface PlacementRequest {
  readonly signal?: AbortSignal;
}

/**
 * The one seam placement is resolved through: the place `accountId`'s
 * Computers live in and the origin of its API.
 */
export interface PlacementSource {
  resolve(
    accountId: AccountId,
    request?: PlacementRequest,
  ): Promise<AssignedPlacement>;
}

/**
 * The placement source of a client on an IDYL network: the network's public
 * metadata names the Computer Subnet, read once, anonymously, and shared by
 * every Account; the Account's discovery advertises its API host. Concurrent operations share one read, and a caller's signal ends
 * only its own wait.
 */
export function networkPlacement(state: ServiceState): PlacementSource {
  let computerSubnet: Promise<SubnetSlug> | undefined;
  const managed = new Map<AccountId, Promise<AssignedPlacement>>();

  const subnet = (): Promise<SubnetSlug> => {
    computerSubnet ??= readComputerSubnet(state).catch((error: unknown) => {
      computerSubnet = undefined;
      throw error;
    });
    return computerSubnet;
  };

  return {
    async resolve(accountId, request = {}) {
      const signal = request.signal ?? new AbortController().signal;
      let placement = managed.get(accountId);
      if (placement === undefined) {
        placement = subnet()
          .then((slug) => discover(state, accountId, slug))
          .catch((error: unknown) => {
            managed.delete(accountId);
            throw error;
          });
        managed.set(accountId, placement);
      }
      return await abortable(placement, signal);
    },
  };
}

/**
 * Reads the network's public metadata and returns the Subnet every
 * Account's Computers live in. Throws a `TypeError` when the metadata names
 * none or names one that is not a canonical slug.
 */
async function readComputerSubnet(state: ServiceState): Promise<SubnetSlug> {
  const served = await state.transport.anonymousJson<unknown>(
    "GET",
    requireMeta(state.endpoints.meta),
    NETWORK_METADATA,
  );
  try {
    const metadata = decodeNetwork(served);
    validateNetwork(metadata);
    return parseSubnetSlug(metadata.computerSubnet);
  } catch (cause) {
    throw new TransportError(
      "invalid_response",
      "network metadata names no valid place for computers",
      { cause },
    );
  }
}

/**
 * Finds `slug` in the Account's deployable-Subnet discovery and returns it
 * with the origin of its API. Throws a plain `Error` that names no place
 * when discovery advertises no API host for it.
 */
async function discover(
  state: ServiceState,
  accountId: AccountId,
  slug: SubnetSlug,
): Promise<AssignedPlacement> {
  const discovery = asRecord(
    await state.transport.json<unknown>(
      "GET",
      state.endpoints.api,
      account(accountId, "deployable-subnet-identities"),
    ),
  );
  const identities = discovery["identities"];
  const identity = (Array.isArray(identities) ? identities : [])
    .map(asRecord)
    .find((candidate) => candidate["slug"] === slug);
  const host =
    identity === undefined
      ? ""
      : stringField(asRecord(identity["hosts"]), "api");
  if (host === "") {
    throw new Error("IDYL advertises no computer API for this account");
  }
  let endpoint: string;
  try {
    endpoint = endpointForHost(state.scheme, host);
  } catch (cause) {
    throw new TransportError(
      "invalid_response",
      `computer API host: ${errorMessage(cause)}`,
      { cause },
    );
  }
  const zone = identity === undefined ? "" : stringField(identity, "zone");
  return { subnet: slug, endpoint, zone };
}

/**
 * A response read leniently: a value that is not an object reads as an
 * empty one, so a missing field is judged by the rule that consumes it
 * rather than by a schema.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
