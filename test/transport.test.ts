// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  TransportError,
  isApiCode,
  isApiStatus,
} from "../src/errors.js";
import type { Credential, CredentialSource } from "../src/credential.js";
import { Transport } from "../src/internal/transport.js";
import { DEFAULT_USER_AGENT } from "../src/internal/version.js";
import {
  apiEndpoint,
  FetchQueue,
  receiverCheckedFetch,
  redirectResponse,
  unreadBody,
} from "./fakes/fetch-queue.js";
import { proofsOnFakeTime, testCredential, testKey } from "./fakes/keys.js";
import { checkedProof } from "./fakes/proof.js";

const credential = testCredential;

/** A credential source that presents `accessToken` with the test key. */
function source(accessToken = "test-token"): {
  credential: ReturnType<typeof vi.fn<() => Credential>>;
} {
  return { credential: vi.fn(() => ({ accessToken, key: testKey })) };
}

function transport(
  queue: FetchQueue,
  overrides: Partial<ConstructorParameters<typeof Transport>[0]> = {},
): Transport {
  return new Transport({ credential, fetch: queue.fetch, ...overrides });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (error: unknown) => error,
  );
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("transport requests", () => {
  // Contract: every request carries accept, the access token in the DPoP
  // scheme with a proof of its key for exactly this request, the SDK user
  // agent, and a JSON content type and its Content-Digest when it has a
  // body.
  it("sends the SDK headers and the JSON body on the wire", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ ok: true });
    const result = await transport(queue).json<{ ok: boolean }>(
      "POST",
      apiEndpoint,
      "/v1/example?limit=1",
      { body: { name: "dev" } },
    );
    expect(result).toEqual({ ok: true });
    const request = queue.requests[0];
    expect(request?.url.href).toBe(
      "https://api.example.test/v1/example?limit=1",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("accept")).toBe("application/json");
    expect(request?.headers.get("authorization")).toBe("DPoP test-token");
    expect(request?.headers.get("user-agent")).toBe(DEFAULT_USER_AGENT);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.body).toBe('{"name":"dev"}');
    if (request === undefined) throw new Error("no request");
    await checkedProof(request, "access");
    queue.assertExhausted();
  });

  // Contract: an explicit anonymous request sends no Authorization header
  // and no proof, and never consults the credential source.
  it("sends anonymous requests without a credential", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ regions: [] });
    const unused = source("unused");
    await new Transport({
      credential: unused,
      fetch: queue.fetch,
    }).anonymousJson("GET", "https://meta.example.test", "/v1/regions");
    expect(unused.credential).not.toHaveBeenCalled();
    expect(queue.requests[0]?.headers.has("authorization")).toBe(false);
    expect(queue.requests[0]?.headers.has("dpop")).toBe(false);
    expect(queue.requests[0]?.headers.get("accept")).toBe("application/json");
  });

  // Contract: the credential source is consulted for every request, so a
  // rotated token is used by the next request without rebuilding anything.
  it("resolves the credential on every request", async () => {
    const queue = new FetchQueue();
    queue.respondJson({});
    queue.respondJson({});
    const tokens = ["first-token", "second-token"];
    const rotating = {
      credential: vi.fn(() => ({
        accessToken: tokens.shift() ?? "",
        key: testKey,
      })),
    };
    const shared = new Transport({ credential: rotating, fetch: queue.fetch });
    await shared.json("GET", apiEndpoint, "/v1/one");
    await shared.json("GET", apiEndpoint, "/v1/two");
    expect(rotating.credential).toHaveBeenCalledTimes(2);
    expect(queue.requests.map((r) => r.headers.get("authorization"))).toEqual([
      "DPoP first-token",
      "DPoP second-token",
    ]);
    for (const request of queue.requests) {
      await checkedProof(request, "access");
    }
  });

  // Contract: a token the source returns is validated before it is sent, and
  // the failure names the source rather than echoing the token.
  it("refuses a token the source returns with whitespace", async () => {
    const queue = new FetchQueue();
    const error = await failure(
      new Transport({
        credential: source("two words"),
        fetch: queue.fetch,
      }).json("GET", apiEndpoint, "/v1/example"),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "credential source returned an access token that contains whitespace",
    );
    expect((error as Error).message).not.toContain("two words");
    expect(queue.requests).toHaveLength(0);
  });

  // Contract: the credential lookup runs under the request's signal, so a
  // cancelled request rejects with the caller's reason while the lookup is
  // still pending and leaves nothing running.
  it("aborts a pending credential lookup through the request signal", async () => {
    const queue = new FetchQueue();
    let release: (credential: Credential) => void = () => undefined;
    const held = new Promise<Credential>((resolve) => {
      release = resolve;
    });
    let observed: AbortSignal | undefined;
    const pendingSource: CredentialSource = {
      credential: (context) => {
        observed = context.signal;
        return held;
      },
    };
    const controller = new AbortController();
    const pending = new Transport({
      credential: pendingSource,
      fetch: queue.fetch,
    }).json("GET", apiEndpoint, "/v1/example", { signal: controller.signal });
    const reason = new DOMException("caller left", "AbortError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(observed?.aborted).toBe(true);
    expect(observed?.reason).toBe(reason);
    expect(queue.requests).toHaveLength(0);
    release({ accessToken: "late-token", key: testKey });
  });

  // Contract: a request that exceeds requestTimeoutMs rejects with a
  // TransportError carrying `timeout`, and the fetch it started is aborted.
  it("times out with a timeout TransportError", async () => {
    vi.useFakeTimers();
    await proofsOnFakeTime();
    const queue = new FetchQueue();
    queue.respond(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            const reason: unknown = request.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          });
        }),
    );
    const pending = transport(queue, { requestTimeoutMs: 50 }).json(
      "GET",
      apiEndpoint,
      "/v1/example",
    );
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(50);
    const error = await settled;
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("timeout");
    expect((error as TransportError).message).toBe("request exceeded 50 ms");
    expect(queue.requests[0]?.signal?.aborted).toBe(true);
  });

  // Contract: a path may not change the origin the client resolved.
  it("refuses a path that would replace the origin", async () => {
    const queue = new FetchQueue();
    await expect(
      transport(queue).json("GET", apiEndpoint, "//evil.example.com/v1"),
    ).rejects.toThrow("must not change the origin");
    await expect(
      transport(queue).json("GET", apiEndpoint, "v1/example"),
    ).rejects.toThrow("must begin with /");
    expect(queue.requests).toHaveLength(0);
  });

  // Contract: cleartext origins are refused unless the transport was built
  // with allowHttp.
  it("requires https unless cleartext was allowed explicitly", async () => {
    const queue = new FetchQueue();
    await expect(
      transport(queue).json("GET", "http://api.example.test", "/v1"),
    ).rejects.toThrow("must use https");
    queue.respondJson({});
    await transport(queue, { allowHttp: true }).json(
      "GET",
      "http://api.example.test",
      "/v1",
    );
    expect(queue.requests).toHaveLength(1);
  });

  // Contract: construction fails when no fetch is available rather than
  // failing on the first request.
  it("fails at construction without a fetch implementation", () => {
    const original = globalThis.fetch;
    // @ts-expect-error the runtime without fetch is the case under test
    globalThis.fetch = undefined;
    try {
      expect(() => new Transport({ credential })).toThrow(
        "fetch is unavailable",
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("transport responses", () => {
  // Contract: a non-2xx response becomes an ApiError carrying status, code,
  // the envelope's message as detail, details, request ID, and the
  // Retry-After delay in milliseconds.
  it("decodes the error envelope into an ApiError", async () => {
    const queue = new FetchQueue();
    queue.respondJson(
      {
        error: "capacity unavailable",
        code: "NO_CAPACITY",
        details: { region: "zone-a" },
      },
      503,
      { "x-request-id": "req-1", "retry-after": "3" },
    );
    const error = await failure(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: "ApiError",
      status: 503,
      code: "NO_CAPACITY",
      detail: "capacity unavailable",
      details: { region: "zone-a" },
      requestId: "req-1",
      retryAfterMs: 3_000,
      message: "IDYL API: 503 Service Unavailable: NO_CAPACITY",
    });
    expect(isApiStatus(error, 503)).toBe(true);
    expect(isApiCode(error, "NO_CAPACITY")).toBe(true);
  });

  // Contract: Retry-After as an HTTP date is converted to a delay from now.
  it("reads Retry-After as an HTTP date", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const queue = new FetchQueue();
    queue.respondJson({ error: "busy" }, 429, {
      "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT",
    });
    const error = await failure(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    );
    expect((error as ApiError).retryAfterMs).toBe(30_000);
  });

  // Contract: an encoded body larger than the caller's bound is refused
  // before the credential is consulted and before any byte is sent, naming
  // the size and the bound.
  it("refuses a request body over the caller's bound before any request", async () => {
    const queue = new FetchQueue();
    const bounded = source();
    const error = await failure(
      transport(queue, { credential: bounded }).json(
        "PUT",
        apiEndpoint,
        "/v1",
        {
          body: { value: "x".repeat(20) },
          maxRequestBodyBytes: 16,
        },
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "request body is 32 bytes, maximum is 16",
    );
    expect(bounded.credential).not.toHaveBeenCalled();
    expect(queue.requests).toHaveLength(0);
  });

  // Contract: under a disclosure allow-list the status and the code always
  // reach the caller, the message and details only under a code the list
  // names, and every other body, envelope or not, yields the fixed sentence
  // as detail and in the message.
  it("holds an error to the disclosure allow-list", async () => {
    const queue = new FetchQueue();
    const safeErrorCode = (code: string): boolean => code === "SAFE_CODE";
    const send = async (): Promise<ApiError> =>
      (await failure(
        transport(queue).json("GET", apiEndpoint, "/v1", { safeErrorCode }),
      )) as ApiError;

    queue.respondJson(
      { error: "named resource missing", code: "SAFE_CODE", details: { k: 1 } },
      404,
    );
    expect(await send()).toMatchObject({
      status: 404,
      code: "SAFE_CODE",
      detail: "named resource missing",
      details: { k: 1 },
      message: "IDYL API: 404 Not Found: SAFE_CODE",
    });

    queue.respondJson(
      { error: "leaked text", code: "OTHER", details: { v: "leaked" } },
      500,
    );
    const flattened = await send();
    expect(flattened.status).toBe(500);
    expect(flattened.code).toBe("OTHER");
    expect(flattened.details).toBeUndefined();
    expect(flattened.detail).toBe("request failed");
    expect(flattened.message).toBe(
      "IDYL API: 500 Internal Server Error: OTHER",
    );

    queue.respondText("leaked text", 502);
    const raw = await send();
    expect(raw.code).toBeUndefined();
    expect(raw.detail).toBe("request failed");
    expect(raw.message).toBe("IDYL API: 502 Bad Gateway");

    queue.respondText("", 404);
    const empty = await send();
    expect(empty.detail).toBe("request failed");
    expect(empty.message).toBe("IDYL API: 404 Not Found");
  });

  // Contract: a non-JSON error body still yields an ApiError with the status
  // and the bounded raw text as its detail and in its message.
  it("yields an ApiError for a non-JSON error body", async () => {
    const queue = new FetchQueue();
    queue.respondText("<html>gateway</html>", 502);
    const error = await failure(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).code).toBeUndefined();
    expect((error as ApiError).detail).toBe("<html>gateway</html>");
    expect((error as ApiError).message).toBe("IDYL API: 502 Bad Gateway");
  });

  // Contract: an empty error body falls back to the status text and carries
  // no detail, because the response carried no message.
  it("falls back to the status text for an empty error body", async () => {
    const queue = new FetchQueue();
    queue.respondText("", 404);
    const error = await failure(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    );
    expect((error as ApiError).message).toBe("IDYL API: 404 Not Found");
    expect("detail" in (error as ApiError)).toBe(false);
  });

  // Contract: an error body is read under a 64 KiB bound; a larger one is
  // refused and the refusal is reported inside the ApiError, as its detail
  // and in its message, with no byte of the body.
  it("bounds error bodies at 64 KiB", async () => {
    const queue = new FetchQueue();
    queue.respondText("x".repeat(64 * 1024 + 1), 500);
    const error = await failure(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).detail).toContain("exceeds 65536 bytes");
    expect((error as ApiError).detail).toMatch(
      /^API error response could not be read: .*exceeds 65536 bytes/u,
    );
    expect((error as ApiError).detail).not.toContain("xx");
  });

  // Contract: a success body that declares more than 16 MiB is refused from
  // the content-length header before any byte is read.
  it("refuses a success body that declares more than 16 MiB", async () => {
    const queue = new FetchQueue();
    let cancelled = false;
    queue.respond(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 200,
            headers: { "content-length": String(16 * 1024 * 1024 + 1) },
          },
        ),
    );
    await expect(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    ).rejects.toThrow("exceeds 16777216 bytes");
    expect(cancelled).toBe(true);
  });

  // Contract: a success body that streams past 16 MiB without declaring a
  // length or an end is refused as it is read, and the stream is cancelled
  // so the source stops producing.
  it("refuses a success body that streams past 16 MiB", async () => {
    const queue = new FetchQueue();
    const chunk = new Uint8Array(1024 * 1024);
    let cancelled = false;
    let pulls = 0;
    queue.respond(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    await expect(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    ).rejects.toThrow("exceeds 16777216 bytes");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(18);
  });

  // Contract: a response carries exactly one JSON value.
  it("rejects two JSON values in one body", async () => {
    const queue = new FetchQueue();
    queue.respondText('{"first":true}\n{"second":true}');
    await expect(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    ).rejects.toThrow("expected exactly one JSON value");
  });

  // Contract: an empty body where JSON is expected is a decode failure, not
  // an undefined result.
  it("rejects an empty body where JSON is expected", async () => {
    const queue = new FetchQueue();
    queue.respondText("");
    await expect(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    ).rejects.toThrow("empty response body");
  });

  // Contract: unknown fields on a read path are carried as-is.
  it("carries unknown response fields on read", async () => {
    const queue = new FetchQueue();
    queue.respondText('{"known":1,"unknown":{"deep":true}}');
    const value = await transport(queue).json<Record<string, unknown>>(
      "GET",
      apiEndpoint,
      "/v1",
    );
    expect(value).toEqual({ known: 1, unknown: { deep: true } });
  });

  // Contract: a 204 or a request that expects no body drains and returns
  // undefined.
  it("returns undefined for a 204 and for response: none", async () => {
    const queue = new FetchQueue();
    queue.respondJson(null, 204);
    queue.respondText("ignored");
    const shared = transport(queue);
    await expect(
      shared.json("DELETE", apiEndpoint, "/v1"),
    ).resolves.toBeUndefined();
    await expect(
      shared.json("DELETE", apiEndpoint, "/v1", { response: "none" }),
    ).resolves.toBeUndefined();
  });

  // Contract: a stream chunked into many reads reassembles into one value.
  it("reassembles a chunked success body", async () => {
    const queue = new FetchQueue();
    const encoder = new TextEncoder();
    queue.respond(
      () =>
        new Response(
          streamOf([encoder.encode('{"na'), encoder.encode('me":"dev"}')]),
          { status: 200 },
        ),
    );
    await expect(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    ).resolves.toEqual({
      name: "dev",
    });
  });

  // Contract: the SDK issues no automatic retry of a refused request; the
  // one retry it makes is of a refused proof, covered with the proofs.
  it("does not retry a failed request", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ error: "busy" }, 503);
    await expect(
      transport(queue).json("POST", apiEndpoint, "/v1", { body: {} }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(queue.requests).toHaveLength(1);
    queue.assertExhausted();
  });

  // Contract: an error body that is not valid UTF-8 still yields an ApiError
  // carrying the status; a malformed byte is read as a replacement character
  // and never turns a response into a decoding failure.
  it("yields an ApiError for an error body that is not UTF-8", async () => {
    const queue = new FetchQueue();
    queue.respond(
      () =>
        new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 502 }),
    );
    const error = await failure(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).toBe("IDYL API: 502 Bad Gateway");
  });

  // Contract: a success body whose string carries a byte that is not UTF-8
  // decodes with a replacement character, as the reference contract reads it.
  it("reads a success body that is not UTF-8 with replacement characters", async () => {
    const queue = new FetchQueue();
    queue.respond(
      () =>
        new Response(
          new Uint8Array([
            0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
          ]),
          { status: 200 },
        ),
    );
    await expect(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    ).resolves.toEqual({ a: "�" });
  });

  // Contract: the error-body bound is enforced as the stream is read, not
  // only from Content-Length, so a body that declares less than it delivers
  // is still refused at 64 KiB and its stream is cancelled.
  it("bounds a streamed error body that understates its length", async () => {
    const queue = new FetchQueue();
    const chunk = new Uint8Array(16 * 1024);
    let cancelled = false;
    let pulls = 0;
    queue.respond(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 500, headers: { "content-length": "10" } },
        ),
    );
    const error = await failure(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).detail).toContain("exceeds 65536 bytes");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(8);
  });

  // Contract: the success-body bound is enforced as the stream is read, not
  // only from Content-Length, so a body that declares less than it delivers
  // is still refused at 16 MiB and its stream is cancelled.
  it("bounds a streamed success body that understates its length", async () => {
    const queue = new FetchQueue();
    const chunk = new Uint8Array(1024 * 1024);
    let cancelled = false;
    let pulls = 0;
    queue.respond(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-length": "10" } },
        ),
    );
    await expect(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    ).rejects.toThrow("response body exceeds 16777216 bytes");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(20);
  });

  // Contract: a response is exactly one JSON value; content after the value
  // is refused, with the parser's failure as the cause.
  it("refuses trailing content after one JSON value", async () => {
    const queue = new FetchQueue();
    queue.respondText('{"a":1} x');
    await expect(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    ).rejects.toThrow("expected exactly one JSON value");
  });

  // Contract: a Retry-After that is neither delay seconds nor an HTTP date
  // carries no delay, rather than a date invented from a malformed number.
  it("ignores a Retry-After that is neither seconds nor a date", async () => {
    const queue = new FetchQueue();
    for (const value of ["-1", "1.5", "soon", "120s"]) {
      queue.respondJson({ error: "busy" }, 429, { "retry-after": value });
      const error = await failure(
        transport(queue).json("GET", apiEndpoint, "/v1"),
      );
      expect((error as ApiError).retryAfterMs, value).toBeUndefined();
    }
    queue.assertExhausted();
  });

  // Contract: a fetch failure that is not an abort keeps its cause.
  it("preserves the cause of a network failure", async () => {
    const queue = new FetchQueue();
    const cause = new TypeError("connection refused");
    queue.respond(() => Promise.reject(cause));
    const error = await failure(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    );
    expect((error as Error).message).toBe("GET request failed");
    expect((error as TransportError).code).toBe("network_error");
    expect((error as Error).cause).toBe(cause);
  });
});

describe("transport redirects", () => {
  // Contract: every request is handed to fetch with redirect "manual", the
  // one mode every runtime accepts, and with no receiver, at both request
  // sites, so a redirect is the SDK's to refuse rather than the runtime's to
  // follow or to reject.
  it("sends redirect manual with no receiver at both sites", async () => {
    const queue = new FetchQueue();
    queue.respondJson({});
    queue.respondText("bytes", 200, {
      "content-type": "application/octet-stream",
    });
    const checked = receiverCheckedFetch(queue);
    const shared = new Transport({ credential, fetch: checked.fetch });
    await shared.json("GET", apiEndpoint, "/v1/example");
    const response = await shared.openContent(
      apiEndpoint,
      "/v1/content",
      "application/octet-stream",
      undefined,
    );
    await response.body?.cancel();
    expect(checked.receivers).toEqual([undefined, undefined]);
    expect(checked.inits.map((init) => init?.redirect)).toEqual([
      "manual",
      "manual",
    ]);
    queue.assertExhausted();
  });

  const location = "https://elsewhere.example.test/moved";
  const redirects: readonly [string, number][] = [
    ["301 redirect", 301],
    ["302 redirect", 302],
    ["307 redirect", 307],
    ["opaque redirect", 0],
  ];

  /**
   * Asserts the refusal of a redirect: a TransportError carrying
   * `redirect_refused` and the fixed sentence, with no cause and nothing the
   * redirecting peer wrote, in the message, the cause, or any property.
   */
  function expectRefusedRedirect(error: unknown): void {
    expect(error).toBeInstanceOf(TransportError);
    const refused = error as TransportError;
    expect(refused.code).toBe("redirect_refused");
    expect(refused.message).toBe("redirect refused");
    expect(refused.cause).toBeUndefined();
    const carried = carriedText(refused);
    expect(carried).not.toContain(location);
    expect(carried).not.toContain("elsewhere");
  }

  // Contract: a redirect, the 3xx response itself or a browser's opaque
  // redirect, is refused before its body or its headers are read: a
  // TransportError carrying `redirect_refused` and the fixed sentence
  // `redirect refused`, with no cause, no second request, the
  // credential consulted once, and the Location value nowhere in the error.
  it.each(redirects)(
    "%s is refused on a JSON request",
    async (_label, status) => {
      const queue = new FetchQueue();
      const body = unreadBody();
      queue.respond(() => redirectResponse(status, location, body.stream));
      const counted = source();
      const error = await failure(
        new Transport({ credential: counted, fetch: queue.fetch }).json(
          "POST",
          apiEndpoint,
          "/v1/example",
          { body: { name: "dev" } },
        ),
      );
      expectRefusedRedirect(error);
      expect(body.reads()).toBe(0);
      expect(queue.requests).toHaveLength(1);
      expect(counted.credential).toHaveBeenCalledTimes(1);
    },
  );

  // Contract: saved content is held to the same refusal: the redirect fails
  // the open, before any body is read and without a second request.
  it.each(redirects)(
    "%s is refused on saved content",
    async (_label, status) => {
      const queue = new FetchQueue();
      const body = unreadBody();
      queue.respond(() => redirectResponse(status, location, body.stream));
      const counted = source();
      const error = await failure(
        new Transport({ credential: counted, fetch: queue.fetch }).openContent(
          apiEndpoint,
          "/v1/content",
          "application/octet-stream",
          undefined,
        ),
      );
      expectRefusedRedirect(error);
      expect(body.reads()).toBe(0);
      expect(queue.requests).toHaveLength(1);
      expect(counted.credential).toHaveBeenCalledTimes(1);
    },
  );
});

describe("transport user agent", () => {
  // Contract: an explicit userAgent replaces the SDK default on the wire,
  // and a blank one is the same as none.
  it("sends an explicit userAgent and falls back from a blank one", async () => {
    const queue = new FetchQueue();
    queue.respondJson({ ok: true });
    queue.respondJson({ ok: true });
    await transport(queue, { userAgent: "example-app/1.0" }).json(
      "GET",
      apiEndpoint,
      "/v1/example",
    );
    await transport(queue, { userAgent: "  " }).json(
      "GET",
      apiEndpoint,
      "/v1/example",
    );
    expect(queue.requests[0]?.headers.get("user-agent")).toBe(
      "example-app/1.0",
    );
    expect(queue.requests[1]?.headers.get("user-agent")).toBe(
      DEFAULT_USER_AGENT,
    );
    queue.assertExhausted();
  });

  // Contract: in a browser document the browser owns User-Agent, so the
  // SDK sends no default one and a cross-origin preflight never has to
  // admit a header the SDK added on its own; every other header is as on
  // any runtime.
  it("leaves the default User-Agent to a browser document", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const queue = new FetchQueue();
    queue.respondJson({ ok: true });
    await transport(queue).json("GET", apiEndpoint, "/v1/example");
    const request = queue.requests[0];
    expect(request?.headers.has("user-agent")).toBe(false);
    expect(request?.headers.get("accept")).toBe("application/json");
    expect(request?.headers.get("authorization")).toBe("DPoP test-token");
    queue.assertExhausted();
  });

  // Contract: an explicit userAgent is the caller's decision and is sent on
  // every runtime, a browser document included.
  it("sends an explicit userAgent from a browser document", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const queue = new FetchQueue();
    queue.respondJson({ ok: true });
    await transport(queue, { userAgent: "example-app/1.0" }).json(
      "GET",
      apiEndpoint,
      "/v1/example",
    );
    expect(queue.requests[0]?.headers.get("user-agent")).toBe(
      "example-app/1.0",
    );
  });
});

/**
 * Every string an error carries: its message, its own properties, and its
 * cause chain, so a leak assertion covers what a log would print.
 */
function carriedText(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error);
  const own = Object.getOwnPropertyNames(error).map((key) =>
    JSON.stringify((error as unknown as Record<string, unknown>)[key]),
  );
  return [error.message, ...own, carriedText(error.cause)].join("\n");
}

describe("transport body failures", () => {
  // Contract: a connection lost while a body is read is a TransportError
  // with code network_error, retried as a failed fetch is.
  it("reports a body that broke off in transit", async () => {
    const queue = new FetchQueue();
    queue.respond(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"a":'));
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const error = await failure(
      transport(queue).json("GET", apiEndpoint, "/v1"),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("network_error");
    expect((error as Error).message).toBe("GET response body failed");
  });
});
