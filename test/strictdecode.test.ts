// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  always,
  array,
  boolean,
  collection,
  decodeText,
  decodeValue,
  integer,
  map,
  object,
  omitEmpty,
  omitZero,
  parseText,
  pointer,
  required,
  scalar,
  string,
} from "../src/internal/strictdecode.js";
import { StrictDecodeError } from "../src/resource/decode-error.js";

interface Inner {
  readonly name: string;
  readonly count?: number;
  readonly flag?: boolean;
}

interface Outer {
  readonly kind: string;
  readonly inner: Inner;
  readonly items: readonly Inner[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly block?: Inner;
  readonly size?: { readonly value: number };
}

const inner = object<Inner>({
  name: always(string()),
  count: omitEmpty(integer({ unsigned: true })),
  flag: pointer(boolean()),
});

const size = scalar<{ readonly value: number }>({
  decode: (text) => {
    if (!/^\d+Gi$/u.test(text)) throw new TypeError(`invalid size ${text}`);
    return { value: Number(text.slice(0, -2)) };
  },
  encode: (value) => `${String(value.value)}Gi`,
  zero: () => ({ value: 0 }),
  isZero: (value) => value.value === 0,
  acceptsNumber: true,
});

const outer = object<Outer>({
  kind: required(string()),
  inner: always(inner),
  items: collection(array(inner)),
  labels: omitEmpty(map(string())),
  block: pointer(inner),
  size: omitZero(size),
});

function rejection(run: () => unknown): StrictDecodeError {
  try {
    run();
  } catch (error) {
    if (error instanceof StrictDecodeError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("strict text parsing", () => {
  // Contract: a duplicate key anywhere is refused by its full path, escapes
  // resolved, so two spellings of one key are one key.
  it("refuses duplicate keys by path", () => {
    const error = rejection(() =>
      parseText('{"a":{"b":[{"c":1,"\\u0063":2}]}}'),
    );
    expect(error.reason).toBe("duplicate_field");
    expect(error.path).toBe("a.b[0].c");
    expect(error.message).toBe('duplicate field "a.b[0].c"');
  });

  // Contract: exactly one value; a second value is trailing content.
  it("refuses trailing content", () => {
    const error = rejection(() => parseText('{"a":1} {"b":2}'));
    expect(error.reason).toBe("trailing_content");
    expect(error.message).toBe("multiple JSON values are not allowed");
    expect(rejection(() => parseText('{"a":1} x')).reason).toBe("invalid_json");
  });

  // Contract: malformed text is refused as invalid JSON with its offset.
  it("refuses malformed text", () => {
    for (const text of [
      "",
      "   ",
      "{",
      '{"a"}',
      '{"a":}',
      "[1,]",
      '{"a":01}',
      '{"a":"\\x"}',
      '{"a":"\n"}',
      "tru",
      '{"a":1,}',
      "{a:1}",
    ]) {
      expect(rejection(() => parseText(text)).reason, text).toBe(
        "invalid_json",
      );
    }
  });

  // Contract: nesting is bounded at the depth the reference contract's decoder accepts,
  // so a document built to exhaust the stack is refused as invalid JSON
  // rather than failing inside the parser.
  it("refuses nesting past the bound", () => {
    const accepted = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
    expect(Array.isArray(parseText(accepted))).toBe(true);
    const error = rejection(() =>
      parseText(`${"[".repeat(10_001)}${"]".repeat(10_001)}`),
    );
    expect(error.reason).toBe("invalid_json");
    expect(error.message).toBe(
      "invalid JSON at offset 10000: exceeded max depth",
    );
    const nested = `{"a":${"[".repeat(10_000)}1${"]".repeat(10_000)}}`;
    expect(rejection(() => parseText(nested)).reason).toBe("invalid_json");
  });

  // Contract: well-formed text parses to the value JSON.parse gives.
  it("accepts well-formed text", () => {
    const text =
      ' {"a": [1, -2.5e3, true, false, null, "s\\u00e9\\n"], "b": {}, "c": []} ';
    expect(parseText(text)).toEqual(JSON.parse(text));
  });
});

describe("strict shape decoding", () => {
  const document = {
    kind: "Thing",
    inner: { name: "a", count: 2, flag: false },
    items: [{ name: "b" }],
    labels: { z: "1", a: "2" },
    size: "4Gi",
  };

  // Contract: a document with every declared field decodes to the typed
  // value and encodes back to itself with the reference contract's key order for maps.
  it("round-trips a full document", () => {
    const value = decodeValue(document, outer);
    expect(value).toEqual(
      document.size === "4Gi" ? { ...document, size: { value: 4 } } : document,
    );
    expect(outer.encode(value)).toEqual({
      ...document,
      labels: { a: "2", z: "1" },
    });
  });

  // Contract: an absent `always` field reads as its zero value and is still
  // written; an absent optional field reads as undefined and is not.
  it("fills zero values and omits unset fields", () => {
    const value = decodeValue({ kind: "Thing" }, outer);
    expect(value).toEqual({ kind: "Thing", inner: { name: "" }, items: [] });
    expect("labels" in value).toBe(false);
    expect(outer.encode(value)).toEqual({
      kind: "Thing",
      inner: { name: "" },
    });
  });

  // Contract: a required field must be present; null reads as absence.
  it("refuses a missing required field", () => {
    const error = rejection(() => decodeValue({ inner: {} }, outer));
    expect(error.reason).toBe("missing_field");
    expect(error.path).toBe("kind");
    expect(error.message).toBe('missing field "kind"');
    expect(rejection(() => decodeValue({ kind: null }, outer)).path).toBe(
      "kind",
    );
  });

  // Contract: an unknown field is refused by its full path, before any type
  // error, and keys are visited in sorted order.
  it("refuses unknown fields by path and before type errors", () => {
    const error = rejection(() =>
      decodeValue(
        { kind: "Thing", inner: { name: 1, zzz: true, aaa: 1 } },
        outer,
      ),
    );
    expect(error.reason).toBe("unknown_field");
    expect(error.path).toBe("inner.aaa");
    const inArray = rejection(() =>
      decodeValue(
        { kind: "Thing", items: [{ name: "x" }, { nope: 1 }] },
        outer,
      ),
    );
    expect(inArray.path).toBe("items[1].nope");
    expect(inArray.message).toBe('unknown field "items[1].nope"');
  });

  // Contract: keys match exactly and case-sensitively.
  it("matches keys case-sensitively", () => {
    expect(rejection(() => decodeValue({ Kind: "Thing" }, outer)).path).toBe(
      "Kind",
    );
  });

  // Contract: a value of the wrong JSON type is refused by path and by the
  // type the field expects.
  it("refuses wrong types", () => {
    const cases: readonly [unknown, string, string][] = [
      [{ kind: 1 }, "kind", 'field "kind" must be a string'],
      [{ kind: "k", inner: [] }, "inner", 'field "inner" must be an object'],
      [{ kind: "k", items: {} }, "items", 'field "items" must be an array'],
      [
        { kind: "k", inner: { name: "a", count: -1 } },
        "inner.count",
        'field "inner.count" must be a non-negative integer',
      ],
      [
        { kind: "k", inner: { name: "a", count: 1.5 } },
        "inner.count",
        'field "inner.count" must be a non-negative integer',
      ],
      [
        { kind: "k", inner: { name: "a", flag: "yes" } },
        "inner.flag",
        'field "inner.flag" must be a boolean',
      ],
      [
        { kind: "k", labels: { a: 1 } },
        "labels.a",
        'field "labels.a" must be a string',
      ],
      [{ kind: "k", size: true }, "size", 'field "size" must be a string'],
    ];
    for (const [document, path, message] of cases) {
      const error = rejection(() => decodeValue(document, outer));
      expect(error.reason, path).toBe("wrong_type");
      expect(error.path).toBe(path);
      expect(error.message).toBe(message);
    }
    expect(rejection(() => decodeValue([], outer)).message).toBe(
      "document must be an object",
    );
  });

  // Contract: a scalar's own codec judges its spelling; a refusal is an
  // invalid_value carrying the codec's error as its cause, and a number is
  // accepted as the spelling of itself where the codec allows it.
  it("delegates scalar spellings to the codec", () => {
    const error = rejection(() =>
      decodeValue({ kind: "k", size: "fast" }, outer),
    );
    expect(error.reason).toBe("invalid_value");
    expect(error.path).toBe("size");
    expect(error.message).toBe('invalid field "size": invalid size fast');
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(
      rejection(() => decodeValue({ kind: "k", size: 4 }, outer)).message,
    ).toBe('invalid field "size": invalid size 4');
  });

  // Contract: omission follows the Go tag. omitempty drops an empty array
  // or map, omitzero drops a zero scalar, a pointer keeps a present false
  // and an empty object, and a plain field is written even when zero.
  it("encodes with the Go omission rules", () => {
    expect(
      outer.encode({
        kind: "k",
        inner: { name: "", count: 0, flag: false },
        items: [],
        labels: {},
        block: { name: "" },
        size: { value: 0 },
      }),
    ).toEqual({
      kind: "k",
      inner: { name: "", flag: false },
      block: { name: "" },
    });
  });

  // Contract: text decoding is the value decoding after the text checks.
  it("decodes text through the same rules", () => {
    expect(decodeText(JSON.stringify(document), outer)).toEqual(
      decodeValue(document, outer),
    );
    expect(
      rejection(() => decodeText('{"kind":"k","kind":"k"}', outer)).reason,
    ).toBe("duplicate_field");
  });

  // Contract: a prototype key is an ordinary undeclared field, never a
  // prototype assignment.
  it("treats __proto__ as an undeclared field", () => {
    const error = rejection(() =>
      decodeText('{"kind":"k","__proto__":{"polluted":true}}', outer),
    );
    expect(error.path).toBe("__proto__");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
