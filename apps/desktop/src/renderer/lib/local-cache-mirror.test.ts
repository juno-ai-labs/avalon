import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllLocalCache, closeLocalCache, localCacheEpoch } from './local-cache';
import { LOCAL_CACHE_WRITE_COALESCE_MS, mirrorQueriesToLocalCache, queryKeyIsOneOf } from './local-cache-mirror';

describe('query mirror', () => {
  afterEach(() => {
    vi.useRealTimers();
    closeLocalCache();
  });

  function mirrorOf(queryClient: QueryClient, write = vi.fn<(value: string, atEpoch: number) => Promise<void>>(async () => undefined)) {
    const mirror = mirrorQueriesToLocalCache<string>(queryClient, {
      matches: queryKeyIsOneOf([['thing']]),
      snapshot: () => queryClient.getQueryData<string>(['thing']) ?? null,
      write,
    });
    return { mirror, write };
  }

  it('writes one picture of a burst, after the coalescing window', () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const { mirror, write } = mirrorOf(queryClient);

    queryClient.setQueryData(['thing'], 'one');
    queryClient.setQueryData(['thing'], 'two');
    vi.advanceTimersByTime(LOCAL_CACHE_WRITE_COALESCE_MS - 1);
    queryClient.setQueryData(['thing'], 'three');
    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe('three');
    mirror.stop();
  });

  it('ignores queries outside its family and skips a snapshot with nothing to keep', () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const { mirror, write } = mirrorOf(queryClient);

    queryClient.setQueryData(['other'], 'noise');
    vi.advanceTimersByTime(LOCAL_CACHE_WRITE_COALESCE_MS);
    expect(write).not.toHaveBeenCalled();

    queryClient.setQueryData(['thing'], 'present');
    queryClient.removeQueries({ queryKey: ['thing'], exact: true });
    vi.advanceTimersByTime(LOCAL_CACHE_WRITE_COALESCE_MS);
    expect(write).not.toHaveBeenCalled();
    mirror.stop();
  });

  it('issues a pending write when stopped, and observes nothing afterwards', () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const { mirror, write } = mirrorOf(queryClient);

    queryClient.setQueryData(['thing'], 'pending');
    mirror.stop();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe('pending');

    queryClient.setQueryData(['thing'], 'after stop');
    vi.advanceTimersByTime(LOCAL_CACHE_WRITE_COALESCE_MS);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('stamps a write with the epoch in force when the change was seen', async () => {
    const queryClient = new QueryClient();
    const { mirror, write } = mirrorOf(queryClient);
    const before = localCacheEpoch();

    queryClient.setQueryData(['thing'], 'typed before sign-out');
    await clearAllLocalCache();
    await mirror.flush();

    // The slice's write is what refuses it; the mirror's job is to hand over
    // the epoch the content belongs to rather than the one it flushed under.
    expect(write).toHaveBeenCalledWith('typed before sign-out', before);
    expect(localCacheEpoch()).not.toBe(before);
    mirror.stop();
  });
});
