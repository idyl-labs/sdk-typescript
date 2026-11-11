// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * What a caller needs to decide from a reason without knowing the reason:
 * whether to keep waiting, and whether anything it controls has to change.
 *
 * - `progressing`: the property is being worked toward; waiting is correct.
 * - `transient`: something is in the way that is expected to clear without
 *   intervention; waiting is still correct, waiting forever is not.
 * - `blocked`: the property will not be reached until something changes,
 *   such as the resource's own settings or the catalog it draws on;
 *   waiting will not help.
 * - `settled`: the resource is not pursuing the property at all, because it
 *   holds or because the resource is ending.
 */
export type ConditionReasonClass =
  "progressing" | "transient" | "blocked" | "settled";
