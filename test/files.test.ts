// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ApiError,
  SAVE_REASON_ACCOUNT_STORAGE_LIMIT,
  SAVE_REASON_COMPUTER_SIZE,
  SAVE_REASON_NAME_LIMIT,
  isApiCode,
  type Computer,
  type UploadProgress,
} from "../src/index.js";
import { fileEtagOf } from "./fakes/content.js";
import { json } from "./fakes/control-plane.js";
import { FakeNetwork, computerRecord, computersPath } from "./fakes/network.js";
import { FakeWorkspace } from "./fakes/workspace.js";

const ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const byId = `${computersPath}/by-id/${ID}`;

async function computerWith(
  workspace: FakeWorkspace,
): Promise<{ computer: Computer; network: FakeNetwork }> {
  const network = new FakeNetwork(async (request, body) => {
    const { pathname } = request.url;
    if (pathname === `${computersPath}/api-dev` || pathname === byId) {
      return json({ computer: computerRecord({ headVersion: 7 }) });
    }
    return await workspace.route(request, body);
  });
  return {
    computer: await network.client().computers.get("api-dev"),
    network,
  };
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

interface TarEntry {
  readonly name: string;
  readonly type: string;
  readonly mode: number;
  readonly size: number;
  readonly pax?: string;
}

/** The entries of a tar archive, each header checked against its checksum. */
function tarEntries(archive: Uint8Array): TarEntry[] {
  const field = (block: Uint8Array, offset: number, width: number): string =>
    text(block.slice(offset, offset + width)).replace(/\0.*$/su, "");
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const block = archive.slice(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const sum = block.reduce(
      (total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte),
      0,
    );
    expect(parseInt(field(block, 148, 8), 8)).toBe(sum);
    expect(field(block, 257, 6)).toBe("ustar");
    const size = parseInt(field(block, 124, 12), 8);
    const type = field(block, 156, 1);
    const data = archive.slice(offset + 512, offset + 512 + size);
    entries.push({
      name: field(block, 0, 100),
      type,
      mode: parseInt(field(block, 100, 8), 8),
      size,
      ...(type === "x"
        ? { pax: text(data).replace(/^\d+ /u, "").replace(/\n$/u, "") }
        : {}),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("computer.files", () => {
  // Contract: an upload of one file publishes one version and returns it.
  it("uploads one file and returns its version", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer } = await computerWith(workspace);
    expect(await computer.files.upload("hello.py", 'print("hello")\n')).toEqual(
      { version: 4 },
    );
    expect(
      text(workspace.files.get("hello.py")?.bytes ?? new Uint8Array()),
    ).toBe('print("hello")\n');
    expect(workspace.files.get("hello.py")?.mode).toBe(0o644);
    expect(
      (
        await computer.files.upload("run.sh", new Uint8Array([35, 33]), {
          mode: 0o755,
        })
      ).version,
    ).toBe(5);
    expect(workspace.files.get("run.sh")?.mode).toBe(0o755);
  });

  // Contract: an upload and a change of files state the kind of client
  // making them, `sdk` unless the caller names another, so the history
  // entry each publishes records it.
  it("states the client of an upload and a change", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer, network } = await computerWith(workspace);
    await computer.files.upload("hello.py", "print()\n");
    await computer.files.upload("run.sh", "#!/bin/sh\n", { client: "console" });
    await computer.files.remove("hello.py", { client: "cli" });
    const created = network
      .computerRequests()
      .filter(
        (request) =>
          request.method === "POST" &&
          request.url.pathname === `${byId}/uploads`,
      )
      .map((request) => JSON.parse(request.body ?? "null") as unknown);
    expect(created).toEqual([
      { client: "sdk" },
      { client: "console" },
      { client: "cli" },
    ]);
  });

  // Contract: an upload to a running Computer says how the Computer
  // received it and, where it met unsaved work, names both copies' paths.
  it("reports the delivery and both kept copies of an upload", async () => {
    const workspace = new FakeWorkspace(byId);
    workspace.delivery = {
      state: "applied",
      replacedCount: 2,
      replaced: [
        { path: "notes.md", landedAt: { path: "notes (uploaded).md" } },
        { pathBase64: "/w==" },
      ],
    };
    const { computer } = await computerWith(workspace);
    expect(await computer.files.upload("notes.md", "uploaded\n")).toEqual({
      version: 4,
      delivery: {
        state: "applied",
        replacedCount: 2,
        replaced: [
          { path: "notes.md", landedAt: "notes (uploaded).md" },
          { path: "\uFFFD" },
        ],
      },
    });
    workspace.delivery = { state: "pending", replacedCount: 0 };
    expect(await computer.files.upload("late.md", "late\n")).toEqual({
      version: 5,
      delivery: { state: "pending", replacedCount: 0, replaced: [] },
    });
  });

  // Contract: many files are one version, whatever their sources.
  it("uploads many files as one version", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer } = await computerWith(workspace);
    const { version } = await computer.files.upload({
      "app.py": "main",
      "lib/util.py": new Blob(["util"]),
      "data.bin": new Blob([new Uint8Array([1, 2, 3])]).stream(),
    });
    expect(version).toBe(4);
    expect([...workspace.files.keys()].sort()).toEqual([
      "app.py",
      "data.bin",
      "lib/util.py",
    ]);
  });

  // Contract: onProgress reports each file in the order sent, once as its
  // transfer starts and after every accepted part, with the size its data
  // states; a stream has no size until it ends.
  it("reports each file's accepted bytes as its parts are accepted", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer } = await computerWith(workspace);
    const MiB = 1024 * 1024;
    const reported: UploadProgress[] = [];
    await computer.files.upload(
      {
        "big.bin": new Uint8Array(2 * MiB + 512),
        "note.txt": "héllo",
        "data.bin": new Blob([new Uint8Array([1, 2, 3])]).stream(),
      },
      { onProgress: (progress) => reported.push(progress) },
    );
    expect(reported).toEqual([
      { path: "big.bin", sent: 0, size: 2 * MiB + 512 },
      { path: "big.bin", sent: MiB, size: 2 * MiB + 512 },
      { path: "big.bin", sent: 2 * MiB, size: 2 * MiB + 512 },
      { path: "big.bin", sent: 2 * MiB + 512, size: 2 * MiB + 512 },
      { path: "note.txt", sent: 0, size: 6 },
      { path: "note.txt", sent: 6, size: 6 },
      { path: "data.bin", sent: 0 },
      { path: "data.bin", sent: 3 },
    ]);
  });

  // Contract: an exception onProgress throws ends the upload with it, and
  // no version is published.
  it("ends an upload with the exception its progress throws", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer } = await computerWith(workspace);
    const stop = new Error("stop here");
    await expect(
      computer.files.upload("a.txt", "abc", {
        onProgress: ({ sent }) => {
          if (sent > 0) throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(workspace.files.size).toBe(0);
  });

  // Contract: an archive is unpacked into the directory it names.
  it("uploads a directory as an archive", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer } = await computerWith(workspace);
    await computer.files.upload("src", new Uint8Array([1, 2]), {
      archive: true,
    });
    expect(workspace.archives).toEqual([
      { path: "src", bytes: new Uint8Array([1, 2]) },
    ]);
    await expect(
      computer.files.upload("src", "x", { archive: true, mode: 0o644 }),
    ).rejects.toThrow("mode does not apply to an archive");
  });

  // Contract: a folder is an archive of one empty directory entry, sent
  // into its parent on the version the existence check read.
  it("creates a folder", async () => {
    const workspace = new FakeWorkspace(byId);
    workspace.files.set("src/main.py", {
      bytes: new Uint8Array(1),
      mode: 0o644,
    });
    const { computer, network } = await computerWith(workspace);
    expect(await computer.files.createFolder("src/lib")).toBe(4);
    expect(workspace.archives).toHaveLength(1);
    const [sent] = workspace.archives;
    expect(sent?.path).toBe("src");
    expect(sent?.bytes).toHaveLength(3 * 512);
    expect(tarEntries(sent?.bytes ?? new Uint8Array())).toEqual([
      { name: "lib/", type: "5", mode: 0o755, size: 0 },
    ]);
    const listing = network
      .computerRequests()
      .find((request) => request.url.pathname.endsWith("/files"));
    expect(listing?.url.searchParams.get("path")).toBe("src");
    expect(listing?.url.searchParams.get("version")).toBe("3");
    expect(await computer.files.createFolder("docs")).toBe(5);
    expect(workspace.archives[1]?.path).toBe("");
  });

  // Contract: a name past the ustar name field travels in a pax header.
  it("creates a folder with a long name", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer } = await computerWith(workspace);
    const name = "é".repeat(120);
    await computer.files.createFolder(name);
    const entries = tarEntries(
      workspace.archives[0]?.bytes ?? new Uint8Array(),
    );
    expect(entries.map((entry) => entry.type)).toEqual(["x", "5"]);
    expect(entries[0]?.pax).toBe(`path=${name}/`);
  });

  // Contract: a taken name or a missing parent is refused, the upload
  // cancelled and nothing sent.
  it("refuses a taken name and a missing parent", async () => {
    const workspace = new FakeWorkspace(byId);
    workspace.files.set("notes.txt", { bytes: new Uint8Array(1), mode: 0o644 });
    workspace.files.set("src/main.py", {
      bytes: new Uint8Array(1),
      mode: 0o644,
    });
    const { computer } = await computerWith(workspace);
    for (const taken of ["notes.txt", "src"]) {
      await expect(computer.files.createFolder(taken)).rejects.toMatchObject({
        status: 409,
        detail: `${taken} already exists`,
      });
    }
    await expect(computer.files.createFolder("lib/util")).rejects.toMatchObject(
      { status: 404, detail: "folder lib does not exist" },
    );
    expect(workspace.cancelled).toBe(3);
    expect(workspace.archives).toHaveLength(0);
    for (const path of ["", "/tmp", "a/../b", "a/"]) {
      await expect(computer.files.createFolder(path)).rejects.toThrow(
        TypeError,
      );
    }
  });

  // Contract: a change to the same path after the base ends the upload in
  // conflict.
  it("reports a folder that conflicted", async () => {
    const workspace = new FakeWorkspace(byId);
    workspace.outcome = "conflict";
    const { computer } = await computerWith(workspace);
    await expect(computer.files.createFolder("new")).rejects.toMatchObject({
      status: 409,
      code: "UPLOAD_CONFLICT",
    });
  });

  // Contract: a download is a body read once, the fetch way, resolved with
  // HEAD to one version and pinned to it, stating what it is.
  it("downloads a file as a body read once", async () => {
    const workspace = new FakeWorkspace(byId);
    const bytes = new TextEncoder().encode('{"ok":true}');
    workspace.files.set("app.json", { bytes, mode: 0o644 });
    const { computer, network } = await computerWith(workspace);
    const body = await computer.files.download("app.json", { version: 3 });
    expect(body.version).toBe(3);
    expect(body.size).toBe(bytes.length);
    expect(body.etag).toBe(fileEtagOf(bytes));
    expect(body.bodyUsed).toBe(false);
    expect(await body.json()).toEqual({ ok: true });
    expect(body.bodyUsed).toBe(true);
    await expect(body.text()).rejects.toThrow("already been read");
    const reads = network
      .computerRequests()
      .filter((request) => request.url.pathname.endsWith("/files/content"));
    expect(reads.map((request) => request.method)).toEqual(["HEAD", "GET"]);
    for (const read of reads) {
      expect(read.url.searchParams.get("version")).toBe("3");
      expect(read.url.searchParams.get("path")).toBe("app.json");
    }
    expect(reads[1]?.headers.get("range")).toBe(
      `bytes=0-${String(bytes.length - 1)}`,
    );
    expect(reads[1]?.headers.get("if-range")).toBe(fileEtagOf(bytes));
  });

  // Contract: a file that is not there rejects the download itself, before
  // any body exists.
  it("rejects a download of a missing file", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer } = await computerWith(workspace);
    await expect(computer.files.download("absent")).rejects.toMatchObject({
      status: 404,
    });
  });

  // Contract: a download link names the path and the version on the wire
  // and returns the address, its expiry and the version it stays on.
  it("creates a download link", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer } = await computerWith(workspace);
    expect(await computer.files.downloadLink("data.bin")).toEqual({
      url: "https://download.example.test/link",
      expiresAt: "2026-01-02T03:04:05Z",
      version: 3,
    });
    await computer.files.downloadLink("src", { version: 2 });
    await computer.files.downloadLink("", { version: "release" });
    expect(workspace.links).toEqual([
      { path: "data.bin" },
      { path: "src", version: "2" },
      { path: "", version: "release" },
    ]);
  });

  // Contract: a link never starts a save, and its path stays in the
  // workspace; each is refused with no link asked for.
  it("refuses a download link that saves first or leaves the workspace", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer } = await computerWith(workspace);
    await expect(
      computer.files.downloadLink("a", { version: "save-first" }),
    ).rejects.toThrow("a download link cannot save first");
    await expect(computer.files.downloadLink("/etc/passwd")).rejects.toThrow(
      TypeError,
    );
    expect(workspace.links).toEqual([]);
  });

  // Contract: a listed entry states its tag where the listing gives one, and
  // an entry without one, or without a sha256, reads as it was served.
  it("states a listed file's tag where given", async () => {
    const tag = "a".repeat(64);
    const network = new FakeNetwork((request) => {
      const { pathname } = request.url;
      if (pathname === `${computersPath}/api-dev` || pathname === byId) {
        return json({ computer: computerRecord({ headVersion: 7 }) });
      }
      if (pathname === `${byId}/files`) {
        return json({
          items: [
            { name: "a", type: "file", mode: 0o644, size: 1, tag },
            { name: "b", type: "file", mode: 0o644, size: 2 },
          ],
          totalCount: 2,
        });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    const entries = [];
    for await (const entry of computer.files.list()) entries.push(entry);
    expect(entries).toEqual([
      { path: "a", type: "file", size: 1, mode: 0o644, tag },
      { path: "b", type: "file", size: 2, mode: 0o644 },
    ]);
  });

  // Contract: a listing yields each entry with its workspace path, and
  // recursively the directories below.
  it("lists, recursively", async () => {
    const workspace = new FakeWorkspace(byId);
    for (const path of ["a.txt", "src/main.py", "src/lib/util.py"]) {
      workspace.files.set(path, { bytes: new Uint8Array(2), mode: 0o644 });
    }
    const { computer, network } = await computerWith(workspace);
    const top = [];
    for await (const entry of computer.files.list()) top.push(entry.path);
    expect(top.sort()).toEqual(["a.txt", "src"]);
    const all = [];
    for await (const entry of computer.files.list("src", { recursive: true })) {
      all.push([entry.path, entry.type, entry.size]);
    }
    expect(all).toEqual([
      ["src/main.py", "file", 2],
      ["src/lib", "dir", 0],
      ["src/lib/util.py", "file", 2],
    ]);
    // The recursive walk reads one saved version throughout.
    const versions = network
      .computerRequests()
      .filter((request) => request.url.pathname.endsWith("/files"))
      .slice(1)
      .map((request) => request.url.searchParams.get("version"));
    expect(versions).toEqual(["7", "7"]);
  });

  // Contract: move and remove are one version each.
  it("moves and removes", async () => {
    const workspace = new FakeWorkspace(byId);
    for (const path of ["app.py", "old.txt", "tmp/a"]) {
      workspace.files.set(path, { bytes: new Uint8Array(1), mode: 0o644 });
    }
    const { computer } = await computerWith(workspace);
    expect(await computer.files.move("app.py", "src/main.py")).toBe(4);
    expect(await computer.files.remove(["old.txt", "tmp"])).toBe(5);
    expect([...workspace.files.keys()]).toEqual(["src/main.py"]);
    expect(workspace.changes).toEqual([
      {
        seq: 1,
        rename: [{ from: { path: "app.py" }, to: { path: "src/main.py" } }],
      },
      { seq: 1, delete: [{ path: "old.txt" }, { path: "tmp" }] },
    ]);
  });

  // Contract: a path outside the workspace is refused before any request.
  it("refuses paths that leave the workspace", async () => {
    const workspace = new FakeWorkspace(byId);
    const { computer, network } = await computerWith(workspace);
    const before = network.computerRequests().length;
    for (const path of [
      "/etc/passwd",
      "../x",
      "a/../../b",
      "a//b",
      "./a",
      "",
    ]) {
      await expect(computer.files.upload(path, "x")).rejects.toThrow(TypeError);
    }
    await expect(computer.files.download("/workspace/a")).rejects.toThrow(
      TypeError,
    );
    await expect(computer.files.remove([])).rejects.toThrow(TypeError);
    await expect(computer.files.upload({})).rejects.toThrow(TypeError);
    await expect(
      computer.files.upload("a", "x", { mode: 0o10000 }),
    ).rejects.toThrow(TypeError);
    expect(network.computerRequests()).toHaveLength(before);
  });

  // Contract: an upload that ends without publishing is an ApiError with
  // its outcome's code.
  it("reports an upload that did not publish", async () => {
    const workspace = new FakeWorkspace(byId);
    workspace.outcome = "conflict";
    const { computer } = await computerWith(workspace);
    const error = await computer.files
      .upload("a.txt", "x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "UPLOAD_CONFLICT",
      detail: "files changed",
    });
  });

  // Contract: an upload that fails for size carries its reason as its code,
  // one of the three size reasons; any other failure carries no code.
  it("reports an upload that failed for size", async () => {
    for (const reason of [
      SAVE_REASON_ACCOUNT_STORAGE_LIMIT,
      SAVE_REASON_COMPUTER_SIZE,
      SAVE_REASON_NAME_LIMIT,
    ]) {
      const workspace = new FakeWorkspace(byId);
      workspace.outcome = "failed";
      workspace.reason = reason;
      const { computer } = await computerWith(workspace);
      const error = await computer.files
        .upload("a.txt", "x")
        .catch((e: unknown) => e);
      expect(isApiCode(error, reason)).toBe(true);
      expect(error).toMatchObject({ status: 409, detail: reason });
    }
    const workspace = new FakeWorkspace(byId);
    workspace.outcome = "failed";
    workspace.reason = "node-disk-failed";
    const { computer } = await computerWith(workspace);
    const error = await computer.files
      .upload("a.txt", "x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBeUndefined();
  });
});
