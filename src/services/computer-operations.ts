// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import * as operations from "../api/computer-operations.js";
import type { NamespaceScope } from "../api/types.js";
import type { PlacementContext } from "../internal/context.js";
import {
  computerById,
  namespaceResource,
  storageChild,
} from "../internal/apipath.js";
import { requireNonBlank, signalOption } from "../internal/options.js";
import { resolvePlacement } from "../internal/routing.js";
import { decodeValue, type Shape } from "../internal/strictdecode.js";
import {
  parseComputerId,
  parseComputerOperationId,
} from "../resource/uuid-id.js";
import type { RequestOptions } from "../request.js";
import { sameOperation, submission } from "./storage.js";

/**
 * Wakes and sleeps of a Computer, each an operation resource as
 * {@link operations.ComputerWake} and {@link operations.ComputerSleep}
 * describe. A create answers at once, pending or finished; the caller reads
 * the operation until its state is no longer `pending`. Every call
 * addresses the Computer either by name or, in its `ById` form, by its
 * stable ID, and needs `computer:update`. A read whose answer names another
 * operation is refused with a `TransportError` (`invalid_response`).
 */
export interface ComputerOperationMethods {
  /**
   * Asks for the Computer addressed by name to be woken. The answer is
   * `awake` at once when the Computer is already awake, and otherwise
   * `pending` until its execution has started.
   */
  createWake(
    address: string,
    request: operations.CreateComputerWakeRequest,
    requestOptions?: RequestOptions,
  ): Promise<operations.ComputerWake>;
  /** Asks for the Computer addressed by its stable ID to be woken, as {@link ComputerOperationMethods.createWake} does. */
  createWakeById(
    address: string,
    request: operations.CreateComputerWakeRequest,
    requestOptions?: RequestOptions,
  ): Promise<operations.ComputerWake>;
  /** Reads a wake of the Computer addressed by name. */
  getWake(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<operations.ComputerWake>;
  /** Reads a wake of the Computer addressed by its stable ID. */
  getWakeById(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<operations.ComputerWake>;
  /**
   * Asks for the Computer addressed by name to be put to sleep. The answer
   * is `asleep` at once when the Computer is already asleep, and otherwise
   * `pending` until its files have been saved, its sessions ended and its
   * execution released.
   */
  createSleep(
    address: string,
    request: operations.CreateComputerSleepRequest,
    requestOptions?: RequestOptions,
  ): Promise<operations.ComputerSleep>;
  /** Asks for the Computer addressed by its stable ID to be put to sleep, as {@link ComputerOperationMethods.createSleep} does. */
  createSleepById(
    address: string,
    request: operations.CreateComputerSleepRequest,
    requestOptions?: RequestOptions,
  ): Promise<operations.ComputerSleep>;
  /** Reads a sleep of the Computer addressed by name. */
  getSleep(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<operations.ComputerSleep>;
  /** Reads a sleep of the Computer addressed by its stable ID. */
  getSleepById(
    address: string,
    operation: string,
    requestOptions?: RequestOptions,
  ): Promise<operations.ComputerSleep>;
}

type ComputerPath = (scope: NamespaceScope) => string;

/** Composes the wake and sleep routes on the client's placement and transport. */
export function computerOperationMethods(
  context: PlacementContext,
): ComputerOperationMethods {
  function computerPath(address: string, byId: boolean): ComputerPath {
    if (byId) {
      const id = parseComputerId(address);
      return (scope) => computerById(scope, id);
    }
    requireNonBlank(address, "computer name");
    return (scope) => namespaceResource(scope, "computers", address);
  }
  async function exchange<T>(
    path: ComputerPath,
    method: "GET" | "POST",
    collection: "wakes" | "sleeps",
    shape: Shape<T>,
    requestOptions: RequestOptions,
    member?: string,
    body?: unknown,
  ): Promise<T> {
    const resolved = await resolvePlacement(
      context,
      signalOption(requestOptions.signal),
    );
    const value = await context.state.transport.json<unknown>(
      method,
      resolved.endpoint,
      storageChild(path(resolved.scope), collection, member),
      {
        ...signalOption(requestOptions.signal),
        ...(body === undefined ? {} : { body }),
      },
    );
    return decodeValue(value, shape, "lenient");
  }
  async function createWake(
    path: ComputerPath,
    request: operations.CreateComputerWakeRequest,
    requestOptions: RequestOptions,
  ): Promise<operations.ComputerWake> {
    const body = submission(request, operations.createComputerWakeRequestShape);
    return await exchange(
      path,
      "POST",
      "wakes",
      operations.computerWakeShape,
      requestOptions,
      undefined,
      body,
    );
  }
  async function getWake(
    path: ComputerPath,
    operation: string,
    requestOptions: RequestOptions,
  ): Promise<operations.ComputerWake> {
    const id = parseComputerOperationId(operation);
    return sameOperation(
      await exchange(
        path,
        "GET",
        "wakes",
        operations.computerWakeShape,
        requestOptions,
        id,
      ),
      id,
    );
  }
  async function createSleep(
    path: ComputerPath,
    request: operations.CreateComputerSleepRequest,
    requestOptions: RequestOptions,
  ): Promise<operations.ComputerSleep> {
    const body = submission(
      request,
      operations.createComputerSleepRequestShape,
    );
    return await exchange(
      path,
      "POST",
      "sleeps",
      operations.computerSleepShape,
      requestOptions,
      undefined,
      body,
    );
  }
  async function getSleep(
    path: ComputerPath,
    operation: string,
    requestOptions: RequestOptions,
  ): Promise<operations.ComputerSleep> {
    const id = parseComputerOperationId(operation);
    return sameOperation(
      await exchange(
        path,
        "GET",
        "sleeps",
        operations.computerSleepShape,
        requestOptions,
        id,
      ),
      id,
    );
  }
  return {
    async createWake(address, request, requestOptions = {}) {
      return await createWake(
        computerPath(address, false),
        request,
        requestOptions,
      );
    },
    async createWakeById(address, request, requestOptions = {}) {
      return await createWake(
        computerPath(address, true),
        request,
        requestOptions,
      );
    },
    async getWake(address, operation, requestOptions = {}) {
      return await getWake(
        computerPath(address, false),
        operation,
        requestOptions,
      );
    },
    async getWakeById(address, operation, requestOptions = {}) {
      return await getWake(
        computerPath(address, true),
        operation,
        requestOptions,
      );
    },
    async createSleep(address, request, requestOptions = {}) {
      return await createSleep(
        computerPath(address, false),
        request,
        requestOptions,
      );
    },
    async createSleepById(address, request, requestOptions = {}) {
      return await createSleep(
        computerPath(address, true),
        request,
        requestOptions,
      );
    },
    async getSleep(address, operation, requestOptions = {}) {
      return await getSleep(
        computerPath(address, false),
        operation,
        requestOptions,
      );
    },
    async getSleepById(address, operation, requestOptions = {}) {
      return await getSleep(
        computerPath(address, true),
        operation,
        requestOptions,
      );
    },
  };
}
