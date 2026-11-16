import { LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { Button, ErrorNotice } from '../components/primitives';
import { reportTelemetryProductIntent, uuidV7 } from '../lib/telemetry';
import type { PendingWorkspaceInvitation } from '../lib/types';

/**
 * The invitations waiting for the signed-in address, each with Accept and
 * Decline. Shared by the Mac app's first run and the browser's signed-in
 * screen, which the Expo app also shows. Each host supplies how an invitation
 * is answered: the Mac app through its bridge, the browser through its cookie.
 */
export function InvitationChoices({ invitations, onAccept, onDecline, onChanged }: {
  invitations: readonly PendingWorkspaceInvitation[];
  /** Resolves once the organization is opening, or rejects with what to show. */
  onAccept: (invitation: PendingWorkspaceInvitation, operationId: string) => Promise<void>;
  onDecline: (invitation: PendingWorkspaceInvitation) => Promise<void>;
  /** Re-reads the list after a decline, or after an accept that failed. */
  onChanged: () => Promise<unknown> | void;
}): React.JSX.Element {
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accept = async (invitation: PendingWorkspaceInvitation): Promise<void> => {
    const operationId = uuidV7();
    reportTelemetryProductIntent({
      kind: 'workspace_activation_requested',
      selectedRegion: invitation.region,
      entrypoint: 'invitation',
      operationId,
    });
    setWorkingId(invitation.id);
    setError(null);
    try {
      await onAccept(invitation, operationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The invitation could not be accepted.');
      await onChanged();
    } finally {
      setWorkingId(null);
    }
  };

  const decline = async (invitation: PendingWorkspaceInvitation): Promise<void> => {
    setWorkingId(invitation.id);
    setError(null);
    try {
      await onDecline(invitation);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The invitation could not be declined.');
    } finally {
      setWorkingId(null);
    }
  };

  return <>
    <div className="invitation-choice-list" aria-label="Invitations" role="list">
      {invitations.map((invitation) => (
        <article className="invitation-choice" key={invitation.id} role="listitem">
          <div>
            <strong>{invitation.workspaceName}</strong>
            <span>Invited by {invitation.invitedByName} · {invitation.role === 'admin' ? 'Administrator' : 'Member'}</span>
          </div>
          <div className="invitation-choice-actions">
            <Button disabled={workingId !== null} onClick={() => void decline(invitation)}>Decline</Button>
            <Button className="button-primary" disabled={workingId !== null} onClick={() => void accept(invitation)}>
              {workingId === invitation.id && <LoaderCircle aria-hidden="true" className="spin" size={14} />}
              Accept
            </Button>
          </div>
        </article>
      ))}
    </div>
    {error && <ErrorNotice>{error}</ErrorNotice>}
  </>;
}
