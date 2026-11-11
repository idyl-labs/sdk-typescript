// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  array,
  boolean,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { prefixed } from "./validation.js";

/**
 * The network intent of a Computer's execution environment, independent of
 * its isolation class: an isolation class constrains compute isolation
 * only, and every network class is enforced by the host outside the
 * environment's sandbox. The tokens are the kebab-case taxonomy the
 * platform defines.
 *
 * - `none` requests no network access; egress rules cannot be combined
 *   with it.
 * - `internet` requests outbound access to the public internet with every
 *   local network denied: the host's own addresses, the networks the host
 *   is directly connected to, and the private, shared, loopback,
 *   link-local (cloud instance metadata included), multicast, and reserved
 *   ranges. Name resolution reaches the resolvers the host is configured
 *   with, and nothing else on a local network. Nothing outside the host can
 *   open a connection to the environment. Egress rules cannot be combined
 *   with it. It is the class settings that omit their network run with.
 * - `restricted-egress` requests deny-by-default networking where only the
 *   destinations allowed by the egress block are reachable and local
 *   networks stay denied. It is the only class that accepts an egress
 *   block.
 * - `unrestricted` requests ordinary outbound access with no
 *   platform-imposed egress filtering, local networks included; egress
 *   rules cannot be combined with it.
 *
 * The union is open: a class the platform reports that this SDK does not
 * know is carried as a string rather than rejected on read.
 */
export type NetworkClass =
  | "none"
  | "internet"
  | "restricted-egress"
  | "unrestricted"
  | (string & Record<never, never>);

/** Network intent. */
export interface WorkloadNetwork {
  /**
   * The requested network policy. Required whenever the network block is
   * present; settings that omit the whole block run with class `internet`.
   */
  readonly class?: NetworkClass;
  /** Allowed outbound destinations for a restricted-egress network. */
  readonly egress?: WorkloadNetworkEgress;
}

/** Restricted-egress allow intent. */
export interface WorkloadNetworkEgress {
  /**
   * Structured allow rules: `dns`, or `tcp:<port>:<dns-hostname>`. TCP
   * targets are DNS hostnames, never IP literals.
   */
  readonly allow?: readonly string[];
  /**
   * Must be `true` whenever `allow` is set. Local networks remain denied
   * while the listed destinations are allowed.
   */
  readonly denyLocalNetworks?: boolean;
}

export const workloadNetworkEgressShape: Shape<WorkloadNetworkEgress> =
  object<WorkloadNetworkEgress>({
    allow: omitEmpty(array(string())),
    denyLocalNetworks: pointer(boolean()),
  });

export const workloadNetworkShape: Shape<WorkloadNetwork> =
  object<WorkloadNetwork>({
    class: omitEmpty(string<NetworkClass>()),
    egress: pointer(workloadNetworkEgressShape),
  });

/**
 * Judges a network class a caller wrote: exactly the four supported
 * classes are accepted, and the empty string is reported as required.
 */
export function validateNetworkClass(networkClass: NetworkClass): void {
  switch (networkClass) {
    case "none":
    case "internet":
    case "restricted-egress":
    case "unrestricted":
      return;
    case "":
      throw new TypeError("network class is required");
    default:
      throw new TypeError(
        `unknown network class ${JSON.stringify(networkClass)} (supported: none, internet, restricted-egress, unrestricted)`,
      );
  }
}

/**
 * Judges the network intent as a whole: the class is valid, an egress block
 * is only permitted with the `restricted-egress` class, and a
 * restricted-egress block carries well-formed allow rules with
 * `denyLocalNetworks` explicitly `true` whenever allow rules are present.
 * Throws a `TypeError` naming the first violation.
 */
export function validateWorkloadNetwork(network: WorkloadNetwork): void {
  validateWorkloadNetworkWith(network, validateWorkloadNetworkEgressAllowRule);
}

/**
 * {@link validateWorkloadNetwork}, holding each allow entry to `allowRule`.
 * Throws a `TypeError` naming the first violation.
 */
export function validateWorkloadNetworkWith(
  network: WorkloadNetwork,
  allowRule: (rule: string) => void,
): void {
  const networkClass = network.class ?? "";
  validateNetworkClass(networkClass);
  switch (networkClass) {
    case "none":
    case "internet":
    case "unrestricted":
      if (network.egress !== undefined) {
        throw new TypeError(
          `network.egress is not supported with network.class ${networkClass}`,
        );
      }
      return;
    case "restricted-egress":
      validateRestrictedEgressPolicy(network.egress, allowRule);
      return;
    default:
      return;
  }
}

function validateRestrictedEgressPolicy(
  egress: WorkloadNetworkEgress | undefined,
  allowRule: (rule: string) => void,
): void {
  if (egress === undefined) return;
  if (egress.denyLocalNetworks === false) {
    throw new TypeError(
      "network.egress.denyLocalNetworks must be true for network.class restricted-egress",
    );
  }
  const allow = egress.allow ?? [];
  if (allow.length > 0 && egress.denyLocalNetworks === undefined) {
    throw new TypeError(
      "network.egress.denyLocalNetworks must be explicit true when network.egress.allow is set",
    );
  }
  allow.forEach((rule, index) => {
    prefixed(`network.egress.allow[${String(index)}] is invalid`, () => {
      allowRule(rule);
    });
  });
}

/**
 * Judges a Pod's restricted-egress allow rule: `dns`, or
 * `tcp:<port>:<dns-hostname>` with a port between 1 and 65535 and a
 * well-formed, non-local DNS hostname. A Micropod's rules are judged by
 * `validateMicropodEgressAllowRule`, which accepts these and more.
 */
export function validateWorkloadNetworkEgressAllowRule(rule: string): void {
  if (rule === "") throw new TypeError("allow rule is required");
  if (rule.trim() !== rule) {
    throw new TypeError("allow rule must not contain surrounding whitespace");
  }
  if (rule === "dns") return;

  const firstColon = rule.indexOf(":");
  if (firstColon === -1) {
    throw new TypeError("expected dns or tcp:<port>:<dns-hostname>");
  }
  const protocol = rule.slice(0, firstColon);
  const rest = rule.slice(firstColon + 1);
  if (protocol !== "tcp") {
    throw new TypeError(
      `unsupported egress protocol ${JSON.stringify(protocol)} (supported: tcp, dns)`,
    );
  }
  const secondColon = rest.indexOf(":");
  if (secondColon === -1) {
    throw new TypeError("expected tcp:<port>:<dns-hostname>");
  }
  const portValue = rest.slice(0, secondColon);
  const host = rest.slice(secondColon + 1);
  if (portValue === "") throw new TypeError("tcp egress port is required");
  if (
    !/^\d+$/u.test(portValue) ||
    Number(portValue) === 0 ||
    Number(portValue) > 65535
  ) {
    throw new TypeError(
      `tcp egress port ${JSON.stringify(portValue)} must be between 1 and 65535`,
    );
  }
  validateNetworkTargetHost(host);
}

function validateNetworkTargetHost(host: string): void {
  if (host === "") throw new TypeError("egress host is required");
  if (looksLikeIpAddress(host)) {
    throw new TypeError(
      `egress host ${JSON.stringify(host)} must be a DNS hostname, not an IP literal`,
    );
  }
  if (host.includes("*")) {
    throw new TypeError(
      `egress host ${JSON.stringify(host)} must be a DNS hostname, not a wildcard`,
    );
  }
  validateNetworkTargetHostname(host);
}

/** Judges a DNS hostname an egress rule names. Throws a `TypeError`. */
export function validateNetworkTargetHostname(host: string): void {
  const quoted = JSON.stringify(host);
  if (host.length > 253) {
    throw new TypeError(`egress host ${quoted} exceeds 253 characters`);
  }
  if (host.endsWith(".")) {
    throw new TypeError(`egress host ${quoted} must not end with a dot`);
  }
  const lower = host.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local")
  ) {
    throw new TypeError(`egress host ${quoted} is a denied local hostname`);
  }
  for (const label of host.split(".")) {
    if (label.length === 0) {
      throw new TypeError(`egress host ${quoted} contains an empty DNS label`);
    }
    if (label.length > 63) {
      throw new TypeError(
        `egress host ${quoted} contains a DNS label longer than 63 characters`,
      );
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      throw new TypeError(
        `egress host ${quoted} contains a DNS label with a leading or trailing hyphen`,
      );
    }
    for (const character of label) {
      if (!/^[a-zA-Z0-9-]$/u.test(character)) {
        throw new TypeError(
          `egress host ${quoted} contains invalid DNS label character ${JSON.stringify(character)}`,
        );
      }
    }
  }
}

/** Whether `host` reads as an IP literal rather than a DNS hostname. */
export function looksLikeIpAddress(host: string): boolean {
  const looksIpv4 = host.includes(".") && /^[0-9.]+$/u.test(host);
  const looksIpv6 = host.includes(":") && /^[0-9a-fA-F:.]+$/u.test(host);
  return looksIpv4 || looksIpv6;
}
