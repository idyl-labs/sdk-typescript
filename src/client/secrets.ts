// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The Secrets a Computer can attach: each holds one value that IDYL adds to
 * the Computer's requests to the origins the Secret allows, so the value
 * never enters the Computer. A Namespace can also hold keyed Secrets, which
 * a Pod mounts as files; every read reports them too, and a Computer cannot
 * use one. The public types are built from the redacted document field by
 * field; no read carries a value.
 */
import type {
  ComputerSecretAttachmentStatus,
  ComputerSecretUse as ServedComputerSecretUse,
} from "../api/computer-secrets.js";
import {
  formatVaultResourceVersionETag,
  validateVaultRotateOptions,
  VAULT_PURGE_CONFIRMATION,
  type VaultVersionMetadata,
} from "../api/vault.js";
import { TransportError } from "../errors.js";
import type { PlacementContext } from "../internal/context.js";
import {
  validateRedactedSecret,
  validateSecretSpec,
  validateVaultReferenceName,
  type RedactedSecret,
  type SecretSource as SecretSourceDocument,
  type SecretEgressCredential as RedactedSecretCredential,
  type SecretKeyMetadata,
  type SecretSpec,
} from "../resource/secret.js";
import { parseTimestamp } from "../resource/shapes.js";
import { errorMessage } from "../resource/validation.js";
import { vaultSecretsService } from "../services/vault-secrets.js";
import {
  offsetContinue,
  offsetOf,
  pageOf,
  requireLimit,
  requireText,
  signalOf,
  walk,
  type CallOptions,
  type ListOptions,
  type Page,
  type PageOptions,
} from "./common.js";
import { numberOf } from "./records.js";

/**
 * The place in a request a Secret's value fills. A placeholder anywhere
 * else in a request is sent as written.
 *
 * - `basic-password` is the password of HTTP Basic authentication, filled
 *   when the whole password is the placeholder; the user name is sent as
 *   written.
 * - `header` is the header `header` names, such as `PRIVATE-TOKEN`, filled
 *   when its whole value is the placeholder.
 * - `authorization-token` is the token of an `Authorization` header in the
 *   scheme `scheme` names: `Bearer`, as most API clients send an API key or
 *   an access token, or `token`, as the GitHub CLI sends a GitHub token. It
 *   is filled when the request carries exactly one `Authorization` header
 *   whose value is the scheme, compared without regard to case, then one or
 *   more spaces, then a token that is wholly the placeholder. A request with
 *   two `Authorization` headers, another scheme, or the placeholder inside
 *   a longer token is sent as written.
 */
export type SecretCredential =
  | { readonly type: "basic-password" }
  | { readonly type: "header"; readonly header: string }
  | {
      readonly type: "authorization-token";
      readonly scheme: "Bearer" | "token";
    };

/**
 * Where a Secret's value comes from, as a read reports it: a stored `value`
 * of `sizeBytes` bytes, with the `expiresAt` its writer stated; a
 * `github-app` installation whose tokens IDYL mints; or, for a keyed Secret
 * that a Pod mounts as files, its `keys`. No read carries a value or the
 * App's private key.
 */
export type SecretSource =
  | {
      readonly type: "value";
      readonly sizeBytes: number;
      readonly expiresAt?: string;
    }
  | {
      readonly type: "github-app";
      readonly appId: number;
      readonly installationId: number;
    }
  | {
      readonly type: "keys";
      readonly keys: readonly SecretKey[];
    };

/** One key of a keyed Secret, without its value. */
export interface SecretKey {
  /** The key's name, which is the file name a Pod mounts it as. */
  readonly name: string;
  /** The length of the key's value, in bytes. */
  readonly sizeBytes: number;
}

/** A Secret, as every read reports it. */
export interface Secret {
  /** The Secret's ID, a canonical UUID; a Computer's attachment holds it. */
  readonly id: string;
  readonly name: string;
  /** The Namespace the Secret lives in. */
  readonly namespace: string;
  /**
   * The HTTPS origins that receive the value, as they were written. Empty
   * for a keyed Secret, whose values go to no origin.
   */
  readonly origins: readonly string[];
  /**
   * The place in a request the value fills. Absent for a keyed Secret, which
   * a Computer cannot use.
   */
  readonly credential?: SecretCredential;
  readonly source: SecretSource;
  /** The current version, from 1; an attachment can pin one. */
  readonly version: number;
  /**
   * The Secret's resource version, from 1, which every change advances. A
   * rotation states the one it expects, and is refused if the Secret has
   * changed since.
   */
  readonly resourceVersion: number;
  /**
   * `active`, or `tombstone` once deleted. A state this package does not
   * name is carried as IDYL reported it.
   */
  readonly state: string;
  /**
   * `healthy`; `expiring` within seven days of the value's expiry; `expired`;
   * or `source_failed` when a GitHub App's last token mint failed. Absent
   * when IDYL reports none.
   */
  readonly health?: string;
  /** When it was created, as an RFC 3339 instant. */
  readonly createdAt?: string;
  /** When it last changed, as an RFC 3339 instant. */
  readonly updatedAt?: string;
}

/**
 * What a version of a Secret holds: exactly one source, `value` or
 * `githubApp`, the `origins` that receive its value, and the `credential`
 * the value fills.
 */
export interface SecretContentOptions extends CallOptions {
  /**
   * A value to store: printable ASCII, at most 8 KiB, with no line break.
   * It is write-only: no read returns it, and it never enters a Computer.
   */
  readonly value?: string;
  /**
   * When the stored value stops being valid, as an RFC 3339 instant. The
   * Secret's health turns to `expiring` seven days before it, and a value
   * past it is never sent. Only with `value`.
   */
  readonly expiresAt?: string;
  /**
   * A GitHub App installation whose installation tokens IDYL mints as the
   * value, each lasting one hour. `privateKey` is a private key of the App
   * in the PEM form GitHub downloads; it is write-only and stays in IDYL.
   */
  readonly githubApp?: {
    readonly appId: number;
    readonly installationId: number;
    readonly privateKey: string;
  };
  /**
   * The HTTPS origins that receive the value, 1 to 16, each
   * `https://<host>`, such as `https://api.example.com`, on port 443: an
   * origin may write `:443`, and any other port is refused with `origin must
   * use port 443`, because the value is added only to requests on port 443.
   * A wildcard is the whole leftmost label, `https://*.example.com`, and
   * covers every name below it. The value goes to no other origin, and each
   * origin can read it, so name only the API hosts that need it.
   */
  readonly origins: readonly string[];
  readonly credential: SecretCredential;
}

/** Creates a Secret, with the content of its first version. */
export interface CreateSecretOptions extends SecretContentOptions {
  /**
   * The Secret's name, unique within the Namespace: 1 to 63 lowercase
   * letters, digits, `.`, `_` and `-`, beginning and ending with a letter
   * or a digit.
   */
  readonly name: string;
}

/**
 * Rotates a Secret: the content of its new version, which states a source
 * and an egress as the Secret does, and the two guards every rotation
 * carries.
 */
export interface RotateSecretOptions extends SecretContentOptions {
  /**
   * The {@link Secret.resourceVersion} the rotation expects, from a read of
   * the Secret. A Secret that has changed since is not rotated, and the
   * call rejects with an `ApiError` whose code is
   * `VAULT_RESOURCE_VERSION_CONFLICT`.
   */
  readonly resourceVersion: number;
  /**
   * A key you choose, unique to this one intended rotation, such as a UUID.
   * Retrying with the same key returns the version the first attempt
   * appended rather than appending another, so a rotation whose outcome is
   * unknown can be retried safely. It has no surrounding whitespace and no
   * line break.
   */
  readonly idempotencyKey: string;
}

/**
 * Purges a Secret. A purge cannot be undone, so it states its confirmation
 * explicitly.
 */
export interface PurgeSecretOptions extends CallOptions {
  /** The confirmation: always the word `purge`. */
  readonly confirm: "purge";
  /**
   * Purges a Secret that Pods still hold. Without it, such a purge is
   * refused with an `ApiError` whose code is `VAULT_ACTIVE_BINDINGS`.
   */
  readonly force?: boolean;
}

/** The outcome of a purge. */
export interface SecretPurge {
  /** Whether IDYL accepted the purge. */
  readonly accepted: boolean;
  /** When the purge completed, as an RFC 3339 instant; absent until it has. */
  readonly purgedAt?: string;
}

/** Selects the versions of a Secret a read returns. */
export interface SecretVersionsOptions extends CallOptions {
  /**
   * The most versions to return, newest first. `undefined` takes the
   * platform's default. Must be a positive integer.
   */
  readonly limit?: number;
}

/** One stored version of a Secret. No version carries its value. */
export interface SecretVersion {
  /** The version number, from 1. */
  readonly version: number;
  /** Whether it is the Secret's current version. */
  readonly current: boolean;
  /** When it was written, as an RFC 3339 instant. */
  readonly createdAt?: string;
}

/**
 * The Namespace's Secrets. A Secret lives where the client's Computers
 * live, and a Computer attaches it by name or ID through its `secrets`
 * setting. Writing a Secret, and reading one, needs the permission to do so
 * on the Namespace; a refusal rejects with an `ApiError` that carries
 * IDYL's stable code, such as `VAULT_POLICY_DISABLED` where Secrets are not
 * enabled.
 */
export interface Secrets {
  /**
   * Creates a Secret and returns it as a read reports it. Creating the same
   * Secret again returns it; other content under a name in use is refused
   * with `VAULT_RESOURCE_VERSION_CONFLICT`. Creating a Secret under the name
   * of one deleted within seven days restores that Secret, with its ID, and
   * the Computers attached to it resume. Throws a `TypeError` naming the
   * field before any request when an option is invalid; no message ever
   * contains the value or the key.
   */
  create(options: CreateSecretOptions): Promise<Secret>;
  /**
   * The Secret with this name. A name the Namespace does not hold rejects
   * with an `ApiError` whose status is 404.
   */
  get(name: string, options?: CallOptions): Promise<Secret>;
  /**
   * Every Secret of the Namespace, by name, page by page. No item carries a
   * value.
   */
  list(options?: ListOptions): AsyncIterable<Secret>;
  /** One page of the Namespace's Secrets, by name. */
  listPage(options?: PageOptions): Promise<Page<Secret>>;
  /**
   * Writes a new version of the Secret with this name and makes it current,
   * returning the Secret. The new version states a source and an egress as
   * the first did; the origins and the credential may change with it.
   * Attachments that follow the current version send the new value from
   * their next request; an attachment pinned to a version keeps its
   * version. A Secret whose source is a GitHub App mints its own tokens and
   * keeps no versions to pin.
   *
   * The rotation is conditioned on `resourceVersion` and made safe to retry
   * by `idempotencyKey`. Throws a `TypeError` naming the field before any
   * request when an option is invalid; no message ever contains the value
   * or the key.
   */
  rotate(name: string, options: RotateSecretOptions): Promise<Secret>;
  /**
   * Removes the Secret with this name and every version of it, permanently.
   * Unlike `delete`, it cannot be restored, and creating a Secret of its
   * name later creates another Secret with another ID; attachments that
   * named the purged Secret read `secret_not_found`. `confirm` must be
   * `purge`; any other value is refused with a `TypeError` before any
   * request.
   */
  purge(name: string, options: PurgeSecretOptions): Promise<SecretPurge>;
  /**
   * The stored versions of the Secret with this name, newest first: the
   * newest `limit` of them, or the platform's default count when `limit`
   * is absent. The current version is the first.
   */
  versions(
    name: string,
    options?: SecretVersionsOptions,
  ): Promise<readonly SecretVersion[]>;
  /**
   * Deletes the Secret with this name. For seven days, creating a Secret of
   * its name restores it, with its ID. To stop one Computer using a Secret,
   * detach it from that Computer instead.
   */
  delete(name: string, options?: CallOptions): Promise<void>;
}

/** Builds the Secrets of the Namespace the client's context addresses. */
export function secrets(
  context: (options?: CallOptions) => Promise<PlacementContext>,
): Secrets {
  const service = async (options: CallOptions | undefined) =>
    vaultSecretsService(await context(signalOf(options)));
  const listPage = async (options: PageOptions = {}): Promise<Page<Secret>> => {
    const limit = requireLimit(options.limit);
    const offset = offsetOf(options.continue) ?? 0;
    const page = await (
      await service(options)
    ).list(
      {
        ...(limit === undefined ? {} : { limit }),
        ...(offset === 0 ? {} : { offset }),
      },
      signalOf(options),
    );
    return pageOf(
      page.items.map(secretOf),
      offsetContinue(offset, page.items.length, page.totalCount),
    );
  };
  return Object.freeze({
    async create(options: CreateSecretOptions) {
      const name = requireText(options.name, "secret name");
      const document = {
        kind: "Secret",
        metadata: { name, subnet: "" },
        spec: specOf(options),
      };
      // Judged before the client's context is read, so a refusal arrives
      // before anything is sent.
      validateVaultReferenceName("metadata.name", name);
      validateSecretSpec(document.spec);
      const served = await (
        await service(options)
      ).put(document, signalOf(options));
      return secretOf(served);
    },
    list: (options: ListOptions = {}) => walk(listPage, options),
    listPage,
    async rotate(name: string, options: RotateSecretOptions) {
      const secretName = requireText(name, "secret name");
      const spec = specOf(options);
      const guards = {
        idempotencyKey: idempotencyKeyOf(options.idempotencyKey),
        ifMatch: formatVaultResourceVersionETag(
          positive(options.resourceVersion, "resourceVersion"),
        ),
      };
      // Judged before the client's context is read, so a refusal arrives
      // before anything is sent.
      validateSecretSpec(spec);
      validateVaultRotateOptions(guards);
      const served = await (
        await service(options)
      ).rotate(secretName, { spec }, guards, signalOf(options));
      return secretOf(served);
    },
    async purge(name: string, options: PurgeSecretOptions) {
      const secretName = requireText(name, "secret name");
      if ((options.confirm as unknown) !== VAULT_PURGE_CONFIRMATION) {
        throw new TypeError('confirm must be "purge"');
      }
      if (
        options.force !== undefined &&
        typeof (options.force as unknown) !== "boolean"
      ) {
        throw new TypeError("force must be a boolean");
      }
      const outcome = await (
        await service(options)
      ).purge(
        secretName,
        {
          confirm: VAULT_PURGE_CONFIRMATION,
          ...(options.force === true ? { force: true } : {}),
        },
        signalOf(options),
      );
      return Object.freeze({
        accepted: outcome.accepted,
        ...(outcome.purgedAt === undefined
          ? {}
          : { purgedAt: outcome.purgedAt }),
      });
    },
    async versions(name: string, options: SecretVersionsOptions = {}) {
      const secretName = requireText(name, "secret name");
      const limit = requireLimit(options.limit);
      const { items } = await (
        await service(options)
      ).listVersions(
        secretName,
        limit === undefined ? {} : { limit },
        signalOf(options),
      );
      return Object.freeze(items.map(versionOf));
    },
    async get(name: string, options: CallOptions = {}) {
      const secretName = requireText(name, "secret name");
      const served = await (
        await service(options)
      ).get(secretName, signalOf(options));
      return secretOf(served);
    },
    async delete(name: string, options: CallOptions = {}) {
      const secretName = requireText(name, "secret name");
      await (await service(options)).delete(secretName, signalOf(options));
    },
  });
}

/** The spec of a Secret version a create or a rotation states. */
function specOf(options: SecretContentOptions): SecretSpec {
  return {
    source: sourceOf(options),
    egress: {
      origins: originsOf(options.origins),
      credential: credentialOf(options.credential),
    },
  };
}

/** Judges an idempotency key before it becomes a header. */
function idempotencyKeyOf(key: unknown): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new TypeError("idempotencyKey is required");
  }
  if (key.trim() !== key || /[\r\n]/u.test(key)) {
    throw new TypeError(
      "idempotencyKey must have no surrounding whitespace and no line break",
    );
  }
  return key;
}

function sourceOf(options: SecretContentOptions): SecretSourceDocument {
  const { value, expiresAt, githubApp } = options;
  if ((value === undefined) === (githubApp === undefined)) {
    throw new TypeError("state exactly one of value and githubApp");
  }
  if (githubApp !== undefined) {
    if (expiresAt !== undefined) {
      throw new TypeError("expiresAt is stated only with value");
    }
    if (
      typeof (githubApp as unknown) !== "object" ||
      (githubApp as unknown) === null
    ) {
      throw new TypeError("githubApp must be an object");
    }
    if (typeof (githubApp.privateKey as unknown) !== "string") {
      throw new TypeError("githubApp.privateKey must be a string");
    }
    return {
      githubApp: {
        appId: positive(githubApp.appId, "githubApp.appId"),
        installationId: positive(
          githubApp.installationId,
          "githubApp.installationId",
        ),
        privateKey: githubApp.privateKey,
      },
    };
  }
  if (typeof value !== "string") {
    throw new TypeError("value must be a string");
  }
  if (expiresAt === undefined) return { value };
  try {
    return { value, expiresAt: parseTimestamp(expiresAt) };
  } catch (cause) {
    throw new TypeError(`expiresAt: ${errorMessage(cause)}`, { cause });
  }
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function originsOf(origins: unknown): string[] {
  if (!Array.isArray(origins)) {
    throw new TypeError("origins must be an array of origins");
  }
  return origins.map((origin: unknown, index) => {
    if (typeof origin !== "string") {
      throw new TypeError(`origins[${String(index)}] must be a string`);
    }
    return origin;
  });
}

function credentialOf(credential: unknown): SecretCredential {
  if (typeof credential !== "object" || credential === null) {
    throw new TypeError(
      'credential must be { type: "basic-password" }, { type: "header", header } or { type: "authorization-token", scheme }',
    );
  }
  const { type, header, scheme } = credential as {
    readonly type?: unknown;
    readonly header?: unknown;
    readonly scheme?: unknown;
  };
  if (typeof type !== "string") {
    throw new TypeError("credential.type must be a string");
  }
  if (header !== undefined && typeof header !== "string") {
    throw new TypeError("credential.header must be a string");
  }
  if (scheme !== undefined && typeof scheme !== "string") {
    throw new TypeError("credential.scheme must be a string");
  }
  // Only the fields the contract names are sent. A type this package does
  // not name, a scheme it does not name, or a field where none belongs, is
  // carried for the contract's validator to refuse with its own sentence.
  return {
    type,
    ...(header === undefined ? {} : { header }),
    ...(scheme === undefined ? {} : { scheme }),
  } as SecretCredential;
}

/** The public view of a served Secret, judged as it is read. */
function secretOf(served: RedactedSecret): Secret {
  try {
    validateRedactedSecret(served);
  } catch (cause) {
    throw new TransportError(
      "invalid_response",
      `secret response is not a valid secret: ${errorMessage(cause)}`,
      { cause },
    );
  }
  const { metadata, spec, status } = served;
  const { source, egress } = spec;
  if (metadata.id === undefined) {
    throw new TransportError("invalid_response", "secret response names no ID");
  }
  // The validator admits a source exactly with an egress, and keys exactly
  // without either, so a Secret with no source is a keyed one.
  return Object.freeze({
    id: metadata.id,
    name: metadata.name,
    namespace: metadata.namespace ?? "",
    origins: Object.freeze([...(egress?.origins ?? [])]),
    ...(egress === undefined
      ? {}
      : { credential: credentialInfoOf(egress.credential) }),
    source:
      source === undefined ? keysInfoOf(spec.keys ?? []) : sourceInfoOf(source),
    version: numberOf(spec.currentVersion),
    resourceVersion: numberOf(status.resourceVersion),
    state: status.state,
    ...(status.health === undefined || status.health === ""
      ? {}
      : { health: status.health }),
    ...(metadata.createdAt === undefined
      ? {}
      : { createdAt: metadata.createdAt }),
    ...(metadata.updatedAt === undefined
      ? {}
      : { updatedAt: metadata.updatedAt }),
  });
}

function sourceInfoOf(
  source: NonNullable<RedactedSecret["spec"]["source"]>,
): SecretSource {
  if (source.githubApp !== undefined) {
    return Object.freeze({
      type: "github-app",
      appId: numberOf(source.githubApp.appId),
      installationId: numberOf(source.githubApp.installationId),
    });
  }
  const value = source.value ?? { sizeBytes: 0 };
  return Object.freeze({
    type: "value",
    sizeBytes: numberOf(value.sizeBytes),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
  });
}

/** The public view of a keyed Secret's keys. */
function keysInfoOf(keys: readonly SecretKeyMetadata[]): SecretSource {
  return Object.freeze({
    type: "keys",
    keys: Object.freeze(
      keys.map((key) =>
        Object.freeze({
          name: key.name,
          sizeBytes: numberOf(key.sizeBytes ?? 0),
        }),
      ),
    ),
  });
}

/** The public view of a served credential, which the read has judged. */
function credentialInfoOf(
  credential: RedactedSecretCredential,
): SecretCredential {
  switch (credential.type) {
    case "header":
      return Object.freeze({
        type: "header",
        header: credential.header ?? "",
      });
    case "authorization-token":
      return Object.freeze({
        type: "authorization-token",
        scheme: credential.scheme === "token" ? "token" : "Bearer",
      });
    default:
      return Object.freeze({ type: "basic-password" });
  }
}

/** The public view of one served version. */
function versionOf(version: VaultVersionMetadata): SecretVersion {
  return Object.freeze({
    version: numberOf(version.version),
    current: version.current,
    ...(version.createdAt === undefined
      ? {}
      : { createdAt: version.createdAt }),
  });
}

/**
 * The state of one Secret attachment of a Computer, judged against the
 * version the attachment uses: its current version, or the one it is
 * pinned to.
 */
export interface SecretAttachmentStatus {
  /** The environment variable that holds the placeholder. */
  readonly env: string;
  /** The ID of the attached Secret. */
  readonly secret: string;
  /**
   * `healthy`; `expiring`, within seven days of the value's expiry; or
   * `broken`, when the value is not sent. A health this package does not
   * name is carried as IDYL reported it.
   */
  readonly health: string;
  /**
   * Why the health is not `healthy`: `expiring` with that health, and with
   * `broken` one of `secret_deleted` (deleted; creating a Secret of its
   * name within seven days restores it), `secret_not_found` (no Secret has
   * the ID), `not_attached` (it came with a fork's or a restore's settings
   * and was never attached to this Computer; attaching it again sends it),
   * `no_egress`, `expired` or `source_failed`. Absent when healthy.
   */
  readonly reason?: string;
  /**
   * When the value the attachment sends stops being valid, as an RFC 3339
   * instant; absent while none is known.
   */
  readonly expiresAt?: string;
}

/**
 * One attachment of a Secret in one Computer's settings, as
 * `computers.listBySecret` reads it.
 */
export interface ComputerSecretUse {
  /** The ID of the Computer that holds the attachment. */
  readonly computer: string;
  /** The Computer's name. */
  readonly computerName: string;
  /** The environment variable that holds the placeholder. */
  readonly env: string;
  /**
   * Whether the attachment was attached to this Computer by someone allowed
   * to use the Secret. An attachment that came with a fork's or a restore's
   * settings and was never attached here is `false`: its value is not sent
   * until it is attached here.
   */
  readonly attached: boolean;
  /**
   * The version the attachment is pinned to; absent when it follows the
   * Secret's current version, so a rotation reaches it.
   */
  readonly version?: number;
}

/** The public view of one served attachment state. */
export function secretAttachmentStatusOf(
  status: ComputerSecretAttachmentStatus,
): SecretAttachmentStatus {
  return Object.freeze({
    env: status.env,
    secret: status.secret,
    health: status.health,
    ...(status.reason === undefined ? {} : { reason: status.reason }),
    ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }),
  });
}

/** The public view of one served attachment of a Secret. */
export function computerSecretUseOf(
  use: ServedComputerSecretUse,
): ComputerSecretUse {
  return Object.freeze({
    computer: use.computer,
    computerName: use.computerName,
    env: use.env,
    attached: use.attached,
    ...(use.version === undefined ? {} : { version: numberOf(use.version) }),
  });
}
