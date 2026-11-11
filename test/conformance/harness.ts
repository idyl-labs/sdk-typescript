// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * Discovers the vendored fixtures of IDYL's reference contract. The goldens
 * are the wire: each served-object golden under `fixtures/api/testdata/golden`
 * is one document the platform emits or one request or response envelope of
 * a route, and each resource refusal golden under
 * `fixtures/resource/testdata/golden` is a list of values validation refuses.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "../../src/resource/json.js";

export const fixturesDir = fileURLToPath(
  new URL("./fixtures/", import.meta.url),
);
const goldenDir = join(fixturesDir, "resource", "testdata", "golden");
const servedGoldenDir = join(fixturesDir, "api", "testdata", "golden");

/** One resource refusal golden: its key, `<kind>.<name>`, and its file. */
export interface RefusalGolden {
  readonly kind: string;
  readonly key: string;
  readonly file: string;
}

/**
 * Every resource refusal golden, sorted by key. Each entry of one is a case,
 * the refusal sentence, and the value refused.
 */
export function discoverRefusalGoldens(): readonly RefusalGolden[] {
  return readdirSync(goldenDir)
    .sort()
    .filter((file) => /(?:^|[.-])refusals\.json$/u.test(file))
    .map((file) => {
      const key = file.replace(/\.json$/u, "");
      const kind = /^(?<kind>[a-z0-9]+)\./u.exec(file)?.groups?.["kind"];
      if (kind === undefined || !/(?:^|[.-])refusals\.json$/u.test(file)) {
        throw new Error(`unexpected refusal golden ${file}`);
      }
      return { kind, key, file: join(goldenDir, file) };
    });
}

/**
 * One resource document golden, `<kind>.<state>.json`: a document as a
 * write submits it or as a read returns it, under its kind's file name.
 */
export interface ResourceGolden {
  readonly kind: string;
  readonly key: string;
  readonly file: string;
}

/** Every resource document golden, refusal goldens excluded, sorted by key. */
export function discoverResourceGoldens(): readonly ResourceGolden[] {
  return readdirSync(goldenDir)
    .sort()
    .filter((file) => !/(?:^|[.-])refusals\.json$/u.test(file))
    .map((file) => {
      const key = file.replace(/\.json$/u, "");
      const kind = /^(?<kind>[a-z0-9]+)\./u.exec(file)?.groups?.["kind"];
      if (kind === undefined) {
        throw new Error(`unexpected resource golden ${file}`);
      }
      return { kind, key, file: join(goldenDir, file) };
    });
}

/** Reads one fixture as the JSON value it holds. */
export function readFixture(file: string): unknown {
  return parseJson(readFileSync(file, "utf8"));
}

/**
 * One golden under `fixtures/api/testdata/golden`, `<kind>.<state>.json`:
 * a document the platform emits for a resource in one lifecycle state, or
 * one request or response envelope of a route, whose state names it
 * (`update-request`, `list-page`). The kind is the fixture's own name, and
 * both parts may be hyphenated (`computer-session`, `notebook-busy`).
 *
 * `key` selects the codec: a served object's states share their kind's
 * codec, so its key is the kind; a request or response envelope has a shape
 * of its own, so its key is `<kind>.<state>` (`computer.update-request`).
 */
export interface ServedGolden {
  readonly kind: string;
  readonly state: string;
  readonly key: string;
  readonly file: string;
  /** The fixture's name relative to the golden directory. */
  readonly name: string;
}

/** Every served-object golden, sorted by file name. */
export function discoverServedGoldens(): readonly ServedGolden[] {
  return readdirSync(servedGoldenDir)
    .sort()
    .map((file) => {
      const match = /^(?<kind>[a-z0-9-]+)\.(?<state>[a-z0-9-]+)\.json$/u.exec(
        file,
      );
      const kind = match?.groups?.["kind"];
      const state = match?.groups?.["state"];
      if (kind === undefined || state === undefined) {
        throw new Error(`unexpected served-object fixture ${file}`);
      }
      const key =
        /-(?:request|response)$/u.test(state) || /(?:^|-)refusals$/u.test(state)
          ? `${kind}.${state}`
          : kind;
      return {
        kind,
        state,
        key,
        file: join(servedGoldenDir, file),
        name: file,
      };
    });
}
