import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import type * as DraftCache from './draft-cache';
import { clearAllDrafts, readDraftAttachments } from './draft-cache';

/** Lets one test hold the cache read open long enough to lose a race to a drop. */
let readDelayMs = 0;
vi.mock('./draft-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof DraftCache>();
  return {
    ...actual,
    readDraftAttachments: async (draftKey: string) => {
      if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      return actual.readDraftAttachments(draftKey);
    },
  };
});
import { type FileAttachmentsApi, useFileAttachments } from './use-file-attachments';
import type { WorkstreamResource } from './types';

const draftKey = 'workstream:019fcc00-0000-7000-8000-0000000000ff';

const resource: WorkstreamResource = {
  id: '019fcc00-0000-7000-8000-000000000001',
  title: 'notes.txt',
  resourceType: 'uploaded_file',
  provider: 'rally_upload',
  mimeType: 'text/plain',
  watchEnabled: false,
  watchStatus: 'unsupported',
  contentAvailable: true,
  sizeBytes: 5,
  currentVersion: 1,
  relationshipType: 'attachment',
  direction: 'source',
};

function apiMock(overrides: Partial<FileAttachmentsApi> = {}): FileAttachmentsApi {
  return {
    uploadResource: vi.fn(async () => resource),
    deleteDraftResource: vi.fn(async () => undefined),
    ...overrides,
  } satisfies FileAttachmentsApi;
}

describe('useFileAttachments', () => {
  beforeEach(async () => {
    await clearAllDrafts();
    readDelayMs = 0;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uploads immediately with a stable client draft ID and becomes ready', async () => {
    const uploadResource = vi.fn(async (_file: File, _draftId: string, onProgress?: (value: number) => void) => {
      onProgress?.(47);
      return resource;
    });
    const api = apiMock({ uploadResource });
    const { result } = renderHook(() => useFileAttachments(api, draftKey));

    act(() => result.current.addFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })]));

    await waitFor(() => expect(result.current.attachments[0]?.status).toBe('ready'));
    const draftId = result.current.attachments[0]?.localId;
    expect(draftId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(uploadResource).toHaveBeenCalledWith(expect.any(File), draftId, expect.any(Function), expect.any(AbortSignal));
    expect(result.current.attachments[0]?.progress).toBe(100);
    expect(result.current.ready).toHaveLength(1);
  });

  it('deletes the server draft when a ready attachment is removed', async () => {
    const api = apiMock();
    const { result } = renderHook(() => useFileAttachments(api, draftKey));
    act(() => result.current.addFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })]));
    await waitFor(() => expect(result.current.ready).toHaveLength(1));

    act(() => result.current.removeAttachment(result.current.attachments[0]!.localId));

    await waitFor(() => expect(api.deleteDraftResource).toHaveBeenCalledWith(resource.id));
    expect(result.current.attachments).toHaveLength(0);
  });

  it('deletes a draft again when an aborted upload still completes upstream', async () => {
    let finishUpload: ((value: WorkstreamResource) => void) | undefined;
    const uploadResource = vi.fn(() => new Promise<WorkstreamResource>((resolve) => {
      finishUpload = resolve;
    }));
    const api = apiMock({ uploadResource });
    const { result } = renderHook(() => useFileAttachments(api, draftKey));
    act(() => result.current.addFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })]));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    const draftId = result.current.attachments[0]!.localId;

    act(() => result.current.removeAttachment(draftId));
    await waitFor(() => expect(api.deleteDraftResource).toHaveBeenCalledWith(draftId));
    act(() => finishUpload?.(resource));

    await waitFor(() => expect(api.deleteDraftResource).toHaveBeenCalledWith(resource.id));
    expect(result.current.attachments).toHaveLength(0);
  });

  it('rejects empty and oversized files locally without uploading them', async () => {
    const api = apiMock();
    const { result } = renderHook(() => useFileAttachments(api, draftKey));
    const oversized = new File(['x'], 'huge.bin');
    Object.defineProperty(oversized, 'size', { value: 25_000_001 });

    act(() => result.current.addFiles([new File([], 'empty.txt'), oversized]));

    await waitFor(() => expect(result.current.attachments).toHaveLength(2));
    expect(result.current.attachments.map((attachment) => attachment.status)).toEqual(['failed', 'failed']);
    expect(result.current.attachments.map((attachment) => attachment.error)).toEqual([
      'Empty files cannot be attached.',
      'Files must be 25 MB or smaller.',
    ]);
    expect(api.uploadResource).not.toHaveBeenCalled();
  });

  it('keeps the first ten files and reports overflow', async () => {
    const api = apiMock();
    const { result } = renderHook(() => useFileAttachments(api, draftKey));
    const files = Array.from({ length: 12 }, (_, index) => new File([String(index)], `file-${index}.txt`));

    act(() => result.current.addFiles(files));

    await waitFor(() => expect(result.current.attachments).toHaveLength(10));
    expect(result.current.error).toBe('You can attach up to 10 files to one message.');
    await waitFor(() => expect(result.current.ready).toHaveLength(10));

    act(() => result.current.removeAttachment(result.current.attachments[0]!.localId));
    expect(result.current.error).toBeUndefined();
  });

  it('marks failed uploads and supports an explicit retry', async () => {
    const uploadResource = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(resource);
    const api = apiMock({ uploadResource });
    const { result } = renderHook(() => useFileAttachments(api, draftKey));
    act(() => result.current.addFiles([new File(['hello'], 'notes.txt')]));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe('failed'));

    act(() => result.current.retryAttachment(result.current.attachments[0]!.localId));

    await waitFor(() => expect(result.current.attachments[0]?.status).toBe('ready'));
    expect(uploadResource).toHaveBeenCalledTimes(2);
  });

  it('uses SHA-256 to skip duplicate files within one pending message', async () => {
    const uploadResource = vi.fn(async () => resource);
    const api = apiMock({ uploadResource });
    const { result } = renderHook(() => useFileAttachments(api, draftKey));

    act(() => result.current.addFiles([
      new File(['same bytes'], 'first.txt', { type: 'text/plain' }),
      new File(['same bytes'], 'renamed.md', { type: 'text/markdown' }),
      new File(['different bytes'], 'first.txt', { type: 'text/plain' }),
    ]));

    await waitFor(() => expect(result.current.ready).toHaveLength(2));
    expect(result.current.attachments.map((attachment) => attachment.file.name)).toEqual(['first.txt', 'first.txt']);
    expect(result.current.attachments[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.current.error).toBe('Skipped 1 duplicate attachment.');
    expect(uploadResource).toHaveBeenCalledTimes(2);
  });

  it('appends to the attachments already pending, from the picker or a drop', async () => {
    const api = apiMock({ uploadResource: vi.fn(async (file: File) => ({ ...resource, id: file.name })) });
    const { result } = renderHook(() => useFileAttachments(api, draftKey));
    act(() => result.current.addFiles([new File(['one'], 'first.txt')]));
    await waitFor(() => expect(result.current.ready).toHaveLength(1));

    act(() => result.current.addFiles([new File(['two'], 'second.txt')]));
    await waitFor(() => expect(result.current.ready).toHaveLength(2));

    act(() => result.current.addFiles([new File(['three'], 'third.txt')]));

    await waitFor(() => expect(result.current.ready).toHaveLength(3));
    expect(result.current.attachments.map((attachment) => attachment.file.name))
      .toEqual(['first.txt', 'second.txt', 'third.txt']);
    expect(result.current.error).toBeUndefined();
  });

  it('restores cached attachments in order without uploading them again', async () => {
    const api = apiMock();
    const first = renderHook(() => useFileAttachments(api, draftKey));
    act(() => first.result.current.addFiles([
      new File(['one'], 'first.txt', { type: 'text/plain' }),
      new File(['two'], 'second.png', { type: 'image/png' }),
    ]));
    await waitFor(() => expect(first.result.current.ready).toHaveLength(2));
    first.unmount();

    const restored = renderHook(() => useFileAttachments(api, draftKey));

    await waitFor(() => expect(restored.result.current.attachments).toHaveLength(2));
    expect(restored.result.current.attachments.map((attachment) => attachment.file.name))
      .toEqual(['first.txt', 'second.png']);
    expect(restored.result.current.ready).toHaveLength(2);
    expect(restored.result.current.attachments[1]?.previewUrl).toBe('blob:preview');
    expect(await restored.result.current.attachments[0]!.file.text()).toBe('one');
    expect(api.uploadResource).toHaveBeenCalledTimes(2);
    expect(api.deleteDraftResource).not.toHaveBeenCalled();
  });

  it('finishes an upload that was interrupted before the draft was recorded', async () => {
    const uploadResource = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new ApiError('This attachment draft already exists', 409, 'attachment_draft_exists'));
    const api = apiMock({ uploadResource });
    const first = renderHook(() => useFileAttachments(api, draftKey));
    act(() => first.result.current.addFiles([new File(['one'], 'first.txt')]));
    await waitFor(() => expect(first.result.current.attachments[0]?.status).toBe('failed'));
    const localId = first.result.current.attachments[0]!.localId;
    first.unmount();

    const restored = renderHook(() => useFileAttachments(api, draftKey));

    await waitFor(() => expect(restored.result.current.ready).toHaveLength(1));
    expect(restored.result.current.attachments[0]?.resource?.id).toBe(localId);
  });

  it('swaps cached attachments when the composer moves to another draft', async () => {
    const api = apiMock();
    const { result, rerender } = renderHook(({ key }) => useFileAttachments(api, key), {
      initialProps: { key: draftKey },
    });
    act(() => result.current.addFiles([new File(['one'], 'first.txt')]));
    await waitFor(() => expect(result.current.ready).toHaveLength(1));

    rerender({ key: 'workstream:other' });
    await waitFor(() => expect(result.current.attachments).toHaveLength(0));

    rerender({ key: draftKey });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.attachments[0]?.file.name).toBe('first.txt');
  });

  it('drops the cached copy when an attachment is removed or sent', async () => {
    const api = apiMock({ uploadResource: vi.fn(async (file: File) => ({ ...resource, id: file.name })) });
    const { result } = renderHook(() => useFileAttachments(api, draftKey));
    act(() => result.current.addFiles([new File(['one'], 'first.txt'), new File(['two'], 'second.txt')]));
    await waitFor(() => expect(result.current.ready).toHaveLength(2));

    act(() => result.current.removeAttachment(result.current.attachments[0]!.localId));
    await waitFor(async () => expect(await readDraftAttachments(draftKey)).toHaveLength(1));

    const sent = result.current.attachments[0]!.localId;
    act(() => result.current.consume([sent]));

    await waitFor(async () => expect(await readDraftAttachments(draftKey)).toHaveLength(0));
    expect(result.current.attachments).toHaveLength(0);
  });

  it('settles the ten-file limit when a drop races the cache read', async () => {
    const api = apiMock({ uploadResource: vi.fn(async (file: File) => ({ ...resource, id: file.name })) });
    const seeded = renderHook(() => useFileAttachments(api, draftKey));
    act(() => seeded.result.current.addFiles(
      Array.from({ length: 9 }, (_, index) => new File([`cached-${index}`], `cached-${index}.txt`)),
    ));
    await waitFor(() => expect(seeded.result.current.ready).toHaveLength(9));
    seeded.unmount();

    // The drop lands before the cached nine are known, so it is counted against
    // an empty composer and has to be reconciled once they arrive.
    readDelayMs = 60;
    const { result } = renderHook(() => useFileAttachments(api, draftKey));
    act(() => result.current.addFiles(
      Array.from({ length: 10 }, (_, index) => new File([`dropped-${index}`], `dropped-${index}.txt`)),
    ));

    // Wait for the cached nine to arrive, not merely for ten tiles: the ten
    // dropped files satisfy that count on their own, before reconciliation.
    await waitFor(() => expect(result.current.attachments[0]?.file.name).toBe('cached-0.txt'));
    expect(result.current.attachments).toHaveLength(10);
    expect(result.current.error).toBe('You can attach up to 10 files to one message.');
    await waitFor(async () => expect(await readDraftAttachments(draftKey)).toHaveLength(10));
    expect(result.current.attachments.map((attachment) => attachment.file.name))
      .toEqual([...Array.from({ length: 9 }, (_, index) => `cached-${index}.txt`), 'dropped-0.txt']);
    // Every file that did not fit released its draft resource rather than
    // lingering upstream, invisible and unremovable.
    await waitFor(() => {
      for (let index = 1; index < 10; index += 1) {
        expect(api.deleteDraftResource).toHaveBeenCalledWith(`dropped-${index}.txt`);
      }
    });
  });

  it('attributes a file added on the render that switches drafts to the new one', async () => {
    const api = apiMock({ uploadResource: vi.fn(async (file: File) => ({ ...resource, id: file.name })) });
    const { result, rerender } = renderHook(({ key }) => useFileAttachments(api, key), {
      initialProps: { key: draftKey },
    });
    await waitFor(() => expect(result.current.attachments).toHaveLength(0));

    // The add is issued from the render that changed the key, before the
    // hydration effect for the new key has run.
    rerender({ key: 'workstream:other' });
    act(() => result.current.addFiles([new File(['switched'], 'switched.txt')]));

    await waitFor(() => expect(result.current.ready).toHaveLength(1));
    await waitFor(async () => expect(await readDraftAttachments('workstream:other')).toHaveLength(1));
    expect(await readDraftAttachments(draftKey)).toEqual([]);
  });

  it('does not cache a file that could never be sent', async () => {
    const api = apiMock();
    const { result } = renderHook(() => useFileAttachments(api, draftKey));

    act(() => result.current.addFiles([new File([], 'empty.txt')]));

    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(await readDraftAttachments(draftKey)).toEqual([]);
  });
});
