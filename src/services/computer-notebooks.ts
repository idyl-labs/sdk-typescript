// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * A Computer's notebooks are named records of the commands run in it. A
 * session that names a notebook records its command as a cell of that
 * notebook; a session that names none records nothing. Every notebook call
 * addresses the Computer by name or by its stable identity, and the
 * notebook by its name, on the Subnet the client's placement resolves to.
 */
import { TransportError } from "../errors.js";
import type { NamespaceScope } from "../api/types.js";
import type { PageOptions } from "../api/storage.js";
import { validateComputerNotebookName } from "../api/computer-notebook-name.js";
import {
  decodeComputerNotebook,
  decodeListComputerNotebookCellsResponse,
  decodeListComputerNotebooksResponse,
  encodeCreateComputerNotebookRequest,
  encodeUpdateComputerNotebookRequest,
  validateCreateComputerNotebookRequest,
  validateUpdateComputerNotebookRequest,
  type ComputerNotebook,
  type CreateComputerNotebookRequest,
  type UpdateComputerNotebookRequest,
  type ListComputerNotebookCellsResponse,
  type ListComputerNotebooksResponse,
} from "../api/computer-notebook.js";
import {
  computerNotebooks,
  computerNotebooksById,
} from "../internal/apipath.js";
import type { PlacementContext } from "../internal/context.js";
import { listEnvelope } from "../internal/envelopes.js";
import { pageQuery } from "../internal/listquery.js";
import { requireNonBlank, signalOption } from "../internal/options.js";
import { resolvePlacement } from "../internal/routing.js";
import { parseComputerId } from "../resource/uuid-id.js";

/**
 * One Computer's notebook collection, built from the scope the resolution
 * named; with `notebook`, one notebook of it.
 */
export type NotebooksPath = (
  scope: NamespaceScope,
  notebook?: string,
) => string;

/**
 * The notebooks of the Computer addressed by name. Throws a `TypeError`
 * when `name` is blank.
 */
export function notebooksByName(name: string): NotebooksPath {
  requireNonBlank(name, "computer name");
  return (scope, notebook) => computerNotebooks(scope, name, notebook);
}

/**
 * The notebooks of the Computer addressed by its stable identity. Throws a
 * `TypeError` when `id` is not a canonical UUID.
 */
export function notebooksById(id: string): NotebooksPath {
  const computerId = parseComputerId(id);
  return (scope, notebook) =>
    computerNotebooksById(scope, computerId, notebook);
}

/**
 * Creates a notebook, or returns the one that already holds the name. The
 * request is judged before anything is sent, and a response naming another
 * notebook is refused.
 */
export async function createNotebook(
  context: PlacementContext,
  notebooks: NotebooksPath,
  request: CreateComputerNotebookRequest,
  signal: AbortSignal | undefined,
): Promise<ComputerNotebook> {
  validateCreateComputerNotebookRequest(request);
  const body = encodeCreateComputerNotebookRequest(request);
  const resolved = await resolvePlacement(context, signalOption(signal));
  const notebook = decodeComputerNotebook(
    await context.state.transport.json<unknown>(
      "POST",
      resolved.endpoint,
      notebooks(resolved.scope),
      { body, ...signalOption(signal) },
    ),
  );
  if (notebook.name !== request.name) {
    throw new TransportError(
      "invalid_response",
      "create computer notebook response names a different notebook",
    );
  }
  return notebook;
}

/** Reads one notebook. A response naming another notebook is refused. */
export async function getNotebook(
  context: PlacementContext,
  notebooks: NotebooksPath,
  notebook: string,
  signal: AbortSignal | undefined,
): Promise<ComputerNotebook> {
  validateComputerNotebookName(notebook);
  const resolved = await resolvePlacement(context, signalOption(signal));
  const read = decodeComputerNotebook(
    await context.state.transport.json<unknown>(
      "GET",
      resolved.endpoint,
      notebooks(resolved.scope, notebook),
      signalOption(signal),
    ),
  );
  if (read.name !== notebook) {
    throw new TransportError(
      "invalid_response",
      "read computer notebook response names a different notebook",
    );
  }
  return read;
}

/**
 * Reads one page of the notebooks. The options are judged before any
 * request is sent, and the page is read leniently once its envelope is one.
 */
export async function listNotebooks(
  context: PlacementContext,
  notebooks: NotebooksPath,
  options: PageOptions,
  signal: AbortSignal | undefined,
): Promise<ListComputerNotebooksResponse> {
  const query = pageQuery(options);
  const resolved = await resolvePlacement(context, signalOption(signal));
  const response = await context.state.transport.json<unknown>(
    "GET",
    resolved.endpoint,
    `${notebooks(resolved.scope)}${query}`,
    signalOption(signal),
  );
  listEnvelope(response, "computer notebooks");
  return decodeListComputerNotebooksResponse(response);
}

/**
 * Reads one page of a notebook's cells. The notebook name and the options
 * are judged before any request is sent, and the page is read leniently
 * once its envelope is one.
 */
export async function listNotebookCells(
  context: PlacementContext,
  notebooks: NotebooksPath,
  notebook: string,
  options: PageOptions,
  signal: AbortSignal | undefined,
): Promise<ListComputerNotebookCellsResponse> {
  validateComputerNotebookName(notebook);
  const query = pageQuery(options);
  const resolved = await resolvePlacement(context, signalOption(signal));
  const response = await context.state.transport.json<unknown>(
    "GET",
    resolved.endpoint,
    `${notebooks(resolved.scope, notebook)}/cells${query}`,
    signalOption(signal),
  );
  listEnvelope(response, "computer notebook cells");
  return decodeListComputerNotebookCellsResponse(response);
}

/**
 * Updates one notebook and returns it as the update left it. The notebook
 * name and the request are judged before anything is sent, and a response
 * naming another notebook is refused.
 */
export async function updateNotebook(
  context: PlacementContext,
  notebooks: NotebooksPath,
  notebook: string,
  request: UpdateComputerNotebookRequest,
  signal: AbortSignal | undefined,
): Promise<ComputerNotebook> {
  validateComputerNotebookName(notebook);
  validateUpdateComputerNotebookRequest(request);
  const body = encodeUpdateComputerNotebookRequest(request);
  const resolved = await resolvePlacement(context, signalOption(signal));
  const updated = decodeComputerNotebook(
    await context.state.transport.json<unknown>(
      "PATCH",
      resolved.endpoint,
      notebooks(resolved.scope, notebook),
      { body, ...signalOption(signal) },
    ),
  );
  if (updated.name !== (request.name ?? notebook)) {
    throw new TransportError(
      "invalid_response",
      "update computer notebook response names a different notebook",
    );
  }
  return updated;
}

/** Deletes one notebook and its cells. */
export async function deleteNotebook(
  context: PlacementContext,
  notebooks: NotebooksPath,
  notebook: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  validateComputerNotebookName(notebook);
  const resolved = await resolvePlacement(context, signalOption(signal));
  await context.state.transport.json<undefined>(
    "DELETE",
    resolved.endpoint,
    notebooks(resolved.scope, notebook),
    { response: "none", ...signalOption(signal) },
  );
}
