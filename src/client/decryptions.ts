// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The record of decryptions: one entry for each time IDYL opened a Secret's
 * stored value. The public type is built from the served record field by
 * field; no entry carries a value.
 */
import type { VaultDecryption } from "../api/vault.js";
import { numberOf } from "./records.js";

/**
 * One time IDYL opened a Secret's stored value, as the record reports the
 * decryption.
 * Vault, which keeps the sealed values, and IDYL's key store, which holds
 * the keys that seal them, each report every decryption, so the record
 * holds a decryption whether or not Vault reported the decryption. IDYL
 * keeps each entry for 90 days.
 *
 * A Computer's start opens the values it attaches, and a later use can
 * open a value again.
 */
export interface Decryption {
  /** When the value was opened, as an RFC 3339 instant. */
  readonly at: string;
  /** The kind of the opened resource, such as `Secret`. */
  readonly kind: string;
  /** The opened resource's ID, a canonical UUID. */
  readonly resourceId: string;
  /**
   * The resource's name when the value was opened. A Secret deleted and
   * created again under the name has another `resourceId`.
   */
  readonly name: string;
  /** The version whose value was opened, from 1. */
  readonly version: number;
  /**
   * The Computer the value was opened for. Absent when the value was opened
   * for no Computer, and for a decryption only the key store reported.
   */
  readonly computerId?: string;
  /**
   * The ID of the instance the value was opened for, when the value was
   * opened for no Computer. Absent for a Computer's decryption and for a
   * decryption only the key store reported.
   */
  readonly podId?: string;
  /**
   * The start the value was opened for, such as one wake of a Computer.
   * Absent when the value was opened under no start.
   */
  readonly activation?: string;
  /**
   * `opened`; `refused`, IDYL refused to open the value; or `failed`, no
   * answer came to Vault's request, so whether the value was opened is known
   * only once the key store reports the request. An outcome this package
   * does not name is carried unchanged from IDYL's report.
   */
  readonly outcome:
    "opened" | "refused" | "failed" | (string & Record<never, never>);
  /**
   * Who reported the decryption: `vault`; `kms` for the key store alone,
   * which means Vault did not report the decryption; or `both`. A reporter
   * this package does not name is carried unchanged from IDYL's report.
   */
  readonly reportedBy:
    "vault" | "kms" | "both" | (string & Record<never, never>);
  /**
   * The key store's ID of the request, which names the same decryption in
   * the key store's own log. Absent only when no answer to Vault's request
   * named one.
   */
  readonly kmsRequestId?: string;
}

/** The fields of a served record the public type carries. */
const FIELDS = [
  "at",
  "kind",
  "resourceId",
  "name",
  "computerId",
  "podId",
  "activation",
  "outcome",
  "reportedBy",
  "kmsRequestId",
] as const;

/**
 * The public view of one served decryption record, read leniently: an
 * outcome or a reporter this package does not name is carried, and a field
 * the public type does not declare is left out.
 */
export function decryptionOf(served: VaultDecryption): Decryption {
  const view: Record<string, unknown> = {};
  for (const field of FIELDS) {
    if (served[field] !== undefined) view[field] = served[field];
  }
  view["version"] = numberOf(served.version);
  return Object.freeze(view) as unknown as Decryption;
}
