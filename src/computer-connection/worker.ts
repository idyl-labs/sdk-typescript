// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The Computer connection Worker. It runs the WebAssembly connection: the
// client certificate's key (generated here, never exported), one dock per
// certificate over a WebSocket to the edge's browser listener, the lanes on
// it and the TLS connections to Computers' endpoints. It knows nothing of
// sessions: each session stream is a byte pipe the page frames.

import init, {
  WorkerClient,
  WorkerKey,
} from "../../wasm/pkg/computer_connection.js";
import type { PageToWorker, WorkerToPage } from "./messages.js";

/**
 * The scope a Worker runs in, as far as the connection uses it: a dedicated
 * Worker's global scope, `self`.
 */
export interface WorkerScope {
  /**
   * Sends a message to the page, as `postMessage` does in a Worker.
   *
   * @param message an event or reply of the connection's own protocol
   * @param transfer the buffers whose ownership passes to the page
   */
  postMessage(message: WorkerToPage, transfer?: Transferable[]): void;
  /**
   * Calls `listener` with each message the page sends, as
   * `addEventListener` does in a Worker.
   *
   * @param type always `message`
   * @param listener called with each message, in the order the page sent
   *   them
   */
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<PageToWorker>) => void,
  ): void;
}

/** The subprotocol of the edge's browser listener. */
const SUBPROTOCOL = "idyl-fallback.1";

interface Dock {
  readonly client: WorkerClient;
  readonly socket: WebSocket;
  // Streams the page has opened, to read after every turn.
  readonly streams: Map<number, Set<number>>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Serves the page's requests on `scope` until the Worker ends. Call it once,
 * from the Worker's module.
 */
export function serveComputerConnections(scope: WorkerScope): void {
  let key: WorkerKey | undefined;
  let nextDock = 1;
  const docks = new Map<number, Dock>();

  const post = (message: WorkerToPage, transfer: Transferable[] = []): void => {
    scope.postMessage(message, transfer);
  };

  /** Moves bytes and events after anything changed on a dock. */
  const turn = (id: number, dock: Dock): void => {
    const out = dock.client.takeOutput();
    if (out.length > 0 && dock.socket.readyState === WebSocket.OPEN) {
      dock.socket.send(out);
    }
    for (;;) {
      const event = dock.client.nextEvent() as
        Record<string, unknown> | undefined;
      if (event === undefined) break;
      forward(id, dock, event);
    }
    for (const [computer, streams] of dock.streams) {
      for (const stream of streams) {
        for (;;) {
          const read: unknown = dock.client.read(computer, stream);
          if (read === null) break;
          if (read instanceof Uint8Array) {
            post({ type: "data", dock: id, computer, stream, bytes: read }, [
              read.buffer,
            ]);
            continue;
          }
          streams.delete(stream);
          post({
            type: "stream-ended",
            dock: id,
            computer,
            stream,
            broken: read === "broken",
          });
          break;
        }
      }
    }
    // Reading may have granted credit: send what that produced.
    const more = dock.client.takeOutput();
    if (more.length > 0 && dock.socket.readyState === WebSocket.OPEN) {
      dock.socket.send(more);
    }
    schedule(id, dock);
  };

  const schedule = (id: number, dock: Dock): void => {
    if (dock.timer !== undefined) clearTimeout(dock.timer);
    dock.timer = undefined;
    const deadline = dock.client.nextDeadline();
    if (deadline === undefined) return;
    dock.timer = setTimeout(
      () => {
        dock.timer = undefined;
        dock.client.tick(Date.now());
        turn(id, dock);
      },
      Math.max(0, deadline - Date.now()),
    );
  };

  const forward = (
    id: number,
    dock: Dock,
    event: Record<string, unknown>,
  ): void => {
    const text = (value: unknown): string =>
      typeof value === "string" ? value : "";
    const num = (value: unknown): number =>
      typeof value === "number" ? value : 0;
    switch (event["type"]) {
      case "docked":
        post({ type: "docked", dock: id });
        return;
      case "drain":
        post({ type: "drain", dock: id, reason: text(event["reason"]) });
        return;
      case "edge-ended": {
        // The dock is forgotten here, so its socket's close does not report
        // it ended a second time.
        docks.delete(id);
        if (dock.timer !== undefined) clearTimeout(dock.timer);
        const retry = event["retryAfterMs"];
        post({
          type: "dock-ended",
          dock: id,
          reason: text(event["reason"]),
          ...(typeof retry === "number" ? { retryAfterMs: retry } : {}),
        });
        dock.socket.close(1000);
        return;
      }
      case "lane-ready":
        post({ type: "lane-ready", dock: id, lane: num(event["lane"]) });
        return;
      case "lane-ended":
        post({
          type: "lane-ended",
          dock: id,
          lane: num(event["lane"]),
          reason: text(event["reason"]),
        });
        return;
      case "computer-established":
        post({
          type: "computer-established",
          dock: id,
          computer: num(event["computer"]),
          epoch: String(event["epoch"]),
        });
        return;
      case "computer-ended": {
        const computer = num(event["computer"]);
        dock.streams.delete(computer);
        const refusal = event["refusal"];
        post({
          type: "computer-ended",
          dock: id,
          computer,
          reason: text(event["reason"]),
          ...(typeof refusal === "number" ? { refusal } : {}),
        });
        return;
      }
      default:
        return;
    }
  };

  const openDock = (
    request: Extract<PageToWorker, { type: "dock" }>,
  ): number => {
    if (key === undefined) throw new Error("the worker has not started");
    const client = new WorkerClient(
      key,
      request.serverName,
      request.edgeId,
      [...request.edgeRoots],
      [...request.chain],
      request.lease,
      request.keepaliveMs,
      Date.now(),
    );
    const socket = new WebSocket(request.url, SUBPROTOCOL);
    socket.binaryType = "arraybuffer";
    const id = nextDock++;
    const dock: Dock = { client, socket, streams: new Map(), timer: undefined };
    docks.set(id, dock);
    socket.addEventListener("open", () => {
      turn(id, dock);
    });
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!(event.data instanceof ArrayBuffer)) {
        socket.close(1003);
        return;
      }
      client.receive(new Uint8Array(event.data), Date.now());
      turn(id, dock);
    });
    socket.addEventListener("close", () => {
      if (dock.timer !== undefined) clearTimeout(dock.timer);
      if (docks.delete(id)) {
        post({ type: "dock-ended", dock: id, reason: "connection closed" });
      }
    });
    return id;
  };

  const docked = (id: number): Dock => {
    const dock = docks.get(id);
    if (dock === undefined) throw new Error("no such dock");
    return dock;
  };

  const handle = async (request: PageToWorker): Promise<unknown> => {
    switch (request.type) {
      case "start": {
        await init({ module_or_path: request.module });
        key = new WorkerKey();
        post({
          type: "key",
          certificateRequest: key.certificateRequest(),
          publicKey: key.publicKey(),
        });
        return undefined;
      }
      case "dock":
        return openDock(request);
      case "close-dock": {
        const dock = docked(request.dock);
        dock.client.close();
        turn(request.dock, dock);
        return undefined;
      }
      case "open-lane": {
        const dock = docked(request.dock);
        const lane = dock.client.openLane(request.principal);
        turn(request.dock, dock);
        return lane;
      }
      case "open-computer": {
        const dock = docked(request.dock);
        const computer = dock.client.openComputer(
          request.lane,
          request.hostPod,
          BigInt(request.sequence),
          BigInt(request.epoch),
          [...request.roots],
          [...request.chain],
          request.trustDomain,
          request.account,
          request.computer,
          BigInt(request.minEpoch),
        );
        dock.streams.set(computer, new Set());
        turn(request.dock, dock);
        return computer;
      }
      case "close-computer": {
        const dock = docked(request.dock);
        dock.client.closeComputer(request.computer);
        dock.streams.delete(request.computer);
        turn(request.dock, dock);
        return undefined;
      }
      case "open-stream": {
        const dock = docked(request.dock);
        const stream = dock.client.openStream(request.computer);
        dock.streams.get(request.computer)?.add(stream);
        return stream;
      }
      case "write": {
        const dock = docked(request.dock);
        dock.client.write(request.computer, request.stream, request.bytes);
        turn(request.dock, dock);
        return undefined;
      }
      case "finish": {
        const dock = docked(request.dock);
        dock.client.finish(request.computer, request.stream);
        turn(request.dock, dock);
        return undefined;
      }
      case "abort": {
        const dock = docked(request.dock);
        dock.client.abort(request.computer, request.stream);
        dock.streams.get(request.computer)?.delete(request.stream);
        turn(request.dock, dock);
        return undefined;
      }
    }
  };

  scope.addEventListener("message", (event) => {
    const request = event.data;
    handle(request).then(
      (value) => {
        post({ type: "reply", ref: request.ref, value });
      },
      (error: unknown) => {
        post({
          type: "reply",
          ref: request.ref,
          error: error instanceof Error ? error.message : "request failed",
        });
      },
    );
  });
}
