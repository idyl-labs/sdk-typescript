// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validateComputerCellErrorReason,
  validateComputerCellTermination,
} from "../src/api/computer-cell.js";
import {
  computerSessionReasonClass,
  decodeComputerSession,
  validateComputerSessionReason,
  validateCreateComputerSessionRequest,
} from "../src/api/computer-session.js";
import {
  ERROR_CODE_INVALID_CONTINUE,
  decodeJournalEntry,
  encodeJournalEntry,
  validateJournalEntry,
  validateJournalEntrySave,
  validateJournalListOptions,
  validateJournalSaveTrigger,
} from "../src/api/journal.js";
import { isApiCode } from "../src/errors.js";
import { type JsonObject } from "../src/resource/json.js";
import {
  isJournalEntryId,
  parseComputerSessionId,
  parseJournalEntryId,
  type ComputerSessionId,
} from "../src/resource/uuid-id.js";
import {
  FakeControlPlane,
  errorResponse,
  json,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
import type { RecordedRequest } from "./fakes/fetch-queue.js";

const COMPUTER_ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const ENTRY_ID = "01954e20-7540-7ec4-93ec-14f783e6ab32";
const journalPath = `${namespacePathPrefix}/computers/payments/journal`;
const journalByIdPath = `${namespacePathPrefix}/computers/by-id/${COMPUTER_ID}/journal`;

/** A Computer journal golden, as the platform serves it. */
function golden(state: string): JsonObject {
  return JSON.parse(
    readFileSync(
      new URL(
        `./conformance/fixtures/api/testdata/golden/${state}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as JsonObject;
}

const listPage = golden("computer-journal.list-page");
const lastPage = golden("computer-journal.list-last-page");
const fullCell = golden("computer-journal.cell-full");

function subnetCalls(requests: readonly RecordedRequest[]): string[] {
  return requests
    .filter((request) => request.url.host === subnetHost)
    .map(
      (request) =>
        `${request.method} ${request.url.pathname}${request.url.search}`,
    );
}

function refusal(validate: () => void): string {
  try {
    validate();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

/** Answers journal pages from `pages` in turn and every entry read with the full Cell. */
function journalPlane(pages: readonly JsonObject[]): FakeControlPlane {
  let listed = 0;
  return new FakeControlPlane({
    routes: (request) => {
      if (request.url.host !== subnetHost) return undefined;
      if (request.url.pathname.endsWith("/journal")) {
        const page = pages[Math.min(listed, pages.length - 1)];
        listed += 1;
        return json(page);
      }
      return json(fullCell);
    },
  });
}

describe("Computer journal", () => {
  // Contract: a listing pages by position: the first page is read with the
  // options stated, its continue position is handed back, and passing it
  // back reads the next page; a page without one is the last. The
  // Computer is addressed by name or under the reserved by-id segment.
  it("pages a listing by its continue position", async () => {
    const plane = journalPlane([listPage, lastPage]);
    const computers = plane.client().account.computers;

    const first = await computers.listJournal("payments", { limit: 2 });
    expect(first.continue).toBe("eyJwYWdlIjoxfQ");
    expect(first.totalCount).toBe(5);
    expect(first.items[0]?.cell?.mode).toBe("endpoint-cell");
    expect(first.items[0]?.cell?.command).toEqual({});
    expect(first.items[1]?.cell?.command.exec?.truncated).toBe(true);
    const second = await computers.listJournalById(COMPUTER_ID, {
      limit: 2,
      ...(first.continue === undefined ? {} : { continue: first.continue }),
    });
    expect(second.continue).toBeUndefined();
    expect(second.items.at(-1)?.kind).toBe("genesis");

    expect(subnetCalls(plane.requests)).toEqual([
      `GET ${journalPath}?limit=2`,
      `GET ${journalByIdPath}?continue=eyJwYWdlIjoxfQ&limit=2`,
    ]);
  });

  // Contract: options the route does not serve are refused before any
  // request: a limit over the page bound or below zero.
  it("refuses options before any request", async () => {
    const cases: readonly [
      Parameters<typeof validateJournalListOptions>[0],
      string,
    ][] = [
      [{ limit: 201 }, "limit must be at most 200"],
      [{ limit: -1 }, "limit must be a non-negative integer"],
    ];
    for (const [options, message] of cases) {
      expect(
        refusal(() => {
          validateJournalListOptions(options);
        }),
      ).toBe(message);
    }
    const plane = journalPlane([listPage]);
    await expect(
      plane.client().account.computers.listJournal("payments", { limit: 500 }),
    ).rejects.toThrow(new TypeError("limit must be at most 200"));
    await expect(
      plane.client().account.computers.getJournalEntry("payments", "entry-1"),
    ).rejects.toThrow(
      new TypeError("journal entry ID must be a canonical UUID"),
    );
    await expect(
      plane
        .client({ namespace: undefined })
        .account.computers.listJournal("payments"),
    ).rejects.toThrow(new TypeError("namespace is required"));
    expect(subnetCalls(plane.requests)).toEqual([]);
  });

  // Contract: an entry is read by its ID, by Computer name or ID, with
  // its whole command; a response naming another entry is refused.
  it("reads one entry and refuses another", async () => {
    const plane = journalPlane([listPage]);
    const computers = plane.client().account.computers;
    const entry = await computers.getJournalEntry("payments", ENTRY_ID);
    expect(entry.cell?.command.exec?.argv).toEqual([
      "/bin/sh",
      "-c",
      "make test",
    ]);
    await computers.getJournalEntryById(COMPUTER_ID, ENTRY_ID);
    expect(subnetCalls(plane.requests)).toEqual([
      `GET ${journalPath}/${ENTRY_ID}`,
      `GET ${journalByIdPath}/${ENTRY_ID}`,
    ]);
    const other = "01954e20-7540-7ec4-93ec-14f783e6ab33";
    await expect(
      computers.getJournalEntry("payments", other),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "read computer journal entry response names a different entry",
    });
  });

  // Contract: a refusal of a continue position reaches the caller with its
  // code, so a listing can start again without it.
  it("relays a refused continue position with its code", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? errorResponse(400, ERROR_CODE_INVALID_CONTINUE, "start again")
          : undefined,
    });
    const error = await plane
      .client()
      .account.computers.listJournal("payments", { continue: "eyJ9" })
      .catch((caught: unknown) => caught);
    expect(isApiCode(error, ERROR_CODE_INVALID_CONTINUE)).toBe(true);
  });

  // Contract: an entry names who caused it, a save entry says what caused
  // it and, for a session's end, links the session and the notebook cell,
  // and a change-driven save names no creator; each reads, validates, and
  // writes back as served.
  it("reads who caused an entry and what caused a save", () => {
    const sessionEnd = golden("computer-journal.save-session-end");
    const ended = decodeJournalEntry(sessionEnd);
    expect(ended.creator).toBe("developer@example.com");
    expect(ended.save).toEqual({
      trigger: "session-end",
      notebook: "build",
      cell: "01954e20-7540-7ec4-93ec-14f783e6ab35",
      session: "01954e20-7540-7ec4-93ec-14f783e6ab23",
    });
    expect(() => {
      validateJournalEntry(ended);
    }).not.toThrow();
    expect(encodeJournalEntry(ended)).toEqual(sessionEnd);

    const change = decodeJournalEntry(golden("computer-journal.save-change"));
    expect(change.creator).toBeUndefined();
    expect(change.save).toEqual({ trigger: "change" });
    expect(() => {
      validateJournalEntry(change);
    }).not.toThrow();
  });

  // Contract: a restore entry that changed the Computer's execution
  // settings carries the settings it set; one that did not carries none,
  // and both are valid.
  it("reads the settings a restore set", () => {
    const restored = decodeJournalEntry(
      golden("computer-journal.restore-settings"),
    );
    expect(restored.kind).toBe("restore");
    expect(restored.creator).toBe("developer@example.com");
    expect(restored.executionSettings?.cause).toBe("settings");
    expect(() => {
      validateJournalEntry(restored);
    }).not.toThrow();
    const filesOnly = decodeJournalEntry(
      Object.fromEntries(
        Object.entries(golden("computer-journal.restore-settings")).filter(
          ([key]) => key !== "executionSettings",
        ),
      ),
    );
    expect(filesOnly.executionSettings).toBeUndefined();
    expect(() => {
      validateJournalEntry(filesOnly);
    }).not.toThrow();
  });

  // Contract: a save trigger outside the named set is carried on read and
  // refused by validation; links belong only to a session-end save, and a
  // notebook and its cell are stated together.
  it("judges a save's trigger and links", () => {
    expect(
      refusal(() => {
        validateJournalSaveTrigger("");
      }),
    ).toBe("save trigger is required");
    expect(
      decodeJournalEntry({
        ...golden("computer-journal.save-change"),
        save: { trigger: "schedule" },
      }).save?.trigger,
    ).toBe("schedule");
    expect(
      refusal(() => {
        validateJournalEntrySave({ trigger: "schedule" });
      }),
    ).toBe('unknown save trigger "schedule"');
    expect(
      refusal(() => {
        validateJournalEntrySave({ trigger: "session-end", notebook: "build" });
      }),
    ).toBe("notebook and cell must be set together");
    expect(
      refusal(() => {
        validateJournalEntrySave({
          trigger: "release",
          session: parseComputerSessionId(
            "01954e20-7540-7ec4-93ec-14f783e6ab23",
          ),
        });
      }),
    ).toBe("a release save names no notebook, cell, or session");
    expect(
      refusal(() => {
        validateJournalEntrySave({
          trigger: "session-end",
          session: "session-1" as ComputerSessionId,
        });
      }),
    ).toBe("session: computer session ID must be a canonical UUID");
  });

  // Contract: a change of the default shell is recorded under the changed
  // path "shell", in a settings document that states it.
  it("reads a change of the default shell", () => {
    const full = golden("computer-journal.execution-settings-full");
    const change = full["executionSettings"] as JsonObject;
    const settings = change["settings"] as JsonObject;
    const shellChange = decodeJournalEntry({
      ...full,
      executionSettings: {
        ...change,
        settings: { ...settings, shell: "/usr/bin/zsh" },
        changed: ["shell"],
      },
    });
    expect(shellChange.executionSettings?.settings.shell).toBe("/usr/bin/zsh");
    expect(shellChange.executionSettings?.changed).toEqual(["shell"]);
    expect(() => {
      validateJournalEntry(shellChange);
    }).not.toThrow();
  });

  // Contract: a change of the isolation class is recorded under the changed
  // path "isolation", beside "image" for the image that follows the class.
  it("reads a change of the isolation class", () => {
    const full = golden("computer-journal.execution-settings-full");
    const change = full["executionSettings"] as JsonObject;
    const settings = change["settings"] as JsonObject;
    const classChange = decodeJournalEntry({
      ...full,
      executionSettings: {
        ...change,
        settings: {
          ...settings,
          isolation: "vm",
          image: { idyl: "ubuntu-24.04-machine" },
        },
        changed: ["image", "isolation"],
      },
    });
    expect(classChange.executionSettings?.changed).toEqual([
      "image",
      "isolation",
    ]);
    expect(() => {
      validateJournalEntry(classChange);
    }).not.toThrow();
  });

  // Contract: an endpoint cell's command is held by the Computer alone: the
  // Cell is judged valid with no command member, and refused with any, known
  // or not, as the reference contract holds.
  it("reads an endpoint cell with no command and refuses one", () => {
    const full = golden("computer-journal.cell-full");
    const withCommand = (command: JsonObject): JsonObject => ({
      ...full,
      cell: { ...(full["cell"] as JsonObject), mode: "endpoint-cell", command },
    });
    const entry = decodeJournalEntry(withCommand({}));
    expect(entry.cell?.mode).toBe("endpoint-cell");
    expect(entry.cell?.command).toEqual({});
    expect(() => {
      validateJournalEntry(entry);
    }).not.toThrow();
    for (const command of [{ exec: { argv: ["true"] } }, { later: {} }]) {
      expect(
        refusal(() => {
          validateJournalEntry(decodeJournalEntry(withCommand(command)));
        }),
      ).toBe(
        "cell: an endpoint cell carries no command: the Computer alone records it",
      );
    }
  });

  // Contract: the contract names no SSH command member: a Cell carrying
  // `sshExec` or `shell` decodes it as an unknown member, written back
  // unchanged, and validation refuses it; an exec Cell without `exec` is
  // refused.
  it("carries an SSH command member as unknown and refuses it", () => {
    const full = golden("computer-journal.cell-full");
    const cell = full["cell"] as JsonObject;
    for (const [name, member] of [
      ["shell", { executable: "/bin/sh" }],
      ["sshExec", { data: "", length: 0 }],
    ] as const) {
      const document = {
        ...full,
        cell: { ...cell, mode: "exec", command: { [name]: member } },
      };
      const entry = decodeJournalEntry(document);
      expect(encodeJournalEntry(entry)).toEqual(document);
      expect(
        refusal(() => {
          validateJournalEntry(entry);
        }),
      ).toBe(
        `cell: command member ${JSON.stringify(name)} is not one this version names`,
      );
    }
    expect(
      refusal(() => {
        validateJournalEntry(
          decodeJournalEntry({
            ...full,
            cell: { ...cell, mode: "exec", command: {} },
          }),
        );
      }),
    ).toBe("cell: command.exec is required");
    expect(
      refusal(() => {
        validateJournalEntry(
          decodeJournalEntry({ ...full, cell: { ...cell, mode: "ssh-exec" } }),
        );
      }),
    ).toBe('cell: unknown computer cell mode "ssh-exec"');
  });

  // Contract: the journal identifier families admit only the canonical UUID
  // form.
  it("parses the identifier families", () => {
    expect(isJournalEntryId(ENTRY_ID)).toBe(true);
    expect(isJournalEntryId(ENTRY_ID.toUpperCase())).toBe(false);
    expect(() => parseJournalEntryId("")).toThrow(
      new TypeError("journal entry ID must be a canonical UUID"),
    );
  });
});

describe("Computer session client", () => {
  const spec = decodeComputerSession(golden("computer-session.ready")).spec;

  // Contract: a session create may state its client; a client this SDK
  // does not name is refused, and an empty one states none.
  it("judges a stated client", () => {
    expect(() => {
      validateCreateComputerSessionRequest({ ...spec, client: "console" });
    }).not.toThrow();
    expect(() => {
      validateCreateComputerSessionRequest({ ...spec, client: "" });
    }).not.toThrow();
    expect(
      refusal(() => {
        validateCreateComputerSessionRequest({ ...spec, client: "agent" });
      }),
    ).toBe('client: unknown computer session client "agent"');
  });
});

describe("rename entries", () => {
  // Contract: a rename entry round-trips with its two names and validates;
  // one without its names, to the same name, owning a version, or a rename
  // member on another kind is refused, as the reference contract refuses
  // each.
  it("are read, written and judged", () => {
    const text = readFileSync(
      new URL(
        "./conformance/fixtures/api/testdata/golden/computer-journal.rename.json",
        import.meta.url,
      ),
      "utf8",
    );
    const entry = decodeJournalEntry(text);
    expect(entry.rename).toEqual({ from: "payments", to: "payments-ledger" });
    expect(encodeJournalEntry(entry)).toEqual(JSON.parse(text));
    expect(() => {
      validateJournalEntry(entry);
    }).not.toThrow();
    const { rename, ...bare } = entry;
    expect(rename).toBeDefined();
    expect(() => {
      validateJournalEntry(bare);
    }).toThrow("rename is required on a rename entry");
    expect(() => {
      validateJournalEntry({
        ...entry,
        rename: { from: "payments", to: "payments" },
      });
    }).toThrow("rename: from and to must differ");
    expect(() => {
      validateJournalEntry({ ...entry, version: 6 });
    }).toThrow("rename entries own no version");
    expect(() => {
      validateJournalEntry({
        ...entry,
        kind: "save",
        save: { trigger: "request" },
      });
    }).toThrow("rename must be absent on a save entry");
  });
});

describe("wake and sleep entries", () => {
  // Contract: a wake and a sleep entry round-trip carrying no detail and
  // validate; one that owns a version, or carries a cell, execution
  // settings or a save, is refused with the reference contract's sentence.
  it.each(["wake", "sleep"])("are read, written and judged: %s", (kind) => {
    const text = readFileSync(
      new URL(
        `./conformance/fixtures/api/testdata/golden/computer-journal.${kind}.json`,
        import.meta.url,
      ),
      "utf8",
    );
    const entry = decodeJournalEntry(text);
    expect(entry.kind).toBe(kind);
    expect(entry.creator).toBe("developer@example.com");
    expect(encodeJournalEntry(entry)).toEqual(JSON.parse(text));
    expect(() => {
      validateJournalEntry(entry);
    }).not.toThrow();
    expect(() => {
      validateJournalEntry({ ...entry, version: 6 });
    }).toThrow(`${kind} entries own no version`);
    expect(() => {
      validateJournalEntry({ ...entry, save: { trigger: "request" } });
    }).toThrow(
      `cell, executionSettings, and save must be absent on a ${kind} entry`,
    );
  });

  // Contract: a sleep that discarded unsaved changes round-trips its sleep
  // detail and validates; a sleep detail on any other kind, genesis
  // included, is refused with the reference contract's sentence.
  it("carry the discard of unsaved changes on a sleep alone", () => {
    const text = readFileSync(
      new URL(
        "./conformance/fixtures/api/testdata/golden/computer-journal.sleep-discard.json",
        import.meta.url,
      ),
      "utf8",
    );
    const entry = decodeJournalEntry(text);
    expect(entry.sleep).toEqual({ discardedUnsavedChanges: true });
    expect(encodeJournalEntry(entry)).toEqual(JSON.parse(text));
    expect(() => {
      validateJournalEntry(entry);
    }).not.toThrow();
    const wake = decodeJournalEntry(
      readFileSync(
        new URL(
          "./conformance/fixtures/api/testdata/golden/computer-journal.wake.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(() => {
      validateJournalEntry({
        ...wake,
        sleep: { discardedUnsavedChanges: true },
      });
    }).toThrow("sleep must be absent on a wake entry");
    const genesis = decodeJournalEntry(
      readFileSync(
        new URL(
          "./conformance/fixtures/api/testdata/golden/computer-journal.genesis.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(() => {
      validateJournalEntry({
        ...genesis,
        sleep: { discardedUnsavedChanges: true },
      });
    }).toThrow("sleep must be absent on a genesis entry");
  });

  // Contract: what a sleep ends is named: a session reads `PutToSleep`,
  // settled, and a notebook cell reads the error reason or the termination
  // `put-to-sleep`.
  it("name what a sleep ends", () => {
    expect(() => {
      validateComputerSessionReason("PutToSleep");
    }).not.toThrow();
    expect(computerSessionReasonClass("PutToSleep")).toBe("settled");
    expect(() => {
      validateComputerCellErrorReason("put-to-sleep");
    }).not.toThrow();
    expect(() => {
      validateComputerCellTermination("put-to-sleep");
    }).not.toThrow();
  });

  // Contract: a session that failed because its Computer's isolation class
  // is no longer admitted is named: the session reason is blocked, and a
  // notebook cell reads the matching error reason.
  it("name a session refused for its isolation class", () => {
    expect(() => {
      validateComputerSessionReason("ISOLATION_CLASS_NOT_ADMITTED");
    }).not.toThrow();
    expect(computerSessionReasonClass("ISOLATION_CLASS_NOT_ADMITTED")).toBe(
      "blocked",
    );
    expect(() => {
      validateComputerCellErrorReason("isolation-class-not-admitted");
    }).not.toThrow();
  });
});
