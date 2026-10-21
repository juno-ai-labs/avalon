import "../../../../../tests/isolated-region";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllLocalCache,
  clearWorkspaceLocalCache,
  closeLocalCache,
  defineLocalCacheSlice,
  localCacheEpoch,
  localCacheGeneration,
  localCacheScope,
} from './local-cache';

interface Note { text: string }

function parseNote(value: unknown): Note | null {
  return value !== null && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string'
    ? { text: (value as { text: string }).text }
    : null;
}

const notes = defineLocalCacheSlice<Note>({ kind: 'test-notes', version: 1, parse: parseNote });
const notesNextShape = defineLocalCacheSlice<Note>({ kind: 'test-notes', version: 2, parse: parseNote });
const strictNotes = defineLocalCacheSlice<Note>({ kind: 'test-notes', version: 1, parse: () => null });

const USER = '00000000-0000-7000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-7000-8000-0000000000bb';
const global1 = localCacheScope(USER, 'global', '00000000-0000-7000-8000-000000000001');
const eu1 = localCacheScope(USER, 'enterprise', '00000000-0000-7000-8000-000000000001');

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('local cache store', () => {
  beforeEach(() => clearAllLocalCache());
  afterEach(() => closeLocalCache());

  it('round-trips a value under its scope and key', async () => {
    await expect(notes.write(global1, 'a', { text: 'kept' })).resolves.toBe(true);

    expect(await notes.read(global1, 'a')).toEqual({ text: 'kept' });
    expect(await notes.read(eu1, 'a')).toBeNull();
  });

  it('refuses a queued write after another renderer wipes the workspace', async () => {
    const epoch = localCacheEpoch(global1);
    const generation = await localCacheGeneration(global1);
    vi.resetModules();
    const otherRenderer = await import('./local-cache');
    try {
      await otherRenderer.clearWorkspaceLocalCache(USER, 'global', '00000000-0000-7000-8000-000000000001');
      await expect(notes.write(global1, 'late', { text: 'before the other tab signed out' }, undefined, epoch, generation))
        .resolves.toBe(false);
      expect(await notes.read(global1, 'late')).toBeNull();
      const current = await localCacheGeneration(global1);
      await expect(notes.write(global1, 'current', { text: 'new session' }, undefined, epoch, current)).resolves.toBe(true);
      expect(await notes.read(global1, 'current')).toEqual({ text: 'new session' });
    } finally {
      otherRenderer.closeLocalCache();
    }
  });

  it('drops a row written under another version of the slice, and removes it', async () => {
    await notes.write(global1, 'a', { text: 'old shape' });

    expect(await notesNextShape.read(global1, 'a')).toBeNull();
    await settle();
    expect(await notes.read(global1, 'a')).toBeNull();
  });

  it('drops a row the slice will not vouch for, and removes it', async () => {
    await notes.write(global1, 'a', { text: 'rejected on read' });

    expect(await strictNotes.read(global1, 'a')).toBeNull();
    await settle();
    expect(await notes.read(global1, 'a')).toBeNull();
  });

  it('refuses a write captured before a wipe', async () => {
    const captured = localCacheEpoch();
    await clearAllLocalCache();

    await expect(notes.write(global1, 'a', { text: 'from before sign-out' }, undefined, captured)).resolves.toBe(false);
    expect(await notes.read(global1, 'a')).toBeNull();
    // A write captured after the wipe lands normally.
    await expect(notes.write(global1, 'a', { text: 'after' })).resolves.toBe(true);
    expect(await notes.read(global1, 'a')).toEqual({ text: 'after' });
  });

  it('clears one organization and leaves the others', async () => {
    await notes.write(global1, 'a', { text: 'global' });
    await notes.write(eu1, 'a', { text: 'enterprise' });

    await clearWorkspaceLocalCache(USER, 'global', '00000000-0000-7000-8000-000000000001');

    expect(await notes.read(global1, 'a')).toBeNull();
    expect(await notes.read(eu1, 'a')).toEqual({ text: 'enterprise' });
  });

  it('keeps two accounts\' rows for one organization apart, and clears only the leaving account\'s', async () => {
    const otherAccount = localCacheScope(OTHER_USER, 'global', '00000000-0000-7000-8000-000000000001');
    await notes.write(global1, 'a', { text: 'first account' });
    await notes.write(otherAccount, 'a', { text: 'second account' });

    expect(await notes.read(global1, 'a')).toEqual({ text: 'first account' });
    expect(await notes.read(otherAccount, 'a')).toEqual({ text: 'second account' });

    await clearWorkspaceLocalCache(USER, 'global', '00000000-0000-7000-8000-000000000001');

    expect(await notes.read(global1, 'a')).toBeNull();
    expect(await notes.read(otherAccount, 'a')).toEqual({ text: 'second account' });
  });

  it('keeps a guest\'s rows apart from what the same account cached as a member, and clears both on leaving', async () => {
    const guest1 = localCacheScope(USER, 'global', '00000000-0000-7000-8000-000000000001', 'guest');
    await notes.write(global1, 'a', { text: 'read as a member' });

    expect(await notes.read(guest1, 'a')).toBeNull();
    await notes.write(guest1, 'a', { text: 'read as a guest' });
    expect(await notes.read(global1, 'a')).toEqual({ text: 'read as a member' });

    await clearWorkspaceLocalCache(USER, 'global', '00000000-0000-7000-8000-000000000001');

    expect(await notes.read(global1, 'a')).toBeNull();
    expect(await notes.read(guest1, 'a')).toBeNull();
  });

  it('lists a scope and removes by subject and by key across scopes', async () => {
    await notes.write(global1, 'p:0', { text: 'main' }, 'p');
    await notes.write(global1, 'p:child', { text: 'child' }, 'p');
    await notes.write(global1, 'q:0', { text: 'other' }, 'q');
    await notes.write(eu1, 'p:0', { text: 'main in enterprise' }, 'p');

    expect((await notes.entries(global1)).map((entry) => `${entry.subject}/${entry.key}`).sort())
      .toEqual(['p/p:0', 'p/p:child', 'q/q:0']);

    await notes.removeSubject('p');
    expect((await notes.entries(global1)).map((entry) => entry.key)).toEqual(['q:0']);
    expect(await notes.read(eu1, 'p:0')).toBeNull();

    await notes.write(eu1, 'q:0', { text: 'other in enterprise' }, 'q');
    await notes.removeKey('q:0');
    expect(await notes.entries(global1)).toEqual([]);
    expect(await notes.entries(eu1)).toEqual([]);
  });

  it('lists one scope\'s rows about a subject through the index, and no other scope\'s', async () => {
    await notes.write(global1, 'p:0', { text: 'main' }, 'p');
    await notes.write(global1, 'p:child', { text: 'child' }, 'p');
    await notes.write(global1, 'q:0', { text: 'other' }, 'q');
    await notes.write(eu1, 'p:0', { text: 'main in enterprise' }, 'p');

    expect((await notes.entriesForSubject(global1, 'p')).map((entry) => entry.key).sort()).toEqual(['p:0', 'p:child']);
    expect((await notes.entriesForSubject(eu1, 'p')).map((entry) => entry.key)).toEqual(['p:0']);
    expect(await notes.entriesForSubject(global1, 'r')).toEqual([]);
  });

  it('removes one key without touching its neighbours', async () => {
    await notes.write(global1, 'a', { text: 'a' });
    await notes.write(global1, 'b', { text: 'b' });

    await notes.remove(global1, 'a');

    expect(await notes.read(global1, 'a')).toBeNull();
    expect(await notes.read(global1, 'b')).toEqual({ text: 'b' });
  });
});


it('upgrades inactive cached organizations and removes only structured meeting content', async () => {
  closeLocalCache();
  const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
  await request(indexedDB.deleteDatabase('rally-local-cache'));
  const opening = indexedDB.open('rally-local-cache', 1);
  opening.onupgradeneeded = () => {
    const entries = opening.result.createObjectStore('entries', { keyPath: ['scope', 'kind', 'key'] });
    entries.createIndex('kindSubject', ['kind', 'subject']);
    entries.createIndex('kindKey', ['kind', 'key']);
  };
  const database = await request(opening);
  const transaction = database.transaction('entries', 'readwrite');
  const complete = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  transaction.objectStore('entries').put({ scope: eu1, kind: 'directory', key: 'directory', subject: 'directory', version: 1,
    updatedAt: 1, value: { notes: [{ title: 'private meeting' }], workstreams: [{ title: 'keep' }] } });
  transaction.objectStore('entries').put({ scope: eu1, kind: 'conversation-test', key: 'conversation', subject: 'conversation', version: 1,
    updatedAt: 1, value: { text: 'ordinary conversation mentioning a meeting', attachments: [
      { provider: 'avalon_note', title: 'private transcript' }, { provider: 'granola', title: 'keep' },
    ] } });
  await complete;
  database.close();
  const directory = defineLocalCacheSlice({ kind: 'directory', version: 2, parse: value => value });
  const conversation = defineLocalCacheSlice({ kind: 'conversation-test', version: 1, parse: value => value });
  expect(await directory.read(eu1, 'directory')).toEqual({ workstreams: [{ title: 'keep' }] });
  expect(await conversation.read(eu1, 'conversation')).toEqual({ text: 'ordinary conversation mentioning a meeting',
    attachments: [{ provider: 'granola', title: 'keep' }] });
  closeLocalCache();
});
