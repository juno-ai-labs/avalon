import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MemoryForgetResponse, MemoryReview, MemoryReviewFact } from '@rally/contracts';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { MemoryReviewPanel, type MemoryReviewApi } from './memory-review';

function fact(factId: string, text: string, extra: Partial<MemoryReviewFact> = {}): MemoryReviewFact {
  return {
    factId, subjectKind: 'person', subjectTitle: null, kind: 'standing', text,
    validFrom: null, validUntil: null, recordedAt: '2026-10-01T12:00:00.000Z',
    expired: false, upcoming: false, conflict: false, derivedFrom: 'person',
    source: { kind: 'thread', workstreamId: 'plan', title: 'Q4 plan' },
    removable: true,
    ...extra,
  };
}

function fakeApi(review: MemoryReview) {
  return {
    getMyMemoryReview: vi.fn(async () => review),
    forgetMyMemory: vi.fn(async (factId: string): Promise<MemoryForgetResponse> => ({ factId, retractedAt: '2026-10-19T12:00:00.000Z' })),
  } satisfies MemoryReviewApi;
}

function show(api: MemoryReviewApi): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter>
    <MemoryReviewPanel api={api} workspaceId="org" />
  </MemoryRouter></QueryClientProvider>);
}

describe('MemoryReviewPanel', () => {
  it('lists the person’s own facts first, then the Organization’s, then each Channel’s', async () => {
    show(fakeApi({
      own: [fact('own-1', 'Prefers short answers.')],
      shared: [
        fact('org-1', 'The fiscal year starts in February.', { subjectKind: 'organization', removable: false }),
        fact('ch-1', 'Outbound targets mid-market accounts.', { subjectKind: 'channel', subjectTitle: 'Outbound', removable: false,
          source: { kind: 'breakout', workstreamId: 'plan', substreamId: 'pricing', title: 'Pricing' } }),
      ],
    }));

    await screen.findByText('Prefers short answers.');
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
      .toEqual(['About you', 'About the Organization', 'About Outbound']);
    const facts = screen.getAllByRole('listitem').map((row) => row.querySelector('p')?.textContent);
    expect(facts).toEqual(['Prefers short answers.', 'The fiscal year starts in February.', 'Outbound targets mid-market accounts.']);
    // A Breakout opens inside its Thread.
    expect(within(screen.getByRole('region', { name: 'About Outbound' })).getByRole('link', { name: 'Pricing' }))
      .toHaveAttribute('href', '/workstreams/plan?substream=pricing');
  });

  it('marks an expired fact Expired with its day', async () => {
    show(fakeApi({
      own: [fact('own-1', 'Is on leave this week.', { kind: 'situational', validUntil: '2025-03-14T12:00:00.000Z', expired: true })],
      shared: [],
    }));

    expect(await screen.findByText('Expired Mar 14')).toBeInTheDocument();
  });

  it('offers Remove only on a fact the person may remove', async () => {
    show(fakeApi({
      own: [],
      shared: [fact('org-1', 'The fiscal year starts in February.', { subjectKind: 'organization', removable: false })],
    }));

    await screen.findByText('The fiscal year starts in February.');
    expect(screen.queryByRole('button', { name: /Remove/u })).toBeNull();
  });

  it('removes a fact through the API and drops its row', async () => {
    const api = fakeApi({ own: [fact('own-1', 'Prefers short answers.'), fact('own-2', 'Works in Go.')], shared: [] });
    show(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove “Prefers short answers.”' }));

    await waitFor(() => expect(screen.queryByText('Prefers short answers.')).toBeNull());
    expect(api.forgetMyMemory).toHaveBeenCalledWith('own-1');
    expect(screen.getByText('Works in Go.')).toBeInTheDocument();
  });

  it('keeps the row and says why when a removal is refused', async () => {
    const api = fakeApi({ own: [], shared: [fact('org-1', 'The fiscal year starts in February.', { subjectKind: 'organization' })] });
    api.forgetMyMemory.mockRejectedValueOnce(new ApiError('Forbidden', 403, 'memory_fact_not_removable'));
    show(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove “The fiscal year starts in February.”' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Only an administrator can remove this.');
    expect(screen.getByText('The fiscal year starts in February.')).toBeInTheDocument();
  });

  it('says so when Rally has remembered nothing', async () => {
    show(fakeApi({ own: [], shared: [] }));

    expect(await screen.findByText('Rally has not remembered anything for you yet.')).toBeInTheDocument();
  });
});
