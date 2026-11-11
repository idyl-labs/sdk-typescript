// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { json } from "./fakes/control-plane.js";
import { FakeNetwork, computerRecord, computersPath } from "./fakes/network.js";
import { FakeWorkspace, type SavedFile } from "./fakes/workspace.js";

const quickstart = readFileSync(
  new URL("../examples/quickstart.ts", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const byId = `${computersPath}/by-id/${String(computerRecord()["id"])}`;

describe("the quickstart", () => {
  // Contract: the README carries the quickstart program exactly as the
  // compiled example file has it.
  it("is the README's quickstart", () => {
    const program = quickstart.split("\n").slice(2).join("\n");
    expect(readme).toContain("```ts\n" + program + "```");
  });

  // Contract: the quickstart's calls do what its comments say: a restore
  // of the first upload's version brings back the file as it was then.
  it("runs against a Computer", async () => {
    const workspace = new FakeWorkspace(byId);
    // The files of every published version, as the workspace held them.
    const versions = new Map<number, Map<string, SavedFile>>();
    const network = new FakeNetwork(async (request, body) => {
      const { pathname } = request.url;
      const method = request.init.method ?? "GET";
      if (pathname === computersPath && method === "POST") {
        return json(
          {
            computer: computerRecord({ name: (body as { name: string }).name }),
          },
          201,
        );
      }
      if (pathname === byId && method === "DELETE") {
        return json({ accepted: true }, 202);
      }
      if (pathname === `${byId}/restores` && method === "POST") {
        const { from } = body as { from: string };
        workspace.files = new Map(versions.get(Number(from)));
        workspace.version += 1;
        versions.set(workspace.version, new Map(workspace.files));
        return json({
          id: "01954e20-7540-7ec4-93ec-14f783e6ab72",
          state: "published",
          version: workspace.version,
        });
      }
      const answered = await workspace.route(request, body);
      versions.set(workspace.version, new Map(workspace.files));
      return answered;
    });
    const idyl = network.client();
    const printed: string[] = [];

    // The quickstart, with `console.log` collected.
    const computer = await idyl.computers.create({
      name: "quickstart",
      image: "ubuntu-24.04",
    });
    const first = await computer.files.upload("version.txt", "v1\n");
    await computer.files.upload("version.txt", "v2\n");
    await computer.restore(first.version);
    const version = await computer.files.download("version.txt");
    printed.push(await version.text());
    await computer.delete();

    expect(printed).toEqual(["v1\n"]);
    expect(network.computerCalls()).toContain(`POST ${byId}/restores`);
    expect(network.computerCalls().at(-1)).toBe(`DELETE ${byId}`);
  });
});
