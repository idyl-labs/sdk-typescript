// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// Writes the package's reference for the documentation site: one Mintlify
// page per area of the public API, and a manifest of what it wrote.
//
//   node scripts/reference-pages.mjs <site-checkout>
//
// The pages are read from the package's own type declarations and doc
// comments through the TypeScript compiler, starting at the two entry
// points the export map names, `.` and `./computer-connection`. Only what
// those entry points export appears, and every export appears on exactly
// one page: an export no page claims stops the run, naming the export.
//
// The run replaces `reference/sdk/` in the site checkout: every page there
// and `manifest.json`, which records the package version, each page in
// navigation order with the SHA-256 of its bytes, and the page each export
// is on. The site's reference check compares the pages with the manifest,
// so a page edited by hand fails it. A page that reads wrong is fixed in
// the doc comment it came from, and the pages are written again.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the pages live in the site, and the address of each page. */
export const SITE_FOLDER = "reference/sdk";

/** The entry points of the export map, with the import path of each. */
const ENTRIES = [
  { file: "src/index.ts", specifier: "@idyl-sh/sdk" },
  {
    file: "src/computer-connection/index.ts",
    specifier: "@idyl-sh/sdk/computer-connection",
  },
];

/**
 * @typedef {object} PageSpec
 * @property {string} slug the page's file name, without `.mdx`
 * @property {string} title the page's title
 * @property {string} [subject] the class or interface the page is about
 * @property {string} [intro] the source file whose module comment opens a
 *   page that has no subject
 * @property {readonly string[]} sources source files, relative to `src/`,
 *   whose exports the page holds
 * @property {readonly string[]} [claims] exports the page holds whatever
 *   file declares them
 */

/**
 * The pages, in the order the site lists them. An export is on the page
 * that claims it by name, or else on the page that lists its source file.
 * @type {readonly PageSpec[]}
 */
export const PAGES = [
  {
    slug: "idyl",
    title: "Idyl",
    subject: "Idyl",
    sources: [
      "client/idyl.ts",
      "client/common.ts",
      "credential.ts",
      "resource/id.ts",
      "resource/uuid-id.ts",
    ],
  },
  {
    slug: "computers",
    title: "idyl.computers",
    subject: "Computers",
    sources: [],
    claims: [
      "Computers",
      "CreateComputerOptions",
      "ComputerImage",
      "ImageShell",
      "ImagesOptions",
      "ComputerSizeInfo",
    ],
  },
  {
    slug: "computer",
    title: "Computer",
    subject: "Computer",
    sources: [
      "client/computer.ts",
      "client/exec.ts",
      "client/terminal.ts",
      "client/records.ts",
      "client/settings.ts",
      "api/storage.ts",
    ],
  },
  {
    slug: "files",
    title: "computer.files",
    subject: "Files",
    sources: ["client/files.ts", "client/download.ts"],
  },
  {
    slug: "notebooks",
    title: "computer.notebooks",
    subject: "Notebooks",
    sources: ["client/notebooks.ts"],
    claims: ["Cell", "CellProcess"],
  },
  {
    slug: "secrets",
    title: "idyl.secrets",
    subject: "Secrets",
    sources: ["client/secrets.ts"],
  },
  {
    slug: "billing",
    title: "idyl.billing",
    subject: "Billing",
    sources: [
      "client/billing.ts",
      "api/billing.ts",
      "resource/computer-execution-settings.ts",
    ],
  },
  {
    slug: "identity",
    title: "idyl.identity",
    subject: "Identity",
    sources: ["client/identity.ts"],
  },
  {
    slug: "access-keys",
    title: "idyl.accessKeys",
    subject: "AccessKeys",
    sources: ["client/access-keys.ts", "client/access-key-file.ts"],
  },
  {
    slug: "errors",
    title: "Errors",
    intro: "errors.ts",
    sources: ["errors.ts", "client/codes.ts"],
    claims: ["ComputerSessionEndedError", "FrameError", "SessionTrustError"],
  },
  {
    slug: "computer-connection",
    title: "Browser connection",
    intro: "computer-connection/index.ts",
    sources: ["computer-connection/"],
    claims: ["ConnectorOptions"],
  },
];

/**
 * How a page's code names the object a type's methods are called on. A
 * type not listed is named by its own name, lowercased at its first letter.
 * @type {Readonly<Record<string, string>>}
 */
const RECEIVERS = {
  Idyl: "idyl",
  Computers: "idyl.computers",
  Computer: "computer",
  Files: "computer.files",
  Notebooks: "computer.notebooks",
  Secrets: "idyl.secrets",
  Billing: "idyl.billing",
  Identity: "idyl.identity",
  AccessKeys: "idyl.accessKeys",
};

/**
 * @typedef {object} Export
 * @property {string} name
 * @property {ts.Symbol} symbol the declared symbol, aliases resolved
 * @property {ts.Declaration} declaration
 * @property {string} source the declaring file, relative to `src/`
 * @property {string} specifier the import path that exports it
 */

/**
 * @typedef {object} Doc
 * @property {string} text the comment's prose
 * @property {{ name: string, text: string }[]} tags its block tags, in order
 */

/**
 * @typedef {object} Context
 * @property {ts.TypeChecker} checker
 * @property {Map<string, string>} homes the page slug of every export
 * @property {Map<string, string>} members the anchor of every method, by
 *   `Type.method`
 * @property {Set<string>} gaps what the doc comments leave undocumented
 * @property {string} page the page being written
 */

/** Builds the program over the package's entry points. */
function loadProgram() {
  const configPath = join(repository, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (parsed === undefined) throw new Error("tsconfig.json is not readable");
  return ts.createProgram({
    rootNames: ENTRIES.map((entry) => join(repository, entry.file)),
    options: parsed.options,
  });
}

/**
 * Every export of the entry points, in the order each entry exports it.
 * @param {ts.Program} program
 * @returns {Export[]}
 */
function exportsOf(program) {
  const checker = program.getTypeChecker();
  /** @type {Export[]} */
  const found = [];
  const seen = new Set();
  for (const entry of ENTRIES) {
    const file = program.getSourceFile(join(repository, entry.file));
    const module = file && checker.getSymbolAtLocation(file);
    if (module === undefined) throw new Error(`${entry.file} is not a module`);
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      const declaration = symbol.declarations?.[0];
      if (declaration === undefined) {
        throw new Error(`export ${exported.name} has no declaration`);
      }
      if (seen.has(exported.name)) {
        throw new Error(`export ${exported.name} is exported twice`);
      }
      seen.add(exported.name);
      found.push({
        name: exported.name,
        symbol,
        declaration,
        source: relative(
          join(repository, "src"),
          declaration.getSourceFile().fileName,
        ),
        specifier: entry.specifier,
      });
    }
  }
  return found;
}

/**
 * The page each export is on.
 * @param {readonly Export[]} exports
 * @returns {Map<string, string>}
 */
function assignPages(exports) {
  /** @type {Map<string, string>} */
  const homes = new Map();
  const claimed = new Map();
  for (const page of PAGES) {
    for (const name of page.claims ?? []) claimed.set(name, page.slug);
  }
  /** @type {string[]} */
  const homeless = [];
  for (const entry of exports) {
    const page =
      claimed.get(entry.name) ??
      PAGES.find((spec) =>
        spec.sources.some((source) =>
          source.endsWith("/")
            ? entry.source.startsWith(source)
            : entry.source === source,
        ),
      )?.slug;
    if (page === undefined)
      homeless.push(`${entry.name} (src/${entry.source})`);
    else homes.set(entry.name, page);
  }
  if (homeless.length > 0) {
    throw new Error(
      `no page holds these exports; add each to PAGES:\n  ${homeless.join("\n  ")}`,
    );
  }
  for (const name of claimed.keys()) {
    if (!homes.has(name))
      throw new Error(`PAGES claims ${name}, which is not exported`);
  }
  return homes;
}

/**
 * The doc comment of a declaration: its prose and its block tags.
 * @param {Parameters<typeof ts.getJSDocCommentsAndTags>[0]} node
 * @returns {Doc}
 */
function docOf(node) {
  const comments = ts
    .getJSDocCommentsAndTags(node)
    .filter((item) => ts.isJSDoc(item));
  const last = comments.at(-1);
  if (last === undefined) return { text: "", tags: [] };
  return { text: commentText(last.comment), tags: tagsOf(last) };
}

/**
 * The block tags of a doc comment, in order. The compiler reads
 * `{@link X}` after `@throws` as a type expression and splits the tag in
 * two, so `@throws` tags are read from the comment's source text instead.
 * @param {ts.JSDoc} comment
 * @returns {{ name: string, text: string }[]}
 */
function tagsOf(comment) {
  const tags = (comment.tags ?? [])
    .filter(
      (tag) =>
        !ts.isJSDocThrowsTag(tag) &&
        tag.tagName.text !== "link" &&
        tag.tagName.text !== "packageDocumentation",
    )
    .map((tag) => ({ name: tag.tagName.text, text: tagText(tag) }));
  const source = comment
    .getText()
    .replace(/^\/\*\*/u, "")
    .replace(/\*\/$/u, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*(?!\/) ?/u, ""))
    .join("\n");
  for (const [, text = ""] of source.matchAll(
    /^@throws[ \t]+([\s\S]*?)(?=^@[A-Za-z]|(?![\s\S]))/gmu,
  )) {
    tags.push({ name: "throws", text: text.trim() });
  }
  return tags;
}

/**
 * The text of a comment, with inline links kept in `{@link …}` form.
 * @param {string | ts.NodeArray<ts.JSDocComment> | undefined} comment
 */
function commentText(comment) {
  if (comment === undefined) return "";
  if (typeof comment === "string") return comment.trim();
  return comment
    .map((part) =>
      ts.isJSDocLink(part) ||
      ts.isJSDocLinkCode(part) ||
      ts.isJSDocLinkPlain(part)
        ? `{@link ${part.name === undefined ? "" : part.name.getText()}${part.text}}`
        : part.text,
    )
    .join("")
    .trim();
}

/**
 * The text of a block tag. A `@param` keeps its name first; a `@throws`
 * keeps its error first, as written.
 * @param {ts.JSDocTag} tag
 */
function tagText(tag) {
  const text = commentText(tag.comment);
  if (ts.isJSDocParameterTag(tag))
    return `${tag.name.getText()} ${text}`.trim();
  return text;
}

/**
 * Whether a member is part of the public surface.
 * @param {ts.Declaration} declaration
 */
function isPublic(declaration) {
  const name = ts.getNameOfDeclaration(declaration);
  if (name !== undefined && ts.isPrivateIdentifier(name)) return false;
  const flags = ts.getCombinedModifierFlags(declaration);
  if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
    return false;
  }
  return !ts
    .getJSDocTags(declaration)
    .some((tag) => tag.tagName.text === "internal");
}

/** Collapses the white space of a piece of code onto one line. @param {string} code */
const oneLine = (code) =>
  code
    .replace(/\s+/gu, " ")
    .replace(/([<([]) /gu, "$1")
    .replace(/ ([>)\]])/gu, "$1")
    .trim();

/**
 * The type a declaration states, as written.
 * @param {Context} context
 * @param {ts.Declaration} declaration
 */
function declaredType(context, declaration) {
  const node = /** @type {{ type?: ts.TypeNode }} */ (declaration).type;
  if (node !== undefined) return oneLine(node.getText());
  return context.checker.typeToString(
    context.checker.getTypeAtLocation(declaration),
    undefined,
    ts.TypeFormatFlags.NoTruncation,
  );
}

/**
 * One parameter of a signature.
 * @typedef {object} Parameter
 * @property {string} name
 * @property {string} type
 * @property {boolean} optional
 * @property {string} text its `@param` prose
 * @property {ts.Type} resolved
 */

/**
 * @typedef {object} Callable
 * @property {string} name
 * @property {string} signature the signature as code, without the name
 * @property {Parameter[]} parameters
 * @property {string} returns the return type as written
 * @property {Doc} doc
 * @property {string} owner the declaring type and a dot, or "" for a function
 */

/**
 * The callable form of a method, function or constructor declaration.
 * @param {Context} context
 * @param {string} name
 * @param {ts.SignatureDeclaration} declaration
 * @returns {Callable}
 */
function callableOf(context, name, declaration) {
  const parent = declaration.parent;
  const owner =
    (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) &&
    parent.name !== undefined
      ? `${parent.name.text}.`
      : "";
  const doc = docOf(declaration);
  const params = new Map(
    doc.tags
      .filter((tag) => tag.name === "param")
      .map((tag) => {
        const space = tag.text.indexOf(" ");
        return space === -1
          ? [tag.text, ""]
          : [
              tag.text.slice(0, space),
              tag.text.slice(space + 1).replace(/^-\s*/u, ""),
            ];
      }),
  );
  /** @type {Parameter[]} */
  const parameters = declaration.parameters.map((parameter) => {
    const parameterName = parameter.name.getText();
    const optional =
      parameter.questionToken !== undefined ||
      parameter.initializer !== undefined ||
      parameter.dotDotDotToken !== undefined;
    return {
      name:
        parameter.dotDotDotToken === undefined
          ? parameterName
          : `...${parameterName}`,
      type:
        parameter.type === undefined
          ? "unknown"
          : oneLine(parameter.type.getText()),
      optional,
      text: params.get(parameterName) ?? "",
      resolved: context.checker.getTypeAtLocation(parameter),
    };
  });
  const returns =
    declaration.type === undefined
      ? ts.isConstructorDeclaration(declaration)
        ? ""
        : "void"
      : oneLine(declaration.type.getText());
  const typeParameters =
    declaration.typeParameters === undefined
      ? ""
      : `<${declaration.typeParameters.map((parameter) => oneLine(parameter.getText())).join(", ")}>`;
  const list = parameters
    .map((parameter) =>
      parameter.name.startsWith("...")
        ? `${parameter.name}: ${parameter.type}`
        : `${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.type}`,
    )
    .join(", ");
  return {
    name,
    signature: `${typeParameters}(${list})${returns === "" ? "" : `: ${returns}`}`,
    parameters,
    returns,
    doc,
    owner,
  };
}

/**
 * @typedef {object} Property
 * @property {string} name
 * @property {string} type
 * @property {boolean} optional
 * @property {Doc} doc
 * @property {string} owner the declaring type

/**
 * @typedef {object} Shape
 * @property {Property[]} properties
 * @property {Callable[]} methods
 * @property {Callable | undefined} constructor
 * @property {string[]} heritage the types it extends, as written
 */

/**
 * The members of a class or interface: its own, in declaration order,
 * then those it inherits from an interface it extends.
 * @param {Context} context
 * @param {ts.ClassDeclaration | ts.InterfaceDeclaration} declaration
 * @param {boolean} inherited whether to include inherited members
 * @returns {Shape}
 */
function shapeOf(context, declaration, inherited) {
  /** @type {Property[]} */
  const properties = [];
  /** @type {Callable[]} */
  const methods = [];
  /** @type {Callable | undefined} */
  let constructor;
  const seen = new Set();
  /** @param {ts.ClassDeclaration | ts.InterfaceDeclaration} owner */
  const visit = (owner) => {
    for (const member of owner.members) {
      if (!isPublic(member)) continue;
      if (ts.isConstructorDeclaration(member)) {
        if (owner === declaration)
          constructor = callableOf(context, "constructor", member);
        continue;
      }
      if (ts.isIndexSignatureDeclaration(member)) continue;
      const name = member.name?.getText();
      if (name === undefined) continue;
      if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
        // Every signature of an overloaded method is shown; a class
        // method's implementation is not a signature callers see.
        if (
          seen.has(name) &&
          !methods.some(
            (method) =>
              method.name === name &&
              method.owner === `${owner.name?.text ?? ""}.`,
          )
        )
          continue;
        if (
          ts.isMethodDeclaration(member) &&
          member.body !== undefined &&
          owner.members.some(
            (other) =>
              other !== member &&
              ts.isMethodDeclaration(other) &&
              other.name.getText() === name,
          )
        )
          continue;
        seen.add(name);
        methods.push(callableOf(context, name, member));
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
        properties.push({
          name,
          type: declaredType(context, member),
          optional: member.questionToken !== undefined,
          doc: docOf(member),
          owner: owner.name?.text ?? "",
        });
      } else if (ts.isGetAccessorDeclaration(member)) {
        properties.push({
          name,
          type:
            member.type === undefined
              ? declaredType(context, member)
              : oneLine(member.type.getText()),
          optional: false,
          doc: docOf(member),
          owner: owner.name?.text ?? "",
        });
      }
    }
    if (!inherited) return;
    for (const clause of owner.heritageClauses ?? []) {
      for (const type of clause.types) {
        const symbol = context.checker.getSymbolAtLocation(type.expression);
        const target =
          symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
            ? context.checker.getAliasedSymbol(symbol)
            : symbol;
        const parent = target?.declarations?.find(
          (item) =>
            ts.isInterfaceDeclaration(item) || ts.isClassDeclaration(item),
        );
        if (
          parent !== undefined &&
          (ts.isInterfaceDeclaration(parent) ||
            ts.isClassDeclaration(parent)) &&
          !parent.getSourceFile().isDeclarationFile
        ) {
          visit(parent);
        }
      }
    }
  };
  visit(declaration);
  const heritage = (declaration.heritageClauses ?? []).flatMap((clause) =>
    clause.types.map((type) => oneLine(type.getText())),
  );
  return { properties, methods, constructor, heritage };
}

/** Escapes prose for MDX: outside code, `<`, `>`, `{` and `}` are text. @param {string} text */
function escapeProse(text) {
  return text
    .split(/(`+[^`]*?`+)/u)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/\\/gu, "\\\\")
            .replace(
              /[<>{}]/gu,
              (character) => `&#${String(character.charCodeAt(0))};`,
            ),
    )
    .join("");
}

/** The anchor Mintlify gives a heading. @param {string} heading */
export function anchorOf(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * The link to an export, or to a member of one, or undefined when the name
 * is not on any page.
 * @param {Context} context
 * @param {string} target `Name` or `Name.member`
 */
function linkTo(context, target) {
  const [name = "", member] = target.split(".", 2);
  const page = context.homes.get(name);
  if (page === undefined) return undefined;
  const anchor =
    member === undefined ? undefined : context.members.get(`${name}.${member}`);
  if (anchor !== undefined) return `/${SITE_FOLDER}/${page}#${anchor}`;
  // A page's subject is the page itself, which has no heading of its name.
  const subject = PAGES.find((spec) => spec.slug === page)?.subject === name;
  return subject
    ? `/${SITE_FOLDER}/${page}`
    : `/${SITE_FOLDER}/${page}#${anchorOf(name)}`;
}

/**
 * Prose from a doc comment as MDX: inline links resolved, the rest escaped,
 * and fenced code kept as written.
 * @param {Context} context
 * @param {string} text
 */
function prose(context, text) {
  return text
    .split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/mu)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      /** @type {string[]} */
      const links = [];
      const marked = part.replace(
        /\{@link(?:code|plain)?\s+([^}\s|]+)(?:[\s|]+([^}]*))?\}/gu,
        (
          _all,
          /** @type {string} */ target,
          /** @type {string | undefined} */ label,
        ) => {
          const href = linkTo(context, target);
          const shown = label?.trim() || target;
          links.push(
            href === undefined ? `\`${shown}\`` : `[\`${shown}\`](${href})`,
          );
          return `\uE000${String(links.length - 1)}\uE000`;
        },
      );
      return escapeProse(marked).replace(
        /\uE000(\d+)\uE000/gu,
        (_all, /** @type {string} */ index) => links[Number(index)] ?? "",
      );
    })
    .join("")
    .trim();
}

/** A table cell: one line, with pipes escaped. @param {string} text */
const cell = (text) => text.replace(/\s*\n\s*/gu, " ").replace(/\|/gu, "\\|");

/**
 * A type as inline code, linked when it is exactly one exported name.
 * @param {Context} context
 * @param {string} type
 */
function typeCell(context, type) {
  const bare = type.replace(/^readonly\s+/u, "").replace(/\[\]$/u, "");
  const href = /^[A-Za-z_]\w*$/u.test(bare) ? linkTo(context, bare) : undefined;
  const code = `\`${cell(type)}\``;
  return href === undefined ? code : `[${code}](${href})`;
}

/**
 * The options every call shares, documented once on the Idyl page and
 * linked from each call that takes them.
 */
const SHARED_OPTIONS = new Set(["CallOptions", "ListOptions", "PageOptions"]);

/**
 * The exported options interface, named `…Options`, a parameter takes,
 * when it takes one that is not shared.
 * @param {Context} context
 * @param {Parameter} parameter
 */
function optionsInterface(context, parameter) {
  const name = parameter.type.replace(/\s*\|\s*undefined$/u, "");
  if (!/^[A-Z]\w*$/u.test(name) || !context.homes.has(name)) return undefined;
  if (SHARED_OPTIONS.has(name) || !name.endsWith("Options")) return undefined;
  const symbol = context.checker
    .getNonNullableType(parameter.resolved)
    .getSymbol();
  const declaration = symbol?.declarations?.find((item) =>
    ts.isInterfaceDeclaration(item),
  );
  if (declaration === undefined || !ts.isInterfaceDeclaration(declaration))
    return undefined;
  const shape = shapeOf(context, declaration, true);
  return shape.methods.length === 0 && shape.properties.length > 0
    ? { name, shape }
    : undefined;
}

/**
 * The rows of a properties table.
 * @param {Context} context
 * @param {readonly Property[]} properties
 * @param {string} [prefix] prepended to each name
 */
function propertyRows(context, properties, prefix = "") {
  return properties.map((property) => {
    if (property.doc.text === "") {
      context.gaps.add(
        `${context.page}: property ${property.owner}.${property.name} has no doc comment`,
      );
    }
    return `| \`${prefix}${property.name}${property.optional ? "?" : ""}\` | ${typeCell(context, property.type)} | ${cell(prose(context, property.doc.text))} |`;
  });
}

/**
 * What a parameter's row says: its `@param` prose, or for an options
 * interface the first sentence of that interface's comment.
 * @param {Context} context
 * @param {Callable} callable
 * @param {Parameter} parameter
 */
function parameterText(context, callable, parameter) {
  if (parameter.text !== "") {
    return `${parameter.text.charAt(0).toUpperCase()}${parameter.text.slice(1)}`;
  }
  const symbol = context.checker
    .getNonNullableType(parameter.resolved)
    .getSymbol();
  const declaration = symbol?.declarations?.find((item) =>
    ts.isInterfaceDeclaration(item),
  );
  const text =
    declaration === undefined ? "" : firstSentence(docOf(declaration).text);
  if (text === "") {
    context.gaps.add(
      `${context.page}: parameter ${parameter.name} of ${callable.owner}${callable.name} has no @param`,
    );
  }
  return text;
}

/**
 * A method, function or constructor as MDX.
 * @param {Context} context
 * @param {Callable} callable
 * @param {string} receiver what the code calls it on, or "" for a function
 * @param {string} level the heading's `#`s
 * @param {string} heading the heading, or "" for none
 */
function renderCallable(context, callable, receiver, level, heading) {
  /** @type {string[]} */
  const out = heading === "" ? [] : [`${level} ${heading}`, ""];
  const call =
    callable.name === "constructor"
      ? `new ${receiver}${callable.signature}`
      : `${receiver === "" ? "" : `${receiver}.`}${callable.name}${callable.signature}`;
  out.push("```ts", call, "```", "");
  const text = prose(context, callable.doc.text);
  if (text !== "") out.push(text, "");
  else
    context.gaps.add(
      `${context.page}: ${callable.owner}${callable.name} has no doc comment`,
    );
  if (callable.parameters.length > 0) {
    out.push(
      "**Parameters**",
      "",
      "| Name | Type | Description |",
      "| --- | --- | --- |",
    );
    /** @type {{ name: string, shape: Shape }[]} */
    const expanded = [];
    for (const parameter of callable.parameters) {
      out.push(
        `| \`${parameter.name}${parameter.optional ? "?" : ""}\` | ${typeCell(context, parameter.type)} | ${cell(prose(context, parameterText(context, callable, parameter)))} |`,
      );
      const options = optionsInterface(context, parameter);
      if (options !== undefined)
        expanded.push({ ...options, name: parameter.name });
    }
    out.push("");
    for (const options of expanded) {
      out.push(
        `**Options** of \`${options.name}\``,
        "",
        "| Name | Type | Description |",
        "| --- | --- | --- |",
        ...propertyRows(context, options.shape.properties),
        "",
      );
    }
  }
  if (callable.returns !== "" && callable.returns !== "void") {
    const returned =
      callable.doc.tags.find((tag) => tag.name === "returns")?.text ?? "";
    out.push(
      `**Returns** ${typeCell(context, callable.returns)}${returned === "" ? "" : ` ${prose(context, returned)}`}`,
      "",
    );
  }
  const throws = callable.doc.tags.filter((tag) => tag.name === "throws");
  if (throws.length > 0) {
    out.push("**Throws**", "", "| Error | When |", "| --- | --- |");
    for (const tag of throws) {
      const match =
        /^(?:\{@link\s+([^}\s]+)\s*\}|([A-Za-z_]\w*))\s*([\s\S]*)$/u.exec(
          tag.text,
        );
      const name = match?.[1] ?? match?.[2] ?? "";
      const when = match?.[3] ?? tag.text;
      out.push(
        `| ${name === "" ? "" : typeCell(context, name)} | ${cell(prose(context, when))} |`,
      );
    }
    out.push("");
  }
  for (const example of examplesOf(callable.doc)) out.push(example, "");
  return out;
}

/**
 * The `@example` blocks of a comment, each as fenced code.
 * @param {Doc} doc
 */
function examplesOf(doc) {
  return doc.tags
    .filter((tag) => tag.name === "example")
    .map((tag) => {
      const text = tag.text.trim();
      // A line of the example that starts with `@` would have ended the
      // tag early; an unbalanced fence shows that it did.
      if ((text.match(/^```/gmu) ?? []).length % 2 === 1) {
        throw new Error(
          `an @example ends inside a code block: ${JSON.stringify(text.slice(0, 60))}`,
        );
      }
      return text.startsWith("```") ? text : `\`\`\`ts\n${text}\n\`\`\``;
    });
}

/**
 * The code that declares a type alias or a constant.
 * @param {Context} context
 * @param {Export} entry
 */
function declarationCode(context, entry) {
  const declaration = entry.declaration;
  if (ts.isTypeAliasDeclaration(declaration)) {
    const parameters =
      declaration.typeParameters === undefined
        ? ""
        : `<${declaration.typeParameters.map((parameter) => parameter.getText()).join(", ")}>`;
    return `type ${entry.name}${parameters} = ${declaration.type.getText()};`;
  }
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = declaration.initializer;
    const literal =
      initializer !== undefined &&
      (ts.isStringLiteral(initializer) || ts.isNumericLiteral(initializer))
        ? initializer.getText()
        : undefined;
    return literal === undefined
      ? `const ${entry.name}: ${declaredType(context, declaration)};`
      : `const ${entry.name} = ${literal};`;
  }
  return "";
}

/**
 * The receiver a type's methods are shown called on.
 * @param {string} name
 */
const receiverOf = (name) =>
  RECEIVERS[name] ?? `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/**
 * One export as MDX, under a `###` heading.
 * @param {Context} context
 * @param {Export} entry
 */
function renderEntry(context, entry) {
  const declaration = entry.declaration;
  const doc = docOf(
    ts.isVariableDeclaration(declaration)
      ? declaration.parent.parent
      : declaration,
  );
  /** @type {string[]} */
  const out = [];
  if (ts.isFunctionDeclaration(declaration)) {
    const overloads = (entry.symbol.declarations ?? []).filter((item) =>
      ts.isFunctionDeclaration(item),
    );
    const shown =
      overloads.length > 1
        ? overloads.filter((item) => item.body === undefined)
        : overloads;
    shown.forEach((overload, index) => {
      const callable = callableOf(
        context,
        entry.name,
        /** @type {ts.FunctionDeclaration} */ (overload),
      );
      out.push(
        ...renderCallable(
          context,
          callable,
          "",
          "###",
          index === 0 ? entry.name : `${entry.name} (${String(index + 1)})`,
        ),
      );
    });
    return out;
  }
  out.push(`### ${entry.name}`, "");
  if (
    ts.isClassDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration)
  ) {
    const shape = shapeOf(context, declaration, false);
    const kind = ts.isClassDeclaration(declaration) ? "class" : "interface";
    const extendsText =
      shape.heritage.length === 0
        ? ""
        : ` extends ${shape.heritage.join(", ")}`;
    out.push(
      "```ts",
      `${kind} ${entry.name}${typeParametersOf(declaration)}${extendsText}`,
      "```",
      "",
    );
    const text = prose(context, doc.text);
    if (text !== "") out.push(text, "");
    if (shape.heritage.length > 0) {
      const links = shape.heritage.map((type) => typeCell(context, type));
      out.push(`Extends ${links.join(", ")}.`, "");
    }
    for (const example of examplesOf(doc)) out.push(example, "");
    if (shape.constructor !== undefined) {
      out.push(
        ...renderCallable(
          context,
          shape.constructor,
          entry.name,
          "####",
          `${entry.name} constructor`,
        ),
      );
    }
    if (shape.properties.length > 0) {
      out.push(
        "| Property | Type | Description |",
        "| --- | --- | --- |",
        ...propertyRows(context, shape.properties),
        "",
      );
    }
    shape.methods.forEach((method, index) => {
      const overload = shape.methods[index - 1]?.name === method.name;
      out.push(
        ...renderCallable(
          context,
          method,
          receiverOf(entry.name),
          "####",
          overload ? "" : `${entry.name}.${method.name}`,
        ),
      );
    });
    return out;
  }
  out.push("```ts", declarationCode(context, entry), "```", "");
  const text = prose(context, doc.text);
  if (text !== "") out.push(text, "");
  for (const example of examplesOf(doc)) out.push(example, "");
  return out;
}

/** @param {ts.ClassDeclaration | ts.InterfaceDeclaration} declaration */
function typeParametersOf(declaration) {
  return declaration.typeParameters === undefined
    ? ""
    : `<${declaration.typeParameters.map((parameter) => parameter.getText()).join(", ")}>`;
}

/**
 * The module comment of a source file: the first doc comment, when it
 * carries `@packageDocumentation`.
 * @param {ts.Program} program
 * @param {string} source relative to `src/`
 * @returns {Doc}
 */
function moduleDoc(program, source) {
  const file = program.getSourceFile(join(repository, "src", source));
  if (file === undefined)
    throw new Error(`src/${source} is not in the program`);
  const statement = file.statements[0];
  if (statement === undefined) return { text: "", tags: [] };
  for (const item of ts.getJSDocCommentsAndTags(statement)) {
    if (!ts.isJSDoc(item)) continue;
    if (
      (item.tags ?? []).some(
        (tag) => tag.tagName.text === "packageDocumentation",
      )
    ) {
      return {
        text: commentText(item.comment),
        tags: tagsOf(item),
      };
    }
  }
  return { text: "", tags: [] };
}

/** The first sentence of a piece of prose, for a page's description. @param {string} text */
function firstSentence(text) {
  const plain =
    text
      .split(/\n\s*\n/u)[0]
      ?.replace(
        /\{@link(?:code|plain)?\s+([^}\s|]+)(?:[\s|]+([^}]*))?\}/gu,
        (
          _all,
          /** @type {string} */ target,
          /** @type {string | undefined} */ label,
        ) => label?.trim() || target,
      )
      .replace(/`/gu, "")
      .replace(/\s+/gu, " ")
      .trim() ?? "";
  const end = plain.search(/[.:](?:\s|$)/u);
  return (end === -1 ? plain : plain.slice(0, end + 1)).replace(/:$/u, ".");
}

/**
 * Records the anchor of every method on a page: a subject's methods are
 * headed by their own names, any other type's by `Type.method`.
 * @param {Context} context
 * @param {PageSpec} page
 * @param {readonly Export[]} entries
 */
function recordMembers(context, page, entries) {
  for (const entry of entries) {
    const declaration = entry.declaration;
    if (
      !ts.isClassDeclaration(declaration) &&
      !ts.isInterfaceDeclaration(declaration)
    )
      continue;
    for (const method of shapeOf(context, declaration, false).methods) {
      const key = `${entry.name}.${method.name}`;
      context.members.set(
        key,
        anchorOf(entry.name === page.subject ? method.name : key),
      );
    }
  }
}

/**
 * Writes one page.
 * @param {Context} context
 * @param {ts.Program} program
 * @param {PageSpec} page
 * @param {readonly Export[]} entries the exports on the page, in export order
 * @param {string} version
 */
function renderPage(context, program, page, entries, version) {
  context.page = page.slug;
  const subject = entries.find((entry) => entry.name === page.subject);
  const intro =
    subject === undefined
      ? moduleDoc(program, page.intro ?? "")
      : docOf(subject.declaration);
  const specifiers = [...new Set(entries.map((entry) => entry.specifier))];
  /** @type {string[]} */
  const out = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(firstSentence(intro.text))}`,
    "---",
    "",
    `{/* Written by scripts/reference-pages.mjs in sdk-typescript from the package's doc comments. Edit the doc comments, never this page. */}`,
    "",
    `Version ${version} of ${specifiers.map((specifier) => `\`${specifier}\``).join(" and ")}.`,
    "",
  ];
  const text = prose(context, intro.text);
  if (text !== "") out.push(text, "");
  const examples = examplesOf(intro);
  if (examples.length !== 1) {
    context.gaps.add(
      `${page.slug}: the page's comment has ${String(examples.length)} @example blocks, not one`,
    );
  }
  for (const example of examples) out.push(example, "");

  if (subject !== undefined) {
    const declaration = subject.declaration;
    if (
      ts.isClassDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration)
    ) {
      const shape = shapeOf(context, declaration, false);
      if (shape.constructor !== undefined) {
        out.push("## Constructor", "");
        out.push(
          ...renderCallable(
            context,
            shape.constructor,
            subject.name,
            "###",
            "",
          ),
        );
      }
      if (shape.properties.length > 0) {
        out.push(
          "## Properties",
          "",
          "| Property | Type | Description |",
          "| --- | --- | --- |",
          ...propertyRows(context, shape.properties),
          "",
        );
      }
      if (shape.methods.length > 0) {
        out.push("## Methods", "");
        shape.methods.forEach((method, index) => {
          const overload = shape.methods[index - 1]?.name === method.name;
          out.push(
            ...renderCallable(
              context,
              method,
              receiverOf(subject.name),
              "###",
              overload ? "" : method.name,
            ),
          );
        });
      }
    }
  }

  const groups = [
    {
      title: "Classes",
      test: (/** @type {ts.Declaration} */ d) => ts.isClassDeclaration(d),
    },
    {
      title: "Functions",
      test: (/** @type {ts.Declaration} */ d) => ts.isFunctionDeclaration(d),
    },
    {
      title: "Types",
      test: (/** @type {ts.Declaration} */ d) =>
        ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d),
    },
    {
      title: "Constants",
      test: (/** @type {ts.Declaration} */ d) => ts.isVariableDeclaration(d),
    },
  ];
  for (const group of groups) {
    const members = entries.filter(
      (entry) => entry !== subject && group.test(entry.declaration),
    );
    if (members.length === 0) continue;
    out.push(`## ${group.title}`, "");
    for (const entry of members) out.push(...renderEntry(context, entry));
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd()}\n`;
}

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Renders every page.
 * @returns {{ version: string, pages: { slug: string, title: string, text: string }[], homes: Map<string, string>, exports: Export[], gaps: string[] }}
 */
export function renderReference() {
  const program = loadProgram();
  const checker = program.getTypeChecker();
  const exports = exportsOf(program);
  const homes = assignPages(exports);
  /** @type {Context} */
  const context = {
    checker,
    homes,
    members: new Map(),
    gaps: new Set(),
    page: "",
  };
  const onPage = (/** @type {PageSpec} */ page) =>
    exports.filter((entry) => homes.get(entry.name) === page.slug);
  for (const page of PAGES) {
    recordMembers(context, page, onPage(page));
  }
  const pkg = /** @type {{ version: string }} */ (
    JSON.parse(readFileSync(join(repository, "package.json"), "utf8"))
  );
  const pages = PAGES.map((page) => ({
    slug: page.slug,
    title: page.title,
    text: renderPage(context, program, page, onPage(page), pkg.version),
  }));
  return {
    version: pkg.version,
    pages,
    homes,
    exports,
    gaps: [...context.gaps].sort(),
  };
}

/**
 * Writes the pages and the manifest into a site checkout.
 * @param {string} site the site checkout's root
 */
export function writeReference(site) {
  if (!existsSync(join(site, "docs.json"))) {
    throw new Error(`${site} is not a site checkout: it has no docs.json`);
  }
  const { version, pages, homes, exports, gaps } = renderReference();
  if (gaps.length > 0) {
    throw new Error(
      `the doc comments leave ${String(gaps.length)} gaps; document each and run again:\n  ${gaps.join("\n  ")}`,
    );
  }
  const folder = join(site, SITE_FOLDER);
  mkdirSync(folder, { recursive: true });
  for (const name of readdirSync(folder)) {
    if (name.endsWith(".mdx") || name === "manifest.json") {
      rmSync(join(folder, name));
    }
  }
  for (const page of pages)
    writeFileSync(join(folder, `${page.slug}.mdx`), page.text);
  const manifest = {
    package: "@idyl-sh/sdk",
    version,
    generator: "sdk-typescript scripts/reference-pages.mjs",
    pages: pages.map((page) => ({
      page: `${SITE_FOLDER}/${page.slug}`,
      title: page.title,
      sha256: sha256(page.text),
    })),
    exports: Object.fromEntries(
      exports.map((entry) => [
        entry.name,
        {
          from: entry.specifier,
          page: `${SITE_FOLDER}/${homes.get(entry.name) ?? ""}`,
        },
      ]),
    ),
  };
  writeFileSync(
    join(folder, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { version, pages: pages.map((page) => `${SITE_FOLDER}/${page.slug}`) };
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  const site = process.argv[2];
  if (site === undefined || process.argv.length > 3) {
    console.error("usage: node scripts/reference-pages.mjs <site-checkout>");
    process.exit(2);
  }
  try {
    const { version, pages } = writeReference(resolve(site));
    console.log(
      `reference pages: wrote ${String(pages.length)} pages for version ${version}`,
    );
    for (const page of pages) console.log(`  ${page}`);
  } catch (error) {
    console.error(
      `reference pages: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
