// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { decodeValue } from "../../src/internal/strictdecode.js";
import { validateMicropodNetwork } from "../../src/resource/micropod-network.js";
import {
  ComputerExecutionSettingsError,
  validateComputerExecutionSettings,
  computerExecutionSettingsShape,
} from "../../src/resource/computer-execution-settings.js";
import {
  secretSpecShape,
  validateSecretSpec,
} from "../../src/resource/secret.js";
import { workloadNetworkShape } from "../../src/resource/workload-network.js";
import { discoverRefusalGoldens, readFixture } from "./harness.js";

/** One entry of a refusal golden: a document, its refusal, and, when the contract names it, the refused field. */
interface Refusal {
  readonly case: string;
  readonly refusal: string;
  readonly field?: string;
  readonly value: unknown;
}

/**
 * The judgement of each resource refusal golden, keyed by file stem: the
 * value is read as its type is and validated, and must throw.
 */
const judges: ReadonlyMap<string, (value: unknown) => void> = new Map<
  string,
  (value: unknown) => void
>([
  [
    "micropod.network-refusals",
    (value) => {
      validateMicropodNetwork(decodeValue(value, workloadNetworkShape));
    },
  ],
  [
    "secret.egress-refusals",
    (value) => {
      validateSecretSpec(decodeValue(value, secretSpecShape));
    },
  ],
  [
    "computer.execution-refusals",
    (value) => {
      validateComputerExecutionSettings(
        decodeValue(value, computerExecutionSettingsShape),
      );
    },
  ],
]);

const goldens = discoverRefusalGoldens();

describe("resource refusal goldens", () => {
  // Contract: every refusal golden is judged; none is skipped silently, and
  // no judge names a golden that is gone.
  it("account for every refusal golden", () => {
    expect(
      goldens
        .filter((golden) => !judges.has(golden.key))
        .map((golden) => golden.key),
    ).toEqual([]);
    expect(
      [...judges.keys()].filter(
        (key) => !goldens.some((golden) => golden.key === key),
      ),
    ).toEqual([]);
  });

  for (const golden of goldens) {
    const judge = judges.get(golden.key);
    if (judge === undefined) continue;

    // Contract: every entry is refused with exactly the sentence the
    // reference contract refuses it with, and an entry that names its field is refused by a
    // ComputerExecutionSettingsError naming that field.
    it(`refuse each entry of ${golden.key}`, () => {
      const entries = readFixture(golden.file) as readonly Refusal[];
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        let refusal: unknown;
        try {
          judge(entry.value);
        } catch (error) {
          refusal = error;
        }
        expect(refusal, entry.case).toBeInstanceOf(TypeError);
        expect((refusal as Error).message, entry.case).toBe(entry.refusal);
        if (entry.field !== undefined) {
          expect(refusal, entry.case).toBeInstanceOf(
            ComputerExecutionSettingsError,
          );
          expect(
            (refusal as ComputerExecutionSettingsError).field,
            entry.case,
          ).toBe(entry.field);
        }
      }
    });
  }
});
