// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// Holds the built package to its size budget: the whole ES module build,
// every product on the client included, minified and compressed with gzip at
// level 9, must fit in 70 kB (70 000 bytes). The CommonJS build carries the
// same code and is not counted twice. The budget is a tripwire against
// accidental growth, set a little above the package's size: a change that
// crosses it raises it deliberately, in the same change, or cuts elsewhere.
//
// Run after `pnpm build`.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { transform } from "esbuild";

export const BUDGET_BYTES = 70_000;

/**
 * Returns the minified and compressed size of an ES module's source.
 * @param {string} source
 * @returns {Promise<{ minified: number, compressed: number }>}
 */
export async function measure(source) {
  const { code } = await transform(source, {
    format: "esm",
    minify: true,
    target: "es2022",
    legalComments: "none",
  });
  const minified = Buffer.byteLength(code);
  const compressed = gzipSync(code, { level: 9 }).byteLength;
  return { minified, compressed };
}

/** @param {number} bytes */
function kilobytes(bytes) {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  const entry = new URL("../dist/index.js", import.meta.url);
  let source;
  try {
    source = readFileSync(entry, "utf8");
  } catch (error) {
    throw new Error("dist/index.js is missing; run `pnpm build` first", {
      cause: error,
    });
  }
  const { minified, compressed } = await measure(source);
  const line = `size: ${kilobytes(compressed)} minified and compressed (${kilobytes(minified)} minified), budget ${kilobytes(BUDGET_BYTES)}`;
  if (compressed > BUDGET_BYTES) {
    console.error(`${line}: over budget`);
    process.exit(1);
  }
  console.log(line);
}
