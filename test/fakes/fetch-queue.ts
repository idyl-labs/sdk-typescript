// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * A recorded fake `fetch`. Every call is recorded before a queued handler
 * answers it, so a test asserts on the request the SDK made rather than on
 * what a fake chose to return. Handlers are consumed in order; an unqueued
 * request is answered with a rejection the SDK surfaces, never with a throw
 * that fails the test from inside the fake.
 */
export interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  /** The request body as sent, or `undefined` when none was sent. */
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly init: RequestInit;
}

export type Handler = (
  request: RecordedRequest,
) => Response | Promise<Response>;

export class FetchQueue {
  readonly requests: RecordedRequest[] = [];
  readonly #handlers: Handler[] = [];

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
    const handler = this.#handlers.shift();
    if (handler === undefined) {
      throw new Error(`unexpected request: ${request.method} ${url.href}`);
    }
    return await handler(request);
  };

  /** Queues a JSON response. */
  respondJson(body: unknown, status = 200, headers?: HeadersInit): void {
    this.#handlers.push(
      () =>
        new Response(status === 204 ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...toRecord(headers) },
        }),
    );
  }

  /** Queues a raw text response. */
  respondText(text: string, status = 200, headers?: HeadersInit): void {
    this.#handlers.push(
      () => new Response(text, { status, headers: toRecord(headers) }),
    );
  }

  /** Queues a handler that builds the response from the recorded request. */
  respond(handler: Handler): void {
    this.#handlers.push(handler);
  }

  /** Fails when a queued response was never consumed. */
  assertExhausted(): void {
    if (this.#handlers.length !== 0) {
      throw new Error(
        `${String(this.#handlers.length)} queued responses were not consumed`,
      );
    }
  }
}

/**
 * A `fetch` held to the receiver rule, and the receiver and the init of
 * every call.
 */
export interface ReceiverCheckedFetch {
  readonly fetch: typeof globalThis.fetch;
  /** The receiver of every call, in order, refused calls included. */
  readonly receivers: unknown[];
  /**
   * The init of every call, in order and index for index with `receivers`,
   * refused calls included: the object the SDK handed to `fetch`, as it
   * handed it.
   */
  readonly inits: (RequestInit | undefined)[];
}

/**
 * Wraps `queue.fetch` in a `fetch` that enforces the receiver rule a
 * browser's does. A browser implements `fetch` as an operation of its global
 * object: a call whose receiver is that global, `undefined`, or `null`
 * proceeds, and a call through any other receiver, such as the object a
 * stored reference is invoked on, rejects with `TypeError: Illegal
 * invocation` before any request is made. This wrapper admits `undefined`
 * alone, the receiver a detached call has and the one the SDK guarantees an
 * injected implementation sees, and records every receiver and every init so
 * a test asserts on them. A call that passes the rule is answered by `queue`.
 */
export function receiverCheckedFetch(queue: FetchQueue): ReceiverCheckedFetch {
  const receivers: unknown[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetch = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    receivers.push(this);
    inits.push(init);
    if (this !== undefined) {
      return Promise.reject(new TypeError("Illegal invocation"));
    }
    return queue.fetch(input, init);
  };
  return { fetch, receivers, inits };
}

/** A body that fails every read, and the count of reads attempted on it. */
export interface UnreadBody {
  readonly stream: ReadableStream<Uint8Array>;
  /** How many reads were attempted; a body the SDK never read reports 0. */
  readonly reads: () => number;
}

/**
 * A body that fails every read and counts the attempts, so a test proves
 * the SDK never read it. The stream pulls only on demand, with a zero
 * high-water mark, so constructing it, wrapping it in a `Response`, and
 * cancelling it read nothing; only a reader's `read()` counts.
 */
export function unreadBody(): UnreadBody {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads += 1;
        controller.error(new Error("body read"));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, reads: () => reads };
}

/**
 * A redirect as a runtime hands one back under `redirect: "manual"`: the
 * 3xx response itself for a `status` of 300 through 399, or a browser's
 * opaque redirect, `type` `opaqueredirect` with status 0, for a `status` of
 * 0. Both carry `location`, a request ID naming the same peer, and `body`,
 * more than a browser's opaque redirect exposes, so a test proves that none
 * of them is read. `Response` cannot be constructed with status 0, so the
 * opaque shape is built from the members the SDK may consult.
 */
export function redirectResponse(
  status: number,
  location: string,
  body: ReadableStream<Uint8Array>,
): Response {
  const headers = new Headers({
    location,
    "x-request-id": `req-${new URL(location).host}`,
  });
  if (status === 0) {
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers,
      body,
    };
    return opaque as unknown as Response;
  }
  return new Response(body, { status, headers });
}

function toRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined) return record;
  for (const [name, value] of new Headers(headers)) record[name] = value;
  return record;
}

/** Synthetic identities shared by the tests. */
export const accountId = "550000000001";
export const subnetSlug = "550000000002";
export const otherSubnetSlug = "550000000004";
export const network = "example.test";
export const apiEndpoint = "https://api.example.test";
export const subnetEndpoint = "https://zone-a.example.com";
