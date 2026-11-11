// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * A recorded fake IDYL API. It serves what a test registers through
 * `routes` and answers every other request with a 404 error envelope, never
 * with a throw that fails the test from inside the fake. Its Computer API
 * origin is the place the test client's Account is assigned, so every
 * Computer request reaches this same fake.
 *
 * Every request is recorded before it is answered, so a test asserts on the
 * request the SDK made.
 */
import {
  accountId,
  network,
  subnetEndpoint,
  subnetSlug,
} from "./fetch-queue.js";
import type { RecordedRequest } from "./fetch-queue.js";
import { testClient } from "./client.js";
import type { TestClient, TestClientConfig } from "./client.js";

/** The Namespace fake-backed clients use unless a test says otherwise. */
export const namespace = "agents";
/** The host of the Computer API the fake serves. */
export const subnetHost = new URL(subnetEndpoint).host;
/** The host of the global API the fake serves. */
export const apiHost = `api.${network}`;
/** The Namespace-scoped prefix of the Computer routes. */
export const namespacePathPrefix = `/v1/accounts/${accountId}/namespaces/${namespace}`;
/** The account-wide prefix of the Computer API's routes. */
export const subnetPathPrefix = `/v1/accounts/${accountId}/subnets/${subnetSlug}`;

/** A handler that answers a request, or declines it with `undefined`. */
export type RouteHandler = (
  request: RecordedRequest,
  body: unknown,
) => Response | undefined | Promise<Response | undefined>;

export interface ControlPlaneOptions {
  /** Answers requests; a request it declines is answered with 404. */
  readonly routes?: RouteHandler;
}

export class FakeControlPlane {
  readonly requests: RecordedRequest[] = [];
  readonly #options: ControlPlaneOptions;

  constructor(options: ControlPlaneOptions = {}) {
    this.#options = options;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const headers = new Headers(
      input instanceof Request ? input.headers : init.headers,
    );
    const request: RecordedRequest = {
      url,
      method: init.method ?? (input instanceof Request ? input.method : "GET"),
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
      signal: init.signal ?? undefined,
      init,
    };
    this.requests.push(request);
    let body: unknown;
    if (request.body !== undefined) {
      try {
        body = JSON.parse(request.body);
      } catch {
        return errorResponse(400, "invalid_json", "request body is not JSON");
      }
    }
    const answer = (async (): Promise<Response> => {
      const custom = await this.#options.routes?.(request, body);
      return custom ?? notFound();
    })();
    return await abortable(answer, request.signal);
  };

  /**
   * A client addressing this fake. Fields left unset take the fake's
   * Network, the test Account, the test Namespace, and the test
   * credential, so a test states only what it is varying.
   */
  client(overrides: TestClientConfig = {}): TestClient {
    return testClient({ namespace, fetch: this.fetch, ...overrides });
  }

  /** The requests the SDK sent to the Computer API host, in order. */
  subnetRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url.host === subnetHost);
  }
}

/**
 * Settles with the answer unless `signal` aborts first, in which case it
 * rejects with the signal's reason, as `fetch` does. The answer itself is
 * left to settle on its own; a test that held it open releases it.
 */
export async function abortable(
  answer: Promise<Response>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (signal === undefined) return await answer;
  if (signal.aborted) throw asError(signal.reason);
  return await new Promise<Response>((resolve, reject) => {
    const onAbort = (): void => {
      reject(asError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    answer.then(
      (response) => {
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(asError(error));
      },
    );
  });
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** A JSON response. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The API's error envelope with the given status and code. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return json({ error: message, code }, status);
}

function notFound(): Response {
  return errorResponse(404, "not_found", "not found");
}
