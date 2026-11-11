// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * A recorded fake of the account API's Namespace collection and its deletion
 * lifecycle. A delete marks the Namespace terminating and answers 202; a
 * terminating Namespace still reads, refuses edits with the stable 409 code,
 * accepts a repeated delete, and finalizes after a fixed number of reads,
 * after which it resolves 404. The reserved `default` Namespace exists from
 * the start and refuses deletion with 403.
 *
 * Every request is recorded before it is answered, so a test asserts on the
 * request the SDK made. An unknown route is answered with a 404 error
 * envelope, never with a throw that fails the test from inside the fake.
 */
import { parseAccountId } from "../../src/resource/id.js";
import { parseNamespaceId } from "../../src/resource/uuid-id.js";
import type {
  CreateNamespaceRequest,
  Namespace,
  UpdateNamespaceRequest,
} from "../../src/api/namespace.js";
import { abortable, errorResponse, json } from "./control-plane.js";
import type { RouteHandler } from "./control-plane.js";
import { testClient } from "./client.js";
import type { TestClient, TestClientConfig } from "./client.js";
import { accountId, network } from "./fetch-queue.js";
import type { RecordedRequest } from "./fetch-queue.js";

/** The Namespace fake-backed clients enter unless a test says otherwise. */
export const namespace = "agents";
/** The Account route prefix. */
export const accountPath = `/v1/accounts/${accountId}`;
/** The Namespace collection route. */
export const namespacesPath = `${accountPath}/namespaces`;

const CREATED_AT = "2026-01-02T03:04:05Z";
const UPDATED_AT = "2026-01-02T04:05:06Z";
const TERMINATING_AT = "2026-01-02T05:06:07Z";
const account = parseAccountId(accountId);

export interface AccountPlaneOptions {
  /**
   * Answers requests before the built-in routes are consulted, so a test can
   * hold a route open or answer it with a failure.
   */
  readonly routes?: RouteHandler;
  /**
   * How many reads a terminating Namespace answers before it finalizes and
   * resolves 404. Defaults to 1.
   */
  readonly readsUntilFinalized?: number;
}

interface NamespaceRecord {
  namespace: Namespace;
  readsUntilGone: number | undefined;
}

export class FakeAccountPlane {
  readonly requests: RecordedRequest[] = [];
  readonly namespaces = new Map<string, NamespaceRecord>();
  readonly #options: AccountPlaneOptions;
  #sequence = 0;

  constructor(options: AccountPlaneOptions = {}) {
    this.#options = options;
    this.seedNamespace("default", "The reserved namespace");
    this.seedNamespace(namespace);
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
      return custom ?? this.#serve(request, body);
    })();
    return await abortable(answer, request.signal);
  };

  /**
   * A client addressing this fake. Fields left unset take the test Network,
   * the test Account, the fake's Namespace, and the test credential; an
   * explicit `undefined` leaves the field unset.
   */
  client(overrides: TestClientConfig = {}): TestClient {
    return testClient({ namespace, fetch: this.fetch, ...overrides });
  }

  /** The recorded requests as `METHOD path?query`, in order. */
  calls(): string[] {
    return this.requests.map(
      (request) =>
        `${request.method} ${request.url.pathname}${request.url.search}`,
    );
  }

  /** Stores an active Namespace as if the platform held it. */
  seedNamespace(name: string, description = ""): Namespace {
    const record: NamespaceRecord = {
      namespace: {
        id: parseNamespaceId(this.#id()),
        accountId: account,
        name,
        description,
        phase: "active",
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
      readsUntilGone: undefined,
    };
    this.namespaces.set(name, record);
    return record.namespace;
  }

  #id(): string {
    this.#sequence += 1;
    return `01954e20-7540-7ec4-93ec-${(0x14f783e6ab00 + this.#sequence).toString(16).padStart(12, "0")}`;
  }

  #serve(request: RecordedRequest, body: unknown): Response {
    const { url, method } = request;
    if (url.host !== `api.${network}`) return notFound();
    const path = url.pathname;
    const prefix = String.raw`^/v1/accounts/(\d{12})`;
    const at = (pattern: string): RegExpExecArray | null =>
      new RegExp(`${prefix}${pattern}$`, "u").exec(path);

    let match = at("/namespaces");
    if (match !== null) {
      if (method === "POST") return this.#createNamespace(body);
      if (method === "GET") return this.#listNamespaces(url);
      return notFound();
    }
    match = at("/namespaces/([^/]+)");
    if (match !== null) {
      const name = decodeURIComponent(match[2] ?? "");
      return this.#namespaceRoute(method, name, body);
    }
    return notFound();
  }

  #createNamespace(body: unknown): Response {
    const request = body as CreateNamespaceRequest;
    if (this.namespaces.has(request.name)) {
      return errorResponse(409, "already_exists", "namespace already exists");
    }
    const created = this.seedNamespace(request.name, request.description ?? "");
    return json({ namespace: created }, 201);
  }

  #listNamespaces(url: URL): Response {
    const items = [...this.namespaces.values()]
      .filter((record) => record.readsUntilGone === undefined)
      .map((record) => record.namespace)
      .sort((a, b) => a.name.localeCompare(b.name));
    return page(url, items);
  }

  #namespaceRoute(method: string, name: string, body: unknown): Response {
    const record = this.namespaces.get(name);
    if (record === undefined) return notFound();
    switch (method) {
      case "GET":
        return this.#readNamespace(name, record);
      case "PUT": {
        if (record.readsUntilGone !== undefined) {
          return terminating("NAMESPACE_TERMINATING", { namespace: name });
        }
        const request = body as UpdateNamespaceRequest;
        record.namespace = {
          ...record.namespace,
          ...(request.description === undefined
            ? {}
            : { description: request.description }),
        };
        return json({ namespace: record.namespace });
      }
      case "DELETE": {
        if (name === "default") {
          return errorResponse(
            403,
            "forbidden",
            "the default namespace cannot be deleted",
          );
        }
        if (record.readsUntilGone === undefined) {
          record.readsUntilGone = this.#options.readsUntilFinalized ?? 1;
          record.namespace = {
            ...record.namespace,
            phase: "terminating",
            terminatingAt: TERMINATING_AT,
            termination: { computersRemaining: 0, zones: [] },
          };
        }
        return json({ accepted: true, deletedAt: TERMINATING_AT }, 202);
      }
      default:
        return notFound();
    }
  }

  #readNamespace(name: string, record: NamespaceRecord): Response {
    if (record.readsUntilGone !== undefined) {
      if (record.readsUntilGone <= 0) {
        this.namespaces.delete(name);
        return notFound();
      }
      record.readsUntilGone -= 1;
    }
    return json({ namespace: record.namespace });
  }
}

function page(url: URL, items: readonly unknown[]): Response {
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = url.searchParams.get("limit");
  const slice = items.slice(
    offset,
    limit === null ? undefined : offset + Number(limit),
  );
  return json({ items: slice, totalCount: items.length });
}

function terminating(
  code: "NAMESPACE_TERMINATING",
  details: Record<string, string>,
): Response {
  return json(
    {
      error: `${details["namespace"] ?? ""} is terminating`,
      code,
      details,
    },
    409,
  );
}

function notFound(): Response {
  return errorResponse(404, "not_found", "not found");
}
