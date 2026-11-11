// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type {
  CreateAccessKeyRequest,
  CreateAccessKeyResponse,
} from "../api/iam.js";
import type { AccessKey } from "../api/iam-entities.js";
import { ACCESS_KEYS, accessKey } from "../internal/apipath.js";
import type { ServiceState } from "../internal/context.js";
import { signalOption } from "../internal/options.js";
import { unwrapCollection, unwrapObject } from "../internal/unwrap.js";
import type { RequestOptions } from "../request.js";
import { parseAccessKeyId } from "../resource/uuid-id.js";

/**
 * Access key operations for the calling person. The keys belong to whoever
 * the client's credential authenticates as, not to an Account path, so
 * every route is the same for every caller. Every `accessKeyId` is judged
 * with `parseAccessKeyId` before any request, so a malformed one throws a
 * `TypeError` and sends nothing.
 */
export interface AccessKeysService {
  /** The calling person's access key records. */
  list(options?: RequestOptions): Promise<readonly AccessKey[]>;
  /** Registers the public key the request names as an access key. */
  create(
    request: CreateAccessKeyRequest,
    options?: RequestOptions,
  ): Promise<AccessKey>;
  /** Revokes one access key. */
  revoke(accessKeyId: string, options?: RequestOptions): Promise<void>;
}

/** Builds the access key service. */
export function accessKeysService(state: ServiceState): AccessKeysService {
  const { transport, endpoints } = state;
  return Object.freeze({
    async list(options: RequestOptions = {}): Promise<readonly AccessKey[]> {
      const response = await transport.json<unknown>(
        "GET",
        endpoints.api,
        ACCESS_KEYS,
        signalOption(options.signal),
      );
      return unwrapCollection(
        response,
        "accessKeys",
        "list access keys",
      ) as readonly AccessKey[];
    },
    async create(
      request: CreateAccessKeyRequest,
      options: RequestOptions = {},
    ): Promise<AccessKey> {
      const response = await transport.json<CreateAccessKeyResponse>(
        "POST",
        endpoints.api,
        ACCESS_KEYS,
        { body: request, ...signalOption(options.signal) },
      );
      return unwrapObject(
        response,
        "accessKey",
        "create access key",
      ) as AccessKey;
    },
    async revoke(
      accessKeyId: string,
      options: RequestOptions = {},
    ): Promise<void> {
      await transport.json<undefined>(
        "DELETE",
        endpoints.api,
        accessKey(parseAccessKeyId(accessKeyId)),
        { response: "none", ...signalOption(options.signal) },
      );
    },
  });
}
