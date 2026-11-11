// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  type FileReadOptions,
  type FileListOptions,
} from "../src/api/files.js";
import { type PageOptions } from "../src/api/storage.js";

import { FakeControlPlane, subnetHost } from "./fakes/control-plane.js";
const RESOURCE = "00000000-0000-4000-8000-000000000004";

describe.each(["computers"] as const)("%s query option types", () => {
  // Contract: known query values are judged by the canonical submission
  // shape before any fetch, rather than coerced into URL strings.
  it("refuses wrong saved-version types on every read and listing address", async () => {
    const plane = new FakeControlPlane();
    const service = plane.client().account.computers;
    for (const version of [123, false, null, [], {}]) {
      const read = { path: "file", version } as unknown as FileReadOptions;
      const list = { path: "file", version } as unknown as FileListOptions;
      for (const call of [
        () => service.readFilePiecesById(RESOURCE, read),
        () => service.headContentById(RESOURCE, "file", read),
        () =>
          service.readContentRangeById(RESOURCE, "archive", read, {
            offset: 0,
            length: 1,
            etag: '"e"',
          }),
        () => service.listFiles("ordinary", list),
        () => service.listFilesById(RESOURCE, list),
      ])
        await expect(call()).rejects.toThrow();
    }
    expect(plane.requests).toHaveLength(0);
  });

  // Contract: a version listing takes plain page options; history has no
  // branches, so a branch selector is refused as an unknown field on both
  // addresses before discovery or fetch.
  it("refuses a branch selector on both version-list addresses", async () => {
    const plane = new FakeControlPlane();
    const service = plane.client().account.computers;
    for (const branch of ["main", "", 123]) {
      const options = { branch } as unknown as PageOptions;
      await expect(service.listVersions("ordinary", options)).rejects.toThrow(
        "unknown field",
      );
      await expect(service.listVersionsById(RESOURCE, options)).rejects.toThrow(
        "unknown field",
      );
    }
    expect(plane.requests).toHaveLength(0);
  });

  // Contract: undefined and empty query selectors keep their ordinary omission
  // bytes; an explicit empty path still addresses the root. Nonempty strings
  // retain their literal query value.
  it("preserves ordinary omission and byte-valued selectors", async () => {
    const plane = new FakeControlPlane({
      routes: (request) => {
        if (request.url.host !== subnetHost) return undefined;
        if (
          request.url.pathname.endsWith("/content") ||
          request.url.pathname.endsWith("/archive")
        )
          return new Response("data");
        return new Response('{"items":[],"totalCount":0}', {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const service = plane.client().account.computers;
    for (const version of [undefined, ""]) {
      const options = { path: "", version } as FileReadOptions;
      const content = await service.readFilePiecesById(RESOURCE, options);
      await content.close();
      expect(plane.subnetRequests().at(-1)?.url.search).toBe("?path=");
      await service.listFilesById(RESOURCE, options);
      expect(plane.subnetRequests().at(-1)?.url.search).toBe("?path=");
    }
    await service.listVersionsById(RESOURCE, {});
    expect(plane.subnetRequests().at(-1)?.url.search).toBe("");
    for (const selector of [".", "..", " ", "a/b%", "雪\0"]) {
      const content = await service.readFilePiecesById(RESOURCE, {
        path: "file",
        version: selector,
      });
      await content.close();
      expect(
        plane.subnetRequests().at(-1)?.url.searchParams.get("version"),
      ).toBe(selector);
    }
  });
});
