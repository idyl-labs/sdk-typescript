// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The REST paths the SDK addresses.
 *
 * The containment model is expressed once. Account, Namespace, Subnet, and
 * resource segments are assembled here and nowhere else, and every segment
 * interpolated into a path is escaped, so a name carrying a slash, a percent
 * sign, or a question mark addresses the resource it names rather than a
 * different route.
 *
 * The scopes it takes are the public ones. A resource that lives in a Subnet
 * is addressed by its Namespace scope on the API host of the Subnet it lives
 * in, so its paths carry no Subnet segment of their own.
 */
import type { NamespaceScope } from "../api/types.js";

/** The Account path, with `suffix` appended when it is not empty. */
export function account(accountId: string, suffix = ""): string {
  return join(`/v1/accounts/${encodeURIComponent(accountId)}`, suffix);
}

/**
 * The path of one account-scoped resource addressed by name within a
 * collection, such as a Namespace, with `suffix` appended when it is not
 * empty.
 */
export function accountResource(
  accountId: string,
  collection: string,
  name: string,
  suffix = "",
): string {
  return resourceWithin(account(accountId), collection, name, suffix);
}

/**
 * The path of one resource addressed by name within a collection beneath
 * `path`, with `suffix` appended when it is not empty. `path` is already
 * escaped by its builder; `name` is escaped here.
 */
export function resourceWithin(
  path: string,
  collection: string,
  name: string,
  suffix = "",
): string {
  return join(`${path}/${collection}/${encodeURIComponent(name)}`, suffix);
}

/** The path of one Namespace, with `suffix` appended when it is not empty. */
export function namespace(scope: NamespaceScope, suffix = ""): string {
  return join(
    accountResource(scope.accountId, "namespaces", scope.namespace),
    suffix,
  );
}

/** The path of one Namespace-scoped resource. */
export function namespaceResource(
  scope: NamespaceScope,
  collection: string,
  name: string,
): string {
  return namespace(scope, `${collection}/${encodeURIComponent(name)}`);
}

/**
 * The path of one Computer addressed by its stable identifier rather than
 * its name. The `by-id` segment is reserved on the platform, so no Computer
 * name can collide with it.
 */
export function computerById(scope: NamespaceScope, id: string): string {
  return namespace(scope, `computers/by-id/${encodeURIComponent(id)}`);
}

/**
 * The path of the attachments of one Secret, addressed by its stable
 * identifier, across the Computers of a Namespace. The `by-secret` segment
 * is reserved on the platform beside `by-id`, so no Computer name can
 * collide with it.
 */
export function computersBySecret(
  scope: NamespaceScope,
  secretId: string,
): string {
  return namespace(
    scope,
    `computers/by-secret/${encodeURIComponent(secretId)}`,
  );
}

/** The Secret attachment states of the Computer addressed by name. */
export function computerSecrets(scope: NamespaceScope, name: string): string {
  return namespace(scope, `computers/${encodeURIComponent(name)}/secrets`);
}

/**
 * The Secret attachment states of the Computer addressed by its stable
 * identifier.
 */
export function computerSecretsById(scope: NamespaceScope, id: string): string {
  return `${computerById(scope, id)}/secrets`;
}

/**
 * The session collection of the Computer addressed by name, or, with
 * `sessionId`, one session in it.
 */
export function computerSessions(
  scope: NamespaceScope,
  name: string,
  sessionId?: string,
): string {
  return collectionMember(
    namespace(scope, `computers/${encodeURIComponent(name)}/sessions`),
    sessionId,
  );
}

/**
 * The session collection of the Computer addressed by its stable
 * identifier, or, with `sessionId`, one session in it.
 */
export function computerSessionsById(
  scope: NamespaceScope,
  id: string,
  sessionId?: string,
): string {
  return collectionMember(`${computerById(scope, id)}/sessions`, sessionId);
}

/**
 * The journal of the Computer addressed by name, or, with `entryId`, one
 * entry of it.
 */
export function computerJournal(
  scope: NamespaceScope,
  name: string,
  entryId?: string,
): string {
  return collectionMember(
    namespace(scope, `computers/${encodeURIComponent(name)}/journal`),
    entryId,
  );
}

/**
 * The journal of the Computer addressed by its stable identifier, or, with
 * `entryId`, one entry of it.
 */
export function computerJournalById(
  scope: NamespaceScope,
  id: string,
  entryId?: string,
): string {
  return collectionMember(`${computerById(scope, id)}/journal`, entryId);
}

/**
 * The notebooks of the Computer addressed by name, or, with `notebook`, one
 * notebook of it.
 */
export function computerNotebooks(
  scope: NamespaceScope,
  name: string,
  notebook?: string,
): string {
  return collectionMember(
    namespace(scope, `computers/${encodeURIComponent(name)}/notebooks`),
    notebook,
  );
}

/**
 * The notebooks of the Computer addressed by its stable identifier, or,
 * with `notebook`, one notebook of it.
 */
export function computerNotebooksById(
  scope: NamespaceScope,
  id: string,
  notebook?: string,
): string {
  return collectionMember(`${computerById(scope, id)}/notebooks`, notebook);
}

function collectionMember(collection: string, member?: string): string {
  return member === undefined
    ? collection
    : `${collection}/${encodeURIComponent(member)}`;
}

/**
 * The path of one Subnet within an Account, with `suffix` appended when it is
 * not empty.
 */
export function accountSubnet(
  accountId: string,
  subnetSlug: string,
  suffix = "",
): string {
  return join(
    account(accountId, `subnets/${encodeURIComponent(subnetSlug)}`),
    suffix,
  );
}

/** The Account the presented credential acts as, on the identity endpoint. */
export const CURRENT_ACCOUNT = "/account";

/** Account signup, on the API endpoint. */
export const SIGNUP = "/v1/signup";

/** What a new Account would start with, on the API endpoint. */
export const SIGNUP_OFFER = "/v1/signup/offer";

/** Requests a one-time sign-in code, on the identity endpoint. */
export const LOGIN_START = "/login/start";

/** Requests that the one-time sign-in code be sent again. */
export const LOGIN_RESEND = "/login/resend";

/** Verifies a one-time sign-in code. */
export const LOGIN_VERIFY = "/login/verify";

/** Exchanges a refresh token for a profile access token. */
export const TOKEN_PROFILE = "/token/profile";

/** The profiles a refresh token may assume. */
export const TOKEN_PROFILES = "/token/profiles";

/** Ends the sign-in the presented refresh token belongs to. */
export const LOGOUT = "/logout";

/** Exchanges an access key for an access token, on the identity endpoint. */
export const TOKEN_ACCESS_KEY = "/token/access-key";

/** Issues a one-time code bound to a browser's S256 PKCE transaction. */
export const BROWSER_AUTHORIZE = "/browser/authorize";

/** Redeems a browser authorization code. */
export const BROWSER_EXCHANGE = "/browser/exchange";

/** The calling person's access keys, on the API endpoint. */
export const ACCESS_KEYS = "/v1/access-keys";

/** The path of one of the calling person's access keys. */
export function accessKey(accessKeyId: string): string {
  return `${ACCESS_KEYS}/${encodeURIComponent(accessKeyId)}`;
}

/** The network's public metadata, read anonymously from the meta endpoint. */
export const NETWORK_METADATA = "/v1/network";

/** Every size a Computer can run at, read anonymously from the meta endpoint. */
export const COMPUTER_SIZES = "/v1/computer-sizes";

/**
 * Appends a suffix that is already escaped by its caller. An empty suffix
 * leaves the path addressing the scope itself rather than a route beneath it.
 */
function join(path: string, suffix: string): string {
  return suffix === "" ? path : `${path}/${suffix}`;
}

/** One storage child of an already escaped Computer address. */
export function storageChild(
  base: string,
  collection: string,
  member?: string,
  suffix = "",
): string {
  return join(collectionMember(join(base, collection), member), suffix);
}
