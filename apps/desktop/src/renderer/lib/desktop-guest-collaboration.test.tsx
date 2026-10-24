import "../../../../../tests/isolated-region";
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopSession, DesktopWorkspaceOnboardingState, RallyDesktopBridge } from '../../common/desktop';

// The Mac app's half of `browser-collaboration.test.tsx`: the real `App`, its
// session provider and every surface it mounts, for a guest. Only the Electron
// bridge and `fetch` are substituted. Each window this renderer draws is a
// separate `?surface=`, so each is mounted on its own.

const at = '2026-09-17T00:00:00.000Z';
const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'guest@example.test', name: 'Guest', avatarUrl: null, timezone: 'UTC', createdAt: at };
const workspace = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Design team', slug: 'design', region: 'global' as const,
  accessClass: 'guest' as const, role: null, timezone: 'UTC', createdAt: at };
/** A second Organization this person is a guest of, held in the background. */
const otherGuest = { ...workspace, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Partner studio', slug: 'partner' };
/** And one they belong to, whose attention is theirs to read. */
const member = { ...workspace, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Home', slug: 'home', role: 'member' as const, accessClass: undefined };
const session: DesktopSession = { accessToken: 'access-token-longer-than-twenty-characters',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), apiBaseUrl: 'https://api.rallywith.ai', user: { id: user.id, email: user.email, name: user.name }, workspace };
const directory: DesktopWorkspaceOnboardingState = {
  workspace: { ...workspace, credentialStored: true },
  workspaces: [workspace, otherGuest, member].map((entry) => ({ ...entry, credentialStored: true })),
  invitations: [],
  identity: 'connected',
};

/**
 * The route families that refuse a guest: everything under `requireAuth` in
 * the API, less the Organization profile, roster and socket ticket under `/workspace`,
 * and the Sidekick library and creation, which refuse a guest per route.
 */
const MEMBER_ONLY = /^\/(workspace\/(?!socket$|members$|me\/device-timezone$)|workspaces|workstreams|sideline|work-opportunities|projects|spaces(?!\/[^/]+\/channels)|digest|connections|favicons|realtime|(sidekicks|automations)\/?$)/u;

const spaceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

let requested: string[];
let refreshes: number;
/** What `GET /workspace` reports: the guest, unless a test promotes them. */
let served: typeof workspace | typeof member;
let attention: string[];

/** Every bridge method the shell does not need answered resolves to nothing. */
function bridge(): RallyDesktopBridge {
  const answers: Partial<Record<keyof RallyDesktopBridge, unknown>> = {
    getSession: async () => session,
    hasStoredCredential: async () => true,
    getRuntimeConfig: async () => ({ appVersion: '1.0.0', isPackaged: false, platform: 'darwin',
      api: { global: 'https://api.rallywith.ai', enterprise: 'https://enterprise.api.rallywith.ai' }, webBaseUrl: 'https://rallywith.ai', devAuthEnabled: false }),
    getOnboardingState: async () => directory,
    getAccountOnboarding: async () => ({ revision: 1, eligible: false, introduced: true, presentation: null }),
    getWorkspaceAttention: async ({ workspaceId }: { workspaceId: string }) => {
      attention.push(workspaceId);
      return { unreadCount: 0, attentionCount: 0 };
    },
    consumePendingDeepLinks: async () => [],
    refreshSession: async () => { refreshes++; return session; },
    // No main window is publishing its socket, so Settings and Sidekicks dial their own.
    getWorkspaceSyncSource: async () => ({ revision: 0, source: null }),
    openRealtimeSocket: async () => ({ socketId: 'socket' }),
  };
  return new Proxy({} as RallyDesktopBridge, {
    get: (_target, key) => {
      if (key in answers) return answers[key as keyof RallyDesktopBridge];
      // Subscriptions hand back their unsubscribe; everything else is a no-op.
      return typeof key === 'string' && key.startsWith('on') ? () => () => undefined : async () => undefined;
    },
  });
}

beforeEach(() => {
  requested = [];
  attention = [];
  refreshes = 0;
  served = workspace;
  vi.stubGlobal('rally', bridge());
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(String(input)).pathname;
    requested.push(path);
    if (path === '/workspace') return Response.json({ ...served, id: workspace.id });
    if (path === '/workspace/socket') return Response.json({ url: `wss://api.rallywith.ai/socket/workspaces/${workspace.id}`, ticket: 'ticket' });
    if (path === '/navigation/threads') return Response.json({ items: [], pinned: [], nextCursor: null });
    if (path === '/feature-flags') return Response.json({ multipleWorkspacesEnabled: true, liveArtifactsEnabled: false });
    if (path === '/sharing/navigation') return Response.json({ spaces: [], workstreams: [] });
    return Response.json({ error: { message: `Unexpected request: ${path}` } }, { status: 404 });
  }));
});

afterEach(() => {
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Mounts the window a `?surface=` names, the way main opens it. */
async function open(search: string, hash: string): Promise<void> {
  history.replaceState(null, '', `/${search}${hash}`);
  const { default: App } = await import('../App');
  render(<App />);
}

function refused(): string[] {
  return requested.filter((path) => MEMBER_ONLY.test(path));
}

it('opens a guest in the main window without asking for anything a guest is refused', async () => {
  await open('', '#/');
  await waitFor(() => expect(requested).toContain('/workspace'));
  // The account menu reads background attention for the membership alone.
  await waitFor(() => expect(attention).toEqual([member.id]));
  // Search answers a guest from their own audience, as it does a member.
  expect(await screen.findByRole('button', { name: 'Search organization' })).toBeEnabled();
  // The menu's content mounts on open, and with it anything it reads.
  const triggers = await screen.findAllByRole('button', { name: /Guest/u });
  fireEvent.pointerDown(triggers[triggers.length - 1]!, { button: 0, ctrlKey: false });
  await screen.findByRole('menuitem', { name: /Settings/u });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(refused()).toEqual([]);
  // The profile agrees with the session, so nothing is renewed early.
  expect(refreshes).toBe(0);
});

it('renews the session when the Organization reports a promotion', async () => {
  served = member;
  await open('', '#/');
  await waitFor(() => expect(refreshes).toBe(1));
});

it('lands a stale new-Channel link on the guest\'s own conversations', async () => {
  await open('', `#/spaces/${spaceId}/workstreams/new`);
  await waitFor(() => expect(window.location.hash).not.toContain('/workstreams/new'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(refused()).toEqual([]);
});

it('opens Settings in its own window on a section a guest does not have, and shows Account', async () => {
  await open('?surface=settings&settingsSection=internet-access', '#/settings');
  await screen.findByRole('heading', { name: 'Account' });
  // Members opens for a guest; the member-only sections are drawn disabled.
  const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
  expect(within(navigation).getByRole('button', { name: 'Members' })).not.toHaveAttribute('aria-disabled');
  expect(within(navigation).getByRole('button', { name: 'Security' })).toHaveAttribute('aria-disabled', 'true');
  expect(refused()).toEqual([]);
});

it('opens the Sidekicks window without the library or creation', async () => {
  await open('?surface=sidekicks', '#/sidekicks/new');
  await screen.findByText('Sidekicks open from conversations');
  expect(screen.queryByRole('link', { name: /New Sidekick/u })).not.toBeInTheDocument();
  expect(refused()).toEqual([]);
});
