// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The public views of the records a Computer serves: its settings, its
 * history and its saved versions. Each is built
 * field by field from the served record, so a field the product does not
 * offer never reaches a caller.
 */
import type {
  ComputerAwake,
  ComputerSessionSummary,
} from "../api/computer-awake.js";
import type { JournalEntry } from "../api/journal.js";
import type { Version as VersionRecord } from "../api/storage.js";
import type { ComputerEffectiveExecutionSettings } from "../api/computer.js";
import type {
  ComputerExecutionSettings,
  ComputerSecretAttachment,
} from "../resource/computer-execution-settings.js";
import { formatCpu } from "../resource/cpu.js";
import type { Integer } from "../resource/json.js";
import { formatMemory } from "../resource/memory.js";
import { formatVolume } from "../resource/volume.js";

/**
 * How a Computer runs: its image, CPU, memory, network class and what it
 * allows, environment variables, and default shell. A field that is absent
 * is not stated and takes IDYL's default.
 */
export interface ExecutionSettings {
  /** The image: an IDYL catalogue name such as `ubuntu-26.04`, or an image reference. */
  readonly image?: string;
  /** How it is isolated: `secure-container` or `vm`. Absent is `secure-container`. */
  readonly isolation?: string;
  /**
   * The tier of machine it runs on: `economy`, `standard`, `performance` or
   * `best-available`. The settings as stated leave it out when they state
   * none; the effective settings hold the setting the next start uses, IDYL's
   * default `best-available` when none is stated. A tier this package does
   * not name is carried unchanged from IDYL's report.
   */
  readonly tier?: string;
  /**
   * The size by name, such as `small`. Settings as stated hold it or `cpu` and
   * `memory`; the effective settings hold all three, with `disk`, and leave it
   * out while the limits are no size's.
   */
  readonly size?: string;
  /**
   * The name a person reads for `size`, such as `Small`, so a list row can show
   * it with no second request. Only the effective settings hold this field.
   */
  readonly sizeLabel?: string;
  /** The CPU limit, such as `500m` or `2`. */
  readonly cpu?: string;
  /** The memory limit, such as `512Mi` or `4Gi`. */
  readonly memory?: string;
  /**
   * The most the Computer can store, such as `20Gi`, as reported by IDYL. Only
   * the effective settings hold this field.
   */
  readonly disk?: string;
  /**
   * The network class: `internet` (the open internet, local networks
   * blocked), `restricted-egress` or `none`. A class this package does not name
   * is carried unchanged from IDYL's report.
   */
  readonly network?: string;
  /**
   * What a `restricted-egress` network allows: `dns`, and
   * `tcp:<port>:<hostname>` per destination.
   */
  readonly allow?: readonly string[];
  /** The environment variables every process starts with. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The Secrets attached, by the environment variable each is attached
   * under: `secret` is the Secret's ID, and `version` the version an
   * attachment pins, absent when it follows the current one. Only the settings
   * as stated hold this field.
   */
  readonly secrets?: Readonly<
    Record<string, { readonly secret: string; readonly version?: number }>
  >;
  /**
   * The default shell its terminals run, such as `/usr/bin/zsh`. Absent
   * when none is stated: a terminal then runs `/bin/bash` when the image
   * has it and `/bin/sh` otherwise.
   */
  readonly shell?: string;
}

/**
 * One entry of a Computer's history, newest first. `kind` is `genesis`,
 * `execution-settings`, `upload`, `edit`, `restore`, `save`,
 * `fork-point`, `rename`, `wake` or `sleep`, or one this package does not
 * name. `version` is
 * the saved version the entry owns, when it owns one. `creator` names who
 * caused it, absent when IDYL made it on its own.
 */
export interface HistoryEntry {
  /** The entry's ID, which a fork can start from. */
  readonly id: string;
  /** What the entry records, as the description of {@link HistoryEntry} lists. */
  readonly kind: string;
  /** When IDYL admitted the entry, as an RFC 3339 instant. */
  readonly admittedAt: string;
  /** The saved version the entry owns, when it owns one. */
  readonly version?: number;
  /** Who caused it; absent when IDYL made it on its own. */
  readonly creator?: string;
  /**
   * The kind of client that made it, such as `console`, `cli` or `sdk`, or
   * `unknown` when its request named none. Present on every entry a
   * request caused; absent on an entry IDYL made on its own. It is
   * informative and grants nothing.
   */
  readonly client?: string;
  /** What caused a `save` entry. */
  readonly save?: { readonly trigger: string };
  /** The settings after an `execution-settings` or `restore` entry. */
  readonly settings?: ExecutionSettings;
  /**
   * The image patch an `execution-settings` entry records: IDYL started the
   * Computer on a newer patch level of its catalog image, named by `image`,
   * moving `from` one patch level `to` another, such as `2026.10.13` to
   * `2026.10.24`. Such an entry is IDYL's own and names no creator or
   * client. Absent on every other entry.
   */
  readonly imagePatch?: {
    readonly image: string;
    readonly from: string;
    readonly to: string;
  };
  /** The names before and after a `rename` entry. */
  readonly rename?: { readonly from: string; readonly to: string };
  /**
   * Why a `sleep` entry's Computer slept: `reason` is `request`, `idle`,
   * `no-execution`, `settings`, `restore`, `node-drain`, `out-of-usage`,
   * `plan-size` or `powered-off`, when a program in the Computer shut its
   * machine down; `idleTimeout` is the timeout in force on an idle sleep;
   * `discardedUnsavedChanges` is true when the sleep was asked to discard
   * unsaved changes and released the Computer without saving them.
   */
  readonly sleep?: {
    readonly reason?: string;
    readonly idleTimeout?: string;
    readonly discardedUnsavedChanges: boolean;
  };
  /**
   * What started a `wake` entry's Computer: `session` is the kind of session,
   * `terminal`, `command` or `ssh`, or a kind this package does not name.
   * Absent on a wake request.
   */
  readonly wake?: { readonly session: string };
  /**
   * Why a `restart` entry's execution started again: `reason` is `node-lost`,
   * `failed`, when the Computer's machine or container failed, or `replaced`.
   */
  readonly restart?: { readonly reason: string };
}

/** One thing keeping a Computer awake. */
export interface AwakeHold {
  /**
   * What it is: `session`, `keep-awake`, `starting-session`,
   * `settings-restart`, or a kind this package does not name. A
   * `settings-restart` keeps nothing awake: the Computer sleeps once no session
   * holds it awake.
   */
  readonly kind: string;
  /** How many sessions it names; zero on a hold that names none. */
  readonly count: number;
}

/**
 * Why a Computer is awake and when it sleeps, at the time of the read. A
 * Computer counting down states `sleepsAt` and `sleepsIn`; count down from
 * `sleepsIn`, which needs no agreement between this machine's clock and IDYL's,
 * and read the Computer again to follow a change made elsewhere.
 */
export interface Awake {
  /** When its current execution started, as an RFC 3339 instant. */
  readonly since: string;
  /**
   * The tier of the machine it runs on: `economy`, `standard` or
   * `performance`. A `best-available` Computer can run on another tier at
   * each start, and this says which it took. Absent while the machine states
   * no tier.
   */
  readonly tier?: string;
  /** What keeps it awake at the read; empty while it counts down. */
  readonly holds: readonly AwakeHold[];
  /** When it sleeps by IDYL's clock, as an RFC 3339 instant. */
  readonly sleepsAt?: string;
  /**
   * Whole seconds until `sleepsAt`, from the read; zero once that time has
   * passed.
   */
  readonly sleepsIn?: number;
}

/**
 * One open session of a Computer, as seen by anyone who may read the Computer.
 * It carries no command, output or credential, and it grants nothing.
 */
export interface OpenSession {
  /** The session's ID. */
  readonly id: string;
  /**
   * `terminal`, `command`, `ssh` (an SSH connection), or a kind this
   * package does not name.
   */
  readonly kind: string;
  /** The kind of client that opened it, or `unknown`. It is informative. */
  readonly client: string;
  /** The identity that opened the session. */
  readonly openedBy: string;
  /** When it was accepted, as an RFC 3339 instant. */
  readonly openedAt: string;
  /** Whether the caller who read the list opened the session. */
  readonly yours: boolean;
}

/** One saved version of a Computer's files. */
export interface Version {
  /** The version's number; zero is the empty first version. */
  readonly number: number;
  /** The name it was given, if any. */
  readonly name?: string;
  /** When it was saved, as an RFC 3339 instant. */
  readonly createdAt: string;
  /** What made it: `genesis`, `commit`, `upload`, `restore` or `fork-point`. */
  readonly origin: string;
  /** The history entry that owns this version. */
  readonly entry?: string;
  /** The version it was made from. */
  readonly parent?: number;
  /** The size of its files, in bytes. */
  readonly bytes: number;
}

/** An integer the platform served, as a number. */
export function numberOf(value: Integer): number {
  return typeof value === "bigint" ? Number(value) : value;
}

/** An optional integer the platform served, as a number. */
export function optionalNumber(value: Integer | undefined): number | undefined {
  return value === undefined ? undefined : numberOf(value);
}

/** Copies `value` into `target` under `key` when it is present. */
function present<K extends string, V>(
  key: K,
  value: V | undefined,
): Readonly<Partial<Record<K, V>>> {
  return (value === undefined ? {} : { [key]: value }) as Readonly<
    Partial<Record<K, V>>
  >;
}

/**
 * A served quantity or duration in its spelling. The lenient reader
 * carries a value its codec refused as it arrived, so a string is shown as
 * it is, and anything else that cannot be spelled is left out rather than
 * failing the whole record.
 */
export function spelled<T>(
  value: T | undefined,
  format: (value: T) => string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return format(value);
  } catch {
    return undefined;
  }
}

/**
 * The `secrets` field of the settings as stated; a read that carries no
 * list, or what the lenient reader kept of one it could not read, has none.
 */
function attachmentsOf(
  settings: ComputerExecutionSettings | ComputerEffectiveExecutionSettings,
): Pick<ExecutionSettings, "secrets"> {
  const stated: unknown = "secrets" in settings ? settings.secrets : undefined;
  return Array.isArray(stated)
    ? { secrets: attachedOf(stated as readonly ComputerSecretAttachment[]) }
    : {};
}

/**
 * The public view of Secret attachments, by variable. A read names each
 * Secret by ID; a name is shown only where IDYL reported one in its place.
 */
function attachedOf(
  attachments: readonly ComputerSecretAttachment[],
): Readonly<
  Record<string, { readonly secret: string; readonly version?: number }>
> {
  const attached: Record<
    string,
    { readonly secret: string; readonly version?: number }
  > = {};
  for (const { env, secret } of attachments) {
    attached[env] = Object.freeze({
      secret: secret.id ?? secret.name ?? "",
      ...(secret.version === undefined
        ? {}
        : { version: numberOf(secret.version) }),
    });
  }
  return Object.freeze(attached);
}

/** The public view of execution settings. */
export function settingsOf(
  settings:
    ComputerExecutionSettings | ComputerEffectiveExecutionSettings | undefined,
): ExecutionSettings {
  if (settings === undefined) return Object.freeze({});
  const env: Record<string, string> = {};
  for (const variable of settings.variables ?? []) {
    env[variable.name] = variable.value;
  }
  return Object.freeze({
    ...present("image", settings.image?.idyl ?? settings.image?.ref),
    ...present("size", settings.size === "" ? undefined : settings.size),
    ...("sizeLabel" in settings && settings.sizeLabel !== ""
      ? present("sizeLabel", settings.sizeLabel)
      : {}),
    ...present("cpu", spelled(settings.cpu, formatCpu)),
    ...present("memory", spelled(settings.memory, formatMemory)),
    ...("disk" in settings
      ? present("disk", spelled(settings.disk, formatVolume))
      : {}),
    ...present("network", settings.network?.class),
    ...present(
      "allow",
      settings.network?.egress?.allow === undefined
        ? undefined
        : Object.freeze([...settings.network.egress.allow]),
    ),
    ...(settings.variables === undefined ? {} : { env: Object.freeze(env) }),
    ...attachmentsOf(settings),
    ...("isolation" in settings
      ? present(
          "isolation",
          settings.isolation === "" ? undefined : settings.isolation,
        )
      : {}),
    ...present("tier", settings.tier === "" ? undefined : settings.tier),
    ...present("shell", settings.shell === "" ? undefined : settings.shell),
  });
}

/** The public view of a history entry. */
export function historyEntryOf(entry: JournalEntry): HistoryEntry {
  return Object.freeze({
    id: entry.id,
    kind: entry.kind,
    admittedAt: entry.admittedAt,
    ...present("version", optionalNumber(entry.version)),
    ...present("creator", entry.creator),
    ...present(
      "client",
      entry.client ?? entry.cell?.client ?? entry.executionSettings?.client,
    ),
    ...present(
      "save",
      entry.save === undefined
        ? undefined
        : Object.freeze({ trigger: entry.save.trigger }),
    ),
    ...present(
      "settings",
      entry.executionSettings === undefined
        ? undefined
        : settingsOf(entry.executionSettings.settings),
    ),
    ...present(
      "imagePatch",
      entry.executionSettings?.imagePatch === undefined
        ? undefined
        : Object.freeze({
            image: entry.executionSettings.imagePatch.name,
            from: entry.executionSettings.imagePatch.from.patch,
            to: entry.executionSettings.imagePatch.to.patch,
          }),
    ),
    ...present(
      "rename",
      entry.rename === undefined
        ? undefined
        : Object.freeze({ from: entry.rename.from, to: entry.rename.to }),
    ),
    ...present(
      "sleep",
      entry.sleep === undefined
        ? undefined
        : Object.freeze({
            ...present("reason", entry.sleep.reason),
            ...present("idleTimeout", entry.sleep.idleTimeout),
            discardedUnsavedChanges:
              entry.sleep.discardedUnsavedChanges === true,
          }),
    ),
    ...present(
      "wake",
      entry.wake === undefined
        ? undefined
        : Object.freeze({ session: entry.wake.session }),
    ),
    ...present(
      "restart",
      entry.restart === undefined
        ? undefined
        : Object.freeze({ reason: entry.restart.reason }),
    ),
  });
}

/** The public view of why a Computer is awake. */
export function awakeOf(awake: ComputerAwake): Awake {
  return Object.freeze({
    since: awake.since,
    ...present("tier", awake.tier === "" ? undefined : awake.tier),
    holds: Object.freeze(
      awake.holds.map((hold) =>
        Object.freeze({ kind: hold.kind, count: numberOf(hold.count) }),
      ),
    ),
    ...present("sleepsAt", awake.sleepsAt),
    ...present("sleepsIn", optionalNumber(awake.sleepsIn)),
  });
}

/** The public view of an open session. */
export function openSessionOf(session: ComputerSessionSummary): OpenSession {
  return Object.freeze({
    id: session.id,
    kind: session.kind,
    client: session.client,
    openedBy: session.openedBy,
    openedAt: session.openedAt,
    yours: session.yours,
  });
}

/** The public view of a saved version. */
export function versionOf(version: VersionRecord): Version {
  return Object.freeze({
    number: numberOf(version.number),
    ...present("name", version.name),
    createdAt: version.createdAt,
    origin: version.origin,
    ...present("entry", version.entry),
    ...present("parent", optionalNumber(version.parent)),
    bytes: numberOf(version.logicalBytes),
  });
}
