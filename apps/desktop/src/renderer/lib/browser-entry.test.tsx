import { z } from 'zod';
import '../../../../../tests/isolated-region';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
// These cases control the session clock; IndexedDB transactions have their own
// runtime suite and must not be coupled to fake session deadlines.
vi.mock('./draft-cache', () => ({ clearAllDrafts: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./local-cache', () => ({ clearAllLocalCache: vi.fn().mockResolvedValue(undefined) }));
import { uuidToBase58 } from '@rally/contracts/uuid-base58';
import { BrowserEntry } from '../../../../browser/src/entry';
import { clearAllLocalCache } from './local-cache';

const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'guest@example.test', name: 'Guest',
  avatarUrl: null, timezone: 'UTC', createdAt: '2026-09-17T00:00:00.000Z' };
const workspace = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Shared team', slug: 'shared',
  region: 'global', accessClass: 'guest', role: null, timezone: 'UTC', createdAt: user.createdAt };

afterEach(() => { vi.useRealTimers(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

// Renderer test: HTTP is the boundary; backend cookie/membership authority is
// exercised by the API browser-session suites. The channel itself is real.
it('revalidates other-tab session changes and same-user organization changes without discarding drafts', async () => {
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
      if (!allowed) return Response.json({ error: { message: 'Organization access has ended' } }, { status: 403 });
      return Response.json({ ...metadata, workspace: promoted ? { ...workspace, accessClass: 'member', role: 'member' } : workspace });
    }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}`);
  const channel = new BroadcastChannel('rally-browser-session');
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
    await screen.findByText('Organization access has ended');
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


it('opens a workspace in another deployment through Global the first time, then uses that deployment directly', async () => {
  const enterprise = { ...workspace, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Enterprise team', region: 'enterprise', accessClass: 'member', role: 'member' };
  // Enterprise knows the same person under its own user id.
  const regionalUser = { ...user, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
  let activated = false;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${input}`);
    const metadata = { user: regionalUser, workspace: enterprise, expiresAt: new Date(Date.now() + 100_000).toISOString() };
    if (input === '/regional/enterprise/browser/workspace/select') {
      return activated ? Response.json(metadata) : Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    }
    if (input === '/regional/global/browser/workspace/activate') {
      expect(JSON.parse(String(init?.body))).toEqual({ region: 'enterprise', workspaceId: enterprise.id });
      activated = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  history.replaceState(null, '', `/app/workspaces/enterprise/${enterprise.id}`);
  const view = render(<BrowserEntry renderCollaboration={(region, session) => <output>{`${region}:${session.workspace?.name}`}</output>} />);
  try {
    await screen.findByText('enterprise:Enterprise team');
    expect(calls.slice(0, 3)).toEqual([
      'POST /regional/enterprise/browser/workspace/select',
      'POST /regional/global/browser/workspace/activate',
      'POST /regional/enterprise/browser/workspace/select',
    ]);
  } finally { view.unmount(); }
});

it('counts each organization\'s activity after the list, and shows nothing for one without any', async () => {
  const quiet = { ...workspace, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Quiet team', accessClass: 'member', role: 'member' };
  const busy = { ...workspace, name: 'Busy team', accessClass: 'member', role: 'member' };
  const counts = (readerAttentionCount: number) => ({ waitingForYou: 0, waitingReason: null, hasUnreadActivity: readerAttentionCount > 0, readerAttentionCount });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/browser')[1];
    if (path === '/session') return Response.json({ user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() });
    if (path === '/workspaces') return Response.json({ workspaces: [busy, quiet] });
    if (path === '/workspaces/attention') return Response.json({ attention: [
      { region: 'global', workspaceId: busy.id, attention: counts(4) },
      { region: 'global', workspaceId: quiet.id, attention: counts(0) },
    ] });
    throw new Error(`Unexpected request ${input}`);
  }));
  const view = render(<BrowserEntry />);
  try {
    const busyRow = await screen.findByRole('link', { name: 'Busy team, 4 conversations with new activity' });
    expect(busyRow).toHaveTextContent(/^BBusy team4$/u);
    expect(screen.getByRole('link', { name: 'Quiet team' })).toHaveTextContent(/^QQuiet team$/u);
  } finally { view.unmount(); }
});

it('signs out of every deployment, so no other deployment keeps a session in this browser', async () => {
  const logouts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/browser')[1];
    if (path === '/session') return Response.json({ user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() });
    if (path === '/workspaces') return Response.json({ workspaces: [workspace] });
    if (path === '/logout') { logouts.push(input); return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected request ${input}`);
  }));
  const view = render(<BrowserEntry />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Welcome to Rally' });
    expect(logouts.sort()).toEqual(['/regional/enterprise/browser/logout', '/regional/global/browser/logout']);
  } finally { view.unmount(); }
});

it('says so when a deployment does not answer sign-out', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/browser')[1];
    if (path === '/session') return Response.json({ user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() });
    if (path === '/workspaces') return Response.json({ workspaces: [workspace] });
    if (input === '/regional/enterprise/browser/logout') return Response.json({ error: { message: 'Unavailable' } }, { status: 503 });
    if (path === '/logout') return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${input}`);
  }));
  const view = render(<BrowserEntry />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByText('Signed out here, but a Rally deployment did not respond. Sign out again to finish.');
  } finally { view.unmount(); }
});

it('reopens a workspace in another deployment through Global when its renewal finds the cookie gone', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const now = Date.parse('2026-09-17T00:00:00.000Z');
  vi.setSystemTime(now);
  const enterprise = { ...workspace, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Enterprise team', region: 'enterprise', accessClass: 'member', role: 'member' };
  let cookie = false;
  let activations = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const unauthorized = () => Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (input === '/regional/enterprise/browser/session/renew') { cookie = false; return unauthorized(); }
    if (input === '/regional/enterprise/browser/workspace/select') {
      return cookie ? Response.json({ user, workspace: enterprise, expiresAt: new Date(Date.now() + 100_000).toISOString() }) : unauthorized();
    }
    if (input === '/regional/global/browser/workspace/activate') { cookie = true; ++activations; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected request ${input}`);
  }));
  history.replaceState(null, '', `/app/workspaces/enterprise/${enterprise.id}`);
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => { view = render(<BrowserEntry renderCollaboration={(region, session) => <output>{`${region}:${session.workspace?.name}`}</output>} />); });
    expect(screen.getByText('enterprise:Enterprise team')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(activations).toBe(2);
    expect(screen.getByText('enterprise:Enterprise team')).toBeInTheDocument();
  } finally { view?.unmount(); }
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
    expect(screen.getByRole('heading', { name: 'Your organizations' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(renewals).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    if (extended) {
      expect(screen.getByRole('heading', { name: 'Your organizations' })).toBeInTheDocument();
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
    // The member shell keeps transcripts in the local cache; signing out wipes it with the drafts.
    expect(clearAllLocalCache).toHaveBeenCalled();
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

it('restores the organization picker for a legacy conversation link', async () => {
  history.replaceState(null, '', '/app/workstreams/cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const fetcher = vi.fn(async (input: string) => input.endsWith('/workspaces')
    ? Response.json({ workspaces: [workspace] })
    : Response.json({ user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() }));
  vi.stubGlobal('fetch', fetcher);
  render(<BrowserEntry />);
  expect(await screen.findByRole('link', { name: /Shared team/ })).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/workspace/select'))).toBe(false);
});

it('keeps explicit magic-link confirmation visible after a focus session restore', async () => {
  history.replaceState(null, '', '/login/email#region=global&challenge=cccccccc-cccc-4ccc-8ccc-cccccccccccc&token=proof-token');
  const fetcher = vi.fn(async (input: string) => input.endsWith('/workspaces')
    ? Response.json({ workspaces: [workspace] })
    : Response.json({ user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() }));
  vi.stubGlobal('fetch', fetcher);
  render(<BrowserEntry />);
  expect(await screen.findByRole('heading', { name: 'Confirm your sign-in' })).toBeInTheDocument();
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(screen.getByRole('heading', { name: 'Confirm your sign-in' })).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/email/redeem'))).toBe(false);
});

it('returns to email entry on a non-JSON unauthorized response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));
  render(<BrowserEntry />);
  expect(await screen.findByRole('heading', { name: 'Welcome to Rally' })).toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('leads with Google and opens the email form only when asked', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 })));
  render(<BrowserEntry />);
  const google = await screen.findByRole('button', { name: 'Continue with Google' });
  expect(google).toHaveClass('button-primary');
  expect(screen.queryByRole('textbox', { name: 'Email' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
  expect(screen.getByRole('textbox', { name: 'Email' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toHaveClass('button-primary');
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Other sign-in options' }));
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Email' })).toBeNull();
});

it('offers the development account where the API does, and opens the organization list with it', async () => {
  const expiresAt = new Date(Date.now() + 100_000).toISOString();
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const route = input.split('/browser')[1]!;
    calls.push(`${init?.method ?? 'GET'} ${route}`);
    if (route === '/dev/session' && (init?.method ?? 'GET') === 'GET') return new Response(null, { status: 204 });
    if (route === '/dev/session') return Response.json({ user, workspace: null, expiresAt }, { status: 201 });
    if (route === '/workspaces') return Response.json({ workspaces: [workspace] });
    if (route === '/workspaces/attention') return Response.json({ attention: [] });
    return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
  }));
  render(<BrowserEntry />);
  fireEvent.click(await screen.findByRole('button', { name: 'Use local development account' }));
  expect(await screen.findByText('Shared team')).toBeInTheDocument();
  expect(calls).toContain('POST /dev/session');
});

it('offers no development account where the API does not', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => input.endsWith('/dev/session')
    ? new Response(null, { status: 404 })
    : Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 })));
  render(<BrowserEntry />);
  await screen.findByRole('button', { name: 'Continue with Google' });
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole('button', { name: 'Use local development account' })).toBeNull();
});

it('names a Sidekick link on the sign-in page', async () => {
  history.replaceState(null, '', `/app/global/${uuidToBase58(workspace.id)}/sk/${uuidToBase58('dddddddd-dddd-4ddd-8ddd-dddddddddddd')}/`);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 })));
  render(<BrowserEntry />);
  expect(await screen.findByText('Sign in to open this Sidekick.')).toBeInTheDocument();
});

it('preserves renewal requested while a focus restore is in flight', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const now = Date.parse('2026-09-17T00:00:00.000Z'); vi.setSystemTime(now);
  const metadata = { user, workspace: null, expiresAt: new Date(now + 100_000).toISOString() };
  let reads = 0, renewals = 0;
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.endsWith('/session/renew')) { renewals++; return Response.json(metadata); }
    if (input.endsWith('/session') && ++reads === 2) return new Promise<Response>((resolve) => { finish = resolve; });
    if (input.endsWith('/workspaces')) return Response.json({ workspaces: [workspace] });
    return Response.json(metadata);
  }));
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => { view = render(<BrowserEntry />); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(renewals).toBe(0);
    await act(async () => { finish!(Response.json(metadata)); });
    expect(renewals).toBe(1);
  } finally { view?.unmount(); }
});

it('does not publish an old account organization list after focus restores another account', async () => {
  history.replaceState(null, '', '/login/email#region=global&challenge=cccccccc-cccc-4ccc-8ccc-cccccccccccc&token=proof-token');
  const other = { ...user, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', email: 'other@example.test' };
  let listReads = 0;
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.endsWith('/workspaces')) {
      if (++listReads === 1) return new Promise<Response>((resolve) => { finish = resolve; });
      return Response.json({ workspaces: [{ ...workspace, name: 'Other account organization' }] });
    }
    return Response.json({ user: input.endsWith('/email/redeem') ? user : other, workspace: null,
      expiresAt: new Date(Date.now() + 100_000).toISOString() });
  }));
  render(<BrowserEntry />);
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await screen.findByRole('link', { name: /Other account organization/ });
  await act(async () => { finish!(Response.json({ workspaces: [workspace] })); });
  expect(screen.queryByRole('link', { name: /Shared team/ })).toBeNull();
  expect(screen.getByRole('link', { name: /Other account organization/ })).toBeInTheDocument();
});

it('opens a shared Canvas straight from sign-in, with nothing to accept', async () => {
  // The emailed link is the Canvas's own link. Signing in as the invited
  // mailbox is the whole of joining: the server claims the share then.
  const path = `/app/global/${uuidToBase58(workspace.id)}/cv/${uuidToBase58('dddddddd-dddd-4ddd-8ddd-dddddddddddd')}/`;
  history.replaceState(null, '', path);
  const requests: string[] = [];
  let startBody: unknown = null;
  let signedIn = false;
  const expiresAt = new Date(Date.now() + 100_000).toISOString();
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const route = input.split('/browser')[1]!;
    requests.push(route);
    if (route === '/session' || (route === '/workspace/select' && !signedIn)) return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (route === '/email/start') startBody = JSON.parse(String(init?.body));
    if (route === '/email/start') return Response.json({ challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: Date.now() + 600_000 }, { status: 202 });
    if (route === '/email/redeem') { signedIn = true; return Response.json({ user, workspace: null, expiresAt }); }
    if (route === '/workspace/select') return Response.json({ user, workspace, expiresAt });
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  render(<BrowserEntry renderCollaboration={() => <p>Shared conversation</p>} />);
  expect(await screen.findByText('Sign in to open this Canvas.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'guest@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Sign-in code' }), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Shared conversation')).toBeInTheDocument();
  expect(location.pathname).toBe(path);
  expect(requests.some((route) => route.includes('accept') || route === '/invitation')).toBe(false);
  // The emailed link is minted on this page's path, so it lands back here too.
  expect(startBody).toMatchObject({ returnPath: path });
});

it('signs in from an emailed link that landed on a shared path and opens what it names', async () => {
  const path = `/app/global/${uuidToBase58(workspace.id)}/cv/${uuidToBase58('dddddddd-dddd-4ddd-8ddd-dddddddddddd')}/`;
  history.replaceState(null, '', `${path}#region=global&challenge=cccccccc-cccc-4ccc-8ccc-cccccccccccc&token=proof-token`);
  let signedIn = false;
  const redeemed: unknown[] = [];
  const expiresAt = new Date(Date.now() + 100_000).toISOString();
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const route = input.split('/browser')[1]!;
    if (route === '/session' || (route === '/workspace/select' && !signedIn)) return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (route === '/email/redeem') { signedIn = true; redeemed.push(JSON.parse(String(init?.body))); return Response.json({ user, workspace: null, expiresAt }); }
    if (route === '/workspace/select') return Response.json({ user, workspace, expiresAt });
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  render(<BrowserEntry renderCollaboration={() => <p>Shared conversation</p>} />);
  expect(await screen.findByRole('heading', { name: 'Confirm your sign-in' })).toBeInTheDocument();
  // The proof never stays in history; the path does.
  expect(location.hash).toBe('');
  expect(location.pathname).toBe(path);
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Shared conversation')).toBeInTheDocument();
  expect(redeemed).toEqual([expect.objectContaining({ method: 'magic', credential: 'proof-token' })]);
  expect(location.pathname).toBe(path);
});

it('treats an old token invitation link as a plain sign-in page', async () => {
  history.replaceState(null, '', `/invite#inv_${'this-is-not-a-real-token'.padEnd(43, '0')}`);
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const route = input.split('/browser')[1]!;
    requests.push(route);
    if (route === '/session') return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  render(<BrowserEntry />);
  expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  // The token is out of history, and nothing asks what it pointed at: signing
  // in with the invited address is what claims the share.
  expect(location.pathname).toBe('/');
  expect(location.hash).toBe('');
  // The sign-in page reports its view, and asks whether a development account
  // is offered, from effects after it has rendered; nothing names the token.
  await waitFor(() => expect(requests).toEqual(['/session', '/signup/view', '/dev/session']));
});

it('waits for the organization list before saying nothing has been shared', async () => {
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const route = input.split('/browser')[1]!;
    if (route === '/session') return Response.json({ user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() });
    if (route === '/workspaces') return new Promise<Response>((resolve) => { finish = resolve; });
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  render(<BrowserEntry />);
  expect(await screen.findByText('Loading your organizations…')).toBeInTheDocument();
  expect(screen.queryByText(/is not part of an organization/u)).toBeNull();
  await act(async () => { finish!(Response.json({ workspaces: [] })); });
  expect(await screen.findByText('guest@example.test is not part of an organization, and nothing has been shared with it yet.')).toBeInTheDocument();
  expect(screen.getByText('Ask a teammate to share a Canvas or a Sidekick with you, or create a new organization.')).toBeInTheDocument();
});

it('starts Google sign-in for the page it was opened on and explains a declined one on return', async () => {
  const starts: Array<{ signupFlowId: string; returnPath: string }> = [];
  const views: Array<{ flowId: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = input.split('/browser')[1];
    if (path === '/workspace/select' || path === '/session') return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (path === '/signup/view') { views.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
    if (path === '/google/start') { starts.push(JSON.parse(String(init?.body))); return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }); }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}#google_error=google_oauth_denied`);
  const view = render(<BrowserEntry />);
  try {
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Google sign-in was cancelled.');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(location.hash).toBe('');
    await waitFor(() => expect(views).toHaveLength(1));
    view.rerender(<BrowserEntry />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(starts).toEqual([{ returnPath: `/app/workspaces/global/${workspace.id}`, signupFlowId: expect.stringMatching(/^[0-9a-f-]{14}7/u) }]));
    expect(views).toEqual([{ flowId: starts[0]!.signupFlowId }]);
  } finally { view.unmount(); }
});

it.each([
  ['01a0ee73-d366-7fb9-b5c0-3ceb3156f70a', '01a0ee73-d366-7fb9-b5c0-3ceb3156f70a'],
  ['invalid', expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u)],
])('handles landing signup flow %s without retaining it in the URL', async (incoming, expected) => {
  const views: Array<{ flowId: string }> = [];
  const starts: Array<{ signupFlowId: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = input.split('/browser')[1];
    if (path === '/session') return Response.json({ error: { message: 'Sign in' } }, { status: 401 });
    if (path === '/signup/view') { views.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
    if (path === '/google/start') { starts.push(JSON.parse(String(init?.body))); return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }); }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  history.replaceState(null, '', `/?signupFlowId=${incoming}`);
  const view = render(<BrowserEntry />);
  try {
    await waitFor(() => expect(views).toHaveLength(1));
    expect(location.search).toBe('');
    expect(views[0]!.flowId).toEqual(expected);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.signupFlowId).toBe(views[0]!.flowId);
  } finally { view.unmount(); }
});

it('keeps landing attribution when the signed-out page reloads, and a new CTA replaces it', async () => {
  const views: Array<{ flowId: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = input.split('/browser')[1];
    if (path === '/session') return Response.json({ error: { message: 'Sign in' } }, { status: 401 });
    if (path === '/signup/view') { views.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  const first = '01a0ee73-d366-7fb9-b5c0-3ceb3156f70a';
  const second = '01a0ee73-d366-7fb9-b5c0-3ceb3156f70b';
  history.replaceState(null, '', `/?signupFlowId=${first}`);
  let view = render(<BrowserEntry />);
  await waitFor(() => expect(views).toEqual([{ flowId: first }]));
  expect(location.search).toBe('');
  view.unmount();
  view = render(<BrowserEntry />);
  await waitFor(() => expect(views).toEqual([{ flowId: first }, { flowId: first }]));
  view.unmount();
  history.replaceState(null, '', `/?signupFlowId=${second}`);
  view = render(<BrowserEntry />);
  await waitFor(() => expect(views).toEqual([{ flowId: first }, { flowId: first }, { flowId: second }]));
  view.unmount();
});

it.each(['google', 'email'] as const)('keeps %s sign-in available on an older strict start API', async method => {
  const starts: Array<Record<string, unknown>> = [];
  const path = `/${method}/start`;
  const legacy = method === 'google'
    ? z.strictObject({ returnPath: z.string() })
    : z.strictObject({ challengeId: z.string().uuid(), email: z.string().email() });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const requestedPath = input.split('/browser')[1];
    if (requestedPath === '/session') return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (requestedPath === '/signup/view') return Response.json({ error: { message: 'Not found' } }, { status: 404 });
    if (requestedPath === path) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      starts.push(body);
      if (!legacy.safeParse(body).success) return Response.json({ error: { code: 'invalid_request', message: 'The request is invalid' } }, { status: 400 });
      return method === 'google' ? Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' })
        : Response.json({ challengeId: body.challengeId, expiresAt: Date.now() + 600_000 }, { status: 202 });
    }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  render(<BrowserEntry />);
  if (method === 'google') fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
  else {
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'new@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  }
  await waitFor(() => expect(starts).toHaveLength(2));
  expect(starts[0]).toHaveProperty('signupFlowId');
  const expected = { ...starts[0] };
  delete expected.signupFlowId;
  expect(starts[1]).toEqual(expected);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  if (method === 'email') expect(await screen.findByRole('textbox', { name: 'Sign-in code' })).toBeVisible();
});

it.each([[503, 'unavailable'], [400, 'not_a_validation_error']] as const)('does not retry a signup start rejected with %s %s', async (status, code) => {
  const starts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = input.split('/browser')[1];
    if (path === '/session') return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (path === '/signup/view') return new Response(null, { status: 204 });
    if (path === '/google/start') {
      starts.push(JSON.parse(String(init?.body)));
      return Response.json({ error: { code, message: 'Start unavailable' } }, { status });
    }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  render(<BrowserEntry />);
  fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('Start unavailable');
  expect(starts).toHaveLength(1);
});

it('returns to the Google-first choice after an email sign-in signs out', async () => {
  let signedIn = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/browser')[1];
    if (path === '/session' || path === '/email/redeem') return signedIn
      ? Response.json({ user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() })
      : Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (path === '/email/start') { signedIn = true; return Response.json({ challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: Date.now() + 600_000 }, { status: 202 }); }
    if (path === '/workspaces') return Response.json({ workspaces: [workspace] });
    if (path === '/logout') { signedIn = false; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  render(<BrowserEntry />);
  fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'person@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Sign-in code' }), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Email' })).toBeNull();
});

it.each([
  ['an iOS Home Screen app, whose cookies the email link cannot reach, asks only for the code', true, 'Enter the code sent to person@example.test.'],
  ['a browser tab also offers the sign-in link', undefined, 'Enter the code sent to person@example.test, or open the sign-in link in that email.'],
])('%s', async (_name, standalone, instructions) => {
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: standalone });
  try {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const path = input.split('/browser')[1];
      if (path === '/session') return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
      if (path === '/email/start') return Response.json({ challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: Date.now() + 600_000 }, { status: 202 });
      throw new Error(`Unexpected browser request: ${input}`);
    }));
    render(<BrowserEntry />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'person@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText(instructions)).toBeVisible();
  } finally {
    Reflect.deleteProperty(navigator, 'standalone');
  }
});

it('drops a returned Google failure once an email sign-in starts', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/browser')[1];
    if (path === '/session') return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (path === '/email/start') return Response.json({ challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: Date.now() + 600_000 }, { status: 202 });
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  history.replaceState(null, '', '/#google_error=google_oauth_failed');
  render(<BrowserEntry />);
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('Google sign-in did not complete. Try again or use your email.');
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'person@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  // Back on the signed-out screen, the old Google failure stays gone.
  fireEvent.click(screen.getByRole('button', { name: 'Use another email or request a new code' }));
  expect(await screen.findByRole('heading', { name: 'Welcome to Rally' })).toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('shows the opening mark, not an empty organization list, while a sign-in opens the linked organization', async () => {
  let signedIn = false;
  let openWorkspace!: () => void;
  const opened = new Promise<void>((resolve) => { openWorkspace = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/browser')[1];
    const metadata = { user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() };
    if (path === '/email/start') return Response.json({ challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: Date.now() + 600_000 });
    if (path === '/email/redeem') { signedIn = true; return Response.json(metadata); }
    if (!signedIn) return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (path === '/workspace/select') { await opened; return Response.json({ ...metadata, workspace }); }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}`);
  const view = render(<BrowserEntry renderCollaboration={(_region, session) => <output>{session.workspace?.name}</output>} />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: user.email } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Sign-in code' }), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('status', { name: 'Opening Rally' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your organizations' })).not.toBeInTheDocument();
    await act(async () => { openWorkspace(); });
    expect(await screen.findByText('Shared team')).toBeInTheDocument();
  } finally { view.unmount(); }
});

it('shows the opening mark while a sign-in activates a linked organization in another deployment', async () => {
  const enterprise = { ...workspace, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Enterprise team', region: 'enterprise', accessClass: 'member', role: 'member' };
  let signedIn = false;
  let activated = false;
  let openWorkspace!: () => void;
  const opened = new Promise<void>((resolve) => { openWorkspace = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const metadata = { user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() };
    if (input === '/regional/global/browser/email/start') return Response.json({ challengeId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', expiresAt: Date.now() + 600_000 });
    if (input === '/regional/global/browser/email/redeem') { signedIn = true; return Response.json(metadata); }
    if (input === '/regional/global/browser/workspace/activate' && signedIn) { activated = true; return new Response(null, { status: 204 }); }
    if (input === '/regional/enterprise/browser/workspace/select' && activated) { await opened; return Response.json({ ...metadata, workspace: enterprise }); }
    if (input.startsWith('/regional/')) return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  history.replaceState(null, '', `/app/workspaces/enterprise/${enterprise.id}`);
  const view = render(<BrowserEntry renderCollaboration={(_region, session) => <output>{session.workspace?.name}</output>} />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: user.email } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Sign-in code' }), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(activated).toBe(true));
    expect(screen.getByRole('status', { name: 'Opening Rally' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Check your email' })).not.toBeInTheDocument();
    await act(async () => { openWorkspace(); });
    expect(await screen.findByText('Enterprise team')).toBeInTheDocument();
  } finally { view.unmount(); }
});

it('creates an organization from the empty shared-work screen and opens it in place', async () => {
  const created: unknown[] = [];
  const calls: string[] = [];
  const createdId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const expiresAt = new Date(Date.now() + 100_000).toISOString();
  const owned = { ...workspace, id: createdId, name: 'Acme Research', accessClass: 'member', role: 'owner' };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    calls.push(input);
    if (input === '/regional/global/browser/session') return Response.json({ user, workspace: null, expiresAt });
    if (input === '/regional/global/browser/workspaces') return Response.json({ workspaces: [] });
    if (input === '/regional/global/browser/workspace/create') {
      created.push(JSON.parse(String(init?.body)));
      return Response.json({ region: 'global', workspaceId: createdId }, { status: 201 });
    }
    if (input === '/regional/global/browser/workspace/select') {
      expect(JSON.parse(String(init?.body))).toEqual({ workspaceId: createdId });
      return Response.json({ user, workspace: owned, expiresAt });
    }
    throw new Error(`Unexpected request ${input}`);
  }));
  const view = render(<BrowserEntry renderCollaboration={(region, session) => <output>{`${region}:${session.workspace?.name}`}</output>} />);
  try {
    await screen.findByText('guest@example.test is not part of an organization, and nothing has been shared with it yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Create an organization' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Organization name' }), { target: { value: ' Acme Research ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(created).toEqual([{ name: 'Acme Research', operationId: expect.stringMatching(/^[0-9a-f-]{14}7/u) }]));
    // The organization opens in this document, at its own address.
    expect(await screen.findByText('global:Acme Research')).toBeInTheDocument();
    expect(location.pathname).toBe(`/app/workspaces/global/${createdId}`);
    // A later restore reopens the organization rather than reading the list.
    calls.length = 0;
    fireEvent.focus(window);
    await waitFor(() => expect(calls).toEqual(['/regional/global/browser/workspace/select']));
    expect(screen.getByText('global:Acme Research')).toBeInTheDocument();
  } finally { view.unmount(); }
});

it('does not offer Create again when a created organization fails to open', async () => {
  const createdId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef';
  const expiresAt = new Date(Date.now() + 100_000).toISOString();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === '/regional/global/browser/session') return Response.json({ user, workspace: null, expiresAt });
    if (input === '/regional/global/browser/workspaces') return Response.json({ workspaces: [] });
    if (input === '/regional/global/browser/workspace/create') return Response.json({ region: 'global', workspaceId: createdId }, { status: 201 });
    if (input === '/regional/global/browser/workspace/select') {
      return Response.json({ error: { code: 'regional_onboarding_unavailable', message: 'The region is unavailable' } }, { status: 503 });
    }
    throw new Error(`Unexpected request ${input}`);
  }));
  const view = render(<BrowserEntry renderCollaboration={(region, session) => <output>{`${region}:${session.workspace?.name}`}</output>} />);
  try {
    await screen.findByText('guest@example.test is not part of an organization, and nothing has been shared with it yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Create an organization' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Organization name' }), { target: { value: 'Acme Research' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Organization name' })).not.toBeInTheDocument());
    await waitFor(() => expect(location.pathname).toBe(`/app/workspaces/global/${createdId}`));
    // The select failed; the empty list read before the creation must not come
    // back with Create on it.
    expect(await screen.findByText('The region is unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create an organization' })).not.toBeInTheDocument();
  } finally { view.unmount(); }
});

it('holds Back while an organization is being created and reuses its operation after an uncertain failure', async () => {
  const created: Array<{ operationId: string }> = [];
  let fail!: () => void;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input === '/regional/global/browser/session') return Response.json({ user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() });
    if (input === '/regional/global/browser/workspaces') return Response.json({ workspaces: [] });
    if (input === '/regional/global/browser/workspace/create') {
      created.push(JSON.parse(String(init?.body)));
      if (created.length === 1) return new Promise<Response>((resolve) => { fail = () => resolve(Response.json({ error: { message: 'The regional onboarding action could not be confirmed' } }, { status: 503 })); });
      return Response.json({ error: { message: 'Still unavailable' } }, { status: 503 });
    }
    throw new Error(`Unexpected request ${input}`);
  }));
  const view = render(<BrowserEntry />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Create an organization' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Organization name' }), { target: { value: 'Acme Research' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    await act(async () => { fail(); });
    await screen.findByText('The regional onboarding action could not be confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create an organization' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Organization name' }), { target: { value: 'Acme Research' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(created).toHaveLength(2));
    expect(created[1]!.operationId).toBe(created[0]!.operationId);
  } finally { view.unmount(); }
});

it('drops the organization form when another account signs in elsewhere', async () => {
  let current = user;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === '/regional/global/browser/session') return Response.json({ user: current, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() });
    if (input === '/regional/global/browser/workspaces') return Response.json({ workspaces: [] });
    throw new Error(`Unexpected request ${input}`);
  }));
  const channel = new BroadcastChannel('rally-browser-session');
  const view = render(<BrowserEntry />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Create an organization' }));
    await screen.findByRole('textbox', { name: 'Organization name' });
    current = { ...user, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'other@example.test' };
    await act(async () => { channel.postMessage('session-changed'); });
    await screen.findByText('other@example.test is not part of an organization, and nothing has been shared with it yet.');
    expect(screen.queryByRole('textbox', { name: 'Organization name' })).not.toBeInTheDocument();
  } finally { view.unmount(); channel.close(); }
});

it('says a retired Thread link names something gone, and says nothing of the kind on the Organization shell path', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/browser')[1];
    if (path === '/session') return Response.json({ user, workspace: null, expiresAt: new Date(Date.now() + 100_000).toISOString() });
    if (path === '/workspaces') return Response.json({ workspaces: [workspace] });
    if (path === '/workspaces/attention') return Response.json({ attention: [] });
    if (path === '/workspace/select') return Response.json({ user, workspace, expiresAt: new Date(Date.now() + 100_000).toISOString() });
    throw new Error(`Unexpected request ${input}`);
  }));
  const retired = 'This link is to something that no longer exists. Rally replaced Channels, Threads and Breakouts with Canvases.';
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}/workstreams/dddddddd-dddd-4ddd-8ddd-dddddddddddd`);
  let view = render(<BrowserEntry />);
  try {
    await screen.findByRole('heading', { name: 'Your organizations' });
    expect(screen.getByText(retired)).toBeVisible();
  } finally { view.unmount(); }
  // Signed in on the web app's own Organization shell path, which is no
  // retired link: the organization list says nothing of one.
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}`);
  view = render(<BrowserEntry />);
  try {
    await screen.findByRole('heading', { name: 'Your organizations' });
    expect(screen.queryByText(retired)).not.toBeInTheDocument();
  } finally { view.unmount(); }
});
