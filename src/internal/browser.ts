// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * What the SDK knows about the runtime it is loaded in. It answers one
 * question, whether the runtime is a browser document, from the global
 * object alone, and it is the only place that question is asked. One
 * behaviour follows from the answer: who owns the `User-Agent` header.
 */

/** The globals a browser document defines and every other runtime lacks. */
interface DocumentScope {
  readonly window?: unknown;
  readonly document?: unknown;
}

/**
 * Reports whether `scope`, the global object by default, is a browser
 * document. A runtime is one when its global object carries both `window`
 * and `document` as objects: Node.js, Bun, Deno, and Workers-class
 * runtimes define neither together.
 */
export function isBrowserDocument(scope: object = globalThis): boolean {
  const { window, document } = scope as DocumentScope;
  return isObject(window) && isObject(document);
}

/**
 * Reports whether `scope`, the global object by default, is a browser
 * document, where the browser owns the `User-Agent` header. A browser sets
 * that header itself on every request. Chromium discards a value a script
 * sets; WebKit and Gecko send it, but as a header outside the CORS
 * safelist, so a cross-origin request carrying it needs the server's
 * preflight to admit `user-agent` and fails when it does not. The transport
 * therefore leaves the default `User-Agent` to the browser here and sends
 * it everywhere else.
 */
export function browserOwnsUserAgent(scope: object = globalThis): boolean {
  return isBrowserDocument(scope);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
