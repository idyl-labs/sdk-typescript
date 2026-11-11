// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ERROR_CODE_STORAGE_NOT_OPEN } from "../src/api/storage-errors.js";
import { isApiCode } from "../src/errors.js";
import { type JsonObject } from "../src/resource/json.js";
import {
  FakeControlPlane,
  errorResponse,
  json,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
import { redirectResponse, unreadBody } from "./fakes/fetch-queue.js";

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
const RESOURCE = "00000000-0000-4000-8000-000000000004";
const OPERATION = "00000000-0000-4000-8000-000000000020";
interface RouteCase {
  readonly method: string;
  readonly verb: string;
  readonly suffix: string;
  readonly args: readonly unknown[];
  readonly response: JsonObject;
  readonly body?: unknown;
}
/** The storage request documents each route sends verbatim. */
const requests: Record<string, JsonObject> = {
  version: {
    name: "release",
  },
  commit: {
    idempotencyKey: "save-1",
  },
  restore: {
    from: "0",
    idempotencyKey: "restore-1",
  },
  upload: {
    base: 0,
    idempotencyKey: "upload-1",
  },
  publish: {
    idempotencyKey: "publish-1",
  },
  changes: {
    seq: 1,
    delete: [
      {
        pathBase64: "/w==",
      },
    ],
    rename: [
      {
        from: {
          path: "old",
        },
        to: {
          path: "new",
        },
      },
    ],
  },
};
const cases: readonly RouteCase[] = [
  {
    method: "listVersions",
    verb: "GET",
    suffix: "/versions?continue=c%2F%3F&limit=2",
    args: [{ limit: 2, continue: "c/?" }],
    response: { items: [golden("version.full")], totalCount: 1 },
  },
  {
    method: "updateVersion",
    verb: "PATCH",
    suffix: "/versions/0",
    args: [0, requests["version"]],
    body: requests["version"],
    response: golden("version.full"),
  },
  {
    method: "createCommit",
    verb: "POST",
    suffix: "/commits",
    args: [requests["commit"]],
    body: requests["commit"],
    response: golden("commit.full"),
  },
  {
    method: "getCommit",
    verb: "GET",
    suffix: `/commits/${OPERATION}`,
    args: [OPERATION],
    response: { ...golden("commit.full"), id: OPERATION },
  },
  {
    method: "createRestore",
    verb: "POST",
    suffix: "/restores",
    args: [requests["restore"]],
    body: requests["restore"],
    response: golden("restore.full"),
  },
  {
    method: "getRestore",
    verb: "GET",
    suffix: `/restores/${OPERATION}`,
    args: [OPERATION],
    response: { ...golden("restore.full"), id: OPERATION },
  },
  {
    method: "listFiles",
    verb: "GET",
    suffix: "/files?pathBase64=Yf8%3D&version=save-first",
    args: [{ pathBase64: "Yf8=", version: "save-first" }],
    response: { items: [golden("file.byte-name")], totalCount: 1 },
  },
  {
    method: "createUpload",
    verb: "POST",
    suffix: "/uploads",
    args: [requests["upload"]],
    body: requests["upload"],
    response: golden("upload.full"),
  },
  {
    method: "getUpload",
    verb: "GET",
    suffix: `/uploads/${OPERATION}`,
    args: [OPERATION],
    response: { ...golden("upload.full"), id: OPERATION },
  },
  {
    method: "cancelUpload",
    verb: "DELETE",
    suffix: `/uploads/${OPERATION}`,
    args: [OPERATION],
    response: { ...golden("upload.full"), id: OPERATION },
  },
  {
    method: "publishUpload",
    verb: "POST",
    suffix: `/uploads/${OPERATION}/publish`,
    args: [OPERATION, requests["publish"]],
    body: requests["publish"],
    response: { ...golden("upload.delivered"), id: OPERATION },
  },
  {
    method: "uploadChanges",
    verb: "POST",
    suffix: `/uploads/${OPERATION}/changes`,
    args: [OPERATION, requests["changes"]],
    body: requests["changes"],
    response: golden("upload.change-receipt"),
  },
  {
    method: "listUploadReplaced",
    verb: "GET",
    suffix: `/uploads/${OPERATION}/replaced?limit=2`,
    args: [OPERATION, { limit: 2 }],
    response: golden("upload-replaced.list-page"),
  },
];

describe("saved-state native routes", () => {
  // Contract: each resource family is addressed by name and by stable identity, with its canonical bodies and queries sent unchanged.
  for (const family of ["computers"] as const)
    for (const byId of [false, true]) {
      it(`uses canonical ${family} ${byId ? "identity" : "name"} routes`, async () => {
        for (const test of cases) {
          const plane = new FakeControlPlane({
            routes: (request) =>
              request.url.host === subnetHost ? json(test.response) : undefined,
          });
          const client = plane.client();
          const service = client.account.computers;
          const method = test.method + (byId ? "ById" : "");
          const callable = (
            service as unknown as Record<
              string,
              (...args: unknown[]) => Promise<unknown>
            >
          )[method];
          if (callable === undefined)
            throw new Error(`missing public method ${method}`);
          const result = await callable(
            byId ? RESOURCE : "destination",
            ...test.args,
          );
          expect(result, method).toEqual(test.response);
          const request = plane.requests.find(
            (value) => value.url.host === subnetHost,
          );
          expect(request?.method, method).toBe(test.verb);
          expect(
            request === undefined
              ? undefined
              : request.url.pathname + request.url.search,
            method,
          ).toBe(
            `${namespacePathPrefix}/${family}/${byId ? "by-id/" + RESOURCE : "destination"}${test.suffix}`,
          );
          expect(
            request?.body === undefined ? undefined : JSON.parse(request.body),
            method,
          ).toEqual(test.body);
          expect(request?.init.redirect).toBe("manual");
        }
      });
    }
  // Contract: an observed operation must match the requested identity; a receipt must match the submitted sequence.
  it("refuses mismatched operations and receipts", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? json({
              id: RESOURCE,
              seq: 2,
              cell: RESOURCE,
              state: "checkpointed",
            })
          : undefined,
    });
    const client = plane.client();
    await expect(
      client.account.computers.getCommitById(RESOURCE, OPERATION),
    ).rejects.toThrow("different identity");
    await expect(
      client.account.computers.uploadChanges("destination", OPERATION, {
        seq: 1,
      }),
    ).rejects.toThrow("different sequence");
  });
  // Contract: locally judgeable malformed requests never reach the network or consult credentials.
  it("refuses unsupported inputs before network", async () => {
    const plane = new FakeControlPlane();
    const service = plane.client().account.computers;
    await expect(
      service.updateVersion("destination", -1, { name: "v" }),
    ).rejects.toThrow("non-negative");
    await expect(
      service.getRestoreById("not-an-id", OPERATION),
    ).rejects.toThrow("UUID");
    await expect(
      service.getUpload("destination", "not-an-operation"),
    ).rejects.toThrow("UUID");
    await expect(
      service.createRestore("destination", { from: "" }),
    ).rejects.toThrow("restore from is required");
    await expect(
      service.listFiles("destination", { path: "../escape" }),
    ).rejects.toThrow();
    await expect(
      service.uploadChanges("destination", OPERATION, { seq: 0 }),
    ).rejects.toThrow("positive");
    await expect(
      service.listVersions("destination", { offset: 1 } as never),
    ).rejects.toThrow("unknown field");
    expect(plane.requests).toEqual([]);
  });
  // Contract: closed storage is the server's precise refusal and is neither repaired nor retried by the client.
  it("relays closed storage without a repaired retry", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? errorResponse(
              503,
              ERROR_CODE_STORAGE_NOT_OPEN,
              "durable storage is not open",
            )
          : undefined,
    });
    const error = await plane
      .client()
      .account.computers.createCommitById(RESOURCE, {})
      .catch((value: unknown) => value);
    expect(isApiCode(error, ERROR_CODE_STORAGE_NOT_OPEN)).toBe(true);
    expect(
      plane.requests.filter((request) => request.url.host === subnetHost),
    ).toHaveLength(1);
  });
});

describe("saved-content transfer ownership", () => {
  // Contract: close cancels the underlying reader even when the returned body has a reader; no eager buffering occurs.
  it("retains zero saved version and releases unread content", async () => {
    let cancelled = 0;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? new Response(stream, {
              headers: { etag: '"bytes"', "Idyl-Saved-Version": "0" },
            })
          : undefined,
    });
    const client = plane.client();
    const content = await client.account.computers.readFilePiecesById(
      RESOURCE,
      {
        pathBase64: "Yf8=",
      },
    );
    expect(content.version).toBe(0);
    expect(content.etag).toBe('"bytes"');
    const reader = content.body.getReader();
    expect(pulls).toBe(0);
    await content.close();
    await content.close();
    expect(cancelled).toBe(1);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(plane.requests[0]?.url.search).toBe("?pathBase64=Yf8%3D");
  });
  // Contract: a redirect's body and headers are not trusted; credentials and streamed bodies are never replayed.
  it("refuses redirects before consuming their bodies", async () => {
    for (const status of [307, 0]) {
      const input = unreadBody();
      const redirect = unreadBody();
      const plane = new FakeControlPlane({
        routes: (request) =>
          request.url.host === subnetHost
            ? redirectResponse(
                status,
                "https://other.example.com/content",
                redirect.stream,
              )
            : undefined,
      });
      const service = plane.client().account.computers;
      await expect(
        service.uploadFileById(
          RESOURCE,
          OPERATION,
          { path: "file", mode: 0o600, seq: 1 },
          input.stream,
        ),
      ).rejects.toThrow("redirect refused");
      expect(input.reads()).toBe(0);
      expect(redirect.reads()).toBe(0);
      expect(plane.requests).toHaveLength(1);
      await input.stream.cancel();
    }
  });
});
