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
  parseComputerNotebookId,
  type ComputerSessionId,
} from "../resource/uuid-id.js";
import { pollUntil } from "../wait.js";
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
  /** The renewal interval of open sessions, in milliseconds. */
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
   * What the stream runs: `shell`, an interactive shell on a terminal;
   * `exec`, one command; `cell`, a script as a notebook's next cell; or
   * `records`, the recorded cells of a notebook and their output.
   */
  readonly mode: "shell" | "exec" | "cell" | "records";
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
  /** A `cell` session's script: 1 byte to 32 KiB, without NUL. */
  readonly script?: string;
  /**
   * Whether the session runs on a terminal. A `shell` session always does
   * and a `cell` or `records` stream never does; `false` when absent.
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
  /** The notebook a cell runs in or a records stream reads, by name. */
  readonly notebook?: string;
  /** The notebook's ID, which a records stream names. */
  readonly notebookId?: string;
  /**
   * Where a `records` stream resumes: it reads the records after the one
   * of this `order`, a non-negative integer. Absent reads from the first.
   */
  readonly after?: number;
}

/** What any session stream the connector opens runs. */
type StreamOpen = Omit<SessionOpen, "mode"> & {
  readonly mode: SessionOpen["mode"] | "files";
};

/** The most arguments an exec's command holds. */
const MAX_COMMAND_ARGS = 1024;
/** The most bytes an exec's command or a cell's script holds. */
const MAX_COMMAND_BYTES = 32 << 10;

/** The largest terminal dimension, in character cells. */
const MAX_TERMINAL_DIMENSION = 10_000;

/**
 * Judges an open's stream before its create or its stream is sent, as the
 * endpoint judges its open frame: a terminal states its size, 1 to 10000
 * cells each way, and a type and locale
 * `validateWorkloadSessionTerminalProfile` admits, and only a terminal
 * does; a shell runs on a terminal, names no
 * command or script, and names its shell, when it does, by a clean
 * absolute path; an exec names its command alone, 1 to 1024 arguments of
 * at most 32 KiB together, the first naming its program; a cell runs a
 * script of 1 byte to 32 KiB without a terminal; and a records stream
 * names its notebook's ID and, when it resumes, a non-negative `after`. An
 * `ssh` stream is refused: it carries raw bytes after `opened` and opens
 * with OpenSSH. Throws a `TypeError`.
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
  const script = open.script ?? "";
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
  if (
    open.mode !== "records" &&
    (open.notebookId !== undefined || open.after !== undefined)
  ) {
    throw new TypeError("only a records stream names a notebook");
  }
  switch (open.mode) {
    case "shell":
      if (!tty || command.length > 0 || script !== "") {
        throw new TypeError(
          "a shell session runs on a terminal and names no command or script",
        );
      }
      if (shell !== "" && !isCleanAbsolutePath(shell)) {
        throw new TypeError(
          `shell ${JSON.stringify(shell)} is not a clean absolute path`,
        );
      }
      break;
    case "exec":
      if (shell !== "" || script !== "") {
        throw new TypeError("an exec names its command alone");
      }
      validateCommand(command);
      break;
    case "cell":
      if (tty || shell !== "" || command.length > 0) {
        throw new TypeError(
          "a cell runs its script without a terminal and names nothing else",
        );
      }
      if (
        script === "" ||
        utf8.encode(script).length > MAX_COMMAND_BYTES ||
        script.includes("\0")
      ) {
        throw new TypeError(
          `a cell's script must be 1 to ${String(MAX_COMMAND_BYTES)} bytes without NUL`,
        );
      }
      break;
    case "records":
      if (tty || shell !== "" || command.length > 0 || script !== "") {
        throw new TypeError("a records stream names its notebook alone");
      }
      parseComputerNotebookId(open.notebookId ?? "");
      if (open.after !== undefined) {
        if (!Number.isSafeInteger(open.after)) {
          throw new TypeError("after must be an integer");
        }
        if (open.after < 0) {
          throw new TypeError("after must not be negative");
        }
      }
      break;
    case "files":
      if (tty || shell !== "" || command.length > 0 || script !== "") {
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
 * The features an open asks for, by mode: an exec asks for its save result
 * after exit. The endpoint refuses a feature its mode does not take: a shell
 * takes no save result, and a cell, a records stream or a files stream
 * takes no feature.
 */
function featuresFor(mode: StreamOpen["mode"]): readonly SessionFeature[] {
  return mode === "exec" ? ["save-result"] : [];
}
const RENEW_EVERY_MS = 60_000;
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
/**
 * The first pause before a read of an unbound session, and the longest:
 * each pause doubles up to it. Milliseconds.
 */
const BIND_BACKOFF_MS = 100;
const BIND_BACKOFF_MAX_MS = 1_000;

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
}

interface Connection {
  readonly handle: number;
  readonly dock: number;
  readonly node: string;
  readonly established: Promise<number>;
  readonly streams: Map<number, SessionStream>;
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
   * stream's `output`. An `opened` that does not answer the open's mode,
   * as one carrying an SSH host key does for any mode but `ssh`, errors the
   * output with a `FrameError`, finishes the stream, and stops the
   * session's renewals, leaving it to its lease. An `ssh` session's stream carries raw SSH bytes
   * after `opened`, not frames, so the connector never opens one: OpenSSH
   * does. An open of mode `ssh` or `reattach` rejects with a `TypeError`
   * before anything is sent, so it neither wakes the Computer nor reaches
   * it.
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
   * awake: the returned promise rejects with it, or, when the stream was
   * opened before the refusal arrived, the session ends `failed` with it.
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
  /** Ends every connection. */
  close(): void;
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
  // The dock in use. It is dropped when the dock ends or fails to dock, so
  // the next session docks again.
  #ready: Promise<Docked> | undefined;
  // The edge's earliest time to dock again, from the last dock's end.
  #notBeforeMs = 0;
  #renewer: ReturnType<typeof setInterval> | undefined;
  // Aborted by close, which ends every read of an unbound session.
  #closing = new AbortController();

  constructor(options: ComputerConnectorOptions) {
    this.#o = options;
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
    return this.#state().then(() => undefined);
  }

  #state(): Promise<Docked> {
    if (this.#ready === undefined) {
      const ready = this.#dock();
      this.#ready = ready;
      ready.catch(() => {
        if (this.#ready === ready) this.#ready = undefined;
      });
    }
    return this.#ready;
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
      ...(open.notebook === undefined ? {} : { notebook: open.notebook }),
    };
    validateCreateComputerSessionRequest(request);
    await this.ready();
    const created = this.#o.api.createSession(computer, request);
    // A pending answer bound to its Activation carries its endpoint as a
    // ready one does; the endpoint holds the stream until the grant is
    // installed, so either is connected to at once. Only a pending answer
    // without its endpoint is read again, until the session is bound.
    const placed = (session: ServedSession): ComputerSessionEndpoint => {
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
      this.#track(computer, session.id);
      return endpoint;
    };
    const answered = created.then((session) =>
      unbound(session)
        ? this.#bound(computer, session).then(placed)
        : placed(session),
    );
    answered.catch(() => undefined);
    // The client connects where it last saw the Computer; with no place
    // known it waits for the create. The endpoint's certificate must name
    // an Activation epoch at least the one known, so a command never
    // reaches an earlier Activation.
    const known =
      this.#known.get(computer) ?? this.#recall(computer) ?? (await answered);
    let connection: Connection;
    try {
      connection = await this.#connection(computer, known);
      await connection.established;
    } catch (first) {
      // The place the client knew is stale: the create says where it is.
      const endpoint = await answered;
      if (sameEndpoint(endpoint, known)) throw first;
      connection = await this.#connection(computer, endpoint, true);
      await connection.established;
    }
    const session = await this.#stream(computer, connection, requestID, open);
    created.then(
      (served) => {
        session.served(served.id, served.status.cell);
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
   * Reads `session`, which its create answered pending without its
   * endpoint, until it is bound or in another phase, and resolves to it
   * then. The platform holds a session unbound while the Computer's
   * previous Activation is released, as after the Computer went to sleep,
   * and while the Computer's wake runs, as while its files are fetched; it
   * fails a session still pending at the session's `readyBy`, which moves
   * forward while the wake makes progress. The reads therefore go on until
   * the latest `readyBy` read has passed by {@link READY_BY_GRACE_MS}, and
   * never end before {@link BIND_WAIT_MS}, which is also the bound when no
   * answer states a `readyBy`. They pause from {@link BIND_BACKOFF_MS},
   * doubling to {@link BIND_BACKOFF_MAX_MS}; a read that meets a network
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
    for (;;) {
      try {
        await pollUntil<ServedSession>(
          {
            timeoutMs: Math.max(0, until - Date.now()),
            signal: this.#closing.signal,
          },
          {
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
            delay: (attempt) =>
              Math.max(
                0,
                Math.min(
                  BIND_BACKOFF_MS * 2 ** attempt,
                  BIND_BACKOFF_MAX_MS,
                  until - Date.now(),
                ),
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

  /** Ends every connection and the dock. */
  close(): void {
    if (this.#renewer !== undefined) clearInterval(this.#renewer);
    this.#closing.abort();
    this.#closing = new AbortController();
    void this.#ready?.then(({ dock }) =>
      this.#request({ type: "close-dock", dock }),
    );
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
    const ending = (m: WorkerToPage): void => {
      if (m.type !== "dock-ended" || m.dock !== dock) return;
      this.#listeners.delete(ending);
      this.#ended(m);
    };
    this.#listeners.add(ending);
    this.#renewer ??= setInterval(() => {
      this.#renew();
    }, this.#o.renewEveryMs ?? RENEW_EVERY_MS);
    return { dock, trust: verified, chain: certificate.chain };
  }

  /**
   * Forgets a dock that ended, its lanes and its Computer connections, and
   * ends their streams as broken: the Worker no longer holds any of them.
   * The next session docks again, no earlier than the edge asked.
   */
  #ended(m: Extract<WorkerToPage, { type: "dock-ended" }>): void {
    if (m.retryAfterMs !== undefined) {
      this.#notBeforeMs = Date.now() + m.retryAfterMs;
    }
    const ready = this.#ready;
    void ready?.then(
      ({ dock }) => {
        if (dock === m.dock && this.#ready === ready) this.#ready = undefined;
      },
      () => undefined,
    );
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
   * on the way, such as a cell's exit and save result, is not cut off. A
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

  async #lane(node: string): Promise<number> {
    const { dock, trust } = await this.#state();
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
      const { dock, trust, chain } = await this.#state();
      const lane = await this.#lane(at.placement.node);
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
      const streams = new Map<number, SessionStream>();
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
    const { dock } = await this.#state();
    const stream = (await this.#request({
      type: "open-stream",
      dock,
      computer: connection.handle,
    })) as number;
    const send = (bytes: Uint8Array): void => {
      void this.#request(
        { type: "write", dock, computer: connection.handle, stream, bytes },
        [bytes.buffer],
      ).catch(() => undefined);
    };
    const session = new SessionStream(
      requestID,
      open.mode,
      send,
      () => {
        void this.#request({
          type: "finish",
          dock,
          computer: connection.handle,
          stream,
        }).catch(() => undefined);
      },
      () => {
        this.#sessions.get(computer)?.delete(session.id ?? "");
      },
      (id) => {
        // A cancel that fails leaves the session to its attach
        // deadline; the stream's error is what the caller acts on.
        this.#sessions.get(computer)?.delete(id);
        void this.#o.api.cancelSession(computer, id).catch(() => undefined);
      },
    );
    connection.streams.set(stream, session);
    const frame: OpenFrame = {
      requestID,
      mode: open.mode,
      tty: open.tty ?? false,
      features: featuresFor(open.mode),
      ...(open.shell === undefined ? {} : { shell: open.shell }),
      ...(open.command === undefined ? {} : { command: open.command }),
      ...(open.script === undefined ? {} : { script: open.script }),
      ...(open.size === undefined ? {} : { size: open.size }),
      ...(open.term === undefined ? {} : { term: open.term }),
      ...(open.locale === undefined ? {} : { locale: open.locale }),
      ...(open.notebookId === undefined || open.mode !== "records"
        ? {}
        : { notebook: open.notebookId }),
      ...(open.after === undefined ? {} : { after: open.after }),
    };
    send(encodeFrame({ type: "open", ...frame }));
    return session;
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

/** `ms` as an RFC 3339 UTC timestamp to the second, as the reference contract writes one. */
function rfc3339Seconds(ms: number): string {
  return new Date(Math.floor(ms / 1_000) * 1_000)
    .toISOString()
    .replace(".000Z", "Z");
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
 * opens on, so no endpoint served it and nothing ran in it. A session whose
 * Computer was put to sleep before it started is answered `cancelled`.
 * `phase` and `reason` are what a caller branches on; the message is for
 * people. The open rejects with it when it waited for the create's answer,
 * and a stream already sent fails with it the moment the answer arrives.
 */
export class ComputerSessionEndedError extends Error {
  /** The session's ID, as the create answered it. */
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

/** What a session's output carries: the endpoint's frames, as read. */
export type SessionOutput = EndpointFrame | { readonly type: "broken" };

/** One session on a Computer connection. */
export interface ComputerSessionStream {
  /** The request ID the session's grant and stream name. */
  readonly requestId: string;
  /** The endpoint's frames, in order; it closes after the stream ends. */
  readonly output: ReadableStream<SessionOutput>;
  /** The session's ID, once its create has answered. */
  readonly id: string | undefined;
  /** The notebook cell a cell session records, once its create has answered. */
  readonly cell: string | undefined;
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
  /** Ends the session on purpose. */
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

class SessionStream implements ComputerSessionStream {
  /** The request ID the session's grant and stream name. */
  readonly requestId: string;
  /** The endpoint's frames, in order; it closes after the stream ends. */
  readonly output: ReadableStream<SessionOutput>;
  /** The mode the stream's open names, which its `opened` must answer. */
  readonly #mode: SessionMode;
  #id: string | undefined;
  #cell: string | undefined;
  readonly #send: (bytes: Uint8Array) => void;
  readonly #finish: () => void;
  readonly #forget: () => void;
  readonly #abandon: (id: string) => void;
  readonly #reader = new FrameReader();
  #controller!: ReadableStreamDefaultController<SessionOutput>;
  // The output is closed or errored.
  #done = false;
  // The Worker's stream is finished by the page or ended by the Worker.
  #released = false;
  // The page closed the session: it is no longer renewed.
  #closed = false;
  // A frame of the stream arrived.
  #answered = false;
  // The endpoint refused the open before the session started.
  #unstarted = false;
  // The unstarted session was cancelled.
  #abandoned = false;

  /**
   * `abandon` cancels the session by its ID, once, when the endpoint
   * refused its open before it started; it runs as soon as both the
   * refusal and the create's answer are in.
   */
  constructor(
    requestId: string,
    mode: SessionMode,
    send: (bytes: Uint8Array) => void,
    finish: () => void,
    forget: () => void,
    abandon: (id: string) => void,
  ) {
    this.requestId = requestId;
    this.#mode = mode;
    this.#send = send;
    this.#finish = finish;
    this.#forget = forget;
    this.#abandon = abandon;
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

  /** The session's ID, once its create has answered. */
  get id(): string | undefined {
    return this.#id;
  }

  /** Sends input. */
  write(data: Uint8Array): void {
    for (const frame of stdinFrames(data)) this.#send(frame);
  }

  /** Sets the terminal's size. */
  resize(size: TerminalSize): void {
    validateTerminalSize(size);
    this.#send(encodeFrame({ type: "resize", size }));
  }

  /** Ends the input; the process sees end of file. */
  closeInput(): void {
    this.#send(encodeFrame({ type: "close_input" }));
  }

  /**
   * Ends the session on purpose: its stream is finished, unless it has
   * ended, and the session is no longer renewed.
   */
  close(): void {
    this.#closed = true;
    this.#release();
    this.#forget();
  }

  /** @internal Sends one encoded frame, unless the stream has ended. */
  sendFrame(frame: Uint8Array): void {
    if (!this.#released) this.#send(frame);
  }

  /** Finishes the Worker's stream once. */
  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#finish();
  }

  /** The notebook cell a cell session records, once its create has answered. */
  get cell(): string | undefined {
    return this.#cell;
  }

  /** @internal The session's create answered. */
  served(id: string, cell: string | undefined): void {
    this.#id = id;
    this.#cell = cell;
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
    if (this.#done) return;
    this.#done = true;
    this.#controller.error(error);
  }

  /** @internal Bytes of the stream arrived. */
  receive(bytes: Uint8Array): void {
    if (this.#done) return;
    try {
      for (const frame of this.#reader.push(bytes)) {
        this.#first(frame);
        this.#controller.enqueue(frame);
      }
    } catch (error) {
      if (error instanceof FrameError) {
        this.fail(error);
        this.#release();
        return;
      }
      throw error;
    }
  }

  /** @internal The stream ended. */
  ended(broken: boolean): void {
    this.#released = true;
    if (this.#done) return;
    this.#done = true;
    if (broken) this.#controller.enqueue({ type: "broken" });
    this.#controller.close();
  }
}
