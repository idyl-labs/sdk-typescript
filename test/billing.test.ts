// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  Idyl,
  MICROS_PER_DOLLAR,
  TransportError,
  isBillingPlanChangeStateFinal,
  isBillingPurchaseStateFinal,
  isOutOfUsage,
  sizeBelowUsage,
  sizeNotInPlan,
  spendCapReached,
} from "../src/index.js";
import {
  decodeAccountBilling,
  encodeAccountBilling,
  decodeBillingPlanChange,
  encodeUpdateAccountBillingRequest,
  updateAccountBillingRequestShape,
  validateAccountBilling,
  validateBillingPlan,
  validateBillingPlanChange,
  validateComputerSize,
  validateCreateBillingPurchaseRequest,
} from "../src/api/billing.js";
import { decodeText } from "../src/internal/strictdecode.js";
import type { JsonObject } from "../src/resource/json.js";
import {
  FakeControlPlane,
  errorResponse,
  json,
  type RouteHandler,
} from "./fakes/control-plane.js";
import {
  accountId,
  subnetSlug,
  type RecordedRequest,
} from "./fakes/fetch-queue.js";
import { testCredential } from "./fakes/keys.js";
import { decodeCpu } from "../src/resource/cpu.js";
import { decodeMemory } from "../src/resource/memory.js";
import { decodeVolume, type VolumeUnit } from "../src/resource/volume.js";
import { computerHost, endpoints } from "./fakes/network.js";

const accountPath = `/v1/accounts/${accountId}`;
const billingPath = `${accountPath}/billing`;
const planChangeId = "01954e20-7540-7ec4-93ec-14f783e6ab51";
const purchaseId = "01954e20-7540-7ec4-93ec-14f783e6ab52";

/** A billing golden's text, as the platform serves it. */
function goldenText(name: string): string {
  return readFileSync(
    new URL(
      `./conformance/fixtures/api/testdata/golden/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
}

/** A billing golden, parsed. */
function golden(name: string): JsonObject {
  return JSON.parse(goldenText(name)) as JsonObject;
}

/** A response serving a golden's text. */
function served(name: string, status = 200): Response {
  return new Response(goldenText(name), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/**
 * A fake IDYL network: the current-account route, the network's public
 * metadata and the Account's discovery, and the billing routes a test
 * answers on the global API.
 */
function network(routes: RouteHandler): {
  readonly idyl: Idyl;
  readonly requests: RecordedRequest[];
  readonly bodies: unknown[];
  readonly calls: () => string[];
} {
  const bodies: unknown[] = [];
  const plane = new FakeControlPlane({
    routes: async (request, body) => {
      const { host, pathname } = request.url;
      if (host === "identity.example.test" && pathname === "/account") {
        return json({ id: accountId, email: "", displayName: "" });
      }
      if (host === "meta.example.test" && pathname === "/v1/network") {
        return json({ computerSubnet: subnetSlug });
      }
      if (
        host === "api.example.test" &&
        pathname === `${accountPath}/deployable-subnet-identities`
      ) {
        return json({
          identities: [
            {
              slug: subnetSlug,
              status: "active",
              hosts: { api: computerHost },
              regionEnabled: true,
              approvedForAccount: true,
              developerAdmitted: true,
            },
          ],
        });
      }
      if (host !== "api.example.test") return undefined;
      if (request.body !== undefined) bodies.push(body);
      return await routes(request, body);
    },
  });
  const idyl = new Idyl({
    credential: testCredential,
    endpoints,
    fetch: plane.fetch,
  });
  return {
    idyl,
    requests: plane.requests,
    bodies,
    calls: () =>
      plane.requests
        .filter((request) => request.url.host === "api.example.test")
        .map(
          (request) =>
            `${request.method} ${request.url.pathname}${request.url.search}`,
        ),
  };
}

/** Routes each `METHOD path?query` to the golden it serves. */
function goldens(table: Readonly<Record<string, string>>): RouteHandler {
  return (request) => {
    const name =
      table[`${request.method} ${request.url.pathname}${request.url.search}`];
    return name === undefined ? undefined : served(name);
  };
}

describe("idyl.billing", () => {
  // Contract: the billing read, the settings update, the plan change, the
  // portal session and the purchases address the Account's billing routes
  // on the global API with the reference contract's methods; each body is
  // the request's own encoding, a removed cap is sent as null, and each
  // answer is the served object's public view.
  it("addresses every billing route on the wire", async () => {
    const { idyl, bodies, calls } = network(
      goldens({
        [`GET ${billingPath}`]: "billing.get-response.json",
        [`PATCH ${billingPath}`]: "billing.get-response.json",
        [`POST ${billingPath}/plan-changes`]:
          "billing-plan-change.create-response.json",
        [`GET ${billingPath}/plan-changes/${planChangeId}`]:
          "billing-plan-change.get-response.json",
        [`POST ${billingPath}/portal-sessions`]:
          "billing-portal-session.create-response.json",
        [`POST ${billingPath}/purchases`]:
          "billing-purchase.create-response.json",
        [`GET ${billingPath}/purchases/${purchaseId}`]:
          "billing-purchase.get-response.json",
        [`GET ${billingPath}/purchases?limit=10&offset=20`]:
          "billing-purchases.list-page.json",
      }),
    );
    const { billing } = idyl;

    const read = await billing.get();
    const status = (
      golden("billing.get-response.json")["billing"] as JsonObject
    )["status"] as JsonObject;
    expect(read).toEqual({
      spec: { autoRefill: { enabled: false, amountMicros: 20_000_000 } },
      status: {
        plan: "trial",
        periodStart: "2026-10-12T00:00:00Z",
        periodEnd: "2026-11-12T00:00:00Z",
        allowanceMicros: 1_000_000,
        usedMicros: 0,
        extraBalanceMicros: 0,
        extraBoughtMicros: 0,
        standing: "ok",
        lifecycle: "trial",
        renewal: "ok",
        largestSize: "medium",
        storedData: "10Gi",
        hasInvoices: false,
        sizePlans: status["sizePlans"],
        plans: status["plans"],
        sizeRates: status["sizeRates"],
        storageMicrosPerGiBMonth: status["storageMicrosPerGiBMonth"],
        downloadMicrosPerGiB: status["downloadMicrosPerGiB"],
      },
    });
    expect(Object.isFrozen(read.status)).toBe(true);
    expect(
      read.status.plans.map((offer) => [offer.plan, offer.storedData]),
    ).toEqual([
      ["trial", "10Gi"],
      ["none", "10Gi"],
      ["pro", "400Gi"],
      ["max", "2Ti"],
      ["ultra", "10Ti"],
    ]);
    const updated = await billing.update({ spendCapMicros: null });
    expect(updated.status.plan).toBe("trial");
    const change = await billing.createPlanChange({
      plan: "max",
      idempotencyKey: "plan-1",
    });
    expect(change).toEqual({
      id: planChangeId,
      plan: "pro",
      state: "pending",
      action: {
        kind: "checkout",
        url: "https://checkout.example.com/pay/session-1",
        expiresAt: "2026-10-28T09:00:00Z",
      },
    });
    const changed = await billing.getPlanChange(planChangeId);
    expect(changed.action?.kind).toBe("confirm_payment");
    const portal = await billing.createPortalSession();
    expect(portal).toEqual({
      url: "https://portal.example.com/session/portal-3",
    });
    const bought = await billing.purchases.create({
      amountMicros: 20 * MICROS_PER_DOLLAR,
    });
    expect(bought.state).toBe("pending");
    const purchase = await billing.purchases.get(purchaseId);
    expect(purchase).toEqual({
      id: purchaseId,
      kind: "manual",
      amountMicros: 10_000_000,
      state: "paid",
      createdAt: "2026-10-27T09:00:00Z",
    });
    const page = await billing.purchases.listPage({
      limit: 10,
      continue: "20",
    });
    expect(page.items.map((item) => [item.kind, item.reason])).toEqual([
      ["auto_refill", "PAYMENT_DECLINED"],
      ["manual", undefined],
    ]);
    expect(page.continue).toBeUndefined();

    expect(bodies).toEqual([
      { spendCapMicros: null },
      { plan: "max", idempotencyKey: "plan-1" },
      { amountMicros: 20_000_000 },
    ]);
    expect(calls()).toEqual([
      `GET ${billingPath}`,
      `PATCH ${billingPath}`,
      `POST ${billingPath}/plan-changes`,
      `GET ${billingPath}/plan-changes/${planChangeId}`,
      `POST ${billingPath}/portal-sessions`,
      `POST ${billingPath}/purchases`,
      `GET ${billingPath}/purchases/${purchaseId}`,
      `GET ${billingPath}/purchases?limit=10&offset=20`,
    ]);
  });

  // Contract: list walks the purchases page by page, by offset, until the
  // served total is reached.
  it("walks every purchase", async () => {
    const page = (offset: number): Response =>
      json({
        items: [
          {
            ...(golden("billing-purchase.paid.json") as Record<
              string,
              unknown
            >),
            id: `01954e20-7540-7ec4-93ec-14f783e6ab6${String(offset)}`,
          },
        ],
        totalCount: 2,
      });
    const { idyl, calls } = network((request) =>
      request.url.pathname === `${billingPath}/purchases`
        ? page(Number(request.url.searchParams.get("offset") ?? "0"))
        : undefined,
    );
    const ids: string[] = [];
    for await (const purchase of idyl.billing.purchases.list({ limit: 1 })) {
      ids.push(purchase.id);
    }
    expect(ids).toEqual([
      "01954e20-7540-7ec4-93ec-14f783e6ab60",
      "01954e20-7540-7ec4-93ec-14f783e6ab61",
    ]);
    expect(calls()).toEqual([
      `GET ${billingPath}/purchases?limit=1`,
      `GET ${billingPath}/purchases?limit=1&offset=1`,
    ]);
  });

  // Contract: a request the billing types refuse, an amount that is not a
  // whole number of micro-dollars, and an identifier that is not a
  // canonical UUID throw a TypeError with the sentence the reference
  // contract refuses them with, before anything is sent, the Account read
  // included.
  it("refuses an invalid request before anything is sent", async () => {
    const { idyl, requests } = network(() => undefined);
    const { billing } = idyl;
    await expect(billing.update({})).rejects.toThrow(
      new TypeError("billing update states no field"),
    );
    await expect(
      billing.update({
        autoRefill: { enabled: true, amountMicros: 20 * MICROS_PER_DOLLAR },
        spendCapMicros: null,
      }),
    ).rejects.toThrow(
      "billing update: autoRefill can be enabled only with spendCapMicros set",
    );
    await expect(billing.update({ spendCapMicros: 1.5 })).rejects.toThrow(
      "spendCapMicros must be a whole number of micro-dollars",
    );
    await expect(billing.createPlanChange({ plan: "Max 5x" })).rejects.toThrow(
      TypeError,
    );
    await expect(billing.getPlanChange("not-a-uuid")).rejects.toThrow(
      "billing plan change ID must be a canonical UUID",
    );
    await expect(
      billing.purchases.create({ amountMicros: 20_500_000 }),
    ).rejects.toThrow(
      "amountMicros must be a positive whole number of dollars",
    );
    await expect(
      billing.purchases.create({ amountMicros: 2 ** 60 }),
    ).rejects.toThrow("amountMicros must be a whole number of micro-dollars");
    await expect(
      billing.purchases.create({
        amountMicros: 20 * MICROS_PER_DOLLAR,
        idempotencyKey: "k".repeat(65),
      }),
    ).rejects.toThrow("idempotencyKey must be at most 64 bytes");
    await expect(
      billing.purchases.get(purchaseId.toUpperCase()),
    ).rejects.toThrow("billing purchase ID must be a canonical UUID");
    await expect(billing.purchases.listPage({ limit: 0 })).rejects.toThrow(
      "limit must be a positive integer",
    );
    expect(requests).toEqual([]);
  });

  // Contract: a rate states the size it prices, and a platform that leaves
  // those fields out still validates, writing back nothing it did not state.
  it("reads a rate with or without the size it prices", () => {
    const document = golden("billing.trial.json");
    const status = document["status"] as JsonObject;
    const bare = { size: "xs", perHourMicros: 50_000 };
    const read = decodeAccountBilling({
      ...document,
      status: { ...status, sizeRates: [bare] },
    });
    expect(() => {
      validateAccountBilling(read);
    }).not.toThrow();
    const written = encodeAccountBilling(read)["status"] as JsonObject;
    expect(written["sizeRates"]).toEqual([bare]);

    const full = decodeAccountBilling(document).status.sizeRates[0];
    expect(full?.label).toBe("XS");
    expect(full?.cpu).toEqual(decodeCpu("1"));
    expect(full?.memory).toEqual(decodeMemory("2Gi"));
    expect(full?.disk).toEqual(decodeVolume("10Gi"));
    expect(full?.default).toBe(true);
  });

  // Contract: a plan's stored-data limit is optional on the wire. A read
  // that states none validates and writes none back; one that states it
  // carries it as a volume quantity; an invalid unit is refused under
  // `storedData`.
  it("reads a plan with or without a stored-data limit", () => {
    const document = golden("billing.trial.json");
    const status = document["status"] as JsonObject;
    const plans = status["plans"] as JsonObject[];
    const withoutStoredData = (value: JsonObject): JsonObject =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "storedData"),
      );
    const bare = plans.map(withoutStoredData);
    const withoutLimit = withoutStoredData(status);
    const read = decodeAccountBilling({
      ...document,
      status: { ...withoutLimit, plans: bare },
    });
    expect(read.status.storedData).toBeUndefined();
    expect(
      read.status.plans.every((offer) => offer.storedData === undefined),
    ).toBe(true);
    expect(() => {
      validateAccountBilling(read);
    }).not.toThrow();
    const written = encodeAccountBilling(read)["status"] as JsonObject;
    expect(written).not.toHaveProperty("storedData");
    expect(written["plans"]).toEqual(bare);

    const billing = decodeAccountBilling(document);
    const full = billing.status;
    expect(full.storedData).toEqual(decodeVolume("10Gi"));
    expect(
      full.plans.find((offer) => offer.plan === "max")?.storedData,
    ).toEqual(decodeVolume("2Ti"));

    const invalid = {
      ...billing,
      status: {
        ...full,
        storedData: { value: 1, unit: "Pi" as VolumeUnit },
      },
    };
    expect(
      refusal(() => {
        validateAccountBilling(invalid);
      }),
    ).toBe('status: storedData: unknown volume unit "Pi"');
  });

  // Contract: the rates are the ones the Account's Computers are charged.
  // With no place charging its own, the default rates are returned and the
  // client's placement is not read; when the read names places that do,
  // the client's one place is resolved, and its rates replace the
  // default when it is among them.
  it("returns the rates the Account's Computers are charged", async () => {
    const own = golden("billing.update-response.json");
    const record = own["billing"] as JsonObject;
    const status = record["status"] as JsonObject;
    const overrides = status["subnetSizeRates"] as JsonObject[];
    const charged = [
      { size: "xs", perHourMicros: 70_000 },
      { size: "small", perHourMicros: 140_000 },
    ];
    const responses = [
      served("billing.get-response.json"),
      served("billing.update-response.json"),
      json({
        billing: {
          ...record,
          status: {
            ...status,
            subnetSizeRates: [
              ...overrides,
              { subnet: subnetSlug, sizeRates: charged },
            ],
          },
        },
      }),
    ];
    const { idyl, requests } = network(() => responses.shift());
    const placementReads = (): number =>
      requests.filter((request) => request.url.host === "meta.example.test")
        .length;

    const defaults = await idyl.billing.get();
    expect(defaults.status.sizeRates).toEqual(status["sizeRates"]);
    expect(placementReads()).toBe(0);

    const elsewhere = await idyl.billing.get();
    expect(elsewhere.status.sizeRates).toEqual(status["sizeRates"]);
    expect(placementReads()).toBe(1);
    expect(elsewhere).not.toHaveProperty("status.subnetSizeRates");
    expect(elsewhere.spec).toEqual({
      autoRefill: { enabled: false, amountMicros: 50_000_000 },
      spendCapMicros: 100_000_000,
    });
    expect(elsewhere.status.scheduledChange).toEqual({
      plan: "none",
      at: "2026-11-12T00:00:00Z",
      largestSize: "medium",
    });
    expect(elsewhere.status.autoRefillStopped).toEqual({
      reason: "PAYMENT_DECLINED",
      at: "2026-10-27T09:00:00Z",
    });

    const here = await idyl.billing.get();
    expect(here.status.sizeRates).toEqual(charged);
    expect(placementReads()).toBe(1);
  });

  // Contract: a status whose period's allowance was withheld says why, and
  // its allowance is zero; a status whose allowance was not withheld
  // carries no reason.
  it("says why an allowance was withheld", async () => {
    const responses = [
      json({ billing: golden("billing.trial-withheld.json") }),
      served("billing.get-response.json"),
    ];
    const { idyl } = network(() => responses.shift());

    const withheld = await idyl.billing.get();
    expect(withheld.status.allowanceWithheld).toBe("trial_one_per_person");
    expect(withheld.status.allowanceMicros).toBe(0);
    expect(withheld.status.standing).toBe("out");

    const granted = await idyl.billing.get();
    expect(granted.status).not.toHaveProperty("allowanceWithheld");
  });

  // Contract: each plan states the vCPU an Account on it keeps awake at
  // once, and a status under a rate card with a free trial states how long
  // files are kept and when each deletion warning goes, in milliseconds,
  // longest first. A status under a rate card with no trial states neither.
  it("reads each plan's awake vCPU limit and the file terms", async () => {
    const responses = [
      json({ billing: golden("billing.paid-full.json") }),
      served("billing.get-response.json"),
    ];
    const { idyl } = network(() => responses.shift());
    const day = 24 * 60 * 60 * 1000;

    const paid = await idyl.billing.get();
    expect(
      paid.status.plans.map((offer) => [offer.plan, offer.awakeVCPU]),
    ).toEqual([
      ["trial", 8],
      ["none", 8],
      ["pro", 100],
      ["max", 500],
      ["ultra", 2500],
    ]);
    expect(paid.status.fileRetentionMs).toBe(90 * day);
    expect(paid.status.deletionWarningsMs).toEqual([30 * day, 7 * day, day]);

    const trial = await idyl.billing.get();
    expect(trial.status).not.toHaveProperty("fileRetentionMs");
    expect(trial.status).not.toHaveProperty("deletionWarningsMs");
  });

  // Contract: an amount that cannot be shown as the number it is, past
  // the safe-integer range or not a number, makes the response unreadable
  // rather than reading as another amount.
  it("refuses an amount past the safe-integer range", async () => {
    const text = goldenText("billing.get-response.json").replace(
      '"extraBalanceMicros": 0',
      '"extraBalanceMicros": 9223372036854775807',
    );
    const { idyl } = network(
      () =>
        new Response(text, {
          headers: { "content-type": "application/json" },
        }),
    );
    const error: unknown = await idyl.billing.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe("invalid_response");
  });

  // Contract: a billing refusal reaches the caller as the ApiError the
  // platform answered with, classified by code.
  it("rejects with the platform's refusal", async () => {
    const { idyl } = network(() =>
      errorResponse(402, "EXTRA_USAGE_NOT_IN_PLAN", "no extra usage"),
    );
    const error: unknown = await idyl.billing.purchases
      .create({ amountMicros: 10 * MICROS_PER_DOLLAR })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("EXTRA_USAGE_NOT_IN_PLAN");
  });
});

describe("idyl.deleteAccount", () => {
  // Contract: a delete addresses the Account the credential acts as with
  // DELETE on the global API, sends no body, and returns whether IDYL
  // accepted it.
  it("deletes the Account the credential acts as", async () => {
    const { idyl, requests, calls } = network((request) =>
      request.method === "DELETE" && request.url.pathname === accountPath
        ? json({ accepted: true })
        : undefined,
    );
    expect(await idyl.deleteAccount()).toEqual({ accepted: true });
    expect(calls()).toEqual([`DELETE ${accountPath}`]);
    expect(requests.at(-1)?.body).toBeUndefined();
  });

  // Contract: a refused delete rejects with the platform's ApiError, and a
  // response that is not an object is an invalid response.
  it("rejects a refusal and an unreadable answer", async () => {
    const answers = [
      errorResponse(403, "forbidden", "not permitted"),
      json(null),
    ];
    const { idyl } = network(() => answers.shift());
    const refused: unknown = await idyl
      .deleteAccount()
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(403);
    const unreadable: unknown = await idyl
      .deleteAccount()
      .catch((e: unknown) => e);
    expect(unreadable).toBeInstanceOf(TransportError);
  });
});

describe("billing contract", () => {
  // Contract: a read carries a field and a token this package does not
  // name, and validation then refuses the token, so a newer platform never
  // breaks a read.
  it("reads leniently and judges on validate", () => {
    const document = golden("billing.trial.json");
    const status = document["status"] as JsonObject;
    const read = decodeAccountBilling(
      JSON.stringify({
        ...document,
        status: { ...status, standing: "frozen", addedLater: true },
      }),
    );
    expect(read.status.standing).toBe("frozen");
    expect((read.status as unknown as JsonObject)["addedLater"]).toBe(true);
    expect(
      refusal(() => {
        validateAccountBilling(read);
      }),
    ).toBe('status: standing: unknown billing standing "frozen"');
  });

  // Contract: an amount past the safe-integer range reads exactly, as a
  // bigint, and is judged by its exact value.
  it("carries amounts past the safe-integer range exactly", () => {
    const text = JSON.stringify(golden("billing.trial.json")).replace(
      '"extraBalanceMicros":0',
      '"extraBalanceMicros":9223372036854775807',
    );
    const read = decodeAccountBilling(text);
    expect(read.status.extraBalanceMicros).toBe(9223372036854775807n);
    expect(() => {
      validateAccountBilling(read);
    }).not.toThrow();
    expect(
      refusal(() => {
        validateCreateBillingPurchaseRequest({
          amountMicros: 9_000_000_000_000_000_001n,
        });
      }),
    ).toBe("amountMicros must be a positive whole number of dollars");
  });

  // Contract: a settings update is read strictly as the route binds it: a
  // null spend cap removes the cap, a null auto-refill and an unknown field
  // are refused, and an encoded update writes only the fields it states.
  it("binds a settings update strictly", () => {
    expect(
      decodeText('{"spendCapMicros":null}', updateAccountBillingRequestShape),
    ).toEqual({ spendCapMicros: null });
    expect(
      refusal(() =>
        decodeText('{"autoRefill":null}', updateAccountBillingRequestShape),
      ),
    ).toBe("autoRefill must not be null");
    expect(
      refusal(() =>
        decodeText('{"spendCap":1}', updateAccountBillingRequestShape),
      ),
    ).toBe('unknown field "spendCap"');
    expect(encodeUpdateAccountBillingRequest({})).toEqual({});
    expect(
      encodeUpdateAccountBillingRequest({ spendCapMicros: 5_000_000 }),
    ).toEqual({ spendCapMicros: 5_000_000 });
  });

  // Contract: a plan is an identifier judged by form only, a size by
  // membership, and an operation's state is final exactly where the
  // reference contract says so; a state this package does not name is not
  // final.
  it("judges plans, sizes, and final states as the reference contract does", () => {
    expect(() => {
      validateBillingPlan("team_2026");
    }).not.toThrow();
    expect(
      refusal(() => {
        validateBillingPlan("");
      }),
    ).toBe("billing plan is required");
    expect(() => {
      validateComputerSize("xxl");
    }).not.toThrow();
    expect(
      refusal(() => {
        validateComputerSize("XXL");
      }),
    ).toBe(
      'computer size "XXL" must be 1 to 32 lowercase letters, digits and hyphens, beginning with a letter',
    );
    expect(
      refusal(() => {
        validateComputerSize("");
      }),
    ).toBe("computer size is required");
    expect(
      ["pending", "applied", "scheduled", "failed", "later"].map(
        isBillingPlanChangeStateFinal,
      ),
    ).toEqual([false, true, true, true, false]);
    expect(
      ["pending", "paid", "failed", "later"].map(isBillingPurchaseStateFinal),
    ).toEqual([false, true, true, false]);
    const change = decodeBillingPlanChange(
      golden("billing-plan-change.pending.json"),
    );
    expect(change.effectiveAt).toBeUndefined();
  });

  // Contract: a failed plan change carries one of the four reasons the
  // reference contract names; a reason it does not name, or none, is
  // refused.
  it("judges a failed plan change's reason as the reference contract does", () => {
    const failed = (reason?: string) =>
      decodeBillingPlanChange({
        id: "0b0f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
        plan: "max",
        state: "failed",
        ...(reason === undefined ? {} : { reason }),
      });
    for (const reason of [
      "PAYMENT_DECLINED",
      "ACTION_EXPIRED",
      "PLAN_CHANGE_SUPERSEDED",
      "PLAN_CHANGE_UNAVAILABLE",
    ]) {
      expect(() => {
        validateBillingPlanChange(failed(reason));
      }).not.toThrow();
    }
    for (const reason of [undefined, "SPEND_CAP_REACHED"]) {
      expect(() => {
        validateBillingPlanChange(failed(reason));
      }).toThrow(TypeError);
    }
  });
});

describe("billing refusal helpers", () => {
  const apiError = (code: string, details?: JsonObject): ApiError =>
    new ApiError({
      status: 402,
      message: "refused",
      code,
      ...(details === undefined ? {} : { details }),
    });

  // Contract: each helper recognizes only its own code, and reads the
  // refusal's details as a response is read: a key it does not name is
  // ignored, and a key absent or carried in another form reads as zero or
  // the empty string.
  it("recognize their code and read its details", () => {
    expect(isOutOfUsage(apiError("OUT_OF_USAGE"))).toBe(true);
    expect(isOutOfUsage(apiError("SIZE_NOT_IN_PLAN"))).toBe(false);
    expect(isOutOfUsage(new Error("OUT_OF_USAGE"))).toBe(false);

    expect(
      sizeNotInPlan(
        apiError("SIZE_NOT_IN_PLAN", {
          size: "xl",
          largestSize: "large",
          plan: "max",
          planName: "Max 5x",
          added: "ignored",
        }),
      ),
    ).toEqual({
      size: "xl",
      largestSize: "large",
      plan: "max",
      planName: "Max 5x",
    });
    expect(
      sizeNotInPlan(
        apiError("SIZE_NOT_IN_PLAN", { size: 7, largestSize: "large" }),
      ),
    ).toEqual({ size: "", largestSize: "large", plan: "", planName: "" });
    expect(sizeNotInPlan(apiError("OUT_OF_USAGE"))).toBeUndefined();

    expect(
      sizeBelowUsage(
        apiError("SIZE_BELOW_USAGE", {
          usedBytes: 31_000_000_000,
          sizeBytes: 20_000_000_000,
          computerSize: "small",
        }),
      ),
    ).toEqual({
      usedBytes: 31_000_000_000,
      sizeBytes: 20_000_000_000,
      computerSize: "small",
    });
    expect(
      sizeBelowUsage(apiError("SIZE_BELOW_USAGE", { usedBytes: -1 })),
    ).toEqual({ usedBytes: 0, sizeBytes: 0, computerSize: "" });

    expect(
      spendCapReached(
        apiError("SPEND_CAP_REACHED", {
          spendCapMicros: 100_000_000,
          boughtMicros: 90_000_000,
        }),
      ),
    ).toEqual({ spendCapMicros: 100_000_000, boughtMicros: 90_000_000 });
    expect(
      spendCapReached(apiError("SPEND_CAP_REACHED", { boughtMicros: 1.5 })),
    ).toEqual({ spendCapMicros: 0, boughtMicros: 0 });
    expect(spendCapReached(apiError("SIZE_BELOW_USAGE"))).toBeUndefined();
  });
});
