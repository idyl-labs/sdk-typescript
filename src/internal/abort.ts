// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * A signal derived from an optional parent and an optional timeout. `cleanup`
 * releases the listener and timer the signal holds; it is called when the
 * work the signal guards has finished, whether or not the signal fired.
 */
export interface ManagedSignal {
  readonly signal: AbortSignal;
  cleanup(): void;
}

/**
 * Builds a signal that aborts with the parent's reason when `parent` aborts
 * and with a `TimeoutError` `DOMException` carrying `timeoutMessage` when
 * `timeoutMs` elapses first. An already-aborted parent aborts the result
 * immediately. `timeoutMs` is milliseconds and must be positive when given;
 * `undefined` sets no timeout.
 */
export function managedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
  timeoutMessage: string,
): ManagedSignal {
  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new TypeError("timeoutMs must be greater than zero");
  }
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(parent?.reason ?? abortError());
  };
  if (parent?.aborted === true) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });

  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new DOMException(timeoutMessage, "TimeoutError"));
        }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup(): void {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

/**
 * Resolves with `value` unless `signal` aborts first, in which case it
 * rejects with the signal's reason, unchanged. The underlying work is not cancelled by
 * this function; the caller passes `signal` to it separately. A rejection
 * that is not an `Error` is wrapped so the cause is preserved.
 */
export async function abortable<T>(
  value: PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      // The caller's reason, whatever it is, is what the wait rejects with.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(asError(error));
      },
    );
  });
}

/**
 * Resolves after `milliseconds`, or rejects with the signal's reason if
 * `signal` aborts first. The timer is cleared on abort so nothing is left
 * running.
 */
export async function delay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The reason `signal` aborted with, as an `Error`. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return abortError(
    typeof reason === "string" && reason !== "" ? reason : undefined,
  );
}

function abortError(message = "this operation was aborted"): DOMException {
  return new DOMException(message, "AbortError");
}

function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error("operation failed with a non-Error rejection", {
    cause: reason,
  });
}
