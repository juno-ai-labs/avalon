/**
 * A best-effort IndexedDB database with an epoch fence, shared by every
 * on-device cache the renderer keeps.
 *
 * Best-effort means a caller never sees the database fail: a browser in
 * private mode, a revoked quota, a corrupt file, or an implementation that
 * cannot open at all every resolve to the caller's fallback instead of an
 * error the person cannot act on. The composer keeps working when its drafts
 * cannot be saved, and a screen waits for its socket when its cache cannot be
 * read, and neither is told.
 *
 * The epoch is the answer to one race. A wipe runs after work is already in
 * flight: a debounced save, a coalesced mirror write, a file mid-fingerprint.
 * Each of those states the epoch its content was captured in, and a wipe
 * moves the epoch on, so whatever lands behind the wipe from before it is
 * dropped rather than restoring what the wipe removed.
 */
export interface IndexedDbStoreDefinition {
  name: string;
  version: number;
  /**
   * Creates or upgrades the object stores, inside the upgrade transaction.
   * Called with whatever version the database was found at, so it checks what
   * exists rather than assuming an empty database.
   */
  upgrade: (database: IDBDatabase, transaction: IDBTransaction) => void;
  /** Names the database in the errors its requests and transactions reject with. */
  label: string;
}

export interface IndexedDbStore {
  /** The epoch a write about to be scheduled should carry. */
  epoch(): number;
  /** A wipe moves the epoch on; any write captured before it is then dropped. */
  advanceEpoch(): void;
  /** Resolves a request, rejecting with the store's label when it fails. */
  awaitRequest<T>(request: IDBRequest<T>): Promise<T>;
  /**
   * Runs one transaction over the named stores and resolves the fallback when
   * the database is unavailable or the transaction fails. A readwrite
   * transaction is awaited to its commit; a read returns as soon as it has its
   * result.
   */
  withStores<T>(
    storeNames: string[],
    mode: IDBTransactionMode,
    run: (transaction: IDBTransaction) => Promise<T>,
    fallback: T,
  ): Promise<T>;
  /**
   * Test seam: drops the open connection so the next call reopens the
   * database, and resets the epoch so one file's wipe does not fence another's
   * writes. A live connection keeps its implementation's task queue running,
   * which a test that never touches the cache should not have to absorb.
   */
  close(): void;
}

export function createIndexedDbStore(definition: IndexedDbStoreDefinition): IndexedDbStore {
  const { name, version, upgrade, label } = definition;
  let databasePromise: Promise<IDBDatabase | null> | null = null;
  let epoch = 0;

  const openDatabase = (): Promise<IDBDatabase | null> => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise<IDBDatabase | null>((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(name, version);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        upgrade(request.result, request.transaction!);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return databasePromise;
  };

  const awaitRequest = <T,>(request: IDBRequest<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`The ${label} request failed.`));
  });

  const awaitTransaction = (transaction: IDBTransaction): Promise<void> => new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(`The ${label} transaction failed.`));
    transaction.onabort = () => reject(transaction.error ?? new Error(`The ${label} transaction was aborted.`));
  });

  return {
    epoch: () => epoch,
    advanceEpoch() {
      epoch += 1;
    },
    awaitRequest,
    async withStores(storeNames, mode, run, fallback) {
      const database = await openDatabase();
      if (!database) return fallback;
      try {
        const transaction = database.transaction(storeNames, mode);
        // Subscribed before the first request so a transaction that commits
        // promptly cannot settle before anyone is listening for it.
        const settled = awaitTransaction(transaction);
        // A read never awaits the commit, so keep its rejection from going unhandled.
        settled.catch(() => undefined);
        const result = await run(transaction);
        if (mode === 'readwrite') await settled;
        return result;
      } catch {
        return fallback;
      }
    },
    close() {
      const opening = databasePromise;
      databasePromise = null;
      epoch = 0;
      void opening?.then((database) => database?.close());
    },
  };
}
