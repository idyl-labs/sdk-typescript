// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * A proof verifier written apart from the package, as the API verifies a
 * proof: it parses the compact JWS, admits only the header the profile
 * names, imports the JWK the header carries with WebCrypto and checks the
 * signature with it, and judges the claims against the request that carried
 * them. Hashes are computed with the runtime's `node:crypto`, not the
 * package's.
 */
import { createHash } from "node:crypto";
import type { RecordedRequest } from "./fetch-queue.js";

/** A proof whose signature verified with the key its header carries. */
export interface VerifiedProof {
  readonly header: {
    readonly typ: string;
    readonly alg: string;
    readonly jwk: Readonly<Record<string, string>>;
  };
  readonly claims: Readonly<Record<string, unknown>>;
  /** The public key the header carries, as WebCrypto imported it. */
  readonly publicKey: CryptoKey;
}

/** The unpadded base64url SHA-256 of `value`. */
export function sha256url(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** The RFC 9530 `Content-Digest` of `body`. */
export function contentDigestOf(body: string | Uint8Array): string {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

function decodePart(part: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(part)) {
    throw new Error("proof part is not unpadded base64url");
  }
  return Uint8Array.from(Buffer.from(part, "base64url"));
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

/**
 * Verifies a proof with the public key its own header carries. Throws when
 * it is not a three-part compact JWS, when its header carries anything
 * beyond `typ`, `alg` and a public `jwk`, or when the signature does not
 * verify.
 */
export async function verifyProof(proof: string): Promise<VerifiedProof> {
  const parts = proof.split(".");
  if (parts.length !== 3) throw new Error("proof is not a compact JWS");
  const [rawHeader = "", rawClaims = "", rawSignature = ""] = parts;
  const header = JSON.parse(
    new TextDecoder().decode(decodePart(rawHeader)),
  ) as VerifiedProof["header"];
  if (!exactKeys(header, ["typ", "alg", "jwk"]) || header.typ !== "dpop+jwt") {
    throw new Error("proof header is not the profile's");
  }
  const { jwk } = header;
  const ed =
    header.alg === "EdDSA" &&
    jwk["kty"] === "OKP" &&
    jwk["crv"] === "Ed25519" &&
    exactKeys(jwk, ["kty", "crv", "x"]);
  const ec =
    header.alg === "ES256" &&
    jwk["kty"] === "EC" &&
    jwk["crv"] === "P-256" &&
    exactKeys(jwk, ["kty", "crv", "x", "y"]);
  if (!ed && !ec) throw new Error("proof alg and jwk do not match");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    ed ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  const signature = decodePart(rawSignature);
  if (ec && signature.byteLength !== 64) {
    throw new Error("ES256 signature is not 64 bytes of r||s");
  }
  const verified = await crypto.subtle.verify(
    ed ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    new TextEncoder().encode(`${rawHeader}.${rawClaims}`),
  );
  if (!verified) throw new Error("proof signature does not verify");
  const claims = JSON.parse(
    new TextDecoder().decode(decodePart(rawClaims)),
  ) as Record<string, unknown>;
  return { header, claims, publicKey };
}

/** The semantic headers `hth` covers, in order. */
const SEMANTIC = [
  "content-type",
  "idempotency-key",
  "if-match",
  "if-none-match",
  "last-event-id",
];

/**
 * Verifies the proof a recorded request carried and judges every claim
 * against the request itself, as the API does: `htm`, `htu`, a 128-bit
 * `jti`, `ath` exactly when an access token is presented (`access`),
 * `htq` exactly with a query, `htd` exactly with a `Content-Digest`, which
 * must be the digest of the body as sent, and `hth` exactly with a
 * semantic header. Returns the verified proof.
 */
export async function checkedProof(
  request: RecordedRequest,
  presents: "access" | "refresh" | "key",
): Promise<VerifiedProof> {
  const header = request.headers.get("dpop");
  if (header === null) throw new Error("request carries no DPoP proof");
  const proof = await verifyProof(header);
  const { claims } = proof;
  const expected: Record<string, unknown> = {
    jti: claims["jti"],
    htm: request.method,
    htu: `${request.url.protocol}//${request.url.host}${request.url.pathname}`,
    iat: claims["iat"],
  };
  const authorization = request.headers.get("authorization");
  if (presents === "key") {
    if (authorization !== null) throw new Error("a key proof sent a token");
  } else if (authorization?.startsWith("DPoP ") !== true) {
    throw new Error("request presents no DPoP token");
  }
  if (presents === "access" && authorization !== null) {
    expected["ath"] = sha256url(authorization.slice("DPoP ".length));
  }
  const query = request.url.search.slice(1);
  if (query !== "") expected["htq"] = sha256url(query);
  const digest = request.headers.get("content-digest");
  if (digest !== null) {
    if (digest !== contentDigestOf(request.body ?? "")) {
      throw new Error("Content-Digest is not the digest of the body");
    }
    expected["htd"] = digest;
  }
  let semantic = "";
  for (const name of SEMANTIC) {
    const value = request.headers.get(name);
    if (value !== null) semantic += `${name}:${value}\n`;
  }
  if (semantic !== "") expected["hth"] = sha256url(semantic);
  const jti = claims["jti"];
  if (typeof jti !== "string" || decodePart(jti).byteLength !== 16) {
    throw new Error("jti is not 128 bits of base64url");
  }
  if (!Number.isInteger(claims["iat"])) throw new Error("iat is not seconds");
  const actual = JSON.stringify(Object.entries(claims).sort());
  const wanted = JSON.stringify(Object.entries(expected).sort());
  if (actual !== wanted) {
    throw new Error(`proof claims ${actual} are not ${wanted}`);
  }
  return proof;
}
