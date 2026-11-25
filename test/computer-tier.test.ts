// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ApiError,
  ERROR_CODE_TIER_NOT_IN_PLAN,
  isApiCode,
  tierNotInPlan,
} from "../src/index.js";
import {
  decodeComputer,
  encodeComputer,
  encodeUpdateComputerRequest,
  updateComputerRequestShape,
  validateUpdateComputerRequest,
  type UpdateComputerRequest,
} from "../src/api/computer.js";
import {
  decodeComputerAwake,
  validateComputerAwake,
} from "../src/api/computer-awake.js";
import {
  ComputerExecutionSettingsError,
  computerExecutionSettingsShape,
  validateComputerExecutionSettings,
  validateComputerTier,
  validateMachineTier,
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

describe("tiers", () => {
  // Contract: a machine tier is one of three and a Computer's tier one of those
  // or best-available; the empty string is reported as missing, and any
  // other token is refused with the rule.
  it("judge the tier vocabularies", () => {
    for (const tier of ["economy", "standard", "performance"]) {
      expect(() => {
        validateMachineTier(tier);
      }).not.toThrow();
      expect(() => {
        validateComputerTier(tier);
      }).not.toThrow();
    }
    expect(() => {
      validateComputerTier("best-available");
    }).not.toThrow();
    expect(
      refusal(() => {
        validateMachineTier("best-available");
      }).message,
    ).toBe("tier must be economy, standard or performance");
    expect(
      refusal(() => {
        validateComputerTier("frontier");
      }).message,
    ).toBe("tier must be economy, standard, performance or best-available");
    expect(
      refusal(() => {
        validateMachineTier("");
      }).message,
    ).toBe("tier is required");
    expect(
      refusal(() => {
        validateComputerTier("");
      }).message,
    ).toBe("tier is required");
  });

  // Contract: the settings carry the tier after the isolation class, leave it
  // out when empty, and refuse an unknown tier under execution.tier.
  it("are stated in a Computer's execution settings", () => {
    const settings = decodeText(
      '{"isolation":"vm","tier":"performance","size":"small"}',
      computerExecutionSettingsShape,
    );
    expect(settings.tier).toBe("performance");
    expect(() => {
      validateComputerExecutionSettings(settings);
    }).not.toThrow();
    expect(
      JSON.stringify(computerExecutionSettingsShape.encode(settings)),
    ).toBe('{"isolation":"vm","tier":"performance","size":"small"}');
    expect(
      JSON.stringify(
        computerExecutionSettingsShape.encode({ tier: "", size: "small" }),
      ),
    ).toBe('{"size":"small"}');
    const error = refusal(() => {
      validateComputerExecutionSettings({ tier: "frontier" });
    });
    expect(error).toBeInstanceOf(ComputerExecutionSettingsError);
    expect((error as ComputerExecutionSettingsError).field).toBe(
      "execution.tier",
    );
    expect(error.message).toBe(
      "execution.tier: must be economy, standard, performance or best-available",
    );
  });

  // Contract: an update states the tier after the isolation class, never as
  // null; an empty tier states nothing; an unknown tier is refused under
  // the update's own field, tier.
  it("are changed by an update", () => {
    for (const request of [
      { tier: "economy" },
      { tier: "best-available" },
      { isolation: "vm", tier: "performance" },
    ] satisfies UpdateComputerRequest[]) {
      expect(() => {
        validateUpdateComputerRequest(request);
      }, JSON.stringify(request)).not.toThrow();
    }
    expect(
      refusal(() => {
        validateUpdateComputerRequest({ tier: "", client: "cli" });
      }).message,
    ).toBe("computer update states no field");
    const error = refusal(() => {
      validateUpdateComputerRequest({ tier: "frontier" });
    });
    expect(error.message).toBe(
      "computer update: tier: must be economy, standard, performance or best-available",
    );
    expect(error.cause).toBeInstanceOf(ComputerExecutionSettingsError);
    expect((error.cause as ComputerExecutionSettingsError).field).toBe("tier");
    expect(
      JSON.stringify(
        encodeUpdateComputerRequest({
          size: "small",
          tier: "performance",
          isolation: "vm",
        }),
      ),
    ).toBe('{"isolation":"vm","tier":"performance","size":"small"}');
    expect(
      JSON.stringify(encodeUpdateComputerRequest({ tier: "", cpu: null })),
    ).toBe('{"cpu":null}');
    expect(
      decodeText('{"tier":"standard"}', updateComputerRequestShape),
    ).toEqual({ tier: "standard" });
    expect(() =>
      decodeText('{"tier":null}', updateComputerRequestShape),
    ).toThrow(StrictDecodeError);
  });

  // Contract: a read carries the tier setting the next start uses and the
  // tier of the machine a running Computer is on, a newer tier included, and
  // writes both back as read.
  it("are read from a Computer", () => {
    const read = decodeComputer({
      ...computerRecord(),
      execution: "running",
      executionSettings: {
        revision: 1,
        pending: false,
        effective: { tier: "best-available", size: "small" },
      },
      awake: { since: "2026-01-02T04:05:06Z", tier: "standard", holds: [] },
    });
    expect(read.executionSettings?.effective.tier).toBe("best-available");
    expect(read.awake?.tier).toBe("standard");
    const written = encodeComputer(read);
    expect(
      ((written["executionSettings"] as JsonObject)["effective"] as JsonObject)[
        "tier"
      ],
    ).toBe("best-available");
    expect((written["awake"] as JsonObject)["tier"]).toBe("standard");

    const newer = decodeComputerAwake({
      since: "2026-01-02T04:05:06Z",
      tier: "frontier",
      holds: [],
    });
    expect(newer.tier).toBe("frontier");
    expect(
      refusal(() => {
        validateComputerAwake(newer);
      }).message,
    ).toBe("tier must be economy, standard or performance");
    expect(() => {
      validateComputerAwake({ ...newer, tier: "performance" });
    }).not.toThrow();
  });
});

describe("Computer tiers", () => {
  // Contract: a create states the tier under spec.execution.tier; a create
  // that states none sends no tier and takes IDYL's default.
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
    await computers.create({ name: "api-dev", tier: "performance" });
    await computers.create({ name: "api-dev" });
    expect(bodies).toEqual([
      {
        name: "api-dev",
        subnet: "550000000002",
        spec: { execution: { tier: "performance" } },
        client: "sdk",
      },
      { name: "api-dev", subnet: "550000000002", client: "sdk" },
    ]);
    const unknown = "frontier" as "standard";
    await expect(
      computers.create({ name: "api-dev", tier: unknown }),
    ).rejects.toThrow(
      "tier: must be economy, standard, performance or best-available",
    );
    expect(bodies).toHaveLength(2);
  });

  // Contract: an update states the tier on the update request beside the
  // other settings, and an unknown tier is refused before any request.
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
    await computer.update({ tier: "economy" });
    await computer.update({ tier: "best-available", size: "small" });
    const unknown = "frontier" as "economy";
    await expect(computer.update({ tier: unknown })).rejects.toThrow(
      "tier: must be economy, standard, performance or best-available",
    );
    expect(sent).toEqual([
      { tier: "economy", client: "sdk" },
      { tier: "best-available", size: "small", client: "sdk" },
    ]);
  });

  // Contract: the snapshot reports the tier as stated, the tier setting the
  // next start uses, and the tier of the machine an awake Computer runs on;
  // a Computer that reports none hands on none.
  it("are read in the snapshot", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/api-dev`
        ? json({
            computer: computerRecord({
              execution: "running",
              spec: { execution: { tier: "best-available" } },
              executionSettings: {
                revision: 1,
                pending: false,
                effective: { tier: "best-available" },
              },
              awake: {
                since: "2026-01-02T04:05:06Z",
                tier: "economy",
                holds: [{ kind: "session", count: 1 }],
              },
            }),
          })
        : json({ computer: computerRecord() }),
    );
    const { computers } = network.client();
    const computer = await computers.get("api-dev");
    expect(computer.snapshot.settings).toEqual({ tier: "best-available" });
    expect(computer.snapshot.effectiveSettings).toEqual({
      tier: "best-available",
    });
    expect(computer.snapshot.awake).toEqual({
      since: "2026-01-02T04:05:06Z",
      tier: "economy",
      holds: [{ kind: "session", count: 1 }],
    });
    const fresh = await computers.get("tools");
    expect(fresh.snapshot.settings.tier).toBeUndefined();
  });

  // Contract: a tier above the plan's highest is refused with
  // TIER_NOT_IN_PLAN, and tierNotInPlan reads its details from the refusal
  // as served.
  it("refused for the plan carry their details", async () => {
    const network = new FakeNetwork((request) =>
      request.method === "POST" && request.url.pathname === computersPath
        ? json(
            {
              error: "the tier performance is not in this Account's plan",
              code: "TIER_NOT_IN_PLAN",
              details: {
                tier: "performance",
                highestTier: "standard",
                plan: "max",
                planName: "Max",
              },
            },
            402,
          )
        : undefined,
    );
    const error = await rejection(
      network.client().computers.create({
        name: "api-dev",
        tier: "performance",
      }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(402);
    expect(isApiCode(error, ERROR_CODE_TIER_NOT_IN_PLAN)).toBe(true);
    expect(tierNotInPlan(error)).toEqual({
      tier: "performance",
      highestTier: "standard",
      plan: "max",
      planName: "Max",
    });
  });
});
