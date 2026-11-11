// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The slice of a client's state that services read.
 * The shapes are structural, so a client hands its own internals across
 * without an adapter, and nothing below the client layer names the client.
 */
import type { AccountId } from "../resource/id.js";
import type { PlacementSource } from "./placement.js";
import type { Transport } from "./transport.js";

/** The resolved public endpoints and the transport every request goes through. */
export interface ServiceState {
  readonly endpoints: {
    readonly api: string;
    readonly identity?: string;
    readonly meta?: string;
  };
  readonly scheme: "https:" | "http:";
  readonly transport: Transport;
}

/** The Account and Namespace a Computer operation runs in. */
export interface WorkloadScope {
  readonly accountId: AccountId;
  readonly namespace?: string;
}

/** What placement resolution and Computer services read from a client. */
export interface PlacementContext {
  readonly state: ServiceState;
  readonly scope: WorkloadScope;
  /** Where the Account's Computers live; the client's one source of it. */
  readonly placement: PlacementSource;
}
