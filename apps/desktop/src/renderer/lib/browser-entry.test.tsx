import '../../../../../tests/isolated-region';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
// These cases control the session clock; IndexedDB transactions have their own
// runtime suite and must not be coupled to fake session deadlines.
vi.mock('./draft-cache', () => ({ clearAllDrafts: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./local-cache', () => ({ clearAllLocalCache: vi.fn().mockResolvedValue(undefined) }));
import { BrowserEntry } from '../../../../browser/src/entry';
import { clearAllLocalCache } from './local-cache';

const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'guest@example.test', name: 'Guest',
  avatarUrl: null, timezone: 'UTC', createdAt: '2026-09-17T00:00:00.000Z' };
const workspace = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Shared team', slug: 'shared',
  region: 'global', accessClass: 'guest', role: null, timezone: 'UTC', createdAt: user.createdAt };

afterEach(() => { vi.useRealTimers(); history.replaceState(null, '', '/'); });

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
  expect(screen.queryByRole('alert')).toBeNull();
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

it('opens a shared conversation straight from sign-in, with nothing to accept', async () => {
  // The emailed link is the conversation's own address. Signing in as the
  // invited mailbox is the whole of joining: the server claims the share then.
  const path = `/app/workspaces/global/${workspace.id}/workstreams/dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
  history.replaceState(null, '', path);
  const requests: string[] = [];
  let signedIn = false;
  const expiresAt = new Date(Date.now() + 100_000).toISOString();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const route = input.split('/browser')[1]!;
    requests.push(route);
    if (route === '/session' || (route === '/workspace/select' && !signedIn)) return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (route === '/email/start') return Response.json({ challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: Date.now() + 600_000 }, { status: 202 });
    if (route === '/email/redeem') { signedIn = true; return Response.json({ user, workspace: null, expiresAt }); }
    if (route === '/workspace/select') return Response.json({ user, workspace, expiresAt });
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  render(<BrowserEntry renderCollaboration={() => <p>Shared conversation</p>} />);
  expect(await screen.findByText('Sign in with the email address the link was sent to.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'guest@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Sign-in code' }), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Shared conversation')).toBeInTheDocument();
  expect(location.pathname).toBe(path);
  expect(requests.some((route) => route.includes('accept') || route === '/invitation')).toBe(false);
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
  expect(requests).toEqual(['/session']);
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
  expect(await screen.findByText('Loading your shared work…')).toBeInTheDocument();
  expect(screen.queryByText(/Nothing has been shared/u)).toBeNull();
  await act(async () => { finish!(Response.json({ workspaces: [] })); });
  expect(await screen.findByText('Nothing has been shared with guest@example.test yet.')).toBeInTheDocument();
});

it('starts Google sign-in for the page it was opened on and explains a declined one on return', async () => {
  const starts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = input.split('/browser')[1];
    if (path === '/workspace/select' || path === '/session') return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (path === '/google/start') { starts.push(JSON.parse(String(init?.body))); return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }); }
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  history.replaceState(null, '', `/app/workspaces/global/${workspace.id}#google_error=google_oauth_denied`);
  const view = render(<BrowserEntry />);
  try {
    expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in was cancelled.');
    expect(location.hash).toBe('');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(starts).toEqual([{ returnPath: `/app/workspaces/global/${workspace.id}` }]));
  } finally { view.unmount(); }
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

it('drops a returned Google failure once an email sign-in starts', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('/browser')[1];
    if (path === '/session') return Response.json({ error: { message: 'Sign in to continue' } }, { status: 401 });
    if (path === '/email/start') return Response.json({ challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: Date.now() + 600_000 }, { status: 202 });
    throw new Error(`Unexpected browser request: ${input}`);
  }));
  history.replaceState(null, '', '/#google_error=google_oauth_failed');
  render(<BrowserEntry />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in did not complete. Try again or use your email.');
  fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'person@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  // Back on the signed-out screen, the old Google failure stays gone.
  fireEvent.click(screen.getByRole('button', { name: 'Use another email or request a new code' }));
  expect(await screen.findByRole('heading', { name: 'Welcome to Rally' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
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
    expect(screen.queryByRole('heading', { name: 'Your shared work' })).not.toBeInTheDocument();
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
