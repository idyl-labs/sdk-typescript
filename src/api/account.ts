// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The Account's own routes on the global API, at `/v1/accounts/{account}`.
 */

/** What deleting an Account returns. */
export interface DeleteOrgAccountResponse {
  readonly accepted: boolean;
}
