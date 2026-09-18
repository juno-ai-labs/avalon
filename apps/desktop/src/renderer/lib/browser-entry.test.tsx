import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserEntry } from '../../../../browser/src/entry';

const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'guest@example.test', name: 'Guest',
  avatarUrl: null, timezone: 'UTC', createdAt: '2026-09-17T00:00:00.000Z' };
const workspace = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Shared team', slug: 'shared',
  region: 'global', accessClass: 'guest', role: null, timezone: 'UTC', createdAt: user.createdAt };

afterEach(() => { vi.useRealTimers(); history.replaceState(null, '', '/'); });

// Renderer test: HTTP is the boundary; backend cookie/membership authority is
// exercised by the API browser-session suites. The channel itself is real.
it('revalidates other-tab session changes and same-user workspace changes without discarding drafts', async () => {
  let signedIn = true;
  let allowed = true;
  let promoted = false;
  let workspaceReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/browser')[1];
    const metadata = { user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() };
    if (!signedIn) return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (path === '/session' || path === '/session/renew') return Response.json(metadata);
    if (path === '/workspaces') return Response.json({ workspaces: [workspace] });
    if (path === '/workspace/select') {
      ++workspaceReads;
      if (!allowed) return Response.json({ error: { message: 'Workspace access has ended' } }, { status: 403 });
      return Response.json({ ...metadata, workspace: promoted ? { ...workspace, accessClass: 'member', role: 'member' } : workspace });
    }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}`);
  const channel = new BroadcastChannel('rally-browser-session:global');
  const view = render(<BrowserEntry renderCollaboration={(_region, session) => <section>
    <output>{session.workspace?.accessClass}</output><textarea aria-label="Draft" />
  </section>} />);
  try {
    await screen.findByText('guest');
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'Keep this draft' } });
    promoted = true;
    await act(async () => { channel.postMessage('session-changed'); });
    await screen.findByText('member');
    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this draft');
    expect(workspaceReads).toBeGreaterThan(1);
    allowed = false;
    fireEvent.focus(window);
    await screen.findByText('Workspace access has ended');
    expect(screen.queryByRole('textbox', { name: 'Draft' })).not.toBeInTheDocument();
    signedIn = false;
    await act(async () => { channel.postMessage('session-changed'); });
    await screen.findByRole('heading', { name: 'Welcome to Rally' });
    signedIn = true;
    allowed = true;
    await act(async () => { channel.postMessage('session-changed'); });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Draft' })).toBeInTheDocument());
  } finally {
    view.unmount();
    channel.close();
  }
});


it.each([false, true])('renews before expiry and respects an unchanged absolute ceiling (extended=%s)', async (extended) => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const now = Date.parse('2026-09-17T00:00:00.000Z');
  vi.setSystemTime(now);
  let expiry = now + 100_000;
  let renewals = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = input.split('/browser')[1];
    if (Date.now() >= expiry) return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (path === '/session/renew') {
      expect(init?.method).toBe('POST');
      ++renewals;
      if (extended) expiry = now + 200_000;
    }
    if (path === '/session' || path === '/session/renew') return Response.json({ user, workspace: null, expiresAt: new Date(expiry).toISOString() });
    if (path === '/workspaces') return Response.json({ workspaces: [workspace] });
    throw new Error(`Unexpected request ${input}`);
  }));
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => { view = render(<BrowserEntry />); });
    expect(screen.getByRole('heading', { name: 'Your shared work' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(renewals).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    if (extended) {
      expect(screen.getByRole('heading', { name: 'Your shared work' })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(100_000); });
      expect(renewals).toBe(2);
    } else expect(renewals).toBe(1);
    expect(screen.getByRole('heading', { name: 'Welcome to Rally' })).toBeInTheDocument();
  } finally { view?.unmount(); }
});

it('ignores a renewal response delivered after sign-out', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const now = Date.parse('2026-09-17T00:00:00.000Z');
  vi.setSystemTime(now);
  const metadata = { user, workspace: null, expiresAt: new Date(now + 100_000).toISOString() };
  let finishRenewal: ((response: Response) => void) | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/browser')[1];
    if (path === '/session/renew') return new Promise<Response>((resolve) => { finishRenewal = resolve; });
    if (path === '/session') return Response.json(metadata);
    if (path === '/workspaces') return Response.json({ workspaces: [workspace] });
    if (path === '/logout') return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${input}`);
  }));
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => { view = render(<BrowserEntry />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(finishRenewal).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); });
    await act(async () => { finishRenewal!(Response.json({ ...metadata, expiresAt: new Date(now + 200_000).toISOString() })); });
    expect(screen.getByRole('heading', { name: 'Welcome to Rally' })).toBeInTheDocument();
  } finally { view?.unmount(); }
});

it('does not overflow a session deadline longer than the browser timer range', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const { scheduleSessionDeadline } = await import('../../../../browser/src/session-timer');
  const callback = vi.fn();
  const duration = 30 * 24 * 60 * 60 * 1000;
  const cancel = scheduleSessionDeadline(Date.now() + duration, callback);
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(callback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(duration - 2_147_483_647);
  expect(callback).toHaveBeenCalledOnce();
  cancel();
});
