// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * A Computer's saved files, in memory, behind the storage routes the files
 * API uses: uploads with their transfers, change pages and publication,
 * listings and content. Each published upload is one new version.
 */
import { sha256Hex } from "../../src/resource/sha256.js";
import { fileEtagOf, serveContent } from "./content.js";
import { json } from "./control-plane.js";
import type { RecordedRequest } from "./fetch-queue.js";

const OPERATION = "01954e20-7540-7ec4-93ec-14f783e6ab61";
const TRANSFER = "01954e20-7540-7ec4-93ec-14f783e6ab62";

interface Staged {
  readonly kind: string;
  readonly path: string;
  readonly mode: number;
  bytes: Uint8Array;
  complete: boolean;
}

/** One saved file. */
export interface SavedFile {
  readonly bytes: Uint8Array;
  readonly mode: number;
}

export class FakeWorkspace {
  /** The files of the newest version, by path. */
  files = new Map<string, SavedFile>();
  /** The newest version. */
  version = 3;
  /** How a publication ends: `published`, or a refusal such as `conflict`. */
  outcome = "published";
  /** The reason a `failed` publication states. */
  reason = "";
  /** The delivery a published upload reports, when a Computer is running. */
  delivery: Record<string, unknown> | undefined;
  /** Every archive accepted, by destination. */
  readonly archives: { path: string; bytes: Uint8Array }[] = [];
  /** Every change page accepted. */
  readonly changes: unknown[] = [];
  /** Every download link asked for, by its request. */
  readonly links: unknown[] = [];
  /** How many uploads were cancelled. */
  cancelled = 0;
  readonly #staged = new Map<number, Staged>();
  #pending: unknown[] = [];
  #state = "open";

  constructor(readonly base: string) {}

  /** Answers the storage routes under `base`; declines anything else. */
  readonly route = async (
    request: RecordedRequest,
    body: unknown,
  ): Promise<Response | undefined> => {
    const { pathname, searchParams } = request.url;
    if (!pathname.startsWith(this.base)) return undefined;
    const path = pathname.slice(this.base.length);
    const method = request.init.method ?? "GET";
    const uploads = `/uploads/${OPERATION}`;
    if (path === "/uploads" && method === "POST") {
      this.#staged.clear();
      this.#pending = [];
      this.#state = "open";
      return json(this.#upload(), 201);
    }
    if (path === uploads && method === "GET") return json(this.#upload());
    if (path === uploads && method === "DELETE") {
      this.cancelled += 1;
      this.#state = "cancelled";
      return json(this.#upload());
    }
    if (path === `${uploads}/transfers` && method === "POST") {
      const creation = body as {
        seq: string | number;
        kind: string;
        path?: string;
        mode?: number;
      };
      const seq = Number(creation.seq);
      this.#staged.set(seq, {
        kind: creation.kind,
        path: creation.path ?? "",
        mode: creation.mode ?? 0,
        bytes: new Uint8Array(),
        complete: false,
      });
      return json(this.#transfer(seq));
    }
    const transfer = /^\/uploads\/[^/]+\/transfers\/[^/]+(\/.*)?$/u.exec(path);
    if (transfer !== null) {
      const seq = [...this.#staged.keys()].at(-1) ?? 1;
      const staged = this.#staged.get(seq);
      if (staged === undefined) return json({ error: "no transfer" }, 404);
      const rest = transfer[1] ?? "";
      if (rest.startsWith("/parts/") && method === "PUT") {
        const bytes = new Uint8Array(
          await new Response(request.init.body).arrayBuffer(),
        );
        const joined = new Uint8Array(staged.bytes.length + bytes.length);
        joined.set(staged.bytes);
        joined.set(bytes, staged.bytes.length);
        staged.bytes = joined;
      }
      if (rest === "/complete") staged.complete = true;
      return json(this.#transfer(seq));
    }
    if (path === `${uploads}/changes` && method === "POST") {
      this.changes.push(body);
      this.#pending.push(body);
      const seq = (body as { seq: number }).seq;
      return json({ seq, fingerprint: "a".repeat(64) });
    }
    if (path === `${uploads}/publish` && method === "POST") {
      this.#state = this.outcome;
      if (this.outcome === "published") this.#publish();
      return json(this.#upload());
    }
    if (path === "/files" && method === "GET") {
      const directory = searchParams.get("path") ?? "";
      const prefix = directory === "" ? "" : `${directory}/`;
      const names = new Map<string, Record<string, unknown>>();
      for (const [file, saved] of this.files) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...below] = file.slice(prefix.length).split("/");
        if (name === undefined) continue;
        names.set(
          name,
          below.length > 0
            ? { name, type: "dir", mode: 0o755, size: 0 }
            : {
                name,
                type: "file",
                mode: saved.mode,
                size: saved.bytes.length,
              },
        );
      }
      if (directory !== "" && names.size === 0) {
        return json({ error: "saved path not found" }, 404);
      }
      return json({ items: [...names.values()], totalCount: names.size });
    }
    if (path === "/files/content" && (method === "GET" || method === "HEAD")) {
      const saved = this.files.get(searchParams.get("path") ?? "");
      if (saved === undefined) {
        return method === "HEAD"
          ? new Response(null, { status: 404 })
          : json({ error: "not found", code: "PATH_INVALID" }, 404);
      }
      return serveContent(request, {
        bytes: saved.bytes,
        etag: fileEtagOf(saved.bytes),
        version: this.version,
      });
    }
    if (path === "/files/download-link" && method === "POST") {
      this.links.push(body);
      return json(
        {
          url: "https://download.example.test/link",
          expiresAt: "2026-01-02T03:04:05Z",
          version: this.version,
        },
        201,
      );
    }
    return undefined;
  };

  #upload(): Record<string, unknown> {
    return {
      id: OPERATION,
      state: this.#state,
      base: this.version,
      ...(this.#state === "published" ? { version: this.version } : {}),
      ...(this.#state === "published" && this.delivery !== undefined
        ? { delivery: this.delivery }
        : {}),
      ...(this.#state === "conflict" ? { reason: "files changed" } : {}),
      ...(this.#state === "failed" && this.reason !== ""
        ? { reason: this.reason }
        : {}),
    };
  }

  #transfer(seq: number): Record<string, unknown> {
    const staged = this.#staged.get(seq);
    const bytes = staged?.bytes ?? new Uint8Array();
    return {
      id: TRANSFER,
      seq,
      state: staged?.complete === true ? "complete" : "receiving",
      nextOffset: String(bytes.length),
      prefixSHA256: sha256Hex(bytes),
      maxPartBytes: String(1 << 20),
      ...(staged?.complete === true
        ? { receipt: { seq, fingerprint: "b".repeat(64) } }
        : {}),
    };
  }

  #publish(): void {
    for (const staged of this.#staged.values()) {
      if (staged.kind === "archive") {
        this.archives.push({ path: staged.path, bytes: staged.bytes });
      } else {
        this.files.set(staged.path, { bytes: staged.bytes, mode: staged.mode });
      }
    }
    for (const page of this.#pending as {
      delete?: { path: string }[];
      rename?: { from: { path: string }; to: { path: string } }[];
    }[]) {
      for (const removed of page.delete ?? []) {
        for (const file of [...this.files.keys()]) {
          if (file === removed.path || file.startsWith(`${removed.path}/`)) {
            this.files.delete(file);
          }
        }
      }
      for (const { from, to } of page.rename ?? []) {
        const saved = this.files.get(from.path);
        if (saved !== undefined) {
          this.files.delete(from.path);
          this.files.set(to.path, saved);
        }
      }
    }
    this.version += 1;
  }
}
