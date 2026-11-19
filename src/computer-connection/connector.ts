// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The page's side of Computer connections. It owns the access credential's
// requests (the client certificate, the Zone's session trust, session
// creates and renewals) and the session frames; its Worker owns the client
// certificate's key and every TLS connection. A session is opened by
// sending its create and its stream at the same time, named by one request
// ID, so nothing waits for the create unless the Computer's place or
// Activation is not yet known. The create answers with the place once the
// session is bound to the Activation that will serve it, while the session
// may still be pending, so the connection's handshake overlaps the end of
// the Computer's wake. The platform holds a session pending and unbound
// while the Computer's previous Activation is released, as just after the
// Computer went to sleep; only such an answer is read again, until the
// session is bound.

import {
  COMPUTER_SESSION_LEASE_MS,
  isComputerSessionPhaseTerminal,
  isZeroInstant,
  validateComputerSessionReason,
  validateCreateComputerSessionRequest,
  type ComputerSession as ServedSession,
  type ComputerSessionClient,
  type CreateComputerSessionRequest,
} from "../api/computer-session.js";
import { validateWorkloadSessionTerminalProfile } from "../api/workload-session.js";
import { ApiError, TransportError } from "../errors.js";
import {
  isComputerSessionId,
  type ComputerSessionId,
} from "../resource/uuid-id.js";
import { pollUntil, sessionPlacementPauses, type WaitEvents } from "../wait.js";
import type { ComputerWatch } from "../api/computer-watch.js";
import {
  Listening,
  OPEN_WAIT_MS,
  type ChangeListener,
  type ComputerChange,
  type EventService,
  type ListeningState,
} from "./listening.js";
import type { ComputerSessionEndpoint } from "../api/computer-session-endpoint.js";
import {
  FrameError,
  FrameReader,
  encodeFrame,
  stdinFrames,
  validateOpenedFor,
} from "./frames.js";
import { filesSession } from "./files.js";
import type { ComputerFilesSession, FilesSessionHandlers } from "./files.js";
import type {
  EndpointFrame,
  OpenedFrame,
  OpenFrame,
  SessionFeature,
  SessionMode,
  TerminalSize,
} from "./frames.js";
import type { PageToWorker, WorkerToPage } from "./messages.js";
import { SessionTrustError, verifySessionTrust } from "./trust.js";
import { defaultTrustFloor, type TrustFloor } from "./trust-floor.js";
import type { SessionTrust, SessionTrustResponse, TrustKey } from "./trust.js";

/**
 * The Worker a connector runs its connections through: a dedicated Worker
 * whose module called `serveComputerConnections`, or the `worker` that
 * `connectInThisThread` returns. The messages between them belong to the
 * connection and are opaque to the caller.
 */
export interface WorkerPort {
  /**
   * Sends a message to the Worker, as `Worker.postMessage` does.
   *
   * @param message a request of the connection's own protocol
   * @param transfer the buffers whose ownership passes to the Worker
   */
  postMessage(message: PageToWorker, transfer?: Transferable[]): void;
  /**
   * Calls `listener` with each message the Worker sends, as
   * `Worker.addEventListener` does.
   *
   * @param type always `message`
   * @param listener called with each message, in the order the Worker sent
   *   them
   */
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerToPage>) => void,
  ): void;
}

/** The client certificate the platform issued for the Worker's key. */
export interface IssuedCertificate {
  /** DER, leaf first. */
  readonly chain: readonly Uint8Array[];
  /** The dock admission lease, exactly as issued. */
  readonly admissionLease: Uint8Array;
  /** The leaf's `notBefore`, in milliseconds since the epoch. */
  readonly notBeforeMs: number;
  /** The leaf's `notAfter`, in milliseconds since the epoch. */
  readonly notAfterMs: number;
}

/**
 * A session trust response and the trust scope the client's own placement
 * names, which the bundle must name too: the client, not the bundle,
 * chooses the scope it is held to.
 */
export interface PlacedSessionTrust {
  readonly scope: string;
  readonly response: SessionTrustResponse;
}

/** The platform requests the connector makes, with the page's credential. */
export interface ConnectorApi {
  /** Issues a client certificate for a DER certificate request. */
  certify(request: Uint8Array): Promise<IssuedCertificate>;
  /**
   * The session trust of the Zone that serves the Account, with that Zone
   * as the client's placement names it.
   */
  sessionTrust(): Promise<PlacedSessionTrust>;
  /** Creates a session of a Computer. */
  createSession(
    computer: string,
    request: CreateComputerSessionRequest,
  ): Promise<ServedSession>;
  /**
   * Reads one session of a Computer as it now is. A response naming
   * another session is refused.
   */
  readSession(
    computer: string,
    session: string,
    signal: AbortSignal,
  ): Promise<ServedSession>;
  /**
   * Renews the named sessions of a Computer, each on its own renew route.
   * Resolves to those that renewing again cannot keep: the platform does
   * not know them or holds them as final. A session left out failed only
   * for now, such as on a network failure or a server error.
   */
  renewSessions(
    computer: string,
    sessions: readonly string[],
  ): Promise<readonly string[]>;
  /** Cancels one session of a Computer; cancelling an ended one is a no-op. */
  cancelSession(computer: string, session: string): Promise<void>;
  /** Creates the Computer watch of the connector's Namespace. */
  createWatch(): Promise<ComputerWatch>;
}

/**
 * Where a Computer's sessions were last placed, kept across page loads so
 * the first session after a reload need not wait for its create. The value
 * is opaque to the caller and is never authority: a stale one costs one
 * fast refusal.
 */
export interface PlacementMemory {
  /**
   * The value `save` last kept for a Computer, or `undefined` when it kept
   * none.
   *
   * @param computer the Computer's ID
   */
  load(computer: string): string | undefined;
  /**
   * Keeps `value` for a Computer, in place of any value kept before.
   *
   * @param computer the Computer's ID
   * @param value the opaque value to keep, exactly as given
   */
  save(computer: string, value: string): void;
}

/** What a connector needs. */
export interface ComputerConnectorOptions {
  readonly worker: WorkerPort;
  /** The compiled Computer connection module. */
  readonly module: WebAssembly.Module;
  readonly network: string;
  /** The Network trust keys this client pins. */
  readonly trustKeys: readonly TrustKey[];
  /** The Account the page acts as, read once when the connector starts. */
  readonly account: () => Promise<string>;
  readonly api: ConnectorApi;
  readonly placements?: PlacementMemory;
  /** The kind of client every session create states; `sdk` when absent. */
  readonly client?: ComputerSessionClient;
  /** The edge's browser listener; derived from the Zone when absent. */
  readonly edgeUrl?: (zone: string) => string;
  /**
   * The interval, in milliseconds, of the connector's upkeep: the renewal
   * of open sessions, and of the client certificate once half its life has
   * passed.
   */
  readonly renewEveryMs?: number;
  /**
   * Where the highest accepted session trust version is kept per Network
   * and Zone; when absent, the page's IndexedDB floor, or its memory where
   * IndexedDB is absent or its `open` throws.
   */
  readonly trustFloor?: TrustFloor;
}

/** What one session stream runs. */
export interface SessionOpen {
  /**
   * What the stream runs: `shell`, an interactive shell on a terminal; or
   * `exec`, one command.
   */
  readonly mode: "shell" | "exec";
  /**
   * The shell a `shell` session runs, as a clean absolute path; when
   * absent, the Computer chooses.
   */
  readonly shell?: string;
  /**
   * An `exec` session's command and its arguments: 1 to 1024 arguments of
   * at most 32 KiB together, the first naming the program.
   */
  readonly command?: readonly string[];
  /**
   * Whether the session runs on a terminal. A `shell` session always does;
   * `false` when absent.
   */
  readonly tty?: boolean;
  /** The terminal's size; stated when, and only when, `tty` is `true`. */
  readonly size?: TerminalSize;
  /**
   * The terminal type, such as `xterm-256color`; stated when, and only
   * when, `tty` is `true`.
   */
  readonly term?: string;
  /** The terminal's locale, such as `C.UTF-8`; only a terminal session states one. */
  readonly locale?: string;
}

/** What any session stream the connector opens runs. */
type StreamOpen = Omit<SessionOpen, "mode"> & {
  readonly mode: SessionOpen["mode"] | "files";
};

/** The most arguments an exec's command holds. */
const MAX_COMMAND_ARGS = 1024;
/** The most bytes an exec's command holds. */
const MAX_COMMAND_BYTES = 32 << 10;

/** The largest terminal dimension, in character cells. */
const MAX_TERMINAL_DIMENSION = 10_000;

/**
 * Judges an open's stream before its create or its stream is sent, as the
 * endpoint judges its open frame: a terminal states its size, 1 to 10000
 * cells each way, and a type and locale
 * `validateWorkloadSessionTerminalProfile` admits, and only a terminal
 * does; a shell runs on a terminal, names no command, and names its shell,
 * when it does, by a clean absolute path; and an exec names its command
 * alone, 1 to 1024 arguments of at most 32 KiB together, the first naming
 * its program. An `ssh` stream is refused: it carries raw bytes after
 * `opened` and opens with OpenSSH. Throws a `TypeError`.
 */
export function validateSessionOpen(open: StreamOpen): void {
  const mode: string = open.mode;
  if (mode === "ssh") {
    throw new TypeError(
      "an ssh session carries raw bytes after opened and opens with OpenSSH",
    );
  }
  const tty = open.tty ?? false;
  const command = open.command ?? [];
  const shell = open.shell ?? "";
  if (tty !== (open.size !== undefined)) {
    throw new TypeError(
      "a terminal session states its size, and only a terminal session does",
    );
  }
  if (open.size !== undefined) validateTerminalSize(open.size);
  if (
    tty !== ((open.term ?? "") !== "") ||
    (!tty && (open.locale ?? "") !== "")
  ) {
    throw new TypeError(
      "a terminal session names its terminal type, and only a terminal session names a terminal",
    );
  }
  if (tty) {
    validateWorkloadSessionTerminalProfile({
      type: open.term ?? "",
      ...(open.locale === undefined ? {} : { locale: open.locale }),
    });
  }
  switch (open.mode) {
    case "shell":
      if (!tty || command.length > 0) {
        throw new TypeError(
          "a shell session runs on a terminal and names no command",
        );
      }
      if (shell !== "" && !isCleanAbsolutePath(shell)) {
        throw new TypeError(
          `shell ${JSON.stringify(shell)} is not a clean absolute path`,
        );
      }
      break;
    case "exec":
      if (shell !== "") {
        throw new TypeError("an exec names its command alone");
      }
      validateCommand(command);
      break;
    case "files":
      if (tty || shell !== "" || command.length > 0) {
        throw new TypeError("a files stream names nothing else");
      }
      break;
    default:
      throw new TypeError("unsupported mode");
  }
}

const utf8 = new TextEncoder();

function validateTerminalSize(size: TerminalSize): void {
  const inBounds = (dimension: number): boolean =>
    Number.isSafeInteger(dimension) &&
    dimension >= 1 &&
    dimension <= MAX_TERMINAL_DIMENSION;
  if (!inBounds(size.cols) || !inBounds(size.rows)) {
    throw new TypeError(
      `terminal size ${String(size.cols)}x${String(size.rows)} is outside 1 to ${String(MAX_TERMINAL_DIMENSION)}`,
    );
  }
}

/**
 * Whether `path` is absolute, holds no NUL, and is already in its clean
 * form: no empty, `.` or `..` segment and no trailing slash, except the
 * root `/` itself.
 */
function isCleanAbsolutePath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\0")) return false;
  if (path === "/") return true;
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validateCommand(command: readonly string[]): void {
  if (command.length === 0 || command.length > MAX_COMMAND_ARGS) {
    throw new TypeError(
      `an exec's command must hold 1 to ${String(MAX_COMMAND_ARGS)} arguments`,
    );
  }
  let total = 0;
  for (const argument of command) {
    total += utf8.encode(argument).length;
    if (argument.includes("\0")) {
      throw new TypeError("an exec's command holds a NUL");
    }
  }
  if (command[0] === "" || total > MAX_COMMAND_BYTES) {
    throw new TypeError(
      `an exec's command names its program and is at most ${String(MAX_COMMAND_BYTES)} bytes`,
    );
  }
}

/**
 * The features an open asks for, by mode: a shell and an exec ask for a
 * session that survives the loss of its stream, and an exec also for its
 * save result after exit. The endpoint refuses a feature its mode does not
 * take: a shell takes no save result, and a files stream takes no feature.
 */
function featuresFor(mode: StreamOpen["mode"]): readonly SessionFeature[] {
  switch (mode) {
    case "exec":
      return ["save-result", "reattach"];
    case "shell":
      return ["reattach"];
    case "files":
      return [];
  }
}
const RENEW_EVERY_MS = 60_000;
/**
 * The first and the longest pause between attempts to resume a lost
 * stream, in milliseconds; each pause doubles the last.
 */
const REATTACH_BACKOFF_MS = 100;
const REATTACH_BACKOFF_MAX_MS = 2_000;
/**
 * How long a resume keeps trying the grant one create installed before it
 * creates again, in milliseconds, so a Computer placed anew is found while
 * a lost path costs no create per attempt.
 */
const REATTACH_CREATE_EVERY_MS = 30_000;
const KEEPALIVE_MS = 20_000;
/**
 * The least time an open reads a session its create answered pending
 * without its endpoint before it gives up on the session being bound, and
 * the bound when no answer states the session's `readyBy`, in milliseconds.
 */
const BIND_WAIT_MS = 30_000;
/**
 * How long past a pending session's `readyBy` an open still reads it, in
 * milliseconds: the platform fails the session at `readyBy`, and the grace
 * covers its sweep and the clocks of this host and the platform
 * disagreeing, so the open normally reads the session failed.
 */
const READY_BY_GRACE_MS = 30_000;

/** A request to the Worker, before its `ref`. */
type Request = PageToWorker extends infer T
  ? T extends { readonly ref: number }
    ? Omit<T, "ref">
    : never
  : never;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface Docked {
  readonly dock: number;
  readonly trust: SessionTrust;
  readonly chain: readonly Uint8Array[];
  /** The client service lane profile the dock's edge serves; empty for none. */
  readonly serviceLaneProfile: string;
  /** The client certificate's `notBefore`, in milliseconds since the epoch. */
  readonly notBeforeMs: number;
  /** The client certificate's `notAfter`, in milliseconds since the epoch. */
  readonly notAfterMs: number;
}

interface Connection {
  readonly handle: number;
  readonly dock: number;
  readonly node: string;
  readonly established: Promise<number>;
  readonly streams: Map<number, Leg>;
  readonly listener: (m: WorkerToPage) => void;
}

/**
 * One page's end-to-end encrypted connections to the Account's Computers.
 * Each session's bytes are readable only by the page and the Computer.
 */
export interface ComputerConnector {
  /**
   * Starts the Worker, obtains the page's client certificate and the
   * Network's signed trust, and connects. Call it when the page loads: a
   * session waits for it, and none of it happens when a session opens. A
   * call after a failure starts again.
   *
   * From then until {@link ComputerConnector.close}, once a minute, the
   * connector renews its client certificate once half the certificate's
   * life has passed and connects again under the renewed one, in the
   * background: sessions opened after that use the new connection, and the
   * old one carries its streams until its certificate expires, when they
   * are resumed on the new one. When the Network's edge asks a connection to
   * drain, the connector connects again at once, in the background, and new
   * sessions wait for that connection instead.
   *
   * @throws {@link SessionTrustError} the Network's session trust fails
   *   verification or is older than the trust floor, or the floor cannot
   *   be read or written
   * @throws {@link ApiError} IDYL refuses the client certificate or the
   *   session trust
   * @throws {@link TransportError} a request to IDYL does not complete
   * @throws Error the connection to the Network's edge ends while it is
   *   made
   */
  ready(): Promise<void>;
  /**
   * Gets ready to open sessions on a Computer at once, where it was last
   * placed. It sends nothing for a Computer whose place it does not know,
   * and a failure only leaves the next session to connect.
   *
   * @param computer the Computer's ID
   */
  prepare(computer: string): void;
  /**
   * Opens a session on the Computer `computer` (its ID). Resolves once its
   * stream is open; its output, exit and save result arrive on the
   * stream's `output`. A `shell` or an `exec` session survives the loss of
   * its stream, as {@link ComputerSessionStream} describes. An `opened` that does not answer the open's mode,
   * as one carrying an SSH host key does for any mode but `ssh`, errors the
   * output with a `FrameError`, finishes the stream, and stops the
   * session's renewals, leaving it to its lease. An `ssh` session's stream carries raw SSH bytes
   * after `opened`, not frames, so the connector never opens one: OpenSSH
   * does. An open of mode `ssh` or `reattach` rejects with a `TypeError`
   * before anything is sent, so it neither wakes nor reaches the Computer.
   *
   * @param computer the Computer's ID
   * @throws TypeError `open` is not one the endpoint takes; nothing is sent
   * @throws {@link ComputerSessionEndedError} the session ended before it
   *   opened
   * @throws {@link ApiError} IDYL refuses the session, such as with
   *   `OUT_OF_USAGE`
   * @throws {@link TransportError} a request to IDYL does not complete
   * @throws {@link SessionTrustError} the connector cannot get ready, as
   *   {@link ComputerConnector.ready} rejects
   * @throws DOMException a `TimeoutError` when IDYL does not bind the
   *   session to the Computer by its ready-by time, or an `AbortError` when
   *   `close` is called first
   * @throws Error the connection to the Computer or to the Network's edge
   *   ends before the stream opens
   */
  open(computer: string, open: SessionOpen): Promise<ComputerSessionStream>;
  /**
   * Opens a `files` session on the Computer `computer` (its ID): listings
   * of the folders it watches, from the Computer's live disk, delivered to
   * `handlers`. Resolves once its stream is open; it watches nothing until
   * the caller calls `watch`. A Computer that is not awake refuses the
   * session with a `ComputerNotAwakeError` and is neither woken nor kept
   * awake: the returned promise rejects with that error, or, when the stream
   * was opened before the refusal arrived, the session ends `failed` with the
   * same error.
   *
   * @param computer the Computer's ID
   * @throws {@link ComputerNotAwakeError} the Computer is not awake
   * @throws {@link ApiError} IDYL refuses the session for another reason
   * @throws {@link TransportError} a request to IDYL does not complete
   * @throws {@link SessionTrustError} the connector cannot get ready, as
   *   {@link ComputerConnector.ready} rejects
   * @throws Error the connection to the Computer or to the Network's edge
   *   ends before the stream opens
   */
  openFiles(
    computer: string,
    handlers: FilesSessionHandlers,
  ): Promise<ComputerFilesSession>;
  /**
   * The connector's {@link ListeningState}, as its listeners were last
   * told it; `undefined` while its first attempt to listen is in flight.
   * It stays `listening` while a stream that ended is opened again at once.
   * Waits pace themselves by whether a stream carries events at that
   * moment, not by this value.
   */
  readonly listening: ListeningState | undefined;
  /**
   * Calls `listener` with each change to the Computers of the connector's
   * own Namespace, and of no other, and each start and stop of the event
   * stream. A wait on a Computer of another Namespace pauses as with no
   * event stream. The connector listens from
   * {@link ComputerConnector.ready} or its first session on; nothing waits
   * for it.
   *
   * @returns the function that removes the listener
   */
  listen(listener: ChangeListener): () => void;
  /** Ends every connection, and the event stream. */
  close(): void;
}

/**
 * The events that end a wait's pause for a change `matches` accepts, from
 * `connector`'s event stream, counted as carrying them only while its watch
 * is of `namespace` when one is named; `undefined` for a connector this
 * package did not build.
 */
export function connectorWaitEvents(
  connector: ComputerConnector,
  namespace: string | undefined,
  matches: (change: ComputerChange) => boolean,
): WaitEvents | undefined {
  return connector instanceof Connector
    ? connector.waitEvents(matches, namespace)
    : undefined;
}

/** Builds a connector. */
export function computerConnector(
  options: ComputerConnectorOptions,
): ComputerConnector {
  return new Connector(options);
}

class Connector implements ComputerConnector {
  readonly #o: ComputerConnectorOptions;
  readonly #floor: TrustFloor;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(m: WorkerToPage) => void>();
  readonly #lanes = new Map<string, Promise<number>>();
  readonly #connections = new Map<string, Promise<Connection>>();
  readonly #known = new Map<string, ComputerSessionEndpoint>();
  readonly #sessions = new Map<string, Set<string>>();
  // Recent events, so a wait that starts after its request was sent still
  // sees an event the Worker sent with the reply.
  readonly #log: { readonly seq: number; readonly message: WorkerToPage }[] =
    [];
  #seq = 0;
  #ref = 1;
  #account = "";
  // The Worker's certificate request, once the Worker has started. The
  // Worker's key outlives every dock.
  #started: Promise<Uint8Array> | undefined;
  // The dock new sessions use, live or in flight. It is dropped when the
  // dock ends or fails to dock, so the next session docks again; it is
  // replaced at once when the edge asks the dock to drain, and by the dock
  // under a renewed certificate once that one has docked.
  #ready: Promise<Docked> | undefined;
  // The dock #ready last resolved to, until it ends.
  #current: Docked | undefined;
  // The one dock in flight, for sessions or for a renewal: every caller
  // that needs a dock while one is in flight joins it.
  #docking: Promise<Docked> | undefined;
  // The docks the connector holds open, each with the timer that closes it
  // at its certificate's notAfter once a later dock replaced it.
  readonly #docks = new Map<
    number,
    { retire: ReturnType<typeof setTimeout> | undefined }
  >();
  // The docks the edge asked to drain.
  readonly #draining = new Set<number>();
  // Counts closes, so a dock that docks after a close is closed.
  #generation = 0;
  // The edge's earliest time to dock again, from the last dock's end.
  #notBeforeMs = 0;
  #renewer: ReturnType<typeof setInterval> | undefined;
  // Aborted by close, which ends every read of an unbound session.
  #closing = new AbortController();
  readonly #changes: Listening;

  constructor(options: ComputerConnectorOptions) {
    this.#o = options;
    this.#changes = new Listening({
      docked: async () => {
        const { dock, trust, chain, serviceLaneProfile } = await this.#state();
        return {
          dock,
          chain,
          serviceLaneProfile,
          service: eventService(trust),
        };
      },
      request: (request) => this.#request(request),
      listen: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
      createWatch: () => this.#o.api.createWatch(),
    });
    // The default floor opens its database now, at page load, so a dock's
    // floor read is one transaction.
    this.#floor = options.trustFloor ?? defaultTrustFloor();
    options.worker.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "reply") {
        const pending = this.#pending.get(message.ref);
        if (pending === undefined) return;
        this.#pending.delete(message.ref);
        if (message.error === undefined) pending.resolve(message.value);
        else pending.reject(new Error(message.error));
        return;
      }
      this.#log.push({ seq: ++this.#seq, message });
      if (this.#log.length > 256) this.#log.shift();
      for (const listener of [...this.#listeners]) listener(message);
    });
  }

  /**
   * Starts the Worker, obtains the client certificate and the Zone's
   * trust, and docks. Call it at page load; every other method waits for
   * it, and nothing here happens on a click unless the dock has ended.
   */
  ready(): Promise<void> {
    const ready = this.#state().then(() => undefined);
    // Listening follows the dock and never holds it up.
    void ready.then(
      () => {
        this.#changes.start();
      },
      () => undefined,
    );
    return ready;
  }

  get listening(): ListeningState | undefined {
    return this.#changes.listening;
  }

  listen(listener: ChangeListener): () => void {
    return this.#changes.subscribe(listener);
  }

  /**
   * The events that end a wait's pause for a change `matches` accepts, and
   * for every `reread`, for the waits of the Computer client.
   */
  waitEvents(
    matches: (change: ComputerChange) => boolean,
    namespace?: string,
  ): WaitEvents {
    return this.#changes.waitEvents(matches, namespace);
  }

  /** The dock new sessions use, docking when there is none. */
  #state(): Promise<Docked> {
    this.#ready ??= this.#redock();
    return this.#ready;
  }

  /**
   * Docks under a client certificate issued for the dock, or joins the dock
   * already in flight. Once docked, the dock is the one new sessions use,
   * and the dock it replaces is closed at its certificate's `notAfter`: its
   * connections carry on until then, and their streams are then resumed on
   * a live dock. A dock that docks after `close` is closed.
   */
  #redock(): Promise<Docked> {
    if (this.#docking !== undefined) return this.#docking;
    const generation = this.#generation;
    const next = this.#dock();
    this.#docking = next;
    next.then(
      (docked) => {
        if (this.#docking === next) this.#docking = undefined;
        if (generation !== this.#generation) {
          void this.#request({ type: "close-dock", dock: docked.dock }).catch(
            () => undefined,
          );
          return;
        }
        if (!this.#docks.has(docked.dock)) {
          // It ended before it was used.
          if (this.#ready === next) this.#ready = undefined;
          return;
        }
        const previous = this.#current;
        this.#current = docked;
        this.#ready = next;
        if (previous !== undefined) this.#retire(previous);
      },
      () => {
        if (this.#docking === next) this.#docking = undefined;
        if (this.#ready === next) this.#ready = undefined;
      },
    );
    return next;
  }

  /** Closes `docked` at its certificate's `notAfter`, or at once if that has passed. */
  #retire(docked: Docked): void {
    const held = this.#docks.get(docked.dock);
    if (held === undefined || held.retire !== undefined) return;
    held.retire = setTimeout(
      () => {
        held.retire = undefined;
        void this.#request({ type: "close-dock", dock: docked.dock }).catch(
          () => undefined,
        );
      },
      Math.max(0, docked.notAfterMs - Date.now()),
    );
  }

  /**
   * The connector's upkeep, on its renewal tick: it docks when no dock is
   * live or in flight, and docks again under a renewed certificate once half
   * the live dock's certificate's life has passed.
   */
  #maintain(): void {
    if (this.#docking !== undefined) return;
    const current = this.#current;
    if (
      this.#ready === undefined ||
      current === undefined ||
      this.#draining.has(current.dock)
    ) {
      this.#ready = this.#redock();
      this.#ready.catch(() => undefined);
      return;
    }
    const half =
      current.notBeforeMs + (current.notAfterMs - current.notBeforeMs) / 2;
    if (Date.now() >= half) void this.#redock().catch(() => undefined);
  }

  /**
   * The edge asked the dock `dock` to drain: its Computer connections serve
   * no new session, and when it is the dock new sessions use, a new dock is
   * docked at once, in the background, which new sessions join.
   */
  #drained(dock: number): void {
    if (this.#draining.has(dock) || !this.#docks.has(dock)) return;
    this.#draining.add(dock);
    for (const [computer, opened] of [...this.#connections]) {
      void opened.then(
        (connection) => {
          if (
            connection.dock === dock &&
            this.#connections.get(computer) === opened
          ) {
            this.#connections.delete(computer);
          }
        },
        () => undefined,
      );
    }
    if (this.#current?.dock !== dock) return;
    this.#ready = this.#redock();
    this.#ready.catch(() => undefined);
  }

  /**
   * Gets ready to open sessions on `computer` at once: the lane to its last
   * known place and, when it is awake there, the connection to it.
   */
  prepare(computer: string): void {
    const known = this.#known.get(computer) ?? this.#recall(computer);
    if (known === undefined) return;
    this.#known.set(computer, known);
    void this.#connection(computer, known).catch(() => undefined);
  }

  /**
   * Opens a session on `computer`. Resolves once its stream is open; the
   * session's output, exit and save result arrive on its `output`.
   */
  open(computer: string, open: SessionOpen): Promise<ComputerSessionStream> {
    return this.#open(computer, open);
  }

  /**
   * Opens a `files` session on `computer`. Resolves once its stream is
   * open; its listings arrive on `handlers`.
   */
  async openFiles(
    computer: string,
    handlers: FilesSessionHandlers,
  ): Promise<ComputerFilesSession> {
    return filesSession(
      await this.#open(computer, { mode: "files" }),
      handlers,
    );
  }

  async #open(computer: string, open: StreamOpen): Promise<SessionStream> {
    // The stream and the create are judged before anything is sent, so a
    // refused open neither wakes the Computer nor reaches it.
    validateSessionOpen(open);
    const requestID = crypto.randomUUID();
    const request: CreateComputerSessionRequest = {
      operation: "shell",
      attachment: "endpoint",
      endpoint: { mode: open.mode },
      idempotencyKey: requestID,
      client: this.#o.client ?? "sdk",
    };
    validateCreateComputerSessionRequest(request);
    await this.ready();
    const created = this.#o.api.createSession(computer, request);
    // A pending answer bound to its Activation carries its endpoint as a
    // ready one does; the endpoint holds the stream until the grant is
    // installed, so either is connected to at once. Only a pending answer
    // without its endpoint is read again, until the session is bound.
    const answered = created.then((session) =>
      unbound(session)
        ? this.#bound(computer, session).then((bound) =>
            this.#placed(computer, bound, true),
          )
        : this.#placed(computer, session, true),
    );
    answered.catch(() => undefined);
    // A session event for this session makes the read that tells whether it
    // failed at once, while its connection is made and its stream answered.
    const failure = this.#endedOnEvent(computer, created);
    const watched = Promise.race([answered, failure.ended]);
    watched.catch(() => undefined);
    // The client connects where it last saw the Computer; with no place
    // known it waits for the create. The endpoint's certificate must name
    // an Activation epoch at least the one known, so a command never
    // reaches an earlier Activation.
    const known =
      this.#known.get(computer) ?? this.#recall(computer) ?? (await answered);
    let connection: Connection;
    let deadline = Date.now() + OPEN_WAIT_MS;
    try {
      try {
        // A create that answers another place ends the attempt on the
        // remembered one at once.
        connection = await this.#establish(
          computer,
          known,
          watched,
          deadline,
          false,
          (endpoint) => !sameEndpoint(endpoint, known),
        );
      } catch (first) {
        if (first instanceof CreateFailure) throw first;
        // The place the client knew is stale: the create says where it is.
        const endpoint = await watched;
        if (sameEndpoint(endpoint, known)) throw first;
        deadline = Date.now() + OPEN_WAIT_MS;
        connection = await this.#establish(
          computer,
          endpoint,
          watched,
          deadline,
          true,
        );
      }
    } catch (error) {
      failure.stop();
      throw await this.#unopened(computer, created, error);
    }
    const session = await this.#stream(computer, connection, requestID, open);
    session.answerBy(deadline, () => this.#late(computer, created));
    session.onSettled(failure.stop);
    failure.ended.catch((error: unknown) => {
      session.fail(error);
    });
    created.then(
      (served) => {
        session.served(served.id);
      },
      (error: unknown) => {
        session.fail(error);
      },
    );
    // A stream sent before the answer is ended at once by a session that
    // ended before it opened, as a refused create ends it.
    answered.catch((error: unknown) => {
      if (error instanceof ComputerSessionEndedError) session.fail(error);
    });
    return session;
  }

  /**
   * Where the grant of `session`, as its create answered or a read found
   * it, is installed, remembered as the Computer's place; with `track`, the
   * session is renewed from then on. A session answered final without its
   * endpoint is a {@link ComputerSessionEndedError}.
   */
  #placed(
    computer: string,
    session: ServedSession,
    track: boolean,
  ): ComputerSessionEndpoint {
    const endpoint = session.status.endpoint;
    if (endpoint === undefined) {
      const phase = session.status.phase;
      if (isEndedPhase(phase)) {
        throw new ComputerSessionEndedError({
          session: session.id,
          phase,
          ...(session.status.reason === undefined
            ? {}
            : { reason: session.status.reason }),
        });
      }
      throw new Error("the session was created without its endpoint");
    }
    this.#remember(computer, endpoint);
    if (track) this.#track(computer, session.id);
    return endpoint;
  }

  /**
   * Connects to the Computer at `at` and waits until the connection is
   * established, or until `deadline`, in milliseconds since the epoch, when
   * it rejects with a `TimeoutError` `DOMException` and the connection is
   * closed, so the next open connects afresh. The session's create is
   * watched beside it: a create that fails, or answers the session ended,
   * ends the attempt at once with a {@link CreateFailure} carrying why.
   */
  async #establish(
    computer: string,
    at: ComputerSessionEndpoint,
    answered: Promise<ComputerSessionEndpoint>,
    deadline: number,
    fresh = false,
    moved?: (endpoint: ComputerSessionEndpoint) => boolean,
  ): Promise<Connection> {
    const opened = this.#connection(computer, at, fresh);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          reject(
            new DOMException(
              `the Computer connection was not established within ${String(OPEN_WAIT_MS)} ms`,
              "TimeoutError",
            ),
          );
        },
        Math.max(0, deadline - Date.now()),
      );
    });
    const refused = answered.then(
      (endpoint) => {
        if (moved?.(endpoint) === true) {
          throw new Error("the create answered another place");
        }
        return new Promise<never>(() => undefined);
      },
      (cause: unknown) => {
        throw new CreateFailure(cause);
      },
    );
    try {
      return await Promise.race([
        opened.then(async (connection) => {
          await connection.established;
          return connection;
        }),
        late,
        refused,
      ]);
    } catch (error) {
      if (!(error instanceof CreateFailure)) this.#drop(computer, opened);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * What an open whose connection was not made rejects with. A create that
   * failed, or answered the session ended, ends it with its own failure.
   * Otherwise the session, once its create has answered, is read once: a
   * session in a final phase ends the open with a
   * {@link ComputerSessionEndedError} and its reason, and any other with
   * `error`. The session is no longer renewed and is cancelled, since
   * nothing will use it; cancelling a session already final changes
   * nothing.
   */
  async #unopened(
    computer: string,
    created: Promise<ServedSession>,
    error: unknown,
  ): Promise<unknown> {
    if (error instanceof CreateFailure) return error.cause;
    const served = await created.catch(() => undefined);
    if (served === undefined) return error;
    this.#sessions.get(computer)?.delete(served.id);
    const ended = await this.#endedNow(computer, served.id);
    void this.#o.api.cancelSession(computer, served.id).catch(() => undefined);
    return ended ?? error;
  }

  /**
   * Follows the connector's events for the session `created` answers: each
   * `session` event for it, and each `reread`, reads it once, and `ended`
   * rejects with a {@link ComputerSessionEndedError} when it is final, until
   * `stop` is called. Nothing else rejects it.
   */
  #endedOnEvent(
    computer: string,
    created: Promise<ServedSession>,
  ): { readonly ended: Promise<never>; readonly stop: () => void } {
    let stopped = false;
    let remove: (() => void) | undefined;
    const ended = new Promise<never>((_, reject) => {
      void created.then(
        (served) => {
          if (stopped) return;
          remove = this.#changes.subscribe({
            onChange: (change) => {
              if (
                change.part !== "reread" &&
                !(change.part === "session" && change.id === served.id)
              ) {
                return;
              }
              void this.#endedNow(computer, served.id).then((error) => {
                if (error !== undefined && !stopped) reject(error);
              });
            },
          });
        },
        () => undefined,
      );
    });
    ended.catch(() => undefined);
    return {
      ended,
      stop: () => {
        stopped = true;
        remove?.();
      },
    };
  }

  /**
   * What a stream the endpoint did not answer in time fails with: once its
   * create has answered, the session is read once, and a session in a final
   * phase fails it with a {@link ComputerSessionEndedError} and its reason;
   * otherwise a `TimeoutError` `DOMException`.
   */
  async #late(
    computer: string,
    created: Promise<ServedSession>,
  ): Promise<unknown> {
    const served = await created.catch(() => undefined);
    const ended =
      served === undefined
        ? undefined
        : await this.#endedNow(computer, served.id);
    return (
      ended ??
      new DOMException(
        `the endpoint did not answer the session's open within ${String(OPEN_WAIT_MS)} ms`,
        "TimeoutError",
      )
    );
  }

  /**
   * One read of the session `id`: a {@link ComputerSessionEndedError} when
   * it is in a final phase, and `undefined` when it is not or the read
   * fails. The read cannot hold an open: the client's transport bounds
   * every request by its request timeout, 30 s unless the client states
   * another, and a read that runs out reads as not final.
   */
  async #endedNow(
    computer: string,
    id: string,
  ): Promise<ComputerSessionEndedError | undefined> {
    try {
      const read = await this.#o.api.readSession(
        computer,
        id,
        this.#closing.signal,
      );
      const phase = read.status.phase;
      if (!isEndedPhase(phase)) return undefined;
      return new ComputerSessionEndedError({
        session: read.id,
        phase,
        ...(read.status.reason === undefined
          ? {}
          : { reason: read.status.reason }),
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Forgets the connection `opened` and asks the Worker to close it, once
   * it has a handle, so a connection that was never established is not
   * reused.
   */
  #drop(computer: string, opened: Promise<Connection>): void {
    if (this.#connections.get(computer) === opened) {
      this.#connections.delete(computer);
    }
    void opened.then(
      (connection) => {
        this.#listeners.delete(connection.listener);
        for (const s of connection.streams.values()) s.ended(true);
        connection.streams.clear();
        void this.#request({
          type: "close-computer",
          dock: connection.dock,
          computer: connection.handle,
        }).catch(() => undefined);
      },
      () => undefined,
    );
  }

  /**
   * Reads `session`, which its create answered pending without its
   * endpoint, until it is bound or in another phase, and resolves to it
   * then. The platform holds a session unbound while the Computer's
   * previous Activation is released, as after the Computer went to sleep,
   * and while the Computer's wake runs, as while its files are fetched; it
   * fails a session still pending at the session's `readyBy`, which moves
   * forward while the wake makes progress. The reads therefore go on until
   * the latest `readyBy` read has passed by {@link READY_BY_GRACE_MS}, and
   * never end before {@link BIND_WAIT_MS}, which is also the bound when no
   * answer states a `readyBy`. They pause by
   * {@link sessionPlacementPauses}; a read that meets a network
   * failure, HTTP 429 or a server error is tried again at the next pause,
   * and any other refusal rejects at once. A session still unbound once the
   * bound passed rejects with a `TimeoutError` `DOMException`, and `close`
   * ends the reads at once with an `AbortError`.
   */
  async #bound(
    computer: string,
    session: ServedSession,
  ): Promise<ServedSession> {
    const started = Date.now();
    let current = session;
    let readyBy = instant(session.status.readyBy);
    let until = boundBy(readyBy, started);
    const pauses = sessionPlacementPauses();
    for (;;) {
      try {
        await pollUntil<ServedSession>(
          {
            timeoutMs: Math.max(0, until - Date.now()),
            signal: this.#closing.signal,
          },
          {
            events: this.#changes.waitEvents(
              (change) => change.part === "session" && change.id === session.id,
            ),
            initial: current,
            read: async (signal) => {
              try {
                current = await this.#o.api.readSession(
                  computer,
                  session.id,
                  signal,
                );
              } catch (error) {
                if (signal.aborted || !passing(error)) throw error;
              }
              return current;
            },
            met: (read) => !unbound(read),
            timeoutMessage: () =>
              readyBy === undefined
                ? `computer session ${session.id} was not bound to an Activation within ${String(BIND_WAIT_MS)} ms`
                : `computer session ${session.id} was not bound to an Activation by its ready-by time ${rfc3339Seconds(readyBy)}`,
            pauses: (streaming, elapsedMs) =>
              Math.max(
                0,
                Math.min(pauses(streaming, elapsedMs), until - Date.now()),
              ),
          },
        );
        return current;
      } catch (error) {
        // A wait that ran out goes on only when a read moved the session's
        // readyBy, and with it the bound, forward.
        if (!(error instanceof DOMException) || error.name !== "TimeoutError")
          throw error;
        const moved = instant(current.status.readyBy);
        if (moved === undefined || (readyBy !== undefined && moved <= readyBy))
          throw error;
        readyBy = moved;
        const next = boundBy(readyBy, started);
        if (next <= until) throw error;
        until = next;
      }
    }
  }

  /** Ends every connection, the event stream and every dock. */
  close(): void {
    this.#changes.stop();
    if (this.#renewer !== undefined) clearInterval(this.#renewer);
    this.#renewer = undefined;
    this.#closing.abort();
    this.#closing = new AbortController();
    this.#generation++;
    this.#ready = undefined;
    this.#docking = undefined;
    this.#current = undefined;
    for (const [dock, held] of this.#docks) {
      clearTimeout(held.retire);
      held.retire = undefined;
      void this.#request({ type: "close-dock", dock }).catch(() => undefined);
    }
  }

  /** Starts the Worker once; resolves to its certificate request. */
  #start(): Promise<Uint8Array> {
    if (this.#started === undefined) {
      const started = (async () => {
        const key = new Promise<Uint8Array>((resolve) => {
          const listener = (m: WorkerToPage): void => {
            if (m.type === "key") {
              this.#listeners.delete(listener);
              resolve(m.certificateRequest);
            }
          };
          this.#listeners.add(listener);
        });
        this.#account = await this.#o.account();
        await this.#request({ type: "start", module: this.#o.module });
        return key;
      })();
      this.#started = started;
      started.catch(() => {
        if (this.#started === started) this.#started = undefined;
      });
    }
    return this.#started;
  }

  /**
   * Holds a verified bundle to the trust floor of its Network and the Zone
   * the client's placement chose, which the bundle was verified to name:
   * an older version is refused, and a newer one raises the floor, in one
   * atomic step. A floor that cannot be read or written refuses the bundle:
   * a rollback is never accepted because the floor was out of reach.
   */
  async #holdToFloor(verified: SessionTrust): Promise<void> {
    try {
      await this.#floor.accept(
        verified.network,
        verified.zone,
        verified.version,
      );
    } catch (error) {
      if (error instanceof SessionTrustError) throw error;
      throw new SessionTrustError("session trust floor is unavailable", {
        cause: error,
      });
    }
  }

  /**
   * Obtains a client certificate and the Zone's trust, and docks. Each dock
   * is admitted with a certificate issued for it.
   */
  async #dock(): Promise<Docked> {
    // The trust is fetched, verified and held to the floor while the client
    // certificate is requested, so neither waits for the other.
    const trust = this.#o.api.sessionTrust().then(async (placed) => {
      if (placed.scope === "") {
        throw new SessionTrustError(
          "the client's placement names no session trust scope",
        );
      }
      const verified = await verifySessionTrust(placed.response, {
        network: this.#o.network,
        zone: placed.scope,
        keys: this.#o.trustKeys,
        minVersion: 0,
        nowMs: Date.now(),
      });
      await this.#holdToFloor(verified);
      return verified;
    });
    trust.catch(() => undefined);
    const wait = this.#notBeforeMs - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const certificate = await this.#o.api.certify(await this.#start());
    const verified = await trust;
    const docked = this.#event(
      (m) => m.type === "docked" || m.type === "dock-ended",
    );
    const dock = (await this.#request({
      type: "dock",
      url:
        this.#o.edgeUrl?.(verified.zone) ??
        verified.dataFabric.browserEndpoint ??
        `wss://edge.${verified.zone}.zone.${this.#o.network}/hyperplane/fallback/1`,
      serverName: verified.dataFabric.endpoint.replace(/:\d+$/, ""),
      edgeId: verified.dataFabric.serverId,
      edgeRoots: verified.dataFabric.serverRoots,
      chain: certificate.chain,
      lease: certificate.admissionLease,
      keepaliveMs: KEEPALIVE_MS,
    })) as number;
    const outcome = await docked;
    if (outcome.type === "dock-ended") {
      this.#ended(outcome);
      throw new Error(`the dock ended: ${outcome.reason}`);
    }
    const serviceLaneProfile =
      outcome.type === "docked" ? outcome.serviceLaneProfile : "";
    const ending = (m: WorkerToPage): void => {
      if (!onDock(m, dock)) return;
      if (m.type === "drain") {
        this.#drained(dock);
      } else if (m.type === "dock-ended") {
        this.#listeners.delete(ending);
        this.#ended(m);
      }
    };
    this.#docks.set(dock, { retire: undefined });
    this.#listeners.add(ending);
    this.#renewer ??= setInterval(() => {
      this.#renew();
      this.#maintain();
    }, this.#o.renewEveryMs ?? RENEW_EVERY_MS);
    return {
      dock,
      trust: verified,
      chain: certificate.chain,
      serviceLaneProfile,
      notBeforeMs: certificate.notBeforeMs,
      notAfterMs: certificate.notAfterMs,
    };
  }

  /**
   * Forgets a dock that ended, its lanes and its Computer connections, and
   * ends their streams as lost: the Worker no longer holds any of them, and
   * a session that survives the loss of its stream resumes on a live dock.
   * The next session uses the dock in flight or docks again, no earlier
   * than the edge asked.
   */
  #ended(m: Extract<WorkerToPage, { type: "dock-ended" }>): void {
    if (m.retryAfterMs !== undefined) {
      this.#notBeforeMs = Date.now() + m.retryAfterMs;
    }
    clearTimeout(this.#docks.get(m.dock)?.retire);
    this.#docks.delete(m.dock);
    this.#draining.delete(m.dock);
    if (this.#current?.dock === m.dock) {
      this.#current = undefined;
      // New sessions wait for the dock in flight, if any, or dock again.
      this.#ready = this.#docking;
    }
    for (const key of [...this.#lanes.keys()]) {
      if (key.startsWith(`${String(m.dock)} `)) this.#lanes.delete(key);
    }
    for (const [computer, opened] of [...this.#connections]) {
      void opened.then(
        (connection) => {
          if (connection.dock !== m.dock) return;
          this.#listeners.delete(connection.listener);
          for (const s of connection.streams.values()) s.ended(true);
          connection.streams.clear();
          if (this.#connections.get(computer) === opened) {
            this.#connections.delete(computer);
          }
        },
        () => undefined,
      );
    }
  }

  #remember(computer: string, endpoint: ComputerSessionEndpoint): void {
    this.#known.set(computer, endpoint);
    this.#o.placements?.save(computer, JSON.stringify(endpoint));
  }

  #recall(computer: string): ComputerSessionEndpoint | undefined {
    const text = this.#o.placements?.load(computer);
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as ComputerSessionEndpoint;
      return typeof value.placement.hostPod === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  #track(computer: string, session: string): void {
    let set = this.#sessions.get(computer);
    if (set === undefined) {
      set = new Set();
      this.#sessions.set(computer, set);
    }
    set.add(session);
  }

  /**
   * Renews every session the page holds. A session the platform does not
   * know or holds as final is never renewed again; its stream is left to
   * the endpoint, which ends it when its permit runs out, so output still
   * on the way, such as a command's exit and save result, is not cut off. A
   * session whose renewal failed for any other reason is renewed at the
   * next interval.
   */
  #renew(): void {
    for (const [computer, sessions] of this.#sessions) {
      if (sessions.size === 0) continue;
      void this.#o.api.renewSessions(computer, [...sessions]).then(
        (over) => {
          for (const session of over) sessions.delete(session);
        },
        () => undefined,
      );
    }
  }

  async #lane(docked: Docked, node: string): Promise<number> {
    const { dock, trust } = docked;
    const principal = `spiffe://${trust.zone}.zone.${this.#o.network}/node/${node}/data-dock`;
    // Lanes are the dock's: keyed by it, so a later dock opens its own.
    const key = `${String(dock)} ${principal}`;
    let lane = this.#lanes.get(key);
    if (lane === undefined) {
      lane = (async () => {
        const since = this.#mark();
        const handle = (await this.#request({
          type: "open-lane",
          dock,
          principal,
        })) as number;
        // The lane ends with its dock, which the Worker reports only once.
        const outcome = await this.#event(
          (m) =>
            onDock(m, dock) &&
            (((m.type === "lane-ready" || m.type === "lane-ended") &&
              m.lane === handle) ||
              m.type === "dock-ended"),
          since,
        );
        if (outcome.type === "lane-ended" || outcome.type === "dock-ended") {
          throw new Error(
            `the lane to the Computer's machine ended: ${outcome.reason}`,
          );
        }
        return handle;
      })();
      this.#lanes.set(key, lane);
      lane.catch(() => this.#lanes.delete(key));
    }
    return lane;
  }

  #connection(
    computer: string,
    at: ComputerSessionEndpoint,
    fresh = false,
  ): Promise<Connection> {
    const current = this.#connections.get(computer);
    if (current !== undefined && !fresh) return current;
    const opened = (async () => {
      const docked = await this.#state();
      const { dock, trust, chain } = docked;
      const lane = await this.#lane(docked, at.placement.node);
      const since = this.#mark();
      const handle = (await this.#request({
        type: "open-computer",
        dock,
        lane,
        hostPod: at.placement.hostPod,
        sequence: String(at.placement.sequence),
        epoch: String(at.epoch),
        roots: trust.podRoots,
        chain,
        trustDomain: `${trust.zone}.zone.${this.#o.network}`,
        account: this.#account,
        computer: computer,
        minEpoch: String(at.epoch),
      })) as number;
      const streams = new Map<number, Leg>();
      const established = this.#event(
        (m) =>
          onDock(m, dock) &&
          (((m.type === "computer-established" ||
            m.type === "computer-ended") &&
            m.computer === handle) ||
            m.type === "dock-ended"),
        since,
      ).then((m) => {
        if (m.type === "computer-ended" || m.type === "dock-ended") {
          throw new Error(`the Computer connection ended: ${m.reason}`);
        }
        return Number(m.type === "computer-established" ? m.epoch : 0);
      });
      // A connection readied ahead may end unawaited (the Computer left
      // its place); a session that waits on it still sees why.
      established.catch(() => undefined);
      // A handle is unique only within its dock.
      const listener = (m: WorkerToPage): void => {
        if (!onDock(m, dock)) return;
        if (m.type === "data" && m.computer === handle) {
          streams.get(m.stream)?.receive(m.bytes);
        } else if (m.type === "stream-ended" && m.computer === handle) {
          streams.get(m.stream)?.ended(m.broken);
          streams.delete(m.stream);
        } else if (m.type === "computer-ended" && m.computer === handle) {
          this.#listeners.delete(listener);
          for (const s of streams.values()) s.ended(true);
          streams.clear();
          if (this.#connections.get(computer) === opened) {
            this.#connections.delete(computer);
          }
        }
      };
      const connection: Connection = {
        handle,
        dock,
        node: at.placement.node,
        established,
        streams,
        listener,
      };
      this.#listeners.add(listener);
      return connection;
    })();
    this.#connections.set(computer, opened);
    opened.catch(() => {
      if (this.#connections.get(computer) === opened)
        this.#connections.delete(computer);
    });
    return opened;
  }

  async #stream(
    computer: string,
    connection: Connection,
    requestID: string,
    open: StreamOpen,
  ): Promise<SessionStream> {
    const features = featuresFor(open.mode);
    const leg = await this.#openLeg(connection, {
      requestID,
      mode: open.mode,
      tty: open.tty ?? false,
      features,
      ...(open.shell === undefined ? {} : { shell: open.shell }),
      ...(open.command === undefined ? {} : { command: open.command }),
      ...(open.size === undefined ? {} : { size: open.size }),
      ...(open.term === undefined ? {} : { term: open.term }),
      ...(open.locale === undefined ? {} : { locale: open.locale }),
    });
    const session: SessionStream = new SessionStream({
      requestId: requestID,
      mode: open.mode,
      leg,
      savesResult: features.includes("save-result"),
      forget: () => {
        this.#sessions.get(computer)?.delete(session.id ?? "");
      },
      abandon: (id) => {
        // A cancel that fails leaves the session to its attach
        // deadline; the stream's error is what the caller acts on.
        this.#sessions.get(computer)?.delete(id);
        void this.#o.api.cancelSession(computer, id).catch(() => undefined);
      },
      ...(features.includes("reattach")
        ? { resume: this.#reattacher(computer, features) }
        : {}),
    });
    session.begin();
    return session;
  }

  /**
   * Opens a stream on `connection`, on the connection's own dock, and sends
   * its open frame.
   */
  async #openLeg(connection: Connection, frame: OpenFrame): Promise<Leg> {
    const { dock, handle } = connection;
    const stream = (await this.#request({
      type: "open-stream",
      dock,
      computer: handle,
    })) as number;
    const leg = new Leg(
      (bytes) => {
        void this.#request(
          { type: "write", dock, computer: handle, stream, bytes },
          [bytes.buffer],
        ).catch(() => undefined);
      },
      () => {
        void this.#request({
          type: "finish",
          dock,
          computer: handle,
          stream,
        }).catch(() => undefined);
      },
    );
    connection.streams.set(stream, leg);
    leg.send(encodeFrame({ type: "open", ...frame }));
    return leg;
  }

  /**
   * The resume of one session on `computer`, which asked for `features`:
   * each call reopens the session from a cursor, in a stream of mode
   * `reattach` under a create of its own. It keeps trying the grant one
   * create installed while the endpoint cannot be reached, and creates again
   * once the endpoint answers that the grant is gone, once the create
   * failed, or after {@link REATTACH_CREATE_EVERY_MS}. Calls come one at a
   * time, from the stream's resume.
   */
  #reattacher(computer: string, features: readonly SessionFeature[]): Resume {
    let answer: Promise<ComputerSessionEndpoint> | undefined;
    let failed = false;
    let requestID = "";
    let createdAt = 0;
    return async (session, cursor, signal, until) => {
      if (
        answer === undefined ||
        Date.now() - createdAt > REATTACH_CREATE_EVERY_MS
      ) {
        requestID = crypto.randomUUID();
        const request: CreateComputerSessionRequest = {
          operation: "shell",
          attachment: "endpoint",
          endpoint: { mode: "reattach", session },
          idempotencyKey: requestID,
          client: this.#o.client ?? "sdk",
        };
        validateCreateComputerSessionRequest(request);
        const created = this.#o.api
          .createSession(computer, request)
          .then((served) =>
            unbound(served) ? this.#bound(computer, served) : served,
          )
          .then((served) => this.#placed(computer, served, false));
        failed = false;
        created.catch(() => {
          if (answer === created) failed = true;
        });
        answer = created;
        createdAt = Date.now();
      }
      const attempt = answer;
      try {
        const resumed = await this.#resumeOn(
          computer,
          {
            requestID,
            mode: "reattach",
            tty: false,
            session,
            cursor,
            features,
          },
          attempt,
          signal,
          until,
        );
        answer = undefined;
        return resumed;
      } catch (error) {
        if (
          (answer === attempt && failed) ||
          (error instanceof EndpointRefusal && error.code === "not_granted")
        ) {
          answer = undefined;
        }
        throw error;
      }
    };
  }

  /**
   * One attempt to reattach a session with `frame`, whose create `answer`
   * answers: on the open connection to `computer`, or one made to where it
   * was last seen or where the create answers, each wait bounded by
   * {@link OPEN_WAIT_MS} and by `until`. A create that answers a later
   * Activation than the connection's endpoint serves is followed once, to
   * the answered endpoint. Resolves to the stream once the endpoint
   * answered `opened`.
   */
  async #resumeOn(
    computer: string,
    frame: OpenFrame,
    answer: Promise<ComputerSessionEndpoint>,
    signal: AbortSignal,
    until: number,
  ): Promise<Resumed> {
    const deadline = (): number => Math.min(Date.now() + OPEN_WAIT_MS, until);
    const known = this.#known.get(computer) ?? (await answer);
    let connection: Connection;
    try {
      connection = await this.#establish(
        computer,
        known,
        answer,
        deadline(),
        false,
        (endpoint) => !sameEndpoint(endpoint, known),
      );
    } catch (first) {
      if (first instanceof CreateFailure) throw first.cause;
      const endpoint = await answer;
      if (sameEndpoint(endpoint, known)) throw first;
      connection = await this.#establish(
        computer,
        endpoint,
        answer,
        deadline(),
        true,
      );
    }
    for (let followed = false; ; followed = true) {
      const leg = await this.#openLeg(connection, frame);
      try {
        return await firstFrame(
          leg,
          answer,
          await connection.established,
          deadline(),
          signal,
        );
      } catch (error) {
        if (!(error instanceof Superseded) || followed) throw error;
        connection = await this.#establish(
          computer,
          error.endpoint,
          answer,
          deadline(),
          true,
        );
      }
    }
  }

  #request(request: Request, transfer: Transferable[] = []): Promise<unknown> {
    const ref = this.#ref++;
    return new Promise((resolve, reject) => {
      this.#pending.set(ref, { resolve, reject });
      this.#o.worker.postMessage({ ...request, ref }, transfer);
    });
  }

  /** The event count so far, to wait from with {@link #event}. */
  #mark(): number {
    return this.#seq;
  }

  /** The first event after `since` that `match` accepts. */
  #event<T extends WorkerToPage>(
    match: (m: WorkerToPage) => boolean,
    since: number = this.#seq,
  ): Promise<T> {
    const seen = this.#log.find((e) => e.seq > since && match(e.message));
    if (seen !== undefined) return Promise.resolve(seen.message as T);
    return new Promise((resolve) => {
      const listener = (m: WorkerToPage): void => {
        if (!match(m)) return;
        this.#listeners.delete(listener);
        resolve(m as T);
      };
      this.#listeners.add(listener);
    });
  }
}

/**
 * Whether the platform holds `session` pending and not yet bound to the
 * Activation that will serve it: it names no endpoint.
 */
function unbound(session: ServedSession): boolean {
  return (
    session.status.phase === "pending" && session.status.endpoint === undefined
  );
}

/**
 * The instant `timestamp` names, in milliseconds since the epoch, or
 * `undefined` for the zero instant or a timestamp that names none.
 */
function instant(timestamp: string): number | undefined {
  if (isZeroInstant(timestamp)) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * When the reads of an unbound session first read at `started` stop:
 * {@link READY_BY_GRACE_MS} after `readyBy`, the latest `readyBy` the
 * platform stated for it, and never before {@link BIND_WAIT_MS} has
 * passed, which is also the bound when the platform stated none.
 */
function boundBy(readyBy: number | undefined, started: number): number {
  const least = started + BIND_WAIT_MS;
  return readyBy === undefined
    ? least
    : Math.max(least, readyBy + READY_BY_GRACE_MS);
}

/**
 * The event service as the verified session trust names it, or
 * `undefined` when the trust names none: the connector then does not
 * listen.
 */
function eventService(trust: SessionTrust): EventService | undefined {
  const events = trust.computerEvents;
  return events === undefined
    ? undefined
    : { principal: events.serverId, roots: events.serverRoots };
}

/** `ms` as an RFC 3339 UTC timestamp to the second, as the reference contract writes one. */
function rfc3339Seconds(ms: number): string {
  return new Date(Math.floor(ms / 1_000) * 1_000)
    .toISOString()
    .replace(".000Z", "Z");
}

/**
 * A session's create that failed, or answered the session ended, while its
 * connection was being established: the open ends with `cause`, the
 * create's own failure.
 */
class CreateFailure extends Error {
  constructor(cause: unknown) {
    super("the session's create failed", { cause });
    this.name = "CreateFailure";
  }
}

/**
 * Whether a read failed only in passing, so the same read may succeed: no
 * answer arrived, the request timed out, or the platform answered HTTP 429
 * or a server error.
 */
function passing(error: unknown): boolean {
  if (error instanceof TransportError) {
    return error.code === "network_error" || error.code === "timeout";
  }
  return (
    error instanceof ApiError && (error.status === 429 || error.status >= 500)
  );
}

/** Whether the Worker's event `m` is about the dock `dock`. */
function onDock(m: WorkerToPage, dock: number): boolean {
  return "dock" in m && m.dock === dock;
}

function sameEndpoint(
  a: ComputerSessionEndpoint,
  b: ComputerSessionEndpoint,
): boolean {
  return (
    a.epoch === b.epoch &&
    a.placement.node === b.placement.node &&
    a.placement.hostPod === b.placement.hostPod &&
    a.placement.sequence === b.placement.sequence
  );
}

/**
 * A session that ended before it opened: its create answered it in a final
 * phase (`ended`, `failed`, or `cancelled`) without the endpoint its stream
 * opens on, so no endpoint served the session and nothing ran. A session whose
 * Computer was put to sleep before it started is answered `cancelled`. `phase`
 * and `reason` are what a caller branches on; the message is for people. The
 * open rejects with it when it waited for the create's answer, and a stream
 * already sent fails with it the moment the answer arrives.
 */
export class ComputerSessionEndedError extends Error {
  /** The session's ID, as answered by the create. */
  readonly session: ComputerSessionId;
  /** The final phase the session is in: `ended`, `failed` or `cancelled`. */
  readonly phase: EndedPhase;
  /**
   * The session's reason code, such as `ATTACH_TIMEOUT` or `WAKE_TIMEOUT`,
   * as the platform sent it; `undefined` when the session states none.
   */
  declare readonly reason?: string;

  /**
   * The message names the session when its ID is canonical, the phase when
   * it is final, and the reason when this SDK names it; no other text the
   * platform sent is echoed.
   *
   * @param options the session's ID, final phase and reason, as the create
   *   answered them
   */
  constructor(options: {
    readonly session: ComputerSessionId;
    readonly phase: EndedPhase;
    readonly reason?: string;
  }) {
    super(endedMessage(options));
    this.name = "ComputerSessionEndedError";
    this.session = options.session;
    this.phase = options.phase;
    if (options.reason !== undefined) this.reason = options.reason;
  }
}

/** The final phases a session ends in. */
type EndedPhase = "ended" | "failed" | "cancelled";

/** Whether `phase` is a final phase. */
function isEndedPhase(phase: string): phase is EndedPhase {
  return isComputerSessionPhaseTerminal(phase);
}

function endedMessage(options: {
  readonly session: string;
  readonly phase: string;
  readonly reason?: string;
}): string {
  const session = isComputerSessionId(options.session)
    ? `the Computer session ${options.session}`
    : "the Computer session";
  const phase = isEndedPhase(options.phase)
    ? options.phase
    : "in a final phase";
  const reason = options.reason ?? "";
  if (reason !== "" && knownReason(reason)) {
    return `${session} ended before it opened: ${phase} (${reason})`;
  }
  return `${session} ended before it opened: ${phase}`;
}

function knownReason(reason: string): boolean {
  try {
    validateComputerSessionReason(reason);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a session's output carries: the endpoint's frames, as read, and
 * `broken`, the last item of a stream that was lost and could not be
 * resumed.
 */
export type SessionOutput = EndpointFrame | { readonly type: "broken" };

/**
 * One session on a Computer connection.
 *
 * A `shell` or `exec` session survives the loss of its stream, as when its
 * connection or the dock under it ends: the stream is resumed from the
 * output already delivered, on a live connection, and `output` carries on
 * as if the stream had not been lost. Input sent while the stream was lost
 * may be lost with it. When output the Computer no longer held was lost
 * with the stream, `output` carries one `opened` frame with `dropped: true`
 * before the output that follows; its `cursor` counts the output bytes,
 * stdout and stderr in the order sent, after which that output resumes. A
 * stream that no resume reaches within one session lease, 180 seconds, of
 * the loss, or whose resume the Computer or IDYL refuses, ends with
 * `broken`.
 */
export interface ComputerSessionStream {
  /** The request ID the session's first open names. */
  readonly requestId: string;
  /** The endpoint's frames, in order; it closes after the stream ends. */
  readonly output: ReadableStream<SessionOutput>;
  /** The session's ID, once its create has answered. */
  readonly id: string | undefined;
  /**
   * Sends input to the process, in order.
   *
   * @param data the bytes to send to its standard input
   */
  write(data: Uint8Array): void;
  /**
   * Sets the terminal's size, 1 to 10000 cells each way.
   *
   * @param size the terminal's size in character cells
   * @throws TypeError `size` is outside those bounds; nothing is sent
   */
  resize(size: TerminalSize): void;
  /** Ends the input; the process sees end of file. */
  closeInput(): void;
  /**
   * Ends the session on purpose: a `shell` or `exec` session is sent its
   * `end`, so it ends on the Computer at once, and the stream is finished.
   */
  close(): void;
}

/**
 * The error codes an endpoint answers an open with only before it asks the
 * machine the Computer runs on to start the session: a session whose stream opens with one of them
 * never started, and its request ID is used once, so it never will.
 */
const UNSTARTED_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "unsupported",
  "busy",
  "not_granted",
]);

/** What a stream's reader is told: the bytes that arrived, and the end. */
interface LegReader {
  bytes(bytes: Uint8Array): void;
  ended(broken: boolean): void;
}

/**
 * One Worker stream of a session on a Computer connection. Bytes and the
 * end that arrive while no reader is set are held for the next reader.
 */
class Leg {
  /** The frames of this stream, which start with its first byte. */
  readonly frames = new FrameReader();
  readonly #write: (bytes: Uint8Array) => void;
  readonly #finish: () => void;
  #reader: LegReader | undefined;
  #held: Uint8Array[] = [];
  // How the stream ended, while no reader has been told.
  #ending: boolean | undefined;
  // The page finished the stream or the Worker ended it.
  #released = false;

  constructor(write: (bytes: Uint8Array) => void, finish: () => void) {
    this.#write = write;
    this.#finish = finish;
  }

  /** Sends bytes, unless the stream has ended. */
  send(bytes: Uint8Array): void {
    if (!this.#released) this.#write(bytes);
  }

  /** Finishes the Worker's stream once. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#finish();
  }

  /** Sets the reader, or unsets it, and gives it what was held. */
  read(reader: LegReader | undefined): void {
    this.#reader = reader;
    if (reader === undefined) return;
    const held = this.#held;
    this.#held = [];
    for (const bytes of held) {
      if (this.#reader !== reader) return;
      reader.bytes(bytes);
    }
    const ending = this.#ending;
    if (ending !== undefined && this.#reader === reader) {
      this.#ending = undefined;
      reader.ended(ending);
    }
  }

  /** Bytes of the stream arrived. */
  receive(bytes: Uint8Array): void {
    if (this.#reader === undefined) this.#held.push(bytes);
    else this.#reader.bytes(bytes);
  }

  /** The stream ended. */
  ended(broken: boolean): void {
    this.#released = true;
    if (this.#reader === undefined) this.#ending = broken;
    else this.#reader.ended(broken);
  }
}

/** A resumed stream: its stream, its `opened`, and the frames read after it. */
interface Resumed {
  readonly leg: Leg;
  readonly opened: OpenedFrame;
  readonly rest: readonly EndpointFrame[];
}

/**
 * One attempt to resume the session `session` from `cursor`, given up when
 * `signal` aborts or at `until`, in milliseconds since the epoch.
 */
type Resume = (
  session: ComputerSessionId,
  cursor: number,
  signal: AbortSignal,
  until: number,
) => Promise<Resumed>;

/** An error frame the endpoint answered an open with. */
class EndpointRefusal extends Error {
  readonly code: string;

  constructor(code: string) {
    super("the endpoint refused the session's open");
    this.name = "EndpointRefusal";
    this.code = code;
  }
}

/**
 * A create that answered a later Activation than the one the connection's
 * endpoint serves: the session's grant is installed at `endpoint`.
 */
class Superseded extends Error {
  readonly endpoint: ComputerSessionEndpoint;

  constructor(endpoint: ComputerSessionEndpoint) {
    super("the session's grant is at a later Activation");
    this.name = "Superseded";
    this.endpoint = endpoint;
  }
}

/**
 * Whether a failed resume will not succeed by trying again: the endpoint
 * refused it with any code but `not_granted`, whose grant is created again,
 * or IDYL refused it with a status other than 408, 429 or a server error.
 */
function resumeFinal(error: unknown): boolean {
  if (error instanceof EndpointRefusal) return error.code !== "not_granted";
  if (error instanceof ApiError) {
    return !(
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return false;
}

/**
 * The first frame of a reattach stream `leg`: resolves once it is an
 * `opened` answering mode `reattach`, and rejects with an
 * {@link EndpointRefusal} for an error frame, with a {@link Superseded} as
 * soon as `answer` names a later Activation than `epoch`, the one the
 * stream's endpoint serves, with the create's failure as soon as it fails,
 * with a `TimeoutError` `DOMException` at `deadline`, and with `signal`'s
 * reason when it aborts. A rejected stream is finished.
 */
function firstFrame(
  leg: Leg,
  answer: Promise<ComputerSessionEndpoint>,
  epoch: number,
  deadline: number,
  signal: AbortSignal,
): Promise<Resumed> {
  return new Promise<Resumed>((resolve, reject) => {
    let settled = false;
    const settle = (then: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      leg.read(undefined);
      then();
    };
    const fail = (error: unknown): void => {
      settle(() => {
        leg.release();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    };
    const timer = setTimeout(
      () => {
        fail(
          new DOMException(
            `the endpoint did not answer the session's open within ${String(OPEN_WAIT_MS)} ms`,
            "TimeoutError",
          ),
        );
      },
      Math.max(0, deadline - Date.now()),
    );
    const aborted = (): void => {
      fail(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    answer.then(
      (endpoint) => {
        if (endpoint.epoch > epoch) fail(new Superseded(endpoint));
      },
      (error: unknown) => {
        fail(error);
      },
    );
    leg.read({
      bytes: (bytes) => {
        let frames: EndpointFrame[];
        try {
          frames = leg.frames.push(bytes);
        } catch (error) {
          fail(error);
          return;
        }
        const [first, ...rest] = frames;
        if (first === undefined) return;
        if (first.type === "error") {
          fail(new EndpointRefusal(first.code));
          return;
        }
        if (first.type !== "opened") {
          fail(new FrameError("the session's first frame is not opened"));
          return;
        }
        try {
          validateOpenedFor(first, "reattach");
        } catch (cause) {
          fail(
            new FrameError(
              "the endpoint's opened does not answer the stream's mode",
              { cause },
            ),
          );
          return;
        }
        settle(() => {
          resolve({ leg, opened: first, rest });
        });
      },
      ended: () => {
        fail(
          new Error("the stream ended before the endpoint answered its open"),
        );
      },
    });
  });
}

/** Waits `ms`; resolves `false` at once when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const aborted = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** What a session stream is built from. */
interface SessionStreamParts {
  readonly requestId: string;
  /** The mode the stream's open names, which its `opened` must answer. */
  readonly mode: SessionMode;
  /** The stream the session opened on. */
  readonly leg: Leg;
  /** Whether the open asked for the save result, which follows exit. */
  readonly savesResult: boolean;
  /** Stops the session's renewals. */
  readonly forget: () => void;
  /**
   * Cancels the session by its ID, once, when the endpoint refused its open
   * before it started; it runs as soon as both the refusal and the create's
   * answer are in.
   */
  readonly abandon: (id: string) => void;
  /** Resumes a lost stream; absent for a session that cannot be resumed. */
  readonly resume?: Resume;
}

class SessionStream implements ComputerSessionStream {
  /** The request ID the session's first open names. */
  readonly requestId: string;
  /** The endpoint's frames, in order; it closes after the stream ends. */
  readonly output: ReadableStream<SessionOutput>;
  /** The mode the stream's open names, which its `opened` must answer. */
  readonly #mode: SessionMode;
  #id: string | undefined;
  readonly #forget: () => void;
  readonly #abandon: (id: string) => void;
  readonly #resume: Resume | undefined;
  readonly #savesResult: boolean;
  // The stream the session's frames arrive on; a resume replaces it.
  #leg: Leg;
  #controller!: ReadableStreamDefaultController<SessionOutput>;
  // The output is closed or errored.
  #done = false;
  // The page closed the session: it is no longer renewed.
  #closed = false;
  // Aborted when the page closes the session, which ends a resume.
  readonly #closing = new AbortController();
  // A frame of the stream arrived.
  #answered = false;
  // The endpoint refused the open before the session started.
  #unstarted = false;
  // The unstarted session was cancelled.
  #abandoned = false;
  // Ends the stream when the endpoint has not answered its open in time.
  #answerTimer: ReturnType<typeof setTimeout> | undefined;
  // The open was given up on: nothing the endpoint sends reaches the output.
  #gaveUp = false;
  // Called once the open is answered, given up on, or the stream ends.
  #settled: (() => void)[] = [];
  // The session the endpoint's first `opened` names, which a resume reopens.
  #session: string | undefined;
  // The output bytes delivered, stdout and stderr in the order sent.
  #cursor = 0;
  // The session has nothing more to send: its exit, and its save result
  // when the open asked for it.
  #finished = false;
  // The endpoint ended the stream with an error frame.
  #refused = false;
  // A lost stream is being resumed.
  #resuming = false;

  constructor(parts: SessionStreamParts) {
    this.requestId = parts.requestId;
    this.#mode = parts.mode;
    this.#leg = parts.leg;
    this.#savesResult = parts.savesResult;
    this.#forget = parts.forget;
    this.#abandon = parts.abandon;
    this.#resume = parts.resume;
    this.output = new ReadableStream<SessionOutput>({
      start: (controller) => {
        this.#controller = controller;
      },
      // A reader that cancels ends the output: nothing more may reach it.
      cancel: () => {
        this.#done = true;
      },
    });
  }

  /**
   * @internal Starts reading the stream the session opened on; the
   * session's handlers then see what it held.
   */
  begin(): void {
    this.#follow(this.#leg);
  }

  /** The session's ID, once its create has answered. */
  get id(): string | undefined {
    return this.#id;
  }

  /** Sends input. */
  write(data: Uint8Array): void {
    for (const frame of stdinFrames(data)) this.#leg.send(frame);
  }

  /** Sets the terminal's size. */
  resize(size: TerminalSize): void {
    validateTerminalSize(size);
    this.#leg.send(encodeFrame({ type: "resize", size }));
  }

  /** Ends the input; the process sees end of file. */
  closeInput(): void {
    this.#leg.send(encodeFrame({ type: "close_input" }));
  }

  /**
   * Ends the session on purpose: a session that survives the loss of its
   * stream is sent its `end`, its stream is finished, unless it has ended,
   * and the session is no longer renewed. A resume under way stops, and the
   * output closes.
   */
  close(): void {
    this.#stopAnswerTimer();
    this.#closed = true;
    this.#closing.abort();
    if (this.#resume !== undefined) {
      this.#leg.send(encodeFrame({ type: "end" }));
    }
    this.#leg.release();
    this.#forget();
    if (this.#resuming) {
      this.#resuming = false;
      this.#close();
    }
  }

  /** @internal Sends one encoded frame, unless the stream has ended. */
  sendFrame(frame: Uint8Array): void {
    this.#leg.send(frame);
  }

  /**
   * @internal Ends the stream unless a frame of it arrives by `deadline`,
   * in milliseconds since the epoch: the session is no longer renewed and
   * is cancelled once its create has answered, and the output fails with
   * what `late` resolves to, the session's ending when it is final and a
   * `TimeoutError` `DOMException` otherwise; the Worker's stream is then
   * finished.
   */
  answerBy(deadline: number, late: () => Promise<unknown>): void {
    if (this.#answered || this.#done) return;
    this.#answerTimer = setTimeout(
      () => {
        this.#answerTimer = undefined;
        if (this.#answered || this.#done) return;
        // Nothing waits for this session any more: it is no longer renewed,
        // and is cancelled once its create has answered.
        this.#gaveUp = true;
        this.#settle();
        this.#closed = true;
        this.#forget();
        this.#unstarted = true;
        this.#abandonUnstarted();
        void late().then((error) => {
          this.fail(error);
          this.#leg.release();
        });
      },
      Math.max(0, deadline - Date.now()),
    );
  }

  /** @internal Calls `settled` once the open is answered or ends. */
  onSettled(settled: () => void): void {
    if (this.#answered || this.#done || this.#gaveUp) settled();
    else this.#settled.push(settled);
  }

  /** Calls each settled callback once. */
  #settle(): void {
    const settled = this.#settled;
    this.#settled = [];
    for (const call of settled) call();
  }

  /** Stops the wait for the endpoint's first frame. */
  #stopAnswerTimer(): void {
    this.#settle();
    if (this.#answerTimer === undefined) return;
    clearTimeout(this.#answerTimer);
    this.#answerTimer = undefined;
  }

  /** @internal The session's create answered. */
  served(id: string): void {
    this.#id = id;
    // A session closed before its create answered is not renewed.
    if (this.#closed) this.#forget();
    this.#abandonUnstarted();
  }

  /**
   * Judges the stream's first frame: whether the session never started,
   * and that an `opened` answers the open's mode. Throws a `FrameError`
   * for an `opened` that does not.
   */
  #first(frame: SessionOutput): void {
    if (this.#answered) return;
    this.#answered = true;
    this.#stopAnswerTimer();
    if (frame.type === "opened") {
      try {
        validateOpenedFor(frame, this.#mode);
      } catch (cause) {
        // The session is no longer renewed, as a session closed on
        // purpose is not; its lease ends it.
        this.#closed = true;
        this.#forget();
        throw new FrameError(
          "the endpoint's opened does not answer the stream's mode",
          { cause },
        );
      }
      this.#session = frame.session;
    }
    if (frame.type === "error" && UNSTARTED_CODES.has(frame.code)) {
      this.#unstarted = true;
      this.#abandonUnstarted();
    }
  }

  /** Cancels a session that never started, once its ID is known. */
  #abandonUnstarted(): void {
    if (!this.#unstarted || this.#abandoned || this.#id === undefined) return;
    this.#abandoned = true;
    this.#abandon(this.#id);
  }

  /** @internal The session's create failed. */
  fail(error: unknown): void {
    this.#stopAnswerTimer();
    if (this.#done) return;
    this.#done = true;
    this.#resuming = false;
    this.#controller.error(error);
  }

  /** Reads `leg`'s bytes and end as the session's. */
  #follow(leg: Leg): void {
    leg.read({
      bytes: (bytes) => {
        this.#receive(leg, bytes);
      },
      ended: (broken) => {
        this.#ended(leg, broken);
      },
    });
  }

  /** Bytes of `leg` arrived. */
  #receive(leg: Leg, bytes: Uint8Array): void {
    if (leg !== this.#leg || this.#done || this.#gaveUp) return;
    try {
      for (const frame of leg.frames.push(bytes)) {
        this.#first(frame);
        this.#deliver(frame);
      }
    } catch (error) {
      if (error instanceof FrameError) {
        this.fail(error);
        leg.release();
        return;
      }
      throw error;
    }
  }

  /** Notes what `frame` says of the session, and passes it on. */
  #deliver(frame: EndpointFrame): void {
    switch (frame.type) {
      case "stdout":
      case "stderr":
        this.#cursor += frame.data.length;
        break;
      case "exit":
        this.#finished ||= !this.#savesResult;
        break;
      case "saved":
        this.#finished = true;
        break;
      case "error":
        this.#refused = true;
        break;
      default:
        break;
    }
    if (!this.#done) this.#controller.enqueue(frame);
  }

  /** `leg` ended. */
  #ended(leg: Leg, broken: boolean): void {
    if (leg !== this.#leg) return;
    this.#stopAnswerTimer();
    // An open given up on fails with its reason once the read settles.
    if (this.#done || this.#gaveUp) return;
    const session = this.#session;
    if (
      this.#resume !== undefined &&
      session !== undefined &&
      isComputerSessionId(session) &&
      !this.#finished &&
      !this.#refused &&
      !this.#closed
    ) {
      void this.#resumeFrom(this.#resume, session);
      return;
    }
    if (broken) this.#controller.enqueue({ type: "broken" });
    this.#close();
  }

  /**
   * Resumes the lost stream of `session` from the output delivered, trying
   * again after a pause of {@link REATTACH_BACKOFF_MS}, doubling up to
   * {@link REATTACH_BACKOFF_MAX_MS}, until one session lease has passed
   * since the loss or the resume is refused for good; the output then ends
   * with `broken`. Closing the session ends the resume.
   */
  async #resumeFrom(resume: Resume, session: ComputerSessionId): Promise<void> {
    this.#resuming = true;
    const signal = this.#closing.signal;
    const until = Date.now() + COMPUTER_SESSION_LEASE_MS;
    let backoff = REATTACH_BACKOFF_MS;
    for (;;) {
      let failure: unknown;
      try {
        const resumed = await resume(session, this.#cursor, signal, until);
        if (!this.#isResuming()) {
          // Closed or failed while the stream reopened.
          resumed.leg.send(encodeFrame({ type: "end" }));
          resumed.leg.release();
          return;
        }
        this.#adopt(resumed);
        return;
      } catch (error) {
        failure = error;
      }
      if (!this.#isResuming()) return;
      const wait = Math.min(backoff, until - Date.now());
      if (
        resumeFinal(failure) ||
        wait <= 0 ||
        !(await pause(wait, signal)) ||
        Date.now() >= until
      ) {
        break;
      }
      backoff = Math.min(2 * backoff, REATTACH_BACKOFF_MAX_MS);
    }
    if (!this.#isResuming()) return;
    this.#resuming = false;
    this.#controller.enqueue({ type: "broken" });
    this.#close();
  }

  /**
   * Whether the resume under way still is: closing or failing the session
   * ends it while an attempt is awaited.
   */
  #isResuming(): boolean {
    return this.#resuming;
  }

  /**
   * Takes the resumed stream in place of the lost one. When the endpoint
   * no longer held output that was lost, the output first carries the
   * resume's `opened`, with `dropped` set and the cursor the output
   * resumes after.
   */
  #adopt(resumed: Resumed): void {
    this.#resuming = false;
    this.#leg = resumed.leg;
    const { opened } = resumed;
    const cursor = opened.cursor;
    if (
      cursor !== undefined &&
      (opened.dropped === true || cursor > this.#cursor)
    ) {
      const at = Math.max(cursor, this.#cursor);
      this.#controller.enqueue({
        type: "opened",
        session: opened.session,
        cursor: at,
        dropped: true,
      });
      this.#cursor = at;
    }
    for (const frame of resumed.rest) this.#deliver(frame);
    this.#follow(resumed.leg);
  }

  /** Closes the output once. */
  #close(): void {
    if (this.#done) return;
    this.#done = true;
    this.#controller.close();
  }
}
