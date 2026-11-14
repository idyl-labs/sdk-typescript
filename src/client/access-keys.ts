// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { AccessKey as AccessKeyRecord } from "../api/iam-entities.js";
import { TransportError } from "../errors.js";
import type { ServiceState } from "../internal/context.js";
import { coordinate, keyProfile } from "../internal/dpop.js";
import { isUuidId } from "../resource/uuid-id.js";
import { accessKeysService } from "../services/access-keys.js";
import {
  encodeFile,
  fileOf,
  type AccessKeyFile,
  type PrivateJwk,
} from "./access-key-file.js";
import { requireText, signalOf, type CallOptions } from "./common.js";

/**
 * The record of an access key. It never carries the private key, which
 * IDYL never holds: `keyThumbprint` is the RFC 7638 thumbprint of the
 * public key IDYL keeps.
 */
export interface AccessKey {
  /**
   * The key's ID, a lowercase canonical UUID, which {@link AccessKeys.revoke}
   * takes.
   */
  readonly id: string;
  /** The key's name, as it was created. */
  readonly name: string;
  /** What the key is for; absent when it was created without one. */
  readonly description?: string;
  /** The RFC 7638 SHA-256 thumbprint of the key's public half, unpadded base64url. */
  readonly keyThumbprint: string;
  /** When it expires, as an RFC 3339 instant; absent for a key with no expiry. */
  readonly expiresAt?: string;
  /** When it was created, as an RFC 3339 instant. */
  readonly createdAt?: string;
  /** When it was last exchanged for an access token; absent until it has been. */
  readonly lastUsedAt?: string;
  /** When it was revoked; absent for a key in use. */
  readonly revokedAt?: string;
}

/**
 * A newly created access key: its record, and the access key file that
 * holds its private key. `keyFile` is the file's text, returned here and
 * never again: write it where only its owner can read it, and keep it out
 * of logs and source control. `file` is the same file ready for
 * `accessKeyCredentials`, its private key held non-extractable.
 */
export interface CreatedAccessKey {
  /** The key's record, as registered by IDYL. */
  readonly accessKey: AccessKey;
  /** The access key file's text, which holds the private key. */
  readonly keyFile: string;
  /** The same file, parsed, with its private key held non-extractable. */
  readonly file: AccessKeyFile;
}

/** Creates an access key. */
export interface CreateAccessKeyOptions extends CallOptions {
  /** The key's name: 1 to 128 characters. */
  readonly name: string;
  /** What the key is for, shown with its record; none when absent or empty. */
  readonly description?: string;
  /** When the key expires; a key with none never expires. */
  readonly expiresAt?: Date | string;
}

/**
 * The access keys of the person the client's credential authenticates as,
 * for programs and servers. An access key is an Ed25519 key pair whose
 * public half is registered with IDYL; whoever holds its private key
 * exchanges it for short-lived access tokens bound to it, which act as
 * that person, with their permissions, until the key expires or is
 * revoked. Every ID is judged before any request: a malformed one throws a
 * `TypeError` and sends nothing.
 *
 * @example
 * ```ts
 * import { writeFile } from "node:fs/promises";
 *
 * const { accessKey, keyFile } = await idyl.accessKeys.create({
 *   name: "ci",
 *   expiresAt: "2027-01-01T00:00:00Z",
 * });
 * await writeFile("ci.idyl-key", keyFile, { mode: 0o600 });
 * console.log(accessKey.id);
 * ```
 */
export interface AccessKeys {
  /**
   * Creates an access key: generates an Ed25519 key pair with WebCrypto,
   * registers its public half, and returns the record and the key file.
   * The private key never leaves the runtime except in the returned file.
   *
   * @throws {@link TypeError} `name` is blank, `description` is not a
   *   string, `expiresAt` is not a valid instant, or the client was built
   *   from explicit endpoints without a `network`, which the key file names;
   *   nothing is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete, or the
   *   response does not name the key that was registered
   */
  create(options: CreateAccessKeyOptions): Promise<CreatedAccessKey>;
  /**
   * Every access key, without any private key.
   *
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete, or the
   *   response carries no key records
   */
  list(options?: CallOptions): Promise<readonly AccessKey[]>;
  /**
   * Revokes one access key. A revoked key is never exchanged again, and
   * tokens it obtained stop authorizing within the platform's
   * authorization cache lifetime.
   *
   * @param accessKeyId The key's `id`, a lowercase canonical UUID.
   * @throws {@link TypeError} `accessKeyId` is not a lowercase canonical
   *   UUID; nothing is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  revoke(accessKeyId: string, options?: CallOptions): Promise<void>;
}

/** What creating an access key reads from its client. */
export interface AccessKeyHost {
  readonly state: ServiceState;
  /** The client's network domain; absent for a client built from endpoints alone. */
  readonly network: string | undefined;
  /** The Account the client's credential acts as. */
  account(options?: CallOptions): Promise<{ readonly id: string }>;
}

/** Builds the access keys of the person the client's credential authenticates as. */
export function accessKeys(host: AccessKeyHost): AccessKeys {
  const service = accessKeysService(host.state);
  return Object.freeze({
    async create(options: CreateAccessKeyOptions) {
      const { name, description, expiresAt } = options;
      requireText(name, "access key name");
      if (description !== undefined && typeof description !== "string") {
        throw new TypeError("description must be a string");
      }
      const expiry = instant(expiresAt);
      const { network } = host;
      if (network === undefined) {
        throw new TypeError(
          "network is required to create an access key file: the client was built from endpoints alone",
        );
      }
      const account = (await host.account(signalOf(options))).id;
      // The private key is extractable only so it can be written into the
      // file below; the file handed back holds a non-extractable copy.
      const generated = await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"],
      );
      const { jwk, thumbprint } = await keyProfile(generated.publicKey);
      const record = keyOf(
        await service.create(
          {
            name,
            ...(description === undefined || description === ""
              ? {}
              : { description }),
            publicKey: jwk,
            ...(expiry === undefined ? {} : { expiresAt: expiry }),
          },
          signalOf(options),
        ),
      );
      if (record.keyThumbprint !== thumbprint || !isUuidId(record.id)) {
        throw new TransportError(
          "invalid_response",
          "access key response does not name the registered key",
        );
      }
      const exported = await crypto.subtle.exportKey(
        "jwk",
        generated.privateKey,
      );
      const privateKey = privateJwkOf(exported);
      const document = {
        type: "idyl-access-key" as const,
        network,
        accessKeyId: record.id,
        account,
        privateKey,
      };
      return Object.freeze({
        accessKey: record,
        keyFile: encodeFile(document),
        file: await fileOf(document, false),
      });
    },
    async list(options?: CallOptions) {
      const records = await service.list(signalOf(options));
      return Object.freeze(records.map(keyOf));
    },
    async revoke(accessKeyId: string, options?: CallOptions) {
      await service.revoke(accessKeyId, signalOf(options));
    },
  });
}

/** The private members of a generated Ed25519 key's exported JWK. */
function privateJwkOf(exported: JsonWebKey): PrivateJwk {
  const { x, d } = exported;
  if (!coordinate(x) || !coordinate(d)) {
    throw new TypeError("generated key could not be exported");
  }
  return { kty: "OKP", crv: "Ed25519", x, d };
}

/** An expiry as the RFC 3339 instant the contract carries. */
function instant(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (Number.isNaN(time)) {
    throw new TypeError("expiresAt must be a valid instant");
  }
  return new Date(time).toISOString();
}

/** The public view of a served access key record, judged as it is read. */
function keyOf(record: AccessKeyRecord): AccessKey {
  if (
    typeof (record as unknown) !== "object" ||
    (record as unknown) === null ||
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.keyThumbprint !== "string"
  ) {
    throw new TransportError(
      "invalid_response",
      "access key response carries no key record",
    );
  }
  const optional = (key: keyof AccessKeyRecord) => {
    const value = record[key];
    return typeof value === "string" && value !== "" ? { [key]: value } : {};
  };
  return Object.freeze({
    id: record.id,
    name: record.name,
    ...optional("description"),
    keyThumbprint: record.keyThumbprint,
    ...optional("expiresAt"),
    ...optional("createdAt"),
    ...optional("lastUsedAt"),
    ...optional("revokedAt"),
  });
}
