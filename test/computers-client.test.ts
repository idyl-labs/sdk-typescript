// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  Computer,
  ERROR_CODE_FORK_NOT_QUIESCENT,
  Idyl,
  SAVE_REASON_ACCOUNT_STORAGE_LIMIT,
  SAVE_REASON_COMPUTER_SIZE,
  SAVE_REASON_NAME_LIMIT,
  TransportError,
  forkNotQuiescent,
  isApiCode,
} from "../src/index.js";
import { errorResponse, json } from "./fakes/control-plane.js";
import {
  decodeListComputerSizesResponse,
  encodeListComputerSizesResponse,
  validateComputerSizeInfo,
  validateListComputerSizesResponse,
} from "../src/api/computer-size.js";
import {
  FakeNetwork,
  computerRecord,
  computersPath,
  endpoints,
} from "./fakes/network.js";

const ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const byId = `${computersPath}/by-id/${ID}`;
const OPERATION = "01954e20-7540-7ec4-93ec-14f783e6ab41";
const ENTRY = "01954e20-7540-7ec4-93ec-14f783e6ab13";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

describe("idyl.computers.create", () => {
  // Contract: a create states the settings in the contract's spellings and
  // returns a handle on the served Computer.
  it("creates a Computer with its settings", async () => {
    let sent: unknown;
    const network = new FakeNetwork((request, body) => {
      if (request.method === "POST" && request.url.pathname === computersPath) {
        sent = body;
        return json({ computer: computerRecord() }, 201);
      }
      return undefined;
    });
    const computer = await network.client().computers.create({
      name: "api-dev",
      image: "ubuntu-24.04",
      cpu: "2",
      memory: "4Gi",
      network: "internet",
      env: { NODE_ENV: "development" },
      idleTimeout: "10m",
      autoSave: false,
      idempotencyKey: "create-1",
    });
    expect(computer).toBeInstanceOf(Computer);
    expect(computer.id).toBe(ID);
    expect(computer.name).toBe("api-dev");
    expect(sent).toEqual({
      name: "api-dev",
      subnet: "550000000002",
      spec: {
        idleTimeout: "600s",
        autoSave: false,
        execution: {
          image: { idyl: "ubuntu-24.04" },
          cpu: "2",
          memory: "4Gi",
          network: { class: "internet" },
          variables: [{ name: "NODE_ENV", value: "development" }],
        },
      },
      idempotencyKey: "create-1",
      client: "sdk",
    });
  });

  // Contract: `workspaceOnly: true` asks for a Computer that saves only
  // /workspace; `false` and absence write nothing, so the Computer saves its
  // whole system. A value that is not a boolean is refused before a request.
  it("asks for a Computer that saves only /workspace", async () => {
    const bodies: unknown[] = [];
    const network = new FakeNetwork((request, body) => {
      if (request.method === "POST" && request.url.pathname === computersPath) {
        bodies.push(body);
        return json({ computer: computerRecord() }, 201);
      }
      return undefined;
    });
    const { computers } = network.client();
    await computers.create({ name: "api-dev", workspaceOnly: true });
    await computers.create({ name: "api-dev", workspaceOnly: false });
    expect(bodies).toEqual([
      {
        name: "api-dev",
        subnet: "550000000002",
        workspaceOnly: true,
        client: "sdk",
      },
      { name: "api-dev", subnet: "550000000002", client: "sdk" },
    ]);
    await expect(
      computers.create({
        name: "api-dev",
        workspaceOnly: "yes" as unknown as boolean,
      }),
    ).rejects.toThrow("workspaceOnly must be a boolean");
    expect(bodies).toHaveLength(2);
  });

  // Contract: a size is sent by the name stated, with no CPU or memory beside
  // it, and only its form is judged before a request.
  it("creates and updates a Computer by size name", async () => {
    const bodies: unknown[] = [];
    const network = new FakeNetwork((request, body) => {
      if (request.method === "POST" && request.url.pathname === computersPath) {
        bodies.push(body);
        return json({ computer: computerRecord() }, 201);
      }
      if (request.method === "PATCH") {
        bodies.push(body);
        return json({ computer: computerRecord() });
      }
      return undefined;
    });
    const { computers } = network.client();
    const computer = await computers.create({
      name: "api-dev",
      size: "extra-large",
    });
    await computer.update({ size: "small" });
    expect(bodies).toEqual([
      {
        name: "api-dev",
        subnet: "550000000002",
        spec: { execution: { size: "extra-large" } },
        client: "sdk",
      },
      { size: "small", client: "sdk" },
    ]);
    await expect(
      computers.create({ name: "api-dev", size: "Small" }),
    ).rejects.toThrow(/must be 1 to 32 lowercase letters/u);
    await expect(
      computers.create({ name: "api-dev", size: "small", cpu: "2" }),
    ).rejects.toThrow("must not be stated with cpu or memory");
    await expect(
      computer.update({ size: "small", memory: null }),
    ).rejects.toThrow("must not be stated with cpu or memory");
    expect(bodies).toHaveLength(2);
  });

  // Contract: the sizes are read from the metadata endpoint with no credential
  // and no Account, in the platform's order, as the platform names them; the
  // package holds no list of its own.
  it("lists the sizes with no credential", async () => {
    const requests: Request[] = [];
    const client = new Idyl({
      endpoints,
      fetch: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(
          json({
            items: [
              {
                name: "tiny",
                label: "Tiny",
                cpu: "1",
                memory: "2Gi",
                disk: "10Gi",
                default: true,
                laterField: true,
              },
              {
                name: "extra-large",
                label: "Extra large",
                cpu: "16",
                memory: "32Gi",
                disk: "160Gi",
                names: 16_000_000,
                default: false,
              },
            ],
          }),
        );
      },
    });
    const sizes = await client.computers.sizes();
    expect(sizes).toEqual([
      {
        name: "tiny",
        label: "Tiny",
        cpu: "1",
        memory: "2Gi",
        disk: "10Gi",
        default: true,
      },
      {
        name: "extra-large",
        label: "Extra large",
        cpu: "16",
        memory: "32Gi",
        disk: "160Gi",
        names: 16_000_000,
        default: false,
      },
    ]);
    expect(sizes[0]).not.toHaveProperty("names");
    expect(Object.isFrozen(sizes)).toBe(true);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(new URL(request?.url ?? "").href).toBe(
      `${endpoints.meta}/v1/computer-sizes`,
    );
    expect(request?.method).toBe("GET");
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("dpop")).toBeNull();
  });

  // Contract: a size's name limit is optional on the wire. A size that states
  // none validates and writes none back, one that states it carries it, and
  // a negative limit is refused.
  it("judges a size's name limit", () => {
    const bare = {
      name: "xs",
      label: "XS",
      cpu: "1",
      memory: "2Gi",
      disk: "10Gi",
      default: true,
    };
    const read = decodeListComputerSizesResponse({
      items: [
        bare,
        { ...bare, name: "small", names: 2_000_000, default: false },
      ],
    });
    expect(() => {
      validateListComputerSizesResponse(read);
    }).not.toThrow();
    expect(read.items.map((size) => size.names)).toEqual([
      undefined,
      2_000_000,
    ]);
    expect(encodeListComputerSizesResponse(read)["items"]).toEqual([
      bare,
      { ...bare, name: "small", names: 2_000_000, default: false },
    ]);
    const [first] = read.items;
    expect(() => {
      if (first !== undefined)
        validateComputerSizeInfo({ ...first, names: -1 });
    }).toThrow(new TypeError("names must not be negative"));
  });

  // Contract: an invalid setting is refused by field before any request.
  it("refuses an invalid setting before any request", async () => {
    const network = new FakeNetwork();
    const { computers } = network.client();
    await expect(
      computers.create({ name: "api-dev", cpu: "two" }),
    ).rejects.toThrow(/^cpu: /u);
    await expect(
      computers.create({ name: "api-dev", memory: "4 GB" }),
    ).rejects.toThrow(/^memory: /u);
    await expect(
      computers.create({ name: "api-dev", idleTimeout: "soon" }),
    ).rejects.toThrow(/^idleTimeout: /u);
    await expect(computers.create({ name: " " })).rejects.toThrow(
      "computer name is required",
    );
    expect(network.computerCalls()).toEqual([]);
  });
});

describe("the client a change records", () => {
  // Contract: a create and an update state the kind of client making them,
  // `sdk` unless the caller names another, and the history records it; a
  // client this SDK does not name is refused before any request.
  it("states the client on create and update", async () => {
    const sent: unknown[] = [];
    const network = new FakeNetwork((request, body) => {
      if (request.method === "POST" && request.url.pathname === computersPath) {
        sent.push(body);
        return json({ computer: computerRecord() }, 201);
      }
      if (request.method === "PATCH" && request.url.pathname === byId) {
        sent.push(body);
        return json({ computer: computerRecord() });
      }
      return undefined;
    });
    const { computers } = network.client();
    const computer = await computers.create({
      name: "api-dev",
      client: "console",
    });
    await computer.update({ shell: "/bin/sh", client: "console" });
    await computer.update({ idleTimeout: "never", client: "cli" });
    expect(sent).toEqual([
      { name: "api-dev", subnet: "550000000002", client: "console" },
      { shell: "/bin/sh", client: "console" },
      { idleTimeout: "never", client: "cli" },
    ]);
    const unknown = "unknown" as "sdk";
    await expect(
      computers.create({ name: "api-dev", client: unknown }),
    ).rejects.toThrow('client must be "sdk", "console" or "cli"');
    await expect(
      computer.update({ shell: "/bin/sh", client: unknown }),
    ).rejects.toThrow('client must be "sdk", "console" or "cli"');
    await expect(computer.update({ client: "console" })).rejects.toThrow(
      "update states no field",
    );
    expect(sent).toHaveLength(3);
  });
});

describe("own images and allowed destinations", () => {
  // Contract: an image with `/`, `:` or `@` is the caller's own image
  // reference; any other image is a catalogue name.
  it("states an own image as a reference", async () => {
    const sent: unknown[] = [];
    const network = new FakeNetwork((request, body) => {
      if (request.method === "POST" && request.url.pathname === computersPath) {
        sent.push(body);
        return json({ computer: computerRecord() }, 201);
      }
      return undefined;
    });
    const { computers } = network.client();
    for (const image of [
      "ghcr.io/example/toolbox:1.4",
      "python:3.12",
      "registry.example.com/team/image@sha256:" + "a".repeat(64),
    ]) {
      await computers.create({ name: "api-dev", image });
    }
    await computers.create({ name: "api-dev", image: "debian-12" });
    expect(
      sent.map(
        (body) => (body as { spec: { execution: unknown } }).spec.execution,
      ),
    ).toEqual([
      { image: { ref: "ghcr.io/example/toolbox:1.4" } },
      { image: { ref: "python:3.12" } },
      {
        image: {
          ref: "registry.example.com/team/image@sha256:" + "a".repeat(64),
        },
      },
      { image: { idyl: "debian-12" } },
    ]);
    await expect(
      computers.create({
        name: "api-dev",
        image: "ghcr.io/example/tool box:1",
      }),
    ).rejects.toThrow(TypeError);
  });

  // Contract: a restricted-egress network states what it allows; local
  // networks stay denied while it does.
  it("creates and updates a restricted-egress network with its allow list", async () => {
    const sent: unknown[] = [];
    const network = new FakeNetwork((request, body) => {
      if (request.method === "POST" && request.url.pathname === computersPath) {
        sent.push(body);
        return json({ computer: computerRecord() }, 201);
      }
      if (request.method === "PATCH" && request.url.pathname === byId) {
        sent.push(body);
        return json({ computer: computerRecord() });
      }
      return undefined;
    });
    const computer = await network.client().computers.create({
      name: "api-dev",
      network: "restricted-egress",
      allow: ["dns", "tcp:443:pypi.org"],
    });
    await computer.update({
      network: "restricted-egress",
      allow: ["dns", "tcp:443:registry.npmjs.org"],
    });
    await computer.update({ network: "restricted-egress", allow: [] });
    expect(sent).toEqual([
      {
        name: "api-dev",
        subnet: "550000000002",
        spec: {
          execution: {
            network: {
              class: "restricted-egress",
              egress: {
                allow: ["dns", "tcp:443:pypi.org"],
                denyLocalNetworks: true,
              },
            },
          },
        },
        client: "sdk",
      },
      {
        network: {
          class: "restricted-egress",
          egress: {
            allow: ["dns", "tcp:443:registry.npmjs.org"],
            denyLocalNetworks: true,
          },
        },
        client: "sdk",
      },
      { network: { class: "restricted-egress" }, client: "sdk" },
    ]);
  });

  // Contract: an allow list without its class, or with a malformed rule, is
  // refused by field before any request.
  it("refuses an allow list it cannot state", async () => {
    const network = new FakeNetwork();
    const { computers } = network.client();
    await expect(
      computers.create({ name: "api-dev", allow: ["dns"] }),
    ).rejects.toThrow(/^allow: /u);
    await expect(
      computers.create({
        name: "api-dev",
        network: "internet",
        allow: ["dns"],
      }),
    ).rejects.toThrow(/^allow: /u);
    await expect(
      computers.create({
        name: "api-dev",
        network: "restricted-egress",
        allow: ["tcp:443:192.0.2.10"],
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      computers.create({
        name: "api-dev",
        network: "restricted-egress",
        allow: ["icmp:1:example.com"],
      }),
    ).rejects.toThrow(TypeError);
    expect(network.computerCalls()).toEqual([]);
  });

  // Contract: the snapshot shows what a restricted-egress network allows.
  it("reads the allow list back", async () => {
    const network = new FakeNetwork(() =>
      json({
        computer: computerRecord({
          spec: {
            execution: {
              image: { ref: "ghcr.io/example/toolbox:1.4" },
              network: {
                class: "restricted-egress",
                egress: {
                  allow: ["dns", "tcp:443:pypi.org"],
                  denyLocalNetworks: true,
                },
              },
            },
          },
        }),
      }),
    );
    const computer = await network.client().computers.get("api-dev");
    expect(computer.snapshot.settings).toEqual({
      image: "ghcr.io/example/toolbox:1.4",
      network: "restricted-egress",
      allow: ["dns", "tcp:443:pypi.org"],
    });
    expect(Object.isFrozen(computer.snapshot.settings.allow)).toBe(true);
  });
});

describe("default shells", () => {
  // Contract: a create states the default shell as the settings' shell, an
  // update replaces it or, with null, returns it to the default rule, and
  // a shell that is not a clean absolute path is refused by field before
  // any request.
  it("creates and updates a Computer with its default shell", async () => {
    const sent: unknown[] = [];
    const network = new FakeNetwork((request, body) => {
      if (request.method === "POST" && request.url.pathname === computersPath) {
        sent.push(body);
        return json({ computer: computerRecord() }, 201);
      }
      if (request.method === "PATCH" && request.url.pathname === byId) {
        sent.push(body);
        return json({ computer: computerRecord() });
      }
      return undefined;
    });
    const { computers } = network.client();
    const computer = await computers.create({
      name: "api-dev",
      shell: "/usr/bin/zsh",
    });
    await computer.update({ shell: "/bin/bash" });
    await computer.update({ shell: null });
    expect(sent).toEqual([
      {
        name: "api-dev",
        subnet: "550000000002",
        spec: { execution: { shell: "/usr/bin/zsh" } },
        client: "sdk",
      },
      { shell: "/bin/bash", client: "sdk" },
      { shell: null, client: "sdk" },
    ]);
    await expect(
      computers.create({ name: "api-dev", shell: "zsh" }),
    ).rejects.toThrow("shell: must be a clean absolute POSIX path");
    await expect(computer.update({ shell: "" })).rejects.toThrow(
      /^computer update: shell: must not be empty/u,
    );
    await expect(computer.update({ shell: "/bin/zsh\n" })).rejects.toThrow(
      "computer update: shell: contains forbidden characters",
    );
    expect(sent).toHaveLength(3);
  });

  // Contract: the snapshot carries the default shell as stated, in the
  // settings and in the effective settings alike, with no default filled
  // in, and the shells the image held when it last started, in order; a
  // Computer that has not started reports none.
  it("reads the default shell and the image's shells", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/api-dev`
        ? json({
            computer: computerRecord({
              spec: { execution: { shell: "/usr/bin/zsh" } },
              executionSettings: {
                revision: 1,
                pending: false,
                effective: { shell: "/usr/bin/zsh" },
                shells: [
                  { name: "sh", path: "/bin/sh" },
                  { name: "bash", path: "/bin/bash" },
                  { name: "zsh", path: "/usr/bin/zsh" },
                ],
              },
            }),
          })
        : json({ computer: computerRecord() }),
    );
    const { computers } = network.client();
    const computer = await computers.get("api-dev");
    expect(computer.snapshot.settings).toEqual({ shell: "/usr/bin/zsh" });
    expect(computer.snapshot.effectiveSettings).toEqual({
      shell: "/usr/bin/zsh",
    });
    expect(computer.snapshot.shells).toEqual([
      { name: "sh", path: "/bin/sh" },
      { name: "bash", path: "/bin/bash" },
      { name: "zsh", path: "/usr/bin/zsh" },
    ]);
    expect(Object.isFrozen(computer.snapshot.shells)).toBe(true);
    expect(Object.isFrozen(computer.snapshot.shells?.[0])).toBe(true);
    const fresh = await computers.get("tools");
    expect(fresh.snapshot.settings.shell).toBeUndefined();
    expect(fresh.snapshot).not.toHaveProperty("shells");
  });

  // Contract: the effective settings state the size by the name IDYL reports,
  // with its CPU, memory and disk; settings as stated keep the name alone.
  it("reads the size, limits and disk IDYL reports", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/api-dev`
        ? json({
            computer: computerRecord({
              spec: { execution: { size: "small" } },
              executionSettings: {
                revision: 1,
                pending: false,
                effective: {
                  size: "small",
                  sizeLabel: "Small",
                  cpu: "2",
                  memory: "4Gi",
                  disk: "20Gi",
                },
              },
            }),
          })
        : undefined,
    );
    const computer = await network.client().computers.get("api-dev");
    expect(computer.snapshot.settings).toEqual({ size: "small" });
    expect(computer.snapshot.effectiveSettings).toEqual({
      size: "small",
      sizeLabel: "Small",
      cpu: "2",
      memory: "4Gi",
      disk: "20Gi",
    });
    expect(computer.snapshot).not.toHaveProperty("headroom");
    expect(computer.snapshot).not.toHaveProperty("size");
  });

  // Contract: the snapshot carries the largest size the Computer can run
  // at as IDYL reports it, and none while IDYL reports none.
  it("reads the largest size the Computer can run at", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/api-dev`
        ? json({
            computer: computerRecord({
              executionSettings: {
                revision: 1,
                pending: false,
                effective: {},
                largestSize: "medium",
              },
            }),
          })
        : json({ computer: computerRecord() }),
    );
    const { computers } = network.client();
    const computer = await computers.get("api-dev");
    expect(computer.snapshot.largestSize).toBe("medium");
    const fresh = await computers.get("tools");
    expect(fresh.snapshot).not.toHaveProperty("largestSize");
  });
});

describe("Computer handles", () => {
  // Contract: the snapshot is the product's view of the served Computer.
  it("reads a snapshot", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/api-dev`
        ? json({
            computer: computerRecord({
              spec: {
                idleTimeout: "300s",
                saveQuiet: "10s",
                execution: {
                  image: { idyl: "ubuntu-24.04" },
                  variables: [{ name: "A", value: "1" }],
                },
              },
              executionSettings: {
                revision: 2,
                pending: true,
                effective: {
                  image: { idyl: "ubuntu-24.04" },
                  cpu: "1",
                  memory: "2Gi",
                  network: { class: "internet" },
                  variables: [{ name: "A", value: "1" }],
                },
              },
              status: { fork: { state: "copying", copied: 1, total: 4 } },
            }),
          })
        : undefined,
    );
    const computer = await network.client().computers.get("api-dev");
    expect(computer.snapshot).toEqual({
      id: ID,
      name: "api-dev",
      phase: "active",
      execution: "dormant",
      version: 3,
      settings: { image: "ubuntu-24.04", env: { A: "1" } },
      effectiveSettings: {
        image: "ubuntu-24.04",
        cpu: "1",
        memory: "2Gi",
        network: "internet",
        env: { A: "1" },
      },
      settingsPending: true,
      idleTimeout: "300s",
      autoSave: true,
      saveQuiet: "10s",
      fork: { state: "copying", copied: 1, total: 4 },
      createdAt: "2026-01-02T03:04:05Z",
      updatedAt: "2026-01-02T04:05:06Z",
    });
    expect(Object.isFrozen(computer.snapshot)).toBe(true);
    expect(JSON.stringify(computer.snapshot)).not.toMatch(/subnet/iu);
  });

  // Contract: a handle is only ever made by the package.
  it("cannot be constructed", () => {
    expect(() => new (Computer as unknown as new () => Computer)()).toThrow(
      TypeError,
    );
  });

  // Contract: a Computer of another Namespace or Account is never handed
  // back.
  it("refuses a Computer of another namespace", async () => {
    const network = new FakeNetwork(() =>
      json({ computer: computerRecord({ namespace: "other" }) }),
    );
    const error = await rejection(network.client().computers.get("api-dev"));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("invalid_response");
  });

  // Contract: update addresses the Computer by its ID, field by field, and
  // returns a handle with the new snapshot.
  it("updates by ID", async () => {
    let sent: unknown;
    const network = new FakeNetwork((request, body) => {
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.method === "PATCH" && request.url.pathname === byId) {
        sent = body;
        return json({ computer: computerRecord({ headVersion: 4 }) });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    const updated = await computer.update({
      memory: "8Gi",
      cpu: null,
      env: { NODE_ENV: "test", OLD: null },
      autoSave: true,
    });
    expect(updated.snapshot.version).toBe(4);
    expect(computer.snapshot.version).toBe(3);
    expect(sent).toEqual({
      autoSave: true,
      cpu: null,
      memory: "8Gi",
      setVariables: [{ name: "NODE_ENV", value: "test" }],
      removeVariables: ["OLD"],
      client: "sdk",
    });
    await expect(computer.update({})).rejects.toThrow("update states no field");
  });

  // Contract: a notebook handle pins and unpins its notebook by the
  // Computer's ID and returns a handle with the new snapshot; this handle
  // keeps its old one, and an update that states nothing is refused before
  // any request.
  it("pins a notebook by the Computer's ID", async () => {
    const sent: unknown[] = [];
    const record = (pinned: boolean) => ({
      name: "notes",
      computer: ID,
      createdAt: "2026-01-02T03:04:05Z",
      creator: "owner@example.com",
      cells: 2,
      pinned,
    });
    const network = new FakeNetwork((request, body) => {
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.url.pathname !== `${byId}/notebooks/notes`) return undefined;
      if (request.method === "PATCH") {
        sent.push(body);
        return json(record((body as { pinned: boolean }).pinned));
      }
      return json(record(false));
    });
    const computer = await network.client().computers.get("api-dev");
    const notes = await computer.notebooks.get("notes");
    expect(notes.snapshot.pinned).toBe(false);
    const pinned = await notes.update({ pinned: true });
    expect(pinned.snapshot.pinned).toBe(true);
    expect(notes.snapshot.pinned).toBe(false);
    expect((await pinned.update({ pinned: false })).snapshot.pinned).toBe(
      false,
    );
    expect(sent).toEqual([{ pinned: true }, { pinned: false }]);
    await expect(notes.update({})).rejects.toThrow(
      new TypeError("notebook update states no field"),
    );
    expect(sent).toHaveLength(2);
  });

  // Contract: a rename patches the notebook by its current name and returns
  // a handle under the new name with the same ID; this handle keeps the old
  // name, and a new name that is not valid is refused before any request.
  it("renames a notebook and keeps its ID", async () => {
    const sent: unknown[] = [];
    const notebookId = "01954e20-7540-7ec4-93ec-14f783e6ab50";
    const record = (name: string) => ({
      id: notebookId,
      name,
      computer: ID,
      createdAt: "2026-01-02T03:04:05Z",
      creator: "owner@example.com",
      cells: 2,
      pinned: false,
    });
    const network = new FakeNetwork((request, body) => {
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.url.pathname !== `${byId}/notebooks/notes`) return undefined;
      if (request.method === "PATCH") {
        sent.push(body);
        return json(record((body as { name: string }).name));
      }
      return json(record("notes"));
    });
    const computer = await network.client().computers.get("api-dev");
    const notes = await computer.notebooks.get("notes");
    expect(notes.id).toBe(notebookId);
    expect(notes.snapshot.id).toBe(notebookId);
    const renamed = await notes.update({ name: "lab-notes" });
    expect(renamed.name).toBe("lab-notes");
    expect(renamed.id).toBe(notebookId);
    expect(notes.name).toBe("notes");
    expect(sent).toEqual([{ name: "lab-notes" }]);
    await expect(notes.update({ name: "Lab Notes" })).rejects.toThrow(
      TypeError,
    );
    expect(sent).toHaveLength(1);
  });

  // Contract: a notebook's cells read what ended their session, so a cell
  // whose client closed it reads `client-disconnected`, and one with no
  // recorded end reads none.
  it("reads what ended a cell's session", async () => {
    const page = JSON.parse(
      readFileSync(
        new URL(
          "./conformance/fixtures/api/testdata/golden/computer-notebook.cells-page.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { items: Record<string, unknown>[] };
    const ended = page.items[0];
    if (ended === undefined) throw new Error("the cells page is empty");
    const stopped = {
      ...ended,
      id: "01954e20-7540-7ec4-93ec-14f783e6ab42",
      termination: "client-disconnected",
      process: { outcome: "signaled", signal: "KILL" },
    };
    const running: Record<string, unknown> = {
      ...ended,
      id: "01954e20-7540-7ec4-93ec-14f783e6ab43",
      state: "running",
    };
    for (const key of ["endedAt", "process", "termination"]) {
      Reflect.deleteProperty(running, key);
    }
    const network = new FakeNetwork((request) => {
      const path = request.url.pathname;
      if (path === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (path === `${byId}/notebooks/build`) {
        return json({
          name: "build",
          computer: ID,
          createdAt: "2026-01-02T03:04:05Z",
          creator: "developer@example.com",
          cells: 3,
          pinned: false,
        });
      }
      if (path === `${byId}/notebooks/build/cells`) {
        return json({ items: [ended, stopped, running], totalCount: 3 });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    const cells = [];
    for await (const cell of (await computer.notebooks.get("build")).cells()) {
      cells.push(cell);
    }
    expect(cells.map((cell) => cell.termination)).toEqual([
      "exited",
      "client-disconnected",
      undefined,
    ]);
    expect(cells[1]?.process).toEqual({ outcome: "signaled", signal: "KILL" });
  });

  // Contract: a rename is an update that states a name. It addresses the
  // Computer by its ID, so the handle keeps reaching it across the rename,
  // writes only the name, and returns a handle under the new name; a name in
  // the form of a Computer ID, or a blank one, is refused before any request.
  it("renames by ID", async () => {
    const requests: string[] = [];
    let sent: unknown;
    const network = new FakeNetwork((request, body) => {
      requests.push(`${request.method} ${request.url.pathname}`);
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.method === "PATCH" && request.url.pathname === byId) {
        sent = body;
        return json({ computer: computerRecord({ name: "ledger" }) });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    const renamed = await computer.update({ name: "ledger" });
    expect(sent).toEqual({ name: "ledger", client: "sdk" });
    expect(renamed.name).toBe("ledger");
    expect(renamed.id).toBe(computer.id);
    expect(computer.name).toBe("api-dev");
    await expect(computer.update({ name: ID })).rejects.toThrow(
      "computer name must not be in the form of a computer ID",
    );
    await expect(computer.update({ name: " " })).rejects.toThrow(
      "computer name is required",
    );
    expect(requests).toEqual([`GET ${computersPath}/api-dev`, `PATCH ${byId}`]);
  });

  // Contract: History shows a rename with the names before and after and
  // who renamed the Computer; the entry owns no version.
  it("shows a rename in history", async () => {
    const network = new FakeNetwork((request) => {
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.url.pathname === `${byId}/journal`) {
        return json({
          items: [
            {
              id: ENTRY,
              seq: 4,
              kind: "rename",
              admittedAt: "2026-01-02T03:04:05Z",
              creator: "owner@example.com",
              rename: { from: "api", to: "api-dev" },
            },
          ],
          totalCount: 1,
        });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    const entries = [];
    for await (const entry of computer.history()) entries.push(entry);
    expect(entries).toEqual([
      {
        id: ENTRY,
        kind: "rename",
        admittedAt: "2026-01-02T03:04:05Z",
        creator: "owner@example.com",
        rename: { from: "api", to: "api-dev" },
      },
    ]);
  });

  // Contract: History shows a sleep that discarded unsaved changes with its
  // sleep detail; a sleep that saved first carries none.
  it("shows a sleep that discarded unsaved changes in history", async () => {
    const network = new FakeNetwork((request) => {
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.url.pathname === `${byId}/journal`) {
        return json({
          items: [
            {
              id: ENTRY,
              seq: 5,
              kind: "sleep",
              admittedAt: "2026-01-02T03:04:05Z",
              creator: "owner@example.com",
              client: "console",
              sleep: { discardedUnsavedChanges: true },
            },
          ],
          totalCount: 1,
        });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    const entries = [];
    for await (const entry of computer.history()) entries.push(entry);
    expect(entries).toEqual([
      {
        id: ENTRY,
        kind: "sleep",
        admittedAt: "2026-01-02T03:04:05Z",
        creator: "owner@example.com",
        client: "console",
        sleep: { discardedUnsavedChanges: true },
      },
    ]);
  });

  // Contract: History names the kind of client whose request caused each
  // entry, read from the entry, else from its settings change; an entry
  // recorded with none carries none.
  it("shows the client of each entry in history", async () => {
    const network = new FakeNetwork((request) => {
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.url.pathname === `${byId}/journal`) {
        return json({
          items: [
            {
              id: "01954e20-7540-7ec4-93ec-14f783e6ab3b",
              seq: 6,
              kind: "wake",
              admittedAt: "2026-01-02T03:05:41Z",
              creator: "owner@example.com",
              client: "cli",
            },
            {
              id: ENTRY,
              seq: 5,
              kind: "execution-settings",
              admittedAt: "2026-01-02T03:04:05Z",
              creator: "owner@example.com",
              executionSettings: {
                cause: "settings",
                settings: { shell: "/bin/sh" },
                revision: 2,
                changed: ["shell"],
                creator: "owner@example.com",
                client: "console",
              },
            },
            {
              id: OPERATION,
              seq: 4,
              kind: "rename",
              admittedAt: "2026-01-02T03:04:00Z",
              creator: "owner@example.com",
              rename: { from: "api", to: "api-dev" },
            },
          ],
          totalCount: 3,
        });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    const entries = [];
    for await (const entry of computer.history()) entries.push(entry);
    expect(entries.map((entry) => entry.client)).toEqual([
      "cli",
      "console",
      undefined,
    ]);
    expect(entries[1]?.settings).toEqual({ shell: "/bin/sh" });
  });

  // Contract: an image patch reads as IDYL's own entry naming the catalog
  // image and the patch levels it moved between, with no creator or client.
  it("shows an image patch in history", async () => {
    const patch = JSON.parse(
      readFileSync(
        new URL(
          "./conformance/fixtures/api/testdata/golden/computer-journal.execution-settings-image-patch.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { readonly id: string };
    const network = new FakeNetwork((request) => {
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.url.pathname === `${byId}/journal`) {
        return json({ items: [patch], totalCount: 1 });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    const entries = [];
    for await (const entry of computer.history()) entries.push(entry);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.imagePatch).toEqual({
      image: "python-3.12-ubuntu-24.04",
      from: "2026.01.01",
      to: "2026.01.02.2",
    });
    expect(entries[0]?.creator).toBeUndefined();
    expect(entries[0]?.client).toBeUndefined();
  });

  // Contract: delete addresses the ID, and with `wait` reads it back until
  // it is gone.
  it("deletes and waits until gone", async () => {
    let reads = 0;
    const network = new FakeNetwork((request) => {
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.url.pathname !== byId) return undefined;
      if (request.method === "DELETE") {
        return json({ accepted: true, deletedAt: "2026-01-02T05:00:00Z" }, 202);
      }
      reads += 1;
      return reads === 1
        ? json({ computer: computerRecord({ phase: "terminating" }) })
        : errorResponse(404, "not_found", "computer not found");
    });
    const computer = await network.client().computers.get("api-dev");
    await computer.delete({ wait: true });
    expect(network.computerCalls().slice(1)).toEqual([
      `DELETE ${byId}`,
      `GET ${byId}`,
      `GET ${byId}`,
    ]);
  });
});

describe("idyl.computers listing and images", () => {
  // Contract: list walks every page; a handle is yielded for each.
  it("lists every page", async () => {
    const network = new FakeNetwork((request) => {
      if (request.url.pathname !== computersPath) return undefined;
      return request.url.searchParams.get("offset") === null
        ? json({
            items: [computerRecord({ name: "a" })],
            totalCount: 2,
          })
        : json({ items: [computerRecord({ name: "b" })], totalCount: 2 });
    });
    const names: string[] = [];
    for await (const computer of network.client().computers.list()) {
      expect(computer).toBeInstanceOf(Computer);
      names.push(computer.name);
    }
    expect(names).toEqual(["a", "b"]);
    expect(
      network
        .computerRequests()
        .map((request) => request.url.searchParams.get("offset")),
    ).toEqual([null, "1"]);
  });

  // Contract: a listed Computer of another Account is never handed back;
  // its page rejects as a get of it would.
  it("refuses a listed Computer of another account", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === computersPath
        ? json({
            items: [
              computerRecord({ name: "own" }),
              computerRecord({ name: "other", accountId: "550000000009" }),
            ],
            totalCount: 2,
          })
        : undefined,
    );
    await expect(network.client().computers.listPage()).rejects.toThrow(
      new TransportError(
        "invalid_response",
        "computer response names a different account or namespace",
      ),
    );
  });

  // Contract: the catalogue carries what a caller chooses by, and not the
  // registry location an image is pulled from.
  it("reads the image catalogue", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname.endsWith("/computer-images")
        ? json({
            items: [
              {
                name: "ubuntu-24.04",
                displayName: "Ubuntu 24.04 LTS",
                os: { name: "ubuntu", version: "24.04" },
                gpu: false,
                image: "registry.example.com/ubuntu@sha256:00",
                patch: "2026.01.02",
                default: true,
              },
            ],
            totalCount: 1,
          })
        : undefined,
    );
    expect(await network.client().computers.images()).toEqual([
      {
        name: "ubuntu-24.04",
        displayName: "Ubuntu 24.04 LTS",
        os: { name: "ubuntu", version: "24.04" },
        gpu: false,
        patch: "2026.01.02",
        default: true,
        isolation: "secure-container",
      },
    ]);
    expect(network.computerCalls()).toEqual([
      `GET /v1/accounts/550000000001/subnets/550000000002/computer-images`,
    ]);
  });

  // Contract: the images of one isolation class are read with the class as
  // the query, and each states the class it serves; a class no Computer may
  // select is refused before any request.
  it("reads the images of one isolation class", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname.endsWith("/computer-images")
        ? json({
            items:
              request.url.searchParams.get("isolation") === "vm"
                ? [
                    {
                      name: "ubuntu-26.04-machine",
                      displayName: "Ubuntu 26.04 LTS machine",
                      os: { name: "ubuntu", version: "26.04" },
                      gpu: false,
                      image: "registry.example.com/ubuntu-machine@sha256:00",
                      patch: "2026.11.01",
                      default: true,
                      isolation: "vm",
                    },
                  ]
                : [],
            totalCount: 0,
          })
        : undefined,
    );
    const { computers } = network.client();
    const unknown = "microvm" as "vm";
    await expect(computers.images({ isolation: unknown })).rejects.toThrow(
      "list images: isolation class must be secure-container or vm",
    );
    expect(network.plane.requests).toHaveLength(0);
    expect(await computers.images({ isolation: "vm" })).toEqual([
      {
        name: "ubuntu-26.04-machine",
        displayName: "Ubuntu 26.04 LTS machine",
        os: { name: "ubuntu", version: "26.04" },
        gpu: false,
        patch: "2026.11.01",
        default: true,
        isolation: "vm",
      },
    ]);
    expect(await computers.images({ isolation: "secure-container" })).toEqual(
      [],
    );
    expect(network.computerCalls()).toEqual([
      `GET /v1/accounts/550000000001/subnets/550000000002/computer-images?isolation=vm`,
      `GET /v1/accounts/550000000001/subnets/550000000002/computer-images?isolation=secure-container`,
    ]);
  });
});

describe("saved state", () => {
  function savedState(): FakeNetwork {
    let commitReads = 0;
    return new FakeNetwork((request, body) => {
      const { pathname } = request.url;
      if (pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (pathname === `${byId}/commits` && request.method === "POST") {
        expect(body).toEqual({ client: "sdk" });
        return json({ id: OPERATION, state: "pending" }, 202);
      }
      if (pathname === `${byId}/commits/${OPERATION}`) {
        commitReads += 1;
        return json(
          commitReads === 1
            ? { id: OPERATION, state: "pending" }
            : { id: OPERATION, state: "saved", version: 5 },
        );
      }
      if (pathname === `${byId}/restores` && request.method === "POST") {
        expect(body).toEqual({ from: "release", client: "sdk" });
        return json({ id: OPERATION, state: "pending" }, 202);
      }
      if (pathname === `${byId}/restores/${OPERATION}`) {
        return json({ id: OPERATION, state: "published", version: 6 });
      }
      if (pathname === `${byId}/versions`) {
        return json({
          items: [
            {
              number: 1,
              name: "release",
              createdAt: "2026-01-02T03:04:05Z",
              origin: "commit",
              entry: ENTRY,
              parent: 0,
              logicalBytes: 123,
            },
          ],
          totalCount: 1,
        });
      }
      if (pathname === `${byId}/versions/1` && request.method === "PATCH") {
        return json({
          number: 1,
          name: (body as { name: string }).name,
          createdAt: "2026-01-02T03:04:05Z",
          origin: "commit",
          logicalBytes: 123,
        });
      }
      if (pathname === `${byId}/journal`) {
        return json({
          items: [
            {
              id: ENTRY,
              seq: 2,
              kind: "save",
              admittedAt: "2026-01-02T03:04:05Z",
              version: 1,
              creator: "owner@example.com",
              save: { trigger: "request" },
            },
          ],
          totalCount: 1,
        });
      }
      return undefined;
    });
  }

  // Contract: save waits for the outcome; restore waits for publication.
  it("saves and restores", async () => {
    const network = savedState();
    const computer = await network.client().computers.get("api-dev");
    expect(await computer.save()).toEqual({ state: "saved", version: 5 });
    expect(await computer.restore("release")).toEqual({
      state: "published",
      version: 6,
    });
    await expect(computer.restore(-1)).rejects.toThrow(TypeError);
    await expect(computer.restore(" ")).rejects.toThrow(TypeError);
  });

  // Contract: a save refused for size rejects with its reason as both the
  // code and the detail; a save that fails for any other reason carries no
  // code.
  it("rejects a save refused for size with its reason as the code", async () => {
    for (const [reason, coded] of [
      [SAVE_REASON_ACCOUNT_STORAGE_LIMIT, true],
      [SAVE_REASON_COMPUTER_SIZE, true],
      [SAVE_REASON_NAME_LIMIT, true],
      ["node-disk-failed", false],
    ] as const) {
      const network = new FakeNetwork((request) => {
        const { pathname } = request.url;
        if (pathname === `${computersPath}/api-dev`) {
          return json({ computer: computerRecord() });
        }
        if (pathname === `${byId}/commits` && request.method === "POST") {
          return json({ id: OPERATION, state: "failed", reason }, 202);
        }
        return undefined;
      });
      const computer = await network.client().computers.get("api-dev");
      const error = await computer.save().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 409, detail: reason });
      expect(isApiCode(error, reason)).toBe(coded);
    }
  });

  // Contract: history and versions are read newest first, as the
  // product's own views.
  it("reads history and versions", async () => {
    const network = savedState();
    const computer = await network.client().computers.get("api-dev");
    const entries = [];
    for await (const entry of computer.history()) entries.push(entry);
    expect(entries).toEqual([
      {
        id: ENTRY,
        kind: "save",
        admittedAt: "2026-01-02T03:04:05Z",
        version: 1,
        creator: "owner@example.com",
        save: { trigger: "request" },
      },
    ]);
    const versions = [];
    for await (const version of computer.versions()) versions.push(version);
    expect(versions).toEqual([
      {
        number: 1,
        name: "release",
        createdAt: "2026-01-02T03:04:05Z",
        origin: "commit",
        entry: ENTRY,
        parent: 0,
        bytes: 123,
      },
    ]);
    expect((await computer.nameVersion(1, "stable")).name).toBe("stable");
    await expect(computer.nameVersion(-1, "x")).rejects.toThrow(TypeError);
  });
});

describe("Computer.fork", () => {
  // Contract: a fork creates a Computer from an entry of this one's
  // history and resolves once its copy has finished.
  it("forks from an entry and waits for the copy", async () => {
    let sent: unknown;
    let reads = 0;
    const forkId = "01954e20-7540-7ec4-93ec-14f783e6ab99";
    const network = new FakeNetwork((request, body) => {
      const { pathname } = request.url;
      if (pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (pathname === computersPath && request.method === "POST") {
        sent = body;
        return json(
          {
            computer: computerRecord({
              id: forkId,
              name: "api-dev-2",
              status: { fork: { state: "copying", copied: 0, total: 2 } },
            }),
          },
          201,
        );
      }
      if (pathname === `${computersPath}/by-id/${forkId}`) {
        reads += 1;
        return json({
          computer: computerRecord({
            id: forkId,
            name: "api-dev-2",
            status: { fork: { state: "done", copied: 2, total: 2 } },
          }),
        });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    const fork = await computer.fork({ name: "api-dev-2", from: ENTRY });
    expect(fork.id).toBe(forkId);
    expect(fork.snapshot.fork?.state).toBe("done");
    expect(reads).toBe(1);
    expect(sent).toEqual({
      name: "api-dev-2",
      subnet: "550000000002",
      forkOf: { source: { computer: ID }, entry: ENTRY },
    });
  });

  // Contract: a stated `from` with nothing in it, as for a cell whose save has
  // no entry, is refused before any request: it never forks from somewhere else.
  it("refuses a stated from that names nothing", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/api-dev`
        ? json({ computer: computerRecord() })
        : undefined,
    );
    const computer = await network.client().computers.get("api-dev");
    const calls = network.computerCalls().length;
    await expect(
      computer.fork({ name: "x", from: undefined as unknown as string }),
    ).rejects.toThrow(TypeError);
    await expect(computer.fork({ name: "x", from: "" })).rejects.toThrow(
      TypeError,
    );
    await expect(computer.fork({ name: "x", from: -1 })).rejects.toThrow(
      TypeError,
    );
    expect(network.computerCalls()).toHaveLength(calls);
  });

  /** A network whose Computer forks at once, recording what the fork named. */
  function forking(versions: unknown): {
    readonly network: FakeNetwork;
    readonly sent: () => unknown;
  } {
    const forkId = "01954e20-7540-7ec4-93ec-14f783e6ab99";
    let sent: unknown;
    const network = new FakeNetwork((request, body) => {
      const { pathname } = request.url;
      if (pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.method === "POST" && pathname === computersPath) {
        sent = body;
        return json(
          {
            computer: computerRecord({
              id: forkId,
              status: { fork: { state: "done", copied: 2, total: 2 } },
            }),
          },
          201,
        );
      }
      if (pathname.startsWith(`${byId}/versions`)) {
        const answer = (versions as (path: string) => unknown)(pathname);
        return answer === undefined
          ? errorResponse(404, "VERSION_NOT_FOUND", "no such version")
          : json(answer);
      }
      return undefined;
    });
    return { network, sent: () => sent };
  }

  const version = (number: number, name?: string): unknown => ({
    number,
    ...(name === undefined ? {} : { name }),
    createdAt: "2026-01-01T00:00:00Z",
    origin: "commit",
    entry: ENTRY,
    logicalBytes: 1,
  });

  // Contract: a fork with `workspaceOnly: true` asks for a fork that saves
  // only /workspace; without it the request names nothing, so the fork saves
  // its whole system whatever its source saves.
  it("forks a Computer that saves only /workspace when asked", async () => {
    const { network, sent } = forking(() => version(3));
    const computer = await network.client().computers.get("api-dev");
    await computer.fork({ name: "api-dev-2", from: 3, workspaceOnly: true });
    expect(sent()).toMatchObject({ workspaceOnly: true });
    await computer.fork({ name: "api-dev-3", from: 3 });
    expect(sent()).not.toHaveProperty("workspaceOnly");
  });

  // Contract: the create a fork sends is the reference contract's fork
  // request, byte for byte, in each of its four forms: no `from` copies the
  // Computer as it is now and names no entry, `save` is sent only when
  // stated, a stated `false` included, and a `from` names its entry. A fork
  // with no `from` reads nothing before its create.
  it("sends the four fork requests of the reference contract", async () => {
    const golden = JSON.parse(
      readFileSync(
        new URL(
          "./conformance/fixtures/api/testdata/golden/computer.fork-requests.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<
      "asItIsNow" | "entry" | "neverSave" | "saveFirst",
      { readonly forkOf: { readonly entry?: string } }
    >;
    const { network, sent } = forking(() => undefined);
    const computer = await network.client().computers.get("api-dev");
    const before = network.computerCalls().length;
    await computer.fork({ name: "fork" });
    expect(sent()).toEqual(golden.asItIsNow);
    await computer.fork({ name: "fork", save: true });
    expect(sent()).toEqual(golden.saveFirst);
    await computer.fork({ name: "fork", save: false });
    expect(sent()).toEqual(golden.neverSave);
    expect(
      network
        .computerCalls()
        .slice(before)
        .filter((call) => !call.startsWith("POST")),
    ).toEqual([]);
    await computer.fork({
      name: "fork",
      from: golden.entry.forkOf.entry ?? "",
    });
    expect(sent()).toEqual(golden.entry);
  });

  // Contract: `save` is stated only on a fork with no `from`, as the
  // reference contract refuses it with an entry, and only as a boolean;
  // either refusal comes before any request.
  it("refuses save stated with from or as another type", async () => {
    const { network, sent } = forking(() => version(3));
    const computer = await network.client().computers.get("api-dev");
    const calls = network.computerCalls().length;
    await expect(
      computer.fork({ name: "x", from: ENTRY, save: false }),
    ).rejects.toThrow("save is stated only on a fork with no from");
    await expect(
      computer.fork({ name: "x", from: 3, save: true }),
    ).rejects.toThrow(TypeError);
    await expect(
      computer.fork({ name: "x", save: "yes" as unknown as boolean }),
    ).rejects.toThrow("save must be a boolean");
    expect(network.computerCalls()).toHaveLength(calls);
    expect(sent()).toBeUndefined();
  });

  // Contract: `from` also takes a saved version, by name or by number, as a
  // restore does.
  it("forks from a saved version by name or number", async () => {
    const { network, sent } = forking(() => version(3, "release"));
    const computer = await network.client().computers.get("api-dev");
    await computer.fork({ name: "api-dev-2", from: "release" });
    await computer.fork({ name: "api-dev-3", from: 3 });
    expect(sent()).toMatchObject({ forkOf: { entry: ENTRY } });
    expect(
      network.computerCalls().filter((call) => call.includes("/versions")),
    ).toEqual([`GET ${byId}/versions/release`, `GET ${byId}/versions/3`]);
  });

  /**
   * A network whose creates are answered in turn by `answers`, then
   * accepted with a finished copy, recording each create it received.
   */
  function refusing(answers: readonly (() => Response)[]): {
    readonly network: FakeNetwork;
    readonly creates: unknown[];
  } {
    const creates: unknown[] = [];
    const network = new FakeNetwork((request, body) => {
      const { pathname } = request.url;
      if (pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.method === "POST" && pathname === computersPath) {
        const answer = answers[creates.length];
        creates.push(body);
        return answer === undefined
          ? json(
              {
                computer: computerRecord({
                  id: "01954e20-7540-7ec4-93ec-14f783e6ab99",
                  status: { fork: { state: "done", copied: 2, total: 2 } },
                }),
              },
              201,
            )
          : answer();
      }
      return undefined;
    });
    return { network, creates };
  }

  /** The refusal of a fork whose save has not settled: 409 and a Retry-After. */
  const unsettled = (seconds: string) => (): Response =>
    new Response(
      JSON.stringify({ error: "save not settled", code: "CONFLICT" }),
      {
        status: 409,
        headers: {
          "content-type": "application/json",
          "retry-after": seconds,
        },
      },
    );

  // Contract: a fork refused because a save it waits for has not settled,
  // the save it makes first or the save a named cell still owes, created
  // nothing; the fork asks again with the same request, which waits for the
  // same save, and resolves once IDYL accepts it.
  for (const [form, options] of [
    ["as it is now", {}],
    ["from a cell", { from: ENTRY }],
  ] as const) {
    it(`asks again for a fork ${form} whose save has not settled`, async () => {
      const { network, creates } = refusing([unsettled("0")]);
      const computer = await network.client().computers.get("api-dev");
      const fork = await computer.fork({ name: "api-dev-2", ...options });
      expect(fork.snapshot.fork?.state).toBe("done");
      expect(creates).toHaveLength(2);
      expect(creates[1]).toEqual(creates[0]);
    });
  }

  // Contract: a fork whose save is still unsettled when its `timeoutMs` runs
  // out rejects with IDYL's last refusal, status 409 with `retryAfterMs`, so
  // the caller knows nothing was created; a zero timeout asks once.
  it("rejects with the refusal when the save outlasts the timeout", async () => {
    const { network, creates } = refusing([unsettled("1"), unsettled("1")]);
    const computer = await network.client().computers.get("api-dev");
    const once = await rejection(
      computer.fork({ name: "api-dev-2", timeoutMs: 0 }),
    );
    expect(once).toBeInstanceOf(ApiError);
    expect(once).toMatchObject({ status: 409, retryAfterMs: 1000 });
    expect(creates).toHaveLength(1);
    const later = await rejection(
      computer.fork({ name: "api-dev-2", timeoutMs: 100 }),
    );
    expect(later).toMatchObject({ status: 409, retryAfterMs: 1000 });
    expect(creates).toHaveLength(2);
  });

  // Contract: a fork whose save failed is refused with FORK_NOT_QUIESCENT
  // and the save's reason in its details; it is not asked again, and
  // `forkNotQuiescent` reads the reason, a reason this package does not name
  // included.
  it("rejects a fork whose save failed with the save's reason", async () => {
    for (const reason of [SAVE_REASON_COMPUTER_SIZE, "disk-unreadable"]) {
      const { network, creates } = refusing([
        () =>
          json(
            {
              error: "save failed",
              code: ERROR_CODE_FORK_NOT_QUIESCENT,
              details: { saveReason: reason },
            },
            409,
          ),
      ]);
      const computer = await network.client().computers.get("api-dev");
      const error = await rejection(computer.fork({ name: "api-dev-2" }));
      expect(isApiCode(error, ERROR_CODE_FORK_NOT_QUIESCENT)).toBe(true);
      expect(forkNotQuiescent(error)).toEqual({ saveReason: reason });
      expect(creates).toHaveLength(1);
    }
    expect(forkNotQuiescent(new Error("x"))).toBeUndefined();
    expect(
      forkNotQuiescent(
        new ApiError({
          status: 409,
          code: ERROR_CODE_FORK_NOT_QUIESCENT,
          message: "x",
          details: { saveReason: 7 },
        }),
      ),
    ).toEqual({ saveReason: "" });
  });
});

describe("Computer.refresh", () => {
  // Contract: a refresh reads the Computer by its stable ID and returns a new
  // handle; the handle it was called on keeps its snapshot.
  it("returns a new handle on the Computer as it is now", async () => {
    let phase = "dormant";
    const network = new FakeNetwork((request) => {
      const { pathname } = request.url;
      if (pathname === `${computersPath}/api-dev` || pathname === byId) {
        return json({ computer: computerRecord({ phase }) });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    phase = "active";
    const current = await computer.refresh();
    expect(current).not.toBe(computer);
    expect(current.snapshot.phase).toBe("active");
    expect(computer.snapshot.phase).toBe("dormant");
    expect(network.computerCalls()).toContain(`GET ${byId}`);
  });
});

describe("Computer isolation", () => {
  // Contract: a create states the isolation class in the contract's spelling,
  // and a read reports it.
  it("states and reports the isolation class", async () => {
    let sent: unknown;
    const network = new FakeNetwork((request, body) => {
      if (request.method === "POST" && request.url.pathname === computersPath) {
        sent = body;
        return json(
          {
            computer: computerRecord({
              spec: { execution: { isolation: "vm" } },
            }),
          },
          201,
        );
      }
      return undefined;
    });
    const computer = await network.client().computers.create({
      name: "api-dev",
      isolation: "vm",
    });
    expect(sent).toMatchObject({ spec: { execution: { isolation: "vm" } } });
    expect(computer.snapshot.settings.isolation).toBe("vm");
  });

  // Contract: an update changes the isolation class, with an image of the
  // new class only when one is stated, and a class no Computer may select is
  // refused before any request.
  it("changes the isolation class on update", async () => {
    const sent: unknown[] = [];
    const network = new FakeNetwork((request, body) => {
      const { pathname } = request.url;
      if (pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (request.method === "PATCH" && pathname === byId) {
        sent.push(body);
        return json({ computer: computerRecord() });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    await computer.update({ isolation: "vm" });
    await computer.update({
      isolation: "vm",
      image: "ubuntu-26.04-machine",
      client: "console",
    });
    const unknown = "microvm" as "vm";
    await expect(computer.update({ isolation: unknown })).rejects.toThrow(
      "isolation: must be secure-container or vm",
    );
    expect(sent).toEqual([
      { isolation: "vm", client: "sdk" },
      {
        image: { idyl: "ubuntu-26.04-machine" },
        isolation: "vm",
        client: "console",
      },
    ]);
  });
});

describe("Computer.version", () => {
  // Contract: a saved version reads by number or by name, addressed by the
  // Computer's stable ID.
  it("reads one saved version", async () => {
    const network = new FakeNetwork((request) => {
      const { pathname } = request.url;
      if (pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      return pathname === `${byId}/versions/release`
        ? json({
            number: 3,
            name: "release",
            createdAt: "2026-01-01T00:00:00Z",
            origin: "commit",
            entry: ENTRY,
            logicalBytes: 1,
          })
        : undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    await expect(computer.version("release")).resolves.toMatchObject({
      number: 3,
      name: "release",
      entry: ENTRY,
    });
    await expect(computer.version(-1)).rejects.toThrow(TypeError);
  });
});

describe("idyl.computers.connector", () => {
  // Contract: a connector takes the client's network and trust keys, and needs
  // them from one or the other.
  it("takes the network and trust keys from the client", () => {
    const parts = {
      worker: {
        postMessage: () => undefined,
        addEventListener: () => undefined,
      },
      module: {} as WebAssembly.Module,
    };
    const trustKeys = [{ keyId: "key", publicKey: new Uint8Array(32) }];
    const network = new FakeNetwork(() => undefined);
    expect(() => network.client().computers.connector(parts)).toThrow(
      TypeError,
    );
    expect(() =>
      network
        .client({ trustKeys, network: "example.test" })
        .computers.connector(parts),
    ).not.toThrow();
    expect(() =>
      network.client({ trustKeys }).computers.connector(parts),
    ).toThrow("network");
  });

  // Contract: a client for a Network this package pins keys for needs none
  // stated; a client for any other Network still does.
  it("takes the pinned trust keys of idyl.sh", () => {
    const parts = {
      worker: {
        postMessage: () => undefined,
        addEventListener: () => undefined,
      },
      module: {} as WebAssembly.Module,
    };
    const network = new FakeNetwork(() => undefined);
    expect(() =>
      network.client({ network: "idyl.sh" }).computers.connector(parts),
    ).not.toThrow();
    expect(() =>
      network.client({ network: "example.test" }).computers.connector(parts),
    ).toThrow("trustKeys");
  });
});

describe("refusals from the platform", () => {
  // Contract: a refusal is an ApiError carrying its code.
  it("relays the code", async () => {
    const network = new FakeNetwork(() =>
      errorResponse(404, "not_found", "computer not found"),
    );
    const error = await rejection(network.client().computers.get("gone"));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});

describe("Computer waits and listings", () => {
  // Contract: an invalid wait is refused before the irreversible request.
  it("judges a delete's wait before deleting", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/api-dev`
        ? json({ computer: computerRecord() })
        : undefined,
    );
    const computer = await network.client().computers.get("api-dev");
    await expect(
      computer.delete({ wait: true, timeoutMs: -1 }),
    ).rejects.toThrow(TypeError);
    await expect(
      computer.fork({ name: "x", from: ENTRY, timeoutMs: Number.NaN }),
    ).rejects.toThrow(TypeError);
    expect(
      network.computerCalls().filter((call) => !call.startsWith("GET")),
    ).toEqual([]);
  });

  // Contract: a list hands on when each Computer was last used, and a
  // Computer without the value has no such key.
  it("lists when each Computer was last used", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === computersPath
        ? json({
            items: [
              computerRecord({
                name: "used",
                lastUsedAt: "2026-01-02T05:06:07Z",
              }),
              computerRecord({ name: "unused" }),
            ],
            totalCount: 2,
          })
        : undefined,
    );
    const listed = [];
    for await (const computer of network.client().computers.list()) {
      listed.push(computer.snapshot);
    }
    expect(listed[0]?.lastUsedAt).toBe("2026-01-02T05:06:07Z");
    expect(listed[1]).not.toHaveProperty("lastUsedAt");
  });

  // Contract: one Computer with a value the package cannot spell does not
  // break the listing; the value is shown as served or left out.
  it("lists a Computer with an unfamiliar quantity", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === computersPath
        ? json({
            items: [
              computerRecord({
                spec: { execution: { cpu: "2 cores", memory: "4Gi" } },
              }),
            ],
            totalCount: 1,
          })
        : undefined,
    );
    const listed = [];
    for await (const computer of network.client().computers.list()) {
      listed.push(computer.snapshot.settings);
    }
    expect(listed).toEqual([{ cpu: "2 cores", memory: "4Gi" }]);
  });
});
