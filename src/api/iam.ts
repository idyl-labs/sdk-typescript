// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { AccessKey } from "./iam-entities.js";

/*
 * Access keys.
 */

/**
 * The public half of an Ed25519 or ECDSA P-256 key as a JSON Web Key
 * (RFC 7517), public members only: `kty` `OKP`, `crv` `Ed25519` and `x`, or
 * `kty` `EC`, `crv` `P-256`, `x` and `y`.
 */
export interface PublicJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y?: string;
}

/**
 * Registers a public key as an access key. `name` is 1 to 128 characters.
 * `expiresAt` is an RFC 3339 instant; a key with none never expires. A field
 * left `undefined` is not sent. The private key is generated and kept by the
 * holder and is never sent; a public key registers once across the network.
 */
export interface CreateAccessKeyRequest {
  readonly name: string;
  readonly description?: string;
  readonly publicKey: PublicJwk;
  readonly expiresAt?: string;
}

/** The registered key's record, under the wire key `accessKey`. */
export interface CreateAccessKeyResponse {
  readonly accessKey: AccessKey;
}

/** The access keys of one principal, under the wire key `accessKeys`. */
export interface ListAccessKeysResponse {
  readonly accessKeys: readonly AccessKey[];
}
