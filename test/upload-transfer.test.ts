// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeUploadTransfer,
  encodeUploadTransfer,
  type UploadTransfer,
} from "../src/api/upload-transfer.js";
import { UploadTransferFailedError } from "../src/errors.js";
import { type JsonObject } from "../src/resource/json.js";
import { parseStorageOperationId } from "../src/resource/uuid-id.js";
import {
  FakeControlPlane,
  json,
  subnetHost,
  namespacePathPrefix,
} from "./fakes/control-plane.js";

const RESOURCE = "00000000-0000-4000-8000-000000000004";
const OPERATION = "00000000-0000-4000-8000-000000000020";
const TRANSFER = "00000000-0000-4000-8000-000000000021";
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const empty = digest(new Uint8Array());
function source(bytes: Uint8Array, chunk = 1): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else {
          controller.enqueue(bytes.subarray(offset, offset + chunk));
          offset = Math.min(offset + chunk, bytes.length);
        }
      },
    },
    { highWaterMark: 0 },
  );
}
interface ReceiverOptions {
  readonly budget?: number;
  readonly accepted?: Uint8Array;
  readonly state?: string;
  readonly lostPartAck?: boolean;
  readonly lostCompleteAck?: boolean;
  readonly stalePartRead?: boolean;
  readonly processingReads?: number;
  readonly changedPrefix?: boolean;
}
function receiver(options: ReceiverOptions = {}) {
  let accepted = options.accepted ?? new Uint8Array();
  let state = options.state ?? "receiving";
  let partLost = options.lostPartAck === true;
  let completionLost = options.lostCompleteAck === true;
  let stale = false;
  let polls = 0;
  const parts: { offset: string; bytes: Uint8Array }[] = [];
  const completions: unknown[] = [];
  let creation: unknown;
  function value(): JsonObject {
    return {
      id: TRANSFER,
      seq: 1,
      state,
      nextOffset: String(accepted.length),
      prefixSHA256: options.changedPrefix ? empty : digest(accepted),
      maxPartBytes: String(options.budget ?? 4),
      ...(state === "complete"
        ? { receipt: { seq: 1, fingerprint: "accepted" } }
        : {}),
      ...(state === "failed"
        ? { failure: { code: "PATH_INVALID", error: "failed" } }
        : {}),
    };
  }
  const plane = new FakeControlPlane({
    routes: (request, body) => {
      if (request.url.host !== subnetHost) return undefined;
      return (async () => {
        const path = request.url.pathname;
        if (request.init.method === "POST" && path.endsWith("/transfers")) {
          creation = body;
          return json(value());
        }
        if (request.init.method === "GET" && path.endsWith(TRANSFER)) {
          if (stale) {
            stale = false;
            return json({ ...value(), nextOffset: "0", prefixSHA256: empty });
          }
          if (
            state === "processing" &&
            ++polls >= (options.processingReads ?? 1)
          )
            state = "complete";
          return json(value());
        }
        if (request.init.method === "PUT" && path.includes("/parts/")) {
          const bytes = new Uint8Array(
            await new Response(request.init.body).arrayBuffer(),
          );
          const offset = path.split("/").at(-1) ?? "";
          parts.push({ offset, bytes });
          expect(bytes.length).toBeLessThanOrEqual(options.budget ?? 4);
          expect(request.url.searchParams.get("sha256")).toBe(digest(bytes));
          expect(request.headers.get("content-type")).toBe(
            "application/octet-stream",
          );
          expect(request.init.redirect).toBe("manual");
          if (Number(offset) === accepted.length) {
            const joined = new Uint8Array(accepted.length + bytes.length);
            joined.set(accepted);
            joined.set(bytes, accepted.length);
            accepted = joined;
          } else
            expect(
              accepted.slice(Number(offset), Number(offset) + bytes.length),
            ).toEqual(bytes);
          if (partLost) {
            partLost = false;
            stale = options.stalePartRead === true;
            throw new Error("connection reset after acceptance");
          }
          return json(value());
        }
        if (request.init.method === "POST" && path.endsWith("/complete")) {
          completions.push(body);
          expect(body).toEqual({
            length: String(accepted.length),
            sha256: digest(accepted),
          });
          state = options.processingReads ? "processing" : "complete";
          if (completionLost) {
            completionLost = false;
            throw new Error("connection reset after seal");
          }
          return json(value());
        }
        return json({ error: "unexpected route" }, 404);
      })();
    },
  });
  const service = plane.client().account.computers;
  return {
    plane,
    service,
    parts,
    completions,
    creation: () => creation,
    accepted: () => accepted,
  };
}

describe("bounded upload streams", () => {
  // Contract: unknown-length and empty file/archive sources share the same
  // bounded transport and never publish their parent Upload.
  it.each([false, true])(
    "sends bounded parts for archive=%s",
    async (archive) => {
      for (const bytes of [
        new Uint8Array(),
        new TextEncoder().encode("a longer stream"),
      ]) {
        const test = receiver();
        const result = archive
          ? await test.service.uploadArchiveById(
              RESOURCE,
              OPERATION,
              { path: "", seq: 1 },
              source(bytes, 3),
            )
          : await test.service.uploadFileById(
              RESOURCE,
              OPERATION,
              { path: "file", mode: 0o644, seq: 1 },
              source(bytes, 3),
            );
        expect(result).toEqual({ seq: 1, fingerprint: "accepted" });
        expect(test.accepted()).toEqual(bytes);
        expect(test.parts.map((part) => part.offset)).toEqual(
          bytes.length === 0 ? [] : ["0", "4", "8", "12"],
        );
        expect(test.creation()).toEqual({
          path: archive ? "" : "file",
          seq: 1,
          kind: archive ? "archive" : "file",
          ...(archive ? {} : { mode: 0o644 }),
        });
        expect(
          test.plane.requests.every(
            (req) => !/\/(content|archive|publish)$/u.test(req.url.pathname),
          ),
        ).toBe(true);
      }
    },
  );
  // Contract: a lost successful response is recovered by reading durable
  // progress or by replaying exactly the retained part at the same offset.
  it.each([false, true])(
    "recovers a lost part ACK with stale read=%s",
    async (stalePartRead) => {
      const test = receiver({ lostPartAck: true, stalePartRead });
      const bytes = new TextEncoder().encode("abcdefgh");
      await test.service.uploadFileById(
        RESOURCE,
        OPERATION,
        { path: "file", mode: 0, seq: 1 },
        source(bytes),
      );
      expect(test.accepted()).toEqual(bytes);
      expect(test.parts.map((part) => part.offset)).toEqual(
        stalePartRead ? ["0", "0", "4"] : ["0", "4"],
      );
    },
  );
  it("replays completion after its response is lost", async () => {
    const test = receiver({ lostCompleteAck: true });
    await test.service.uploadFileById(
      RESOURCE,
      OPERATION,
      { path: "file", mode: 0, seq: 1 },
      source(new Uint8Array()),
    );
    expect(test.completions).toHaveLength(2);
    expect(test.completions[0]).toEqual(test.completions[1]);
  });
  // Contract: the accepted prefix is hashed again before any tail is sent.
  it("resumes only after verifying the accepted prefix", async () => {
    const test = receiver({ accepted: new TextEncoder().encode("abcd") });
    await test.service.uploadFileById(
      RESOURCE,
      OPERATION,
      { path: "file", mode: 0, seq: 1 },
      source(new TextEncoder().encode("abcdefgh")),
    );
    expect(test.parts.map((part) => part.offset)).toEqual(["4"]);
    const mismatch = receiver({ accepted: new TextEncoder().encode("abcd") });
    await expect(
      mismatch.service.uploadFileById(
        RESOURCE,
        OPERATION,
        { path: "file", mode: 0, seq: 1 },
        source(new TextEncoder().encode("xxxxefgh")),
      ),
    ).rejects.toThrow("verified source prefix");
    expect(mismatch.parts).toHaveLength(0);
    expect(mismatch.completions).toHaveLength(0);
  });
  // Contract: the accepted byte count is reported once the verified prefix
  // is known and again after each accepted part, a part recovered from a
  // lost response included, and never goes backwards.
  it.each([false, true])(
    "reports accepted bytes after each part with a lost ACK=%s",
    async (lostPartAck) => {
      const test = receiver({
        accepted: new TextEncoder().encode("ab"),
        lostPartAck,
      });
      const reported: bigint[] = [];
      await test.service.uploadFileById(
        RESOURCE,
        OPERATION,
        { path: "file", mode: 0, seq: 1 },
        source(new TextEncoder().encode("abcdefghij")),
        { accepted: (bytes) => reported.push(bytes) },
      );
      expect(reported).toEqual([2n, 6n, 10n]);
    },
  );
  // Contract: complete replay verifies actual EOF and performs no mutation
  // against a parent that may already have published.
  it("returns the receipt of a complete transfer without resealing", async () => {
    const bytes = new TextEncoder().encode("done");
    const test = receiver({ accepted: bytes, state: "complete" });
    await test.service.uploadFileById(
      RESOURCE,
      OPERATION,
      { path: "file", mode: 0, seq: 1 },
      source(bytes),
    );
    expect(test.parts).toHaveLength(0);
    expect(test.completions).toHaveLength(0);
    expect(test.plane.requests).toHaveLength(1);
    const longer = receiver({ accepted: bytes, state: "complete" });
    await expect(
      longer.service.uploadFileById(
        RESOURCE,
        OPERATION,
        { path: "file", mode: 0, seq: 1 },
        source(new TextEncoder().encode("done!")),
      ),
    ).rejects.toThrow("longer than the sealed");
    const shorter = receiver({ accepted: bytes, state: "complete" });
    await expect(
      shorter.service.uploadFileById(
        RESOURCE,
        OPERATION,
        { path: "file", mode: 0, seq: 1 },
        source(new TextEncoder().encode("end")),
      ),
    ).rejects.toThrow("shorter than the accepted");
  });
  it("returns failed and unknown lifecycle states without reading the source", async () => {
    for (const state of ["failed", "future-state"]) {
      let reads = 0;
      const input = new ReadableStream<Uint8Array>(
        {
          pull() {
            reads++;
          },
        },
        { highWaterMark: 0 },
      );
      const test = receiver({ state });
      const promise = test.service.uploadFileById(
        RESOURCE,
        OPERATION,
        { path: "file", mode: 0, seq: 1 },
        input,
      );
      if (state === "failed")
        await expect(promise).rejects.toBeInstanceOf(UploadTransferFailedError);
      else
        await expect(promise).rejects.toThrow("unknown upload transfer state");
      expect(reads).toBe(0);
      await input.cancel();
    }
  });
  // Contract: a server advertising a larger body budget cannot increase the
  // SDK's bounded buffer, and total stream length remains independent of it.
  it("caps its own part size even with a larger advertised budget", async () => {
    const test = receiver({ budget: 8 * 1024 * 1024 });
    const bytes = new Uint8Array(4 * 1024 * 1024 + 17).fill(7);
    await test.service.uploadFileById(
      RESOURCE,
      OPERATION,
      { path: "file", mode: 0, seq: 1 },
      source(bytes, 65536),
    );
    expect(test.parts.map((part) => part.bytes.length)).toEqual([
      4 * 1024 * 1024,
      17,
    ]);
    expect(digest(test.accepted())).toBe(digest(bytes));
  });
  it("polls durable archive ingestion after sealing", async () => {
    const test = receiver({ processingReads: 1 });
    await test.service.uploadArchiveById(
      RESOURCE,
      OPERATION,
      { path: "", seq: 1 },
      source(new Uint8Array()),
    );
    expect(
      test.plane.requests.filter((request) => request.init.method === "GET"),
    ).toHaveLength(1);
  });
  it("refuses malformed response counts before reading or allocating", async () => {
    for (const nextOffset of ["01", "-1", "18446744073709551616", {}, 1]) {
      let reads = 0;
      const input = new ReadableStream<Uint8Array>(
        {
          pull() {
            reads++;
          },
        },
        { highWaterMark: 0 },
      );
      const plane = new FakeControlPlane({
        routes: (request) =>
          request.url.host === subnetHost
            ? json({
                id: TRANSFER,
                seq: 1,
                state: "receiving",
                nextOffset,
                maxPartBytes: "4194304",
                prefixSHA256: empty,
              })
            : undefined,
      });
      const service = plane.client().account.computers;
      const pending = service.uploadFileById(
        RESOURCE,
        OPERATION,
        { path: "file", mode: 0, seq: 1 },
        input,
      );
      await expect(pending).rejects.toThrow();
      expect(reads).toBe(0);
      await input.cancel();
    }
  });
  // Contract: the caller can interrupt an idle source without a transfer-wide
  // elapsed timeout, and cancellation releases its reader lock.
  it("cancels while the source is idle", async () => {
    const test = receiver();
    const controller = new AbortController();
    let pending!: () => void;
    const reading = new Promise<void>((resolve) => {
      pending = resolve;
    });
    let cancelled = 0;
    const input = new ReadableStream<Uint8Array>(
      {
        pull() {
          pending();
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const result = test.service.uploadFileById(
      RESOURCE,
      OPERATION,
      { path: "file", mode: 0, seq: 1 },
      input,
      { signal: controller.signal },
    );
    await reading;
    controller.abort(new Error("caller stopped"));
    await expect(result).rejects.toThrow("caller stopped");
    expect(cancelled).toBe(1);
    expect(input.locked).toBe(false);
    expect(test.parts).toHaveLength(0);
  });
});

// Contract: exact unsigned byte strings and sequence numbers never pass through
// rounded JavaScript arithmetic; every resource addressing form uses one shape.
describe("upload transfer contracts", () => {
  it("retains exact uint64 byte counts and newer fields", () => {
    const wire = {
      id: TRANSFER,
      seq: 18446744073709551615n,
      state: "future",
      nextOffset: "18446744073709551615",
      maxPartBytes: "4194304",
      prefixSHA256: empty,
      newer: 9,
    };
    const transfer = decodeUploadTransfer(wire);
    expect(transfer.nextOffset).toBe(18446744073709551615n);
    expect(transfer.state).toBe("future");
    const canonical = { ...wire };
    Reflect.deleteProperty(canonical, "newer");
    expect(encodeUploadTransfer(transfer)).toEqual(canonical);
    for (const nextOffset of ["01", "-1", "18446744073709551616", {}, 1])
      expect(() => decodeUploadTransfer({ ...wire, nextOffset })).toThrow();
  });
  it("routes creation, status, part and seal by name and identity in both families", async () => {
    for (const family of ["computers"] as const)
      for (const byId of [false, true]) {
        const reply: UploadTransfer = {
          id: parseStorageOperationId(TRANSFER),
          seq: 1,
          state: "receiving",
          nextOffset: 0,
          maxPartBytes: 4,
          prefixSHA256: empty,
        };
        const plane = new FakeControlPlane({
          routes: (request) =>
            request.url.host === subnetHost
              ? json(encodeUploadTransfer(reply))
              : undefined,
        });
        const client = plane.client();
        const service = client.account.computers;
        const address = byId ? RESOURCE : "example";
        const suffix = byId ? "ById" : "";
        await service[`createUploadTransfer${suffix}`](address, OPERATION, {
          path: "file",
          seq: 1,
          kind: "file",
        });
        await service[`getUploadTransfer${suffix}`](
          address,
          OPERATION,
          TRANSFER,
        );
        const bytes = new Uint8Array([1]);
        await service[`uploadTransferPart${suffix}`](
          address,
          OPERATION,
          TRANSFER,
          18446744073709551614n,
          digest(bytes),
          bytes,
        );
        await service[`completeUploadTransfer${suffix}`](
          address,
          OPERATION,
          TRANSFER,
          { length: 18446744073709551615n, sha256: empty },
        );
        const base = byId
          ? `${namespacePathPrefix}/${family}/by-id/${RESOURCE}`
          : `${namespacePathPrefix}/${family}/example`;
        expect(plane.requests.map((req) => req.url.pathname)).toEqual([
          `${base}/uploads/${OPERATION}/transfers`,
          `${base}/uploads/${OPERATION}/transfers/${TRANSFER}`,
          `${base}/uploads/${OPERATION}/transfers/${TRANSFER}/parts/18446744073709551614`,
          `${base}/uploads/${OPERATION}/transfers/${TRANSFER}/complete`,
        ]);
        expect(plane.requests.map((req) => req.init.method)).toEqual([
          "POST",
          "GET",
          "PUT",
          "POST",
        ]);
      }
  });
});
