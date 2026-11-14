// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/** Storage error codes classify API refusals; clients never parse human messages. */
/**
 * Refuses, with HTTP 409, a size smaller than the resource's measured
 * referenced bytes: a storage size, or a change of a Computer's CPU and
 * memory to a size whose disk cannot hold its current files. Earlier
 * versions do not count. The details carry the keys
 * `SIZE_BELOW_USAGE_DETAIL_USED_BYTES` and
 * `SIZE_BELOW_USAGE_DETAIL_SIZE_BYTES`, and, for a Computer's size,
 * `SIZE_BELOW_USAGE_DETAIL_COMPUTER_SIZE`; see `SizeBelowUsageDetails`.
 * Freeing space lets the change through.
 */
export const ERROR_CODE_SIZE_BELOW_USAGE = "SIZE_BELOW_USAGE";

/** ErrorCodeSizeAboveCap refuses a requested size above the applicable Account or Subnet cap. */
export const ERROR_CODE_SIZE_ABOVE_CAP = "SIZE_ABOVE_CAP";

/** ErrorCodeHeadMoved reports that the selected files head changed before the operation could act. */
export const ERROR_CODE_HEAD_MOVED = "HEAD_MOVED";

/** ErrorCodeUploadExpired reports an upload whose inactivity deadline ended its publication eligibility. */
export const ERROR_CODE_UPLOAD_EXPIRED = "UPLOAD_EXPIRED";

/** ErrorCodeUploadCancelled reports a cancelled upload, which can no longer publish. */
export const ERROR_CODE_UPLOAD_CANCELLED = "UPLOAD_CANCELLED";

/** ErrorCodeUploadConflict reports overlapping file changes since the upload base; the upload ends in conflict. */
export const ERROR_CODE_UPLOAD_CONFLICT = "UPLOAD_CONFLICT";

/** ErrorCodeChangeSequenceMismatch refuses reuse of an accepted change sequence with a different fingerprint. */
export const ERROR_CODE_CHANGE_SEQUENCE_MISMATCH = "CHANGE_SEQUENCE_MISMATCH";

/** ErrorCodeVersionNotFound reports a version number or name absent from the addressed resource. */
export const ERROR_CODE_VERSION_NOT_FOUND = "VERSION_NOT_FOUND";

/** ErrorCodeResultExpired reports a result payload no longer retained; it does not grant a repeated effect. */
export const ERROR_CODE_RESULT_EXPIRED = "RESULT_EXPIRED";

/** ErrorCodeForkCrossNamespace refuses a fork across Namespace authority boundaries. */
export const ERROR_CODE_FORK_CROSS_NAMESPACE = "FORK_CROSS_NAMESPACE";

/**
 * Refuses, with HTTP 409, a fork whose source cannot establish the required
 * copy point. A Computer fork that names no entry is refused with it when
 * the save it makes first fails; the details then carry that save's reason
 * under `FORK_NOT_QUIESCENT_DETAIL_SAVE_REASON`, and no Computer is created.
 */
export const ERROR_CODE_FORK_NOT_QUIESCENT = "FORK_NOT_QUIESCENT";

/**
 * The details key of a `FORK_NOT_QUIESCENT` refusal whose save failed. Its
 * value is a string spelled as the failed save's `reason`, such as
 * `SAVE_REASON_COMPUTER_SIZE`; the set of reasons may grow, so an unknown
 * one is carried, not rejected. See `ForkNotQuiescentDetails`.
 */
export const FORK_NOT_QUIESCENT_DETAIL_SAVE_REASON = "saveReason";

/** ErrorCodePathInvalid refuses a structurally invalid byte path or a mutation of reserved runtime state. */
export const ERROR_CODE_PATH_INVALID = "PATH_INVALID";

/** ErrorCodeNameNotNFC refuses a newly created name that is not UTF-8 NFC; existing byte names remain addressable. */
export const ERROR_CODE_NAME_NOT_NFC = "NAME_NOT_NFC";

/** ErrorCodeStorageNotOpen refuses storage operations for an Account whose storage feature is not open. */
export const ERROR_CODE_STORAGE_NOT_OPEN = "STORAGE_NOT_OPEN";

/** Storage pending reasons describe the prerequisite the resource is waiting for. */
export const STORAGE_PENDING_REASON_WAITING_FOR_DISK = "WaitingForDisk";

/** StoragePendingReasonNoViewCapableNode waits for capacity that advertises verified views. */
export const STORAGE_PENDING_REASON_NO_VIEW_CAPABLE_NODE = "NoViewCapableNode";

/** StoragePendingReasonWaitingForVersion waits until the machine has applied the requested floor. */
export const STORAGE_PENDING_REASON_WAITING_FOR_VERSION = "WaitingForVersion";

/** Refuses a transfer part that skips the accepted contiguous prefix. */
export const ERROR_CODE_CHANGE_SEQUENCE_GAP = "CHANGE_SEQUENCE_GAP";
/** Refuses a part or completion digest that differs from accepted bytes. */
export const ERROR_CODE_UPLOAD_DIGEST_MISMATCH = "UPLOAD_DIGEST_MISMATCH";
/** Refuses a request body above the transfer's advertised per-part budget. */
export const ERROR_CODE_UPLOAD_PART_TOO_LARGE = "UPLOAD_PART_TOO_LARGE";
