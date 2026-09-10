import { hashKey, type QueryCacheNotifyEvent, type QueryClient } from '@tanstack/react-query';
import { localCacheEpoch } from './local-cache';

/**
 * How long a burst of cache writes is allowed to run before the mirror takes
 * one picture of it. A live run upserts a turn or an activity several times a
 * second, and each of those is a React Query write; persisting every one would
 * put an IndexedDB transaction behind every frame for a value that only has to
 * be right the next time the application launches. The first write in a burst
 * starts the clock and later ones do not extend it, so the disk is never more
 * than this far behind the screen. The same coalescing idea as the draft
 * cache's keystroke debounce, sized for a run rather than a typist.
 */
export const LOCAL_CACHE_WRITE_COALESCE_MS = 1_000;

export interface QueryMirror {
  /** Stop observing. A write that was pending is issued now, from the current value. */
  stop(): void;
  /** Issue the pending write now, if there is one. */
  flush(): Promise<void>;
}

/**
 * Keep a slice on disk equal to what a family of query-cache entries holds.
 *
 * The mirror is deliberately one-directional and dumb: it does not know what
 * the queries mean, only that a change to any of them is a reason to take a
 * new `snapshot()` and hand it to `write`. A snapshot of `null` means there is
 * nothing worth keeping right now — a cache that holds a seed rather than
 * something the socket said, a query that was evicted — and no write happens.
 * Who decides that is the slice, which is what keeps this reusable for the next
 * family of entries.
 */
export function mirrorQueriesToLocalCache<T>(queryClient: QueryClient, options: {
  matches: (queryKey: readonly unknown[]) => boolean;
  snapshot: () => T | null;
  write: (value: T, atEpoch: number) => Promise<unknown>;
}): QueryMirror {
  let timer: number | null = null;
  let pendingEpoch = localCacheEpoch();
  let stopped = false;
  const flush = async (): Promise<void> => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    const value = options.snapshot();
    if (value === null) return;
    await options.write(value, pendingEpoch);
  };
  const schedule = (): void => {
    if (stopped || timer !== null) return;
    // The epoch the content belongs to is the one in force when the change was
    // seen; a wipe between now and the write moves it on and the write drops.
    pendingEpoch = localCacheEpoch();
    timer = window.setTimeout(() => {
      timer = null;
      void flush();
    }, LOCAL_CACHE_WRITE_COALESCE_MS);
  };
  const unsubscribe = queryClient.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (!options.matches(event.query.queryKey)) return;
    schedule();
  });
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      if (timer !== null) void flush();
    },
    flush,
  };
}

/** Whether `queryKey` is exactly one of `keys`, by React Query's own hashing. */
export function queryKeyIsOneOf(keys: readonly (readonly unknown[])[]): (queryKey: readonly unknown[]) => boolean {
  const hashes = new Set(keys.map((key) => hashKey([...key])));
  return (queryKey) => hashes.has(hashKey([...queryKey]));
}
