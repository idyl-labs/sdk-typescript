// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * Proofs of possession (RFC 9449, DPoP) in the one profile the API verifies.
 * A proof is a compact JWS of type `dpop+jwt`, signed `EdDSA` (Ed25519) or
 * `ES256` (ECDSA P-256), whose header carries the public key's JWK and
 * nothing else, and whose claims name one request: a fresh 128-bit `jti`,
 * the method (`htm`), the URL as scheme, host and path (`htu`), the time
 * (`iat`), the hash of the access token presented (`ath`), the hash of the
 * raw query (`htq`), the request's `Content-Digest` (`htd`) and the hash of
 * the headers that change what the request means (`hth`). WebCrypto alone
 * signs and hashes, so a private key may be non-extractable.
 */
import { encodeBase64 } from "../resource/base64.js";

/** The algorithms a proof is signed with. */
export type ProofAlgorithm = "EdDSA" | "ES256";

/** The public half of a key as a JSON Web Key, public members only. */
export interface PublicJwk {
  readonly kty: "OKP" | "EC";
  readonly crv: "Ed25519" | "P-256";
  readonly x: string;
  readonly y?: string;
}

/** What a proof states about a key, derived once per key. */
interface KeyProfile {
  readonly alg: ProofAlgorithm;
  readonly jwk: PublicJwk;
  /** The base64url protected header every proof by the key carries. */
  readonly header: string;
  /** The RFC 7638 SHA-256 thumbprint of `jwk`, unpadded base64url. */
  readonly thumbprint: string;
}

/**
 * The request headers a proof's `hth` covers, in the order it covers them:
 * every client header a service reads to decide what an operation does.
 */
export const SEMANTIC_HEADERS = [
  "content-type",
  "idempotency-key",
  "if-match",
  "if-none-match",
  "last-event-id",
] as const;

/** The sentence an unsupported key is refused with. */
const UNSUPPORTED_KEY = "must be an Ed25519 or ECDSA P-256 key pair";

/** Each public key's profile, exported and hashed once. */
const profiles = new WeakMap<CryptoKey, Promise<KeyProfile>>();

/**
 * Reports why `key` cannot sign proofs, or `undefined` when it can: it must
 * be a WebCrypto key pair of one Ed25519 or ECDSA P-256 key whose private
 * half may sign. The wording completes a sentence that names the key's
 * origin.
 */
export function keyPairProblem(key: unknown): string | undefined {
  if (typeof key !== "object" || key === null) return "is required";
  const { publicKey, privateKey } = key as Partial<CryptoKeyPair>;
  if (!isCryptoKey(publicKey) || !isCryptoKey(privateKey)) {
    return "must be a CryptoKeyPair";
  }
  if (publicKey.type !== "public" || privateKey.type !== "private") {
    return "must be a CryptoKeyPair";
  }
  const algorithm = algorithmOf(publicKey);
  if (algorithm === undefined || algorithmOf(privateKey) !== algorithm) {
    return UNSUPPORTED_KEY;
  }
  if (!privateKey.usages.includes("sign")) {
    return "has a private key that may not sign";
  }
  return undefined;
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<CryptoKey>).type === "string" &&
    typeof (value as Partial<CryptoKey>).algorithm === "object" &&
    Array.isArray((value as Partial<CryptoKey>).usages)
  );
}

/** The proof algorithm a key's WebCrypto algorithm signs with, if any. */
function algorithmOf(key: CryptoKey): ProofAlgorithm | undefined {
  const algorithm = key.algorithm as Partial<EcKeyAlgorithm>;
  if (algorithm.name === "Ed25519") return "EdDSA";
  if (algorithm.name === "ECDSA" && algorithm.namedCurve === "P-256") {
    return "ES256";
  }
  return undefined;
}

/**
 * The profile of a public key: its JWK, algorithm, protected header and
 * thumbprint. The JWK is exported once per key and kept while the key is;
 * a failed export is not kept. Throws a `TypeError` for a key that is not
 * an Ed25519 or P-256 public key, or whose public half cannot be exported.
 */
export async function keyProfile(publicKey: CryptoKey): Promise<KeyProfile> {
  let profile = profiles.get(publicKey);
  if (profile === undefined) {
    profile = deriveProfile(publicKey);
    profiles.set(publicKey, profile);
    profile.catch(() => {
      profiles.delete(publicKey);
    });
  }
  return await profile;
}

async function deriveProfile(publicKey: CryptoKey): Promise<KeyProfile> {
  const alg =
    isCryptoKey(publicKey) && publicKey.type === "public"
      ? algorithmOf(publicKey)
      : undefined;
  if (alg === undefined) throw new TypeError(`key ${UNSUPPORTED_KEY}`);
  let exported: JsonWebKey;
  try {
    exported = await crypto.subtle.exportKey("jwk", publicKey);
  } catch (cause) {
    throw new TypeError("key's public half cannot be exported", { cause });
  }
  const jwk = publicMembers(exported, alg);
  const header = base64url(
    new TextEncoder().encode(
      JSON.stringify({ typ: "dpop+jwt", alg, jwk: orderedJwk(jwk) }),
    ),
  );
  return Object.freeze({
    alg,
    jwk,
    header,
    thumbprint: await thumbprintOf(jwk),
  });
}

/** The public members of an exported JWK, judged for shape. */
function publicMembers(exported: JsonWebKey, alg: ProofAlgorithm): PublicJwk {
  const { kty, crv, x, y } = exported;
  if (alg === "EdDSA") {
    if (kty === "OKP" && crv === "Ed25519" && coordinate(x)) {
      return Object.freeze({ kty, crv, x });
    }
  } else if (
    kty === "EC" &&
    crv === "P-256" &&
    coordinate(x) &&
    coordinate(y)
  ) {
    return Object.freeze({ kty, crv, x, y });
  }
  throw new TypeError(`key ${UNSUPPORTED_KEY}`);
}

/** Whether `value` is 32 bytes as unpadded base64url. */
export function coordinate(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

/** A JWK with its members in the order a proof header writes them. */
function orderedJwk(jwk: PublicJwk): PublicJwk {
  return jwk.y === undefined
    ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x }
    : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/**
 * The RFC 7638 SHA-256 thumbprint of a public JWK, unpadded base64url: the
 * hash of its required members in lexicographic order.
 */
export async function thumbprintOf(jwk: PublicJwk): Promise<string> {
  const canonical =
    jwk.y === undefined
      ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
      : { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return await hash(JSON.stringify(canonical));
}

/** What one proof names. */
export interface ProofRequest {
  readonly method: string;
  /** The URL the request is sent to, as `fetch` receives it. */
  readonly url: URL;
  /**
   * The {@link hash} of the access token the request presents; absent when
   * it presents none, or presents a refresh token, which its key alone binds.
   */
  readonly ath?: string;
  /** The request's `Content-Digest`; absent for a request that sends none. */
  readonly contentDigest?: string;
  /** The request's headers, whose semantic members `hth` covers. */
  readonly headers: Headers;
  /** The time the proof states, in milliseconds since the epoch. */
  readonly now: number;
}

/**
 * Signs a proof for one request with `key`, a key pair `keyPairProblem`
 * admits. Every call states a fresh `jti`, so no two proofs are alike.
 */
export async function prove(
  key: CryptoKeyPair,
  request: ProofRequest,
): Promise<string> {
  const profile = await keyProfile(key.publicKey);
  const { url } = request;
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const semantic = semanticHeaders(request.headers);
  const claims = {
    jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
    htm: request.method,
    htu: `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`,
    iat: Math.floor(request.now / 1000),
    ...(request.ath === undefined ? {} : { ath: request.ath }),
    ...(query === "" ? {} : { htq: await hash(query) }),
    ...(request.contentDigest === undefined
      ? {}
      : { htd: request.contentDigest }),
    ...(semantic === "" ? {} : { hth: await hash(semantic) }),
  };
  const signed = `${profile.header}.${base64url(
    new TextEncoder().encode(JSON.stringify(claims)),
  )}`;
  return `${signed}.${base64url(await sign(key.privateKey, profile.alg, signed))}`;
}

/**
 * The text `hth` hashes: `<name>:<value>\n` for each semantic header the
 * request carries, in {@link SEMANTIC_HEADERS} order; empty when it carries
 * none.
 */
export function semanticHeaders(headers: Headers): string {
  let text = "";
  for (const name of SEMANTIC_HEADERS) {
    const value = headers.get(name);
    if (value !== null) text += `${name}:${value}\n`;
  }
  return text;
}

/**
 * Signs `message`: Ed25519 over the message itself, ES256 over its SHA-256
 * as the 64-byte r||s of RFC 7518 §3.4, which is WebCrypto's own encoding.
 */
async function sign(
  privateKey: CryptoKey,
  alg: ProofAlgorithm,
  message: string,
): Promise<Uint8Array> {
  const data = new TextEncoder().encode(message);
  let signature: ArrayBuffer;
  try {
    signature =
      alg === "EdDSA"
        ? await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data)
        : await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            privateKey,
            data,
          );
  } catch (cause) {
    throw new TypeError("credential key could not sign the proof", { cause });
  }
  const bytes = new Uint8Array(signature);
  if (bytes.byteLength !== 64) {
    throw new TypeError("credential key returned a malformed signature");
  }
  return bytes;
}

/** The unpadded base64url SHA-256 of `text`'s UTF-8 bytes. */
export async function hash(text: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  );
}

/** The RFC 9530 `Content-Digest` of `body`, in its `sha-256` form. */
export async function contentDigest(body: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>),
  );
  return `sha-256=:${encodeBase64(digest)}:`;
}

/** Unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
  return encodeBase64(bytes)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

/** Reads unpadded base64url strictly; `undefined` for any other text. */
export function decodeBase64url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) {
    return undefined;
  }
  const binary = atob(
    text.replace(/-/gu, "+").replace(/_/gu, "/") +
      "=".repeat((4 - (text.length % 4)) % 4),
  );
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  // A second spelling of the same bytes, with stray low bits in the last
  // character, is not the canonical encoding.
  return base64url(bytes) === text ? bytes : undefined;
}

/**
 * The clock proofs state: the local clock plus the offset the API's last
 * `Date` header showed, so a skewed local clock does not make proofs stale.
 * One clock is shared by every transport of a client.
 */
export class ProofClock {
  #offsetMs = 0;

  /** The API's time now, in milliseconds since the epoch, as best known. */
  now(): number {
    return Date.now() + this.#offsetMs;
  }

  /** Learns the API's clock from a response's `Date` header, when it has one. */
  observe(response: Response): void {
    const date = response.headers.get("date");
    if (date === null) return;
    const at = Date.parse(date);
    if (Number.isFinite(at)) this.#offsetMs = at - Date.now();
  }
}

/**
 * Whether `response` refused the request's proof, as a proof that stated a
 * skewed time is refused: a 401 whose `WWW-Authenticate` names
 * `invalid_dpop_proof`.
 */
export function proofRefused(response: Response): boolean {
  return (
    response.status === 401 &&
    (response.headers.get("www-authenticate") ?? "").includes(
      'error="invalid_dpop_proof"',
    )
  );
}
