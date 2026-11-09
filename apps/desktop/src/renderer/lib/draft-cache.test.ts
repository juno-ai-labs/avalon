import "../../../../../tests/isolated-region";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_CACHE_TTL_MS,
  clearAllDrafts,
  clearWorkspaceDrafts,
  draftCacheEpoch,
  deleteDraftAttachments,
  nextDraftSortKey,
  pruneExpiredDrafts,
  readDraftAttachments,
  readDraftText,
  closeDraftCache,
  migrateLegacyDrafts,
  updateDraftAttachment,
  writeDraftAttachment,
  writeDraftText,
} from './draft-cache';
import { conversationDraftKey, newAutomationDraftKey, newWorkstreamDraftKey, workstreamDraftKey } from './draft-keys';
import type { WorkstreamResource } from './types';

const resource: WorkstreamResource = {
  id: '019fcc00-0000-7000-8000-000000000001',
  title: 'notes.txt',
  resourceType: 'uploaded_file',
  provider: 'rally_upload',
  mimeType: 'text/plain',
  refreshSupported: false,
  watchEnabled: false,
  watchStatus: 'unsupported',
  contentAvailable: true,
  sizeBytes: 5,
  currentVersion: 1,
  relationshipType: 'attachment',
  direction: 'source',
};

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function decode(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(buffer));
}

async function cacheAttachment(draftKey: string, localId: string, contents: string): Promise<void> {
  await writeDraftAttachment({
    draftKey,
    localId,
    sortKey: nextDraftSortKey(),
    fileName: `${localId}.txt`,
    mimeType: 'text/plain',
    lastModified: 1,
    bytes: bytes(contents),
  });
}

describe('draft cache', () => {
  beforeEach(() => clearAllDrafts());
  afterEach(() => vi.useRealTimers());

  it('round-trips drafted text and its mentions', async () => {
    await writeDraftText('workstream:1', 'half a thought', [
      { type: 'person', label: 'Ada', userId: 'user-1', connectorType: null },
    ]);

    const stored = await readDraftText('workstream:1');

    expect(stored?.text).toBe('half a thought');
    expect(stored?.mentions).toEqual([{ type: 'person', label: 'Ada', userId: 'user-1', connectorType: null }]);
  });

  it('drops the row when the draft is cleared to empty', async () => {
    await writeDraftText('workstream:1', 'half a thought');

    await writeDraftText('workstream:1', '');

    expect(await readDraftText('workstream:1')).toBeNull();
  });

  it('keeps attachments in insertion order and scoped to their draft', async () => {
    await cacheAttachment('workstream:1', 'first', 'one');
    await cacheAttachment('workstream:1', 'second', 'two');
    await cacheAttachment('workstream:2', 'other', 'three');

    const stored = await readDraftAttachments('workstream:1');

    expect(stored.map((attachment) => attachment.localId)).toEqual(['first', 'second']);
    expect(decode(stored[0]!.bytes)).toBe('one');
    expect((await readDraftAttachments('workstream:2')).map((attachment) => attachment.localId)).toEqual(['other']);
  });

  it('records the uploaded resource without disturbing the cached bytes', async () => {
    await cacheAttachment('workstream:1', 'first', 'one');

    await updateDraftAttachment('workstream:1', 'first', { resource });

    const stored = await readDraftAttachments('workstream:1');
    expect(stored[0]?.resource?.id).toBe(resource.id);
    expect(decode(stored[0]!.bytes)).toBe('one');
  });

  it('deletes only the named attachments', async () => {
    await cacheAttachment('workstream:1', 'first', 'one');
    await cacheAttachment('workstream:1', 'second', 'two');

    await deleteDraftAttachments('workstream:1', ['first']);

    expect((await readDraftAttachments('workstream:1')).map((attachment) => attachment.localId)).toEqual(['second']);
  });

  it('deletes every attachment under a key when none are named', async () => {
    await cacheAttachment('workstream:1', 'first', 'one');
    await cacheAttachment('workstream:1', 'second', 'two');

    await deleteDraftAttachments('workstream:1');

    expect(await readDraftAttachments('workstream:1')).toEqual([]);
  });

  it('hides and prunes drafts past the cache lifetime, reporting their resources', async () => {
    await writeDraftText('workstream:1', 'stale');
    await cacheAttachment('workstream:1', 'first', 'one');
    await updateDraftAttachment('workstream:1', 'first', { resource });
    // Only the clock moves: IndexedDB drives its transactions off real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + DRAFT_CACHE_TTL_MS + 1_000);

    expect(await readDraftText('workstream:1')).toBeNull();
    expect(await readDraftAttachments('workstream:1')).toEqual([]);

    const expired = await pruneExpiredDrafts();

    expect(expired.map((attachment) => attachment.resource?.id)).toEqual([resource.id]);
    vi.useRealTimers();
    expect(await pruneExpiredDrafts()).toEqual([]);
  });

  it('drops a write whose content predates a wipe', async () => {
    const atEpoch = draftCacheEpoch();
    await cacheAttachment('workstream:1', 'first', 'one');

    await clearAllDrafts();
    // Both racing shapes: a debounced save and a file that was still being
    // fingerprinted when the device left the session.
    await writeDraftText('workstream:1', 'typed just before signing out', [], atEpoch);
    const stored = await writeDraftAttachment({
      draftKey: 'workstream:1',
      localId: 'late',
      sortKey: nextDraftSortKey(),
      fileName: 'late.txt',
      mimeType: 'text/plain',
      lastModified: 1,
      bytes: bytes('late'),
    }, atEpoch);

    expect(stored).toBe(false);
    expect(await readDraftText('workstream:1')).toBeNull();
    expect(await readDraftAttachments('workstream:1')).toEqual([]);
  });

  it('lets a composer opened after a wipe write normally', async () => {
    await clearAllDrafts();
    const atEpoch = draftCacheEpoch();

    await writeDraftText('workstream:1', 'a new session, a new draft', [], atEpoch);

    expect((await readDraftText('workstream:1'))?.text).toBe('a new session, a new draft');
  });

  it("keeps a Canvas's Chat draft apart from a Sidekick's with the same id, and clears it with its organization", async () => {
    const canvasKey = conversationDraftKey('enterprise', 'shared-workspace', 'canvas', '7');
    const sidekickKey = conversationDraftKey('enterprise', 'shared-workspace', 'automation', '7');
    await writeDraftText(canvasKey, 'the Canvas draft');
    await writeDraftText(sidekickKey, 'the Sidekick draft');
    await cacheAttachment(canvasKey, 'canvas-file', 'canvas');

    expect((await readDraftText(canvasKey))?.text).toBe('the Canvas draft');
    expect((await readDraftText(sidekickKey))?.text).toBe('the Sidekick draft');

    await clearWorkspaceDrafts('enterprise', 'shared-workspace');

    expect(await readDraftText(canvasKey)).toBeNull();
    expect(await readDraftAttachments(canvasKey)).toEqual([]);
  });

  it('clears one regional organization without touching a same-id organization in another region', async () => {
    const enterpriseKey = workstreamDraftKey('enterprise', 'shared-workspace', '1');
    const globalKey = workstreamDraftKey('global', 'shared-workspace', '2');
    await writeDraftText(enterpriseKey, 'leave this one');
    await writeDraftText(globalKey, 'keep this one');
    await cacheAttachment(enterpriseKey, 'enterprise-file', 'enterprise');
    await cacheAttachment(globalKey, 'global-file', 'global');

    await clearWorkspaceDrafts('enterprise', 'shared-workspace');

    expect(await readDraftText(enterpriseKey)).toBeNull();
    expect(await readDraftAttachments(enterpriseKey)).toEqual([]);
    expect((await readDraftText(globalKey))?.text).toBe('keep this one');
    expect(await readDraftAttachments(globalKey)).toHaveLength(1);
  });

  it('keeps main and private-child drafts separate without moving the released main key', () => {
    expect(workstreamDraftKey('global', 'workspace', 'parent')).toBe('workspace:global:workspace:workstream:parent');
    expect(workstreamDraftKey('global', 'workspace', 'parent', 'child')).toBe('workspace:global:workspace:workstream:parent:substream:child');
  });

  it('moves released single-organization draft keys into the regional namespace', async () => {
    await writeDraftText('workstream:room-one', 'existing room');
    await writeDraftText('new-workstream:shared-workspace', 'new room');
    await writeDraftText('new-automation:shared-workspace:draft-one', 'new automation');
    await cacheAttachment('workstream:room-one', 'legacy-file', 'legacy');

    await migrateLegacyDrafts('enterprise', 'shared-workspace');

    const roomKey = workstreamDraftKey('enterprise', 'shared-workspace', 'room-one');
    expect((await readDraftText(roomKey))?.text).toBe('existing room');
    expect(await readDraftAttachments(roomKey)).toHaveLength(1);
    expect((await readDraftText(newWorkstreamDraftKey('enterprise', 'shared-workspace')))?.text).toBe('new room');
    expect((await readDraftText(newAutomationDraftKey('enterprise', 'shared-workspace', 'draft-one')))?.text)
      .toBe('new automation');
    expect(await readDraftText('workstream:room-one')).toBeNull();
    expect(await readDraftAttachments('workstream:room-one')).toEqual([]);
  });

  it('degrades to empty results when IndexedDB is unavailable', async () => {
    closeDraftCache();
    vi.stubGlobal('indexedDB', undefined);

    await expect(writeDraftText('workstream:1', 'half a thought')).resolves.toBeUndefined();
    expect(await readDraftText('workstream:1')).toBeNull();
    expect(await readDraftAttachments('workstream:1')).toEqual([]);

    vi.unstubAllGlobals();
    closeDraftCache();
  });
});
