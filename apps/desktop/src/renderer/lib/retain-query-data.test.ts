import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retainQueryData } from './retain-query-data';

afterEach(() => vi.useRealTimers());

describe('retainQueryData', () => {
  it('preserves a query fetcher and collection policy after releasing its hold', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const queryKey = ['also-fetched'];
    const fetch = vi.fn(async () => 'fetched');
    // This test owns the collection clock, so its policy is intentionally
    // shorter than the library default to detect retention overwriting it.
    await client.fetchQuery({ queryKey, queryFn: fetch, gcTime: 60_000 });
    const release = retainQueryData(client, [queryKey]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    release();
    await client.refetchQueries({ queryKey });
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(client.getQueryData(queryKey)).toBeUndefined();
    client.clear();
  });

  it('keeps existing and future state without readers or fetches until its last producer releases it', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const existing = ['existing'];
    const future = ['future'];
    const unrelated = ['unrelated'];
    client.setQueryData(existing, ['before']);
    client.setQueryData(unrelated, ['collect me']);
    const fetch = vi.fn(async () => ['fetched']);
    client.setQueryDefaults(future, { queryFn: fetch });
    const release = retainQueryData(client, [existing, future]);
    const releaseOther = retainQueryData(client, [future]);
    expect(client.getQueryCache().find({ queryKey: future })).toBeUndefined();
    client.setQueryData(future, ['pushed']);
    const screen = new QueryObserver(client, { queryKey: future, enabled: false });
    const leave = screen.subscribe(() => undefined);
    leave();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.getQueryData(existing)).toEqual(['before']);
    expect(client.getQueryData(future)).toEqual(['pushed']);
    expect(client.getQueryData(unrelated)).toBeUndefined();
    await client.invalidateQueries();
    expect(fetch).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.getQueryData(existing)).toBeUndefined();
    expect(client.getQueryData(future)).toEqual(['pushed']);
    releaseOther();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.getQueryData(future)).toBeUndefined();
    client.clear();
  });

  it('honors eviction without resurrecting data and retains a later replacement', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const key = ['conversation', 'a'];
    const release = retainQueryData(client, [key]);
    client.setQueryData(key, 'old');
    client.removeQueries({ queryKey: key, exact: true });
    expect(client.getQueryCache().find({ queryKey: key })).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.getQueryData(key)).toBeUndefined();
    client.setQueryData(key, 'replacement');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.getQueryData(key)).toBe('replacement');
    client.clear();
    expect(client.getQueryData(key)).toBeUndefined();
    release();
    release();
    client.setQueryData(key, 'after release');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.getQueryData(key)).toBeUndefined();
    client.clear();
  });
});
