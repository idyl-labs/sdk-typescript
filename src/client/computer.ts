// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type {
  ComputerSleep,
  ComputerWake,
} from "../api/computer-operations.js";
import type { ComputerSize } from "../api/billing.js";
import type { Computer as ComputerRecord } from "../api/computer.js";
import type { ListComputerSizesResponse } from "../api/computer-size.js";
import { isSaveSizeReason } from "../api/storage.js";
import { formatCpu } from "../resource/cpu.js";
import { formatMemory } from "../resource/memory.js";
import { evaluateComputerWait } from "../api/wait.js";
import { ApiError, TransportError } from "../errors.js";
import type { PlacementContext } from "../internal/context.js";
import type { AccountId } from "../resource/id.js";
import { formatDuration } from "../resource/duration.js";
import { DEFAULT_IDLE_TIMEOUT } from "../resource/idle-timeout.js";
import { formatVolume } from "../resource/volume.js";
import {
  isJournalEntryId,
  isResourceId,
  parseJournalEntryId,
  type JournalEntryId,
} from "../resource/uuid-id.js";
import { imageCatalogQuery } from "../internal/listquery.js";
import { computersService } from "../services/computers.js";
import type { ComputersService } from "../services/computers.js";
import {
  normalizeWaitOptions,
  pollUntil,
  waitForDeletion,
  type WaitOptions,
} from "../wait.js";
import {
  clientOf,
  pageOf,
  pageRequest,
  requireLimit,
  signalOf,
  walk,
  type CallOptions,
  type ListOptions,
  type Page,
  type PageOptions,
} from "./common.js";
import {
  awakeOf,
  historyEntryOf,
  numberOf,
  openSessionOf,
  optionalNumber,
  settingsOf,
  spelled,
  versionOf,
  type Awake,
  type ExecutionSettings,
  type HistoryEntry,
  type OpenSession,
  type Version,
} from "./records.js";
import { files, type Files } from "./files.js";
import { notebooks, type Notebooks } from "./notebooks.js";
import {
  computerSecretUseOf,
  secretAttachmentStatusOf,
  type ComputerSecretUse,
  type SecretAttachmentStatus,
} from "./secrets.js";
import { settingsRequest, updateRequest } from "./settings.js";
import { computerConnector } from "../computer-connection/connector.js";
import { connections, type Connections } from "./connections.js";
import { openTerminal, type TerminalOptions } from "./terminal.js";
import {
  commandOf,
  runCommand,
  type ExecOptions,
  type ExecResult,
} from "./exec.js";
import type {
  ComputerConnector,
  ComputerSessionStream,
} from "../computer-connection/connector.js";
import type {
  PlacementMemory,
  WorkerPort,
} from "../computer-connection/connector.js";
import type { TrustKey } from "../computer-connection/trust.js";
import type { TrustFloor } from "../computer-connection/trust-floor.js";
import { computerEndpointApi } from "../services/computer-endpoint-sessions.js";
import type {
  ComputerSettingsOptions,
  UpdateComputerOptions,
} from "./settings.js";

/**
 * A Computer as it was when it was read: an immutable snapshot. Read the
 * Computer again for its current state.
 */
export interface ComputerInfo {
  /**
   * The stable identifier. A name changes when the Computer is renamed and
   * may be reused once freed; an ID never changes and is never reused.
   */
  readonly id: string;
  /**
   * The Computer's name, unique among the live Computers of its Namespace. A
   * rename changes it; the ID stays.
   */
  readonly name: string;
  /**
   * `active` in service, or `terminating` from the moment a delete is
   * accepted until IDYL finishes releasing it.
   */
  readonly phase: "active" | "terminating" | (string & Record<never, never>);
  /**
   * Whether anything executes for it: `dormant` (nothing runs and no
   * compute is held), `running`, or `waiting`.
   */
  readonly execution:
    "dormant" | "running" | "waiting" | (string & Record<never, never>);
  /** The newest saved version of its files; zero is the empty first version. */
  readonly version: number;
  /** The execution settings as stated. */
  readonly settings: ExecutionSettings;
  /**
   * The settings its next start uses: those stated, with every default
   * filled in. For display; absent when IDYL does not report them.
   */
  readonly effectiveSettings?: ExecutionSettings;
  /**
   * Whether it is still running on earlier settings, which it leaves once
   * the commands running on them end.
   */
  readonly settingsPending: boolean;
  /**
   * The shells its image held when it last started, as the image's
   * `/etc/shells` lists them, at most 16, for a terminal to offer. Absent
   * before it first starts. Its image may hold other shells at its next
   * start, so a shell listed here is offered, not promised.
   */
  readonly shells?: readonly ImageShell[];
  /**
   * The largest size it can run at when it was read: the largest size that
   * fits a machine ready to run it. A create or a change at a larger size is
   * refused with `COMPUTER_DOES_NOT_FIT`; every size up to it is accepted.
   * Absent while no machine is ready to run it, or when IDYL does not report
   * it.
   */
  readonly largestSize?: ComputerSize;
  /**
   * How long it keeps running after its last command or terminal ends:
   * whole seconds such as `300s`, or `never`.
   */
  readonly idleTimeout: string;
  /** Whether it saves its files on its own; `true` unless turned off. */
  readonly autoSave: boolean;
  /** How long writes must be quiet before an automatic save, such as `10s`, when stated. */
  readonly saveQuiet?: string;
  /** The longest time between saves while writes continue, such as `2m`, when stated. */
  readonly saveMaxInterval?: string;
  /**
   * How much its files use, in bytes, as IDYL reports it, and how many files,
   * folders and links its newest saved version holds, once a save has counted
   * them.
   */
  readonly usage?: {
    readonly logicalBytes: number;
    readonly storedBytes: number;
    readonly names?: number;
  };
  /** The Computer and saved version it was forked from. */
  readonly forkOf?: { readonly computerId?: string; readonly version: number };
  /**
   * The copy a fork makes: `copying`, then `done` or `failed`, with how
   * much of the `total` is `copied`. Absent when IDYL does not report it.
   */
  readonly fork?: {
    readonly state:
      "copying" | "done" | "failed" | (string & Record<never, never>);
    readonly copied: number;
    readonly total: number;
  };
  /** When it was created, as an RFC 3339 instant. */
  readonly createdAt: string;
  /** When it was last modified, as an RFC 3339 instant. */
  readonly updatedAt: string;
  /** When its delete was recorded; present only while terminating. */
  readonly terminatingAt?: string;
  /**
   * When it last woke or went to sleep, as an RFC 3339 instant: while it
   * runs, when it woke. A list reports it; it is absent from a read of one
   * Computer and for a Computer that has never run.
   */
  readonly lastUsedAt?: string;
  /**
   * Why it is awake and when it will sleep. A read of one Computer reports it
   * while it runs; it is absent from a list, so its absence there says
   * nothing about the Computer.
   */
  readonly awake?: Awake;
  /**
   * Whether it is on its way to sleep while it still runs: a sleep was asked
   * for, or its idle time has run out, and it may still be saving. A read of
   * one Computer and a list both report it; absent means it is not. A session
   * opened before an idle sleep is released clears it.
   */
  readonly goingToSleep?: boolean;
}

/** A shell a Computer's image holds. */
export interface ImageShell {
  /** The shell's file name, such as `zsh`; two shells may share one. */
  readonly name: string;
  /** Where the image holds it, such as `/usr/bin/zsh`; what a terminal names. */
  readonly path: string;
}

/** Creates a Computer. */
export interface CreateComputerOptions
  extends ComputerSettingsOptions, CallOptions {
  /**
   * 3 to 63 characters in IDYL's Computer name format, unique among the
   * Account's live Computers.
   */
  readonly name: string;
  /**
   * Makes a create safe to repeat: a repeat with the same key returns the
   * Computer the first created.
   */
  readonly idempotencyKey?: string;
  /**
   * The kind of client creating it, recorded with its first execution
   * settings in its history. `sdk` when absent.
   */
  readonly client?: "sdk" | "console" | "cli";
  /**
   * Makes a Computer that saves only `/workspace`: its system files outside
   * `/workspace`, such as installed packages, users and `/etc`, start from
   * its image at each wake. Absent or `false`, it saves its whole system.
   */
  readonly workspaceOnly?: boolean;
}

/** Forks a Computer. */
export interface ForkOptions extends CallOptions {
  /**
   * The fork's name: 3 to 63 characters in IDYL's Computer name format,
   * unique among the Account's live Computers.
   */
  readonly name: string;
  /**
   * The point to fork from: a history entry's ID, such as a version's
   * `entry` or a cell's `save.entry`, or a saved version's number or name.
   * A fork from a point copies that point and saves nothing. Left out, the
   * fork copies the Computer as it is now. Stating `undefined` is a
   * `TypeError`, so a cell with no save is never forked from somewhere
   * else.
   */
  readonly from?: string | number;
  /**
   * Whether IDYL saves the Computer before a fork with no `from`: `true`
   * saves an awake Computer first, whatever its save setting, and `false`
   * never saves it, so the fork holds its files as they were last saved.
   * Left out, the Computer's own save setting (`autoSave`) decides: an
   * awake Computer that saves automatically is saved first, and one that
   * saves only when asked is not. An asleep Computer has nothing unsaved and
   * is never saved. Stating it together with `from` is a `TypeError`.
   */
  readonly save?: boolean;
  /** Makes the fork safe to repeat, as a create's key does. */
  readonly idempotencyKey?: string;
  /**
   * Makes a fork that saves only `/workspace` and carries none of this
   * Computer's system files. Absent or `false`, the fork saves its whole
   * system, whatever this Computer saves.
   */
  readonly workspaceOnly?: boolean;
  /**
   * How long to wait for the fork, in milliseconds: for a save it waits on,
   * then for the copy; ten minutes when absent. A wait that runs out once
   * IDYL has accepted the fork rejects with a `TimeoutError`
   * `DOMException`, and the fork goes on. One that runs out while the fork
   * still waits on a save rejects with IDYL's last refusal, an `ApiError`
   * with status 409 and `retryAfterMs`, and nothing is created.
   */
  readonly timeoutMs?: number;
}

/** Deletes a Computer. */
export interface DeleteComputerOptions extends CallOptions {
  /**
   * Waits until the Computer is gone, not only until its delete is
   * accepted. `false` when absent.
   */
  readonly wait?: boolean;
  /**
   * How long to wait, in milliseconds, with `wait`; ten minutes when
   * absent. A wait that runs out rejects with a `TimeoutError`
   * `DOMException`; the delete goes on.
   */
  readonly timeoutMs?: number;
}

/** Saves a Computer's files. */
export interface SaveOptions extends CallOptions {
  /**
   * How long to wait for the outcome, in milliseconds; ten minutes when
   * absent. A wait that runs out rejects with a `TimeoutError`
   * `DOMException`; the save goes on.
   */
  readonly timeoutMs?: number;
  /** Makes the save safe to repeat: a repeat with the same key returns its outcome. */
  readonly idempotencyKey?: string;
  /**
   * The kind of client making the save, recorded with its entry in the
   * Computer's history. `sdk` when absent.
   */
  readonly client?: "sdk" | "console" | "cli";
}

/** A save's outcome. */
export interface SaveResult {
  /**
   * `saved` when the save published a version, or `unchanged` when the
   * files held nothing the last saved version lacks.
   */
  readonly state: "saved" | "unchanged" | (string & Record<never, never>);
  /**
   * The version the save published, or with `unchanged` the Computer's
   * newest saved version.
   */
  readonly version: number;
}

/** Wakes a Computer. */
export interface WakeOptions extends CallOptions {
  /**
   * How long to wait for the Computer to be awake, in milliseconds; ten
   * minutes when absent. A wait that runs out rejects with a `TimeoutError`
   * `DOMException`; the wake goes on.
   */
  readonly timeoutMs?: number;
  /** Makes the wake safe to repeat: a repeat with the same key returns its outcome. */
  readonly idempotencyKey?: string;
  /**
   * The kind of client making the wake, recorded with its entry in the
   * Computer's history. `sdk` when absent.
   */
  readonly client?: "sdk" | "console" | "cli";
  /**
   * Called when the wake starts waiting for a cause that can clear by itself,
   * with the code it fails with if the cause holds, such as
   * `ERROR_CODE_INSUFFICIENT_CAPACITY`, and with `undefined` when it stops
   * waiting. It is called only when that changes, as the wake is read. The wake
   * goes on trying whatever it does, and a callback that throws rejects the
   * wait; the wake itself goes on.
   */
  readonly onWaiting?: (waitingFor: string | undefined) => void;
}

/** A finished wake: the Computer is `awake`. */
export interface WakeResult {
  /** `awake`. */
  readonly state: "awake" | (string & Record<never, never>);
}

/** Puts a Computer to sleep. */
export interface SleepOptions extends CallOptions {
  /**
   * How long to wait for the Computer to be asleep, in milliseconds; ten
   * minutes when absent. A wait that runs out rejects with a `TimeoutError`
   * `DOMException`; the sleep goes on.
   */
  readonly timeoutMs?: number;
  /** Makes the sleep safe to repeat: a repeat with the same key returns its outcome. */
  readonly idempotencyKey?: string;
  /**
   * The kind of client making the sleep, recorded with its entry in the
   * Computer's history. `sdk` when absent.
   */
  readonly client?: "sdk" | "console" | "cli";
  /**
   * Puts the Computer to sleep without saving it: every change to its files
   * since its last saved version is lost, and the sleep saves no version.
   * Saved versions and history are untouched, and the Computer wakes later
   * at its last saved version. Asked while another sleep of the Computer is
   * waiting for a save that has not published, such as one that keeps
   * failing, it ends that wait. The sleep's history entry records the
   * discard. `false` or absent saves the files first.
   */
  readonly discardUnsavedChanges?: boolean;
  /**
   * Called when the sleep starts waiting at a storage limit that refused its
   * save, with that save's reason, such as
   * `SAVE_REASON_ACCOUNT_STORAGE_LIMIT`, and with `undefined` when it stops
   * waiting. It is called only when that changes, as the sleep is read. The
   * sleep goes on asking for a save whatever it does: deleting files, or a
   * sleep with `discardUnsavedChanges`, ends the wait. A callback that throws
   * rejects the wait; the sleep itself goes on.
   */
  readonly onWaiting?: (waitingFor: string | undefined) => void;
}

/** A finished sleep: the Computer is `asleep`. */
export interface SleepResult {
  /** `asleep`. */
  readonly state: "asleep" | (string & Record<never, never>);
  /**
   * The version the sleep's save recorded; absent when the Computer was
   * already asleep, or the sleep discarded unsaved changes, and nothing was
   * saved.
   */
  readonly version?: number;
}

/** Restores a saved version. */
export interface RestoreOptions extends CallOptions {
  /**
   * How long to wait for the restored files to be published, in
   * milliseconds; ten minutes when absent. A wait that runs out rejects
   * with a `TimeoutError` `DOMException`; the restore goes on.
   */
  readonly timeoutMs?: number;
  /** Makes the restore safe to repeat. */
  readonly idempotencyKey?: string;
  /**
   * The kind of client making the restore, recorded with its entry in the
   * Computer's history. `sdk` when absent.
   */
  readonly client?: "sdk" | "console" | "cli";
}

/** A published restore. */
export interface RestoreResult {
  /** `published`. */
  readonly state: "published" | (string & Record<never, never>);
  /** The version the restore published, which holds the restored files. */
  readonly version: number;
}

/** What a handle shares with the handles derived from it. */
export interface HandleState {
  /** The client's view, once its Account is known. */
  readonly context: (options?: CallOptions) => Promise<PlacementContext>;
  /** The Namespace the handle's Computer lives in. */
  readonly namespace: string;
  /** The connectors commands run on. */
  readonly connections: Connections;
}

interface Internals {
  readonly state: HandleState;
  readonly record: ComputerRecord;
  readonly snapshot: ComputerInfo;
}

const internals = new WeakMap<Computer, Internals>();

/** The interval between reads while a save, restore, fork, wake, sleep or delete settles. */
const SETTLE_POLL_MS = 500;

/** How long a fork whose copy reports no progress is read before it counts as copied. */
const FORK_GRACE_MS = 5_000;

/**
 * The wait of an operation that settles on the platform, judged before
 * anything is sent: a `timeoutMs` that is not a non-negative number is a
 * `TypeError` naming it.
 */
function settleOptions(
  options: CallOptions & { readonly timeoutMs?: number },
): WaitOptions {
  const wait: WaitOptions = {
    ...signalOf(options),
    pollIntervalMs: SETTLE_POLL_MS,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
  try {
    normalizeWaitOptions(wait);
  } catch (cause) {
    throw new TypeError(
      "timeoutMs must be a non-negative number of milliseconds",
      { cause },
    );
  }
  return wait;
}

/**
 * One Computer. A handle holds an immutable snapshot, read when the handle
 * was made, and addresses its Computer by its stable ID, so it keeps
 * reaching its Computer across a rename, and a name reused after a rename
 * or a delete never reaches another Computer. Its methods do the work:
 * `update`, `delete`, `save`, `wake`, `sleep`, `history`, `versions`,
 * `exec`, `terminal`, `restore` and `fork`. A {@link ComputerConnector},
 * addressed by its `id`, opens any other session, such as a live files listing.
 *
 * Get one from `idyl.computers`.
 *
 * @example
 * ```ts
 * const computer = await idyl.computers.get("research");
 *
 * await computer.files.upload("data.csv", "id,score\n1,0.9\n");
 * const { stdout } = await computer.exec("wc -l data.csv");
 *
 * const { version } = await computer.save();
 * const trial = await computer.fork({ name: "research-trial", from: version });
 * ```
 */
export class Computer {
  private constructor() {
    throw new TypeError("a Computer is obtained from idyl.computers");
  }

  /** The Computer as it was when this handle was made. */
  get snapshot(): ComputerInfo {
    return internalsOf(this).snapshot;
  }

  /** The Computer's stable identifier. */
  get id(): string {
    return internalsOf(this).snapshot.id;
  }

  /** The Computer's name. */
  get name(): string {
    return internalsOf(this).snapshot.name;
  }

  /**
   * The Computer's workspace as saved versions: `upload`, `download`,
   * `list`, `move` and `remove`.
   */
  get files(): Files {
    const { state, record } = internalsOf(this);
    return files(state, record.id);
  }

  /** The Computer's notebooks: recorded sequences of commands. */
  get notebooks(): Notebooks {
    const { state, record } = internalsOf(this);
    return notebooks(state, record.id);
  }

  /**
   * Updates the Computer field by field and returns a handle with its
   * updated snapshot. Execution settings take effect from its next start,
   * without disturbing commands already running; `settingsPending` reports
   * the wait. A rename, the idle timeout and the save settings take effect
   * at once; this handle keeps its earlier snapshot, and sessions already
   * running are unaffected by a rename.
   *
   * @throws {@link TypeError} the update states nothing or a field is
   * invalid, naming the field, before any request is sent
   * @throws {@link ApiError} IDYL refuses the update, such as for a name
   * another Computer holds or a size the plan does not include
   * @throws {@link TransportError} the request does not complete, or the
   * answer names another Account or Namespace
   */
  async update(options: UpdateComputerOptions): Promise<Computer> {
    const { state, record } = internalsOf(this);
    const request = updateRequest(options);
    const service = await serviceOf(state, options);
    const { computer } = await service.updateById(
      record.id,
      request,
      signalOf(options),
    );
    return await handleOf(state, computer, options);
  }

  /**
   * Deletes the Computer: its files, history and notebooks are released.
   * The delete is accepted at once and completes on its own; `wait` waits
   * until the Computer is gone.
   *
   * @throws {@link TypeError} `timeoutMs` is not a non-negative number,
   * before any request is sent
   * @throws {@link ApiError} IDYL refuses the delete
   * @throws {@link TransportError} a request does not complete
   * @throws DOMException a `TimeoutError`: with `wait`, the Computer is
   * not gone within `timeoutMs`; the delete goes on
   */
  async delete(options: DeleteComputerOptions = {}): Promise<void> {
    const { state, record } = internalsOf(this);
    const wait = settleOptions(options);
    const service = await serviceOf(state, options);
    await service.deleteById(record.id, signalOf(options));
    if (options.wait !== true) return;
    await waitForDeletion(wait, {
      kind: "Computer",
      name: record.name,
      read: async (signal) =>
        (await service.getById(record.id, { signal })).computer,
      evaluate: (computer) => evaluateComputerWait(computer, "deleted"),
    });
  }

  /**
   * Saves the Computer's files and waits for the outcome. A save that finds
   * nothing to save reports `unchanged` with the newest saved version. A
   * save refused for size leaves the Computer awake with its unsaved files;
   * freeing files, or a sleep that discards unsaved changes, lets it sleep.
   *
   * @throws {@link TypeError} `timeoutMs` is not a non-negative number,
   * before any request is sent
   * @throws {@link ApiError} IDYL refuses the save, or the save fails: status
   * 409 with the reason as `detail`, and for a save refused for size the
   * reason as `code` too, `SAVE_REASON_ACCOUNT_STORAGE_LIMIT`,
   * `SAVE_REASON_COMPUTER_SIZE` or `SAVE_REASON_NAME_LIMIT`
   * @throws {@link TransportError} a request does not complete
   * @throws DOMException a `TimeoutError`: the save does not finish
   * within `timeoutMs`; the save goes on
   */
  async save(options: SaveOptions = {}): Promise<SaveResult> {
    const { state, record } = internalsOf(this);
    const wait = settleOptions(options);
    const service = await serviceOf(state, options);
    const created = await service.createCommitById(
      record.id,
      {
        ...(options.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
        client: clientOf(options.client),
      },
      signalOf(options),
    );
    const settled =
      (await pollUntil(wait, {
        initial: created,
        read: async (signal) =>
          await service.getCommitById(record.id, created.id, { signal }),
        met: (commit) =>
          ["saved", "unchanged", "failed"].includes(commit.state),
        timeoutMessage: (ms) => `save did not finish within ${String(ms)} ms`,
      })) ?? created;
    if (settled.state === "failed" || settled.version === undefined) {
      throw outcomeRefused(
        "save",
        settled.state,
        settled.reason,
        isSaveSizeReason(settled.reason),
      );
    }
    return Object.freeze({
      state: settled.state,
      version: numberOf(settled.version),
    });
  }

  /**
   * Wakes the Computer: starts its execution with no command running, and
   * waits until it is awake. A Computer that is already awake is awake at
   * once. Either way it then stays awake for its idle timeout, counted from
   * the wake, and goes to sleep as it does after its last command. Commands
   * wake a Computer on their own; a wake starts it ahead of them.
   *
   * @throws {@link TypeError} `timeoutMs` is not a non-negative number,
   * before any request is sent
   * @throws {@link ApiError} IDYL refuses the wake, or the wake fails:
   * status 409 whose `code` and `detail` are the reason, the code that would
   * fail a command for the same cause, such as
   * `ERROR_CODE_INSUFFICIENT_CAPACITY` or `ERROR_CODE_WAKE_TIMEOUT`
   * @throws {@link TransportError} a request does not complete
   * @throws DOMException a `TimeoutError`: the Computer is not awake
   * within `timeoutMs`; the wake goes on
   */
  async wake(options: WakeOptions = {}): Promise<WakeResult> {
    const { state, record } = internalsOf(this);
    const wait = settleOptions(options);
    const service = await serviceOf(state, options);
    const created = await service.createWakeById(
      record.id,
      {
        ...(options.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
        client: clientOf(options.client),
      },
      signalOf(options),
    );
    let waitingFor: string | undefined;
    const observed = (wake: ComputerWake): ComputerWake => {
      if (wake.waitingFor !== waitingFor) {
        waitingFor = wake.waitingFor;
        options.onWaiting?.(waitingFor);
      }
      return wake;
    };
    const settled =
      (await pollUntil(wait, {
        initial: observed(created),
        read: async (signal) =>
          observed(
            await service.getWakeById(record.id, created.id, { signal }),
          ),
        met: (wake) => ["awake", "failed"].includes(wake.state),
        timeoutMessage: (ms) => `wake did not finish within ${String(ms)} ms`,
      })) ?? created;
    if (settled.state !== "awake") {
      throw outcomeRefused("wake", settled.state, settled.reason, true);
    }
    return Object.freeze({ state: settled.state });
  }

  /**
   * Puts the Computer to sleep and waits until it is asleep. Its files are
   * saved first, as `save` does, unless `discardUnsavedChanges` asks to
   * discard the changes since its last saved version; then every command,
   * terminal and notebook cell still running is ended and its execution is
   * released, so background processes stop. A Computer that is already
   * asleep is asleep at once, with nothing saved. The next command wakes it
   * again.
   *
   * @throws {@link TypeError} `timeoutMs` is not a non-negative number,
   * before any request is sent
   * @throws {@link ApiError} IDYL refuses the sleep, or the sleep fails:
   * status 409 whose `code` and `detail` are the reason,
   * `ERROR_CODE_SAVE_FAILED` when the save failed and nothing was ended, or
   * `ERROR_CODE_SLEEP_TIMEOUT` when the Computer could not be released in
   * time and goes to sleep after its idle timeout instead
   * @throws {@link TransportError} a request does not complete
   * @throws DOMException a `TimeoutError`: the Computer is not asleep
   * within `timeoutMs`; the sleep goes on
   */
  async sleep(options: SleepOptions = {}): Promise<SleepResult> {
    const { state, record } = internalsOf(this);
    const wait = settleOptions(options);
    const service = await serviceOf(state, options);
    const created = await service.createSleepById(
      record.id,
      {
        ...(options.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
        client: clientOf(options.client),
        ...(options.discardUnsavedChanges === true
          ? { discardUnsavedChanges: true }
          : {}),
      },
      signalOf(options),
    );
    let waitingFor: string | undefined;
    const observed = (sleep: ComputerSleep): ComputerSleep => {
      if (sleep.waitingFor !== waitingFor) {
        waitingFor = sleep.waitingFor;
        options.onWaiting?.(waitingFor);
      }
      return sleep;
    };
    const settled =
      (await pollUntil(wait, {
        initial: observed(created),
        read: async (signal) =>
          observed(
            await service.getSleepById(record.id, created.id, { signal }),
          ),
        met: (sleep) => ["asleep", "failed"].includes(sleep.state),
        timeoutMessage: (ms) => `sleep did not finish within ${String(ms)} ms`,
      })) ?? created;
    if (settled.state !== "asleep") {
      throw outcomeRefused("sleep", settled.state, settled.reason, true);
    }
    const version = optionalNumber(settled.version);
    return Object.freeze({
      state: settled.state,
      ...(version === undefined ? {} : { version }),
    });
  }

  /**
   * The Computer's history, newest entry first, page by page. Anyone who
   * may read the Computer may read its whole history.
   *
   * @throws {@link TypeError} `limit` is not a positive integer, before any
   * request is sent
   * @throws {@link ApiError} IDYL refuses a page's request
   * @throws {@link TransportError} a page's request does not complete
   */
  history(options: ListOptions = {}): AsyncIterable<HistoryEntry> {
    return walk((page) => this.historyPage(page), options);
  }

  /**
   * One page of the Computer's history, newest entry first.
   *
   * @throws {@link TypeError} `limit` is not a positive integer
   * @throws {@link ApiError} IDYL refuses the request, such as a `continue`
   * this listing did not issue
   * @throws {@link TransportError} the request does not complete
   */
  async historyPage(options: PageOptions = {}): Promise<Page<HistoryEntry>> {
    const { state, record } = internalsOf(this);
    const service = await serviceOf(state, options);
    const page = await service.listJournalById(
      record.id,
      pageRequest(options),
      signalOf(options),
    );
    return pageOf(page.items.map(historyEntryOf), page.continue);
  }

  /**
   * The Computer's open sessions, oldest first, as anyone who may read the
   * Computer sees them: kind, client, who and when, never content. A Computer
   * that is asleep has none.
   *
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  async sessions(options: CallOptions = {}): Promise<readonly OpenSession[]> {
    const { state, record } = internalsOf(this);
    const service = await serviceOf(state, options);
    const { items } = await service.listSessionsById(
      record.id,
      signalOf(options),
    );
    return Object.freeze(items.map(openSessionOf));
  }

  /**
   * The state of each of the Computer's Secret attachments, in the order of
   * its settings in force: whether the attached Secret's value can be sent,
   * judged against the version the attachment uses, and when it cannot,
   * why. It is read when asked for, from IDYL, and never wakes the
   * Computer. Anyone who may read the Computer may read it.
   *
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  async secrets(
    options: CallOptions = {},
  ): Promise<readonly SecretAttachmentStatus[]> {
    const { state, record } = internalsOf(this);
    const service = await serviceOf(state, options);
    const { items } = await service.listSecretsById(
      record.id,
      signalOf(options),
    );
    return Object.freeze(items.map(secretAttachmentStatusOf));
  }

  /**
   * The Computer's saved versions, newest first, page by page.
   *
   * @throws {@link TypeError} `limit` is not a positive integer, before any
   * request is sent
   * @throws {@link ApiError} IDYL refuses a page's request
   * @throws {@link TransportError} a page's request does not complete
   */
  versions(options: ListOptions = {}): AsyncIterable<Version> {
    return walk((page) => this.versionsPage(page), options);
  }

  /**
   * One page of the Computer's saved versions, newest first.
   *
   * @throws {@link TypeError} `limit` is not a positive integer
   * @throws {@link ApiError} IDYL refuses the request, such as a `continue`
   * this listing did not issue
   * @throws {@link TransportError} the request does not complete
   */
  async versionsPage(options: PageOptions = {}): Promise<Page<Version>> {
    const { state, record } = internalsOf(this);
    const service = await serviceOf(state, options);
    const page = await service.listVersionsById(
      record.id,
      pageRequest(options),
      signalOf(options),
    );
    return pageOf(page.items.map(versionOf), page.continue);
  }

  /**
   * One saved version, by number or by name.
   *
   * @param version the version's number, a non-negative integer, or the
   * name it was given with `nameVersion`
   * @throws {@link TypeError} `version` is neither a non-negative integer
   * nor a non-empty name, before any request is sent
   * @throws {@link ApiError} IDYL refuses the request, such as for a version
   * the Computer does not have
   * @throws {@link TransportError} the request does not complete
   */
  async version(
    version: number | string,
    options: CallOptions = {},
  ): Promise<Version> {
    const selector = versionSelector(version);
    const { state, record } = internalsOf(this);
    const service = await serviceOf(state, options);
    return versionOf(
      await service.getVersionById(record.id, selector, signalOf(options)),
    );
  }

  /**
   * Reads the Computer again and returns a handle with its current
   * snapshot. This handle's `snapshot` stays as it was.
   *
   * @throws {@link ApiError} IDYL refuses the read, such as for a Computer
   * that is gone (status 404)
   * @throws {@link TransportError} the request does not complete
   */
  async refresh(options: CallOptions = {}): Promise<Computer> {
    const { state, record } = internalsOf(this);
    const service = await serviceOf(state, options);
    const { computer } = await service.getById(record.id, signalOf(options));
    return await handleOf(state, computer, options);
  }

  /**
   * Opens a terminal: a shell in the Computer, its output on `output`, its
   * input through `write`. A Computer that is asleep wakes. It runs until its
   * shell exits or it is closed, and it holds the client's connection open
   * until then, so a program closes it, or reads it to its end, before it can
   * exit. A browser page first builds its connector with
   * `idyl.computers.connector`.
   *
   * @throws {@link TypeError} the client has no connector to run it on: a
   * browser page that has not built one with `idyl.computers.connector`,
   * or a client with no network or trust keys
   * @throws {@link ApiError} IDYL refuses the session, such as
   * `ERROR_CODE_INSUFFICIENT_CAPACITY` or `ERROR_CODE_SESSION_BUDGET_EXCEEDED`
   * @throws {@link ComputerSessionEndedError} the session ended before it
   * ran, such as when the Computer was put to sleep
   * @throws {@link SessionTrustError} the network's session trust is refused
   * @throws {@link TransportError} a request does not complete
   */
  async terminal(
    options: TerminalOptions = {},
  ): Promise<ComputerSessionStream> {
    const { state, record } = internalsOf(this);
    return await openTerminal(
      await state.connections.hold(),
      record.id,
      options,
    );
  }

  /**
   * Runs a command in the Computer and returns once it has ended and its
   * changes are saved, so a read of the files after it sees what it wrote. A
   * Computer that is asleep wakes. A string runs through `/bin/sh -c`, so its
   * pipes, quotes and variables work; a list runs its program as given. It
   * starts in `/workspace`.
   *
   * Each stream keeps at most 16 MiB. For more, or for output as it arrives,
   * open a session on a {@link ComputerConnector}.
   *
   * A browser page first builds its connector with `idyl.computers.connector`.
   * Any other program needs nothing more: the client connects on the first
   * command and closes the connection a moment after the last.
   *
   * @param command a shell command line, run through `/bin/sh -c`, or a
   * program and its arguments, run as given
   * @throws {@link ExitError} the command exits other than with 0; it
   * carries the exit code and the output
   * @throws {@link CommandSaveError} the command ended but its changes could
   * not be saved; it carries the output
   * @throws {@link CommandSessionError} the session failed before the
   * command's end was known, or a stream passed 16 MiB; it carries the
   * output so far
   * @throws {@link TypeError} `command` is empty, or the client has no
   * connector to run it on: a
   * browser page that has not built one with `idyl.computers.connector`,
   * or a client with no network or trust keys
   * @throws {@link ApiError} IDYL refuses the session, such as
   * `ERROR_CODE_INSUFFICIENT_CAPACITY` or `ERROR_CODE_SESSION_BUDGET_EXCEEDED`
   * @throws {@link ComputerSessionEndedError} the session ended before it
   * ran, such as when the Computer was put to sleep
   * @throws {@link SessionTrustError} the network's session trust is refused
   * @throws {@link TransportError} a request does not complete
   */
  async exec(
    command: string | readonly string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const argv = commandOf(command);
    const { state, record } = internalsOf(this);
    const service = await serviceOf(state, options);
    return await state.connections.use((connector) =>
      runCommand(
        connector,
        record.id,
        { mode: "exec", command: argv },
        (session, signal) =>
          service.getSessionById(
            record.id,
            session,
            signal === undefined ? {} : { signal },
          ),
        options.signal,
      ),
    );
  }

  /**
   * Names a saved version, so `restore` can select it by name; an empty
   * name removes the name.
   *
   * @param version the version's number
   * @param name the name to give it, or `""` to remove its name
   * @throws {@link TypeError} `version` is not a non-negative integer, or
   * `name` is not a string, before any request is sent
   * @throws {@link ApiError} IDYL refuses the request, such as for a version
   * the Computer does not have
   * @throws {@link TransportError} the request does not complete
   */
  async nameVersion(
    version: number,
    name: string,
    options: CallOptions = {},
  ): Promise<Version> {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new TypeError("version must be a non-negative integer");
    }
    if (typeof name !== "string") throw new TypeError("name must be a string");
    const { state, record } = internalsOf(this);
    const service = await serviceOf(state, options);
    return versionOf(
      await service.updateVersionById(
        record.id,
        version,
        { name },
        signalOf(options),
      ),
    );
  }

  /**
   * Restores the files and execution settings of a saved version, by
   * number or by name, and waits until the restored files are published as
   * a further version. History only moves forward: the restore is an entry
   * of its own and every earlier one is kept. The settings apply at the
   * next start; commands already running continue, and the next session
   * sees the restored files.
   *
   * @param version the number of the version to restore, or its name
   * @throws {@link TypeError} `version` is neither a non-negative integer
   * nor a non-empty name, or `timeoutMs` is invalid, before any request is
   * sent
   * @throws {@link ApiError} IDYL refuses the restore, or the restore fails:
   * status 409 whose `detail` says why
   * @throws {@link TransportError} a request does not complete
   * @throws DOMException a `TimeoutError`: the restored files are not
   * published within `timeoutMs`; the restore goes on
   */
  async restore(
    version: number | string,
    options: RestoreOptions = {},
  ): Promise<RestoreResult> {
    const from = versionSelector(version);
    const { state, record } = internalsOf(this);
    const wait = settleOptions(options);
    const service = await serviceOf(state, options);
    const created = await service.createRestoreById(
      record.id,
      {
        from,
        ...(options.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
        client: clientOf(options.client),
      },
      signalOf(options),
    );
    const settled =
      (await pollUntil(wait, {
        initial: created,
        read: async (signal) =>
          await service.getRestoreById(record.id, created.id, { signal }),
        met: (restore) => ["published", "failed"].includes(restore.state),
        timeoutMessage: (ms) =>
          `restore did not finish within ${String(ms)} ms`,
      })) ?? created;
    const published = optionalNumber(settled.version);
    if (settled.state !== "published" || published === undefined) {
      throw outcomeRefused("restore", settled.state, settled.reason);
    }
    return Object.freeze({ state: settled.state, version: published });
  }

  /**
   * Creates a Computer as a fork of this one and waits until its copy has
   * finished. The fork has a history of its own; this Computer keeps its
   * unsaved files whatever the fork states. Check `snapshot.fork?.state` on
   * the returned handle: `failed` means the copy did not complete.
   *
   * A fork from a point (`from`) copies that point's files and settings and
   * saves nothing.
   *
   * A fork with no `from` copies the Computer as it is now: the newest entry
   * of its history, chosen by IDYL as it creates the fork, so a settings
   * change made after the last save is in the fork. An awake Computer that
   * saves automatically is saved first, and the fork holds its files as
   * that save finds them; files written after the save are not in it. An
   * awake Computer that saves only when asked is not saved, so the fork
   * holds its files as they were last saved. `save` states otherwise:
   * `true` saves an awake Computer first, `false` never saves it. The save
   * is recorded in this Computer's history like any other. A fork needs
   * read permission on this Computer; `save: true` on a Computer that saves
   * only when asked needs the permission a save needs.
   *
   * A fork whose save, or the save of the cell it names, has not settled is
   * refused by IDYL with status 409 and `retryAfterMs`, and nothing is
   * created; the fork asks again after that delay, for the same save, until
   * `timeoutMs` runs out.
   *
   * @throws {@link TypeError} `name` is empty, `from` is stated as
   * `undefined` (as for a cell whose save is off, pending or failed), `save`
   * is not a boolean or is stated with `from`, or `timeoutMs` is invalid
   * @throws {@link ApiError} IDYL refuses the fork, such as for a name
   * another Computer holds, a version the Computer does not have, or
   * `save: true` from a caller that may only read the Computer (status
   * 403). A save that fails refuses the fork with
   * `ERROR_CODE_FORK_NOT_QUIESCENT`, whose reason `forkNotQuiescent` reads;
   * the fork asked again with `save: false` copies the newest entry without
   * saving. A save still unsettled when `timeoutMs` runs out leaves the
   * last refusal, status 409 with `retryAfterMs`
   * @throws {@link TransportError} a request does not complete, or the
   * answer names another Account or Namespace
   * @throws DOMException a `TimeoutError`: the copy does not finish
   * within `timeoutMs`; the fork goes on
   */
  async fork(options: ForkOptions): Promise<Computer> {
    const { name, idempotencyKey, workspaceOnly } = options;
    const stated = options as {
      readonly from?: unknown;
      readonly save?: unknown;
    };
    const from = stated.from;
    if ("from" in options && (from === undefined || from === "")) {
      throw new TypeError(
        "from names no history entry or version; leave it out to fork the Computer as it is now",
      );
    }
    const save = stated.save;
    if (save !== undefined && typeof save !== "boolean") {
      throw new TypeError("save must be a boolean");
    }
    if (save !== undefined && from !== undefined) {
      throw new TypeError("save is stated only on a fork with no from");
    }
    const forkName = requireName(name);
    const wait = settleOptions(options);
    const { state, record } = internalsOf(this);
    const service = await serviceOf(state, options);
    const entry =
      options.from === undefined
        ? undefined
        : await forkPoint(service, record.id, options.from, options);
    const request = {
      name: forkName,
      forkOf: {
        source: { computer: record.id },
        ...(entry === undefined ? {} : { entry }),
        ...(save === undefined ? {} : { save }),
      },
      ...(workspaceOnly === undefined ? {} : { workspaceOnly }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };
    // One wait covers the whole fork. Until IDYL accepts the create, each
    // read asks for it again, after the delay a refusal for an unsettled
    // save asked for; the create runs under the caller's signal alone, so
    // running out of time never leaves a create in doubt. Once accepted,
    // the copy is finished when it reports `done` or `failed`, and a
    // Computer that reports no copy at all is read for a short while, in
    // case the copy appears late, and then taken as copied.
    let created: ComputerRecord | undefined;
    let refusal: ApiError | undefined;
    let unreported = 0;
    let settled: ComputerRecord | ApiError | undefined;
    try {
      settled = await pollUntil<ComputerRecord | ApiError>(wait, {
        read: async (signal) => {
          if (created !== undefined) {
            return (await service.getById(created.id, { signal })).computer;
          }
          try {
            created = (await service.create(request, signalOf(options)))
              .computer;
          } catch (error) {
            if (!awaitsSave(error)) throw error;
            refusal = error;
            return error;
          }
          unreported = Date.now() + FORK_GRACE_MS;
          return created;
        },
        met: (current) => {
          if (current instanceof ApiError) return false;
          const copy = current.status?.fork?.state;
          return copy === undefined
            ? Date.now() >= unreported
            : copy === "done" || copy === "failed";
        },
        delay: () =>
          created === undefined
            ? Math.max(refusal?.retryAfterMs ?? 0, SETTLE_POLL_MS)
            : SETTLE_POLL_MS,
        timeoutMessage: (ms) => `fork did not finish within ${String(ms)} ms`,
      });
    } catch (error) {
      if (
        created === undefined &&
        refusal !== undefined &&
        isTimeout(error) &&
        options.signal?.aborted !== true
      ) {
        throw refusal;
      }
      throw error;
    }
    // `met` holds only for a created Computer, and `read` never reports one
    // gone, so the wait ends on the created Computer.
    if (settled === undefined || settled instanceof ApiError) {
      throw new TransportError("invalid_response", "fork was not created");
    }
    return await handleOf(state, settled, options);
  }
}

/**
 * Whether `error` is IDYL's refusal of a fork whose save has not settled:
 * status 409 with a `Retry-After`. Nothing was created, and the same
 * request asked again waits for the same save.
 */
function awaitsSave(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.retryAfterMs !== undefined
  );
}

/** Whether `error` is the `TimeoutError` an exhausted wait throws. */
function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/** The history entry named by `from` in the Computer `id`. */
async function forkPoint(
  service: ComputersService,
  id: string,
  from: string | number,
  options: CallOptions,
): Promise<JournalEntryId> {
  if (typeof from === "string" && isJournalEntryId(from)) {
    return parseJournalEntryId(from);
  }
  const version = await service.getVersionById(
    id,
    versionSelector(from),
    signalOf(options),
  );
  if (version.entry === undefined) {
    throw new TypeError("the Computer has no saved version to fork from");
  }
  return parseJournalEntryId(version.entry);
}

/** The handle state of `computer`; it is how the other client modules reach it. */
export function handleStateOf(computer: Computer): {
  readonly state: HandleState;
  readonly id: string;
} {
  const { state, record } = internalsOf(computer);
  return { state, id: record.id };
}

/** The Computers service of the handle's Namespace. */
export async function serviceOf(
  state: HandleState,
  options: CallOptions | undefined,
): Promise<ComputersService> {
  const context = await state.context(signalOf(options));
  return computersService(context, context.scope.accountId, state.namespace);
}

/**
 * A handle for `record`, judged against the client's Account: a served
 * Computer of another Account, or of another Namespace, is never handed
 * back.
 */
export async function handleOf(
  state: HandleState,
  record: ComputerRecord,
  options: CallOptions | undefined,
): Promise<Computer> {
  const context = await state.context(signalOf(options));
  return handleFor(state, record, context.scope.accountId);
}

/** A handle for `record`, judged against `accountId` and the Namespace. */
export function handleFor(
  state: HandleState,
  record: ComputerRecord,
  accountId: AccountId,
): Computer {
  if (record.accountId !== accountId || record.namespace !== state.namespace) {
    throw new TransportError(
      "invalid_response",
      "computer response names a different account or namespace",
    );
  }
  const computer = Object.create(Computer.prototype) as Computer;
  internals.set(
    computer,
    Object.freeze({ state, record, snapshot: computerInfoOf(record) }),
  );
  return Object.freeze(computer);
}

function internalsOf(computer: Computer): Internals {
  const value = internals.get(computer);
  if (value === undefined) {
    throw new TypeError("receiver is not a Computer handle");
  }
  return value;
}

/** The public snapshot of a served Computer. */
export function computerInfoOf(record: ComputerRecord): ComputerInfo {
  const { spec, executionSettings, usage, forkOf, status } = record;
  const fork = status?.fork;
  return Object.freeze({
    id: record.id,
    name: record.name,
    phase: record.phase,
    execution: record.execution,
    version: numberOf(record.headVersion),
    settings: settingsOf(spec.execution),
    ...(executionSettings === undefined
      ? {}
      : { effectiveSettings: settingsOf(executionSettings.effective) }),
    settingsPending: executionSettings?.pending === true,
    ...(executionSettings?.shells === undefined
      ? {}
      : {
          shells: Object.freeze(
            executionSettings.shells.map(({ name, path }) =>
              Object.freeze({ name, path }),
            ),
          ),
        }),
    ...(executionSettings?.largestSize === undefined ||
    executionSettings.largestSize === ""
      ? {}
      : { largestSize: executionSettings.largestSize }),
    idleTimeout: spec.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
    autoSave: spec.autoSave !== false,
    ...optional("saveQuiet", spelled(spec.saveQuiet, formatDuration)),
    ...optional(
      "saveMaxInterval",
      spelled(spec.saveMaxInterval, formatDuration),
    ),
    ...(usage === undefined
      ? {}
      : {
          usage: Object.freeze({
            logicalBytes: numberOf(usage.logicalBytes),
            storedBytes: numberOf(usage.storedBytes),
            ...(usage.names === undefined
              ? {}
              : { names: numberOf(usage.names) }),
          }),
        }),
    ...(forkOf === undefined
      ? {}
      : {
          forkOf: Object.freeze({
            ...(forkOf.computer === undefined
              ? {}
              : { computerId: forkOf.computer }),
            version: numberOf(forkOf.version),
          }),
        }),
    ...(fork === undefined
      ? {}
      : {
          fork: Object.freeze({
            state: fork.state,
            copied: numberOf(fork.copied),
            total: numberOf(fork.total),
          }),
        }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.terminatingAt === undefined
      ? {}
      : { terminatingAt: record.terminatingAt }),
    ...(record.lastUsedAt === undefined
      ? {}
      : { lastUsedAt: record.lastUsedAt }),
    ...(record.goingToSleep === true ? { goingToSleep: true } : {}),
    ...(record.awake === undefined ? {} : { awake: awakeOf(record.awake) }),
  });
}

/** The image catalogue entry a Computer can start from. */
export interface ComputerImage {
  /** The name a create or update states, such as `ubuntu-24.04`. */
  readonly name: string;
  /** The name to show a person, such as `Ubuntu 24.04`. */
  readonly displayName: string;
  /** A sentence on what the image holds; absent when the catalogue states none. */
  readonly description?: string;
  /** The operating system the image runs: its name and its version. */
  readonly os: { readonly name: string; readonly version: string };
  /** Whether the image carries GPU support. */
  readonly gpu: boolean;
  /** Its current patch level. */
  readonly patch: string;
  /**
   * Whether a create in the image's isolation class that states no image
   * receives it.
   */
  readonly default: boolean;
  /**
   * The isolation class the image serves, `secure-container` or `vm`: only a
   * Computer in that class runs it.
   */
  readonly isolation:
    "secure-container" | "vm" | (string & Record<never, never>);
}

/** Which images `images` lists. */
export interface ImagesOptions extends CallOptions {
  /**
   * The isolation class whose images to list, `secure-container` or `vm`.
   * The list of a class not offered where the Account's Computers live is
   * empty, so a class is offered exactly when its list is not. When absent, the
   * `secure-container` images are listed.
   */
  readonly isolation?: "secure-container" | "vm";
}

/** One size a Computer can run at, as IDYL offers it. */
export interface ComputerSizeInfo {
  /** The name `create` and `update` state, such as `small`. */
  readonly name: ComputerSize;
  /** The name to show a person, such as `Small`. */
  readonly label: string;
  /** The CPU limit, such as `2`. */
  readonly cpu: string;
  /** The memory limit, such as `4Gi`. */
  readonly memory: string;
  /** The most a Computer of this size can store, such as `20Gi`. */
  readonly disk: string;
  /**
   * The most files, folders and links a Computer of this size holds, such
   * as `2000000`. A save or an upload that adds names past it fails with
   * `SAVE_REASON_NAME_LIMIT`. `undefined` when the size has no such limit.
   */
  readonly names?: number;
  /** Whether a Computer that states no size, CPU or memory runs at this size. */
  readonly default: boolean;
}

/**
 * The Computers of the client's Namespace: `idyl.computers`.
 *
 * @example
 * ```ts
 * const computer = await idyl.computers.create({
 *   name: "research",
 *   image: "ubuntu-24.04",
 * });
 *
 * const same = await idyl.computers.get("research");
 *
 * for await (const each of idyl.computers.list()) {
 *   console.log(each.name, each.snapshot.execution);
 * }
 * ```
 */
export interface Computers {
  /**
   * Creates a Computer and returns its handle. Every setting is optional;
   * one left out takes IDYL's default, the image the catalogue's default.
   *
   * @throws {@link TypeError} an option is invalid, naming the field, before
   * any request is sent
   * @throws {@link ApiError} IDYL refuses the create, such as for a name
   * another Computer holds, or with `ERROR_CODE_IMAGE_NOT_IN_CATALOG` or
   * `ERROR_CODE_SIZE_NOT_IN_PLAN`
   * @throws {@link TransportError} the request does not complete, or the
   * answer names another Account or Namespace
   */
  create(options: CreateComputerOptions): Promise<Computer>;
  /**
   * The Computer with this name.
   *
   * @param name the Computer's name
   * @throws {@link TypeError} `name` is empty, before any request is sent
   * @throws {@link ApiError} IDYL refuses the read, such as for a name the
   * Namespace does not hold (status 404)
   * @throws {@link TransportError} the request does not complete, or the
   * answer names another Account or Namespace
   */
  get(name: string, options?: CallOptions): Promise<Computer>;
  /**
   * Every Computer of the Account, page by page, as handles. Each holds the
   * snapshot the listing read and acts on its Computer without reading it
   * again, as a handle from `get` does.
   *
   * @throws {@link TypeError} `limit` is not a positive integer
   * @throws {@link ApiError} IDYL refuses a page's request
   * @throws {@link TransportError} a page's request does not complete, or a
   * listed Computer belongs to another Account or Namespace
   */
  list(options?: ListOptions): AsyncIterable<Computer>;
  /**
   * One page of the Account's Computers, as handles.
   *
   * @throws {@link TypeError} `limit` is not a positive integer, or
   * `continue` is not a position this listing issued, before any request is
   * sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete, or a
   * listed Computer belongs to another Account or Namespace
   */
  listPage(options?: PageOptions): Promise<Page<Computer>>;
  /**
   * Every attachment of the Secret with this ID across the Namespace's
   * Computers that you may read, asleep or awake, ordered by Computer name
   * and then by variable: which Computer, through which variable, whether
   * it is attached there, and the version it is pinned to, if any. It lists
   * the settings each Computer applies from its next start. It is read at
   * one moment and is not paged, and it reads no Secret: an ID no Computer
   * you may read attaches reads as none.
   *
   * @param secretId a Secret's `id`, a canonical UUID
   * @throws {@link TypeError} `secretId` is not a canonical UUID, before any
   * request is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  listBySecret(
    secretId: string,
    options?: CallOptions,
  ): Promise<readonly ComputerSecretUse[]>;
  /**
   * The image catalogue a Computer can start from, for one isolation class:
   * `secure-container` unless `isolation` names another. Empty for a class
   * that is not offered.
   *
   * @throws {@link TypeError} `isolation` names no isolation class, before
   * any request is sent
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  images(options?: ImagesOptions): Promise<readonly ComputerImage[]>;
  /**
   * The sizes a Computer can run at, smallest first, as IDYL offers them. The
   * read needs no credential and no Account.
   *
   * @throws {@link ApiError} IDYL refuses the request
   * @throws {@link TransportError} the request does not complete
   */
  sizes(options?: CallOptions): Promise<readonly ComputerSizeInfo[]>;
  /**
   * A connector for the Account's Computers: the one way a command, a
   * terminal, a notebook cell or a live files listing runs in a Computer.
   * Each session is end-to-end encrypted between the page and the
   * Computer, run by `options.worker`: a Worker that called
   * `serveComputerConnections` from `@idyl-sh/sdk/computer-connection`.
   * Nothing is sent until {@link ComputerConnector.ready} or a session.
   * `Computer.exec` runs on the connector built last, which stays open until
   * it is closed.
   *
   * @throws {@link TypeError} neither the options nor the client name a
   * network, or neither states trust keys
   */
  connector(options: ConnectorOptions): ComputerConnector;
}

/** What a Computer connector needs beyond the client. */
export interface ConnectorOptions {
  /** The Worker that runs the connections. */
  readonly worker: WorkerPort;
  /** `@idyl-sh/sdk/computer-connection.wasm`, compiled. */
  readonly module: WebAssembly.Module;
  /** The Network the client is configured for, as a domain; the client's when absent. */
  readonly network?: string;
  /** The Network trust keys the page pins; the client's when absent. */
  readonly trustKeys?: readonly TrustKey[];
  /** Where Computers were last placed, kept across page loads. */
  readonly placements?: PlacementMemory;
  /**
   * The kind of client every session create states, recorded with each
   * notebook cell the connector runs. `sdk` when absent.
   */
  readonly client?: "sdk" | "console" | "cli";
  /**
   * Where the connector keeps the highest session trust version it has
   * accepted per Network and trust scope, and refuses an older bundle. When
   * absent, the page's one default floor: IndexedDB where the runtime
   * offers it, and memory for the life of the page where IndexedDB is
   * absent or its `open` throws before the page ever opened it; any other
   * storage failure refuses the bundle.
   */
  readonly trustFloor?: TrustFloor;
}

/** Builds the Computers of `namespace`. */
export function computers(
  context: (options?: CallOptions) => Promise<PlacementContext>,
  namespace: string,
  readSizes: (options?: CallOptions) => Promise<ListComputerSizesResponse>,
  network: {
    readonly network: string | undefined;
    readonly trustKeys: readonly TrustKey[] | undefined;
  },
): Computers {
  const buildConnector = (
    options: ConnectorOptions & {
      readonly network: string;
      readonly trustKeys: readonly TrustKey[];
    },
  ): ComputerConnector =>
    computerConnector({
      worker: options.worker,
      module: options.module,
      network: options.network,
      trustKeys: options.trustKeys,
      ...(options.placements === undefined
        ? {}
        : { placements: options.placements }),
      client: clientOf(options.client),
      ...(options.trustFloor === undefined
        ? {}
        : { trustFloor: options.trustFloor }),
      account: async () => (await context()).scope.accountId,
      api: computerEndpointApi(() => context()),
    });
  const commands = connections({
    network: network.network,
    trustKeys: network.trustKeys,
    build: buildConnector,
  });
  const fresh = (): HandleState => ({
    context,
    namespace,
    connections: commands,
  });
  const service = async (options?: CallOptions) =>
    await serviceOf(fresh(), options);
  const listPage = async (
    options: PageOptions = {},
  ): Promise<Page<Computer>> => {
    const limit = requireLimit(options.limit);
    const offset = offsetOf(options.continue);
    const state = fresh();
    const page = await (
      await serviceOf(state, options)
    ).list(
      {
        ...(limit === undefined ? {} : { limit }),
        ...(offset === 0 ? {} : { offset }),
      },
      signalOf(options),
    );
    const handles = await Promise.all(
      page.items.map((record) => handleOf(state, record, options)),
    );
    const next = offset + page.items.length;
    return pageOf(
      handles,
      page.items.length > 0 && BigInt(next) < BigInt(page.totalCount)
        ? String(next)
        : undefined,
    );
  };
  return Object.freeze({
    async create(options: CreateComputerOptions) {
      const state = fresh();
      const name = requireName(options.name);
      const spec = settingsRequest(options);
      const client = clientOf(options.client);
      const { idempotencyKey, workspaceOnly } = options;
      const { computer } = await (
        await serviceOf(state, options)
      ).create(
        {
          name,
          ...(Object.keys(spec).length === 0 ? {} : { spec }),
          ...(workspaceOnly === undefined ? {} : { workspaceOnly }),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          client,
        },
        signalOf(options),
      );
      return await handleOf(state, computer, options);
    },
    async get(name: string, options: CallOptions = {}) {
      const state = fresh();
      const computerName = requireName(name);
      const service = await serviceOf(state, options);
      const { computer } = await service.get(computerName, signalOf(options));
      return await handleOf(state, computer, options);
    },
    list: (options: ListOptions = {}) => walk(listPage, options),
    listPage,
    async listBySecret(secretId: string, options: CallOptions = {}) {
      // Judged before the client's context is read, so a refusal arrives
      // before anything is sent.
      if (!isResourceId(secretId)) {
        throw new TypeError("secret ID must be a canonical UUID");
      }
      const { items } = await (
        await service(options)
      ).listBySecret(secretId, signalOf(options));
      return Object.freeze(items.map(computerSecretUseOf));
    },
    connector(options: ConnectorOptions) {
      const stated = options.network ?? commands.network;
      const keys = options.trustKeys ?? commands.trustKeys;
      if (stated === undefined) {
        throw new TypeError("network is required: the client names none");
      }
      if (keys === undefined) {
        throw new TypeError("trustKeys is required: the client states none");
      }
      return commands.adopt(
        buildConnector({ ...options, network: stated, trustKeys: keys }),
      );
    },
    async images(options: ImagesOptions = {}) {
      const { isolation } = options;
      // A class no Computer may select is refused before the client's
      // context, which may read the network, is resolved.
      if (isolation !== undefined) imageCatalogQuery(isolation);
      const computers = await service(options);
      const catalogue = await (isolation === undefined
        ? computers.listImages(signalOf(options))
        : computers.listImagesFor(isolation, signalOf(options)));
      return Object.freeze(
        catalogue.items.map((image) =>
          Object.freeze({
            name: image.name,
            displayName: image.displayName,
            ...(image.description === undefined
              ? {}
              : { description: image.description }),
            os: Object.freeze({
              name: image.os.name,
              version: image.os.version,
            }),
            gpu: image.gpu,
            patch: image.patch,
            default: image.default,
            isolation: image.isolation ?? "secure-container",
          }),
        ),
      );
    },
    async sizes(options: CallOptions = {}) {
      const { items } = await readSizes(options);
      return Object.freeze(
        items.map((size) =>
          Object.freeze({
            name: size.name,
            label: size.label,
            cpu: formatCpu(size.cpu),
            memory: formatMemory(size.memory),
            disk: formatVolume(size.disk),
            ...(size.names === undefined
              ? {}
              : { names: numberOf(size.names) }),
            default: size.default,
          }),
        ),
      );
    },
  });
}

function offsetOf(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw new TypeError("continue is not a position this listing issued");
  }
  return Number(value);
}

function requireName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("computer name is required");
  }
  return name;
}

/** A saved version selected by number or by name, as the contract spells it. */
function versionSelector(version: number | string): string {
  if (typeof version === "number") {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new TypeError("version must be a non-negative integer or a name");
    }
    return String(version);
  }
  if (typeof version !== "string" || version.trim() === "") {
    throw new TypeError("version must be a non-negative integer or a name");
  }
  return version;
}

/**
 * An operation that ended without the outcome asked for, as the `ApiError`
 * a refusal of it would be: status 409, the platform's reason as `detail`.
 * An operation whose reasons are stable codes also carries its reason as
 * `code`.
 */
function outcomeRefused(
  operation: string,
  state: string,
  reason: string | undefined,
  coded = false,
): ApiError {
  return new ApiError({
    status: 409,
    message: reason ?? `${operation} ended ${state}`,
    ...(coded && reason !== undefined ? { code: reason } : {}),
  });
}

function optional<K extends string>(
  key: K,
  value: string | undefined,
): Readonly<Partial<Record<K, string>>> {
  return (value === undefined ? {} : { [key]: value }) as Readonly<
    Partial<Record<K, string>>
  >;
}
