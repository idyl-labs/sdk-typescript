// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    platform: "neutral",
    // Loaded on a program's first command: never part of the client's build.
    external: ["@idyl-sh/sdk/computer-connection"],
    target: "es2022",
    sourcemap: true,
    // Each build cleans only its own outputs: the two run at once.
    clean: ["index.*"],
    treeshake: true,
    splitting: false,
    minify: false,
  },
  // The Computer connection Worker, with its WebAssembly beside it. Built
  // from wasm/ by `pnpm build:wasm`; only pages that run a connector load
  // either.
  {
    entry: { "computer-connection": "src/computer-connection/index.ts" },
    format: ["esm"],
    dts: true,
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    clean: ["computer-connection.*"],
    treeshake: true,
    splitting: false,
    minify: false,
    onSuccess: "node scripts/copy-wasm.mjs",
  },
]);
