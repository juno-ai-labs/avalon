import "../../../../../tests/isolated-region";
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceAccountMenu } from './workspace-account-menu';
import { AccountSignInSupersededError, FINISH_SIGN_IN_IN_BROWSER } from '../lib/app-session';
import { desktopWorkspaceIdentityKey, type DesktopUpdateStatus } from '../../common/desktop';
import type * as PlatformModule from '../lib/platform';

/** Update methods layered over the real bridge while a test sets them. */
const updateBridge = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../lib/platform', async (importOriginal) => {
  const original = await importOriginal<typeof PlatformModule>();
  return {
    ...original,
    desktopBridge: () => ({ ...original.desktopBridge(), ...updateBridge.current }),
  };
});


const currentUser = { id: 'user-1', name: 'Ada', email: 'ada@example.com', timezone: 'America/New_York' };
const active = {
  id: 'workspace-global', name: 'Global Studio', slug: 'global-studio', region: 'global' as const,
  role: 'owner' as const, createdAt: '2026-08-01T00:00:00.000Z',
};
const enterprise = {
  id: 'workspace-enterprise', name: 'Europe Studio', slug: 'europe-studio', region: 'enterprise' as const,
  role: 'member' as const, createdAt: '2026-08-02T00:00:00.000Z',
};

function renderMenu(overrides: Partial<React.ComponentProps<typeof WorkspaceAccountMenu>> = {}) {
  const props: React.ComponentProps<typeof WorkspaceAccountMenu> = {
    activeWorkspace: active,
    attention: {
      [desktopWorkspaceIdentityKey(enterprise.region, enterprise.id)]: {
        waitingForYou: 3, waitingReason: 'mentioned', hasUnreadActivity: true, readerAttentionCount: 3,
      },
    },
    currentUser,
    enabled: true,
    invitations: [],
    onAcceptInvitation: vi.fn(async () => undefined),
    onCreateWorkspace: vi.fn(async () => undefined),
    onDeclineInvitation: vi.fn(async () => undefined),
    onInvitationPromptDismiss: vi.fn(),
    onMenuOpen: vi.fn(),
    onAbandonSignIn: vi.fn(),
    onOpenSettings: vi.fn(),
    onSignOut: vi.fn(),
    onSwitchWorkspace: vi.fn(async () => true),
    staleAt: null,
    workspaces: [active, enterprise],
    ...overrides,
  };
  render(<Tooltip.Provider><WorkspaceAccountMenu {...props} /></Tooltip.Provider>);
  return props;
}

function openMenu(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: /Ada/u }), { button: 0, ctrlKey: false });
}

describe('organization account menu', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps organization discovery and switching available in the Grok presentation', () => {
    const props = renderMenu({ presentation: 'grok' });
    openMenu();
    expect(props.onMenuOpen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('menuitem', { name: /Europe Studio.*enterprise/u }));
    expect(props.onSwitchWorkspace).toHaveBeenCalledWith(enterprise);
    expect(screen.queryByText('Weekly usage')).not.toBeInTheDocument();
    expect(screen.queryByText('Get Rally for iOS')).not.toBeInTheDocument();
  });
  it('puts Restart to Update above Members only while an update is downloaded', async () => {
    const installDownloadedUpdate = vi.fn(async () => undefined);
    let status: DesktopUpdateStatus = { kind: 'idle' };
    updateBridge.current = {
      getUpdateStatus: async () => status,
      onUpdateStatusChanged: () => () => undefined,
      installDownloadedUpdate,
      openSidekicks: vi.fn(async () => undefined),
    };
    try {
      renderMenu({ presentation: 'grok' });
      await act(async () => undefined);
      openMenu();
      expect(screen.queryByRole('menuitem', { name: 'Restart to Update' })).not.toBeInTheDocument();
      cleanup();

      status = { kind: 'downloaded', version: '1.2.0' };
      renderMenu({ presentation: 'grok' });
      await act(async () => undefined);
      openMenu();
      const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
      expect(items[0]).toHaveAccessibleName('Restart to Update');
      expect(items[1]).toHaveAccessibleName('Members');
      expect(items[2]).toHaveAccessibleName('Sidekicks');
      fireEvent.click(items[0]!);
      expect(installDownloadedUpdate).toHaveBeenCalledOnce();
    } finally {
      updateBridge.current = null;
    }
  });
  it.each(['grok', 'workspace'] as const)('offers Add new member above Members only to someone who may invite (%s)', (presentation) => {
    renderMenu({ presentation });
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Add new member' })).not.toBeInTheDocument();
    cleanup();

    const props = renderMenu({ presentation, onAddMembers: vi.fn() });
    openMenu();
    const names = within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent);
    expect(names.indexOf('Add new member')).toBe(names.indexOf('Members') - 1);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add new member' }));
    expect(props.onAddMembers).toHaveBeenCalledOnce();
  });
  it('opens Settings on the Members page from Members', () => {
    const openSettings = vi.fn(async () => undefined);
    updateBridge.current = { openSettings };
    try {
      renderMenu({ presentation: 'grok' });
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Members' }));
      expect(openSettings).toHaveBeenCalledWith('members');
    } finally {
      updateBridge.current = null;
    }
  });
  it.each([true, false])('keeps compact account actions ordered and usable with organizations enabled=%s', (enabled) => {
    const invite = {
      id: 'invite-1', workspaceId: 'workspace-invited', workspaceName: 'Invited Studio',
      region: 'global' as const, email: currentUser.email, role: 'member' as const,
      invitedByName: 'Grace', expiresAt: '2026-09-07T00:00:00.000Z',
    };
    const props = renderMenu({ presentation: 'grok', enabled, invitations: [invite] });
    openMenu();
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items).toHaveLength(enabled ? 7 : 4);
    expect(items[0]).toHaveAccessibleName('Members');
    expect(within(menu).getByRole('menuitem', { name: 'Members' }).querySelector('.tabler-icon-users'))
      .toBeInTheDocument();
    expect(items[1]).toHaveAccessibleName('Sidekicks');
    expect(within(menu).getByRole('menuitem', { name: 'Sidekicks' }).querySelector('.tabler-icon-hexagons'))
      .toBeInTheDocument();
    expect(items[2]).toHaveAccessibleName('Settings');
    expect(within(menu).getByRole('menuitem', { name: 'Settings' }).querySelector('.tabler-icon-settings'))
      .toBeInTheDocument();
    if (enabled) {
      expect(items[3]).toHaveAccessibleName(/Global Studio.*Current/u);
      expect(items[4]).toHaveAccessibleName(/Europe Studio/u);
      expect(items[5]).toHaveAccessibleName(/Join Invited Studio.*Grace/u);
    }
    const logout = within(menu).getByRole('menuitem', { name: 'Log out' });
    expect(logout.querySelector('.tabler-icon-logout')).toBeInTheDocument();
    expect(items.at(-1)).toBe(logout);
    expect(menu.lastElementChild).toBe(logout);
    expect(within(menu).getAllByRole('separator')).toEqual([logout.previousElementSibling]);
    for (const name of ['About', 'Help Center', 'Send Feedback', 'Create an organization']) {
      expect(within(menu).queryByRole('menuitem', { name })).not.toBeInTheDocument();
    }
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Settings' }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(props.onSignOut).toHaveBeenCalledOnce();
  });

  it('shows background attention, a cross-region tag, and one-action switching', () => {
    const props = renderMenu();

    expect(screen.getByRole('button', { name: /Ada.*attention in another organization/u }))
      .toBeVisible();
    openMenu();

    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Organizations')).toBeVisible();
    expect(within(menu).getByRole('menuitem', { name: /Global Studio.*global.*Current/u })).toBeVisible();
    const europe = within(menu).getByRole('menuitem', {
      name: 'Europe Studio, enterprise, 3 conversations with new activity, 3 mentions waiting for you',
    });
    expect(europe).toHaveTextContent(/^EEurope Studioenterprise3$/u);

    fireEvent.click(europe);
    expect(props.onSwitchWorkspace).toHaveBeenCalledWith(enterprise);
  });

  it('explains the activity count on hover', async () => {
    renderMenu();
    openMenu();
    fireEvent.pointerMove(screen.getByText('3'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('3 mentions waiting for you');
  });

  it('counts unread activity when nothing waits on the person, and shows nothing at zero', async () => {
    renderMenu({
      attention: {
        [desktopWorkspaceIdentityKey(enterprise.region, enterprise.id)]: {
          waitingForYou: 0, waitingReason: null, hasUnreadActivity: true, readerAttentionCount: 120,
        },
      },
    });
    openMenu();
    const europe = screen.getByRole('menuitem', { name: 'Europe Studio, enterprise, 120 conversations with new activity' });
    expect(europe).toHaveTextContent(/99\+$/u);
    fireEvent.pointerMove(within(europe).getByText('99+'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('120 conversations with new activity');
    cleanup();

    renderMenu({
      attention: {
        [desktopWorkspaceIdentityKey(enterprise.region, enterprise.id)]: {
          // Only an agent waiting on input: no conversation to count.
          waitingForYou: 1, waitingReason: 'needs_input', hasUnreadActivity: false, readerAttentionCount: 0,
        },
      },
    });
    expect(screen.getByRole('button', { name: /Ada/u })).not.toHaveAccessibleName(/another organization/u);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Europe Studio, enterprise' })).toHaveTextContent(/^EEurope Studioenterprise$/u);
  });

  it('closes once a switch has taken and stays open while it has not', async () => {
    const onSwitchWorkspace = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    renderMenu({ onSwitchWorkspace, workspaceErrors: { [desktopWorkspaceIdentityKey(enterprise.region, enterprise.id)]: undefined } });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Europe Studio/u }));
    await waitFor(() => expect(onSwitchWorkspace).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('menu')).toBeVisible();

    fireEvent.click(screen.getByRole('menuitem', { name: /Europe Studio/u }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('marks unread-only activity on the account trigger', () => {
    renderMenu({
      attention: {
        [desktopWorkspaceIdentityKey(enterprise.region, enterprise.id)]: {
          waitingForYou: 0, waitingReason: null, hasUnreadActivity: true, readerAttentionCount: 1,
        },
      },
    });

    expect(screen.getByRole('button', { name: /Ada.*Global Studio.*unread activity in another organization/u }))
      .toBeVisible();
  });

  it('does not mark a same-id organization in another region as current', () => {
    const regionalCollision = { ...enterprise, id: active.id };
    const props = renderMenu({ attention: {}, workspaces: [active, regionalCollision] });

    openMenu();
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Global Studio.*global.*Current/u })).toBeVisible();
    const europe = within(menu).getByRole('menuitem', { name: /Europe Studio.*enterprise/u });
    expect(europe).not.toHaveAccessibleName(/Current/u);

    fireEvent.click(europe);
    expect(props.onSwitchWorkspace).toHaveBeenCalledWith(regionalCollision);
  });

  it('keeps stale values visible and identifies when they were last updated', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T20:07:00.000Z'));
    renderMenu({ staleAt: '2026-08-31T20:00:00.000Z' });
    openMenu();

    // The relative label is its own <time> element so that it keeps ticking,
    // so the sentence is read off the row rather than matched as one text node.
    expect(screen.getByText(/Counts last updated/u).closest('.workspace-counts-stale'))
      .toHaveTextContent('Counts last updated 7 minutes ago');
    expect(screen.getByRole('menuitem', { name: /Europe Studio.*3 conversations with new activity/u })).toHaveTextContent(/3$/u);
  });

  it('keeps the legacy one-organization anatomy while the flag is off', () => {
    renderMenu({ enabled: false, workspaces: [active], attention: {} });
    openMenu();

    expect(screen.queryByText('Organizations')).not.toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeVisible();
    const settings = screen.getByRole('menuitem', { name: 'Settings…' });
    const signOut = screen.getByRole('menuitem', { name: 'Sign out' });
    expect(settings).toBeVisible();
    expect(settings.querySelector('.tabler-icon-settings')).toBeInTheDocument();
    expect(signOut).toBeVisible();
    expect(signOut.querySelector('.tabler-icon-logout')).toBeInTheDocument();
  });

  it('names the active organization\'s data region by deployment identifier under the account, and offers no reconnect item', () => {
    renderMenu({ attention: {} });
    openMenu();

    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Organization')).toBeVisible();
    expect(within(menu).queryByRole('menuitem', { name: /Reconnect/u })).not.toBeInTheDocument();
    expect(within(menu).queryByText(/Reconnect your account/u)).not.toBeInTheDocument();
  });

  it('says where the person is expected while a switch waits on the browser, and lets the row be chosen again', () => {
    const enterpriseKey = desktopWorkspaceIdentityKey(enterprise.region, enterprise.id);
    const onSwitchWorkspace = vi.fn(() => new Promise<boolean>(() => undefined));
    renderMenu({ attention: {}, onSwitchWorkspace, signingInWorkspaceKey: enterpriseKey, switchingWorkspaceKey: enterpriseKey });
    openMenu();

    const europe = screen.getByRole('menuitem', { name: /Europe Studio/u });
    expect(within(europe).getByText(FINISH_SIGN_IN_IN_BROWSER)).toBeVisible();
    expect(europe).toHaveAccessibleName(new RegExp(FINISH_SIGN_IN_IN_BROWSER, 'u'));
    expect(within(europe).getByLabelText('Waiting for sign-in')).toBeVisible();

    // The person closed the browser without finishing: choosing the row again
    // opens it again rather than doing nothing.
    fireEvent.click(europe);
    expect(onSwitchWorkspace).toHaveBeenCalledWith(enterprise);
    expect(screen.getByRole('menu')).toBeVisible();
  });

  it('acknowledges a failed sign-in and keeps a row that is opening from being chosen twice', () => {
    const enterpriseKey = desktopWorkspaceIdentityKey(enterprise.region, enterprise.id);
    const props = renderMenu({
      attention: {},
      switchingWorkspaceKey: enterpriseKey,
      workspaceErrors: { [enterpriseKey]: 'Sign in could not be completed: access denied' },
    });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Sign in could not be completed: access denied');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    openMenu();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const europe = screen.getByRole('menuitem', { name: /Europe Studio/u });
    expect(within(europe).queryByText(FINISH_SIGN_IN_IN_BROWSER)).not.toBeInTheDocument();
    expect(within(europe).getByLabelText('Opening organization')).toBeVisible();
    fireEvent.click(europe);
    expect(props.onSwitchWorkspace).not.toHaveBeenCalled();
  });

  it('confirms an invitation and creates an organization from the same menu', async () => {
    const invite = {
      id: 'invite-1', workspaceId: 'workspace-invited', workspaceName: 'Invited Studio',
      region: 'global' as const, email: currentUser.email, role: 'member' as const,
      invitedByName: 'Grace', expiresAt: '2026-09-07T00:00:00.000Z',
    };
    const props = renderMenu({ invitations: [invite] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Join Invited Studio.*Grace/u }));

    const invitation = await screen.findByRole('dialog', { name: 'Join Invited Studio' });
    fireEvent.click(within(invitation).getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(props.onAcceptInvitation).toHaveBeenCalledWith(invite, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Join Invited Studio' })).not.toBeInTheDocument());

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create an organization' }));
    const create = await screen.findByRole('dialog', { name: 'Create an organization' });
    const workspaceName = within(create).getByLabelText('Organization name');
    expect(workspaceName).toHaveFocus();
    expect(workspaceName).toHaveAttribute('maxlength', '120');
    fireEvent.change(workspaceName, { target: { value: 'New Lab' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create organization' }));
    expect(props.onCreateWorkspace).toHaveBeenCalledWith(
      { name: 'New Lab', region: 'global' }, expect.any(String), { onSignInRequired: expect.any(Function) },
    );
  });

  it('notes the browser sign-in in the create dialog while creation waits on it', async () => {
    let progress: { onSignInRequired: () => void } | null = null;
    const onCreateWorkspace = vi.fn((
      _input: { name: string; region: string },
      _operationId: string,
      hooks: { onSignInRequired: () => void },
    ) => new Promise<void>(() => { progress = hooks; }));
    renderMenu({ onCreateWorkspace });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create an organization' }));
    const create = await screen.findByRole('dialog', { name: 'Create an organization' });
    expect(within(create).queryByRole('radio')).not.toBeInTheDocument();
    fireEvent.change(within(create).getByLabelText('Organization name'), { target: { value: 'New Lab' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(progress).not.toBeNull());
    expect(within(create).queryByText(FINISH_SIGN_IN_IN_BROWSER)).not.toBeInTheDocument();

    act(() => progress!.onSignInRequired());

    expect(within(create).getByText(FINISH_SIGN_IN_IN_BROWSER)).toBeVisible();
    // The person may have closed the browser instead: both ways out stay open.
    expect(within(create).getByRole('button', { name: 'Create organization' })).toBeEnabled();
    expect(within(create).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('lets a creation that waits on the browser be tried again, and drops the earlier attempt quietly', async () => {
    let progress: { onSignInRequired: () => void } | null = null;
    let rejectFirst: ((error: Error) => void) | null = null;
    const onCreateWorkspace = vi.fn()
      .mockImplementationOnce((
        _input: { name: string; region: string },
        _operationId: string,
        hooks: { onSignInRequired: () => void },
      ) => new Promise<void>((_resolve, reject) => {
        progress = hooks;
        rejectFirst = reject;
      }))
      .mockImplementationOnce(() => new Promise<void>(() => undefined));
    const props = renderMenu({ onCreateWorkspace });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create an organization' }));
    const create = await screen.findByRole('dialog', { name: 'Create an organization' });
    fireEvent.change(within(create).getByLabelText('Organization name'), { target: { value: 'Field Notes' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(progress).not.toBeNull());
    expect(within(create).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    act(() => progress!.onSignInRequired());
    expect(await within(create).findByText(FINISH_SIGN_IN_IN_BROWSER)).toBeVisible();

    fireEvent.click(within(create).getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(onCreateWorkspace).toHaveBeenCalledTimes(2));
    // The first attempt stands down as a newer sign-in supersedes it, and says
    // nothing in the dialog the second attempt now owns.
    act(() => rejectFirst!(new AccountSignInSupersededError()));
    await act(async () => { await Promise.resolve(); });
    expect(within(create).queryByText(/newer sign-in/u)).not.toBeInTheDocument();
    expect(within(create).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(props.onAbandonSignIn).not.toHaveBeenCalled();
  });

  it('abandons the creation, not the sign-in, when the dialog is closed while waiting on the browser', async () => {
    let progress: { onSignInRequired: () => void } | null = null;
    const onCreateWorkspace = vi.fn((
      _input: { name: string; region: string },
      _operationId: string,
      hooks: { onSignInRequired: () => void },
    ) => new Promise<void>(() => { progress = hooks; }));
    const props = renderMenu({ onCreateWorkspace });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create an organization' }));
    const create = await screen.findByRole('dialog', { name: 'Create an organization' });
    fireEvent.change(within(create).getByLabelText('Organization name'), { target: { value: 'Field Notes' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(progress).not.toBeNull());
    act(() => progress!.onSignInRequired());
    expect(await within(create).findByText(FINISH_SIGN_IN_IN_BROWSER)).toBeVisible();

    fireEvent.click(within(create).getByRole('button', { name: 'Cancel' }));

    expect(props.onAbandonSignIn).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create an organization' })).not.toBeInTheDocument());
  });

  it('submits organization creation with Enter but leaves an IME composition alone', async () => {
    const props = renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create an organization' }));
    const create = await screen.findByRole('dialog', { name: 'Create an organization' });
    const workspaceName = within(create).getByLabelText('Organization name');
    fireEvent.change(workspaceName, { target: { value: 'New Lab' } });

    fireEvent.keyDown(workspaceName, { key: 'Enter', isComposing: true });
    expect(props.onCreateWorkspace).not.toHaveBeenCalled();
    fireEvent.keyDown(workspaceName, { key: 'Enter' });

    await waitFor(() => expect(props.onCreateWorkspace).toHaveBeenCalledWith(
      { name: 'New Lab', region: 'global' }, expect.any(String), { onSignInRequired: expect.any(Function) },
    ));
  });

  it('reuses an operation id while retrying the same creation intent', async () => {
    const onCreateWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(undefined);
    renderMenu({ onCreateWorkspace });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create an organization' }));
    const create = await screen.findByRole('dialog', { name: 'Create an organization' });
    fireEvent.change(within(create).getByLabelText('Organization name'), { target: { value: 'New Lab' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create organization' }));
    expect(await screen.findByText('response lost')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    fireEvent.click(within(create).getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(onCreateWorkspace).toHaveBeenCalledTimes(2));
    expect(onCreateWorkspace.mock.calls[1]?.[1]).toBe(onCreateWorkspace.mock.calls[0]?.[1]);
  });

  it('shows a readable action error and clears it before another create attempt', async () => {
    renderMenu({
      onCreateWorkspace: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'onboarding:create-organization': Error: Sign in again to create an organization",
        );
      }),
    });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create an organization' }));
    let create = await screen.findByRole('dialog', { name: 'Create an organization' });
    fireEvent.change(within(create).getByLabelText('Organization name'), { target: { value: 'New Lab' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText('Sign in again to create an organization')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(within(create).queryByText(/Error invoking remote method/u)).not.toBeInTheDocument();
    fireEvent.click(within(create).getByRole('button', { name: 'Cancel' }));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create an organization' }));
    create = await screen.findByRole('dialog', { name: 'Create an organization' });
    expect(within(create).queryByText('Sign in again to create an organization')).not.toBeInTheDocument();
  });

  it('surfaces a signed-in invitation prompt without requiring the menu to open', async () => {
    const invite = {
      id: 'invite-1', workspaceId: 'workspace-invited', workspaceName: 'Invited Studio',
      region: 'global' as const, email: currentUser.email, role: 'member' as const,
      invitedByName: 'Grace', expiresAt: '2026-09-07T00:00:00.000Z',
    };
    const props = renderMenu({ invitations: [invite], promptedInvitation: invite });

    const dialog = await screen.findByRole('dialog', { name: 'Join Invited Studio' });
    expect(within(dialog).queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));

    expect(props.onInvitationPromptDismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Join Invited Studio' })).not.toBeInTheDocument();
  });

  it('lets an account-menu invitation be declined and removes its prompt', async () => {
    const invite = {
      id: 'invite-1', workspaceId: 'workspace-invited', workspaceName: 'Invited Studio',
      region: 'global' as const, email: currentUser.email, role: 'member' as const,
      invitedByName: 'Grace', expiresAt: '2026-09-07T00:00:00.000Z',
    };
    const props = renderMenu({ invitations: [invite] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Join Invited Studio.*Grace/u }));

    const dialog = await screen.findByRole('dialog', { name: 'Join Invited Studio' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(props.onDeclineInvitation).toHaveBeenCalledWith(invite));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Join Invited Studio' })).not.toBeInTheDocument());
  });

  it.each([true, false])('shows the active organization\'s usage with organizations enabled=%s', async (enabled) => {
    renderMenu({ enabled, activeUsage: <span>72% left till Thu 9:00 AM</span> });
    openMenu();
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByText('72% left till Thu 9:00 AM')).toHaveLength(1);
    expect(within(menu).queryByText('Organizations') !== null).toBe(enabled);
  });

  it('puts the usage row right under Settings, ahead of the Organizations list', async () => {
    renderMenu({ enabled: true, presentation: 'grok', activeUsage: <span>72% left till Thu 9:00 AM</span> });
    openMenu();
    const menu = await screen.findByRole('menu');
    const settingsRow = within(menu).getByRole('menuitem', { name: 'Settings' });
    const usage = within(menu).getByText('72% left till Thu 9:00 AM');
    const organizations = within(menu).getByText('Organizations');
    expect(settingsRow.nextElementSibling).toBe(usage);
    expect(usage.compareDocumentPosition(organizations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
