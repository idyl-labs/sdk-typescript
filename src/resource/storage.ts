// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "./json.js";
import {
  always,
  integer,
  object,
  omitEmpty,
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
 * Fixes the source journal entry a create operation copies. Later changes
 * to the source do not change the new resource's history.
 */
export interface ForkReference {
  readonly source: StorageResourceReference;
  /**
   * The source entry the fork starts at: an entry of the source's journal,
   * or a cell of one of the source Computer's notebooks. A fork from a
   * notebook cell starts at the save that covers that cell and receives that
   * one notebook up to and including the cell, continuing from its shell
   * state; forking from a cell requires permission to read the source's
   * notebooks. Other notebooks are never copied.
   */
  readonly entry: JournalEntryId;
}
/** The wire shape of an immutable fork point. */
export const forkReferenceShape: Shape<ForkReference> = object<ForkReference>({
  source: always(storageResourceReferenceShape),
  entry: always(string<JournalEntryId>()),
});
/** Checks source and entry identities without reading or authorizing the source. */
export function validateForkReference(reference: ForkReference): void {
  prefixed("source", () => {
    validateStorageResourceReference(reference.source);
  });
  prefixed("entry", () => {
    parseJournalEntryId(reference.entry);
  });
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
