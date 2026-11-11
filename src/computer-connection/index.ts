// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * The Computer connection Worker of `@idyl-sh/sdk`: import this from the
 * module of a dedicated Worker and call {@link serveComputerConnections}
 * on its global scope. The page then builds a `ComputerConnector` from the
 * client (`idyl.computers.connector`) with that Worker and the compiled
 * `@idyl-sh/sdk/computer-connection.wasm`.
 */
export { serveComputerConnections } from "./worker.js";
export type { WorkerScope } from "./worker.js";
export { connectInThisThread } from "./in-thread.js";
export type { ThreadConnection } from "./in-thread.js";
