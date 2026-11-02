import { z } from 'zod';
import { AnnotationSchema, type Annotation } from '@rally/contracts';
import type { MentionIdentity } from './api';
import type { WorkstreamResource } from './types';
import type { RallyRegion } from '../../common/desktop';
import { createIndexedDbStore } from './indexeddb-store';
import {
  newAutomationDraftKey,
  newWorkstreamDraftKey,
  workspaceDraftPrefix,
  workstreamDraftKey,
} from './draft-keys';

/**
 * Composer drafts survive navigation, a window close, and an application
 * restart by living in IndexedDB rather than in component state. Attachment
 * bytes are kept alongside the text so a restored draft can still paint its
 * thumbnails and retry its uploads without the file picker.
 */
const DATABASE_NAME = 'rally-composer-drafts';
const DATABASE_VERSION = 3;
const ANNOTATION_STORE = 'annotations';
const TEXT_STORE = 'text';
const ATTACHMENT_STORE = 'attachments';
const DRAFT_KEY_INDEX = 'draftKey';
const UPDATED_AT_INDEX = 'updatedAt';

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
  /** A long paste the API types and names; see `lib/pasted-text.ts`. */
  pastedText?: boolean;
  resource?: WorkstreamResource;
  updatedAt: number;
}

let lastSortKey = 0;

/**
 * The store both drafts and the local cache are kept in the shape of; what is
 * particular to drafts is the object stores below and the twelve-hour
 * lifetime above. A write carries the epoch its content was captured in, and a
 * wipe moves the epoch on, so a debounced save, a file mid-fingerprint, or an
 * upload about to record its resource from before the wipe is dropped rather
 * than landing behind the clear and restoring what was erased.
 */
const store = createIndexedDbStore({
  name: DATABASE_NAME,
  version: DATABASE_VERSION,
  label: 'draft cache',
  upgrade(database, transaction) {
    if (!database.objectStoreNames.contains(TEXT_STORE)) {
      database.createObjectStore(TEXT_STORE, { keyPath: 'draftKey' });
    }
    if (!database.objectStoreNames.contains(ANNOTATION_STORE)) {
      const annotations = database.createObjectStore(ANNOTATION_STORE, { keyPath: ['draftKey', 'id'] });
      annotations.createIndex(DRAFT_KEY_INDEX, 'draftKey');
      annotations.createIndex(UPDATED_AT_INDEX, 'updatedAt');
    }
    const attachments = database.objectStoreNames.contains(ATTACHMENT_STORE)
      ? transaction.objectStore(ATTACHMENT_STORE)
      : (() => {
          const created = database.createObjectStore(ATTACHMENT_STORE, { keyPath: ['draftKey', 'localId'] });
          created.createIndex(DRAFT_KEY_INDEX, 'draftKey');
          return created;
        })();
    // Added in version 2 so the launch sweep can range-scan straight to the
    // expired rows instead of materializing every cached file to read a date.
    if (!attachments.indexNames.contains(UPDATED_AT_INDEX)) {
      attachments.createIndex(UPDATED_AT_INDEX, 'updatedAt');
    }
  },
});

/** The epoch a draft write about to be scheduled should carry. */
export function draftCacheEpoch(): number {
  return store.epoch();
}

/** Insertion keys must keep rising even when two files land in the same tick. */
export function nextDraftSortKey(): number {
  lastSortKey = Math.max(Date.now(), lastSortKey + 1);
  return lastSortKey;
}

const { awaitRequest, withStores } = store;

function isMentionIdentity(value: unknown): value is MentionIdentity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const offsetsAbsent = candidate['startOffset'] === undefined && candidate['endOffset'] === undefined;
  const offsetsValid = Number.isInteger(candidate['startOffset'])
    && Number.isInteger(candidate['endOffset'])
    && Number(candidate['startOffset']) >= 0
    && Number(candidate['endOffset']) > Number(candidate['startOffset']);
  return (candidate['type'] === 'person' || candidate['type'] === 'connector'
    || (candidate['type'] === 'sidekick' && typeof candidate['sidekickId'] === 'string'))
    && typeof candidate['label'] === 'string'
    && (offsetsAbsent || offsetsValid);
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
    ...(candidate['pastedText'] === true ? { pastedText: true } : {}),
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
export async function writeDraftText(
  draftKey: string,
  text: string,
  mentions: MentionIdentity[] = [],
  atEpoch: number = store.epoch(),
): Promise<void> {
  if (atEpoch !== store.epoch()) return;
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

/**
 * Reports whether the bytes actually landed. A composer that promises work will
 * survive has to know when the device refused to store it — an exhausted quota
 * is the difference between a cached attachment and one that disappears at the
 * next launch.
 */
export async function writeDraftAttachment(
  attachment: Omit<CachedDraftAttachment, 'updatedAt'>,
  atEpoch: number = store.epoch(),
): Promise<boolean> {
  if (atEpoch !== store.epoch()) return false;
  return withStores([ATTACHMENT_STORE], 'readwrite', async (transaction) => {
    transaction.objectStore(ATTACHMENT_STORE).put({ ...attachment, updatedAt: Date.now() } satisfies CachedDraftAttachment);
    return true;
  }, false);
}

/**
 * Upload progress never reaches the cache; only the settled result does, so a
 * finished upload rewrites one row rather than one row per progress event.
 */
export async function updateDraftAttachment(
  draftKey: string,
  localId: string,
  patch: Pick<Partial<CachedDraftAttachment>, 'resource' | 'sha256'>,
  atEpoch: number = store.epoch(),
): Promise<void> {
  if (atEpoch !== store.epoch()) return;
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
  const expiredRange = IDBKeyRange.upperBound(cutoff);
  return withStores([TEXT_STORE, ATTACHMENT_STORE, ANNOTATION_STORE], 'readwrite', async (transaction) => {
    const annotations = transaction.objectStore(ANNOTATION_STORE);
    for (const key of await awaitRequest(annotations.index(UPDATED_AT_INDEX).getAllKeys(expiredRange))) annotations.delete(key);
    const textStore = transaction.objectStore(TEXT_STORE);
    for (const record of await awaitRequest(textStore.getAll())) {
      const parsed = parseCachedText(record);
      if (parsed && parsed.updatedAt <= cutoff) textStore.delete(parsed.draftKey);
    }
    // Walked through the date index rather than read whole: a live draft's file
    // bytes are never deserialized just to learn that the draft is not expired.
    const attachmentStore = transaction.objectStore(ATTACHMENT_STORE);
    const expired: CachedDraftAttachment[] = [];
    await new Promise<void>((resolve, reject) => {
      const request = attachmentStore.index(UPDATED_AT_INDEX).openCursor(expiredRange);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const parsed = parseCachedAttachment(cursor.value);
        if (parsed) expired.push(parsed);
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('The draft cache sweep failed.'));
    });
    return expired;
  }, []);
}

/** Sign-out leaves no drafted text or file bytes behind on the device. */
export async function clearAllDrafts(): Promise<void> {
  store.advanceEpoch();
  broadcastDraftClear(null);
  await withStores([TEXT_STORE, ATTACHMENT_STORE, ANNOTATION_STORE], 'readwrite', async (transaction) => {
    transaction.objectStore(ANNOTATION_STORE).clear();
    transaction.objectStore(TEXT_STORE).clear();
    transaction.objectStore(ATTACHMENT_STORE).clear();
  }, undefined);
}

/** Leaving one workspace removes only keys that belong to that workspace. */
export async function clearWorkspaceDrafts(region: RallyRegion, workspaceId: string): Promise<void> {
  store.advanceEpoch();
  const prefix = workspaceDraftPrefix(region, workspaceId);
  broadcastDraftClear(prefix);
  const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  await withStores([TEXT_STORE, ATTACHMENT_STORE, ANNOTATION_STORE], 'readwrite', async (transaction) => {
    const annotations = transaction.objectStore(ANNOTATION_STORE);
    for (const key of await awaitRequest(annotations.index(DRAFT_KEY_INDEX).getAllKeys(range))) annotations.delete(key);
    transaction.objectStore(TEXT_STORE).delete(range);
    const attachmentStore = transaction.objectStore(ATTACHMENT_STORE);
    const keys = await awaitRequest(
      attachmentStore.index(DRAFT_KEY_INDEX).getAllKeys(range),
    );
    for (const key of keys) attachmentStore.delete(key);
  }, undefined);
}

function regionalDraftKey(
  legacyKey: string,
  region: RallyRegion,
  workspaceId: string,
): string | null {
  const workstream = /^workstream:(.+)$/u.exec(legacyKey);
  if (workstream?.[1]) return workstreamDraftKey(region, workspaceId, workstream[1]);
  const newWorkstreamPrefix = `new-workstream:${workspaceId}`;
  if (legacyKey === newWorkstreamPrefix || legacyKey.startsWith(`${newWorkstreamPrefix}:`)) {
    return `${newWorkstreamDraftKey(region, workspaceId)}${legacyKey.slice(newWorkstreamPrefix.length)}`;
  }
  const newAutomationPrefix = `new-automation:${workspaceId}`;
  if (legacyKey === newAutomationPrefix) return newAutomationDraftKey(region, workspaceId);
  if (legacyKey.startsWith(`${newAutomationPrefix}:`)) {
    return newAutomationDraftKey(region, workspaceId, legacyKey.slice(newAutomationPrefix.length + 1));
  }
  return null;
}

/** Move released single-workspace keys after the first regional workspace
 * session identifies their authority. Only legacy prefixes are considered, so
 * retries are idempotent; a newer regional row wins an interrupted rewrite. */
export async function migrateLegacyDrafts(region: RallyRegion, workspaceId: string): Promise<void> {
  await withStores([TEXT_STORE, ATTACHMENT_STORE], 'readwrite', async (transaction) => {
    const textStore = transaction.objectStore(TEXT_STORE);
    for (const record of await awaitRequest(textStore.getAll())) {
      const legacy = parseCachedText(record);
      if (!legacy) continue;
      const draftKey = regionalDraftKey(legacy.draftKey, region, workspaceId);
      if (!draftKey || draftKey === legacy.draftKey) continue;
      const current = parseCachedText(await awaitRequest(textStore.get(draftKey)));
      if (!current || current.updatedAt <= legacy.updatedAt) textStore.put({ ...legacy, draftKey });
      textStore.delete(legacy.draftKey);
    }

    const attachmentStore = transaction.objectStore(ATTACHMENT_STORE);
    for (const record of await awaitRequest(attachmentStore.getAll())) {
      const legacy = parseCachedAttachment(record);
      if (!legacy) continue;
      const draftKey = regionalDraftKey(legacy.draftKey, region, workspaceId);
      if (!draftKey || draftKey === legacy.draftKey) continue;
      const current = parseCachedAttachment(await awaitRequest(
        attachmentStore.get([draftKey, legacy.localId]),
      ));
      if (!current || current.updatedAt <= legacy.updatedAt) attachmentStore.put({ ...legacy, draftKey });
      attachmentStore.delete([legacy.draftKey, legacy.localId]);
    }
  }, undefined);
}

/**
 * Test seam: drops the open connection so the next call reopens the database.
 * A live IndexedDB connection keeps its implementation's task queue running,
 * which is noise a test that never touches a draft should not have to absorb.
 */
export function closeDraftCache(): void {
  lastSortKey = 0;
  store.close();
}

/** One row per confirmed comment; image bytes use the attachment cache's buffer representation. */
export interface CachedAnnotationDraft {
  draftKey: string;
  id: string;
  generation: string;
  sortKey?: number;
  name: string;
  annotation: Annotation;
  original: Annotation;
  updatedAt: number;
  image?: { bytes: ArrayBuffer; name: string; type: string };
}

const CachedAnnotationSchema = AnnotationSchema.extend({ comment: z.string() });

export async function readAnnotationDrafts(draftKey: string): Promise<CachedAnnotationDraft[]> {
  return withStores([ANNOTATION_STORE], 'readonly', async (transaction) => {
    const rows: unknown[] = await awaitRequest(transaction.objectStore(ANNOTATION_STORE).index(DRAFT_KEY_INDEX).getAll(draftKey));
    return rows.filter((row): row is CachedAnnotationDraft => {
      if (!row || typeof row !== 'object') return false;
      const value = row as CachedAnnotationDraft;
      return value.draftKey === draftKey && typeof value.id === 'string' && typeof value.generation === 'string'
        && typeof value.name === 'string' && typeof value.updatedAt === 'number'
        && Date.now() - value.updatedAt <= DRAFT_CACHE_TTL_MS
        && CachedAnnotationSchema.safeParse(value.annotation).success && CachedAnnotationSchema.safeParse(value.original).success;
    }).sort((a, b) => (a.sortKey ?? a.updatedAt) - (b.sortKey ?? b.updatedAt));
  }, []);
}

/** Expected generation makes send receipts and background resolution conditional on the captured edit. */
export async function writeAnnotationDraft(row: CachedAnnotationDraft, atEpoch: number, expectedGeneration?: string): Promise<boolean> {
  if (atEpoch !== store.epoch()) return false;
  return withStores([ANNOTATION_STORE], 'readwrite', async (transaction) => {
    if (atEpoch !== store.epoch()) return false;
    const annotations = transaction.objectStore(ANNOTATION_STORE);
    if (expectedGeneration !== undefined) {
      const previous = await awaitRequest(annotations.get([row.draftKey, row.id])) as CachedAnnotationDraft | undefined;
      if (previous?.generation !== expectedGeneration) return true;
    }
    annotations.put(row);
    return true;
  }, false);
}

export async function deleteAnnotationDraft(draftKey: string, id: string, atEpoch: number, expectedGeneration?: string): Promise<boolean> {
  if (atEpoch !== store.epoch()) return false;
  return withStores([ANNOTATION_STORE], 'readwrite', async (transaction) => {
    if (atEpoch !== store.epoch()) return false;
    const annotations = transaction.objectStore(ANNOTATION_STORE);
    const previous = await awaitRequest(annotations.get([draftKey, id])) as CachedAnnotationDraft | undefined;
    if (expectedGeneration !== undefined && previous?.generation !== expectedGeneration) return true;
    annotations.delete([draftKey, id]);
    return true;
  }, false);
}

const draftClearListeners = new Set<(prefix: string | null) => void>();
let draftClearChannel: BroadcastChannel | null = null;
export function subscribeDraftClears(listener: (prefix: string | null) => void): () => void {
  draftClearListeners.add(listener);
  if (!draftClearChannel && typeof BroadcastChannel !== 'undefined') {
    draftClearChannel = new BroadcastChannel('rally-draft-clear');
    draftClearChannel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== null && typeof event.data !== 'string') return;
      store.advanceEpoch();
      for (const receive of draftClearListeners) receive(event.data);
    };
  }
  return () => { draftClearListeners.delete(listener); if (!draftClearListeners.size) {draftClearChannel?.close();draftClearChannel=null;} };
}
function broadcastDraftClear(prefix: string | null): void {
  for (const listener of draftClearListeners) listener(prefix);
  if (draftClearChannel) draftClearChannel.postMessage(prefix);
  else if (typeof BroadcastChannel !== 'undefined') {const channel=new BroadcastChannel('rally-draft-clear');channel.postMessage(prefix);channel.close();}
}
