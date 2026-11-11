// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// Copies the Computer connection's WebAssembly, built by `pnpm build:wasm`,
// into the package's dist/ beside its Worker module.
import { copyFileSync, existsSync } from "node:fs";

const source = new URL(
  "../wasm/pkg/computer_connection_bg.wasm",
  import.meta.url,
);
if (!existsSync(source)) {
  throw new Error(
    "wasm/pkg/computer_connection_bg.wasm is missing: run pnpm build:wasm first",
  );
}
copyFileSync(
  source,
  new URL("../dist/computer-connection.wasm", import.meta.url),
);
