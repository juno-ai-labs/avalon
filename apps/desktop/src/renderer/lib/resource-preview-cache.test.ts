import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllLocalCache, clearWorkspaceLocalCache, closeLocalCache, defineLocalCacheSlice, localCacheScope } from './local-cache';
import { ResourcePreviewCache } from './resource-preview-cache';

const scope = localCacheScope('alice', 'global', 'organization');
const key = 'https://api.example.com/resources/image/preview';
const image = (text = 'first image', etag = '"image-preview-v1:1:abc"'): Response =>
  new Response(text, { headers: { 'content-type': 'image/png', etag } });
const savedImages = defineLocalCacheSlice({ kind: 'resource-image-preview', version: 1, parse: (value) => value });

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
      if (etag === '"image-preview-v1:1:abc"') return new Response(null, { status: 304 });
      downloads += 1;
      return image();
    });
    await new ResourcePreviewCache().load(scope, key, fetchPreview);
    expect(await savedImages.entries(scope)).toEqual([{ key, subject: key }]);
    closeLocalCache();
    const reopened = await new ResourcePreviewCache().load(scope, key, fetchPreview);
    expect(await reopened.text()).toBe('first image');
    expect(reopened.type).toBe('image/png');
    expect(downloads).toBe(1);
    expect(fetchPreview).toHaveBeenCalledTimes(2);
    expect(fetchPreview.mock.calls[1]?.[0]).toBe('"image-preview-v1:1:abc"');
  });

  it('does not persist or revalidate image responses with raw storage ETags', async () => {
    const cache = new ResourcePreviewCache();
    const validators: (string | undefined)[] = [];
    const fetchPreview = async (etag: string | undefined): Promise<Response> => {
      validators.push(etag);
      return image('uncacheable image', '"r2-object-etag"');
    };
    expect(await (await cache.load(scope, key, fetchPreview)).text()).toBe('uncacheable image');
    expect(await savedImages.entries(scope)).toEqual([]);
    expect(await (await cache.load(scope, key, fetchPreview)).text()).toBe('uncacheable image');
    expect(validators).toEqual([undefined, undefined]);
    expect(await savedImages.entries(scope)).toEqual([]);
  });

  it('discards a persisted raw storage ETag instead of sending it back', async () => {
    await savedImages.write(scope, key, { etag: '"r2-object-etag"', mimeType: 'image/png', bytes: new ArrayBuffer(1) });
    const loaded = await new ResourcePreviewCache().load(scope, key, async (etag) => {
      expect(etag).toBeUndefined();
      return image('uncacheable image', '"r2-object-etag"');
    });
    expect(await loaded.text()).toBe('uncacheable image');
    expect(await savedImages.entries(scope)).toEqual([]);
  });

  it.each(['image/png', 'application/pdf'])('removes replaced image bytes when the new %s response is uncacheable', async (mimeType) => {
    const cache = new ResourcePreviewCache();
    await cache.load(scope, key, async () => image());
    expect(await savedImages.entries(scope)).toEqual([{ key, subject: key }]);
    const validators: (string | undefined)[] = [];
    const fetchPreview = async (etag: string | undefined): Promise<Response> => {
      validators.push(etag);
      return new Response('replacement preview', { headers: { 'content-type': mimeType, etag: '"raw-storage-etag"' } });
    };
    expect(await (await cache.load(scope, key, fetchPreview)).text()).toBe('replacement preview');
    expect(await savedImages.entries(scope)).toEqual([]);
    expect(await (await cache.load(scope, key, fetchPreview)).text()).toBe('replacement preview');
    expect(validators).toEqual(['"image-preview-v1:1:abc"', undefined]);
  });

  it('replaces saved bytes when the server returns a newer image', async () => {
    const cache = new ResourcePreviewCache();
    await cache.load(scope, key, async () => image());
    const changed = await cache.load(scope, key, async () => image('second image', '"image-preview-v1:2:def"'));
    expect(await changed.text()).toBe('second image');
    expect(await savedImages.entries(scope)).toEqual([{ key, subject: key }]);
    closeLocalCache();
    const reopened = await new ResourcePreviewCache().load(scope, key, async (etag) => {
      expect(etag).toBe('"image-preview-v1:2:def"');
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

  it.each([403, 404])('removes saved bytes after a %s response', async (status) => {
    const cache = new ResourcePreviewCache();
    await cache.load(scope, key, async () => image());
    expect(await savedImages.entries(scope)).toEqual([{ key, subject: key }]);
    await expect(cache.load(scope, key, async () => { throw Object.assign(new Error('access_refused'), { status }); }))
      .rejects.toThrow('access_refused');
    expect(await savedImages.entries(scope)).toEqual([]);
  });

  it('retries a rejected conditional request once as a plain read and removes its saved validator', async () => {
    const cache = new ResourcePreviewCache();
    await cache.load(scope, key, async () => image());
    expect(await savedImages.entries(scope)).toEqual([{ key, subject: key }]);
    const validators: (string | undefined)[] = [];
    const loaded = await cache.load(scope, key, async (etag) => {
      validators.push(etag);
      if (etag) throw Object.assign(new Error('preflight rejected'), { code: 'network_error' });
      return image('older API bytes', '"raw-storage-etag"');
    });
    expect(await loaded.text()).toBe('older API bytes');
    expect(validators).toEqual(['"image-preview-v1:1:abc"', undefined]);
    expect(await savedImages.entries(scope)).toEqual([]);
  });

  it('preserves saved bytes when the plain retry body fails before a replacement loads', async () => {
    const cache = new ResourcePreviewCache();
    await cache.load(scope, key, async () => image());
    expect(await savedImages.entries(scope)).toEqual([{ key, subject: key }]);
    const validators: (string | undefined)[] = [];
    const failed = cache.load(scope, key, async (etag) => {
      validators.push(etag);
      if (etag) throw Object.assign(new Error('preflight rejected'), { code: 'network_error' });
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error('download interrupted')); },
      }), { headers: { 'content-type': 'image/png', etag: '"raw-storage-etag"' } });
    });
    await expect(failed).rejects.toThrow('download interrupted');
    expect(validators).toEqual(['"image-preview-v1:1:abc"', undefined]);
    expect(await savedImages.entries(scope)).toEqual([{ key, subject: key }]);
    const reopened = await cache.load(scope, key, async (etag) => {
      expect(etag).toBe('"image-preview-v1:1:abc"');
      return new Response(null, { status: 304 });
    });
    expect(await reopened.text()).toBe('first image');
  });

  it('does not replay uncached network failures or server errors', async () => {
    const cache = new ResourcePreviewCache();
    const networkFailure = vi.fn(async () => { throw Object.assign(new Error('offline'), { code: 'network_error' }); });
    await expect(cache.load(scope, key, networkFailure)).rejects.toThrow('offline');
    expect(networkFailure).toHaveBeenCalledTimes(1);
    await cache.load(scope, key, async () => image());
    const unavailable = vi.fn(async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); });
    await expect(cache.load(scope, key, unavailable)).rejects.toThrow('unavailable');
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(await savedImages.entries(scope)).toEqual([{ key, subject: key }]);
    networkFailure.mockClear();
    await expect(cache.load(scope, key, networkFailure)).rejects.toThrow('offline');
    expect(networkFailure).toHaveBeenCalledTimes(2);
    expect(await savedImages.entries(scope)).toEqual([{ key, subject: key }]);
  });

  it('rejects uncacheable streaming bytes when sign-out happens after headers', async () => {
    let arrived!: () => void;
    let finish!: () => void;
    const reading = new Promise<void>((resolve) => { arrived = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    const response = new Response(new ReadableStream({
      async pull(controller) {
        arrived();
        await release;
        controller.enqueue(new TextEncoder().encode('late image bytes'));
        controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png' } });
    const pending = new ResourcePreviewCache().load(scope, key, async () => response);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await reading;
    await clearAllLocalCache();
    finish();
    await rejected;
  });

  it('fences a download when another renderer wipes the shared database', async () => {
    let arrived!: () => void;
    let finish!: (response: Response) => void;
    const started = new Promise<void>((resolve) => { arrived = resolve; });
    const pending = new ResourcePreviewCache().load(scope, key, () => {
      arrived();
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    // Independent module state models the other tab's local epoch, while both
    // clients use the same IndexedDB implementation and database.
    vi.resetModules();
    const otherRenderer = await import('./local-cache');
    try {
      await otherRenderer.clearWorkspaceLocalCache('alice', 'global', 'organization');
      finish(image());
      await rejected;
      expect(await savedImages.entries(scope)).toEqual([]);
    } finally {
      otherRenderer.closeLocalCache();
    }
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
