// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The README quickstart against the Network an access key names. Each case
// runs only when its access key is given, so the ordinary run and CI skip
// it and make no network call.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const program = fileURLToPath(new URL("./quickstart.mjs", import.meta.url));
const built = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

/** How long one run of the program may take, in milliseconds. */
const RUN_MS = 10 * 60 * 1000;

/** The access key kinds the package reads, and the variable holding each. */
const KEYS = [
  {
    kind: "Ed25519",
    article: "an",
    variable: "IDYL_QUICKSTART_ACCESS_KEY_ED25519",
  },
  { kind: "P-256", article: "a", variable: "IDYL_QUICKSTART_ACCESS_KEY_P256" },
] as const;

/** How a run of the program ended. */
interface Ran {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the program on the built package, with nothing in its environment
 * but `PATH`, the access key, the Computer's name and, when given, the
 * Network's trust keys.
 */
function run(accessKey: string, computer: string): Promise<Ran> {
  const trustKeys = process.env["IDYL_QUICKSTART_TRUST_KEYS"];
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    IDYL_ACCESS_KEY: accessKey,
    QUICKSTART_COMPUTER: computer,
    ...(trustKeys === undefined
      ? {}
      : { IDYL_QUICKSTART_TRUST_KEYS: trustKeys }),
  };
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [program],
      { cwd: repository, env, timeout: RUN_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : (error.code as number | null),
          timedOut: error?.killed === true,
          stdout,
          stderr,
        });
      },
    );
  });
}

describe("the quickstart against a Network", () => {
  for (const { kind, article, variable } of KEYS) {
    // Contract: a program that holds only an access key of this kind
    // creates a Computer, uploads a file, runs a command that reads it and
    // gets its output, deletes the Computer, and exits on its own.
    it(
      `runs with only ${article} ${kind} access key`,
      { timeout: RUN_MS + 30_000 },
      async ({ skip }) => {
        const accessKey = process.env[variable];
        if (accessKey === undefined || accessKey.trim() === "") {
          skip(
            `set ${variable} to the contents of ${article} ${kind} access key file to run the quickstart against its Network`,
          );
          return;
        }
        expect(existsSync(built), "build the package first").toBe(true);
        const suffix = crypto.randomUUID().slice(0, 8);
        const name = `quickstart-${kind.replace("-", "").toLowerCase()}-${suffix}`;

        const ran = await run(accessKey, name);

        expect(ran.timedOut, "the program did not exit in time").toBe(false);
        expect(ran.code, ran.stderr).toBe(0);
        const printed = ran.stdout.trim().split("\n").at(-1) ?? "";
        expect(JSON.parse(printed)).toEqual({ stdout: "passed 42\n" });
      },
    );
  }
});
