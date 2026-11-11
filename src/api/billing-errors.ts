// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * The codes below refuse a request, or fail an operation, because of an
 * Account's billing. Each is carried by the structured API error, and
 * clients classify on the code, never on the message. A refused request
 * changes nothing. The helpers that read each refusal's details, and the
 * details types they return, are `isOutOfUsage`, `sizeNotInPlan`,
 * `sizeBelowUsage` and `spendCapReached` beside the error classes.
 */

/**
 * Returned with HTTP 402 when a Computer's Account has used its month's
 * allowance and its extra usage, and auto-refill cannot buy more (standing
 * `out`). It refuses a session at once, and fails a wake, a pending session
 * (reason `OUT_OF_USAGE`) and a notebook cell (error reason
 * `out-of-usage`). It carries no details. A purchase, an upgrade or the
 * start of the Account's next period lets its Computers wake again.
 */
export const ERROR_CODE_OUT_OF_USAGE = "OUT_OF_USAGE";

/**
 * Returned with HTTP 402 when a wake, or a change of a Computer's CPU and
 * memory to a larger size, names a size larger than the Account's plan
 * includes. A change to a size no larger than the Computer's own is never
 * refused with it. It refuses a resize at once, and fails a wake, a pending
 * session (reason `SIZE_NOT_IN_PLAN`) and a notebook cell (error reason
 * `size-not-in-plan`). The details carry the keys
 * {@link SIZE_NOT_IN_PLAN_DETAIL_SIZE},
 * {@link SIZE_NOT_IN_PLAN_DETAIL_LARGEST_SIZE},
 * {@link SIZE_NOT_IN_PLAN_DETAIL_PLAN} and
 * {@link SIZE_NOT_IN_PLAN_DETAIL_PLAN_NAME}; see `SizeNotInPlanDetails`.
 * A resize to a size the plan includes, or an
 * upgrade to the plan named, lets the Computer wake.
 */
export const ERROR_CODE_SIZE_NOT_IN_PLAN = "SIZE_NOT_IN_PLAN";

/**
 * The reason a wake fails when it would take the vCPU of the Account's awake
 * Computers past what its plan allows at once. It fails a wake, a pending
 * session (reason `VCPU_LIMIT_REACHED`) and a notebook cell (error reason
 * `vcpu-limit-reached`). It carries no details. Computers already awake keep
 * running. Putting another Computer to sleep, or upgrading to a plan with a
 * higher limit, lets the Computer wake. The count can briefly lag a change, so
 * a wake just after a sleep can fail with it and succeed when asked again.
 */
export const ERROR_CODE_VCPU_LIMIT_REACHED = "VCPU_LIMIT_REACHED";

/**
 * Returned with HTTP 429 and `Retry-After` when an Account with a download limit
 * has downloaded as much of its saved files as one window allows. An Account has
 * a limit on a free trial, on no plan, and on a paid plan while it is out of
 * usage. It refuses a download at once, and a download under way ends when it
 * passes the limit. The details carry `limitBytes` and `usedBytes`. A new window
 * opens when `Retry-After` has passed. On a paid plan, a purchase, an upgrade or
 * the start of the Account's next period lifts the limit.
 */
export const ERROR_CODE_DOWNLOAD_LIMIT_REACHED = "DOWNLOAD_LIMIT_REACHED";

/**
 * The reason a plan change or a purchase failed because the card was
 * declined, or could not be charged without the user, as an auto-refill
 * cannot. The plan in force is unchanged and nothing was charged. It is
 * also why auto-refill was turned off (`BillingAutoRefillStop`). The card
 * is changed in a portal session.
 */
export const ERROR_CODE_PAYMENT_DECLINED = "PAYMENT_DECLINED";

/**
 * Why auto-refill was turned off when a payment of the Account was
 * disputed with its card's issuer (`BillingAutoRefillStop`).
 */
export const ERROR_CODE_PAYMENT_DISPUTED = "PAYMENT_DISPUTED";

/**
 * The reason a plan change or a purchase failed because its
 * `BillingAction` expired before the user completed the payment. Nothing
 * was charged; a new change or purchase starts again.
 */
export const ERROR_CODE_ACTION_EXPIRED = "ACTION_EXPIRED";

/**
 * The reason a pending plan change failed because a later plan change of
 * the Account replaced it. Nothing was charged for it.
 */
export const ERROR_CODE_PLAN_CHANGE_SUPERSEDED = "PLAN_CHANGE_SUPERSEDED";

/**
 * The reason an upgrade failed because the platform could not make it as
 * priced. The plan in force is unchanged and nothing was charged. The same
 * change can be made again later.
 */
export const ERROR_CODE_PLAN_CHANGE_UNAVAILABLE = "PLAN_CHANGE_UNAVAILABLE";

/**
 * Returned with HTTP 422 when a plan change names a plan the platform does
 * not offer: one `AccountBillingStatus.plans` does not list.
 */
export const ERROR_CODE_PLAN_NOT_OFFERED = "PLAN_NOT_OFFERED";

/**
 * Returned with HTTP 402 when a purchase of extra usage, or an update that
 * turns auto-refill on, is made on a plan that does not include extra
 * usage (`BillingPlanOffer.extraUsage`). It carries no details. An upgrade
 * to a plan that includes it lets the Account buy.
 */
export const ERROR_CODE_EXTRA_USAGE_NOT_IN_PLAN = "EXTRA_USAGE_NOT_IN_PLAN";

/**
 * Returned with HTTP 409 when a purchase of extra usage would take what
 * the current period has bought, purchases paid and pending, past the
 * Account's spend cap. The details carry the keys
 * {@link SPEND_CAP_REACHED_DETAIL_SPEND_CAP} and
 * {@link SPEND_CAP_REACHED_DETAIL_BOUGHT}; see
 * `SpendCapReachedDetails`. A higher cap, a smaller amount or the
 * next period lets the purchase through.
 */
export const ERROR_CODE_SPEND_CAP_REACHED = "SPEND_CAP_REACHED";

/**
 * Returned with HTTP 422 when an update would leave auto-refill on with no
 * spend cap set: auto-refill never buys without a cap. It carries no
 * details.
 */
export const ERROR_CODE_AUTO_REFILL_NEEDS_SPEND_CAP =
  "AUTO_REFILL_NEEDS_SPEND_CAP";

/** The details key of a `SIZE_NOT_IN_PLAN` refusal naming the size refused, a `ComputerSize` string. */
export const SIZE_NOT_IN_PLAN_DETAIL_SIZE = "size";

/**
 * The details key of a `SIZE_NOT_IN_PLAN` refusal naming the largest size
 * the Account's plan includes, a `ComputerSize` string.
 */
export const SIZE_NOT_IN_PLAN_DETAIL_LARGEST_SIZE = "largestSize";

/**
 * The details key of a `SIZE_NOT_IN_PLAN` refusal naming the smallest plan
 * that includes the size, a `BillingPlan` string. It is absent when no plan
 * includes it.
 */
export const SIZE_NOT_IN_PLAN_DETAIL_PLAN = "plan";

/**
 * The details key of a `SIZE_NOT_IN_PLAN` refusal naming that plan's name
 * for display, such as `Max 5x`, a string. It is absent when no plan
 * includes the size.
 */
export const SIZE_NOT_IN_PLAN_DETAIL_PLAN_NAME = "planName";

/** The details key of a `SPEND_CAP_REACHED` refusal naming the Account's spend cap, in micro-dollars. */
export const SPEND_CAP_REACHED_DETAIL_SPEND_CAP = "spendCapMicros";

/**
 * The details key of a `SPEND_CAP_REACHED` refusal naming what the current
 * period has bought, purchases paid and pending, before the refused
 * purchase, in micro-dollars.
 */
export const SPEND_CAP_REACHED_DETAIL_BOUGHT = "boughtMicros";

/**
 * The details key of a `SIZE_BELOW_USAGE` refusal naming the bytes the
 * resource's current files use, a whole number. Earlier versions do not
 * count.
 */
export const SIZE_BELOW_USAGE_DETAIL_USED_BYTES = "usedBytes";

/**
 * The details key of a `SIZE_BELOW_USAGE` refusal naming the size the
 * refused change would leave for those files, in bytes, a whole number.
 */
export const SIZE_BELOW_USAGE_DETAIL_SIZE_BYTES = "sizeBytes";

/**
 * The details key of a `SIZE_BELOW_USAGE` refusal naming the
 * `ComputerSize` the refused change names, a string. It is present only
 * when the refusal is of a change to a Computer's CPU and memory.
 */
export const SIZE_BELOW_USAGE_DETAIL_COMPUTER_SIZE = "computerSize";
