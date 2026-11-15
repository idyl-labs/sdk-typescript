// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The record of the Vault values opened for one Computer, on the API that
 * serves the client's Computers. The record is read on its own route under
 * the Namespace's vault path, only when asked for; a Computer read, a
 * Computer list and a Computer's wake never carry it.
 */
import {
  decodeVaultDecryption,
  isVaultErrorCode,
  MAX_VAULT_MANAGEMENT_REQUEST_BODY_BYTES,
  type ListVaultDecryptionsResponse,
} from "../api/vault.js";
import type { ListOptions } from "../api/types.js";
import { vaultDecryptionsOfComputer } from "../internal/apipath.js";
import type { PlacementContext } from "../internal/context.js";
import { readList } from "../internal/envelopes.js";
import { listQuery } from "../internal/listquery.js";
import { requireNonBlank, signalOption } from "../internal/options.js";
import { resolvePlacement } from "../internal/routing.js";
import type { RequestOptions } from "../request.js";
import { addressedDecryptions } from "./vault-secrets.js";

/** The decryption records of the Namespace a client addresses. */
export interface VaultDecryptionsService {
  /**
   * One page of the record of every Secret value opened for the Computer
   * with this stable ID, newest first. `limit` and `offset` page it; a
   * record of another Subnet in the page is refused with a
   * `TransportError`.
   */
  listForComputer(
    computerId: string,
    options?: ListOptions,
    request?: RequestOptions,
  ): Promise<ListVaultDecryptionsResponse>;
}

/** Builds the decryption records service of the Namespace `context` addresses. */
export function vaultDecryptionsService(
  context: PlacementContext,
): VaultDecryptionsService {
  return {
    async listForComputer(computerId, options = {}, request = {}) {
      const id = requireNonBlank(computerId, "computer ID");
      const query = listQuery(options);
      const resolved = await resolvePlacement(context, {
        ...signalOption(request.signal),
      });
      const response = await context.state.transport.json<unknown>(
        "GET",
        resolved.endpoint,
        vaultDecryptionsOfComputer(resolved.scope, id) + query,
        {
          maxRequestBodyBytes: MAX_VAULT_MANAGEMENT_REQUEST_BODY_BYTES,
          safeErrorCode: isVaultErrorCode,
          ...signalOption(request.signal),
        },
      );
      return addressedDecryptions(
        readList(response, "decryptions", decodeVaultDecryption),
        resolved,
      );
    },
  };
}
