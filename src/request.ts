// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * What a single call accepts beyond its own arguments. `signal` cancels the
 * call: the credential lookup, the request, and the body read stop, and the
 * call rejects with the signal's reason. Cancelling a call never deletes a
 * resource.
 */
export interface RequestOptions {
  readonly signal?: AbortSignal;
}
