// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  operationPauses,
  pollUntil,
  saveResultPauses,
  sessionPlacementPauses,
  type PauseSchedule,
  type WaitEvents,
} from "../src/wait.js";

/** The first `n` pauses `schedule` gives, each at the elapsed time stated. */
function pauses(
  schedule: PauseSchedule,
  streaming: boolean,
  elapsed: readonly number[],
): number[] {
  return elapsed.map((ms) => schedule(streaming, ms));
}

/** Events a test delivers by hand, with the stream open or not. */
class HandEvents implements WaitEvents {
  open = true;
  readonly #wakes = new Set<() => void>();

  streaming = (): boolean => this.open;

  listen = (wake: () => void): (() => void) => {
    this.#wakes.add(wake);
    return () => this.#wakes.delete(wake);
  };

  /** Delivers one event to every wait listening. */
  deliver(): void {
    for (const wake of this.#wakes) wake();
  }

  get listeners(): number {
    return this.#wakes.size;
  }
}

describe("wait pauses", () => {
  // Contract: a session not yet placed is read 100 ms after the last read,
  // doubling to 1 s, with an event stream open as without one: an event
  // the stream does not carry never leaves the session unread for longer.
  it("paces a session not yet placed", () => {
    const zeros = Array<number>(8).fill(0);
    const paced = [100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000];
    expect(pauses(sessionPlacementPauses(), false, zeros)).toEqual(paced);
    expect(pauses(sessionPlacementPauses(), true, zeros)).toEqual(paced);
  });

  // Contract: with no event stream an operation is read every 500 ms for
  // the first 10 s of its wait, then after 1, 2 and 4 s, then every 5 s.
  it("paces an operation with no event stream", () => {
    expect(
      pauses(
        operationPauses(),
        false,
        [0, 500, 9_999, 10_000, 11_000, 13_000, 17_000, 22_000, 27_000],
      ),
    ).toEqual([500, 500, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
  });

  // Contract: with an event stream an operation is read 500 ms after the
  // last read, doubling to 5 s, each read a guard against a lost event.
  it("paces an operation with an event stream", () => {
    expect(pauses(operationPauses(), true, Array<number>(6).fill(0))).toEqual([
      500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });

  // Contract: a command's save result is read every 250 ms with no event
  // stream, and 250 ms doubling to 5 s with one.
  it("paces a command's save result", () => {
    const zeros = Array<number>(7).fill(0);
    expect(pauses(saveResultPauses(), false, zeros)).toEqual(
      Array<number>(7).fill(250),
    );
    expect(pauses(saveResultPauses(), true, zeros)).toEqual([
      250, 500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });
});

describe("the wait loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Contract: an event for what the wait waits for ends the pause under
  // way, so the next read is made at once rather than at the schedule's
  // pause.
  it("reads at once on an event", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events = new HandEvents();
    let reads = 0;
    let done = false;
    const waiting = pollUntil<number>(
      { timeoutMs: 60_000 },
      {
        pauses: () => 5_000,
        events,
        read: () => Promise.resolve(++reads),
        met: () => done,
        timeoutMessage: () => "wait exceeded",
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    done = true;
    events.deliver();
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting).toBe(2);
    expect(events.listeners).toBe(0);
  });

  // Contract: an event that arrives while a read is under way skips the
  // pause that would follow it, so a change the read missed is read next.
  it("skips the next pause after an event during a read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events = new HandEvents();
    let reads = 0;
    const waiting = pollUntil<number>(
      { timeoutMs: 60_000 },
      {
        pauses: () => 5_000,
        events,
        read: () => {
          reads += 1;
          if (reads === 1) events.deliver();
          return Promise.resolve(reads);
        },
        met: (n) => n === 2,
        timeoutMessage: () => "wait exceeded",
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting).toBe(2);
  });

  // Contract: the schedule is told whether the event stream is open at
  // each pause, so a wait whose stream closes falls back to the pauses for
  // no stream.
  it("asks the schedule whether the stream is open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events = new HandEvents();
    const seen: boolean[] = [];
    let reads = 0;
    const waiting = pollUntil<number>(
      { timeoutMs: 60_000 },
      {
        pauses: (streaming) => {
          seen.push(streaming);
          return 10;
        },
        events,
        read: () => {
          reads += 1;
          if (reads === 2) events.open = false;
          return Promise.resolve(reads);
        },
        met: (n) => n === 3,
        timeoutMessage: () => "wait exceeded",
      },
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toBe(3);
    expect(seen).toEqual([true, false]);
  });

  // Contract: a poll interval the options state takes the place of the
  // schedule.
  it("lets a stated poll interval replace the schedule", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let reads = 0;
    const waiting = pollUntil<number>(
      { timeoutMs: 60_000, pollIntervalMs: 7 },
      {
        pauses: () => 5_000,
        read: () => Promise.resolve(++reads),
        met: (n) => n === 3,
        timeoutMessage: () => "wait exceeded",
      },
    );
    await vi.advanceTimersByTimeAsync(14);
    expect(await waiting).toBe(3);
  });

  // Contract: a wait that is cancelled stops listening for events.
  it("stops listening when cancelled", async () => {
    const events = new HandEvents();
    const controller = new AbortController();
    const waiting = pollUntil<number>(
      { timeoutMs: 60_000, signal: controller.signal },
      {
        pauses: () => 5_000,
        events,
        read: () => Promise.resolve(1),
        met: () => false,
        timeoutMessage: () => "wait exceeded",
      },
    ).catch((error: unknown) => error);
    await Promise.resolve();
    expect(events.listeners).toBe(1);
    controller.abort(new Error("stopped"));
    expect(await waiting).toMatchObject({ message: "stopped" });
    expect(events.listeners).toBe(0);
  });
});
