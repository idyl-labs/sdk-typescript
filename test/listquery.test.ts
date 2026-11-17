// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { listQuery, computerListQuery } from "../src/internal/listquery.js";
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

  // Contract: a Computer list sends its page size and position, never an
  // offset; a Namespace-scoped route always states the place it addresses.
  it("encodes a Computer list on a namespace-scoped route", () => {
    expect(computerListQuery({}, subnetSlug)).toBe(`?subnet=${subnetSlug}`);
    expect(
      computerListQuery(
        { limit: 100, continue: "a/b+c", filter: "all" },
        subnetSlug,
      ),
    ).toBe(`?continue=a%2Fb%2Bc&filter=all&limit=100&subnet=${subnetSlug}`);
    expect(() => computerListQuery({ limit: -1 })).toThrow(
      new TypeError("list limit must be a non-negative integer"),
    );
  });

  // Contract: an account-wide route addresses its place in the path and
  // never repeats it.
  it("omits the subnet on an account-wide route", () => {
    expect(computerListQuery({})).toBe("");
    expect(computerListQuery({ continue: "p" })).toBe("?continue=p");
  });
});
