// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * The codecs the served-object conformance suite drives, one per kind the
 * platform serves in a shape of its own.
 *
 * `decode` is the lenient read every response receives, the kind's own
 * `decode*` function over the shared walker: JSON text is parsed once, a
 * field this SDK does not declare survives the read, and a missing field
 * reads as its zero value. `encode` renders the typed value as the document
 * the platform emits, and the suite requires it to deep-equal the golden it
 * read. `validate` judges what the reference contract judges on the served
 * object: the phase or status vocabulary, and a Computer's execution state.
 *
 * Keys are the golden fixture's kind name for a served object (`namespace`,
 * `computer`), and `<kind>.<state>` for a route's request or response
 * envelope (`computer.update-request`). A fixture whose key is absent here
 * is pending, and `served-pending.ts` names it by file; the suite fails when
 * a fixture is neither registered nor pending.
 *
 * A `<kind>.refusals` fixture is a list of documents the kind's validation
 * refuses, each with the refusal; its codec lives in `servedRefusals`.
 */
import {
  decodeListComputerSecretAttachmentsResponse,
  decodeListComputersBySecretResponse,
  encodeListComputerSecretAttachmentsResponse,
  encodeListComputersBySecretResponse,
  validateListComputerSecretAttachmentsResponse,
  validateListComputersBySecretResponse,
  type ListComputerSecretAttachmentsResponse,
  type ListComputersBySecretResponse,
} from "../../src/api/computer-secrets.js";
import {
  computerAwakeShape,
  decodeComputerAwake,
  decodeListComputerSessionsResponse,
  encodeListComputerSessionsResponse,
  validateComputerAwake,
  validateComputerSessionSummary,
  type ComputerAwake,
  type ListComputerSessionsResponse,
} from "../../src/api/computer-awake.js";
import {
  createComputerRequestShape,
  decodeComputer,
  encodeComputer,
  updateComputerRequestShape,
  updateComputerResponseShape,
  validateComputerExecution,
  validateComputerPhase,
  validateCreateComputerRequest,
  validateUpdateComputerRequest,
  type Computer,
  type CreateComputerRequest,
  type UpdateComputerRequest,
  type UpdateComputerResponse,
} from "../../src/api/computer.js";
import { validateComputerCell } from "../../src/api/computer-cell.js";
import {
  decodeComputerImage,
  decodeListComputerImagesResponse,
  encodeComputerImage,
  encodeListComputerImagesResponse,
  validateComputerExecutionSettingsImageStatus,
  validateComputerImage,
  type ComputerImage,
  type ListComputerImagesResponse,
} from "../../src/api/computer-image.js";
import {
  createComputerNotebookRequestShape,
  decodeComputerNotebook,
  decodeListComputerNotebookCellsResponse,
  decodeListComputerNotebooksResponse,
  encodeComputerNotebook,
  encodeListComputerNotebookCellsResponse,
  encodeListComputerNotebooksResponse,
  updateComputerNotebookRequestShape,
  validateComputerNotebook,
  validateCreateComputerNotebookRequest,
  validateUpdateComputerNotebookRequest,
  type ComputerNotebook,
  type CreateComputerNotebookRequest,
  type ListComputerNotebookCellsResponse,
  type ListComputerNotebooksResponse,
  type UpdateComputerNotebookRequest,
} from "../../src/api/computer-notebook.js";
import {
  createComputerSessionRequestShape,
  decodeComputerSession,
  encodeComputerSession,
  validateComputerSession,
  validateCreateComputerSessionRequest,
  type ComputerSession,
  type CreateComputerSessionRequest,
} from "../../src/api/computer-session.js";
import {
  decodeJournalEntry,
  decodeJournalPage,
  encodeJournalEntry,
  encodeJournalPage,
  validateJournalEntry,
  type JournalEntry,
  type ListJournalResponse,
} from "../../src/api/journal.js";
import {
  decodeNamespace,
  encodeNamespace,
  validateNamespacePhase,
  type Namespace,
} from "../../src/api/namespace.js";
import {
  decodeNetwork,
  encodeNetwork,
  validateNetwork,
  type Network,
} from "../../src/api/network.js";
import {
  decodeListComputerSizesResponse,
  encodeListComputerSizesResponse,
  validateListComputerSizesResponse,
  type ListComputerSizesResponse,
} from "../../src/api/computer-size.js";
import type { ErrorResponse } from "../../src/api/types.js";
import {
  always,
  decodeValue,
  jsonObject,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../../src/internal/strictdecode.js";
import { validateComputerSpec } from "../../src/resource/computer.js";
import { parseJson } from "../../src/resource/json.js";
import { storageRegistry } from "./storage-registry.js";
import { billingRegistry } from "./billing-registry.js";

export interface ServedCodec<T> {
  decode(document: unknown): T;
  encode(value: T): unknown;
  validate(value: T): void;
}

const namespace: ServedCodec<Namespace> = {
  decode: decodeNamespace,
  encode: encodeNamespace,
  validate: (value) => {
    validateNamespacePhase(value.phase);
  },
};

const network: ServedCodec<Network> = {
  decode: decodeNetwork,
  encode: encodeNetwork,
  validate: validateNetwork,
};

/**
 * Judges a served Computer as the reference contract does: phase,
 * execution, spec, and the image its computer reports.
 */
function validateServedComputer(value: Computer): void {
  validateComputerPhase(value.phase);
  validateComputerExecution(value.execution);
  validateComputerSpec(value.spec);
  if (value.executionSettings?.image !== undefined) {
    validateComputerExecutionSettingsImageStatus(value.executionSettings.image);
  }
}

const computer: ServedCodec<Computer> = {
  decode: decodeComputer,
  encode: encodeComputer,
  validate: validateServedComputer,
};

/**
 * The codec of a route envelope with no decoder of its own: its shape read
 * leniently, as every response is, and encoded back.
 */
function envelope<T>(
  shape: Shape<T>,
  validate: (value: T) => void,
): ServedCodec<T> {
  return {
    decode: (document) =>
      decodeValue(
        typeof document === "string" ? parseJson(document) : document,
        shape,
        "lenient",
      ),
    encode: (value) => shape.encode(value),
    validate,
  };
}

const createComputerRequest = envelope<CreateComputerRequest>(
  createComputerRequestShape,
  validateCreateComputerRequest,
);

const updateComputerRequest = envelope<UpdateComputerRequest>(
  updateComputerRequestShape,
  validateUpdateComputerRequest,
);

const updateComputerResponse = envelope<UpdateComputerResponse>(
  updateComputerResponseShape,
  (value) => {
    validateServedComputer(value.computer);
  },
);

const createComputerSessionRequest = envelope<CreateComputerSessionRequest>(
  createComputerSessionRequestShape,
  validateCreateComputerSessionRequest,
);

const computerSession: ServedCodec<ComputerSession> = {
  decode: decodeComputerSession,
  encode: encodeComputerSession,
  validate: validateComputerSession,
};

const computerNotebook: ServedCodec<ComputerNotebook> = {
  decode: decodeComputerNotebook,
  encode: encodeComputerNotebook,
  validate: validateComputerNotebook,
};

const computerNotebookPage: ServedCodec<ListComputerNotebooksResponse> = {
  decode: decodeListComputerNotebooksResponse,
  encode: encodeListComputerNotebooksResponse,
  validate: (page) => {
    for (const notebook of page.items) validateComputerNotebook(notebook);
  },
};

const computerNotebookCellsPage: ServedCodec<ListComputerNotebookCellsResponse> =
  {
    decode: decodeListComputerNotebookCellsResponse,
    encode: encodeListComputerNotebookCellsResponse,
    validate: (page) => {
      for (const cell of page.items) validateComputerCell(cell);
    },
  };

const createComputerNotebookRequest = envelope<CreateComputerNotebookRequest>(
  createComputerNotebookRequestShape,
  validateCreateComputerNotebookRequest,
);

const updateComputerNotebookRequest = envelope<UpdateComputerNotebookRequest>(
  updateComputerNotebookRequestShape,
  validateUpdateComputerNotebookRequest,
);

const computerJournalEntry: ServedCodec<JournalEntry> = {
  decode: decodeJournalEntry,
  encode: encodeJournalEntry,
  validate: validateJournalEntry,
};

const computerJournalPage: ServedCodec<ListJournalResponse> = {
  decode: decodeJournalPage,
  encode: encodeJournalPage,
  validate: (page) => {
    for (const entry of page.items) validateJournalEntry(entry);
  },
};

const errorResponseShape: Shape<ErrorResponse> = object<ErrorResponse>({
  error: always(string()),
  code: omitEmpty(string()),
  details: pointer(jsonObject()),
});

/** The error document a route answers with, carrying `code`. */
function errorDocument(code: string): ServedCodec<ErrorResponse> {
  return envelope(errorResponseShape, (value) => {
    if (value.code !== code) {
      throw new Error(
        `code is ${JSON.stringify(value.code)}, want ${JSON.stringify(code)}`,
      );
    }
  });
}

const computerImages: ServedCodec<ListComputerImagesResponse> = {
  decode: decodeListComputerImagesResponse,
  encode: encodeListComputerImagesResponse,
  validate: (catalog) => {
    for (const image of catalog.items) validateComputerImage(image);
  },
};

const computerSizes: ServedCodec<ListComputerSizesResponse> = {
  decode: decodeListComputerSizesResponse,
  encode: encodeListComputerSizesResponse,
  validate: validateListComputerSizesResponse,
};

const computerAwake: ServedCodec<ComputerAwake> = {
  decode: decodeComputerAwake,
  encode: (awake) => computerAwakeShape.encode(awake),
  validate: validateComputerAwake,
};

const computerSessions: ServedCodec<ListComputerSessionsResponse> = {
  decode: decodeListComputerSessionsResponse,
  encode: encodeListComputerSessionsResponse,
  validate: (page) => {
    for (const session of page.items) validateComputerSessionSummary(session);
  },
};

const computerSecrets: ServedCodec<ListComputerSecretAttachmentsResponse> = {
  decode: decodeListComputerSecretAttachmentsResponse,
  encode: encodeListComputerSecretAttachmentsResponse,
  validate: validateListComputerSecretAttachmentsResponse,
};

const computersBySecret: ServedCodec<ListComputersBySecretResponse> = {
  decode: decodeListComputersBySecretResponse,
  encode: encodeListComputersBySecretResponse,
  validate: validateListComputersBySecretResponse,
};

const computerImage: ServedCodec<ComputerImage> = {
  decode: decodeComputerImage,
  encode: encodeComputerImage,
  validate: validateComputerImage,
};

/** Every served-object codec, keyed as the harness keys its golden. */
export const servedRegistry: ReadonlyMap<
  string,
  ServedCodec<unknown>
> = new Map<string, ServedCodec<unknown>>([
  ...storageRegistry,
  ...billingRegistry,
  ["namespace", namespace],
  ["network", network],
  ["computer", computer],
  ["computer.create-idle-timeout-request", createComputerRequest],
  [
    "computer.execution-does-not-fit-error",
    errorDocument("COMPUTER_DOES_NOT_FIT"),
  ],
  ["computer.create-computer-request", createComputerRequest],
  ["computer.create-size-request", createComputerRequest],
  ["computer.create-request", createComputerRequest],
  [
    "computer.image-not-in-catalog-error",
    errorDocument("IMAGE_NOT_IN_CATALOG"),
  ],
  [
    "computer.network-class-not-admitted-error",
    errorDocument("NETWORK_CLASS_NOT_ADMITTED"),
  ],
  ["computer.session-exec-client-request", createComputerSessionRequest],
  ["computer.session-notebook-request", createComputerSessionRequest],
  ["computer.rename-request", updateComputerRequest],
  ["computer.update-computer-default-request", updateComputerRequest],
  ["computer.update-computer-request", updateComputerRequest],
  ["computer.update-isolation-request", updateComputerRequest],
  ["computer.update-secrets-request", updateComputerRequest],
  ["computer.update-identity-request", updateComputerRequest],
  ["computer.update-identity-default-request", updateComputerRequest],
  ["computer-secrets.list", computerSecrets],
  ["computers.by-secret", computersBySecret],
  ["computers.by-secret-empty", computersBySecret],
  ["computer.update-size-request", updateComputerRequest],
  ["computer.update-request", updateComputerRequest],
  ["computer.update-response", updateComputerResponse],
  ["computer-awake", computerAwake],
  ["computer-sessions", computerSessions],
  ["computer-images", computerImages],
  ["computer-sizes", computerSizes],
  ["computer-journal", computerJournalEntry],
  ["computer-journal.execution-settings-list-page", computerJournalPage],
  ["computer-journal.list-last-page", computerJournalPage],
  ["computer-journal.list-page", computerJournalPage],
  ["computer-session", computerSession],
  ["computer-session.endpoint-create-request", createComputerSessionRequest],
  [
    "computer-session.endpoint-create-request-ssh",
    createComputerSessionRequest,
  ],
  ["computer-notebook", computerNotebook],
  ["computer-notebook.list-page", computerNotebookPage],
  ["computer-notebook.cells-page", computerNotebookCellsPage],
  ["computer-notebook.create-request", createComputerNotebookRequest],
  ["computer-notebook.update-request", updateComputerNotebookRequest],
  ["computer-notebook.rename-request", updateComputerNotebookRequest],
]);

/**
 * The codecs of the `<kind>.refusals` fixtures, keyed as the served
 * registry is: each fixture entry's `value` is read through the codec, the
 * list encodes back to the identical document, and `validate` refuses each
 * value with exactly the entry's `refusal`.
 */
export const servedRefusals: ReadonlyMap<
  string,
  ServedCodec<unknown>
> = new Map<string, ServedCodec<unknown>>([
  ["computer-images.refusals", computerImage],
  ["computer-session.refusals", computerSession],
  ["computer-journal.execution-settings-refusals", computerJournalEntry],
]);
