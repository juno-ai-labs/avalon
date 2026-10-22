import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ConversationAccessPreview } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { ConversationAccessRequest, type ConversationAccessApi } from './conversation-access-request';

const PARENT = '00000000-0000-4000-8000-0000000ac0a0';
const BREAKOUT = '00000000-0000-4000-8000-0000000ac0a1';

function preview(extra: Partial<ConversationAccessPreview> = {}): ConversationAccessPreview {
  return { kind: 'channel', title: 'Launch plan', appearance: { icon: 'rocket', color: 'teal' }, markId: PARENT, access: 'requestable', requestPending: false, ...extra };
}

function fakeApi(answer: ConversationAccessPreview, request: () => Promise<void> = async () => undefined) {
  return {
    conversationAccessPreview: vi.fn(async () => answer),
    requestConversationAccess: vi.fn(request),
  } satisfies ConversationAccessApi;
}

function show(api: ConversationAccessApi, substreamId = '0', onRetry: () => void = () => undefined,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <ConversationAccessRequest api={api} fallback={<p>Thread could not be opened</p>} onRetry={onRetry} parentId={PARENT} substreamId={substreamId} />
    </QueryClientProvider>,
  );
}

describe('ConversationAccessRequest', () => {
  it('names a Channel the member is not in and sends one request for it', async () => {
    const api = fakeApi(preview());
    show(api);
    expect(await screen.findByRole('heading', { name: 'Launch plan' })).toBeTruthy();
    expect(screen.queryByText('Thread could not be opened')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect((await screen.findByRole('status')).textContent).toContain('Access requested — awaiting approval');
    expect(api.requestConversationAccess).toHaveBeenCalledWith(PARENT, '0');
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });

  it('shows the stored pending request on a fresh visit without sending another request', async () => {
    const api = fakeApi(preview({ requestPending: true }));
    const onRetry = vi.fn();
    show(api, '0', onRetry);
    expect((await screen.findByRole('status')).textContent).toContain('Access requested — awaiting approval');
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
    expect(screen.queryByText('You’re not in this thread, ask for access below')).toBeNull();
    expect(api.requestConversationAccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps the sent state on reopening and refreshes it when the pending request was declined', async () => {
    let answer = preview();
    const api = {
      conversationAccessPreview: vi.fn(async () => answer),
      requestConversationAccess: vi.fn(async () => { answer = preview({ requestPending: true }); }),
    } satisfies ConversationAccessApi;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = show(api, '0', undefined, client);
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    await screen.findByRole('status');
    first.unmount();
    const reopened = show(api, '0', undefined, client);
    expect(screen.getByRole('status').textContent).toContain('Access requested — awaiting approval');
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
    await vi.waitFor(() => expect(api.conversationAccessPreview).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await vi.waitFor(() => expect(client.isFetching()).toBe(0), { timeout: 2_000 });
    reopened.unmount();
    answer = preview();
    show(api, '0', undefined, client);
    expect(await screen.findByRole('button', { name: 'Request access' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(api.requestConversationAccess).toHaveBeenCalledTimes(1);
  });

  it('offers to dial again once the request is sent, since a revoked socket never dials back alone', async () => {
    const onRetry = vi.fn();
    show(fakeApi(preview()), '0', onRetry);
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('asks about the Breakout the link names', async () => {
    const api = fakeApi(preview({ kind: 'breakout', title: 'Pricing' }));
    show(api, BREAKOUT);
    expect(await screen.findByText('You’re not in this breakout, ask for access below')).toBeTruthy();
    expect(api.conversationAccessPreview).toHaveBeenCalledWith(PARENT, BREAKOUT);
  });

  it('keeps the ordinary error without a retry loop when the member can already open it', async () => {
    const api = fakeApi(preview({ access: 'open' }));
    const onRetry = vi.fn();
    show(api, '0', onRetry);
    await vi.waitFor(() => expect(api.conversationAccessPreview).toHaveBeenCalled(), { timeout: 2_000 });
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByText('Thread could not be opened')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });

  it('says why when nobody can approve', async () => {
    const api = fakeApi(preview(), async () => {
      throw new ApiError('Nobody can approve this request. Ask someone in it to add you.', 409, 'access_request_no_approver');
    });
    show(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    expect(await screen.findByText('Nobody can approve this request. Ask someone in it to add you.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
  });
});
