// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  accountListQuery,
  listQuery,
  namespaceListQuery,
} from "../src/internal/listquery.js";
import { subnetSlug } from "./fakes/fetch-queue.js";

describe("list query encoding", () => {
  // Contract: nothing set sends nothing; each option is sent under its wire
  // name only when set; keys are sorted.
  it("sends each option under its wire name only when set", () => {
    expect(listQuery({})).toBe("");
    expect(listQuery({ limit: 10 })).toBe("?limit=10");
    expect(listQuery({ offset: 20 })).toBe("?offset=20");
    expect(listQuery({ filter: "phase=ready", sort: "name" })).toBe(
      "?filter=phase%3Dready&sort=name",
    );
    expect(
      listQuery({
        sort: "name",
        offset: 5,
        limit: 2,
        filter: "a b",
      }),
    ).toBe(`?filter=a+b&limit=2&offset=5&sort=name`);
  });

  // Contract: an explicit zero offset is a value and is sent; an empty
  // string says nothing about its dimension.
  it("distinguishes zero from unset and empty from unset", () => {
    expect(listQuery({ offset: 0 })).toBe("?offset=0");
    expect(listQuery({ filter: "", sort: "" })).toBe("");
  });

  // Contract: a limit is a positive safe integer and an offset a
  // non-negative safe integer; anything else is a TypeError naming the
  // option, and a present value is never silently dropped.
  it("refuses a limit that is not positive or an offset that is negative", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, 18446744073709551616n]) {
      expect(() => listQuery({ limit })).toThrow(
        new TypeError("list limit must be a positive integer"),
      );
    }
    for (const offset of [-1, 1.5, Number.NaN, 18446744073709551616n]) {
      expect(() => listQuery({ offset })).toThrow(
        new TypeError("list offset must be a non-negative integer"),
      );
    }
  });

  // Contract: a Namespace-scoped route always states the place it
  // addresses.
  it("always states the subnet on a namespace-scoped route", () => {
    expect(namespaceListQuery({}, subnetSlug)).toBe(`?subnet=${subnetSlug}`);
    expect(namespaceListQuery({ limit: 1 }, subnetSlug)).toBe(
      `?limit=1&subnet=${subnetSlug}`,
    );
  });

  // Contract: an account-wide route addresses its place in the path and
  // never repeats it.
  it("omits the subnet on an account-wide route", () => {
    expect(accountListQuery({})).toBe("");
    expect(accountListQuery({ offset: 3 })).toBe("?offset=3");
  });
});
