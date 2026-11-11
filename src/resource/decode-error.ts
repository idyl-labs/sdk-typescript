// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * Why a strict decode refused a document. The vocabulary is closed and only
 * grows: a value is never renamed or removed, and a new value is a new case
 * to handle.
 *
 * - `invalid_json`: the text is not one well-formed JSON value.
 * - `duplicate_field`: an object names the same key twice.
 * - `trailing_content`: a second value follows the first.
 * - `unknown_field`: the document names a field the kind does not declare.
 * - `missing_field`: a field the kind requires is absent or `null`.
 * - `wrong_type`: a value is not the JSON type the field declares.
 * - `invalid_value`: a value has the right JSON type but is not a valid
 *   spelling of the field, such as a CPU quantity of `"fast"`.
 */
export type StrictDecodeReason =
  | "invalid_json"
  | "duplicate_field"
  | "trailing_content"
  | "unknown_field"
  | "missing_field"
  | "wrong_type"
  | "invalid_value";

/** What a {@link StrictDecodeError} reports. */
export interface StrictDecodeErrorOptions {
  readonly reason: StrictDecodeReason;
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * A submission the strict decoder refused.
 *
 * `reason` is the classification to branch on and `path` locates the field
 * from the root of the document, in the form `spec.containers[0].imageURI`;
 * it is empty when the rejection is about the document as a whole. `message`
 * is prose for people and is never parsed. The cause, when there is one, is
 * the error the field's own codec raised.
 */
export class StrictDecodeError extends Error {
  readonly reason: StrictDecodeReason;
  readonly path: string;

  constructor(options: StrictDecodeErrorOptions) {
    super(
      options.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "StrictDecodeError";
    this.reason = options.reason;
    this.path = options.path;
  }
}
