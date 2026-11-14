// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * The codecs of the billing goldens: an Account's billing, its plan
 * changes, its purchases, its portal sessions, the requests their routes
 * bind, the error documents their refusals are served with, and the
 * heterogeneous list of values each type's validation refuses.
 */
import {
  accountBillingShape,
  billingPlanChangeShape,
  billingPurchaseShape,
  createBillingPlanChangeRequestShape,
  createBillingPlanChangeResponseShape,
  createBillingPortalSessionResponseShape,
  createBillingPurchaseRequestShape,
  createBillingPurchaseResponseShape,
  getAccountBillingResponseShape,
  getBillingPlanChangeResponseShape,
  getBillingPurchaseResponseShape,
  listBillingPurchasesResponseShape,
  updateAccountBillingRequestShape,
  updateAccountBillingResponseShape,
  validateAccountBilling,
  validateBillingPlanChange,
  validateBillingPortalSession,
  validateBillingPurchase,
  validateCreateBillingPlanChangeRequest,
  validateCreateBillingPurchaseRequest,
  validateUpdateAccountBillingRequest,
} from "../../src/api/billing.js";
import {
  ERROR_CODE_AUTO_REFILL_NEEDS_SPEND_CAP,
  ERROR_CODE_EXTRA_USAGE_NOT_IN_PLAN,
  ERROR_CODE_OUT_OF_USAGE,
  ERROR_CODE_PLAN_NOT_OFFERED,
  ERROR_CODE_SIZE_NOT_IN_PLAN,
  ERROR_CODE_SPEND_CAP_REACHED,
} from "../../src/api/billing-errors.js";
import { signupOfferShape, validateSignupOffer } from "../../src/api/signup.js";
import { ERROR_CODE_SIZE_BELOW_USAGE } from "../../src/api/storage-errors.js";
import {
  ApiError,
  sizeBelowUsage,
  sizeNotInPlan,
  spendCapReached,
} from "../../src/errors.js";
import {
  always,
  decodeValue,
  jsonObject,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../../src/internal/strictdecode.js";
import { isDeepStrictEqual } from "node:util";
import { parseJson, type JsonObject } from "../../src/resource/json.js";
import type { ServedCodec } from "./served-registry.js";

/** A codec reading `shape` leniently, as every response is read, and judging it with `validate`. */
function codec<T>(
  shape: Shape<T>,
  validate: (value: T) => void,
): ServedCodec<unknown> {
  return {
    decode: (document) =>
      decodeValue(
        typeof document === "string" ? parseJson(document) : document,
        shape,
        "lenient",
      ),
    encode: (value) => shape.encode(value as T),
    validate: (value) => {
      validate(value as T);
    },
  };
}

/**
 * A golden that is an object of named documents, each read through its
 * own shape. A name the table does not hold is carried by a read and not
 * written back, as a lenient read of any object is; `validate` judges each
 * named document.
 */
export function namedDocuments(
  shapes: ReadonlyMap<string, Shape<unknown>>,
  validate: (name: string, value: unknown) => void,
): ServedCodec<Record<string, unknown>> {
  return {
    decode(document) {
      const values = (
        typeof document === "string" ? parseJson(document) : document
      ) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(values).map(([name, value]) => {
          const shape = shapes.get(name);
          return [
            name,
            shape === undefined ? value : decodeValue(value, shape, "lenient"),
          ];
        }),
      );
    },
    encode(value) {
      return Object.fromEntries(
        Object.entries(value).flatMap(([name, item]) => {
          const shape = shapes.get(name);
          return shape === undefined ? [] : [[name, shape.encode(item)]];
        }),
      );
    },
    validate(value) {
      for (const [name, item] of Object.entries(value)) {
        if (shapes.has(name)) validate(name, item);
      }
    },
  };
}

const requestShapes: ReadonlyMap<string, Shape<unknown>> = new Map<
  string,
  Shape<unknown>
>([
  ["updateSetCap", updateAccountBillingRequestShape as Shape<unknown>],
  ["updateRemoveCap", updateAccountBillingRequestShape as Shape<unknown>],
  ["updateAutoRefill", updateAccountBillingRequestShape as Shape<unknown>],
  ["planChange", createBillingPlanChangeRequestShape as Shape<unknown>],
  ["planChangeKeep", createBillingPlanChangeRequestShape as Shape<unknown>],
  ["purchase", createBillingPurchaseRequestShape as Shape<unknown>],
  ["purchaseMinimal", createBillingPurchaseRequestShape as Shape<unknown>],
]);

/**
 * The requests as the routes bind them: each is written back through the
 * one strict decoder, which a route's binding mirrors, and passes the
 * validation the service applies before sending it.
 */
const requests = namedDocuments(requestShapes, (name, value) => {
  const shape = requestShapes.get(name);
  if (shape === undefined) return;
  const bound = decodeValue(shape.encode(value), shape, "strict");
  if (name.startsWith("update")) {
    validateUpdateAccountBillingRequest(bound as never);
  } else if (name.startsWith("planChange")) {
    validateCreateBillingPlanChangeRequest(bound as never);
  } else {
    validateCreateBillingPurchaseRequest(bound as never);
  }
});

interface ServedError {
  readonly error: string;
  readonly code?: string;
  readonly details?: JsonObject;
}

const servedErrorShape: Shape<ServedError> = object<ServedError>({
  error: always(string()),
  code: omitEmpty(string()),
  details: pointer(jsonObject()),
});

/** The code each served refusal is pinned with. */
const servedCodes: ReadonlyMap<string, string> = new Map([
  ["outOfUsage", ERROR_CODE_OUT_OF_USAGE],
  ["sizeNotInPlan", ERROR_CODE_SIZE_NOT_IN_PLAN],
  ["sizeNotInAnyPlan", ERROR_CODE_SIZE_NOT_IN_PLAN],
  ["computerSizeBelowUsage", ERROR_CODE_SIZE_BELOW_USAGE],
  ["spendCapReached", ERROR_CODE_SPEND_CAP_REACHED],
  ["extraUsageNotInPlan", ERROR_CODE_EXTRA_USAGE_NOT_IN_PLAN],
  ["autoRefillNeedsSpendCap", ERROR_CODE_AUTO_REFILL_NEEDS_SPEND_CAP],
  ["planNotOffered", ERROR_CODE_PLAN_NOT_OFFERED],
]);

/**
 * The details a client reads from a served refusal through the code's own
 * helper, written with only the keys the refusal carries, as the reference
 * contract's details types write them with `omitempty`.
 */
function readDetails(error: ApiError): JsonObject | undefined {
  const notInPlan = sizeNotInPlan(error);
  if (notInPlan !== undefined) {
    return {
      size: notInPlan.size,
      largestSize: notInPlan.largestSize,
      ...(notInPlan.plan === "" ? {} : { plan: notInPlan.plan }),
      ...(notInPlan.planName === "" ? {} : { planName: notInPlan.planName }),
    };
  }
  const belowUsage = sizeBelowUsage(error);
  if (belowUsage !== undefined) {
    return {
      usedBytes: belowUsage.usedBytes,
      sizeBytes: belowUsage.sizeBytes,
      ...(belowUsage.computerSize === ""
        ? {}
        : { computerSize: belowUsage.computerSize }),
    };
  }
  const capReached = spendCapReached(error);
  if (capReached !== undefined) {
    return {
      spendCapMicros: capReached.spendCapMicros,
      boughtMicros: capReached.boughtMicros,
    };
  }
  return undefined;
}

/**
 * The error documents the billing refusals are served with. Each carries
 * the code it is pinned with, and the details a client reads through the
 * code's helper are exactly the details served: the keys the helpers read
 * are the keys the platform writes.
 */
const servedRefusals = namedDocuments(
  new Map(
    [...servedCodes.keys()].map((name) => [
      name,
      servedErrorShape as Shape<unknown>,
    ]),
  ),
  (name, value) => {
    const served = value as ServedError;
    const code = servedCodes.get(name);
    if (served.code !== code) {
      throw new Error(
        `${name}: code is ${JSON.stringify(served.code)}, want ${JSON.stringify(code)}`,
      );
    }
    const error = new ApiError({
      status: 400,
      message: served.error,
      ...(served.code === undefined ? {} : { code: served.code }),
      ...(served.details === undefined ? {} : { details: served.details }),
    });
    const read = readDetails(error);
    if (!isDeepStrictEqual(read, served.details)) {
      throw new Error(
        `${name}: details read as ${JSON.stringify(read)}, served as ${JSON.stringify(served.details)}`,
      );
    }
  },
);

/** The billing codecs of the served registry, keyed as it is keyed. */
export const billingRegistry: ReadonlyMap<
  string,
  ServedCodec<unknown>
> = new Map<string, ServedCodec<unknown>>([
  ["billing", codec(accountBillingShape, validateAccountBilling)],
  ["signup-offer", codec(signupOfferShape, validateSignupOffer)],
  [
    "billing.get-response",
    codec(getAccountBillingResponseShape, (value) => {
      validateAccountBilling(value.billing);
    }),
  ],
  [
    "billing.update-response",
    codec(updateAccountBillingResponseShape, (value) => {
      validateAccountBilling(value.billing);
    }),
  ],
  ["billing.requests", requests],
  ["billing.served-refusals", servedRefusals],
  [
    "billing-plan-change",
    codec(billingPlanChangeShape, validateBillingPlanChange),
  ],
  [
    "billing-plan-change.create-response",
    codec(createBillingPlanChangeResponseShape, (value) => {
      validateBillingPlanChange(value.planChange);
    }),
  ],
  [
    "billing-plan-change.get-response",
    codec(getBillingPlanChangeResponseShape, (value) => {
      validateBillingPlanChange(value.planChange);
    }),
  ],
  ["billing-purchase", codec(billingPurchaseShape, validateBillingPurchase)],
  [
    "billing-purchase.create-response",
    codec(createBillingPurchaseResponseShape, (value) => {
      validateBillingPurchase(value.purchase);
    }),
  ],
  [
    "billing-purchase.get-response",
    codec(getBillingPurchaseResponseShape, (value) => {
      validateBillingPurchase(value.purchase);
    }),
  ],
  [
    "billing-purchases.list-page",
    codec(listBillingPurchasesResponseShape, (value) => {
      for (const purchase of value.items) validateBillingPurchase(purchase);
    }),
  ],
  [
    "billing-portal-session.create-response",
    codec(createBillingPortalSessionResponseShape, (value) => {
      validateBillingPortalSession(value.portalSession);
    }),
  ],
]);

/** The type each `billing.refusals` case is written as, and its validation. */
const refusalTypes: ReadonlyMap<
  string,
  readonly [Shape<unknown>, (value: never) => void]
> = new Map(
  (
    [
      [
        [
          "settings update without a field",
          "auto-refill amount not in whole dollars",
          "negative spend cap",
          "auto-refill on while the cap is removed",
        ],
        updateAccountBillingRequestShape,
        validateUpdateAccountBillingRequest,
      ],
      [
        ["plan named by its display name"],
        createBillingPlanChangeRequestShape,
        validateCreateBillingPlanChangeRequest,
      ],
      [
        ["idempotency key past its bound", "purchase of nothing"],
        createBillingPurchaseRequestShape,
        validateCreateBillingPurchaseRequest,
      ],
      [
        [
          "more used than allowed",
          "plan in force not listed",
          "rates naming a size twice",
          "negative storage rate",
          "negative download rate",
          "negative rate",
          "Subnet rates not named by slug",
          "Subnet rates listed twice",
          "negative awake vCPU limit",
          "deletion warnings out of order",
          "deletion warnings without a retention",
          "auto-refill on with no cap",
          "allowance withheld for a reason not named",
          "allowance withheld yet granted",
          "unknown lifecycle",
          "no lifecycle",
        ],
        accountBillingShape,
        validateAccountBilling,
      ],
      [
        [
          "offer with a trial and a withheld reason",
          "offer with an unknown reason",
        ],
        signupOfferShape,
        validateSignupOffer,
      ],
      [
        ["failed change without a reason", "applied change without its time"],
        billingPlanChangeShape,
        validateBillingPlanChange,
      ],
      [
        ["paid purchase with an action", "action page not on https"],
        billingPurchaseShape,
        validateBillingPurchase,
      ],
    ] as const
  ).flatMap(([cases, shape, validate]) =>
    cases.map(
      (name) =>
        [
          name,
          [shape as Shape<unknown>, validate as (value: never) => void],
        ] as const,
    ),
  ),
);

/**
 * Reads one `billing.refusals` value as the type its case names and returns
 * it written back, then judges it: the validation that owns the type must
 * refuse it with a `TypeError`, which is returned. A case this table does
 * not name throws.
 */
export function judgeBillingRefusal(
  value: unknown,
  name: string,
): { readonly written: unknown; readonly refusal: unknown } {
  const entry = refusalTypes.get(name);
  if (entry === undefined) {
    throw new Error(`unregistered billing refusal ${name}`);
  }
  const [shape, validate] = entry;
  const read = decodeValue(value, shape, "lenient");
  let refusal: unknown;
  try {
    validate(read as never);
  } catch (error) {
    refusal = error;
  }
  return { written: shape.encode(read), refusal };
}
