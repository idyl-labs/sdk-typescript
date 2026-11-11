// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { json } from "./fakes/control-plane.js";
import { FakeNetwork, computerRecord } from "./fakes/network.js";

describe("Computer usage", () => {
  // Contract: a read hands on how many files, folders and links the newest
  // saved version holds once a save has counted them, and nothing before.
  it("hands on the names the newest save holds", async () => {
    const counted = {
      ...computerRecord(),
      usage: {
        referencedBytes: 4096,
        logicalBytes: 4096,
        storedBytes: 0,
        names: 31250,
      },
    };
    const uncounted = {
      ...computerRecord({ name: "older" }),
      usage: { referencedBytes: 4096, logicalBytes: 4096, storedBytes: 0 },
    };
    const network = new FakeNetwork((request) => {
      if (request.method !== "GET") return undefined;
      if (request.url.pathname.endsWith("/api-dev"))
        return json({ computer: counted });
      if (request.url.pathname.endsWith("/older"))
        return json({ computer: uncounted });
      return undefined;
    });
    const client = network.client();
    expect((await client.computers.get("api-dev")).snapshot.usage).toEqual({
      logicalBytes: 4096,
      storedBytes: 0,
      names: 31250,
    });
    expect((await client.computers.get("older")).snapshot.usage).toEqual({
      logicalBytes: 4096,
      storedBytes: 0,
    });
  });
});
