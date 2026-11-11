// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateComputerCell } from "../src/api/computer-cell.js";
import {
  MAX_COMPUTER_NOTEBOOK_NAME_BYTES,
  validateComputerNotebookName,
} from "../src/api/computer-notebook-name.js";
import {
  ERROR_CODE_NOTEBOOK_NOT_FOUND,
  decodeComputerNotebook,
  decodeListComputerNotebookCellsResponse,
  encodeCreateComputerNotebookRequest,
  encodeUpdateComputerNotebookRequest,
  validateComputerNotebook,
  validateUpdateComputerNotebookRequest,
} from "../src/api/computer-notebook.js";
import {
  decodeComputerSession,
  validateComputerSession,
} from "../src/api/computer-session.js";
import { isApiCode } from "../src/errors.js";
import { type JsonObject } from "../src/resource/json.js";
import {
  FakeControlPlane,
  errorResponse,
  json,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
import type { RecordedRequest } from "./fakes/fetch-queue.js";

const COMPUTER_ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const notebooksPath = `${namespacePathPrefix}/computers/payments/notebooks`;
const notebooksByIdPath = `${namespacePathPrefix}/computers/by-id/${COMPUTER_ID}/notebooks`;

/** A golden under `api/testdata/golden`, as the platform serves it. */
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

const notebook = golden("computer-notebook.full");
const listPage = golden("computer-notebook.list-page");
const cellsPage = golden("computer-notebook.cells-page");

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

/**
 * A Subnet API serving one Computer's notebooks: a create or read answers
 * `answer`, a listing its page, and a delete 204; every create body is
 * recorded.
 */
function notebookPlane(answer: JsonObject = notebook): {
  readonly plane: FakeControlPlane;
  readonly bodies: unknown[];
} {
  const bodies: unknown[] = [];
  const plane = new FakeControlPlane({
    routes: (request, body) => {
      if (request.url.host !== subnetHost) return undefined;
      const path = request.url.pathname;
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST") {
        bodies.push(body);
        return json(answer, 201);
      }
      if (request.method === "PATCH") {
        bodies.push(body);
        return json(answer);
      }
      if (path.endsWith("/cells")) return json(cellsPage);
      if (path.endsWith("/notebooks")) return json(listPage);
      return json(answer);
    },
  });
  return { plane, bodies };
}

describe("Computer notebook contract", () => {
  // Contract: a notebook name is a DNS label of at most 63 bytes, and each
  // refusal is the sentence the reference contract refuses it with.
  it("judges notebook names as the reference contract does", () => {
    for (const name of ["abc", "build-2", "build-"]) {
      expect(() => {
        validateComputerNotebookName(name);
      }, name).not.toThrow();
    }
    expect(() => {
      validateComputerNotebookName(
        "a".repeat(MAX_COMPUTER_NOTEBOOK_NAME_BYTES),
      );
    }).not.toThrow();
    const cases: readonly [string, string][] = [
      ["", "notebook name is required"],
      ["a".repeat(64), "notebook name must not exceed 63 characters"],
      ["é".repeat(32), "notebook name must not exceed 63 characters"],
      ["2build", "notebook name must start with a lowercase letter"],
      ["-build", "notebook name must start with a lowercase letter"],
      [
        "Build",
        "notebook name must contain only lowercase letters, digits, or '-'",
      ],
      ["ab", "notebook name must be at least 3 characters"],
    ];
    for (const [name, message] of cases) {
      expect(
        refusal(() => {
          validateComputerNotebookName(name);
        }),
        name,
      ).toBe(message);
    }
  });

  // Contract: a served notebook validates; one without a canonical ID, a
  // canonical Computer, a creation time, or a creator is refused.
  it("validates a served notebook", () => {
    const read = decodeComputerNotebook(notebook);
    expect(() => {
      validateComputerNotebook(read);
    }).not.toThrow();
    expect(read.id).toBe("01954e20-7540-7ec4-93ec-14f783e6ab50");
    expect(
      refusal(() => {
        validateComputerNotebook({ ...read, id: "build" } as never);
      }),
    ).toBe("id: computer notebook ID must be a canonical UUID");
    expect(
      refusal(() => {
        validateComputerNotebook({ ...read, computer: "payments" } as never);
      }),
    ).toBe("computer: computer ID must be a canonical UUID");
    expect(
      refusal(() => {
        validateComputerNotebook({ ...read, creator: "" });
      }),
    ).toBe("creator is required");
  });

  // Contract: the create request is `{name}` and nothing else; a field the
  // request does not declare is refused before it is written.
  it("encodes the create request strictly", () => {
    expect(encodeCreateComputerNotebookRequest({ name: "build" })).toEqual({
      name: "build",
    });
    expect(() =>
      encodeCreateComputerNotebookRequest({
        name: "build",
        cells: 1,
      } as never),
    ).toThrow();
  });

  // Contract: a notebook carries whether it is pinned, `false` included,
  // and the update request is the reference contract's: `pinned` and
  // `name` when stated, refused when it states nothing, a new name that is
  // not valid, or a field it does not declare.
  it("reads the pin and encodes the update request strictly", () => {
    expect(decodeComputerNotebook(notebook).pinned).toBe(true);
    expect(
      decodeComputerNotebook(golden("computer-notebook.empty")).pinned,
    ).toBe(false);
    expect(encodeUpdateComputerNotebookRequest({ pinned: true })).toEqual(
      golden("computer-notebook.update-request"),
    );
    expect(encodeUpdateComputerNotebookRequest({ pinned: false })).toEqual({
      pinned: false,
    });
    expect(
      refusal(() => {
        validateUpdateComputerNotebookRequest({});
      }),
    ).toBe("notebook update states no field");
    expect(
      encodeUpdateComputerNotebookRequest({ name: "nightly-build" }),
    ).toEqual(golden("computer-notebook.rename-request"));
    expect(
      refusal(() => {
        validateUpdateComputerNotebookRequest({ name: "ab" });
      }),
    ).toBe("notebook update: notebook name must be at least 3 characters");
    expect(() =>
      encodeUpdateComputerNotebookRequest({
        pinned: true,
        color: "blue",
      } as never),
    ).toThrow();
  });

  // Contract: a notebook cell names its notebook, and a session's save is
  // judged as a cell save is: a private session that ended carries the save
  // covering its end and no cell.
  it("reads a notebook cell and a private session's save", () => {
    const cell = decodeComputerSession(
      golden("computer-session.private-ended"),
    );
    expect(cell.status.cell).toBeUndefined();
    expect(cell.status.save).toEqual({
      state: "saved",
      version: 7,
      entry: "01954e20-7540-7ec4-93ec-14f783e6ab41",
    });
    expect(() => {
      validateComputerSession(cell);
    }).not.toThrow();
    expect(
      refusal(() => {
        validateComputerSession({
          ...cell,
          status: { ...cell.status, save: { state: "saved" } },
        });
      }),
    ).toBe("saved or unchanged requires version");
    const first = decodeListComputerNotebookCellsResponse(cellsPage).items[0];
    if (first === undefined) throw new Error("the cells page is empty");
    expect(first.notebook).toBe("build");
    expect(() => {
      validateComputerCell(first);
    }).not.toThrow();
    expect(
      refusal(() => {
        validateComputerCell({ ...first, notebook: "Build" });
      }),
    ).toBe("notebook name must contain only lowercase letters, digits, or '-'");
  });
});

describe("Computer notebook operations", () => {
  // Contract: every notebook call addresses the Computer's notebook
  // collection by name or under the reserved by-id segment, the notebook by
  // its escaped name, and the list routes by `limit` and `continue` only.
  it("routes every notebook call by name and by ID", async () => {
    const { plane, bodies } = notebookPlane();
    const computers = plane.client().account.computers;

    const created = await computers.createNotebook("payments", {
      name: "build",
    });
    expect(created.cells).toBe(2);
    await computers.createNotebookById(COMPUTER_ID, { name: "build" });
    expect((await computers.getNotebook("payments", "build")).name).toBe(
      "build",
    );
    await computers.getNotebookById(COMPUTER_ID, "build");
    const page = await computers.listNotebooks("payments", {
      limit: 2,
      continue: "eyJuYW1lIjoiYnVpbGQifQ",
    });
    expect(page.items.map((item) => item.name)).toEqual([
      "build",
      "release-checks",
    ]);
    expect(page.continue).toBe("eyJuYW1lIjoiYnVpbGQifQ");
    await computers.listNotebooksById(COMPUTER_ID);
    const cells = await computers.listNotebookCells("payments", "build", {
      limit: 50,
    });
    expect(cells.items[0]?.notebook).toBe("build");
    expect(cells.items[0]?.save?.state).toBe("saved");
    await computers.listNotebookCellsById(COMPUTER_ID, "build");
    const pinned = await computers.updateNotebook("payments", "build", {
      pinned: true,
    });
    expect(pinned.pinned).toBe(true);
    await computers.updateNotebookById(COMPUTER_ID, "build", {
      pinned: false,
    });
    await computers.deleteNotebook("payments", "build");
    await computers.deleteNotebookById(COMPUTER_ID, "build");

    expect(subnetCalls(plane.requests)).toEqual([
      `POST ${notebooksPath}`,
      `POST ${notebooksByIdPath}`,
      `GET ${notebooksPath}/build`,
      `GET ${notebooksByIdPath}/build`,
      `GET ${notebooksPath}?continue=eyJuYW1lIjoiYnVpbGQifQ&limit=2`,
      `GET ${notebooksByIdPath}`,
      `GET ${notebooksPath}/build/cells?limit=50`,
      `GET ${notebooksByIdPath}/build/cells`,
      `PATCH ${notebooksPath}/build`,
      `PATCH ${notebooksByIdPath}/build`,
      `DELETE ${notebooksPath}/build`,
      `DELETE ${notebooksByIdPath}/build`,
    ]);
    expect(bodies).toEqual([
      { name: "build" },
      { name: "build" },
      { pinned: true },
      { pinned: false },
    ]);
  });

  // Contract: a blank Computer name, an ID that is not canonical, an
  // invalid notebook name, and list options the route does not serve are
  // refused before any request is sent.
  it("refuses what it can judge before any request", async () => {
    const { plane } = notebookPlane();
    const computers = plane.client().account.computers;
    await expect(
      computers.createNotebook(" ", { name: "build" }),
    ).rejects.toThrow(new TypeError("computer name is required"));
    await expect(
      computers.getNotebookById("payments", "build"),
    ).rejects.toThrow(new TypeError("computer ID must be a canonical UUID"));
    await expect(
      computers.createNotebook("payments", { name: "Build" }),
    ).rejects.toThrow(
      new TypeError(
        "notebook name must contain only lowercase letters, digits, or '-'",
      ),
    );
    await expect(computers.deleteNotebook("payments", "")).rejects.toThrow(
      new TypeError("notebook name is required"),
    );
    await expect(
      computers.updateNotebook("payments", "build", {}),
    ).rejects.toThrow(new TypeError("notebook update states no field"));
    await expect(
      computers.listNotebookCells("payments", "build", {
        offset: 1,
      } as never),
    ).rejects.toThrow();
    expect(subnetCalls(plane.requests)).toEqual([]);
  });

  // Contract: a response naming another notebook than the one created,
  // read or updated is refused, and a missing notebook reports its code.
  it("refuses a response for another notebook and relays not found", async () => {
    const other = { ...notebook, name: "release-checks" };
    const { plane } = notebookPlane(other);
    const computers = plane.client().account.computers;
    await expect(
      computers.createNotebook("payments", { name: "build" }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "create computer notebook response names a different notebook",
    });
    await expect(
      computers.getNotebook("payments", "build"),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "read computer notebook response names a different notebook",
    });
    await expect(
      computers.updateNotebook("payments", "build", { pinned: true }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "update computer notebook response names a different notebook",
    });

    const missing = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? errorResponse(404, ERROR_CODE_NOTEBOOK_NOT_FOUND, "no notebook")
          : undefined,
    });
    const read = await missing
      .client()
      .account.computers.getNotebook("payments", "build")
      .catch((caught: unknown) => caught);
    expect(isApiCode(read, ERROR_CODE_NOTEBOOK_NOT_FOUND)).toBe(true);
  });
});
