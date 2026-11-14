// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The signed session trust of a Zone, as the reference contract defines it:
// which roots sign Computer endpoint and client certificates, and where
// the Zone's data edge is and how it is authenticated. A client trusts it
// only when a Network trust key it pins, or a successor that key signed,
// signed it, and refuses another Network or Zone, a bundle outside its
// validity, and a version lower than the highest it has accepted.

import { decodeBase64 } from "../resource/base64.js";

/** The payload type of a session trust bundle. */
export const SESSION_TRUST_TYPE = "idyl-session-trust/1";
/** The payload type of a trust key statement. */
export const TRUST_KEY_TYPE = "idyl-trust-key/1";
/** The role whose keys sign session trust. */
export const NETWORK_TRUST_ROLE = "network-trust";

/** A Network trust key the client pins: its ID and raw Ed25519 public key. */
export interface TrustKey {
  /** The key's ID, as published by the Network. */
  readonly keyId: string;
  /** The raw 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
}

/** The sentence a bundle for another Network or trust scope is refused with. */
const TRUST_SCOPE = "trust document names another network, zone or role";

/** A signed document as served: its payload and its signatures, base64. */
export interface SignedTrustDocument {
  readonly payload: string;
  readonly signatures: readonly {
    readonly keyId: string;
    readonly signature: string;
  }[];
}

/** The session trust route's answer. */
export interface SessionTrustResponse {
  readonly bundle: SignedTrustDocument;
  readonly keys?: readonly SignedTrustDocument[];
}

/** A verified session trust bundle. */
export interface SessionTrust {
  readonly network: string;
  readonly zone: string;
  readonly version: number;
  readonly expiresAtMs: number;
  /** DER roots of Computer endpoint and client certificates. */
  readonly podRoots: readonly Uint8Array[];
  /**
   * The data edge: its `host:port`, exact SPIFFE ID and DER roots, and the
   * `wss://` URL of its browser listener when the Zone names one.
   */
  readonly dataFabric: {
    readonly endpoint: string;
    readonly serverId: string;
    readonly serverRoots: readonly Uint8Array[];
    readonly browserEndpoint?: string;
  };
}

/** What a bundle must satisfy. */
export interface SessionTrustPolicy {
  readonly network: string;
  readonly zone?: string;
  readonly keys: readonly TrustKey[];
  /** The highest version accepted before; a lower one is refused. */
  readonly minVersion: number;
  readonly nowMs: number;
}

/**
 * The Network's signed session trust was refused: no pinned key, nor a
 * successor one signed, signed it; it names another Network or another
 * trust scope than the client's placement chose; it lies outside its
 * validity or lacks a part a connection needs; its version is lower than
 * the highest the client has accepted for that Network and scope, a
 * rollback; or the trust floor that keeps that version could not be read
 * or written, which `cause` carries. The connector's `ready` rejects with this
 * error, and so does every session waiting on `ready`. The message is a fixed
 * sentence naming the rule.
 */
export class SessionTrustError extends Error {
  /**
   * Builds the error. A {@link TrustFloor} of the caller's own rejects with
   * one to refuse a rollback.
   *
   * @param message a fixed sentence naming the rule the bundle breaks
   * @param options `cause`, the underlying failure, when there is one
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionTrustError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** `bytes` in a buffer of its own, as WebCrypto takes them. */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/** The bytes a signature covers: the type, a newline, the payload. */
function signedMessage(
  type: string,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode(`${type}\n`);
  const out = new Uint8Array(prefix.length + payload.length);
  out.set(prefix);
  out.set(payload, prefix.length);
  return out;
}

async function verifiedBy(
  type: string,
  document: SignedTrustDocument,
  keys: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array | undefined> {
  const payload = decodeBase64(document.payload);
  const message = signedMessage(type, payload);
  for (const signature of document.signatures) {
    const publicKey = keys.get(signature.keyId);
    if (publicKey === undefined) continue;
    const key = await crypto.subtle.importKey(
      "raw",
      owned(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    if (
      await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        owned(decodeBase64(signature.signature)),
        message,
      )
    ) {
      return payload;
    }
  }
  return undefined;
}

function json(payload: Uint8Array, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(payload));
  } catch (cause) {
    throw new SessionTrustError(`${what} is not JSON`, { cause });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionTrustError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function pemCertificates(pem: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const re =
    /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/g;
  for (const match of pem.matchAll(re)) {
    out.push(decodeBase64((match[1] ?? "").replace(/\s+/g, "")));
  }
  return out;
}

/** A `wss://` URL with a host and a path, and nothing else. */
function isBrowserEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "wss:" &&
    url.hostname !== "" &&
    url.pathname.length > 1 &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

/**
 * Verifies a Zone's session trust under `policy` and returns it. Throws a
 * {@link SessionTrustError} naming the rule a bundle breaks.
 */
export async function verifySessionTrust(
  response: SessionTrustResponse,
  policy: SessionTrustPolicy,
): Promise<SessionTrust> {
  const trusted = new Map<string, Uint8Array>(
    policy.keys.map((k) => [k.keyId, k.publicKey]),
  );
  // Successor keys, each announced by a key already trusted.
  for (const statement of response.keys ?? []) {
    const payload = await verifiedBy(TRUST_KEY_TYPE, statement, trusted);
    if (payload === undefined) continue;
    const s = json(payload, "trust key statement");
    if (
      s["type"] !== TRUST_KEY_TYPE ||
      s["network"] !== policy.network ||
      s["role"] !== NETWORK_TRUST_ROLE ||
      typeof s["keyId"] !== "string" ||
      typeof s["publicKey"] !== "string" ||
      typeof s["notBefore"] !== "string" ||
      Date.parse(s["notBefore"]) > policy.nowMs
    ) {
      continue;
    }
    trusted.set(s["keyId"], decodeBase64(s["publicKey"]));
  }
  const payload = await verifiedBy(
    SESSION_TRUST_TYPE,
    response.bundle,
    trusted,
  );
  if (payload === undefined) {
    throw new SessionTrustError(
      "session trust is not signed by a trusted Network key",
    );
  }
  const b = json(payload, "session trust");
  if (b["type"] !== SESSION_TRUST_TYPE) {
    throw new SessionTrustError("session trust has another type");
  }
  if (b["network"] !== policy.network) {
    throw new SessionTrustError(TRUST_SCOPE);
  }
  const zone = b["zone"];
  if (typeof zone !== "string" || zone === "") {
    throw new SessionTrustError("session trust names no Zone");
  }
  if (policy.zone !== undefined && zone !== policy.zone) {
    throw new SessionTrustError(TRUST_SCOPE);
  }
  const version = b["version"];
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw new SessionTrustError("session trust has no version");
  }
  if (version < policy.minVersion) {
    throw new SessionTrustError(
      "session trust bundle is older than one already accepted",
    );
  }
  const issuedAt = Date.parse(String(b["issuedAt"]));
  const expiresAt = Date.parse(String(b["expiresAt"]));
  if (
    Number.isNaN(issuedAt) ||
    Number.isNaN(expiresAt) ||
    policy.nowMs < issuedAt ||
    policy.nowMs >= expiresAt
  ) {
    throw new SessionTrustError("session trust is outside its validity");
  }
  const pod = b["pod"] as { generations?: unknown } | undefined;
  const podRoots = (Array.isArray(pod?.generations) ? pod.generations : [])
    .map((g: unknown) => (g as { certificateDer?: unknown }).certificateDer)
    .filter((der): der is string => typeof der === "string")
    .map((der) => decodeBase64(der));
  if (podRoots.length === 0) {
    throw new SessionTrustError("session trust names no Pod roots");
  }
  const fabric = b["dataFabric"] as Record<string, unknown> | undefined;
  const endpoint = fabric?.["endpoint"];
  const serverId = fabric?.["serverId"];
  const roots = fabric?.["serverRoots"];
  const serverRoots = pemCertificates(typeof roots === "string" ? roots : "");
  if (
    typeof endpoint !== "string" ||
    typeof serverId !== "string" ||
    serverRoots.length === 0
  ) {
    throw new SessionTrustError("session trust names no data edge");
  }
  const browser = fabric?.["browserEndpoint"];
  if (browser !== undefined && !isBrowserEndpoint(browser)) {
    throw new SessionTrustError(
      "session trust names a browser endpoint that is not a wss URL",
    );
  }
  return {
    network: policy.network,
    zone,
    version,
    expiresAtMs: expiresAt,
    podRoots,
    dataFabric: {
      endpoint,
      serverId,
      serverRoots,
      ...(browser === undefined ? {} : { browserEndpoint: browser }),
    },
  };
}
