// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// How a connector listens for changes to its Namespace's Computers: it
// creates a Computer watch, opens one client service lane to its Zone's
// event service and one stream on it, presents the watch's ticket, and
// hands each event to its listeners and to the waits in progress. Nothing
// waits for any of it.
//
// An attempt to listen succeeds when the stream delivers its first frame,
// the `reread` that answers an accepted ticket, within OPEN_WAIT_MS. A
// stream that ends after it carried events is opened again at once; an
// attempt that fails is tried again after 0.5 s, 1, 2, 4, 8, 15, then every
// 30 s. The connector has no event stream from a failed attempt, or from a
// dock whose Zone serves no events, until a stream delivers its first
// `reread`; meanwhile waits pause as with no stream and a page reads on its
// fallback schedule. A first attempt still in flight is not that state.
//
// At a ticket's end the service sends `ended`; the connector then creates
// the watch again, with the token its credential source hands it then, and
// presents the new ticket. It keeps no clock of its own for the watch's
// end. A refused ticket is answered by one new watch; a second refusal with
// no accepted ticket between fails the attempt. A watch create refused for
// the caller's sign-in or permission is not tried again on a timer, only on
// the connector's next dock or use.

import {
  COMPUTER_EVENTS_STREAM_PROFILE,
  ERROR_CODE_COMPUTER_WATCH_TICKET_REFUSED,
  isComputerEventPart,
  type ComputerEventFrame,
  type ComputerEventServiceFrame,
  type ComputerWatch,
} from "../api/computer-watch.js";
import { ApiError } from "../errors.js";
import { EventFrameReader, encodeTicketFrame } from "./events.js";
import type { WorkerToPage } from "./messages.js";
import type { WaitEvents } from "../wait.js";

/** The client service lane profile an edge's welcome names when it serves it. */
export const CLIENT_SERVICE_LANE_PROFILE = "client-service-lanes/1";

/**
 * How long one connection attempt waits, in milliseconds: a terminal's
 * attempt for its endpoint's first frame, and listening's for its stream's
 * first `reread`.
 */
export const OPEN_WAIT_MS = 30_000;

/** The pauses before each attempt to listen again after a failed one, in milliseconds; the last repeats. */
const RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

/** A change to one of the Namespace's Computers, as its event names it. */
export interface ComputerChange {
  /** Which part changed; a part this SDK does not name is delivered as `reread`. */
  readonly part: ComputerEventFrame["part"];
  /** The Computer's ID; absent on `reread`. */
  readonly computer?: string;
  /** The session's ID for `session`, the operation's for `operation`. */
  readonly id?: string;
}

/** What a page or program is told of its connector's listening. */
export interface ChangeListener {
  /** A change arrived. Called in order, never while another call runs. */
  readonly onChange?: (change: ComputerChange) => void;
  /**
   * Whether the connector has an event stream: `true` once a stream
   * delivers its first `reread`; `false` once an attempt to open one
   * fails, or when the platform serves no change events to the dock.
   * Called only when the answer changes, and not while a first attempt is in flight or a stream
   * that ended is opened again.
   */
  readonly onListening?: (listening: boolean) => void;
}

/** The event service, and how its certificate is verified. */
export interface EventService {
  /** The service's exact SPIFFE ID. */
  readonly principal: string;
  /** The trust anchors of its certificate, DER. */
  readonly roots: readonly Uint8Array[];
}

/** A request listening sends to the Worker. */
type ListeningRequest =
  | {
      readonly type: "open-service-lane";
      readonly dock: number;
      readonly principal: string;
    }
  | {
      readonly type: "open-service";
      readonly dock: number;
      readonly lane: number;
      readonly profile: string;
      readonly roots: readonly Uint8Array[];
      readonly chain: readonly Uint8Array[];
      readonly principal: string;
    }
  | {
      readonly type: "service-write";
      readonly dock: number;
      readonly service: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: "close-service";
      readonly dock: number;
      readonly service: number;
    };

/** What listening needs from its connector. */
export interface ListeningPort {
  /**
   * The connector's dock, docking when it has none, with the event
   * service its verified session trust names, `undefined` when it names
   * none.
   */
  docked(): Promise<{
    readonly dock: number;
    readonly chain: readonly Uint8Array[];
    readonly serviceLaneProfile: string;
    readonly service: EventService | undefined;
  }>;
  /** Sends a request to the Worker and resolves to its reply. */
  request(request: ListeningRequest): Promise<unknown>;
  /** Calls `listener` with every Worker event; returns its removal. */
  listen(listener: (m: WorkerToPage) => void): () => void;
  /** Creates the Namespace's Computer watch. */
  createWatch(): Promise<ComputerWatch>;
}

/** The stream in hand, from its lane's verb to its end. */
interface Stream {
  readonly dock: number;
  lane: number | undefined;
  service: number | undefined;
  readonly reader: EventFrameReader;
  /** The watch whose ticket the stream last presented. */
  presented: string | undefined;
  /** Tickets refused since the stream last delivered an event. */
  refused: number;
  /** Whether the stream has delivered its first `reread`. */
  carried: boolean;
  /** Ends the attempt unless the first `reread` arrives in time. */
  deadline: ReturnType<typeof setTimeout> | undefined;
  stop(): void;
}

/** Whether `error` refuses the caller's sign-in or permission. */
function refusedCaller(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 401 || error.status === 403)
  );
}

/** One connector's listening. */
export class Listening {
  readonly #port: ListeningPort;
  readonly #listeners = new Set<ChangeListener>();
  readonly #wakes = new Set<(change: ComputerChange) => void>();
  #watch: ComputerWatch | undefined;
  #stream: Stream | undefined;
  #state: "opening" | "listening" | "down" = "opening";
  /** What listeners were last told, `undefined` before the first answer. */
  #told: boolean | undefined;
  #started = false;
  #attempting = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #stopDocked: (() => void) | undefined;

  constructor(port: ListeningPort) {
    this.#port = port;
  }

  /** Whether a stream carries the Namespace's events now. */
  get listening(): boolean {
    return this.#state === "listening";
  }

  /**
   * Starts listening, or tries again now when an attempt is not under way,
   * no stream is held and none is scheduled. Nothing waits for it.
   */
  start(): void {
    if (!this.#started) {
      this.#started = true;
      // A new dock is where the Zone may first serve events.
      this.#stopDocked = this.#port.listen((m) => {
        if (m.type === "docked") this.#kick();
      });
    }
    this.#kick();
  }

  /** Adds a listener; returns its removal. */
  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The events that end a wait's pause for a change `matches` accepts, and
   * for every `reread`. With `namespace`, the name of the Namespace the
   * wait's object lives in, the stream counts as carrying its events only
   * while the watch is of that Namespace.
   */
  waitEvents(
    matches: (change: ComputerChange) => boolean,
    namespace?: string,
  ): WaitEvents {
    return {
      streaming: () =>
        this.#state === "listening" &&
        (namespace === undefined || this.#watch?.namespace === namespace),
      listen: (wake) => {
        const onChange = (change: ComputerChange): void => {
          if (change.part === "reread" || matches(change)) wake();
        };
        this.#wakes.add(onChange);
        return () => this.#wakes.delete(onChange);
      },
    };
  }

  /**
   * Ends the stream and stops listening, keeping the listeners; a later
   * {@link Listening.start} listens again.
   */
  stop(): void {
    this.#started = false;
    this.#stopDocked?.();
    this.#stopDocked = undefined;
    clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#failures = 0;
    this.#end();
    this.#state = "opening";
    this.#told = undefined;
  }

  /** Attempts to listen when nothing is under way. */
  #kick(): void {
    if (
      !this.#started ||
      this.#attempting ||
      this.#stream !== undefined ||
      this.#retry !== undefined
    ) {
      return;
    }
    void this.#attempt();
  }

  /** One attempt to open the lane and the stream and present a ticket. */
  async #attempt(): Promise<void> {
    this.#attempting = true;
    let stream: Stream | undefined;
    try {
      const docked = await this.#port.docked();
      const service = docked.service;
      if (
        docked.serviceLaneProfile !== CLIENT_SERVICE_LANE_PROFILE ||
        service === undefined
      ) {
        // The Zone serves no events on this dock; the next dock looks again.
        this.#down();
        return;
      }
      let watch: ComputerWatch;
      try {
        watch = this.#watch ?? (await this.#port.createWatch());
      } catch (error) {
        if (!refusedCaller(error)) throw error;
        this.#down();
        return;
      }
      this.#watch = watch;
      if (!this.#started) return;
      stream = this.#open(docked.dock);
      const lane = await this.#laneReady(stream, service.principal);
      const opened = (await this.#port.request({
        type: "open-service",
        dock: docked.dock,
        lane,
        profile: COMPUTER_EVENTS_STREAM_PROFILE,
        roots: service.roots,
        chain: docked.chain,
        principal: service.principal,
      })) as number;
      stream.service = opened;
      await this.#present(stream, watch);
    } catch {
      if (stream === undefined || this.#stream === stream) this.#fail();
    } finally {
      this.#attempting = false;
    }
  }

  /**
   * Starts a stream on `dock`, following the Worker's events for it, with
   * the attempt's bound on its first `reread`.
   */
  #open(dock: number): Stream {
    const stream: Stream = {
      dock,
      lane: undefined,
      service: undefined,
      reader: new EventFrameReader(),
      presented: undefined,
      refused: 0,
      carried: false,
      deadline: undefined,
      stop: () => undefined,
    };
    stream.stop = this.#port.listen((m) => {
      this.#worker(stream, m);
    });
    stream.deadline = setTimeout(() => {
      stream.deadline = undefined;
      if (this.#stream === stream && !stream.carried) this.#fail();
    }, OPEN_WAIT_MS);
    this.#stream = stream;
    return stream;
  }

  /**
   * Asks for the lane and resolves to it once it is ready. The Worker's
   * events are followed from before the verb is sent, so an answer that
   * arrives ahead of the verb's reply is not missed.
   */
  async #laneReady(stream: Stream, principal: string): Promise<number> {
    const ready = new Set<number>();
    const ended = new Set<number>();
    let dockEnded = false;
    let settle: (() => void) | undefined;
    const stop = this.#port.listen((m) => {
      if (!("dock" in m) || m.dock !== stream.dock) return;
      if (m.type === "lane-ready") ready.add(m.lane);
      else if (m.type === "lane-ended") ended.add(m.lane);
      else if (m.type === "dock-ended") dockEnded = true;
      else return;
      settle?.();
    });
    try {
      const lane = (await this.#port.request({
        type: "open-service-lane",
        dock: stream.dock,
        principal,
      })) as number;
      stream.lane = lane;
      await new Promise<void>((resolve, reject) => {
        settle = () => {
          if (ready.has(lane)) resolve();
          else if (ended.has(lane) || dockEnded) {
            reject(new Error("the lane to the event service ended"));
          }
        };
        settle();
      });
      return lane;
    } finally {
      stop();
    }
  }

  /** Presents `watch`'s ticket on the stream. */
  async #present(stream: Stream, watch: ComputerWatch): Promise<void> {
    if (stream.service === undefined) return;
    stream.presented = watch.id;
    await this.#port.request({
      type: "service-write",
      dock: stream.dock,
      service: stream.service,
      bytes: encodeTicketFrame({
        type: "ticket",
        watch: watch.id,
        ticket: watch.ticket,
      }),
    });
  }

  /**
   * Creates the watch again and presents its ticket on `stream`. A create
   * refused for the caller's sign-in or permission leaves the stream with
   * no live ticket, which the service closes; any other failure fails the
   * attempt.
   */
  async #rewatch(stream: Stream): Promise<void> {
    this.#watch = undefined;
    try {
      const watch = await this.#port.createWatch();
      this.#watch = watch;
      if (this.#stream === stream) await this.#present(stream, watch);
    } catch (error) {
      if (this.#stream === stream && !refusedCaller(error)) this.#fail();
    }
  }

  /** One Worker event, for the stream in hand. */
  #worker(stream: Stream, m: WorkerToPage): void {
    if (this.#stream !== stream || !("dock" in m) || m.dock !== stream.dock) {
      return;
    }
    switch (m.type) {
      case "service-data":
        if (m.service === stream.service) this.#data(stream, m.bytes);
        return;
      case "service-ended":
        if (m.service === stream.service) this.#lost(stream);
        return;
      case "lane-ended":
        if (m.lane === stream.lane) this.#lost(stream);
        return;
      case "dock-ended":
        this.#lost(stream);
        return;
      default:
        return;
    }
  }

  /** The service's bytes: each frame in order. */
  #data(stream: Stream, bytes: Uint8Array): void {
    let frames: ComputerEventServiceFrame[];
    try {
      frames = stream.reader.push(bytes);
    } catch {
      this.#lost(stream);
      return;
    }
    for (const frame of frames) {
      if (this.#stream !== stream) return;
      switch (frame.type) {
        case "ended":
          if (frame.watch === stream.presented) void this.#rewatch(stream);
          continue;
        case "error":
          this.#refusal(stream, frame.code, frame.watch);
          continue;
        case "event":
          this.#event(stream, frame);
          continue;
      }
    }
  }

  /** One event: the first is the `reread` of an accepted ticket. */
  #event(stream: Stream, frame: ComputerEventFrame): void {
    const watch = this.#watch;
    if (
      frame.namespaceId !== undefined &&
      watch !== undefined &&
      frame.namespaceId !== watch.namespaceId
    ) {
      return;
    }
    stream.refused = 0;
    if (!stream.carried) {
      stream.carried = true;
      clearTimeout(stream.deadline);
      stream.deadline = undefined;
      this.#failures = 0;
      this.#state = "listening";
      this.#report(true);
    }
    const part = isComputerEventPart(frame.part) ? frame.part : "reread";
    const change: ComputerChange =
      part === "reread"
        ? { part }
        : {
            part,
            ...(frame.computer === undefined
              ? {}
              : { computer: frame.computer }),
            ...(frame.id === undefined ? {} : { id: frame.id }),
          };
    for (const wake of [...this.#wakes]) wake(change);
    this.#tell((l) => l.onChange?.(change));
  }

  /**
   * A ticket the service refused. The first refusal since the stream last
   * delivered an event is answered by a new watch; a second fails the
   * attempt, as the service then closes the stream.
   */
  #refusal(stream: Stream, code: string, watch: string | undefined): void {
    if (code !== ERROR_CODE_COMPUTER_WATCH_TICKET_REFUSED) return;
    if (watch !== undefined && watch !== stream.presented) return;
    stream.refused += 1;
    if (stream.refused === 1) {
      void this.#rewatch(stream);
      return;
    }
    this.#watch = undefined;
    this.#fail();
  }

  /**
   * The stream ended. One that had carried events is opened again at once,
   * and the connector is not without a stream meanwhile; one that had not
   * is a failed attempt.
   */
  #lost(stream: Stream): void {
    if (this.#stream !== stream) return;
    if (!stream.carried) {
      this.#fail();
      return;
    }
    this.#end();
    this.#state = "opening";
    this.#kick();
  }

  /** The attempt failed: no event stream until one delivers its `reread`. */
  #fail(): void {
    this.#end();
    this.#down();
    if (!this.#started || this.#retry !== undefined) return;
    const wait = RETRY_MS[Math.min(this.#failures, RETRY_MS.length - 1)];
    this.#failures += 1;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.#kick();
    }, wait);
  }

  /** The connector has no event stream. */
  #down(): void {
    this.#state = "down";
    this.#report(false);
  }

  /** Forgets the stream in hand, closing what the Worker holds of it. */
  #end(): void {
    const stream = this.#stream;
    this.#stream = undefined;
    if (stream === undefined) return;
    clearTimeout(stream.deadline);
    stream.stop();
    if (stream.service !== undefined) {
      void this.#port
        .request({
          type: "close-service",
          dock: stream.dock,
          service: stream.service,
        })
        .catch(() => undefined);
    }
  }

  /** Tells the listeners whether a stream carries events, when that changed. */
  #report(listening: boolean): void {
    if (this.#told === listening) return;
    this.#told = listening;
    this.#tell((l) => l.onListening?.(listening));
  }

  #tell(call: (listener: ChangeListener) => void): void {
    for (const listener of [...this.#listeners]) {
      try {
        call(listener);
      } catch {
        // A listener's failure is its own; the others are still told.
      }
    }
  }
}
