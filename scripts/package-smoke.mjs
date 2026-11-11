// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// Proves the packed tarball is what a consumer receives: it checks the
// archive holds only the published files and source maps that name no
// absolute path, installs it into a temporary project with npm, imports it as
// ESM and as CommonJS, refuses a deep import of an internal module, compiles
// a TypeScript consumer against the installed declarations under two module
// resolutions, and runs publint and @arethetypeswrong/cli on the archive.
//
// Run through `pnpm test:package`, which builds and packs first.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDirectory = join(repository, ".package-test");
const binDirectory = join(repository, "node_modules", ".bin");
const manifest = JSON.parse(
  readFileSync(join(repository, "package.json"), "utf8"),
);
const packageName = manifest.name;

if (!existsSync(packageDirectory)) {
  throw new Error("run `pnpm test:package`, which packs the archive first");
}
const archiveName = readdirSync(packageDirectory).find((name) =>
  name.endsWith(".tgz"),
);
if (archiveName === undefined) {
  throw new Error("pnpm pack did not produce an archive");
}
const archive = join(packageDirectory, archiveName);

/** The files a published archive may hold, beside `package.json`. */
const published = [
  /^dist\/index\.(?:js|cjs|d\.ts|d\.cts)$/u,
  /^dist\/index\.(?:js|cjs)\.map$/u,
  // The Computer connection Worker: an ES module, its declarations and
  // source map, and the WebAssembly it runs.
  /^dist\/computer-connection\.(?:js|d\.ts|js\.map|wasm)$/u,
  /^(?:README\.md|LICENSE|CHANGELOG\.md)$/u,
];

/** What a consumer runs as an ES module. */
const esmConsumer = `
  import * as sdk from ${JSON.stringify(packageName)};
  if (typeof sdk !== "object") throw new Error("ESM import is wrong");
  const key = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const credential = sdk.staticCredential("example-token", key);
  if (typeof new sdk.Idyl({ credential }).computers.list !== "function") {
    throw new Error("ESM client is wrong");
  }
  // A program's first command loads the connection and its WebAssembly from
  // beside the package's own files.
  const connection = await import(${JSON.stringify(`${packageName}/computer-connection`)});
  const { worker, module } = await connection.connectInThisThread();
  if (typeof worker.postMessage !== "function" || !(module instanceof WebAssembly.Module)) {
    throw new Error("the connection did not load in this thread");
  }
  try {
    await import(${JSON.stringify(`${packageName}/internal/transport`)});
    throw new Error("an internal module is reachable through the package");
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
`;

/** What a consumer runs as CommonJS. */
const cjsConsumer = `
  const sdk = require(${JSON.stringify(packageName)});
  if (typeof sdk !== "object") throw new Error("CommonJS require is wrong");
  if (!(new sdk.Idyl() instanceof sdk.Idyl)) {
    throw new Error("CommonJS client is wrong");
  }
`;

/** What a TypeScript consumer compiles against the declarations. */
const typeScriptConsumer = `
  import * as sdk from ${JSON.stringify(packageName)};
  import { Idyl, type IdylOptions } from ${JSON.stringify(packageName)};
  export const surface: object = sdk;
  declare const key: CryptoKeyPair;
  const options: IdylOptions = {
    credential: sdk.credentialSourceFunc(async ({ signal }) => ({ accessToken: signal.aborted ? "" : "example-token", key })),
  };
  export const client: Idyl = new Idyl(options);
`;

/**
 * @param {string} file
 * @param {string[]} args
 * @param {string} cwd
 */
function run(file, args, cwd) {
  try {
    return execFileSync(file, args, { cwd, stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    const detail = /** @type {{ stdout?: string, stderr?: string }} */ (error);
    process.stderr.write(detail.stdout ?? "");
    process.stderr.write(detail.stderr ?? "");
    throw new Error(`${file} ${args.join(" ")} failed`, { cause: error });
  }
}

const temporary = mkdtempSync(join(tmpdir(), "idyl-sdk-package-"));
try {
  const contents = join(temporary, "contents");
  mkdirSync(contents);
  run("tar", ["-xzf", archive, "-C", contents], temporary);
  const root = join(contents, "package");
  const unexpected = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .filter((path) => path !== "package.json")
    .filter((path) => !published.some((pattern) => pattern.test(path)));
  if (unexpected.length > 0) {
    throw new Error(
      `the archive holds unexpected files: ${unexpected.join(", ")}`,
    );
  }
  for (const map of ["dist/index.js.map", "dist/index.cjs.map"]) {
    /** @type {{ sources: string[] }} */
    const sourceMap = JSON.parse(readFileSync(join(root, map), "utf8"));
    const outside = sourceMap.sources.filter(
      (source) => !source.startsWith("../src/"),
    );
    if (outside.length > 0) {
      throw new Error(`${map} names sources outside src/`);
    }
  }

  const project = join(temporary, "project");
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive],
    project,
  );

  writeFileSync(join(project, "esm.mjs"), esmConsumer);
  run(process.execPath, [join(project, "esm.mjs")], project);

  writeFileSync(join(project, "cjs.cjs"), cjsConsumer);
  run(process.execPath, [join(project, "cjs.cjs")], project);

  writeFileSync(join(project, "consumer.ts"), typeScriptConsumer);
  const tsc = join(binDirectory, "tsc");
  for (const { module, moduleResolution } of [
    { module: "nodenext", moduleResolution: "nodenext" },
    { module: "esnext", moduleResolution: "bundler" },
  ]) {
    const config = join(project, `tsconfig.${moduleResolution}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          target: "es2022",
          lib: ["es2022", "dom"],
          types: [],
          module,
          moduleResolution,
        },
        files: ["consumer.ts"],
      }),
    );
    run(tsc, ["-p", config], project);
  }

  process.stdout.write(
    run(
      join(binDirectory, "publint"),
      ["run", "--strict", archive],
      repository,
    ),
  );
  // The main entry under every resolution; the Computer connection Worker,
  // an ES module for browsers, under the ES module ones. Its WebAssembly is
  // an asset with no types.
  process.stdout.write(
    run(
      join(binDirectory, "attw"),
      [
        archive,
        "--no-emoji",
        "--exclude-entrypoints",
        "./computer-connection",
        "./computer-connection.wasm",
      ],
      repository,
    ),
  );
  process.stdout.write(
    run(
      join(binDirectory, "attw"),
      [
        archive,
        "--no-emoji",
        "--profile",
        "esm-only",
        "--entrypoints",
        "./computer-connection",
      ],
      repository,
    ),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
  rmSync(packageDirectory, { recursive: true, force: true });
}
console.log(
  `package: ${archiveName} holds only published files and imports as ESM, CommonJS, and TypeScript`,
);
