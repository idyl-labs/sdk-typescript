// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/** Supported fork state tokens; reads also carry newer tokens. */
export type ForkState =
  "copying" | "done" | "failed" | (string & Record<never, never>);
/** Judges fork state membership without making decoding strict. */
export function validateForkState(value: ForkState): void {
  if (["copying", "done", "failed"].includes(value)) return;
  if (value === "") throw new TypeError("fork state is required");
  throw new TypeError(`unknown fork state ${JSON.stringify(value)}`);
}

/** Supported version origin tokens; reads also carry newer tokens. */
export type VersionOrigin =
  | "genesis"
  | "commit"
  | "upload"
  | "restore"
  | "fork-point"
  | (string & Record<never, never>);
/** Judges version origin membership without making decoding strict. */
export function validateVersionOrigin(value: VersionOrigin): void {
  if (["genesis", "commit", "upload", "restore", "fork-point"].includes(value))
    return;
  if (value === "") throw new TypeError("version origin is required");
  throw new TypeError(`unknown version origin ${JSON.stringify(value)}`);
}

/** Supported commit state tokens; reads also carry newer tokens. */
export type CommitState =
  | "pending"
  | "saved"
  | "unchanged"
  | "failed"
  | (string & Record<never, never>);
/** Judges commit state membership without making decoding strict. */
export function validateCommitState(value: CommitState): void {
  if (["pending", "saved", "unchanged", "failed"].includes(value)) return;
  if (value === "") throw new TypeError("commit state is required");
  throw new TypeError(`unknown commit state ${JSON.stringify(value)}`);
}

/** Supported restore state tokens; reads also carry newer tokens. */
export type RestoreState =
  "pending" | "published" | "failed" | (string & Record<never, never>);
/** Judges restore state membership without making decoding strict. */
export function validateRestoreState(value: RestoreState): void {
  if (["pending", "published", "failed"].includes(value)) return;
  if (value === "") throw new TypeError("restore state is required");
  throw new TypeError(`unknown restore state ${JSON.stringify(value)}`);
}
