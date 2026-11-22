// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { certificateValidity } from "../src/internal/certificate-validity.js";
import {
  certificate,
  certificateWith,
  der,
  generalizedTime,
  utcTime,
} from "./fakes/certificate.js";

const NOT_BEFORE = Date.UTC(2026, 0, 2, 3, 4, 5);
const NOT_AFTER = Date.UTC(2026, 0, 2, 4, 4, 5);

describe("certificate validity", () => {
  // Contract: the validity period is read from the TBSCertificate, past
  // its version, serial number, signature algorithm and issuer, in UTCTime
  // or GeneralizedTime to the second.
  it("reads a certificate's validity period", () => {
    expect(certificateValidity(certificate(NOT_BEFORE, NOT_AFTER))).toEqual({
      notBeforeMs: NOT_BEFORE,
      notAfterMs: NOT_AFTER,
    });
    const later = Date.UTC(2051, 5, 6, 7, 8, 9);
    expect(
      certificateValidity(
        certificateWith(utcTime(NOT_BEFORE), generalizedTime(later)),
      ),
    ).toEqual({ notBeforeMs: NOT_BEFORE, notAfterMs: later });
  });

  // Contract: bytes that are not one certificate with two well-formed times
  // name no validity period.
  it("refuses what is not one certificate with a validity period", () => {
    const valid = certificate(NOT_BEFORE, NOT_AFTER);
    expect(certificateValidity(Uint8Array.of(5))).toBeUndefined();
    expect(
      certificateValidity(valid.subarray(0, valid.length - 1)),
    ).toBeUndefined();
    expect(certificateValidity(Uint8Array.of(...valid, 0))).toBeUndefined();
    const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
    for (const time of [
      der(0x17, ascii("261302030405Z")),
      der(0x17, ascii("2601020304Z")),
      der(0x17, ascii("260102030405+0100")),
      der(0x18, ascii("20260102030405.5Z")),
      der(0x04, ascii("260102030405Z")),
    ]) {
      expect(
        certificateValidity(certificateWith(time, utcTime(NOT_AFTER))),
      ).toBeUndefined();
    }
  });
});
