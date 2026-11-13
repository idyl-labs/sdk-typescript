// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The stable codes an `ApiError` carries that a caller of this package may
 * branch on. Match them with `isApiCode(error, code)`, never on a message.
 */

import {
  SAVE_REASON_ACCOUNT_STORAGE_LIMIT,
  SAVE_REASON_COMPUTER_SIZE,
  SAVE_REASON_NAME_LIMIT,
} from "../api/storage.js";

/**
 * A call that names a notebook the Computer does not have (HTTP 404). It is
 * always a `NotebookNotFoundError`.
 */
export const ERROR_CODE_NOTEBOOK_NOT_FOUND = "NOTEBOOK_NOT_FOUND";

/**
 * Execution is not turned on for the Computer, so it runs no command. A
 * command runs once execution is turned on.
 */
export const ERROR_CODE_EXECUTION_NOT_ENABLED = "EXECUTION_NOT_ENABLED";

/**
 * A `files` session asked of a Computer that is not awake (HTTP 409). The
 * Computer is neither woken nor kept awake; its saved files are listed
 * instead. It is always a `ComputerNotAwakeError`.
 */
export const ERROR_CODE_COMPUTER_NOT_AWAKE = "COMPUTER_NOT_AWAKE";

/** A command or terminal in a Computer that is being deleted. */
export const ERROR_CODE_COMPUTER_TERMINATING = "COMPUTER_TERMINATING";

/**
 * The Computer's CPU and memory fit no machine that could run it, so it
 * cannot start until an update gives it a size that fits.
 */
export const ERROR_CODE_PROFILE_FITS_NO_HOST = "PROFILE_FITS_NO_HOST";

/**
 * The Computer was not ready in time for a command. A later attempt may
 * succeed.
 */
export const ERROR_CODE_WAKE_TIMEOUT = "WAKE_TIMEOUT";

/**
 * A limit on concurrent commands and terminals is reached (HTTP 429).
 * Another can start once one of them ends.
 */
export const ERROR_CODE_SESSION_BUDGET_EXCEEDED = "SESSION_BUDGET_EXCEEDED";

/**
 * No machine that could run the Computer has the CPU and memory free for it
 * when the request arrives. Unlike `ERROR_CODE_PROFILE_FITS_NO_HOST`, a
 * later attempt can succeed once capacity is released.
 */
export const ERROR_CODE_INSUFFICIENT_CAPACITY = "INSUFFICIENT_CAPACITY";

/**
 * No machine that could run the Computer has the disk space its files
 * need. A later attempt can succeed once space is freed.
 */
export const ERROR_CODE_INSUFFICIENT_DISK = "INSUFFICIENT_DISK";

/**
 * The saved version the Computer starts from is damaged: its stored content
 * failed its integrity checks. Restoring another saved version lets it
 * start.
 */
export const ERROR_CODE_VERSION_DAMAGED = "VERSION_DAMAGED";

/**
 * A sleep whose save of the Computer's files failed. Nothing was ended and
 * the Computer stays awake.
 */
export const ERROR_CODE_SAVE_FAILED = "SAVE_FAILED";

/**
 * A sleep whose Computer could not be released in time. It stays awake and
 * goes to sleep after its idle timeout.
 */
export const ERROR_CODE_SLEEP_TIMEOUT = "SLEEP_TIMEOUT";

/** A renewal of a session that has already ended (HTTP 409). */
export const ERROR_CODE_SESSION_FINAL = "SESSION_FINAL";

/**
 * A create or update names an image the catalogue does not hold (HTTP
 * 422); `idyl.computers.images()` lists the catalogue.
 */
export const ERROR_CODE_IMAGE_NOT_IN_CATALOG = "IMAGE_NOT_IN_CATALOG";

/**
 * The CPU and memory asked for fit no machine that could run the Computer
 * (HTTP 422). The details state the largest size that fits one at the time
 * of the request, the size the snapshot's `largestSize` names, as its CPU
 * and memory under `maxCPU` and `maxMemory`.
 */
export const ERROR_CODE_COMPUTER_DOES_NOT_FIT = "COMPUTER_DOES_NOT_FIT";

/**
 * A network class the Account may not use (HTTP 403). The details name the
 * refused class under `class` and the admitted ones under `allowed`.
 */
export const ERROR_CODE_NETWORK_CLASS_NOT_ADMITTED =
  "NETWORK_CLASS_NOT_ADMITTED";

/**
 * An isolation class not offered where the Computer lives (HTTP 403), on a
 * create or on an update that moves the Computer to another class; a wake
 * or command of a Computer whose class is withdrawn there fails with it
 * too. The
 * details name the refused class under `isolation.class` and the offered
 * ones under `allowedIsolationClasses`. `idyl.computers.images({ isolation })`
 * is empty for a class that is not offered.
 */
export const ERROR_CODE_ISOLATION_CLASS_NOT_ADMITTED =
  "ISOLATION_CLASS_NOT_ADMITTED";

/**
 * This release of the package is below the minimum the API supports (HTTP
 * 426). The details name the minimum and latest versions.
 */
export const ERROR_CODE_CLIENT_UPGRADE_REQUIRED = "CLIENT_UPGRADE_REQUIRED";

/**
 * A disk size smaller than what the Computer's files already use, or a
 * change of its CPU and memory to a size whose disk cannot hold them (HTTP
 * 409). Earlier versions do not count. `sizeBelowUsage` reads its details:
 * the bytes the files use, the bytes the size holds, and, for a change of
 * size, the size named. Freeing space lets the change through.
 */
export const ERROR_CODE_SIZE_BELOW_USAGE = "SIZE_BELOW_USAGE";

/** A disk size above the largest the Account may use. */
export const ERROR_CODE_SIZE_ABOVE_CAP = "SIZE_ABOVE_CAP";

/** A saved version, by number or name, the Computer does not have. */
export const ERROR_CODE_VERSION_NOT_FOUND = "VERSION_NOT_FOUND";

/** A fork whose source could not reach a point to copy from; try again. */
export const ERROR_CODE_FORK_NOT_QUIESCENT = "FORK_NOT_QUIESCENT";

/** A path the workspace cannot hold, or one that is reserved. */
export const ERROR_CODE_PATH_INVALID = "PATH_INVALID";

/** A file name a call writes that is not in Unicode normalization form C. */
export const ERROR_CODE_NAME_NOT_NFC = "NAME_NOT_NFC";

/**
 * The Account's storage is not open, so its saved files can be neither read
 * nor written.
 */
export const ERROR_CODE_STORAGE_NOT_OPEN = "STORAGE_NOT_OPEN";

/** The files were modified while the call ran; read again and retry. */
export const ERROR_CODE_HEAD_MOVED = "HEAD_MOVED";

/** Files a call writes were modified by someone else first. */
export const ERROR_CODE_UPLOAD_CONFLICT = "UPLOAD_CONFLICT";

/** A files change that went quiet for too long, so it cannot publish. */
export const ERROR_CODE_UPLOAD_EXPIRED = "UPLOAD_EXPIRED";

/** A files change that was cancelled, so it cannot publish. */
export const ERROR_CODE_UPLOAD_CANCELLED = "UPLOAD_CANCELLED";

/** A `continue` position the listing did not issue; list again without it. */
export const ERROR_CODE_INVALID_CONTINUE = "INVALID_CONTINUE";

/**
 * The Account has used its month's allowance and its extra usage, and
 * auto-refill cannot buy more (HTTP 402). It refuses a session at once,
 * and a wake or a session that fails later for the same cause carries it as
 * its reason. A purchase, an upgrade or the start of the Account's next
 * period lets its Computers wake again; `isOutOfUsage` classifies it.
 */
export const ERROR_CODE_OUT_OF_USAGE = "OUT_OF_USAGE";

/**
 * A wake, or a change of a Computer's CPU and memory to a larger size,
 * names a size larger than the Account's plan includes (HTTP 402). A change
 * to a size no larger than the Computer's own is never refused with it.
 * `sizeNotInPlan` reads its details: the size refused, the plan's largest
 * size, and the smallest plan that includes the size.
 */
export const ERROR_CODE_SIZE_NOT_IN_PLAN = "SIZE_NOT_IN_PLAN";

/**
 * A wake would take the vCPU of the Account's awake Computers past what its
 * plan allows at once. It fails a wake and a pending session, which carry it as
 * their reason, and it carries no details. Computers already awake keep running.
 * Putting another Computer to sleep, or upgrading to a plan with a higher limit,
 * lets the Computer wake. The count can briefly lag a change, so a wake just
 * after a sleep can fail with it and succeed when asked again.
 */
export const ERROR_CODE_VCPU_LIMIT_REACHED = "VCPU_LIMIT_REACHED";

/**
 * An Account on a free trial or on no plan has downloaded as much of its saved
 * files as one window allows (HTTP 429, with `Retry-After`). The details carry
 * `limitBytes` and `usedBytes`. A paid plan has no limit, and the next window
 * opens when `Retry-After` has passed.
 */
export const ERROR_CODE_DOWNLOAD_LIMIT_REACHED = "DOWNLOAD_LIMIT_REACHED";

/**
 * Why a plan change or a purchase failed: the card was declined, or could
 * not be charged without the user, as an auto-refill cannot. The plan in
 * force is unchanged and nothing was charged. It is also why auto-refill
 * was turned off. A portal session replaces the card.
 */
export const ERROR_CODE_PAYMENT_DECLINED = "PAYMENT_DECLINED";

/** Why auto-refill was turned off when a payment of the Account was disputed. */
export const ERROR_CODE_PAYMENT_DISPUTED = "PAYMENT_DISPUTED";

/**
 * Why a plan change or a purchase failed: its payment page expired before
 * the user completed the payment. Nothing was charged.
 */
export const ERROR_CODE_ACTION_EXPIRED = "ACTION_EXPIRED";

/**
 * Why a pending plan change failed: a later plan change of the Account
 * replaced it. Nothing was charged for it.
 */
export const ERROR_CODE_PLAN_CHANGE_SUPERSEDED = "PLAN_CHANGE_SUPERSEDED";

/**
 * Why an upgrade failed: the platform could not make it as priced. The
 * plan in force is unchanged and nothing was charged; the same change can
 * be made again later.
 */
export const ERROR_CODE_PLAN_CHANGE_UNAVAILABLE = "PLAN_CHANGE_UNAVAILABLE";

/** A plan change names a plan that is not offered (HTTP 422). */
export const ERROR_CODE_PLAN_NOT_OFFERED = "PLAN_NOT_OFFERED";

/**
 * A purchase of extra usage, or an update that turns auto-refill on, on a
 * plan that does not include extra usage (HTTP 402). An upgrade to a plan
 * that includes it lets the Account buy.
 */
export const ERROR_CODE_EXTRA_USAGE_NOT_IN_PLAN = "EXTRA_USAGE_NOT_IN_PLAN";

/**
 * A purchase of extra usage that would take what the current period has
 * bought, purchases paid and pending, past the Account's spend cap (HTTP
 * 409). `spendCapReached` reads its details: the cap and what the period
 * has bought.
 */
export const ERROR_CODE_SPEND_CAP_REACHED = "SPEND_CAP_REACHED";

/**
 * An update that would leave auto-refill on with no spend cap set (HTTP
 * 422): auto-refill never buys without a cap.
 */
export const ERROR_CODE_AUTO_REFILL_NEEDS_SPEND_CAP =
  "AUTO_REFILL_NEEDS_SPEND_CAP";

/*
 * A save or an upload refused for size carries its reason as its code:
 * `SAVE_REASON_ACCOUNT_STORAGE_LIMIT`, `SAVE_REASON_COMPUTER_SIZE` or
 * `SAVE_REASON_NAME_LIMIT`, defined beside the save and upload contracts.
 */
export {
  SAVE_REASON_ACCOUNT_STORAGE_LIMIT,
  SAVE_REASON_COMPUTER_SIZE,
  SAVE_REASON_NAME_LIMIT,
};

/**
 * The code an `ApiError` carries. It is an open union: the platform may add
 * codes, which arrive as their own strings.
 */
export type ApiErrorCode =
  | typeof ERROR_CODE_NOTEBOOK_NOT_FOUND
  | typeof ERROR_CODE_EXECUTION_NOT_ENABLED
  | typeof ERROR_CODE_COMPUTER_TERMINATING
  | typeof ERROR_CODE_PROFILE_FITS_NO_HOST
  | typeof ERROR_CODE_WAKE_TIMEOUT
  | typeof ERROR_CODE_SESSION_BUDGET_EXCEEDED
  | typeof ERROR_CODE_INSUFFICIENT_CAPACITY
  | typeof ERROR_CODE_INSUFFICIENT_DISK
  | typeof ERROR_CODE_VERSION_DAMAGED
  | typeof ERROR_CODE_SAVE_FAILED
  | typeof ERROR_CODE_SLEEP_TIMEOUT
  | typeof ERROR_CODE_SESSION_FINAL
  | typeof ERROR_CODE_IMAGE_NOT_IN_CATALOG
  | typeof ERROR_CODE_COMPUTER_DOES_NOT_FIT
  | typeof ERROR_CODE_NETWORK_CLASS_NOT_ADMITTED
  | typeof ERROR_CODE_ISOLATION_CLASS_NOT_ADMITTED
  | typeof ERROR_CODE_CLIENT_UPGRADE_REQUIRED
  | typeof ERROR_CODE_SIZE_BELOW_USAGE
  | typeof ERROR_CODE_SIZE_ABOVE_CAP
  | typeof ERROR_CODE_VERSION_NOT_FOUND
  | typeof ERROR_CODE_FORK_NOT_QUIESCENT
  | typeof ERROR_CODE_PATH_INVALID
  | typeof ERROR_CODE_NAME_NOT_NFC
  | typeof ERROR_CODE_STORAGE_NOT_OPEN
  | typeof ERROR_CODE_HEAD_MOVED
  | typeof ERROR_CODE_UPLOAD_CONFLICT
  | typeof ERROR_CODE_UPLOAD_EXPIRED
  | typeof ERROR_CODE_UPLOAD_CANCELLED
  | typeof ERROR_CODE_INVALID_CONTINUE
  | typeof ERROR_CODE_OUT_OF_USAGE
  | typeof ERROR_CODE_SIZE_NOT_IN_PLAN
  | typeof ERROR_CODE_VCPU_LIMIT_REACHED
  | typeof ERROR_CODE_DOWNLOAD_LIMIT_REACHED
  | typeof ERROR_CODE_PAYMENT_DECLINED
  | typeof ERROR_CODE_PAYMENT_DISPUTED
  | typeof ERROR_CODE_ACTION_EXPIRED
  | typeof ERROR_CODE_PLAN_CHANGE_SUPERSEDED
  | typeof ERROR_CODE_PLAN_CHANGE_UNAVAILABLE
  | typeof ERROR_CODE_PLAN_NOT_OFFERED
  | typeof ERROR_CODE_EXTRA_USAGE_NOT_IN_PLAN
  | typeof ERROR_CODE_SPEND_CAP_REACHED
  | typeof ERROR_CODE_AUTO_REFILL_NEEDS_SPEND_CAP
  | typeof SAVE_REASON_ACCOUNT_STORAGE_LIMIT
  | typeof SAVE_REASON_COMPUTER_SIZE
  | typeof SAVE_REASON_NAME_LIMIT
  | (string & Record<never, never>);
