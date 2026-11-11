// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/**
 * An IndexedDB in memory, as far as a trust floor uses it: opening a
 * database, creating a store with a key path, and transactions that read
 * and write records. Transactions of one database run one at a time, in
 * the order they were made, as readwrite transactions over one store do;
 * a transaction's requests answer asynchronously, in order, and it
 * completes once its last request has answered. A test can make `open`
 * throw, fail, or block; make every transaction fail; close a database
 * under its holder; or ask it to make way for a newer version.
 */

type Handler = (() => void) | null;

class FakeRequest {
  result: unknown;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeStore {
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly keyPath: readonly string[],
    private readonly transaction: FakeTransaction,
  ) {}

  get(key: readonly unknown[]): FakeRequest {
    return this.transaction.request(() =>
      structuredClone(this.records.get(JSON.stringify(key))),
    );
  }

  put(value: Record<string, unknown>): FakeRequest {
    const key = this.keyPath.map((name) => value[name]);
    return this.transaction.request(() => {
      this.records.set(JSON.stringify(key), structuredClone(value));
      return key;
    });
  }
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  readonly #operations: { request: FakeRequest; run: () => unknown }[] = [];
  #started = false;
  #done = false;

  constructor(
    private readonly database: FakeDatabase,
    private readonly fail: boolean,
    private readonly finished: () => void,
  ) {}

  objectStore(name: string): FakeStore {
    const store = this.database.stores.get(name);
    if (store === undefined)
      throw new DOMException("no store", "NotFoundError");
    return new FakeStore(store.records, store.keyPath, this);
  }

  request(run: () => unknown): FakeRequest {
    const request = new FakeRequest();
    this.#operations.push({ request, run });
    return request;
  }

  /** Runs the transaction's requests, then completes it. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#next();
  }

  #next(): void {
    queueMicrotask(() => {
      if (this.#done) return;
      const operation = this.#operations.shift();
      if (operation === undefined) {
        this.#done = true;
        this.oncomplete?.();
        this.finished();
        return;
      }
      if (this.fail) {
        this.#done = true;
        const error = new DOMException(
          "the disk is full",
          "QuotaExceededError",
        );
        operation.request.error = error;
        operation.request.onerror?.();
        this.error = error;
        this.onerror?.();
        this.finished();
        return;
      }
      operation.request.result = operation.run();
      operation.request.onsuccess?.();
      this.#next();
    });
  }
}

class FakeDatabase {
  readonly stores = new Map<
    string,
    { readonly records: Map<string, unknown>; readonly keyPath: string[] }
  >();
  /** The database's version; 0 until its first upgrade. */
  version = 0;
  readonly #queue: FakeTransaction[] = [];
  #running = false;

  constructor(private readonly owner: FakeIndexedDb) {}

  createObjectStore(name: string, options: { keyPath: string[] }): void {
    this.stores.set(name, { records: new Map(), keyPath: options.keyPath });
  }

  /** A connection to this database, as one `open` hands back. */
  connect(): FakeConnection {
    const connection = new FakeConnection(this);
    this.owner.connections.push(connection);
    return connection;
  }

  /** Queues a transaction; it starts once every earlier one has finished. */
  enqueue(): FakeTransaction {
    const transaction = new FakeTransaction(
      this,
      this.owner.failTransactions,
      () => {
        this.#running = false;
        this.#pump();
      },
    );
    this.#queue.push(transaction);
    queueMicrotask(() => {
      this.#pump();
    });
    return transaction;
  }

  #pump(): void {
    if (this.#running) return;
    const transaction = this.#queue.shift();
    if (transaction === undefined) return;
    this.#running = true;
    transaction.start();
  }
}

/** One open connection to a database. */
class FakeConnection {
  onversionchange: Handler = null;
  onclose: Handler = null;
  closed = false;

  constructor(readonly database: FakeDatabase) {}

  get version(): number {
    return this.database.version;
  }

  get objectStoreNames(): { contains(name: string): boolean } {
    return { contains: (name) => this.database.stores.has(name) };
  }

  createObjectStore(name: string, options: { keyPath: string[] }): void {
    this.database.createObjectStore(name, options);
  }

  transaction(): FakeTransaction {
    if (this.closed) {
      throw new DOMException("the database is closed", "InvalidStateError");
    }
    return this.database.enqueue();
  }

  close(): void {
    this.closed = true;
  }
}

class FakeOpenRequest extends FakeRequest {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

/** The fake IndexedDB: its databases by name and the failures it injects. */
export class FakeIndexedDb {
  readonly databases = new Map<string, FakeDatabase>();
  /** Every connection ever opened, in order. */
  readonly connections: FakeConnection[] = [];
  /** How many times `open` was called. */
  opens = 0;
  /** `open` throws, as in a window that offers no storage. */
  throwOnOpen = false;
  /** `open` fails with an error event. */
  failOpen = false;
  /** `open` is blocked until {@link FakeIndexedDb.unblock}. */
  blockOpen = false;
  /** Every transaction fails. */
  failTransactions = false;
  readonly #blocked: (() => void)[] = [];

  /** This fake as the factory a trust floor takes. */
  get factory(): IDBFactory {
    return {
      open: (name: string, version?: number) => this.#open(name, version),
    } as unknown as IDBFactory;
  }

  /** Makes a database at `version` with no store, as a newer client might. */
  create(name: string, version: number): void {
    const database = new FakeDatabase(this);
    database.version = version;
    this.databases.set(name, database);
  }

  /** Lets every blocked open proceed. */
  unblock(): void {
    this.blockOpen = false;
    for (const proceed of this.#blocked.splice(0)) proceed();
  }

  /** Closes every open connection under its holder, as clearing site data does. */
  closeAll(): void {
    for (const connection of this.connections) {
      if (connection.closed) continue;
      connection.closed = true;
      connection.onclose?.();
    }
  }

  /** Asks every open connection to make way for a newer version. */
  versionChange(): void {
    for (const connection of this.connections) {
      if (!connection.closed) connection.onversionchange?.();
    }
  }

  #open(name: string, version: number | undefined): FakeOpenRequest {
    this.opens += 1;
    if (this.throwOnOpen) {
      throw new DOMException("no storage", "SecurityError");
    }
    const request = new FakeOpenRequest();
    const proceed = (): void => {
      queueMicrotask(() => {
        if (this.failOpen) {
          request.error = new DOMException("no storage", "UnknownError");
          request.onerror?.();
          return;
        }
        let database = this.databases.get(name);
        database ??= new FakeDatabase(this);
        this.databases.set(name, database);
        const wanted = version ?? Math.max(database.version, 1);
        if (wanted < database.version) {
          request.error = new DOMException("older version", "VersionError");
          request.onerror?.();
          return;
        }
        const upgrade = wanted > database.version;
        database.version = wanted;
        request.result = database.connect();
        if (upgrade) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
    };
    if (this.blockOpen) {
      queueMicrotask(() => request.onblocked?.());
      this.#blocked.push(proceed);
    } else {
      proceed();
    }
    return request;
  }
}
