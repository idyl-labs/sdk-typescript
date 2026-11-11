// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { ProfileTokenRequest } from "./auth-profile.js";

/** A browser transaction using an exact registered redirect and S256 PKCE. */
export interface AuthorizeBrowserRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  /** 32 browser-generated random bytes encoded as unpadded base64url. */
  readonly state: string;
  readonly codeChallenge: string;
  /**
   * The RFC 7638 thumbprint of the key the browser holds. The code is
   * redeemable only with a proof signed by that key, and the tokens it
   * yields are bound to it.
   */
  readonly dpopJkt: string;
  /** Requires accountId and profileId; name and default-profile selectors are unsupported. */
  readonly profile: ProfileTokenRequest;
}

/**
 * A short-lived, single-use code for the browser, and the successor of the
 * refresh token the request presented, which is retired. `expiresAt` is the
 * code's expiry and `refreshExpiresAt` the successor's, as RFC 3339
 * instants.
 */
export interface AuthorizeBrowserResponse {
  readonly code: string;
  readonly expiresAt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
}

/** Redeems a code with its original transaction binding and RFC 7636 verifier. */
export interface ExchangeBrowserRequest {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string;
}
