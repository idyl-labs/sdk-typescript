// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeComputer, encodeComputer } from "../src/api/computer.js";
import {
  decodeListComputerSessionsResponse,
  validateComputerAwake,
  validateComputerSessionSummary,
  type ComputerAwake,
  type ComputerSessionSummary,
} from "../src/api/computer-awake.js";
import {
  decodeJournalEntry,
  validateJournalEntry,
  type JournalEntry,
} from "../src/api/journal.js";
import { parseEgressAllowRule } from "../src/resource/egress-allow-rule.js";
import { validateMicropodNetwork } from "../src/resource/micropod-network.js";
import { validateWorkloadNetworkEgressAllowRule } from "../src/resource/workload-network.js";
import { json } from "./fakes/control-plane.js";
import { FakeNetwork, computerRecord, computersPath } from "./fakes/network.js";

// A host in a private range, assembled at run time so this file never holds
// an address that could name an internal host.
const privateHost = [10, 1, 2, 3].join(".");

const ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const SESSION = "01954e20-7540-7ec4-93ec-14f783e6ab21";
const ENTRY = "01954e20-7540-7ec4-93ec-14f783e6ab3c";

const counting: ComputerAwake = {
  since: "2026-01-02T04:05:06Z",
  holds: [],
  sleepsAt: "2026-01-02T04:09:38Z",
  sleepsIn: 272,
};

const terminal: ComputerSessionSummary = {
  id: SESSION as ComputerSessionSummary["id"],
  kind: "terminal",
  client: "cli",
  openedBy: "developer@example.com",
  openedAt: "2026-01-02T03:05:41Z",
  yours: true,
};

const entry = (fields: Record<string, unknown>): JournalEntry =>
  decodeJournalEntry({
    id: ENTRY,
    seq: 2,
    admittedAt: "2026-01-02T03:05:41Z",
    ...fields,
  });

describe("why a Computer is awake", () => {
  // Contract: a Computer past its time reads sleepsIn zero and is valid; every
  // other shape the contract rules out is refused by name.
  it("judges an awake state", () => {
    expect(() => {
      validateComputerAwake(counting);
    }).not.toThrow();
    expect(() => {
      validateComputerAwake({ ...counting, sleepsIn: 0 });
    }).not.toThrow();
    const refused: readonly [ComputerAwake, string][] = [
      [{ ...counting, sleepsIn: -1 }, "sleepsIn must not be negative"],
      [
        { since: counting.since, holds: [], sleepsIn: 1 },
        "sleepsAt and sleepsIn must be set together",
      ],
      [
        { since: counting.since, holds: [{ kind: "session", count: 0 }] },
        "holds[0]: a session hold must count at least one session",
      ],
      [
        { since: counting.since, holds: [{ kind: "keep-awake", count: 1 }] },
        "holds[0]: a keep-awake hold counts no sessions",
      ],
      [
        {
          since: counting.since,
          holds: [
            { kind: "keep-awake", count: 0 },
            { kind: "keep-awake", count: 0 },
          ],
        },
        "holds[1]: keep-awake is repeated",
      ],
      [
        { since: counting.since, holds: [{ kind: "future", count: 0 }] },
        'holds[0]: unknown computer awake hold kind "future"',
      ],
    ];
    for (const [awake, refusal] of refused) {
      expect(() => {
        validateComputerAwake(awake);
      }).toThrow(refusal);
    }
  });

  // Contract: a read of one Computer hands on why it is awake, with its time
  // as numbers; a Computer that reports none hands on nothing.
  it("hands on awake from a read", async () => {
    const network = new FakeNetwork((request) =>
      request.method === "GET" && request.url.pathname.endsWith("/api-dev")
        ? json({
            computer: {
              ...computerRecord(),
              execution: "running",
              awake: {
                ...counting,
                holds: [{ kind: "session", count: 2 }],
              },
            },
          })
        : undefined,
    );
    const computer = await network.client().computers.get("api-dev");
    expect(computer.snapshot.awake).toEqual({
      ...counting,
      holds: [{ kind: "session", count: 2 }],
    });
  });

  // Contract: a read and a list both hand on that a running Computer is going
  // to sleep, and a Computer that does not report it hands on nothing.
  it("hands on goingToSleep from a read and from a list", async () => {
    const going = {
      ...computerRecord(),
      execution: "running",
      goingToSleep: true,
    };
    const network = new FakeNetwork((request) => {
      if (request.method !== "GET") return undefined;
      return request.url.pathname.endsWith("/api-dev")
        ? json({ computer: going })
        : json({
            items: [going, computerRecord({ name: "other" })],
            totalCount: 2,
          });
    });
    const client = network.client();
    const read = await client.computers.get("api-dev");
    expect(read.snapshot.goingToSleep).toBe(true);
    const listed = [];
    for await (const computer of client.computers.list()) {
      listed.push(computer.snapshot);
    }
    expect(listed[0]?.goingToSleep).toBe(true);
    expect(listed[1]).not.toHaveProperty("goingToSleep");
  });

  // Contract: the golden for a Computer going to sleep reads and writes back
  // byte for byte, and false is never written.
  it("round-trips the going-to-sleep golden", () => {
    const document = readFileSync(
      new URL(
        "./conformance/fixtures/api/testdata/golden/computer.going-to-sleep.json",
        import.meta.url,
      ),
      "utf8",
    );
    const computer = decodeComputer(document);
    expect(computer.goingToSleep).toBe(true);
    expect(encodeComputer(computer)).toEqual(JSON.parse(document));
    expect(
      encodeComputer({ ...computer, goingToSleep: false }),
    ).not.toHaveProperty("goingToSleep");
  });
});

describe("a Computer's open sessions", () => {
  // Contract: sessions() reads the Computer's session collection by its ID
  // and hands on each session as served.
  it("lists them on the Computer's session collection", async () => {
    const seen: string[] = [];
    const network = new FakeNetwork((request) => {
      if (request.method === "GET" && request.url.pathname.endsWith("/api-dev"))
        return json({ computer: computerRecord() });
      if (request.method === "GET") {
        seen.push(request.url.pathname);
        return json({ items: [terminal] });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    expect(await computer.sessions()).toEqual([terminal]);
    expect(seen).toEqual([`${computersPath}/by-id/${ID}/sessions`]);
  });

  // Contract: a read carries a kind this SDK does not name, and validation
  // alone judges it.
  it("carries a newer kind and judges it apart", () => {
    const page = decodeListComputerSessionsResponse({
      items: [{ ...terminal, kind: "future" }],
    });
    const newer = page.items[0];
    expect(newer?.kind).toBe("future");
    expect(() => {
      if (newer !== undefined) validateComputerSessionSummary(newer);
    }).toThrow('unknown computer session kind "future"');
    expect(() => {
      validateComputerSessionSummary({ ...terminal, notebook: "analysis" });
    }).toThrow("notebook must be set exactly on a notebook cell");
  });
});

describe("reasons in a Computer's history", () => {
  // Contract: each reason reads back and is judged against its kind.
  it("reads and judges a wake, a sleep and a restart", () => {
    const valid = [
      entry({ kind: "wake", wake: { session: "terminal" } }),
      entry({ kind: "sleep", sleep: { reason: "idle", idleTimeout: "300s" } }),
      entry({ kind: "restart", restart: { reason: "node-lost" } }),
    ];
    for (const read of valid) {
      expect(() => {
        validateJournalEntry(read);
      }).not.toThrow();
    }
    const refused: readonly [Record<string, unknown>, string][] = [
      [
        { kind: "sleep", wake: { session: "terminal" } },
        "wake must be absent on a sleep entry",
      ],
      [{ kind: "restart" }, "restart is required on a restart entry"],
      [
        { kind: "wake", restart: { reason: "replaced" } },
        "restart must be absent on a wake entry",
      ],
      [
        { kind: "restart", restart: { reason: "future" } },
        'restart: unknown restart reason "future"',
      ],
      [
        { kind: "sleep", sleep: { reason: "future" } },
        'sleep: unknown sleep reason "future"',
      ],
      [
        { kind: "sleep", sleep: { reason: "request", idleTimeout: "300s" } },
        'sleep: idleTimeout must be absent on a "request" sleep',
      ],
    ];
    for (const [fields, refusal] of refused) {
      expect(() => {
        validateJournalEntry(entry(fields));
      }).toThrow(refusal);
    }
  });
});

describe("a Micropod's egress rules", () => {
  // Contract: a rule states either protocol and any destination form; a
  // wildcard is held apart from the name below it.
  it("parses each destination form", () => {
    expect(parseEgressAllowRule("udp:53:Example.COM")).toEqual({
      protocol: "udp",
      port: 53,
      host: "example.com",
    });
    expect(parseEgressAllowRule("tcp:443:*.example.com")).toEqual({
      protocol: "tcp",
      port: 443,
      host: "example.com",
      wildcard: true,
    });
    expect(parseEgressAllowRule("tcp:443:93.184.216.34")).toEqual({
      protocol: "tcp",
      port: 443,
      range: "93.184.216.34/32",
    });
    expect(parseEgressAllowRule("tcp:443:93.184.216.0/24")).toEqual({
      protocol: "tcp",
      port: 443,
      range: "93.184.216.0/24",
    });
  });

  // Contract: a rule that could never work is refused: local destinations,
  // host bits, IPv6, malformed wildcards and a wildcard below an IP literal.
  it("refuses a rule that could never work", () => {
    const refused: readonly [string, string][] = [
      [`tcp:443:${privateHost}`, "inside the local network range 10.0.0.0/8"],
      ["tcp:443:93.184.216.1/24", "must have no host bits set"],
      ["tcp:443:2001:db8::1", "is an IPv6 destination"],
      ["tcp:443:*.com", "must write a wildcard as *.<name>"],
      ["tcp:443:a.*.example.com", "must write a wildcard as *.<name>"],
      ["tcp:443:*.10.0.0.1", "not an IP literal"],
      ["icmp:1:example.com", 'unsupported egress protocol "icmp"'],
    ];
    for (const [rule, refusal] of refused) {
      expect(() => parseEgressAllowRule(rule)).toThrow(refusal);
    }
  });

  // Contract: the wider rules are a Micropod's alone; a Pod keeps its own.
  it("keeps a Pod to its own rules", () => {
    expect(() => {
      validateWorkloadNetworkEgressAllowRule("tcp:443:*.example.com");
    }).toThrow("must be a DNS hostname, not a wildcard");
    expect(() => {
      validateMicropodNetwork({
        class: "restricted-egress",
        egress: {
          allow: ["dns", "udp:53:example.com", "tcp:443:*.example.com"],
          denyLocalNetworks: true,
        },
      });
    }).not.toThrow();
  });
});
