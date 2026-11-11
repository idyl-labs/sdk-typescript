// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { BillingAllowanceWithheld } from "../api/billing.js";
import type { ProfileTokenRequest } from "../api/auth-profile.js";
import type { SignInReader } from "../api/auth.js";
import { TransportError } from "../errors.js";
import { parseAccountId } from "../resource/id.js";
import { parseAccessKeyId, parseProfileId } from "../resource/uuid-id.js";
import type { IdentityService } from "../services/identity.js";
import { requireText, signalOf, type CallOptions } from "./common.js";

/**
 * A profile a person can act as: one Account and the permissions the
 * profile grants in it. `orgId` and `org` are present when the Account
 * belongs to an organization.
 */
export interface Profile {
  readonly accountId: string;
  readonly accountName: string;
  /** The Account's contact address. */
  readonly accountEmail: string;
  readonly orgId?: string;
  readonly org?: string;
  readonly profileId: string;
  readonly profileName: string;
}

/**
 * Starts a sign-in or sends another code. `timeZone` and `locale` say how
 * the person signing in reads dates and times, so that IDYL's emails can
 * show them that way: the email carrying the code uses them at once, and a
 * verified sign-in keeps them for later emails. None of the fields is
 * authority: a value the server cannot use is ignored, never refused, and an
 * empty one is not sent. Code running on a server sets them from the
 * person's own browser or device, never from the server's.
 */
export interface SignInOptions extends CallOptions {
  /**
   * An IANA tz database name, such as `Europe/Berlin`, or a fixed offset from
   * UTC, such as `+05:30`.
   */
  readonly timeZone?: string;
  /** A BCP 47 language tag, such as `de-DE`. */
  readonly locale?: string;
  /**
   * The `User-Agent` of the browser asking for the code, set by a server
   * that starts a sign-in on a browser's behalf, so the email can say which
   * browser asked. The server reads a known browser and operating system
   * from it, shows nothing else of it, and does not keep it.
   */
  readonly userAgent?: string;
}

/**
 * A refresh token and the key it is bound to. Every exchange that presents
 * the token proves possession of `key`; the token alone is useless. The
 * exchanges that mint a token, {@link Identity.accessToken} and
 * {@link Identity.authorizeBrowser}, retire the refresh token they present
 * and return its successor, which the holder keeps in its place. A retired
 * token presented again with its key is answered with a fresh successor, so
 * concurrent exchanges by one holder all succeed.
 */
export interface RefreshCredential {
  readonly refreshToken: string;
  readonly key: CryptoKeyPair;
}

/**
 * The result of a verified sign-in code. `refreshToken` is bound to the key
 * the verification proved and is presented with it, as a
 * {@link RefreshCredential}, by every later exchange; `expiresAt` is its
 * RFC 3339 expiry. `profiles` lists the profiles the person can act as,
 * when the platform included them, and `accessToken` is present, bound to
 * the same key, when a default profile could be assumed at once.
 *
 * A refresh token is a long-lived credential. Where it is kept is the
 * application's decision; it is useless without its key, and a browser
 * page keeps that key non-extractable.
 */
export interface SignIn {
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly profiles?: readonly Profile[];
  readonly accessToken?: string;
}

/**
 * Chooses the profile a refresh token is exchanged for. The Account is named
 * by `account` (its name, as `org/account`) or by `accountId`, and the
 * profile by `profile` (its name) or by `profileId`. With nothing set, the
 * platform chooses the person's default profile.
 */
export interface ProfileSelector {
  readonly account?: string;
  readonly accountId?: string;
  readonly profile?: string;
  readonly profileId?: string;
}

/**
 * A short-lived access token for one Account and profile, and what it acts
 * as. It is bound to the key whose proof obtained it: present it with that
 * key as a `Credential`. `expiresAt` is its RFC 3339 expiry.
 *
 * `refreshToken` is present when the exchange rotated or issued one: the
 * successor of the refresh token {@link Identity.accessToken} presented,
 * which replaces it, or the refresh token {@link Identity.exchangeBrowser}
 * issues bound to the browser's key. `refreshExpiresAt` is its expiry. An
 * access key's exchange names no profile, so `profileId` and `profileName`
 * are empty for it.
 */
export interface AccessToken {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly refreshToken?: string;
  readonly refreshExpiresAt?: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly orgId?: string;
  readonly org?: string;
  readonly profileId: string;
  readonly profileName: string;
}

/** Creates the first Account of a signed-in person. */
export interface SignUpRequest {
  /** Must be `true`: the person accepts the terms of service. */
  readonly acceptedTerms: boolean;
  readonly displayName?: string;
}

/**
 * What an Account created now by the signed-in person would start with. The
 * decision is made when the Account is created, and reading this reserves
 * nothing.
 */
export interface SignUpOffer {
  /** Whether the Account would start on a free trial. */
  readonly trial: boolean;
  /**
   * Why it would not, when a trial is withheld: `trial_one_per_person` when
   * the person already has one, or `trials_closed`. `undefined` when a trial
   * is offered or when none is offered to anyone.
   */
  readonly trialWithheld?: BillingAllowanceWithheld;
}

/**
 * What sign-up created: the Account and the owner profile the person can
 * assume at once.
 */
export interface SignUp {
  readonly account: { readonly id: string; readonly displayName: string };
  readonly profile: {
    readonly accountId: string;
    readonly accountName: string;
    readonly profileId: string;
    readonly profileName: string;
  };
}

/**
 * A browser authorization: a registered client, its exact redirect URI, a
 * state value of 32 random bytes encoded as unpadded base64url, the S256
 * PKCE challenge of a verifier the page keeps, and `dpopJkt`, the
 * thumbprint of the page's own key (see `keyThumbprint`). `profile` must
 * name the Account and profile by `accountId` and `profileId`.
 */
export interface BrowserAuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly dpopJkt: string;
  readonly profile: ProfileSelector;
}

/**
 * A short-lived, single-use code, redeemable only with a proof by the key
 * the authorization named, and the successor of the refresh token the
 * authorization presented, which replaces it. `expiresAt` is the code's
 * expiry and `refreshExpiresAt` the successor's.
 */
export interface BrowserAuthorization {
  readonly code: string;
  readonly expiresAt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
}

/** Redeems a browser authorization code with its transaction and verifier. */
export interface BrowserExchangeRequest {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  /** The RFC 7636 verifier whose S256 challenge the authorization carried. */
  readonly codeVerifier: string;
}

/**
 * Sign-in for people and access keys: email codes, sign-up, the profiles a
 * person can act as, access tokens, the browser handoff, access key
 * exchanges and sign-out.
 *
 * Every token IDYL issues is bound to a key its holder keeps. Verifying a
 * code, redeeming a browser code and exchanging an access key prove a key
 * and bind the tokens they issue to it; every other call presents a
 * {@link RefreshCredential} for that one request only. Starting sign-in is
 * anonymous. None of them consults the client's `credential`. No token is
 * kept, inspected or logged, and no message carries one.
 */
export interface Identity {
  /**
   * Sends a six-digit sign-in code to `email`. The answer is the same
   * whether or not the address belongs to anyone. Throws a `TypeError`
   * when `email` is blank.
   */
  startSignIn(email: string, options?: SignInOptions): Promise<void>;
  /** Sends another sign-in code, answering as {@link Identity.startSignIn} does. */
  resendCode(email: string, options?: SignInOptions): Promise<void>;
  /**
   * Verifies a sign-in code with a proof by `key`, the client's key, and
   * returns a refresh token bound to it. Throws a `TypeError` when `email`
   * or `code` is blank or `key` cannot sign; a wrong or expired code
   * rejects with an `ApiError`.
   */
  verifyCode(
    email: string,
    code: string,
    key: CryptoKeyPair,
    options?: CallOptions,
  ): Promise<SignIn>;
  /**
   * Creates the first Account of a signed-in person who has none. Throws a
   * `TypeError` before any request unless the terms are accepted.
   */
  signUp(
    refresh: RefreshCredential,
    request: SignUpRequest,
    options?: CallOptions,
  ): Promise<SignUp>;
  /**
   * Reads what an Account created now by the signed-in person would start
   * with. It reserves nothing: `signUp` makes the decision.
   */
  signUpOffer(
    refresh: RefreshCredential,
    options?: CallOptions,
  ): Promise<SignUpOffer>;
  /** The profiles a refresh token's person can act as; the token is not rotated. */
  profiles(
    refresh: RefreshCredential,
    options?: CallOptions,
  ): Promise<readonly Profile[]>;
  /**
   * Exchanges a refresh token for a short-lived access token for one
   * Account and profile, bound to the same key; with no selector, for the
   * default profile. The refresh token is rotated: the result's
   * `refreshToken` is its successor.
   */
  accessToken(
    refresh: RefreshCredential,
    profile?: ProfileSelector,
    options?: CallOptions,
  ): Promise<AccessToken>;
  /**
   * Issues a single-use code that hands a browser page its own tokens:
   * bound to a registered client, its exact redirect URI, the state, an
   * S256 PKCE challenge and the page's key thumbprint, `dpopJkt`. The page
   * redeems it with {@link Identity.exchangeBrowser} and its key. The
   * refresh token is rotated: the result's `refreshToken` is its successor.
   */
  authorizeBrowser(
    refresh: RefreshCredential,
    request: BrowserAuthorizationRequest,
    options?: CallOptions,
  ): Promise<BrowserAuthorization>;
  /**
   * Redeems a browser authorization code with its verifier and a proof by
   * `key`, the key the authorization named, for an access token and a
   * refresh token in a new sign-in, both bound to `key`.
   */
  exchangeBrowser(
    request: BrowserExchangeRequest,
    key: CryptoKeyPair,
    options?: CallOptions,
  ): Promise<AccessToken>;
  /**
   * Exchanges an access key for an access token. `key` is the access key's
   * key pair: the request's proof, signed by it, is the assertion, and the
   * token is bound to the same key. The token acts as the key's principal
   * in the key's Account and expires within an hour, never after the key
   * does; `accessKeyCredentials` keeps such a token fresh. Throws a
   * `TypeError` when `accessKeyId` is not a canonical UUID.
   */
  exchangeAccessKey(
    accessKeyId: string,
    key: CryptoKeyPair,
    options?: CallOptions,
  ): Promise<AccessToken>;
  /**
   * Ends the sign-in a refresh token belongs to: it and every token rotated
   * from the same sign-in are refused from then on.
   */
  signOut(refresh: RefreshCredential, options?: CallOptions): Promise<void>;
}

/** Builds the sign-in surface over the identity service. */
export function identity(service: () => IdentityService): Identity {
  return Object.freeze({
    async startSignIn(email: string, options?: SignInOptions) {
      await service().startAuth(
        { email: requireText(email, "email"), ...readerOf(options) },
        signalOf(options),
      );
    },
    async resendCode(email: string, options?: SignInOptions) {
      await service().resendAuth(
        { email: requireText(email, "email"), ...readerOf(options) },
        signalOf(options),
      );
    },
    async verifyCode(
      email: string,
      code: string,
      key: CryptoKeyPair,
      options?: CallOptions,
    ) {
      return signInOf(
        await service().verifyAuth(
          {
            email: requireText(email, "email"),
            code: requireText(code, "code"),
          },
          key,
          signalOf(options),
        ),
      );
    },
    async signUp(
      refresh: RefreshCredential,
      request: SignUpRequest,
      options?: CallOptions,
    ) {
      const { acceptedTerms, displayName } = request;
      if ((acceptedTerms as unknown) !== true) {
        throw new TypeError("terms must be accepted to create an account");
      }
      return signUpOf(
        await service().signup(
          refresh,
          {
            acceptedTerms,
            ...(displayName === undefined ? {} : { displayName }),
          },
          signalOf(options),
        ),
      );
    },
    async signUpOffer(refresh: RefreshCredential, options?: CallOptions) {
      const { trial, trialWithheld } = await service().getSignupOffer(
        refresh,
        signalOf(options),
      );
      return Object.freeze({
        trial: (trial as unknown) === true,
        ...(typeof trialWithheld === "string" && trialWithheld !== ""
          ? { trialWithheld }
          : {}),
      });
    },
    async profiles(refresh: RefreshCredential, options?: CallOptions) {
      const { profiles } = await service().listAssumableProfiles(
        refresh,
        signalOf(options),
      );
      const listed: unknown = profiles;
      return Object.freeze(
        (Array.isArray(listed) ? profiles : []).map(profileOf),
      );
    },
    async accessToken(
      refresh: RefreshCredential,
      profile: ProfileSelector = {},
      options?: CallOptions,
    ) {
      return accessTokenOf(
        await service().getProfileAccessToken(
          refresh,
          selector(profile),
          signalOf(options),
        ),
      );
    },
    async authorizeBrowser(
      refresh: RefreshCredential,
      request: BrowserAuthorizationRequest,
      options?: CallOptions,
    ) {
      const { clientId, redirectUri, state, codeChallenge, dpopJkt, profile } =
        request;
      if (!/^[A-Za-z0-9_-]{43}$/u.test(requireText(dpopJkt, "dpopJkt"))) {
        throw new TypeError("dpopJkt must be a SHA-256 key thumbprint");
      }
      const authorized = await service().authorizeBrowser(
        refresh,
        {
          clientId: requireText(clientId, "clientId"),
          redirectUri: requireText(redirectUri, "redirectUri"),
          state: requireText(state, "state"),
          codeChallenge: requireText(codeChallenge, "codeChallenge"),
          dpopJkt,
          profile: selector(profile),
        },
        signalOf(options),
      );
      const label = "browser authorization";
      return Object.freeze({
        code: field(authorized, "code", label),
        expiresAt: field(authorized, "expiresAt", label),
        refreshToken: field(authorized, "refreshToken", label),
        refreshExpiresAt: field(authorized, "refreshExpiresAt", label),
      });
    },
    async exchangeBrowser(
      request: BrowserExchangeRequest,
      key: CryptoKeyPair,
      options?: CallOptions,
    ) {
      const { code, clientId, redirectUri, state, codeVerifier } = request;
      const exchanged = await service().exchangeBrowser(
        {
          code: requireText(code, "code"),
          clientId: requireText(clientId, "clientId"),
          redirectUri: requireText(redirectUri, "redirectUri"),
          state: requireText(state, "state"),
          codeVerifier: requireText(codeVerifier, "codeVerifier"),
        },
        key,
        signalOf(options),
      );
      return accessTokenOf(exchanged);
    },
    async exchangeAccessKey(
      accessKeyId: string,
      key: CryptoKeyPair,
      options?: CallOptions,
    ) {
      return accessTokenOf(
        await service().exchangeAccessKey(
          { accessKeyId: parseAccessKeyId(accessKeyId) },
          key,
          signalOf(options),
        ),
      );
    },
    async signOut(refresh: RefreshCredential, options?: CallOptions) {
      await service().logout(refresh, signalOf(options));
    },
  });
}
/**
 * The declared fields of a profile selector and nothing else, judged as
 * the contract's identifiers before any request.
 */
function selector(profile: ProfileSelector): ProfileTokenRequest {
  const { account, accountId, profile: name, profileId } = profile;
  return {
    ...(account === undefined ? {} : { account }),
    ...(accountId === undefined
      ? {}
      : { accountId: parseAccountId(accountId) }),
    ...(name === undefined ? {} : { profile: name }),
    ...(profileId === undefined
      ? {}
      : { profileId: parseProfileId(profileId) }),
  };
}

/**
 * The reader fields of sign-in options and nothing else: each non-empty
 * string is sent, and an empty or missing one is left out, as the server
 * reads it as not known.
 */
function readerOf(options: SignInOptions | undefined): SignInReader {
  const reader: { timeZone?: string; locale?: string; userAgent?: string } = {};
  for (const key of ["timeZone", "locale", "userAgent"] as const) {
    const value: unknown = options?.[key];
    if (typeof value === "string" && value !== "") reader[key] = value;
  }
  return reader;
}

/**
 * A credential field of a served sign-in record: a non-empty string, or the
 * record is unusable, an `invalid_response` `TransportError` naming only the
 * record and the field. Only fields a caller cannot proceed without are
 * held to this; every other field is read leniently, so a record the
 * platform has acted on is never refused for a display value.
 */
function field(record: unknown, key: string, label: string): string {
  const value = text(record, key);
  if (value === "") {
    throw new TransportError(
      "invalid_response",
      `${label} response has no ${key}`,
    );
  }
  return value;
}

/** A display field of a served record: its string, or empty. */
function text(record: unknown, key: string): string {
  const value =
    typeof record === "object" && record !== null
      ? (record as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" ? value : "";
}

/** An optional string of a served record, carried only when it is one. */
function optional<K extends string>(
  record: unknown,
  key: K,
): Readonly<Partial<Record<K, string>>> {
  const value = text(record, key);
  return (value === "" ? {} : { [key]: value }) as Readonly<
    Partial<Record<K, string>>
  >;
}

function profileOf(record: unknown): Profile {
  return Object.freeze({
    accountId: text(record, "accountId"),
    accountName: text(record, "accountName"),
    accountEmail: text(record, "accountEmail"),
    ...optional(record, "orgId"),
    ...optional(record, "org"),
    profileId: text(record, "profileId"),
    profileName: text(record, "profileName"),
  });
}

function accessTokenOf(record: unknown): AccessToken {
  return Object.freeze({
    accessToken: field(record, "accessToken", "access token"),
    expiresAt: field(record, "expiresAt", "access token"),
    ...optional(record, "refreshToken"),
    ...optional(record, "refreshExpiresAt"),
    accountId: text(record, "accountId"),
    accountName: text(record, "accountName"),
    ...optional(record, "orgId"),
    ...optional(record, "org"),
    profileId: text(record, "profileId"),
    profileName: text(record, "profileName"),
  });
}

function signInOf(record: unknown): SignIn {
  const profiles = (record as { profiles?: unknown } | null)?.profiles;
  return Object.freeze({
    refreshToken: field(record, "refreshToken", "sign-in"),
    expiresAt: field(record, "expiresAt", "sign-in"),
    ...(Array.isArray(profiles)
      ? { profiles: Object.freeze(profiles.map(profileOf)) }
      : {}),
    ...optional(record, "accessToken"),
  });
}

/**
 * The record of a sign-up, read leniently throughout: the Account exists
 * once the platform answered, so nothing in the answer is reason to fail.
 */
function signUpOf(record: unknown): SignUp {
  const parts = (record ?? {}) as Record<string, unknown>;
  const { account, profile } = parts;
  return Object.freeze({
    account: Object.freeze({
      id: text(account, "id"),
      displayName: text(account, "displayName"),
    }),
    profile: Object.freeze({
      accountId: text(profile, "accountId"),
      accountName: text(profile, "accountName"),
      profileId: text(profile, "profileId"),
      profileName: text(profile, "profileName"),
    }),
  });
}
