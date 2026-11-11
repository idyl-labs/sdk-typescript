// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * The goldens under `api/testdata/golden` whose kinds have no served codec,
 * named by file. A file leaves this list only when its kind enters the
 * served registry; the suite fails if the two disagree with the fixtures on
 * disk.
 */
export const pendingServedFiles: readonly string[] = [];
