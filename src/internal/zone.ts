// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * Requests a Namespace-scoped service sends to the API that serves the
 * Account's Computers. The client's placement is resolved once per
 * operation, and an account-wide list needs no Namespace. The resolved
 * endpoint is where the request goes; the resolved place and scope are what
 * its path is built from.
 *
 * `ZoneCollection` is the shape of a collection that is created into, read,
 * changed, and deleted by name, and listed within a Namespace or across the
 * Account, each resource travelling under its own envelope key. It is read
 * through the kind's lenient decoder, so what the platform adds survives the
 * read; the rest of every envelope is carried as it arrived.
 *
 * A Computer names the place it lives in on every response, and only that
 * place's API serves it. Its collection refuses a response in which any
 * Computer names a place other than the one the request addressed, or none,
 * so a caller never holds a Computer another place answered for. Every path
 * is built in `apipath`, every list query encoded in `listquery`, and every
 * envelope read here.
 */
import { TransportError } from "../errors.js";
import { signalOption } from "../internal/options.js";
import type {
  DeleteResponse,
  ListOptions,
  ListResponse,
} from "../api/types.js";
import { accountSubnet, namespace, namespaceResource } from "./apipath.js";
import type { PlacementContext } from "./context.js";
import { readEnvelope, readList } from "./envelopes.js";
import { requireNonBlank } from "./options.js";
import { accountListQuery, namespaceListQuery } from "./listquery.js";
import { resolvePlacement } from "./routing.js";
import type { ResolvedPlacement, ResolvePlacementOptions } from "./routing.js";

/** What one request to a Subnet's API carries beyond its method and path. */
export interface ZoneRequestOptions {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxRequestBodyBytes?: number;
  readonly safeErrorCode?: (code: string) => boolean;
  readonly signal?: AbortSignal;
}

/**
 * Resolves the client's placement under `resolve` and sends one request to
 * the Subnet API that serves it. `path` is built from the resolution, so an
 * account-wide route always addresses the Subnet the request is sent to.
 */
export async function sendToZone<T>(
  context: PlacementContext,
  method: string,
  path: (resolved: ResolvedPlacement) => string,
  resolve: Omit<ResolvePlacementOptions, "signal">,
  options: ZoneRequestOptions = {},
): Promise<T> {
  return (await exchange(context, method, path, resolve, options))
    .response as T;
}

/**
 * Throws unless every place in `served` is `addressed`. The message names
 * the kind only: where a Computer lives is never part of a message, and the
 * place a response named is server-controlled and is never repeated.
 */
function requireServedSubnet(
  label: string,
  addressed: string,
  served: readonly string[],
): void {
  if (served.some((subnet) => subnet !== addressed)) {
    throw new TransportError(
      "invalid_response",
      `${label} response names a placement other than the one addressed`,
    );
  }
}

/**
 * {@link sendToZone}, handing back the resolution the request was sent
 * under with the response. `options.bodyFor`, when present, builds the body
 * from the resolution in place of `options.body`, and may throw to refuse
 * the request before it is sent.
 */
async function exchange(
  context: PlacementContext,
  method: string,
  path: (resolved: ResolvedPlacement) => string,
  resolve: Omit<ResolvePlacementOptions, "signal">,
  options: ExchangeOptions = {},
): Promise<Exchanged> {
  const resolved = await resolvePlacement(context, {
    ...resolve,
    ...signalOption(options.signal),
  });
  const body =
    options.bodyFor === undefined ? options.body : options.bodyFor(resolved);
  const response = await context.state.transport.json<unknown>(
    method,
    resolved.endpoint,
    path(resolved),
    {
      ...(body === undefined ? {} : { body }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.maxRequestBodyBytes === undefined
        ? {}
        : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
      ...(options.safeErrorCode === undefined
        ? {}
        : { safeErrorCode: options.safeErrorCode }),
      ...signalOption(options.signal),
    },
  );
  return { resolved, response };
}

/** What {@link exchange} carries: a body may be built from the resolution. */
interface ExchangeOptions extends ZoneRequestOptions {
  readonly bodyFor?: (resolved: ResolvedPlacement) => unknown;
}

/** A response envelope carrying one resource under `K`. */
export type Envelope<K extends string, T> = Readonly<Record<K, T>>;

/** How one kind's collection is addressed, encoded, and read. */
export interface ZoneCollectionSpec<K extends string, T> {
  /** The collection path segment, such as `computers`. */
  readonly plural: string;
  /** The envelope key requests and responses wrap the resource in. */
  readonly key: K;
  /** The singular noun used in messages, such as `computer`. */
  readonly label: string;
  /** Reads a resource the platform reported, leniently. */
  readonly decode: (value: unknown) => T;
  /**
   * The Subnet a served resource names, for a kind that lives in one Subnet.
   * When present, every response carrying resources is refused unless each
   * of them names the Subnet the request addressed. `undefined` checks
   * nothing.
   */
  readonly subnetOf?: (value: T) => string;
}

/** One kind's Namespace-scoped collection on the client's resolved Subnet. */
export class ZoneCollection<K extends string, T> {
  readonly #context: PlacementContext;
  readonly #spec: ZoneCollectionSpec<K, T>;

  constructor(context: PlacementContext, spec: ZoneCollectionSpec<K, T>) {
    this.#context = context;
    this.#spec = spec;
  }

  /**
   * Creates a resource in the Namespace from the request body `body`
   * builds for the resolved placement. `body`
   * may throw to refuse the request before anything is sent.
   */
  async submit(
    body: (resolved: ResolvedPlacement) => unknown,
    signal?: AbortSignal,
  ): Promise<Envelope<K, T>> {
    return this.#envelope(
      await exchange(
        this.#context,
        "POST",
        (resolved) => namespace(resolved.scope, this.#spec.plural),
        {},
        { bodyFor: body, ...signalOption(signal) },
      ),
    );
  }

  /** Reads the named resource. Throws a `TypeError` when `name` is blank. */
  async get(name: string, signal?: AbortSignal): Promise<Envelope<K, T>> {
    this.#requireName(name);
    return await this.read(
      (resolved) => this.#resourcePath(resolved, name),
      signal,
    );
  }

  /** Reads the one resource `path` addresses on the resolved Subnet. */
  async read(
    path: (resolved: ResolvedPlacement) => string,
    signal?: AbortSignal,
  ): Promise<Envelope<K, T>> {
    return this.#envelope(
      await exchange(this.#context, "GET", path, {}, signalOption(signal)),
    );
  }

  /**
   * Applies a partial change, `body`, to the named resource with a PATCH
   * and reads back the resource as the change left it. Throws a
   * `TypeError` when `name` is blank.
   */
  async patch(
    name: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Envelope<K, T>> {
    this.#requireName(name);
    return await this.change(
      (resolved) => this.#resourcePath(resolved, name),
      body,
      signal,
    );
  }

  /**
   * Applies a partial change, `body`, with a PATCH of the one resource
   * `path` addresses on the resolved Subnet, and reads back the resource
   * as the change left it.
   */
  async change(
    path: (resolved: ResolvedPlacement) => string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Envelope<K, T>> {
    return this.#envelope(
      await exchange(
        this.#context,
        "PATCH",
        path,
        {},
        { body, ...signalOption(signal) },
      ),
    );
  }

  /**
   * Asks the platform to remove the named resource and returns its answer.
   * Throws a `TypeError` when `name` is blank.
   */
  async delete(name: string, signal?: AbortSignal): Promise<DeleteResponse> {
    this.#requireName(name);
    return await this.remove(
      (resolved) => this.#resourcePath(resolved, name),
      signal,
    );
  }

  /**
   * Asks the platform to remove the one resource `path` addresses on the
   * resolved Subnet and returns its answer.
   */
  async remove(
    path: (resolved: ResolvedPlacement) => string,
    signal?: AbortSignal,
  ): Promise<DeleteResponse> {
    return await sendToZone<DeleteResponse>(
      this.#context,
      "DELETE",
      path,
      {},
      signalOption(signal),
    );
  }

  /** One page of the collection within the Namespace. */
  async list(
    options: ListOptions,
    signal?: AbortSignal,
  ): Promise<ListResponse<T>> {
    return this.#page(
      await exchange(
        this.#context,
        "GET",
        (resolved) =>
          namespace(resolved.scope, this.#spec.plural) +
          namespaceListQuery(options, resolved.subnet),
        {},
        signalOption(signal),
      ),
    );
  }

  /**
   * One page of the collection across every Namespace in the Account, in
   * the client's Subnet. The client's Namespace is not consulted: the path
   * addresses the Account and the Subnet directly, and each item carries
   * its own Namespace.
   */
  async listAllNamespaces(
    options: ListOptions,
    signal?: AbortSignal,
  ): Promise<ListResponse<T>> {
    return this.#page(
      await exchange(
        this.#context,
        "GET",
        (resolved) =>
          accountSubnet(
            resolved.scope.accountId,
            resolved.subnet,
            this.#spec.plural,
          ) + accountListQuery(options),
        { requireNamespace: false },
        signalOption(signal),
      ),
    );
  }

  #envelope(exchanged: Exchanged): Envelope<K, T> {
    const envelope = readEnvelope(
      exchanged.response,
      this.#spec.key,
      this.#spec.decode,
    );
    this.#requireServed(exchanged.resolved, [envelope[this.#spec.key]]);
    return envelope;
  }

  #page(exchanged: Exchanged): ListResponse<T> {
    const page = readList(
      exchanged.response,
      this.#spec.plural,
      this.#spec.decode,
    );
    this.#requireServed(exchanged.resolved, page.items);
    return page;
  }

  #requireServed(resolved: ResolvedPlacement, served: readonly T[]): void {
    const subnetOf = this.#spec.subnetOf;
    if (subnetOf === undefined) return;
    requireServedSubnet(
      this.#spec.label,
      resolved.subnet,
      served.map(subnetOf),
    );
  }

  #requireName(name: string): void {
    requireNonBlank(name, `${this.#spec.label} name`);
  }

  #resourcePath(resolved: ResolvedPlacement, name: string): string {
    return namespaceResource(resolved.scope, this.#spec.plural, name);
  }
}

/** A response with the resolution its request was sent under. */
interface Exchanged {
  readonly resolved: ResolvedPlacement;
  readonly response: unknown;
}
