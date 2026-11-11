// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { AccessKeyId } from "../resource/uuid-id.js";

/**
 * The record of an access key: a public key registered for automation.
 * The holder keeps the private key; IDYL keeps only the public key and its
 * thumbprint, so no route can return a secret. The holder exchanges a proof
 * signed with the key for short-lived access tokens bound to that same key.
 *
 * Only the fields the package reads are declared; anything else a served
 * record carries is ignored. `expiresAt` is absent for a key with no
 * expiry, `lastUsedAt` until the key has been exchanged, and `revokedAt`
 * until it is revoked. The timestamps are RFC 3339 instants.
 */
export interface AccessKey {
  readonly id: AccessKeyId;
  readonly name: string;
  readonly description?: string;
  readonly keyThumbprint: string;
  readonly expiresAt?: string;
  readonly createdAt?: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
}
