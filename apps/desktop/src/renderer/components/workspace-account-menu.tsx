import { ErrorNotice } from './primitives';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { MenuActionItem } from '@rally/ui/components/menu-action-item';
import { IconDeviceDesktopDown, IconHexagons, IconLogout, IconSettings, IconUserPlus, IconUsers } from '@tabler/icons-react';
import { desktopBridge } from '../lib/platform';
import { useDownloadedUpdate } from '../lib/use-downloaded-update';
import type { SupportPerson, SupportWorkspace, WorkspaceAttention } from '@rally/contracts';
import { Check, LoaderCircle, Plus } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

import type { DesktopPendingWorkspaceInvitation, DesktopWorkspaceSummary, RallyRegion } from '../../common/desktop';
import { desktopWorkspaceIdentityKey } from '../../common/desktop';
import { AccountSignInSupersededError, FINISH_SIGN_IN_IN_BROWSER, type AccountActionProgress } from '../lib/app-session';
import { useShellCapabilities } from '../lib/collaboration-session';
import type { WorkspaceMember } from '../lib/types';
import { uuidV7 } from '../lib/telemetry';
import { ActivityCountBadge, Avatar, Button, Modal, activityCountLabel } from './primitives';
import { RailItem } from './rail-item';
import { RelativeTime } from './relative-time';
import { SupportWorkspaceMenuRow } from './support-workspace-menu';

export interface WorkspaceAccountMenuProps {
  activeWorkspace: DesktopWorkspaceSummary;
  /**
   * The active Organization's usage meter, a full row under Settings. A slot,
   * so the host supplies the read and opening the menu refreshes it.
   */
  activeUsage?: ReactNode;
  attention: Record<string, WorkspaceAttention | undefined>;
  currentUser: WorkspaceMember;
  enabled: boolean;
  invitations: DesktopPendingWorkspaceInvitation[];
  promptedInvitation?: DesktopPendingWorkspaceInvitation | null;
  /** The switching row whose activation is waiting on a sign-in finishing in
   * the browser. It stays selectable so the browser can be opened again. */
  signingInWorkspaceKey?: string | null;
  staleAt: string | null;
  switchingWorkspaceKey?: string | null;
  workspaceErrors?: Record<string, string | undefined>;
  workspaces: DesktopWorkspaceSummary[];
  onAcceptInvitation: (invitation: DesktopPendingWorkspaceInvitation, operationId: string) => Promise<void>;
  onCreateWorkspace: (
    input: { name: string; region: RallyRegion },
    operationId: string,
    progress: AccountActionProgress,
  ) => Promise<void>;
  onDeclineInvitation: (invitation: DesktopPendingWorkspaceInvitation) => Promise<void>;
  onMenuOpen: () => void;
  /** The create dialog was closed while its creation waited on the browser:
   * the creation stands down, and a sign-in that still lands is kept. */
  onAbandonSignIn: () => void;
  onInvitationPromptDismiss: () => void;
  /** Opens the add-members dialog. */
  onAddMembers: () => void;
  /** Whether the viewer may invite. When not, Add new member stays, disabled, and says why. */
  canAddMembers?: boolean;
  onOpenSettings: () => void;
  onSignOut: () => void;
  /** Resolves true once the switch has taken; the menu closes on that and stays
   * open — with the row's error beneath it — when it did not. */
  onSwitchWorkspace: (workspace: DesktopWorkspaceSummary) => Promise<boolean>;
  /** The GrokBot shell keeps workspace administration out of its account card. */
  presentation?: 'workspace' | 'grok';
  /**
   * Rally support access (`docs/impersonation.md`). `impersonator` is the
   * staff member acting as `currentUser` on a support session; the trigger
   * shows both, and **Sign out** becomes **End impersonation**, which
   * `onSignOut` must then do. `supportWorkspaces` are the Organizations that
   * granted Rally access, listed only to Rally staff.
   */
  impersonator?: WorkspaceMember | null;
  supportWorkspaces?: SupportWorkspace[];
  loadSupportPeople?: (workspaceId: string) => Promise<SupportPerson[]>;
  onStartSupportSession?: (workspace: SupportWorkspace, person: SupportPerson) => Promise<void>;
}

const ADD_MEMBERS_DISABLED_REASON = 'Only administrators can add members.';

/** Deployment tags disambiguate workspaces when multiple deployments are configured. */
function regionLabel(region: RallyRegion): string {
  return region;
}

/**
 * A background row's count is `readerAttentionCount`: the conversations unread,
 * unseen or mentioning this person, the same number as that Organization's
 * attention menu and dock badge. Zero shows nothing. When some of them are
 * waiting on this person, the strongest reason, in the order WorkspaceDO ranks
 * them, is the badge's tooltip and part of the row's accessible name.
 */
function waitingLabel(attention: WorkspaceAttention): string | null {
  const count = attention.waitingForYou;
  if (count === 0) return null;
  const plural = count === 1 ? '' : 's';
  return attention.waitingReason === 'mentioned'
    ? `${count} mention${plural} waiting for you`
    : attention.waitingReason === 'needs_input'
      ? `${count} thread${plural} waiting for your input`
      : `${count} new thread${plural} you have not opened`;
}

function IndicatorTooltip({ children, label }: { children: React.ReactElement; label: string }): React.JSX.Element {
  return (
    <Tooltip.Root delayDuration={300}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" side="top" sideOffset={6}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function actionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '');
}

export function WorkspaceAccountMenu({
  activeWorkspace,
  activeUsage = null,
  attention,
  currentUser,
  enabled,
  invitations,
  promptedInvitation = null,
  signingInWorkspaceKey = null,
  staleAt,
  switchingWorkspaceKey = null,
  workspaceErrors = {},
  workspaces,
  onAcceptInvitation,
  onCreateWorkspace,
  onDeclineInvitation,
  onMenuOpen,
  onAbandonSignIn,
  onInvitationPromptDismiss,
  onAddMembers,
  canAddMembers = false,
  onOpenSettings,
  onSignOut,
  onSwitchWorkspace,
  presentation = 'workspace',
  impersonator = null,
  supportWorkspaces = [],
  loadSupportPeople,
  onStartSupportSession,
}: WorkspaceAccountMenuProps): React.JSX.Element {
  // A guest attaches the Sidekicks a conversation offers; the library is for
  // members, who author them.
  const { guest } = useShellCapabilities();
  const [invitation, setInvitation] = useState<DesktopPendingWorkspaceInvitation | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const downloadedUpdate = useDownloadedUpdate();
  const [creating, setCreating] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const workspaceRegion = 'global';
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creationSigningIn, setCreationSigningIn] = useState(false);
  // Creating again while a creation waits on the browser starts a newer
  // attempt, whose sign-in supersedes the earlier one; the earlier promise
  // then settles without touching the dialog the newer one now owns.
  const creationAttempt = useRef(0);
  const creationOperation = useRef<{ fingerprint: string; id: string } | null>(null);
  const invitationOperation = useRef<{ invitationId: string; id: string } | null>(null);
  const workspaceNameInput = useRef<HTMLInputElement>(null);
  const backgroundAttention = enabled ? workspaces.flatMap((workspace) => {
    if (workspace.id === activeWorkspace.id && workspace.region === activeWorkspace.region) return [];
    const value = attention[desktopWorkspaceIdentityKey(workspace.region, workspace.id)];
    return value ? [value] : [];
  }) : [];
  // Only Organizations whose row shows a count, so the trigger's dot, its name
  // and the rows agree.
  const counted = backgroundAttention.filter((value) => value.readerAttentionCount > 0);
  const backgroundHasAttention = counted.length > 0;
  const backgroundAttentionDescription = counted.some((value) => value.waitingForYou > 0)
    ? 'attention in another organization'
    : backgroundHasAttention ? 'unread activity in another organization' : null;
  const multipleRegions = new Set(workspaces.map((workspace) => workspace.region)).size > 1;
  const supportRows = loadSupportPeople && onStartSupportSession ? supportWorkspaces.map((workspace) => (
    <SupportWorkspaceMenuRow
      current={impersonator && workspace.id === activeWorkspace.id && workspace.region === activeWorkspace.region
        ? currentUser.id : null}
      key={desktopWorkspaceIdentityKey(workspace.region, workspace.id)}
      loadPeople={loadSupportPeople}
      onChoose={(person) => onStartSupportSession(workspace, person).then(() => setMenuOpen(false))}
      workspace={workspace}
    />
  )) : [];

  useEffect(() => {
    if (!promptedInvitation) return;
    setActionError(null);
    setInvitation(promptedInvitation);
  }, [promptedInvitation]);

  const submitWorkspaceCreation = (): void => {
    if ((actionPending && !creationSigningIn) || workspaceName.trim().length < 2) return;
    const attempt = ++creationAttempt.current;
    setActionPending(true);
    setActionError(null);
    setCreationSigningIn(false);
    const input = { name: workspaceName.trim(), region: workspaceRegion };
    const fingerprint = JSON.stringify(input);
    const operation = creationOperation.current?.fingerprint === fingerprint
      ? creationOperation.current
      : { fingerprint, id: uuidV7() };
    creationOperation.current = operation;
    const current = (): boolean => creationAttempt.current === attempt;
    void onCreateWorkspace(input, operation.id, {
      onSignInRequired: () => { if (current()) setCreationSigningIn(true); },
    }).then(() => {
      if (!current()) return;
      creationOperation.current = null;
      setCreating(false);
      setWorkspaceName('');
    }, (error: unknown) => {
      if (!current() || error instanceof AccountSignInSupersededError) return;
      setActionError(actionErrorMessage(error, 'The organization could not be created.'));
    }).finally(() => {
      if (!current()) return;
      setActionPending(false);
      setCreationSigningIn(false);
    });
  };

  /** Close the create dialog; a creation waiting on the browser stands down. */
  const dismissWorkspaceCreation = (): void => {
    if (creationSigningIn) onAbandonSignIn();
    creationAttempt.current += 1;
    setActionPending(false);
    setCreationSigningIn(false);
    setActionError(null);
    creationOperation.current = null;
    setCreating(false);
  };

  return (
    <>
      <DropdownMenu.Root
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open && enabled) onMenuOpen();
        }}
        open={menuOpen}
      >
        <DropdownMenu.Trigger asChild>
          <RailItem
            aria-label={['Settings', currentUser.name, activeWorkspace.name,
              impersonator && `impersonated by ${impersonator.name}`, backgroundAttentionDescription].filter(Boolean).join(', ')}
            badge={impersonator && <span className="navigation-rail-impersonator"><Avatar member={impersonator} size="small" title={`Impersonated by ${impersonator.name}`} /></span>}
            icon={<Avatar member={currentUser} size="small" />}
            label="Settings"
          />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            alignOffset={8}
            className={presentation === 'grok' ? 'menu-content account-menu-content' : 'menu-content workspace-menu'}
            collisionPadding={8}
            side="top"
            sideOffset={8}
          >
            {downloadedUpdate !== null && (
              <DropdownMenu.Item className="menu-item account-menu-item" onSelect={() => void desktopBridge().installDownloadedUpdate()}>
                <IconDeviceDesktopDown aria-hidden="true" />
                <span>Restart to Update</span>
              </DropdownMenu.Item>
            )}
            {presentation === 'grok' && (
              <>
                {!guest && <MenuActionItem className="menu-item account-menu-item" disabled={!canAddMembers}
                  disabledReason={ADD_MEMBERS_DISABLED_REASON} onSelect={onAddMembers} tooltipSide="right">
                  <IconUserPlus aria-hidden="true" />
                  <span>Add new member</span>
                </MenuActionItem>}
                {!guest && <DropdownMenu.Item className="menu-item account-menu-item" onSelect={() => void desktopBridge().openSettings('members')}>
                  <IconUsers aria-hidden="true" />
                  <span>Members</span>
                </DropdownMenu.Item>}
                {!guest && <DropdownMenu.Item className="menu-item account-menu-item" onSelect={() => void desktopBridge().openSidekicks()}>
                  <IconHexagons aria-hidden="true" />
                  <span>Sidekicks</span>
                </DropdownMenu.Item>}
                <DropdownMenu.Item className="menu-item account-menu-item" onSelect={onOpenSettings}>
                  <IconSettings aria-hidden="true" />
                  <span>Settings</span>
                </DropdownMenu.Item>
                {activeUsage}
              </>
            )}
            {!enabled && supportRows.length > 0 && (
              <>
                <DropdownMenu.Label className="menu-label workspace-menu-section">Organizations</DropdownMenu.Label>
                {supportRows}
                <DropdownMenu.Separator className="menu-separator" />
              </>
            )}
            {enabled && (
              <>
                <DropdownMenu.Label className="menu-label workspace-menu-section">Organizations</DropdownMenu.Label>
                {workspaces.map((workspace) => {
                  const workspaceKey = desktopWorkspaceIdentityKey(workspace.region, workspace.id);
                  const active = workspace.id === activeWorkspace.id && workspace.region === activeWorkspace.region;
                  const workspaceAttention = active ? undefined : attention[workspaceKey];
                  const activityCount = workspaceAttention?.readerAttentionCount ?? 0;
                  const activityDescription = activityCount > 0 ? activityCountLabel(activityCount) : null;
                  const waitingDescription = activityCount > 0 && workspaceAttention ? waitingLabel(workspaceAttention) : null;
                  const switching = workspaceKey === switchingWorkspaceKey;
                  const signingIn = switching && workspaceKey === signingInWorkspaceKey;
                  const error = workspaceErrors[workspaceKey];
                  const label = [
                    workspace.name,
                    ...(multipleRegions ? [regionLabel(workspace.region)] : []),
                    ...(active ? ['Current'] : []),
                    ...(activityDescription ? [activityDescription] : []),
                    ...(waitingDescription ? [waitingDescription] : []),
                    ...(signingIn ? [FINISH_SIGN_IN_IN_BROWSER] : []),
                    ...(error ? [error] : []),
                  ].join(', ');
                  return (
                    <Fragment key={workspaceKey}>
                      <DropdownMenu.Item
                        aria-label={label}
                        className="menu-item workspace-menu-item"
                        onSelect={(event) => {
                          // A row waiting on the browser can be chosen again,
                          // which opens the browser again.
                          if (active || (switching && !signingIn)) return;
                          // The menu stays open while the switch is pending, so
                          // the row's spinner and any error land where the
                          // person is looking; it closes itself once it took.
                          event.preventDefault();
                          void onSwitchWorkspace(workspace).then(
                            (switched) => { if (switched) setMenuOpen(false); },
                            () => undefined,
                          );
                        }}
                      >
                        <span aria-hidden="true" className="workspace-mark">{workspace.name.slice(0, 1).toLocaleUpperCase()}</span>
                        <span className="workspace-menu-copy">
                          <span>{workspace.name}</span>
                          {signingIn && <small className="workspace-menu-note">{FINISH_SIGN_IN_IN_BROWSER}</small>}
                        </span>
                        {multipleRegions && <small className="workspace-region-tag">{regionLabel(workspace.region)}</small>}
                        {switching && (
                          <LoaderCircle
                            aria-label={signingIn ? 'Waiting for sign-in' : 'Opening organization'}
                            className="spin"
                            size={14}
                          />
                        )}
                        {active && <Check aria-label="Current" size={14} />}
                        {!active && !switching && activityDescription && (
                          <IndicatorTooltip label={waitingDescription ?? activityDescription}>
                            <span className="workspace-activity-count"><ActivityCountBadge count={activityCount} /></span>
                          </IndicatorTooltip>
                        )}
                      </DropdownMenu.Item>
                    </Fragment>
                  );
                })}
                {supportRows}
                {invitations.length > 0 && (
                  <DropdownMenu.Label className="menu-label workspace-menu-section">Invitations</DropdownMenu.Label>
                )}
                {invitations.map((pending) => (
                  <DropdownMenu.Item
                    aria-label={`Join ${pending.workspaceName}, invited by ${pending.invitedByName}`}
                    className="menu-item workspace-menu-item"
                    key={pending.id}
                    onSelect={() => {
                      setActionError(null);
                      setInvitation(pending);
                    }}
                  >
                    <span aria-hidden="true" className="workspace-mark">{pending.workspaceName.slice(0, 1).toLocaleUpperCase()}</span>
                    <span className="workspace-menu-copy">
                      <span>Join {pending.workspaceName}</span>
                      <small>Invited by {pending.invitedByName}</small>
                    </span>
                  </DropdownMenu.Item>
                ))}
                {presentation === 'workspace' && (
                  <DropdownMenu.Item className="menu-item" onSelect={() => {
                    setActionError(null);
                    setCreating(true);
                  }}>
                    <Plus size={14} /> Create an organization
                  </DropdownMenu.Item>
                )}
                {staleAt && (
                  <DropdownMenu.Label className="menu-label workspace-counts-stale">
                    Counts last updated <RelativeTime value={staleAt} />
                  </DropdownMenu.Label>
                )}
                {presentation === 'workspace' && <DropdownMenu.Separator className="menu-separator" />}
              </>
            )}
            {presentation === 'grok' && (
              <>
                <DropdownMenu.Separator className="menu-separator account-menu-separator" />
                <DropdownMenu.Item className="menu-item account-menu-item" onSelect={onSignOut}>
                  <IconLogout aria-hidden="true" />
                  <span>{impersonator ? 'End impersonation' : 'Log out'}</span>
                </DropdownMenu.Item>
              </>
            )}
            {presentation === 'workspace' && (
              <>
                <DropdownMenu.Label className="menu-label">
                  <span>{currentUser.email}</span>
                  <small>Organization</small>
                </DropdownMenu.Label>
                <DropdownMenu.Separator className="menu-separator" />
                {!guest && <MenuActionItem disabled={!canAddMembers}
                  disabledReason={ADD_MEMBERS_DISABLED_REASON} onSelect={onAddMembers} tooltipSide="right">
                  Add new member
                </MenuActionItem>}
                {!guest && <DropdownMenu.Item asChild className="menu-item">
                  <button onClick={() => void desktopBridge().openSettings('members')} type="button">Members</button>
                </DropdownMenu.Item>}
                {!guest && <DropdownMenu.Item asChild className="menu-item">
                  <button onClick={() => void desktopBridge().openSidekicks()} type="button">Sidekicks</button>
                </DropdownMenu.Item>}
                <DropdownMenu.Item asChild className="menu-item">
                  <button onClick={onOpenSettings} type="button"><IconSettings size={14} /> Settings…</button>
                </DropdownMenu.Item>
                {activeUsage}
                <DropdownMenu.Item className="menu-item" onSelect={onSignOut}>
                  <IconLogout size={14} /> {impersonator ? 'End impersonation' : 'Sign out'}
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {workspaces.map((workspace) => {
        const key = desktopWorkspaceIdentityKey(workspace.region, workspace.id);
        const error = workspaceErrors[key];
        return error ? <ErrorNotice key={key}>{error}</ErrorNotice> : null;
      })}

      <Modal
        description={invitation ? `${invitation.invitedByName} invited you as ${invitation.role}.` : undefined}
        footer={invitation ? (
          <>
            <Button className="button-secondary" disabled={actionPending} onClick={() => {
              invitationOperation.current = null;
              setInvitation(null);
              onInvitationPromptDismiss();
            }}>Not now</Button>
            {promptedInvitation?.id !== invitation.id && (
              <Button
                className="button-secondary"
                disabled={actionPending}
                onClick={() => {
                  setActionPending(true);
                  setActionError(null);
                  void onDeclineInvitation(invitation).then(
                    () => {
                      invitationOperation.current = null;
                      setInvitation(null);
                    },
                    (error: unknown) => setActionError(actionErrorMessage(
                      error, 'This invitation could not be declined.',
                    )),
                  ).finally(() => setActionPending(false));
                }}
              >Decline</Button>
            )}
            <Button
              className="button-primary"
              disabled={actionPending}
              onClick={() => {
                setActionPending(true);
                setActionError(null);
                const operation = invitationOperation.current?.invitationId === invitation.id
                  ? invitationOperation.current
                  : { invitationId: invitation.id, id: uuidV7() };
                invitationOperation.current = operation;
                void onAcceptInvitation(invitation, operation.id).then(
                  () => {
                    invitationOperation.current = null;
                    setInvitation(null);
                  },
                  (error: unknown) => setActionError(actionErrorMessage(
                    error, 'This invitation could not be accepted.',
                  )),
                ).finally(() => setActionPending(false));
              }}
            >Join</Button>
          </>
        ) : undefined}
        onOpenChange={(open) => {
          if (!open && !actionPending) {
            invitationOperation.current = null;
            setInvitation(null);
            if (promptedInvitation) onInvitationPromptDismiss();
          }
        }}
        open={invitation !== null}
        title={invitation ? `Join ${invitation.workspaceName}` : 'Join organization'}
      >
        {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
      </Modal>

      <Modal
        description="A shared home for your team and Rally."
        footer={(
          <>
            <Button
              className="button-secondary"
              disabled={actionPending && !creationSigningIn}
              onClick={dismissWorkspaceCreation}
            >Cancel</Button>
            <Button
              className="button-primary"
              disabled={(actionPending && !creationSigningIn) || workspaceName.trim().length < 2}
              onClick={submitWorkspaceCreation}
            >Create organization</Button>
          </>
        )}
        onOpenChange={(open) => {
          // A creation that is waiting on the browser can be left, unlike one
          // that is in flight: the person may have closed the browser instead.
          if (!open && (!actionPending || creationSigningIn)) dismissWorkspaceCreation();
        }}
        initialFocusRef={workspaceNameInput}
        open={creating}
        title="Create an organization"
      >
        <label className="form-field">
          <span>Organization name</span>
          <input
            maxLength={120}
            onChange={(event) => setWorkspaceName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submitWorkspaceCreation();
            }}
            ref={workspaceNameInput}
            value={workspaceName}
          />
        </label>

        {creationSigningIn && !actionError && <p className="inline-note">{FINISH_SIGN_IN_IN_BROWSER}</p>}
        {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
      </Modal>
    </>
  );
}
