// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * What every product on the client shares: the per-call options, the page a
 * listing returns, and the walk that turns pages into an async iterator.
 */
import { TransportError } from "../errors.js";

/**
 * What a call accepts beyond its own arguments. `signal` cancels the call:
 * the credential lookup, the request and the body read stop, and the call
 * rejects with the signal's reason. Cancelling a call never deletes
 * anything.
 */
export interface CallOptions {
  /**
   * Cancels the call when it aborts: the call rejects with the signal's
   * reason. `undefined` lets the call run to its end.
   */
  readonly signal?: AbortSignal;
}

/**
 * One page of a listing. `continue` is present on every page but the last:
 * pass it back unchanged as the `continue` option to read the next page.
 * It is opaque and is valid only for the listing that returned it.
 */
export interface Page<T> {
  /** The page's items, in the listing's order; empty when there are none. */
  readonly items: readonly T[];
  /**
   * The position of the next page, passed back as the `continue` option;
   * absent on the last page.
   */
  readonly continue?: string;
}

/** Walks a listing. */
export interface ListOptions extends CallOptions {
  /**
   * The most items to read per page. `undefined` takes the platform's page
   * size. Must be a positive integer.
   */
  readonly limit?: number;
}

/** Selects one page of a listing. */
export interface PageOptions extends CallOptions {
  /**
   * The most items to return. `undefined` takes the platform's page size.
   * Must be a positive integer.
   */
  readonly limit?: number;
  /** The `continue` of the previous page; `undefined` starts at the first. */
  readonly continue?: string;
}

/**
 * Walks a listing page by page, yielding each item in the platform's
 * order, until a page carries no `continue`. `signal` cancels the walk
 * between and during pages.
 */
export async function* walk<T>(
  page: (options: PageOptions) => Promise<Page<T>>,
  options: ListOptions = {},
): AsyncGenerator<T, void, undefined> {
  requireLimit(options.limit);
  let next: string | undefined;
  for (;;) {
    const current = await page({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(next === undefined ? {} : { continue: next }),
    });
    yield* current.items;
    if (current.continue === undefined) return;
    if (current.continue === next) {
      throw new TransportError(
        "invalid_response",
        "listing returned the position it was asked for",
      );
    }
    next = current.continue;
  }
}

/**
 * Judges `limit` before any request: absent, or a positive safe integer.
 * Throws a `TypeError` naming the field.
 */
export function requireLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("limit must be a positive integer");
  }
  return limit;
}

/**
 * Reads the `continue` of an offset-paged listing back into its offset.
 * Throws a `TypeError` when `value` is not a position this package issued.
 */
export function offsetOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw new TypeError("continue is not a position this listing issued");
  }
  return Number(value);
}

/**
 * The `continue` of an offset-paged page: the offset after its items while
 * the platform reports more, absent on the last page.
 */
export function offsetContinue(
  offset: number,
  count: number,
  total: number | bigint,
): string | undefined {
  const next = offset + count;
  return count > 0 && BigInt(next) < BigInt(total) ? String(next) : undefined;
}

/**
 * The kind of client a call states, recorded with what it changes or runs:
 * `sdk` when absent. Throws a `TypeError` for any other value.
 */
export function clientOf(
  client: "sdk" | "console" | "cli" | undefined,
): "sdk" | "console" | "cli" {
  if (client === undefined) return "sdk";
  if (!(["sdk", "console", "cli"] as readonly string[]).includes(client)) {
    throw new TypeError('client must be "sdk", "console" or "cli"');
  }
  return client;
}

/** The `signal` of `options`, as a transport option. */
export function signalOf(options: CallOptions | undefined): {
  readonly signal?: AbortSignal;
} {
  return options?.signal === undefined ? {} : { signal: options.signal };
}

/** Judges a required, non-blank string argument. */
export function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

/** A page of public items. */
export function pageOf<T>(
  items: readonly T[],
  next: string | undefined,
): Page<T> {
  return Object.freeze({
    items: Object.freeze([...items]),
    ...(next === undefined ? {} : { continue: next }),
  });
}

/** The contract's page request for a public page selection. */
export function pageRequest(options: PageOptions): {
  readonly limit?: number;
  readonly continue?: string;
} {
  const limit = requireLimit(options.limit);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(options.continue === undefined ? {} : { continue: options.continue }),
  };
}
