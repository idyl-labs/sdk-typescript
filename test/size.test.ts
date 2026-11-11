// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { BUDGET_BYTES, measure } from "../scripts/size.mjs";

describe("size budget", () => {
  // Contract: the budget is 70 kB minified and compressed for the whole
  // package.
  it("is 70 kB", () => {
    expect(BUDGET_BYTES).toBe(70_000);
  });

  // Contract: the measure is of minified output, so comments and whitespace
  // cost nothing.
  it("measures the minified, compressed module", async () => {
    const spacious = `/** documentation */\nexport const value    =    1;\n`;
    const dense = `export const value=1;`;
    expect(await measure(spacious)).toEqual(await measure(dense));
  });
});
