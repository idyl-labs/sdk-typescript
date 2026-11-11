// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { parseJson } from "../resource/json.js";
import type { JsonObject } from "../resource/json.js";
import { parseSubnetSlug } from "../resource/id.js";
import {
  always,
  decodeValue,
  object,
  string,
  type Shape,
} from "../internal/strictdecode.js";

/**
 * A network's public metadata, served anonymously by its metadata endpoint.
 * It names what every Account of the network shares, so a client reads it
 * once and needs no credential to do so.
 *
 * `computerSubnet` is the twelve-digit address of the place every Account's
 * Computers live in. The network names one such place for all of its
 * Accounts, and no Account chooses it. Whether an Account may use it, and
 * the host of its API, come from the Account's own discovery, which the
 * metadata does not repeat.
 */
export interface Network {
  readonly computerSubnet: string;
}

const networkShape: Shape<Network> = object<Network>({
  computerSubnet: always(string()),
});

/**
 * Reads a network's metadata as served, leniently. `document` is JSON text
 * or a value already parsed from JSON. A field this package does not
 * declare is carried as it arrived, and a missing field reads as its zero
 * value. Nothing is judged; {@link validateNetwork} judges.
 */
export function decodeNetwork(document: unknown): Network {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, networkShape, "lenient");
}

/** Renders a network's metadata as the endpoint serves it. */
export function encodeNetwork(network: Network): JsonObject {
  return networkShape.encode(network) as JsonObject;
}

/**
 * Judges that the metadata names the place for Computers by a canonical
 * twelve-digit address. Throws a `TypeError`.
 */
export function validateNetwork(network: Network): void {
  if (network.computerSubnet === "") {
    throw new TypeError("network metadata names no place for computers");
  }
  try {
    parseSubnetSlug(network.computerSubnet);
  } catch (cause) {
    throw new TypeError(
      "network metadata names an invalid place for computers",
      { cause },
    );
  }
}
