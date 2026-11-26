// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { signalOption } from "./internal/options.js";
import type { WaitEvaluation } from "./api/wait.js";
import { isNotFound } from "./errors.js";
import { abortReason, managedSignal } from "./internal/abort.js";

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
 * `undefined` follows the wait's own schedule of pauses, or polls every
 * 1 000 for a wait that has none. Both are milliseconds; `timeoutMs` must be
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
 * The pause before each read of a wait that follows a schedule of its own,
 * in milliseconds. `streaming` is whether an event stream that carries the
 * events which end the wait is open at that moment; `elapsedMs` is the time
 * since the wait began. A schedule is made for one wait and counts the
 * pauses it has given, so each wait takes a fresh one from its factory.
 */
export type PauseSchedule = (streaming: boolean, elapsedMs: number) => number;

/**
 * The pauses of a wait for a session the platform has not yet placed: 100
 * ms doubling to 1 000, whether or not an event stream is open. The session
 * is placed once its Computer's wake is far enough along, so it is read at
 * least once a second until then; an event for the session still makes the
 * wait read at once.
 */
export function sessionPlacementPauses(): PauseSchedule {
  let count = 0;
  return () => Math.min(100 * 2 ** count++, 1_000);
}

/**
 * The pauses of a wait for a wake, sleep, save, restore, fork, upload or
 * deletion. With no event stream: 500 ms for the first 10 000 ms of the
 * wait, then 1 000, 2 000 and 4 000, then every 5 000. With one: 500 ms
 * doubling to 5 000, each read a guard against a lost event.
 */
export function operationPauses(): PauseSchedule {
  let count = 0;
  let late = 0;
  return (streaming, elapsedMs) => {
    if (streaming) return Math.min(500 * 2 ** count++, 5_000);
    count += 1;
    if (elapsedMs < 10_000) return 500;
    return Math.min(1_000 * 2 ** late++, 5_000);
  };
}

/**
 * The pauses of a wait for the save result a command's session states:
 * every 250 ms with no event stream, and 250 ms doubling to 5 000 with one,
 * each read a guard against a lost event.
 */
export function saveResultPauses(): PauseSchedule {
  let count = 0;
  return (streaming) => (streaming ? Math.min(250 * 2 ** count++, 5_000) : 250);
}

/**
 * The events that end a wait's pause early. `streaming` reports whether
 * an event stream that carries them is open now, which chooses the
 * schedule's pauses; `listen` calls `wake` for each event naming what the
 * wait waits for, and returns the function that stops listening. An event
 * carries no state: it makes the wait read at once.
 */
export interface WaitEvents {
  readonly streaming: () => boolean;
  readonly listen: (wake: () => void) => () => void;
}

/**
 * What one poll needs: a snapshot already in hand, judged before any
 * request; a read of the object under the wait's signal, reporting
 * `undefined` when the object is gone; the judgement of one snapshot; the
 * timeout sentence for the bound applied; for a wait whose pauses follow a
 * schedule of its own, that schedule; and the events that make it read at
 * once.
 */
export interface PollTarget<T> {
  readonly initial?: T;
  readonly read: (signal: AbortSignal) => Promise<T | undefined>;
  /** Whether `current` meets the condition; throws to end the wait with a terminal failure. */
  readonly met: (current: T) => boolean;
  readonly timeoutMessage: (timeoutMs: number) => string;
  /**
   * The pause before each read that follows an observation. A
   * `pollIntervalMs` the options state takes its place; with neither, the
   * wait pauses for {@link DEFAULT_WAIT_POLL_INTERVAL_MS} every time.
   */
  readonly pauses?: PauseSchedule;
  /** The events that end a pause early; `undefined` when no stream carries any. */
  readonly events?: WaitEvents;
}

/**
 * The one polling loop every wait runs. A snapshot in hand is judged
 * first; otherwise, and after every pause, the object is read again and
 * judged, until `met` reports the condition or `read` reports the object
 * gone, in which case `undefined` is returned. An event the target's
 * `events` report ends the pause under way, or skips the next one when it
 * arrives during a read, so the wait reads at once. A zero timeout judges
 * once: the snapshot in hand, or without one a single read, and a pending
 * judgement throws as an exhausted timeout does. An exhausted timeout
 * throws a `TimeoutError` `DOMException`; cancellation throws the signal's
 * reason; a failure `met` or `read` throws propagates. The listeners and
 * timers the wait holds are released however it ends, and nothing is
 * deleted.
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
  const started = Date.now();
  const pauses =
    options.pollIntervalMs === undefined ? target.pauses : undefined;
  // An event during a read is kept for the pause that follows it.
  const event: { woken: boolean; wake: (() => void) | undefined } = {
    woken: false,
    wake: undefined,
  };
  const stopListening = target.events?.listen(() => {
    event.woken = true;
    event.wake?.();
  });
  try {
    let current = target.initial;
    let observed = current !== undefined;
    for (;;) {
      if (current !== undefined && target.met(current)) return current;
      if (observed) {
        const pause =
          pauses?.(target.events?.streaming() ?? false, Date.now() - started) ??
          wait.pollIntervalMs;
        if (!event.woken) {
          await wakeableDelay(pause, managed.signal, (resume) => {
            event.wake = resume;
          });
        }
        event.woken = false;
        event.wake = undefined;
      }
      current = await target.read(managed.signal);
      observed = true;
      if (current === undefined) return undefined;
    }
  } finally {
    stopListening?.();
    managed.cleanup();
  }
}

/**
 * Pauses for `milliseconds`, or until the function handed to `onWake` is
 * called, whichever comes first; rejects with the signal's reason when it
 * aborts first.
 */
async function wakeableDelay(
  milliseconds: number,
  signal: AbortSignal,
  onWake: (resume: () => void) => void,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    onWake(done);
  });
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
  /** The events that end a pause early; `undefined` when no stream carries any. */
  readonly events?: WaitEvents;
}

/**
 * Polls until the object is gone: the evaluator reports `deleted` met, or a
 * read answers 404, which is the caller's judgement that absence is the
 * condition. Every other verdict is pending; a served object that can be
 * read has not been deleted. It reads at once and then after each pause of
 * {@link operationPauses}, or of the poll interval the options state, never judging a snapshot in hand, so it answers without
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
    pauses: operationPauses(),
    ...(target.events === undefined ? {} : { events: target.events }),
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
