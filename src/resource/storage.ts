// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "./json.js";
import {
  always,
  boolean,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import {
  parseJournalEntryId,
  parseComputerId,
  type JournalEntryId,
  type ComputerId,
} from "./uuid-id.js";
import { prefixed } from "./validation.js";

/** Names one Computer in the request's Account and Namespace. */
export interface StorageResourceReference {
  /** Stable Computer identity. */
  readonly computer?: ComputerId;
}
/** The inline wire fields shared by resource ownership and historical references. */
export const storageResourceReferenceFields = {
  computer: omitEmpty(string<ComputerId>()),
};
/** The canonical wire shape of one resource reference. */
export const storageResourceReferenceShape: Shape<StorageResourceReference> =
  object<StorageResourceReference>(storageResourceReferenceFields);
/** Requires one canonical source identity; authorization remains a server check. */
export function validateStorageResourceReference(
  reference: StorageResourceReference,
): void {
  const computer = reference.computer ?? "";
  if (computer === "") throw new TypeError("computer is required");
  parseComputerId(computer);
}
/**
 * Selects what a create copies from a source Computer: one entry of its
 * history, or the Computer as it is now.
 *
 * A reference that names `entry` copies that entry and saves nothing; later
 * changes to the source do not reach the new resource. A reference that
 * names no entry copies the source as it is now: `CreateComputerRequest`'s
 * `forkOf` states when the platform saves the source first and which entry
 * the fork then copies. `save` overrides that choice and is stated only on
 * a reference that names no entry.
 */
export interface ForkReference {
  readonly source: StorageResourceReference;
  /**
   * The source entry the fork starts at: an entry of the source's journal,
   * or a cell of one of the source Computer's notebooks. A fork from a
   * notebook cell starts at the save that covers that cell and receives that
   * one notebook up to and including the cell, continuing from its shell
   * state; forking from a cell requires permission to read the source's
   * notebooks. Other notebooks are never copied. `undefined` or empty, the
   * fork copies the source as it is now, and none is written.
   */
  readonly entry?: JournalEntryId;
  /**
   * Whether the platform saves the source before a fork that names no
   * entry: `true` saves it first, `false` never does, and `undefined`
   * follows the source's own save setting. A stated `false` is written.
   * Refused together with `entry`.
   */
  readonly save?: boolean;
}
/** The wire shape of a fork reference. */
export const forkReferenceShape: Shape<ForkReference> = object<ForkReference>({
  source: always(storageResourceReferenceShape),
  entry: omitEmpty(string<JournalEntryId>()),
  save: pointer(boolean()),
});
/**
 * Checks the source identity, the entry identity when one is named, and
 * that `save` is not stated together with an entry. It neither reads nor
 * authorizes the source, and does not check that the entry belongs to it.
 */
export function validateForkReference(reference: ForkReference): void {
  prefixed("source", () => {
    validateStorageResourceReference(reference.source);
  });
  const entry = reference.entry ?? "";
  if (entry === "") return;
  prefixed("entry", () => {
    parseJournalEntryId(entry);
  });
  if (reference.save !== undefined) {
    throw new TypeError("save is stated only on a fork that names no entry");
  }
}
/** Historical fork provenance; version zero is reported genesis, distinct from a create's entry target. */
export interface VersionRef extends StorageResourceReference {
  readonly version: Integer;
}
/** The wire shape of historical resource/version provenance. */
export const versionRefShape: Shape<VersionRef> = object<VersionRef>({
  ...storageResourceReferenceFields,
  version: always(integer({ unsigned: false, bits: 64 })),
});
/** Checks resource identity and nonnegative version number. */
export function validateVersionRef(reference: VersionRef): void {
  validateStorageResourceReference(reference);
  if (reference.version < 0)
    throw new TypeError("version must be non-negative");
}
