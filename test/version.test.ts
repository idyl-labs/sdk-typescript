// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT, SDK_VERSION } from "../src/internal/version.js";

describe("version", () => {
  // Contract: the version in source is the version in package.json, and the
  // default User-Agent carries it.
  it("matches package.json and shapes the user agent", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(SDK_VERSION).toBe(manifest.version);
    expect(DEFAULT_USER_AGENT).toBe(`idyl-sdk-typescript/${manifest.version}`);
  });

  // Contract: the package records the reference contract revision it
  // implements, and it is the revision the vendored goldens are pinned to.
  it("records the contract revision", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { idyl?: { contract?: string } };
    const revision = readFileSync(
      new URL("../CONTRACT_REVISION", import.meta.url),
      "utf8",
    ).trim();
    expect(manifest.idyl?.contract).toBe(revision);
  });
});
