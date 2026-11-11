// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { integerEqual } from "../internal/strictdecode.js";
import { isUint64 } from "../internal/strictdecode.js";
import { validateComputerNotebookName } from "./computer-notebook-name.js";
import {
  validateComputerSessionKind,
  type ComputerSessionKind,
} from "./computer-awake.js";
import { parseJson } from "../resource/json.js";
import type { Integer } from "../resource/json.js";
import type { PageOptions } from "./storage.js";
import {
  storageResourceReferenceShape,
  validateForkReference,
  type ForkReference,
} from "../resource/storage.js";
import {
  parseComputerSessionId,
  type ComputerSessionId,
} from "../resource/uuid-id.js";
import {
  always,
  array,
  boolean,
  decodeValue,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import type { JsonObject } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";
import {
  parseJournalEntryId,
  type JournalEntryId,
} from "../resource/uuid-id.js";
import { prefixed } from "../resource/validation.js";
import type { ListResponse } from "./types.js";
import {
  validateComputerCell,
  computerCellShape,
  type ComputerCell,
} from "./computer-cell.js";
import {
  isZeroInstant,
  validateStatedClient,
  type ComputerSessionClient,
} from "./computer-session.js";
import {
  validateComputerExecutionSettingsChange,
  computerExecutionSettingsChangeShape,
  type ComputerExecutionSettingsChange,
} from "./computer-execution-settings.js";

/** The largest page a journal list returns, and the largest `limit` a request may state. */
export const MAX_JOURNAL_PAGE_SIZE = 200;

/**
 * What a journal entry records.
 *
 * - `genesis`: the first entry of every journal: sequence number zero,
 *   recording nothing. It is not counted in any count.
 * - `cell`: an entry that records one command run in the Computer outside
 *   any notebook, such as a copied Cell. Its `cell` carries the detail. A
 *   command run in a notebook is a cell of that notebook, listed with it,
 *   and a private session records nothing.
 * - `execution-settings`: an entry that records one change to the Computer's
 *   execution settings. Its `executionSettings` carries the whole settings after the
 *   change.
 * - `upload`: an entry that owns a file-change version once its publication
 *   succeeds.
 * - `edit`: an entry that owns a file-change version once its publication
 *   succeeds.
 * - `restore`: an entry that owns a restored version. On a Computer whose
 *   restore changed its execution settings, its `executionSettings` records
 *   the settings the restore set.
 * - `save`: an entry that records a save and owns its published version.
 *   Its `save` says what caused it.
 * - `fork-point`: an entry that records the copied starting point of a
 *   fork.
 * - `rename`: an entry that records a change of the Computer's name. Its
 *   `rename` carries the name before and after, and its `creator` who
 *   renamed it. It owns no version: the Computer's files and identity are
 *   unchanged.
 * - `wake`: an entry that records the Computer woken on request from sleep.
 *   Its `creator` is who woke it. It owns no version and carries no detail.
 *   A wake that found the Computer awake records nothing.
 * - `sleep`: an entry that records the Computer put to sleep on request:
 *   its execution released after its files were saved and its sessions
 *   ended. Its `creator` is who put it to sleep. It owns no version; the
 *   save the sleep made is its own `save` entry. Its `sleep` detail is
 *   present when the sleep discarded unsaved changes on request. A sleep
 *   that found the Computer asleep records nothing.
 * - `restart`: an entry that records the Computer's execution started again
 *   without the Computer going to sleep, on the same files and history. IDYL
 *   makes a restart on its own, so it names no `creator`. Its `restart` detail
 *   says why. The sessions open at the restart ended with it. It owns no
 *   version.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateJournalEntryKind}
 * judges membership, and a caller shows an entry of a kind it does not know
 * as one it cannot describe.
 */
export type JournalEntryKind =
  | "genesis"
  | "cell"
  | "execution-settings"
  | "upload"
  | "edit"
  | "restore"
  | "save"
  | "fork-point"
  | "rename"
  | "wake"
  | "sleep"
  | "restart"
  | (string & Record<never, never>);

/**
 * Judges that the kind is one this SDK names. The empty string is reported
 * as missing. Throws a `TypeError`.
 */
export function validateJournalEntryKind(kind: JournalEntryKind): void {
  switch (kind) {
    case "genesis":
    case "cell":
    case "execution-settings":
    case "upload":
    case "edit":
    case "restore":
    case "save":
    case "fork-point":
    case "rename":
    case "wake":
    case "sleep":
    case "restart":
      return;
    case "":
      throw new TypeError("journal entry kind is required");
    default:
      throw new TypeError(`unknown journal entry kind ${JSON.stringify(kind)}`);
  }
}

/**
 * What caused a save entry.
 *
 * - `session-end`: a save made when a session ended, capturing the files it
 *   left behind.
 * - `change`: a save IDYL made on its own because the files changed: once
 *   writes had been quiet for the Computer's `saveQuiet`, or once its
 *   `saveMaxInterval` had passed while writes went on. One such save can hold the changes of
 *   several people, so it names no `creator`.
 * - `request`: a save a caller asked for with a commit.
 * - `release`: the save IDYL made when the execution holding the files was
 *   released.
 * - `recovery`: a save of work kept after the session that wrote it ended
 *   without saving it. It names no `creator`.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateJournalSaveTrigger} judges
 * membership, and a caller shows a save of a trigger it does not know as a
 * save it cannot explain.
 */
export type JournalSaveTrigger =
  | "session-end"
  | "change"
  | "request"
  | "release"
  | "recovery"
  | (string & Record<never, never>);

/**
 * Judges that the trigger is one this SDK names. The empty string is
 * reported as missing. Throws a `TypeError`.
 */
export function validateJournalSaveTrigger(trigger: JournalSaveTrigger): void {
  switch (trigger) {
    case "session-end":
    case "change":
    case "request":
    case "release":
    case "recovery":
      return;
    case "":
      throw new TypeError("save trigger is required");
    default:
      throw new TypeError(`unknown save trigger ${JSON.stringify(trigger)}`);
  }
}

/**
 * What caused a save entry, and, for a save made when a session ended,
 * which session and which notebook cell. The links are historical: the
 * session or notebook they name may since have been deleted, and they grant
 * no access to it.
 */
export interface JournalEntrySave {
  /** What caused the save. */
  readonly trigger: JournalSaveTrigger;
  /**
   * The notebook whose cell caused the save, set together with `cell`;
   * only on a `session-end` save.
   */
  readonly notebook?: string;
  /**
   * The notebook cell whose end caused the save, set together with
   * `notebook`; only on a `session-end` save.
   */
  readonly cell?: JournalEntryId;
  /** The session whose end caused the save; only on a `session-end` save. */
  readonly session?: ComputerSessionId;
}

const journalEntrySaveShape: Shape<JournalEntrySave> = object<JournalEntrySave>(
  {
    trigger: always(string<JournalSaveTrigger>()),
    notebook: omitEmpty(string()),
    cell: omitEmpty(string<JournalEntryId>()),
    session: omitEmpty(string<ComputerSessionId>()),
  },
);

/**
 * Judges the save against this SDK's contract: a trigger this SDK names, a
 * notebook and a cell stated together and well formed, a well-formed
 * session, and links only on a `session-end` save. Throws a `TypeError`.
 */
export function validateJournalEntrySave(save: JournalEntrySave): void {
  validateJournalSaveTrigger(save.trigger);
  const notebook = save.notebook ?? "";
  const cell = save.cell ?? "";
  const session = save.session ?? "";
  if ((notebook !== "") !== (cell !== "")) {
    throw new TypeError("notebook and cell must be set together");
  }
  if (notebook !== "") {
    prefixed("notebook", () => {
      validateComputerNotebookName(notebook);
    });
    prefixed("cell", () => {
      parseJournalEntryId(cell);
    });
  }
  if (session !== "") {
    prefixed("session", () => {
      parseComputerSessionId(session);
    });
  }
  if (save.trigger !== "session-end" && (notebook !== "" || session !== "")) {
    throw new TypeError(
      `a ${save.trigger} save names no notebook, cell, or session`,
    );
  }
}

/** Original provenance retained by copies of any journal entry kind; it conveys no source-read or execution authority. */
export interface JournalEntryOrigin extends ForkReference {
  /** Recorded original Computer session, when known; historical and only on Cell origins. */
  readonly session?: ComputerSessionId;
}
/** Checks recorded identities without requiring or authorizing source existence. */
export function validateJournalEntryOrigin(origin: JournalEntryOrigin): void {
  validateForkReference(origin);
  if ((origin.session ?? "") !== "")
    prefixed("session", () => {
      parseComputerSessionId(origin.session ?? "");
    });
}
const journalEntryOriginShape: Shape<JournalEntryOrigin> =
  object<JournalEntryOrigin>({
    source: always(storageResourceReferenceShape),
    entry: always(string<JournalEntryId>()),
    session: omitEmpty(string<ComputerSessionId>()),
  });

/**
 * The change of name a `rename` entry records. Both names are the
 * Computer's names at the time; neither is a reference that resolves to the
 * Computer later, since the name it had may since have been given to
 * another Computer.
 */
export interface JournalEntryRename {
  /** The name the Computer had before the rename. */
  readonly from: string;
  /** The name the rename gave the Computer. */
  readonly to: string;
}

const journalEntryRenameShape: Shape<JournalEntryRename> =
  object<JournalEntryRename>({
    from: always(string()),
    to: always(string()),
  });

/**
 * Requires both names, and requires them to differ: a rename to the name a
 * Computer already has records nothing. Throws a `TypeError`.
 */
export function validateJournalEntryRename(rename: JournalEntryRename): void {
  if (rename.from === "" || rename.to === "") {
    throw new TypeError("from and to are required");
  }
  if (rename.from === rename.to) {
    throw new TypeError("from and to must differ");
  }
}

/**
 * One entry of a Computer's journal: the history of what was
 * done to that resource, one list that only grows forward. An entry is
 * placed when it is admitted, so a running Cell keeps its place while it
 * runs, and entries are never moved, rewritten, or removed. Restoring an
 * earlier version appends a restore entry rather than returning to it.
 *
 * Entries are numbered per journal in the order they were admitted,
 * starting at genesis. A Computer's execution-settings changes share that
 * journal with the entries that own saved versions. Every entry names who caused it, except one IDYL made on its
 * own.
 *
 * {@link decodeJournalEntry} reads one leniently: a field or kind
 * newer than this SDK is carried rather than refused, and
 * {@link validateJournalEntry} judges the entry against this SDK's
 * contract.
 */
export interface JournalEntry {
  /** Saved version owned by this entry; zero is genesis, absent until published. */
  readonly version?: Integer;
  /** Original source and entry; later copies and source deletion retain it unchanged. */
  readonly origin?: JournalEntryOrigin;
  /** Names the entry on the journal routes; it never changes. */
  readonly id: JournalEntryId;
  /**
   * The entry's sequence number: zero for genesis, then increasing in the
   * order entries were admitted. Two entries of one resource never share
   * one. Always written.
   */
  readonly seq: Integer;
  /** What the entry records. */
  readonly kind: JournalEntryKind;
  /** When the platform admitted the entry, by its own clock, as an RFC 3339 instant. */
  readonly admittedAt: string;
  /**
   * The identity that caused the entry: who saved, uploaded, restored,
   * changed the settings, renamed, or forked. `undefined` only on an entry IDYL made
   * on its own, such as genesis, a change-driven save, a release save, or an
   * image patch. It is informative and grants nothing.
   */
  readonly creator?: string;
  /**
   * The kind of client whose request caused the entry, or `unknown` when
   * that request stated none. `undefined` on an entry IDYL made on its own.
   * It is informative and grants nothing.
   */
  readonly client?: ComputerSessionClient;
  /**
   * The session the entry records, present exactly when `kind` is `cell`.
   * In a journal list it carries its command bounded by
   * `MAX_COMPUTER_CELL_LISTED_COMMAND_BYTES`; reading the entry on its own
   * returns the whole command.
   */
  readonly cell?: ComputerCell;
  /**
   * The execution settings the entry records. Present when `kind` is
   * `execution-settings`, and on the `restore` entry of a Computer whose
   * restore changed its settings, where it is the settings the restore set:
   * those in force at the restored version's entry, applied at the
   * Computer's next start. Absent on every other entry. In a journal list
   * its variable values are bounded by
   * `MAX_COMPUTER_EXECUTION_SETTINGS_LISTED_VARIABLE_BYTES`; reading the
   * entry on its own returns them whole.
   */
  readonly executionSettings?: ComputerExecutionSettingsChange;
  /** What caused a save, present exactly when `kind` is `save`. */
  readonly save?: JournalEntrySave;
  /** The change of name, present exactly when `kind` is `rename`. */
  readonly rename?: JournalEntryRename;
  /**
   * Why the Computer slept and what the sleep did beyond releasing it. It is
   * present only when `kind` is `sleep`.
   */
  readonly sleep?: JournalEntrySleep;
  /**
   * What kind of session started the Computer. It is present only when `kind`
   * is `wake`, and absent on a wake request and on a start IDYL made on its
   * own.
   */
  readonly wake?: JournalEntryWake;
  /** Why the execution started again, present exactly when `kind` is `restart`. */
  readonly restart?: JournalEntryRestart;
}

/**
 * Why a Computer went to sleep: `request`, a caller asked; `idle`, it reached
 * its idle timeout with nothing holding it; `no-execution`, its execution had
 * stopped and nothing was waiting to start it again; `settings`, so that its
 * next start uses new execution settings; `restore`, a restore set earlier
 * execution settings; `node-drain`, the machine it ran on was being drained; `out-of-usage`,
 * the Account ran out of usage; or `plan-size`, its size is above what the
 * Account's plan includes.
 *
 * The union is open: a caller shows a sleep of a reason it does not know as a
 * sleep it cannot explain.
 */
export type JournalSleepReason =
  | "request"
  | "idle"
  | "no-execution"
  | "settings"
  | "restore"
  | "node-drain"
  | "out-of-usage"
  | "plan-size"
  | (string & Record<never, never>);

/**
 * Judges that the reason is one this SDK names. The empty string is reported
 * as missing. Throws a `TypeError`.
 */
export function validateJournalSleepReason(reason: JournalSleepReason): void {
  switch (reason) {
    case "request":
    case "idle":
    case "no-execution":
    case "settings":
    case "restore":
    case "node-drain":
    case "out-of-usage":
    case "plan-size":
      return;
    case "":
      throw new TypeError("sleep reason is required");
    default:
      throw new TypeError(`unknown sleep reason "${reason}"`);
  }
}

/**
 * Why a Computer's execution started again: `node-lost`, the machine it ran on
 * was lost; or `replaced`, its execution was replaced for any other reason.
 *
 * The union is open: a caller shows a restart of a reason it does not know as
 * a restart it cannot explain.
 */
export type JournalRestartReason =
  "node-lost" | "replaced" | (string & Record<never, never>);

/**
 * Judges that the reason is one this SDK names. The empty string is reported
 * as missing. Throws a `TypeError`.
 */
export function validateJournalRestartReason(
  reason: JournalRestartReason,
): void {
  switch (reason) {
    case "node-lost":
    case "replaced":
      return;
    case "":
      throw new TypeError("restart reason is required");
    default:
      throw new TypeError(`unknown restart reason "${reason}"`);
  }
}

/** The detail of a `wake` entry a session caused. */
export interface JournalEntryWake {
  /** The kind of session that started the Computer. */
  readonly session: ComputerSessionKind;
}

/** The detail of a `restart` entry. */
export interface JournalEntryRestart {
  /** Why the Computer's execution started again. */
  readonly reason: JournalRestartReason;
}

/**
 * The detail of a `sleep` entry. Its presence alone says nothing about
 * unsaved changes: only `discardedUnsavedChanges` does.
 */
export interface JournalEntrySleep {
  /** Why the Computer slept. */
  readonly reason?: JournalSleepReason;
  /**
   * The idle timeout in force when the Computer slept, in its canonical
   * spelling; only with `idle`.
   */
  readonly idleTimeout?: string;
  /**
   * True when the sleep was asked to discard the Computer's unsaved changes
   * (`CreateComputerSleepRequest.discardUnsavedChanges`) and released it
   * without saving them.
   */
  readonly discardedUnsavedChanges?: boolean;
  /**
   * True when the sleep was asked to force
   * (`CreateComputerSleepRequest.force`): its save holds what the Computer's
   * programs had written when it was taken, and they were then stopped
   * without a shutdown.
   */
  readonly forced?: boolean;
}

const journalEntrySleepShape: Shape<JournalEntrySleep> =
  object<JournalEntrySleep>({
    reason: omitEmpty(string<JournalSleepReason>()),
    idleTimeout: omitEmpty(string()),
    discardedUnsavedChanges: omitEmpty(boolean()),
    forced: omitEmpty(boolean()),
  });

const journalEntryWakeShape: Shape<JournalEntryWake> = object<JournalEntryWake>(
  {
    session: always(string<ComputerSessionKind>()),
  },
);

const journalEntryRestartShape: Shape<JournalEntryRestart> =
  object<JournalEntryRestart>({
    reason: always(string<JournalRestartReason>()),
  });

const journalEntryShape: Shape<JournalEntry> = object<JournalEntry>({
  version: pointer(integer({ unsigned: false, bits: 64 })),
  id: always(string<JournalEntryId>()),
  seq: always(integer({ unsigned: false, bits: 64 })),
  kind: always(string<JournalEntryKind>()),
  admittedAt: always(timestampShape),
  creator: omitEmpty(string()),
  client: omitEmpty(string<ComputerSessionClient>()),
  origin: pointer(journalEntryOriginShape),
  cell: pointer(computerCellShape),
  executionSettings: pointer(computerExecutionSettingsChangeShape),
  save: pointer(journalEntrySaveShape),
  rename: pointer(journalEntryRenameShape),
  sleep: pointer(journalEntrySleepShape),
  wake: pointer(journalEntryWakeShape),
  restart: pointer(journalEntryRestartShape),
});

/** Judges the reasons a wake, a sleep or a restart entry carries. */
function validateReasons(entry: JournalEntry): void {
  const { wake, sleep, restart } = entry;
  if (wake !== undefined) {
    prefixed("wake", () => {
      validateComputerSessionKind(wake.session);
    });
  }
  if (sleep !== undefined) {
    prefixed("sleep", () => {
      const reason = sleep.reason ?? "";
      if (reason !== "") validateJournalSleepReason(reason);
      if ((sleep.idleTimeout ?? "") !== "" && reason !== "idle") {
        throw new TypeError(
          `idleTimeout must be absent on a "${reason}" sleep`,
        );
      }
      if (sleep.forced === true && sleep.discardedUnsavedChanges === true) {
        throw new TypeError("a sleep cannot both discard and force");
      }
    });
  }
  if (entry.kind === "restart") {
    if (restart === undefined) {
      throw new TypeError("restart is required on a restart entry");
    }
    prefixed("restart", () => {
      validateJournalRestartReason(restart.reason);
    });
  }
}

/**
 * One page of a resource's journal, newest entry first. `totalCount` is
 * the number of entries other than genesis, read when the listing's first
 * page was, so the whole listing returns `totalCount` entries and then
 * genesis; entries admitted after the first page are not listed by its
 * continuation. `continue` is the position the next page starts from,
 * absent on the last page.
 */
export type ListJournalResponse = ListResponse<JournalEntry>;

const listJournalResponseShape: Shape<ListJournalResponse> =
  object<ListJournalResponse>({
    items: always(array(journalEntryShape)),
    totalCount: always(integer({ unsigned: false, bits: 64 })),
    snapshotCursor: omitEmpty(string()),
    continue: omitEmpty(string()),
  });

/**
 * Reads a journal entry the platform served, leniently. `document` is JSON
 * text or a value already parsed from JSON; a string is parsed once, as a
 * response is. A field, kind, token, or command member this SDK does not
 * name is carried as it arrived, and nothing is judged.
 */
export function decodeJournalEntry(document: unknown): JournalEntry {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, journalEntryShape, "lenient");
}

/** Renders a journal entry as the document the platform emits. */
export function encodeJournalEntry(entry: JournalEntry): JsonObject {
  return journalEntryShape.encode(entry) as JsonObject;
}

/**
 * Reads a journal page the platform served, leniently, as
 * {@link decodeJournalEntry} reads each entry.
 */
export function decodeJournalPage(document: unknown): ListJournalResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, listJournalResponseShape, "lenient");
}

/**
 * Renders a journal page as the document the platform emits: `items` and
 * `totalCount` always, `continue` only on a page that is not the last.
 */
export function encodeJournalPage(page: ListJournalResponse): JsonObject {
  return listJournalResponseShape.encode(page) as JsonObject;
}

/**
 * Judges the entry against this SDK's contract: a canonical ID, a kind this
 * SDK names, an admission time, and the shape the kind gives it. Genesis has
 * sequence number zero and carries no Cell, execution settings, save, or
 * rename. Every other entry has a positive sequence number. A Cell entry has
 * a valid Cell whose ID is the entry's; an execution-settings entry has
 * valid execution settings; a restore entry may carry valid execution
 * settings; a save entry has a valid save; a rename entry has a valid rename
 * and owns no version; a sleep entry may carry a valid sleep detail; a wake
 * entry may carry a valid wake detail; a restart entry has a valid restart
 * detail and owns no version; no entry carries one its kind does not. A
 * copied Cell has no live session and is not running. Historical origin
 * sessions are permitted only on Cell
 * entries. Throws a `TypeError`.
 */
export function validateJournalEntry(entry: JournalEntry): void {
  parseJournalEntryId(entry.id);
  validateJournalEntryKind(entry.kind);
  if (isZeroInstant(entry.admittedAt)) {
    throw new TypeError("admittedAt is required");
  }
  if (entry.version !== undefined && entry.version < 0)
    throw new TypeError("version must be non-negative");
  validateStatedClient(entry.client);
  const origin = entry.origin;
  if (origin !== undefined) {
    prefixed("origin", () => {
      validateJournalEntryOrigin(origin);
    });
    if (entry.kind !== "cell" && (origin.session ?? "") !== "")
      throw new TypeError("origin.session must be absent on a non-cell entry");
  }
  if (entry.sleep !== undefined && entry.kind !== "sleep")
    throw new TypeError(`sleep must be absent on a ${entry.kind} entry`);
  if (entry.wake !== undefined && entry.kind !== "wake")
    throw new TypeError(`wake must be absent on a ${entry.kind} entry`);
  if (entry.restart !== undefined && entry.kind !== "restart")
    throw new TypeError(`restart must be absent on a ${entry.kind} entry`);
  if (entry.kind === "genesis") {
    if (!integerEqual(entry.seq, 0)) {
      throw new TypeError("genesis must have seq 0");
    }
    if (
      entry.cell !== undefined ||
      entry.executionSettings !== undefined ||
      entry.save !== undefined ||
      entry.rename !== undefined
    ) {
      throw new TypeError(
        "genesis must have no cell, executionSettings, save, or rename",
      );
    }
    return;
  }
  if (entry.rename !== undefined && entry.kind !== "rename") {
    throw new TypeError(`rename must be absent on a ${entry.kind} entry`);
  }
  if (entry.seq < 1) {
    throw new TypeError(`a ${entry.kind} entry must have a positive seq`);
  }
  switch (entry.kind) {
    case "cell":
      validateCellEntry(entry);
      return;
    case "execution-settings": {
      if (entry.version !== undefined)
        throw new TypeError("execution-settings entries own no version");
      const executionSettings = entry.executionSettings;
      if (executionSettings === undefined) {
        throw new TypeError(
          "executionSettings is required on an execution-settings entry",
        );
      }
      if (entry.cell !== undefined) {
        throw new TypeError(
          "cell must be absent on an execution-settings entry",
        );
      }
      if (entry.save !== undefined) {
        throw new TypeError(
          "save must be absent on an execution-settings entry",
        );
      }
      prefixed("executionSettings", () => {
        validateComputerExecutionSettingsChange(executionSettings);
      });
      return;
    }
    case "save": {
      if (entry.cell !== undefined || entry.executionSettings !== undefined) {
        throw new TypeError(
          "cell and executionSettings must be absent on a save entry",
        );
      }
      const save = entry.save;
      if (save === undefined) {
        throw new TypeError("save is required on a save entry");
      }
      prefixed("save", () => {
        validateJournalEntrySave(save);
      });
      return;
    }
    case "restore": {
      if (entry.cell !== undefined || entry.save !== undefined) {
        throw new TypeError("cell and save must be absent on a restore entry");
      }
      const executionSettings = entry.executionSettings;
      if (executionSettings !== undefined) {
        prefixed("executionSettings", () => {
          validateComputerExecutionSettingsChange(executionSettings);
        });
      }
      return;
    }
    case "rename": {
      if (entry.version !== undefined)
        throw new TypeError("rename entries own no version");
      if (
        entry.cell !== undefined ||
        entry.executionSettings !== undefined ||
        entry.save !== undefined
      ) {
        throw new TypeError(
          "cell, executionSettings, and save must be absent on a rename entry",
        );
      }
      const rename = entry.rename;
      if (rename === undefined) {
        throw new TypeError("rename is required on a rename entry");
      }
      prefixed("rename", () => {
        validateJournalEntryRename(rename);
      });
      return;
    }
    case "wake":
    case "sleep":
    case "restart":
      if (entry.version !== undefined)
        throw new TypeError(`${entry.kind} entries own no version`);
      if (
        entry.cell !== undefined ||
        entry.executionSettings !== undefined ||
        entry.save !== undefined
      ) {
        throw new TypeError(
          `cell, executionSettings, and save must be absent on a ${entry.kind} entry`,
        );
      }
      validateReasons(entry);
      return;
    default:
      if (
        entry.cell !== undefined ||
        entry.executionSettings !== undefined ||
        entry.save !== undefined
      ) {
        throw new TypeError(
          "cell, executionSettings, and save must be absent on a version entry",
        );
      }
  }
}

/**
 * Judges a Cell entry: it owns no version and carries a valid Cell whose ID
 * is the entry's, a copy carrying no live session.
 */
function validateCellEntry(entry: JournalEntry): void {
  if (entry.version !== undefined)
    throw new TypeError("a cell owns no version");
  if (entry.executionSettings !== undefined) {
    throw new TypeError("executionSettings must be absent on a cell entry");
  }
  if (entry.save !== undefined) {
    throw new TypeError("save must be absent on a cell entry");
  }
  const cell = entry.cell;
  if (cell === undefined) {
    throw new TypeError("cell is required on a cell entry");
  }
  if (cell.id !== entry.id) {
    throw new TypeError("cell.id does not match the entry id");
  }
  prefixed("cell", () => {
    validateComputerCell(cell);
  });
  if (entry.origin !== undefined) {
    if ((cell.session ?? "") !== "")
      throw new TypeError("cell.session must be absent on a copied entry");
    if (cell.state === "running")
      throw new TypeError("a copied cell must not be running");
  }
}

/**
 * Reads a resource's journal a page at a time, newest entry first, ending
 * with genesis. The journal list takes these options rather than
 * `ListOptions`: it pages by an opaque position, never by offset, and
 * refuses offset, filter, and sort with {@link ERROR_CODE_INVALID_QUERY}.
 */
export type JournalListOptions = PageOptions;

/**
 * Judges that the options state a listing the route serves: a `limit` that
 * is a non-negative integer within {@link MAX_JOURNAL_PAGE_SIZE}. Throws a
 * `TypeError`.
 */
export function validateJournalListOptions(options: JournalListOptions): void {
  const limit = options.limit ?? 0;
  if (!isUint64(limit) || limit < 0) {
    throw new TypeError("limit must be a non-negative integer");
  }
  if (limit > MAX_JOURNAL_PAGE_SIZE) {
    throw new TypeError(
      `limit must be at most ${String(MAX_JOURNAL_PAGE_SIZE)}`,
    );
  }
}

/**
 * Returned with HTTP 400 when a request states a query parameter its route
 * does not serve, such as offset, filter, or sort on the journal list, or a
 * value it cannot read.
 */
export const ERROR_CODE_INVALID_QUERY = "INVALID_QUERY";

/**
 * Returned with HTTP 400 when a continue position was not issued by the
 * listing it is passed to: malformed, or issued for another resource. The
 * listing starts again without it.
 */
export const ERROR_CODE_INVALID_CONTINUE = "INVALID_CONTINUE";
