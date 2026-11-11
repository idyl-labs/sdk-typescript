// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * Vault Secrets: the document a write submits, the redacted document every
 * read returns, and their validation.
 *
 * A Secret holds either keyed binary values, which a Pod mounts as files, or
 * one value that IDYL adds to a Computer's requests to the origins the
 * Secret allows, so that the value never enters the Computer. Its source
 * states where that value comes from, and its egress where the value may go:
 * the exact HTTPS origins that receive it and the one place in a request it
 * fills.
 *
 * A Computer that attaches the Secret holds a placeholder in an environment
 * variable in its place. When the Computer sends a request to one of the
 * Secret's origins, IDYL puts the value in place of the placeholder where the
 * credential says, and sends the request on over TLS verified against the
 * origin. A placeholder anywhere else, or sent to any other origin, is sent
 * as written. The origin receives the value and can record it or return it
 * in a response, so an origin should be the API host that needs it.
 *
 * Refusals never contain a value or a key.
 */
import {
  always,
  array,
  integer,
  map,
  object,
  omitEmpty,
  omitZero,
  pointer,
  string,
  decodeValue,
  type Shape,
} from "../internal/strictdecode.js";
import { bytesShape } from "./base64.js";
import { parseEgressWildcard } from "./egress-allow-rule.js";
import { parseJson, type Integer } from "./json.js";
import { timestampShape } from "./shapes.js";
import type { ResourceId } from "./uuid-id.js";
import { errorMessage, isWellFormed, prefixed } from "./validation.js";
import {
  looksLikeIpAddress,
  validateNetworkTargetHostname,
} from "./workload-network.js";

/** The most keys one keyed Secret version holds. */
export const MAX_VAULT_SECRET_KEYS = 64;
/** The most UTF-8 bytes one Secret key takes. */
export const MAX_VAULT_SECRET_KEY_BYTES = 255;
/** The most bytes one keyed Secret value holds. */
export const MAX_VAULT_SECRET_VALUE_BYTES = 256 * 1024;
/** The most bytes all the values of one keyed Secret version hold. */
export const MAX_VAULT_SECRET_TOTAL_BYTES = 1024 * 1024;
/** The most bytes of a private key in PEM form. */
export const MAX_VAULT_PRIVATE_KEY_BYTES = 256 * 1024;
/** The most bytes a stored source value holds, so that it fits in one header. */
export const MAX_SECRET_SOURCE_VALUE_BYTES = 8 * 1024;
/** The most origins one Secret's egress states. */
export const MAX_SECRET_EGRESS_ORIGINS = 16;
/** The most bytes of the header name a `header` credential fills. */
export const MAX_SECRET_EGRESS_HEADER_BYTES = 128;
/**
 * The port of an origin that states none. It is also the one port a written
 * origin may name, because the value is added only to requests on it.
 */
export const DEFAULT_SECRET_EGRESS_ORIGIN_PORT = 443;

/** The ports a Computer's egress gateway serves itself, which no origin names. */
const RESERVED_ORIGIN_PORTS: ReadonlySet<number> = new Set([53, 7300, 7301]);

/** The form of a Vault resource name and of an explicitly stated Namespace. */
const REFERENCE_NAME_FORM = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u;

/**
 * The manifest kind of a Vault resource. Open, as the platform may name
 * more; {@link validateSecret} and {@link validateRedactedSecret} judge it.
 */
export type VaultResourceKind =
  "Secret" | "TLSCertificate" | (string & Record<never, never>);

/** The identity every Vault resource carries. */
export interface VaultResourceMetadata {
  /** The resource's ID. `undefined` on a write, which the platform assigns. */
  readonly id?: ResourceId;
  /** The resource's name, unique within its Namespace and Subnet. Always written. */
  readonly name: string;
  /** The Namespace the resource lives in; `undefined` takes the addressed one. */
  readonly namespace?: string;
  /** The Subnet the resource lives in, as its twelve-digit slug. Always written. */
  readonly subnet: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
  /** When the resource was created, an RFC 3339 time. */
  readonly createdAt?: string;
  /** When the resource last changed, an RFC 3339 time. */
  readonly updatedAt?: string;
  /** When the resource was deleted, an RFC 3339 time; `undefined` while it is not. */
  readonly deletedAt?: string;
}

/**
 * The place in a request a Secret's value fills:
 *
 * - `basic-password`, the password of HTTP Basic authentication when the
 *   whole password is the placeholder;
 * - `header`, the header the credential names when its whole value is the
 *   placeholder;
 * - `authorization-token`, the token of an `Authorization` header that uses
 *   the scheme the credential names, such as `Authorization: Bearer
 *   <token>`. It is filled only when the request carries exactly one
 *   `Authorization` header, and that header's value is the scheme, compared
 *   without regard to case, then one or more spaces, then a token that is
 *   wholly the placeholder. The scheme and the spaces are sent as written. A
 *   request with two `Authorization` headers, another scheme, or the
 *   placeholder as part of a longer token is sent as written.
 *
 * Open; {@link validateSecretEgressCredential} judges it.
 */
export type SecretEgressCredentialType =
  | "basic-password"
  | "header"
  | "authorization-token"
  | (string & Record<never, never>);

/**
 * The authentication scheme of the `Authorization` header whose token an
 * `authorization-token` credential fills. The set is closed, and each scheme
 * has one spelling: `Bearer`, the scheme of RFC 6750, which most API
 * clients send an API key or an access token in, and `token`, which the
 * GitHub CLI sends a GitHub token in. The type is open so that a read
 * carries any scheme; {@link validateSecretEgressCredential} judges it.
 */
export type SecretEgressAuthorizationScheme =
  "Bearer" | "token" | (string & Record<never, never>);

/**
 * The place in a request a Secret's value fills. The value replaces the
 * placeholder only where the whole of that place is the placeholder; a
 * placeholder anywhere else in a request, including the URL, the body,
 * another header, or part of a longer value, is sent as written.
 */
export interface SecretEgressCredential {
  /** The place the value fills. Always written. */
  readonly type: SecretEgressCredentialType;
  /**
   * The name of the header the value fills, for type `header`, matched
   * without regard to case, such as `PRIVATE-TOKEN`. An HTTP field name
   * other than one that frames the request or controls the connection.
   * `undefined` for every other type.
   */
  readonly header?: string;
  /**
   * The authentication scheme of the `Authorization` header whose token the
   * value fills, for type `authorization-token`: `Bearer` or `token`.
   * `undefined` for every other type.
   */
  readonly scheme?: SecretEgressAuthorizationScheme;
}

/** Where a Secret's value may go: the origins that receive it, and the place it fills. */
export interface SecretEgress {
  /**
   * The HTTPS origins that receive the value, each `https://<host>` with an
   * optional `:<port>`, as {@link parseSecretEgressOrigin} admits; a
   * wildcard is written as the whole leftmost label, `https://*.example.com`.
   * The value goes to no other origin. A write names port 443 only, by
   * leaving the port out or by writing `:443`; see
   * {@link validateSecretSpec}. 1 to {@link MAX_SECRET_EGRESS_ORIGINS}, none
   * repeated. Always written.
   */
  readonly origins: readonly string[];
  /** The place in a request the value fills. Always written. */
  readonly credential: SecretEgressCredential;
}

/** A GitHub App installation whose installation tokens a Secret sends as its value. */
export interface SecretGitHubAppSource {
  /** The GitHub App's ID, as GitHub shows it on the App's settings. At least 1. */
  readonly appId: Integer;
  /** The ID of the App's installation whose repositories the tokens reach. At least 1. */
  readonly installationId: Integer;
  /**
   * A private key of the App, in the PEM form GitHub downloads. Write-only:
   * it stays in Vault, and no read returns it.
   */
  readonly privateKey: string;
}

/**
 * Where a Secret's value comes from: exactly one of a stored `value` and a
 * `githubApp`. Its material is write-only; a read reports the kind of
 * source and none of its material.
 */
export interface SecretSource {
  /**
   * A value stored in Vault: printable ASCII, from space to tilde, at most
   * {@link MAX_SECRET_SOURCE_VALUE_BYTES} bytes, with no line break.
   */
  readonly value?: string;
  /**
   * When the stored value stops being valid, an RFC 3339 time, as its issuer
   * states it. The Secret's health turns to `expiring` seven days before it
   * and to `expired` at it, and a value past it is never sent. Stated only
   * with `value`.
   */
  readonly expiresAt?: string;
  /**
   * A GitHub App installation whose tokens Vault mints: each lasts one hour,
   * is minted when one is needed, and is sent as the value.
   */
  readonly githubApp?: SecretGitHubAppSource;
}

/**
 * What a Secret holds: exactly one of `data` and `source`, and `egress`
 * exactly when it states `source`.
 */
export interface SecretSpec {
  /** Binary values keyed by projection-safe names, for a Pod to mount as files. */
  readonly data?: Readonly<Record<string, Uint8Array>>;
  /** Where the Secret's one value comes from; never stated with `data`. */
  readonly source?: SecretSource;
  /** Where the value may go; required with `source`, and absent without it. */
  readonly egress?: SecretEgress;
}

/** The document a Secret write submits. */
export interface Secret {
  /** Always `Secret`. */
  readonly kind: VaultResourceKind;
  readonly metadata: VaultResourceMetadata;
  readonly spec: SecretSpec;
}

/** One key of a keyed Secret, without its value. */
export interface SecretKeyMetadata {
  readonly name: string;
  /** The length of the key's value; `undefined` reads as zero. */
  readonly sizeBytes?: Integer;
}

/** A stored source value, without the value. */
export interface RedactedSecretValueSource {
  /** The length of the current version's value. Always written. */
  readonly sizeBytes: Integer;
  /** When the current version stops being valid; `undefined` when its writer stated none. */
  readonly expiresAt?: string;
}

/** A GitHub App source, without its private key. */
export interface RedactedSecretGitHubAppSource {
  readonly appId: Integer;
  readonly installationId: Integer;
}

/** The kind of a Secret's source, as a read reports it: exactly one is present. */
export interface RedactedSecretSource {
  readonly value?: RedactedSecretValueSource;
  readonly githubApp?: RedactedSecretGitHubAppSource;
}

/**
 * What a read reports of a Secret: its keys or the kind of its source, its
 * egress in full, and its versions. It never carries a value.
 */
export interface RedactedSecretSpec {
  /** The keys of a keyed Secret; `undefined` when it states a source. */
  readonly keys?: readonly SecretKeyMetadata[];
  /** The kind of the Secret's source; present exactly when `keys` is absent. */
  readonly source?: RedactedSecretSource;
  /** The Secret's egress, present exactly with `source`. */
  readonly egress?: SecretEgress;
  /** The current version, from 1. Always written. */
  readonly currentVersion: Integer;
  /** How many versions are kept. Always written. */
  readonly versionCount: Integer;
}

/**
 * The lifecycle of a Vault resource: `active`, `tombstone` once deleted
 * while its versions are kept, or `purged`. Open; the validator judges it.
 */
export type VaultResourceState =
  "active" | "tombstone" | "purged" | (string & Record<never, never>);

/**
 * Whether a Vault resource's current version can be used: `healthy`,
 * `not_yet_valid`, `expired`, `expiring` within seven days, or
 * `source_failed` when its source cannot produce a value. Open; the
 * validator judges it.
 */
export type VaultResourceHealth =
  | "healthy"
  | "not_yet_valid"
  | "expired"
  | "expiring"
  | "source_failed"
  | (string & Record<never, never>);

/** The lifecycle and validity of a Vault resource. */
export interface VaultResourceStatus {
  /** Always written. */
  readonly state: VaultResourceState;
  /** `undefined` when the platform reports none. */
  readonly health?: VaultResourceHealth;
  /** The resource's version for optimistic concurrency, from 1. Always written. */
  readonly resourceVersion: Integer;
}

/** The redacted document every Secret read returns. */
export interface RedactedSecret {
  readonly kind: VaultResourceKind;
  readonly metadata: VaultResourceMetadata;
  readonly spec: RedactedSecretSpec;
  readonly status: VaultResourceStatus;
}

/**
 * One parsed origin of a Secret's egress. Two spellings of one origin, such
 * as `https://example.com` and `https://EXAMPLE.com:443`, parse to equal
 * values.
 */
export interface SecretEgressOrigin {
  /** The lowercase host name; for a wildcard origin, the name below the wildcard. */
  readonly host: string;
  /** Whether the origin was written `https://*.<host>`. */
  readonly wildcard: boolean;
  /** The TCP port, {@link DEFAULT_SECRET_EGRESS_ORIGIN_PORT} when the origin states none. */
  readonly port: number;
}

const vaultResourceMetadataShape: Shape<VaultResourceMetadata> =
  object<VaultResourceMetadata>({
    id: omitEmpty(string<ResourceId>()),
    name: always(string()),
    namespace: omitEmpty(string()),
    subnet: always(string()),
    labels: omitEmpty(map(string())),
    annotations: omitEmpty(map(string())),
    createdAt: omitZero(timestampShape),
    updatedAt: omitZero(timestampShape),
    deletedAt: pointer(timestampShape),
  });

const secretEgressShape: Shape<SecretEgress> = object<SecretEgress>({
  origins: always(array(string())),
  credential: always(
    object<SecretEgressCredential>({
      type: always(string<SecretEgressCredentialType>()),
      header: omitEmpty(string()),
      scheme: omitEmpty(string<SecretEgressAuthorizationScheme>()),
    }),
  ),
});

const int64 = integer({ unsigned: false, bits: 64 });
const uint64 = integer({ unsigned: true, bits: 64 });

/** The wire shape of a Secret's spec. */
export const secretSpecShape: Shape<SecretSpec> = object<SecretSpec>({
  data: omitEmpty(map(bytesShape)),
  source: pointer(
    object<SecretSource>({
      value: omitEmpty(string()),
      expiresAt: pointer(timestampShape),
      githubApp: pointer(
        object<SecretGitHubAppSource>({
          appId: always(int64),
          installationId: always(int64),
          privateKey: always(string()),
        }),
      ),
    }),
  ),
  egress: pointer(secretEgressShape),
});

/** The wire shape of the document a Secret write submits. */
export const secretShape: Shape<Secret> = object<Secret>({
  kind: always(string<VaultResourceKind>()),
  metadata: always(vaultResourceMetadataShape),
  spec: always(secretSpecShape),
});

/** The wire shape of the redacted document a Secret read returns. */
export const redactedSecretShape: Shape<RedactedSecret> =
  object<RedactedSecret>({
    kind: always(string<VaultResourceKind>()),
    metadata: always(vaultResourceMetadataShape),
    spec: always(
      object<RedactedSecretSpec>({
        keys: omitEmpty(
          array(
            object<SecretKeyMetadata>({
              name: always(string()),
              sizeBytes: omitEmpty(uint64),
            }),
          ),
        ),
        source: pointer(
          object<RedactedSecretSource>({
            value: pointer(
              object<RedactedSecretValueSource>({
                sizeBytes: always(uint64),
                expiresAt: pointer(timestampShape),
              }),
            ),
            githubApp: pointer(
              object<RedactedSecretGitHubAppSource>({
                appId: always(int64),
                installationId: always(int64),
              }),
            ),
          }),
        ),
        egress: pointer(secretEgressShape),
        currentVersion: always(uint64),
        versionCount: always(uint64),
      }),
    ),
    status: always(
      object<VaultResourceStatus>({
        state: always(string<VaultResourceState>()),
        health: omitEmpty(string<VaultResourceHealth>()),
        resourceVersion: always(uint64),
      }),
    ),
  });

/**
 * Reads a redacted Secret leniently, from a parsed value or its JSON text: a
 * field, state or health newer than this package is carried rather than
 * refused, and {@link validateRedactedSecret} judges it.
 */
export function decodeRedactedSecret(document: unknown): RedactedSecret {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, redactedSecretShape, "lenient");
}

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Judges a Secret write: its kind is `Secret`, its name is a valid Vault
 * name, it names its Subnet, a Namespace it states is valid, and its spec is
 * one {@link validateSecretSpec} admits. Throws a `TypeError`.
 */
export function validateSecret(secret: Secret): void {
  validateVaultEnvelope(secret.kind, secret.metadata);
  validateSecretSpec(secret.spec);
}

/**
 * Judges a Secret spec: exactly one of `data` and `source`. Data holds 1 to
 * {@link MAX_VAULT_SECRET_KEYS} keys {@link validateVaultSecretKey} admits,
 * within the byte bounds. A source is one {@link validateSecretSource}
 * admits, stated with an egress {@link validateSecretEgress} admits whose
 * every origin names port 443, the one port the value is added to requests
 * on. An origin on another port is refused with the sentence `origin must
 * use port 443`, as `spec.egress.origins[<i>]: origin must use port 443`.
 * Throws a `TypeError` that never contains a value.
 */
export function validateSecretSpec(spec: SecretSpec): void {
  const data = spec.data ?? {};
  const keys = Object.keys(data);
  if (spec.source !== undefined) {
    if (keys.length !== 0) {
      throw new TypeError("spec.data must not be stated with spec.source");
    }
    prefixed("spec.source", () => {
      validateSecretSource(spec.source ?? {});
    });
    if (spec.egress === undefined) {
      throw new TypeError("spec.egress is required with spec.source");
    }
    validateSpecEgress(spec.egress);
    validateWrittenPorts(spec.egress);
    return;
  }
  if (spec.egress !== undefined) {
    throw new TypeError("spec.egress requires spec.source");
  }
  if (keys.length === 0) {
    throw new TypeError("spec.data must contain at least one key");
  }
  if (keys.length > MAX_VAULT_SECRET_KEYS) {
    throw new TypeError(
      `spec.data has ${String(keys.length)} keys, maximum is ${String(MAX_VAULT_SECRET_KEYS)}`,
    );
  }
  let total = 0;
  for (const key of keys.sort()) {
    const quoted = JSON.stringify(key);
    prefixed(`spec.data key ${quoted}`, () => {
      validateVaultSecretKey(key);
    });
    const size = data[key]?.byteLength ?? 0;
    if (size > MAX_VAULT_SECRET_VALUE_BYTES) {
      throw new TypeError(
        `spec.data key ${quoted} is ${String(size)} bytes, maximum is ${String(MAX_VAULT_SECRET_VALUE_BYTES)}`,
      );
    }
    total += size;
    if (total > MAX_VAULT_SECRET_TOTAL_BYTES) {
      throw new TypeError(
        `spec.data is ${String(total)} decoded bytes, maximum is ${String(MAX_VAULT_SECRET_TOTAL_BYTES)}`,
      );
    }
  }
}

/** Judges one stable, projection-safe key of a keyed Secret. Throws a `TypeError`. */
export function validateVaultSecretKey(key: string): void {
  if (key === "") throw new TypeError("must not be empty");
  if (!isWellFormed(key)) throw new TypeError("must be valid UTF-8");
  const size = utf8Length(key);
  if (size > MAX_VAULT_SECRET_KEY_BYTES) {
    throw new TypeError(
      `is ${String(size)} bytes, maximum is ${String(MAX_VAULT_SECRET_KEY_BYTES)}`,
    );
  }
  if (key === "." || key === "..") {
    throw new TypeError("must not be a traversal component");
  }
  if (/[/\\\0]/u.test(key)) {
    throw new TypeError("must not contain slash, backslash, or NUL");
  }
}

/**
 * Judges a source: exactly one of `value` and `githubApp`, and well-formed
 * material. A stored value is printable ASCII of at most
 * {@link MAX_SECRET_SOURCE_VALUE_BYTES} bytes; an expiry goes only with it.
 * A GitHub App states IDs of at least 1 and a PEM private key of at most
 * {@link MAX_VAULT_PRIVATE_KEY_BYTES} bytes. Throws a `TypeError` that never
 * contains the material.
 */
export function validateSecretSource(source: SecretSource): void {
  const value = source.value ?? "";
  if ((value === "") === (source.githubApp === undefined)) {
    throw new TypeError("must state exactly one of value and githubApp");
  }
  if (source.githubApp !== undefined) {
    if (source.expiresAt !== undefined) {
      throw new TypeError("expiresAt is stated only with value");
    }
    validateGitHubAppSource(source.githubApp);
    return;
  }
  const bytes = encoder.encode(value);
  if (bytes.byteLength > MAX_SECRET_SOURCE_VALUE_BYTES) {
    throw new TypeError(
      `value is ${String(bytes.byteLength)} bytes, maximum is ${String(MAX_SECRET_SOURCE_VALUE_BYTES)}`,
    );
  }
  const unprintable = bytes.findIndex((byte) => byte < 0x20 || byte > 0x7e);
  if (unprintable !== -1) {
    throw new TypeError(
      `value byte ${String(unprintable)} is not printable ASCII`,
    );
  }
  if (source.expiresAt !== undefined && isZeroTime(source.expiresAt)) {
    throw new TypeError("expiresAt must be a time");
  }
}

function validateGitHubAppSource(app: SecretGitHubAppSource): void {
  if (!atLeastOne(app.appId)) {
    throw new TypeError("githubApp.appId must be at least 1");
  }
  if (!atLeastOne(app.installationId)) {
    throw new TypeError("githubApp.installationId must be at least 1");
  }
  if (app.privateKey === "") {
    throw new TypeError("githubApp.privateKey is required");
  }
  const size = utf8Length(app.privateKey);
  if (size > MAX_VAULT_PRIVATE_KEY_BYTES) {
    throw new TypeError(
      `githubApp.privateKey is ${String(size)} bytes, maximum is ${String(MAX_VAULT_PRIVATE_KEY_BYTES)}`,
    );
  }
  if (!app.privateKey.startsWith("-----BEGIN ")) {
    throw new TypeError("githubApp.privateKey must be PEM");
  }
}

/**
 * Refuses, for an egress {@link validateSecretEgress} admits, the first
 * origin that names a port other than
 * {@link DEFAULT_SECRET_EGRESS_ORIGIN_PORT}. Its sentence is part of the
 * contract.
 */
function validateWrittenPorts(egress: SecretEgress): void {
  egress.origins.forEach((raw, index) => {
    const { port } = parseSecretEgressOrigin(raw);
    if (port !== DEFAULT_SECRET_EGRESS_ORIGIN_PORT) {
      throw new TypeError(
        `spec.egress.origins[${String(index)}]: origin must use port 443`,
      );
    }
  });
}

/**
 * Judges an egress: 1 to {@link MAX_SECRET_EGRESS_ORIGINS} origins
 * {@link parseSecretEgressOrigin} admits, no origin twice in any spelling,
 * and a credential {@link validateSecretEgressCredential} admits. Throws a
 * `TypeError` naming the field, such as `origins[0]: ...`.
 *
 * It judges an egress as it is read, and so admits an origin on any port
 * {@link parseSecretEgressOrigin} admits. A write is judged by
 * {@link validateSecretSpec}, which also requires every origin to name
 * port 443.
 */
export function validateSecretEgress(egress: SecretEgress): void {
  if (egress.origins.length === 0) {
    throw new TypeError("origins must name at least one origin");
  }
  if (egress.origins.length > MAX_SECRET_EGRESS_ORIGINS) {
    throw new TypeError(
      `origins has ${String(egress.origins.length)} entries, maximum is ${String(MAX_SECRET_EGRESS_ORIGINS)}`,
    );
  }
  const seen = new Map<string, number>();
  egress.origins.forEach((raw, index) => {
    let origin: SecretEgressOrigin;
    try {
      origin = parseSecretEgressOrigin(raw);
    } catch (cause) {
      throw new TypeError(`origins[${String(index)}]: ${errorMessage(cause)}`, {
        cause,
      });
    }
    const canonical = formatSecretEgressOrigin(origin);
    const previous = seen.get(canonical);
    if (previous !== undefined) {
      throw new TypeError(
        `origins[${String(index)}] duplicates origins[${String(previous)}]`,
      );
    }
    seen.set(canonical, index);
  });
  prefixed("credential", () => {
    validateSecretEgressCredential(egress.credential);
  });
}

/** The header names, lowercase, that frame a request or control its connection. */
const REFUSED_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** An HTTP field name: one or more token characters of RFC 9110. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

/**
 * Judges a credential: a type this package names; a header exactly when the
 * type is `header`, an HTTP field name of at most
 * {@link MAX_SECRET_EGRESS_HEADER_BYTES} bytes that neither frames the
 * request nor controls the connection; and a scheme exactly when the type is
 * `authorization-token`, one of `Bearer` and `token` spelled as they are.
 * Throws a `TypeError`.
 */
export function validateSecretEgressCredential(
  credential: SecretEgressCredential,
): void {
  const { type } = credential;
  const header = credential.header ?? "";
  const scheme = credential.scheme ?? "";
  switch (type) {
    case "basic-password":
    case "header":
    case "authorization-token":
      break;
    case "":
      throw new TypeError("type is required");
    default:
      throw new TypeError(`unknown credential type ${JSON.stringify(type)}`);
  }
  if (type !== "authorization-token" && scheme !== "") {
    throw new TypeError(`scheme must be absent for type ${type}`);
  }
  if (type === "authorization-token") {
    if (header !== "") {
      throw new TypeError(`header must be absent for type ${type}`);
    }
    switch (scheme) {
      case "Bearer":
      case "token":
        return;
      case "":
        throw new TypeError("scheme is required");
      default:
        throw new TypeError(
          `unknown authorization scheme ${JSON.stringify(scheme)}`,
        );
    }
  }
  if (type !== "header") {
    if (header !== "") {
      throw new TypeError(`header must be absent for type ${type}`);
    }
    return;
  }
  if (header === "") throw new TypeError(`header is required for type ${type}`);
  const size = utf8Length(header);
  if (size > MAX_SECRET_EGRESS_HEADER_BYTES) {
    throw new TypeError(
      `header is ${String(size)} bytes, maximum is ${String(MAX_SECRET_EGRESS_HEADER_BYTES)}`,
    );
  }
  if (!HTTP_TOKEN.test(header)) {
    throw new TypeError("header must be an HTTP field name");
  }
  if (REFUSED_HEADERS.has(header.toLowerCase())) {
    throw new TypeError(
      `header ${header} frames the request or controls the connection`,
    );
  }
}

/**
 * Parses an origin a Secret's value may go to: `https://`, a host, and an
 * optional `:<port>`, with no user, path, query or fragment. The host is a
 * DNS name, or a wildcard written as the whole leftmost label, such as
 * `*.example.com`, below a name of at least two labels. It refuses an IP
 * address or range, a local host name, and the ports 53, 7300 and 7301,
 * which a Computer's egress gateway serves itself. A Secret write further
 * requires port 443; see {@link validateSecretSpec}. Throws a `TypeError`.
 */
export function parseSecretEgressOrigin(origin: string): SecretEgressOrigin {
  if (!origin.startsWith("https://")) {
    throw new TypeError("origin must begin with https://");
  }
  const authority = origin.slice("https://".length);
  if (authority === "") throw new TypeError("origin must state a host");
  if (/[/?#@\\]/u.test(authority)) {
    throw new TypeError(
      "origin must not state a user, path, query or fragment",
    );
  }
  if (authority.startsWith("[")) {
    throw new TypeError("origin must name a host, not an IP address");
  }
  const colon = authority.indexOf(":");
  const host = colon === -1 ? authority : authority.slice(0, colon);
  let port = DEFAULT_SECRET_EGRESS_ORIGIN_PORT;
  if (colon !== -1) {
    const text = authority.slice(colon + 1);
    const value = /^[0-9]{1,5}$/u.test(text) ? Number(text) : 0;
    if (value < 1 || value > 65535 || text.startsWith("0")) {
      throw new TypeError(
        `origin port ${JSON.stringify(text)} must be between 1 and 65535`,
      );
    }
    port = value;
  }
  if (RESERVED_ORIGIN_PORTS.has(port)) {
    throw new TypeError(
      `origin port ${String(port)} is reserved for the Computer's gateway`,
    );
  }
  if (host === "") throw new TypeError("origin must state a host");
  if (looksLikeIpAddress(host)) {
    throw new TypeError("origin must name a host, not an IP address");
  }
  if (host.includes("*")) {
    return { host: parseEgressWildcard(host), wildcard: true, port };
  }
  validateNetworkTargetHostname(host);
  return { host: host.toLowerCase(), wildcard: false, port };
}

/**
 * The canonical spelling of an origin: `https://`, the lowercase host, and
 * the port when it is not {@link DEFAULT_SECRET_EGRESS_ORIGIN_PORT}.
 */
export function formatSecretEgressOrigin(origin: SecretEgressOrigin): string {
  const host = origin.wildcard ? `*.${origin.host}` : origin.host;
  return origin.port === DEFAULT_SECRET_EGRESS_ORIGIN_PORT
    ? `https://${host}`
    : `https://${host}:${String(origin.port)}`;
}

/**
 * Judges a redacted Secret as this package understands it: its envelope,
 * its status, versions of at least 1, and either keys or the kind of a
 * source with its egress. A read never requires it: a document a newer
 * platform reports is carried as it arrived. Throws a `TypeError`.
 */
export function validateRedactedSecret(secret: RedactedSecret): void {
  validateVaultEnvelope(secret.kind, secret.metadata);
  prefixed("status", () => {
    validateVaultResourceStatus(secret.status);
  });
  const { spec } = secret;
  if (!atLeastOne(spec.currentVersion)) {
    throw new TypeError("spec.currentVersion must be greater than zero");
  }
  if (!atLeastOne(spec.versionCount)) {
    throw new TypeError("spec.versionCount must be greater than zero");
  }
  if (spec.source !== undefined) {
    if ((spec.keys ?? []).length !== 0) {
      throw new TypeError("spec.keys must be absent with spec.source");
    }
    prefixed("spec.source", () => {
      validateRedactedSecretSource(spec.source ?? {});
    });
    if (spec.egress === undefined) {
      throw new TypeError("spec.egress is required with spec.source");
    }
    validateSpecEgress(spec.egress);
    return;
  }
  if (spec.egress !== undefined) {
    throw new TypeError("spec.egress requires spec.source");
  }
  const keys = spec.keys ?? [];
  if (keys.length === 0) {
    throw new TypeError("spec.keys must contain at least one key");
  }
  if (keys.length > MAX_VAULT_SECRET_KEYS) {
    throw new TypeError(
      `spec.keys has ${String(keys.length)} entries, maximum is ${String(MAX_VAULT_SECRET_KEYS)}`,
    );
  }
  const seen = new Set<string>();
  keys.forEach((key, index) => {
    const field = `spec.keys[${String(index)}]`;
    prefixed(`${field}.name`, () => {
      validateVaultSecretKey(key.name);
    });
    const size = BigInt(key.sizeBytes ?? 0);
    if (size > BigInt(MAX_VAULT_SECRET_VALUE_BYTES)) {
      throw new TypeError(
        `${field}.sizeBytes is ${size.toString()}, maximum is ${String(MAX_VAULT_SECRET_VALUE_BYTES)}`,
      );
    }
    if (seen.has(key.name)) {
      throw new TypeError(
        `${field}.name duplicates ${JSON.stringify(key.name)}`,
      );
    }
    seen.add(key.name);
  });
}

function validateRedactedSecretSource(source: RedactedSecretSource): void {
  if ((source.value === undefined) === (source.githubApp === undefined)) {
    throw new TypeError("must state exactly one of value and githubApp");
  }
  if (source.githubApp !== undefined) {
    if (
      !atLeastOne(source.githubApp.appId) ||
      !atLeastOne(source.githubApp.installationId)
    ) {
      throw new TypeError(
        "githubApp.appId and githubApp.installationId must be at least 1",
      );
    }
    return;
  }
  const size = BigInt(source.value?.sizeBytes ?? 0);
  if (size > BigInt(MAX_SECRET_SOURCE_VALUE_BYTES)) {
    throw new TypeError(
      `value.sizeBytes is ${size.toString()}, maximum is ${String(MAX_SECRET_SOURCE_VALUE_BYTES)}`,
    );
  }
}

/**
 * Judges a Vault resource's status: a state and a health this package
 * names, and a resource version of at least 1. Throws a `TypeError`.
 */
export function validateVaultResourceStatus(status: VaultResourceStatus): void {
  switch (status.state) {
    case "active":
    case "tombstone":
    case "purged":
      break;
    default:
      throw new TypeError(
        `unknown Vault resource state ${JSON.stringify(status.state)}`,
      );
  }
  switch (status.health ?? "") {
    case "":
    case "healthy":
    case "not_yet_valid":
    case "expired":
    case "expiring":
    case "source_failed":
      break;
    default:
      throw new TypeError(
        `unknown Vault resource health ${JSON.stringify(status.health)}`,
      );
  }
  if (!atLeastOne(status.resourceVersion)) {
    throw new TypeError("resourceVersion must be greater than zero");
  }
}

/** Judges a Vault resource name or an explicitly stated Namespace. Throws a `TypeError`. */
export function validateVaultReferenceName(label: string, name: string): void {
  if (name === "") throw new TypeError(`${label} is required`);
  if (name === "." || name === ".." || !REFERENCE_NAME_FORM.test(name)) {
    throw new TypeError(`${label} ${JSON.stringify(name)} is invalid`);
  }
}

function validateVaultEnvelope(
  kind: VaultResourceKind,
  metadata: VaultResourceMetadata,
): void {
  if (kind === "") throw new TypeError("vault resource kind is required");
  if (kind !== "Secret" && kind !== "TLSCertificate") {
    throw new TypeError(`unknown Vault resource kind ${JSON.stringify(kind)}`);
  }
  if (kind !== "Secret") throw new TypeError('kind must be "Secret"');
  validateVaultReferenceName("metadata.name", metadata.name);
  if (metadata.subnet.trim() === "") {
    throw new TypeError("metadata.subnet is required");
  }
  const namespace = metadata.namespace ?? "";
  if (namespace !== "") {
    validateVaultReferenceName("metadata.namespace", namespace);
  }
}

function validateSpecEgress(egress: SecretEgress): void {
  try {
    validateSecretEgress(egress);
  } catch (cause) {
    throw new TypeError(`spec.egress.${errorMessage(cause)}`, { cause });
  }
}

function atLeastOne(value: Integer): boolean {
  return BigInt(value) >= 1n;
}

/**
 * The instant the reference contract reads as no time at all,
 * `0001-01-01T00:00:00Z`, in milliseconds since the epoch.
 */
const ZERO_TIME_MS = -62_135_596_800_000;

function isZeroTime(timestamp: string): boolean {
  return Date.parse(timestamp) === ZERO_TIME_MS;
}
