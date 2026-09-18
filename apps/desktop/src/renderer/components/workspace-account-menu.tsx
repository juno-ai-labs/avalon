import { AccountTrigger } from '@rally/ui/components/account-trigger';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { desktopBridge } from '../lib/platform';
import type { WorkspaceAttention } from '@rally/contracts';
import { Check, LoaderCircle, LogOut, Plus, Settings, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { DesktopPendingWorkspaceInvitation, DesktopWorkspaceSummary, RallyRegion } from '../../common/desktop';
import { desktopWorkspaceIdentityKey } from '../../common/desktop';
import { AccountSignInSupersededError, FINISH_SIGN_IN_IN_BROWSER, type AccountActionProgress } from '../lib/app-session';
import type { WorkspaceMember } from '../lib/types';
import { uuidV7 } from '../lib/telemetry';
import { Button, Modal } from './primitives';
import { RelativeTime } from './relative-time';

export interface WorkspaceAccountMenuProps {
  activeWorkspace: DesktopWorkspaceSummary;
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
  onOpenSettings: () => void;
  onSignOut: () => void;
  /** Resolves true once the switch has taken; the menu closes on that and stays
   * open — with the row's error beneath it — when it did not. */
  onSwitchWorkspace: (workspace: DesktopWorkspaceSummary) => Promise<boolean>;
  /** The GrokBot shell keeps workspace administration out of its account card. */
  presentation?: 'workspace' | 'grok';
}

/** Deployment tags disambiguate workspaces when multiple deployments are configured. */
function regionLabel(region: RallyRegion): string {
  return region;
}

/** What the dot means when nothing is waiting on this person. */
export const UNREAD_ACTIVITY_DESCRIPTION = 'New activity since you last looked. Nothing is waiting on you.';

/**
 * One green dot marks a background workspace with any activity at all; the
 * detail — how many work streams are waiting on this person and the
 * strongest reason among them, in the order WorkspaceDO ranks them — is
 * kept for the tooltip and the accessible name rather than shown as a count.
 */
function attentionLabel(attention: WorkspaceAttention): string | null {
  const count = attention.waitingForYou;
  if (count > 0) {
    const plural = count === 1 ? '' : 's';
    return attention.waitingReason === 'mentioned'
      ? `${count} mention${plural} waiting for you`
      : attention.waitingReason === 'needs_input'
        ? `${count} work stream${plural} waiting for your input`
        : `${count} new work stream${plural} you have not opened`;
  }
  return attention.hasUnreadActivity ? 'Unread activity' : null;
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
  onOpenSettings,
  onSignOut,
  onSwitchWorkspace,
  presentation = 'workspace',
}: WorkspaceAccountMenuProps): React.JSX.Element {
  const [invitation, setInvitation] = useState<DesktopPendingWorkspaceInvitation | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
  const backgroundHasAttention = backgroundAttention.some((value) => attentionLabel(value) !== null);
  const backgroundAttentionDescription = backgroundAttention.some((value) => value.waitingForYou > 0)
    ? 'attention in another workspace'
    : backgroundHasAttention ? 'unread activity in another workspace' : null;
  const multipleRegions = new Set(workspaces.map((workspace) => workspace.region)).size > 1;

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
      setActionError(actionErrorMessage(error, 'The workspace could not be created.'));
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
          <AccountTrigger currentUser={currentUser} workspaceName={activeWorkspace.name}
            description={backgroundAttentionDescription} presentation={presentation} hasAttention={backgroundHasAttention} />
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
            {presentation === 'grok' && (
              <>
                <DropdownMenu.Item className="menu-item account-menu-item" onSelect={() => void desktopBridge().openSidekicks()}>
                  <Sparkles aria-hidden="true" />
                  <span>Sidekicks</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item account-menu-item" onSelect={onOpenSettings}>
                  <Settings aria-hidden="true" />
                  <span>Settings</span>
                </DropdownMenu.Item>
              </>
            )}
            {enabled && (
              <>
                <DropdownMenu.Label className="menu-label workspace-menu-section">Workspaces</DropdownMenu.Label>
                {workspaces.map((workspace) => {
                  const workspaceKey = desktopWorkspaceIdentityKey(workspace.region, workspace.id);
                  const active = workspace.id === activeWorkspace.id && workspace.region === activeWorkspace.region;
                  const workspaceAttention = active ? undefined : attention[workspaceKey];
                  const attentionDescription = workspaceAttention ? attentionLabel(workspaceAttention) : null;
                  const activityDetail = workspaceAttention && workspaceAttention.waitingForYou > 0
                    ? attentionDescription
                    : UNREAD_ACTIVITY_DESCRIPTION;
                  const switching = workspaceKey === switchingWorkspaceKey;
                  const signingIn = switching && workspaceKey === signingInWorkspaceKey;
                  const error = workspaceErrors[workspaceKey];
                  const label = [
                    workspace.name,
                    ...(multipleRegions ? [regionLabel(workspace.region)] : []),
                    ...(active ? ['Current'] : []),
                    ...(attentionDescription ? [attentionDescription] : []),
                    ...(signingIn ? [FINISH_SIGN_IN_IN_BROWSER] : []),
                    ...(error ? [error] : []),
                  ].join(', ');
                  return (
                    <DropdownMenu.Item
                      aria-label={label}
                      className="menu-item workspace-menu-item"
                      key={workspaceKey}
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
                        {error
                          ? <small className="workspace-menu-error">{error}</small>
                          : signingIn && <small className="workspace-menu-note">{FINISH_SIGN_IN_IN_BROWSER}</small>}
                      </span>
                      {multipleRegions && <small className="workspace-region-tag">{regionLabel(workspace.region)}</small>}
                      {switching && (
                        <LoaderCircle
                          aria-label={signingIn ? 'Waiting for sign-in' : 'Opening workspace'}
                          className="spin"
                          size={14}
                        />
                      )}
                      {active && <Check aria-label="Current" size={14} />}
                      {!active && !switching && attentionDescription && activityDetail && (
                        <IndicatorTooltip label={activityDetail}>
                          <span aria-label={attentionDescription} className="workspace-activity-dot" />
                        </IndicatorTooltip>
                      )}
                    </DropdownMenu.Item>
                  );
                })}
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
                    <Plus size={14} /> Create a workspace
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
                  <LogOut aria-hidden="true" />
                  <span>Log out</span>
                </DropdownMenu.Item>
              </>
            )}
            {presentation === 'workspace' && (
              <>
                <DropdownMenu.Label className="menu-label">
                  <span>{currentUser.email}</span>
                  <small>Workspace</small>
                </DropdownMenu.Label>
                <DropdownMenu.Separator className="menu-separator" />
                <DropdownMenu.Item asChild className="menu-item">
                  <button onClick={() => void desktopBridge().openSidekicks()} type="button">Sidekicks</button>
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild className="menu-item">
                  <button onClick={onOpenSettings} type="button"><Settings size={14} /> Settings…</button>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={onSignOut}>
                  <LogOut size={14} /> Sign out
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

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
        title={invitation ? `Join ${invitation.workspaceName}` : 'Join workspace'}
      >
        {actionError && <p className="inline-error">{actionError}</p>}
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
            >Create workspace</Button>
          </>
        )}
        onOpenChange={(open) => {
          // A creation that is waiting on the browser can be left, unlike one
          // that is in flight: the person may have closed the browser instead.
          if (!open && (!actionPending || creationSigningIn)) dismissWorkspaceCreation();
        }}
        initialFocusRef={workspaceNameInput}
        open={creating}
        title="Create a workspace"
      >
        <label className="form-field">
          <span>Workspace name</span>
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
        {actionError && <p className="inline-error">{actionError}</p>}
      </Modal>
    </>
  );
}
