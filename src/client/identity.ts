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
 * A profile a person can act as: one Account and the permissions the profile
 * grants there. `orgId` and `org` are present when the Account belongs to an
 * organization.
 */
export interface Profile {
  /** The Account's twelve-digit ID. */
  readonly accountId: string;
  /** The Account's name. */
  readonly accountName: string;
  /** The Account's contact address. */
  readonly accountEmail: string;
  /** The organization's twelve-digit ID; absent for an Account outside one. */
  readonly orgId?: string;
  /** The organization's name; absent for an Account outside one. */
  readonly org?: string;
  /** The profile's ID, a lowercase canonical UUID. */
  readonly profileId: string;
  /** The profile's name. */
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
   * browser asked. The server reads a known browser and operating system from
   * it and shows nothing else. The value is not kept.
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
  /** The refresh token, presented as issued and never inspected. */
  readonly refreshToken: string;
  /** The key pair the token is bound to, which signs each exchange's proof. */
  readonly key: CryptoKeyPair;
}

/**
 * The result of a verified sign-in code. `refreshToken` is bound to the key
 * whose proof the verification carried and is presented with it, as a
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
  /** The refresh token, bound to the verifying key. */
  readonly refreshToken: string;
  /** When the refresh token expires, as an RFC 3339 instant. */
  readonly expiresAt: string;
  /** The profiles the person can act as; absent when the platform did not list them. */
  readonly profiles?: readonly Profile[];
  /** An access token for the default profile; absent when none could be assumed at once. */
  readonly accessToken?: string;
}

/**
 * Chooses the profile a refresh token is exchanged for. The Account is named
 * by `account` (its name, as `org/account`) or by `accountId`, and the
 * profile by `profile` (its name) or by `profileId`. With nothing set, the
 * platform chooses the person's default profile.
 */
export interface ProfileSelector {
  /** The Account's name, as `org/account`. */
  readonly account?: string;
  /** The Account's twelve-digit ID. */
  readonly accountId?: string;
  /** The profile's name. */
  readonly profile?: string;
  /** The profile's ID, a lowercase canonical UUID. */
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
 * access key's exchange names no profile, so its `profileId` and `profileName`
 * are empty.
 */
export interface AccessToken {
  /** The access token, bound to the key whose proof obtained the token. */
  readonly accessToken: string;
  /** When the access token expires, as an RFC 3339 instant. */
  readonly expiresAt: string;
  /** The refresh token the exchange rotated or issued; absent when it did neither. */
  readonly refreshToken?: string;
  /**
   * When `refreshToken` expires, as an RFC 3339 instant; absent when
   * `refreshToken` is absent.
   */
  readonly refreshExpiresAt?: string;
  /** The twelve-digit ID of the Account the token acts in. */
  readonly accountId: string;
  /** The name of the Account the token acts in. */
  readonly accountName: string;
  /** The organization's twelve-digit ID; absent for an Account outside one. */
  readonly orgId?: string;
  /** The organization's name; absent for an Account outside one. */
  readonly org?: string;
  /** The profile's ID; empty for an access key's token. */
  readonly profileId: string;
  /** The profile's name; empty for an access key's token. */
  readonly profileName: string;
}

/** Creates the first Account of a signed-in person. */
export interface SignUpRequest {
  /** Must be `true`: the person accepts the terms of service. */
  readonly acceptedTerms: boolean;
  /** The Account's display name; the platform chooses one when absent. */
  readonly displayName?: string;
}

/**
 * What an Account the signed-in person creates would start with. The
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
  /** The Account created: its twelve-digit ID and its display name. */
  readonly account: { readonly id: string; readonly displayName: string };
  /** The owner profile of the Account, which the person can assume. */
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
  /** The registered client's ID. */
  readonly clientId: string;
  /** The redirect URI, exactly as registered by the client. */
  readonly redirectUri: string;
  /** 32 random bytes as unpadded base64url, which the page checks on return. */
  readonly state: string;
  /** The RFC 7636 S256 challenge of the verifier the page keeps. */
  readonly codeChallenge: string;
  /**
   * The RFC 7638 thumbprint of the page's key, as returned by `keyThumbprint`.
   */
  readonly dpopJkt: string;
  /** The Account and profile the page acts as, named by `accountId` and `profileId`. */
  readonly profile: ProfileSelector;
}

/**
 * A short-lived, single-use code, redeemable only with a proof by the key
 * the authorization named, and the successor of the refresh token the
 * authorization presented, which the successor replaces. `expiresAt` is the
 * code's expiry and `refreshExpiresAt` the successor's.
 */
export interface BrowserAuthorization {
  /** The single-use code the page redeems. */
  readonly code: string;
  /** When the code expires, as an RFC 3339 instant. */
  readonly expiresAt: string;
  /** The successor of the refresh token the authorization presented. */
  readonly refreshToken: string;
  /** When the successor expires, as an RFC 3339 instant. */
  readonly refreshExpiresAt: string;
}

/** Redeems a browser authorization code with its transaction and verifier. */
export interface BrowserExchangeRequest {
  /** The code {@link Identity.authorizeBrowser} issued. */
  readonly code: string;
  /** The client ID the authorization named. */
  readonly clientId: string;
  /** The redirect URI the authorization named. */
  readonly redirectUri: string;
  /** The state the authorization named. */
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
 *
 * @example
 * ```ts
 * const key = await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
 *   "sign",
 *   "verify",
 * ]);
 * await idyl.identity.startSignIn("ada@example.com");
 * const { refreshToken } = await idyl.identity.verifyCode(
 *   "ada@example.com",
 *   "123456",
 *   key,
 * );
 * const token = await idyl.identity.accessToken({ refreshToken, key });
 * ```
 */
export interface Identity {
  /**
   * Sends a six-digit sign-in code to `email`. The answer is the same
   * whether or not the address belongs to anyone.
   *
   * @param email The address to send the code to.
   * @throws {@link TypeError} `email` is blank; nothing is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  startSignIn(email: string, options?: SignInOptions): Promise<void>;
  /**
   * Sends another sign-in code, answering as {@link Identity.startSignIn} does.
   *
   * @param email The address the sign-in was started for.
   * @throws {@link TypeError} `email` is blank; nothing is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  resendCode(email: string, options?: SignInOptions): Promise<void>;
  /**
   * Verifies a sign-in code with a proof by `key`, the client's key, and
   * returns a refresh token bound to that key.
   *
   * @param email The address the code was sent to.
   * @param code The six-digit code from the email.
   * @param key The Ed25519 or ECDSA P-256 key pair the tokens are bound to;
   *   its private key may be non-extractable.
   * @throws {@link TypeError} `email` or `code` is blank, or `key` cannot
   *   sign; nothing is sent
   * @throws {@link ApiError} the code is wrong or expired, or IDYL refuses
   *   the request
   * @throws {@link TransportError} the request does not complete, or the
   *   response carries no refresh token or expiry
   */
  verifyCode(
    email: string,
    code: string,
    key: CryptoKeyPair,
    options?: CallOptions,
  ): Promise<SignIn>;
  /**
   * Creates the first Account of a signed-in person who has none.
   *
   * @param refresh The person's refresh token and its key.
   * @param request The acceptance of the terms and the Account's name.
   * @throws {@link TypeError} `acceptedTerms` is not `true`, or the refresh
   *   credential cannot be presented; nothing is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  signUp(
    refresh: RefreshCredential,
    request: SignUpRequest,
    options?: CallOptions,
  ): Promise<SignUp>;
  /**
   * Reads what an Account the signed-in person creates would start with.
   * It reserves nothing: `signUp` makes the decision.
   *
   * @param refresh The person's refresh token and its key.
   * @throws {@link TypeError} the refresh credential is missing, its token is
   *   empty or its key cannot sign; nothing is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  signUpOffer(
    refresh: RefreshCredential,
    options?: CallOptions,
  ): Promise<SignUpOffer>;
  /**
   * The profiles a refresh token's person can act as; the token is not
   * rotated.
   *
   * @param refresh The person's refresh token and its key.
   * @throws {@link TypeError} the refresh credential is missing, its token is
   *   empty or its key cannot sign; nothing is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  profiles(
    refresh: RefreshCredential,
    options?: CallOptions,
  ): Promise<readonly Profile[]>;
  /**
   * Exchanges a refresh token for a short-lived access token for one
   * Account and profile, bound to the same key; with no selector, for the
   * default profile. The refresh token is rotated: the result's
   * `refreshToken` is its successor.
   *
   * @param refresh The person's refresh token and its key.
   * @param profile The Account and profile to act as; the default profile
   *   when absent.
   * @throws {@link TypeError} `accountId` or `profileId` is malformed, or the
   *   refresh credential cannot be presented; nothing is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete, or the
   *   response carries no access token or expiry
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
   *
   * @param refresh The person's refresh token and its key.
   * @param request The page's client, transaction and key thumbprint.
   * @throws {@link TypeError} a field of `request` is blank, `dpopJkt` is not
   *   a SHA-256 key thumbprint, a profile ID is malformed, or the refresh
   *   credential cannot be presented; nothing is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete, or the
   *   response lacks the code, the successor or an expiry
   */
  authorizeBrowser(
    refresh: RefreshCredential,
    request: BrowserAuthorizationRequest,
    options?: CallOptions,
  ): Promise<BrowserAuthorization>;
  /**
   * Redeems a browser authorization code with its verifier and a proof by
   * `key`, the key the authorization named, for an access token and a
   * refresh token of a sign-in of the page's own, both bound to `key`.
   *
   * @param request The code, the transaction it was issued for, and the
   *   verifier.
   * @param key The page's key pair, whose thumbprint the authorization named.
   * @throws {@link TypeError} a field of `request` is blank, or `key` cannot
   *   sign; nothing is sent
   * @throws {@link ApiError} IDYL refuses the code, such as one already
   *   redeemed or expired
   * @throws {@link TransportError} the request does not complete, or the
   *   response carries no access token or expiry
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
   * does; `accessKeyCredentials` keeps such a token fresh.
   *
   * @param accessKeyId The access key's ID, a lowercase canonical UUID.
   * @param key The access key's key pair.
   * @throws {@link TypeError} `accessKeyId` is not a lowercase canonical UUID,
   *   or `key` cannot sign; nothing is sent
   * @throws {@link ApiError} IDYL refuses the exchange, such as for a revoked
   *   or expired key
   * @throws {@link TransportError} the request does not complete, or the
   *   response carries no access token or expiry
   */
  exchangeAccessKey(
    accessKeyId: string,
    key: CryptoKeyPair,
    options?: CallOptions,
  ): Promise<AccessToken>;
  /**
   * Ends the sign-in a refresh token belongs to: it and every token rotated
   * from the same sign-in are refused from then on.
   *
   * @param refresh The refresh token of the sign-in to end, and its key.
   * @throws {@link TypeError} the refresh credential is missing, its token is
   *   empty or its key cannot sign; nothing is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
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
