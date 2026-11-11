// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { TrustKey } from "../computer-connection/trust.js";
import { decodeBase64 } from "../resource/base64.js";

/**
 * The Network trust keys this package pins, by Network: each key's ID, the
 * RFC 7638 thumbprint of its Ed25519 JWK, and its raw public key as
 * standard base64. They are public keys, kept in source so that anyone can
 * read which keys a release trusts. A successor key needs no new release:
 * a Network announces it in a statement a pinned key signs.
 */
const PINNED: ReadonlyMap<
  string,
  readonly { readonly keyId: string; readonly publicKey: string }[]
> = new Map([
  [
    "idyl.sh",
    [
      {
        keyId: "vZZ-WibhORIZdMICCA6lPBTqrmOlsAl3mxASYfOOQ-I",
        publicKey: "/+hVsiFC1uACHFnyv/LzB1mx+sl9vQO0ogTRog12B40=",
      },
    ],
  ],
]);

/**
 * The trust keys this package pins for `network`, as fresh copies a caller
 * may keep, or `undefined` when it pins none for that Network.
 */
export function pinnedTrustKeys(network: string): TrustKey[] | undefined {
  return PINNED.get(network)?.map(({ keyId, publicKey }) => ({
    keyId,
    publicKey: decodeBase64(publicKey),
  }));
}
