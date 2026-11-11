// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The Vault Secrets of one Namespace, on the API that serves the client's
 * Computers. A Secret lives in one Namespace and one Subnet; the Subnet is
 * the one the client's placement resolves, which is the Subnet its
 * Computers live in, so a Secret written here can be attached to them.
 *
 * Every route carries secret material, so a request body is bounded before
 * it is sent and a refusal relays the platform's message only under a
 * Vault code. Every response is redacted: no read returns a value.
 */
import { TransportError } from "../errors.js";
import {
  decodeVaultVersionMetadata,
  encodePurgeVaultResourceRequest,
  encodeRotateVaultSecretRequest,
  isVaultErrorCode,
  MAX_VAULT_MANAGEMENT_REQUEST_BODY_BYTES,
  validateVaultRotateOptions,
  VAULT_HEADER_IDEMPOTENCY_KEY,
  VAULT_HEADER_IF_MATCH,
  type ListVaultSecretsResponse,
  type ListVaultVersionsResponse,
  type PurgeVaultResourceRequest,
  type PurgeVaultResourceResponse,
  type RotateVaultSecretRequest,
  type VaultRotateOptions,
} from "../api/vault.js";
import type { DeleteResponse, ListOptions } from "../api/types.js";
import { namespace, namespaceResource } from "../internal/apipath.js";
import type { PlacementContext } from "../internal/context.js";
import { readList } from "../internal/envelopes.js";
import { listQuery } from "../internal/listquery.js";
import { requireNonBlank, signalOption } from "../internal/options.js";
import {
  resolvePlacement,
  type ResolvedPlacement,
} from "../internal/routing.js";
import type { RequestOptions } from "../request.js";
import {
  decodeRedactedSecret,
  secretShape,
  validateSecret,
  validateSecretSpec,
  validateVaultReferenceName,
  type RedactedSecret,
  type Secret,
} from "../resource/secret.js";

/** The Secrets of the Namespace a client addresses. */
export interface VaultSecretsService {
  /**
   * Validates `secret` and creates it under its name, returning its
   * redacted form. The Namespace and Subnet are the addressed ones: a
   * document that states another is a `TypeError`, and one that states
   * none takes them. Writing the same content again returns the Secret it
   * created; writing other content under a name in use is refused with
   * `VAULT_RESOURCE_VERSION_CONFLICT`. Writing to the name of a Secret
   * deleted within seven days restores that Secret, with its ID.
   */
  put(secret: Secret, options?: RequestOptions): Promise<RedactedSecret>;
  /** The redacted form of the named Secret. */
  get(name: string, options?: RequestOptions): Promise<RedactedSecret>;
  /**
   * One page of the Namespace's Secrets in the addressed Subnet, redacted,
   * in the platform's order by name. `limit` and `offset` page it; a
   * Secret of another Namespace or Subnet in the page is refused with a
   * `TransportError`.
   */
  list(
    options?: ListOptions,
    request?: RequestOptions,
  ): Promise<ListVaultSecretsResponse>;
  /**
   * Appends a version to the named Secret and makes it current, returning
   * the redacted Secret. `spec` is judged as a write, and states the same
   * form as the Secret: a source and an egress, or keyed data. `options`
   * carries the two required headers: the `If-Match` of the resource
   * version the rotation expects, which refuses a stale one with
   * `VAULT_RESOURCE_VERSION_CONFLICT`, and an idempotency key that makes a
   * retry return the version it appended rather than append another.
   * Throws a `TypeError` before any request when either is invalid.
   */
  rotate(
    name: string,
    request: RotateVaultSecretRequest,
    options: VaultRotateOptions,
    call?: RequestOptions,
  ): Promise<RedactedSecret>;
  /**
   * Permanently removes every version of the named Secret. It cannot be
   * restored, and an attachment that names its ID reads
   * `secret_not_found` from then on. `request.confirm` states the explicit
   * confirmation; `force` purges a Secret that live bindings still hold.
   */
  purge(
    name: string,
    request: PurgeVaultResourceRequest,
    options?: RequestOptions,
  ): Promise<PurgeVaultResourceResponse>;
  /**
   * One page of the named Secret's versions, as metadata only. `limit` and
   * `offset` page it.
   */
  listVersions(
    name: string,
    options?: ListOptions,
    request?: RequestOptions,
  ): Promise<ListVaultVersionsResponse>;
  /**
   * Deletes the named Secret. It can be restored for seven days by writing
   * to its name, and the Computers attached to it resume when it is.
   */
  delete(name: string, options?: RequestOptions): Promise<DeleteResponse>;
}

const COLLECTION = "vault/secrets";

/** Builds the Secrets service of the Namespace `context` addresses. */
export function vaultSecretsService(
  context: PlacementContext,
): VaultSecretsService {
  const send = async (
    method: string,
    path: (resolved: ResolvedPlacement) => string,
    request: RequestOptions,
    body?: (resolved: ResolvedPlacement) => unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<{ resolved: ResolvedPlacement; response: unknown }> => {
    const resolved = await resolvePlacement(context, {
      ...signalOption(request.signal),
    });
    const encoded = body?.(resolved);
    const response = await context.state.transport.json<unknown>(
      method,
      resolved.endpoint,
      path(resolved),
      {
        ...(encoded === undefined ? {} : { body: encoded }),
        ...(headers === undefined ? {} : { headers }),
        maxRequestBodyBytes: MAX_VAULT_MANAGEMENT_REQUEST_BODY_BYTES,
        safeErrorCode: isVaultErrorCode,
        ...signalOption(request.signal),
      },
    );
    return { resolved, response };
  };
  /** The path of the named Secret, with `suffix` appended. */
  const secretPath =
    (name: string, suffix = "") =>
    (resolved: ResolvedPlacement): string =>
      namespaceResource(resolved.scope, COLLECTION, name) + suffix;
  const read = async (
    method: string,
    name: string,
    request: RequestOptions,
    body?: (resolved: ResolvedPlacement) => unknown,
    suffix = "",
    headers?: Readonly<Record<string, string>>,
  ): Promise<RedactedSecret> => {
    const { resolved, response } = await send(
      method,
      secretPath(name, suffix),
      request,
      body,
      headers,
    );
    const secret = decodeRedactedSecret(response);
    if (!isAddressed(secret, resolved) || secret.metadata.name !== name) {
      throw new TransportError(
        "invalid_response",
        "secret response names a secret other than the one addressed",
      );
    }
    return secret;
  };
  return {
    async put(secret, options = {}) {
      const name = requireNonBlank(secret.metadata.name, "secret name");
      // The name and the spec are judged before placement is resolved, so
      // a refusal arrives before anything is read or sent.
      validateVaultReferenceName("metadata.name", name);
      validateSecretSpec(secret.spec);
      return await read("PUT", name, options, (resolved) => {
        const stated = secret.metadata;
        if (stated.subnet !== "" && stated.subnet !== resolved.subnet) {
          throw new TypeError(
            "secret subnet does not match resolved placement subnet",
          );
        }
        const namespace = stated.namespace ?? "";
        if (namespace !== "" && namespace !== resolved.scope.namespace) {
          throw new TypeError(
            "secret namespace is not the addressed namespace",
          );
        }
        const document: Secret = {
          ...secret,
          metadata: {
            ...stated,
            namespace: resolved.scope.namespace,
            subnet: resolved.subnet,
          },
        };
        validateSecret(document);
        return secretShape.encode(document);
      });
    },
    async get(name, options = {}) {
      return await read("GET", requireNonBlank(name, "secret name"), options);
    },
    async list(options = {}, request = {}) {
      const query = listQuery(options);
      const { resolved, response } = await send(
        "GET",
        (placed) => namespace(placed.scope, COLLECTION) + query,
        request,
      );
      const page = readList(response, "secrets", decodeRedactedSecret);
      if (!page.items.every((secret) => isAddressed(secret, resolved))) {
        throw new TransportError(
          "invalid_response",
          "secret list names a secret outside the addressed namespace",
        );
      }
      return page;
    },
    async rotate(name, request, options, call = {}) {
      const secretName = requireNonBlank(name, "secret name");
      validateVaultRotateOptions(options);
      validateSecretSpec(request.spec);
      return await read(
        "POST",
        secretName,
        call,
        () => encodeRotateVaultSecretRequest(request),
        ":rotate",
        {
          [VAULT_HEADER_IDEMPOTENCY_KEY]: options.idempotencyKey,
          [VAULT_HEADER_IF_MATCH]: options.ifMatch,
        },
      );
    },
    async purge(name, request, options = {}) {
      const secretName = requireNonBlank(name, "secret name");
      const { response } = await send(
        "POST",
        secretPath(secretName, ":purge"),
        options,
        () => encodePurgeVaultResourceRequest(request),
      );
      const record =
        typeof response === "object" && response !== null
          ? (response as Readonly<Record<string, unknown>>)
          : {};
      const { purgedAt } = record;
      return {
        accepted: record["accepted"] === true,
        ...(typeof purgedAt === "string" ? { purgedAt } : {}),
      };
    },
    async listVersions(name, options = {}, request = {}) {
      const secretName = requireNonBlank(name, "secret name");
      const query = listQuery(options);
      const { response } = await send(
        "GET",
        secretPath(secretName, `/versions${query}`),
        request,
      );
      return readList(response, "secret versions", decodeVaultVersionMetadata);
    },
    async delete(name, options = {}) {
      const { response } = await send(
        "DELETE",
        secretPath(requireNonBlank(name, "secret name")),
        options,
      );
      const record =
        typeof response === "object" && response !== null
          ? (response as Readonly<Record<string, unknown>>)
          : {};
      const { deletedAt } = record;
      return {
        accepted: record["accepted"] === true,
        ...(typeof deletedAt === "string" ? { deletedAt } : {}),
      };
    },
  };
}

/**
 * Whether a served Secret names the addressed Subnet and Namespace; one
 * that states no Namespace is read as the addressed one.
 */
function isAddressed(
  secret: RedactedSecret,
  resolved: ResolvedPlacement,
): boolean {
  return (
    typeof (secret as unknown) === "object" &&
    (secret.metadata as unknown) !== undefined &&
    secret.metadata.subnet === resolved.subnet &&
    (secret.metadata.namespace ?? resolved.scope.namespace) ===
      resolved.scope.namespace
  );
}
