// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@idyl-sh/sdk/computer-connection": new URL(
        "./src/computer-connection/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});
