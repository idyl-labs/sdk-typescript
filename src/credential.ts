// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { keyPairProblem, keyProfile } from "./internal/dpop.js";

/**
 * An access token and the key it is bound to.
 *
 * Every token IDYL issues is bound to a key its holder keeps (RFC 9449,
 * DPoP) and is accepted only with a proof of possession of that key made
 * for the one request it accompanies. The package signs that proof with
 * `key` for every request, retries included. `key` is a WebCrypto key pair
 * of an Ed25519 or ECDSA P-256 key; its private half may be
 * non-extractable, since only `crypto.subtle.sign` is used, and it never
 * leaves the runtime's key store through the package.
 */
export interface Credential {
  /** The access token, presented as issued and never inspected. */
  readonly accessToken: string;
  /** The key pair the token is bound to, which signs each request's proof. */
  readonly key: CryptoKeyPair;
}

/** What a {@link CredentialSource} receives when a request needs a credential. */
export interface CredentialContext {
  /**
   * Aborted when the request is cancelled or exceeds its timeout. A source
   * that performs its own network call passes this signal through so a
   * cancelled request does not leave a token exchange running.
   */
  readonly signal: AbortSignal;
}

/**
 * Supplies the credential for a request. `credential` is called for every
 * authenticated request rather than once at construction, so a source that
 * refreshes or rotates a short-lived token is adopted without rebuilding
 * the client.
 *
 * Every token is opaque to the package: it is presented with a proof and
 * never inspected, logged, or stored beyond the request that used it. A
 * source may be consulted concurrently by requests in flight at once.
 */
export interface CredentialSource {
  /**
   * Returns the credential for one request. A rejection fails that request
   * with the source's error, and the next request asks again.
   *
   * @param context The request's context, whose `signal` ends when the
   *   request is cancelled.
   * @throws {@link Error} whatever the source throws or rejects with; the
   *   request fails with it and sends nothing
   */
  credential(context: CredentialContext): Credential | Promise<Credential>;
}

/**
 * A fixed access token and its key. An access token expires within an hour,
 * so prefer a refreshing {@link CredentialSource}, such as
 * `accessKeyCredentials`, for a long-running program.
 *
 * @param accessToken An access token IDYL issued for `key`.
 * @param key The Ed25519 or ECDSA P-256 key pair the token is bound to.
 * @throws {@link TypeError} `accessToken` is empty or contains whitespace or
 *   control characters, or `key` is not an Ed25519 or ECDSA P-256 key pair
 *   whose private key may sign
 */
export function staticCredential(
  accessToken: string,
  key: CryptoKeyPair,
): CredentialSource {
  const problem =
    typeof accessToken === "string" ? tokenProblem(accessToken) : "is required";
  if (problem !== undefined) {
    throw new TypeError(`credential access token ${problem}`);
  }
  const keyProblem = keyPairProblem(key);
  if (keyProblem !== undefined) {
    throw new TypeError(`credential key ${keyProblem}`);
  }
  const credential: Credential = Object.freeze({ accessToken, key });
  return Object.freeze({ credential: () => credential });
}

/**
 * Adapts a function into a {@link CredentialSource}. The function is called
 * for every authenticated request with the request's
 * {@link CredentialContext}.
 *
 * @param source Returns the credential for one request, or a promise of it.
 * @throws {@link TypeError} `source` is not a function
 */
export function credentialSourceFunc(
  source: (context: CredentialContext) => Credential | Promise<Credential>,
): CredentialSource {
  if (typeof source !== "function") {
    throw new TypeError("credential source function is required");
  }
  return Object.freeze({
    credential: (context: CredentialContext) => source(context),
  });
}

/**
 * The RFC 7638 SHA-256 thumbprint of an Ed25519 or ECDSA P-256 public key,
 * unpadded base64url: the `cnf.jkt` of every token bound to the key, and
 * the `dpopJkt` a browser hand-off names. The key's JWK is exported once
 * and kept while the key is.
 *
 * @param publicKey The public half of an Ed25519 or ECDSA P-256 key pair.
 * @throws {@link TypeError} `publicKey` is any other key, or its public half
 *   cannot be exported
 */
export async function keyThumbprint(publicKey: CryptoKey): Promise<string> {
  return (await keyProfile(publicKey)).thumbprint;
}

/**
 * Reports why `token` cannot be presented as a credential, or `undefined`
 * when it can. The wording completes a sentence that names the token's
 * origin.
 */
export function tokenProblem(token: string): string | undefined {
  if (token.length === 0 || token.trim().length === 0) return "is empty";
  if (/\s/u.test(token)) return "contains whitespace";
  for (const character of token) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "contains control characters";
  }
  return undefined;
}
