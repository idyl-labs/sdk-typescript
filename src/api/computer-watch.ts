// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * A client learns that a Computer changed from an event the platform sends on
 * one stream, and then reads the part that changed once. An event carries
 * no state: every read still asks the platform, which decides it.
 *
 * To listen, a client creates a Computer watch for one Namespace in one
 * Subnet, decided as a list of that Namespace's Computers is. The watch's
 * answer carries a ticket the platform signed; the client presents the ticket on
 * its event stream, and the stream carries that Namespace's events until the
 * ticket's end, the expiry of the access token that created it. At that end
 * the service sends `ended` for the watch, and the client creates a watch
 * again, with the token it holds then, and presents the new ticket on the
 * stream it holds. No row is kept for a watch: it is never read, listed or
 * deleted.
 */
import type { ComputerWatchId, NamespaceId } from "../resource/uuid-id.js";

/** Asks for a Computer watch of the Namespace the route names; it states nothing else. */
export type CreateComputerWatchRequest = Readonly<Record<never, never>>;

/** A Computer watch, as its create answers it. */
export interface ComputerWatch {
  /** The watch's ID, which the stream's `ticket` and `error` frames name. */
  readonly id: ComputerWatchId;
  /** The watched Namespace's ID. */
  readonly namespaceId: NamespaceId;
  /** The watched Namespace's name. */
  readonly namespace: string;
  /** The Subnet whose Computers are watched. */
  readonly subnet: string;
  /**
   * When the watch ends, an RFC 3339 instant: its token's expiry. For the
   * caller's information: the service's `ended` frame, not this instant,
   * is what a client acts on.
   */
  readonly expiresAt: string;
  /**
   * The ticket the platform signed, presented on the event stream unchanged.
   * Opaque: at most {@link MAX_COMPUTER_WATCH_TICKET_BYTES} bytes, never
   * parsed and never kept beyond `expiresAt`.
   */
  readonly ticket: string;
}

/** The most bytes a watch's ticket holds. */
export const MAX_COMPUTER_WATCH_TICKET_BYTES = 1024;

/** The profile of the event stream, which the lane stream's header names. */
export const COMPUTER_EVENTS_STREAM_PROFILE = "computer-events/json-v1";

/**
 * The most bytes one frame's JSON body holds on the event stream. A frame
 * declaring no bytes or more than this ends the stream before its body is
 * read.
 */
export const MAX_COMPUTER_EVENT_FRAME_BYTES = 4096;

/**
 * Which part of a Computer an event says changed, and so what a client
 * reads again:
 *
 * - `computer`: the Computer was created, renamed or deleted, or its state,
 *   settings or reasons for being awake changed, including its fork's copy;
 *   read the Computer and each list page that shows it.
 * - `session`: a session changed phase, was placed, or stated its save
 *   result; read that session if the client waits for it.
 * - `sessions`: the set of open sessions changed; read them if shown.
 * - `operation`: a wake, sleep, save, restore or upload changed state; read
 *   that operation if the client waits for it.
 * - `version`: a saved version was added; read the newest version, the
 *   saved lists of open folders, and the history if shown.
 * - `reread`: read at once everything the client shows or waits for, of
 *   the event's Namespace or, when it names none, of every Namespace. The
 *   service paces the `reread`s it sends.
 *
 * A part this SDK does not name reads as `reread`.
 */
export type ComputerEventPart =
  | "computer"
  | "session"
  | "sessions"
  | "operation"
  | "version"
  | "reread"
  | (string & Record<never, never>);

/** The parts this SDK names. */
const PARTS: ReadonlySet<string> = new Set([
  "computer",
  "session",
  "sessions",
  "operation",
  "version",
  "reread",
]);

/** Whether `part` is one this SDK names. */
export function isComputerEventPart(part: string): boolean {
  return PARTS.has(part);
}

/** A client's frame on the event stream: a ticket for one watch. */
export interface ComputerWatchTicketFrame {
  readonly type: "ticket";
  /** The watch the ticket is for, which a refusal names. */
  readonly watch: string;
  readonly ticket: string;
}

/** A change, as the service sends it. */
export interface ComputerEventFrame {
  readonly type: "event";
  /** The Namespace of the change; absent on a `reread` for every Namespace. */
  readonly namespaceId?: string;
  /** The Computer's ID; absent on `reread`. */
  readonly computer?: string;
  readonly part: ComputerEventPart;
  /** The session's ID for `session`, the operation's for `operation`. */
  readonly id?: string;
}

/**
 * A ticket's end: the service sends no more of its Namespace's events, and
 * the client creates the watch again.
 */
export interface ComputerWatchEndedFrame {
  readonly type: "ended";
  /** The watch whose ticket ended. */
  readonly watch: string;
}

/** A ticket the service refused. */
export interface ComputerWatchErrorFrame {
  readonly type: "error";
  /** `COMPUTER_WATCH_TICKET_REFUSED` for a ticket refused, every cause alike. */
  readonly code: string;
  /** The watch whose ticket the frame answers. */
  readonly watch?: string;
  /** For people; never a contract. */
  readonly message?: string;
}

/** A ticket was refused; every cause answers the same. */
export const ERROR_CODE_COMPUTER_WATCH_TICKET_REFUSED =
  "COMPUTER_WATCH_TICKET_REFUSED";

/** A frame the service sends. A frame of a `type` this SDK does not name is ignored. */
export type ComputerEventServiceFrame =
  ComputerEventFrame | ComputerWatchEndedFrame | ComputerWatchErrorFrame;
