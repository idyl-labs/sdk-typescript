// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { validateComputerSessionKind } from "../src/api/computer-awake.js";
import { validateComputerSessionHostKey } from "../src/api/computer-session-host-key.js";
import {
  allComputerSessionReasons,
  computerSessionReasonClass,
  validateComputerSessionReason,
  validateCreateComputerSessionRequest,
  type CreateComputerSessionRequest,
} from "../src/api/computer-session.js";
import { validateComputerSessionMode } from "../src/api/computer-session-endpoint.js";
import type { ComputerSessionId } from "../src/resource/uuid-id.js";
import { decodeBase64, encodeBase64 } from "../src/resource/base64.js";

/** The host key the reference contract's opened-ssh golden carries. */
const VALID =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBfLefsrQSDysexl5BmNbgiyjoE/6wHkpACDm4XhgIDO";
const ENCODED = VALID.slice("ssh-ed25519 ".length);
/** The 32-byte public key inside the golden's wire encoding. */
const PUBLIC = decodeBase64(ENCODED).subarray(4 + 11 + 4);

/** An SSH wire string: a four-byte big-endian length and its bytes. */
function wireString(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + value.byteLength);
  new DataView(out.buffer).setUint32(0, value.byteLength);
  out.set(value, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** The SSH wire encoding of a public key named `name`. */
function wireKey(name: string, key: Uint8Array): Uint8Array {
  return concat(wireString(new TextEncoder().encode(name)), wireString(key));
}

/**
 * OpenSSH's Ed25519 certificate type, assembled so it does not read as an
 * email address.
 */
const CERTIFICATE_TYPE = ["ssh-ed25519-cert-v01", "openssh.com"].join("@");

const line = (blob: Uint8Array): string => `ssh-ed25519 ${encodeBase64(blob)}`;

describe("computer session host key", () => {
  // Contract: the golden's host key is one ssh-ed25519 line of a 32-byte
  // key, and it is accepted.
  it("accepts one ssh-ed25519 line of a 32-byte key", () => {
    expect(VALID).toHaveLength("ssh-ed25519 ".length + 68);
    expect(PUBLIC.byteLength).toBe(32);
    expect(line(wireKey("ssh-ed25519", PUBLIC))).toBe(VALID);
    expect(() => {
      validateComputerSessionHostKey(VALID);
    }).not.toThrow();
  });

  // Contract: anything but exactly one ssh-ed25519 line whose base64 is
  // the one canonical spelling of one 32-byte key in SSH's wire encoding is
  // refused: a comment, any other whitespace, a carriage return or line
  // feed anywhere, another type, a byte-order mark before the inner type
  // (which a text decoder would drop), a short, long or truncated
  // key, and trailing wire bytes. The refusal never repeats the line.
  it("refuses every other line without repeating it", () => {
    const longKey = concat(PUBLIC, Uint8Array.of(0));
    const refused: Record<string, string> = {
      empty: "",
      "type alone": "ssh-ed25519",
      "type and space": "ssh-ed25519 ",
      "a comment": `${VALID} endpoint@example.com`,
      "a line ending": `${VALID}\n`,
      "a carriage return": `${VALID}\r\n`,
      "a line feed inside": `ssh-ed25519 ${ENCODED.slice(0, 10)}\n${ENCODED.slice(10)}`,
      "a return inside": `ssh-ed25519 ${ENCODED.slice(0, 10)}\r${ENCODED.slice(10)}`,
      "a leading space": ` ${VALID}`,
      "two spaces": `ssh-ed25519  ${ENCODED}`,
      "a tab": `ssh-ed25519\t${ENCODED}`,
      "another type": `ssh-rsa ${ENCODED}`,
      "type in capitals": `SSH-ED25519 ${ENCODED}`,
      "two keys": `${VALID}\n${VALID}`,
      "not base64": `ssh-ed25519 !${ENCODED.slice(1)}`,
      unpadded: line(wireKey("ssh-ed25519", PUBLIC.subarray(0, 31))).replace(
        /=+$/u,
        "",
      ),
      "short key": line(wireKey("ssh-ed25519", PUBLIC.subarray(0, 31))),
      "long key": line(wireKey("ssh-ed25519", longKey)),
      "inner type differs": line(wireKey("ssh-ed25518", PUBLIC)),
      "inner type is rsa": line(wireKey("ssh-rsa", PUBLIC)),
      "byte-order mark before the inner type": line(
        wireKey("\uFEFFssh-ed25519", PUBLIC),
      ),
      "trailing wire bytes": line(
        concat(wireKey("ssh-ed25519", PUBLIC), new Uint8Array(4)),
      ),
      "length past the end": line(
        concat(
          wireKey("ssh-ed25519", new Uint8Array()).subarray(0, 15),
          Uint8Array.of(0, 0, 0, 33),
        ),
      ),
      "truncated length": line(new Uint8Array(3)),
      "raw key, no wire": line(PUBLIC),
      "certificate type": line(wireKey(CERTIFICATE_TYPE, PUBLIC)),
      "spaces inside base64": `ssh-ed25519 ${ENCODED.slice(0, 10)} ${ENCODED.slice(10)}`,
    };
    for (const [name, value] of Object.entries(refused)) {
      let thrown: unknown;
      try {
        validateComputerSessionHostKey(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(TypeError);
      expect(String(thrown), name).not.toContain(ENCODED.slice(0, 8));
    }
  });
});

describe("ssh session values", () => {
  // Contract: mode ssh, kind ssh and reason mode-unavailable are values
  // this SDK names, and mode-unavailable reads as transient: a new session
  // may succeed.
  it("names the ssh mode, kind and failure reason", () => {
    expect(() => {
      validateComputerSessionMode("ssh");
    }).not.toThrow();
    expect(() => {
      validateComputerSessionKind("ssh");
    }).not.toThrow();
    expect(() => {
      validateComputerSessionReason("mode-unavailable");
    }).not.toThrow();
    expect(allComputerSessionReasons()).toContain("mode-unavailable");
    expect(computerSessionReasonClass("mode-unavailable")).toBe("transient");
  });

  // Contract: an ssh session's create states its mode alone; a shell, a
  // session to resume and a notebook are each refused.
  it("refuses an ssh create that states anything but its mode", () => {
    const create: CreateComputerSessionRequest = {
      operation: "shell",
      attachment: "endpoint",
      endpoint: { mode: "ssh" },
      idempotencyKey: "k",
    };
    expect(() => {
      validateCreateComputerSessionRequest(create);
    }).not.toThrow();
    expect(() => {
      validateCreateComputerSessionRequest({
        ...create,
        shell: { executable: "/bin/bash" },
      });
    }).toThrow(
      new TypeError(
        "an ssh session states no shell: its channels choose what runs",
      ),
    );
    expect(() => {
      validateCreateComputerSessionRequest({
        ...create,
        endpoint: {
          mode: "ssh",
          session: "01954e20-7540-7ec4-93ec-14f783e6ab21" as ComputerSessionId,
        },
      });
    }).toThrow(TypeError);
    expect(() => {
      validateCreateComputerSessionRequest({ ...create, notebook: "scratch" });
    }).toThrow(TypeError);
  });
});
