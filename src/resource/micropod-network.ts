// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  EGRESS_ALLOW_DNS,
  parseEgressAllowRule,
  validateMicropodEgressAllowRule,
} from "./egress-allow-rule.js";
import {
  validateWorkloadNetworkWith,
  type WorkloadNetwork,
} from "./workload-network.js";

/**
 * The most distinct protocol and port pairs the allow entries of a Micropod's
 * network may name. Each pair holds one socket open for the Micropod's life.
 */
export const MAX_MICROPOD_EGRESS_PORTS = 32;

/**
 * Judges a network a Micropod runs with, as a Computer's execution environment and a
 * Subnet's `restricted-egress` default network are held to it. It holds the
 * structure `validateWorkloadNetwork` holds, with the allow entries of the
 * Micropod network profile:
 *
 * - the class is `none`, `restricted-egress`, or `internet`;
 *   `unrestricted`, which would reach the host and the networks it is on,
 *   is refused;
 * - each allow entry is one {@link validateMicropodEgressAllowRule} accepts,
 *   which adds UDP, wildcard hostnames, IPv4 addresses, and IPv4 ranges to the
 *   entries a Pod accepts;
 * - the allow entries name at most {@link MAX_MICROPOD_EGRESS_PORTS}
 *   distinct protocol and port pairs.
 *
 * Each refusal names the field it concerns. Throws a `TypeError`.
 */
export function validateMicropodNetwork(network: WorkloadNetwork): void {
  validateWorkloadNetworkWith(network, validateMicropodEgressAllowRule);
  if (network.class === "unrestricted") {
    throw new TypeError(
      "network.class unrestricted is not supported for a Micropod",
    );
  }
  const ports = new Set<string>();
  (network.egress?.allow ?? []).forEach((rule, index) => {
    if (rule === EGRESS_ALLOW_DNS) return;
    const { protocol, port } = parseEgressAllowRule(rule);
    ports.add(`${protocol}:${String(port)}`);
    if (ports.size > MAX_MICROPOD_EGRESS_PORTS) {
      throw new TypeError(
        `network.egress.allow[${String(index)}]: too many distinct egress ports (max ${String(MAX_MICROPOD_EGRESS_PORTS)})`,
      );
    }
  });
}
