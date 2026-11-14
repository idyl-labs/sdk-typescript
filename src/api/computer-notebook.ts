// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  always,
  array,
  boolean,
  decodeValue,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { parseJson } from "../resource/json.js";
import type { Integer, JsonObject } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";
import {
  parseComputerId,
  parseComputerNotebookId,
  type ComputerId,
  type ComputerNotebookId,
} from "../resource/uuid-id.js";
import { prefixed } from "../resource/validation.js";
import { computerCellShape, type ComputerCell } from "./computer-cell.js";
import { validateComputerNotebookName } from "./computer-notebook-name.js";
import { isZeroInstant } from "./computer-session.js";
import type { ListResponse } from "./types.js";

/**
 * Refuses a request that names a notebook the Computer does not have, with
 * HTTP 404: a session that names it, or a read, cell listing, or deletion
 * of it.
 */
export const ERROR_CODE_NOTEBOOK_NOT_FOUND = "NOTEBOOK_NOT_FOUND";

/**
 * A named, durable record of commands run in one Computer. Each command run
 * in a session that names the notebook becomes one of its cells, recording
 * the command, its output, its exit status, and the file version saved
 * after it. A session that names no notebook records nothing.
 *
 * A notebook belongs to one Computer and is addressed by its name, which
 * is unique within that Computer. The name may change; the ID never does.
 * A session names its notebook when it is created and records into that
 * notebook whatever the notebook is called later. A notebook runs one cell
 * at a time, in the order the sessions were created, and carries its working directory and exported environment
 * variables from each cell to the next, across the Computer stopping and
 * starting. An exported variable whose name is one of the Computer's
 * secrets is never recorded.
 *
 * A notebook can be pinned ({@link UpdateComputerNotebookRequest}): the pin
 * is the notebook's, seen by everyone who reads the Computer's notebooks,
 * and clients list pinned notebooks first. A notebook starts unpinned.
 *
 * Deleting a notebook deletes its cells. It never changes the Computer's
 * files: the saves its cells caused stay in the Computer's history.
 * Renaming a notebook is not recorded in the Computer's history.
 *
 * {@link decodeComputerNotebook} reads one leniently: a field newer than
 * this SDK is carried rather than refused, and
 * {@link validateComputerNotebook} judges it against this SDK's contract.
 * Instants are RFC 3339 strings.
 */
export interface ComputerNotebook {
  /** The notebook's stable ID; it never changes. Always written. */
  readonly id: ComputerNotebookId;
  /** Addresses the notebook within its Computer. Always written. */
  readonly name: string;
  /** The stable ID of the Computer the notebook belongs to. Always written. */
  readonly computer: ComputerId;
  /** When the notebook was created. Always written. */
  readonly createdAt: string;
  /** The identity that created the notebook. Always written. */
  readonly creator: string;
  /** The number of cells the notebook holds. Always written. */
  readonly cells: Integer;
  /** Whether the notebook is pinned. Always written, `false` included. */
  readonly pinned: boolean;
}

const computerNotebookShape: Shape<ComputerNotebook> = object<ComputerNotebook>(
  {
    id: always(string<ComputerNotebookId>()),
    name: always(string()),
    computer: always(string<ComputerId>()),
    createdAt: always(timestampShape),
    creator: always(string()),
    cells: always(integer({ unsigned: true, bits: 64 })),
    pinned: always(boolean()),
  },
);

/**
 * Reads a notebook the platform served, leniently. `document` is JSON text
 * or a value already parsed from JSON; a string is parsed once, as a
 * response is.
 */
export function decodeComputerNotebook(document: unknown): ComputerNotebook {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, computerNotebookShape, "lenient");
}

/** Renders a notebook as the document the platform emits. */
export function encodeComputerNotebook(notebook: ComputerNotebook): JsonObject {
  return computerNotebookShape.encode(notebook) as JsonObject;
}

/**
 * Judges the notebook against this SDK's contract: a canonical ID, a valid
 * name, a canonical Computer ID, a creation time, and a creator. Throws a
 * `TypeError`.
 */
export function validateComputerNotebook(notebook: ComputerNotebook): void {
  prefixed("id", () => {
    parseComputerNotebookId(notebook.id);
  });
  validateComputerNotebookName(notebook.name);
  prefixed("computer", () => {
    parseComputerId(notebook.computer);
  });
  if (isZeroInstant(notebook.createdAt)) {
    throw new TypeError("createdAt is required");
  }
  if (notebook.creator === "") throw new TypeError("creator is required");
}

/**
 * Creates a notebook in a Computer. Creating a notebook that already exists
 * succeeds and returns it unchanged, so a client may create a notebook
 * before every use.
 */
export interface CreateComputerNotebookRequest {
  /** The notebook's name, as {@link validateComputerNotebookName} describes. */
  readonly name: string;
}

/** The wire shape of a notebook create request: `name` always written. */
export const createComputerNotebookRequestShape: Shape<CreateComputerNotebookRequest> =
  object<CreateComputerNotebookRequest>({
    name: always(string()),
  });

/** Judges that the request names a valid notebook. Throws a `TypeError`. */
export function validateCreateComputerNotebookRequest(
  request: CreateComputerNotebookRequest,
): void {
  validateComputerNotebookName(request.name);
}

/**
 * Renders a notebook create request as the document the route carries. A
 * field the request does not declare is refused with a `StrictDecodeError`.
 */
export function encodeCreateComputerNotebookRequest(
  request: CreateComputerNotebookRequest,
): JsonObject {
  createComputerNotebookRequestShape.unknownFields(request, "");
  const value = createComputerNotebookRequestShape.encode(request);
  decodeValue(value, createComputerNotebookRequestShape, "strict");
  return value as JsonObject;
}

/**
 * Changes a notebook field by field: only the fields a request states
 * reach the wire.
 *
 * A new name takes effect at once: the old name addresses nothing and is
 * free for another notebook, and sessions already created keep recording
 * into the notebook. A name another notebook of the Computer holds is
 * refused with HTTP 409, and a refused update changes nothing.
 */
export interface UpdateComputerNotebookRequest {
  /**
   * The notebook's new name, as {@link validateComputerNotebookName}
   * describes.
   */
  readonly name?: string;
  /** Pins the notebook, or unpins with `false`. */
  readonly pinned?: boolean;
}

/** The wire shape of a notebook update request: each field when stated. */
export const updateComputerNotebookRequestShape: Shape<UpdateComputerNotebookRequest> =
  object<UpdateComputerNotebookRequest>({
    name: pointer(string()),
    pinned: pointer(boolean()),
  });

/**
 * Requires the update to state a field, since one that states none would
 * change nothing, and a new name to be valid. Throws a `TypeError`.
 */
export function validateUpdateComputerNotebookRequest(
  request: UpdateComputerNotebookRequest,
): void {
  const { name, pinned } = request;
  if (name === undefined && pinned === undefined) {
    throw new TypeError("notebook update states no field");
  }
  if (name !== undefined) {
    prefixed("notebook update", () => {
      validateComputerNotebookName(name);
    });
  }
}

/**
 * Renders a notebook update request as the document the route carries. A
 * field the request does not declare is refused with a `StrictDecodeError`.
 */
export function encodeUpdateComputerNotebookRequest(
  request: UpdateComputerNotebookRequest,
): JsonObject {
  updateComputerNotebookRequestShape.unknownFields(request, "");
  const value = updateComputerNotebookRequestShape.encode(request);
  decodeValue(value, updateComputerNotebookRequestShape, "strict");
  return value as JsonObject;
}

/** One page of a Computer's notebooks, ordered by name. */
export type ListComputerNotebooksResponse = ListResponse<ComputerNotebook>;

/** One page of a notebook's cells, in the order they ran. */
export type ListComputerNotebookCellsResponse = ListResponse<ComputerCell>;

const listComputerNotebooksResponseShape: Shape<ListComputerNotebooksResponse> =
  object<ListComputerNotebooksResponse>({
    items: always(array(computerNotebookShape)),
    totalCount: always(integer({ unsigned: false, bits: 64 })),
    snapshotCursor: omitEmpty(string()),
    continue: omitEmpty(string()),
  });

const listComputerNotebookCellsResponseShape: Shape<ListComputerNotebookCellsResponse> =
  object<ListComputerNotebookCellsResponse>({
    items: always(array(computerCellShape)),
    totalCount: always(integer({ unsigned: false, bits: 64 })),
    snapshotCursor: omitEmpty(string()),
    continue: omitEmpty(string()),
  });

/** Reads a page of notebooks the platform served, leniently. */
export function decodeListComputerNotebooksResponse(
  document: unknown,
): ListComputerNotebooksResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, listComputerNotebooksResponseShape, "lenient");
}

/**
 * Renders a page of notebooks as the document the platform emits: `items`
 * and `totalCount` always, `continue` only on a page that is not the last.
 */
export function encodeListComputerNotebooksResponse(
  page: ListComputerNotebooksResponse,
): JsonObject {
  return listComputerNotebooksResponseShape.encode(page) as JsonObject;
}

/**
 * Reads a page of notebook cells the platform served, leniently: a field,
 * token, or command member newer than this SDK is carried rather than
 * refused, and `validateComputerCell` judges each cell.
 */
export function decodeListComputerNotebookCellsResponse(
  document: unknown,
): ListComputerNotebookCellsResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, listComputerNotebookCellsResponseShape, "lenient");
}

/**
 * Renders a page of notebook cells as the document the platform emits:
 * `items` and `totalCount` always, `continue` only on a page that is not
 * the last.
 */
export function encodeListComputerNotebookCellsResponse(
  page: ListComputerNotebookCellsResponse,
): JsonObject {
  return listComputerNotebookCellsResponseShape.encode(page) as JsonObject;
}
