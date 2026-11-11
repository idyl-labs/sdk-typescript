// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The Computer connection for a program with no page to protect: the code a
// dedicated Worker runs in a browser runs here in the program's own thread,
// behind the same messages.

import type { WorkerPort } from "./connector.js";
import type { PageToWorker, WorkerToPage } from "./messages.js";
import { serveComputerConnections, type WorkerScope } from "./worker.js";

/** A connection served in this thread, and the module it runs. */
export interface ThreadConnection {
  /** The port a connector talks to the connection through. */
  readonly worker: WorkerPort;
  /** `computer-connection.wasm`, compiled. */
  readonly module: WebAssembly.Module;
}

/** The part of a Node.js-compatible `process` this module reads. */
interface HostProcess {
  getBuiltinModule?(
    id: "node:fs",
  ): { readFileSync(path: URL): Uint8Array<ArrayBuffer> } | undefined;
}

/** The compiled connection, once per thread. */
let compiled: Promise<WebAssembly.Module> | undefined;

/**
 * Serves a Computer connection in this thread and compiles the module beside
 * this file. Each call serves a connection of its own, with a key of its own,
 * which lives as long as the thread. A runtime that cannot read the module
 * beside this file rejects with a `TypeError`; there, build a connector from
 * a port and a module of your own.
 */
export async function connectInThisThread(): Promise<ThreadConnection> {
  compiled ??= compileConnection().catch((error: unknown) => {
    compiled = undefined;
    throw error;
  });
  const module = await compiled;
  const { page, connection } = messagePorts();
  serveComputerConnections(connection);
  return { worker: page, module };
}

async function compileConnection(): Promise<WebAssembly.Module> {
  const location = new URL("./computer-connection.wasm", import.meta.url);
  if (location.protocol !== "file:") {
    const response = await fetch(location);
    if (!response.ok) {
      throw new TypeError("the Computer connection module cannot be read");
    }
    return await WebAssembly.compile(await response.arrayBuffer());
  }
  const host = (globalThis as { readonly process?: HostProcess }).process;
  const fs = host?.getBuiltinModule?.("node:fs");
  if (fs === undefined) {
    throw new TypeError("the Computer connection module cannot be read");
  }
  return await WebAssembly.compile(fs.readFileSync(location));
}

/**
 * Two ends of one in-thread channel. A message reaches the other end in a
 * later microtask, in the order it was sent, and is handed over as it is: a
 * sender never touches a buffer again once it has sent it.
 */
function messagePorts(): {
  readonly page: WorkerPort;
  readonly connection: WorkerScope;
} {
  type Listener<T> = (event: MessageEvent<T>) => void;
  const toConnection = new Set<Listener<PageToWorker>>();
  const toPage = new Set<Listener<WorkerToPage>>();
  const deliver = <T>(listeners: ReadonlySet<Listener<T>>, data: T): void => {
    queueMicrotask(() => {
      for (const listener of listeners) {
        listener({ data } as MessageEvent<T>);
      }
    });
  };
  return {
    page: {
      postMessage: (message) => {
        deliver(toConnection, message);
      },
      addEventListener: (_type, listener) => {
        toPage.add(listener);
      },
    },
    connection: {
      postMessage: (message) => {
        deliver(toPage, message);
      },
      addEventListener: (_type, listener) => {
        toConnection.add(listener);
      },
    },
  };
}
