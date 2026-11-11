// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable, delay, managedSignal } from "../src/internal/abort.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("managed signals", () => {
  // Contract: the managed signal follows its parent with the parent's reason
  // and releases its listener on cleanup.
  it("follows the parent and releases the listener", () => {
    const parent = new AbortController();
    const managed = managedSignal(parent.signal, undefined, "unused");
    expect(managed.signal.aborted).toBe(false);
    const reason = new Error("gone");
    parent.abort(reason);
    expect(managed.signal.reason).toBe(reason);
    managed.cleanup();
    const already = managedSignal(parent.signal, undefined, "unused");
    expect(already.signal.aborted).toBe(true);
    already.cleanup();
  });

  // Contract: the timeout aborts with a TimeoutError and cleanup clears it.
  it("times out with a TimeoutError unless cleaned up first", () => {
    vi.useFakeTimers();
    const timed = managedSignal(undefined, 10, "too slow");
    vi.advanceTimersByTime(10);
    expect(timed.signal.aborted).toBe(true);
    expect((timed.signal.reason as DOMException).name).toBe("TimeoutError");
    expect((timed.signal.reason as DOMException).message).toBe("too slow");
    timed.cleanup();
    const cleaned = managedSignal(undefined, 10, "too slow");
    cleaned.cleanup();
    vi.advanceTimersByTime(10);
    expect(cleaned.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => managedSignal(undefined, 0, "x")).toThrow("greater than zero");
  });
});

describe("abortable and delay", () => {
  // Contract: abortable rejects with the signal's reason when the signal
  // fires before the value settles, and settles with the value otherwise.
  it("races a value against the signal", async () => {
    const controller = new AbortController();
    let release: (value: string) => void = () => undefined;
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const pending = abortable(held, controller.signal);
    controller.abort("caller left");
    // The caller's reason is what the wait rejects with, unchanged.
    await expect(pending).rejects.toBe("caller left");
    release("late");
    await expect(abortable("now", new AbortController().signal)).resolves.toBe(
      "now",
    );
    await expect(
      abortable(
        Promise.reject(new Error("failed")),
        new AbortController().signal,
      ),
    ).rejects.toThrow("failed");
    const wrapped = await abortable(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error rejection is the case under test
      Promise.reject("text"),
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect((wrapped as Error).cause).toBe("text");
    await expect(abortable("x", AbortSignal.abort())).rejects.toThrow();
  });

  // Contract: delay resolves after the interval or rejects on abort and
  // leaves no timer running either way.
  it("waits or aborts without leaving timers", async () => {
    vi.useFakeTimers();
    const waited = delay(20, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20);
    await expect(waited).resolves.toBeUndefined();
    const controller = new AbortController();
    const cancelled = delay(20, controller.signal);
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
