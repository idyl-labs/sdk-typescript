// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  LICENSE_HEADER,
  RULES,
  hasLicenseHeader,
  isPublishableAddress,
  isPublishableEmail,
  isSignedOff,
  messageBody,
  needsSignOff,
  needsLicenseHeader,
  parseTerms,
  scanText,
} from "../scripts/publication-scan.mjs";

/** The rule IDs the built-in rules report for one text in one file. */
function rulesFor(text: string, path = "src/example.ts"): string[] {
  return scanText(text, path, RULES).map((finding) => finding.rule);
}

// Synthetic values are assembled at run time so this file never holds the
// material it proves the scan refuses.
const workstation = ["", "Users", "someone", "project"].join("/");
const companyHost = ["api", "staging", "idyl", "dev"].join(".");
const privateAddress = [10, 1, 2, 3].join(".");

describe("publication scan rules", () => {
  // Contract: a workstation path is refused wherever it appears.
  it("refuses a workstation path", () => {
    expect(rulesFor(`see ${workstation}/file.ts`)).toEqual([
      "workstation-path",
    ]);
  });

  // Contract: a host under an IDYL domain is refused; a bare email domain is
  // judged by the email rule instead.
  it("refuses a host under an IDYL domain", () => {
    expect(rulesFor(`https://${companyHost}/v1`)).toEqual(["idyl-host"]);
    expect(rulesFor("security@idyl.dev")).toEqual([]);
  });

  // Contract: the production network's three public endpoints, the client's
  // default, are published; any other host under the domain is refused.
  it("admits only the production network's public endpoints", () => {
    expect(rulesFor("https://api.idyl.sh/v1")).toEqual([]);
    expect(rulesFor("https://identity.idyl.sh/account")).toEqual([]);
    expect(rulesFor("https://meta.idyl.sh/v1/network")).toEqual([]);
    expect(
      rulesFor(`https://${["console", "idyl", "network"].join(".")}`),
    ).toEqual(["idyl-host"]);
    expect(
      rulesFor(`https://${["x", "api", "idyl", "network"].join(".")}`),
    ).toEqual(["idyl-host"]);
  });

  // Contract: an email address is refused unless it is the published
  // security contact or under a reserved example domain.
  it("refuses an email address outside the reserved domains", () => {
    expect(isPublishableEmail("person@example.com")).toBe(true);
    expect(isPublishableEmail("person@service.test")).toBe(true);
    expect(isPublishableEmail("security@idyl.dev")).toBe(true);
    expect(rulesFor("pnpm@10.26.2 and @types/node@24.13.3")).toEqual([]);
    expect(rulesFor("attach@idyl.dev")).toEqual([]);
    expect(rulesFor("shell_not_found@idyl.network")).toEqual([]);
    expect(rulesFor("shell_not_found@idyl.sh")).toEqual([]);
    // The domains also carry mail: only the listed names pass.
    expect(isPublishableEmail(["person", "idyl.network"].join("@"))).toBe(
      false,
    );
    expect(isPublishableEmail(["person", "idyl.dev"].join("@"))).toBe(false);
    expect(isPublishableEmail(["person", "idyl.sh"].join("@"))).toBe(false);
    expect(rulesFor(["write to person", "mail.invalid.org"].join("@"))).toEqual(
      ["email"],
    );
  });

  // Contract: an IPv4 address is refused unless it is loopback, unspecified,
  // in an RFC 5737 documentation range, the base address of a special-purpose
  // range, or in the block of `example.com`. A host in a private range is
  // refused, and the vendored contract fixtures are judged where they are
  // published.
  it("refuses an IPv4 address outside the publishable ranges", () => {
    expect(isPublishableAddress("192.0.2.10")).toBe(true);
    expect(isPublishableAddress("198.51.100.1")).toBe(true);
    expect(isPublishableAddress("203.0.113.255")).toBe(true);
    expect(isPublishableAddress("127.0.0.1")).toBe(true);
    expect(isPublishableAddress("0.0.0.0")).toBe(true);
    expect(isPublishableAddress("10.0.0.0")).toBe(true);
    expect(isPublishableAddress("172.16.0.0")).toBe(true);
    expect(isPublishableAddress("93.184.216.34")).toBe(true);
    expect(isPublishableAddress(privateAddress)).toBe(false);
    expect(isPublishableAddress([172, 16, 0, 1].join("."))).toBe(false);
    expect(isPublishableAddress([93, 184, 217, 1].join("."))).toBe(false);
    expect(rulesFor(`host ${privateAddress}:443`)).toEqual(["ip-address"]);
    expect(
      rulesFor(
        `host ${privateAddress}`,
        "test/conformance/fixtures/api/x.json",
      ),
    ).toEqual([]);
    expect(rulesFor("version 1.2.3")).toEqual([]);
  });

  // Contract: products that are not in the package are not named outside the
  // vendored contract fixtures; Node.js and the User-Agent header are not
  // products.
  it("refuses a product the package does not carry", () => {
    expect(rulesFor("an Actor runs")).toEqual(["unlaunched-product"]);
    expect(rulesFor("a Workload runs")).toEqual(["unlaunched-product"]);
    expect(rulesFor("a WorkloadSession type")).toEqual([]);
    expect(rulesFor("on Node.js 22 with a User-Agent")).toEqual([]);
    expect(rulesFor("on Node 22 and Node 24")).toEqual([]);
    expect(rulesFor('written "Node\n22" when wrapped')).toEqual([]);
    expect(rulesFor("a Node runs")).toEqual(["unlaunched-product"]);
    expect(
      rulesFor("an Actor runs", "test/conformance/fixtures/api/x.json"),
    ).toEqual([]);
  });

  // Contract: a finding names its place and rule, never the text it matched.
  it("reports a position and a rule, never the match", () => {
    const findings = scanText(`one\ntwo ${workstation}/x`, "README.md", RULES);
    expect(findings).toEqual([
      { source: "README.md", line: 2, column: 5, rule: "workstation-path" },
    ]);
  });
});

describe("private terms", () => {
  // Contract: a term list is one case-sensitive regular expression per
  // line; blank lines and comments are skipped, and a finding names the
  // term's line, never the term.
  it("reads one expression per line and reports the line", () => {
    const rules = parseTerms("# comment\n\nsecret-name\nother\\d+\n");
    expect(rules.map((rule) => rule.id)).toEqual([
      "private-term:3",
      "private-term:4",
    ]);
    expect(
      scanText("a secret-name and other42, not SECRET-NAME", "x.md", rules),
    ).toEqual([
      { source: "x.md", line: 1, column: 3, rule: "private-term:3" },
      { source: "x.md", line: 1, column: 19, rule: "private-term:4" },
    ]);
  });
});

describe("commit messages", () => {
  // Contract: attribution lines are not scanned; everything else is.
  it("drops attribution lines before scanning", () => {
    expect(
      messageBody(
        "Body\n\n\u{1F916} Generated with [Tool](https://example.com/tool)",
      ),
    ).toBe("Body\n");
    expect(
      messageBody(
        "Subject\n\nBody\n\nCo-Authored-By: A <a@example.com>\nSigned-off-by: B <b@example.org>",
      ),
    ).toBe("Subject\n\nBody\n");
  });

  // Contract: every commit carries a Developer Certificate of Origin
  // sign-off with a name and an address.
  it("requires a sign-off", () => {
    expect(
      isSignedOff("Subject\n\nSigned-off-by: A Person <a@example.com>"),
    ).toBe(true);
    expect(isSignedOff("Subject\n\nBody")).toBe(false);
    expect(isSignedOff("Subject\n\nSigned-off-by: nobody")).toBe(false);
  });

  // Contract: the sign-off rule skips exactly the listed commits, named by
  // full hash; any other commit, or a prefix of a listed one, is held to it.
  it("skips only the listed unsigned commits", () => {
    expect(needsSignOff("730ed94f3c513256892761fac706ea0e939579a8")).toBe(
      false,
    );
    expect(needsSignOff("730ed94f3c51")).toBe(true);
    expect(needsSignOff("0000000000000000000000000000000000000000")).toBe(true);
  });
});

describe("license headers", () => {
  // Contract: every source, test and script file starts with the license
  // header, after a shebang when it has one; vendored fixtures and other
  // files do not.
  it("requires the header on code files only", () => {
    expect(needsLicenseHeader("src/index.ts")).toBe(true);
    expect(needsLicenseHeader("scripts/size.mjs")).toBe(true);
    expect(needsLicenseHeader("README.md")).toBe(false);
    expect(needsLicenseHeader("test/conformance/fixtures/a.json")).toBe(false);
    expect(hasLicenseHeader(`${LICENSE_HEADER}\n\nexport {};\n`)).toBe(true);
    expect(hasLicenseHeader(`#!/usr/bin/env node\n${LICENSE_HEADER}\n`)).toBe(
      true,
    );
    expect(hasLicenseHeader("export {};\n")).toBe(false);
  });
});
