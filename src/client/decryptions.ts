// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The record of decryptions: one entry for each time IDYL opened a Secret's
 * stored value. The public type is built from the served record field by
 * field; no entry carries a value.
 */
import type { VaultDecryption } from "../api/vault.js";
import { numberOf } from "./records.js";

/**
 * One time IDYL opened a Secret's stored value, as the record reports it.
 * Vault, which keeps the sealed values, and the key service that seals them
 * each report every decryption, so the record holds a decryption whether or
 * not Vault's code reported it. IDYL keeps each entry for 90 days.
 *
 * A Computer's start opens the values it attaches, and the Computer opens
 * them again when it fetches them after more than 15 minutes without a use.
 */
export interface Decryption {
  /** When the value was opened, as an RFC 3339 instant. */
  readonly at: string;
  /**
   * The kind of the opened resource: `Secret`, or "TLSCertificate" for a TLS
   * certificate a Pod mounts.
   */
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
   * The Computer the value was opened for. Absent for a Pod's decryption and
   * for one only the key service reported.
   */
  readonly computerId?: string;
  /**
   * The Pod the value was opened for, by its instance ID. Absent for a
   * Computer's decryption and for one only the key service reported.
   */
  readonly podId?: string;
  /**
   * The start the value was opened for: a Computer's activation or a Pod's
   * assignment. Absent when it was opened under no start.
   */
  readonly activation?: string;
  /**
   * `opened`; `refused`, the key service refused to open it; or `failed`,
   * Vault's request received no answer, so whether it was opened is not
   * known until the key service's report of the request arrives. An outcome
   * this package does not name is carried unchanged from IDYL's report.
   */
  readonly outcome:
    "opened" | "refused" | "failed" | (string & Record<never, never>);
  /**
   * Who reported the decryption: `vault`, `kms` for the key service alone,
   * which means Vault's code did not report it, or `both`. A reporter this
   * package does not name is carried unchanged from IDYL's report.
   */
  readonly reportedBy:
    "vault" | "kms" | "both" | (string & Record<never, never>);
  /**
   * The key service's ID of the request, which names the same decryption in
   * the key service's own log. Absent only when Vault's request received no
   * answer that named one.
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
