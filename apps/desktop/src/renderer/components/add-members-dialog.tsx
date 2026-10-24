import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, ErrorNotice, Modal } from './primitives';
import { InviteEmailField, inviteEmailsProblem, inviteMembers, useInviteEmails, type InviteMembersApi } from './invite-emails';

/**
 * The account menu's **Add new member**: the onboarding invite list in a
 * dialog. It closes once every address is invited; on a partial failure it
 * stays open holding only the addresses that failed, so a retry sends those.
 */
export function AddMembersDialog({ api, open, onClose }: {
  api: InviteMembersApi | null;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  // Mounted only while open, so a closed dialog leaves no draft behind.
  return <>{open && <AddMembersForm api={api} onClose={onClose} />}</>;
}

function AddMembersForm({ api, onClose }: { api: InviteMembersApi | null; onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const invite = useInviteEmails();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const count = invite.addresses.length;
  const send = async (): Promise<void> => {
    const problem = inviteEmailsProblem(invite);
    if (problem) { setError(new Error(problem)); return; }
    if (!api || busy) return;
    setBusy(true); setError(null);
    const addresses = invite.addresses;
    invite.replace(addresses);
    try {
      const { failures } = await inviteMembers(api, addresses, () => undefined);
      invite.replace(failures);
      if (failures.length) throw new Error(`Could not invite: ${failures.join(', ')}. Check the addresses and retry.`);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Something went wrong. Try again.'));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ['workspace-invitations'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
    }
  };
  return <Modal open onOpenChange={(next) => { if (!next && !busy) onClose(); }} title="Add new members"
    description="Invite teammates by email. Links expire after seven days."
    footer={<>
      <Button disabled={busy} onClick={onClose}>Cancel</Button>
      <Button className="button-primary" disabled={busy || !api} onClick={() => void send()}>
        {busy ? 'Inviting…' : count ? `Invite ${count} ${count === 1 ? 'teammate' : 'teammates'}` : 'Invite teammates'}
      </Button>
    </>}>
    <InviteEmailField invite={invite} disabled={busy} />
    {error && <ErrorNotice occurrence={error}>{error.message}</ErrorNotice>}
  </Modal>;
}
