// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { JsonObject } from "./resource/json.js";
import { ERROR_CODE_CLIENT_UPGRADE_REQUIRED } from "./api/types.js";
import type { UploadTransfer } from "./api/upload-transfer.js";
import type { BillingPlan, ComputerSize } from "./api/billing.js";
import {
  ERROR_CODE_OUT_OF_USAGE,
  ERROR_CODE_SIZE_NOT_IN_PLAN,
  ERROR_CODE_SPEND_CAP_REACHED,
  SIZE_BELOW_USAGE_DETAIL_COMPUTER_SIZE,
  SIZE_BELOW_USAGE_DETAIL_SIZE_BYTES,
  SIZE_BELOW_USAGE_DETAIL_USED_BYTES,
  SIZE_NOT_IN_PLAN_DETAIL_LARGEST_SIZE,
  SIZE_NOT_IN_PLAN_DETAIL_PLAN,
  SIZE_NOT_IN_PLAN_DETAIL_PLAN_NAME,
  SIZE_NOT_IN_PLAN_DETAIL_SIZE,
  SPEND_CAP_REACHED_DETAIL_BOUGHT,
  SPEND_CAP_REACHED_DETAIL_SPEND_CAP,
} from "./api/billing-errors.js";
import { ERROR_CODE_SIZE_BELOW_USAGE } from "./api/storage-errors.js";

/** What a non-2xx response carried. */
export interface ApiErrorOptions {
  readonly status: number;
  readonly message: string;
  readonly code?: string;
  readonly details?: JsonObject;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

/**
 * A non-2xx response from the IDYL API.
 *
 * `status` is the HTTP status. `code` is the stable error code when the endpoint publishes one and
 * is what a caller branches on. `detail` is the server's message, the reference
 * contract's `Message`: prose for a person, never parsed, and absent when the
 * response carried none. When the error body could not be read it is the
 * sentence that says so, on a route held to a disclosure allow-list it is
 * the fixed sentence `request failed` outside the listed codes. `message` is the sentence composed for
 * logs from the status and the code; it never carries `detail`, and is not
 * a contract either. `details` carries per-code structured context where a code
 * documents it, `requestId` the server's request identifier when one was
 * returned, and `retryAfterMs` the delay the server advertised through
 * `Retry-After`, in milliseconds, when it sent one.
 *
 * Match it with `instanceof`, or classify it with {@link isApiCode}.
 */
export class ApiError extends Error {
  readonly status: number;
  declare readonly code?: string;
  declare readonly detail?: string;
  declare readonly details?: JsonObject;
  declare readonly requestId?: string;
  declare readonly retryAfterMs?: number;

  constructor(options: ApiErrorOptions) {
    super(describeApiError(options), causeOption(options.cause));
    this.name = "ApiError";
    this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.message !== "") this.detail = options.message;
    if (options.details !== undefined) this.details = options.details;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/**
 * The message of an API error: the status and, when it has the shape of a
 * stable code, the code. The server's own message is carried in `detail`
 * and never reaches the message, so nothing a server wrote is logged by a
 * caller that logs errors.
 */
function describeApiError(options: ApiErrorOptions): string {
  const status = describeStatus(options.status);
  const code = options.code ?? "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(code)
    ? `IDYL API: ${status}: ${code}`
    : `IDYL API: ${status}`;
}

/**
 * The platform's refusal of a call that names a notebook the Computer does
 * not have, carrying `NOTEBOOK_NOT_FOUND`. A notebook comes into being only
 * through `computer.notebooks.create(name)`, which is repeat-safe, so a
 * caller that may meet a new Computer creates the notebook before its first
 * run.
 */
export class NotebookNotFoundError extends ApiError {
  constructor(options: ApiErrorOptions) {
    super(options);
    this.name = "NotebookNotFoundError";
    this.message = `${this.message} (create the notebook with computer.notebooks.create(name) before running a cell in it)`;
  }
}

/** The code on {@link NotebookNotFoundError}. */
const NOTEBOOK_NOT_FOUND = "NOTEBOOK_NOT_FOUND";

/**
 * The platform's refusal of a `files` session on a Computer that is not
 * awake, carrying `COMPUTER_NOT_AWAKE` with HTTP 409. The refusal neither
 * wakes the Computer nor keeps it awake; a caller lists the Computer's
 * saved files instead.
 */
export class ComputerNotAwakeError extends ApiError {
  constructor(options: ApiErrorOptions) {
    super(options);
    this.name = "ComputerNotAwakeError";
  }
}

/** The code on {@link ComputerNotAwakeError}. */
const COMPUTER_NOT_AWAKE = "COMPUTER_NOT_AWAKE";

/**
 * Builds the error a non-2xx response becomes: a
 * {@link NotebookNotFoundError} for `NOTEBOOK_NOT_FOUND`, a
 * {@link ComputerNotAwakeError} for `COMPUTER_NOT_AWAKE`, an
 * {@link ApiError} otherwise.
 */
export function apiError(options: ApiErrorOptions): ApiError {
  switch (options.code) {
    case NOTEBOOK_NOT_FOUND:
      return new NotebookNotFoundError(options);
    case COMPUTER_NOT_AWAKE:
      return new ComputerNotAwakeError(options);
    default:
      return new ApiError(options);
  }
}

/**
 * Why a request did not complete. The vocabulary is closed and only grows.
 *
 * - `network_error`: the request failed before any response: a refused
 *   connection, a reset, a failed name lookup, or a TLS failure.
 * - `timeout`: the request did not complete within the client's request
 *   timeout.
 * - `redirect_refused`: the server answered with a redirect. The package
 *   never follows one, so a credential is never replayed to a host the
 *   server chose.
 * - `response_too_large`: the response body exceeds the package's bound.
 * - `invalid_response`: the response cannot be used: it is not exactly one
 *   JSON value, or it contradicts the request it answers.
 */
export type TransportErrorCode =
  | "network_error"
  | "timeout"
  | "redirect_refused"
  | "response_too_large"
  | "invalid_response";

/**
 * A request that did not complete: no answer arrived from the platform, or
 * the answer could not be used. `code` classifies it. The
 * message is a fixed sentence built from the code and, where one helps, a
 * fixed detail naming the rule that failed: it never carries a token, a
 * command, its output, or text a peer sent. `cause` carries the underlying
 * failure when there is one.
 *
 * A request that failed this way may or may not have reached the platform,
 * so the package never retries it, with one exception: the reads of
 * `files.download`, which change nothing and resume on their own.
 */
export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(
    code: TransportErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, causeOption(options?.cause));
    this.name = "TransportError";
    this.code = code;
  }
}

/** Reports whether `error` is an HTTP 404 {@link ApiError}. */
export function isNotFound(error: unknown): error is ApiError {
  return isApiStatus(error, 404);
}

/** Reports whether `error` is an {@link ApiError} with the given HTTP status. */
export function isApiStatus(error: unknown, status: number): error is ApiError {
  return error instanceof ApiError && error.status === status;
}

/** Reports whether `error` is an {@link ApiError} carrying the given stable code. */
export function isApiCode(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

/**
 * Reports whether `error` is the API's refusal of the product release a
 * request named in its `Idyl-Client` header as below the minimum it
 * supports: an {@link ApiError}, with HTTP 426 Upgrade Required, carrying
 * {@link ERROR_CODE_CLIENT_UPGRADE_REQUIRED}. The refusal's `details` name
 * the product, the minimum and latest versions, and the upgrade URL under
 * the `CLIENT_UPGRADE_REQUIRED_DETAIL_*` keys, each a string. See
 * `ClientProduct`.
 */
export function isClientUpgradeRequired(error: unknown): error is ApiError {
  return isApiCode(error, ERROR_CODE_CLIENT_UPGRADE_REQUIRED);
}

/**
 * The details of a `SIZE_NOT_IN_PLAN` refusal. A key the refusal does not
 * carry, or carries in another form, reads as the empty string.
 */
export interface SizeNotInPlanDetails {
  /** The size refused. */
  readonly size: ComputerSize;
  /** The largest size the Account's plan includes. */
  readonly largestSize: ComputerSize;
  /**
   * The smallest plan that includes `size`; the empty string when no plan
   * includes it.
   */
  readonly plan: BillingPlan;
  /** That plan's name for display; the empty string when no plan includes `size`. */
  readonly planName: string;
}

/**
 * The details of a `SIZE_BELOW_USAGE` refusal. A key the refusal does not
 * carry, or carries in another form, reads as zero or the empty string.
 */
export interface SizeBelowUsageDetails {
  /** The bytes the resource's current files use. Earlier versions do not count. */
  readonly usedBytes: number;
  /** The bytes the refused size would leave for them. */
  readonly sizeBytes: number;
  /**
   * The size a refused Computer resize names; the empty string for any
   * other refusal.
   */
  readonly computerSize: ComputerSize;
}

/**
 * The details of a `SPEND_CAP_REACHED` refusal, each a whole number of
 * micro-dollars. The purchase the cap still allows is `spendCapMicros` less
 * `boughtMicros`, when that is positive. A key the refusal does not carry,
 * or carries in another form, reads as zero.
 */
export interface SpendCapReachedDetails {
  /** The Account's spend cap. */
  readonly spendCapMicros: number;
  /**
   * What the current period has bought, purchases paid and pending, before
   * the refused purchase.
   */
  readonly boughtMicros: number;
}

/**
 * Reports whether `error` is the refusal of a Computer's wake or session
 * because its Account has used its month's allowance and its extra usage:
 * an {@link ApiError}, with HTTP 402, carrying `ERROR_CODE_OUT_OF_USAGE`. A
 * wake or a session that fails later for the same cause carries the code as
 * its reason instead.
 */
export function isOutOfUsage(error: unknown): error is ApiError {
  return isApiCode(error, ERROR_CODE_OUT_OF_USAGE);
}

/**
 * The details of `error` when it is the refusal of a Computer's size as
 * larger than its Account's plan includes, an {@link ApiError} carrying
 * `ERROR_CODE_SIZE_NOT_IN_PLAN`: the size refused, the plan's largest size,
 * and the smallest plan that includes the size. `undefined` for any other
 * error. The details are read as a response is: a key the details do not
 * name is ignored, and a key the error does not carry, or carries in
 * another form, reads as the empty string.
 */
export function sizeNotInPlan(
  error: unknown,
): SizeNotInPlanDetails | undefined {
  if (!isApiCode(error, ERROR_CODE_SIZE_NOT_IN_PLAN)) return undefined;
  const details = error.details;
  return Object.freeze({
    size: detailString(details, SIZE_NOT_IN_PLAN_DETAIL_SIZE),
    largestSize: detailString(details, SIZE_NOT_IN_PLAN_DETAIL_LARGEST_SIZE),
    plan: detailString(details, SIZE_NOT_IN_PLAN_DETAIL_PLAN),
    planName: detailString(details, SIZE_NOT_IN_PLAN_DETAIL_PLAN_NAME),
  });
}

/**
 * The details of `error` when it is the refusal of a size whose disk cannot
 * hold a resource's current files, an {@link ApiError} carrying
 * `ERROR_CODE_SIZE_BELOW_USAGE`: the bytes the files use, the bytes the size
 * holds, and, for a Computer's resize, the size it names. `undefined` for
 * any other error. The details are read as {@link sizeNotInPlan} reads its
 * own: a key carried in another form, a byte count below zero or past
 * `Number.MAX_SAFE_INTEGER` included, reads as zero or the empty string.
 */
export function sizeBelowUsage(
  error: unknown,
): SizeBelowUsageDetails | undefined {
  if (!isApiCode(error, ERROR_CODE_SIZE_BELOW_USAGE)) return undefined;
  const details = error.details;
  return Object.freeze({
    usedBytes: detailCount(details, SIZE_BELOW_USAGE_DETAIL_USED_BYTES, 0),
    sizeBytes: detailCount(details, SIZE_BELOW_USAGE_DETAIL_SIZE_BYTES, 0),
    computerSize: detailString(details, SIZE_BELOW_USAGE_DETAIL_COMPUTER_SIZE),
  });
}

/**
 * The details of `error` when it is the refusal of a purchase of extra
 * usage that would pass the Account's spend cap, an {@link ApiError}
 * carrying `ERROR_CODE_SPEND_CAP_REACHED`: the cap and what the period has
 * bought, in micro-dollars. `undefined` for any other error. The details
 * are read as {@link sizeNotInPlan} reads its own: a key carried in another
 * form, an amount past the safe-integer range included, reads as zero.
 */
export function spendCapReached(
  error: unknown,
): SpendCapReachedDetails | undefined {
  if (!isApiCode(error, ERROR_CODE_SPEND_CAP_REACHED)) return undefined;
  const details = error.details;
  return Object.freeze({
    spendCapMicros: detailCount(
      details,
      SPEND_CAP_REACHED_DETAIL_SPEND_CAP,
      Number.MIN_SAFE_INTEGER,
    ),
    boughtMicros: detailCount(
      details,
      SPEND_CAP_REACHED_DETAIL_BOUGHT,
      Number.MIN_SAFE_INTEGER,
    ),
  });
}

/** The string under `key`, or the empty string when it is absent or not a string. */
function detailString(details: JsonObject | undefined, key: string): string {
  const value = details?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * The whole number under `key` from `minimum` up to
 * `Number.MAX_SAFE_INTEGER`, or zero when it is absent or not such a number.
 */
function detailCount(
  details: JsonObject | undefined,
  key: string,
  minimum: number,
): number {
  const value = details?.[key];
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : 0;
}

/**
 * The refusal of a client configuration whose `clientProduct` is partially
 * set or breaks the documented `name` and `version` grammar. Thrown by the
 * client constructors before any request is made. It is a `TypeError`, as
 * every other configuration refusal is, and `instanceof` tells it apart.
 */
export class InvalidClientProductError extends TypeError {
  constructor(reason: string) {
    super(`invalid client product: ${reason}`);
    this.name = "InvalidClientProductError";
  }
}

function causeOption(cause: unknown): ErrorOptions | undefined {
  return cause === undefined ? undefined : { cause };
}

/**
 * The reason phrase for each status, as the reference contract renders it, so one status
 * reads the same in every IDYL SDK's error message.
 */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Request Entity Too Large",
  414: "Request URI Too Long",
  415: "Unsupported Media Type",
  416: "Requested Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};

/**
 * Renders an HTTP status as `404 Not Found`, with the reason phrase the reference
 * contract renders, or as `HTTP 599` when the status has none.
 */
export function describeStatus(status: number): string {
  const text = STATUS_TEXT[status];
  return text === undefined
    ? `HTTP ${String(status)}`
    : `${String(status)} ${text}`;
}

/** What a command wrote before it ended. */
export interface CommandOutput {
  /** Its standard output, decoded as UTF-8. */
  readonly stdout: string;
  /** Its standard error, decoded as UTF-8. */
  readonly stderr: string;
  /** The notebook cell that recorded it, when it ran in a notebook. */
  readonly cell?: string;
}

/**
 * A command ran and ended other than with exit code 0. Its changes were saved
 * as usual; `code` and `signal` are what a caller branches on.
 */
export class ExitError extends Error implements CommandOutput {
  /** Its exit code, when it exited by itself. */
  declare readonly code?: number;
  /** The signal that ended it, when one did. */
  declare readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  declare readonly cell?: string;

  constructor(
    code: number | undefined,
    signal: string | undefined,
    output: CommandOutput,
  ) {
    super(
      code === undefined
        ? "command ended without an exit code"
        : `command exited with code ${String(code)}`,
    );
    this.name = "ExitError";
    if (code !== undefined) this.code = code;
    if (signal !== undefined) this.signal = signal;
    this.stdout = output.stdout;
    this.stderr = output.stderr;
    if (output.cell !== undefined) this.cell = output.cell;
  }
}

/**
 * A command ran but its changes could not be saved, so a read of the files does
 * not show them. `exitCode` is how the command itself ended.
 */
export class CommandSaveError extends Error implements CommandOutput {
  /**
   * Why the save failed, as the platform states it, such as
   * `SAVE_REASON_COMPUTER_SIZE`.
   */
  declare readonly reason?: string;
  declare readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  declare readonly cell?: string;

  constructor(
    reason: string | undefined,
    exitCode: number | undefined,
    output: CommandOutput,
  ) {
    super("command ran but its changes could not be saved");
    this.name = "CommandSaveError";
    if (reason !== undefined) this.reason = reason;
    if (exitCode !== undefined) this.exitCode = exitCode;
    this.stdout = output.stdout;
    this.stderr = output.stderr;
    if (output.cell !== undefined) this.cell = output.cell;
  }
}

/**
 * A command's session failed before the command's end was known, so the
 * command may not have run, or may have been cut short. `code` is the
 * session's error code; `broken` and `no_exit` name a connection that ended
 * without an exit, and `output_too_large` a stream past the 16 MiB a command
 * keeps. The message names the code alone.
 */
export class CommandSessionError extends Error implements CommandOutput {
  readonly code: string;
  readonly stdout: string;
  readonly stderr: string;
  declare readonly cell?: string;

  constructor(code: string, output: CommandOutput) {
    super(
      /^[a-z_]+$/u.test(code)
        ? `command session failed: ${code}`
        : "command session failed",
    );
    this.name = "CommandSessionError";
    this.code = code;
    this.stdout = output.stdout;
    this.stderr = output.stderr;
    if (output.cell !== undefined) this.cell = output.cell;
  }
}

/** Durable ingestion failure. Classify using transfer.failure.code, never its prose. */
export class UploadTransferFailedError extends Error {
  constructor(readonly transfer: UploadTransfer) {
    super(
      transfer.failure?.code
        ? `upload transfer failed: ${transfer.failure.code}`
        : "upload transfer failed",
    );
    this.name = "UploadTransferFailedError";
  }
}
