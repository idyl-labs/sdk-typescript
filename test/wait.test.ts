// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { type Computer } from "../src/api/computer.js";
import { type Namespace } from "../src/api/namespace.js";
import {
  evaluateNamespaceWait,
  evaluateComputerWait,
  type WaitCondition,
} from "../src/api/wait.js";
import { parseAccountId } from "../src/resource/id.js";
import { parseNamespaceId, parseComputerId } from "../src/resource/uuid-id.js";

const servedNamespace: Namespace = {
  id: parseNamespaceId("01954e20-7540-7ec4-93ec-14f783e6ab06"),
  accountId: parseAccountId("550000000001"),
  name: "production",
  description: "",
  phase: "active",
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-01-02T04:05:06Z",
};

const servedComputer: Computer = {
  id: parseComputerId("01954e20-7540-7ec4-93ec-14f783e6ab04"),
  accountId: parseAccountId("550000000001"),
  namespaceId: servedNamespace.id,
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

describe("evaluateNamespaceWait", () => {
  const reportedAt = "2026-01-02T03:04:05Z";
  // Contract: a Namespace that can still be read has not been deleted, so
  // every phase is pending; a terminating one names the Computers still to
  // finalize and then every zone holdout, in the platform's order.
  const cases: readonly {
    readonly name: string;
    readonly namespace: Namespace;
    readonly message: string;
  }[] = [
    {
      name: "active is pending and not terminating",
      namespace: servedNamespace,
      message: "namespace production is not terminating",
    },
    {
      name: "terminating names computers then every zone holdout",
      namespace: {
        ...servedNamespace,
        phase: "terminating",
        termination: {
          computersRemaining: 1,
          zones: [
            {
              zone: "zone-a",
              acknowledged: true,
              reportedAt,
              remaining: [
                { kind: "Pod", count: 2 },
                { kind: "Service", count: 1 },
                { kind: "Secret", count: 0 },
              ],
            },
            { zone: "zone-b", acknowledged: false, remaining: [] },
            { zone: "zone-c", acknowledged: true, reportedAt, remaining: [] },
          ],
        },
      },
      message:
        "namespace production is terminating: 1 computer remaining; zone-a: Pod 2, Service 1; zone-b unacknowledged",
    },
    {
      name: "terminating pluralizes computers",
      namespace: {
        ...servedNamespace,
        phase: "terminating",
        termination: { computersRemaining: 3, zones: [] },
      },
      message: "namespace production is terminating: 3 computers remaining",
    },
    {
      name: "terminating with every zone drained awaits finalization",
      namespace: {
        ...servedNamespace,
        phase: "terminating",
        termination: {
          computersRemaining: 0,
          zones: [
            {
              zone: "zone-a",
              acknowledged: true,
              reportedAt,
              remaining: [{ kind: "Pod", count: 0 }],
            },
          ],
        },
      },
      message: "namespace production is terminating: awaiting finalization",
    },
    {
      name: "terminating without detail awaits finalization",
      namespace: { ...servedNamespace, phase: "terminating" },
      message: "namespace production is terminating: awaiting finalization",
    },
    {
      name: "a phase this version does not name is still pending",
      namespace: { ...servedNamespace, phase: "archived" },
      message: 'namespace production still exists in phase "archived"',
    },
  ];
  for (const { name, namespace, message } of cases) {
    it(name, () => {
      expect(evaluateNamespaceWait(namespace, "deleted")).toEqual({
        state: "pending",
        message,
      });
    });
  }
});

describe("evaluateComputerWait", () => {
  // Contract: a Computer is pending for every phase while it can be read, a terminating one awaiting
  // finalization.
  const cases: readonly {
    readonly name: string;
    readonly computer: Computer;
    readonly message: string;
  }[] = [
    {
      name: "active is pending and not terminating",
      computer: servedComputer,
      message: "computer payments is not terminating",
    },
    {
      name: "terminating awaits finalization",
      computer: {
        ...servedComputer,
        phase: "terminating",
        terminatingAt: "2026-01-02T05:06:07Z",
      },
      message: "computer payments is terminating: awaiting finalization",
    },
    {
      name: "a phase this version does not name is still pending",
      computer: { ...servedComputer, phase: "archived" },
      message: 'computer payments still exists in phase "archived"',
    },
  ];
  for (const { name, computer, message } of cases) {
    it(name, () => {
      expect(evaluateComputerWait(computer, "deleted")).toEqual({
        state: "pending",
        message,
      });
    });
  }

  // Contract: a Namespace and a Computer have exactly one wait condition.
  // Every other condition, named by this version or not, fails as
  // unsupported in one sentence.
  it("fails every other condition as unsupported for both kinds", () => {
    for (const condition of ["started", "ready", "complete", "available"]) {
      expect(
        evaluateNamespaceWait(servedNamespace, condition as WaitCondition),
      ).toEqual({
        state: "failed",
        message: `condition ${JSON.stringify(condition)} is not supported for Namespace`,
      });
      expect(
        evaluateComputerWait(servedComputer, condition as WaitCondition),
      ).toEqual({
        state: "failed",
        message: `condition ${JSON.stringify(condition)} is not supported for Computer`,
      });
    }
  });
});
