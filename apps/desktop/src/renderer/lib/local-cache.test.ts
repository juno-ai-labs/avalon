import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllLocalCache,
  clearWorkspaceLocalCache,
  closeLocalCache,
  defineLocalCacheSlice,
  localCacheEpoch,
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
const eu1 = localCacheScope(USER, 'eu', '00000000-0000-7000-8000-000000000001');

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

  it('clears one workspace and leaves the others', async () => {
    await notes.write(global1, 'a', { text: 'global' });
    await notes.write(eu1, 'a', { text: 'eu' });

    await clearWorkspaceLocalCache(USER, 'global', '00000000-0000-7000-8000-000000000001');

    expect(await notes.read(global1, 'a')).toBeNull();
    expect(await notes.read(eu1, 'a')).toEqual({ text: 'eu' });
  });

  it('keeps two accounts\' rows for one workspace apart, and clears only the leaving account\'s', async () => {
    const otherAccount = localCacheScope(OTHER_USER, 'global', '00000000-0000-7000-8000-000000000001');
    await notes.write(global1, 'a', { text: 'first account' });
    await notes.write(otherAccount, 'a', { text: 'second account' });

    expect(await notes.read(global1, 'a')).toEqual({ text: 'first account' });
    expect(await notes.read(otherAccount, 'a')).toEqual({ text: 'second account' });

    await clearWorkspaceLocalCache(USER, 'global', '00000000-0000-7000-8000-000000000001');

    expect(await notes.read(global1, 'a')).toBeNull();
    expect(await notes.read(otherAccount, 'a')).toEqual({ text: 'second account' });
  });

  it('lists a scope and removes by subject and by key across scopes', async () => {
    await notes.write(global1, 'p:0', { text: 'main' }, 'p');
    await notes.write(global1, 'p:child', { text: 'child' }, 'p');
    await notes.write(global1, 'q:0', { text: 'other' }, 'q');
    await notes.write(eu1, 'p:0', { text: 'main in eu' }, 'p');

    expect((await notes.entries(global1)).map((entry) => `${entry.subject}/${entry.key}`).sort())
      .toEqual(['p/p:0', 'p/p:child', 'q/q:0']);

    await notes.removeSubject('p');
    expect((await notes.entries(global1)).map((entry) => entry.key)).toEqual(['q:0']);
    expect(await notes.read(eu1, 'p:0')).toBeNull();

    await notes.write(eu1, 'q:0', { text: 'other in eu' }, 'q');
    await notes.removeKey('q:0');
    expect(await notes.entries(global1)).toEqual([]);
    expect(await notes.entries(eu1)).toEqual([]);
  });

  it('removes one key without touching its neighbours', async () => {
    await notes.write(global1, 'a', { text: 'a' });
    await notes.write(global1, 'b', { text: 'b' });

    await notes.remove(global1, 'a');

    expect(await notes.read(global1, 'a')).toBeNull();
    expect(await notes.read(global1, 'b')).toEqual({ text: 'b' });
  });
});
