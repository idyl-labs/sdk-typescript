// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

// The highest session trust version a client has accepted, per Network and
// trust scope. A connector refuses a bundle older than it, so a validly
// signed but rolled-back bundle is never accepted again once a newer one
// has been.

import { SessionTrustError } from "./trust.js";

/** The sentence a floor refuses an older version with. */
export const TRUST_ROLLBACK =
  "session trust bundle is older than one already accepted";

/**
 * Where a client keeps the highest session trust version it has accepted
 * for each Network and trust scope. `scope` is the opaque name the client's
 * placement gives the sessions a bundle governs; a floor keeps it as given,
 * without interpretation.
 */
export interface TrustFloor {
  /**
   * Accepts `version` for `network` and `scope` as one atomic step: rejects
   * with a `SessionTrustError` when it is lower than the version kept, and
   * otherwise keeps it when it is higher; an equal version changes nothing.
   * Any other rejection means the floor could not be read or written, and a
   * connector refuses the bundle for that reason.
   *
   * @param network the Network the bundle names, as a domain
   * @param scope the trust scope the bundle governs, kept as given
   * @param version the bundle's version
   * @throws {@link SessionTrustError} `version` is lower than the version
   *   kept
   */
  accept(network: string, scope: string, version: number): Promise<void>;
}

/** The database a browser keeps its trust floors in. */
const DATABASE = "idyl-session-trust";
/** Its one store: one record per Network and trust scope. */
const STORE = "floors";

interface FloorRecord {
  readonly network: string;
  readonly scope: string;
  readonly version: number;
}

/**
 * A trust floor held in memory, for the life of the page or process that
 * holds it.
 */
export function memoryTrustFloor(): TrustFloor {
  const floors = new Map<string, number>();
  return {
    accept(network, scope, version) {
      const key = `${network}\n${scope}`;
      const kept = floors.get(key) ?? 0;
      if (version < kept) {
        return Promise.reject(new SessionTrustError(TRUST_ROLLBACK));
      }
      if (version > kept) floors.set(key, version);
      return Promise.resolve();
    },
  };
}

/**
 * A trust floor kept in IndexedDB, in database `idyl-session-trust`, store
 * `floors`, one record per Network and trust scope; each `accept` is one
 * readwrite transaction, so two pages accepting at once never lower each
 * other. The page's `memory` floor records every version the page accepts
 * as well, so the page never accepts below a version it has accepted,
 * whatever the database later holds.
 *
 * The database is opened when the floor is made, at whatever version it
 * has, so a page never locks out another that made it at a newer version,
 * and opened again when it is closed under the floor, as when site data is
 * cleared, or asked to make way for a newer version. An open that another
 * page blocks waits for it. A factory whose `open` throws before the page
 * has ever opened the database, as some private windows' does, leaves the
 * floor to `memory` for the life of the page; once the database has
 * opened, an `open` that throws rejects. Any other failure to open, read or
 * write rejects, and the next `accept` opens the database again. A stored
 * record that is not a whole, non-negative version rejects too: nothing is
 * assumed in its place.
 */
export function indexedDbTrustFloor(
  factory: IDBFactory,
  memory: TrustFloor,
): TrustFloor {
  let opened: Promise<IDBDatabase | undefined> | undefined;
  let everOpened = false;
  const database = (): Promise<IDBDatabase | undefined> => {
    if (opened === undefined) {
      const opening = openDatabase(factory, everOpened, () => {
        if (opened === opening) opened = undefined;
      });
      opened = opening;
      opening.then(
        (db) => {
          if (db !== undefined) everOpened = true;
        },
        () => {
          if (opened === opening) opened = undefined;
        },
      );
    }
    return opened;
  };
  void database().catch(() => undefined);
  return {
    async accept(network, scope, version) {
      await memory.accept(network, scope, version);
      for (let attempt = 0; ; attempt += 1) {
        const current = database();
        const db = await current;
        if (db === undefined) return;
        try {
          await acceptIn(db, network, scope, version);
          return;
        } catch (error) {
          // A database closed under the floor is opened again once, unless
          // a concurrent accept already opened it again.
          if (attempt > 0 || !closed(error)) throw error;
          if (opened === current) opened = undefined;
        }
      }
    },
  };
}

function closed(error: unknown): boolean {
  return error instanceof DOMException && error.name === "InvalidStateError";
}

/** Accepts `version` in one readwrite transaction of `db`. */
function acceptIn(
  db: IDBDatabase,
  network: string,
  scope: string,
  version: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let refusal: Error | undefined;
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get([network, scope]) as IDBRequest<unknown>;
    request.onsuccess = () => {
      const kept = keptVersion(request.result);
      if (kept === undefined) {
        refusal = new Error("trust floor record is malformed");
      } else if (version < kept) {
        refusal = new SessionTrustError(TRUST_ROLLBACK);
      } else if (version > kept) {
        store.put({ network, scope, version } satisfies FloorRecord);
      }
    };
    transaction.oncomplete = () => {
      if (refusal === undefined) resolve();
      else reject(refusal);
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("trust floor transaction failed"));
    };
    transaction.onabort = transaction.onerror;
  });
}

/**
 * The version a stored record keeps: 0 for none, and `undefined` for a
 * record that is not a whole, non-negative version.
 */
function keptVersion(record: unknown): number | undefined {
  if (record === undefined) return 0;
  const version =
    typeof record === "object" && record !== null
      ? (record as { version?: unknown }).version
      : undefined;
  return typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= 0
    ? version
    : undefined;
}

/**
 * Opens the database at whatever version it has, and, when it holds no
 * floor store, opens it once more at the next version to create it. Calls
 * `lost` when the opened database is closed or asked to make way for a
 * newer version. Resolves with `undefined` when `open` throws and the page
 * has never opened the database; rejects when it throws after, or when
 * the open fails. A blocked open keeps waiting.
 */
async function openDatabase(
  factory: IDBFactory,
  everOpened: boolean,
  lost: () => void,
): Promise<IDBDatabase | undefined> {
  const db = await openAt(factory, undefined, everOpened);
  if (db === undefined || db.objectStoreNames.contains(STORE)) {
    if (db !== undefined) watch(db, lost);
    return db;
  }
  const next = db.version + 1;
  db.close();
  const upgraded = await openAt(factory, next, true);
  if (upgraded !== undefined) watch(upgraded, lost);
  return upgraded;
}

function watch(db: IDBDatabase, lost: () => void): void {
  db.onversionchange = () => {
    db.close();
    lost();
  };
  db.onclose = lost;
}

/**
 * One `open` of the database, at `version` when one is given, creating the
 * floor store in an upgrade that lacks it.
 */
function openAt(
  factory: IDBFactory,
  version: number | undefined,
  strict: boolean,
): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request =
        version === undefined
          ? factory.open(DATABASE)
          : factory.open(DATABASE, version);
    } catch (error) {
      if (strict)
        reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(undefined);
      return;
    }
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: ["network", "scope"] });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error("trust floor database cannot open"));
    };
  });
}

/** The page's default floor, made by the first connector that needs it. */
let pageFloor: TrustFloor | undefined;

/**
 * The trust floor a connector uses when it is given none: one per page,
 * shared by every connector of the page, kept in IndexedDB where the
 * runtime offers it and in memory where it does not.
 */
export function defaultTrustFloor(): TrustFloor {
  if (pageFloor === undefined) {
    const memory = memoryTrustFloor();
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    pageFloor =
      factory === undefined ? memory : indexedDbTrustFloor(factory, memory);
  }
  return pageFloor;
}
