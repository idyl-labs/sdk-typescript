// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * An Account pays for the Computers it runs through its billing: a plan,
 * which grants a monthly allowance of usage, and, on a paid plan, extra
 * usage bought on top of it. The Account's billing is one resource per
 * Account, `AccountBilling`, served by the global API. Changes that move
 * money are operation resources of their own: a plan change
 * (`BillingPlanChange`) and a purchase of extra usage (`BillingPurchase`).
 * Each create records the operation and answers within a short bounded
 * wait, already finished or still pending, and the caller reads it until it
 * is finished; no request is held open while Stripe takes a payment. Card
 * details, addresses, invoices and receipts are kept by Stripe and reached
 * through a portal session (`BillingPortalSession`); IDYL never receives
 * them.
 *
 * Billing is read when a client starts and in the background, never on a
 * Computer's wake, session or cell. A wake, a session or a resize that the
 * Account's billing refuses is refused by that call itself, with
 * `ERROR_CODE_OUT_OF_USAGE`, `ERROR_CODE_SIZE_NOT_IN_PLAN` or
 * `ERROR_CODE_VCPU_LIMIT_REACHED`, so nothing has to be checked first.
 *
 * Every amount of money is in US dollars, as a whole number of
 * micro-dollars (`MICROS_PER_DOLLAR` to the dollar), so usage priced by the
 * minute is exact and sums without rounding. Amounts are never negative,
 * and every amount field is always written, since zero is a reading.
 * Amounts are 64-bit integers on the wire: a value within
 * `Number.MAX_SAFE_INTEGER` reads as a number, a larger one as a bigint.
 */
import {
  validateComputerSize,
  type ComputerSize,
} from "../resource/computer-execution-settings.js";
import {
  always,
  array,
  boolean,
  decodeValue,
  explicitPointer,
  integer,
  object,
  omitEmpty,
  omitZero,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { cpuQuantityShape, type CpuQuantity } from "../resource/cpu.js";
import { parseSubnetSlug } from "../resource/id.js";
import {
  memoryQuantityShape,
  type MemoryQuantity,
} from "../resource/memory.js";
import {
  isZeroVolume,
  validateVolumeQuantity,
  volumeQuantityShape,
  type VolumeQuantity,
} from "../resource/volume.js";
import { parseJson } from "../resource/json.js";
import {
  compareDuration,
  durationShape,
  isZeroDuration,
  type Duration,
} from "../resource/duration.js";
import type { Integer, JsonObject } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";
import {
  parseBillingPlanChangeId,
  parseBillingPurchaseId,
  type BillingPlanChangeId,
  type BillingPurchaseId,
} from "../resource/uuid-id.js";
import { prefixed } from "../resource/validation.js";
import {
  ERROR_CODE_ACTION_EXPIRED,
  ERROR_CODE_PAYMENT_DECLINED,
  ERROR_CODE_PAYMENT_DISPUTED,
  ERROR_CODE_PLAN_CHANGE_SUPERSEDED,
  ERROR_CODE_PLAN_CHANGE_UNAVAILABLE,
} from "./billing-errors.js";
import { isZeroInstant } from "./computer-session.js";
import type { ListResponse } from "./types.js";

/**
 * The number of micro-dollars in one US dollar: every billing amount is a
 * whole number of micro-dollars.
 */
export const MICROS_PER_DOLLAR = 1_000_000;

/** The most bytes the `idempotencyKey` of a plan change or a purchase may take. */
export const MAX_BILLING_IDEMPOTENCY_KEY_BYTES = 64;

const MICROS_PER_DOLLAR_EXACT = BigInt(MICROS_PER_DOLLAR);

/** The wire shape of every amount of money: a 64-bit integer of micro-dollars. */
const microsShape: Shape<Integer> = integer({ unsigned: false, bits: 64 });

export { validateComputerSize, type ComputerSize };

/**
 * Identifies a plan. The plans an Account can be on are a catalog the
 * platform serves with every read of its billing
 * ({@link AccountBillingStatus.plans}), so a plan is an identifier rather
 * than a closed set. The tokens this SDK names are:
 *
 * - `trial`: the plan an Account starts on. It costs nothing, needs no
 *   card and cannot be requested.
 * - `none`: no plan: an Account whose paid plan has ended. It costs nothing
 *   and needs no card, and a plan change to it cancels a paid plan.
 * - `pro`: the first paid plan.
 * - `max`: the paid plan with five times Pro's allowance.
 * - `ultra`: the paid plan with 25 times Pro's allowance.
 */
export type BillingPlan =
  "trial" | "none" | "pro" | "max" | "ultra" | (string & Record<never, never>);

const BILLING_PLAN_FORM = /^[a-z][a-z0-9_]{0,62}$/u;

/**
 * Judges that the plan is in the form every plan identifier takes: 1 to 63
 * lowercase letters, digits and underscores, beginning with a letter.
 * Whether the platform offers it is the platform's decision. Throws a
 * `TypeError`.
 */
export function validateBillingPlan(plan: BillingPlan): void {
  if (plan === "") throw new TypeError("billing plan is required");
  if (!BILLING_PLAN_FORM.test(plan)) {
    throw new TypeError(
      `billing plan ${JSON.stringify(plan)} must be 1 to 63 lowercase letters, digits and underscores, beginning with a letter`,
    );
  }
}

/**
 * Whether auto-refill is on and how much each refill buys. A refill is an
 * extra usage purchase of kind `auto_refill`, made with the card the
 * Account pays with, at most one each time the balance reaches zero, and
 * never past the spend cap.
 */
export interface BillingAutoRefill {
  /** Whether auto-refill buys extra usage. Always written, `false` included. */
  readonly enabled: boolean;
  /**
   * What one refill buys: a positive whole number of dollars, in
   * micro-dollars. It is kept while auto-refill is off. Always written.
   */
  readonly amountMicros: Integer;
}

/** The wire shape of an auto-refill setting. */
export const billingAutoRefillShape: Shape<BillingAutoRefill> =
  object<BillingAutoRefill>({
    enabled: always(boolean()),
    amountMicros: always(microsShape),
  });

/**
 * Judges the auto-refill: its amount is a positive whole number of dollars.
 * Throws a `TypeError`.
 */
export function validateBillingAutoRefill(autoRefill: BillingAutoRefill): void {
  validateDollarAmount("amountMicros", autoRefill.amountMicros);
}

/** Refuses an amount that is not a positive whole number of dollars, which is how extra usage is sold. */
function validateDollarAmount(field: string, micros: Integer): void {
  const exact = BigInt(micros);
  if (exact <= 0n || exact % MICROS_PER_DOLLAR_EXACT !== 0n) {
    throw new TypeError(`${field} must be a positive whole number of dollars`);
  }
}

/** Whether `micros` is below zero. */
function isNegative(micros: Integer): boolean {
  return BigInt(micros) < 0n;
}

/** What an Account's owner sets for its extra usage. */
export interface AccountBillingSpec {
  /**
   * Buys extra usage when the Account's extra usage balance reaches zero.
   * It is off when an Account is created, with an amount of $20. The
   * platform turns it off on its own when a refill cannot be charged or a
   * payment is disputed, and says why in
   * {@link AccountBillingStatus.autoRefillStopped}. Always written.
   */
  readonly autoRefill: BillingAutoRefill;
  /**
   * The most the Account spends on extra usage in one period, counting
   * purchases paid and pending, whether the owner bought them or
   * auto-refill did; a purchase that would pass it is refused with
   * `ERROR_CODE_SPEND_CAP_REACHED`. `undefined` means no cap, which is how
   * an Account starts. Auto-refill can be on only while a cap is set
   * (`ERROR_CODE_AUTO_REFILL_NEEDS_SPEND_CAP`).
   */
  readonly spendCapMicros?: Integer;
}

/** The wire shape of an Account's billing settings. */
export const accountBillingSpecShape: Shape<AccountBillingSpec> =
  object<AccountBillingSpec>({
    autoRefill: always(billingAutoRefillShape),
    spendCapMicros: pointer(microsShape),
  });

/**
 * Judges the spec: a valid auto-refill, a cap that is not negative, and a
 * cap set whenever auto-refill is on. Throws a `TypeError`.
 */
export function validateAccountBillingSpec(spec: AccountBillingSpec): void {
  prefixed("autoRefill", () => {
    validateBillingAutoRefill(spec.autoRefill);
  });
  if (spec.spendCapMicros !== undefined && isNegative(spec.spendCapMicros)) {
    throw new TypeError("spendCapMicros must not be negative");
  }
  if (spec.autoRefill.enabled && spec.spendCapMicros === undefined) {
    throw new TypeError(
      "autoRefill can be enabled only with spendCapMicros set",
    );
  }
}

/**
 * Whether an Account's Computers may wake.
 *
 * - `ok`: an Account whose Computers may wake: it has allowance or extra
 *   usage left, or auto-refill can buy more.
 * - `out`: an Account that has used its month's allowance and its extra
 *   usage, and that auto-refill cannot refill. Its wakes and session starts
 *   are refused with `ERROR_CODE_OUT_OF_USAGE` and its awake Computers are
 *   asked to sleep, their files kept. It is `ok` again after a purchase, an
 *   upgrade or the start of its next period; its Computers are not woken by
 *   that.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string.
 */
export type BillingStanding = "ok" | "out" | (string & Record<never, never>);

/**
 * Judges that the standing is one this SDK names. The empty string is
 * reported as missing. Throws a `TypeError`.
 */
export function validateBillingStanding(standing: BillingStanding): void {
  switch (standing) {
    case "ok":
    case "out":
      return;
    case "":
      throw new TypeError("billing standing is required");
    default:
      throw new TypeError(
        `unknown billing standing ${JSON.stringify(standing)}`,
      );
  }
}

/**
 * Whether a paid plan's latest renewal was paid.
 *
 * - `ok`: a renewal that was paid, or an Account on `trial` or `none`, whose periods need
 *   no payment.
 * - `failed`: a renewal whose payment failed and is being retried by Stripe.
 *   The period's allowance is granted only once it is paid. If the retries end
 *   unpaid, the plan ends and the Account is on `none`.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string.
 */
export type BillingRenewalState =
  "ok" | "failed" | (string & Record<never, never>);

/**
 * Judges that the state is one this SDK names. The empty string is reported
 * as missing. Throws a `TypeError`.
 */
export function validateBillingRenewalState(state: BillingRenewalState): void {
  switch (state) {
    case "ok":
    case "failed":
      return;
    case "":
      throw new TypeError("billing renewal state is required");
    default:
      throw new TypeError(
        `unknown billing renewal state ${JSON.stringify(state)}`,
      );
  }
}

/**
 * Why the platform withheld the allowance of an Account's current period,
 * which is then zero.
 *
 * - `trial_one_per_person`: an unpaid allowance withheld because it is given
 *   once per person: the verified sign-in email of the Account's owner
 *   already holds it on another Account. The Account may still use a paid
 *   plan, whose allowance is never withheld for this reason.
 * - `trials_closed`: an unpaid allowance withheld because IDYL offered no
 *   trials when the Account was created. The Account may still use a paid
 *   plan.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string.
 */
export type BillingAllowanceWithheld =
  "trial_one_per_person" | "trials_closed" | (string & Record<never, never>);

/**
 * Judges that the reason is one this SDK names. The empty string is
 * reported as missing. Throws a `TypeError`.
 */
export function validateBillingAllowanceWithheld(
  reason: BillingAllowanceWithheld,
): void {
  switch (reason) {
    case "trial_one_per_person":
    case "trials_closed":
      return;
    case "":
      throw new TypeError("billing allowance withheld reason is required");
    default:
      throw new TypeError(
        `unknown billing allowance withheld reason ${JSON.stringify(reason)}`,
      );
  }
}

/**
 * Where an Account stands in its use of the platform. A client reads it to
 * tell an Account whose free usage has ended from a paying Account that has
 * used up its month, which a `standing` of `out` alone cannot.
 *
 * - `full`: an Account with nothing in its way but its usage: on a paid plan,
 *   or on no plan with extra usage left to spend. A paid plan's month that is
 *   used up reads `full`, with a `standing` of `out`.
 * - `trial`: an Account on its free trial, which ends at `periodEnd` or when
 *   its allowance is used, whichever comes first.
 * - `ended`: an Account with no paid plan and nothing left to spend: its trial
 *   ended or was withheld, or its paid plan ended and its extra usage is used.
 * - `deleting`: an Account whose retention has passed and whose files are being
 *   deleted. The deletion cannot be stopped, and plan changes are refused until
 *   it has finished. The Account then reads `ended`, with nothing stored, and
 *   can choose a plan as usual.
 *   Its standing is `out`, and no later period grants it anything. A paid plan
 *   returns it to `full`.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string.
 */
export type BillingLifecycle =
  "full" | "trial" | "ended" | "deleting" | (string & Record<never, never>);

/**
 * Judges that the lifecycle is one this SDK names. The empty string is
 * reported as missing. Throws a `TypeError`.
 */
export function validateBillingLifecycle(lifecycle: BillingLifecycle): void {
  switch (lifecycle) {
    case "full":
    case "trial":
    case "ended":
    case "deleting":
      return;
    case "":
      throw new TypeError("billing lifecycle is required");
    default:
      throw new TypeError(
        `unknown billing lifecycle ${JSON.stringify(lifecycle)}`,
      );
  }
}

/**
 * What one awake hour of a size costs, before tax, and the size this rate
 * prices, stated as `ComputerSizeInfo` states it, so a reader of the Account's
 * billing needs no second request to show the size. `label`, `cpu`, `memory`,
 * `disk` and `default` are optional: a platform that leaves them out still
 * validates.
 */
export interface BillingSizeRate {
  /** The size. Always written. */
  readonly size: ComputerSize;
  /**
   * The price of one hour the Computer is awake at `size`, in
   * micro-dollars; a Computer is charged for the seconds it is awake. Zero
   * is a rate. Always written.
   */
  readonly perHourMicros: Integer;
  /** The name a person reads for the size this rate prices, such as `Small`. */
  readonly label?: string;
  /** The CPU limit of a Computer of the size this rate prices. */
  readonly cpu?: CpuQuantity;
  /** The memory limit of a Computer of the size this rate prices. */
  readonly memory?: MemoryQuantity;
  /** The most a Computer of the size this rate prices can store. */
  readonly disk?: VolumeQuantity;
  /**
   * Whether the size this rate prices is the one a Computer that states no
   * size, CPU or memory runs at. `undefined` means it is not.
   */
  readonly default?: boolean;
}

/** The wire shape of the rate of one size. */
export const billingSizeRateShape: Shape<BillingSizeRate> =
  object<BillingSizeRate>({
    size: always(string()),
    perHourMicros: always(microsShape),
    label: omitEmpty(string()),
    cpu: omitZero(cpuQuantityShape),
    memory: omitZero(memoryQuantityShape),
    disk: omitZero(volumeQuantityShape),
    default: omitEmpty(boolean()),
  });

/** The rates of one Subnet whose rate card differs from the platform's default. */
export interface BillingSubnetSizeRates {
  /**
   * The Subnet's canonical 12-digit slug, as a Computer names the Subnet it
   * lives in. Always written.
   */
  readonly subnet: string;
  /**
   * The Subnet's rate for each size, one entry per size, smallest first.
   * Always written, empty rather than omitted.
   */
  readonly sizeRates: readonly BillingSizeRate[];
}

/** The wire shape of one Subnet's rates. */
export const billingSubnetSizeRatesShape: Shape<BillingSubnetSizeRates> =
  object<BillingSubnetSizeRates>({
    subnet: always(string()),
    sizeRates: always(array(billingSizeRateShape)),
  });

/**
 * Judges the Subnet's rates: a canonical slug, and rates as
 * {@link AccountBillingStatus.sizeRates} holds them. Throws a `TypeError`.
 */
export function validateBillingSubnetSizeRates(
  rates: BillingSubnetSizeRates,
): void {
  prefixed("subnet", () => {
    parseSubnetSlug(rates.subnet);
  });
  joined("sizeRates", () => {
    validateSizeRates(rates.sizeRates);
  });
}

/**
 * Requires sizes in identifier form, each once, with rates that are not
 * negative. The platform states their order, smallest first. Its refusals begin
 * with the refused entry's index, for the caller to prefix with the field.
 */
function validateSizeRates(rates: readonly BillingSizeRate[]): void {
  const seen = new Set<ComputerSize>();
  rates.forEach((rate, index) => {
    const at = `[${String(index)}]`;
    prefixed(`${at}: size`, () => {
      validateComputerSize(rate.size);
    });
    if (seen.has(rate.size)) {
      throw new TypeError(
        `${at}: size ${JSON.stringify(rate.size)} is listed twice`,
      );
    }
    seen.add(rate.size);
    if (isNegative(rate.perHourMicros)) {
      throw new TypeError(`${at}: perHourMicros must not be negative`);
    }
  });
}

/**
 * A change of plan that takes effect at the end of the current period: a
 * downgrade, or a cancellation, which is a change to `none`. When it takes
 * effect, the Account's awake Computers larger than `largestSize` are asked
 * to sleep, and each needs a size no larger than it, or an upgrade, before
 * it can wake again. A plan change to the plan in force undoes the pending
 * change.
 */
export interface BillingScheduledChange {
  /** The plan the Account changes to. Always written. */
  readonly plan: BillingPlan;
  /** When the change takes effect: the end of the current period. Always written. */
  readonly at: string;
  /** The largest size `plan` includes. Always written. */
  readonly largestSize: ComputerSize;
}

/** The wire shape of a scheduled change of plan. */
export const billingScheduledChangeShape: Shape<BillingScheduledChange> =
  object<BillingScheduledChange>({
    plan: always(string<BillingPlan>()),
    at: always(timestampShape),
    largestSize: always(string()),
  });

/**
 * Judges the change: a plan in identifier form, an instant, and a size this
 * SDK names. Throws a `TypeError`.
 */
export function validateBillingScheduledChange(
  change: BillingScheduledChange,
): void {
  prefixed("plan", () => {
    validateBillingPlan(change.plan);
  });
  if (isZeroInstant(change.at)) throw new TypeError("at is required");
  prefixed("largestSize", () => {
    validateComputerSize(change.largestSize);
  });
}

/** Why and when the platform turned auto-refill off. */
export interface BillingAutoRefillStop {
  /**
   * `PAYMENT_DECLINED` when a refill could not be charged, or
   * `PAYMENT_DISPUTED` when a payment of the Account was disputed. Always
   * written.
   */
  readonly reason: string;
  /** When auto-refill was turned off. Always written. */
  readonly at: string;
}

/** The wire shape of an auto-refill stop. */
export const billingAutoRefillStopShape: Shape<BillingAutoRefillStop> =
  object<BillingAutoRefillStop>({
    reason: always(string()),
    at: always(timestampShape),
  });

/**
 * Judges the stop: a reason this SDK names, and an instant. Throws a
 * `TypeError`.
 */
export function validateBillingAutoRefillStop(
  stop: BillingAutoRefillStop,
): void {
  switch (stop.reason) {
    case ERROR_CODE_PAYMENT_DECLINED:
    case ERROR_CODE_PAYMENT_DISPUTED:
      break;
    case "":
      throw new TypeError("reason is required");
    default:
      throw new TypeError(
        `unknown auto-refill stop reason ${JSON.stringify(stop.reason)}`,
      );
  }
  if (isZeroInstant(stop.at)) throw new TypeError("at is required");
}

/** Names the smallest plan that includes a size. */
export interface BillingSizePlan {
  /** The size. Always written. */
  readonly size: ComputerSize;
  /** The smallest plan whose largest size is at least `size`. Always written. */
  readonly plan: BillingPlan;
}

/** The wire shape of a size and the smallest plan that includes it. */
export const billingSizePlanShape: Shape<BillingSizePlan> =
  object<BillingSizePlan>({
    size: always(string()),
    plan: always(string<BillingPlan>()),
  });

/**
 * Judges the pair: a size and a plan in identifier form.
 * Throws a `TypeError`.
 */
export function validateBillingSizePlan(sizePlan: BillingSizePlan): void {
  prefixed("size", () => {
    validateComputerSize(sizePlan.size);
  });
  prefixed("plan", () => {
    validateBillingPlan(sizePlan.plan);
  });
}

/** A plan as it is offered. */
export interface BillingPlanOffer {
  /** Identifies the plan. Always written. */
  readonly plan: BillingPlan;
  /** The plan's name for display, such as `Max 5x`. Always written. */
  readonly name: string;
  /**
   * The plan's price for one month, before tax, which Stripe adds when it
   * charges, in micro-dollars. Zero for `trial` and `none`. Always written.
   */
  readonly priceMicros: Integer;
  /** The usage the plan grants each month, in micro-dollars. Always written. */
  readonly allowanceMicros: Integer;
  /** The largest size the plan includes. Always written. */
  readonly largestSize: ComputerSize;
  /**
   * The most data an Account on the plan stores across all its Computers,
   * saved history included, such as `400Gi`. A save or an upload that would
   * go past it fails with `SAVE_REASON_ACCOUNT_STORAGE_LIMIT`. `undefined`
   * when the plan has no such limit.
   */
  readonly storedData?: VolumeQuantity;
  /**
   * The most vCPU an Account on the plan keeps awake at once, across all its
   * Computers. Asleep Computers count for nothing. A wake that would go past
   * it fails with `ERROR_CODE_VCPU_LIMIT_REACHED`. `undefined` when the plan
   * has no such limit.
   */
  readonly awakeVCPU?: Integer;
  /**
   * Whether an Account on the plan can buy extra usage and turn on
   * auto-refill. Always written.
   */
  readonly extraUsage: boolean;
}

/** The wire shape of a plan offer. */
export const billingPlanOfferShape: Shape<BillingPlanOffer> =
  object<BillingPlanOffer>({
    plan: always(string<BillingPlan>()),
    name: always(string()),
    priceMicros: always(microsShape),
    allowanceMicros: always(microsShape),
    largestSize: always(string()),
    storedData: omitZero(volumeQuantityShape),
    awakeVCPU: omitEmpty(integer({ unsigned: false, bits: 64 })),
    extraUsage: always(boolean()),
  });

/**
 * Judges the offer: a plan in identifier form, a name, amounts and an awake
 * vCPU limit that are not negative, a size in identifier form, and a valid
 * stored-data limit when one is stated. Throws a `TypeError`.
 */
export function validateBillingPlanOffer(offer: BillingPlanOffer): void {
  prefixed("plan", () => {
    validateBillingPlan(offer.plan);
  });
  if (offer.name === "") throw new TypeError("name is required");
  if (isNegative(offer.priceMicros) || isNegative(offer.allowanceMicros)) {
    throw new TypeError("priceMicros and allowanceMicros must not be negative");
  }
  if (offer.awakeVCPU !== undefined && isNegative(offer.awakeVCPU)) {
    throw new TypeError("awakeVCPU must not be negative");
  }
  prefixed("largestSize", () => {
    validateComputerSize(offer.largestSize);
  });
  validateStoredData(offer.storedData);
}

/**
 * Judges the terms on which an Account's files are kept: warnings only beside
 * a retention, each positive and shorter than it, longest first.
 */
function validateFileRetention(
  retention: Duration | undefined,
  warnings: readonly Duration[] | undefined,
): void {
  if (retention !== undefined && isBelowZero(retention)) {
    throw new TypeError("fileRetention must not be negative");
  }
  if (warnings === undefined || warnings.length === 0) return;
  if (retention === undefined || isZeroDuration(retention)) {
    throw new TypeError("deletionWarnings need a fileRetention");
  }
  let longest = retention;
  warnings.forEach((warning, index) => {
    if (
      isBelowZero(warning) ||
      isZeroDuration(warning) ||
      compareDuration(warning, longest) >= 0
    ) {
      throw new TypeError(
        `deletionWarnings[${String(index)}] must be positive and shorter than the one before it and fileRetention`,
      );
    }
    longest = warning;
  });
}

/** Whether the duration runs backwards. */
function isBelowZero(duration: Duration): boolean {
  return compareDuration(duration, { seconds: 0, nanoseconds: 0 }) < 0;
}

/** Judges a stated limit on stored data: a valid quantity. */
function validateStoredData(quantity: VolumeQuantity | undefined): void {
  if (quantity === undefined || isZeroVolume(quantity)) return;
  prefixed("storedData", () => {
    validateVolumeQuantity(quantity);
  });
}

/**
 * An Account's billing as the platform reports it. Usage is counted as soon
 * as it is recorded, before it is settled, so the amounts are the ones the
 * Account's standing is judged on. Instants are RFC 3339 strings.
 */
export interface AccountBillingStatus {
  /** The plan in force. Always written. */
  readonly plan: BillingPlan;
  /**
   * The start of the current period, which is `[periodStart, periodEnd)`:
   * one month of the plan in force, or a trial's whole length. An upgrade
   * starts a new period at once. Always written.
   */
  readonly periodStart: string;
  /**
   * The end of the current period: when the allowance resets, a paid plan
   * renews and a trial ends. Always written.
   */
  readonly periodEnd: string;
  /**
   * The allowance granted for the current period: zero until a paid
   * period's renewal is paid, and zero when it was withheld
   * (`allowanceWithheld`). What is left of it when the period ends expires.
   * Always written.
   */
  readonly allowanceMicros: Integer;
  /**
   * Why the current period's allowance was withheld, when it was;
   * `undefined` otherwise. `allowanceMicros` is then zero.
   */
  readonly allowanceWithheld?: BillingAllowanceWithheld;
  /**
   * How much of `allowanceMicros` the period's usage has used, never more
   * than `allowanceMicros`. Usage beyond the allowance draws on the extra
   * usage balance. Always written.
   */
  readonly usedMicros: Integer;
  /**
   * The extra usage bought and not yet used. It never expires and is used
   * only once the allowance is used up. Always written.
   */
  readonly extraBalanceMicros: Integer;
  /**
   * The extra usage bought in the current period, purchases paid and
   * pending, which is what the spend cap counts. Always written.
   */
  readonly extraBoughtMicros: Integer;
  /** Whether the Account's Computers may wake. Always written. */
  readonly standing: BillingStanding;
  /** Where the Account stands in its use of the platform. Always written. */
  readonly lifecycle: BillingLifecycle;
  /** Whether the plan's latest renewal was paid. Always written. */
  readonly renewal: BillingRenewalState;
  /**
   * The largest size the plan in force includes. A wake or a resize of a
   * Computer to a larger size is refused with `ERROR_CODE_SIZE_NOT_IN_PLAN`.
   * Always written.
   */
  readonly largestSize: ComputerSize;
  /**
   * The most data the Account stores across all its Computers under the
   * plan in force, as {@link BillingPlanOffer.storedData} states it.
   * `undefined` when the plan has no such limit.
   */
  readonly storedData?: VolumeQuantity;
  /**
   * How long an Account keeps its files once it has no plan and nothing
   * left to spend, under the platform's default rate card in force now. The
   * files are deleted no earlier than that. An Account whose files are
   * already being kept this way keeps the terms it started with.
   * `undefined` when the rate card has no free trial.
   */
  readonly fileRetention?: Duration;
  /**
   * How long before its files are deleted each warning is sent to the
   * Account's owner, longest first, under the same rate card as
   * `fileRetention`. Each is shorter than `fileRetention`. `undefined` when
   * the rate card has no free trial.
   */
  readonly deletionWarnings?: readonly Duration[];
  /**
   * The plan the Account changes to at the end of the current period, when
   * a downgrade or a cancellation is scheduled; `undefined` when none is.
   */
  readonly scheduledChange?: BillingScheduledChange;
  /**
   * Why the platform turned auto-refill off on its own; `undefined` when it
   * did not. It is cleared when auto-refill is turned on again.
   */
  readonly autoRefillStopped?: BillingAutoRefillStop;
  /**
   * Whether Stripe holds invoices for the Account: it has paid at least
   * once. A portal session shows them. Always written.
   */
  readonly hasInvoices: boolean;
  /**
   * For each size some plan includes, the smallest plan that includes it,
   * smallest size first. Always written, empty rather than omitted.
   */
  readonly sizePlans: readonly BillingSizePlan[];
  /**
   * Every plan offered, cheapest first; it always lists the plan in force
   * and the plan of a scheduled change. Always written, empty rather than
   * omitted.
   */
  readonly plans: readonly BillingPlanOffer[];
  /**
   * What an awake hour of each size costs under the platform's default
   * rate card in force now: one entry per size, smallest first. A Computer
   * is charged its Subnet's rate, which is this one unless
   * `subnetSizeRates` names the Subnet. Always written, empty rather than
   * omitted.
   */
  readonly sizeRates: readonly BillingSizeRate[];
  /**
   * The Subnets the Account may use whose rate card in force now differs
   * from the default, each once, with its rates. A Subnet it does not list
   * charges `sizeRates`. Always written, empty rather than omitted, and
   * empty when every such Subnet charges the default.
   */
  readonly subnetSizeRates: readonly BillingSubnetSizeRates[];
  /**
   * The rate in force now for storing one GiB for one month, under the
   * platform's default rate card, before tax. Zero is a rate. Always written.
   */
  readonly storageMicrosPerGiBMonth: Integer;
  /**
   * The rate in force now for downloading one GiB, under the platform's default
   * rate card, before tax. Zero is a rate. Always written.
   */
  readonly downloadMicrosPerGiB: Integer;
}

/** The wire shape of an Account's billing status. */
export const accountBillingStatusShape: Shape<AccountBillingStatus> =
  object<AccountBillingStatus>({
    plan: always(string<BillingPlan>()),
    periodStart: always(timestampShape),
    periodEnd: always(timestampShape),
    allowanceMicros: always(microsShape),
    allowanceWithheld: omitEmpty(string<BillingAllowanceWithheld>()),
    usedMicros: always(microsShape),
    extraBalanceMicros: always(microsShape),
    extraBoughtMicros: always(microsShape),
    standing: always(string<BillingStanding>()),
    lifecycle: always(string<BillingLifecycle>()),
    renewal: always(string<BillingRenewalState>()),
    largestSize: always(string()),
    storedData: omitZero(volumeQuantityShape),
    fileRetention: omitZero(durationShape),
    deletionWarnings: omitEmpty(array(durationShape)),
    scheduledChange: pointer(billingScheduledChangeShape),
    autoRefillStopped: pointer(billingAutoRefillStopShape),
    hasInvoices: always(boolean()),
    sizePlans: always(array(billingSizePlanShape)),
    plans: always(array(billingPlanOfferShape)),
    sizeRates: always(array(billingSizeRateShape)),
    subnetSizeRates: always(array(billingSubnetSizeRatesShape)),
    storageMicrosPerGiBMonth: always(microsShape),
    downloadMicrosPerGiB: always(microsShape),
  });

/**
 * Judges the status: a plan and sizes in identifier form; a standing, a
 * lifecycle and a renewal state this SDK names; a period whose end follows its
 * start; amounts and rates that are not negative, with no more used than
 * allowed; a withheld allowance with a
 * reason this SDK names and a zero amount; a valid stored-data limit when
 * one is stated; a valid scheduled change and auto-refill stop; sizes named
 * once each in `sizePlans`; plans listed once
 * each; the plan in force and the scheduled plan among `plans`; rates for
 * sizes in identifier form, each once, that are not negative; and Subnets named
 * by slug, each once. Throws a `TypeError`.
 */
export function validateAccountBillingStatus(
  status: AccountBillingStatus,
): void {
  prefixed("plan", () => {
    validateBillingPlan(status.plan);
  });
  if (
    isZeroInstant(status.periodStart) ||
    !(Date.parse(status.periodEnd) > Date.parse(status.periodStart))
  ) {
    throw new TypeError("periodEnd must follow periodStart");
  }
  for (const [field, micros] of [
    ["allowanceMicros", status.allowanceMicros],
    ["usedMicros", status.usedMicros],
    ["extraBalanceMicros", status.extraBalanceMicros],
    ["extraBoughtMicros", status.extraBoughtMicros],
    ["storageMicrosPerGiBMonth", status.storageMicrosPerGiBMonth],
    ["downloadMicrosPerGiB", status.downloadMicrosPerGiB],
  ] as const) {
    if (isNegative(micros)) {
      throw new TypeError(`${field} must not be negative`);
    }
  }
  if (BigInt(status.usedMicros) > BigInt(status.allowanceMicros)) {
    throw new TypeError("usedMicros must not exceed allowanceMicros");
  }
  const withheld = status.allowanceWithheld;
  if (withheld !== undefined) {
    prefixed("allowanceWithheld", () => {
      validateBillingAllowanceWithheld(withheld);
    });
    if (BigInt(status.allowanceMicros) !== 0n) {
      throw new TypeError(
        "allowanceMicros must be zero while allowanceWithheld is set",
      );
    }
  }
  prefixed("standing", () => {
    validateBillingStanding(status.standing);
  });
  prefixed("lifecycle", () => {
    validateBillingLifecycle(status.lifecycle);
  });
  prefixed("renewal", () => {
    validateBillingRenewalState(status.renewal);
  });
  prefixed("largestSize", () => {
    validateComputerSize(status.largestSize);
  });
  validateStoredData(status.storedData);
  validateFileRetention(status.fileRetention, status.deletionWarnings);
  const scheduled = status.scheduledChange;
  if (scheduled !== undefined) {
    prefixed("scheduledChange", () => {
      validateBillingScheduledChange(scheduled);
    });
  }
  const stopped = status.autoRefillStopped;
  if (stopped !== undefined) {
    prefixed("autoRefillStopped", () => {
      validateBillingAutoRefillStop(stopped);
    });
  }
  const sizes = new Set<string>();
  status.sizePlans.forEach((sizePlan, index) => {
    const at = `sizePlans[${String(index)}]`;
    prefixed(at, () => {
      validateBillingSizePlan(sizePlan);
    });
    if (sizes.has(sizePlan.size)) {
      throw new TypeError(
        `${at}: size ${JSON.stringify(sizePlan.size)} is listed twice`,
      );
    }
    sizes.add(sizePlan.size);
  });
  const plans = new Set<string>();
  status.plans.forEach((offer, index) => {
    const at = `plans[${String(index)}]`;
    prefixed(at, () => {
      validateBillingPlanOffer(offer);
    });
    if (plans.has(offer.plan)) {
      throw new TypeError(
        `${at}: plan ${JSON.stringify(offer.plan)} is listed twice`,
      );
    }
    plans.add(offer.plan);
  });
  if (!plans.has(status.plan)) {
    throw new TypeError(
      `plans must list the plan in force, ${JSON.stringify(status.plan)}`,
    );
  }
  if (scheduled !== undefined && !plans.has(scheduled.plan)) {
    throw new TypeError(
      `plans must list the scheduled plan, ${JSON.stringify(scheduled.plan)}`,
    );
  }
  joined("sizeRates", () => {
    validateSizeRates(status.sizeRates);
  });
  const subnets = new Set<string>();
  status.subnetSizeRates.forEach((rates, index) => {
    const at = `subnetSizeRates[${String(index)}]`;
    prefixed(at, () => {
      validateBillingSubnetSizeRates(rates);
    });
    if (subnets.has(rates.subnet)) {
      throw new TypeError(
        `${at}: subnet ${JSON.stringify(rates.subnet)} is listed twice`,
      );
    }
    subnets.add(rates.subnet);
  });
}

/**
 * An Account's billing: `spec` is what the Account's owner sets, and
 * `status` is what the platform reports. The global API serves one per
 * Account, at `/v1/accounts/{account}/billing`; it exists for every
 * Account, from sign-up onwards. The plan is changed through a
 * {@link BillingPlanChange} rather than through `spec`, because a change of
 * plan moves money.
 *
 * {@link decodeAccountBilling} reads one leniently: a field or value newer
 * than this SDK is carried rather than refused, and
 * {@link validateAccountBilling} judges the billing against this SDK's
 * contract.
 */
export interface AccountBilling {
  /** What the Account's owner sets. Always written. */
  readonly spec: AccountBillingSpec;
  /** What the platform reports. Always written. */
  readonly status: AccountBillingStatus;
}

/** The wire shape of an Account's billing. */
export const accountBillingShape: Shape<AccountBilling> =
  object<AccountBilling>({
    spec: always(accountBillingSpecShape),
    status: always(accountBillingStatusShape),
  });

/**
 * Reads an Account's billing the platform served, leniently. `document` is
 * JSON text or a value already parsed from JSON; a string is parsed once,
 * as a response is. A field or token this SDK does not name is carried as
 * it arrived, and nothing is judged.
 */
export function decodeAccountBilling(document: unknown): AccountBilling {
  return decodeValue(parsed(document), accountBillingShape, "lenient");
}

/**
 * Renders an Account's billing as the document the platform emits: every
 * amount, flag and list always, the cap, the scheduled change and the
 * auto-refill stop only when present.
 */
export function encodeAccountBilling(billing: AccountBilling): JsonObject {
  return accountBillingShape.encode(billing) as JsonObject;
}

/**
 * Judges the billing against this SDK's contract: a valid spec and a valid
 * status. Throws a `TypeError`.
 */
export function validateAccountBilling(billing: AccountBilling): void {
  prefixed("spec", () => {
    validateAccountBillingSpec(billing.spec);
  });
  prefixed("status", () => {
    validateAccountBillingStatus(billing.status);
  });
}

/** Carries an Account's billing. */
export interface GetAccountBillingResponse {
  readonly billing: AccountBilling;
}

/** The wire shape of the billing read's response. */
export const getAccountBillingResponseShape: Shape<GetAccountBillingResponse> =
  object<GetAccountBillingResponse>({ billing: always(accountBillingShape) });

/**
 * Changes an Account's billing settings field by field: a field it leaves
 * out keeps its value. `autoRefill` replaces the auto-refill setting whole.
 * `spendCapMicros` sets the spend cap, and `spendCapMicros` stated as
 * `null` removes it. The merged spec is judged as a whole: auto-refill on
 * with no cap is refused with `ERROR_CODE_AUTO_REFILL_NEEDS_SPEND_CAP`, and
 * auto-refill on for a plan without extra usage with
 * `ERROR_CODE_EXTRA_USAGE_NOT_IN_PLAN`. A refused update changes nothing.
 * Lowering the cap below what the period has bought already is allowed: it
 * refuses further purchases in the period.
 *
 * The encoding writes a field when it is stated, and `spendCapMicros` as
 * `null` when it is `null`. A strict read refuses an unknown or repeated
 * field and a `null` anywhere but `spendCapMicros`.
 */
export interface UpdateAccountBillingRequest {
  /** Replaces the auto-refill setting. */
  readonly autoRefill?: BillingAutoRefill;
  /**
   * Replaces the spend cap, which must not be negative, in micro-dollars;
   * `null` removes the spend cap.
   */
  readonly spendCapMicros?: Integer | null;
}

/** A 64-bit integer of micro-dollars, or `null`, which an update writes to remove a cap. */
const nullableMicrosShape: Shape<Integer | null> = {
  unknownFields: microsShape.unknownFields,
  decode: (value, path, mode, numberToken) =>
    value === null ? null : microsShape.decode(value, path, mode, numberToken),
  encode: (value) => (value === null ? null : microsShape.encode(value)),
  zero: () => null,
  isZero: (value) => value === null,
  isEmpty: (value) => value === null,
};

/**
 * The wire shape of a billing settings update: each stated field, with
 * `spendCapMicros` carried as `null` when it is, and a strict read refusing
 * `null` for `autoRefill`.
 */
export const updateAccountBillingRequestShape: Shape<UpdateAccountBillingRequest> =
  object<UpdateAccountBillingRequest>({
    autoRefill: explicitPointer(billingAutoRefillShape),
    spendCapMicros: { ...pointer(nullableMicrosShape), null: "preserve" },
  });

/**
 * Judges the update: it states at least one field, the auto-refill amount
 * is a positive whole number of dollars, the cap is not negative, and
 * auto-refill is not turned on by the same update that removes the cap.
 * Whether the merged spec has a cap, and whether the plan includes extra
 * usage, are the platform's decision. Throws a `TypeError`.
 */
export function validateUpdateAccountBillingRequest(
  request: UpdateAccountBillingRequest,
): void {
  const autoRefill = request.autoRefill;
  const cap = request.spendCapMicros;
  if (autoRefill === undefined && cap === undefined) {
    throw new TypeError("billing update states no field");
  }
  if (autoRefill !== undefined) {
    prefixed("billing update: autoRefill", () => {
      validateBillingAutoRefill(autoRefill);
    });
  }
  if (cap !== undefined && cap !== null && isNegative(cap)) {
    throw new TypeError("billing update: spendCapMicros must not be negative");
  }
  if (autoRefill?.enabled === true && cap === null) {
    throw new TypeError(
      "billing update: autoRefill can be enabled only with spendCapMicros set",
    );
  }
}

/** Renders a billing settings update as the document the route carries. */
export function encodeUpdateAccountBillingRequest(
  request: UpdateAccountBillingRequest,
): JsonObject {
  return updateAccountBillingRequestShape.encode(request) as JsonObject;
}

/** Returns the billing as the update left it. */
export interface UpdateAccountBillingResponse {
  readonly billing: AccountBilling;
}

/** The wire shape of the billing update's response. */
export const updateAccountBillingResponseShape: Shape<UpdateAccountBillingResponse> =
  object<UpdateAccountBillingResponse>({
    billing: always(accountBillingShape),
  });

/**
 * What a {@link BillingAction} asks the user to do in Stripe.
 *
 * - `checkout`: a payment in Stripe Checkout, where the user enters a card
 *   and billing details: the first paid plan, a paid plan after `trial` or `none`, and a
 *   purchase on an Account with no saved card.
 * - `confirm_payment`: a payment of the saved card that the card's issuer
 *   asks the user to authenticate, on Stripe's hosted invoice or payment
 *   page.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string.
 */
export type BillingActionKind =
  "checkout" | "confirm_payment" | (string & Record<never, never>);

/**
 * Judges that the kind is one this SDK names. The empty string is reported
 * as missing. Throws a `TypeError`.
 */
export function validateBillingActionKind(kind: BillingActionKind): void {
  switch (kind) {
    case "checkout":
    case "confirm_payment":
      return;
    case "":
      throw new TypeError("billing action kind is required");
    default:
      throw new TypeError(
        `unknown billing action kind ${JSON.stringify(kind)}`,
      );
  }
}

/**
 * A payment the user completes on a page Stripe hosts, for an operation that
 * waits for that payment. A client opens `url` in the user's browser; Stripe
 * returns the user to IDYL when the payment is done or abandoned. The operation
 * finishes once Stripe confirms the payment, and fails with `ACTION_EXPIRED` if
 * the action expires first.
 */
export interface BillingAction {
  /** What the page asks of the user. Always written. */
  readonly kind: BillingActionKind;
  /**
   * The page, an absolute https URL. It grants the payment it is for to
   * whoever opens it, so it is shown only to the user who acts. Always
   * written.
   */
  readonly url: string;
  /** When the page stops accepting the payment. Always written. */
  readonly expiresAt: string;
}

/** The wire shape of a payment page. */
export const billingActionShape: Shape<BillingAction> = object<BillingAction>({
  kind: always(string<BillingActionKind>()),
  url: always(string()),
  expiresAt: always(timestampShape),
});

/**
 * Judges the action: a kind this SDK names, an absolute https URL with a
 * host and no user information, and an expiry. Throws a `TypeError`.
 */
export function validateBillingAction(action: BillingAction): void {
  prefixed("kind", () => {
    validateBillingActionKind(action.kind);
  });
  validateHttpsUrl("url", action.url);
  if (isZeroInstant(action.expiresAt)) {
    throw new TypeError("expiresAt is required");
  }
}

/**
 * Refuses a page address that is not an absolute https URL with a host and
 * without user information, as `${field} must be ...`.
 */
function validateHttpsUrl(field: string, raw: string): void {
  let parsedUrl: URL | undefined;
  try {
    parsedUrl = new URL(raw);
  } catch {
    parsedUrl = undefined;
  }
  if (
    parsedUrl?.protocol !== "https:" ||
    parsedUrl.host === "" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    /^[^:]*:\/\/[^/?#]*@/u.test(raw)
  ) {
    throw new TypeError(`${field} must be an absolute https URL with a host`);
  }
}

/**
 * Asks for an Account's plan to change. `idempotencyKey` makes an equal
 * retry within its window return the same change rather than make a second
 * one.
 */
export interface CreateBillingPlanChangeRequest {
  /**
   * The plan to change to: one {@link AccountBillingStatus.plans} lists, or
   * the plan in force to undo a scheduled change.
   */
  readonly plan: BillingPlan;
  /** At most {@link MAX_BILLING_IDEMPOTENCY_KEY_BYTES} bytes when stated. */
  readonly idempotencyKey?: string;
}

/** The wire shape of a plan change request. */
export const createBillingPlanChangeRequestShape: Shape<CreateBillingPlanChangeRequest> =
  object<CreateBillingPlanChangeRequest>({
    plan: always(string<BillingPlan>()),
    idempotencyKey: omitEmpty(string()),
  });

/**
 * Judges the request: a plan in identifier form and a bounded key. Whether
 * the platform offers the plan is the platform's decision
 * (`ERROR_CODE_PLAN_NOT_OFFERED`). Throws a `TypeError`.
 */
export function validateCreateBillingPlanChangeRequest(
  request: CreateBillingPlanChangeRequest,
): void {
  prefixed("plan", () => {
    validateBillingPlan(request.plan);
  });
  validateBillingIdempotencyKey(request.idempotencyKey ?? "");
}

/** Renders a plan change request as the document the route carries. */
export function encodeCreateBillingPlanChangeRequest(
  request: CreateBillingPlanChangeRequest,
): JsonObject {
  return createBillingPlanChangeRequestShape.encode(request) as JsonObject;
}

function validateBillingIdempotencyKey(key: string): void {
  if (
    new TextEncoder().encode(key).byteLength > MAX_BILLING_IDEMPOTENCY_KEY_BYTES
  ) {
    throw new TypeError(
      `idempotencyKey must be at most ${String(MAX_BILLING_IDEMPOTENCY_KEY_BYTES)} bytes`,
    );
  }
}

/**
 * Where a plan change is.
 *
 * - `pending`: a change being made, or one whose `action` waits for the
 *   user in Stripe.
 * - `applied`: a change in force from `effectiveAt`.
 * - `scheduled`: a change that takes effect at `effectiveAt`, the end of
 *   the current period, as {@link AccountBillingStatus.scheduledChange}
 *   reports.
 * - `failed`: a change that was not made, with `reason`. The plan in force
 *   is unchanged.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string.
 */
export type BillingPlanChangeState =
  | "pending"
  | "applied"
  | "scheduled"
  | "failed"
  | (string & Record<never, never>);

/**
 * Judges that the state is one this SDK names. The empty string is reported
 * as missing. Throws a `TypeError`.
 */
export function validateBillingPlanChangeState(
  state: BillingPlanChangeState,
): void {
  switch (state) {
    case "pending":
    case "applied":
    case "scheduled":
    case "failed":
      return;
    case "":
      throw new TypeError("billing plan change state is required");
    default:
      throw new TypeError(
        `unknown billing plan change state ${JSON.stringify(state)}`,
      );
  }
}

/**
 * Whether a plan change in `state` will not change state again: `applied`,
 * `scheduled` or `failed`. A state this SDK does not name is not final.
 *
 * @param state - The `state` of a {@link BillingPlanChange}.
 */
export function isBillingPlanChangeStateFinal(
  state: BillingPlanChangeState,
): boolean {
  return state === "applied" || state === "scheduled" || state === "failed";
}

/**
 * A request to change an Account's plan, served at
 * `/v1/accounts/{account}/billing/plan-changes/{id}`. Creating one answers
 * within a short bounded wait, finished or pending, and the caller reads it
 * until its state is final. What a change does depends on the plan in force
 * and the plan it names:
 *
 * - From `trial` or `none` to a paid plan, the change waits for the user in Stripe
 *   Checkout (`checkout`) and is applied once Stripe confirms the first
 *   payment.
 * - To a plan with a higher price, it is an upgrade: it takes effect at
 *   once, a new period starts with the new plan's whole allowance, what was
 *   left of the old allowance expires, and Stripe charges the saved card the
 *   new plan's price less a credit for the unused part of the old period. A
 *   charge the card's issuer asks the user to authenticate waits for the
 *   user (`confirm_payment`); a declined charge fails the change with
 *   `PAYMENT_DECLINED` and leaves the plan as it was. An upgrade the
 *   platform cannot make as priced fails with `PLAN_CHANGE_UNAVAILABLE`,
 *   with nothing charged and the plan as it was.
 * - To a plan with a lower price, `none` included, it is scheduled for the
 *   end of the current period, in place of any change scheduled before.
 * - To the plan in force, it undoes a scheduled change and is applied at
 *   once; with nothing scheduled it changes nothing.
 *
 * An applied change also clears a scheduled one. A change made while
 * another is pending supersedes it: the earlier one fails with
 * `PLAN_CHANGE_SUPERSEDED`. A change is retained for a window after it is
 * final and then reads HTTP 404.
 *
 * {@link decodeBillingPlanChange} reads one leniently, and
 * {@link validateBillingPlanChange} judges it against this SDK's contract.
 */
export interface BillingPlanChange {
  /** Names the change. Always written. */
  readonly id: BillingPlanChangeId;
  /** The plan the change is to. Always written. */
  readonly plan: BillingPlan;
  /** Where the change is. Always written. */
  readonly state: BillingPlanChangeState;
  /**
   * Why a failed change was not made: `PAYMENT_DECLINED`,
   * `ACTION_EXPIRED`, `PLAN_CHANGE_SUPERSEDED` or
   * `PLAN_CHANGE_UNAVAILABLE`. Only a failed change carries one.
   */
  readonly reason?: string;
  /** The payment the user completes in Stripe, carried by a pending change that waits for one. */
  readonly action?: BillingAction;
  /**
   * When an applied change took effect, or when a scheduled change takes
   * effect; `undefined` while pending and once failed.
   */
  readonly effectiveAt?: string;
}

/** The wire shape of a plan change. */
export const billingPlanChangeShape: Shape<BillingPlanChange> =
  object<BillingPlanChange>({
    id: always(string<BillingPlanChangeId>()),
    plan: always(string<BillingPlan>()),
    state: always(string<BillingPlanChangeState>()),
    reason: omitEmpty(string()),
    action: pointer(billingActionShape),
    effectiveAt: omitZero(timestampShape),
  });

/** Reads a plan change the platform served, leniently, as {@link decodeAccountBilling} reads billing. */
export function decodeBillingPlanChange(document: unknown): BillingPlanChange {
  return decodeValue(parsed(document), billingPlanChangeShape, "lenient");
}

/** Renders a plan change as the document the platform emits. */
export function encodeBillingPlanChange(change: BillingPlanChange): JsonObject {
  return billingPlanChangeShape.encode(change) as JsonObject;
}

/**
 * Judges the change: a canonical ID, a plan in identifier form, a state
 * this SDK names, and the fields each state carries. A failed change
 * states a reason this SDK names and nothing else does; only a pending
 * change carries an action; an applied or scheduled change carries
 * `effectiveAt` and no other state does. Throws a `TypeError`.
 */
export function validateBillingPlanChange(change: BillingPlanChange): void {
  parseBillingPlanChangeId(change.id);
  prefixed("plan", () => {
    validateBillingPlan(change.plan);
  });
  validateBillingPlanChangeState(change.state);
  validateOperationReason(
    change.state === "failed",
    change.reason ?? "",
    ERROR_CODE_PAYMENT_DECLINED,
    ERROR_CODE_ACTION_EXPIRED,
    ERROR_CODE_PLAN_CHANGE_SUPERSEDED,
    ERROR_CODE_PLAN_CHANGE_UNAVAILABLE,
  );
  validatePendingAction(change.state === "pending", change.action);
  const effective = change.state === "applied" || change.state === "scheduled";
  if (effective === isZeroInstant(change.effectiveAt ?? "")) {
    throw new TypeError(
      `effectiveAt is required in states applied and scheduled and absent otherwise, not in state ${change.state}`,
    );
  }
}

/** Requires a reason from `named` exactly when failed. */
function validateOperationReason(
  failed: boolean,
  reason: string,
  ...named: readonly string[]
): void {
  if (!failed) {
    if (reason !== "") {
      throw new TypeError("reason is carried only once failed");
    }
    return;
  }
  if (reason === "") throw new TypeError("reason is required once failed");
  if (!named.includes(reason)) {
    throw new TypeError(`unknown failure reason ${JSON.stringify(reason)}`);
  }
}

/** Admits an action only while pending, and judges it. */
function validatePendingAction(
  pending: boolean,
  action: BillingAction | undefined,
): void {
  if (action === undefined) return;
  if (!pending) throw new TypeError("action is carried only while pending");
  prefixed("action", () => {
    validateBillingAction(action);
  });
}

/** Returns the change as it stood when the create's wait ended. */
export interface CreateBillingPlanChangeResponse {
  readonly planChange: BillingPlanChange;
}

/** The wire shape of the plan change create's response. */
export const createBillingPlanChangeResponseShape: Shape<CreateBillingPlanChangeResponse> =
  object<CreateBillingPlanChangeResponse>({
    planChange: always(billingPlanChangeShape),
  });

/** Carries one plan change. */
export interface GetBillingPlanChangeResponse {
  readonly planChange: BillingPlanChange;
}

/** The wire shape of the plan change read's response. */
export const getBillingPlanChangeResponseShape: Shape<GetBillingPlanChangeResponse> =
  object<GetBillingPlanChangeResponse>({
    planChange: always(billingPlanChangeShape),
  });

/**
 * Who made a purchase of extra usage.
 *
 * - `manual`: a purchase a user created.
 * - `auto_refill`: a purchase auto-refill made when the extra usage balance
 *   reached zero.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string.
 */
export type BillingPurchaseKind =
  "manual" | "auto_refill" | (string & Record<never, never>);

/**
 * Judges that the kind is one this SDK names. The empty string is reported
 * as missing. Throws a `TypeError`.
 */
export function validateBillingPurchaseKind(kind: BillingPurchaseKind): void {
  switch (kind) {
    case "manual":
    case "auto_refill":
      return;
    case "":
      throw new TypeError("billing purchase kind is required");
    default:
      throw new TypeError(
        `unknown billing purchase kind ${JSON.stringify(kind)}`,
      );
  }
}

/**
 * Where a purchase is.
 *
 * - `pending`: a purchase being charged, or one whose `action` waits for
 *   the user in Stripe. It counts against the spend cap.
 * - `paid`: a purchase Stripe confirmed: its amount is in the extra usage
 *   balance.
 * - `failed`: a purchase that was not paid, with `reason`. Nothing was
 *   charged, and it does not count against the cap.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string.
 */
export type BillingPurchaseState =
  "pending" | "paid" | "failed" | (string & Record<never, never>);

/**
 * Judges that the state is one this SDK names. The empty string is reported
 * as missing. Throws a `TypeError`.
 */
export function validateBillingPurchaseState(
  state: BillingPurchaseState,
): void {
  switch (state) {
    case "pending":
    case "paid":
    case "failed":
      return;
    case "":
      throw new TypeError("billing purchase state is required");
    default:
      throw new TypeError(
        `unknown billing purchase state ${JSON.stringify(state)}`,
      );
  }
}

/**
 * Whether a purchase in `state` will not change state again: `paid` or
 * `failed`. A state this SDK does not name is not final.
 *
 * @param state - The `state` of a {@link BillingPurchase}.
 */
export function isBillingPurchaseStateFinal(
  state: BillingPurchaseState,
): boolean {
  return state === "paid" || state === "failed";
}

/**
 * Asks to buy extra usage with the card the Account pays with.
 * `idempotencyKey` makes an equal retry within its window return the same
 * purchase rather than charge twice.
 *
 * Only an Account on a plan with extra usage can buy it
 * (`ERROR_CODE_EXTRA_USAGE_NOT_IN_PLAN`), and never past its spend cap
 * (`ERROR_CODE_SPEND_CAP_REACHED`). A refused create records nothing.
 */
export interface CreateBillingPurchaseRequest {
  /**
   * The extra usage to buy: a positive whole number of dollars, in
   * micro-dollars, before tax, which Stripe adds.
   */
  readonly amountMicros: Integer;
  /** At most {@link MAX_BILLING_IDEMPOTENCY_KEY_BYTES} bytes when stated. */
  readonly idempotencyKey?: string;
}

/** The wire shape of a purchase request. */
export const createBillingPurchaseRequestShape: Shape<CreateBillingPurchaseRequest> =
  object<CreateBillingPurchaseRequest>({
    amountMicros: always(microsShape),
    idempotencyKey: omitEmpty(string()),
  });

/**
 * Judges the request: a positive whole number of dollars and a bounded key.
 * Throws a `TypeError`.
 */
export function validateCreateBillingPurchaseRequest(
  request: CreateBillingPurchaseRequest,
): void {
  validateDollarAmount("amountMicros", request.amountMicros);
  validateBillingIdempotencyKey(request.idempotencyKey ?? "");
}

/** Renders a purchase request as the document the route carries. */
export function encodeCreateBillingPurchaseRequest(
  request: CreateBillingPurchaseRequest,
): JsonObject {
  return createBillingPurchaseRequestShape.encode(request) as JsonObject;
}

/**
 * A purchase of extra usage, served at
 * `/v1/accounts/{account}/billing/purchases/{id}`. Creating one answers
 * within a short bounded wait, finished or pending, and the caller reads it
 * until its state is final. A purchase on an Account with no saved card
 * waits for the user in Stripe Checkout (`checkout`); one the card's issuer
 * asks the user to authenticate goes there too. An auto-refill purchase is
 * charged with no user present, so a charge that needs the user fails it
 * with `PAYMENT_DECLINED` and turns auto-refill off.
 *
 * {@link decodeBillingPurchase} reads one leniently, and
 * {@link validateBillingPurchase} judges it against this SDK's contract.
 */
export interface BillingPurchase {
  /** Names the purchase. Always written. */
  readonly id: BillingPurchaseId;
  /** Who made the purchase. Always written. */
  readonly kind: BillingPurchaseKind;
  /** The extra usage bought, before tax, in micro-dollars. Always written. */
  readonly amountMicros: Integer;
  /** Where the purchase is. Always written. */
  readonly state: BillingPurchaseState;
  /**
   * Why a failed purchase was not paid: `PAYMENT_DECLINED` or
   * `ACTION_EXPIRED`. Only a failed purchase carries one.
   */
  readonly reason?: string;
  /** The payment the user completes in Stripe, carried by a pending purchase that waits for one. */
  readonly action?: BillingAction;
  /** When the purchase was recorded. Always written. */
  readonly createdAt: string;
}

/** The wire shape of a purchase. */
export const billingPurchaseShape: Shape<BillingPurchase> =
  object<BillingPurchase>({
    id: always(string<BillingPurchaseId>()),
    kind: always(string<BillingPurchaseKind>()),
    amountMicros: always(microsShape),
    state: always(string<BillingPurchaseState>()),
    reason: omitEmpty(string()),
    action: pointer(billingActionShape),
    createdAt: always(timestampShape),
  });

/** Reads a purchase the platform served, leniently, as {@link decodeAccountBilling} reads billing. */
export function decodeBillingPurchase(document: unknown): BillingPurchase {
  return decodeValue(parsed(document), billingPurchaseShape, "lenient");
}

/** Renders a purchase as the document the platform emits. */
export function encodeBillingPurchase(purchase: BillingPurchase): JsonObject {
  return billingPurchaseShape.encode(purchase) as JsonObject;
}

/**
 * Judges the purchase: a canonical ID, a kind and a state this SDK names, a
 * positive whole number of dollars, a creation instant, and the fields each
 * state carries. A failed purchase states a reason this SDK names and
 * nothing else does; only a pending purchase carries an action. Throws a
 * `TypeError`.
 */
export function validateBillingPurchase(purchase: BillingPurchase): void {
  parseBillingPurchaseId(purchase.id);
  validateBillingPurchaseKind(purchase.kind);
  validateDollarAmount("amountMicros", purchase.amountMicros);
  validateBillingPurchaseState(purchase.state);
  validateOperationReason(
    purchase.state === "failed",
    purchase.reason ?? "",
    ERROR_CODE_PAYMENT_DECLINED,
    ERROR_CODE_ACTION_EXPIRED,
  );
  validatePendingAction(purchase.state === "pending", purchase.action);
  if (isZeroInstant(purchase.createdAt)) {
    throw new TypeError("createdAt is required");
  }
}

/** Returns the purchase as it stood when the create's wait ended. */
export interface CreateBillingPurchaseResponse {
  readonly purchase: BillingPurchase;
}

/** The wire shape of the purchase create's response. */
export const createBillingPurchaseResponseShape: Shape<CreateBillingPurchaseResponse> =
  object<CreateBillingPurchaseResponse>({
    purchase: always(billingPurchaseShape),
  });

/** Carries one purchase. */
export interface GetBillingPurchaseResponse {
  readonly purchase: BillingPurchase;
}

/** The wire shape of the purchase read's response. */
export const getBillingPurchaseResponseShape: Shape<GetBillingPurchaseResponse> =
  object<GetBillingPurchaseResponse>({
    purchase: always(billingPurchaseShape),
  });

/** One page of an Account's purchases of extra usage, newest first. */
export type ListBillingPurchasesResponse = ListResponse<BillingPurchase>;

/** The wire shape of a page of purchases. */
export const listBillingPurchasesResponseShape: Shape<ListBillingPurchasesResponse> =
  object<ListBillingPurchasesResponse>({
    items: always(array(billingPurchaseShape)),
    totalCount: always(integer({ unsigned: false, bits: 64 })),
    snapshotCursor: omitEmpty(string()),
    continue: omitEmpty(string()),
  });

/**
 * A session of Stripe's customer portal, where the user manages the
 * Account's card, billing address and tax IDs and reads its invoices and
 * receipts. Each create makes a new session; it is short-lived, so a client
 * opens `url` in the user's browser at once and creates another for a later
 * visit. Stripe returns the user to IDYL when they leave the portal. The
 * portal does not change plans: that is a {@link BillingPlanChange}.
 */
export interface BillingPortalSession {
  /**
   * The session's page, an absolute https URL. It signs whoever opens it in
   * to the Account's billing details, so it is shown only to the user who
   * asked for it. Always written.
   */
  readonly url: string;
}

/** The wire shape of a portal session. */
export const billingPortalSessionShape: Shape<BillingPortalSession> =
  object<BillingPortalSession>({ url: always(string()) });

/**
 * Judges the session: an absolute https URL with a host and no user
 * information. Throws a `TypeError`.
 */
export function validateBillingPortalSession(
  session: BillingPortalSession,
): void {
  validateHttpsUrl("url", session.url);
}

/** Reads a portal session the platform served, leniently, as {@link decodeAccountBilling} reads billing. */
export function decodeBillingPortalSession(
  document: unknown,
): BillingPortalSession {
  return decodeValue(parsed(document), billingPortalSessionShape, "lenient");
}

/** Renders a portal session as the document the platform emits. */
export function encodeBillingPortalSession(
  session: BillingPortalSession,
): JsonObject {
  return billingPortalSessionShape.encode(session) as JsonObject;
}

/** Returns a new portal session. */
export interface CreateBillingPortalSessionResponse {
  readonly portalSession: BillingPortalSession;
}

/** The wire shape of the portal session create's response. */
export const createBillingPortalSessionResponseShape: Shape<CreateBillingPortalSessionResponse> =
  object<CreateBillingPortalSessionResponse>({
    portalSession: always(billingPortalSessionShape),
  });

/** `document` parsed once when it is JSON text, and as given otherwise. */
function parsed(document: unknown): unknown {
  return typeof document === "string" ? parseJson(document) : document;
}

/**
 * Runs `validate` and rethrows its `TypeError` with `prefix` joined to the
 * message without a separator, for refusals that begin with an index, as
 * `sizeRates[1]: ...`.
 */
function joined(prefix: string, validate: () => void): void {
  try {
    validate();
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError(`${prefix}${error.message}`, { cause: error });
    }
    throw error;
  }
}
