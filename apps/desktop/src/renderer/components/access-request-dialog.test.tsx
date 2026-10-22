import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { asSubstreamId, asUserId, asWorkstreamId, type ConversationAccessRequestItem } from '@rally/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { accessRequestsQueryKey, type AccessRequestDecisionApi } from '../lib/access-requests';
import { AccessRequestDialog } from './access-request-dialog';

const WORKSPACE = 'w1';
const request: ConversationAccessRequestItem = {
  id: 'r1', parentId: asWorkstreamId('00000000-0000-4000-8000-0000000ac0c0'), substreamId: asSubstreamId('0'), kind: 'channel', title: 'Hiring plan', appearance: null,
  markId: '00000000-0000-4000-8000-0000000ac0c0', requesterUserId: asUserId('00000000-0000-4000-8000-0000000ac013'), requesterName: 'Samantha Lee', requestedAt: '2026-10-07T12:00:00.000Z',
};

function show(api: AccessRequestDecisionApi, requestId: string, onClose = vi.fn(), listed: boolean = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (listed) client.setQueryData(accessRequestsQueryKey(WORKSPACE), [request]);
  render(<QueryClientProvider client={client}>
    <AccessRequestDialog api={api} onClose={onClose} requestId={requestId} workspaceId={WORKSPACE} />
  </QueryClientProvider>);
  return { client, onClose };
}

describe('AccessRequestDialog', () => {
  afterEach(async () => {
    cleanup();
    // Radix restores focus in a zero-delay timer after unmount. Finish that
    // callback before jsdom teardown replaces the window's CustomEvent.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it('approves the request the menu bar named, then closes and drops it from the list', async () => {
    const api = { decideConversationAccess: vi.fn(async () => ({ status: 'approved' as const })) };
    const { client, onClose } = show(api, 'r1');
    expect(screen.getByRole('dialog', { name: 'Access request' }).textContent).toContain('Samantha Lee asked to join this channel.');
    expect(screen.getByText('Hiring plan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2_000 });
    expect(api.decideConversationAccess).toHaveBeenCalledWith('r1', 'approve');
    expect(client.getQueryData(accessRequestsQueryKey(WORKSPACE))).toEqual([]);
  });

  it('keeps showing the request while its answer is in flight', async () => {
    const api = { decideConversationAccess: vi.fn(() => new Promise<never>(() => undefined)) };
    show(api, 'r1');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => expect(api.decideConversationAccess).toHaveBeenCalled(), { timeout: 2_000 });
    expect(screen.queryByText('This request was already answered.')).toBeNull();
    expect(screen.getByText('Samantha Lee asked to join this channel.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
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

  it('says it is loading, not answered, until the socket has sent the list', () => {
    const api = { decideConversationAccess: vi.fn() };
    show(api, 'r1', vi.fn(), false);
    expect(screen.getByText('Loading the request…')).toBeTruthy();
    expect(screen.queryByText('This request was already answered.')).toBeNull();
  });
});
