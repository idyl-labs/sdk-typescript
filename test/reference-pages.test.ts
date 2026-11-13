// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PAGES,
  SITE_FOLDER,
  renderReference,
  writeReference,
} from "../scripts/reference-pages.mjs";

/**
 * Names a page may show in inline code without being an export: the
 * language's and the web platform's own, and HTTP header names.
 */
const PLATFORM_NAMES = new Set([
  "AbortError",
  "AbortSignal",
  "ArrayBuffer",
  "AsyncIterable",
  "Authorization",
  "Bearer",
  "Blob",
  "CryptoKey",
  "CryptoKeyPair",
  "DOMException",
  "Error",
  "File",
  "IndexedDB",
  "MessagePort",
  "Number",
  "Promise",
  "Readonly",
  "ReadableStream",
  "Record",
  "Response",
  "Small",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "Uint8Array",
  "WebAssembly",
  "WebSocket",
  "Worker",
]);

const version = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

let reference: ReturnType<typeof renderReference>;

beforeAll(() => {
  reference = renderReference();
}, 60_000);

describe("reference pages", () => {
  // Contract: the doc comments document every public member, parameter and
  // page example, so the pages hold no empty entry.
  it("leaves no gap in the doc comments", () => {
    expect(reference.gaps).toEqual([]);
  });

  // Contract: there is one page per entry of PAGES, in that order.
  it("writes one page per area, in navigation order", () => {
    expect(reference.pages.map((page) => page.slug)).toEqual(
      PAGES.map((page) => page.slug),
    );
  });

  // Contract: every export of both entry points has an entry on its page,
  // headed by its name.
  it("gives every export an entry on its page", () => {
    for (const entry of reference.exports) {
      const slug = reference.homes.get(entry.name);
      const page = reference.pages.find((item) => item.slug === slug);
      expect(page, entry.name).toBeDefined();
      const subject = PAGES.find((spec) => spec.slug === slug)?.subject;
      if (entry.name === subject) continue;
      expect(page?.text, entry.name).toMatch(
        new RegExp(`^### ${entry.name}$`, "mu"),
      );
    }
  });

  // Contract: a heading names an export, a member of one, or a section;
  // nothing the entry points do not export gets an entry.
  it("heads entries only with exported names", () => {
    const exported = new Set(reference.exports.map((entry) => entry.name));
    for (const page of reference.pages) {
      const subject = reference.exports.find(
        (entry) =>
          entry.name === PAGES.find((spec) => spec.slug === page.slug)?.subject,
      );
      const members = new Set(subject?.symbol.members?.keys() ?? []);
      for (const [, level, heading = ""] of page.text.matchAll(
        /^(#{3,4}) (.+)$/gmu,
      )) {
        const name = heading.split(/[. ]/u)[0] ?? "";
        const allowed =
          exported.has(name) || (level === "###" && members.has(name));
        expect(allowed, `${page.slug}: ${heading}`).toBe(true);
      }
    }
  });

  // Contract: descriptions name in code only exports and platform names, so
  // no internal type is described on a page. Signatures and type columns
  // show types as the published declarations write them.
  it("names no internal type in prose", () => {
    const exported = new Set(reference.exports.map((entry) => entry.name));
    for (const page of reference.pages) {
      const prose = page.text
        .replace(/^```[\s\S]*?^```$/gmu, "")
        .split("\n")
        .map((line) =>
          line.startsWith("|")
            ? line
                .split(/(?<!\\)\|/u)
                .filter(
                  (cell) => !/^\s*\[?`[^`]*`\]?(?:\([^)]*\))?\s*$/u.test(cell),
                )
                .join("|")
            : line,
        )
        .join("\n");
      for (const [, name = ""] of prose.matchAll(
        /`([A-Z][A-Za-z0-9]*)(?:[.<([][^`]*)?`/gu,
      )) {
        if (/^[A-Z0-9_]+$/u.test(name)) continue;
        expect(
          exported.has(name) || PLATFORM_NAMES.has(name),
          `${page.slug}: ${name}`,
        ).toBe(true);
      }
    }
  });

  // Contract: every page states the package version it was written from
  // and carries one example.
  it("states the version and carries an example on every page", () => {
    for (const page of reference.pages) {
      expect(page.text, page.slug).toContain(`Version ${version} of `);
      expect(page.text, page.slug).toMatch(/^```ts$/mu);
    }
  });

  // Contract: the pages are a function of the source; two runs agree byte
  // for byte, so the site's check can compare hashes.
  it("renders the same pages on every run", () => {
    const again = renderReference();
    expect(again.pages).toEqual(reference.pages);
  }, 60_000);
});

describe("writeReference", () => {
  let site: string;

  beforeAll(() => {
    site = mkdtempSync(join(tmpdir(), "reference-pages-"));
    writeFileSync(join(site, "docs.json"), "{}\n");
  });

  afterAll(() => {
    rmSync(site, { recursive: true, force: true });
  });

  // Contract: the manifest lists each page in order with the SHA-256 of
  // the bytes written, and the page of every export.
  it("writes the pages and a manifest of their hashes", () => {
    writeReference(site);
    const manifest = JSON.parse(
      readFileSync(join(site, SITE_FOLDER, "manifest.json"), "utf8"),
    ) as {
      version: string;
      pages: { page: string; sha256: string }[];
      exports: Record<string, { page: string }>;
    };
    expect(manifest.version).toBe(version);
    expect(manifest.pages.map((page) => page.page)).toEqual(
      PAGES.map((page) => `${SITE_FOLDER}/${page.slug}`),
    );
    for (const page of manifest.pages) {
      const bytes = readFileSync(join(site, `${page.page}.mdx`));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        page.sha256,
      );
    }
    expect(Object.keys(manifest.exports).sort()).toEqual(
      reference.exports.map((entry) => entry.name).sort(),
    );
  }, 60_000);

  // Contract: a run replaces the folder, so a page the reference drops
  // leaves the site.
  it("removes a page the run does not write", () => {
    const stale = join(site, SITE_FOLDER, "stale.mdx");
    writeFileSync(stale, "---\ntitle: stale\n---\n");
    writeReference(site);
    expect(() => readFileSync(stale)).toThrow();
  }, 60_000);

  // Contract: the run writes only into a site checkout.
  it("refuses a folder that is not a site checkout", () => {
    const empty = mkdtempSync(join(tmpdir(), "reference-pages-"));
    try {
      expect(() => writeReference(empty)).toThrow(/not a site checkout/u);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
