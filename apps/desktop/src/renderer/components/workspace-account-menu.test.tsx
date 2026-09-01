import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceAccountMenu } from './workspace-account-menu';
import { desktopWorkspaceIdentityKey } from '../../common/desktop';

const currentUser = { id: 'user-1', name: 'Ada', email: 'ada@example.com', timezone: 'America/New_York' };
const active = {
  id: 'workspace-global', name: 'Global Studio', slug: 'global-studio', region: 'global' as const,
  role: 'owner' as const, createdAt: '2026-08-01T00:00:00.000Z',
};
const eu = {
  id: 'workspace-eu', name: 'Europe Studio', slug: 'europe-studio', region: 'eu' as const,
  role: 'member' as const, createdAt: '2026-08-02T00:00:00.000Z',
};

function renderMenu(overrides: Partial<React.ComponentProps<typeof WorkspaceAccountMenu>> = {}) {
  const props: React.ComponentProps<typeof WorkspaceAccountMenu> = {
    activeWorkspace: active,
    attention: {
      [desktopWorkspaceIdentityKey(eu.region, eu.id)]: {
        waitingForYou: 3, waitingReason: 'mentioned', hasUnreadActivity: true,
      },
    },
    currentUser,
    enabled: true,
    invitations: [],
    loadingAttention: false,
    onAcceptInvitation: vi.fn(async () => undefined),
    onCreateWorkspace: vi.fn(async () => undefined),
    onDeclineInvitation: vi.fn(async () => undefined),
    onInvitationPromptDismiss: vi.fn(),
    onMenuOpen: vi.fn(),
    onReconnectAccount: vi.fn(async () => undefined),
    onOpenSettings: vi.fn(),
    onSignOut: vi.fn(),
    onSwitchWorkspace: vi.fn(async () => undefined),
    staleAt: null,
    workspaces: [active, eu],
    ...overrides,
  };
  render(<WorkspaceAccountMenu {...props} />);
  return props;
}

function openMenu(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: /Ada/u }), { button: 0, ctrlKey: false });
}

describe('workspace account menu', () => {
  afterEach(() => vi.useRealTimers());
  it('shows background attention, a cross-region tag, and one-action switching', () => {
    const props = renderMenu();

    expect(screen.getByRole('button', { name: /Ada.*attention in another workspace/u }))
      .toBeVisible();
    openMenu();

    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Workspaces')).toBeVisible();
    expect(within(menu).getByRole('menuitem', { name: /Global Studio.*Global.*Current/u })).toBeVisible();
    const europe = within(menu).getByRole('menuitem', { name: /Europe Studio.*European Union.*3/u });
    expect(europe.querySelector('.workspace-attention-count')).toHaveClass('is-mentioned');

    fireEvent.click(europe);
    expect(props.onSwitchWorkspace).toHaveBeenCalledWith(eu);
  });

  it('marks unread-only activity on the account trigger', () => {
    renderMenu({
      attention: {
        [desktopWorkspaceIdentityKey(eu.region, eu.id)]: {
          waitingForYou: 0, waitingReason: null, hasUnreadActivity: true,
        },
      },
    });

    expect(screen.getByRole('button', { name: /Ada.*Global Studio.*unread activity in another workspace/u }))
      .toBeVisible();
  });

  it('does not mark a same-id workspace in another region as current', () => {
    const regionalCollision = { ...eu, id: active.id };
    const props = renderMenu({ attention: {}, workspaces: [active, regionalCollision] });

    openMenu();
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Global Studio.*Global.*Current/u })).toBeVisible();
    const europe = within(menu).getByRole('menuitem', { name: /Europe Studio.*European Union/u });
    expect(europe).not.toHaveAccessibleName(/Current/u);

    fireEvent.click(europe);
    expect(props.onSwitchWorkspace).toHaveBeenCalledWith(regionalCollision);
  });

  it('keeps stale values visible and identifies when they were last updated', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T20:07:00.000Z'));
    renderMenu({ staleAt: '2026-08-31T20:00:00.000Z' });
    openMenu();

    expect(screen.getByText('Counts last updated 7 minutes ago')).toBeVisible();
    expect(screen.getByText('3')).toBeVisible();
  });

  it('keeps the legacy one-workspace anatomy while the flag is off', () => {
    renderMenu({ enabled: false, workspaces: [active], attention: {} });
    openMenu();

    expect(screen.queryByText('Workspaces')).not.toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Settings…' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });

  it('offers an in-place account reconnect when a migrated session lacks platform identity', () => {
    const props = renderMenu({ accountReconnectRequired: true });
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Reconnect account…' }));
    expect(props.onReconnectAccount).toHaveBeenCalledOnce();
  });

  it('confirms an invitation and creates a workspace from the same menu', async () => {
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a workspace' }));
    const create = await screen.findByRole('dialog', { name: 'Create a workspace' });
    const workspaceName = within(create).getByLabelText('Workspace name');
    expect(workspaceName).toHaveFocus();
    expect(workspaceName).toHaveAttribute('maxlength', '120');
    fireEvent.change(workspaceName, { target: { value: 'New Lab' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create workspace' }));
    expect(props.onCreateWorkspace).toHaveBeenCalledWith(
      { name: 'New Lab', region: 'global' }, expect.any(String),
    );
  });

  it('submits workspace creation with Enter but leaves an IME composition alone', async () => {
    const props = renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a workspace' }));
    const create = await screen.findByRole('dialog', { name: 'Create a workspace' });
    const workspaceName = within(create).getByLabelText('Workspace name');
    fireEvent.change(workspaceName, { target: { value: 'New Lab' } });

    fireEvent.keyDown(workspaceName, { key: 'Enter', isComposing: true });
    expect(props.onCreateWorkspace).not.toHaveBeenCalled();
    fireEvent.keyDown(workspaceName, { key: 'Enter' });

    await waitFor(() => expect(props.onCreateWorkspace).toHaveBeenCalledWith(
      { name: 'New Lab', region: 'global' }, expect.any(String),
    ));
  });

  it('reuses an operation id while retrying the same creation intent', async () => {
    const onCreateWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(undefined);
    renderMenu({ onCreateWorkspace });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a workspace' }));
    const create = await screen.findByRole('dialog', { name: 'Create a workspace' });
    fireEvent.change(within(create).getByLabelText('Workspace name'), { target: { value: 'New Lab' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create workspace' }));
    expect(await within(create).findByText('response lost')).toBeVisible();

    fireEvent.click(within(create).getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(onCreateWorkspace).toHaveBeenCalledTimes(2));
    expect(onCreateWorkspace.mock.calls[1]?.[1]).toBe(onCreateWorkspace.mock.calls[0]?.[1]);
  });

  it('shows a readable action error and clears it before another create attempt', async () => {
    renderMenu({
      onCreateWorkspace: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'onboarding:create-workspace': Error: Sign in again to create a workspace",
        );
      }),
    });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a workspace' }));
    let create = await screen.findByRole('dialog', { name: 'Create a workspace' });
    fireEvent.change(within(create).getByLabelText('Workspace name'), { target: { value: 'New Lab' } });
    fireEvent.click(within(create).getByRole('button', { name: 'Create workspace' }));

    expect(await within(create).findByText('Sign in again to create a workspace')).toBeVisible();
    expect(within(create).queryByText(/Error invoking remote method/u)).not.toBeInTheDocument();
    fireEvent.click(within(create).getByRole('button', { name: 'Cancel' }));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a workspace' }));
    create = await screen.findByRole('dialog', { name: 'Create a workspace' });
    expect(within(create).queryByText('Sign in again to create a workspace')).not.toBeInTheDocument();
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
});
