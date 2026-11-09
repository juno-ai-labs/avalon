import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIndexedDbStore } from './indexeddb-store';

const STORE = 'rows';

/** The first event a deletion from another window answers with. */
function deleteFromAnotherWindow(name: string): Promise<'success' | 'blocked' | 'error'> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve('success');
    request.onblocked = () => resolve('blocked');
    request.onerror = () => resolve('error');
  });
}

/** A connection from another window that never yields to a version change. */
function openWithoutYielding(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function testStore(name: string, version = 1) {
  return createIndexedDbStore({
    name,
    version,
    label: 'test store',
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id' });
    },
  });
}

describe('createIndexedDbStore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs a transaction against the stores the definition created, and reads back across a close', async () => {
    const store = testStore('test-store-round-trip');

    await expect(store.withStores([STORE], 'readwrite', async (transaction) => {
      transaction.objectStore(STORE).put({ id: 'a', text: 'kept' });
      return true;
    }, false)).resolves.toBe(true);
    store.close();

    const row = await store.withStores([STORE], 'readonly', async (transaction) =>
      store.awaitRequest(transaction.objectStore(STORE).get('a')), null);
    expect(row).toEqual({ id: 'a', text: 'kept' });
  });

  it('resolves the fallback rather than throwing when there is no IndexedDB at all', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const store = testStore('test-store-absent');

    await expect(store.withStores([STORE], 'readonly', async () => 'read', 'fallback')).resolves.toBe('fallback');
  });

  it('resolves the fallback when the transaction fails, and moves the epoch on only when asked', async () => {
    const store = testStore('test-store-failing');

    // A store the database does not have: the transaction cannot be opened.
    await expect(store.withStores(['missing'], 'readonly', async () => 'read', 'fallback')).resolves.toBe('fallback');

    expect(store.epoch()).toBe(0);
    store.advanceEpoch();
    expect(store.epoch()).toBe(1);
    store.close();
    expect(store.epoch()).toBe(0);
  });

  it('yields its connection to another window deleting the database, then reopens it empty', async () => {
    const store = testStore('test-store-yields');
    await expect(store.withStores([STORE], 'readwrite', async (transaction) => {
      transaction.objectStore(STORE).put({ id: 'a', text: 'kept' });
      return true;
    }, false)).resolves.toBe(true);

    // Held open, the connection would block the deletion, and every later
    // open in any window would wait behind it with no event.
    await expect(deleteFromAnotherWindow('test-store-yields')).resolves.toBe('success');

    const row = await store.withStores([STORE], 'readonly', async (transaction) =>
      store.awaitRequest(transaction.objectStore(STORE).get('a')), 'fallback');
    expect(row).toBeUndefined();
    store.close();
  });

  it('answers the fallback while another window blocks its upgrade, then serves the database once that window lets go', async () => {
    const other = await openWithoutYielding('test-store-blocked');
    const store = testStore('test-store-blocked', 2);

    await expect(store.withStores([STORE], 'readonly', async () => 'read', 'fallback')).resolves.toBe('fallback');

    other.close();
    await vi.waitFor(async () => {
      await expect(store.withStores([STORE], 'readonly', async () => 'read', 'fallback')).resolves.toBe('read');
    });
    store.close();
  });
});
