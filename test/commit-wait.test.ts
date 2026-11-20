// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SAVE_REASON_ACCOUNT_TURN_WAITING,
  SAVE_REASON_PUBLICATION_HELD,
  SAVE_WAITING_FOR_PUBLICATION_TURN,
  decodeCommit,
  encodeCommit,
} from "../src/api/storage.js";
import { type JsonObject } from "../src/resource/json.js";

/** A served-object golden, as the platform sends it. */
function golden(name: string): JsonObject {
  return JSON.parse(
    readFileSync(
      new URL(
        `./conformance/fixtures/api/testdata/golden/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as JsonObject;
}

describe("what a pending save waits for", () => {
  // A save waiting for its Account's publication turn names the turn and no
  // end: the turn comes when one of the Account's running publications ends.
  it("reads a save waiting for its turn", () => {
    const commit = decodeCommit(golden("commit.waiting-turn"));
    expect(commit.waitingFor).toBe(SAVE_WAITING_FOR_PUBLICATION_TURN);
    expect(commit.waitingUntil).toBeUndefined();
    expect(commit.retry).toBeUndefined();
    expect(encodeCommit(commit)).toEqual(golden("commit.waiting-turn"));
  });

  // A held save names the hold, the time it ends, and the hold as the reason
  // of its last failed attempt.
  it("reads a held save with the time its hold ends", () => {
    const commit = decodeCommit(golden("commit.held"));
    expect(commit.waitingFor).toBe(SAVE_REASON_PUBLICATION_HELD);
    expect(commit.waitingUntil).toBe("2026-01-03T03:04:05Z");
    expect(commit.retry?.reason).toBe(SAVE_REASON_PUBLICATION_HELD);
    expect(encodeCommit(commit)).toEqual(golden("commit.held"));
  });

  // A save waiting for its Account's own turn says so as its last
  // attempt's reason, with no wait field and no end.
  it("reads a save waiting for its Account's turn", () => {
    const commit = decodeCommit({
      ...golden("commit.retrying"),
      retry: {
        reason: SAVE_REASON_ACCOUNT_TURN_WAITING,
        attempts: 1,
        nextAttemptAt: "2026-01-02T03:04:05Z",
      },
    });
    expect(commit.retry?.reason).toBe(SAVE_REASON_ACCOUNT_TURN_WAITING);
    expect(commit.waitingFor).toBeUndefined();
    expect(commit.waitingUntil).toBeUndefined();
  });

  // A pending save that waits on neither carries no wait, and a wait this
  // version does not name is carried as sent, not rejected.
  it("carries no wait for an ordinary save and an unknown one as sent", () => {
    const ordinary = decodeCommit(golden("commit.minimal"));
    expect(ordinary.waitingFor).toBeUndefined();
    expect(ordinary.waitingUntil).toBeUndefined();
    expect(encodeCommit(ordinary)).toEqual(golden("commit.minimal"));

    const unknown = decodeCommit({
      ...golden("commit.minimal"),
      waitingFor: "a-later-wait",
    });
    expect(unknown.waitingFor).toBe("a-later-wait");
  });
});
