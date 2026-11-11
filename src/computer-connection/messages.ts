// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The messages between a page and its Computer connection Worker. The
// Worker holds the client certificate's key, the docks and every TLS
// connection; the page holds the access credential and the session
// protocol. Byte payloads travel as transferred ArrayBuffers.

/** What the page asks of the Worker. Every request names a `ref` the page chose. */
export type PageToWorker =
  | {
      readonly type: "start";
      readonly ref: number;
      readonly module: WebAssembly.Module | ArrayBuffer;
    }
  | {
      readonly type: "dock";
      readonly ref: number;
      readonly url: string;
      readonly serverName: string;
      readonly edgeId: string;
      readonly edgeRoots: readonly Uint8Array[];
      readonly chain: readonly Uint8Array[];
      readonly lease: Uint8Array;
      readonly keepaliveMs: number;
    }
  | { readonly type: "close-dock"; readonly ref: number; readonly dock: number }
  | {
      readonly type: "open-lane";
      readonly ref: number;
      readonly dock: number;
      readonly principal: string;
    }
  | {
      readonly type: "open-computer";
      readonly ref: number;
      readonly dock: number;
      readonly lane: number;
      readonly hostPod: string;
      readonly sequence: string;
      readonly epoch: string;
      readonly roots: readonly Uint8Array[];
      readonly chain: readonly Uint8Array[];
      readonly trustDomain: string;
      readonly account: string;
      readonly computer: string;
      readonly minEpoch: string;
    }
  | {
      readonly type: "close-computer";
      readonly ref: number;
      readonly dock: number;
      readonly computer: number;
    }
  | {
      readonly type: "open-stream";
      readonly ref: number;
      readonly dock: number;
      readonly computer: number;
    }
  | {
      readonly type: "write";
      readonly ref: number;
      readonly dock: number;
      readonly computer: number;
      readonly stream: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: "finish";
      readonly ref: number;
      readonly dock: number;
      readonly computer: number;
      readonly stream: number;
    }
  | {
      readonly type: "abort";
      readonly ref: number;
      readonly dock: number;
      readonly computer: number;
      readonly stream: number;
    };

/** What the Worker tells the page. */
export type WorkerToPage =
  /** The answer to a request: its value, or why it failed. */
  | {
      readonly type: "reply";
      readonly ref: number;
      readonly value?: unknown;
      readonly error?: string;
    }
  /** The key exists: its certificate request (DER) and public key. */
  | {
      readonly type: "key";
      readonly certificateRequest: Uint8Array;
      readonly publicKey: Uint8Array;
    }
  | { readonly type: "docked"; readonly dock: number }
  | { readonly type: "drain"; readonly dock: number; readonly reason: string }
  | {
      readonly type: "dock-ended";
      readonly dock: number;
      readonly reason: string;
      readonly retryAfterMs?: number;
    }
  | {
      readonly type: "lane-ready";
      readonly dock: number;
      readonly lane: number;
    }
  | {
      readonly type: "lane-ended";
      readonly dock: number;
      readonly lane: number;
      readonly reason: string;
    }
  | {
      readonly type: "computer-established";
      readonly dock: number;
      readonly computer: number;
      readonly epoch: string;
    }
  | {
      readonly type: "computer-ended";
      readonly dock: number;
      readonly computer: number;
      readonly reason: string;
      readonly refusal?: number;
    }
  | {
      readonly type: "data";
      readonly dock: number;
      readonly computer: number;
      readonly stream: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: "stream-ended";
      readonly dock: number;
      readonly computer: number;
      readonly stream: number;
      readonly broken: boolean;
    };
