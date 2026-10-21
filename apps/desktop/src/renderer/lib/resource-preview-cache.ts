import { defineLocalCacheSlice, localCacheEpoch } from './local-cache';

interface CachedPreview {
  etag: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

const previews = defineLocalCacheSlice<CachedPreview>({
  kind: 'resource-image-preview',
  version: 1,
  parse(value) {
    if (!value || typeof value !== 'object') return null;
    const entry = value as Partial<CachedPreview>;
    return typeof entry.etag === 'string' && typeof entry.mimeType === 'string'
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

  load(scope: string, key: string, fetchPreview: FetchPreview, signal?: AbortSignal): Promise<Blob> {
    signal?.throwIfAborted();
    const epoch = localCacheEpoch();
    const identity = JSON.stringify([scope, key, epoch]);
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
    const cached = await previews.read(scope, key);
    signal.throwIfAborted();
    if (epoch !== localCacheEpoch()) throw new DOMException('The attachment session changed.', 'AbortError');
    const response = await fetchPreview(cached?.etag, signal);
    signal.throwIfAborted();
    if (epoch !== localCacheEpoch()) throw new DOMException('The attachment session changed.', 'AbortError');
    if (response.status === 304 && cached) return new Blob([cached.bytes], { type: cached.mimeType });
    const mimeType = response.headers.get('content-type') ?? '';
    const etag = response.headers.get('etag');
    // Only the API's original-image path supplies a preview validator. Other
    // formats keep their existing derivative/conversion lifecycle.
    if (!etag || !mimeType.startsWith('image/')) return response.blob();
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();
    if (epoch !== localCacheEpoch()) throw new DOMException('The attachment session changed.', 'AbortError');
    await previews.write(scope, key, { etag, mimeType, bytes }, key, epoch);
    if (epoch !== localCacheEpoch()) throw new DOMException('The attachment session changed.', 'AbortError');
    return new Blob([bytes], { type: mimeType });
  }
}
