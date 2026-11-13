// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The access key file, the public format an access key is kept in, and the
 * credential source that exchanges one for access tokens. The file is one
 * JSON object:
 *
 *   {"type":"idyl-access-key","network":"<network>","accessKeyId":"<uuid>",
 *    "account":"<12-digit Account ID>","privateKey":<private JWK>}
 *
 * where `privateKey` is an Ed25519 (RFC 8037) or ECDSA P-256 (RFC 7518)
 * private JSON Web Key. Every error names the problem and never any key
 * material.
 */
import type {
  Credential,
  CredentialContext,
  CredentialSource,
} from "../credential.js";
import { TransportError } from "../errors.js";
import { abortable } from "../internal/abort.js";
import { coordinate, keyPairProblem } from "../internal/dpop.js";
import { validateNetworkDomain } from "../internal/endpoints.js";
import { parseText } from "../internal/strictdecode.js";
import { isAccountId } from "../resource/id.js";
import { isUuidId, parseAccessKeyId } from "../resource/uuid-id.js";
import type { AccessToken, Identity } from "./identity.js";

/** The `type` every access key file carries. */
const ACCESS_KEY_FILE_TYPE = "idyl-access-key";

/** The largest access key file read, in bytes. */
const MAX_ACCESS_KEY_FILE_BYTES = 4096;

/** How long before its expiry an access key's token is replaced. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;
/** The least time between two background renewals of a valid token. */
const RENEW_RETRY_MS = 30 * 1000;
/** How long before its expiry a token is no longer handed out. */
const VALID_MARGIN_MS = 30 * 1000;

/** The refusal of any file that is not exactly one access key object. */
const NOT_A_FILE = "access key file is not one access key JSON object";

/** The refusal of a private key that is not a valid, consistent key. */
const INVALID_KEY =
  "access key file private key is not a valid Ed25519 or P-256 key";

/**
 * An access key as its holder keeps it: the key's ID, the network and
 * Account it belongs to, and its key pair. It is a credential: whoever
 * holds it acts as the key's principal. Keep its file where only its owner
 * can read it, and out of logs and source control.
 */
export interface AccessKeyFile {
  /** The IDYL network's API domain, the `network` a client is built with. */
  readonly network: string;
  /** The access key's ID, a lowercase canonical UUID: its record's `id`. */
  readonly accessKeyId: string;
  /** The twelve-digit ID of the Account the key acts in. */
  readonly account: string;
  /** The key pair; its private key is non-extractable unless it was imported extractable. */
  readonly key: CryptoKeyPair;
}

/** How {@link parseAccessKeyFile} imports the private key. */
export interface ParseAccessKeyFileOptions {
  /**
   * Imports the private key extractable, so {@link encodeAccessKeyFile} can
   * write it again. `undefined` imports it non-extractable, which is all a
   * credential needs.
   */
  readonly extractable?: boolean;
}

/** A private JSON Web Key in the members the file format admits. */
export interface PrivateJwk {
  readonly kty: "OKP" | "EC";
  readonly crv: "Ed25519" | "P-256";
  readonly x: string;
  readonly y?: string;
  readonly d: string;
}

/** The file's document, member for member. */
interface FileDocument {
  readonly type: typeof ACCESS_KEY_FILE_TYPE;
  readonly network: string;
  readonly accessKeyId: string;
  readonly account: string;
  readonly privateKey: PrivateJwk;
}

/**
 * Decodes an access key file strictly, at most 4096 bytes: one JSON object
 * with exactly the members of the format, of type `idyl-access-key`,
 * naming a network domain, a canonical access key ID and a twelve-digit
 * Account ID, and an Ed25519 or P-256 private key whose public members
 * match it. The private key is imported non-extractable unless
 * `options.extractable` is set.
 *
 * @param text The access key file's text, as {@link CreatedAccessKey.keyFile} gave it.
 * @throws {@link TypeError} the text is not a valid access key file; the
 *   message names the problem and no key material
 */
export async function parseAccessKeyFile(
  text: string,
  options: ParseAccessKeyFileOptions = {},
): Promise<AccessKeyFile> {
  return await fileOf(decodeFile(text), options.extractable === true);
}

/**
 * The credential source of an access key file's text, and the network the file
 * names. The file is judged now; its key is imported on the first request.
 * Throws a `TypeError` that names the problem and no key material.
 */
export function accessKeySource(
  text: string,
  identity: () => Identity,
): { readonly network: string; readonly source: CredentialSource } {
  const document = decodeFile(text);
  let source: Promise<CredentialSource> | undefined;
  return {
    network: document.network,
    source: Object.freeze({
      async credential(context: CredentialContext): Promise<Credential> {
        source ??= fileOf(document, false).then((file) =>
          accessKeyCredentials(file, identity()),
        );
        return await (await source).credential(context);
      },
    }),
  };
}

function decodeFile(text: string): FileDocument {
  if (typeof text !== "string") {
    throw new TypeError("access key file must be text");
  }
  if (new TextEncoder().encode(text).byteLength > MAX_ACCESS_KEY_FILE_BYTES) {
    throw new TypeError(
      `access key file exceeds ${String(MAX_ACCESS_KEY_FILE_BYTES)} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseText(text, "strict");
  } catch {
    // The parser's message may quote the text, which holds the key.
    throw new TypeError(NOT_A_FILE);
  }
  return documentOf(parsed);
}

/**
 * Encodes an access key file in the format {@link parseAccessKeyFile}
 * reads, members in the format's order. The private key must be
 * extractable, as a key {@link parseAccessKeyFile} imported with
 * `extractable` is.
 *
 * @param file The access key to encode.
 * @throws {@link TypeError} the private key is not extractable, the key
 *   pair is not an Ed25519 or ECDSA P-256 pair, or a field is invalid
 */
export async function encodeAccessKeyFile(
  file: AccessKeyFile,
): Promise<string> {
  const { network, accessKeyId, account, key } = file;
  const problem = keyPairProblem(key);
  if (problem !== undefined) {
    throw new TypeError(`access key file key ${problem}`);
  }
  if (!key.privateKey.extractable) {
    throw new TypeError("access key file private key is not extractable");
  }
  let exported: JsonWebKey;
  try {
    exported = await crypto.subtle.exportKey("jwk", key.privateKey);
  } catch {
    throw new TypeError(INVALID_KEY);
  }
  const { kty, crv, x, y, d } = exported;
  const document = documentOf({
    type: ACCESS_KEY_FILE_TYPE,
    network,
    accessKeyId,
    account,
    privateKey: kty === "EC" ? { kty, crv, x, y, d } : { kty, crv, x, d },
  });
  return encodeFile(document);
}

/** The file's text, members in the format's order. */
export function encodeFile(document: FileDocument): string {
  const { privateKey: k } = document;
  return JSON.stringify({
    type: document.type,
    network: document.network,
    accessKeyId: document.accessKeyId,
    account: document.account,
    privateKey:
      k.y === undefined
        ? { kty: k.kty, crv: k.crv, x: k.x, d: k.d }
        : { kty: k.kty, crv: k.crv, x: k.x, y: k.y, d: k.d },
  });
}

/** Judges a parsed value as the file's document, member for member. */
function documentOf(value: unknown): FileDocument {
  const file = exactly(value, [
    "type",
    "network",
    "accessKeyId",
    "account",
    "privateKey",
  ]);
  if (file === undefined) throw new TypeError(NOT_A_FILE);
  if (file["type"] !== ACCESS_KEY_FILE_TYPE) {
    throw new TypeError(
      `access key file type must be ${JSON.stringify(ACCESS_KEY_FILE_TYPE)}`,
    );
  }
  const { network, accessKeyId, account } = file;
  if (typeof network !== "string" || !isNetwork(network)) {
    throw new TypeError("access key file names no valid network");
  }
  if (!isUuidId(accessKeyId)) {
    throw new TypeError(
      "access key file access key ID must be a canonical UUID",
    );
  }
  if (!isAccountId(account)) {
    throw new TypeError("access key file names no valid account");
  }
  return {
    type: ACCESS_KEY_FILE_TYPE,
    network,
    accessKeyId,
    account,
    privateKey: privateJwk(file["privateKey"]),
  };
}

function isNetwork(network: string): boolean {
  try {
    validateNetworkDomain(network);
    return true;
  } catch {
    return false;
  }
}

/** A private JWK of exactly the members its key type admits. */
function privateJwk(value: unknown): PrivateJwk {
  const ed = exactly(value, ["kty", "crv", "x", "d"]);
  if (
    ed?.["kty"] === "OKP" &&
    ed["crv"] === "Ed25519" &&
    coordinate(ed["x"]) &&
    coordinate(ed["d"])
  ) {
    return { kty: "OKP", crv: "Ed25519", x: ed["x"], d: ed["d"] };
  }
  const ec = exactly(value, ["kty", "crv", "x", "y", "d"]);
  if (
    ec?.["kty"] === "EC" &&
    ec["crv"] === "P-256" &&
    coordinate(ec["x"]) &&
    coordinate(ec["y"]) &&
    coordinate(ec["d"])
  ) {
    return { kty: "EC", crv: "P-256", x: ec["x"], y: ec["y"], d: ec["d"] };
  }
  throw new TypeError(INVALID_KEY);
}

/** `value` as an object holding exactly `members`, or `undefined`. */
function exactly(
  value: unknown,
  members: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  return keys.length === members.length &&
    members.every((member) => keys.includes(member))
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Imports a judged document's key pair and proves the two halves belong
 * together: a message the private key signs verifies with the public key
 * its members name.
 */
export async function fileOf(
  document: FileDocument,
  extractable: boolean,
): Promise<AccessKeyFile> {
  const { privateKey: jwk } = document;
  const algorithm =
    jwk.kty === "OKP"
      ? { name: "Ed25519" }
      : { name: "ECDSA", namedCurve: "P-256" };
  const signing =
    jwk.kty === "OKP"
      ? { name: "Ed25519" }
      : { name: "ECDSA", hash: "SHA-256" };
  const publicMembers: JsonWebKey =
    jwk.y === undefined
      ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x }
      : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  let key: CryptoKeyPair;
  try {
    const [privateKey, publicKey] = await Promise.all([
      crypto.subtle.importKey("jwk", { ...jwk }, algorithm, extractable, [
        "sign",
      ]),
      crypto.subtle.importKey("jwk", publicMembers, algorithm, true, [
        "verify",
      ]),
    ]);
    const probe = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign(signing, privateKey, probe);
    if (!(await crypto.subtle.verify(signing, publicKey, signature, probe))) {
      throw new TypeError(INVALID_KEY);
    }
    key = Object.freeze({ publicKey, privateKey });
  } catch {
    // A WebCrypto failure is reported as the one fixed sentence, never with
    // a cause that could describe the key.
    throw new TypeError(INVALID_KEY);
  }
  return Object.freeze({
    network: document.network,
    accessKeyId: document.accessKeyId,
    account: document.account,
    key,
  });
}

/** An access key's current token and its expiry, in milliseconds. */
interface HeldToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

/**
 * A {@link CredentialSource} for an access key. It exchanges the key at
 * `identity` for an access token bound to the same key on first use, and
 * hands that token out while it is valid. From five minutes before its
 * expiry the next token is exchanged in the background while the current
 * one is still handed out, so no request waits for a renewal; a request
 * waits only when there is no valid token, each under its own signal.
 * Exchanges are single-flight and bounded by the identity client's request
 * timeout rather than by any one caller. A failed background renewal is
 * tried again at most every 30 seconds while the token is valid; once it
 * has expired, a failed exchange rejects the requests that waited for it
 * and is tried again by the next.
 *
 * @param file The access key, as {@link parseAccessKeyFile} returns it.
 * @param identity The identity of a client for the key's network, which
 *   performs the exchanges.
 * @throws {@link TypeError} `file` is missing, names a malformed access key
 *   ID or holds an unusable key pair, or `identity` is not a client's
 *   identity
 */
export function accessKeyCredentials(
  file: AccessKeyFile,
  identity: Identity,
): CredentialSource {
  if (typeof (file as unknown) !== "object" || (file as unknown) === null) {
    throw new TypeError("access key file is required");
  }
  const accessKeyId = parseAccessKeyId(file.accessKeyId);
  const { key } = file;
  const problem = keyPairProblem(key);
  if (problem !== undefined) {
    throw new TypeError(`access key file key ${problem}`);
  }
  if (
    typeof (identity as Partial<Identity> | undefined)?.exchangeAccessKey !==
    "function"
  ) {
    throw new TypeError("identity is required: the client's identity");
  }
  let current: HeldToken | undefined;
  let pending: Promise<HeldToken> | undefined;
  let nextRenewal = 0;
  const exchange = async (): Promise<HeldToken> => {
    const token: AccessToken = await identity.exchangeAccessKey(
      accessKeyId,
      key,
    );
    const expiresAt = Date.parse(token.expiresAt);
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() + VALID_MARGIN_MS
    ) {
      throw new TransportError(
        "invalid_response",
        "access key exchange response has no valid expiry",
      );
    }
    current = { accessToken: token.accessToken, expiresAt };
    return current;
  };
  const start = (): Promise<HeldToken> => {
    nextRenewal = Date.now() + RENEW_RETRY_MS;
    const exchanging = exchange().finally(() => {
      pending = undefined;
    });
    pending = exchanging;
    return exchanging;
  };
  return Object.freeze({
    async credential({ signal }: CredentialContext): Promise<Credential> {
      const now = Date.now();
      const held = current;
      if (held !== undefined && now + VALID_MARGIN_MS < held.expiresAt) {
        if (
          now + RENEW_BEFORE_MS >= held.expiresAt &&
          pending === undefined &&
          now >= nextRenewal
        ) {
          // A failed background renewal is retried by a later request.
          start().catch(() => undefined);
        }
        return { accessToken: held.accessToken, key };
      }
      const token = await abortable(pending ?? start(), signal);
      return { accessToken: token.accessToken, key };
    },
  });
}
