// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * An Account's billing is served by the global API under the Account's
 * path. Every request it sends is judged first: a body or an identifier
 * this SDK refuses throws a `TypeError` and sends nothing. Every response
 * is read leniently, through the kind's own decoder, and returned as its
 * envelope.
 */
import {
  decodeAccountBilling,
  decodeBillingPlanChange,
  decodeBillingPortalSession,
  decodeBillingPurchase,
  encodeCreateBillingPlanChangeRequest,
  encodeCreateBillingPurchaseRequest,
  encodeUpdateAccountBillingRequest,
  validateCreateBillingPlanChangeRequest,
  validateCreateBillingPurchaseRequest,
  validateUpdateAccountBillingRequest,
  type CreateBillingPlanChangeRequest,
  type CreateBillingPlanChangeResponse,
  type CreateBillingPortalSessionResponse,
  type CreateBillingPurchaseRequest,
  type CreateBillingPurchaseResponse,
  type GetAccountBillingResponse,
  type GetBillingPlanChangeResponse,
  type GetBillingPurchaseResponse,
  type ListBillingPurchasesResponse,
  type UpdateAccountBillingRequest,
  type UpdateAccountBillingResponse,
} from "../api/billing.js";
import type { ListOptions } from "../api/types.js";
import { account, resourceWithin } from "../internal/apipath.js";
import type { ServiceState } from "../internal/context.js";
import { readEnvelope, readList } from "../internal/envelopes.js";
import { listQuery } from "../internal/listquery.js";
import { signalOption } from "../internal/options.js";
import type { RequestOptions } from "../request.js";
import type { AccountId } from "../resource/id.js";
import {
  parseBillingPlanChangeId,
  parseBillingPurchaseId,
} from "../resource/uuid-id.js";

/**
 * The operations on one Account's billing, as `AccountBilling` describes:
 * its read and settings, its plan changes, its purchases of extra usage,
 * and its Stripe portal sessions. No Computer wake, session or cell needs a
 * billing call first: each answers a billing refusal itself.
 */
export interface BillingService {
  /** The Account's billing. */
  get(options?: RequestOptions): Promise<GetAccountBillingResponse>;
  /**
   * Changes the Account's billing settings field by field, as
   * `UpdateAccountBillingRequest` describes, and returns the billing as the
   * update left it. The request is judged with
   * `validateUpdateAccountBillingRequest` before it is sent, and sent with
   * `PATCH`; `spendCapMicros: null` removes the cap.
   */
  update(
    request: UpdateAccountBillingRequest,
    options?: RequestOptions,
  ): Promise<UpdateAccountBillingResponse>;
  /**
   * Asks for the Account's plan to change, as `BillingPlanChange`
   * describes. The answer is the change as it stood when the platform's
   * short wait ended: applied, scheduled or failed, or pending, in which
   * case its `action` may name a page the user completes in Stripe. The
   * request is judged with `validateCreateBillingPlanChangeRequest` before
   * it is sent.
   */
  createPlanChange(
    request: CreateBillingPlanChangeRequest,
    options?: RequestOptions,
  ): Promise<CreateBillingPlanChangeResponse>;
  /**
   * Reads one plan change of the Account. `planChangeId` must be a
   * canonical UUID; any other throws a `TypeError` and sends nothing. A
   * change past its retention window reads HTTP 404.
   */
  getPlanChange(
    planChangeId: string,
    options?: RequestOptions,
  ): Promise<GetBillingPlanChangeResponse>;
  /**
   * Opens a new session of Stripe's customer portal for the Account, as
   * `BillingPortalSession` describes. The session is short-lived: open its
   * URL at once.
   */
  createPortalSession(
    options?: RequestOptions,
  ): Promise<CreateBillingPortalSessionResponse>;
  /** The Account's purchases of extra usage. */
  readonly purchases: BillingPurchasesService;
}

/** The operations on one Account's purchases of extra usage. */
export interface BillingPurchasesService {
  /**
   * Buys extra usage, as `BillingPurchase` describes. The answer is the
   * purchase as it stood when the platform's short wait ended: paid or
   * failed, or pending, in which case its `action` may name a page the user
   * completes in Stripe. The request is judged with
   * `validateCreateBillingPurchaseRequest` before it is sent; a request
   * with an `idempotencyKey` is safe to retry.
   */
  create(
    request: CreateBillingPurchaseRequest,
    options?: RequestOptions,
  ): Promise<CreateBillingPurchaseResponse>;
  /**
   * Reads one purchase. `purchaseId` must be a canonical UUID; any other
   * throws a `TypeError` and sends nothing.
   */
  get(
    purchaseId: string,
    options?: RequestOptions,
  ): Promise<GetBillingPurchaseResponse>;
  /**
   * One page of the Account's purchases, newest first, auto-refill
   * purchases included. `options` is encoded as every list's is.
   */
  list(
    options?: ListOptions,
    request?: RequestOptions,
  ): Promise<ListBillingPurchasesResponse>;
}

const BILLING = "billing";
const PURCHASES = "purchases";

/** Builds the billing service for `accountId`. */
export function billingService(
  state: ServiceState,
  accountId: AccountId,
): BillingService {
  const { transport, endpoints } = state;
  const billing = (suffix = ""): string =>
    account(accountId, suffix === "" ? BILLING : `${BILLING}/${suffix}`);
  return Object.freeze({
    async get(options: RequestOptions = {}) {
      return readEnvelope(
        await transport.json<unknown>(
          "GET",
          endpoints.api,
          billing(),
          signalOption(options.signal),
        ),
        "billing",
        decodeAccountBilling,
      );
    },
    async update(
      request: UpdateAccountBillingRequest,
      options: RequestOptions = {},
    ) {
      validateUpdateAccountBillingRequest(request);
      return readEnvelope(
        await transport.json<unknown>("PATCH", endpoints.api, billing(), {
          body: encodeUpdateAccountBillingRequest(request),
          ...signalOption(options.signal),
        }),
        "billing",
        decodeAccountBilling,
      );
    },
    async createPlanChange(
      request: CreateBillingPlanChangeRequest,
      options: RequestOptions = {},
    ) {
      validateCreateBillingPlanChangeRequest(request);
      return readEnvelope(
        await transport.json<unknown>(
          "POST",
          endpoints.api,
          billing("plan-changes"),
          {
            body: encodeCreateBillingPlanChangeRequest(request),
            ...signalOption(options.signal),
          },
        ),
        "planChange",
        decodeBillingPlanChange,
      );
    },
    async getPlanChange(planChangeId: string, options: RequestOptions = {}) {
      const id = parseBillingPlanChangeId(planChangeId);
      return readEnvelope(
        await transport.json<unknown>(
          "GET",
          endpoints.api,
          resourceWithin(billing(), "plan-changes", id),
          signalOption(options.signal),
        ),
        "planChange",
        decodeBillingPlanChange,
      );
    },
    async createPortalSession(options: RequestOptions = {}) {
      return readEnvelope(
        await transport.json<unknown>(
          "POST",
          endpoints.api,
          billing("portal-sessions"),
          signalOption(options.signal),
        ),
        "portalSession",
        decodeBillingPortalSession,
      );
    },
    purchases: billingPurchasesService(state, billing()),
  } satisfies BillingService);
}

/** Builds the purchases service beneath the billing path `billing`. */
function billingPurchasesService(
  state: ServiceState,
  billing: string,
): BillingPurchasesService {
  const { transport, endpoints } = state;
  const collection = `${billing}/${PURCHASES}`;
  return Object.freeze({
    async create(
      request: CreateBillingPurchaseRequest,
      options: RequestOptions = {},
    ) {
      validateCreateBillingPurchaseRequest(request);
      return readEnvelope(
        await transport.json<unknown>("POST", endpoints.api, collection, {
          body: encodeCreateBillingPurchaseRequest(request),
          ...signalOption(options.signal),
        }),
        "purchase",
        decodeBillingPurchase,
      );
    },
    async get(purchaseId: string, options: RequestOptions = {}) {
      const id = parseBillingPurchaseId(purchaseId);
      return readEnvelope(
        await transport.json<unknown>(
          "GET",
          endpoints.api,
          resourceWithin(billing, PURCHASES, id),
          signalOption(options.signal),
        ),
        "purchase",
        decodeBillingPurchase,
      );
    },
    async list(options: ListOptions = {}, request: RequestOptions = {}) {
      const query = listQuery(options);
      return readList(
        await transport.json<unknown>(
          "GET",
          endpoints.api,
          `${collection}${query}`,
          signalOption(request.signal),
        ),
        "billing purchases",
        decodeBillingPurchase,
      );
    },
  } satisfies BillingPurchasesService);
}
