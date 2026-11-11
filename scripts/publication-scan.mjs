// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The publication scan: proves that everything this repository publishes is
// fit to publish. It reads every file in the working tree that Git tracks or
// would track, every commit message reachable from HEAD, and any message
// file passed with --message (a pull request title and body before they are
// posted), and fails on:
//
//   - a workstation path, a host under an IDYL domain, an email address
//     outside the reserved example domains, or an IPv4 address other than
//     loopback, documentation, a special-purpose range's base address, or
//     one in the block of `example.com`;
//   - a product that is not part of the package named in source, tests or
//     documentation;
//   - a missing license header on a source, test or script file;
//   - a commit without a Developer Certificate of Origin sign-off;
//   - any term in a maintainer's private term list (--terms <file>, or the
//     IDYL_PUBLICATION_TERMS environment variable), one case-sensitive
//     regular expression per line; and
//   - any secret gitleaks finds in the tree or in the history.
//
// A finding names its file, line, column and rule, never the text it
// matched, so the scan's own output is safe to paste into a pull request.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The header every source, test and script file starts with. */
export const LICENSE_HEADER =
  "// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0";

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {RegExp} pattern a global regular expression
 * @property {(path: string) => boolean} [appliesTo]
 * @property {(match: RegExpExecArray) => boolean} [allows]
 */

/**
 * @typedef {object} Finding
 * @property {string} source
 * @property {number} line
 * @property {number} column
 * @property {string} rule
 */

/** Paths whose content is IDYL's reference contract, vendored verbatim. */
const vendored = (/** @type {string} */ path) =>
  path.startsWith("test/conformance/fixtures/");

/** The scanner's own files, which spell out what the scan refuses. */
const scanner = new Set([
  "scripts/publication-scan.mjs",
  "test/publication-scan.test.ts",
]);

const allowedEmailDomains =
  /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid)$/iu;
/**
 * The published contacts in SECURITY.md and CODE_OF_CONDUCT.md, and the
 * protocol names in the `name@domain` form that published commit messages
 * carry: an SSH channel request and a stated session ending, the ending in
 * each spelling the history holds. These domains also carry mail, so each
 * name is listed rather than the domain.
 */
const allowedEmails = new Set([
  "security@idyl.dev",
  "conduct@idyl.dev",
  "attach@idyl.dev",
  "shell_not_found@idyl.network",
  "shell_not_found@idyl.sh",
]);

/**
 * The IPv4 special-purpose ranges of the IANA registry: private, shared,
 * loopback, link-local, documentation, benchmarking, multicast and reserved
 * space. The client refuses egress to them, so its source names each by its
 * base address. A base address names a range, never a host, and is
 * publishable; any other address in a private range could be an internal
 * host, and is not.
 * @type {readonly (readonly [string, number])[]}
 */
const SPECIAL_PURPOSE_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/**
 * The public block `example.com` long resolved to, the documentation domain
 * of RFC 2606. A test uses it where it needs a public destination, which the
 * special-purpose ranges cannot be, and the reference contract's goldens do
 * the same.
 * @type {readonly [string, number]}
 */
const EXAMPLE_COM_RANGE = ["93.184.216.0", 24];

/** @param {string} address */
function addressValue(address) {
  return address
    .split(".")
    .map(Number)
    .reduce((value, octet) => value * 256 + octet, 0);
}

/** @param {number} value @param {readonly [string, number]} range */
function inRange(value, [base, bits]) {
  const start = addressValue(base);
  return value >= start && value < start + 2 ** (32 - bits);
}

/**
 * Whether an IPv4 address is one a public document may carry: loopback, the
 * unspecified address, an RFC 5737 documentation address, the base address
 * of a special-purpose range, or an address in the block of `example.com`.
 * @param {string} address
 */
export function isPublishableAddress(address) {
  const octets = address.split(".").map(Number);
  const [a, b, c] = octets;
  if (octets.some((octet) => octet > 255)) return true; // not an address
  if (a === 127) return true;
  if (octets.every((octet) => octet === 0)) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (SPECIAL_PURPOSE_RANGES.some(([base]) => base === address)) return true;
  return inRange(addressValue(address), EXAMPLE_COM_RANGE);
}

/**
 * Whether an email address is one a public document may carry.
 * @param {string} email
 */
export function isPublishableEmail(email) {
  const lower = email.toLowerCase();
  if (allowedEmails.has(lower)) return true;
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  return allowedEmailDomains.test(domain);
}

/** @type {Rule[]} */
export const RULES = [
  {
    id: "workstation-path",
    pattern: /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\/gu,
  },
  {
    id: "idyl-host",
    pattern:
      /\b(?:[a-z0-9-]+\.)+idyl\.(?:dev|network|sh|io|ai|cloud|app|com)\b/giu,
    // An email address is judged by the email rule. The production network's
    // public endpoints are the client's documented default, and are
    // published.
    allows: (match) =>
      match.input[match.index - 1] === "@" ||
      /^(?:api|identity|meta)\.idyl\.sh$/u.test(match[0]),
  },
  {
    id: "email",
    // The last label is alphabetic, so `package@1.2.3` is not an address.
    pattern: /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/gu,
    allows: (match) => isPublishableEmail(match[0]),
  },
  {
    id: "ip-address",
    pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/gu,
    // The reference contract's goldens are judged where they are published.
    appliesTo: (path) => !vendored(path),
    allows: (match) => isPublishableAddress(match[0]),
  },
  {
    id: "unlaunched-product",
    pattern:
      /\b(?:Actors?|Agents?|Populations?|Invocations?|Fleets?|Nodes?|Workloads?|Filesystems?|Sandbox(?:es)?)\b(?!\.js)/gu,
    // The scanner and its test name the products in order to find them.
    appliesTo: (path) => !vendored(path) && !scanner.has(path),
    allows: (match) => {
      // `User-Agent` is an HTTP header, not a product.
      if (
        match[0].startsWith("Agent") &&
        match.input.slice(Math.max(0, match.index - 5), match.index) === "User-"
      ) {
        return true;
      }
      // `Node 22` is the Node.js runtime at a version, not a product, also
      // when a reflowed message breaks the line between the two.
      return (
        match[0] === "Node" &&
        /^\s+\d/u.test(match.input.slice(match.index + match[0].length))
      );
    },
  },
];

/**
 * Splits text into findings for one rule set. Columns and lines are 1-based.
 * @param {string} text
 * @param {string} source
 * @param {readonly Rule[]} rules
 * @returns {Finding[]}
 */
export function scanText(text, source, rules) {
  /** @type {Finding[]} */
  const findings = [];
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  const position = (/** @type {number} */ offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - (lineStarts[low] ?? 0) + 1 };
  };
  for (const rule of rules) {
    if (rule.appliesTo !== undefined && !rule.appliesTo(source)) continue;
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match[0] === "") {
        pattern.lastIndex += 1;
        continue;
      }
      if (rule.allows?.(match) === true) continue;
      findings.push({ source, ...position(match.index), rule: rule.id });
    }
  }
  return findings;
}

/**
 * Whether a tracked file must start with the license header.
 * @param {string} path
 */
export function needsLicenseHeader(path) {
  if (vendored(path)) return false;
  return /\.(?:ts|mts|cts|js|mjs|cjs)$/u.test(path);
}

/**
 * Whether a file's text starts with the license header, after an optional
 * shebang line.
 * @param {string} text
 */
export function hasLicenseHeader(text) {
  const body = text.startsWith("#!")
    ? text.slice(text.indexOf("\n") + 1)
    : text;
  return body.startsWith(`${LICENSE_HEADER}\n`);
}

/**
 * A commit or pull request message without its attribution lines, which
 * name people and tools by design: the `Co-Authored-By` and `Signed-off-by`
 * trailers and a "Generated with" footer.
 * @param {string} message
 */
export function messageBody(message) {
  return message
    .split("\n")
    .filter(
      (line) =>
        !/^(?:Co-Authored-By|Signed-off-by):/iu.test(line) &&
        !/^\S* ?Generated with \[[^\]]+\]\([^)]+\)$/u.test(line),
    )
    .join("\n");
}

/**
 * Whether a commit message carries a Developer Certificate of Origin
 * sign-off.
 * @param {string} message
 */
export function isSignedOff(message) {
  return /^Signed-off-by: .+ <[^<>\s]+@[^<>\s]+>$/mu.test(message);
}

/**
 * Reads a private term list: one regular expression per line, blank lines
 * and lines starting with `#` ignored. A term is matched case-sensitively,
 * so an expression spells out the cases it refuses.
 * @param {string} text
 * @returns {Rule[]}
 */
export function parseTerms(text) {
  /** @type {Rule[]} */
  const rules = [];
  text.split("\n").forEach((line, index) => {
    const term = line.trim();
    if (term === "" || term.startsWith("#")) return;
    rules.push({
      id: `private-term:${String(index + 1)}`,
      pattern: new RegExp(term, "gu"),
    });
  });
  return rules;
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {string} cwd
 */
function git(file, args, cwd) {
  return execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Runs gitleaks over one target and reports whether it found nothing. The
 * report itself is never printed: it would carry what it found.
 * @param {string[]} args
 * @param {string} cwd
 */
function gitleaks(args, cwd) {
  try {
    execFileSync(
      "gitleaks",
      [...args, "--no-banner", "--redact", "--log-level", "error"],
      { cwd, stdio: "pipe" },
    );
    return true;
  } catch (error) {
    const status = /** @type {{ status?: number, code?: string }} */ (error);
    if (status.code === "ENOENT") {
      throw new Error(
        "gitleaks is not installed; the scan needs it (https://github.com/gitleaks/gitleaks)",
        { cause: error },
      );
    }
    if (status.status === 1) return false;
    throw error;
  }
}

/** @param {string[]} argv */
function parseArguments(argv) {
  /** @type {{ terms: string | undefined, messages: string[] }} */
  const options = {
    terms: process.env["IDYL_PUBLICATION_TERMS"],
    messages: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if ((argument === "--terms" || argument === "--message") && value) {
      if (argument === "--terms") options.terms = value;
      else options.messages.push(value);
      index += 1;
    } else {
      throw new Error(`unknown argument ${String(argument)}`);
    }
  }
  return options;
}

function main() {
  const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const options = parseArguments(process.argv.slice(2));
  const terms =
    options.terms === undefined || options.terms === ""
      ? []
      : parseTerms(readFileSync(options.terms, "utf8"));
  const rules = [...RULES, ...terms];

  /** @type {Finding[]} */
  const findings = [];
  const files = git(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    repository,
  )
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(repository, path)));
  for (const path of files) {
    const bytes = readFileSync(join(repository, path));
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    findings.push(...scanText(text, path, rules));
    if (needsLicenseHeader(path) && !hasLicenseHeader(text)) {
      findings.push({
        source: path,
        line: 1,
        column: 1,
        rule: "license-header",
      });
    }
  }

  const log = git("git", ["log", "-z", "--format=%H%n%B"], repository);
  const commits = log.split("\0").filter((entry) => entry.trim() !== "");
  for (const entry of commits) {
    const newline = entry.indexOf("\n");
    const commit = entry.slice(0, newline).trim();
    const message = entry.slice(newline + 1);
    const source = `commit ${commit.slice(0, 12)}`;
    findings.push(...scanText(messageBody(message), source, rules));
    if (!isSignedOff(message)) {
      findings.push({ source, line: 1, column: 1, rule: "sign-off" });
    }
  }

  for (const path of options.messages) {
    const text = readFileSync(path, "utf8");
    findings.push(...scanText(messageBody(text), `message ${path}`, rules));
  }

  const treeClean = gitleaks(["dir", "."], repository);
  const historyClean = gitleaks(["git", "."], repository);

  for (const finding of findings) {
    console.error(
      `${finding.source}:${String(finding.line)}:${String(finding.column)} ${finding.rule}`,
    );
  }
  if (!treeClean) console.error("gitleaks: a secret was found in the tree");
  if (!historyClean) {
    console.error("gitleaks: a secret was found in the history");
  }
  const summary = [
    `${String(files.length)} files`,
    `${String(commits.length)} commits`,
    `${String(options.messages.length)} messages`,
    `private terms ${terms.length > 0 ? `checked (${String(terms.length)})` : "not checked"}`,
    `gitleaks tree and history ${treeClean && historyClean ? "clean" : "not clean"}`,
  ].join(", ");
  if (findings.length > 0 || !treeClean || !historyClean) {
    console.error(
      `publication scan: ${String(findings.length)} findings; ${summary}`,
    );
    process.exit(1);
  }
  console.log(`publication scan: clean; ${summary}`);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  main();
}
