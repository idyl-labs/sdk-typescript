// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The validity period of a DER X.509 certificate, read from its
// TBSCertificate (RFC 5280, section 4.1): the version, serial number,
// signature algorithm and issuer are stepped over, and the two times of
// `validity` are read. Nothing is verified: the certificate is the caller's
// own, as its issuer answered it.

/** A certificate's validity period, in milliseconds since the epoch. */
export interface CertificateValidity {
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const EXPLICIT_VERSION = 0xa0;
const UTC_TIME = 0x17;
const GENERALIZED_TIME = 0x18;

interface Element {
  readonly tag: number;
  /** The offset of the element's contents. */
  readonly start: number;
  /** The offset just past the element. */
  readonly end: number;
}

/**
 * The validity period of the DER certificate `der`, or `undefined` when
 * `der` is not one DER certificate whose times are UTCTime or
 * GeneralizedTime in UTC to the second.
 */
export function certificateValidity(
  der: Uint8Array,
): CertificateValidity | undefined {
  const certificate = element(der, 0, der.length, SEQUENCE);
  if (certificate?.end !== der.length) return undefined;
  const tbs = element(der, certificate.start, certificate.end, SEQUENCE);
  if (tbs === undefined) return undefined;
  let at = tbs.start;
  const version = element(der, at, tbs.end);
  if (version?.tag === EXPLICIT_VERSION) at = version.end;
  for (const tag of [INTEGER, SEQUENCE, SEQUENCE]) {
    const skipped = element(der, at, tbs.end, tag);
    if (skipped === undefined) return undefined;
    at = skipped.end;
  }
  const validity = element(der, at, tbs.end, SEQUENCE);
  if (validity === undefined) return undefined;
  const notBefore = element(der, validity.start, validity.end);
  if (notBefore === undefined) return undefined;
  const notAfter = element(der, notBefore.end, validity.end);
  if (notAfter?.end !== validity.end) return undefined;
  const notBeforeMs = time(der, notBefore);
  const notAfterMs = time(der, notAfter);
  if (notBeforeMs === undefined || notAfterMs === undefined) return undefined;
  return { notBeforeMs, notAfterMs };
}

/**
 * The DER element at `at`, which must end by `limit` and, when `tag` is
 * given, carry it; `undefined` otherwise. Lengths take the short form or a
 * long form of one to three bytes.
 */
function element(
  der: Uint8Array,
  at: number,
  limit: number,
  tag?: number,
): Element | undefined {
  if (at + 2 > limit) return undefined;
  const found = der[at] ?? -1;
  if (tag !== undefined && found !== tag) return undefined;
  const first = der[at + 1] ?? 0;
  let start = at + 2;
  let length = first;
  if (first & 0x80) {
    const bytes = first & 0x7f;
    if (bytes < 1 || bytes > 3 || start + bytes > limit) return undefined;
    length = 0;
    for (let i = 0; i < bytes; i++)
      length = length * 256 + (der[start + i] ?? 0);
    start += bytes;
  }
  const end = start + length;
  return end > limit ? undefined : { tag: found, start, end };
}

/** The instant a UTCTime or GeneralizedTime element names. */
function time(der: Uint8Array, e: Element): number | undefined {
  const text = String.fromCharCode(...der.subarray(e.start, e.end));
  let digits: string;
  if (e.tag === UTC_TIME && /^\d{12}Z$/.test(text)) {
    // RFC 5280, section 4.1.2.5.1: a two-digit year below 50 is in the 2000s.
    const year = Number(text.slice(0, 2));
    digits = `${String(year < 50 ? 2000 + year : 1900 + year)}${text.slice(2, 12)}`;
  } else if (e.tag === GENERALIZED_TIME && /^\d{14}Z$/.test(text)) {
    digits = text.slice(0, 14);
  } else {
    return undefined;
  }
  const part = (from: number, to: number): number =>
    Number(digits.slice(from, to));
  const ms = Date.UTC(
    part(0, 4),
    part(4, 6) - 1,
    part(6, 8),
    part(8, 10),
    part(10, 12),
    part(12, 14),
  );
  // A field out of range, such as month 13, rolls over in Date.UTC; such a
  // time names no instant.
  const named = new Date(ms).toISOString().replace(/[-:T]|\.\d{3}Z$/g, "");
  return named === digits ? ms : undefined;
}
