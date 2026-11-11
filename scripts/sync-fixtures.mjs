// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// Vendors the golden fixtures of IDYL's reference contract that this package
// implements, at the commit named in CONTRACT_REVISION, and records their
// digests in test/conformance/MANIFEST.json.
//
//   node scripts/sync-fixtures.mjs <contract-checkout>
//       refresh the selected fixtures from a local checkout of the reference
//       contract that holds the commit, and rewrite the manifest
//   node scripts/sync-fixtures.mjs --verify
//       recompute every digest and compare it with the manifest; needs no
//       checkout and no network
//
// The revision and the vendored set change together: a revision bump is a
// contract change, and the manifest is what lets every check prove the two
// still agree. A fixture is selected when its path matches one of SELECTED
// and none of EXCLUDED; a fixture of a kind or field the package does not
// carry is never vendored.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const revisionFile = join(repository, "CONTRACT_REVISION");
const fixturesDir = join(repository, "test", "conformance", "fixtures");
const manifestFile = join(repository, "test", "conformance", "MANIFEST.json");

/** The fixtures the package implements, by path in the contract tree. */
export const SELECTED = [
  /^api\/testdata\/golden\/billing(?:-plan-change|-portal-session|-purchase|-purchases)?\.[a-z0-9-]+\.json$/u,
  /^api\/testdata\/golden\/(?:commit|file|files|files-watch|restore|upload|upload-replaced|version)\.[a-z0-9-]+\.json$/u,
  /^api\/testdata\/golden\/computer(?:-awake|-cell|-images|-journal|-notebook|-operation|-secrets|-session|-sessions|-sizes|-sleep|-wake)?\.[a-z0-9-]+\.json$/u,
  /^api\/testdata\/golden\/computers\.by-secret(?:-empty)?\.json$/u,
  /^api\/testdata\/golden\/journal\.(?:computer-to-computer|copied|repeated-copy|version)-[a-z0-9-]+\.json$/u,
  /^api\/testdata\/golden\/namespace\.[a-z0-9-]+\.json$/u,
  /^api\/testdata\/golden\/network\.[a-z0-9-]+\.json$/u,
  /^api\/testdata\/golden\/signup-offer\.[a-z0-9-]+\.json$/u,
  /^resource\/testdata\/golden\/(?:computer\.execution|micropod\.network)-refusals\.json$/u,
  /^resource\/testdata\/golden\/(?:redacted)?secret\.[a-z0-9-]+\.json$/u,
];

/**
 * Selected paths that carry a kind or field the package leaves out, or that
 * mix such cases into one list.
 */
export const EXCLUDED = [
  /\/commit\.retrying\.json$/u,
  /\/computer\.actor-owned\.json$/u,
  /\/computer\.storage-(?:full|zero)\.json$/u,
  /\/computer-journal\.(?:newer-values|refusals)\.json$/u,
  /\/computer-session\.interrupt-request\.json$/u,
  /\/journal\.copied-cell-(?:outside-save|unsettled-save|zero-version)\.json$/u,
];

/**
 * Whether a contract path is vendored.
 * @param {string} path
 */
export function isSelected(path) {
  return (
    SELECTED.some((pattern) => pattern.test(path)) &&
    !EXCLUDED.some((pattern) => pattern.test(path))
  );
}

/** @returns {string} */
function readRevision() {
  const revision = readFileSync(revisionFile, "utf8").trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error(
      "CONTRACT_REVISION must hold one full lowercase commit SHA",
    );
  }
  return revision;
}

/**
 * Lists every file beneath `dir` as a sorted, slash-separated path relative
 * to `dir`.
 * @param {string} dir
 * @param {string} prefix
 * @returns {string[]}
 */
function listFiles(dir, prefix = "") {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(join(dir, entry.name), relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

/**
 * @param {string} revision
 * @returns {{ revision: string, files: Record<string, string> }}
 */
function computeManifest(revision) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const relativePath of listFiles(fixturesDir)) {
    files[relativePath] = createHash("sha256")
      .update(readFileSync(join(fixturesDir, relativePath)))
      .digest("hex");
  }
  return { revision, files };
}

/** @param {string} source */
function sync(source) {
  const revision = readRevision();
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync("git", ["-C", source, ...args], {
      maxBuffer: 256 * 1024 * 1024,
    });
  git(["cat-file", "-e", `${revision}^{commit}`]);
  const selected = git([
    "ls-tree",
    "-r",
    "--name-only",
    revision,
    "api/testdata",
    "resource/testdata",
  ])
    .toString("utf8")
    .split("\n")
    .filter(isSelected)
    .sort();
  rmSync(fixturesDir, { recursive: true, force: true });
  for (const path of selected) {
    const target = join(fixturesDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git(["show", `${revision}:${path}`]));
  }
  const manifest = computeManifest(revision);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `fixtures: ${String(selected.length)} files vendored at ${revision}`,
  );
}

function verify() {
  const revision = readRevision();
  /** @type {{ revision: string, files: Record<string, string> }} */
  const recorded = JSON.parse(readFileSync(manifestFile, "utf8"));
  /** @type {string[]} */
  const problems = [];
  if (recorded.revision !== revision) {
    problems.push(
      `manifest revision ${recorded.revision} differs from CONTRACT_REVISION ${revision}`,
    );
  }
  const actual = computeManifest(revision).files;
  for (const [relativePath, digest] of Object.entries(recorded.files)) {
    const found = actual[relativePath];
    if (found === undefined) {
      problems.push(`missing fixture ${relativePath}`);
    } else if (found !== digest) {
      problems.push(`modified fixture ${relativePath}`);
    }
  }
  for (const relativePath of Object.keys(actual)) {
    if (!(relativePath in recorded.files)) {
      problems.push(`unrecorded fixture ${relativePath}`);
    } else if (!isSelected(relativePath)) {
      problems.push(`fixture ${relativePath} is not selected`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(
    `fixtures: ${String(Object.keys(recorded.files).length)} files verified at ${revision}`,
  );
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  const [argument] = process.argv.slice(2);
  if (argument === "--verify") {
    verify();
  } else if (argument !== undefined && argument !== "") {
    sync(resolve(argument));
  } else {
    console.error(
      "usage: sync-fixtures.mjs <contract-checkout> | sync-fixtures.mjs --verify",
    );
    process.exit(2);
  }
}
