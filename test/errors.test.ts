// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import * as computer from "../src/api/computer.js";
import * as image from "../src/api/computer-image.js";
import * as notebook from "../src/api/computer-notebook.js";
import * as session from "../src/api/computer-session.js";
import * as journal from "../src/api/journal.js";
import * as storage from "../src/api/storage-errors.js";
import * as types from "../src/api/types.js";
import * as codes from "../src/client/codes.js";
import { ApiError, isApiCode, isApiStatus, isNotFound } from "../src/errors.js";

describe("ApiError", () => {
  // Contract: the message renders status, code, and the server's message in
  // the fixed form; `detail` is the server's message as sent; fields absent
  // from the response are absent from the error.
  it("renders the status line and carries the fields", () => {
    const full = new ApiError({
      status: 409,
      code: "conflict",
      message: "name in use",
      details: { name: "dev" },
      requestId: "req-1",
      retryAfterMs: 1_000,
    });
    expect(full.name).toBe("ApiError");
    expect(full.message).toBe("IDYL API: 409 Conflict: conflict");
    expect(full).toMatchObject({
      status: 409,
      code: "conflict",
      detail: "name in use",
      details: { name: "dev" },
      requestId: "req-1",
      retryAfterMs: 1_000,
    });
    const bare = new ApiError({ status: 599, message: "" });
    expect(bare.message).toBe("IDYL API: HTTP 599");
    // The reason phrases are the reference contract's, so one status reads the same in
    // every IDYL SDK's error message.
    expect(new ApiError({ status: 413, message: "" }).message).toBe(
      "IDYL API: 413 Request Entity Too Large",
    );
    expect(new ApiError({ status: 422, message: "" }).message).toBe(
      "IDYL API: 422 Unprocessable Entity",
    );
    expect("code" in bare).toBe(false);
    expect("detail" in bare).toBe(false);
    const uncoded = new ApiError({ status: 404, message: "gone" });
    expect(uncoded.message).toBe("IDYL API: 404 Not Found");
    expect(uncoded.detail).toBe("gone");
    expect(uncoded.detail).toBe("gone");
    const cause = new Error("read failed");
    expect(new ApiError({ status: 500, message: "x", cause }).cause).toBe(
      cause,
    );
  });

  // Contract: the predicates match on status and code and narrow the type.
  it("matches with the predicates", () => {
    const error: unknown = new ApiError({
      status: 404,
      code: "not_found",
      message: "gone",
    });
    expect(isNotFound(error)).toBe(true);
    expect(isApiStatus(error, 404)).toBe(true);
    expect(isApiStatus(error, 403)).toBe(false);
    expect(isApiCode(error, "not_found")).toBe(true);
    expect(isApiCode(error, "other")).toBe(false);
    expect(isNotFound(new Error("404"))).toBe(false);
    expect(isApiCode(undefined, "x")).toBe(false);
  });
});

describe("public error classes", () => {
  // Contract: the public code constants spell the contract's codes.
  it("spells every public code as the contract does", () => {
    expect(codes.ERROR_CODE_NOTEBOOK_NOT_FOUND).toBe(
      notebook.ERROR_CODE_NOTEBOOK_NOT_FOUND,
    );
    for (const name of [
      "ERROR_CODE_EXECUTION_NOT_ENABLED",
      "ERROR_CODE_COMPUTER_TERMINATING",
      "ERROR_CODE_PROFILE_FITS_NO_HOST",
      "ERROR_CODE_WAKE_TIMEOUT",
      "ERROR_CODE_SESSION_BUDGET_EXCEEDED",
      "ERROR_CODE_SESSION_FINAL",
    ] as const) {
      expect(codes[name]).toBe(session[name]);
    }
    expect(codes.ERROR_CODE_IMAGE_NOT_IN_CATALOG).toBe(
      image.ERROR_CODE_IMAGE_NOT_IN_CATALOG,
    );
    expect(codes.ERROR_CODE_COMPUTER_DOES_NOT_FIT).toBe(
      computer.ERROR_CODE_COMPUTER_DOES_NOT_FIT,
    );
    expect(codes.ERROR_CODE_NETWORK_CLASS_NOT_ADMITTED).toBe(
      types.ERROR_CODE_NETWORK_CLASS_NOT_ADMITTED,
    );
    expect(codes.ERROR_CODE_ISOLATION_CLASS_NOT_ADMITTED).toBe(
      types.ERROR_CODE_ISOLATION_CLASS_NOT_ADMITTED,
    );
    expect(codes.ERROR_CODE_CLIENT_UPGRADE_REQUIRED).toBe(
      types.ERROR_CODE_CLIENT_UPGRADE_REQUIRED,
    );
    for (const name of [
      "ERROR_CODE_UPLOAD_EXPIRED",
      "ERROR_CODE_UPLOAD_CANCELLED",
      "ERROR_CODE_SIZE_BELOW_USAGE",
      "ERROR_CODE_SIZE_ABOVE_CAP",
      "ERROR_CODE_VERSION_NOT_FOUND",
      "ERROR_CODE_FORK_NOT_QUIESCENT",
      "ERROR_CODE_PATH_INVALID",
      "ERROR_CODE_NAME_NOT_NFC",
      "ERROR_CODE_STORAGE_NOT_OPEN",
      "ERROR_CODE_HEAD_MOVED",
      "ERROR_CODE_UPLOAD_CONFLICT",
    ] as const) {
      expect(codes[name]).toBe(storage[name]);
    }
    expect(codes.ERROR_CODE_INVALID_CONTINUE).toBe(
      journal.ERROR_CODE_INVALID_CONTINUE,
    );
  });
});
