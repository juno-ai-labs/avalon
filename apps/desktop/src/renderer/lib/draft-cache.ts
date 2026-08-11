import type { MentionIdentity } from './api';
import type { WorkstreamResource } from './types';

/**
 * Composer drafts survive navigation, a window close, and an application
 * restart by living in IndexedDB rather than in component state. Attachment
 * bytes are kept alongside the text so a restored draft can still paint its
 * thumbnails and retry its uploads without the file picker.
 */
const DATABASE_NAME = 'avalon-composer-drafts';
const DATABASE_VERSION = 1;
const TEXT_STORE = 'text';
const ATTACHMENT_STORE = 'attachments';
const DRAFT_KEY_INDEX = 'draftKey';

/**
 * A cached attachment carries a server draft resource ID that the API's reaper
 * deletes 24 hours after upload. Expiring the local copy well before that keeps
 * a restored draft from pointing at a resource that no longer exists.
 */
export const DRAFT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export interface CachedDraftText {
  draftKey: string;
  text: string;
  mentions: MentionIdentity[];
  updatedAt: number;
}

export interface CachedDraftAttachment {
  draftKey: string;
  localId: string;
  /** Monotonic insertion key; restoring sorts on it to keep the tile order. */
  sortKey: number;
  fileName: string;
  mimeType: string;
  lastModified: number;
  /**
   * File contents as a plain buffer rather than a `Blob`: every IndexedDB
   * implementation clones one faithfully, and the composer rebuilds a `File`
   * from it on restore anyway.
   */
  bytes: ArrayBuffer;
  sha256?: string;
  resource?: WorkstreamResource;
  updatedAt: number;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;
let lastSortKey = 0;

/** Insertion keys must keep rising even when two files land in the same tick. */
export function nextDraftSortKey(): number {
  lastSortKey = Math.max(Date.now(), lastSortKey + 1);
  return lastSortKey;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TEXT_STORE)) {
        database.createObjectStore(TEXT_STORE, { keyPath: 'draftKey' });
      }
      if (!database.objectStoreNames.contains(ATTACHMENT_STORE)) {
        const store = database.createObjectStore(ATTACHMENT_STORE, { keyPath: ['draftKey', 'localId'] });
        store.createIndex(DRAFT_KEY_INDEX, 'draftKey');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
}

function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The draft cache request failed.'));
  });
}

function awaitTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('The draft cache transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('The draft cache transaction was aborted.'));
  });
}

/**
 * A composer must keep working when the cache does not: a browser in private
 * mode, a revoked quota, or a corrupt database all resolve to the fallback
 * instead of surfacing an error the user cannot act on.
 */
async function withStores<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction) => Promise<T>,
  fallback: T,
): Promise<T> {
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
}

function isMentionIdentity(value: unknown): value is MentionIdentity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (candidate['type'] === 'person' || candidate['type'] === 'connector') && typeof candidate['label'] === 'string';
}

function parseCachedText(value: unknown): CachedDraftText | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['draftKey'] !== 'string' || typeof candidate['text'] !== 'string') return null;
  const updatedAt = typeof candidate['updatedAt'] === 'number' ? candidate['updatedAt'] : 0;
  const mentions = Array.isArray(candidate['mentions']) ? candidate['mentions'].filter(isMentionIdentity) : [];
  return { draftKey: candidate['draftKey'], text: candidate['text'], mentions, updatedAt };
}

function parseCachedAttachment(value: unknown): CachedDraftAttachment | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const bytes = candidate['bytes'];
  if (
    typeof candidate['draftKey'] !== 'string'
    || typeof candidate['localId'] !== 'string'
    || typeof candidate['fileName'] !== 'string'
    // A structured clone can hand back a buffer from another realm, where
    // `instanceof` no longer holds.
    || Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]'
  ) return null;
  return {
    draftKey: candidate['draftKey'],
    localId: candidate['localId'],
    sortKey: typeof candidate['sortKey'] === 'number' ? candidate['sortKey'] : 0,
    fileName: candidate['fileName'],
    mimeType: typeof candidate['mimeType'] === 'string' ? candidate['mimeType'] : '',
    lastModified: typeof candidate['lastModified'] === 'number' ? candidate['lastModified'] : 0,
    bytes: bytes as ArrayBuffer,
    ...(typeof candidate['sha256'] === 'string' ? { sha256: candidate['sha256'] } : {}),
    ...(candidate['resource'] && typeof candidate['resource'] === 'object'
      ? { resource: candidate['resource'] as WorkstreamResource }
      : {}),
    updatedAt: typeof candidate['updatedAt'] === 'number' ? candidate['updatedAt'] : 0,
  };
}

export async function readDraftText(draftKey: string): Promise<CachedDraftText | null> {
  return withStores([TEXT_STORE], 'readonly', async (transaction) => {
    const record = await awaitRequest(transaction.objectStore(TEXT_STORE).get(draftKey));
    const parsed = parseCachedText(record);
    if (!parsed) return null;
    return Date.now() - parsed.updatedAt > DRAFT_CACHE_TTL_MS ? null : parsed;
  }, null);
}

/** An empty draft is not a draft: writing one removes the row instead. */
export async function writeDraftText(draftKey: string, text: string, mentions: MentionIdentity[] = []): Promise<void> {
  await withStores([TEXT_STORE], 'readwrite', async (transaction) => {
    const store = transaction.objectStore(TEXT_STORE);
    if (text.length === 0) store.delete(draftKey);
    else store.put({ draftKey, text, mentions, updatedAt: Date.now() } satisfies CachedDraftText);
  }, undefined);
}

export async function readDraftAttachments(draftKey: string): Promise<CachedDraftAttachment[]> {
  return withStores([ATTACHMENT_STORE], 'readonly', async (transaction) => {
    const index = transaction.objectStore(ATTACHMENT_STORE).index(DRAFT_KEY_INDEX);
    const records = await awaitRequest(index.getAll(IDBKeyRange.only(draftKey)));
    return (Array.isArray(records) ? records : [])
      .flatMap((record) => {
        const parsed = parseCachedAttachment(record);
        return parsed && Date.now() - parsed.updatedAt <= DRAFT_CACHE_TTL_MS ? [parsed] : [];
      })
      .sort((left, right) => left.sortKey - right.sortKey);
  }, []);
}

export async function writeDraftAttachment(attachment: Omit<CachedDraftAttachment, 'updatedAt'>): Promise<void> {
  await withStores([ATTACHMENT_STORE], 'readwrite', async (transaction) => {
    transaction.objectStore(ATTACHMENT_STORE).put({ ...attachment, updatedAt: Date.now() } satisfies CachedDraftAttachment);
  }, undefined);
}

/**
 * Upload progress never reaches the cache; only the settled result does, so a
 * finished upload rewrites one row rather than one row per progress event.
 */
export async function updateDraftAttachment(
  draftKey: string,
  localId: string,
  patch: Pick<Partial<CachedDraftAttachment>, 'resource' | 'sha256'>,
): Promise<void> {
  await withStores([ATTACHMENT_STORE], 'readwrite', async (transaction) => {
    const store = transaction.objectStore(ATTACHMENT_STORE);
    const existing = parseCachedAttachment(await awaitRequest(store.get([draftKey, localId])));
    if (!existing) return;
    store.put({ ...existing, ...patch, updatedAt: Date.now() } satisfies CachedDraftAttachment);
  }, undefined);
}

/** Omitting `localIds` drops every attachment cached under the key. */
export async function deleteDraftAttachments(draftKey: string, localIds?: string[]): Promise<void> {
  await withStores([ATTACHMENT_STORE], 'readwrite', async (transaction) => {
    const store = transaction.objectStore(ATTACHMENT_STORE);
    if (localIds) {
      for (const localId of localIds) store.delete([draftKey, localId]);
      return;
    }
    const keys = await awaitRequest(store.index(DRAFT_KEY_INDEX).getAllKeys(IDBKeyRange.only(draftKey)));
    for (const key of keys) store.delete(key);
  }, undefined);
}

/**
 * Drops every draft past its TTL and reports the attachments that went with
 * them, so the caller can release their server-side draft resources too.
 */
export async function pruneExpiredDrafts(): Promise<CachedDraftAttachment[]> {
  const cutoff = Date.now() - DRAFT_CACHE_TTL_MS;
  return withStores([TEXT_STORE, ATTACHMENT_STORE], 'readwrite', async (transaction) => {
    const textStore = transaction.objectStore(TEXT_STORE);
    for (const record of await awaitRequest(textStore.getAll())) {
      const parsed = parseCachedText(record);
      if (parsed && parsed.updatedAt <= cutoff) textStore.delete(parsed.draftKey);
    }
    const attachmentStore = transaction.objectStore(ATTACHMENT_STORE);
    const expired: CachedDraftAttachment[] = [];
    for (const record of await awaitRequest(attachmentStore.getAll())) {
      const parsed = parseCachedAttachment(record);
      if (!parsed) continue;
      if (parsed.updatedAt > cutoff) continue;
      expired.push(parsed);
      attachmentStore.delete([parsed.draftKey, parsed.localId]);
    }
    return expired;
  }, []);
}

/** Sign-out leaves no drafted text or file bytes behind on the device. */
export async function clearAllDrafts(): Promise<void> {
  await withStores([TEXT_STORE, ATTACHMENT_STORE], 'readwrite', async (transaction) => {
    transaction.objectStore(TEXT_STORE).clear();
    transaction.objectStore(ATTACHMENT_STORE).clear();
  }, undefined);
}

/**
 * Test seam: drops the open connection so the next call reopens the database.
 * A live IndexedDB connection keeps its implementation's task queue running,
 * which is noise a test that never touches a draft should not have to absorb.
 */
export function closeDraftCache(): void {
  const opening = databasePromise;
  databasePromise = null;
  lastSortKey = 0;
  void opening?.then((database) => database?.close());
}
