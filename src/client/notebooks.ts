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
  readonly name: string;
  /** When it was created, as an RFC 3339 instant. */
  readonly createdAt: string;
  /** Who created it. */
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
  /** Pins the notebook, or with `false` unpins it. */
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
   * It waits for and rejects as `Computer.exec` does, and a script holds at most
   * 32 KiB.
   */
  run(script: string, options?: ExecOptions): Promise<ExecResult>;
  /** The notebook's cells, in the order they ran, page by page. */
  cells(options?: ListOptions): AsyncIterable<Cell>;
  /** One page of the notebook's cells. */
  cellsPage(options?: PageOptions): Promise<Page<Cell>>;
  /**
   * Changes the notebook and returns a handle with its new snapshot; this
   * handle keeps its old one, and after a rename it addresses the old name,
   * which no longer exists. A pin is the notebook's: everyone who reads the
   * Computer's notebooks sees it. A rename keeps the ID and the cells, and
   * sessions already created keep recording into the notebook. Throws a
   * `TypeError` before any request when the update states nothing or names
   * an invalid name.
   */
  update(options: UpdateNotebookOptions): Promise<Notebook>;
  /** Deletes the notebook and its cells. The Computer's files are untouched. */
  delete(options?: CallOptions): Promise<void>;
}

/** A Computer's notebooks. */
export interface Notebooks {
  /**
   * Creates a notebook, or returns the one that already has this name: it
   * is safe to call before every use. It is the only way a notebook comes
   * into being.
   */
  create(name: string, options?: CallOptions): Promise<Notebook>;
  /** One notebook by name; a missing one rejects with a `NotebookNotFoundError`. */
  get(name: string, options?: CallOptions): Promise<Notebook>;
  /** The Computer's notebooks, by name, page by page. */
  list(options?: ListOptions): AsyncIterable<NotebookInfo>;
  /** One page of the Computer's notebooks. */
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
