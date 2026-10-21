import { desktopWorkspaceIdentityKey, type RallyRegion } from '../../common/desktop';
import { createIndexedDbStore } from './indexeddb-store';

/**
 * The on-device cache behind an immediate open.
 *
 * One IndexedDB database in the renderer's origin holds every slice — the
 * workspace directory, each conversation's last canonical state, whatever the
 * next surface adds — as rows keyed by `[scope, kind, key]`. A *scope* is a
 * regional workspace, so leaving one removes exactly its rows; a *kind* names
 * the slice that owns the row's shape; the *key* is the slice's own identity for
 * it. Nothing in here is authoritative: a row is what the socket last said, kept
 * so the next open paints before the socket says it again.
 *
 * The store is best-effort by construction, like the draft cache beside it:
 * every operation resolves to its fallback rather than throwing, so a renderer
 * with no IndexedDB, no quota, or a corrupt database opens every screen the way
 * it did before this cache existed — it just waits for the socket.
 *
 * `docs/local-cache.md` owns the design.
 */
const DATABASE_NAME = 'rally-local-cache';
const DATABASE_VERSION = 2;
const ENTRY_STORE = 'entries';
const GENERATION_KEY = ['', 'generation', ''];
const scopeEpochs = new Map<string, number>();
let allScopesEpoch = 0;
/** Every row of one kind about one subject, whatever scope it sits in. */
const KIND_SUBJECT_INDEX = 'kindSubject';
/** One row of one kind, whatever scope it sits in. */
const KIND_KEY_INDEX = 'kindKey';

interface LocalCacheRow {
  scope: string;
  kind: string;
  key: string;
  /**
   * What the row is about, for removal by identity rather than by key: every
   * conversation under one work stream shares the work stream's id here, so
   * losing the work stream drops them all in one index scan.
   */
  subject: string;
  /** The slice's shape version at the time of the write; a row from another version is dropped on read. */
  version: number;
  updatedAt: number;
  value: unknown;
}

export interface LocalCacheEntryIdentity {
  key: string;
  subject: string;
}

export interface LocalCacheSliceDefinition<T> {
  /** The slice's name in the store; one per shape, never reused for another. */
  kind: string;
  /**
   * Bumped whenever the persisted shape changes in a way `parse` cannot absorb.
   * Rows written under another version are dropped on read rather than
   * migrated: the cache holds nothing that cannot be fetched again.
   */
  version: number;
  /** Turns a stored value back into the slice's type, or null for one it will not vouch for. */
  parse: (value: unknown) => T | null;
}

export interface LocalCacheSlice<T> {
  readonly kind: string;
  readonly version: number;
  read(scope: string, key: string): Promise<T | null>;
  /**
   * Returns whether the row landed. A write from before the last wipe is
   * dropped and reports false, so nothing in flight at sign-out can restore
   * what the wipe removed. Supplying localCacheGeneration(scope) also fences a wipe
   * from another renderer, with the comparison inside the write transaction.
   */
  write(scope: string, key: string, value: T, subject?: string, atEpoch?: number, atGeneration?: string | null): Promise<boolean>;
  remove(scope: string, key: string): Promise<void>;
  /** The identities of every row of this kind in one scope, for pruning. */
  entries(scope: string): Promise<LocalCacheEntryIdentity[]>;
  /** The identities of one scope's rows about one subject, through the subject index. */
  entriesForSubject(scope: string, subject: string): Promise<LocalCacheEntryIdentity[]>;
  /** Drop every row about one subject, in every scope. */
  removeSubject(subject: string): Promise<void>;
  /** Drop one key's row in every scope. */
  removeKey(key: string): Promise<void>;
}

/**
 * A write states the epoch its content was captured in, and a wipe moves the
 * epoch on, so a coalesced write that was scheduled before sign-out cannot land
 * behind the clear. The same store, and the same race, as the draft cache.
 */
export function localCacheEpoch(scope?: string): number {
  return scope === undefined ? store.epoch() : Math.max(allScopesEpoch, scopeEpochs.get(scope) ?? 0);
}

/**
 * The scope every row is written under: the account that saw it, then the
 * regional workspace it belongs to. Two accounts on one device that share a
 * workspace therefore never read each other's rows, whatever order a wipe and
 * a hydration run in; the wipe is what takes the rows off the disk, the scope
 * is what keeps them apart while they are on it.
 *
 * A guest's rows sit in a scope of their own. Someone removed as a member and
 * later shared in as a guest would otherwise hydrate transcripts they read as
 * a member before the socket refuses them; a separate scope means a guest only
 * ever reads what they cached as a guest.
 */
export function localCacheScope(userId: string, region: RallyRegion, workspaceId: string, accessClass: 'member' | 'guest' = 'member'): string {
  const base = `${userId}:${desktopWorkspaceIdentityKey(region, workspaceId)}`;
  return accessClass === 'guest' ? `${base}:guest` : base;
}

/** Remove structured meeting snapshots; never inspect or rewrite conversation prose. */
function removeRetiredMeetingSnapshots(value: unknown): unknown {
  if (Array.isArray(value)) return value
    .filter(item => !(item && typeof item === 'object' && item.provider === 'avalon_note'))
    .map(removeRetiredMeetingSnapshots);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (object['provider'] === 'avalon_note') return null;
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, removeRetiredMeetingSnapshots(item)]));
}

const store = createIndexedDbStore({
  name: DATABASE_NAME,
  version: DATABASE_VERSION,
  label: 'local cache',
  upgrade(database, transaction) {
    if (database.objectStoreNames.contains(ENTRY_STORE)) {
      // Visit inactive scopes too: waiting for a workspace to be opened would
      // leave its retired Notes directory on this device indefinitely.
      const entries = transaction.objectStore(ENTRY_STORE);
      const request = entries.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const row = cursor.value as LocalCacheRow;
        const value = removeRetiredMeetingSnapshots(row.value);
        if (row.kind === 'directory' && value && typeof value === 'object') {
          delete (value as Record<string, unknown>)['notes'];
          row.version = 2;
        }
        cursor.update({ ...row, value });
        cursor.continue();
      };
      return;
    }
    const entries = database.createObjectStore(ENTRY_STORE, { keyPath: ['scope', 'kind', 'key'] });
    entries.createIndex(KIND_SUBJECT_INDEX, ['kind', 'subject']);
    entries.createIndex(KIND_KEY_INDEX, ['kind', 'key']);
  },
});

const { awaitRequest } = store;

function withEntries<T>(
  mode: IDBTransactionMode,
  run: (entries: IDBObjectStore) => Promise<T>,
  fallback: T,
): Promise<T> {
  return store.withStores([ENTRY_STORE], mode, (transaction) => run(transaction.objectStore(ENTRY_STORE)), fallback);
}

/**
 * Every key of a compound-keyed row beginning with `prefix`. Arrays sort after
 * strings in IndexedDB's key order, so `[...prefix, []]` is past every row whose
 * next component is a string, and `prefix` itself is before all of them.
 */
function prefixRange(prefix: readonly string[]): IDBKeyRange {
  return IDBKeyRange.bound([...prefix], [...prefix, []]);
}

function parseRow(value: unknown): LocalCacheRow | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['scope'] !== 'string'
    || typeof candidate['kind'] !== 'string'
    || typeof candidate['key'] !== 'string'
    || typeof candidate['subject'] !== 'string'
    || typeof candidate['version'] !== 'number'
  ) return null;
  return {
    scope: candidate['scope'],
    kind: candidate['kind'],
    key: candidate['key'],
    subject: candidate['subject'],
    version: candidate['version'],
    updatedAt: typeof candidate['updatedAt'] === 'number' ? candidate['updatedAt'] : 0,
    value: candidate['value'],
  };
}

function generationOf(row: unknown): string | null {
  const value = parseRow(row)?.value;
  return typeof value === 'string' ? value : null;
}

async function generationForScope(entries: IDBObjectStore, scope: string): Promise<string> {
  const [global, scoped] = await Promise.all([
    awaitRequest(entries.get(GENERATION_KEY)),
    awaitRequest(entries.get(['', 'generation', scope])),
  ]);
  return JSON.stringify([generationOf(global), generationOf(scoped)]);
}

/** Global sign-out and this scope's wipe, shared by same-origin tabs. */
export function localCacheGeneration(scope: string): Promise<string | null> {
  return withEntries('readonly', (entries) => generationForScope(entries, scope), null);
}

function advanceGeneration(entries: IDBObjectStore, scope = ''): void {
  entries.put({ scope: '', kind: 'generation', key: scope, subject: '', version: 1,
    updatedAt: Date.now(), value: crypto.randomUUID() } satisfies LocalCacheRow);
}

async function deleteKeys(store: IDBObjectStore, keys: readonly IDBValidKey[]): Promise<void> {
  for (const key of keys) store.delete(key);
  await Promise.resolve();
}

/**
 * Define one persisted shape. The slice is the unit the rest of the renderer
 * composes with: a new surface that wants to paint from the last thing it saw
 * defines a slice, hydrates from it, and mirrors into it, and never touches the
 * store below.
 */
export function defineLocalCacheSlice<T>(definition: LocalCacheSliceDefinition<T>): LocalCacheSlice<T> {
  const { kind, version, parse } = definition;
  const remove = (scope: string, key: string): Promise<void> => withEntries('readwrite', async (store) => {
    store.delete([scope, kind, key]);
  }, undefined);
  return {
    kind,
    version,
    async read(scope, key) {
      const row = await withEntries('readonly', async (store) =>
        parseRow(await awaitRequest(store.get([scope, kind, key]))), null);
      if (!row) return null;
      const parsed = row.version === version ? parse(row.value) : null;
      // A row this version of the slice will not vouch for is dead weight, and
      // the next write would only replace it if the same key is written again.
      if (parsed === null) void remove(scope, key);
      return parsed;
    },
    async write(scope, key, value, subject = key, atEpoch, atGeneration) {
      const currentEpoch = (): number => localCacheEpoch(atGeneration === undefined ? undefined : scope);
      const capturedEpoch = atEpoch ?? currentEpoch();
      if (capturedEpoch !== currentEpoch()) return false;
      return withEntries('readwrite', async (store) => {
        if (atGeneration !== undefined && await generationForScope(store, scope) !== atGeneration) return false;
        if (capturedEpoch !== currentEpoch()) return false;
        store.put({ scope, kind, key, subject, version, updatedAt: Date.now(), value } satisfies LocalCacheRow);
        return true;
      }, false);
    },
    remove,
    entries(scope) {
      return withEntries('readonly', async (store) => {
        const rows = await awaitRequest(store.getAll(prefixRange([scope, kind])));
        return (Array.isArray(rows) ? rows : []).flatMap((row) => {
          const parsed = parseRow(row);
          return parsed ? [{ key: parsed.key, subject: parsed.subject }] : [];
        });
      }, []);
    },
    entriesForSubject(scope, subject) {
      return withEntries('readonly', async (entries) => {
        const rows = await awaitRequest(entries.index(KIND_SUBJECT_INDEX).getAll(IDBKeyRange.only([kind, subject])));
        return (Array.isArray(rows) ? rows : []).flatMap((row) => {
          const parsed = parseRow(row);
          return parsed && parsed.scope === scope ? [{ key: parsed.key, subject: parsed.subject }] : [];
        });
      }, []);
    },
    removeSubject(subject) {
      return withEntries('readwrite', async (store) => {
        const keys = await awaitRequest(store.index(KIND_SUBJECT_INDEX).getAllKeys(IDBKeyRange.only([kind, subject])));
        await deleteKeys(store, keys);
      }, undefined);
    },
    removeKey(key) {
      return withEntries('readwrite', async (store) => {
        const keys = await awaitRequest(store.index(KIND_KEY_INDEX).getAllKeys(IDBKeyRange.only([kind, key])));
        await deleteKeys(store, keys);
      }, undefined);
    },
  };
}

/** Sign-out leaves nothing of any workspace on the device. */
export async function clearAllLocalCache(): Promise<void> {
  store.advanceEpoch();
  allScopesEpoch = store.epoch();
  scopeEpochs.clear();
  await withEntries('readwrite', async (store) => {
    store.clear();
    advanceGeneration(store);
  }, undefined);
}

/** An account leaving one workspace removes only the rows it wrote under that scope. */
export async function clearWorkspaceLocalCache(userId: string, region: RallyRegion, workspaceId: string): Promise<void> {
  store.advanceEpoch();
  const scopes = (['member', 'guest'] as const).map((accessClass) => localCacheScope(userId, region, workspaceId, accessClass));
  for (const scope of scopes) scopeEpochs.set(scope, store.epoch());
  await withEntries('readwrite', async (store) => {
    for (const scope of scopes) {
      advanceGeneration(store, scope);
      store.delete(prefixRange([scope]));
    }
  }, undefined);
}

/**
 * Test seam: drops the open connection so the next call reopens the database,
 * and resets the epoch so one file's wipe does not fence another's writes.
 */
export function closeLocalCache(): void {
  store.close();
  allScopesEpoch = 0;
  scopeEpochs.clear();
}
