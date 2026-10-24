import "../../../../../tests/isolated-region";
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SupportAccess } from '@rally/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatSupportAccessRemaining, SupportAccessSetting, type SupportAccessApi } from './support-access-setting';
import { WorkspaceAccountMenu } from './workspace-account-menu';

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const acme = { id: '01a11778-2de8-72ed-9c2e-51284f2010c7', name: 'Acme Robotics', region: 'global' as const, expiresAt: '2026-10-14T00:00:00.000Z' };
const people = [
  { id: '01a11778-0000-7000-8000-00000000d0d0', name: 'Dana Park', email: 'dana@contractor.test', avatarUrl: null, accessClass: 'guest' as const },
  { id: '01a11778-0000-7000-8000-00000000b0b0', name: 'Bob Smith', email: 'bob@acme.test', avatarUrl: null, accessClass: 'member' as const },
];
const own = { id: 'workspace-juno', name: 'Juno Labs', slug: 'juno-labs', region: 'global' as const, role: 'member' as const, createdAt: '2026-08-01T00:00:00.000Z' };
const adam = { id: 'user-adam', name: 'Adam Juhasz', email: 'adam@rallywith.ai', timezone: 'UTC' };
const bob = { id: people[1]!.id, name: 'Bob Smith', email: 'bob@acme.test', timezone: 'UTC' };

function renderWithQueries(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Tooltip.Provider>{node}</Tooltip.Provider></QueryClientProvider>);
}

function menu(overrides: Partial<React.ComponentProps<typeof WorkspaceAccountMenu>> = {}) {
  const props: React.ComponentProps<typeof WorkspaceAccountMenu> = {
    activeWorkspace: own, attention: {}, currentUser: adam, enabled: false, invitations: [],
    onAcceptInvitation: vi.fn(async () => undefined), onCreateWorkspace: vi.fn(async () => undefined),
    onDeclineInvitation: vi.fn(async () => undefined), onInvitationPromptDismiss: vi.fn(), onMenuOpen: vi.fn(),
    onAbandonSignIn: vi.fn(), onAddMembers: vi.fn(), onOpenSettings: vi.fn(), onSignOut: vi.fn(), onSwitchWorkspace: vi.fn(async () => true),
    staleAt: null, workspaces: [own],
    supportWorkspaces: [acme],
    loadSupportPeople: vi.fn(async () => people),
    onStartSupportSession: vi.fn(async () => undefined),
    ...overrides,
  };
  renderWithQueries(<WorkspaceAccountMenu {...props} />);
  return props;
}

function openMenu(name: RegExp): void {
  fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false });
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('time left on a grant', () => {
  it('counts down in the largest whole unit and never rounds up', () => {
    expect(formatSupportAccessRemaining(7 * DAY - 1)).toBe('6 days left');
    expect(formatSupportAccessRemaining(DAY)).toBe('1 day left');
    expect(formatSupportAccessRemaining(DAY - 1)).toBe('23 hours left');
    expect(formatSupportAccessRemaining(2 * HOUR + 59 * 60_000)).toBe('2 hours left');
    expect(formatSupportAccessRemaining(59 * 60_000)).toBe('59 minutes left');
    expect(formatSupportAccessRemaining(10_000)).toBe('1 minute left');
    expect(formatSupportAccessRemaining(0)).toBeNull();
  });
});

describe('Allow Rally access', () => {
  function api(initial: SupportAccess) {
    let state = initial;
    return {
      getSupportAccess: vi.fn(async () => state),
      // Half a day off the boundary, so the shared clock's ten-second step cannot move the label.
      grantSupportAccess: vi.fn(async () => (state = { available: true, expiresAt: new Date(Date.now() + 6.5 * DAY).toISOString() })),
      revokeSupportAccess: vi.fn(async () => (state = { available: true, expiresAt: null })),
    } satisfies SupportAccessApi;
  }

  it('grants, shows the time left, and goes back to Grant access once revoked', async () => {
    const client = api({ available: true, expiresAt: null });
    renderWithQueries(<SupportAccessSetting api={client} impersonating={false} isAdmin workspaceId="workspace-acme" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grant access' }));
    expect(await screen.findByText('6 days left')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    expect(await screen.findByRole('button', { name: 'Grant access' })).toBeEnabled();
    expect(client.revokeSupportAccess).toHaveBeenCalledOnce();
  });

  it('offers Grant access again once the grant has run out', async () => {
    const client = api({ available: true, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    renderWithQueries(<SupportAccessSetting api={client} impersonating={false} isAdmin workspaceId="workspace-acme" />);
    expect(await screen.findByRole('button', { name: 'Grant access' })).toBeEnabled();
    expect(screen.queryByText(/left$/u)).not.toBeInTheDocument();
  });

  it('lets nobody but an administrator press it, and no support session extend it', async () => {
    renderWithQueries(<SupportAccessSetting api={api({ available: true, expiresAt: null })} impersonating={false} isAdmin={false} workspaceId="a" />);
    expect(await screen.findByRole('button', { name: 'Grant access' })).toBeDisabled();
    cleanup();
    renderWithQueries(<SupportAccessSetting api={api({ available: true, expiresAt: null })} impersonating isAdmin workspaceId="b" />);
    expect(await screen.findByRole('button', { name: 'Grant access' })).toBeDisabled();
  });

  it('is not shown in the staff Organization', async () => {
    const client = api({ available: false, expiresAt: null });
    renderWithQueries(<SupportAccessSetting api={client} impersonating={false} isAdmin workspaceId="juno" />);
    await waitFor(() => expect(client.getSupportAccess).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /access/u })).not.toBeInTheDocument();
  });
});

describe('Rally access in the account menu', () => {
  it('lists a granting Organization and opens a session as the person chosen from its submenu', async () => {
    const props = menu();
    openMenu(/Adam Juhasz/u);
    const row = screen.getByRole('menuitem', { name: 'Acme Robotics, Rally access' });
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    const choice = await screen.findByRole('menuitem', { name: 'Bob Smith' });
    expect(screen.getByRole('menuitem', { name: 'Dana Park, Guest' })).toBeInTheDocument();
    // Within the submenu: the account menu has a Members item of its own.
    const submenu = choice.closest<HTMLElement>('[role="menu"]')!;
    expect(within(submenu).getAllByText(/^(Members|Guests)$/u).map((label) => label.textContent)).toEqual(['Members', 'Guests']);
    fireEvent.click(choice);
    await waitFor(() => expect(props.onStartSupportSession).toHaveBeenCalledWith(acme, people[1]));
    expect(props.loadSupportPeople).toHaveBeenCalledWith(acme.id);
  });

  it('shows both people on a support session and offers End impersonation instead of Sign out', async () => {
    const props = menu({ activeWorkspace: { ...own, id: acme.id, name: acme.name }, currentUser: bob, impersonator: adam });
    const trigger = screen.getByRole('button', { name: 'Settings, Bob Smith, Acme Robotics, impersonated by Adam Juhasz' });
    // Radix paints initials after a short delay, in case an image arrives, and
    // each avatar keeps its own timer: under load one can paint before the
    // other, so wait for both together.
    await waitFor(() => {
      expect(trigger).toHaveTextContent('BS');
      expect(trigger).toHaveTextContent('AJ');
    });
    openMenu(/Bob Smith/u);
    expect(screen.queryByRole('menuitem', { name: /Sign out/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /End impersonation/u }));
    expect(props.onSignOut).toHaveBeenCalledOnce();
  });
});
