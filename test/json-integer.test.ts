// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StrictDecodeError } from "../src/resource/decode-error.js";
import {
  parseJson,
  stringifyJson,
  type Integer,
  type JsonObject,
  type JsonValue,
} from "../src/resource/json.js";
import {
  always,
  array,
  decodeText,
  decodeValue,
  integer,
  map,
  object,
  omitEmpty,
  omitZero,
  pointer,
  parseText,
} from "../src/internal/strictdecode.js";

const unsigned = integer({ unsigned: true, bits: 64 });
const signed = integer({ unsigned: false, bits: 64 });
const unsignedObject = object<{ readonly value: Integer }>({
  value: always(unsigned),
});
const signedObject = object<{ readonly value: Integer }>({
  value: always(signed),
});

function rejection(run: () => unknown): StrictDecodeError {
  try {
    run();
  } catch (error) {
    if (error instanceof StrictDecodeError) return error;
    throw error;
  }
  throw new Error("expected a decode refusal");
}

describe("exact JSON integers", () => {
  // Contract: ordinary safe values keep their number type, and every digit
  // outside that range is read from the original integral token as bigint.
  it("reads and writes the full integral boundaries without quoted numbers", () => {
    const cases: readonly (readonly [string, Integer])[] = [
      ["0", 0],
      ["9007199254740991", Number.MAX_SAFE_INTEGER],
      ["-9007199254740991", Number.MIN_SAFE_INTEGER],
      ["9007199254740992", 9007199254740992n],
      ["9007199254740993", 9007199254740993n],
      ["-9007199254740993", -9007199254740993n],
      ["9223372036854775807", 9223372036854775807n],
      ["-9223372036854775808", -9223372036854775808n],
      ["18446744073709551615", 18446744073709551615n],
      ["18446744073709551616", 18446744073709551616n],
    ];
    for (const [text, expected] of cases) {
      expect(parseJson(text), text).toBe(expected);
      expect(stringifyJson(expected), text).toBe(text);
      expect(parseText(text), text).toBe(expected);
    }
    expect(Object.is(parseJson("-0"), -0)).toBe(true);
    expect(stringifyJson(-0)).toBe("0");
  });

  // Contract: an SDK consumer can parse, inspect and render an external
  // JsonObject using the same exact numeric representation as the codecs.
  it("preserves unknown integral fields and raw values through lenient reads", () => {
    const text =
      '{"value":1,"future":18446744073709551616,"nested":{"items":[9007199254740993,-9223372036854775809]},"__proto__":{"count":9007199254740993}}';
    const value = parseJson(text) as JsonObject;
    expect(value["future"]).toBe(18446744073709551616n);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    const decoded = decodeValue(
      value,
      unsignedObject,
      "lenient",
    ) as unknown as JsonObject;
    expect(decoded["future"]).toBe(value["future"]);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    expect(stringifyJson(decoded)).toBe(text);
    expect(rejection(() => decodeValue(value, unsignedObject)).reason).toBe(
      "unknown_field",
    );
    const unreadable = decodeValue(
      parseJson('{"value":18446744073709551616}'),
      unsignedObject,
      "lenient",
    );
    expect(unreadable.value).toBe(18446744073709551616n);
    expect(stringifyJson(unreadable)).toBe('{"value":18446744073709551616}');
  });

  // Contract: no original intention is recoverable from a rounded number.
  // Writes emit the actual integer represented by the supplied number.
  it("writes the actual supplied number rather than its rounded decimal shortcut", () => {
    const value = Number("1000000000000000128");
    expect(JSON.stringify(value)).toBe("1000000000000000100");
    expect(BigInt(value)).toBe(1000000000000000128n);
    expect(stringifyJson(value)).toBe("1000000000000000128");
    expect(unsigned.decode(value, "")).toBe(1000000000000000128n);
    expect(stringifyJson(unsignedObject.encode({ value }))).toBe(
      '{"value":1000000000000000128}',
    );
    const roundedAboveMaximum = Number("18446744073709551615");
    expect(BigInt(roundedAboveMaximum)).toBe(18446744073709551616n);
    expect(() => unsigned.decode(roundedAboveMaximum, "value")).toThrow(
      StrictDecodeError,
    );
    expect(unsigned.decode(18446744073709551615n, "value")).toBe(
      18446744073709551615n,
    );
  });

  // Contract: fractions and exponent forms read as floating-point numbers;
  // integer syntax is judged on submission.
  it("keeps floating-point observations as numbers", () => {
    for (const text of [
      "1.5",
      "1e3",
      "1E+3",
      "0.1000000000000000000001",
      "1e309",
    ]) {
      expect(parseJson(text), text).toBe(JSON.parse(text));
    }
    expect(stringifyJson(parseJson("1e309"))).toBe("null");
    expect(stringifyJson(parseJson("1.5"))).toBe("1.5");
  });

  // Contract: the exact writer follows ordinary JSON key order, escaping
  // and indentation, permits shared values, and refuses cycles visibly.
  it("renders ordinary objects and arrays like native JSON", () => {
    const leaf = { text: 'line\n\t\u0000"\\', empty: {} };
    const value: JsonValue = {
      "2": 2,
      "1": 1,
      leaves: [leaf, leaf, null, true, 1.25],
    };
    for (const space of [undefined, 0, 2, 12, "  ", "............"]) {
      expect(stringifyJson(value, space)).toBe(
        JSON.stringify(value, null, space),
      );
    }
    expect(stringifyJson(Array<JsonValue>(2))).toBe("[null,null]");
    const cycle: { child?: JsonValue } = {};
    cycle.child = cycle;
    expect(() => stringifyJson(cycle)).toThrow("circular value");
  });

  // Contract: nesting to the bound parses and renders without depending on
  // the JavaScript call stack.
  it("parses and renders deeply nested values", () => {
    const text = `${"[".repeat(10_000)}18446744073709551615${"]".repeat(10_000)}`;
    expect(stringifyJson(parseJson(text))).toBe(text);
    expect(() => parseJson(`[${text}]`)).toThrow("exceeded max depth");
  });

  // Contract: lenient reads keep the last duplicate key while strict text
  // submissions retain duplicate, syntax, trailing and escaped-key checks.
  it("preserves duplicate and trailing-content postures", () => {
    expect(parseJson('{"value":1,"value":18446744073709551615}')).toEqual({
      value: 18446744073709551615n,
    });
    expect(
      rejection(() => parseText('{"value":1,"\\u0076alue":2}')).reason,
    ).toBe("duplicate_field");
    expect(parseJson('{"value":1,"value":null}')).toEqual({ value: null });
    expect(rejection(() => parseJson("1 2")).reason).toBe("trailing_content");
    expect(rejection(() => parseJson("[1,]")).reason).toBe("invalid_json");
  });
});

describe("width-aware integral descriptors", () => {
  // Contract: bounds belong to the canonical Go field width, not the safe
  // JavaScript range. Valid bigint zero behaves like ordinary number zero.
  it("accepts exact signed and unsigned bounds and refuses real overflows", () => {
    expect(
      decodeText('{"value":18446744073709551615}', unsignedObject),
    ).toEqual({ value: 18446744073709551615n });
    expect(decodeText('{"value":9223372036854775807}', signedObject)).toEqual({
      value: 9223372036854775807n,
    });
    expect(decodeText('{"value":-9223372036854775808}', signedObject)).toEqual({
      value: -9223372036854775808n,
    });
    for (const value of [-1n, 18446744073709551616n, Infinity, NaN, 0.5, "1"]) {
      expect(() => unsigned.decode(value, "value")).toThrow(StrictDecodeError);
    }
    for (const value of [-9223372036854775809n, 9223372036854775808n]) {
      expect(() => signed.decode(value, "value")).toThrow(StrictDecodeError);
    }
    expect(signed.isZero(0n)).toBe(true);
    expect(unsigned.isEmpty(0n)).toBe(true);
    expect(unsigned.zero()).toBe(0);
    const omitted = object<{
      readonly empty?: Integer;
      readonly zero?: Integer;
      readonly pointer?: Integer;
    }>({
      empty: omitEmpty(unsigned),
      zero: omitZero(unsigned),
      pointer: pointer(unsigned),
    });
    expect(
      stringifyJson(omitted.encode({ empty: 0n, zero: 0n, pointer: 0n })),
    ).toBe('{"pointer":0}');
  });

  // Contract: a numeric token with a fraction or exponent is not a Go
  // integral submission, even when its floating-point value is integral.
  it("checks original submission syntax in object, array and map fields", () => {
    const arrayShape = object<{ readonly values: readonly Integer[] }>({
      values: always(array(unsigned)),
    });
    const mapShape = object<{
      readonly values: Readonly<Record<string, Integer>>;
    }>({ values: always(map(unsigned)) });
    for (const token of ["1e3", "1E+3", "1.0", "-0"]) {
      const error = rejection(() =>
        decodeText(`{"value":${token}}`, unsignedObject),
      );
      expect(error.path, token).toBe("value");
      expect(
        rejection(() =>
          decodeValue(parseJson(`{"value":${token}}`), unsignedObject),
        ).path,
        token,
      ).toBe("value");
      expect(
        rejection(() => decodeText(`{"values":[${token}]}`, arrayShape)).path,
        token,
      ).toBe("values[0]");
      expect(
        rejection(() => decodeText(`{"values":{"a":${token}}}`, mapShape)).path,
        token,
      ).toBe("values.a");
    }
    expect(rejection(() => decodeText("1e3", unsigned)).reason).toBe(
      "wrong_type",
    );
    expect(decodeText("-0", signed)).toBe(0);
    expect(
      decodeValue(parseJson('{"value":1e3}'), unsignedObject, "lenient"),
    ).toEqual({ value: 1000 });
    expect(
      decodeValue(parseJson('{"value":1.5}'), unsignedObject, "lenient"),
    ).toEqual({ value: 1.5 });
  });

  // Contract: token provenance is tied to the parsed value, so changing a
  // field never silently applies the old token's syntax to the new value.
  it("does not mistake replaced fields or duplicate values for their old tokens", () => {
    const value = parseJson('{"value":1e3}') as { value: JsonValue };
    value.value = 2n;
    expect(decodeValue(value, unsignedObject)).toEqual({ value: 2 });
    expect(
      decodeValue(parseJson('{"value":1e3,"value":2}'), unsignedObject),
    ).toEqual({ value: 2 });
    expect(
      rejection(() =>
        decodeValue(parseJson('{"value":2,"value":1e3}'), unsignedObject),
      ).path,
    ).toBe("value");
  });

  // Contract: narrower widths retain their number representation and their
  // actual Go bounds instead of being widened with the 64-bit fields.
  it("keeps narrow widths and their real bounds", () => {
    const uint32 = integer({ unsigned: true, bits: 32 });
    const int32 = integer({ unsigned: false, bits: 32 });
    expect(uint32.decode(4294967295n, "mode")).toBe(4294967295);
    expect(int32.decode(-2147483648, "exitCode")).toBe(-2147483648);
    expect(int32.decode(2147483647, "exitCode")).toBe(2147483647);
    expect(() => uint32.decode(4294967296n, "mode")).toThrow(StrictDecodeError);
    expect(() => int32.decode(2147483648, "exitCode")).toThrow(
      StrictDecodeError,
    );
    expect(() => int32.decode(-2147483649, "exitCode")).toThrow(
      StrictDecodeError,
    );
    expect(integer({ unsigned: true, bits: 16 }).decode(65535, "port")).toBe(
      65535,
    );
    expect(() =>
      integer({ unsigned: true, bits: 16 }).decode(65536, "port"),
    ).toThrow(StrictDecodeError);
    expect(integer({ unsigned: true, bits: 8 }).decode(255, "flags")).toBe(255);
    expect(() =>
      integer({ unsigned: true, bits: 8 }).decode(256, "flags"),
    ).toThrow(StrictDecodeError);
  });
});

describe("ordinary fixture rendering", () => {
  // Contract: every vendored golden renders as native JSON renders it,
  // compact and pretty-printed: the same numbers, key order and escaping.
  it("retains ordinary fixture bytes and exact integral tokens in canonical fixtures", () => {
    const root = fileURLToPath(
      new URL("./conformance/fixtures/", import.meta.url),
    );
    const paths = readdirSync(root, { recursive: true }).filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.endsWith(".json"),
    );
    expect(paths.length).toBe(172);
    for (const path of paths) {
      const text = readFileSync(`${root}/${path}`, "utf8");
      const exact = parseJson(text);
      const native: unknown = JSON.parse(text);
      expect(stringifyJson(exact), path).toBe(JSON.stringify(native));
      expect(stringifyJson(exact, 2), path).toBe(
        JSON.stringify(native, null, 2),
      );
    }
  });
});

describe("ordinary undefined JSON omission", () => {
  // Contract: optional object values are omitted, while array holes and
  // undefined entries are null, matching the ordinary JSON writer behavior.
  it("keeps omission and holes alongside exact integer values", () => {
    const ordinaryEntries = Array<number | undefined>(3);
    ordinaryEntries[1] = undefined;
    ordinaryEntries[2] = 42;
    const wideEntries = Array<bigint | undefined>(3);
    wideEntries[1] = undefined;
    wideEntries[2] = 18446744073709551615n;
    const ordinary = {
      name: "ordinary",
      description: undefined,
      nested: { omitted: undefined },
      entries: ordinaryEntries,
    };
    expect(stringifyJson(ordinary as unknown as JsonValue)).toBe(
      JSON.stringify(ordinary),
    );
    const wide = {
      ...ordinary,
      count: 18446744073709551615n,
      entries: wideEntries,
    };
    expect(stringifyJson(wide as unknown as JsonValue)).toBe(
      '{"name":"ordinary","nested":{},"entries":[null,null,18446744073709551615],"count":18446744073709551615}',
    );
  });
});
