// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// Fails when package.json declares a runtime dependency of any kind. The SDK
// ships with none: every runtime capability it needs is a web-standard API.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const forbidden = ["dependencies", "peerDependencies", "optionalDependencies"];
const present = forbidden.filter((field) => field in manifest);
if (present.length > 0) {
  console.error(
    `${fileURLToPath(new URL("../package.json", import.meta.url))} declares ${present.join(", ")}; the SDK has no runtime dependencies`,
  );
  process.exit(1);
}
console.log("dependencies: none");
