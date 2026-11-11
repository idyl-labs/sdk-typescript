// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/** Computer list selection through `ListOptions.filter`. */
export type ComputerOwnerFilter =
  "unowned" | "all" | (string & Record<never, never>);

/**
 * Accepts the default and the named selectors; ordinary scope
 * authorization is still required. Throws a `TypeError`.
 */
export function validateComputerOwnerFilter(value: ComputerOwnerFilter): void {
  if (value === "" || value === "unowned" || value === "all") return;
  throw new TypeError("invalid computer owner filter");
}
