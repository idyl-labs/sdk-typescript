// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// A synthetic DER certificate whose TBSCertificate carries a version,
// a serial number, a signature algorithm, an empty issuer and the validity
// period the test states, and nothing a verifier would accept: it is read
// for its validity alone.

/** One DER element of `tag` around `body`, with a short or long length. */
export function der(tag: number, ...body: Uint8Array[]): Uint8Array {
  const length = body.reduce((n, b) => n + b.length, 0);
  const head =
    length < 0x80
      ? [tag, length]
      : length < 0x100
        ? [tag, 0x81, length]
        : [tag, 0x82, length >> 8, length & 0xff];
  const out = new Uint8Array(head.length + length);
  out.set(head);
  let at = head.length;
  for (const b of body) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

/** `ms` as a UTCTime element, to the second. */
export function utcTime(ms: number): Uint8Array {
  const iso = new Date(ms).toISOString();
  const digits = iso.slice(2, 19).replace(/[-:T]/g, "");
  return der(0x17, ascii(`${digits}Z`));
}

/** `ms` as a GeneralizedTime element, to the second. */
export function generalizedTime(ms: number): Uint8Array {
  const iso = new Date(ms).toISOString();
  const digits = iso.slice(0, 19).replace(/[-:T]/g, "");
  return der(0x18, ascii(`${digits}Z`));
}

/** A certificate valid from `notBefore` to `notAfter`, given as DER times. */
export function certificateWith(
  notBefore: Uint8Array,
  notAfter: Uint8Array,
): Uint8Array {
  const version = der(0xa0, der(0x02, Uint8Array.of(2)));
  const serial = der(0x02, Uint8Array.of(1));
  const algorithm = der(0x30, der(0x06, Uint8Array.of(0x2b, 0x65, 0x70)));
  const issuer = der(0x30);
  const validity = der(0x30, notBefore, notAfter);
  const subject = der(0x30);
  const tbs = der(0x30, version, serial, algorithm, issuer, validity, subject);
  return der(0x30, tbs, algorithm, der(0x03, Uint8Array.of(0)));
}

/** A certificate valid from `notBeforeMs` to `notAfterMs`. */
export function certificate(
  notBeforeMs: number,
  notAfterMs: number,
): Uint8Array {
  return certificateWith(utcTime(notBeforeMs), utcTime(notAfterMs));
}
