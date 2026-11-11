// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { validateComputerOwnerFilter } from "../api/computer-owner.js";
import { storageMethods, type StorageMethods } from "./storage.js";
import {
  computerOperationMethods,
  type ComputerOperationMethods,
} from "./computer-operations.js";
import type { DeleteResponse, ListOptions } from "../api/types.js";
import { evaluateComputerWait } from "../api/wait.js";
import {
  createComputerRequestShape,
  decodeComputer,
  encodeUpdateComputerRequest,
  validateCreateComputerRequest,
  validateUpdateComputerRequest,
} from "../api/computer.js";
import type { ListComputerSessionsResponse } from "../api/computer-awake.js";
import type {
  ListComputerSecretAttachmentsResponse,
  ListComputersBySecretResponse,
} from "../api/computer-secrets.js";
import type {
  CreateComputerRequest,
  CreateComputerResponse,
  GetComputerResponse,
  ListComputersResponse,
  UpdateComputerRequest,
  UpdateComputerResponse,
  Computer,
} from "../api/computer.js";
import {
  accountSubnet,
  computerById,
  computerSecrets,
  computerSecretsById,
} from "../internal/apipath.js";
import { listEnvelope } from "../internal/envelopes.js";
import { imageCatalogQuery } from "../internal/listquery.js";
import { resolvePlacement } from "../internal/routing.js";
import {
  decodeListComputerImagesResponse,
  type ListComputerImagesResponse,
} from "../api/computer-image.js";
import type { PlacementContext } from "../internal/context.js";
import { requireNonBlank, signalOption } from "../internal/options.js";
import { ZoneCollection } from "../internal/zone.js";
import type { RequestOptions } from "../request.js";
import type { AccountId } from "../resource/id.js";
import { parseComputerId } from "../resource/uuid-id.js";
import type { ComputerIsolationClass } from "../resource/computer-execution-settings.js";
import { waitForDeletion } from "../wait.js";
import type { WaitOptions } from "../wait.js";
import type {
  CreateComputerSessionRequest,
  ComputerSession,
} from "../api/computer-session.js";
import type {
  ListJournalResponse,
  JournalEntry,
  JournalListOptions,
} from "../api/journal.js";
import {
  getJournalEntry,
  journalById,
  journalByName,
  listJournal,
} from "./computer-journal.js";
import type { PageOptions } from "../api/storage.js";
import type {
  ComputerNotebook,
  CreateComputerNotebookRequest,
  ListComputerNotebookCellsResponse,
  ListComputerNotebooksResponse,
  UpdateComputerNotebookRequest,
} from "../api/computer-notebook.js";
import {
  createNotebook,
  deleteNotebook,
  getNotebook,
  listNotebookCells,
  listNotebooks,
  notebooksById,
  notebooksByName,
  updateNotebook,
} from "./computer-notebooks.js";
import {
  listComputersBySecret,
  listSecretAttachments,
} from "./computer-secrets.js";
import {
  cancelSession,
  createSession,
  getSession,
  listSessions,
  renewSession,
  sessionsById,
  sessionsByName,
} from "./computer-sessions.js";

/**
 * The durable Computers of one Namespace, in the place IDYL assigned the
 * Account. A Computer lives in the place it was created in, and that
 * place's API serves it: every operation is sent to the API the client's
 * placement resolves to, and a response in which a Computer names any other
 * place is refused with an `Error`. A Computer is addressed by place,
 * Namespace, and name together.
 *
 * Requests and responses are the `api` envelopes verbatim, the served
 * Computer read through `decodeComputer`. A service that addresses no
 * Namespace serves only {@link ComputersService.listAllNamespaces}; its
 * Namespace-scoped operations throw a `TypeError` saying a Namespace is
 * required.
 *
 * A Computer's sessions are resources: a create records a session's grant
 * and answers at once, `ready` when the Computer was awake and otherwise
 * `pending` while it wakes, carrying the endpoint its grant is installed on
 * once the session is bound. The session itself runs on that endpoint, over
 * the client's Computer connection. No request is held open while the
 * Computer wakes. Every session operation addresses the Computer either by
 * name or, in its `ById` form, by the Computer's stable identity. A name is
 * free to reuse once its previous holder has been finalized, so a caller
 * holding an ID keeps reaching the Computer it names, and the session it
 * created there, through the `ById` forms. Sessions are read through
 * `decodeComputerSession`.
 */
export interface ComputersService
  extends StorageMethods, ComputerOperationMethods {
  /**
   * Records a Computer in the Namespace, in the client's resolved place.
   * The place is stamped onto the request; a request naming a different
   * one is refused with a `TypeError` before anything is sent. The
   * response carries the server-assigned ID. A name already held by a live
   * Computer of the Namespace there is refused with HTTP 409, and a
   * terminating Namespace refuses the creation with HTTP 409 and
   * `ERROR_CODE_NAMESPACE_TERMINATING`, which `isApiCode` classifies.
   * An `idempotencyKey`, when supplied, identifies equal creation retries;
   * the server retains their recorded outcome.
   *
   * The request is judged with
   * `validateCreateComputerRequest` before anything is sent, and a spec
   * that states no field is not written. Throws a `TypeError` when the name
   * is blank or the request is invalid.
   */
  create(
    request: CreateComputerRequest,
    options?: RequestOptions,
  ): Promise<CreateComputerResponse>;
  /** Reads a Computer by name. Throws a `TypeError` when `name` is blank. */
  get(name: string, options?: RequestOptions): Promise<GetComputerResponse>;
  /**
   * Reads a Computer by its stable identity. A name is free to reuse once
   * its previous holder has been finalized, so a caller holding an ID reads
   * the Computer it names here. Throws a `TypeError` when `id` is not a
   * canonical UUID.
   */
  getById(id: string, options?: RequestOptions): Promise<GetComputerResponse>;
  /**
   * Changes the Computer addressed by name field by field, as
   * {@link UpdateComputerRequest} describes, with a PATCH of the Computer,
   * and returns the Computer as the update left it. The request is judged
   * with `validateUpdateComputerRequest` before it is sent, so an update
   * that states no field, or an invalid one, throws a `TypeError` and sends
   * nothing. Throws a `TypeError` when `name` is blank.
   */
  update(
    name: string,
    request: UpdateComputerRequest,
    options?: RequestOptions,
  ): Promise<UpdateComputerResponse>;
  /**
   * Changes the Computer addressed by its stable identity, exactly as
   * {@link ComputersService.update} does by name. A name is free to reuse
   * once its previous holder has been finalized, so a caller holding an ID
   * never updates a later Computer that took the name. Throws a `TypeError`
   * when `id` is not a canonical UUID or the request is invalid.
   */
  updateById(
    id: string,
    request: UpdateComputerRequest,
    options?: RequestOptions,
  ): Promise<UpdateComputerResponse>;
  /**
   * Starts releasing a Computer addressed by name. The platform records it
   * as terminating and answers 202 with `accepted` set and `deletedAt`
   * stamped, then releases what the Computer holds and finalizes on its
   * own. Nothing else in the Namespace is touched. Deleting a Computer that
   * is already terminating is accepted again with the same `deletedAt`.
   * Once finalized, the Computer resolves 404 and its name may be reused.
   *
   * A caller that needs the Computer gone follows with
   * {@link ComputersService.waitUntilDeleted}. Throws a `TypeError` when
   * `name` is blank.
   */
  delete(name: string, options?: RequestOptions): Promise<DeleteResponse>;
  /**
   * Starts releasing a Computer addressed by its stable identity, with the
   * answer {@link ComputersService.delete} describes. Throws a `TypeError`
   * when `id` is not a canonical UUID.
   */
  deleteById(id: string, options?: RequestOptions): Promise<DeleteResponse>;
  /**
   * One page of the Computers in the Namespace, in the client's resolved
   * place. Filter selects ownership: empty or `unowned`, or `all`.
   */
  list(
    options?: ListOptions,
    request?: RequestOptions,
  ): Promise<ListComputersResponse>;
  /**
   * One page of Computers across every Namespace the caller is authorized
   * to list in the Account, in the resolved Subnet. The service's Namespace
   * does not narrow the result: each Computer carries its own Namespace,
   * `totalCount` counts the account-wide authorized result, and the
   * platform orders by Namespace name and then Computer name so paging is
   * stable and equal names in different Namespaces stay distinct.
   */
  listAllNamespaces(
    options?: ListOptions,
    request?: RequestOptions,
  ): Promise<ListComputersResponse>;
  /**
   * Reads the Computer back by name until it resolves 404, judging each
   * read with `evaluateComputerWait`. It resolves once the Computer is
   * gone; an exhausted timeout rejects with a `TimeoutError` `DOMException`,
   * cancellation with the signal's reason, and any other read failure with
   * its error. Nothing is deleted. Throws a `TypeError` when `name` is
   * blank.
   */
  waitUntilDeleted(name: string, options?: WaitOptions): Promise<void>;
  /**
   * The IDYL image catalog of the resolved Subnet: the images a Computer
   * there may name as `ComputerExecutionSettingsImage.idyl`, each with its current
   * patch level, and the default a create that states no image receives.
   * The catalog is served whole, on one page, read leniently and judged
   * entry by entry with `validateComputerImage` only when a caller asks.
   * The service's Namespace does not narrow it, so a service that addresses
   * no Namespace serves it too.
   */
  listImages(request?: RequestOptions): Promise<ListComputerImagesResponse>;
  /**
   * The IDYL images of the resolved Subnet's catalog that a Computer in
   * `isolation` may name, each stating the class. The list is empty when
   * the Subnet does not admit the class, so a caller offers the class
   * exactly when it is not. `isolation` is `secure-container` or `vm`; any
   * other value throws a `TypeError` before a request is made. Read and
   * scoped as {@link listImages} is.
   */
  listImagesFor(
    isolation: ComputerIsolationClass,
    request?: RequestOptions,
  ): Promise<ListComputerImagesResponse>;
  /**
   * Creates a session in the Computer addressed by name and returns it as
   * the platform answered: ready, or pending while the Computer wakes,
   * carrying its endpoint once it is bound. It neither waits nor opens the
   * session's stream. The request is judged with
   * `validateCreateComputerSessionRequest` before it is sent.
   *
   * A create the platform refuses at once, such as one whose Namespace has
   * no execution in the Subnet or one over a session limit, rejects with an
   * `ApiError` carrying its code, which `isApiCode` classifies against the
   * `ERROR_CODE_*` constants. A request may be retried after a lost
   * response under the same `idempotencyKey`, within the window
   * `CreateComputerSessionRequest` documents, and returns the same session.
   * Throws a `TypeError` when `name` is blank or the request is invalid.
   */
  createSession(
    name: string,
    request: CreateComputerSessionRequest,
    options?: RequestOptions,
  ): Promise<ComputerSession>;
  /**
   * Creates a session in the Computer addressed by its stable identity, as
   * {@link ComputersService.createSession} does. The session is read,
   * renewed, and cancelled by the same identity with the other `ById`
   * forms. Throws a `TypeError` when `id` is not a canonical UUID.
   */
  createSessionById(
    id: string,
    request: CreateComputerSessionRequest,
    options?: RequestOptions,
  ): Promise<ComputerSession>;
  /**
   * Reads a session of the Computer addressed by name, as it now is. Only
   * the identity that created a session may read it. A session that ended
   * is readable until the window of its idempotency key closes; after that,
   * and for an ID the Computer never issued, the read rejects with HTTP
   * 404, which `isNotFound` classifies. Throws a `TypeError` when `name` is
   * blank or `sessionId` is not a canonical UUID.
   */
  getSession(
    name: string,
    sessionId: string,
    options?: RequestOptions,
  ): Promise<ComputerSession>;
  /**
   * Reads a session of the Computer addressed by its stable identity, as
   * {@link ComputersService.getSession} does.
   */
  getSessionById(
    computerId: string,
    sessionId: string,
    options?: RequestOptions,
  ): Promise<ComputerSession>;
  /**
   * Lists every open session of the Computer addressed by name, oldest
   * first, as anyone who may read the Computer sees them: kind, client, who
   * and when, never content. {@link ComputersService.getSession} reads a
   * session in full, and only for its creator. A Computer that is asleep
   * lists none. Throws a `TypeError` when `name` is blank.
   */
  listSessions(
    name: string,
    options?: RequestOptions,
  ): Promise<ListComputerSessionsResponse>;
  /**
   * Lists every open session of the Computer addressed by its stable
   * identity, as {@link ComputersService.listSessions} does.
   */
  listSessionsById(
    id: string,
    options?: RequestOptions,
  ): Promise<ListComputerSessionsResponse>;
  /**
   * The state of each Secret attachment of the Computer addressed by name:
   * one item per attachment in its execution settings in force, in their
   * order, saying whether the attached Secret's value can be sent and, when
   * it cannot, why. Anyone who may read the Computer may read it. Throws a
   * `TypeError` when `name` is blank.
   */
  listSecrets(
    name: string,
    options?: RequestOptions,
  ): Promise<ListComputerSecretAttachmentsResponse>;
  /**
   * The state of each Secret attachment of the Computer addressed by its
   * stable identity, as {@link ComputersService.listSecrets} reads it.
   */
  listSecretsById(
    id: string,
    options?: RequestOptions,
  ): Promise<ListComputerSecretAttachmentsResponse>;
  /**
   * Every attachment of the Secret with ID `secretId` in the execution
   * settings of the Namespace's Computers that the caller may read,
   * sleeping Computers included: for each, the Computer, the variable,
   * whether it is attached there, and the version it is pinned to, if any.
   * A Computer the caller may not read is left out. Throws a `TypeError`
   * before any request when `secretId` is not a canonical UUID.
   */
  listBySecret(
    secretId: string,
    options?: RequestOptions,
  ): Promise<ListComputersBySecretResponse>;
  /**
   * Cancels a session of the Computer addressed by name: one whose stream
   * no endpoint has started. Once a stream may have started, the session
   * is left to end by its deadlines, or ended through its stream.
   * Cancelling a session that is already final changes nothing. A session
   * its creator cancels states no reason. Throws a `TypeError` when `name`
   * is blank or `sessionId` is not a canonical UUID.
   */
  cancelSession(
    name: string,
    sessionId: string,
    options?: RequestOptions,
  ): Promise<void>;
  /**
   * Cancels a session of the Computer addressed by its stable identity, as
   * {@link ComputersService.cancelSession} does and under the same rule.
   */
  cancelSessionById(
    computerId: string,
    sessionId: string,
    options?: RequestOptions,
  ): Promise<void>;
  /**
   * Renews the lease of a session of the Computer addressed by name, with a
   * POST that has no body, and returns the session as the renewal left it,
   * its `status.expiresAt` the new lease deadline. A session is kept by
   * renewing it every `COMPUTER_SESSION_RENEW_INTERVAL_MS`, as
   * `ComputerSession` describes.
   *
   * The platform checks the caller's permission on the Computer again,
   * exactly as a create does. A refused renewal ends the session at once
   * with reason `Revoked` and rejects with an `ApiError`. Renewing a session
   * that is already final changes nothing and rejects with an `ApiError`
   * carrying HTTP 409 and `ERROR_CODE_SESSION_FINAL`. Throws a `TypeError`
   * when `name` is blank or `sessionId` is not a canonical UUID.
   */
  renewSession(
    name: string,
    sessionId: string,
    options?: RequestOptions,
  ): Promise<ComputerSession>;
  /**
   * Renews a session of the Computer addressed by its stable identity, as
   * {@link ComputersService.renewSession} does.
   */
  renewSessionById(
    computerId: string,
    sessionId: string,
    options?: RequestOptions,
  ): Promise<ComputerSession>;
  /**
   * Returns one page of the journal of the Computer addressed by name,
   * newest entry first, as `JournalListOptions` describes. Pass the
   * page's `continue` back in the options to read the next page; a page
   * without one is the last. Each listed Cell carries its command bounded
   * by `MAX_COMPUTER_CELL_LISTED_COMMAND_BYTES`;
   * {@link ComputersService.getJournalEntry} returns the whole command.
   * The journal is one list that only grows forward, and each entry names
   * its `creator` unless IDYL made it on its own. A private session records
   * no entry, and a notebook session's Cell is listed through
   * {@link ComputersService.listNotebookCells}, while the save entry that
   * covers it links to that cell in `save`. Anyone who may read the
   * Computer may read its whole journal, including entries other identities
   * caused.
   *
   * Options the route does not serve are refused with a `TypeError` before
   * any request is sent. A continue position the platform cannot use
   * rejects with `ERROR_CODE_INVALID_CONTINUE`, and the listing starts again
   * without it. Throws a `TypeError` when `name` is blank.
   */
  listJournal(
    name: string,
    options?: JournalListOptions,
    request?: RequestOptions,
  ): Promise<ListJournalResponse>;
  /**
   * Returns one page of the journal of the Computer addressed by its
   * stable identity, as {@link ComputersService.listJournal} does.
   */
  listJournalById(
    id: string,
    options?: JournalListOptions,
    request?: RequestOptions,
  ): Promise<ListJournalResponse>;
  /**
   * Reads one entry of the journal of the Computer addressed by name. A
   * Cell entry carries its whole command. An entry the Computer's journal
   * does not hold rejects with HTTP 404, which `isNotFound` classifies.
   * Throws a `TypeError` when `name` is blank or `entryId` is not a
   * canonical UUID.
   */
  getJournalEntry(
    name: string,
    entryId: string,
    request?: RequestOptions,
  ): Promise<JournalEntry>;
  /**
   * Reads one entry of the journal of the Computer addressed by its stable
   * identity, as {@link ComputersService.getJournalEntry} does.
   */
  getJournalEntryById(
    computerId: string,
    entryId: string,
    request?: RequestOptions,
  ): Promise<JournalEntry>;
  /**
   * Creates a notebook in the Computer addressed by name, as
   * {@link CreateComputerNotebookRequest} describes, and returns it. A
   * notebook that already exists is returned unchanged, so a caller may
   * create a notebook before every use. The request is judged with
   * `validateCreateComputerNotebookRequest` before it is sent. Throws a
   * `TypeError` when `name` is blank or the request is invalid.
   */
  createNotebook(
    name: string,
    request: CreateComputerNotebookRequest,
    options?: RequestOptions,
  ): Promise<ComputerNotebook>;
  /**
   * Creates a notebook in the Computer addressed by its stable identity, as
   * {@link ComputersService.createNotebook} does.
   */
  createNotebookById(
    id: string,
    request: CreateComputerNotebookRequest,
    options?: RequestOptions,
  ): Promise<ComputerNotebook>;
  /**
   * Reads a notebook of the Computer addressed by name. A notebook the
   * Computer does not have rejects with an `ApiError` carrying
   * `ERROR_CODE_NOTEBOOK_NOT_FOUND`. Throws a `TypeError` when `name` is
   * blank or `notebook` is not a valid notebook name.
   */
  getNotebook(
    name: string,
    notebook: string,
    options?: RequestOptions,
  ): Promise<ComputerNotebook>;
  /**
   * Reads a notebook of the Computer addressed by its stable identity, as
   * {@link ComputersService.getNotebook} does.
   */
  getNotebookById(
    id: string,
    notebook: string,
    options?: RequestOptions,
  ): Promise<ComputerNotebook>;
  /**
   * Returns one page of the notebooks of the Computer addressed by name,
   * ordered by name. Pass the page's `continue` back in the options to read
   * the next page; a page without one is the last. Throws a `TypeError`
   * when `name` is blank or the options are invalid.
   */
  listNotebooks(
    name: string,
    options?: PageOptions,
    request?: RequestOptions,
  ): Promise<ListComputerNotebooksResponse>;
  /**
   * Returns one page of the notebooks of the Computer addressed by its
   * stable identity, as {@link ComputersService.listNotebooks} does.
   */
  listNotebooksById(
    id: string,
    options?: PageOptions,
    request?: RequestOptions,
  ): Promise<ListComputerNotebooksResponse>;
  /**
   * Returns one page of a notebook's cells, in the order they ran, in the
   * Computer addressed by name. Each cell carries its command, its process
   * facts, and its `save`. Pass the page's `continue` back in the options
   * to read the next page; a page without one is the last. A notebook the
   * Computer does not have rejects with an `ApiError` carrying
   * `ERROR_CODE_NOTEBOOK_NOT_FOUND`. Throws a `TypeError` when `name` is
   * blank, `notebook` is not a valid notebook name, or the options are
   * invalid.
   */
  listNotebookCells(
    name: string,
    notebook: string,
    options?: PageOptions,
    request?: RequestOptions,
  ): Promise<ListComputerNotebookCellsResponse>;
  /**
   * Returns one page of a notebook's cells in the Computer addressed by its
   * stable identity, as {@link ComputersService.listNotebookCells} does.
   */
  listNotebookCellsById(
    id: string,
    notebook: string,
    options?: PageOptions,
    request?: RequestOptions,
  ): Promise<ListComputerNotebookCellsResponse>;
  /**
   * Updates a notebook of the Computer addressed by name, as
   * {@link UpdateComputerNotebookRequest} describes, and returns it as the
   * update left it. A notebook the Computer does not have rejects with an
   * `ApiError` carrying `ERROR_CODE_NOTEBOOK_NOT_FOUND`. Throws a
   * `TypeError` when `name` is blank, `notebook` is not a valid notebook
   * name, or the request states no field.
   */
  updateNotebook(
    name: string,
    notebook: string,
    request: UpdateComputerNotebookRequest,
    options?: RequestOptions,
  ): Promise<ComputerNotebook>;
  /**
   * Updates a notebook of the Computer addressed by its stable identity, as
   * {@link ComputersService.updateNotebook} does.
   */
  updateNotebookById(
    id: string,
    notebook: string,
    request: UpdateComputerNotebookRequest,
    options?: RequestOptions,
  ): Promise<ComputerNotebook>;
  /**
   * Deletes a notebook of the Computer addressed by name, with all its
   * cells. The Computer's files and history are unchanged. A notebook the
   * Computer does not have rejects with an `ApiError` carrying
   * `ERROR_CODE_NOTEBOOK_NOT_FOUND`. Throws a `TypeError` when `name` is
   * blank or `notebook` is not a valid notebook name.
   */
  deleteNotebook(
    name: string,
    notebook: string,
    options?: RequestOptions,
  ): Promise<void>;
  /**
   * Deletes a notebook of the Computer addressed by its stable identity, as
   * {@link ComputersService.deleteNotebook} does.
   */
  deleteNotebookById(
    id: string,
    notebook: string,
    options?: RequestOptions,
  ): Promise<void>;
}

/**
 * Builds the Computer service for `namespaceName` within `accountId`, on
 * the placement `context` holds. With `namespaceName` undefined the service
 * addresses no Namespace.
 */
export function computersService(
  context: PlacementContext,
  accountId: AccountId,
  namespaceName: string | undefined,
): ComputersService {
  const addressed: PlacementContext = {
    state: context.state,
    scope: {
      accountId,
      ...(namespaceName === undefined ? {} : { namespace: namespaceName }),
    },
    placement: context.placement,
  };
  const collection = new ZoneCollection(addressed, {
    plural: "computers",
    key: "computer",
    label: "computer",
    decode: decodeComputer,
    subnetOf: (computer) => computer.subnet,
  });
  /** Reads the resolved Subnet's image catalog with the query given. */
  const listImages = async (
    query: string,
    request: RequestOptions,
  ): Promise<ListComputerImagesResponse> => {
    const resolved = await resolvePlacement(addressed, {
      requireNamespace: false,
      ...signalOption(request.signal),
    });
    const response = await addressed.state.transport.json<unknown>(
      "GET",
      resolved.endpoint,
      accountSubnet(accountId, resolved.subnet, "computer-images") + query,
      signalOption(request.signal),
    );
    listEnvelope(response, "computer images");
    return decodeListComputerImagesResponse(response);
  };
  const service: ComputersService = {
    ...storageMethods(context, "computers"),
    ...computerOperationMethods(context),
    async create(request, options = {}) {
      createComputerRequestShape.unknownFields(request, "");
      requireNonBlank(request.name, "computer name");
      requireScope(namespaceName);
      return await collection.submit((resolved) => {
        if (
          request.subnet !== undefined &&
          request.subnet !== "" &&
          request.subnet !== resolved.subnet
        ) {
          throw new TypeError(
            "computer subnet does not match resolved placement subnet",
          );
        }
        const body: CreateComputerRequest = {
          name: request.name,
          subnet: resolved.subnet,
          ...(request.spec === undefined ? {} : { spec: request.spec }),
          ...(request.client === undefined ? {} : { client: request.client }),
          ...(request.forkOf === undefined ? {} : { forkOf: request.forkOf }),
          ...(request.workspaceOnly === undefined
            ? {}
            : { workspaceOnly: request.workspaceOnly }),
          ...(request.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: request.idempotencyKey }),
        };
        validateCreateComputerRequest(body);
        return createComputerRequestShape.encode(body);
      }, options.signal);
    },
    async get(name, options = {}) {
      requireNonBlank(name, "computer name");
      requireScope(namespaceName);
      return await collection.get(name, options.signal);
    },
    async getById(id, options = {}) {
      const computerId = parseComputerId(id);
      requireScope(namespaceName);
      return await collection.read(
        (resolved) => computerById(resolved.scope, computerId),
        options.signal,
      );
    },
    async update(name, request, options = {}) {
      requireNonBlank(name, "computer name");
      validateUpdateComputerRequest(request);
      requireScope(namespaceName);
      return await collection.patch(
        name,
        encodeUpdateComputerRequest(request),
        options.signal,
      );
    },
    async updateById(id, request, options = {}) {
      const computerId = parseComputerId(id);
      validateUpdateComputerRequest(request);
      requireScope(namespaceName);
      return await collection.change(
        (resolved) => computerById(resolved.scope, computerId),
        encodeUpdateComputerRequest(request),
        options.signal,
      );
    },
    async delete(name, options = {}) {
      requireNonBlank(name, "computer name");
      requireScope(namespaceName);
      return await collection.delete(name, options.signal);
    },
    async deleteById(id, options = {}) {
      const computerId = parseComputerId(id);
      requireScope(namespaceName);
      return await collection.remove(
        (resolved) => computerById(resolved.scope, computerId),
        options.signal,
      );
    },
    async list(options = {}, request = {}) {
      validateComputerOwnerFilter(options.filter ?? "");
      requireScope(namespaceName);
      return await collection.list(options, request.signal);
    },
    async listAllNamespaces(options = {}, request = {}) {
      validateComputerOwnerFilter(options.filter ?? "");
      return await collection.listAllNamespaces(options, request.signal);
    },
    async listImages(request = {}) {
      return await listImages("", request);
    },
    async listImagesFor(isolation, request = {}) {
      return await listImages(imageCatalogQuery(isolation), request);
    },
    async waitUntilDeleted(name, options = {}) {
      requireNonBlank(name, "computer name");
      requireScope(namespaceName);
      await waitForDeletion<Computer>(options, {
        kind: "Computer",
        name,
        read: async (signal) => (await service.get(name, { signal })).computer,
        evaluate: (computer) => evaluateComputerWait(computer, "deleted"),
      });
    },
    async createSession(name, request, options = {}) {
      const sessions = sessionsByName(name);
      requireScope(namespaceName);
      return await createSession(addressed, sessions, request, options.signal);
    },
    async createSessionById(id, request, options = {}) {
      const sessions = sessionsById(id);
      requireScope(namespaceName);
      return await createSession(addressed, sessions, request, options.signal);
    },
    async getSession(name, sessionId, options = {}) {
      const sessions = sessionsByName(name);
      requireScope(namespaceName);
      return await getSession(addressed, sessions, sessionId, options.signal);
    },
    async getSessionById(computerId, sessionId, options = {}) {
      const sessions = sessionsById(computerId);
      requireScope(namespaceName);
      return await getSession(addressed, sessions, sessionId, options.signal);
    },
    async listSessions(name, options = {}) {
      const sessions = sessionsByName(name);
      requireScope(namespaceName);
      return await listSessions(addressed, sessions, options.signal);
    },
    async listSessionsById(id, options = {}) {
      const sessions = sessionsById(id);
      requireScope(namespaceName);
      return await listSessions(addressed, sessions, options.signal);
    },
    async listSecrets(name, options = {}) {
      requireNonBlank(name, "computer name");
      requireScope(namespaceName);
      return await listSecretAttachments(
        addressed,
        (scope) => computerSecrets(scope, name),
        options.signal,
      );
    },
    async listSecretsById(id, options = {}) {
      const computerId = parseComputerId(id);
      requireScope(namespaceName);
      return await listSecretAttachments(
        addressed,
        (scope) => computerSecretsById(scope, computerId),
        options.signal,
      );
    },
    async listBySecret(secretId, options = {}) {
      requireScope(namespaceName);
      return await listComputersBySecret(addressed, secretId, options.signal);
    },
    async cancelSession(name, sessionId, options = {}) {
      const sessions = sessionsByName(name);
      requireScope(namespaceName);
      await cancelSession(addressed, sessions, sessionId, options.signal);
    },
    async cancelSessionById(computerId, sessionId, options = {}) {
      const sessions = sessionsById(computerId);
      requireScope(namespaceName);
      await cancelSession(addressed, sessions, sessionId, options.signal);
    },
    async renewSession(name, sessionId, options = {}) {
      const sessions = sessionsByName(name);
      requireScope(namespaceName);
      return await renewSession(addressed, sessions, sessionId, options.signal);
    },
    async renewSessionById(computerId, sessionId, options = {}) {
      const sessions = sessionsById(computerId);
      requireScope(namespaceName);
      return await renewSession(addressed, sessions, sessionId, options.signal);
    },
    async listJournal(name, options = {}, request = {}) {
      const journal = journalByName(name);
      requireScope(namespaceName);
      return await listJournal(addressed, journal, options, request.signal);
    },
    async listJournalById(id, options = {}, request = {}) {
      const journal = journalById(id);
      requireScope(namespaceName);
      return await listJournal(addressed, journal, options, request.signal);
    },
    async getJournalEntry(name, entryId, request = {}) {
      const journal = journalByName(name);
      requireScope(namespaceName);
      return await getJournalEntry(addressed, journal, entryId, request.signal);
    },
    async getJournalEntryById(computerId, entryId, request = {}) {
      const journal = journalById(computerId);
      requireScope(namespaceName);
      return await getJournalEntry(addressed, journal, entryId, request.signal);
    },
    async createNotebook(name, request, options = {}) {
      const notebooks = notebooksByName(name);
      requireScope(namespaceName);
      return await createNotebook(
        addressed,
        notebooks,
        request,
        options.signal,
      );
    },
    async createNotebookById(id, request, options = {}) {
      const notebooks = notebooksById(id);
      requireScope(namespaceName);
      return await createNotebook(
        addressed,
        notebooks,
        request,
        options.signal,
      );
    },
    async getNotebook(name, notebook, options = {}) {
      const notebooks = notebooksByName(name);
      requireScope(namespaceName);
      return await getNotebook(addressed, notebooks, notebook, options.signal);
    },
    async getNotebookById(id, notebook, options = {}) {
      const notebooks = notebooksById(id);
      requireScope(namespaceName);
      return await getNotebook(addressed, notebooks, notebook, options.signal);
    },
    async listNotebooks(name, options = {}, request = {}) {
      const notebooks = notebooksByName(name);
      requireScope(namespaceName);
      return await listNotebooks(addressed, notebooks, options, request.signal);
    },
    async listNotebooksById(id, options = {}, request = {}) {
      const notebooks = notebooksById(id);
      requireScope(namespaceName);
      return await listNotebooks(addressed, notebooks, options, request.signal);
    },
    async listNotebookCells(name, notebook, options = {}, request = {}) {
      const notebooks = notebooksByName(name);
      requireScope(namespaceName);
      return await listNotebookCells(
        addressed,
        notebooks,
        notebook,
        options,
        request.signal,
      );
    },
    async listNotebookCellsById(id, notebook, options = {}, request = {}) {
      const notebooks = notebooksById(id);
      requireScope(namespaceName);
      return await listNotebookCells(
        addressed,
        notebooks,
        notebook,
        options,
        request.signal,
      );
    },
    async updateNotebook(name, notebook, request, options = {}) {
      const notebooks = notebooksByName(name);
      requireScope(namespaceName);
      return await updateNotebook(
        addressed,
        notebooks,
        notebook,
        request,
        options.signal,
      );
    },
    async updateNotebookById(id, notebook, request, options = {}) {
      const notebooks = notebooksById(id);
      requireScope(namespaceName);
      return await updateNotebook(
        addressed,
        notebooks,
        notebook,
        request,
        options.signal,
      );
    },
    async deleteNotebook(name, notebook, options = {}) {
      const notebooks = notebooksByName(name);
      requireScope(namespaceName);
      await deleteNotebook(addressed, notebooks, notebook, options.signal);
    },
    async deleteNotebookById(id, notebook, options = {}) {
      const notebooks = notebooksById(id);
      requireScope(namespaceName);
      await deleteNotebook(addressed, notebooks, notebook, options.signal);
    },
  };
  return Object.freeze(service);
}

function requireScope(namespaceName: string | undefined): string {
  if (namespaceName === undefined || namespaceName.trim() === "") {
    throw new TypeError("namespace is required");
  }
  return namespaceName;
}
