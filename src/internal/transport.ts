// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { parseJson, stringifyJson } from "../resource/json.js";
/*
 * The HTTP layer. It builds a request against a base URL and a caller-supplied
 * path, presents the key-bound credential with a fresh proof of possession of
 * its key, reads the response under fixed size bounds, and turns a non-2xx
 * status into an ApiError. It knows nothing about IDYL routes: no path is
 * spelled here and no policy about which endpoint serves what lives here. It
 * decides only what is true of every request the SDK makes: every proof names
 * exactly the request it accompanies, credentials are never replayed across a
 * redirect, a response body cannot grow without bound, and an error body is
 * never trusted to be an envelope.
 */
import { errorMessage } from "../resource/validation.js";
import { clientIdentification, type ClientProduct } from "../client-product.js";
import type { Credential, CredentialSource } from "../credential.js";
import { tokenProblem } from "../credential.js";
import { type ApiError, apiError, TransportError } from "../errors.js";
import type { JsonObject, JsonValue } from "../resource/json.js";
import { abortable, managedSignal } from "./abort.js";
import { browserOwnsUserAgent } from "./browser.js";
import {
  contentDigest,
  hash,
  keyPairProblem,
  ProofClock,
  proofRefused,
  prove,
} from "./dpop.js";
import { DEFAULT_USER_AGENT } from "./version.js";

/** The default per-request timeout, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * The request header naming the one product a request is sent on behalf of,
 * as `<product>/<version>`. The API applies the minimum supported version of
 * exactly that product.
 */
const CLIENT_HEADER = "idyl-client";
/** The largest success body the transport reads, in bytes. */
export const MAX_SUCCESS_BODY_BYTES = 16 * 1024 * 1024;
/** The largest error body the transport reads, in bytes. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
/**
 * How much of a non-envelope error body is carried into the error message;
 * the rest is summarized by length.
 */
const MAX_FALLBACK_ERROR_MESSAGE_BYTES = 512;

/** The `fetch` function the transport calls. */
export type Fetch = typeof globalThis.fetch;

/** What builds a {@link Transport}. */
export interface TransportOptions {
  /**
   * Supplies the credential of every authenticated request. `undefined`
   * builds a transport whose authenticated requests are refused with a
   * `TypeError` before anything is sent.
   */
  readonly credential?: CredentialSource;
  /**
   * The clock proofs state, shared by the transports of one client so each
   * learns the API's time from every response. `undefined` gives the
   * transport a clock of its own.
   */
  readonly clock?: ProofClock;
  /**
   * Performs every request. It is called with no receiver, exactly as a
   * caller writing `fetch(url, init)` would call it, and is bound to
   * nothing. `undefined` uses `globalThis.fetch`; construction fails when
   * neither exists.
   */
  readonly fetch?: Fetch;
  /** Bounds each request, in milliseconds. `undefined` allows 30000. */
  readonly requestTimeoutMs?: number;
  /**
   * Overrides the `User-Agent`. `undefined` or blank sends the SDK default
   * where the SDK sends one: in a browser document the browser owns that
   * header and the default is left to it, while an explicit value is sent
   * on every runtime. See {@link browserOwnsUserAgent}.
   */
  readonly userAgent?: string;
  /**
   * The product named in the `Idyl-Client` header of every request.
   * `undefined` names the SDK itself. Construction throws an
   * `InvalidClientProductError` when it is partially set or malformed.
   */
  readonly clientProduct?: ClientProduct;
  /** Admits `http:` base URLs, for local development and tests only. */
  readonly allowHttp?: boolean;
}

/** Per-request options. */
export interface RequestOptions {
  /** Cancels the request, the credential lookup, and the body read. */
  readonly signal?: AbortSignal;
  /** Encoded as the JSON request body; absent sends no body. */
  readonly body?: unknown;
  /**
   * `json` decodes exactly one JSON value; `none` expects no body and drains
   * one if present. `undefined` reads `json`.
   */
  readonly response?: "json" | "none";
  /** Additional request headers, added after the SDK's own. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Refuses a request whose encoded body exceeds this many bytes, with a
   * `TypeError` naming the size and the bound, before any credential is
   * consulted or byte is sent. `undefined` sends a body of any size.
   */
  readonly maxRequestBodyBytes?: number;
  /**
   * The disclosure allow-list of a route that carries secret material. The
   * status and the stable code of an error always reach the caller; the
   * server's message and details reach it only when this reports the code
   * as safe, and every other message is replaced with a fixed one so no
   * server-controlled text can carry material into a caller's logs.
   * `undefined` relays every message.
   */
  readonly safeErrorCode?: (code: string) => boolean;
}

/**
 * The errors raised because the injected `fetch` itself rejected: the
 * exchange failed before any response, as a refused connection, a reset, a
 * failed name lookup, or a TLS failure does. They are recorded by identity
 * so the error a caller receives stays a plain `Error`.
 */
const fetchFailures = new WeakSet<Error>();

/**
 * Whether `error` is a request whose `fetch` rejected before any response:
 * a failure of the connection rather than an answer from the platform.
 */
export function isFetchFailure(error: unknown): boolean {
  return error instanceof Error && fetchFailures.has(error);
}

/**
 * What an identity exchange presents in place of the credential source's
 * credential: the key it proves and, when it has one, the refresh token
 * bound to that key. A refresh token is bound by its key alone, so a proof
 * that presents one names no token hash.
 */
export interface Presentation {
  readonly key: CryptoKeyPair;
  readonly refreshToken?: string;
}

/** What one request presents: a key, and the token bound to it if any. */
interface Presented {
  readonly key: CryptoKeyPair;
  readonly token?: string;
  /** The hash of an access token, which the proof names as `ath`. */
  readonly ath?: string;
}

/** How a request authenticates. */
type Authentication = "source" | "anonymous" | Presentation;

/**
 * Performs JSON requests. One instance is shared by a client and every client
 * scoped from it, and it is safe to use concurrently.
 */
export class Transport {
  readonly #credential: CredentialSource | undefined;
  readonly #clock: ProofClock;
  readonly #fetch: Fetch;
  readonly #requestTimeoutMs: number;
  readonly #userAgent: string | undefined;
  readonly #clientIdentification: string;
  readonly #allowHttp: boolean;
  /** The last access token presented and its hash, computed once per token. */
  #ath: { readonly token: string; readonly hash: Promise<string> } | undefined;

  constructor(options: TransportOptions) {
    if (
      options.credential !== undefined &&
      typeof (options.credential as Partial<CredentialSource>).credential !==
        "function"
    ) {
      throw new TypeError("credential must be a CredentialSource");
    }
    const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new TypeError("requestTimeoutMs must be greater than zero");
    }
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") {
      throw new TypeError(
        "fetch is unavailable in this runtime; supply one in the configuration",
      );
    }
    const userAgent = options.userAgent?.trim() ?? "";
    this.#clientIdentification = clientIdentification(options.clientProduct);
    this.#credential = options.credential;
    this.#clock = options.clock ?? new ProofClock();
    this.#fetch = fetchImplementation;
    this.#requestTimeoutMs = timeout;
    this.#userAgent =
      userAgent !== ""
        ? userAgent
        : browserOwnsUserAgent()
          ? undefined
          : DEFAULT_USER_AGENT;
    this.#allowHttp = options.allowHttp ?? false;
  }

  /**
   * Sends an authenticated request to `origin` + `path` and decodes its JSON
   * response. `path` begins with a slash and may carry a query string. The
   * credential source is consulted once for this request under the
   * request's signal, so a cancelled request never leaves a token lookup
   * running, and every attempt carries a proof of its own.
   */
  async json<T>(
    method: string,
    origin: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    return (await this.#send(method, origin, path, options, "source")) as T;
  }

  /**
   * Sends a request with no credential and no proof. It exists for the
   * documented identity endpoints and the network's public metadata and
   * Computer sizes, whose contract is anonymous; every other request goes
   * through {@link json}.
   */
  async anonymousJson<T>(
    method: string,
    origin: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    return (await this.#send(method, origin, path, options, "anonymous")) as T;
  }

  /**
   * Sends an identity exchange: a request that proves `presentation.key`
   * and presents the refresh token bound to it, or no token at all, in
   * place of the credential source's credential. The refresh token and the
   * key are judged before anything is sent, and a refusal never names the
   * token.
   */
  async exchangeJson<T>(
    method: string,
    origin: string,
    path: string,
    presentation: Presentation,
    options: RequestOptions = {},
  ): Promise<T> {
    return (await this.#send(method, origin, path, options, presentation)) as T;
  }

  /**
   * Opens caller-owned saved content with caller cancellation and no transfer
   * timeout. `conditions` are request headers such as `Range`; judging the
   * answer to them is the caller's.
   */
  async openContent(
    origin: string,
    path: string,
    accept: string,
    signal: AbortSignal | undefined,
    conditions?: Readonly<Record<string, string>>,
    method = "GET",
  ): Promise<Response> {
    return await this.#content(
      method,
      origin,
      path,
      accept,
      undefined,
      undefined,
      signal,
      conditions,
    );
  }

  /**
   * Sends a body and reads one bounded JSON receipt. Bytes are sent as they
   * are, which every runtime supports; a stream is sent as a streaming
   * request body, which not every browser does. Neither carries a
   * `Content-Digest`: a transfer part's integrity rides the digest its query
   * names, which the proof covers.
   */
  async sendContent(
    origin: string,
    path: string,
    contentType: string,
    body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const response = await this.#content(
      "PUT",
      origin,
      path,
      "application/json",
      contentType,
      body,
      signal,
    );
    return decodeOne(
      await bodyRead("PUT", signal ?? new AbortController().signal, () =>
        readBodyLimited(response, MAX_SUCCESS_BODY_BYTES),
      ),
    );
  }

  async #content(
    method: string,
    origin: string,
    path: string,
    accept: string,
    contentType: string | undefined,
    body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> | undefined,
    signal: AbortSignal | undefined,
    conditions?: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const target = resolveTarget(origin, path, this.#allowHttp);
    const requestSignal = signal ?? new AbortController().signal;
    requestSignal.throwIfAborted();
    const headers = new Headers({ accept, ...conditions });
    if (this.#userAgent !== undefined)
      headers.set("user-agent", this.#userAgent);
    headers.set(CLIENT_HEADER, this.#clientIdentification);
    if (contentType !== undefined) headers.set("content-type", contentType);
    const presented = await this.#sourceCredential(requestSignal);
    const init: RequestInit & {
      readonly signal: AbortSignal;
      readonly headers: Headers;
      readonly duplex?: "half";
    } = {
      method,
      headers,
      signal: requestSignal,
      ...(body === undefined
        ? {}
        : body instanceof ReadableStream
          ? { body, duplex: "half" as const }
          : { body }),
    };
    const failure = `${method} content transfer failed`;
    // A stream is read as it is sent, so only a request whose body can be
    // sent again is retried after a refused proof.
    const replayable = !(body instanceof ReadableStream);
    let response = await this.#attempt(target, init, presented, failure);
    if (replayable && proofRefused(response)) {
      await discardBody(response);
      response = await this.#attempt(target, init, presented, failure);
    }
    if (!response.ok) throw await decodeApiError(response);
    return response;
  }

  /**
   * The credential source's credential for one request, resolved under
   * `signal` and judged for shape. Throws a `TypeError` naming the source
   * when it returns something that cannot be presented, and when the
   * transport has no source at all.
   */
  async #sourceCredential(signal: AbortSignal): Promise<Presented> {
    const source = this.#credential;
    if (source === undefined) {
      throw new TypeError("credential is required for authenticated requests");
    }
    const credential: unknown = await abortable(
      Promise.resolve()
        .then(() => source.credential({ signal }))
        .catch((cause: unknown) => {
          // A source that rejects with something other than an error is
          // reported as its own failure, the rejection kept as the cause.
          throw cause instanceof Error
            ? cause
            : new TypeError("credential source rejected", { cause });
        }),
      signal,
    );
    if (typeof credential !== "object" || credential === null) {
      throw new TypeError("credential source returned no credential");
    }
    const { accessToken, key } = credential as Partial<Credential>;
    if (typeof accessToken !== "string") {
      throw new TypeError(
        "credential source returned a non-string access token",
      );
    }
    const problem = tokenProblem(accessToken);
    if (problem !== undefined) {
      throw new TypeError(
        `credential source returned an access token that ${problem}`,
      );
    }
    if (key === undefined) {
      throw new TypeError("credential source returned no key");
    }
    const keyProblem = keyPairProblem(key);
    if (keyProblem !== undefined) {
      throw new TypeError(
        `credential source returned a key that ${keyProblem}`,
      );
    }
    return { key, token: accessToken, ath: await this.#hashOf(accessToken) };
  }

  /** The hash of an access token, computed once while it is the current one. */
  async #hashOf(token: string): Promise<string> {
    if (this.#ath?.token !== token) {
      this.#ath = { token, hash: hash(token) };
    }
    return await this.#ath.hash;
  }

  /**
   * One attempt of a request: the credential's headers and a fresh proof
   * for exactly this request, set last so the proof covers the headers the
   * request carries, then the request itself. `digest` is the request body's
   * `Content-Digest`, sent and proved with it.
   */
  async #attempt(
    target: URL,
    init: RequestInit & {
      readonly signal: AbortSignal;
      readonly headers: Headers;
    },
    presented: Presented | undefined,
    failure: string,
    digest?: string,
  ): Promise<Response> {
    if (presented !== undefined) {
      const { headers } = init;
      if (presented.token === undefined) headers.delete("authorization");
      else headers.set("authorization", `DPoP ${presented.token}`);
      if (digest !== undefined) headers.set("content-digest", digest);
      headers.set(
        "dpop",
        await prove(presented.key, {
          method: init.method ?? "GET",
          url: target,
          headers,
          now: this.#clock.now(),
          ...(presented.ath === undefined ? {} : { ath: presented.ath }),
          ...(digest === undefined ? {} : { contentDigest: digest }),
        }),
      );
      // Signing completes off the caller's turn; a request cancelled
      // meanwhile is never sent.
      if (init.signal.aborted) throw init.signal.reason;
    }
    return await this.#dispatch(target, init, failure);
  }

  /**
   * Performs one request through the configured `fetch` and returns a
   * response that is not a redirect. `init` is sent with `redirect` set to
   * `manual`, the one mode every runtime accepts, so a redirect the server
   * chose is handed back instead of followed, and it is refused here before
   * anything else about the response is consulted: a response whose `type`
   * is `opaqueredirect`, the shape a browser hands back with status 0, or
   * whose status is 300 through 399 fails as a `TransportError` with code
   * `redirect_refused` and the fixed sentence `redirect refused`, its body
   * discarded unread and its headers never read, so no credential is
   * replayed, no second request is made, and nothing the redirecting peer
   * wrote reaches a caller's logs. Any other response's `Date` sets the
   * clock proofs state. `fetch` is called with no receiver: a
   * browser implements it as an operation of its global object and refuses
   * any other receiver with a `TypeError`, so the held function is never
   * invoked as a method of the transport, and an injected implementation is
   * called exactly as a caller writing `fetch(url, init)` would call it. A
   * `fetch` that rejects fails with `failure` as the message and the
   * rejection as `cause`, unless `init.signal` was aborted, in which case
   * the signal's reason is thrown.
   */
  async #dispatch(
    target: URL,
    init: RequestInit & { readonly signal: AbortSignal },
    failure: string,
  ): Promise<Response> {
    let response: Response;
    try {
      const fetchImplementation = this.#fetch;
      response = await fetchImplementation(target, {
        ...init,
        redirect: "manual",
      });
    } catch (cause) {
      if (init.signal.aborted) throw init.signal.reason;
      const error = new TransportError("network_error", failure, { cause });
      fetchFailures.add(error);
      throw error;
    }
    if (isRedirect(response)) {
      await discardBody(response);
      throw new TransportError("redirect_refused", "redirect refused");
    }
    this.#clock.observe(response);
    return response;
  }

  async #send(
    method: string,
    origin: string,
    path: string,
    options: RequestOptions,
    authentication: Authentication,
  ): Promise<unknown> {
    const target = resolveTarget(origin, path, this.#allowHttp);
    const explicit =
      typeof authentication === "object"
        ? presentationOf(authentication)
        : undefined;
    const managed = managedSignal(
      options.signal,
      this.#requestTimeoutMs,
      `request exceeded ${String(this.#requestTimeoutMs)} ms`,
    );
    try {
      managed.signal.throwIfAborted();
      let body: string | undefined;
      if (options.body !== undefined) {
        body = stringifyJson(options.body as JsonValue);
        const limit = options.maxRequestBodyBytes;
        if (limit !== undefined) {
          const size = new TextEncoder().encode(body).byteLength;
          if (size > limit) {
            throw new TypeError(
              `request body is ${String(size)} bytes, maximum is ${String(limit)}`,
            );
          }
        }
      }
      const headers = new Headers({ accept: "application/json" });
      if (this.#userAgent !== undefined) {
        headers.set("user-agent", this.#userAgent);
      }
      if (body !== undefined) headers.set("content-type", "application/json");
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        headers.set(name, value);
      }
      // Set last so a request names exactly one product whatever extra
      // headers it carries.
      headers.set(CLIENT_HEADER, this.#clientIdentification);
      const presented =
        authentication === "source"
          ? await this.#sourceCredential(managed.signal)
          : explicit;
      // `fetch` sends a string body as its UTF-8 bytes, the bytes the
      // digest is computed over.
      const digest =
        presented === undefined || body === undefined
          ? undefined
          : await contentDigest(new TextEncoder().encode(body));
      const init = {
        method,
        headers,
        signal: managed.signal,
        ...(body === undefined ? {} : { body }),
      };
      const failure = `${method} request failed`;
      let response = await this.#attempt(
        target,
        init,
        presented,
        failure,
        digest,
      );
      // A proof refused, as one stating a skewed time is, is retried once
      // with a fresh proof at the clock the refusal's `Date` set.
      if (presented !== undefined && proofRefused(response)) {
        await discardBody(response);
        response = await this.#attempt(
          target,
          init,
          presented,
          failure,
          digest,
        );
      }
      if (!response.ok) {
        throw await decodeApiError(response, options.safeErrorCode);
      }
      if (options.response === "none" || response.status === 204) {
        await bodyRead(method, managed.signal, () =>
          drainBody(response, MAX_SUCCESS_BODY_BYTES),
        );
        return undefined;
      }
      const bytes = await bodyRead(method, managed.signal, () =>
        readBodyLimited(response, MAX_SUCCESS_BODY_BYTES),
      );
      return decodeOne(bytes);
    } catch (error) {
      // The request timeout aborts the managed signal while the caller's own
      // signal stays live; only that abort is the transport's timeout.
      if (managed.signal.aborted && options.signal?.aborted !== true) {
        throw new TransportError(
          "timeout",
          `request exceeded ${String(this.#requestTimeoutMs)} ms`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      managed.cleanup();
    }
  }
}

/**
 * An identity exchange's presentation, judged before anything is sent: a
 * refresh token, when there is one, that can be presented, and a key pair
 * that can sign. A refusal names the field, never the token.
 */
function presentationOf(presentation: Presentation): Presented {
  const { key, refreshToken } = presentation;
  if (refreshToken !== undefined) {
    const problem =
      typeof refreshToken === "string"
        ? tokenProblem(refreshToken)
        : "is required";
    if (problem !== undefined) throw new TypeError(`refresh token ${problem}`);
  }
  const problem = keyPairProblem(key);
  if (problem !== undefined) throw new TypeError(`key ${problem}`);
  return refreshToken === undefined ? { key } : { key, token: refreshToken };
}

function resolveTarget(origin: string, path: string, allowHttp: boolean): URL {
  if (!path.startsWith("/")) {
    throw new TypeError(
      `request path ${JSON.stringify(path)} must begin with /`,
    );
  }
  const base = new URL(origin);
  if (base.protocol !== "https:" && !(allowHttp && base.protocol === "http:")) {
    throw new TypeError("request origin must use https");
  }
  const target = new URL(path, base);
  if (target.origin !== base.origin) {
    throw new TypeError("request path must not change the origin");
  }
  target.hash = "";
  return target;
}

/**
 * Reads a non-2xx response as an ApiError. With `safeErrorCode`, the body
 * is held to the disclosure posture of a secret-carrying route: the status
 * and the code are always relayed, and the message and details only under
 * a code the allow-list names; anything else, a code outside the list or a
 * body that is not the envelope at all, is replaced with a fixed message.
 */
async function decodeApiError(
  response: Response,
  safeErrorCode?: (code: string) => boolean,
): Promise<ApiError> {
  const metadata = responseMetadata(response);
  let bytes: Uint8Array;
  try {
    bytes = await readBodyLimited(response, MAX_ERROR_BODY_BYTES);
  } catch (cause) {
    return apiError({
      status: response.status,
      message: `API error response could not be read: ${errorMessage(cause)}`,
      ...metadata,
      cause,
    });
  }
  const text = decodeUtf8(bytes).trim();
  let envelope = parseErrorEnvelope(text);
  if (safeErrorCode !== undefined && !safeErrorCode(envelope.code ?? "")) {
    envelope = {
      error: "request failed",
      ...(envelope.code === undefined ? {} : { code: envelope.code }),
    };
  }
  let message = envelope.error;
  if (message === "") message = truncateFallbackErrorMessage(text);
  return apiError({
    status: response.status,
    message,
    ...(envelope.code === undefined ? {} : { code: envelope.code }),
    ...(envelope.details === undefined ? {} : { details: envelope.details }),
    ...metadata,
  });
}

interface ErrorEnvelope {
  readonly error: string;
  readonly code?: string;
  readonly details?: JsonObject;
}

/**
 * Reads the error envelope leniently: a body that is not one yields an empty
 * envelope rather than a failure, so the bounded raw text becomes the message.
 */
function parseErrorEnvelope(text: string): ErrorEnvelope {
  let body: unknown;
  try {
    body = text === "" ? undefined : parseJson(text);
  } catch {
    return { error: "" };
  }
  if (!isRecord(body)) return { error: "" };
  const error = typeof body["error"] === "string" ? body["error"].trim() : "";
  const code = typeof body["code"] === "string" ? body["code"] : undefined;
  const details = isRecord(body["details"]) ? body["details"] : undefined;
  return {
    error,
    ...(code === undefined ? {} : { code }),
    ...(details === undefined ? {} : { details }),
  };
}

function responseMetadata(response: Response): {
  readonly requestId?: string;
  readonly retryAfterMs?: number;
} {
  const requestId = response.headers.get("x-request-id");
  const retryAfterMs = parseRetryAfter(
    response.headers.get("retry-after"),
    Date.now(),
  );
  return {
    ...(requestId === null || requestId === "" ? {} : { requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

/**
 * Reads `Retry-After` as a non-negative number of delay seconds or as an HTTP
 * date. A date in the past yields zero; a header that is absent or unreadable
 * yields `undefined`. Only a value that names a month is read as a date, so a
 * malformed number is unreadable rather than a date invented from its digits.
 */
export function parseRetryAfter(
  raw: string | null,
  now: number,
): number | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (/^[0-9]+$/u.test(value)) return Number(value) * 1_000;
  if (!/[A-Za-z]/u.test(value)) return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}

function truncateFallbackErrorMessage(message: string): string {
  const bytes = new TextEncoder().encode(message);
  if (bytes.byteLength <= MAX_FALLBACK_ERROR_MESSAGE_BYTES) return message;
  const prefix = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, MAX_FALLBACK_ERROR_MESSAGE_BYTES),
    { stream: true },
  );
  return `${prefix}... (truncated, ${String(bytes.byteLength)} bytes total)`;
}

async function drainBody(response: Response, limit: number): Promise<void> {
  if (response.body === null) return;
  try {
    await readBodyLimited(response, limit);
  } catch {
    // A body that was not expected is discarded whatever its size.
  }
}

/**
 * Reports whether a response handed back under `redirect: "manual"` is a
 * redirect. A browser hands back an opaque redirect, `type` `opaqueredirect`
 * with status 0 and nothing else; every other runtime hands back the 3xx
 * response itself.
 */
function isRedirect(response: Response): boolean {
  return (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status <= 399)
  );
}

/**
 * Releases a body that will not be read, so a runtime that holds a
 * connection open for an unconsumed body does not keep it. Cancelling
 * settles the stream without pulling a byte from it.
 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that refuses cancellation is left to the runtime; the
    // response is refused either way.
  }
}

/**
 * Reads the whole body, refusing one that declares or delivers more than
 * `limit` bytes. An over-limit stream is cancelled so the connection is not
 * left draining.
 */
async function readBodyLimited(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await response.body?.cancel();
    throw new TransportError(
      "response_too_large",
      `response body exceeds ${String(limit)} bytes`,
    );
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new TransportError(
          "response_too_large",
          `response body exceeds ${String(limit)} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Decodes exactly one JSON value. An empty body and a body carrying more than
 * one value are both rejected; unknown fields are carried as-is, which is the
 * read leniency the contract requires.
 */
function decodeOne(bytes: Uint8Array): unknown {
  const text = decodeUtf8(bytes);
  if (text.trim() === "") {
    throw new TransportError(
      "invalid_response",
      "decode response: empty response body",
    );
  }
  try {
    return parseJson(text);
  } catch (cause) {
    throw new TransportError(
      "invalid_response",
      "decode response: expected exactly one JSON value",
      { cause },
    );
  }
}

/**
 * Decodes a body as UTF-8, reading any byte sequence that is not as a
 * replacement character, as the reference contract reads it. A malformed byte is never a
 * reason to lose the status of an error response or to refuse a value the
 * server sent.
 */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads a response body. A read that fails because the connection did,
 * neither by an abort nor by the package's own bounds, is a
 * `TransportError` with code `network_error`, retried as a failed `fetch`
 * is.
 */
async function bodyRead<T>(
  method: string,
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (signal.aborted || cause instanceof TransportError) throw cause;
    throw bodyFailure(`${method} response body failed`, cause);
  }
}

/**
 * The `network_error` a body that broke off in transit is reported as,
 * recorded as a connection failure.
 */
export function bodyFailure(message: string, cause: unknown): TransportError {
  const error = new TransportError("network_error", message, { cause });
  fetchFailures.add(error);
  return error;
}
