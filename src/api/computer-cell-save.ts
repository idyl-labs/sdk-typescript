// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "../resource/json.js";
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
  type JournalEntryId,
} from "../resource/uuid-id.js";

/** Live save progress or a retained outcome; unknown tokens are carried on read. */
export type ComputerCellSaveState =
  | "pending"
  | "retrying"
  | "saved"
  | "unchanged"
  | "failed"
  | "off"
  | "forked"
  | (string & Record<never, never>);
/** Judges membership in this SDK's save-state vocabulary. */
export function validateComputerCellSaveState(
  state: ComputerCellSaveState,
): void {
  switch (state) {
    case "pending":
    case "retrying":
    case "saved":
    case "unchanged":
    case "failed":
    case "off":
    case "forked":
      return;
    case "":
      throw new TypeError("cell save state is required");
    default:
      throw new TypeError(`unknown cell save state ${JSON.stringify(state)}`);
  }
}
/**
 * Reports one save. `version` and `entry` are historical facts, not
 * ownership; `entryDeleted` reports that the covering entry no longer
 * exists although the cell was kept.
 */
export interface ComputerCellSave {
  readonly state: ComputerCellSaveState;
  readonly version?: Integer;
  readonly entry?: JournalEntryId;
  readonly entryDeleted?: boolean;
  readonly reason?: string;
  /** Seconds spent failing; zero remains a reported observation. */
  readonly failingSeconds?: Integer;
  /** The reported failing budget in seconds; zero remains explicit. */
  readonly failingBudgetSeconds?: Integer;
}
/** The canonical wire shape of a Cell save observation. */
export const computerCellSaveShape: Shape<ComputerCellSave> =
  object<ComputerCellSave>({
    state: always(string<ComputerCellSaveState>()),
    version: pointer(integer({ unsigned: false, bits: 64 })),
    entry: omitEmpty(string<JournalEntryId>()),
    entryDeleted: omitEmpty(boolean()),
    reason: omitEmpty(string()),
    failingSeconds: pointer(integer({ unsigned: false, bits: 64 })),
    failingBudgetSeconds: pointer(integer({ unsigned: false, bits: 64 })),
  });
/** Checks state-selected identities and nonnegative count arithmetic. */
export function validateComputerCellSave(save: ComputerCellSave): void {
  validateComputerCellSaveState(save.state);
  for (const count of [
    save.version,
    save.failingSeconds,
    save.failingBudgetSeconds,
  ])
    if (count !== undefined && count < 0)
      throw new TypeError("save counts must be non-negative");
  if (save.state === "saved" || save.state === "unchanged") {
    if (save.version === undefined)
      throw new TypeError("saved or unchanged requires version");
    parseJournalEntryId(save.entry ?? "");
  } else if (
    save.version !== undefined ||
    (save.entry ?? "") !== "" ||
    save.entryDeleted
  )
    throw new TypeError("save version and entry require saved or unchanged");
  if (save.state === "failed" && (save.reason ?? "") === "")
    throw new TypeError("failed save requires reason");
}
