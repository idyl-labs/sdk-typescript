// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decodeComputerSession } from "../src/api/computer-session.js";
import {
  decodeJournalEntry,
  validateJournalEntry,
} from "../src/api/journal.js";
import { isApiCode } from "../src/errors.js";

import { type JsonObject } from "../src/resource/json.js";

import {
  FakeControlPlane,
  errorResponse,
  subnetHost,
} from "./fakes/control-plane.js";

const UINT64_MAX = 18446744073709551615n;
const INT64_MAX = 9223372036854775807n;
const RESOURCE = "00000000-0000-4000-8000-000000000004";

function golden(name: string): JsonObject {
  return JSON.parse(
    readFileSync(
      new URL(
        `./conformance/fixtures/api/testdata/golden/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as JsonObject;
}

/** Supplies original numeric tokens independently of the SDK's writer. */
function rawJson(
  value: unknown,
  tokens: Readonly<Record<string, string>>,
): string {
  let text = JSON.stringify(value);
  for (const [marker, token] of Object.entries(tokens)) {
    text = text.replaceAll(JSON.stringify(marker), token);
  }
  return text;
}

function response(text: string, headers?: HeadersInit): Response {
  return new Response(text, {
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

describe.each(["computers"] as const)("%s integral transport", () => {
  // Contract: each actual service reads wide counts from the response's
  // original digits, retaining future numeric fields without a width cap.
  it("reads wide metadata and list values on name and identity routes", async () => {
    const fixture = golden("computer.active");
    const key = "computer";
    const metadata = rawJson(
      {
        [key]: {
          ...fixture,
          headVersion: "signed",
          future: { count: "wide-future" },
        },
      },
      {
        signed: "9223372036854775807",
        "wide-future": "18446744073709551616",
      },
    );
    const version = rawJson(
      {
        items: [
          {
            ...golden("version.full"),
            number: "signed",
            logicalBytes: "signed",
          },
        ],
        totalCount: "signed",
        futureEnvelope: "not returned",
      },
      { signed: "9223372036854775807" },
    );
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host !== subnetHost
          ? undefined
          : response(
              request.url.pathname.endsWith("/versions") ? version : metadata,
            ),
    });
    const service = plane.client().account.computers;
    const namedResponse = await service.get("demo");
    const named = namedResponse.computer;
    const identifiedResponse = await service.getById(RESOURCE);
    const identified = identifiedResponse.computer;
    expect(named.headVersion).toBe(INT64_MAX);
    expect(identified.headVersion).toBe(INT64_MAX);
    expect((named as unknown as JsonObject)["future"]).toEqual({
      count: 18446744073709551616n,
    });
    const page = await service.listVersionsById(RESOURCE, {
      limit: UINT64_MAX,
    });
    expect(page.totalCount).toBe(INT64_MAX);
    expect(page).not.toHaveProperty("futureEnvelope");
    expect(page.items[0]?.number).toBe(INT64_MAX);
    expect(page.items[0]?.logicalBytes).toBe(INT64_MAX);
    expect(plane.subnetRequests().at(-1)?.url.search).toBe(
      "?limit=18446744073709551615",
    );
  });

  // Contract: a supplied number's actual represented integer is used in
  // the numeric route, and a bigint reaches the entire canonical int64 range.
  it("writes exact numeric route operands and streamed upload queries", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? errorResponse(409, "STORAGE_NOT_OPEN", "closed")
          : undefined,
    });
    const service = plane.client().account.computers;
    await expect(
      service.updateVersionById(RESOURCE, Number("1000000000000000128"), {
        name: "saved",
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isApiCode(error, "STORAGE_NOT_OPEN"),
    );
    expect(plane.subnetRequests()[0]?.url.pathname).toContain(
      "/versions/1000000000000000128",
    );
    await expect(
      service.createUploadById(RESOURCE, { base: INT64_MAX }),
    ).rejects.toSatisfy((error: unknown) =>
      isApiCode(error, "STORAGE_NOT_OPEN"),
    );
    expect(plane.subnetRequests()[1]?.body).toBe(
      '{"base":9223372036854775807}',
    );
    await expect(
      service.updateVersionById(RESOURCE, INT64_MAX + 1n, { name: "saved" }),
    ).rejects.toThrow("version must be");
    expect(plane.subnetRequests()).toHaveLength(2);
  });

  // Contract: saved-content headers use signed 64-bit parsing and preserve
  // Go's accepted decimal signs/leading zeros without using Number first.
  it("reads exact saved-version headers and retains content ownership", async () => {
    let reads = 0;
    const headers = [
      "9223372036854775807",
      "+0001",
      "-0",
      "9223372036854775808",
    ];
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? new Response("bytes", {
              headers: { "Idyl-Saved-Version": headers[reads++] ?? "" },
            })
          : undefined,
    });
    const service = plane.client().account.computers;
    for (const expected of [INT64_MAX, 1, 0]) {
      const content = await service.readFilePiecesById(RESOURCE, {
        path: "file",
      });
      expect(content.version).toBe(expected);
      await content.close();
    }
    await expect(
      service.readFilePiecesById(RESOURCE, { path: "file" }),
    ).rejects.toThrow("invalid saved version");
  });
});

describe("canonical integral request and stream boundaries", () => {
  // Contract: an explicit floor reaches the native request as an unquoted
  // exact integer, while the server's refusal is surfaced without a retry.
  it("submits a full-width session floor and retains explicit bigint zero", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? errorResponse(409, "STORAGE_NOT_OPEN", "closed")
          : undefined,
    });
    const computers = plane.client().account.computers;
    for (const floor of [INT64_MAX, 0n]) {
      await expect(
        computers.createSession("demo", {
          ...decodeComputerSession(golden("computer-session.ready")).spec,
          atLeastVersion: floor,
        }),
      ).rejects.toSatisfy((error: unknown) =>
        isApiCode(error, "STORAGE_NOT_OPEN"),
      );
    }
    const bodies = plane.subnetRequests().map((request) => request.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('"atLeastVersion":9223372036854775807');
    expect(bodies[1]).toContain('"atLeastVersion":0');
    await expect(
      computers.createSession("demo", {
        ...decodeComputerSession(golden("computer-session.ready")).spec,
        atLeastVersion: INT64_MAX + 1n,
      }),
    ).rejects.toThrow();
    expect(plane.subnetRequests()).toHaveLength(2);
  });

  // Contract: a journal entry's sequence number keeps its int64 width, and
  // a bigint page limit is written as its decimal token.
  it("reads full-width journal data and writes a bigint limit", async () => {
    const text = rawJson(
      {
        items: [
          {
            ...golden("computer-journal.cell-full"),
            seq: "signed",
          },
        ],
        totalCount: 1,
      },
      { signed: "9223372036854775807" },
    );
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost ? response(text) : undefined,
    });
    const page = await plane.client().account.computers.listJournal("demo", {
      limit: 200n,
    });
    expect(page.items[0]?.seq).toBe(INT64_MAX);
    expect(plane.subnetRequests()[0]?.url.search).toBe("?limit=200");
    const genesis = decodeJournalEntry(golden("computer-journal.genesis"));
    expect(() => {
      validateJournalEntry({ ...genesis, seq: 0n, version: 0n });
    }).not.toThrow();
  });
});
