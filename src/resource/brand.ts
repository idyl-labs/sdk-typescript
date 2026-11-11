// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/** The compile-time brand. It has no runtime value and is never assigned. */
declare const brand: unique symbol;

/**
 * A string that belongs to one identifier family.
 *
 * The brand exists at compile time only: a branded value is a plain string at
 * runtime and is the wire form of the identifier. A value acquires the brand
 * through the family's `parse*` function or `is*` guard, which never admit
 * the empty string, or by being read off the wire, where a manifest field the
 * platform has not filled carries the empty string as its unset zero value;
 * a field's own documentation says when it can.
 */
export type Branded<Family extends string> = string & {
  readonly [brand]: Family;
};
