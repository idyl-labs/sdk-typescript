// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { isUint64 } from "../internal/strictdecode.js";
import {
  always,
  array,
  boolean,
  decodeValue,
  integer,
  object,
  omitEmpty,
  pointer,
  string,
  type Shape,
} from "../internal/strictdecode.js";
import { parseJson } from "../resource/json.js";
import type { Integer } from "../resource/json.js";
import { timestampShape } from "../resource/shapes.js";
import {
  parseComputerSessionId,
  type ComputerSessionId,
} from "../resource/uuid-id.js";
import { prefixed } from "../resource/validation.js";
import { validateComputerNotebookName } from "./computer-notebook-name.js";
import {
  isZeroInstant,
  validateStatedClient,
  type ComputerSessionClient,
} from "./computer-session.js";

/**
 * What a hold on an awake Computer is.
 *
 * - `session`: one or more open sessions: terminals, commands, notebook
 *   cells and SSH connections. An open session holds the Computer while it
 *   stays open, whether or not anything is typed or running in it; an SSH
 *   connection holds it as a terminal does, for as long as the connection
 *   is open, even with no channel open. A stream that only reads the
 *   Computer's files or a notebook's records is not a session here.
 * - `keep-awake`: an idle timeout of never: the Computer sleeps only when it
 *   is asked to.
 * - `starting-session`: one or more sessions accepted and not yet started.
 * - `settings-restart`: a Computer running on execution settings older than
 *   those in force. It keeps nothing awake: the Computer sleeps as soon as
 *   no session holds it, whatever its idle timeout, so that its next start
 *   uses the settings in force.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateComputerAwakeHoldKind} judges
 * membership, and a caller shows a hold of a kind it does not know as
 * something keeping the Computer awake that it cannot describe.
 */
export type ComputerAwakeHoldKind =
  | "session"
  | "keep-awake"
  | "starting-session"
  | "settings-restart"
  | (string & Record<never, never>);

/**
 * Judges that the kind is one this SDK names. The empty string is reported
 * as missing. Throws a `TypeError`.
 */
export function validateComputerAwakeHoldKind(
  kind: ComputerAwakeHoldKind,
): void {
  switch (kind) {
    case "session":
    case "keep-awake":
    case "starting-session":
    case "settings-restart":
      return;
    case "":
      throw new TypeError("computer awake hold kind is required");
    default:
      throw new TypeError(`unknown computer awake hold kind "${kind}"`);
  }
}

/** One reason an awake Computer has not started counting down to sleep. */
export interface ComputerAwakeHold {
  /** What the hold is. */
  readonly kind: ComputerAwakeHoldKind;
  /**
   * How many sessions the hold names: at least one on a `session` or
   * `starting-session` hold, and zero on any other. Always written.
   */
  readonly count: Integer;
}

/**
 * Why a Computer is awake and when it will sleep, as of the read that
 * reported it. It is the same rule that puts the Computer to sleep, so the
 * time it states is one the platform keeps.
 *
 * When `holds` names nothing but `settings-restart`, or nothing at all, the
 * Computer is counting down: `sleepsAt` and `sleepsIn` are present. A
 * Computer past its time reads `sleepsIn` zero until it has saved and gone to
 * sleep. While a session or Keep awake holds the Computer, both are absent,
 * because nothing it can state says when it will sleep.
 *
 * A caller counting down starts from `sleepsIn`, which needs no agreement
 * between the caller's clock and the platform's, and reads the Computer again
 * to follow a change made elsewhere.
 */
export interface ComputerAwake {
  /** When the Computer's current execution started, as an RFC 3339 instant. */
  readonly since: string;
  /**
   * What is keeping the Computer awake now, each kind at most once. Always
   * written, empty when the Computer is counting down.
   */
  readonly holds: readonly ComputerAwakeHold[];
  /**
   * When the Computer sleeps by the platform's clock, as an RFC 3339 instant.
   * Present exactly when `sleepsIn` is.
   */
  readonly sleepsAt?: string;
  /**
   * How long until `sleepsAt`, in whole seconds from the read that reported
   * it. It is never negative. Present exactly when `sleepsAt` is.
   */
  readonly sleepsIn?: Integer;
}

const computerAwakeHoldShape: Shape<ComputerAwakeHold> =
  object<ComputerAwakeHold>({
    kind: always(string<ComputerAwakeHoldKind>()),
    count: always(integer({ unsigned: false, bits: 64 })),
  });

/** The wire shape of {@link ComputerAwake}. */
export const computerAwakeShape: Shape<ComputerAwake> = object<ComputerAwake>({
  since: always(timestampShape),
  holds: always(array(computerAwakeHoldShape)),
  sleepsAt: pointer(timestampShape),
  sleepsIn: pointer(integer({ unsigned: false, bits: 64 })),
});

/**
 * Reads an awake state leniently: a field or kind newer than this SDK is
 * carried rather than refused, and {@link validateComputerAwake} judges it.
 */
export function decodeComputerAwake(document: unknown): ComputerAwake {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, computerAwakeShape, "lenient");
}

/**
 * Judges the value against this SDK's contract: a start time, holds that are
 * valid and name each kind once, and a sleep time stated whole. Throws a
 * `TypeError`.
 */
export function validateComputerAwake(awake: ComputerAwake): void {
  if (isZeroInstant(awake.since)) throw new TypeError("since is required");
  const seen = new Set<string>();
  awake.holds.forEach((hold, index) => {
    prefixed(`holds[${String(index)}]`, () => {
      validateComputerAwakeHoldKind(hold.kind);
      const counted =
        hold.kind === "session" || hold.kind === "starting-session";
      if (counted && Number(hold.count) < 1) {
        throw new TypeError(
          `a ${hold.kind} hold must count at least one session`,
        );
      }
      if (!counted && Number(hold.count) !== 0) {
        throw new TypeError(`a ${hold.kind} hold counts no sessions`);
      }
      if (seen.has(hold.kind)) {
        throw new TypeError(`${hold.kind} is repeated`);
      }
      seen.add(hold.kind);
    });
  });
  if ((awake.sleepsAt === undefined) !== (awake.sleepsIn === undefined)) {
    throw new TypeError("sleepsAt and sleepsIn must be set together");
  }
  if (awake.sleepsIn !== undefined && !isUint64(awake.sleepsIn)) {
    throw new TypeError("sleepsIn must not be negative");
  }
}

/**
 * What an open session of a Computer is, in the words a person uses for it:
 * `terminal`, an interactive shell on a terminal; `command`, one command;
 * `notebook-cell`, one notebook cell; or `ssh`, one SSH connection, a
 * session of mode `ssh`, shown to people as "SSH connection". An SSH
 * connection's channels are part of it, not sessions of their own.
 *
 * The union is open: a token the platform reports that this SDK does not
 * know is carried as a string; {@link validateComputerSessionKind} judges
 * membership, and a caller shows a session of a kind it does not know as a
 * session it cannot describe.
 */
export type ComputerSessionKind =
  | "terminal"
  | "command"
  | "notebook-cell"
  | "ssh"
  | (string & Record<never, never>);

/**
 * Judges that the kind is one this SDK names. The empty string is reported
 * as missing. Throws a `TypeError`.
 */
export function validateComputerSessionKind(kind: ComputerSessionKind): void {
  switch (kind) {
    case "terminal":
    case "command":
    case "notebook-cell":
    case "ssh":
      return;
    case "":
      throw new TypeError("computer session kind is required");
    default:
      throw new TypeError(`unknown computer session kind "${kind}"`);
  }
}

/**
 * One open session of a Computer, as anyone who may read the Computer sees
 * it: what kind of session it is, which client opened it, who opened it and
 * when. It carries no command, output, attachment or credential, and it
 * grants nothing: a session is read, renewed and ended only by the identity
 * that created it.
 */
export interface ComputerSessionSummary {
  /** Names the session. */
  readonly id: ComputerSessionId;
  /** What the session is. */
  readonly kind: ComputerSessionKind;
  /** The notebook the cell runs in, by its current name; only on a notebook cell. */
  readonly notebook?: string;
  /**
   * The kind of client that opened the session, or `unknown` when its request
   * stated none. It is informative and grants nothing.
   */
  readonly client: ComputerSessionClient;
  /** The identity that opened the session, as `JournalEntry.creator` names it. */
  readonly openedBy: string;
  /** When the platform accepted the session, by its own clock, as an RFC 3339 instant. */
  readonly openedAt: string;
  /** True when the caller who read the list opened the session. Always written. */
  readonly yours: boolean;
}

const computerSessionSummaryShape: Shape<ComputerSessionSummary> =
  object<ComputerSessionSummary>({
    id: always(string<ComputerSessionId>()),
    kind: always(string<ComputerSessionKind>()),
    notebook: omitEmpty(string()),
    client: always(string<ComputerSessionClient>()),
    openedBy: always(string()),
    openedAt: always(timestampShape),
    yours: always(boolean()),
  });

/**
 * Judges the summary against this SDK's contract: a canonical ID, a kind and
 * a client this SDK names, who and when, and a notebook exactly on a notebook
 * cell. Throws a `TypeError`.
 */
export function validateComputerSessionSummary(
  summary: ComputerSessionSummary,
): void {
  parseComputerSessionId(summary.id);
  validateComputerSessionKind(summary.kind);
  prefixed("client", () => {
    if (summary.client === "") {
      throw new TypeError("computer session client is required");
    }
  });
  validateStatedClient(summary.client);
  if (summary.openedBy === "") throw new TypeError("openedBy is required");
  if (isZeroInstant(summary.openedAt)) {
    throw new TypeError("openedAt is required");
  }
  const notebook = summary.notebook ?? "";
  if ((summary.kind === "notebook-cell") !== (notebook !== "")) {
    throw new TypeError("notebook must be set exactly on a notebook cell");
  }
  if (notebook !== "") {
    prefixed("notebook", () => {
      validateComputerNotebookName(notebook);
    });
  }
}

/**
 * Every open session of a Computer, oldest first. The Computer's session
 * limit bounds it, so it is not paged.
 */
export interface ListComputerSessionsResponse {
  /** The open sessions. Always written, empty when none is open. */
  readonly items: readonly ComputerSessionSummary[];
}

const listComputerSessionsResponseShape: Shape<ListComputerSessionsResponse> =
  object<ListComputerSessionsResponse>({
    items: always(array(computerSessionSummaryShape)),
  });

/**
 * Reads a session list leniently: a field or kind newer than this SDK is
 * carried rather than refused, and {@link validateComputerSessionSummary}
 * judges each session.
 */
export function decodeListComputerSessionsResponse(
  document: unknown,
): ListComputerSessionsResponse {
  const value: unknown =
    typeof document === "string" ? parseJson(document) : document;
  return decodeValue(value, listComputerSessionsResponseShape, "lenient");
}

/** Renders a session list as the document the platform emits. */
export function encodeListComputerSessionsResponse(
  page: ListComputerSessionsResponse,
): unknown {
  return listComputerSessionsResponseShape.encode(page);
}
