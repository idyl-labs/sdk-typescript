// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { AccountId } from "../resource/id.js";
import type { AccessKeyId } from "../resource/uuid-id.js";
import type { Profile } from "./auth-profile.js";

/**
 * How the person signing in reads dates and times, and which browser asked
 * for the code; the client's `SignInOptions` documents each field. None is
 * authority: a value the server cannot use is ignored, never refused.
 */
export interface SignInReader {
  readonly timeZone?: string;
  readonly locale?: string;
  readonly userAgent?: string;
}

/** Starts sign-in by requesting a one-time code for an email address. */
export interface StartAuthRequest extends SignInReader {
  readonly email: string;
}

/**
 * Confirms the code was sent. It carries a message and nothing else, so
 * account existence cannot be enumerated from the response.
 */
export interface StartAuthResponse {
  readonly message: string;
}

/** The email address and the one-time code it received. */
export interface VerifyAuthRequest {
  readonly email: string;
  readonly code: string;
}

/**
 * The result of a verified sign-in. `refreshToken` is what every later
 * exchange presents, and `expiresAt` is its RFC 3339 expiry. `accessToken`
 * is present when a profile could be assumed immediately, and `profiles`
 * lists the profiles the identity may assume, when the platform included
 * them.
 */
export interface VerifyAuthResponse {
  readonly accessToken?: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly profiles?: readonly Profile[];
}

/**
 * Asks for the one-time code to be sent again. The reader fields mean what
 * they mean on {@link StartAuthRequest}.
 */
export interface ResendAuthRequest extends SignInReader {
  readonly email: string;
}

/**
 * Confirms the code was resent. Like {@link StartAuthResponse} it carries a
 * message and nothing else.
 */
export interface ResendAuthResponse {
  readonly message: string;
}

/**
 * Exchanges an access key for an access token. The request presents no
 * token; its proof, signed by the access key itself, is the assertion, and
 * the access token issued is bound to that key.
 */
export interface ExchangeAccessKeyRequest {
  readonly accessKeyId: AccessKeyId;
}

/** The Account an authenticated client acts as. */
export interface CurrentAccountResponse {
  readonly id: AccountId;
  readonly email: string;
  readonly displayName: string;
}
