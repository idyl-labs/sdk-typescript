// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { ComputerNotebook } from "../api/computer-notebook.js";
import { validateComputerNotebookName } from "../api/computer-notebook-name.js";
import {
  pageOf,
  pageRequest,
  signalOf,
  walk,
  type CallOptions,
  type ListOptions,
  type Page,
  type PageOptions,
} from "./common.js";
import { serviceOf, type HandleState } from "./computer.js";
import { runCommand, type ExecOptions, type ExecResult } from "./exec.js";
import { cellOf, numberOf, type Cell } from "./records.js";

/** A notebook as it was when it was read. */
export interface NotebookInfo {
  /** The notebook's stable ID; it never changes, while its name may. */
  readonly id: string;
  /** The notebook's name, unique among the Computer's notebooks. */
  readonly name: string;
  /** When it was created, as an RFC 3339 instant. */
  readonly createdAt: string;
  /** Who created the notebook. */
  readonly creator: string;
  /** How many cells it holds. */
  readonly cells: number;
  /** Whether it is pinned; list pinned notebooks first. */
  readonly pinned: boolean;
}

/** Changes a notebook. */
export interface UpdateNotebookOptions extends CallOptions {
  /**
   * Renames the notebook: 3 to 63 lowercase letters, digits, or `-`,
   * starting with a letter, as a Computer's name is. A name another
   * notebook of the Computer holds rejects with an `ApiError` whose status
   * is 409.
   */
  readonly name?: string;
  /** Pins the notebook, or unpins with `false`. */
  readonly pinned?: boolean;
}

/**
 * A notebook: a named, recorded sequence of commands on a Computer. Each
 * command is a cell, run by {@link Notebook.run}; cells of one notebook run one
 * at a time, in order, each continuing in the working directory and environment
 * the one before it left. A `records` session reads the cells' output from the
 * Computer itself.
 */
export interface Notebook {
  /** The notebook's stable ID; it never changes, while its name may. */
  readonly id: string;
  /** The notebook's name when this handle was made. */
  readonly name: string;
  /** The notebook as it was when this handle was made. */
  readonly snapshot: NotebookInfo;
  /**
   * Runs a script as the notebook's next cell, through the Computer's POSIX
   * shell, and returns once it has ended and its changes are saved. The result
   * and any error carry the cell's ID as `cell`, which a fork can start from.
   * It waits as `Computer.exec` does, and a script holds at most 32 KiB.
   *
   * @param script the cell's script, run through the Computer's POSIX shell
   * @throws {@link TypeError} the script is empty, holds more than 32 KiB
   * or a NUL, or the client has no connector to run it on: a browser page
   * that has not built one with `idyl.computers.connector`, or a client with
   * no network or trust keys
   * @throws {@link ExitError} the script exits other than with 0; it
   * carries the exit code, the output and the cell's ID
   * @throws {@link CommandSaveError} the cell ended but its changes could not
   * be saved
   * @throws {@link CommandSessionError} the session failed before the cell's
   * end was known, or a stream passed 16 MiB
   * @throws {@link NotebookNotFoundError} the notebook does not exist, as
   * after a delete or a rename
   * @throws {@link ApiError} IDYL refuses the session
   * @throws {@link ComputerSessionEndedError} the session ended before it
   * ran, such as when the Computer was put to sleep
   * @throws {@link SessionTrustError} the network's session trust is refused
   * @throws {@link TransportError} a request does not complete
   */
  run(script: string, options?: ExecOptions): Promise<ExecResult>;
  /**
   * The notebook's cells, in the order they ran, page by page.
   *
   * @throws {@link TypeError} `limit` is not a positive integer
   * @throws {@link ApiError} IDYL refuses a page's request
   * @throws {@link TransportError} a page's request does not complete
   */
  cells(options?: ListOptions): AsyncIterable<Cell>;
  /**
   * One page of the notebook's cells.
   *
   * @throws {@link TypeError} `limit` is not a positive integer
   * @throws {@link ApiError} IDYL refuses the request, such as a `continue`
   * this listing did not issue
   * @throws {@link TransportError} the request does not complete
   */
  cellsPage(options?: PageOptions): Promise<Page<Cell>>;
  /**
   * Updates the notebook and returns a handle with its updated snapshot;
   * this handle keeps its earlier one, and after a rename it addresses the
   * old name, which is gone. A pin is the notebook's: the pin shows for
   * everyone who reads the Computer's notebooks. A rename keeps the ID and the
   * cells, and sessions already created keep recording into the notebook.
   *
   * @throws {@link TypeError} the update states nothing or names an invalid
   * name, before any request is sent
   * @throws {@link ApiError} IDYL refuses the update, such as a name another
   * notebook of the Computer holds (status 409)
   * @throws {@link TransportError} the request does not complete
   */
  update(options: UpdateNotebookOptions): Promise<Notebook>;
  /**
   * Deletes the notebook and its cells. The Computer's files are untouched.
   *
   * @throws {@link ApiError} IDYL refuses the delete
   * @throws {@link TransportError} the request does not complete
   */
  delete(options?: CallOptions): Promise<void>;
}

/**
 * A Computer's notebooks: `computer.notebooks`.
 *
 * @example
 * ```ts
 * const notebook = await computer.notebooks.create("setup");
 *
 * await notebook.run("cd app && npm ci");
 * const { stdout } = await notebook.run("npm test");
 * ```
 */
export interface Notebooks {
  /**
   * Creates a notebook, or returns the one that already has this name: it
   * is safe to call before every use. It is the only way a notebook comes
   * into being.
   *
   * @param name the notebook's name: 3 to 63 lowercase letters, digits, or
   * `-`, starting with a letter
   * @throws {@link TypeError} `name` is empty or invalid, before any request
   * is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  create(name: string, options?: CallOptions): Promise<Notebook>;
  /**
   * One notebook by name.
   *
   * @param name the notebook's name
   * @throws {@link TypeError} `name` is empty or invalid, before any request
   * is sent
   * @throws {@link NotebookNotFoundError} the Computer has no notebook of
   * this name
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  get(name: string, options?: CallOptions): Promise<Notebook>;
  /**
   * The Computer's notebooks, by name, page by page.
   *
   * @throws {@link TypeError} `limit` is not a positive integer
   * @throws {@link ApiError} IDYL refuses a page's request
   * @throws {@link TransportError} a page's request does not complete
   */
  list(options?: ListOptions): AsyncIterable<NotebookInfo>;
  /**
   * One page of the Computer's notebooks.
   *
   * @throws {@link TypeError} `limit` is not a positive integer
   * @throws {@link ApiError} IDYL refuses the request, such as a `continue`
   * this listing did not issue
   * @throws {@link TransportError} the request does not complete
   */
  listPage(options?: PageOptions): Promise<Page<NotebookInfo>>;
}

/** Builds the notebooks of the Computer `computerId`. */
export function notebooks(state: HandleState, computerId: string): Notebooks {
  const listPage = async (
    options: PageOptions = {},
  ): Promise<Page<NotebookInfo>> => {
    const service = await serviceOf(state, options);
    const page = await service.listNotebooksById(
      computerId,
      pageRequest(options),
      signalOf(options),
    );
    return pageOf(page.items.map(infoOf), page.continue);
  };
  return Object.freeze({
    async create(name: string, options: CallOptions = {}) {
      const notebook = requireName(name);
      const service = await serviceOf(state, options);
      return notebookOf(
        state,
        computerId,
        await service.createNotebookById(
          computerId,
          { name: notebook },
          signalOf(options),
        ),
      );
    },
    async get(name: string, options: CallOptions = {}) {
      const notebook = requireName(name);
      const service = await serviceOf(state, options);
      return notebookOf(
        state,
        computerId,
        await service.getNotebookById(computerId, notebook, signalOf(options)),
      );
    },
    list: (options: ListOptions = {}) => walk(listPage, options),
    listPage,
  });
}

function notebookOf(
  state: HandleState,
  computerId: string,
  record: ComputerNotebook,
): Notebook {
  const { id, name } = record;
  const cellsPage = async (options: PageOptions = {}): Promise<Page<Cell>> => {
    const service = await serviceOf(state, options);
    const page = await service.listNotebookCellsById(
      computerId,
      name,
      pageRequest(options),
      signalOf(options),
    );
    return pageOf(page.items.map(cellOf), page.continue);
  };
  return Object.freeze({
    id,
    name,
    snapshot: infoOf(record),
    async run(script: string, options: ExecOptions = {}) {
      const service = await serviceOf(state, options);
      return await state.connections.use((connector) =>
        runCommand(
          connector,
          computerId,
          { mode: "cell", script, notebook: name },
          (session, signal) =>
            service.getSessionById(
              computerId,
              session,
              signal === undefined ? {} : { signal },
            ),
          options.signal,
        ),
      );
    },
    cells: (options: ListOptions = {}) => walk(cellsPage, options),
    cellsPage,
    async update(options: UpdateNotebookOptions) {
      if (options.name === undefined && options.pinned === undefined) {
        throw new TypeError("notebook update states no field");
      }
      const request = {
        ...(options.name === undefined
          ? {}
          : { name: requireName(options.name) }),
        ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
      };
      const service = await serviceOf(state, options);
      return notebookOf(
        state,
        computerId,
        await service.updateNotebookById(
          computerId,
          name,
          request,
          signalOf(options),
        ),
      );
    },
    async delete(options: CallOptions = {}) {
      const service = await serviceOf(state, options);
      await service.deleteNotebookById(computerId, name, signalOf(options));
    },
  });
}

function infoOf(record: ComputerNotebook): NotebookInfo {
  return Object.freeze({
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    creator: record.creator,
    cells: numberOf(record.cells),
    pinned: record.pinned,
  });
}

/** Judges a notebook name before any request. */
function requireName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("notebook name is required");
  }
  validateComputerNotebookName(name);
  return name;
}
