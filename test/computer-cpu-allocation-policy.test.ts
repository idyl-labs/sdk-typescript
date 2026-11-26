// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  decodeComputer,
  encodeComputer,
  encodeUpdateComputerRequest,
  updateComputerRequestShape,
  validateUpdateComputerRequest,
  type UpdateComputerRequest,
} from "../src/api/computer.js";
import {
  ComputerExecutionSettingsError,
  computerExecutionSettingsShape,
  validateComputerCpuAllocationPolicy,
  validateComputerExecutionSettings,
} from "../src/resource/computer-execution-settings.js";
import { decodeText } from "../src/internal/strictdecode.js";
import { StrictDecodeError } from "../src/resource/decode-error.js";
import { type JsonObject } from "../src/resource/json.js";
import { json } from "./fakes/control-plane.js";
import { FakeNetwork, computerRecord, computersPath } from "./fakes/network.js";

const ID = "01954e20-7540-7ec4-93ec-14f783e6ab04";
const byId = `${computersPath}/by-id/${ID}`;

function refusal(validate: () => void): Error {
  try {
    validate();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("CPU allocation policies", () => {
  // Contract: the policies are full-cores and spread-cores; the empty string
  // is reported as missing, and any other token is refused with the rule.
  it("judge the policy vocabulary", () => {
    for (const policy of ["full-cores", "spread-cores"]) {
      expect(() => {
        validateComputerCpuAllocationPolicy(policy);
      }).not.toThrow();
    }
    expect(
      refusal(() => {
        validateComputerCpuAllocationPolicy("dedicated");
      }).message,
    ).toBe("cpuAllocationPolicy must be full-cores or spread-cores");
    expect(
      refusal(() => {
        validateComputerCpuAllocationPolicy("");
      }).message,
    ).toBe("cpuAllocationPolicy is required");
  });

  // Contract: the settings carry the policy after the tier, leave it out
  // when empty, and refuse an unknown policy under
  // execution.cpuAllocationPolicy.
  it("are stated in a Computer's execution settings", () => {
    const settings = decodeText(
      '{"isolation":"vm","tier":"performance","cpuAllocationPolicy":"spread-cores","size":"small"}',
      computerExecutionSettingsShape,
    );
    expect(settings.cpuAllocationPolicy).toBe("spread-cores");
    expect(() => {
      validateComputerExecutionSettings(settings);
    }).not.toThrow();
    expect(
      JSON.stringify(computerExecutionSettingsShape.encode(settings)),
    ).toBe(
      '{"isolation":"vm","tier":"performance","cpuAllocationPolicy":"spread-cores","size":"small"}',
    );
    expect(
      JSON.stringify(
        computerExecutionSettingsShape.encode({
          cpuAllocationPolicy: "",
          size: "small",
        }),
      ),
    ).toBe('{"size":"small"}');
    const error = refusal(() => {
      validateComputerExecutionSettings({ cpuAllocationPolicy: "dedicated" });
    });
    expect(error).toBeInstanceOf(ComputerExecutionSettingsError);
    expect((error as ComputerExecutionSettingsError).field).toBe(
      "execution.cpuAllocationPolicy",
    );
    expect(error.message).toBe(
      "execution.cpuAllocationPolicy: must be full-cores or spread-cores",
    );
  });

  // Contract: an update states the policy after the tier, never as null; an
  // empty policy states nothing; an unknown policy is refused under the
  // update's own field, cpuAllocationPolicy.
  it("are changed by an update", () => {
    for (const request of [
      { cpuAllocationPolicy: "full-cores" },
      { cpuAllocationPolicy: "spread-cores" },
      { tier: "performance", cpuAllocationPolicy: "spread-cores" },
    ] satisfies UpdateComputerRequest[]) {
      expect(() => {
        validateUpdateComputerRequest(request);
      }, JSON.stringify(request)).not.toThrow();
    }
    expect(
      refusal(() => {
        validateUpdateComputerRequest({
          cpuAllocationPolicy: "",
          client: "cli",
        });
      }).message,
    ).toBe("computer update states no field");
    const error = refusal(() => {
      validateUpdateComputerRequest({ cpuAllocationPolicy: "dedicated" });
    });
    expect(error.message).toBe(
      "computer update: cpuAllocationPolicy: must be full-cores or spread-cores",
    );
    expect(error.cause).toBeInstanceOf(ComputerExecutionSettingsError);
    expect((error.cause as ComputerExecutionSettingsError).field).toBe(
      "cpuAllocationPolicy",
    );
    expect(
      JSON.stringify(
        encodeUpdateComputerRequest({
          size: "small",
          cpuAllocationPolicy: "spread-cores",
          tier: "performance",
        }),
      ),
    ).toBe(
      '{"tier":"performance","cpuAllocationPolicy":"spread-cores","size":"small"}',
    );
    expect(
      JSON.stringify(
        encodeUpdateComputerRequest({ cpuAllocationPolicy: "", cpu: null }),
      ),
    ).toBe('{"cpu":null}');
    expect(
      decodeText(
        '{"cpuAllocationPolicy":"full-cores"}',
        updateComputerRequestShape,
      ),
    ).toEqual({ cpuAllocationPolicy: "full-cores" });
    expect(() =>
      decodeText('{"cpuAllocationPolicy":null}', updateComputerRequestShape),
    ).toThrow(StrictDecodeError);
  });

  // Contract: a read carries the policy the next start uses, a newer policy
  // included, and writes it back as read.
  it("are read from a Computer", () => {
    const read = decodeComputer({
      ...computerRecord(),
      executionSettings: {
        revision: 1,
        pending: false,
        effective: { cpuAllocationPolicy: "full-cores", size: "small" },
      },
    });
    expect(read.executionSettings?.effective.cpuAllocationPolicy).toBe(
      "full-cores",
    );
    const written = encodeComputer(read);
    expect(
      ((written["executionSettings"] as JsonObject)["effective"] as JsonObject)[
        "cpuAllocationPolicy"
      ],
    ).toBe("full-cores");

    const newer = decodeComputer({
      ...computerRecord(),
      executionSettings: {
        revision: 1,
        pending: false,
        effective: { cpuAllocationPolicy: "dedicated" },
      },
    });
    expect(newer.executionSettings?.effective.cpuAllocationPolicy).toBe(
      "dedicated",
    );
  });
});

describe("Computer CPU allocation policies", () => {
  // Contract: a create states the policy under
  // spec.execution.cpuAllocationPolicy; a create that states none sends no
  // policy and runs under full-cores; an unknown policy is refused before
  // any request.
  it("are stated on create", async () => {
    const bodies: unknown[] = [];
    const network = new FakeNetwork((request, body) => {
      if (request.method === "POST" && request.url.pathname === computersPath) {
        bodies.push(body);
        return json({ computer: computerRecord() }, 201);
      }
      return undefined;
    });
    const { computers } = network.client();
    await computers.create({
      name: "api-dev",
      cpuAllocationPolicy: "spread-cores",
    });
    await computers.create({ name: "api-dev" });
    expect(bodies).toEqual([
      {
        name: "api-dev",
        subnet: "550000000002",
        spec: { execution: { cpuAllocationPolicy: "spread-cores" } },
        client: "sdk",
      },
      { name: "api-dev", subnet: "550000000002", client: "sdk" },
    ]);
    const unknown = "dedicated" as "full-cores";
    await expect(
      computers.create({ name: "api-dev", cpuAllocationPolicy: unknown }),
    ).rejects.toThrow(
      "cpuAllocationPolicy: must be full-cores or spread-cores",
    );
    expect(bodies).toHaveLength(2);
  });

  // Contract: an update states the policy on the update request beside the
  // other settings, and an unknown policy is refused before any request.
  it("are changed on update", async () => {
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
    await computer.update({ cpuAllocationPolicy: "spread-cores" });
    await computer.update({ cpuAllocationPolicy: "full-cores", size: "small" });
    const unknown = "dedicated" as "full-cores";
    await expect(
      computer.update({ cpuAllocationPolicy: unknown }),
    ).rejects.toThrow(
      "cpuAllocationPolicy: must be full-cores or spread-cores",
    );
    expect(sent).toEqual([
      { cpuAllocationPolicy: "spread-cores", client: "sdk" },
      { cpuAllocationPolicy: "full-cores", size: "small", client: "sdk" },
    ]);
  });

  // Contract: the snapshot reports the policy as stated and the policy the
  // next start uses; a Computer that reports none hands on none.
  it("are read in the snapshot", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/api-dev`
        ? json({
            computer: computerRecord({
              spec: { execution: { cpuAllocationPolicy: "spread-cores" } },
              executionSettings: {
                revision: 1,
                pending: false,
                effective: { cpuAllocationPolicy: "spread-cores" },
              },
            }),
          })
        : json({ computer: computerRecord() }),
    );
    const { computers } = network.client();
    const computer = await computers.get("api-dev");
    expect(computer.snapshot.settings).toEqual({
      cpuAllocationPolicy: "spread-cores",
    });
    expect(computer.snapshot.effectiveSettings).toEqual({
      cpuAllocationPolicy: "spread-cores",
    });
    const fresh = await computers.get("tools");
    expect(fresh.snapshot.settings.cpuAllocationPolicy).toBeUndefined();
  });
});
