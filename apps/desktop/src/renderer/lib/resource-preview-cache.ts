import { defineLocalCacheSlice, localCacheEpoch, localCacheGeneration } from './local-cache';

interface CachedPreview {
  etag: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

/** Raw R2 ETags cannot be revalidated by the preview endpoint. */
function isPreviewValidator(etag: unknown): etag is string {
  return typeof etag === 'string' && etag.startsWith('"image-preview-v1:');
}

const previews = defineLocalCacheSlice<CachedPreview>({
  kind: 'resource-image-preview',
  version: 1,
  parse(value) {
    if (!value || typeof value !== 'object') return null;
    const entry = value as Partial<CachedPreview>;
    return isPreviewValidator(entry.etag) && typeof entry.mimeType === 'string'
      && Object.prototype.toString.call(entry.bytes) === '[object ArrayBuffer]' ? entry as CachedPreview : null;
  },
});

type FetchPreview = (etag: string | undefined, signal: AbortSignal) => Promise<Response>;
interface PendingPreview {
  controller: AbortController;
  promise: Promise<Blob>;
  readers: number;
}

/** One download for concurrent readers; account-scoped bytes survive renderer/app restarts.
 * Every new read still validates access and content identity with the API.
 */
export class ResourcePreviewCache {
  private readonly pending = new Map<string, PendingPreview>();

  load(scope: string, key: string, fetchPreview: FetchPreview, signal?: AbortSignal, version?: number): Promise<Blob> {
    signal?.throwIfAborted();
    const epoch = localCacheEpoch(scope);
    const identity = JSON.stringify([scope, key, epoch, version]);
    let request = this.pending.get(identity);
    if (!request) {
      const controller = new AbortController();
      const promise = this.read(scope, key, epoch, fetchPreview, controller.signal);
      request = { controller, promise, readers: 0 };
      this.pending.set(identity, request);
      const finished = request;
      void promise.finally(() => {
        if (this.pending.get(identity) === finished) this.pending.delete(identity);
      }).catch(() => undefined);
    }
    const shared = request;
    shared.readers += 1;
    return new Promise<Blob>((resolve, reject) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        signal?.removeEventListener('abort', aborted);
        shared.readers -= 1;
        if (shared.readers === 0) {
          shared.controller.abort();
          if (this.pending.get(identity) === shared) this.pending.delete(identity);
        }
      };
      const aborted = (): void => { release(); reject(signal?.reason); };
      signal?.addEventListener('abort', aborted, { once: true });
      shared.promise.then((blob) => { if (!released) { release(); resolve(blob); } },
        (error: unknown) => { if (!released) { release(); reject(error); } });
    });
  }

  private async read(scope: string, key: string, epoch: number, fetchPreview: FetchPreview, signal: AbortSignal): Promise<Blob> {
    const assertCurrent = (): void => {
      signal.throwIfAborted();
      if (epoch !== localCacheEpoch(scope)) throw new DOMException('The attachment session changed.', 'AbortError');
    };
    const generation = await localCacheGeneration(scope);
    assertCurrent();
    const assertSharedCurrent = async (): Promise<void> => {
      const currentGeneration = await localCacheGeneration(scope);
      assertCurrent();
      if (generation !== currentGeneration) throw new DOMException('The attachment session changed.', 'AbortError');
    };
    const cached = await previews.read(scope, key);
    assertCurrent();
    const fetchCurrent = async (etag: string | undefined): Promise<Response> => {
      try {
        return await fetchPreview(etag, signal);
      } catch (error: unknown) {
        assertCurrent();
        if (error instanceof Error && 'status' in error && (error.status === 403 || error.status === 404)) {
          await previews.remove(scope, key);
        }
        throw error;
      }
    };
    let response: Response;
    try {
      response = await fetchCurrent(cached?.etag);
    } catch (error: unknown) {
      if (!cached || !(error instanceof Error) || !('code' in error) || error.code !== 'network_error') throw error;
      // A rolled-back API may reject If-None-Match in its CORS preflight.
      // Retry this read once without the feature; never replay mutations.
      await assertSharedCurrent();
      response = await fetchCurrent(undefined);
      // Headers alone are not a successful replacement. Keep saved bytes until
      // the body completes; the branches below then replace or remove the row.
    }
    assertCurrent();
    if (response.status === 304 && cached) {
      await assertSharedCurrent();
      return new Blob([cached.bytes], { type: cached.mimeType });
    }
    const mimeType = response.headers.get('content-type') ?? '';
    const etag = response.headers.get('etag');
    // Other R2-backed responses also expose ETags, but only this versioned
    // preview validator supports a bodyless response on a subsequent read.
    if (!isPreviewValidator(etag) || !mimeType.startsWith('image/')) {
      const blob = await response.blob();
      await assertSharedCurrent();
      // A successful replacement invalidates the old image even when its new
      // representation cannot be saved. Keep storage work off the display path.
      if (cached) void previews.remove(scope, key);
      return blob;
    }
    const bytes = await response.arrayBuffer();
    await assertSharedCurrent();
    // Persist in the background. The shared generation is checked atomically
    // with the write, so another tab's wipe also fences this queued save.
    void previews.write(scope, key, { etag, mimeType, bytes }, key, epoch, generation);
    return new Blob([bytes], { type: mimeType });
  }
}
