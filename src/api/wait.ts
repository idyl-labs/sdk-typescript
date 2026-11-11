// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { integerEqual } from "../internal/strictdecode.js";
import type { Integer } from "../resource/json.js";
/*
 * A wait is a client-side loop over reads, and the loop is the same for
 * every kind: read the object, evaluate the condition against it, stop on
 * met or failed, otherwise read again. What differs per kind is the
 * evaluation, and it is published here as a pure function per kind so that
 * every client, in every language, reaches the same verdict from the same
 * object. A service that waits delegates to its kind's evaluator; there is
 * never a second reading of the same state.
 *
 * Absence is the caller's judgement for every deleted wait: a read that
 * reports the resource gone is the condition met, and an object that can
 * still be read is pending whatever its phase.
 */
import type {
  Namespace,
  NamespaceResourceCount,
  NamespaceTermination,
} from "./namespace.js";
import type { Computer } from "./computer.js";
import {
  computerSessionReasonClass,
  type ComputerSession,
} from "./computer-session.js";

/**
 * A lifecycle condition a wait can hold for. It is one vocabulary for every
 * kind a wait can address; which conditions a kind supports is the kind's
 * own contract, stated by its evaluator.
 *
 * - `ready`: a Computer session can be attached.
 * - `deleted`: the API no longer returns the resource; while the resource
 *   is still observable the evaluation stays pending.
 */
export type WaitCondition = "ready" | "deleted";

/**
 * The verdict of evaluating a condition against one object.
 *
 * - `pending`: not yet satisfied; further observation may satisfy it.
 * - `met`: satisfied; the wait ends successfully.
 * - `failed`: the object can no longer satisfy the condition, or the
 *   condition is unsupported for the kind; the wait ends unsuccessfully.
 */
export type WaitState = "pending" | "met" | "failed";

/** The pure evaluation of a condition against one object. */
export interface WaitEvaluation {
  readonly state: WaitState;
  /** Prose for a person; never a contract, never parsed. */
  readonly message: string;
}

/**
 * Evaluates a condition against a served Namespace. Only `deleted` applies,
 * and a Namespace that can still be read has not been deleted, so every
 * phase is pending: an active Namespace says it is not terminating, a
 * terminating one names what still holds finalization back, and a phase
 * this SDK does not name is reported as it arrived. Absence is the caller's
 * judgement, as it is for every deleted wait: a read that reports 404 is
 * the condition met.
 */
export function evaluateNamespaceWait(
  namespace: Namespace,
  condition: WaitCondition,
): WaitEvaluation {
  switch (condition) {
    case "deleted":
      switch (namespace.phase) {
        case "active":
          return pending(`namespace ${namespace.name} is not terminating`);
        case "terminating":
          return pending(
            `namespace ${namespace.name} is terminating: ${namespaceHoldouts(namespace.termination)}`,
          );
        default:
          return pending(
            `namespace ${namespace.name} still exists in phase ${JSON.stringify(namespace.phase)}`,
          );
      }
    default:
      return unsupportedCondition("Namespace", condition);
  }
}

/**
 * Evaluates a condition against a served Computer. Only `deleted` applies:
 * every phase is pending while the Computer can still be read, a
 * terminating one awaits finalization, and absence is the caller's
 * judgement from a read that reports 404.
 */
export function evaluateComputerWait(
  computer: Computer,
  condition: WaitCondition,
): WaitEvaluation {
  switch (condition) {
    case "deleted":
      switch (computer.phase) {
        case "active":
          return pending(`computer ${computer.name} is not terminating`);
        case "terminating":
          return pending(
            `computer ${computer.name} is terminating: ${AWAITING_FINALIZATION}`,
          );
        default:
          return pending(
            `computer ${computer.name} still exists in phase ${JSON.stringify(computer.phase)}`,
          );
      }
    default:
      return unsupportedCondition("Computer", condition);
  }
}

/**
 * Evaluates a condition against a served Computer session. Only `ready`
 * applies. A ready session meets it; a pending session, and one in a phase
 * this SDK does not name, is pending; a session that is attached already,
 * or that ended, failed, or was cancelled, can no longer become ready and
 * fails it. The message appends the session's reason in parentheses when it
 * states one this SDK names.
 */
export function evaluateComputerSessionWait(
  session: ComputerSession,
  condition: WaitCondition,
): WaitEvaluation {
  if (condition !== "ready") {
    return unsupportedCondition("ComputerSession", condition);
  }
  const stated = session.status.reason ?? "";
  const reason =
    computerSessionReasonClass(stated) === undefined ? "" : ` (${stated})`;
  switch (session.status.phase) {
    case "ready":
      return met("computer session is ready");
    case "pending":
      return pending(`computer session is pending${reason}`);
    case "attached":
      return failure("computer session is already attached");
    case "ended":
      return failed(`computer session has ended${reason}`);
    case "failed":
      return failed(`computer session failed${reason}`);
    case "cancelled":
      return failed(`computer session was cancelled${reason}`);
    default:
      return pending(
        "computer session is in a phase this version does not name",
      );
  }
}

/**
 * The holdout message for a terminating object that nothing holds back any
 * more: the platform has drained it and has not yet finalized it.
 */
const AWAITING_FINALIZATION = "awaiting finalization";

/**
 * Names what keeps a terminating Namespace from finalizing, in the
 * platform's order: the Computers still to finalize, then each zone that
 * has not acknowledged or still reports live resources.
 */
function namespaceHoldouts(
  termination: NamespaceTermination | undefined,
): string {
  if (termination === undefined) return AWAITING_FINALIZATION;
  const holdouts: string[] = [];
  if (termination.computersRemaining > 0) {
    holdouts.push(
      `${countNoun(termination.computersRemaining, "computer")} remaining`,
    );
  }
  for (const zone of termination.zones) {
    if (!zone.acknowledged) {
      holdouts.push(`${zone.zone} unacknowledged`);
      continue;
    }
    const remaining = remainingByKind(zone.remaining);
    if (remaining !== "") holdouts.push(`${zone.zone}: ${remaining}`);
  }
  return holdouts.length === 0 ? AWAITING_FINALIZATION : holdouts.join("; ");
}

/**
 * Renders the kinds a zone still holds, as `<kind> 2, <kind> 1`, leaving out
 * kinds it reports at zero.
 */
function remainingByKind(counts: readonly NamespaceResourceCount[]): string {
  return counts
    .filter((count) => count.count > 0)
    .map((count) => `${count.kind} ${String(count.count)}`)
    .join(", ");
}

/** Renders a count with its noun, pluralized with a trailing `s`. */
function countNoun(count: Integer, noun: string): string {
  return integerEqual(count, 1) ? `1 ${noun}` : `${String(count)} ${noun}s`;
}

/**
 * The one verdict for a condition a kind does not have, whichever kind
 * vocabulary names the kind.
 */
function unsupportedCondition(
  kind: string,
  condition: WaitCondition,
): WaitEvaluation {
  return failed(
    `condition ${JSON.stringify(condition)} is not supported for ${kind}`,
  );
}

function pending(message: string): WaitEvaluation {
  return { state: "pending", message };
}

function met(message: string): WaitEvaluation {
  return { state: "met", message };
}

function failed(message: string): WaitEvaluation {
  return { state: "failed", message };
}

function failure(message: string): WaitEvaluation {
  return { state: "failed", message };
}
