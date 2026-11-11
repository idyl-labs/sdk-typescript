// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * The package version, kept equal to `package.json` by test. It is the only
 * place the version is spelled in source.
 */
export const SDK_VERSION = "0.1.0";

/** The `User-Agent` sent when a client does not override it. */
export const DEFAULT_USER_AGENT = `idyl-sdk-typescript/${SDK_VERSION}`;
