// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

import { FakeControlPlane, subnetHost } from "./fakes/control-plane.js";

const RESOURCE = "00000000-0000-4000-8000-000000000004";
const OPERATION = "00000000-0000-4000-8000-000000000020";
const INT64_MAX = 9223372036854775807n;
const UINT64_MAX = 18446744073709551615n;

async function requestText(request: IncomingMessage): Promise<string> {
  let text = "";
  request.setEncoding("utf8");
  for await (const chunk of request) text += String(chunk);
  return text;
}

describe("native integral HTTP bytes", () => {
  // Contract: native methods preserve the literal body, query, receipt and
  // header digits over an actual local HTTP connection. The test-only bridge
  // maps the synthetic public API origin to this disposable receiver.
  it("preserves exact wide values at the receiver and response boundaries", async () => {
    const received: { method: string; uri: string; body: string }[] = [];
    const server = createServer((request, reply) => {
      void (async () => {
        received.push({
          method: request.method ?? "",
          uri: request.url ?? "",
          body: await requestText(request),
        });
        if (request.method === "GET") {
          reply.setHeader("Idyl-Saved-Version", "9223372036854775807");
          reply.end("content");
        } else if (request.url?.endsWith("/complete")) {
          reply.setHeader("Content-Type", "application/json");
          reply.end(
            `{"id":"${OPERATION}","seq":18446744073709551615,"state":"complete","nextOffset":"18446744073709551615","prefixSHA256":"${"0".repeat(64)}","maxPartBytes":"4194304","receipt":{"seq":18446744073709551615,"fingerprint":"opaque","future":9007199254740993}}`,
          );
        } else if (
          request.method === "PUT" ||
          request.url?.endsWith("/transfers")
        ) {
          reply.setHeader("Content-Type", "application/json");
          reply.end(
            `{"id":"${OPERATION}","seq":18446744073709551615,"state":"receiving","nextOffset":"18446744073709551612","prefixSHA256":"${"0".repeat(64)}","maxPartBytes":"4194304"}`,
          );
        } else {
          reply.setHeader("Content-Type", "application/json");
          reply.end(
            `{"id":"${OPERATION}","state":"open","base":9223372036854775807}`,
          );
        }
      })().catch((error: unknown) => {
        reply.statusCode = 500;
        reply.end(error instanceof Error ? error.message : "receiver failed");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("receiver has no TCP address");
    const nativeFetch = globalThis.fetch;
    const plane = new FakeControlPlane({
      routes: (request) => {
        if (request.url.host !== subnetHost) return undefined;
        const uri = `http://127.0.0.1:${String(address.port)}${request.url.pathname}${request.url.search}`;
        return nativeFetch(uri, request.init);
      },
    });
    try {
      const computers = plane.client().account.computers;
      const upload = await computers.createUploadById(RESOURCE, {
        base: INT64_MAX,
      });
      expect(upload.base).toBe(INT64_MAX);
      expect(received[0]?.body).toBe('{"base":9223372036854775807}');
      const transfer = await computers.createUploadTransferById(
        RESOURCE,
        OPERATION,
        { path: "file", mode: 0o600, seq: UINT64_MAX, kind: "file" },
      );
      expect(transfer.seq).toBe(UINT64_MAX);
      expect(transfer.nextOffset).toBe(UINT64_MAX - 3n);
      expect(received[1]?.body).toBe(
        '{"path":"file","seq":18446744073709551615,"kind":"file","mode":384}',
      );
      await computers.uploadTransferPartById(
        RESOURCE,
        OPERATION,
        OPERATION,
        UINT64_MAX - 3n,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        new TextEncoder().encode("abc"),
      );
      expect(received[2]?.uri).toContain("/parts/18446744073709551612?sha256=");
      expect(received[2]?.body).toBe("abc");
      const completed = await computers.completeUploadTransferById(
        RESOURCE,
        OPERATION,
        OPERATION,
        { length: UINT64_MAX, sha256: "0".repeat(64) },
      );
      const receipt = completed.receipt;
      expect(received[3]?.body).toBe(
        `{"length":"18446744073709551615","sha256":"${"0".repeat(64)}"}`,
      );
      if (receipt === undefined) throw new Error("receipt missing");
      expect(receipt.seq).toBe(UINT64_MAX);
      expect((receipt as unknown as Record<string, unknown>)["future"]).toBe(
        9007199254740993n,
      );
      const content = await computers.readFilePiecesById(RESOURCE, {
        path: "file",
      });
      expect(content.version).toBe(INT64_MAX);
      await content.close();
      expect(received).toHaveLength(5);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    }
  });
});
