// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  decodeComputer,
  encodeComputer,
  validateComputerPhase,
  type Computer,
} from "../src/api/computer.js";
import {
  ERROR_CODE_NAMESPACE_TERMINATING,
  decodeNamespace,
  encodeNamespace,
  validateNamespacePhase,
  type Namespace,
} from "../src/api/namespace.js";
import { parseAccountId } from "../src/resource/id.js";
import { parseNamespaceId, parseComputerId } from "../src/resource/uuid-id.js";
import { accountId as testAccount } from "./fakes/fetch-queue.js";

const accountId = parseAccountId(testAccount);

const namespace: Namespace = {
  id: parseNamespaceId("01954e20-7540-7ec4-93ec-14f783e6ab06"),
  accountId,
  name: "production",
  description: "Production services",
  phase: "active",
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-01-02T04:05:06Z",
};

const computer: Computer = {
  id: parseComputerId("01954e20-7540-7ec4-93ec-14f783e6ab04"),
  accountId,
  namespaceId: namespace.id,
  namespace: "production",
  subnet: "550000000002",
  name: "payments",
  phase: "active",
  execution: "dormant",
  headVersion: 0,
  spec: { idleTimeout: "300s" },
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-01-02T04:05:06Z",
};

describe("namespace and computer lifecycle contracts", () => {
  // Contract: a phase is read off a served object and carried whatever it
  // is; membership in the set this version names is validation's judgement,
  // and the empty string is a missing phase.
  it("judges the phase vocabularies", () => {
    for (const phase of ["active", "terminating"]) {
      expect(() => {
        validateNamespacePhase(phase);
      }).not.toThrow();
      expect(() => {
        validateComputerPhase(phase);
      }).not.toThrow();
    }
    expect(() => {
      validateNamespacePhase("");
    }).toThrow(new TypeError("namespace phase is required"));
    expect(() => {
      validateNamespacePhase("Active");
    }).toThrow(new TypeError('unknown namespace phase "Active"'));
    expect(() => {
      validateComputerPhase("");
    }).toThrow(new TypeError("computer phase is required"));
    expect(() => {
      validateComputerPhase("archived");
    }).toThrow(new TypeError('unknown computer phase "archived"'));
    const carried = JSON.parse(
      JSON.stringify({ ...namespace, phase: "archived" }),
    ) as Namespace;
    expect(carried.phase).toBe("archived");
    expect(encodeNamespace(carried)["phase"]).toBe("archived");
  });

  // Contract: an active object writes its phase and nothing else of the
  // lifecycle block: the terminating instant and the termination detail
  // exist only while terminating. A Computer always writes its execution
  // state and its head version, zero included.
  it("emits the phase and no termination while active", () => {
    const encoded = encodeNamespace(namespace);
    expect(encoded["phase"]).toBe("active");
    expect(encoded).not.toHaveProperty("terminatingAt");
    expect(encoded).not.toHaveProperty("termination");
    expect(encoded).not.toHaveProperty("deletedAt");
    const encodedComputer = encodeComputer(computer);
    expect(encodedComputer["phase"]).toBe("active");
    expect(encodedComputer).not.toHaveProperty("terminatingAt");
    expect(encodedComputer["execution"]).toBe("dormant");
    expect(encodedComputer["headVersion"]).toBe(0);
  });

  // Contract: counts are readings and the arrays the platform emits empty
  // stay arrays: a zero count is written as zero and an empty list as [],
  // never dropped and never null.
  it("round-trips termination counts and empty arrays", () => {
    for (const wire of [
      '{"computersRemaining":0,"zones":[]}',
      '{"computersRemaining":2,"zones":[{"zone":"zone-a","acknowledged":true,"remaining":[]}]}',
      '{"computersRemaining":0,"zones":[{"zone":"zone-a","acknowledged":false,"remaining":[{"kind":"Pod","count":0}]}]}',
    ]) {
      const termination = JSON.parse(wire) as Namespace["termination"];
      const encoded = encodeNamespace({
        ...namespace,
        phase: "terminating",
        terminatingAt: "2026-01-02T05:06:07Z",
        ...(termination === undefined ? {} : { termination }),
      });
      expect(JSON.stringify(encoded["termination"])).toBe(wire);
      expect(encoded["terminatingAt"]).toBe("2026-01-02T05:06:07Z");
    }
  });

  // Contract: a kind the platform reports that this version does not name
  // is carried as reported; the count field does not judge the vocabulary.
  it("carries an unknown remaining kind", () => {
    const encoded = encodeNamespace({
      ...namespace,
      phase: "terminating",
      termination: {
        computersRemaining: 0,
        zones: [
          {
            zone: "zone-a",
            acknowledged: true,
            remaining: [{ kind: "StatefulSet", count: 1 }],
          },
        ],
      },
    });
    expect(encoded["termination"]).toEqual({
      computersRemaining: 0,
      zones: [
        {
          zone: "zone-a",
          acknowledged: true,
          remaining: [{ kind: "StatefulSet", count: 1 }],
        },
      ],
    });
  });

  // Contract: a served object is read leniently: a field this SDK does not
  // declare is carried, a missing field reads as its zero value, an
  // unreadable value is carried as it arrived, and text is parsed once; only
  // a document that is not an object is refused.
  it("reads served objects leniently", () => {
    const read = decodeNamespace(
      JSON.stringify({ ...namespace, newerField: true, createdAt: 12 }),
    ) as Namespace & { readonly newerField?: boolean };
    expect(read.newerField).toBe(true);
    expect(read.name).toBe("production");
    expect(read.createdAt).toBe(12);
    const sparse = decodeNamespace({ name: "production", phase: "active" });
    expect(sparse.description).toBe("");
    expect(sparse.accountId).toBe("");
    expect(sparse.termination).toBeUndefined();
    const computerRead = decodeComputer({ ...computer, extra: [1] });
    expect(computerRead).toEqual({ ...computer, extra: [1] });
    expect(() => decodeNamespace("[]")).toThrow("document must be an object");
    expect(() => decodeComputer(null)).toThrow("document must be an object");
  });

  // Contract: the refusal code is a wire constant clients branch on.
  it("names the terminating refusal code", () => {
    expect(ERROR_CODE_NAMESPACE_TERMINATING).toBe("NAMESPACE_TERMINATING");
  });
});
