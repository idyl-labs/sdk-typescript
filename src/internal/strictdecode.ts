// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * Strict submission decoding: one implementation, used by every resource and
 * API contract that decodes a document a caller wrote.
 *
 * A document decodes as exactly one JSON value with no unknown fields, no
 * duplicate object keys, and no trailing content, and every rejection names
 * the field by its full path from the root of the document, in the form
 * `spec.containers[0].imageURI`, so a caller can be pointed at the part of the
 * submission that is wrong rather than at the submission.
 *
 * A contract declares its wire shape once, next to its type, with the
 * combinators below. The shape drives both directions: decoding checks the
 * document against it and builds the typed value, and encoding renders the
 * typed value back to its wire document with the reference contract's omission rules, so
 * what this package emits is what the reference contract emits.
 *
 * The same shapes read a response, in lenient mode: a field the shape does
 * not declare is carried as it arrived, a value the shape cannot read is
 * carried as it arrived, and only what a codec canonicalizes, a quantity or
 * a duration, is normalized. Which mode applies belongs to the call site: a
 * submission is strict, an observation is lenient, and no type decides.
 */
import { StrictDecodeError } from "../resource/decode-error.js";
import type { Integer, JsonObject, JsonValue } from "../resource/json.js";

/**
 * How a document is read. `strict` refuses a field the shape does not
 * declare, a value of the wrong type, and a missing required field.
 * `lenient` carries an undeclared field and an unreadable value as they
 * arrived, reads a missing required field as its zero value, and normalizes
 * only what a codec canonicalizes.
 */
export type DecodeMode = "strict" | "lenient";

/**
 * The wire shape of one value: how it is checked, decoded, encoded, and what
 * its zero value is. The reference contract's omission rules need both `isZero` (the
 * `omitzero` test, which omits a struct or quantity whose every part is zero)
 * and `isEmpty` (the `omitempty` test, which omits a false, zero, empty
 * string, empty array, or empty map but never a struct).
 */
export interface Shape<T> {
  /**
   * Reports the first field under `value` that the shape does not declare,
   * by throwing. Object keys are visited in sorted order so a document with
   * several unknown fields is refused on the same one every time. A value
   * whose JSON type does not fit the shape is left for `decode` to report.
   */
  readonly unknownFields: (value: unknown, path: string) => void;
  /**
   * Builds the typed value, or throws a {@link StrictDecodeError}. In
   * lenient mode a container carries what it cannot read instead of
   * throwing; a scalar shape needs no mode, because the container that
   * holds it decides what to do with its refusal.
   */
  readonly decode: (
    value: unknown,
    path: string,
    mode?: DecodeMode,
    numberToken?: string,
  ) => T;
  /** Renders the typed value as the JSON value the wire carries. */
  readonly encode: (value: T) => JsonValue;
  /** The value the reference contract reads an absent field as. */
  readonly zero: () => T;
  /** Whether the reference contract's `omitzero` would omit the value. */
  readonly isZero: (value: T) => boolean;
  /** Whether the reference contract's `omitempty` would omit the value. */
  readonly isEmpty: (value: T) => boolean;
}

/**
 * How a field is read and written. A `required` field must be present in the
 * document; a `value` field reads as its zero value when absent, as a Go
 * struct field does; an `optional` field reads as `undefined`. Omission on
 * encode follows the Go tag the field carries: `never` for a plain field,
 * `undefined` for a pointer, `empty` for `omitempty`, `zero` for `omitzero`.
 */
export interface Field<T> {
  readonly shape: Shape<T>;
  readonly presence: "required" | "value" | "optional";
  readonly omit: "never" | "undefined" | "empty" | "zero";
  /** Refuses null on submission, or retains it as a JSON payload rather than an absent pointer. */
  readonly null?: "refuse" | "preserve";
}

/** A field that is always present on the typed value. */
export interface PresentField<T> extends Field<T> {
  readonly presence: "required" | "value";
}

/** A field that may be absent from the typed value. */
export interface OptionalField<T> extends Field<T> {
  readonly presence: "optional";
}

type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;

/**
 * The fields of an object shape, keyed by wire name. A property the type
 * declares as optional takes an {@link OptionalField}; every other property
 * takes a {@link PresentField}, so the shape and the type cannot disagree
 * about which fields may be absent.
 */
export type ObjectFields<T> = {
  readonly [K in RequiredKeys<T>]: PresentField<T[K]>;
} & {
  readonly [K in OptionalKeys<T>]: OptionalField<Exclude<T[K], undefined>>;
};

/** A field the document must state. It is always written. */
export function required<T>(shape: Shape<T>): PresentField<T> {
  return { shape, presence: "required", omit: "never" };
}

/**
 * A field the document may omit, read as the shape's zero value when it does.
 * It is always written, zero included.
 */
export function always<T>(shape: Shape<T>): PresentField<T> {
  return { shape, presence: "value", omit: "never" };
}

/** A Go `omitempty` field: absent when unset, omitted when empty. */
export function omitEmpty<T>(shape: Shape<T>): OptionalField<T> {
  return { shape, presence: "optional", omit: "empty" };
}

/**
 * A Go `omitempty` array or map that the type declares as always present:
 * it reads as empty when absent and is omitted when empty, so a document
 * never carries `[]` or `{}` for it and code never reads `undefined`.
 */
export function collection<T>(shape: Shape<T>): PresentField<T> {
  return { shape, presence: "value", omit: "empty" };
}

/** A Go `omitzero` field: absent when unset, omitted when zero. */
export function omitZero<T>(shape: Shape<T>): OptionalField<T> {
  return { shape, presence: "optional", omit: "zero" };
}

/**
 * A Go pointer field with `omitempty`: absent when unset, otherwise written
 * whatever its value, so a present `false` or an empty object reaches the
 * wire.
 */
export function pointer<T>(shape: Shape<T>): OptionalField<T> {
  return { shape, presence: "optional", omit: "undefined" };
}

/** An optional pointer whose explicit null is refused on a strict submission. */
export function explicitPointer<T>(shape: Shape<T>): OptionalField<T> {
  return { ...pointer(shape), null: "refuse" };
}

/**
 * A JSON string carried as it is. The type parameter names the string union
 * the field declares; membership is not judged here, because a vocabulary
 * belongs to whoever reports it and validation is where a caller's own value
 * is held to the set this SDK names.
 */
export function string<T extends string = string>(): Shape<T> {
  return {
    unknownFields: noUnknownFields,
    decode: (value, path) => {
      if (typeof value !== "string") throw wrongType(path, "a string");
      return value as T;
    },
    encode: (value) => value,
    zero: () => "" as T,
    isZero: (value) => value === "",
    isEmpty: (value) => value === "",
  };
}

/** A JSON boolean. */
export function boolean(): Shape<boolean> {
  return {
    unknownFields: noUnknownFields,
    decode: (value, path) => {
      if (typeof value !== "boolean") throw wrongType(path, "a boolean");
      return value;
    },
    encode: (value) => value,
    zero: () => false,
    isZero: (value) => !value,
    isEmpty: (value) => !value,
  };
}

/** A number-valued integer; narrower Go widths are stated explicitly. */
export function integer(options: {
  readonly unsigned: boolean;
  readonly bits?: 8 | 16 | 32;
}): Shape<number>;
/** A full-width Go integral field, represented exactly as number or bigint. */
export function integer(options: {
  readonly unsigned: boolean;
  readonly bits: 64;
}): Shape<Integer>;
export function integer(options: {
  readonly unsigned: boolean;
  readonly bits?: 8 | 16 | 32 | 64;
}): Shape<number> | Shape<Integer> {
  const description = options.unsigned
    ? "a non-negative integer"
    : "an integer";
  const bits = options.bits;
  const minimum = options.unsigned
    ? 0n
    : bits === undefined
      ? BigInt(Number.MIN_SAFE_INTEGER)
      : -(1n << BigInt(bits - 1));
  const maximum =
    bits === undefined
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : (1n << BigInt(options.unsigned ? bits : bits - 1)) - 1n;
  function checked(
    value: unknown,
    path: string,
    mode?: DecodeMode,
    numberToken?: string,
  ): Integer {
    if (
      mode !== "lenient" &&
      numberToken !== undefined &&
      (!INTEGER_TOKEN.test(numberToken) ||
        (options.unsigned && numberToken.startsWith("-")))
    ) {
      throw wrongType(path, description);
    }
    if (!isIntegerValue(value)) {
      throw wrongType(path, description);
    }
    const exact = BigInt(value);
    if (exact < minimum || exact > maximum) throw wrongType(path, description);
    return numberOrBigInt(exact);
  }
  const shape: Shape<Integer> = {
    unknownFields: noUnknownFields,
    decode: checked,
    encode: (value) => checked(value, ""),
    zero: () => 0,
    isZero: (value) => value === 0 || value === 0n,
    isEmpty: (value) => value === 0 || value === 0n,
  };
  return shape;
}

/** A known Go float64 field; integral tokens are rounded to its IEEE-754 value. */
export function float64(): Shape<number> {
  function valueOf(value: unknown, path: string, mode?: DecodeMode): number {
    if (typeof value !== "number" && typeof value !== "bigint")
      throw wrongType(path, "a number");
    const valueAsNumber = Number(value);
    if (
      !Number.isFinite(valueAsNumber) &&
      (typeof value === "bigint" || mode !== "lenient")
    )
      throw wrongType(path, "a finite float64 value");
    return valueAsNumber;
  }
  const shape: Shape<number> = {
    unknownFields: noUnknownFields,
    decode: valueOf,
    encode: (value) => valueOf(value, ""),
    zero: () => 0,
    isZero: (value) => value === 0,
    isEmpty: (value) => value === 0,
  };
  FLOAT64_SHAPES.add(shape);
  return shape;
}

// Marks known float64 shapes and maps without changing plain public values
// or unknown integers.
const FLOAT64_SHAPES = new WeakSet();
const FLOAT64_MAPS = new WeakSet();

/** Narrows an exact integral value only when a number can carry every digit. */
export function numberOrBigInt(value: bigint): Integer {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

const uint64Shape = integer({ unsigned: true, bits: 64 });
const int64Shape = integer({ unsigned: false, bits: 64 });

function fitsInteger(value: unknown, shape: Shape<Integer>): value is Integer {
  try {
    shape.decode(value, "");
    return true;
  } catch (error) {
    if (error instanceof StrictDecodeError) return false;
    throw error;
  }
}

/** Whether a supplied operand fits the canonical unsigned 64-bit field. */
export function isUint64(value: unknown): value is Integer {
  return fitsInteger(value, uint64Shape);
}

/** Whether a supplied operand fits the canonical signed 64-bit field. */
export function isInt64(value: unknown): value is Integer {
  return fitsInteger(value, int64Shape);
}

/** The integral JSON value type, without imposing a field's wire width. */
export function isIntegerValue(value: unknown): value is Integer {
  return (
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isInteger(value))
  );
}

/** Numeric equality across the two exact integral representations. */
export function integerEqual(left: unknown, right: unknown): boolean {
  return isIntegerValue(left) && isIntegerValue(right)
    ? BigInt(left) === BigInt(right)
    : left === right;
}

/** The actual exact integer represented by a number or bigint operand. */
export function integerText(value: Integer): string {
  if (typeof value === "number" && !Number.isInteger(value))
    throw new TypeError("value must be an integer");
  return BigInt(value).toString();
}

/** How a scalar with its own spelling decodes and encodes. */
export interface ScalarCodec<T> {
  /**
   * Parses the wire spelling, throwing a `TypeError` that names what is
   * wrong with it. The message is carried into the decode error's message
   * and the `TypeError` into its cause.
   */
  readonly decode: (text: string) => T;
  /** Renders the canonical wire spelling. */
  readonly encode: (value: T) => string;
  readonly zero: () => T;
  readonly isZero: (value: T) => boolean;
  /**
   * Whether a JSON number is accepted as the spelling of itself, as the
   * reference contract reads `cpu: 1` as the string `1`.
   */
  readonly acceptsNumber?: boolean;
}

/**
 * A value that travels as a JSON string in a spelling of its own, such as a
 * quantity or a duration. The codec judges the spelling; a spelling it
 * refuses is an `invalid_value` rejection carrying the codec's error as its
 * cause.
 */
export function scalar<T>(codec: ScalarCodec<T>): Shape<T> {
  return {
    unknownFields: noUnknownFields,
    decode: (value, path) => {
      let text: string;
      if (typeof value === "string") {
        text = value;
      } else if (
        codec.acceptsNumber === true &&
        (typeof value === "bigint" ||
          (typeof value === "number" && Number.isFinite(value)))
      ) {
        text =
          typeof value === "bigint" || Number.isInteger(value)
            ? integerText(value)
            : String(value);
      } else {
        throw wrongType(path, "a string");
      }
      try {
        return codec.decode(text);
      } catch (error) {
        if (error instanceof TypeError) throw invalidValue(path, error);
        throw error;
      }
    },
    encode: (value) => codec.encode(value),
    zero: codec.zero,
    isZero: codec.isZero,
    isEmpty: codec.isZero,
  };
}

/**
 * A JSON object carried as it is, with no declared fields: the value of a
 * field whose contents belong to whoever wrote them, such as a document a
 * report embeds. Nothing under it is refused, and it is written back
 * verbatim.
 */
export function jsonObject(): Shape<JsonObject> {
  return {
    unknownFields: noUnknownFields,
    decode: (value, path) => {
      if (!isPlainObject(value)) throw wrongType(path, "an object");
      return value as JsonObject;
    },
    encode: (value) => value,
    zero: () => ({}),
    isZero: (value) => Object.keys(value).length === 0,
    isEmpty: (value) => Object.keys(value).length === 0,
  };
}

/**
 * Any JSON value carried as it arrived, for a field the reference contract declares as
 * raw JSON. Its zero value is `null`, which is also the one value an
 * `omitempty` field omits; a pointer field writes whatever it holds.
 */
export function jsonValue(): Shape<JsonValue> {
  return {
    unknownFields: noUnknownFields,
    decode: (value, path) => {
      if (value === undefined) throw wrongType(path, "a JSON value");
      return value as JsonValue;
    },
    encode: (value) => value,
    zero: () => null,
    isZero: (value) => value === null,
    isEmpty: (value) => value === null,
  };
}

/** A JSON array of one element shape. */
export function array<T>(element: Shape<T>): Shape<readonly T[]> {
  return {
    unknownFields: (value, path) => {
      if (!Array.isArray(value)) return;
      value.forEach((item: unknown, index) => {
        element.unknownFields(item, indexPath(path, index));
      });
    },
    decode: (value, path, mode) => {
      if (!Array.isArray(value)) {
        if (mode === "lenient") return value as readonly T[];
        throw wrongType(path, "an array");
      }
      return value.map((item: unknown, index) =>
        decodeChild(
          element,
          item,
          indexPath(path, index),
          mode,
          numberTokenAt(value, String(index)),
        ),
      );
    },
    encode: (value) => value.map((item) => element.encode(item)),
    zero: () => [],
    isZero: (value) => value.length === 0,
    isEmpty: (value) => value.length === 0,
  };
}

/**
 * A JSON object with arbitrary string keys and one value shape. Keys are
 * written in sorted order, as the reference contract writes a map.
 */
export function map<T>(value: Shape<T>): Shape<Readonly<Record<string, T>>> {
  return {
    unknownFields: (document, path) => {
      if (!isPlainObject(document)) return;
      for (const key of sortedKeys(document)) {
        value.unknownFields(document[key], fieldPath(path, key));
      }
    },
    decode: (document, path, mode) => {
      if (!isPlainObject(document)) {
        if (mode === "lenient") return document as Readonly<Record<string, T>>;
        throw wrongType(path, "an object");
      }
      const decoded: Record<string, T> = {};
      for (const key of Object.keys(document)) {
        Object.defineProperty(decoded, key, {
          value: decodeChild(
            value,
            document[key],
            fieldPath(path, key),
            mode,
            numberTokenAt(document, key),
          ),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      if (FLOAT64_SHAPES.has(value)) FLOAT64_MAPS.add(decoded);
      return decoded;
    },
    encode: (record) => {
      const encoded: Record<string, JsonValue> = {};
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item !== undefined)
          Object.defineProperty(encoded, key, {
            value: value.encode(item),
            writable: true,
            enumerable: true,
            configurable: true,
          });
      }
      if (FLOAT64_SHAPES.has(value)) FLOAT64_MAPS.add(encoded);
      return encoded;
    },
    zero: () => ({}),
    isZero: (record) => Object.keys(record).length === 0,
    isEmpty: (record) => Object.keys(record).length === 0,
  };
}

/**
 * A JSON object with declared fields. A field the document names that the
 * shape does not declare is refused by `unknownFields` and carried as it
 * arrived by a lenient decode; a `null` reads as absence, as it does in the
 * reference contract. Fields are written in declaration order.
 */
export function object<T extends object>(fields: ObjectFields<T>): Shape<T> {
  const entries = Object.entries<Field<unknown>>(fields);
  const declared = new Map(entries);
  return {
    unknownFields: (value, path) => {
      if (!isPlainObject(value)) return;
      for (const key of sortedKeys(value)) {
        const field = declared.get(key);
        if (field === undefined) {
          throw new StrictDecodeError({
            reason: "unknown_field",
            path: fieldPath(path, key),
            message: `unknown field ${JSON.stringify(fieldPath(path, key))}`,
          });
        }
        field.shape.unknownFields(value[key], fieldPath(path, key));
      }
    },
    decode: (value, path, mode) => {
      if (!isPlainObject(value)) {
        if (mode === "lenient" && path !== "") return value as T;
        throw path === ""
          ? new StrictDecodeError({
              reason: "wrong_type",
              path,
              message: "document must be an object",
            })
          : wrongType(path, "an object");
      }
      const decoded: Record<string, unknown> = {};
      for (const [key, field] of entries) {
        const raw = Object.hasOwn(value, key) ? value[key] : undefined;
        if (raw === null && field.null === "refuse" && mode !== "lenient") {
          throw new StrictDecodeError({
            reason: "invalid_value",
            path: fieldPath(path, key),
            message: `${fieldPath(path, key)} must not be null`,
          });
        }
        if (raw === null && field.null === "preserve") {
          decoded[key] = field.shape.decode(null, fieldPath(path, key), mode);
          continue;
        }
        if (raw === undefined || raw === null) {
          if (field.presence === "required" && mode !== "lenient") {
            throw new StrictDecodeError({
              reason: "missing_field",
              path: fieldPath(path, key),
              message: `missing field ${JSON.stringify(fieldPath(path, key))}`,
            });
          }
          if (field.presence !== "optional") decoded[key] = field.shape.zero();
          continue;
        }
        decoded[key] = decodeChild(
          field.shape,
          raw,
          fieldPath(path, key),
          mode,
          numberTokenAt(value, key),
        );
      }
      if (mode === "lenient") {
        for (const key of Object.keys(value)) {
          if (!declared.has(key))
            Object.defineProperty(decoded, key, {
              value: value[key],
              writable: true,
              enumerable: true,
              configurable: true,
            });
        }
      }
      return decoded as T;
    },
    encode: (value) => {
      const record = value as Readonly<Record<string, unknown>>;
      const encoded: Record<string, JsonValue> = {};
      for (const [key, field] of entries) {
        const item = record[key];
        if (item === undefined) {
          if (field.omit === "never") {
            encoded[key] = field.shape.encode(field.shape.zero());
          }
          continue;
        }
        if (field.omit === "empty" && field.shape.isEmpty(item)) continue;
        if (field.omit === "zero" && field.shape.isZero(item)) continue;
        encoded[key] = field.shape.encode(item);
      }
      return encoded;
    },
    zero: () => {
      const zero: Record<string, unknown> = {};
      for (const [key, field] of entries) {
        if (field.presence !== "optional") zero[key] = field.shape.zero();
      }
      return zero as T;
    },
    isZero: (value) => {
      const record = value as Readonly<Record<string, unknown>>;
      return entries.every(([key, field]) => {
        const item = record[key];
        return item === undefined || field.shape.isZero(item);
      });
    },
    isEmpty: () => false,
  };
}

/**
 * The half of a shape that reads: what a document router holds for each
 * kind it can decode. A shape of one kind is a decoder of any union that
 * includes the kind, which is what lets one table route to every kind's
 * shape without pretending they share an encoder.
 */
export type Decoder<T> = Pick<Shape<T>, "unknownFields" | "decode">;

/**
 * Decodes JSON text as one document: well-formed, no duplicate object keys
 * anywhere, no trailing content, and no field the shape does not declare.
 */
export function decodeText<T>(text: string, shape: Decoder<T>): T {
  const parsed = new Scanner(text, "strict").readDocument();
  shape.unknownFields(parsed.value, "");
  return shape.decode(parsed.value, "", "strict", parsed.numberToken);
}

/**
 * Decodes a value a caller already parsed. Duplicate keys cannot be detected
 * in a parsed value, because parsing already kept one of them; a caller that
 * holds the text uses {@link decodeText}.
 *
 * `mode` defaults to strict. A lenient decode skips the unknown-field walk
 * and carries what the shape does not declare or cannot read; the document
 * itself must still be an object.
 */
export function decodeValue<T>(
  value: unknown,
  shape: Decoder<T>,
  mode: DecodeMode = "strict",
): T {
  if (mode !== "lenient") shape.unknownFields(value, "");
  return shape.decode(value, "", mode);
}

/**
 * Decodes one child value. In lenient mode a value the child shape refuses
 * is carried as it arrived, so one unreadable field never discards the
 * document around it.
 */
function decodeChild<T>(
  shape: Shape<T>,
  raw: unknown,
  path: string,
  mode: DecodeMode | undefined,
  numberToken?: string,
): T {
  if (mode !== "lenient") return shape.decode(raw, path, mode, numberToken);
  try {
    return shape.decode(raw, path, mode, numberToken);
  } catch (error) {
    if (error instanceof StrictDecodeError) return raw as T;
    throw error;
  }
}

/**
 * Parses exactly one JSON value from its original text. Strict submissions
 * refuse duplicate keys by path; lenient observations keep the last value.
 * Both modes refuse malformed syntax and content after the value.
 */
export function parseText(
  text: string,
  mode: DecodeMode = "strict",
): JsonValue {
  return new Scanner(text, mode).readDocument().value;
}

/**
 * The sole JSON reader. It checks the grammar and builds values from their
 * original tokens, so integral digits never pass through a rounded number.
 * Objects and arrays use an explicit stack, as does the nesting check.
 */
class Scanner {
  private index = 0;
  private scalarNumberToken: string | undefined;

  constructor(
    private readonly text: string,
    private readonly mode: DecodeMode,
  ) {}

  readDocument(): { readonly value: JsonValue; readonly numberToken?: string } {
    this.skipWhitespace();
    if (this.index >= this.text.length) {
      throw this.invalid("unexpected end of input");
    }
    const parsed = this.scanValue("");
    this.skipWhitespace();
    if (this.index < this.text.length) {
      if (startsValue(this.text[this.index] ?? "")) {
        throw new StrictDecodeError({
          reason: "trailing_content",
          path: "",
          message: "multiple JSON values are not allowed",
        });
      }
      throw this.invalid(
        `unexpected character ${JSON.stringify(this.text[this.index] ?? "")}`,
      );
    }
    return parsed;
  }

  private scanValue(path: string): {
    readonly value: JsonValue;
    readonly numberToken?: string;
  } {
    const open: Frame[] = [];
    let root: JsonValue = null;
    let rootNumberToken: string | undefined;
    const append = (value: JsonValue, numberToken?: string): void => {
      const parent = open[open.length - 1];
      if (parent === undefined) {
        root = value;
        rootNumberToken = numberToken;
      } else if (parent.kind === "object") {
        Object.defineProperty(parent.value, parent.key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        rememberNumberToken(parent.value, parent.key, value, numberToken);
      } else {
        parent.value.push(value);
        rememberNumberToken(
          parent.value,
          String(parent.index),
          value,
          numberToken,
        );
      }
    };
    for (;;) {
      this.skipWhitespace();
      const character = this.text[this.index];
      if (character === "{" || character === "[") {
        if (open.length >= MAX_NESTING_DEPTH) {
          throw this.invalid("exceeded max depth");
        }
        this.index += 1;
        this.skipWhitespace();
        const value = character === "{" ? {} : [];
        append(value);
        const close = character === "{" ? "}" : "]";
        if (this.text[this.index] === close) {
          this.index += 1;
        } else if (character === "{") {
          const frame: ObjectFrame = {
            kind: "object",
            path,
            seen: new Set(),
            value,
            key: "",
          };
          open.push(frame);
          path = this.scanKey(frame);
          continue;
        } else {
          open.push({
            kind: "array",
            path,
            index: 0,
            value: value as JsonValue[],
          });
          path = indexPath(path, 0);
          continue;
        }
      } else {
        this.scalarNumberToken = undefined;
        const value = this.scanScalar(character);
        append(value, this.scalarNumberToken);
      }
      for (;;) {
        const frame = open[open.length - 1];
        if (frame === undefined) {
          return rootNumberToken === undefined
            ? { value: root }
            : { value: root, numberToken: rootNumberToken };
        }
        this.skipWhitespace();
        if (this.text[this.index] === ",") {
          this.index += 1;
          if (frame.kind === "object") {
            path = this.scanKey(frame);
          } else {
            frame.index += 1;
            path = indexPath(frame.path, frame.index);
          }
          break;
        }
        this.expect(frame.kind === "object" ? "}" : "]");
        open.pop();
      }
    }
  }

  private scanKey(frame: ObjectFrame): string {
    this.skipWhitespace();
    if (this.text[this.index] !== '"') {
      throw this.invalid("expected an object key");
    }
    const key = this.scanString();
    if (this.mode !== "lenient" && frame.seen.has(key)) {
      throw new StrictDecodeError({
        reason: "duplicate_field",
        path: fieldPath(frame.path, key),
        message: `duplicate field ${JSON.stringify(fieldPath(frame.path, key))}`,
      });
    }
    frame.seen.add(key);
    frame.key = key;
    this.skipWhitespace();
    this.expect(":");
    return fieldPath(frame.path, key);
  }

  private scanScalar(character: string | undefined): JsonValue {
    switch (character) {
      case '"':
        return this.scanString();
      case "t":
        this.scanLiteral("true");
        return true;
      case "f":
        this.scanLiteral("false");
        return false;
      case "n":
        this.scanLiteral("null");
        return null;
      case undefined:
        throw this.invalid("unexpected end of input");
      default:
        if (character === "-" || isDigit(character)) return this.scanNumber();
        throw this.invalid(`unexpected character ${JSON.stringify(character)}`);
    }
  }

  private scanString(): string {
    this.index += 1;
    let value = "";
    for (;;) {
      const character = this.text[this.index];
      if (character === undefined) throw this.invalid("unterminated string");
      if (character === '"') {
        this.index += 1;
        return value;
      }
      if (character === "\\") {
        value += this.scanEscape();
        continue;
      }
      if (character < " ") throw this.invalid("control character in string");
      value += character;
      this.index += 1;
    }
  }

  private scanEscape(): string {
    const escaped = this.text[this.index + 1];
    this.index += 2;
    switch (escaped) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const digits = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/u.test(digits))
          throw this.invalid("invalid unicode escape");
        this.index += 4;
        return String.fromCharCode(Number.parseInt(digits, 16));
      }
      default:
        throw this.invalid("invalid escape sequence");
    }
  }

  private scanNumber(): number | bigint {
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (match === null) throw this.invalid("invalid number");
    const token = match[0];
    this.index += token.length;
    this.scalarNumberToken = token;
    if (INTEGER_TOKEN.test(token)) {
      const exact = BigInt(token);
      if (exact !== 0n) return numberOrBigInt(exact);
    }
    return Number(token);
  }

  private scanLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.index)) {
      throw this.invalid(
        `unexpected character ${JSON.stringify(this.text[this.index] ?? "")}`,
      );
    }
    this.index += literal.length;
  }

  private expect(character: string): void {
    if (this.text[this.index] !== character) {
      throw this.invalid(
        this.index >= this.text.length
          ? "unexpected end of input"
          : `expected ${JSON.stringify(character)}`,
      );
    }
    this.index += 1;
  }

  private skipWhitespace(): void {
    for (;;) {
      const character = this.text[this.index];
      if (
        character === " " ||
        character === "\n" ||
        character === "\r" ||
        character === "\t"
      ) {
        this.index += 1;
        continue;
      }
      return;
    }
  }

  private invalid(detail: string): StrictDecodeError {
    return new StrictDecodeError({
      reason: "invalid_json",
      path: "",
      message: `invalid JSON at offset ${String(this.index)}: ${detail}`,
    });
  }
}

/** Original number syntax belongs to the reader, never to a public wrapper. */
const numberTokens = new WeakMap<
  object,
  Map<
    string,
    {
      readonly value: JsonValue;
      readonly token: string;
    }
  >
>();

function rememberNumberToken(
  container: object,
  key: string,
  value: JsonValue,
  token?: string,
): void {
  if (token === undefined) {
    numberTokens.get(container)?.delete(key);
    return;
  }
  let tokens = numberTokens.get(container);
  if (tokens === undefined) {
    tokens = new Map();
    numberTokens.set(container, tokens);
  }
  tokens.set(key, { value, token });
}

function numberTokenAt(container: object, key: string): string | undefined {
  const source = numberTokens.get(container)?.get(key);
  const value = (container as Readonly<Record<string, unknown>>)[key];
  return source !== undefined && Object.is(source.value, value)
    ? source.token
    : undefined;
}

/**
 * Writes exact integral JSON values and the shortest spelling of known
 * float64 fields. The explicit stack also permits deeply nested values.
 */
export function renderValue(value: JsonValue, space?: number | string): string {
  const gap =
    typeof space === "number"
      ? " ".repeat(Math.max(0, Math.min(10, Math.trunc(space))))
      : (space?.slice(0, 10) ?? "");
  const parts: string[] = [];
  const active = new WeakSet();
  type Part =
    | { readonly text: string }
    | {
        readonly value: JsonValue;
        readonly depth: number;
        readonly float64?: boolean;
      }
    | { readonly leave: object };
  const pending: Part[] = [{ value, depth: 0 }];
  for (;;) {
    const part = pending.pop();
    if (part === undefined) return parts.join("");
    if ("text" in part) {
      parts.push(part.text);
      continue;
    }
    if ("leave" in part) {
      active.delete(part.leave);
      continue;
    }
    const item = part.value;
    if (
      part.float64 === true &&
      (typeof item === "number" || typeof item === "bigint")
    ) {
      const float = Number(item);
      if (!Number.isFinite(float))
        throw new TypeError("float64 value cannot be written as JSON");
      parts.push(Object.is(float, -0) ? "-0" : JSON.stringify(float));
      continue;
    }
    if (typeof item === "bigint") {
      parts.push(integerText(item));
      continue;
    }
    if (typeof item === "number") {
      parts.push(
        Number.isInteger(item) ? integerText(item) : JSON.stringify(item),
      );
      continue;
    }
    if (
      typeof item === "string" ||
      typeof item === "boolean" ||
      item === null
    ) {
      parts.push(JSON.stringify(item));
      continue;
    }
    if (typeof item !== "object")
      throw new TypeError("value cannot be written as JSON");
    if (active.has(item))
      throw new TypeError("circular value cannot be written as JSON");
    active.add(item);
    const array = Array.isArray(item);
    const entries = array
      ? Array.from(
          item,
          (entry: JsonValue, index: number) =>
            [String(index), entry ?? null] as const,
        )
      : Object.entries<JsonValue | undefined>(item).filter(
          (entry): entry is [string, JsonValue] => entry[1] !== undefined,
        );
    const indent = gap.repeat(part.depth);
    const childIndent = gap.repeat(part.depth + 1);
    const newline = gap === "" ? "" : "\n";
    parts.push(array ? "[" : "{");
    pending.push({ leave: item });
    pending.push({
      text:
        entries.length === 0
          ? array
            ? "]"
            : "}"
          : `${newline}${indent}${array ? "]" : "}"}`,
    });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      pending.push({
        value: entry[1],
        depth: part.depth + 1,
        ...(FLOAT64_MAPS.has(item) ? { float64: true } : {}),
      });
      if (!array)
        pending.push({
          text: `${JSON.stringify(entry[0])}:${gap === "" ? "" : " "}`,
        });
      pending.push({
        text: `${index === 0 ? "" : ","}${newline}${childIndent}`,
      });
    }
  }
}

/** An object the scanner has opened and not yet closed. */
interface ObjectFrame {
  readonly kind: "object";
  readonly path: string;
  readonly seen: Set<string>;
  readonly value: Record<string, JsonValue>;
  key: string;
}

/** An array the scanner has opened and not yet closed. */
interface ArrayFrame {
  readonly kind: "array";
  readonly path: string;
  index: number;
  readonly value: JsonValue[];
}

type Frame = ObjectFrame | ArrayFrame;

/** The plain integral syntax accepted by Go integer submission fields. */
const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/u;

/** The JSON number grammar, matched in place from the scanner's position. */
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;

/**
 * The deepest nesting of objects and arrays a document may carry, the same
 * bound the reference contract's decoder applies.
 */
const MAX_NESTING_DEPTH = 10_000;

function startsValue(character: string): boolean {
  return (
    character === "{" ||
    character === "[" ||
    character === '"' ||
    character === "-" ||
    character === "t" ||
    character === "f" ||
    character === "n" ||
    isDigit(character)
  );
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function noUnknownFields(): void {
  // A scalar declares no fields, so there is nothing under it to refuse.
}

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedKeys(value: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(value).sort();
}

function wrongType(path: string, expected: string): StrictDecodeError {
  return new StrictDecodeError({
    reason: "wrong_type",
    path,
    message: `field ${JSON.stringify(path)} must be ${expected}`,
  });
}

function invalidValue(path: string, cause: TypeError): StrictDecodeError {
  return new StrictDecodeError({
    reason: "invalid_value",
    path,
    message: `invalid field ${JSON.stringify(path)}: ${cause.message}`,
    cause,
  });
}

/** Joins a field onto a path the way the reference contract does: `spec.template`. */
export function fieldPath(path: string, field: string): string {
  return path === "" ? field : `${path}.${field}`;
}

/** Joins an index onto a path the way the reference contract does: `containers[0]`. */
export function indexPath(path: string, index: number): string {
  return `${path}[${String(index)}]`;
}
