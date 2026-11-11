// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import {
  always,
  integer,
  object,
  type Shape,
} from "../internal/strictdecode.js";
import type { Integer } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";

/**
 * Work being recovered into a Computer: files kept after the session that
 * wrote them ended without saving them, on their way to a new version.
 * The platform publishes that version by itself; no caller action is needed
 * or offered. Once it is published, the version's save entry carries the
 * trigger `recovery` and the Computer reports no recovery. Where a newer
 * version changed a path the recovered work also changed, the newer file
 * stays and the recovered one is written beside it under the name
 * `<stem>.recovered-v<N><ext>`, N being the recovered version's number, so
 * nothing newer is ever overwritten.
 */
export interface ComputerRecovery {
  /** How many files hold recovered changes. Always written. */
  readonly files: Integer;
  /** The total size of those files, in bytes. Always written. */
  readonly bytes: Integer;
  /**
   * When the platform learned of the recovered work, as an RFC 3339
   * timestamp. Always written.
   */
  readonly since: string;
}

/** The wire shape of a Computer's recovery. */
export const computerRecoveryShape: Shape<ComputerRecovery> =
  object<ComputerRecovery>({
    files: always(integer({ unsigned: false, bits: 64 })),
    bytes: always(integer({ unsigned: false, bits: 64 })),
    since: always(timestampShape),
  });

/**
 * Judges the recovery: counts that are not negative and a `since` that is
 * set. Throws a `TypeError`.
 */
export function validateComputerRecovery(recovery: ComputerRecovery): void {
  if (BigInt(recovery.files) < 0n || BigInt(recovery.bytes) < 0n) {
    throw new TypeError("recovery counts must be non-negative");
  }
  if (recovery.since === "") {
    throw new TypeError("recovery since is required");
  }
}
