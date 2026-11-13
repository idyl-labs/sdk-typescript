// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * The Computer connection Worker of `@idyl-sh/sdk`: import this from the
 * module of a dedicated Worker and call {@link serveComputerConnections}
 * on its global scope. The page then builds a `ComputerConnector` from the
 * client (`idyl.computers.connector`) with that Worker and the compiled
 * `@idyl-sh/sdk/computer-connection.wasm`. Every command, terminal,
 * notebook cell and live files listing runs through the connector, each
 * session end-to-end encrypted between the page and the Computer.
 *
 * A program with no page, such as one on Node.js, calls
 * {@link connectInThisThread} instead and builds the connector from the
 * port and the module it returns.
 *
 * @example
 * ```ts
 * // connection-worker.ts
 * import { serveComputerConnections } from "@idyl-sh/sdk/computer-connection";
 *
 * serveComputerConnections(self);
 * ```
 *
 * ```ts
 * // The page, which serves `@idyl-sh/sdk/computer-connection.wasm`
 * // at `connectionWasmUrl`.
 * const connector = idyl.computers.connector({
 *   worker: new Worker(new URL("./connection-worker.js", import.meta.url), {
 *     type: "module",
 *   }),
 *   module: await WebAssembly.compileStreaming(fetch(connectionWasmUrl)),
 * });
 * await connector.ready();
 *
 * const computer = await idyl.computers.get("research");
 * const terminal = await computer.terminal({ size: { cols: 120, rows: 40 } });
 * ```
 *
 * @packageDocumentation
 */
export { serveComputerConnections } from "./worker.js";
export type { WorkerScope } from "./worker.js";
export { connectInThisThread } from "./in-thread.js";
export type { ThreadConnection } from "./in-thread.js";
