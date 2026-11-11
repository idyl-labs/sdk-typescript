// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  discoverServedGoldens,
  readFixture,
  type ServedGolden,
} from "./harness.js";
import { pendingServedFiles } from "./served-pending.js";
import { servedRefusals, servedRegistry } from "./served-registry.js";
import { judgeBillingRefusal } from "./billing-registry.js";
import { stringifyJson } from "../../src/resource/json.js";

const goldens = discoverServedGoldens();

/**
 * The codec key of a JSON golden: its own `<kind>.<state>` when the
 * registry names a codec for that state, as a list page of a kind whose
 * other states are served objects; otherwise the harness's key.
 */
function keyOf(golden: ServedGolden): string {
  const state = `${golden.kind}.${golden.state}`;
  return servedRegistry.has(state) ? state : golden.key;
}
const registered = (key: string): boolean =>
  servedRegistry.has(key) ||
  servedRefusals.has(key) ||
  key === "billing.refusals";
const implemented = goldens.filter((golden) =>
  servedRegistry.has(keyOf(golden)),
);
const refusals = goldens.filter((golden) => servedRefusals.has(keyOf(golden)));
const pending = goldens
  .filter((golden) => !registered(keyOf(golden)))
  .map((golden) => golden.name);

/** One entry of a refusals fixture: a document and its refusal. */
interface Refusal {
  readonly case: string;
  readonly refusal: string;
  readonly value: unknown;
}

/** A field no served object declares, placed at the document root. */
const UNDECLARED = "fieldThisVersionDoesNotDeclare";

describe("served-object goldens", () => {
  beforeAll(() => {
    process.stdout.write(
      `served objects: ${String(implemented.length + refusals.length)} implemented, ${String(pending.length)} pending${pending.length === 0 ? "" : `: ${pending.join(", ")}`}\n`,
    );
  });

  // Contract: every vendored served-object golden is either implemented or
  // named as pending by file; a fixture can never be skipped silently, and
  // the pending list names only fixtures on disk.
  it("account for every served-object golden", () => {
    const unaccounted = goldens
      .filter((golden) => !registered(keyOf(golden)))
      .map((golden) => golden.name)
      .filter((name) => !pendingServedFiles.includes(name));
    expect(unaccounted).toEqual([]);
    expect(
      pendingServedFiles.filter(
        (name) => !goldens.some((golden) => golden.name === name),
      ),
    ).toEqual([]);
    expect(
      pendingServedFiles.filter((name) =>
        [...implemented, ...refusals].some((golden) => golden.name === name),
      ),
    ).toEqual([]);
    expect(goldens.length).toBeGreaterThan(0);
  });

  for (const golden of implemented) {
    const codec = servedRegistry.get(keyOf(golden));
    if (codec === undefined) continue;

    // Contract: the golden is read leniently, from its text and from a
    // parsed value, and encodes back to the identical document, so what the
    // SDK emits for a served object is what the reference contract emits: the phase always,
    // the lifecycle block only while terminating, counts and empty arrays
    // always.
    it(`round-trip ${golden.name}`, () => {
      const text = readFileSync(golden.file, "utf8");
      const document = readFixture(golden.file);
      expect(codec.encode(codec.decode(text))).toEqual(document);
      expect(codec.encode(codec.decode(document))).toEqual(document);
    });

    // Contract: a lenient read carries a field this SDK does not declare,
    // because a read never refuses what the platform adds; the encoder
    // writes the fields the contract declares.
    it(`carry an undeclared field on a lenient read of ${golden.name}`, () => {
      const document = readFixture(golden.file) as Record<string, unknown>;
      const extended = { ...document, [UNDECLARED]: "x" };
      const read = codec.decode(stringifyJson(extended)) as Record<
        string,
        unknown
      >;
      expect(read[UNDECLARED]).toBe("x");
      expect(codec.encode(read)).toEqual(document);
    });

    // Contract: what the reference contract validates on the served object
    // holds for the golden.
    it(`validate ${golden.name}`, () => {
      expect(() => {
        codec.validate(codec.decode(readFixture(golden.file)));
      }).not.toThrow();
    });
  }

  for (const golden of refusals) {
    const codec = servedRefusals.get(keyOf(golden));
    if (codec === undefined) continue;

    // Contract: every refused document still reads, because a read carries
    // what it cannot judge, and encodes back to the document it was read
    // from; validation then refuses it with exactly the sentence the
    // reference contract refuses it with.
    it(`refuse each entry of ${golden.name}`, () => {
      const entries = readFixture(golden.file) as readonly Refusal[];
      expect(entries.length).toBeGreaterThan(0);
      const read = entries.map((entry) => ({
        ...entry,
        value: codec.encode(codec.decode(JSON.stringify(entry.value))),
      }));
      expect(read).toEqual(entries);
      for (const entry of entries) {
        let refusal: unknown;
        try {
          codec.validate(codec.decode(entry.value));
        } catch (error) {
          refusal = error;
        }
        expect(refusal, entry.case).toBeInstanceOf(TypeError);
        expect((refusal as Error).message, entry.case).toBe(entry.refusal);
      }
    });
  }
});

// Contract: each pinned billing refusal is a value of the type its case
// names that reads and writes back unchanged, and the validation owning
// that type refuses it with exactly the sentence the reference contract
// refuses it with. The fixture holds every case, so none is skipped
// silently.
const billingRefusalGolden = goldens.find(
  (golden) => golden.name === "billing.refusals.json",
);
describe("billing refusals", () => {
  it("are vendored", () => {
    expect(billingRefusalGolden).toBeDefined();
  });
  if (billingRefusalGolden !== undefined) {
    for (const item of readFixture(
      billingRefusalGolden.file,
    ) as readonly Refusal[]) {
      it(`billing refusal ${item.case}`, () => {
        const { written, refusal } = judgeBillingRefusal(item.value, item.case);
        expect(written).toEqual(item.value);
        expect(refusal).toBeInstanceOf(TypeError);
        expect((refusal as Error).message).toBe(item.refusal);
      });
    }
  }
});
