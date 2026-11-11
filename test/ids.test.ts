// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  isAccountId,
  isSubnetSlug,
  parseAccountId,
  parseSubnetSlug,
} from "../src/resource/id.js";
import {
  isComputerId,
  isComputerOperationId,
  isJournalEntryId,
  parseComputerId,
  parseComputerOperationId,
  parseComputerSessionId,
  parseJournalEntryId,
  parseNamespaceId,
  parseStorageOperationId,
} from "../src/resource/uuid-id.js";

describe("twelve-digit identifiers", () => {
  const families: readonly [string, (value: string) => string][] = [
    ["account ID", parseAccountId],
  ];

  // Contract: each family accepts exactly twelve ASCII digits and names
  // itself in the rejection.
  it.each(families)(
    "%s accepts twelve digits and names itself on rejection",
    (label, parse) => {
      expect(parse("550000000001")).toBe("550000000001");
      expect(() => parse("55000000001")).toThrow(
        `invalid ${label}: must be exactly 12 digits, got 11 characters`,
      );
      expect(() => parse("5500000000012")).toThrow("got 13 characters");
      expect(() => parse("55000000000a")).toThrow(
        `invalid ${label}: must contain only ASCII digits`,
      );
      expect(() => parse(" 55000000001")).toThrow(
        "must contain only ASCII digits",
      );
      expect(() => parse("٥٥٠٠٠٠٠٠٠٠٠١")).toThrow(
        "must contain only ASCII digits",
      );
      expect(() => parse("")).toThrow(TypeError);
    },
  );

  // Contract: the guard narrows without throwing and rejects non-strings.
  it("narrows with the is* guard", () => {
    expect(isAccountId("550000000001")).toBe(true);
    expect(isAccountId("55000000000")).toBe(false);
    expect(isAccountId(550000000001)).toBe(false);
    expect(isAccountId(undefined)).toBe(false);
  });

  // Contract: a subnet slug is twelve digits and is reported in the slug's
  // own words.
  it("parses subnet slugs", () => {
    expect(parseSubnetSlug("550000000002")).toBe("550000000002");
    expect(() => parseSubnetSlug("1")).toThrow(
      "subnet slug must be exactly 12 characters",
    );
    expect(() => parseSubnetSlug("55000000000x")).toThrow(
      "subnet slug must match [0-9]{12}",
    );
    expect(isSubnetSlug("550000000002")).toBe(true);
    expect(isSubnetSlug("5500000000020")).toBe(false);
  });
});

describe("UUID identifiers", () => {
  const canonical = "0f1e2d3c-4b5a-4978-8765-43210fedcba9";

  // Contract: only the canonical lowercase hyphenated form is admitted.
  it("accepts only the canonical lowercase form", () => {
    expect(parseComputerId(canonical)).toBe(canonical);
    expect(parseComputerSessionId(canonical)).toBe(canonical);
    expect(parseNamespaceId(canonical)).toBe(canonical);
    expect(parseStorageOperationId(canonical)).toBe(canonical);
    expect(parseComputerOperationId(canonical)).toBe(canonical);
    for (const bad of [
      canonical.toUpperCase(),
      `{${canonical}}`,
      `urn:uuid:${canonical}`,
      canonical.replaceAll("-", ""),
      ` ${canonical}`,
      `${canonical} `,
      canonical.slice(0, 35),
      `${canonical}0`,
      "0f1e2d3c-4b5a-4978-8765-43210fedcbag",
    ]) {
      expect(() => parseComputerId(bad), bad).toThrow(
        "computer ID must be a canonical UUID",
      );
    }
    expect(() => parseJournalEntryId("")).toThrow(
      "journal entry ID must be a canonical UUID",
    );
    expect(() => parseComputerOperationId(canonical.toUpperCase())).toThrow(
      "computer operation ID must be a canonical UUID",
    );
  });

  // Contract: the guard narrows without throwing.
  it("narrows with the is* guard", () => {
    expect(isComputerId(canonical)).toBe(true);
    expect(isComputerId(canonical.toUpperCase())).toBe(false);
    expect(isComputerId(null)).toBe(false);
    expect(isJournalEntryId(canonical)).toBe(true);
    expect(isJournalEntryId(canonical.replaceAll("-", ""))).toBe(false);
    expect(isComputerOperationId(canonical)).toBe(true);
    expect(isComputerOperationId(`{${canonical}}`)).toBe(false);
  });
});
