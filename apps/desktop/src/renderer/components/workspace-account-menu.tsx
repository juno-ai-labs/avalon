import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { WorkspaceAttention } from '@rally/contracts';
import { Check, ChevronDown, LoaderCircle, LogOut, Plus, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type {
  DesktopPendingWorkspaceInvitation,
  DesktopWorkspaceSummary,
  RallyRegion,
} from '../../common/desktop';
import { desktopWorkspaceIdentityKey } from '../../common/desktop';
import type { WorkspaceMember } from '../lib/types';
import { formatRelative } from '../lib/format';
import { uuidV7 } from '../lib/telemetry';
import { Avatar, Button, Modal } from './primitives';

export interface WorkspaceAccountMenuProps {
  accountReconnectRequired?: boolean;
  activeWorkspace: DesktopWorkspaceSummary;
  attention: Record<string, WorkspaceAttention | undefined>;
  currentUser: WorkspaceMember;
  enabled: boolean;
  invitations: DesktopPendingWorkspaceInvitation[];
  loadingAttention: boolean;
  promptedInvitation?: DesktopPendingWorkspaceInvitation | null;
  staleAt: string | null;
  switchingWorkspaceKey?: string | null;
  workspaceErrors?: Record<string, string | undefined>;
  workspaces: DesktopWorkspaceSummary[];
  onAcceptInvitation: (invitation: DesktopPendingWorkspaceInvitation, operationId: string) => Promise<void>;
  onCreateWorkspace: (input: { name: string; region: RallyRegion }, operationId: string) => Promise<void>;
  onDeclineInvitation: (invitation: DesktopPendingWorkspaceInvitation) => Promise<void>;
  onMenuOpen: () => void;
  onReconnectAccount: () => Promise<void>;
  onInvitationPromptDismiss: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
  onSwitchWorkspace: (workspace: DesktopWorkspaceSummary) => Promise<void>;
}

function regionLabel(region: RallyRegion): string {
  return region === 'eu' ? 'European Union' : 'Global';
}

function countClass(attention: WorkspaceAttention): string {
  return attention.waitingReason === 'mentioned'
    ? 'is-mentioned'
    : attention.waitingReason === 'needs_input'
      ? 'is-needs-input'
      : 'is-unseen';
}

function attentionLabel(attention: WorkspaceAttention): string | null {
  if (attention.waitingForYou > 0) {
    const subject = attention.waitingReason === 'mentioned'
      ? 'mentions'
      : attention.waitingReason === 'needs_input'
        ? 'items needing input'
        : 'unseen items';
    return `${attention.waitingForYou} ${subject}`;
  }
  return attention.hasUnreadActivity ? 'Unread activity' : null;
}

function actionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '');
}

export function WorkspaceAccountMenu({
  accountReconnectRequired = false,
  activeWorkspace,
  attention,
  currentUser,
  enabled,
  invitations,
  loadingAttention,
  promptedInvitation = null,
  staleAt,
  switchingWorkspaceKey = null,
  workspaceErrors = {},
  workspaces,
  onAcceptInvitation,
  onCreateWorkspace,
  onDeclineInvitation,
  onMenuOpen,
  onReconnectAccount,
  onInvitationPromptDismiss,
  onOpenSettings,
  onSignOut,
  onSwitchWorkspace,
}: WorkspaceAccountMenuProps): React.JSX.Element {
  const [invitation, setInvitation] = useState<DesktopPendingWorkspaceInvitation | null>(null);
  const [creating, setCreating] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceRegion, setWorkspaceRegion] = useState<RallyRegion>('global');
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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
    if (actionPending || workspaceName.trim().length < 2) return;
    setActionPending(true);
    setActionError(null);
    const input = { name: workspaceName.trim(), region: workspaceRegion };
    const fingerprint = JSON.stringify(input);
    const operation = creationOperation.current?.fingerprint === fingerprint
      ? creationOperation.current
      : { fingerprint, id: uuidV7() };
    creationOperation.current = operation;
    void onCreateWorkspace(input, operation.id).then(() => {
      creationOperation.current = null;
      setCreating(false);
      setWorkspaceName('');
    }, (error: unknown) => {
      setActionError(actionErrorMessage(error, 'The workspace could not be created.'));
    }).finally(() => setActionPending(false));
  };

  return (
    <>
      <DropdownMenu.Root onOpenChange={(open) => { if (open && enabled) onMenuOpen(); }}>
        <DropdownMenu.Trigger asChild>
          <button
            aria-label={[
              currentUser.name,
              activeWorkspace.name,
              backgroundAttentionDescription,
            ].filter(Boolean).join(', ')}
            className="account-trigger window-no-drag"
            type="button"
          >
            <Avatar member={currentUser} size="small" />
            <span className="account-copy">
              <strong>{currentUser.name}</strong>
              <span>{activeWorkspace.name}</span>
            </span>
            {backgroundHasAttention && <span aria-hidden="true" className="account-attention-dot" />}
            <ChevronDown aria-hidden="true" size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" className="menu-content workspace-menu" side="top" sideOffset={8}>
            {enabled && (
              <>
                <DropdownMenu.Label className="menu-label workspace-menu-section">Workspaces</DropdownMenu.Label>
                {workspaces.map((workspace) => {
                  const workspaceKey = desktopWorkspaceIdentityKey(workspace.region, workspace.id);
                  const active = workspace.id === activeWorkspace.id && workspace.region === activeWorkspace.region;
                  const workspaceAttention = active ? undefined : attention[workspaceKey];
                  const count = workspaceAttention?.waitingForYou ?? 0;
                  const attentionDescription = workspaceAttention ? attentionLabel(workspaceAttention) : null;
                  const switching = workspaceKey === switchingWorkspaceKey;
                  const error = workspaceErrors[workspaceKey];
                  const label = [
                    workspace.name,
                    ...(multipleRegions ? [regionLabel(workspace.region)] : []),
                    ...(active ? ['Current'] : []),
                    ...(attentionDescription ? [attentionDescription] : []),
                    ...(error ? [error] : []),
                  ].join(', ');
                  return (
                    <DropdownMenu.Item
                      aria-label={label}
                      className="menu-item workspace-menu-item"
                      key={workspaceKey}
                      onSelect={(event) => {
                        if (active || switching) return;
                        event.preventDefault();
                        void onSwitchWorkspace(workspace);
                      }}
                    >
                      <span aria-hidden="true" className="workspace-mark">{workspace.name.slice(0, 1).toLocaleUpperCase()}</span>
                      <span className="workspace-menu-copy">
                        <span>{workspace.name}</span>
                        {error && <small className="workspace-menu-error">{error}</small>}
                      </span>
                      {multipleRegions && <small className="workspace-region-tag">{regionLabel(workspace.region)}</small>}
                      {switching && <LoaderCircle aria-label="Opening workspace" className="spin" size={14} />}
                      {active && <Check aria-label="Current" size={14} />}
                      {!active && !switching && count > 0 && workspaceAttention && (
                        <span className={`workspace-attention-count ${countClass(workspaceAttention)}`}>{count}</span>
                      )}
                      {!active && !switching && count === 0 && !loadingAttention && workspaceAttention?.hasUnreadActivity && (
                        <span aria-label="Unread activity" className="workspace-activity-dot" />
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
                  <DropdownMenu.Item className="menu-item" onSelect={() => {
                    setActionError(null);
                    setCreating(true);
                  }}>
                  <Plus size={14} /> Create a workspace
                </DropdownMenu.Item>
                {staleAt && (
                  <DropdownMenu.Label className="menu-label workspace-counts-stale">
                    Counts last updated {formatRelative(staleAt)}
                  </DropdownMenu.Label>
                )}
                {accountReconnectRequired && (
                  <DropdownMenu.Item className="menu-item" onSelect={() => { void onReconnectAccount(); }}>
                    Reconnect account…
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Separator className="menu-separator" />
              </>
            )}
            <DropdownMenu.Label className="menu-label">
              <span>{currentUser.email}</span>
              <small>{regionLabel(activeWorkspace.region)} workspace</small>
            </DropdownMenu.Label>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item asChild className="menu-item">
              <button onClick={onOpenSettings} type="button"><Settings size={14} /> Settings…</button>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={onSignOut}>
              <LogOut size={14} /> Sign out
            </DropdownMenu.Item>
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
        description="Choose carefully: a workspace's region cannot be changed later."
        footer={(
          <>
            <Button className="button-secondary" disabled={actionPending} onClick={() => {
              setActionError(null);
              creationOperation.current = null;
              setCreating(false);
            }}>Cancel</Button>
            <Button
              className="button-primary"
              disabled={actionPending || workspaceName.trim().length < 2}
              onClick={submitWorkspaceCreation}
            >Create workspace</Button>
          </>
        )}
        onOpenChange={(open) => {
          if (!open && !actionPending) {
            setActionError(null);
            creationOperation.current = null;
            setCreating(false);
          }
        }}
        initialFocusRef={workspaceNameInput}
        open={creating}
        title="Create a workspace"
      >
        <label className="field">
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
        <fieldset className="workspace-region-choice">
          <legend>Data region</legend>
          {(['global', 'eu'] as const).map((region) => (
            <label key={region}>
              <input
                checked={workspaceRegion === region}
                name="workspace-region"
                onChange={() => setWorkspaceRegion(region)}
                type="radio"
              />
              <span>
                <strong>{regionLabel(region)}</strong>
                <small>{region === 'eu' ? 'Data stored in the European Union' : 'Data stored in the United States'}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {actionError && <p className="inline-error">{actionError}</p>}
      </Modal>
    </>
  );
}
