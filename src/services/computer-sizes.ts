// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  decodeListComputerSizesResponse,
  type ListComputerSizesResponse,
} from "../api/computer-size.js";
import { COMPUTER_SIZES } from "../internal/apipath.js";
import type { ServiceState } from "../internal/context.js";
import { requireMeta } from "../internal/endpoints.js";
import { listEnvelope } from "../internal/envelopes.js";
import { signalOption } from "../internal/options.js";
import type { RequestOptions } from "../internal/transport.js";

/**
 * Reads every size a Computer can run at from the network's metadata endpoint,
 * anonymously: no credential is consulted and no Account is needed. The list
 * is returned as served; `validateListComputerSizesResponse` judges it.
 */
export async function listComputerSizes(
  state: ServiceState,
  request: RequestOptions = {},
): Promise<ListComputerSizesResponse> {
  const response = await state.transport.anonymousJson<unknown>(
    "GET",
    requireMeta(state.endpoints.meta),
    COMPUTER_SIZES,
    signalOption(request.signal),
  );
  listEnvelope(response, "computer sizes");
  return decodeListComputerSizesResponse(response);
}
