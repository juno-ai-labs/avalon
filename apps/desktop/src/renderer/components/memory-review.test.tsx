import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MemoryForgetResponse, MemoryReview, MemoryReviewFact } from '@rally/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { MemoryFactList, useMemoryFacts } from './memory-review';

const openThread = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ openThread, openSidekicks: vi.fn() }) }));

function fact(factId: string, text: string, extra: Partial<MemoryReviewFact> = {}): MemoryReviewFact {
  return {
    factId, subjectKind: 'person', subjectTitle: null, kind: 'standing', text,
    validFrom: null, validUntil: null, recordedAt: '2026-10-01T12:00:00.000Z',
    conflict: false, derivedFrom: 'person',
    source: { kind: 'thread', workstreamId: 'plan', title: 'Q4 plan' },
    removable: true,
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeApi(facts: MemoryReviewFact[]) {
  return {
    getMyMemory: vi.fn<(signal?: AbortSignal) => Promise<MemoryReview>>(async () => ({ facts })),
    forgetMyMemory: vi.fn(async (factId: string): Promise<MemoryForgetResponse> => ({ factId, retractedAt: '2026-10-19T12:00:00.000Z' })),
  };
}

const QUERY_KEY = ['memory', 'me', 'org'];

function Harness({ api }: { api: ReturnType<typeof fakeApi> }): React.JSX.Element {
  const memory = useMemoryFacts({
    queryKey: QUERY_KEY,
    read: (signal) => api.getMyMemory(signal),
    forget: (factId) => api.forgetMyMemory(factId),
  });
  return <MemoryFactList {...memory} emptyCopy="Rally has not remembered anything about you yet." label="What Rally remembers about you" />;
}

function show(api: ReturnType<typeof fakeApi>): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Harness api={api} /></QueryClientProvider>);
  return client;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MemoryFactList', () => {
  it('lists the facts in the order given, each with its source, and no headings of its own', async () => {
    show(fakeApi([
      fact('one', 'Prefers short answers.', { conflict: true }),
      fact('two', 'Works in Go.', { source: { kind: 'channel', spaceId: 'outbound', title: 'Outbound' } }),
    ]));

    await screen.findByText('Prefers short answers.');
    const list = screen.getByRole('region', { name: 'What Rally remembers about you' });
    expect(within(list).queryAllByRole('heading')).toEqual([]);
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('p')?.textContent)).toEqual(['Prefers short answers.Disagreement', 'Works in Go.']);
    // A Thread opens in the main window; a Channel, which a settings window cannot open, is named.
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Q4 plan' }));
    expect(openThread).toHaveBeenCalledWith('plan');
    expect(rows[1]).toHaveTextContent('from Outbound');
    expect(within(rows[1]!).queryByRole('button', { name: 'Outbound' })).toBeNull();
  });

  it('marks a fact past its end Expired, and one not yet begun From, from the fact’s own dates', async () => {
    show(fakeApi([
      fact('past', 'Is on leave this week.', { kind: 'situational', validUntil: '2025-03-14T12:00:00.000Z' }),
      fact('later', 'Leads the offsite.', { kind: 'situational', validFrom: '2099-06-02T12:00:00.000Z', validUntil: '2099-06-04T12:00:00.000Z' }),
    ]));

    expect(await screen.findByText('Expired Mar 14')).toBeInTheDocument();
    expect(screen.getByText('From Jun 2 until Jun 4')).toBeInTheDocument();
  });

  it('turns Until into Expired when the fact runs out while the list is open, without reading again', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
    const api = fakeApi([fact('soon', 'Is in the board meeting.', { kind: 'situational', validUntil: '2026-10-19T12:00:05.000Z' })]);
    show(api);

    expect(await screen.findByText('Until today')).toBeInTheDocument();
    act(() => {
      vi.setSystemTime(new Date('2026-10-19T12:00:30.000Z'));
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByText('Expired today')).toBeInTheDocument();
    expect(api.getMyMemory).toHaveBeenCalledTimes(1);
  });

  it('offers Remove only on a fact the reader may remove', async () => {
    show(fakeApi([fact('org-1', 'The fiscal year starts in February.', { subjectKind: 'organization', removable: false })]));

    await screen.findByText('The fiscal year starts in February.');
    expect(screen.queryByRole('button', { name: /Remove/u })).toBeNull();
  });

  it('removes a fact through the API and drops its row', async () => {
    const api = fakeApi([fact('one', 'Prefers short answers.'), fact('two', 'Works in Go.')]);
    show(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove “Prefers short answers.”' }));

    await waitFor(() => expect(screen.queryByText('Prefers short answers.')).toBeNull());
    expect(api.forgetMyMemory).toHaveBeenCalledWith('one');
    expect(screen.getByText('Works in Go.')).toBeInTheDocument();
  });

  it('keeps the row and says why when a removal is refused', async () => {
    const api = fakeApi([fact('org-1', 'The fiscal year starts in February.', { subjectKind: 'organization' })]);
    api.forgetMyMemory.mockRejectedValueOnce(new ApiError('Forbidden', 403, 'memory_fact_not_removable'));
    show(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove “The fiscal year starts in February.”' }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('You can’t remove this.');
    expect(screen.getByText('The fiscal year starts in February.')).toBeInTheDocument();
  });

  it('treats a fact already removed elsewhere as removed', async () => {
    const api = fakeApi([fact('one', 'Prefers short answers.')]);
    api.forgetMyMemory.mockRejectedValueOnce(new ApiError('Not found', 404, 'memory_fact_not_found'));
    show(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove “Prefers short answers.”' }));

    await waitFor(() => expect(screen.queryByText('Prefers short answers.')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('reports each removal on its own row when two are in flight', async () => {
    const api = fakeApi([fact('one', 'Prefers short answers.'), fact('two', 'Works in Go.')]);
    const first = deferred<MemoryForgetResponse>();
    const second = deferred<MemoryForgetResponse>();
    api.forgetMyMemory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    show(api);

    const removeFirst = await screen.findByRole('button', { name: 'Remove “Prefers short answers.”' });
    fireEvent.click(removeFirst);
    fireEvent.click(screen.getByRole('button', { name: 'Remove “Works in Go.”' }));
    await act(async () => { second.resolve({ factId: 'two', retractedAt: '2026-10-19T12:00:00.000Z' }); });

    await waitFor(() => expect(screen.queryByText('Works in Go.')).toBeNull());
    // The first is still on its way: its button stays held and nothing is said about it yet.
    expect(removeFirst).toBeDisabled();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await act(async () => { first.reject(new ApiError('Forbidden', 403, 'memory_fact_not_removable')); });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('You can’t remove this.');
    expect(removeFirst).toBeEnabled();
  });

  it('does not let a read in flight bring a removed fact back', async () => {
    const api = fakeApi([fact('one', 'Prefers short answers.'), fact('two', 'Works in Go.')]);
    const client = show(api);
    await screen.findByText('Prefers short answers.');
    const reread = deferred<MemoryReview>();
    api.getMyMemory.mockReturnValueOnce(reread.promise);
    await act(async () => { void client.refetchQueries({ queryKey: QUERY_KEY }); });

    fireEvent.click(screen.getByRole('button', { name: 'Remove “Prefers short answers.”' }));
    await waitFor(() => expect(screen.queryByText('Prefers short answers.')).toBeNull());
    // The read began before the removal and answers after it, with the fact still in it.
    await act(async () => {
      reread.resolve({ facts: [fact('one', 'Prefers short answers.'), fact('two', 'Works in Go.')] });
      await reread.promise;
    });
    await waitFor(() => expect(client.getQueryState(QUERY_KEY)?.fetchStatus).toBe('idle'));

    expect(screen.queryByText('Prefers short answers.')).toBeNull();
    expect(screen.getByText('Works in Go.')).toBeInTheDocument();
  });

  it('says so when Rally has remembered nothing', async () => {
    show(fakeApi([]));

    expect(await screen.findByText('Rally has not remembered anything about you yet.')).toBeInTheDocument();
  });
});
