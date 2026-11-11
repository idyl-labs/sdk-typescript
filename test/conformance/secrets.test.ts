// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeText } from "../../src/internal/strictdecode.js";
import {
  decodeRedactedSecret,
  redactedSecretShape,
  secretShape,
  validateRedactedSecret,
  validateSecret,
} from "../../src/resource/secret.js";
import { discoverResourceGoldens, readFixture } from "./harness.js";

/**
 * The Secret goldens: `secret.*` is the document a write submits, read
 * through the strict decoder; `redactedsecret.*` is the document every read
 * returns, read leniently.
 */
const goldens = discoverResourceGoldens().filter(
  (golden) => golden.kind === "secret" || golden.kind === "redactedsecret",
);

describe("secret goldens", () => {
  // Contract: the vendored set holds both documents, so neither harness
  // passes by having nothing to judge.
  it("cover the submitted and the redacted document", () => {
    expect(goldens.filter((golden) => golden.kind === "secret").length).toBe(6);
    expect(
      goldens.filter((golden) => golden.kind === "redactedsecret").length,
    ).toBe(5);
  });

  for (const golden of goldens) {
    if (golden.kind === "secret") {
      // Contract: a submitted Secret strict-decodes from its text, validates,
      // and encodes back to exactly the golden.
      it(`round-trip and validate ${golden.key}`, () => {
        const text = readFileSync(golden.file, "utf8");
        const secret = decodeText(text, secretShape);
        expect(() => {
          validateSecret(secret);
        }).not.toThrow();
        expect(secretShape.encode(secret)).toEqual(readFixture(golden.file));
      });
    } else {
      // Contract: a redacted Secret reads leniently, validates, and encodes
      // back to exactly the golden.
      it(`round-trip and validate ${golden.key}`, () => {
        const secret = decodeRedactedSecret(readFileSync(golden.file, "utf8"));
        expect(() => {
          validateRedactedSecret(secret);
        }).not.toThrow();
        expect(redactedSecretShape.encode(secret)).toEqual(
          readFixture(golden.file),
        );
      });
    }
  }

  // Contract: a submission is strict, so a field the contract does not
  // declare is refused by its path rather than dropped.
  it("refuse an unknown field in a submitted secret", () => {
    const golden = goldens.find((g) => g.key === "secret.egress-minimal");
    expect(golden).toBeDefined();
    const document = readFixture(golden?.file ?? "") as {
      readonly spec: Readonly<Record<string, unknown>>;
    };
    const text = JSON.stringify({
      ...document,
      spec: { ...document.spec, mount: "/run/secret" },
    });
    expect(() => decodeText(text, secretShape)).toThrow(/spec\.mount/u);
  });

  // Contract: a read is lenient, so a health this package does not name is
  // carried, and only the validator refuses it.
  it("carry an unknown health on a read", () => {
    const golden = goldens.find((g) => g.key === "redactedsecret.egress");
    const document = readFixture(golden?.file ?? "") as Readonly<
      Record<string, unknown>
    >;
    const secret = decodeRedactedSecret({
      ...document,
      status: { state: "active", health: "rotating", resourceVersion: 4 },
    });
    expect(secret.status.health).toBe("rotating");
    expect(() => {
      validateRedactedSecret(secret);
    }).toThrow('status: unknown Vault resource health "rotating"');
  });
});
