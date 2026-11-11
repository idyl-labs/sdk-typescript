// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { ComputerConnector } from "../computer-connection/connector.js";
import type { ThreadConnection } from "../computer-connection/in-thread.js";
import type { TrustKey } from "../computer-connection/trust.js";
import { isBrowserDocument } from "../internal/browser.js";

/**
 * How long a connector the client started for itself stays open with no
 * command running, in milliseconds. Commands in a row share one connection;
 * a program with nothing left to do exits this soon after its last command,
 * because an open connection keeps a Node.js process alive.
 */
const IDLE_CLOSE_MS = 1_000;

/** What a connector runs on, as the client built or was given it. */
export interface ConnectorParts {
  readonly worker: ThreadConnection["worker"];
  readonly module: WebAssembly.Module;
  readonly network: string;
  readonly trustKeys: readonly TrustKey[];
}

/** A connector in use. */
export interface ConnectionHold {
  readonly connector: ComputerConnector;
  /** Ends this use. Calling it again changes nothing. */
  readonly release: () => void;
}

/** The connectors of one client. */
export interface Connections {
  /** The Network and trust keys of the client, for a connector it builds. */
  readonly network: string | undefined;
  readonly trustKeys: readonly TrustKey[] | undefined;
  /**
   * Keeps `connector`, built by the application, as the one every later
   * command runs on. Its life is the application's. Returns `connector`.
   */
  adopt(connector: ComputerConnector): ComputerConnector;
  /** A use of the adopted connector, or of one started for it. */
  hold(): Promise<ConnectionHold>;
  /** Runs `work` on the connector of a {@link hold}, released when it ends. */
  use<T>(work: (connector: ComputerConnector) => Promise<T>): Promise<T>;
}

/** What {@link connections} builds from. */
export interface ConnectionsOptions {
  readonly network: string | undefined;
  readonly trustKeys: readonly TrustKey[] | undefined;
  readonly build: (parts: ConnectorParts) => ComputerConnector;
  /** Serves a connection in this thread. */
  readonly connect?: () => Promise<ThreadConnection>;
}

async function connectFromPackage(): Promise<ThreadConnection> {
  // The connection and its WebAssembly load only for a program that runs a
  // command, and never count against the client's own size.
  const { connectInThisThread } =
    await import("@idyl-sh/sdk/computer-connection");
  return await connectInThisThread();
}

/**
 * The connectors of one client. A browser page holds its connection in a
 * dedicated Worker, which only the application can start, so a page builds
 * its connector and adopts it. Any other program needs none of that: the
 * client starts a connector on the first command, in the program's own
 * thread, and closes it once no command has run for a moment.
 */
export function connections(options: ConnectionsOptions): Connections {
  const { network, trustKeys, build } = options;
  const connect = options.connect ?? connectFromPackage;
  let adopted: ComputerConnector | undefined;
  let started: Promise<ComputerConnector> | undefined;
  let running = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const start = (): Promise<ComputerConnector> => {
    if (isBrowserDocument()) {
      throw new TypeError(
        "a page runs commands through a connector of its own: build one with idyl.computers.connector first",
      );
    }
    if (network === undefined) {
      throw new TypeError(
        "a client built from endpoints alone names no network to run commands on",
      );
    }
    if (trustKeys === undefined || trustKeys.length === 0) {
      throw new TypeError(
        `no trust keys are known for the network ${network}: state trustKeys on the client`,
      );
    }
    const starting = connect().then(({ worker, module }) =>
      build({ worker, module, network, trustKeys }),
    );
    starting.catch(() => {
      if (started === starting) started = undefined;
    });
    return starting;
  };

  const end = (): void => {
    running -= 1;
    if (running > 0) return;
    idle = setTimeout(() => {
      idle = undefined;
      const closing = started;
      started = undefined;
      void closing?.then(
        (connector) => {
          connector.close();
        },
        () => undefined,
      );
    }, IDLE_CLOSE_MS);
  };

  const hold = async (): Promise<ConnectionHold> => {
    if (adopted !== undefined) {
      return { connector: adopted, release: () => undefined };
    }
    if (idle !== undefined) clearTimeout(idle);
    idle = undefined;
    running += 1;
    let held = true;
    const release = (): void => {
      if (held) end();
      held = false;
    };
    try {
      started ??= start();
      return { connector: await started, release };
    } catch (error) {
      release();
      throw error;
    }
  };

  return Object.freeze({
    network,
    trustKeys,
    adopt(connector: ComputerConnector) {
      adopted = connector;
      return connector;
    },
    hold,
    async use<T>(work: (connector: ComputerConnector) => Promise<T>) {
      const { connector, release } = await hold();
      try {
        return await work(connector);
      } finally {
        release();
      }
    },
  });
}
