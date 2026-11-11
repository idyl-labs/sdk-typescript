// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/** The fewest characters a notebook name may hold. */
export const MIN_COMPUTER_NOTEBOOK_NAME_BYTES = 3;

/** The most characters a notebook name may hold. */
export const MAX_COMPUTER_NOTEBOOK_NAME_BYTES = 63;

/**
 * Judges a notebook name: {@link MIN_COMPUTER_NOTEBOOK_NAME_BYTES} to
 * {@link MAX_COMPUTER_NOTEBOOK_NAME_BYTES} lowercase ASCII letters, digits,
 * or `-`, starting with a letter, the rule a Computer's name follows. A
 * notebook's name is unique within its Computer. Throws a `TypeError`.
 */
export function validateComputerNotebookName(name: string): void {
  if (name === "") throw new TypeError("notebook name is required");
  if (name.length < MIN_COMPUTER_NOTEBOOK_NAME_BYTES) {
    throw new TypeError(
      `notebook name must be at least ${String(MIN_COMPUTER_NOTEBOOK_NAME_BYTES)} characters`,
    );
  }
  if (
    new TextEncoder().encode(name).byteLength > MAX_COMPUTER_NOTEBOOK_NAME_BYTES
  ) {
    throw new TypeError(
      `notebook name must not exceed ${String(MAX_COMPUTER_NOTEBOOK_NAME_BYTES)} characters`,
    );
  }
  for (let index = 0; index < name.length; index++) {
    const c = name.charCodeAt(index);
    if (c >= 0x61 && c <= 0x7a) continue;
    if ((c >= 0x30 && c <= 0x39) || c === 0x2d) {
      if (index === 0) {
        throw new TypeError("notebook name must start with a lowercase letter");
      }
      continue;
    }
    throw new TypeError(
      "notebook name must contain only lowercase letters, digits, or '-'",
    );
  }
}
