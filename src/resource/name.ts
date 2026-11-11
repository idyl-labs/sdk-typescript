// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * The user-chosen identifier of a resource within its scope. It is the stable
 * handle other resources address each other by (service targets, port names,
 * container names); the platform-assigned IDs are the ones that change across
 * revisions, not the name.
 */
export type Name = string;
