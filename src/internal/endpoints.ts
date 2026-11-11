// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * How a Network domain becomes the public endpoints a client addresses. The
 * conventional hosts are derived from the domain, an explicit entry overrides
 * the derived one, and every endpoint is held to the same rule: an absolute
 * origin with no path, query, fragment, or user information. Every client
 * resolves its endpoints here, naming the one endpoint it cannot do
 * without.
 */

import { errorMessage } from "../resource/validation.js";

/** The public endpoints an endpoint set may name, each an absolute origin. */
export interface EndpointSet {
  readonly api?: string;
  readonly identity?: string;
  readonly meta?: string;
}

/** Which endpoint a client requires; the others are optional. */
export type RequiredEndpoint = "API" | "identity" | "meta";

/**
 * Derives the conventional public endpoints for a Network, keeps explicit
 * overrides, requires the named endpoint, and canonicalizes every configured
 * endpoint. The required endpoint is validated first so its error takes
 * precedence. Throws a `TypeError` naming the problem.
 */
export function resolveEndpointSet(
  network: string | undefined,
  configured: EndpointSet | undefined,
  allowHttp: boolean,
  required: "API",
): EndpointSet & { readonly api: string };
export function resolveEndpointSet(
  network: string | undefined,
  configured: EndpointSet | undefined,
  allowHttp: boolean,
  required: "identity",
): EndpointSet & { readonly identity: string };
export function resolveEndpointSet(
  network: string | undefined,
  configured: EndpointSet | undefined,
  allowHttp: boolean,
  required: "meta",
): EndpointSet & { readonly meta: string };
export function resolveEndpointSet(
  network: string | undefined,
  configured: EndpointSet | undefined,
  allowHttp: boolean,
  required: RequiredEndpoint,
): EndpointSet {
  const endpoints = { ...configured };
  if (network !== undefined) {
    validateNetworkDomain(network);
    endpoints.api ??= `https://api.${network}`;
    endpoints.identity ??= `https://identity.${network}`;
    endpoints.meta ??= `https://meta.${network}`;
  }
  const requiredValue =
    required === "API"
      ? endpoints.api
      : required === "identity"
        ? endpoints.identity
        : endpoints.meta;
  if (requiredValue === undefined) {
    throw new TypeError(
      `${required} endpoint is required when network is not configured`,
    );
  }
  const requiredEndpoint = validateEndpoint(required, requiredValue, allowHttp);
  const api =
    required === "API"
      ? requiredEndpoint
      : optionalEndpoint("API", endpoints.api, allowHttp);
  const identity =
    required === "identity"
      ? requiredEndpoint
      : optionalEndpoint("identity", endpoints.identity, allowHttp);
  const meta =
    required === "meta"
      ? requiredEndpoint
      : optionalEndpoint("meta", endpoints.meta, allowHttp);
  return Object.freeze({
    ...(api === undefined ? {} : { api }),
    ...(identity === undefined ? {} : { identity }),
    ...(meta === undefined ? {} : { meta }),
  });
}

function optionalEndpoint(
  label: string,
  raw: string | undefined,
  allowHttp: boolean,
): string | undefined {
  return raw === undefined
    ? undefined
    : validateEndpoint(label, raw, allowHttp);
}

/**
 * Holds a Network domain to a bare DNS name: no scheme, port, path, query,
 * fragment, user information, or surrounding whitespace. Throws a
 * `TypeError` naming the problem.
 */
export function validateNetworkDomain(network: string): void {
  if (network === "" || network.trim() !== network) {
    throw new TypeError(
      "network domain must be a non-empty DNS name without surrounding whitespace",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${network}`);
  } catch (cause) {
    throw new TypeError(`invalid network domain ${JSON.stringify(network)}`, {
      cause,
    });
  }
  if (
    parsed.hostname !== network.toLowerCase() ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    network.includes("/") ||
    network.startsWith(".") ||
    network.endsWith(".")
  ) {
    throw new TypeError(`invalid network domain ${JSON.stringify(network)}`);
  }
}

/**
 * Holds an endpoint to an absolute `https:` origin (or `http:` when
 * `allowHttp`) with no path, query, fragment, or user information, and
 * returns it in canonical origin form. Throws a `TypeError` naming `label`
 * and the problem.
 */
export function validateEndpoint(
  label: string,
  raw: string,
  allowHttp: boolean,
): string {
  if (raw.trim() !== raw) {
    throw new TypeError(
      `${label} endpoint must not have leading or trailing whitespace`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new TypeError(`${label} endpoint: ${errorMessage(cause)}`, {
      cause,
    });
  }
  if (
    parsed.protocol !== "https:" &&
    !(allowHttp && parsed.protocol === "http:")
  ) {
    throw new TypeError(`${label} endpoint must use https`);
  }
  if (parsed.host === "" || parsed.username !== "" || parsed.password !== "") {
    throw new TypeError(
      `${label} endpoint must be an absolute URL without user information`,
    );
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new TypeError(`${label} endpoint must not include a path`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError(
      `${label} endpoint must not include a query or fragment`,
    );
  }
  return parsed.origin;
}

/**
 * Turns the bare API host discovery advertises into the origin requests are
 * sent to, under the client's scheme. The host is a hostname with an
 * optional port and nothing else: no scheme, path, query, fragment, user
 * information, or surrounding whitespace. Throws a `TypeError` naming the
 * problem.
 */
export function endpointForHost(
  scheme: "https:" | "http:",
  host: string,
): string {
  if (host === "" || host.trim() !== host || host.includes("://")) {
    throw new TypeError(
      "must be a hostname without a scheme or surrounding whitespace",
    );
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(`${scheme}//${host}`);
  } catch {
    parsed = undefined;
  }
  if (
    parsed === undefined ||
    parsed.host === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    /[/?#@\\]/u.test(host)
  ) {
    throw new TypeError(
      "must be a hostname without a path, query, fragment, or user information",
    );
  }
  return parsed.origin;
}

/**
 * The metadata endpoint the network's public metadata is read from. Throws a `TypeError`
 * saying one is required when the client resolved none.
 */
export function requireMeta(endpoint: string | undefined): string {
  if (endpoint === undefined) {
    throw new TypeError(
      "meta endpoint is required; configure network or endpoints.meta",
    );
  }
  return endpoint;
}
