// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateComputerCell } from "../src/api/computer-cell.js";
import {
  decodeJournalEntry,
  encodeJournalEntry,
  encodeJournalPage,
  validateJournalEntry,
} from "../src/api/journal.js";
import { type JsonObject } from "../src/resource/json.js";
import {
  FakeControlPlane,
  json,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";

function golden(name: string): JsonObject {
  const text = readFileSync(
    new URL(
      `./conformance/fixtures/api/testdata/golden/${name}.json`,
      import.meta.url,
    ),
    "utf8",
  );
  return JSON.parse(text) as JsonObject;
}
const COMPUTER = "00000000-0000-4000-8000-000000000004";
const SESSION = "00000000-0000-4000-8000-000000000006";

describe("destination journal ownership", () => {
  // Contract: native list/get at each destination address retain current owner and one original origin, without consulting a source.
  for (const destination of ["computer"] as const) {
    for (const source of ["computer"] as const) {
      it(`reads ${source} provenance through ${destination} name and identity routes`, async () => {
        const name = `journal.${source}-to-${destination}-cell`;
        const document = golden(name);
        const canonical = decodeJournalEntry(document);
        const plane = new FakeControlPlane({
          routes: (request) => {
            if (request.url.host !== subnetHost) return undefined;
            return request.url.pathname.endsWith("/journal")
              ? json({
                  items: [document],
                  totalCount: 1,
                  continue: "position-1",
                })
              : json(document);
          },
        });
        const client = plane.client();
        const service = client.account.computers;
        const id = canonical.cell?.[destination];
        if (id === undefined)
          throw new Error("fixture has no destination owner");
        const page = await service.listJournal("destination", { limit: 1 });
        const identityPage = await service.listJournalById(id, {
          continue: page.continue ?? "",
        });
        const entry = await service.getJournalEntry(
          "destination",
          canonical.id,
        );
        const identityEntry = await service.getJournalEntryById(
          id,
          canonical.id,
        );
        for (const value of [
          page.items[0],
          identityPage.items[0],
          entry,
          identityEntry,
        ]) {
          expect(value).toEqual(canonical);
          if (value === undefined)
            throw new Error("missing native journal item");
          expect(encodeJournalEntry(value)).toEqual(document);
          expect(value.cell?.[destination]).toBe(id);
          expect(value.cell?.session).toBeUndefined();
          expect(value.origin?.session).toBe(SESSION);
        }
        expect(encodeJournalPage(page)).toEqual({
          items: [document],
          totalCount: 1,
          continue: "position-1",
        });
        expect(
          plane.requests
            .filter((request) => request.url.host === subnetHost)
            .map(
              (request) =>
                `${request.method} ${request.url.pathname}${request.url.search}`,
            ),
        ).toEqual([
          `GET ${namespacePathPrefix}/${destination}s/destination/journal?limit=1`,
          `GET ${namespacePathPrefix}/${destination}s/by-id/${id}/journal?continue=position-1`,
          `GET ${namespacePathPrefix}/${destination}s/destination/journal/${canonical.id}`,
          `GET ${namespacePathPrefix}/${destination}s/by-id/${id}/journal/${canonical.id}`,
        ]);
      });
    }
  }
  // Contract: a recorded historical Session is a canonical identity, not a live Cell binding; ordinary running detail remains valid.
  it("refuses invalid original sessions and copied live or running detail", () => {
    const entry = decodeJournalEntry(
      golden("journal.computer-to-computer-cell"),
    );
    const cell = entry.cell;
    const origin = entry.origin;
    expect(cell).toBeDefined();
    expect(origin).toBeDefined();
    if (cell === undefined || origin === undefined)
      throw new Error("fixture has no copied cell");
    expect(() => {
      validateJournalEntry(entry);
    }).not.toThrow();
    expect(() => {
      validateJournalEntry({
        ...entry,
        origin: { ...origin, session: "not-a-session" as never },
      });
    }).toThrow("session");
    expect(() => {
      validateJournalEntry({
        ...entry,
        cell: { ...cell, session: SESSION as never },
      });
    }).toThrow("cell.session must be absent");
    const minimal = decodeJournalEntry(
      golden("computer-journal.cell-minimal"),
    ).cell;
    if (minimal === undefined) throw new Error("fixture has no ordinary cell");
    const running = {
      ...minimal,
      id: entry.id,
      computer: cell.computer,
      session: SESSION,
    } as typeof cell;
    expect(() => {
      validateComputerCell(running);
    }).not.toThrow();
    expect(() => {
      validateJournalEntry({
        ...entry,
        cell: { ...running, session: undefined } as never,
      });
    }).toThrow("copied cell must not be running");
    const { origin: omitted, ...ordinary } = entry;
    expect(omitted).toBeDefined();
    expect(() => {
      validateJournalEntry({ ...ordinary, cell: running });
    }).not.toThrow();
    expect(() => {
      validateComputerCell({ ...cell, computer: undefined } as never);
    }).toThrow("computer is required");
  });
  // Contract: native responses remain lenient for future kinds and origin fields, with no source authority inferred from history.
  it("carries unknown kinds and mixed historical entries", async () => {
    const mixed = {
      items: [
        golden("journal.computer-to-computer-cell"),
        golden("journal.copied-genesis"),
        golden("journal.version-full"),
      ],
      totalCount: 3,
    };
    const unknown = {
      ...golden("journal.copied-genesis"),
      kind: "future-entry",
      origin: {
        source: { computer: COMPUTER },
        entry: "opaque-entry",
        session: "opaque-session",
        future: true,
      },
    };
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? json(request.url.pathname.endsWith("/journal") ? mixed : unknown)
          : undefined,
    });
    const service = plane.client().account.computers;
    const page = await service.listJournalById(COMPUTER);
    expect(encodeJournalPage(page)).toEqual(mixed);
    const id = golden("journal.copied-genesis")["id"];
    if (typeof id !== "string")
      throw new Error("fixture has no entry identity");
    const entry = await service.getJournalEntryById(COMPUTER, id);
    expect(entry.kind).toBe("future-entry");
    expect(entry.origin).toEqual(unknown.origin);
    expect(
      plane.requests.filter((request) => request.url.host === subnetHost),
    ).toHaveLength(2);
  });
});
