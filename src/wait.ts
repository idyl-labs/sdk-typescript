// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { signalOption } from "./internal/options.js";
import type { WaitEvaluation } from "./api/wait.js";
import { isNotFound } from "./errors.js";
import { abortReason, delay, managedSignal } from "./internal/abort.js";

/**
 * Controls polling for a lifecycle condition.
 *
 * `timeoutMs` bounds the whole wait; `undefined` allows 600000, ten
 * minutes. An explicit `0` judges the condition exactly once and returns
 * without waiting: the wait judges the state it starts from (a fresh read
 * for a service wait, and one read for a deletion wait), resolves with it when it meets the condition,
 * rejects with the wait's terminal error when it can no longer meet it, and
 * otherwise rejects with a `TimeoutError` `DOMException`, exactly as a wait
 * that ran out of time. `pollIntervalMs` is the pause between reads;
 * `undefined` polls every 1 000. Both are milliseconds; `timeoutMs` must be
 * zero or greater and `pollIntervalMs` greater than zero when given. A wait
 * that exhausts its timeout rejects with a `TimeoutError` `DOMException`;
 * one cancelled through `signal` rejects with the signal's reason. Neither
 * outcome deletes anything.
 */
export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

/** The wait timeout applied when the options set none, in milliseconds. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;

/** The poll interval applied when the options set none, in milliseconds. */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 1_000;

/** A wait's settings with the defaults applied. */
export interface NormalizedWait {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Applies the defaults and holds each value to the contract, throwing a
 * `TypeError` naming the field that is not a finite number of milliseconds
 * in range: zero or greater for `timeoutMs`, where zero means a single
 * judgement, and greater than zero for `pollIntervalMs`. It runs before any
 * network call so a wait that could never succeed is refused before it
 * creates anything.
 */
export function normalizeWaitOptions(options: WaitOptions): NormalizedWait {
  const timeoutMs = milliseconds(
    options.timeoutMs,
    DEFAULT_WAIT_TIMEOUT_MS,
    "wait timeoutMs",
    0,
  );
  const pollIntervalMs = milliseconds(
    options.pollIntervalMs,
    DEFAULT_WAIT_POLL_INTERVAL_MS,
    "wait pollIntervalMs",
    1,
  );
  return {
    timeoutMs,
    pollIntervalMs,
    ...signalOption(options.signal),
  };
}

/**
 * What one poll needs: a snapshot already in hand, judged before any
 * request; a read of the object under the wait's signal, reporting
 * `undefined` when the object is gone; the judgement of one snapshot; the
 * timeout sentence for the bound applied; and, for a wait whose pauses
 * follow a schedule of their own, the pause before each read.
 */
export interface PollTarget<T> {
  readonly initial?: T;
  readonly read: (signal: AbortSignal) => Promise<T | undefined>;
  /** Whether `current` meets the condition; throws to end the wait with a terminal failure. */
  readonly met: (current: T) => boolean;
  readonly timeoutMessage: (timeoutMs: number) => string;
  /**
   * The pause before read number `attempt`, counted from zero over the
   * reads that follow an observation, in milliseconds. It is consulted
   * just before each pause, so it may reflect what the previous read
   * reported. `undefined` pauses for the wait's poll interval every time.
   */
  readonly delay?: (attempt: number) => number;
}

/**
 * The one polling loop every wait runs. A snapshot in hand is judged
 * first; otherwise, and after every pause, of the poll interval or of the
 * target's own schedule, the object is read again and judged, until `met`
 * reports the condition or `read` reports the object gone, in which case
 * `undefined` is returned. A zero timeout judges once: the snapshot in
 * hand, or without one a single read, and a pending judgement throws as an
 * exhausted timeout does. An exhausted timeout throws a `TimeoutError`
 * `DOMException`; cancellation throws the signal's reason; a failure `met`
 * or `read` throws propagates. The listener and timer the wait holds are
 * released however it ends, and nothing is deleted.
 */
export async function pollUntil<T>(
  options: WaitOptions,
  target: PollTarget<T>,
): Promise<T | undefined> {
  const wait = normalizeWaitOptions(options);
  if (wait.timeoutMs === 0) return await judgeOnce(wait, target);
  const managed = managedSignal(
    wait.signal,
    wait.timeoutMs,
    target.timeoutMessage(wait.timeoutMs),
  );
  try {
    let current = target.initial;
    let observed = current !== undefined;
    for (let attempt = 0; ;) {
      if (current !== undefined && target.met(current)) return current;
      if (observed) {
        const pause = target.delay?.(attempt) ?? wait.pollIntervalMs;
        attempt += 1;
        await delay(pause, managed.signal);
      }
      current = await target.read(managed.signal);
      observed = true;
      if (current === undefined) return undefined;
    }
  } finally {
    managed.cleanup();
  }
}

/**
 * The single judgement a zero timeout asks for: the snapshot in hand, or
 * without one a single read under the caller's signal. A pending judgement
 * throws the caller's cancellation reason when the signal has aborted, and
 * otherwise the `TimeoutError` `DOMException` an exhausted timeout throws.
 */
async function judgeOnce<T>(
  wait: NormalizedWait,
  target: PollTarget<T>,
): Promise<T | undefined> {
  const managed = managedSignal(wait.signal, undefined, "");
  try {
    let current = target.initial;
    if (current === undefined) {
      current = await target.read(managed.signal);
      if (current === undefined) return undefined;
    }
    if (target.met(current)) return current;
    if (managed.signal.aborted) throw abortReason(managed.signal);
    throw new DOMException(target.timeoutMessage(0), "TimeoutError");
  } finally {
    managed.cleanup();
  }
}

/** What the deletion wait needs to read one object and judge it. */
export interface DeletionTarget<T> {
  readonly kind: string;
  readonly name: string;
  readonly read: (signal: AbortSignal) => Promise<T>;
  readonly evaluate: (current: T) => WaitEvaluation;
}

/**
 * Polls until the object is gone: the evaluator reports `deleted` met, or a
 * read answers 404, which is the caller's judgement that absence is the
 * condition. Every other verdict is pending; a served object that can be
 * read has not been deleted. It reads at once and then after each pause of
 * the poll interval, never judging a snapshot in hand, so it answers without
 * a one-interval delay and a timeout shorter than the poll interval still
 * makes one read; a zero timeout makes exactly one. It resolves with the
 * last read judged pending, the object as it was last seen, and with
 * `undefined` when none was. Timeout, cancellation, and release behave as
 * in {@link pollUntil}.
 */
export async function waitForDeletion<T>(
  options: WaitOptions,
  target: DeletionTarget<T>,
): Promise<T | undefined> {
  let last: T | undefined;
  await pollUntil<T>(options, {
    read: async (signal) => {
      try {
        return await target.read(signal);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    met: (current) => {
      if (target.evaluate(current).state === "met") return true;
      last = current;
      return false;
    },
    timeoutMessage: (timeoutMs) =>
      `wait for ${target.kind.toLowerCase()} ${JSON.stringify(target.name)} deletion exceeded ${String(timeoutMs)} ms`,
  });
  return last;
}

/**
 * `value`, or `fallback` when it is `undefined`. `floor` is `0` for a value
 * that may be zero and `1` for one that must be greater than zero; any
 * other value throws a `TypeError` naming `label`.
 */
function milliseconds(
  value: number | undefined,
  fallback: number,
  label: string,
  floor: 0 | 1,
): number {
  if (value === undefined) return fallback;
  const inRange = floor === 0 ? value >= 0 : value > 0;
  if (typeof value !== "number" || !Number.isFinite(value) || !inRange) {
    throw new TypeError(
      floor === 0
        ? `${label} must be zero or greater`
        : `${label} must be greater than zero`,
    );
  }
  return value;
}
