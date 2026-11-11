// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The Account a client's credential acts as, read from the identity API's
 * current-account route, and the Account's own routes on the global API.
 */
import type { DeleteOrgAccountResponse } from "../api/account.js";
import type { CurrentAccountResponse } from "../api/auth.js";
import { account, CURRENT_ACCOUNT } from "../internal/apipath.js";
import type { ServiceState } from "../internal/context.js";
import { signalOption } from "../internal/options.js";
import type { RequestOptions } from "../request.js";
import type { AccountId } from "../resource/id.js";

/**
 * The Account the client's credential acts as. Throws a `TypeError` when
 * the client has no identity endpoint.
 */
export async function getCurrentAccount(
  state: ServiceState,
  options: RequestOptions = {},
): Promise<CurrentAccountResponse> {
  return await state.transport.json<CurrentAccountResponse>(
    "GET",
    requireIdentity(state.endpoints.identity),
    CURRENT_ACCOUNT,
    signalOption(options.signal),
  );
}

/** Deletes `accountId`, as `DELETE /v1/accounts/{account}` on the global API. */
export async function deleteAccount(
  state: ServiceState,
  accountId: AccountId,
  options: RequestOptions = {},
): Promise<DeleteOrgAccountResponse> {
  return await state.transport.json<DeleteOrgAccountResponse>(
    "DELETE",
    state.endpoints.api,
    account(accountId),
    signalOption(options.signal),
  );
}

function requireIdentity(endpoint: string | undefined): string {
  if (endpoint === undefined) {
    throw new TypeError(
      "identity endpoint is required; configure network or endpoints.identity",
    );
  }
  return endpoint;
}
