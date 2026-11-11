// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * An Account's billing: its plan, its usage and settings, its plan changes,
 * its purchases of extra usage and its Stripe portal sessions. Each public
 * view is built field by field from the served record, so a field the
 * product does not offer never reaches a caller.
 */
import type {
  AccountBilling as AccountBillingRecord,
  BillingAction as BillingActionRecord,
  BillingActionKind,
  BillingAllowanceWithheld,
  BillingPlan,
  BillingPlanChange as BillingPlanChangeRecord,
  BillingPlanChangeState,
  BillingPortalSession as BillingPortalSessionRecord,
  BillingPurchase as BillingPurchaseRecord,
  BillingPurchaseKind,
  BillingPurchaseState,
  BillingLifecycle,
  BillingRenewalState,
  BillingStanding,
  ComputerSize,
} from "../api/billing.js";
import {
  validateCreateBillingPlanChangeRequest,
  validateCreateBillingPurchaseRequest,
  validateUpdateAccountBillingRequest,
} from "../api/billing.js";
import { TransportError } from "../errors.js";
import { formatCpu, type CpuQuantity } from "../resource/cpu.js";
import { formatMemory, type MemoryQuantity } from "../resource/memory.js";
import { formatVolume, type VolumeQuantity } from "../resource/volume.js";
import {
  parseBillingPlanChangeId,
  parseBillingPurchaseId,
} from "../resource/uuid-id.js";
import type { PlacementContext } from "../internal/context.js";
import { isRecord } from "../internal/envelopes.js";
import { billingService, type BillingService } from "../services/billing.js";
import {
  offsetContinue,
  offsetOf,
  pageOf,
  requireLimit,
  signalOf,
  walk,
  type CallOptions,
  type ListOptions,
  type Page,
  type PageOptions,
} from "./common.js";
import { spelled } from "./records.js";

export type {
  BillingActionKind,
  BillingAllowanceWithheld,
  BillingPlan,
  BillingPlanChangeState,
  BillingPurchaseKind,
  BillingPurchaseState,
  BillingLifecycle,
  BillingRenewalState,
  BillingStanding,
  ComputerSize,
};
export {
  MICROS_PER_DOLLAR,
  isBillingPlanChangeStateFinal,
  isBillingPurchaseStateFinal,
} from "../api/billing.js";

/**
 * Whether auto-refill is on and how much each refill buys. A refill is an
 * extra usage purchase of kind `auto_refill`, made with the card the
 * Account pays with, at most one each time the balance reaches zero, and
 * never past the spend cap.
 */
export interface BillingAutoRefill {
  /** Whether auto-refill buys extra usage. */
  readonly enabled: boolean;
  /**
   * What one refill buys: a positive whole number of dollars, in
   * micro-dollars. It is kept while auto-refill is off.
   */
  readonly amountMicros: number;
}

/** What an Account's owner sets for its extra usage. */
export interface AccountBillingSpec {
  /**
   * Buys extra usage when the Account's extra usage balance reaches zero.
   * It is off when an Account is created. IDYL turns it off on its own
   * when a refill cannot be charged or a payment is disputed, and says why
   * in {@link AccountBillingStatus.autoRefillStopped}.
   */
  readonly autoRefill: BillingAutoRefill;
  /**
   * The most the Account spends on extra usage in one period, counting
   * purchases paid and pending, whether the owner bought them or
   * auto-refill did; a purchase that would pass it is refused with
   * `ERROR_CODE_SPEND_CAP_REACHED`. `undefined` means no cap, which is how
   * an Account starts. Auto-refill can be on only while a cap is set.
   */
  readonly spendCapMicros?: number;
}

/**
 * What one awake hour of a size costs, before tax, and the size this rate
 * prices, so a page can show the size with no second request. IDYL may leave out
 * every field but `size` and `perHourMicros`.
 */
export interface BillingSizeRate {
  readonly size: ComputerSize;
  /**
   * The price of one hour a Computer is awake at `size`, in micro-dollars;
   * a Computer is charged for the seconds it is awake. Zero is a rate.
   */
  readonly perHourMicros: number;
  /** The name to show a person for the size, such as `Small`. */
  readonly label?: string;
  /** The CPU limit of a Computer of the size, such as `2`. */
  readonly cpu?: string;
  /** The memory limit of a Computer of the size, such as `4Gi`. */
  readonly memory?: string;
  /** The most a Computer of the size can store, such as `20Gi`. */
  readonly disk?: string;
  /** `true` when a Computer that states no size, CPU or memory runs at the size. */
  readonly default?: boolean;
}

/**
 * A change of plan that takes effect at the end of the current period: a
 * downgrade, or a cancellation, which is a change to `none`. When it takes
 * effect, the Account's awake Computers larger than `largestSize` are asked
 * to sleep, and each needs a size no larger than it, or an upgrade, before
 * it can wake again. A plan change to the plan in force undoes it.
 */
export interface BillingScheduledChange {
  /** The plan the Account changes to. */
  readonly plan: BillingPlan;
  /** When the change takes effect, the end of the current period, as an RFC 3339 instant. */
  readonly at: string;
  /** The largest size `plan` includes. */
  readonly largestSize: ComputerSize;
}

/** Why and when IDYL turned auto-refill off. */
export interface BillingAutoRefillStop {
  /**
   * `ERROR_CODE_PAYMENT_DECLINED` when a refill could not be charged, or
   * `ERROR_CODE_PAYMENT_DISPUTED` when a payment of the Account was
   * disputed.
   */
  readonly reason: string;
  /** When auto-refill was turned off, as an RFC 3339 instant. */
  readonly at: string;
}

/** Names the smallest plan that includes a size. */
export interface BillingSizePlan {
  readonly size: ComputerSize;
  /** The smallest plan whose largest size is at least `size`. */
  readonly plan: BillingPlan;
}

/** A plan as it is offered. */
export interface BillingPlanOffer {
  readonly plan: BillingPlan;
  /** The plan's name for display, such as `Max 5x`. */
  readonly name: string;
  /**
   * The plan's price for one month, before tax, which Stripe adds when it
   * charges, in micro-dollars. Zero for `trial` and `none`.
   */
  readonly priceMicros: number;
  /** The usage the plan grants each month, in micro-dollars. */
  readonly allowanceMicros: number;
  /** The largest size the plan includes. */
  readonly largestSize: ComputerSize;
  /**
   * The most data an Account on the plan stores across all its Computers,
   * saved history included, such as `400Gi` or `2Ti`. A save or an upload
   * that would go past it fails with `SAVE_REASON_ACCOUNT_STORAGE_LIMIT`.
   * `undefined` when the plan has no such limit.
   */
  readonly storedData?: string;
  /** Whether an Account on the plan can buy extra usage and turn on auto-refill. */
  readonly extraUsage: boolean;
}

/**
 * An Account's billing as IDYL reports it. Usage is counted as soon as it
 * is recorded, before it is settled, so the amounts are the ones the
 * Account's standing is judged on. Instants are RFC 3339 strings.
 */
export interface AccountBillingStatus {
  /** The plan in force. */
  readonly plan: BillingPlan;
  /**
   * The start of the current period, which is `[periodStart, periodEnd)`:
   * one month of the plan in force, or a trial's whole length. An upgrade
   * starts a new period at once.
   */
  readonly periodStart: string;
  /** The end of the current period: when the allowance resets, a paid plan renews and a trial ends. */
  readonly periodEnd: string;
  /**
   * The allowance granted for the current period: zero until a paid
   * period's renewal is paid, and zero when it was withheld
   * (`allowanceWithheld`). What is left of it when the period ends expires.
   */
  readonly allowanceMicros: number;
  /**
   * Why the current period's allowance was withheld, when it was;
   * `undefined` otherwise. `trial_one_per_person` is an unpaid allowance
   * withheld because it is given once per person and the verified sign-in
   * email of the Account's owner already holds it on another Account.
   * `trials_closed` is one withheld because new trials were closed when the
   * Account was created. A paid plan's allowance is never withheld for
   * either reason.
   */
  readonly allowanceWithheld?: BillingAllowanceWithheld;
  /**
   * How much of `allowanceMicros` the period's usage has used, never more
   * than `allowanceMicros`. Usage beyond the allowance draws on the extra
   * usage balance.
   */
  readonly usedMicros: number;
  /**
   * The extra usage bought and not yet used. It never expires and is used
   * only once the allowance is used up.
   */
  readonly extraBalanceMicros: number;
  /**
   * The extra usage bought in the current period, purchases paid and
   * pending, which is what the spend cap counts.
   */
  readonly extraBoughtMicros: number;
  /**
   * Whether the Account's Computers may wake: `ok`, or `out` when the
   * allowance and the extra usage are used and auto-refill cannot buy
   * more. An `out` Account's wakes and new sessions are refused with
   * `ERROR_CODE_OUT_OF_USAGE` and its awake Computers are asked to sleep,
   * their files kept. It is `ok` again after a purchase, an upgrade or the
   * start of its next period; its Computers are not woken by that.
   */
  readonly standing: BillingStanding;
  /**
   * Where the Account stands in its use of the platform: `full`, `trial`
   * while its free trial runs, or `ended` with no paid plan and nothing left
   * to spend. It tells an Account whose free usage has ended from a paying
   * Account that has used up its month, which a `standing` of `out` alone
   * cannot.
   */
  readonly lifecycle: BillingLifecycle;
  /**
   * Whether the plan's latest renewal was paid: `ok`, or `failed` while
   * Stripe retries a payment that failed. The period's allowance is granted
   * only once it is paid; if the retries end unpaid, the plan ends and the
   * Account is on `none`.
   */
  readonly renewal: BillingRenewalState;
  /**
   * The largest size the plan in force includes. A wake or a resize of a
   * Computer to a larger size is refused with `ERROR_CODE_SIZE_NOT_IN_PLAN`.
   */
  readonly largestSize: ComputerSize;
  /**
   * The most data the Account stores across all its Computers under the
   * plan in force, saved history included, such as `400Gi`. `undefined`
   * when the plan has no such limit.
   */
  readonly storedData?: string;
  /**
   * The plan the Account changes to at the end of the current period, when
   * a downgrade or a cancellation is scheduled; `undefined` when none is.
   */
  readonly scheduledChange?: BillingScheduledChange;
  /**
   * Why IDYL turned auto-refill off on its own; `undefined` when it did
   * not. It is cleared when auto-refill is turned on again.
   */
  readonly autoRefillStopped?: BillingAutoRefillStop;
  /** Whether Stripe holds invoices for the Account. A portal session shows them. */
  readonly hasInvoices: boolean;
  /**
   * For each size some plan includes, the smallest plan that includes it,
   * smallest size first.
   */
  readonly sizePlans: readonly BillingSizePlan[];
  /**
   * Every plan offered, cheapest first; it always lists the plan in force
   * and the plan of a scheduled change.
   */
  readonly plans: readonly BillingPlanOffer[];
  /**
   * What an awake hour of each size costs the Account's Computers under the
   * rate card in force now: one entry per size, smallest first.
   */
  readonly sizeRates: readonly BillingSizeRate[];
  /**
   * The rate in force now for storing one GiB for one month, in micro-dollars,
   * before tax. Zero is a rate.
   */
  readonly storageMicrosPerGiBMonth: number;
  /**
   * The rate in force now for downloading one GiB, in micro-dollars, before
   * tax. Zero is a rate.
   */
  readonly downloadMicrosPerGiB: number;
}

/**
 * An Account's billing: `spec` is what the Account's owner sets, and
 * `status` is what IDYL reports. Every Account has one, from sign-up onwards.
 * The plan is changed through a plan change, not through `spec`.
 *
 * Every amount of money is in US dollars, as a whole number of
 * micro-dollars (`MICROS_PER_DOLLAR` to the dollar), so usage priced by the
 * minute is exact and sums without rounding. Amounts are never negative.
 */
export interface AccountBilling {
  readonly spec: AccountBillingSpec;
  readonly status: AccountBillingStatus;
}

/**
 * A payment the user completes on a page Stripe hosts, for an operation
 * that waits for it. Open `url` in the user's browser; Stripe returns the
 * user to IDYL when the payment is done or abandoned. The operation
 * finishes once Stripe confirms the payment, and fails with
 * `ERROR_CODE_ACTION_EXPIRED` if the action expires first.
 */
export interface BillingAction {
  /**
   * `checkout`, a payment in Stripe Checkout where the user enters a card
   * and billing details, or `confirm_payment`, a payment of the saved card
   * that the card's issuer asks the user to authenticate.
   */
  readonly kind: BillingActionKind;
  /**
   * The page, an absolute https URL. It grants the payment it is for to
   * whoever opens it, so show it only to the user who acts.
   */
  readonly url: string;
  /** When the page stops accepting the payment, as an RFC 3339 instant. */
  readonly expiresAt: string;
}

/**
 * A request to change an Account's plan. Creating one answers within a
 * short bounded wait, finished or pending, and the caller reads it until
 * `isBillingPlanChangeStateFinal` says its state is final. What a change
 * does depends on the plan in force and the plan it names:
 *
 * - From `trial` or `none` to a paid plan, the change waits for the user in Stripe
 *   Checkout and is applied once Stripe confirms the first payment.
 * - To a plan with a higher price, it is an upgrade: it takes effect at
 *   once, a new period starts with the new plan's whole allowance, what was
 *   left of the old allowance expires, and Stripe charges the saved card the
 *   new plan's price less a credit for the unused part of the old period. A
 *   charge the card's issuer asks the user to authenticate waits for the
 *   user; a declined charge fails the change with
 *   `ERROR_CODE_PAYMENT_DECLINED` and leaves the plan as it was. An
 *   upgrade the platform cannot make as priced fails with
 *   `ERROR_CODE_PLAN_CHANGE_UNAVAILABLE`, with nothing charged and the plan
 *   as it was.
 * - To a plan with a lower price, `none` included, it is scheduled for the
 *   end of the current period, in place of any change scheduled before.
 * - To the plan in force, it undoes a scheduled change and is applied at
 *   once; with nothing scheduled it changes nothing.
 *
 * A change made while another is pending supersedes it: the earlier one
 * fails with `ERROR_CODE_PLAN_CHANGE_SUPERSEDED`. A change is kept for a
 * while after it is final, and then reads HTTP 404.
 */
export interface BillingPlanChange {
  readonly id: string;
  /** The plan the change is to. */
  readonly plan: BillingPlan;
  /** `pending`, `applied`, `scheduled` or `failed`. */
  readonly state: BillingPlanChangeState;
  /**
   * Why a failed change was not made: `ERROR_CODE_PAYMENT_DECLINED`,
   * `ERROR_CODE_ACTION_EXPIRED`, `ERROR_CODE_PLAN_CHANGE_SUPERSEDED` or
   * `ERROR_CODE_PLAN_CHANGE_UNAVAILABLE`.
   * Only a failed change carries one.
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

/**
 * A purchase of extra usage. Creating one answers within a short bounded
 * wait, finished or pending, and the caller reads it until
 * `isBillingPurchaseStateFinal` says its state is final. A purchase on an
 * Account with no saved card waits for the user in Stripe Checkout; one the
 * card's issuer asks the user to authenticate goes there too. An
 * auto-refill purchase is charged with no user present, so a charge that
 * needs the user fails it with `ERROR_CODE_PAYMENT_DECLINED` and turns
 * auto-refill off.
 */
export interface BillingPurchase {
  readonly id: string;
  /** `manual`, a purchase a user created, or `auto_refill`. */
  readonly kind: BillingPurchaseKind;
  /** The extra usage bought, before tax, in micro-dollars. */
  readonly amountMicros: number;
  /**
   * `pending`, which counts against the spend cap; `paid`, whose amount is
   * in the extra usage balance; or `failed`, which charged nothing and no
   * longer counts against the cap.
   */
  readonly state: BillingPurchaseState;
  /**
   * Why a failed purchase was not paid: `ERROR_CODE_PAYMENT_DECLINED` or
   * `ERROR_CODE_ACTION_EXPIRED`. Only a failed purchase carries one.
   */
  readonly reason?: string;
  /** The payment the user completes in Stripe, carried by a pending purchase that waits for one. */
  readonly action?: BillingAction;
  /** When the purchase was recorded, as an RFC 3339 instant. */
  readonly createdAt: string;
}

/**
 * A session of Stripe's customer portal, where the user manages the
 * Account's card, billing address and tax IDs and reads its invoices and
 * receipts. It is short-lived: open `url` in the user's browser at once and
 * create another for a later visit. The portal does not change plans.
 */
export interface BillingPortalSession {
  /**
   * The session's page, an absolute https URL. It signs whoever opens it in
   * to the Account's billing details, so show it only to the user who asked
   * for it.
   */
  readonly url: string;
}

/**
 * Changes an Account's billing settings field by field: a field left out
 * keeps its value. The merged settings are judged as a whole: auto-refill
 * on with no cap is refused with `ERROR_CODE_AUTO_REFILL_NEEDS_SPEND_CAP`,
 * and auto-refill on for a plan without extra usage with
 * `ERROR_CODE_EXTRA_USAGE_NOT_IN_PLAN`. A refused update changes nothing.
 * Lowering the cap below what the period has bought already is allowed: it
 * refuses further purchases in the period.
 */
export interface UpdateBillingOptions extends CallOptions {
  /** Replaces the auto-refill setting whole. */
  readonly autoRefill?: BillingAutoRefill;
  /**
   * Replaces the spend cap, which must not be negative, in micro-dollars;
   * `null` removes it.
   */
  readonly spendCapMicros?: number | null;
}

/** Asks for the Account's plan to change. */
export interface CreatePlanChangeOptions extends CallOptions {
  /**
   * The plan to change to: one {@link AccountBillingStatus.plans} lists, or
   * the plan in force to undo a scheduled change.
   */
  readonly plan: BillingPlan;
  /**
   * Makes an equal retry within its window return the same change rather
   * than make a second one. At most 64 bytes.
   */
  readonly idempotencyKey?: string;
}

/**
 * Buys extra usage with the card the Account pays with. Only an Account on
 * a plan with extra usage can buy it (`ERROR_CODE_EXTRA_USAGE_NOT_IN_PLAN`),
 * and never past its spend cap (`ERROR_CODE_SPEND_CAP_REACHED`). A refused
 * purchase records nothing.
 */
export interface CreatePurchaseOptions extends CallOptions {
  /**
   * The extra usage to buy: a positive whole number of dollars, in
   * micro-dollars, before tax, which Stripe adds.
   */
  readonly amountMicros: number;
  /**
   * Makes an equal retry within its window return the same purchase rather
   * than charge twice. At most 64 bytes.
   */
  readonly idempotencyKey?: string;
}

/** The Account's purchases of extra usage, newest first, auto-refill purchases included. */
export interface BillingPurchases {
  /**
   * Buys extra usage. The answer is the purchase as it stood when IDYL's
   * short wait ended: paid or failed, or pending, in which case its
   * `action` may name a page the user completes in Stripe.
   */
  create(options: CreatePurchaseOptions): Promise<BillingPurchase>;
  /** Reads one purchase. */
  get(purchaseId: string, options?: CallOptions): Promise<BillingPurchase>;
  /** Every purchase, page by page. */
  list(options?: ListOptions): AsyncIterable<BillingPurchase>;
  /** One page of the purchases. */
  listPage(options?: PageOptions): Promise<Page<BillingPurchase>>;
}

/**
 * The billing of the Account the client's credential acts as. Read it when
 * a program starts and in the background: no wake, session or command
 * needs a billing read first, since each answers a billing refusal itself
 * (`isOutOfUsage`, `sizeNotInPlan`). Every request is judged before it is
 * sent: an invalid option or a malformed ID throws a `TypeError` and sends
 * nothing.
 */
export interface Billing {
  /** The Account's billing. */
  get(options?: CallOptions): Promise<AccountBilling>;
  /** Changes the Account's billing settings and returns the billing as the update left it. */
  update(options: UpdateBillingOptions): Promise<AccountBilling>;
  /**
   * Asks for the Account's plan to change. The answer is the change as it
   * stood when IDYL's short wait ended: applied, scheduled or failed, or
   * pending, in which case its `action` may name a page the user completes
   * in Stripe.
   */
  createPlanChange(
    options: CreatePlanChangeOptions,
  ): Promise<BillingPlanChange>;
  /** Reads one plan change of the Account. */
  getPlanChange(
    planChangeId: string,
    options?: CallOptions,
  ): Promise<BillingPlanChange>;
  /** Opens a new session of Stripe's customer portal for the Account. */
  createPortalSession(options?: CallOptions): Promise<BillingPortalSession>;
  /** The Account's purchases of extra usage. */
  readonly purchases: BillingPurchases;
}

/** Builds the billing of the Account the client's credential acts as. */
export function billing(
  context: (options?: CallOptions) => Promise<PlacementContext>,
): Billing {
  const service = async (
    options: CallOptions | undefined,
  ): Promise<{
    readonly context: PlacementContext;
    readonly service: BillingService;
  }> => {
    const resolved = await context(options);
    return {
      context: resolved,
      service: billingService(resolved.state, resolved.scope.accountId),
    };
  };
  const listPage = async (
    options: PageOptions = {},
  ): Promise<Page<BillingPurchase>> => {
    const limit = requireLimit(options.limit);
    const offset = offsetOf(options.continue) ?? 0;
    const page = await (
      await service(options)
    ).service.purchases.list(
      {
        ...(limit === undefined ? {} : { limit }),
        ...(offset === 0 ? {} : { offset }),
      },
      signalOf(options),
    );
    return pageOf(
      page.items.map(purchaseOf),
      offsetContinue(offset, page.items.length, page.totalCount),
    );
  };
  return Object.freeze({
    async get(options: CallOptions = {}) {
      const resolved = await service(options);
      const { billing: record } = await resolved.service.get(signalOf(options));
      return await billingOf(record, resolved.context, options);
    },
    async update(options: UpdateBillingOptions) {
      const request = updateRequest(options);
      validateUpdateAccountBillingRequest(request);
      const resolved = await service(options);
      const { billing: record } = await resolved.service.update(
        request,
        signalOf(options),
      );
      return await billingOf(record, resolved.context, options);
    },
    async createPlanChange(options: CreatePlanChangeOptions) {
      if (typeof (options.plan as unknown) !== "string") {
        throw new TypeError("plan must be a string");
      }
      const request = {
        plan: options.plan,
        ...keyOption(options.idempotencyKey),
      };
      validateCreateBillingPlanChangeRequest(request);
      const { planChange } = await (
        await service(options)
      ).service.createPlanChange(request, signalOf(options));
      return planChangeOf(planChange);
    },
    async getPlanChange(planChangeId: string, options: CallOptions = {}) {
      const id = parseBillingPlanChangeId(planChangeId);
      const { planChange } = await (
        await service(options)
      ).service.getPlanChange(id, signalOf(options));
      return planChangeOf(planChange);
    },
    async createPortalSession(options: CallOptions = {}) {
      const { portalSession } = await (
        await service(options)
      ).service.createPortalSession(signalOf(options));
      return portalSessionOf(portalSession);
    },
    purchases: Object.freeze({
      async create(options: CreatePurchaseOptions) {
        const request = {
          amountMicros: requireMicros(options.amountMicros, "amountMicros"),
          ...keyOption(options.idempotencyKey),
        };
        validateCreateBillingPurchaseRequest(request);
        const { purchase } = await (
          await service(options)
        ).service.purchases.create(request, signalOf(options));
        return purchaseOf(purchase);
      },
      async get(purchaseId: string, options: CallOptions = {}) {
        const id = parseBillingPurchaseId(purchaseId);
        const { purchase } = await (
          await service(options)
        ).service.purchases.get(id, signalOf(options));
        return purchaseOf(purchase);
      },
      list: (options: ListOptions = {}) => walk(listPage, options),
      listPage,
    }),
  });
}

/**
 * The settings update an option set states, its numbers judged as whole
 * numbers of micro-dollars before the update's own validation judges it.
 */
function updateRequest(options: UpdateBillingOptions): {
  readonly autoRefill?: {
    readonly enabled: boolean;
    readonly amountMicros: number;
  };
  readonly spendCapMicros?: number | null;
} {
  const { autoRefill, spendCapMicros } = options;
  if (
    autoRefill !== undefined &&
    (typeof (autoRefill as unknown) !== "object" ||
      (autoRefill as unknown) === null ||
      typeof (autoRefill.enabled as unknown) !== "boolean")
  ) {
    throw new TypeError(
      "autoRefill must be an object with a boolean enabled and an amountMicros",
    );
  }
  return {
    ...(autoRefill === undefined
      ? {}
      : {
          autoRefill: {
            enabled: autoRefill.enabled,
            amountMicros: requireMicros(
              autoRefill.amountMicros,
              "autoRefill.amountMicros",
            ),
          },
        }),
    ...(spendCapMicros === undefined
      ? {}
      : {
          spendCapMicros:
            spendCapMicros === null
              ? null
              : requireMicros(spendCapMicros, "spendCapMicros"),
        }),
  };
}

/** Judges an amount a caller states: a safe integer of micro-dollars. */
function requireMicros(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a whole number of micro-dollars`);
  }
  return value;
}

/** The idempotency key a caller states, as the request's own field. */
function keyOption(key: unknown): { readonly idempotencyKey?: string } {
  if (key === undefined) return {};
  if (typeof key !== "string") {
    throw new TypeError("idempotencyKey must be a string");
  }
  return { idempotencyKey: key };
}

/**
 * The public view of a served billing. The rates are the ones the
 * Account's Computers are charged: those of the place they live in when
 * its rate card differs from the default, read through the client's
 * placement only then, and the default rates otherwise.
 */
async function billingOf(
  record: AccountBillingRecord,
  context: PlacementContext,
  options: CallOptions,
): Promise<AccountBilling> {
  const spec = objectOf(record.spec);
  const status = objectOf(record.status);
  const autoRefill = objectOf(spec["autoRefill"]);
  const cap = spec["spendCapMicros"];
  const scheduled = status["scheduledChange"];
  const stopped = status["autoRefillStopped"];
  const withheld = status["allowanceWithheld"];
  return Object.freeze({
    spec: Object.freeze({
      autoRefill: Object.freeze({
        enabled: autoRefill["enabled"] === true,
        amountMicros: micros(autoRefill["amountMicros"]),
      }),
      ...(cap === undefined || cap === null
        ? {}
        : { spendCapMicros: micros(cap) }),
    }),
    status: Object.freeze({
      plan: text(status["plan"]),
      periodStart: text(status["periodStart"]),
      periodEnd: text(status["periodEnd"]),
      allowanceMicros: micros(status["allowanceMicros"]),
      ...(typeof withheld === "string" && withheld !== ""
        ? { allowanceWithheld: withheld }
        : {}),
      usedMicros: micros(status["usedMicros"]),
      extraBalanceMicros: micros(status["extraBalanceMicros"]),
      extraBoughtMicros: micros(status["extraBoughtMicros"]),
      standing: text(status["standing"]),
      lifecycle: text(status["lifecycle"]),
      renewal: text(status["renewal"]),
      largestSize: text(status["largestSize"]),
      ...quantityText(
        "storedData",
        status["storedData"] as VolumeQuantity | undefined,
        formatVolume,
      ),
      ...(isRecord(scheduled)
        ? {
            scheduledChange: Object.freeze({
              plan: text(scheduled["plan"]),
              at: text(scheduled["at"]),
              largestSize: text(scheduled["largestSize"]),
            }),
          }
        : {}),
      ...(isRecord(stopped)
        ? {
            autoRefillStopped: Object.freeze({
              reason: text(stopped["reason"]),
              at: text(stopped["at"]),
            }),
          }
        : {}),
      hasInvoices: status["hasInvoices"] === true,
      sizePlans: listOf(status["sizePlans"], (item) =>
        Object.freeze({ size: text(item["size"]), plan: text(item["plan"]) }),
      ),
      plans: listOf(status["plans"], (item) =>
        Object.freeze({
          plan: text(item["plan"]),
          name: text(item["name"]),
          priceMicros: micros(item["priceMicros"]),
          allowanceMicros: micros(item["allowanceMicros"]),
          largestSize: text(item["largestSize"]),
          ...quantityText(
            "storedData",
            item["storedData"] as VolumeQuantity | undefined,
            formatVolume,
          ),
          extraUsage: item["extraUsage"] === true,
        }),
      ),
      sizeRates: await chargedRates(record, context, options),
      storageMicrosPerGiBMonth: micros(status["storageMicrosPerGiBMonth"]),
      downloadMicrosPerGiB: micros(status["downloadMicrosPerGiB"]),
    }),
  });
}

/**
 * The rates the Account's Computers are charged. The billing read names
 * the default rates and, apart, the rates of every place the Account may
 * use whose rate card differs; only when it names any is the client's one
 * place resolved to choose among them.
 */
async function chargedRates(
  record: AccountBillingRecord,
  context: PlacementContext,
  options: CallOptions,
): Promise<readonly BillingSizeRate[]> {
  const status = objectOf(record.status);
  const overrides = status["subnetSizeRates"];
  let rates: unknown = status["sizeRates"];
  if (Array.isArray(overrides) && overrides.length > 0) {
    const { subnet } = await context.placement.resolve(
      context.scope.accountId,
      signalOf(options),
    );
    const own = (overrides as readonly unknown[]).find(
      (entry) => isRecord(entry) && entry["subnet"] === subnet,
    );
    if (isRecord(own)) rates = own["sizeRates"];
  }
  return listOf(rates, (item: Record<string, unknown>) =>
    Object.freeze({
      size: text(item["size"]),
      perHourMicros: micros(item["perHourMicros"]),
      ...optionalText(item, "label"),
      ...quantityText("cpu", item["cpu"] as CpuQuantity | undefined, formatCpu),
      ...quantityText(
        "memory",
        item["memory"] as MemoryQuantity | undefined,
        formatMemory,
      ),
      ...quantityText(
        "disk",
        item["disk"] as VolumeQuantity | undefined,
        formatVolume,
      ),
      ...(item["default"] === true ? { default: true } : {}),
    } satisfies BillingSizeRate),
  );
}

/** The public view of a served plan change. */
function planChangeOf(record: BillingPlanChangeRecord): BillingPlanChange {
  const change = objectOf(record);
  return Object.freeze({
    id: text(change["id"]),
    plan: text(change["plan"]),
    state: text(change["state"]),
    ...optionalText(change, "reason"),
    ...actionOption(change["action"]),
    ...optionalText(change, "effectiveAt"),
  });
}

/** The public view of a served purchase. */
function purchaseOf(record: BillingPurchaseRecord): BillingPurchase {
  const purchase = objectOf(record);
  return Object.freeze({
    id: text(purchase["id"]),
    kind: text(purchase["kind"]),
    amountMicros: micros(purchase["amountMicros"]),
    state: text(purchase["state"]),
    ...optionalText(purchase, "reason"),
    ...actionOption(purchase["action"]),
    createdAt: text(purchase["createdAt"]),
  });
}

/** The public view of a served portal session. */
function portalSessionOf(
  record: BillingPortalSessionRecord,
): BillingPortalSession {
  return Object.freeze({ url: text(objectOf(record)["url"]) });
}

/** A served payment page, when one is carried. */
function actionOption(value: unknown): { readonly action?: BillingAction } {
  if (!isRecord(value)) return {};
  const action = value as Partial<Record<keyof BillingActionRecord, unknown>>;
  return {
    action: Object.freeze({
      kind: text(action.kind),
      url: text(action.url),
      expiresAt: text(action.expiresAt),
    }),
  };
}

/**
 * A served field that must be an object, such as a billing's `spec`; a
 * response without one cannot be read.
 */
function objectOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TransportError(
      "invalid_response",
      "billing response carries no object where one is required",
    );
  }
  return value;
}

/** A served list of objects, each through `view`; anything else reads as empty. */
function listOf<T>(
  value: unknown,
  view: (item: Record<string, unknown>) => T,
): readonly T[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map(view),
  );
}

/** A served string, or the empty string when it is absent or not a string. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A served optional quantity in its spelling, present only when it has one. */
function quantityText<K extends string, T>(
  key: K,
  value: T | undefined,
  format: (value: T) => string,
): Readonly<Partial<Record<K, string>>> {
  const spelling = spelled(value, format);
  return (spelling === undefined ? {} : { [key]: spelling }) as Readonly<
    Partial<Record<K, string>>
  >;
}

/** A served optional string, present only when it is a non-empty string. */
function optionalText<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Readonly<Partial<Record<K, string>>> {
  const value = record[key];
  return (
    typeof value === "string" && value !== "" ? { [key]: value } : {}
  ) as Readonly<Partial<Record<K, string>>>;
}

/**
 * A served amount of micro-dollars. An amount that is not a whole number
 * within `Number.MAX_SAFE_INTEGER` cannot be shown as the number it is, so
 * the response is refused rather than read as another amount.
 */
function micros(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (value === undefined) return 0;
  throw new TransportError(
    "invalid_response",
    "billing response carries an amount that is not a safe whole number",
  );
}
