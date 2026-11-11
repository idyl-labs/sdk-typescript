// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  looksLikeIpAddress,
  validateNetworkTargetHostname,
} from "./workload-network.js";

/**
 * The allow entry that lets a restricted-egress network resolve the hostnames
 * its other entries cover. It names no destination.
 */
export const EGRESS_ALLOW_DNS = "dns";

/** The transport an egress allow rule covers. */
export type EgressProtocol = "tcp" | "udp";

/** The IPv4 destinations no egress rule reaches, as `[address, bits]`. */
const LOCAL_NETWORK_RANGES: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/**
 * One destination a Micropod's restricted-egress network allows, parsed from
 * `<protocol>:<port>:<destination>`. A rule states either a hostname, in
 * `host`, or an address range, in `range`.
 */
export interface EgressAllowRule {
  /** The transport the rule covers. */
  readonly protocol: EgressProtocol;
  /** The destination port, between 1 and 65535. */
  readonly port: number;
  /** The lowercase hostname the rule covers; absent on an address or range. */
  readonly host?: string;
  /**
   * True when the rule was written `*.<host>`, and so covers `host` and every
   * name below it, at any depth.
   */
  readonly wildcard?: boolean;
  /**
   * The IPv4 range the rule covers, a single address held as a `/32`; absent
   * on a hostname.
   */
  readonly range?: string;
}

/** The address of a dotted-quad IPv4 literal as an unsigned 32-bit value. */
function ipv4Value(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255) {
      return undefined;
    }
    value = value * 256 + Number(part);
  }
  return value;
}

/** The first address of the `/bits` range around `value`. */
function masked(value: number, bits: number): number {
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) * size;
}

/** The IPv4 range of an address or canonical range. */
function parseEgressRange(destination: string): string {
  const quoted = JSON.stringify(destination);
  const invalid = new TypeError(
    `egress host ${quoted} is not a valid IPv4 address or range`,
  );
  const slash = destination.indexOf("/");
  const address = slash === -1 ? destination : destination.slice(0, slash);
  const length = slash === -1 ? "32" : destination.slice(slash + 1);
  if (address.includes(":")) {
    if (/^[0-9a-fA-F:.]+$/u.test(address) && address.includes("::")) {
      throw new TypeError(
        `egress host ${quoted} is an IPv6 destination, which is not supported`,
      );
    }
    throw invalid;
  }
  const value = ipv4Value(address);
  if (
    value === undefined ||
    !/^(?:0|[1-9][0-9]?)$/u.test(length) ||
    Number(length) > 32
  ) {
    throw invalid;
  }
  const bits = Number(length);
  if (masked(value, bits) !== value) {
    throw new TypeError(`egress range ${quoted} must have no host bits set`);
  }
  for (const [local, localBits] of LOCAL_NETWORK_RANGES) {
    const start = ipv4Value(local);
    if (
      start !== undefined &&
      localBits <= bits &&
      masked(value, localBits) === start
    ) {
      throw new TypeError(
        `egress host ${quoted} is inside the local network range ${local}/${String(localBits)}`,
      );
    }
  }
  return `${address}/${String(bits)}`;
}

/**
 * The lowercase name below the wildcard of `*.<name>`: at least two labels,
 * a DNS hostname rather than an IP literal. Throws a `TypeError`.
 */
export function parseEgressWildcard(destination: string): string {
  const quoted = JSON.stringify(destination);
  const name = destination.startsWith("*.") ? destination.slice(2) : undefined;
  if (name === undefined || !name.includes(".") || name.includes("*")) {
    throw new TypeError(
      `egress host ${quoted} must write a wildcard as *.<name> with at least two labels in the name`,
    );
  }
  if (looksLikeIpAddress(name)) {
    throw new TypeError(
      `egress host ${quoted} must write a wildcard below a DNS hostname, not an IP literal`,
    );
  }
  validateNetworkTargetHostname(name);
  return name.toLowerCase();
}

/**
 * Parses a destination allow rule of a Micropod's network: `tcp` or `udp`, a
 * port between 1 and 65535, and one destination, a DNS hostname, a wildcard
 * such as `*.example.com`, an IPv4 address, or a canonical IPv4 range such as
 * `93.184.216.0/24`.
 *
 * It refuses a rule that could never work: a local hostname, a wildcard with
 * fewer than two labels after `*.` or anywhere but as the whole leftmost
 * label, an address or range wholly inside the local network ranges, a range
 * with host bits set, and IPv6. {@link EGRESS_ALLOW_DNS} names no destination
 * and is refused here; {@link validateMicropodEgressAllowRule} accepts it.
 * Throws a `TypeError`.
 */
export function parseEgressAllowRule(rule: string): EgressAllowRule {
  if (rule === "") throw new TypeError("allow rule is required");
  if (rule.trim() !== rule) {
    throw new TypeError("allow rule must not contain surrounding whitespace");
  }
  const firstColon = rule.indexOf(":");
  if (firstColon === -1) {
    throw new TypeError("expected dns or <tcp|udp>:<port>:<destination>");
  }
  const protocol = rule.slice(0, firstColon);
  if (protocol !== "tcp" && protocol !== "udp") {
    throw new TypeError(
      `unsupported egress protocol ${JSON.stringify(protocol)} (supported: tcp, udp, dns)`,
    );
  }
  const rest = rule.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  if (secondColon === -1) {
    throw new TypeError("expected <tcp|udp>:<port>:<destination>");
  }
  const portValue = rest.slice(0, secondColon);
  const destination = rest.slice(secondColon + 1);
  if (portValue === "") throw new TypeError("egress port is required");
  if (
    !/^\d+$/u.test(portValue) ||
    Number(portValue) === 0 ||
    Number(portValue) > 65535
  ) {
    throw new TypeError(
      `egress port ${JSON.stringify(portValue)} must be between 1 and 65535`,
    );
  }
  const port = Number(portValue);
  if (destination === "") throw new TypeError("egress host is required");
  if (destination.includes("/") || looksLikeIpAddress(destination)) {
    return { protocol, port, range: parseEgressRange(destination) };
  }
  if (destination.includes("*")) {
    return {
      protocol,
      port,
      host: parseEgressWildcard(destination),
      wildcard: true,
    };
  }
  validateNetworkTargetHostname(destination);
  return { protocol, port, host: destination.toLowerCase() };
}

/**
 * Judges one allow entry of a Micropod's network: {@link EGRESS_ALLOW_DNS}, or
 * a rule {@link parseEgressAllowRule} accepts. Throws a `TypeError`.
 */
export function validateMicropodEgressAllowRule(rule: string): void {
  if (rule !== EGRESS_ALLOW_DNS) parseEgressAllowRule(rule);
}
