import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllLocalCache, clearWorkspaceLocalCache, closeLocalCache, localCacheScope } from './local-cache';
import { ResourcePreviewCache } from './resource-preview-cache';

const scope = localCacheScope('alice', 'global', 'organization');
const key = 'https://api.example.com/resources/image/preview';
const image = (text = 'first image', etag = '"revision-1"'): Response =>
  new Response(text, { headers: { 'content-type': 'image/png', etag } });

beforeEach(async () => {
  // jsdom's Blob has no arrayBuffer/text methods; use the Web implementation
  // while fake-indexeddb clones the actual buffers the cache persists.
  vi.stubGlobal('Blob', (await new Response('').blob()).constructor);
  await clearAllLocalCache();
});

describe('resource image preview cache', () => {
  it('shares one pending download and lets a viewer survive thumbnail cancellation', async () => {
    let finish!: (response: Response) => void;
    let arrived!: () => void;
    const started = new Promise<void>((resolve) => { arrived = resolve; });
    const fetchPreview = vi.fn<(etag: string | undefined, signal: AbortSignal) => Promise<Response>>(() => {
      arrived();
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    const cache = new ResourcePreviewCache();
    const thumbnailController = new AbortController();
    const thumbnail = cache.load(scope, key, fetchPreview, thumbnailController.signal);
    const viewer = cache.load(scope, key, fetchPreview);
    const canceled = expect(thumbnail).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    thumbnailController.abort();
    await canceled;
    expect(fetchPreview.mock.calls[0]?.[1].aborted).toBe(false);
    finish(image());
    expect(await (await viewer).text()).toBe('first image');
    expect(fetchPreview).toHaveBeenCalledTimes(1);
  });

  it('reopens the database and validates persisted bytes without downloading them again', async () => {
    let downloads = 0;
    const fetchPreview = vi.fn(async (etag: string | undefined) => {
      if (etag === '"revision-1"') return new Response(null, { status: 304 });
      downloads += 1;
      return image();
    });
    await new ResourcePreviewCache().load(scope, key, fetchPreview);
    closeLocalCache();
    const reopened = await new ResourcePreviewCache().load(scope, key, fetchPreview);
    expect(await reopened.text()).toBe('first image');
    expect(reopened.type).toBe('image/png');
    expect(downloads).toBe(1);
    expect(fetchPreview).toHaveBeenCalledTimes(2);
    expect(fetchPreview.mock.calls[1]?.[0]).toBe('"revision-1"');
  });

  it('replaces saved bytes when the server returns a newer image', async () => {
    const cache = new ResourcePreviewCache();
    await cache.load(scope, key, async () => image());
    const changed = await cache.load(scope, key, async () => image('second image', '"revision-2"'));
    expect(await changed.text()).toBe('second image');
    closeLocalCache();
    const reopened = await new ResourcePreviewCache().load(scope, key, async (etag) => {
      expect(etag).toBe('"revision-2"');
      return new Response(null, { status: 304 });
    });
    expect(await reopened.text()).toBe('second image');
  });

  it('never returns cached bytes after access is refused', async () => {
    const cache = new ResourcePreviewCache();
    await cache.load(scope, key, async () => image());
    await expect(cache.load(scope, key, async () => { throw new Error('resource_forbidden'); }))
      .rejects.toThrow('resource_forbidden');
  });

  it('isolates accounts, access classes, origins and workspace wipes', async () => {
    const cache = new ResourcePreviewCache();
    await cache.load(scope, key, async () => image());
    const fetchPreview = vi.fn<(etag: string | undefined, signal: AbortSignal) => Promise<Response>>(async () => image());
    await cache.load(localCacheScope('bob', 'global', 'organization'), key, fetchPreview);
    await cache.load(localCacheScope('alice', 'global', 'organization', 'guest'), key, fetchPreview);
    await cache.load(scope, 'https://other-api.example.com/resources/image/preview', fetchPreview);
    await clearWorkspaceLocalCache('alice', 'global', 'organization');
    await cache.load(scope, key, fetchPreview);
    expect(fetchPreview.mock.calls).toHaveLength(4);
    expect(fetchPreview.mock.calls.every((call) => call[0] === undefined)).toBe(true);
  });

  it('does not restore a download that completes after sign-out', async () => {
    let finish!: (response: Response) => void;
    let arrived!: () => void;
    const started = new Promise<void>((resolve) => { arrived = resolve; });
    const cache = new ResourcePreviewCache();
    const pending = cache.load(scope, key, () => {
      arrived();
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    await clearAllLocalCache();
    finish(image());
    await rejected;
    await cache.load(scope, key, async (etag) => {
      expect(etag).toBeUndefined();
      return image('new session');
    });
  });

  it('aborts unobserved loads and allows a new attempt immediately', async () => {
    let arrived!: () => void;
    const started = new Promise<void>((resolve) => { arrived = resolve; });
    const controller = new AbortController();
    const cache = new ResourcePreviewCache();
    const pending = cache.load(scope, key, (etag, signal) => new Promise<Response>((_resolve, reject) => {
      expect(etag).toBeUndefined();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      arrived();
    }), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    controller.abort();
    await rejected;
    expect(await (await cache.load(scope, key, async () => image())).text()).toBe('first image');
  });

  it('keeps downloading normally when disk persistence is unavailable', async () => {
    closeLocalCache();
    vi.stubGlobal('indexedDB', undefined);
    const cache = new ResourcePreviewCache();
    expect(await (await cache.load(scope, key, async () => image())).text()).toBe('first image');
    expect(await (await cache.load(scope, key, async () => image('second'))).text()).toBe('second');
  });
});
