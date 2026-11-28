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
  // doubling to 1 s with no event stream and to 5 s with one.
  it("paces a session not yet placed", () => {
    const zeros = Array<number>(8).fill(0);
    expect(pauses(sessionPlacementPauses(), false, zeros)).toEqual([
      100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000,
    ]);
    expect(pauses(sessionPlacementPauses(), true, zeros)).toEqual([
      100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000,
    ]);
  });

  // Contract: an operation's pauses in the first second of its wait are a
  // session's, 100 ms doubling; with no event stream they are then 500 ms
  // until 10 s into the wait, then 1, 2 and 4 s, then 5 s each time.
  it("paces an operation with no event stream", () => {
    expect(
      pauses(
        operationPauses(),
        false,
        [
          0, 100, 300, 700, 1_500, 9_999, 10_000, 11_000, 13_000, 17_000,
          22_000,
        ],
      ),
    ).toEqual([
      100, 200, 400, 800, 500, 500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });

  // Contract: with an event stream an operation's pauses in the first
  // second of its wait are a session's, and then 500 ms doubling to 5 s,
  // each read a guard against a lost event.
  it("paces an operation with an event stream", () => {
    expect(
      pauses(
        operationPauses(),
        true,
        [0, 100, 300, 700, 1_500, 2_000, 3_000, 5_000, 9_000, 14_000],
      ),
    ).toEqual([100, 200, 400, 800, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
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

  /**
   * The times, from the start of the wait, at which a wait with no event
   * stream reads an operation the platform finishes `doneAfterMs` into it,
   * on fake timers so no time passes.
   */
  async function operationReadTimes(doneAfterMs: number): Promise<number[]> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const started = Date.now();
    const reads: number[] = [];
    const waiting = pollUntil<string>(
      {},
      {
        initial: "pending",
        pauses: operationPauses(),
        read: () => {
          const at = Date.now() - started;
          reads.push(at);
          return Promise.resolve(at >= doneAfterMs ? "done" : "pending");
        },
        met: (state) => state === "done",
        timeoutMessage: () => "wait exceeded",
      },
    );
    await vi.advanceTimersByTimeAsync(doneAfterMs + 6_000);
    expect(await waiting).toBe("done");
    return reads;
  }

  // Contract: an operation answered pending is read 0.1, 0.3, 0.7 and 1.5 s
  // into its wait and then every 0.5 s to 10 s, then after 1, 2 and 4 s,
  // then every 5 s: the reads for operations that finish 0.6, 1.3, 2.1, 4.9
  // and 30 s into the wait.
  it("reads an operation at the times its schedule states", async () => {
    const halfSeconds = (from: number, to: number): number[] =>
      Array.from({ length: (to - from) / 500 + 1 }, (_, i) => from + i * 500);
    expect(await operationReadTimes(600)).toEqual([100, 300, 700]);
    expect(await operationReadTimes(1_300)).toEqual([100, 300, 700, 1_500]);
    expect(await operationReadTimes(2_100)).toEqual([
      100, 300, 700, 1_500, 2_000, 2_500,
    ]);
    expect(await operationReadTimes(4_900)).toEqual([
      100,
      300,
      700,
      ...halfSeconds(1_500, 5_000),
    ]);
    expect(await operationReadTimes(30_000)).toEqual([
      100,
      300,
      700,
      ...halfSeconds(1_500, 10_000),
      11_000,
      13_000,
      17_000,
      22_000,
      27_000,
      32_000,
    ]);
  });

  // Contract: a wait cancelled while it pauses between reads rejects at
  // once with the signal's reason and reads nothing more.
  it("ends at once when cancelled between reads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const controller = new AbortController();
    const reason = new Error("stopped by the caller");
    let reads = 0;
    const waiting = pollUntil<string>(
      { signal: controller.signal },
      {
        initial: "pending",
        pauses: operationPauses(),
        read: () => {
          reads += 1;
          return Promise.resolve("pending");
        },
        met: (state) => state === "done",
        timeoutMessage: () => "wait exceeded",
      },
    );
    const outcome = waiting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(reads).toBe(1);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe(reason);
    expect(reads).toBe(1);
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
