// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  compareDuration,
  durationShape,
  formatDuration,
  type Duration,
} from "./duration.js";
import {} from "./storage.js";
import { boolean } from "../internal/strictdecode.js";
import {
  object,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";

import { validateIdleTimeout, type IdleTimeout } from "./idle-timeout.js";

import {
  validateComputerExecutionSettings,
  computerExecutionSettingsShape,
  type ComputerExecutionSettings,
} from "./computer-execution-settings.js";

import { prefixed } from "./validation.js";

/** The shortest `saveQuiet` a Computer accepts: one second. */
const MIN_COMPUTER_SAVE_QUIET: Duration = { seconds: 1, nanoseconds: 0 };
/** The longest `saveQuiet` a Computer accepts: ten minutes. */
const MAX_COMPUTER_SAVE_QUIET: Duration = { seconds: 600, nanoseconds: 0 };
/** The shortest `saveMaxInterval` a Computer accepts: ten seconds. */
const MIN_COMPUTER_SAVE_MAX_INTERVAL: Duration = {
  seconds: 10,
  nanoseconds: 0,
};
/** The longest `saveMaxInterval` a Computer accepts: one hour. */
const MAX_COMPUTER_SAVE_MAX_INTERVAL: Duration = {
  seconds: 3_600,
  nanoseconds: 0,
};

/**
 * How a Computer runs. Every field is optional, and a spec that states
 * nothing is written as `{}` rather than omitted, keeping the manifest
 * envelope of kind, metadata, and spec.
 */
export interface ComputerSpec {
  /**
   * Whether the Computer saves its workspace on its own: after changes, when
   * each session ends, and at release. `false` saves only on demand and at
   * release, and a session then reports its save as `off`. An explicit
   * `false` remains stated. `undefined` takes the default, `true`.
   */
  readonly autoSave?: boolean;
  /**
   * How long writes to the workspace must have been quiet before a
   * change-driven save runs: a duration from `1s` to `10m`. `undefined`
   * takes the default, `10s`.
   */
  readonly saveQuiet?: Duration;
  /**
   * The longest time between saves while writes continue and a session is
   * open, so continuous writes are never left unsaved for longer: a
   * duration from `10s` to `1h`, and at least `saveQuiet`. The platform
   * judges it against the `saveQuiet` in force, its default included.
   * `undefined` takes the default, `2m`.
   */
  readonly saveMaxInterval?: Duration;
  /** Nonnegative failing-save budget, with zero preserved; omission uses server policy. */
  readonly saveWindow?: Duration;
  /**
   * How long the Computer keeps its execution after its last session
   * ends: `never`, or a whole number followed by `s`, `m`, or `h`, at least
   * `0s`. The platform states it canonically in seconds, so `5m` reads
   * back as `300s`. `undefined` takes the default, `300s`. See
   * {@link IdleTimeout}.
   */
  readonly idleTimeout?: IdleTimeout;
  /**
   * The execution settings of a Computer: its OS image, size or CPU and
   * memory, network, and environment variables. A create states the whole document, and a field
   * it leaves out takes IDYL's default; an update changes it field by field.
   * A served Computer states the image it runs, unless its Subnet offered no
   * image when it was created.
   * See {@link ComputerExecutionSettings}.
   */
  readonly execution?: ComputerExecutionSettings;
}

export const computerSpecShape: Shape<ComputerSpec> = object<ComputerSpec>({
  idleTimeout: pointer(string()),
  autoSave: pointer(boolean()),
  saveQuiet: pointer(durationShape),
  saveMaxInterval: pointer(durationShape),
  saveWindow: pointer(durationShape),
  execution: pointer(computerExecutionSettingsShape),
});

/**
 * Judges every field the spec states. A spec that states nothing is valid:
 * the platform applies the defaults. `saveMaxInterval` is judged against
 * `saveQuiet` only when both are stated; the platform judges the pair in
 * force. Throws a `TypeError` naming the field,
 * such as `idleTimeout: idle timeout must be non-negative`; a refusal of the
 * computer is a `ComputerExecutionSettingsError` naming the field.
 */
export function validateComputerSpec(spec: ComputerSpec): void {
  if (spec.idleTimeout !== undefined) {
    prefixed("idleTimeout", () => {
      validateIdleTimeout(spec.idleTimeout ?? "");
    });
  }
  validateComputerSaveSettings(spec.saveQuiet, spec.saveMaxInterval);
  if (
    spec.saveWindow !== undefined &&
    compareDuration(spec.saveWindow, { seconds: 0, nanoseconds: 0 }) < 0
  )
    throw new TypeError("saveWindow must be non-negative");
  if (spec.execution !== undefined)
    validateComputerExecutionSettings(spec.execution);
}

/**
 * Judges the change-driven save settings a spec or an update states: each
 * within its range, and the interval at least the quiet time when both are
 * stated.
 */
function validateComputerSaveSettings(
  quiet: Duration | undefined,
  interval: Duration | undefined,
): void {
  if (
    quiet !== undefined &&
    (compareDuration(quiet, MIN_COMPUTER_SAVE_QUIET) < 0 ||
      compareDuration(quiet, MAX_COMPUTER_SAVE_QUIET) > 0)
  ) {
    throw new TypeError(
      `saveQuiet must be from ${formatDuration(MIN_COMPUTER_SAVE_QUIET)} to ${formatDuration(MAX_COMPUTER_SAVE_QUIET)}`,
    );
  }
  if (interval === undefined) return;
  if (
    compareDuration(interval, MIN_COMPUTER_SAVE_MAX_INTERVAL) < 0 ||
    compareDuration(interval, MAX_COMPUTER_SAVE_MAX_INTERVAL) > 0
  ) {
    throw new TypeError(
      `saveMaxInterval must be from ${formatDuration(MIN_COMPUTER_SAVE_MAX_INTERVAL)} to ${formatDuration(MAX_COMPUTER_SAVE_MAX_INTERVAL)}`,
    );
  }
  if (quiet !== undefined && compareDuration(interval, quiet) < 0) {
    throw new TypeError("saveMaxInterval must be at least saveQuiet");
  }
}
