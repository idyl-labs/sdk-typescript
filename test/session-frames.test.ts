// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FrameError,
  FrameReader,
  MAX_DATA_BYTES,
  MAX_FRAME_BYTES,
  encodeFrame,
  frameJson,
  readFrame,
  stdinFrames,
  validateOpenedFor,
} from "../src/computer-connection/frames.js";
import type { ClientFrame } from "../src/computer-connection/frames.js";

// The golden frames of workload-session/json-v2, vendored from the
// reference contract's computer_session_stream.golden.
const golden = new Map(
  readFileSync(
    new URL("fixtures-session/computer_session_stream.golden", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => {
      const tab = line.indexOf("\t");
      return [line.slice(0, tab), line.slice(tab + 1)] as const;
    }),
);

function g(name: string): string {
  const value = golden.get(name);
  if (value === undefined) throw new Error(`no golden ${name}`);
  return value;
}

const enc = new TextEncoder();

describe("client frames", () => {
  // Contract: every frame a client sends is byte for byte the published
  // encoding, members in the published order.
  it("encode as the published frames", () => {
    const cases: [string, ClientFrame][] = [
      ["close-input", { type: "close_input" }],
      ["end", { type: "end" }],
      ["watch", { type: "watch", path: "src/app" }],
      ["unwatch", { type: "unwatch", path: "src/app" }],
      ["resize", { type: "resize", size: { cols: 100, rows: 30 } }],
      ["stdin", { type: "stdin", data: enc.encode("ls\r") }],
      [
        "open-shell",
        {
          type: "open",
          requestID: "req-1",
          mode: "shell",
          shell: "/bin/bash",
          tty: true,
          size: { cols: 120, rows: 40 },
          term: "xterm-256color",
          locale: "en_US.UTF-8",
        },
      ],
      [
        "open-shell-automatic",
        {
          type: "open",
          requestID: "req-1",
          mode: "shell",
          tty: true,
          size: { cols: 80, rows: 24 },
          term: "xterm",
        },
      ],
      [
        "open-exec",
        {
          type: "open",
          requestID: "req-2",
          mode: "exec",
          command: ["ls", "-la", "/workspace"],
          tty: false,
        },
      ],
      [
        "open-exec-features",
        {
          type: "open",
          requestID: "req-4",
          mode: "exec",
          command: ["make", "test"],
          tty: false,
          features: ["save-result", "reattach"],
        },
      ],
      [
        "open-cell",
        {
          type: "open",
          requestID: "req-3",
          mode: "cell",
          script: "make test",
          tty: false,
        },
      ],
      [
        "open-reattach",
        {
          type: "open",
          requestID: "req-5",
          mode: "reattach",
          tty: false,
          session: "session-1",
          cursor: 4096,
          features: ["save-result", "reattach"],
        },
      ],
      [
        "open-files",
        {
          type: "open",
          requestID: "req-7",
          mode: "files",
          tty: false,
          features: [],
        },
      ],
      [
        "open-records",
        {
          type: "open",
          requestID: "req-6",
          mode: "records",
          tty: false,
          notebook: "01954e20-7540-7ec4-93ec-14f783e6ab60",
          after: 3,
        },
      ],
      [
        "open-ssh",
        {
          type: "open",
          requestID: "req-8",
          mode: "ssh",
          tty: false,
          features: ["raw-after-opened"],
        },
      ],
    ];
    for (const [name, frame] of cases) {
      expect(frameJson(frame), name).toBe(g(name));
    }
  });

  // Contract: a frame on the stream is its big-endian length, then its JSON.
  it("are length-prefixed", () => {
    const bytes = encodeFrame({ type: "end" });
    expect(new DataView(bytes.buffer).getUint32(0)).toBe(bytes.length - 4);
    expect(new TextDecoder().decode(bytes.subarray(4))).toBe(g("end"));
  });

  // Contract: input larger than one frame's payload is split, never sent
  // as one oversized frame.
  it("split stdin to the payload bound", () => {
    const frames = stdinFrames(new Uint8Array(MAX_DATA_BYTES * 2 + 1));
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES + 4);
    }
  });
});

describe("endpoint frames", () => {
  // Contract: every frame an endpoint sends reads into its typed form.
  it("read from the published frames", () => {
    expect(readFrame(g("opened"))).toEqual({
      type: "opened",
      session: "session-1",
    });
    expect(readFrame(g("opened-shell"))).toEqual({
      type: "opened",
      session: "session-1",
      shell: "/bin/bash",
    });
    expect(readFrame(g("opened-reattach"))).toEqual({
      type: "opened",
      session: "session-1",
      cursor: 0,
      dropped: true,
    });
    expect(readFrame(g("opened-ssh"))).toEqual({
      type: "opened",
      session: "session-1",
      hostKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBfLefsrQSDysexl5BmNbgiyjoE/6wHkpACDm4XhgIDO",
    });
    expect(readFrame(g("stdout"))).toEqual({
      type: "stdout",
      data: enc.encode("total 0\r\n"),
    });
    expect(readFrame(g("stderr"))).toEqual({
      type: "stderr",
      data: Uint8Array.from([0xff, 0x00, 0x78]),
    });
    expect(readFrame(g("exit-code"))).toEqual({ type: "exit", code: 0 });
    expect(readFrame(g("exit-signal"))).toEqual({
      type: "exit",
      signal: "SIGKILL",
    });
    expect(readFrame(g("saved-published"))).toEqual({
      type: "saved",
      outcome: "published",
      revision: 42,
    });
    expect(readFrame(g("saved-failed"))).toEqual({
      type: "saved",
      outcome: "failed",
      reason: "the store is unavailable",
    });
    expect(readFrame(g("error"))).toEqual({
      type: "error",
      code: "not_granted",
      message: "no grant was installed for the request",
    });
    expect(readFrame(g("record"))).toEqual({
      type: "record",
      cell: "01954e20-7540-7ec4-93ec-14f783e6ab61",
      order: 4,
      meta: { command: "make test", exitCode: 0 },
    });
    expect(readFrame(g("record-output"))).toEqual({
      type: "record_output",
      cell: "01954e20-7540-7ec4-93ec-14f783e6ab61",
      stream: "stdout",
      data: enc.encode("ok\n"),
    });
    expect(readFrame(g("records-end"))).toEqual({
      type: "records_end",
      count: 1,
    });
    expect(readFrame(g("listing"))).toEqual({
      type: "listing",
      path: "src",
      entries: [
        {
          name: "lib",
          type: "dir",
          size: 0,
          mode: 0o755,
          modified: 1761650000000,
        },
        {
          name: "link",
          type: "symlink",
          size: 7,
          mode: 0o777,
          modified: 1761650000000,
          target: "main.go",
        },
        {
          name: "main.go",
          type: "file",
          size: 120,
          mode: 0o644,
          modified: 1761650000000,
        },
      ],
      more: false,
    });
    expect(readFrame(g("listing-more"))).toEqual({
      type: "listing",
      path: "src",
      entries: [
        {
          name: "a.txt",
          type: "file",
          size: 1,
          mode: 0o644,
          modified: 1761650000000,
        },
      ],
      more: true,
    });
    expect(readFrame(g("listing-problem"))).toEqual({
      type: "listing",
      path: "gone",
      entries: [],
      more: false,
      problem: "not_found",
    });
    expect(readFrame(g("listing-truncated"))).toEqual({
      type: "listing",
      path: "big",
      entries: [
        {
          name: "f00000",
          type: "file",
          size: 0,
          mode: 0o644,
          modified: 1761650000000,
        },
      ],
      more: false,
      truncated: true,
    });
  });

  // Contract: a listing reads leniently: an unknown member or entry type
  // is carried for the caller to judge, and a missing member reads as its
  // zero value. An entry that is not an object cannot be read.
  it("read listings leniently", () => {
    expect(
      readFrame(
        '{"type":"listing","path":"","entries":[{"name":"p","type":"door","owner":1}],"later":true}',
      ),
    ).toEqual({
      type: "listing",
      path: "",
      entries: [{ name: "p", type: "door", size: 0, mode: 0, modified: 0 }],
      more: false,
    });
    expect(() =>
      readFrame('{"type":"listing","path":"","entries":[7],"more":false}'),
    ).toThrow(FrameError);
  });

  // Contract: reads are lenient: unknown members are ignored and an
  // unknown frame type is reported for the caller to judge.
  it("read leniently", () => {
    expect(readFrame('{"type":"exit","code":3,"extra":true}')).toEqual({
      type: "exit",
      code: 3,
    });
    expect(readFrame('{"type":"later"}')).toEqual({
      type: "unknown",
      frameType: "later",
    });
  });

  // Contract: a frame that is not a JSON object, or whose data is not
  // base64, cannot be read.
  it("refuse malformed frames", () => {
    expect(() => readFrame("[]")).toThrow(FrameError);
    expect(() => readFrame("{")).toThrow(FrameError);
    expect(() => readFrame('{"type":"stdout","data":7}')).toThrow(FrameError);
  });

  // Contract: an opened frame's host key is read only as one ssh-ed25519
  // public key line; any other is refused with a fixed sentence that never
  // repeats the line, a member that is not text is refused, and an empty or
  // null one reads as absent.
  it("refuse a malformed host key", () => {
    const read = (): unknown =>
      readFrame(
        '{"type":"opened","session":"session-1","hostKey":"ssh-rsa AAAAB3NzaC1yc2E"}',
      );
    expect(read).toThrow(
      new FrameError(
        "session frame host key is not one ssh-ed25519 public key line",
      ),
    );
    try {
      read();
    } catch (error) {
      expect(String(error)).not.toContain("AAAAB3Nza");
    }
    expect(
      readFrame('{"type":"opened","session":"session-1","hostKey":""}'),
    ).toEqual({ type: "opened", session: "session-1" });
    expect(
      readFrame('{"type":"opened","session":"session-1","hostKey":null}'),
    ).toEqual({ type: "opened", session: "session-1" });
    for (const member of ["7", "true", "[]", "{}"]) {
      expect(() =>
        readFrame(
          `{"type":"opened","session":"session-1","hostKey":${member}}`,
        ),
      ).toThrow(new FrameError("session frame host key is not text"));
    }
  });

  // Contract: an ssh stream's opened carries its session and host key and
  // nothing else, and every other mode's opened carries no host key. Each
  // golden opened answers its own mode and no ssh open; the ssh golden
  // answers an ssh open alone.
  it("carry a host key exactly for an ssh stream", () => {
    const ssh = readFrame(g("opened-ssh"));
    if (ssh.type !== "opened") throw new Error("opened-ssh is not opened");
    expect(() => {
      validateOpenedFor(ssh, "ssh");
    }).not.toThrow();
    for (const mode of [
      "shell",
      "exec",
      "cell",
      "reattach",
      "records",
      "files",
    ] as const) {
      expect(() => {
        validateOpenedFor(ssh, mode);
      }).toThrow(
        new TypeError("only an ssh stream's opened carries a host key"),
      );
    }
    for (const name of ["opened", "opened-shell", "opened-reattach"]) {
      const opened = readFrame(g(name));
      if (opened.type !== "opened") throw new Error(`${name} is not opened`);
      expect(() => {
        validateOpenedFor(opened, "shell");
      }).not.toThrow();
      expect(() => {
        validateOpenedFor(opened, "ssh");
      }).toThrow(new TypeError("an ssh stream's opened carries its host key"));
    }
    for (const extra of [
      { shell: "/bin/bash" },
      { cursor: 0 },
      { cursor: 0, dropped: true },
    ]) {
      expect(() => {
        validateOpenedFor({ ...ssh, ...extra }, "ssh");
      }).toThrow(
        new TypeError(
          "an ssh stream's opened carries its session and host key alone",
        ),
      );
    }
  });
});

describe("frame reader", () => {
  // Contract: frames split anywhere across chunks read the same.
  it("joins frames split across chunks", () => {
    const stream = new Uint8Array([
      ...encodeFrame({ type: "end" }),
      ...frameBytes(g("exit-code")),
    ]);
    const reader = new FrameReader();
    const frames = [];
    for (const byte of stream) frames.push(...reader.push(Uint8Array.of(byte)));
    expect(frames).toEqual([
      { type: "unknown", frameType: "end" },
      { type: "exit", code: 0 },
    ]);
  });

  // Contract: a frame declaring more than the bound is refused before it
  // is buffered.
  it("refuses an oversized frame from its length", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
    expect(() => new FrameReader().push(header)).toThrow(FrameError);
  });
});

function frameBytes(json: string): Uint8Array {
  const body = enc.encode(json);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}
