// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * Sign-in, signup, and the identity exchanges. Starting sign-in is anonymous.
 * Every exchange proves possession of a key the caller holds: verifying a
 * code, redeeming a browser code and exchanging an access key prove the key
 * alone, and the tokens they issue are bound to it; every other exchange
 * presents a refresh token with a proof by the key it is bound to. The
 * service holds no credential of its own, and every token is opaque to it.
 */
import type {
  AuthorizeBrowserRequest,
  AuthorizeBrowserResponse,
  ExchangeBrowserRequest,
} from "../api/auth-browser.js";
import type {
  ExchangeAccessKeyRequest,
  ResendAuthRequest,
  ResendAuthResponse,
  StartAuthRequest,
  StartAuthResponse,
  VerifyAuthRequest,
  VerifyAuthResponse,
} from "../api/auth.js";
import type {
  ListProfilesResponse,
  ProfileTokenRequest,
  ProfileTokenResponse,
} from "../api/auth-profile.js";
import type {
  SignupOffer,
  SignupRequest,
  SignupResponse,
} from "../api/signup.js";
import {
  BROWSER_AUTHORIZE,
  BROWSER_EXCHANGE,
  LOGIN_RESEND,
  LOGIN_START,
  LOGIN_VERIFY,
  LOGOUT,
  SIGNUP,
  SIGNUP_OFFER,
  TOKEN_ACCESS_KEY,
  TOKEN_PROFILE,
  TOKEN_PROFILES,
} from "../internal/apipath.js";
import { signalOption } from "../internal/options.js";
import { Transport } from "../internal/transport.js";
import type { TransportOptions } from "../internal/transport.js";
import type { RequestOptions } from "../request.js";

/** The endpoints sign-in addresses. */
export interface IdentityEndpoints {
  readonly identity: string;
  readonly api: string;
}

/**
 * A refresh token and the key it is bound to. Every exchange that presents
 * it proves possession of `key`.
 */
export interface RefreshPresentation {
  readonly refreshToken: string;
  readonly key: CryptoKeyPair;
}

/** The identity operations, as the reference contract defines them. */
export interface IdentityService {
  startAuth(
    request: StartAuthRequest,
    options?: RequestOptions,
  ): Promise<StartAuthResponse>;
  resendAuth(
    request: ResendAuthRequest,
    options?: RequestOptions,
  ): Promise<ResendAuthResponse>;
  verifyAuth(
    request: VerifyAuthRequest,
    key: CryptoKeyPair,
    options?: RequestOptions,
  ): Promise<VerifyAuthResponse>;
  getProfileAccessToken(
    refresh: RefreshPresentation,
    request: ProfileTokenRequest,
    options?: RequestOptions,
  ): Promise<ProfileTokenResponse>;
  listAssumableProfiles(
    refresh: RefreshPresentation,
    options?: RequestOptions,
  ): Promise<ListProfilesResponse>;
  logout(refresh: RefreshPresentation, options?: RequestOptions): Promise<void>;
  signup(
    refresh: RefreshPresentation,
    request: SignupRequest,
    options?: RequestOptions,
  ): Promise<SignupResponse>;
  getSignupOffer(
    refresh: RefreshPresentation,
    options?: RequestOptions,
  ): Promise<SignupOffer>;
  authorizeBrowser(
    refresh: RefreshPresentation,
    request: AuthorizeBrowserRequest,
    options?: RequestOptions,
  ): Promise<AuthorizeBrowserResponse>;
  exchangeBrowser(
    request: ExchangeBrowserRequest,
    key: CryptoKeyPair,
    options?: RequestOptions,
  ): Promise<ProfileTokenResponse>;
  exchangeAccessKey(
    request: ExchangeAccessKeyRequest,
    key: CryptoKeyPair,
    options?: RequestOptions,
  ): Promise<ProfileTokenResponse>;
}

/**
 * Builds the identity service over `endpoints`. `transportOptions` configure
 * the one transport every operation goes through; it holds no credential
 * source, so nothing but the presentation an exchange is given is ever
 * presented.
 */
export function identityService(
  endpoints: IdentityEndpoints,
  transportOptions: Omit<TransportOptions, "credential">,
): IdentityService {
  const transport = new Transport(transportOptions);
  /**
   * The presentation of a refresh exchange, with the refresh token required;
   * the transport judges both members before anything is sent.
   */
  const presenting = (refresh: RefreshPresentation): RefreshPresentation => {
    if (
      typeof (refresh as unknown) !== "object" ||
      (refresh as unknown) === null
    ) {
      throw new TypeError("refresh credential is required");
    }
    const refreshToken = refresh.refreshToken as string | undefined;
    return { refreshToken: refreshToken ?? "", key: refresh.key };
  };
  return Object.freeze({
    /** Requests a one-time authentication code. Anonymous. */
    async startAuth(request: StartAuthRequest, options: RequestOptions = {}) {
      return await transport.anonymousJson<StartAuthResponse>(
        "POST",
        endpoints.identity,
        LOGIN_START,
        { body: request, ...signalOption(options.signal) },
      );
    },
    /**
     * Requests that the one-time authentication code be sent again. Like
     * `startAuth` it is anonymous, and its response carries no information
     * about whether the address belongs to an Account.
     */
    async resendAuth(request: ResendAuthRequest, options: RequestOptions = {}) {
      return await transport.anonymousJson<ResendAuthResponse>(
        "POST",
        endpoints.identity,
        LOGIN_RESEND,
        { body: request, ...signalOption(options.signal) },
      );
    },
    /**
     * Verifies a one-time code with a proof by `key`, and returns a refresh
     * token bound to it.
     */
    async verifyAuth(
      request: VerifyAuthRequest,
      key: CryptoKeyPair,
      options: RequestOptions = {},
    ) {
      return await transport.exchangeJson<VerifyAuthResponse>(
        "POST",
        endpoints.identity,
        LOGIN_VERIFY,
        { key },
        { body: request, ...signalOption(options.signal) },
      );
    },
    /**
     * Exchanges a refresh token for a profile access token bound to the
     * same key, and rotates the refresh token.
     */
    async getProfileAccessToken(
      refresh: RefreshPresentation,
      request: ProfileTokenRequest,
      options: RequestOptions = {},
    ) {
      return await transport.exchangeJson<ProfileTokenResponse>(
        "POST",
        endpoints.identity,
        TOKEN_PROFILE,
        presenting(refresh),
        { body: request, ...signalOption(options.signal) },
      );
    },
    /** Lists the profiles a refresh token may assume; it is not rotated. */
    async listAssumableProfiles(
      refresh: RefreshPresentation,
      options: RequestOptions = {},
    ) {
      return await transport.exchangeJson<ListProfilesResponse>(
        "GET",
        endpoints.identity,
        TOKEN_PROFILES,
        presenting(refresh),
        signalOption(options.signal),
      );
    },
    /** Ends the sign-in a refresh token belongs to. */
    async logout(refresh: RefreshPresentation, options: RequestOptions = {}) {
      await transport.exchangeJson<undefined>(
        "POST",
        endpoints.identity,
        LOGOUT,
        presenting(refresh),
        { response: "none", ...signalOption(options.signal) },
      );
    },
    /**
     * Creates the first Account for an authenticated identity. Throws a
     * `TypeError` before any request when the terms are not accepted.
     */
    async signup(
      refresh: RefreshPresentation,
      request: SignupRequest,
      options: RequestOptions = {},
    ) {
      if (!request.acceptedTerms) {
        throw new TypeError("terms must be accepted to create an account");
      }
      return await transport.exchangeJson<SignupResponse>(
        "POST",
        endpoints.api,
        SIGNUP,
        presenting(refresh),
        { body: request, ...signalOption(options.signal) },
      );
    },
    /**
     * Reads what an Account created now by the signed-in identity would start
     * with. It reserves nothing: `signup` makes the decision.
     */
    async getSignupOffer(
      refresh: RefreshPresentation,
      options: RequestOptions = {},
    ) {
      return await transport.exchangeJson<SignupOffer>(
        "GET",
        endpoints.api,
        SIGNUP_OFFER,
        presenting(refresh),
        signalOption(options.signal),
      );
    },
    /**
     * Issues a one-time code bound to a browser's S256 PKCE transaction and
     * key, and rotates the refresh token.
     */
    async authorizeBrowser(
      refresh: RefreshPresentation,
      request: AuthorizeBrowserRequest,
      options: RequestOptions = {},
    ) {
      return await transport.exchangeJson<AuthorizeBrowserResponse>(
        "POST",
        endpoints.identity,
        BROWSER_AUTHORIZE,
        presenting(refresh),
        { body: request, ...signalOption(options.signal) },
      );
    },
    /**
     * Redeems a one-time code with a proof by `key`, the browser key the
     * code names, for an access token and a refresh token bound to it.
     */
    async exchangeBrowser(
      request: ExchangeBrowserRequest,
      key: CryptoKeyPair,
      options: RequestOptions = {},
    ) {
      return await transport.exchangeJson<ProfileTokenResponse>(
        "POST",
        endpoints.identity,
        BROWSER_EXCHANGE,
        { key },
        { body: request, ...signalOption(options.signal) },
      );
    },
    /**
     * Exchanges an access key for an access token with a proof by `key`,
     * the access key's own key, to which the token is bound.
     */
    async exchangeAccessKey(
      request: ExchangeAccessKeyRequest,
      key: CryptoKeyPair,
      options: RequestOptions = {},
    ) {
      return await transport.exchangeJson<ProfileTokenResponse>(
        "POST",
        endpoints.identity,
        TOKEN_ACCESS_KEY,
        { key },
        { body: request, ...signalOption(options.signal) },
      );
    },
  });
}
