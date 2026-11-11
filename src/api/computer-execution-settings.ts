// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import type { Integer } from "../resource/json.js";
import {
  always,
  array,
  boolean,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { prefixed } from "../resource/validation.js";
import {
  isComputerImageDigestReference,
  validateComputerExecutionSettings,
  validateComputerEnvironmentVariableName,
  computerExecutionSettingsShape,
  type ComputerExecutionSettings,
} from "../resource/computer-execution-settings.js";
import { errorMessage } from "../resource/validation.js";
import {
  compareComputerImagePatch,
  validateComputerImagePatch,
} from "./computer-image.js";
import {
  validateComputerSessionClient,
  type ComputerSessionClient,
} from "./computer-session.js";

/**
 * The most bytes of variable values an execution-settings change carries in a journal
 * list, its variables' values taken together. A change whose values are
 * longer has them cut and is marked truncated; reading the entry on its own
 * returns them whole.
 */
export const MAX_COMPUTER_EXECUTION_SETTINGS_LISTED_VARIABLE_BYTES = 4 << 10;

/** The changed path of a change of the OS image. */
export const COMPUTER_EXECUTION_SETTINGS_CHANGED_IMAGE = "image";
/**
 * The changed path of a change of the isolation class, by which a Computer
 * moves between `secure-container` and `vm`.
 */
export const COMPUTER_EXECUTION_SETTINGS_CHANGED_ISOLATION = "isolation";
/** The changed path of a change of the CPU limit. */
export const COMPUTER_EXECUTION_SETTINGS_CHANGED_CPU = "cpu";
/** The changed path of a change of the memory limit. */
export const COMPUTER_EXECUTION_SETTINGS_CHANGED_MEMORY = "memory";
/** The changed path of a change of the network. */
export const COMPUTER_EXECUTION_SETTINGS_CHANGED_NETWORK = "network";
/** The changed path of a change of the default shell. */
export const COMPUTER_EXECUTION_SETTINGS_CHANGED_SHELL = "shell";
/**
 * The prefix of the changed path of a variable that was added, changed, or
 * removed, as in `variables.LOG_LEVEL`.
 */
export const COMPUTER_EXECUTION_SETTINGS_CHANGED_VARIABLE_PREFIX = "variables.";
/**
 * The prefix of the changed path of a Secret attachment that was added,
 * changed, or removed, named by its variable, as in `secrets.GITHUB_TOKEN`.
 */
export const COMPUTER_EXECUTION_SETTINGS_CHANGED_SECRET_PREFIX = "secrets.";
/** The changed path of a change of the workload identity. */
export const COMPUTER_EXECUTION_SETTINGS_CHANGED_IDENTITY = "identity";

/**
 * What made an execution-settings entry.
 *
 * - `settings`: a write of the settings, by the creator the change names, a
 *   create included.
 * - `image-patch`: IDYL's: the Computer started on a newer patch level of
 *   the IDYL image its settings name. The settings, and their revision, are
 *   those in force before it.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateComputerExecutionSettingsChangeCause}
 * judges membership, and a caller shows an entry of a cause it does not
 * know as an execution-settings change it cannot describe.
 */
export type ComputerExecutionSettingsChangeCause =
  "settings" | "image-patch" | (string & Record<never, never>);

/**
 * Judges that the cause is one this SDK names. The empty string is
 * reported as missing. Throws a `TypeError`.
 */
export function validateComputerExecutionSettingsChangeCause(
  cause: ComputerExecutionSettingsChangeCause,
): void {
  switch (cause) {
    case "settings":
    case "image-patch":
      return;
    case "":
      throw new TypeError(
        "computer execution-settings change cause is required",
      );
    default:
      throw new TypeError(
        `unknown computer execution-settings change cause ${JSON.stringify(cause)}`,
      );
  }
}

/** One patch level of an IDYL image and its pinned image. */
export interface ComputerExecutionSettingsImagePatchLevel {
  /** The patch level. See `validateComputerImagePatch`. */
  readonly patch: string;
  /** The pinned image of the patch level, by digest. */
  readonly image: string;
}

/**
 * A patch IDYL applied to the IDYL image a Computer's settings name: the
 * catalog entry and the patch levels the Computer's starts moved between.
 */
export interface ComputerExecutionSettingsImagePatch {
  /** The catalog name of the IDYL image. */
  readonly name: string;
  /** The patch level the Computer last started on before. */
  readonly from: ComputerExecutionSettingsImagePatchLevel;
  /** The patch level the Computer started on. */
  readonly to: ComputerExecutionSettingsImagePatchLevel;
}

/**
 * One entry of a Computer's journal about its execution settings: the whole
 * settings after the entry, the revision in force, and its cause. A change of the
 * settings names what it changed and who made it from which client; it is
 * recorded when the Computer is created, whenever a write states settings
 * that differ from those in force, and on the restore entry of a restore
 * that changes them to those of the restored point. An image patch names
 * the IDYL image and the patch levels it moved between; IDYL records it
 * when the Computer starts on a newer patch level. Neither a change nor a
 * patch changes the Computer's files; a restore changes them through the
 * version its entry owns.
 *
 * Anyone who may read the Computer may read every change, variable values
 * included. A read decodes leniently, and
 * {@link validateComputerExecutionSettingsChange} judges the change against this
 * SDK's contract.
 */
export interface ComputerExecutionSettingsChange {
  /** What made the entry. */
  readonly cause: ComputerExecutionSettingsChangeCause;
  /**
   * The whole execution settings after the entry, as stated. In a journal
   * list its variable values are bounded and `truncated` is set when they
   * were cut.
   */
  readonly settings: ComputerExecutionSettings;
  /**
   * The revision of the execution settings in force after the entry, the
   * `ComputerExecutionSettingsStatus.revision` a read reports: the one a change of
   * the settings made, the first being revision one, and the one an image
   * patch left unchanged.
   */
  readonly revision: Integer;
  /**
   * What a change of the settings changed against the settings before it,
   * each path once: `image`, `cpu`, `memory`, `network`, or `variables.`
   * and a variable's name. The first change, recorded when the Computer is
   * created, is made against IDYL's defaults. Empty for an image patch.
   * Always written.
   */
  readonly changed: readonly string[];
  /** The patch IDYL applied; present exactly when `cause` is `image-patch`. */
  readonly imagePatch?: ComputerExecutionSettingsImagePatch;
  /** The identity that made a change of the settings; absent on an image patch. */
  readonly creator?: string;
  /**
   * The kind of client a change of the settings' request stated, or
   * `unknown` when it stated none; informative, and absent on an image
   * patch.
   */
  readonly client?: ComputerSessionClient;
  /**
   * Whether the variable values are cut, as a journal list carries them:
   * each variable keeps its name, and the values, in order, hold at most
   * {@link MAX_COMPUTER_EXECUTION_SETTINGS_LISTED_VARIABLE_BYTES} bytes together, the
   * last of them possibly shortened and those after it empty.
   */
  readonly truncated?: boolean;
}

const imagePatchLevelShape: Shape<ComputerExecutionSettingsImagePatchLevel> =
  object<ComputerExecutionSettingsImagePatchLevel>({
    patch: always(string()),
    image: always(string()),
  });

/** The wire shape of an execution-settings change. */
export const computerExecutionSettingsChangeShape: Shape<ComputerExecutionSettingsChange> =
  object<ComputerExecutionSettingsChange>({
    cause: always(string<ComputerExecutionSettingsChangeCause>()),
    settings: always(computerExecutionSettingsShape),
    revision: always(integer({ unsigned: false, bits: 64 })),
    changed: always(array(string())),
    imagePatch: pointer(
      object<ComputerExecutionSettingsImagePatch>({
        name: always(string()),
        from: always(imagePatchLevelShape),
        to: always(imagePatchLevelShape),
      }),
    ),
    creator: omitEmpty(string()),
    client: omitEmpty(string<ComputerSessionClient>()),
    truncated: omitEmpty(boolean()),
  });

/**
 * Judges the change against this SDK's contract: a cause this SDK names,
 * valid settings, a positive revision, and, when truncated, variable values
 * within {@link MAX_COMPUTER_EXECUTION_SETTINGS_LISTED_VARIABLE_BYTES}. A change of
 * the settings names at least one changed path, each one this SDK names and
 * none repeated, a creator, and a client this SDK names, and no image
 * patch. An image patch names no changed path, creator, or client; its
 * settings name the IDYL image it patched; and it moves from one patch level
 * to a later one. Throws a `TypeError`.
 */
export function validateComputerExecutionSettingsChange(
  change: ComputerExecutionSettingsChange,
): void {
  validateComputerExecutionSettingsChangeCause(change.cause);
  validateComputerExecutionSettings(change.settings);
  if (change.revision < 1) {
    throw new TypeError("revision must be positive");
  }
  if (change.cause === "image-patch") {
    validateImagePatch(change);
  } else {
    validateSettingsChange(change);
  }
  if (change.truncated === true) {
    const encoder = new TextEncoder();
    const total = (change.settings.variables ?? []).reduce(
      (sum, variable) => sum + encoder.encode(variable.value).byteLength,
      0,
    );
    if (total > MAX_COMPUTER_EXECUTION_SETTINGS_LISTED_VARIABLE_BYTES) {
      throw new TypeError(
        `settings.variables values must not exceed ${String(MAX_COMPUTER_EXECUTION_SETTINGS_LISTED_VARIABLE_BYTES)} bytes when truncated`,
      );
    }
  }
}

function validateSettingsChange(change: ComputerExecutionSettingsChange): void {
  if (change.imagePatch !== undefined) {
    throw new TypeError(
      "imagePatch must be absent on a change of the settings",
    );
  }
  if (change.changed.length === 0) {
    throw new TypeError("changed must name at least one path");
  }
  change.changed.forEach((path, index) => {
    prefixed(`changed[${String(index)}]`, () => {
      validateChangedPath(path);
    });
    const previous = change.changed.indexOf(path);
    if (previous < index) {
      throw new TypeError(
        `changed[${String(index)}] duplicates changed[${String(previous)}]`,
      );
    }
  });
  if ((change.creator ?? "") === "") {
    throw new TypeError("creator is required");
  }
  validateComputerSessionClient(change.client ?? "");
}

function validateImagePatch(change: ComputerExecutionSettingsChange): void {
  const patch = change.imagePatch;
  if (patch === undefined) {
    throw new TypeError("imagePatch is required on an image patch");
  }
  if (
    change.changed.length !== 0 ||
    (change.creator ?? "") !== "" ||
    (change.client ?? "") !== ""
  ) {
    throw new TypeError(
      "changed, creator, and client must be absent on an image patch",
    );
  }
  if (
    change.settings.image === undefined ||
    (change.settings.image.idyl ?? "") !== patch.name
  ) {
    throw new TypeError(
      "imagePatch.name must be the IDYL image the settings name",
    );
  }
  validatePatchLevel(patch.from, "from");
  validatePatchLevel(patch.to, "to");
  if (compareComputerImagePatch(patch.to.patch, patch.from.patch) <= 0) {
    throw new TypeError(
      "imagePatch.to.patch must be later than imagePatch.from.patch",
    );
  }
}

function validatePatchLevel(
  level: ComputerExecutionSettingsImagePatchLevel,
  field: string,
): void {
  prefixed(`imagePatch.${field}.patch`, () => {
    validateComputerImagePatch(level.patch);
  });
  if (!isComputerImageDigestReference(level.image)) {
    throw new TypeError(
      `imagePatch.${field}.image must be pinned by a sha256 digest`,
    );
  }
}

function validateChangedPath(path: string): void {
  switch (path) {
    case COMPUTER_EXECUTION_SETTINGS_CHANGED_IMAGE:
    case COMPUTER_EXECUTION_SETTINGS_CHANGED_ISOLATION:
    case COMPUTER_EXECUTION_SETTINGS_CHANGED_CPU:
    case COMPUTER_EXECUTION_SETTINGS_CHANGED_MEMORY:
    case COMPUTER_EXECUTION_SETTINGS_CHANGED_NETWORK:
    case COMPUTER_EXECUTION_SETTINGS_CHANGED_SHELL:
    case COMPUTER_EXECUTION_SETTINGS_CHANGED_IDENTITY:
      return;
    default:
      break;
  }
  for (const prefix of [
    COMPUTER_EXECUTION_SETTINGS_CHANGED_VARIABLE_PREFIX,
    COMPUTER_EXECUTION_SETTINGS_CHANGED_SECRET_PREFIX,
  ]) {
    if (!path.startsWith(prefix)) continue;
    try {
      validateComputerEnvironmentVariableName(path.slice(prefix.length));
    } catch (cause) {
      throw new TypeError(
        `${JSON.stringify(path)} does not name a variable: ${errorMessage(cause)}`,
        { cause },
      );
    }
    return;
  }
  throw new TypeError(
    `unknown execution settings path ${JSON.stringify(path)}`,
  );
}
