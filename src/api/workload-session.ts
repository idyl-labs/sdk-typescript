// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { validateShellPath } from "../resource/computer-execution-settings.js";
import {
  always,
  object,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { errorMessage } from "../resource/validation.js";

/**
 * The session operation vocabulary of the session contract. A Computer
 * session is always `shell`, which runs an interactive shell or a command
 * with an explicit shell executable; the contract's other operations are
 * not offered for Computers. The union is open.
 */
export type WorkloadSessionOperation =
  "exec" | "shell" | "logs" | "files" | (string & Record<never, never>);

/** Judges that the operation is one of the fixed set. Throws a `TypeError`. */
export function validateWorkloadSessionOperation(
  operation: WorkloadSessionOperation,
): void {
  switch (operation) {
    case "exec":
    case "shell":
    case "logs":
    case "files":
      return;
    case "":
      throw new TypeError("operation is required");
    default:
      throw new TypeError("unsupported operation");
  }
}

/**
 * How a session's client attaches. A Computer session attaches with
 * `endpoint`: to the Computer's own session endpoint, over the client's
 * end-to-end encrypted Computer connection, and no other attachment is
 * offered for Computers. The union is open.
 */
export type WorkloadSessionAttachmentKind =
  "endpoint" | (string & Record<never, never>);

/**
 * A shell request selects the exact shell executable. A command runs with
 * the same executable and `-c`.
 */
export interface WorkloadSessionShellRequest {
  readonly executable: string;
}

/** The wire shape of a shell arm. */
export const shellRequestShape: Shape<WorkloadSessionShellRequest> =
  object<WorkloadSessionShellRequest>({
    executable: always(string()),
  });

/**
 * Judges a shell executable path as `validateShellPath` does, naming the
 * field `shell.executable`. Throws a `TypeError`.
 */
export function validateShellExecutable(executable: string): void {
  try {
    validateShellPath(executable);
  } catch (cause) {
    throw new TypeError(`shell.executable ${errorMessage(cause)}`, { cause });
  }
}

/** The terminal types a terminal profile may name. */
const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  "ansi",
  "linux",
  "screen",
  "screen-256color",
  "vt100",
  "xterm",
  "xterm-256color",
]);

/**
 * The allowlisted terminal properties a session applies to its process.
 * There is no arbitrary environment: only these fixed properties cross the
 * session boundary. Dimensions are counts; `undefined` and zero state none.
 */
export interface WorkloadSessionTerminalProfile {
  readonly stdin?: boolean;
  /** One of `ansi`, `linux`, `screen`, `screen-256color`, `vt100`, `xterm` or `xterm-256color`. */
  readonly type: string;
  readonly rows?: number;
  readonly columns?: number;
  readonly pixelWidth?: number;
  readonly pixelHeight?: number;
  /**
   * `C`, `POSIX` or `C.UTF-8`, or 2 to 24 characters: two letters, then
   * letters, digits, `_`, `-` or `.`. `undefined` or empty states none.
   */
  readonly locale?: string;
}

/**
 * Judges a terminal profile: a type on the allowlist, non-negative rows and
 * columns stated together, non-negative pixel dimensions stated together
 * and only with character dimensions, and a well-formed locale. Throws a
 * `TypeError`.
 */
export function validateWorkloadSessionTerminalProfile(
  profile: WorkloadSessionTerminalProfile,
): void {
  if (profile.type === "") throw new TypeError("terminal.type is required");
  if (!TERMINAL_TYPES.has(profile.type)) {
    throw new TypeError("unsupported terminal.type");
  }
  const rows = profile.rows ?? 0;
  const columns = profile.columns ?? 0;
  const pixelWidth = profile.pixelWidth ?? 0;
  const pixelHeight = profile.pixelHeight ?? 0;
  if (rows < 0 || columns < 0) {
    throw new TypeError("terminal rows and columns must be non-negative");
  }
  if ((rows === 0) !== (columns === 0)) {
    throw new TypeError("terminal rows and columns must be provided together");
  }
  if (pixelWidth < 0 || pixelHeight < 0) {
    throw new TypeError("terminal pixel dimensions must be non-negative");
  }
  if ((pixelWidth === 0) !== (pixelHeight === 0)) {
    throw new TypeError("terminal pixel dimensions must be provided together");
  }
  if (pixelWidth > 0 && rows === 0) {
    throw new TypeError(
      "terminal character dimensions are required with pixel dimensions",
    );
  }
  const locale = profile.locale ?? "";
  if (locale === "" || ["C", "POSIX", "C.UTF-8"].includes(locale)) return;
  if (!/^[A-Za-z]{2}[A-Za-z0-9_.-]{0,22}$/u.test(locale)) {
    throw new TypeError("terminal.locale is invalid");
  }
}
