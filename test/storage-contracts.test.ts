// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateComputerCellSave } from "../src/api/computer-cell-save.js";
import {
  decodeComputerSession,
  encodeCreateComputerSessionRequest,
} from "../src/api/computer-session.js";
import {
  filePathBytes,
  newFilePath,
  validateFilePathCreate,
  validateFilePathMutation,
} from "../src/api/files.js";
import { parseDuration } from "../src/resource/duration.js";
import { type JsonObject } from "../src/resource/json.js";
import { validateVersionRef } from "../src/resource/storage.js";
import { createComputerSessionRequestShape } from "../src/api/computer-session.js";
import { decodeValue, decodeText } from "../src/internal/strictdecode.js";
import {
  FakeControlPlane,
  json,
  errorResponse,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
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

describe("storage selectors and observations", () => {
  // Contract: existing path bytes roundtrip without normalization, while new names require UTF-8 NFC and reserved state is not mutable.
  it("preserves byte paths and distinguishes new names", () => {
    const bytes = new Uint8Array([97, 255]);
    const path = newFilePath(bytes);
    bytes[0] = 98;
    expect(path).toEqual({ pathBase64: "Yf8=" });
    const returned = filePathBytes(path);
    returned[0] = 99;
    expect(filePathBytes(path)).toEqual(new Uint8Array([97, 255]));
    expect(newFilePath(new Uint8Array())).toEqual({ path: "" });
    expect(filePathBytes({ path: "" })).toHaveLength(0);
    const bom = new Uint8Array([239, 187, 191, 97]);
    expect(filePathBytes(newFilePath(bom))).toEqual(bom);
    for (const value of [{ path: "e\u0301" }, { pathBase64: "Yf8=" }]) {
      expect(() => {
        filePathBytes(value);
      }).not.toThrow();
      expect(() => {
        validateFilePathCreate(value);
      }).toThrow("UTF-8 NFC");
    }
    expect(() => {
      validateFilePathCreate({ path: "é" });
    }).not.toThrow();
    for (const value of [
      {},
      { path: "", pathBase64: "" },
      { path: "a\u0000b" },
      { path: "/a" },
      { path: "a/.." },
      { path: "a//b" },
      { path: "a/" },
      { path: "a".repeat(256) },
      { pathBase64: "Yf9=" },
      { pathBase64: "Yf8" },
      { path: "\ud800" },
    ])
      expect(() => {
        filePathBytes(value);
      }).toThrow();
    expect(() => {
      validateFilePathMutation({ path: ".runtime/owned" });
    }).toThrow("authority-owned");
    expect(() => {
      validateFilePathMutation({ path: "x/.runtime" });
    }).not.toThrow();
  });
  // Contract: provenance and save outcomes retain explicit genesis version zero and exact state-selected identities.
  it("validates zero provenance and save outcomes", () => {
    expect(() => {
      validateVersionRef({
        computer: "00000000-0000-4000-8000-000000000002" as never,
        version: 0,
      });
    }).not.toThrow();
    expect(() => {
      validateVersionRef({
        computer: "00000000-0000-4000-8000-000000000002" as never,
        version: -1,
      });
    }).toThrow("non-negative");
    expect(() => {
      validateComputerCellSave({
        state: "unchanged",
        version: 0,
        entry: "00000000-0000-4000-8000-000000000001" as never,
        failingSeconds: 0,
        failingBudgetSeconds: 0,
      });
    }).not.toThrow();
    expect(() => {
      validateComputerCellSave({ state: "pending", version: 0 });
    }).toThrow("require saved");
    expect(() => {
      validateComputerCellSave({ state: "failed" });
    }).toThrow("requires reason");
  });
});

describe("Computer request presence", () => {
  // Contract: floor zero is explicit, null/duplicate/unknown/trailing submission data is refused by the single strict decoder, and response reads remain lenient.
  it("preserves and judges the session version floor", async () => {
    const request = decodeComputerSession(
      golden("computer-session.ready"),
    ).spec;
    const wire = {
      ...encodeCreateComputerSessionRequest(request),
      atLeastVersion: 0,
    };
    expect(
      encodeCreateComputerSessionRequest(
        decodeValue(wire, createComputerSessionRequestShape, "strict"),
      ),
    ).toEqual(wire);
    const text = JSON.stringify(wire);
    for (const document of [
      text.replace('"atLeastVersion":0', '"atLeastVersion":null'),
      text.replace(
        '"atLeastVersion":0',
        '"atLeastVersion":0,"atLeastVersion":1',
      ),
      text.replace('"atLeastVersion":0', '"atLeastVersion":0,"unknown":true'),
      text + " {}",
    ])
      expect(() =>
        decodeText(document, createComputerSessionRequestShape),
      ).toThrow();
    expect(
      decodeValue(
        { ...wire, atLeastVersion: null },
        createComputerSessionRequestShape,
        "lenient",
      ).atLeastVersion,
    ).toBeUndefined();
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? json(golden("computer-session.ready"))
          : undefined,
    });
    await plane.client().account.computers.createSession("destination", {
      ...request,
      atLeastVersion: 0,
    });
    const refused = new FakeControlPlane();
    for (const atLeastVersion of [null, -1]) {
      await expect(
        refused.client().account.computers.createSession("destination", {
          ...request,
          atLeastVersion,
        } as never),
      ).rejects.toThrow();
    }
    expect(refused.requests).toEqual([]);
    const sent = plane.requests.find(
      (request) => request.url.host === subnetHost,
    );
    expect(JSON.parse(sent?.body ?? "{}")).toEqual(wire);
  });
  // Contract: storage/fork/retry settings, a false autoSave, save timings, and zero timeouts/budgets reach the owning server unchanged; its refusal is surfaced once.
  it("sends exact Computer storage settings and zero idle requests", async () => {
    const body = {
      name: "destination",
      forkOf: {
        source: { computer: "00000000-0000-4000-8000-000000000002" },
        entry: "00000000-0000-4000-8000-000000000003",
      },
      idempotencyKey: "one-effect",
      spec: {
        idleTimeout: "0s",
        autoSave: false,
        saveQuiet: "30s",
        saveMaxInterval: "5m",
        saveWindow: "0s",
      },
    };
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? errorResponse(503, "STORAGE_NOT_OPEN", "closed")
          : undefined,
    });
    await expect(
      plane.client().account.computers.create({
        ...body,
        spec: {
          ...body.spec,
          saveQuiet: parseDuration("30s"),
          saveMaxInterval: parseDuration("5m"),
          saveWindow: parseDuration("0s"),
        },
      } as never),
    ).rejects.toMatchObject({ detail: "closed" });
    const sent = plane.requests.find(
      (request) => request.url.host === subnetHost,
    );
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      ...body,
      subnet: "550000000002",
    });
    expect(sent?.url.pathname).toBe(`${namespacePathPrefix}/computers`);
    expect(
      plane.requests.filter((request) => request.url.host === subnetHost),
    ).toHaveLength(1);
  });
});
