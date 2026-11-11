// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { BillingAllowanceWithheld } from "./billing.js";
import { validateBillingAllowanceWithheld } from "./billing.js";
import {
  always,
  boolean,
  object,
  omitEmpty,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import type { AccountId } from "../resource/id.js";

/**
 * Creates the first Account for an authenticated identity. `acceptedTerms`
 * must be `true`; the SDK refuses to send a request that does not accept
 * them. `displayName` is optional and is not sent when `undefined`.
 */
export interface SignupRequest {
  readonly acceptedTerms: boolean;
  readonly displayName?: string;
}

/**
 * What an Account created now by the signed-in identity would start with. It
 * is a preview, not a promise: the decision is made once, when the Account is
 * created, and nothing is reserved by reading it.
 */
export interface SignupOffer {
  /** Whether the Account would start on a free trial. Always written. */
  readonly trial: boolean;
  /**
   * Why it would not, when the platform withholds one; `trial` is then
   * `false`. `undefined` when a trial is offered or when none is offered to
   * anyone.
   */
  readonly trialWithheld?: BillingAllowanceWithheld;
}

/** The wire shape of a sign-up offer. */
export const signupOfferShape: Shape<SignupOffer> = object<SignupOffer>({
  trial: always(boolean()),
  trialWithheld: omitEmpty(string<BillingAllowanceWithheld>()),
});

/**
 * Judges the offer: a withheld trial has a reason this SDK names and is not
 * offered. Throws a `TypeError`.
 */
export function validateSignupOffer(offer: SignupOffer): void {
  const withheld = offer.trialWithheld;
  if (withheld === undefined) return;
  try {
    validateBillingAllowanceWithheld(withheld);
  } catch (error) {
    throw new TypeError(`trialWithheld: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (offer.trial) {
    throw new TypeError("trial must be false while trialWithheld is set");
  }
}

/** The Account, Namespace, and profile assignment signup created. */
export interface SignupResponse {
  readonly account: SignupAccountInfo;
  readonly namespace: SignupNamespaceInfo;
  readonly profile: SignupProfileInfo;
}

/** The Account created at signup. */
export interface SignupAccountInfo {
  readonly id: AccountId;
  readonly displayName: string;
}

/** The initial Namespace created in the new Account. */
export interface SignupNamespaceInfo {
  readonly id: string;
  readonly name: string;
}

/**
 * The owner profile assigned to the new identity, which it can assume
 * immediately to use the Account.
 */
export interface SignupProfileInfo {
  readonly accountId: AccountId;
  readonly accountName: string;
  readonly profileId: string;
  readonly profileName: string;
}
