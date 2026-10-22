import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ConversationAccessPreview } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { ConversationAccessRequest, type ConversationAccessApi } from './conversation-access-request';

const PARENT = '00000000-0000-4000-8000-0000000ac0a0';
const VIEWER = '00000000-0000-4000-8000-0000000ac013';
const BREAKOUT = '00000000-0000-4000-8000-0000000ac0a1';

function preview(extra: Partial<ConversationAccessPreview> = {}): ConversationAccessPreview {
  return { kind: 'channel', title: 'Launch plan', appearance: { icon: 'rocket', color: 'teal' }, markId: PARENT, access: 'requestable', requestPending: false, requestEmailed: false, ...extra };
}

function fakeApi(answer: ConversationAccessPreview, request: () => Promise<void> = async () => undefined) {
  return {
    viewerUserId: VIEWER,
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
    const api = fakeApi(preview({ requestPending: true, requestEmailed: true }));
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
      viewerUserId: VIEWER,
      conversationAccessPreview: vi.fn(async () => answer),
      requestConversationAccess: vi.fn(async () => { answer = preview({ requestPending: true, requestEmailed: true }); }),
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

  it('keeps a successful request pending when an older preview arrives afterward', async () => {
    let release!: (answer: ConversationAccessPreview) => void;
    const stalePreview = new Promise<ConversationAccessPreview>((resolve) => { release = resolve; });
    const api = {
      viewerUserId: VIEWER,
      conversationAccessPreview: vi.fn(() => stalePreview),
      requestConversationAccess: vi.fn(async () => undefined),
    } satisfies ConversationAccessApi;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['conversation-access-preview', VIEWER, PARENT, '0'], preview());
    show(api, '0', undefined, client);
    await vi.waitFor(() => expect(api.conversationAccessPreview).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await screen.findByRole('status');
    await act(async () => { release(preview()); });
    expect(screen.getByRole('status').textContent).toContain('Access requested — awaiting approval');
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
    expect(client.getQueryData(['conversation-access-preview', VIEWER, PARENT, '0'])).toMatchObject({ requestPending: true });
  });

  it('lets a reopened pending request retry failed email delivery', async () => {
    const send = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Email unavailable'))
      .mockResolvedValueOnce(undefined);
    const api = fakeApi(preview({ requestPending: true, requestEmailed: false }), send);
    show(api);
    expect((await screen.findByRole('status')).textContent).toContain('Access requested — awaiting approval');
    fireEvent.click(screen.getByRole('button', { name: 'Retry sending request' }));
    expect(await screen.findByText('The request couldn’t be sent. Try again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry sending request' }));
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Retry sending request' })).toBeNull(), { timeout: 2_000 });
    expect(screen.getByRole('status').textContent).toContain('Access requested — awaiting approval');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('updates only the submitted conversation when a request completes after navigation', async () => {
    let finishRequest!: () => void;
    const api = fakeApi(preview(), () => new Promise<void>((resolve) => { finishRequest = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const target = (substreamId: string) => (
      <QueryClientProvider client={client}>
        <ConversationAccessRequest api={api} fallback={<p>Loading</p>} onRetry={() => undefined} parentId={PARENT} substreamId={substreamId} />
      </QueryClientProvider>
    );
    const view = render(target('0'));
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    await vi.waitFor(() => expect(api.requestConversationAccess).toHaveBeenCalledWith(PARENT, '0'), { timeout: 2_000 });
    view.rerender(target(BREAKOUT));
    await screen.findByRole('heading', { name: 'Launch plan' });
    await act(async () => { finishRequest(); });
    await vi.waitFor(() => expect(client.getQueryData(['conversation-access-preview', VIEWER, PARENT, '0']))
      .toMatchObject({ requestPending: true, requestEmailed: true }), { timeout: 2_000 });
    expect(client.getQueryData(['conversation-access-preview', VIEWER, PARENT, BREAKOUT]))
      .toMatchObject({ requestPending: false, requestEmailed: false });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
  });

  it('refreshes a stored pending request after the first email send fails', async () => {
    let answer = preview();
    const api = {
      viewerUserId: VIEWER,
      conversationAccessPreview: vi.fn(async () => answer),
      requestConversationAccess: vi.fn(async () => {
        answer = preview({ requestPending: true, requestEmailed: false });
        throw new Error('Email unavailable');
      }),
    } satisfies ConversationAccessApi;
    show(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    expect(await screen.findByText('The request couldn’t be sent. Try again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect((await screen.findByRole('status')).textContent).toContain('Access requested — awaiting approval');
    expect(screen.getByRole('button', { name: 'Retry sending request' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });

  it('keeps an old send completion out of the next requester cache after an identity switch', async () => {
    let finishRequest!: () => void;
    const firstApi = fakeApi(preview(), () => new Promise<void>((resolve) => { finishRequest = resolve; }));
    const secondApi = { ...fakeApi(preview()), viewerUserId: 'another-requester' };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = show(firstApi, '0', undefined, client);
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    await vi.waitFor(() => expect(firstApi.requestConversationAccess).toHaveBeenCalledWith(PARENT, '0'), { timeout: 2_000 });
    first.unmount();
    client.clear();
    show(secondApi, '0', undefined, client);
    await screen.findByRole('button', { name: 'Request access' });
    await act(async () => { finishRequest(); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
    expect(client.getQueryData(['conversation-access-preview', 'another-requester', PARENT, '0']))
      .toMatchObject({ requestPending: false, requestEmailed: false });
    expect(secondApi.requestConversationAccess).not.toHaveBeenCalled();
  });

  it('keeps a previous conversation send failure out of the new conversation', async () => {
    let failRequest!: (error: Error) => void;
    const api = fakeApi(preview(), () => new Promise<void>((_resolve, reject) => { failRequest = reject; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const target = (substreamId: string) => (
      <QueryClientProvider client={client}>
        <ConversationAccessRequest api={api} fallback={<p>Loading</p>} onRetry={() => undefined} parentId={PARENT} substreamId={substreamId} />
      </QueryClientProvider>
    );
    const view = render(target('0'));
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    await vi.waitFor(() => expect(api.requestConversationAccess).toHaveBeenCalledWith(PARENT, '0'), { timeout: 2_000 });
    view.rerender(target(BREAKOUT));
    await screen.findByRole('button', { name: 'Request access' });
    await act(async () => { failRequest(new Error('Email unavailable')); });
    expect(screen.queryByText('The request couldn’t be sent. Try again.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Request access' }).hasAttribute('disabled')).toBe(false);
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
