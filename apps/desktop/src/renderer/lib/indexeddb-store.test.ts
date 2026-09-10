import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIndexedDbStore } from './indexeddb-store';

const STORE = 'rows';

function testStore(name: string) {
  return createIndexedDbStore({
    name,
    version: 1,
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
});
