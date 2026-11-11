// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareComputerImagePatch,
  validateComputerImagePatch,
} from "../src/api/computer-image.js";
import { validateComputerSize } from "../src/api/billing.js";
import {
  decodeComputer,
  encodeComputer,
  encodeUpdateComputerRequest,
  validateUpdateComputerRequest,
  type UpdateComputerRequest,
} from "../src/api/computer.js";
import {
  ComputerExecutionSettingsError,
  MAX_IMAGE_SHELLS,
  computerExecutionSettingsShape,
  validateComputerExecutionSettings,
  validateImageShells,
  validateShellPath,
  type ComputerExecutionSettings,
  type ImageShell,
} from "../src/resource/computer-execution-settings.js";
import { decodeCpu } from "../src/resource/cpu.js";
import { type JsonObject } from "../src/resource/json.js";
import { decodeMemory } from "../src/resource/memory.js";
import { decodeVolume } from "../src/resource/volume.js";
import { updateComputerRequestShape } from "../src/api/computer.js";
import { decodeText } from "../src/internal/strictdecode.js";
import { StrictDecodeError } from "../src/resource/decode-error.js";
import {
  FakeControlPlane,
  json,
  namespacePathPrefix,
  subnetHost,
} from "./fakes/control-plane.js";
import { accountId, subnetSlug } from "./fakes/fetch-queue.js";

/** A Computer golden, as the platform serves it. */
function golden(name: string): JsonObject {
  return JSON.parse(
    readFileSync(
      new URL(
        `./conformance/fixtures/api/testdata/golden/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as JsonObject;
}

function refusal(validate: () => void): Error {
  try {
    validate();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return error as Error;
  }
  throw new Error("expected a refusal");
}

const pending = golden("computer.execution-pending");
const catalog = golden("computer-images.list");

describe("Computer execution settings", () => {
  // Contract: settings that state nothing are valid, and so is every
  // network class a Micropod admits.
  it("accepts settings a Micropod can run", () => {
    expect(() => {
      validateComputerExecutionSettings({});
    }).not.toThrow();
    for (const networkClass of ["none", "internet", "restricted-egress"]) {
      expect(() => {
        validateComputerExecutionSettings({ network: { class: networkClass } });
      }).not.toThrow();
    }
  });

  // Contract: a limit a Micropod cannot represent, and settings whose
  // canonical encoding exceeds 16 KiB, are refused by a
  // ComputerExecutionSettingsError naming the field; the size counts bytes as the
  // Go encoder writes them, escaping `<`, `>`, and `&`.
  it("refuses unrepresentable limits and oversized settings", () => {
    const cpu = refusal(() => {
      validateComputerExecutionSettings({ cpu: decodeCpu("9223372036855") });
    });
    expect(cpu).toBeInstanceOf(ComputerExecutionSettingsError);
    expect((cpu as ComputerExecutionSettingsError).field).toBe("execution.cpu");
    expect(cpu.message).toBe(
      "execution.cpu: must be representable in int64 nanoCPUs",
    );
    expect(() => {
      validateComputerExecutionSettings({ memory: decodeMemory("4Gi") });
    }).not.toThrow();
    const value = "<".repeat(2_800);
    const oversized: ComputerExecutionSettings = {
      variables: [{ name: "PAGE", value }],
    };
    expect(JSON.stringify(oversized).length).toBeLessThan(16 * 1024);
    expect(
      refusal(() => {
        validateComputerExecutionSettings(oversized);
      }).message,
    ).toBe("execution: canonical encoding must be at most 16384 bytes");
  });

  // Contract: a default shell is a clean absolute path other than the
  // root, without a NUL, carriage return or line feed; it is written after
  // the variables, and an empty one is not stated and not written.
  it("judges and writes the default shell", () => {
    expect(() => {
      validateComputerExecutionSettings({ shell: "/usr/bin/zsh" });
    }).not.toThrow();
    expect(() => {
      validateComputerExecutionSettings({ shell: "" });
    }).not.toThrow();
    for (const [shell, rule] of [
      ["zsh", "must be a clean absolute POSIX path"],
      ["/usr/bin/../bin/zsh", "must be a clean absolute POSIX path"],
      ["/usr/bin/", "must be a clean absolute POSIX path"],
      ["/", "must be a clean absolute POSIX path"],
      ["/bin/zsh\n", "contains forbidden characters"],
      ["/bin/z\u0000sh", "contains forbidden characters"],
      [" ", "is required"],
    ] as const) {
      const error = refusal(() => {
        validateComputerExecutionSettings({ shell });
      });
      expect(error, shell).toBeInstanceOf(ComputerExecutionSettingsError);
      expect((error as ComputerExecutionSettingsError).field).toBe(
        "execution.shell",
      );
      expect(error.message).toBe(`execution.shell: ${rule}`);
      expect(
        refusal(() => {
          validateShellPath(shell);
        }).message,
      ).toBe(rule);
    }
    expect(
      JSON.stringify(
        computerExecutionSettingsShape.encode({
          shell: "/usr/bin/zsh",
          variables: [{ name: "A", value: "" }],
        }),
      ),
    ).toBe('{"variables":[{"name":"A","value":""}],"shell":"/usr/bin/zsh"}');
    expect(computerExecutionSettingsShape.encode({ shell: "" })).toEqual({});
  });

  // Contract: an image's shells name each path once, each by its final
  // element, within the bound; one file may be listed under two names.
  it("judges an image's shells", () => {
    expect(() => {
      validateImageShells([]);
    }).not.toThrow();
    expect(() => {
      validateImageShells([
        { name: "sh", path: "/bin/sh" },
        { name: "bash", path: "/bin/bash" },
        { name: "zsh", path: "/usr/bin/zsh" },
      ]);
    }).not.toThrow();
    const tooMany: ImageShell[] = Array.from(
      { length: MAX_IMAGE_SHELLS + 1 },
      (_, index) => ({
        name: `sh${String(index)}`,
        path: `/opt/sh${String(index)}`,
      }),
    );
    for (const [shells, message] of [
      [
        [{ name: "zsh", path: "zsh" }],
        "[0].path must be a clean absolute POSIX path",
      ],
      [
        [{ name: "zsh", path: "/bin/bash" }],
        "[0].name must be the final element of its path",
      ],
      [
        [
          { name: "bash", path: "/bin/bash" },
          { name: "bash", path: "/bin/bash" },
        ],
        "[1].path duplicates [0]",
      ],
      [tooMany, "must list at most 16 shells"],
    ] as const) {
      expect(
        refusal(() => {
          validateImageShells(shells);
        }).message,
      ).toBe(message);
    }
  });

  // Contract: an update states at least one field; each stated field is
  // judged, a refused computer field carrying, as its cause, a
  // ComputerExecutionSettingsError whose field is the path within the update; and a
  // client alone changes nothing.
  it("judges an update field by field", () => {
    for (const request of [
      { idleTimeout: "never" },
      { image: { idyl: "ubuntu-24.04" } },
      { isolation: "vm" },
      { isolation: "secure-container", image: { idyl: "ubuntu-24.04" } },
      { cpu: decodeCpu("2") },
      { cpu: null },
      { memory: null },
      { network: null },
      { shell: "/usr/bin/zsh" },
      { shell: null },
      { setVariables: [{ name: "LOG_LEVEL", value: "debug" }] },
      { removeVariables: ["LOG_LEVEL"] },
    ] satisfies UpdateComputerRequest[]) {
      expect(() => {
        validateUpdateComputerRequest(request);
      }, JSON.stringify(request)).not.toThrow();
    }
    expect(
      refusal(() => {
        validateUpdateComputerRequest({ client: "cli" });
      }).message,
    ).toBe("computer update states no field");
    expect(
      refusal(() => {
        validateUpdateComputerRequest({ isolation: "", client: "cli" });
      }).message,
    ).toBe("computer update states no field");
    expect(
      refusal(() => {
        validateUpdateComputerRequest({ isolation: "microvm" });
      }).message,
    ).toBe("computer update: isolation: must be secure-container or vm");
    expect(
      refusal(() => {
        validateUpdateComputerRequest({ cpu: null, client: "agent" });
      }).message,
    ).toBe('computer update: client: unknown computer session client "agent"');

    const cases: readonly [UpdateComputerRequest, string][] = [
      [{ image: { idyl: "ubuntu-24.04", ref: "python:3.12" } }, "image"],
      [{ image: { ref: "python 3.12" } }, "image.ref"],
      [{ isolation: "microvm" }, "isolation"],
      [{ cpu: decodeCpu("0") }, "cpu"],
      [{ memory: decodeMemory("0") }, "memory"],
      [{ network: { class: "unrestricted" } }, "network"],
      [{ shell: "" }, "shell"],
      [{ shell: "zsh" }, "shell"],
      [
        {
          setVariables: [
            { name: "A", value: "" },
            { name: "IDYL_TOKEN", value: "" },
          ],
        },
        "setVariables[1].name",
      ],
      [
        {
          setVariables: [
            { name: "A", value: "" },
            { name: "A", value: "" },
          ],
        },
        "setVariables[1].name",
      ],
      [
        { setVariables: [{ name: "A", value: "a\u0000b" }] },
        "setVariables[0].value",
      ],
      [
        { setVariables: [{ name: "A", value: "x".repeat(16 * 1024) }] },
        "execution",
      ],
      [{ removeVariables: ["1BAD"] }, "removeVariables[0]"],
      [{ removeVariables: ["A", "A"] }, "removeVariables[1]"],
      [
        { setVariables: [{ name: "A", value: "" }], removeVariables: ["A"] },
        "removeVariables[0]",
      ],
    ];
    for (const [request, field] of cases) {
      const error = refusal(() => {
        validateUpdateComputerRequest(request);
      });
      expect(error.cause, field).toBeInstanceOf(ComputerExecutionSettingsError);
      expect((error.cause as ComputerExecutionSettingsError).field).toBe(field);
      expect(error.message.startsWith(`computer update: ${field}: `)).toBe(
        true,
      );
    }
    expect(
      refusal(() => {
        validateUpdateComputerRequest({ cpu: decodeCpu("0") });
      }).message,
    ).toBe(
      "computer update: cpu: must be greater than zero; null returns it to the default",
    );
    expect(
      refusal(() => {
        validateUpdateComputerRequest({ shell: "" });
      }).message,
    ).toBe(
      "computer update: shell: must not be empty; null returns it to the default",
    );
  });

  // Contract: the encoding writes exactly the fields an update states, in a
  // fixed order: a setting with a value as the value, one returned to its
  // default as null, and nothing for a field left out.
  it("writes only the fields an update states", () => {
    const cases: readonly [UpdateComputerRequest, string][] = [
      [{ idleTimeout: "never" }, '{"idleTimeout":"never"}'],
      [{ cpu: decodeCpu("2") }, '{"cpu":"2"}'],
      [
        { client: "cli", network: null, memory: null, cpu: null },
        '{"cpu":null,"memory":null,"network":null,"client":"cli"}',
      ],
      [
        {
          removeVariables: ["B"],
          setVariables: [{ name: "A", value: "" }],
          image: { ref: "python:3.12" },
        },
        '{"image":{"ref":"python:3.12"},"setVariables":[{"name":"A","value":""}],"removeVariables":["B"]}',
      ],
      [
        { setVariables: [], removeVariables: [], client: "", cpu: null },
        '{"cpu":null}',
      ],
      [{ shell: "/usr/bin/zsh" }, '{"shell":"/usr/bin/zsh"}'],
      [
        { size: "small", isolation: "vm", image: { idyl: "ubuntu-24.04" } },
        '{"image":{"idyl":"ubuntu-24.04"},"isolation":"vm","size":"small"}',
      ],
      [{ isolation: "", cpu: null }, '{"cpu":null}'],
      [
        { client: "cli", shell: null, network: null },
        '{"network":null,"shell":null,"client":"cli"}',
      ],
    ];
    for (const [request, wire] of cases) {
      expect(JSON.stringify(encodeUpdateComputerRequest(request))).toBe(wire);
    }
  });

  // Contract: the update decodes strictly: an unknown or repeated field, an
  // unknown field inside a stated value, and a null for a field without a
  // default are refused, and a null for cpu, memory, network, or shell is
  // read as a reset.
  it("decodes an update strictly", () => {
    for (const body of [
      '{"computer":{"cpu":"2"}}',
      '{"computerRevision":1,"cpu":"2"}',
      '{"cpu":"2","cpu":"3"}',
      '{"image":{"idyl":"ubuntu-24.04","tag":"x"}}',
      '{"network":{"class":"none","mode":"x"}}',
      '{"setVariables":[{"name":"A","value":"1","secret":"x"}]}',
      '{"image":null}',
      '{"isolation":null}',
      '{"idleTimeout":null}',
      '{"setVariables":null}',
      '{"removeVariables":null}',
      '{"client":null}',
      "[]",
      "null",
    ]) {
      expect(() => decodeText(body, updateComputerRequestShape), body).toThrow(
        StrictDecodeError,
      );
    }
    expect(
      decodeText(
        '{"cpu":null,"memory":"4Gi","network":null}',
        updateComputerRequestShape,
      ),
    ).toEqual({ cpu: null, memory: decodeMemory("4Gi"), network: null });
    expect(decodeText('{"shell":null}', updateComputerRequestShape)).toEqual({
      shell: null,
    });
    expect(
      decodeText('{"isolation":"vm"}', updateComputerRequestShape),
    ).toEqual({ isolation: "vm" });
    expect(
      decodeText('{"shell":"/usr/bin/zsh"}', updateComputerRequestShape),
    ).toEqual({ shell: "/usr/bin/zsh" });
  });

  // Contract: patch levels order by date, then by their number that day, a
  // level without one first; a date that is not on the calendar is refused.
  it("orders and judges patch levels", () => {
    expect(compareComputerImagePatch("2026.01.02", "2026.01.02.1")).toBe(-1);
    expect(compareComputerImagePatch("2026.01.03", "2026.01.02.9")).toBe(1);
    expect(compareComputerImagePatch("2026.01.02.2", "2026.01.02.2")).toBe(0);
    expect(
      refusal(() => {
        validateComputerImagePatch("2026.02.30");
      }).message,
    ).toBe("must name a calendar date");
    expect(() => {
      validateComputerImagePatch("0024.02.29");
    }).not.toThrow();
  });
});

describe("Computer execution settings operations", () => {
  // Contract: a create writes the computer and the client it states; an
  // update writes only the fields it states, a reset as null; the
  // served Computer carries the computer status; the image catalog is read
  // from the Subnet's computer-images route, without a Namespace.
  it("routes the computer, the client, and the catalog", async () => {
    const plane = new FakeControlPlane({
      routes: (request) => {
        if (request.url.host !== subnetHost) return undefined;
        if (request.url.pathname.endsWith("/computer-images")) {
          return json(catalog);
        }
        return json(
          { computer: pending },
          request.method === "POST" ? 201 : 200,
        );
      },
    });
    const computers = plane.client().account.computers;
    const created = await computers.create({
      name: "payments",
      spec: { execution: { network: { class: "none" } } },
      client: "console",
    });
    expect(created.computer.executionSettings?.revision).toBe(3);
    expect(created.computer.executionSettings?.image?.started).toBe(true);
    await computers.update("payments", {
      cpu: decodeCpu("2"),
      memory: null,
      client: "console",
    });
    const images = await plane
      .client({ namespace: undefined })
      .account.computers.listImages();
    expect(images.items[0]?.default).toBe(true);

    const calls = plane.requests.filter(
      (request) => request.url.host === subnetHost,
    );
    expect(
      calls.map((request) => `${request.method} ${request.url.pathname}`),
    ).toEqual([
      `POST ${namespacePathPrefix}/computers`,
      `PATCH ${namespacePathPrefix}/computers/payments`,
      `GET /v1/accounts/${accountId}/subnets/${subnetSlug}/computer-images`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      name: "payments",
      subnet: subnetSlug,
      spec: { execution: { network: { class: "none" } } },
      client: "console",
    });
    expect(calls[1]?.body).toBe('{"cpu":"2","memory":null,"client":"console"}');
  });

  // Contract: a create that states no client writes none.
  it("sends no client unless one is stated", async () => {
    const plane = new FakeControlPlane({
      routes: (request) =>
        request.url.host === subnetHost
          ? json({ computer: pending }, 201)
          : undefined,
    });
    await plane.client().account.computers.create({ name: "payments" });
    const posted = plane.requests.find((request) => request.method === "POST");
    expect(JSON.parse(posted?.body ?? "")).toEqual({
      name: "payments",
      subnet: subnetSlug,
    });
  });
});

describe("the largest size a Computer's Subnet can run", () => {
  // Contract: a served Computer carries the largest size its Subnet can run
  // as the platform reports it and writes it back; a Computer whose status
  // reports none writes none; a size is a name the platform serves, so one this
  // version does not name is carried, written back and in form.
  it("reads and writes largestSize as reported", () => {
    const read = decodeComputer(pending);
    expect(read.executionSettings?.largestSize).toBe("large");
    expect(encodeComputer(read)).toEqual(pending);

    const defaults = decodeComputer(golden("computer.execution-defaults"));
    expect(defaults.executionSettings).not.toHaveProperty("largestSize");
    expect(
      encodeComputer(defaults)["executionSettings"] as JsonObject,
    ).not.toHaveProperty("largestSize");

    const executionSettings = pending["executionSettings"] as JsonObject;
    const newer = decodeComputer({
      ...pending,
      executionSettings: { ...executionSettings, largestSize: "xxl" },
    });
    const largestSize = newer.executionSettings?.largestSize ?? "";
    expect(largestSize).toBe("xxl");
    expect(
      (encodeComputer(newer)["executionSettings"] as JsonObject)["largestSize"],
    ).toBe("xxl");
    expect(() => {
      validateComputerSize(largestSize);
    }).not.toThrow();
  });
});

describe("a Computer's size", () => {
  // Contract: settings state a size or limits, never both, and only the size's
  // form is judged; the platform decides whether it offers the name.
  it("judges a stated size by its form and refuses it beside limits", () => {
    expect(() => {
      validateComputerExecutionSettings({ size: "extra-large" });
    }).not.toThrow();
    const refused = (settings: ComputerExecutionSettings): unknown => {
      try {
        validateComputerExecutionSettings(settings);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const outOfForm = refused({ size: "Small" });
    expect(outOfForm).toBeInstanceOf(ComputerExecutionSettingsError);
    expect((outOfForm as ComputerExecutionSettingsError).field).toBe(
      "execution.size",
    );
    for (const limits of [
      { cpu: decodeCpu("2") },
      { memory: decodeMemory("4Gi") },
    ]) {
      const beside = refused({ size: "small", ...limits });
      expect(beside).toBeInstanceOf(ComputerExecutionSettingsError);
      expect((beside as ComputerExecutionSettingsError).message).toBe(
        "execution.size: must not be stated with cpu or memory",
      );
    }
  });

  // Contract: an update's size replaces the limits together. It is refused
  // beside either limit, a limit returned to its default included, and null is
  // never a size; the disk inputs the platform does not accept are unknown.
  it("flattens the size into an update", () => {
    expect(
      updateComputerRequestShape.encode({ size: "small", client: "cli" }),
    ).toEqual({ size: "small", client: "cli" });
    expect(() => {
      validateUpdateComputerRequest({ size: "small" });
    }).not.toThrow();
    for (const request of [
      { size: "small", cpu: null },
      { size: "small", memory: null },
      { size: "small", cpu: decodeCpu("2") },
      { size: "" },
      { size: "Small" },
    ]) {
      let caught: unknown;
      try {
        validateUpdateComputerRequest(request);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(request)).toBeInstanceOf(TypeError);
      expect((caught as Error).message).toMatch(/^computer update: size: /u);
    }
    expect(() => {
      decodeText('{"size":null}', updateComputerRequestShape);
    }).toThrow("size must not be null");
    expect(() => {
      decodeText('{"headroom":"2Gi"}', updateComputerRequestShape);
    }).toThrow('unknown field "headroom"');
  });

  // Contract: a read states the size, CPU, memory and disk together, which
  // settings as stated may not, and a Computer states its disk nowhere else.
  it("reads the size, limits and disk together", () => {
    const read = decodeComputer({
      ...pending,
      effective: { size: "10Gi", headroom: "2Gi", overSizeBytes: 0 },
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
    });
    const effective = read.executionSettings?.effective;
    expect(effective?.size).toBe("small");
    expect(effective?.sizeLabel).toBe("Small");
    expect(effective?.disk).toEqual(decodeVolume("20Gi"));
    const written = encodeComputer(read);
    expect(written).not.toHaveProperty("effective");
    expect((written["executionSettings"] as JsonObject)["effective"]).toEqual({
      size: "small",
      sizeLabel: "Small",
      cpu: "2",
      memory: "4Gi",
      disk: "20Gi",
    });
  });
});
