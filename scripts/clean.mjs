// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// Removes every directory the build and the gates write.
import { rmSync } from "node:fs";

for (const directory of ["dist", "coverage", ".package-test"]) {
  rmSync(new URL(`../${directory}`, import.meta.url), {
    recursive: true,
    force: true,
  });
}
