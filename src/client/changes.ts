// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The changes a handle's waits listen for, from the connector the client
// holds. A client that holds none, as a one-off program that opens no
// session, waits as with no event stream.

import { connectorWaitEvents } from "../computer-connection/connector.js";
import type { ComputerChange } from "../computer-connection/listening.js";
import type { WaitEvents } from "../wait.js";
import type { HandleState } from "./computer.js";

/**
 * The events that end a wait's pause on a Computer of `state` for a change
 * `matches` accepts; none when the client holds no connector.
 */
export function changesOf(
  state: HandleState,
  matches: (change: ComputerChange) => boolean,
): { readonly events?: WaitEvents } {
  const connector = state.connections.current();
  const events =
    connector === undefined
      ? undefined
      : connectorWaitEvents(connector, state.namespace, matches);
  return events === undefined ? {} : { events };
}

/** A change to the operation `id`: a waiter matches on its ID alone. */
export function operationChange(
  id: string,
): (change: ComputerChange) => boolean {
  return (change) => change.part === "operation" && change.id === id;
}

/** A change to the Computer `id` itself, as a fork's copy or a deletion makes. */
export function computerChange(
  id: string,
): (change: ComputerChange) => boolean {
  return (change) => change.part === "computer" && change.computer === id;
}

/** A change to the session `id`, as its placement or its save result. */
export function sessionChange(id: string): (change: ComputerChange) => boolean {
  return (change) => change.part === "session" && change.id === id;
}
