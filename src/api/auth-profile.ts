// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { AccountId, OrganizationId } from "../resource/id.js";
import type { ProfileId } from "../resource/uuid-id.js";

/**
 * Selects the profile a refresh token is exchanged for. The Account is named
 * by `account` (its name, as `org/account`) or by `accountId`, and the
 * profile by `profile` (its name) or by `profileId`; a field left `undefined`
 * is not sent. With nothing set, the platform chooses the identity's default
 * profile.
 */
export interface ProfileTokenRequest {
  readonly account?: string;
  readonly accountId?: AccountId;
  readonly profile?: string;
  readonly profileId?: ProfileId;
}

/**
 * A profile access token and the Account and profile it acts as. The access
 * token is bound to the key whose proof the request carried. `expiresAt` is
 * the token's RFC 3339 expiry. `refreshToken` is the successor of the
 * refresh token the request presented, which is retired, or a new refresh
 * token bound to the browser's key for a browser exchange, with its expiry
 * `refreshExpiresAt`; both are absent when no refresh token was presented
 * or issued. `orgId` and `org` are present when the Account belongs to an
 * organization.
 */
export interface ProfileTokenResponse {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly refreshToken?: string;
  readonly refreshExpiresAt?: string;
  readonly accountId: AccountId;
  readonly accountName: string;
  readonly orgId?: OrganizationId;
  readonly org?: string;
  readonly profileId: ProfileId;
  readonly profileName: string;
}

/** The profiles a refresh token may assume. */
export interface ListProfilesResponse {
  readonly profiles: readonly Profile[];
}

/**
 * A profile the current identity can assume when exchanging a refresh token.
 * `accountEmail` is the Account's contact address; `orgId` and `org` are
 * present when the Account belongs to an organization.
 */
export interface Profile {
  readonly accountId: AccountId;
  readonly accountName: string;
  readonly accountEmail: string;
  readonly orgId?: OrganizationId;
  readonly org?: string;
  readonly profileId: ProfileId;
  readonly profileName: string;
}
