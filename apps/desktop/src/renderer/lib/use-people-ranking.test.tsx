import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PeopleRanking } from '@rally/contracts';
import { usePeopleRanking } from './use-people-ranking';

describe('usePeopleRanking', () => {
  it('waits for the title menu to open, keeps the previous ranking usable, and shares an in-flight refresh across repeated opens', async () => {
    const first: PeopleRanking = { channel: ['alice'], organization: ['alice'] };
    const next: PeopleRanking = { channel: ['bob'], organization: ['bob', 'alice'] };
    let finish!: (value: PeopleRanking) => void;
    let refreshSignal: AbortSignal | undefined;
    const getPeopleRanking = vi.fn()
      .mockResolvedValueOnce(first)
      .mockImplementation((_channelId: string | null, signal?: AbortSignal) => {
        refreshSignal = signal;
        return new Promise<PeopleRanking>((resolve) => { finish = resolve; });
      });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, unmount } = renderHook(() => usePeopleRanking({ getPeopleRanking }, 'org', 'reader', 'channel', true), { wrapper: Wrapper });
    expect(getPeopleRanking).not.toHaveBeenCalled();
    act(() => result.current.onOpen());
    await waitFor(() => expect(result.current.ranking).toEqual(first));
    act(() => result.current.onOpen());
    await waitFor(() => expect(getPeopleRanking).toHaveBeenCalledTimes(2));
    expect(result.current.ranking).toEqual(first);
    act(() => result.current.onOpen());
    expect(getPeopleRanking).toHaveBeenCalledTimes(2);
    expect(refreshSignal?.aborted).toBe(false);
    await act(async () => { finish(next); });
    await waitFor(() => expect(result.current.ranking).toEqual(next));
    unmount();
    client.clear();
  });

  it.each(['guest', 'missing API', 'missing user'] as const)('never fetches on repeated menu openings with %s eligibility', async (reason) => {
    const getPeopleRanking = vi.fn(async () => ({ channel: [], organization: [] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, unmount } = renderHook(() => usePeopleRanking(
      reason === 'missing API' ? null : { getPeopleRanking }, 'org', reason === 'missing user' ? undefined : 'reader', 'channel', reason !== 'guest',
    ), { wrapper: Wrapper });
    await act(async () => { result.current.onOpen(); });
    await act(async () => { result.current.onOpen(); });
    expect(getPeopleRanking).not.toHaveBeenCalled();
    expect(result.current.ranking).toBeUndefined();
    unmount();
    client.clear();
  });
});
