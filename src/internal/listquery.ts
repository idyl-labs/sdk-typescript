// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "../resource/json.js";
import { isUint64, integerText } from "./strictdecode.js";
import type { FileReadOptions, FileListOptions } from "../api/files.js";
import type { WatchFilesOptions } from "../api/file-status.js";
import { pageOptionsShape, type PageOptions } from "../api/storage.js";
/*
 * The query string a list request carries. Every list route shares one
 * encoding: each option is sent under its wire name only when it is set, and
 * the keys are written in sorted order so the same options always produce
 * the same string.
 *
 * The routes served by a Computer's API differ in how they name the place
 * the Computer lives in. A Namespace-scoped route states it as the `subnet`
 * parameter on every request; an account-wide route addresses it in the
 * path and never repeats it.
 *
 * A page size is a positive integer and an offset a non-negative one.
 * `undefined` is unset, a present value is sent, and a value no route could
 * honour is refused with a `TypeError` naming the option.
 */
import type { ListOptions } from "../api/types.js";
import type { JournalListOptions } from "../api/journal.js";

/**
 * Encodes list options for a route on the global API. Returns the query
 * string beginning with `?`, or an empty string when nothing is set. Throws
 * a `TypeError` when `limit` is not a positive integer or `offset` is
 * not a non-negative integer.
 */
export function listQuery(options: ListOptions): string {
  return encode(queryValues(options, undefined));
}

/**
 * Encodes list options for a Namespace-scoped route served by a Computer's
 * API, which always states the resolved `subnet` explicitly.
 */
export function namespaceListQuery(
  options: ListOptions,
  subnet: string,
): string {
  return encode(queryValues(options, subnet));
}

/**
 * Encodes list options for an account-wide route served by a Computer's
 * API, which addresses the resolved place in its path and does not repeat
 * it.
 */
export function accountListQuery(options: ListOptions): string {
  return encode(queryValues(options, undefined));
}

/**
 * Encodes the options of a Computer journal list, already judged: `limit`
 * when greater than zero and `continue` verbatim when set. Keys are written
 * in sorted order.
 */
export function computerJournalQuery(options: JournalListOptions): string {
  const values: [string, string][] = [];
  const limit = options.limit ?? 0;
  if (limit > 0) values.push(["limit", integerText(limit)]);
  const position = options.continue ?? "";
  if (position !== "") values.push(["continue", position]);
  return encode(values.sort(([a], [b]) => (a < b ? -1 : 1)));
}

function queryValues(
  options: ListOptions,
  subnet: string | undefined,
): readonly (readonly [string, string])[] {
  const values: [string, string][] = [];
  const limit = pageValue(options.limit, "limit");
  if (limit !== undefined) values.push(["limit", limit]);
  const offset = pageValue(options.offset, "offset");
  if (offset !== undefined) values.push(["offset", offset]);
  if (options.filter !== undefined && options.filter !== "") {
    values.push(["filter", options.filter]);
  }
  if (options.sort !== undefined && options.sort !== "") {
    values.push(["sort", options.sort]);
  }
  if (subnet !== undefined && subnet !== "") values.push(["subnet", subnet]);
  values.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return values;
}

function pageValue(
  value: Integer | undefined,
  key: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (key === "limit") {
    if (!isUint64(value) || value <= 0) {
      throw new TypeError("list limit must be a positive integer");
    }
  } else if (!isUint64(value) || value < 0) {
    throw new TypeError(`list ${key} must be a non-negative integer`);
  }
  return integerText(value);
}

function encode(values: readonly (readonly [string, string])[]): string {
  if (values.length === 0) return "";
  const query = new URLSearchParams();
  for (const [key, value] of values) query.append(key, value);
  return `?${query.toString()}`;
}

/** Encodes only the continuation fields served by a page-only route. */
export function pageQuery(options: PageOptions): string {
  pageOptionsShape.unknownFields(options, "");
  const limit = options.limit ?? 0;
  if (!isUint64(limit) || limit < 0)
    throw new TypeError("limit must be a non-negative integer");
  if (options.continue !== undefined && typeof options.continue !== "string")
    throw new TypeError("continue must be a string");
  const query = new URLSearchParams();
  if (limit > 0) query.set("limit", integerText(limit));
  if ((options.continue ?? "") !== "")
    query.set("continue", options.continue ?? "");
  query.sort();
  return query.size === 0 ? "" : `?${query.toString()}`;
}

/**
 * The query of an image catalog read for one isolation class:
 * `?isolation=<class>`. The class is `secure-container` or `vm`, the classes
 * a Computer may select; any other value throws a `TypeError` before a
 * request is made.
 */
export function imageCatalogQuery(isolation: string): string {
  if (isolation !== "secure-container" && isolation !== "vm") {
    throw new TypeError(
      "list images: isolation class must be secure-container or vm",
    );
  }
  return `?${new URLSearchParams({ isolation }).toString()}`;
}

/** A saved file selector; exact byte spelling is retained in query fields. */
export function fileQuery(options: FileReadOptions): string {
  const query = new URLSearchParams();
  if (options.path !== undefined) query.set("path", options.path);
  if (options.pathBase64 !== undefined)
    query.set("pathBase64", options.pathBase64);
  if (options.version !== undefined && options.version !== "")
    query.set("version", options.version);
  query.sort();
  const value = query.toString();
  return value === "" ? "" : `?${value}`;
}
/**
 * The query of a file watch: `path` or `pathBase64` when one is set, and
 * `after` when it is not empty.
 */
export function watchFilesQuery(options: WatchFilesOptions): string {
  const query = new URLSearchParams();
  if (options.path !== undefined) query.set("path", options.path);
  if (options.pathBase64 !== undefined)
    query.set("pathBase64", options.pathBase64);
  if (options.after !== undefined && options.after !== "")
    query.set("after", options.after);
  query.sort();
  const value = query.toString();
  return value === "" ? "" : `?${value}`;
}
/** Saved files page by opaque positions and select a path and version. */
export function fileListQuery(options: FileListOptions): string {
  const query = new URLSearchParams(
    pageQuery({
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.continue === undefined ? {} : { continue: options.continue }),
    }).slice(1),
  );
  for (const [key, value] of new URLSearchParams(fileQuery(options).slice(1)))
    query.set(key, value);
  query.sort();
  const value = query.toString();
  return value === "" ? "" : `?${value}`;
}
