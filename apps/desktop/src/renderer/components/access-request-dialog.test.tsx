import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ConversationAccessRequestItem } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';

import { accessRequestsQueryKey, type AccessRequestDecisionApi } from '../lib/access-requests';
import { AccessRequestDialog } from './access-request-dialog';

const WORKSPACE = 'w1';
const request: ConversationAccessRequestItem = {
  id: 'r1', parentId: 'c', substreamId: '0', kind: 'channel', title: 'Hiring plan', appearance: null,
  markId: 'c', requesterUserId: 'u-sam', requesterName: 'Samantha Lee', requestedAt: '2026-10-07T12:00:00.000Z',
};

function show(api: AccessRequestDecisionApi, requestId: string, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(accessRequestsQueryKey(WORKSPACE), [request]);
  render(<QueryClientProvider client={client}>
    <AccessRequestDialog api={api} onClose={onClose} requestId={requestId} workspaceId={WORKSPACE} />
  </QueryClientProvider>);
  return { client, onClose };
}

describe('AccessRequestDialog', () => {
  it('approves the request the menu bar named, then closes and drops it from the list', async () => {
    const api = { decideConversationAccess: vi.fn(async () => ({ status: 'approved' as const })) };
    const { client, onClose } = show(api, 'r1');
    expect(screen.getByRole('dialog', { name: 'Access request' }).textContent).toContain('Samantha Lee asked to join this channel.');
    expect(screen.getByText('Hiring plan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.decideConversationAccess).toHaveBeenCalledWith('r1', 'approve');
    expect(client.getQueryData(accessRequestsQueryKey(WORKSPACE))).toEqual([]);
  });

  it('declines, and puts the request back when the server refuses', async () => {
    const api = { decideConversationAccess: vi.fn(async () => { throw new Error('offline'); }) };
    const { client, onClose } = show(api, 'r1');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('That didn’t go through. Try again.')).toBeTruthy();
    expect(api.decideConversationAccess).toHaveBeenCalledWith('r1', 'decline');
    expect(client.getQueryData(accessRequestsQueryKey(WORKSPACE))).toEqual([request]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says a request answered elsewhere was already answered, with no buttons to press', () => {
    const api = { decideConversationAccess: vi.fn() };
    show(api, 'r-gone');
    expect(screen.getByText('This request was already answered.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
