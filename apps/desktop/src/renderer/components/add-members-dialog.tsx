import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, ErrorNotice, Modal } from './primitives';
import { InviteEmailField, failuresNotice, inviteEmailsProblem, inviteMembers, unemailedNotice, useInviteEmails, type InviteMembersApi } from './invite-emails';

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
  // Added but not told: a status, not a failure, and the dialog stays open so it is read.
  const [notice, setNotice] = useState<string | null>(null);
  const count = invite.addresses.length;
  const send = async (): Promise<void> => {
    const problem = inviteEmailsProblem(invite);
    if (problem) { setError(new Error(problem)); return; }
    if (!api || busy) return;
    setBusy(true); setError(null); setNotice(null);
    const addresses = invite.addresses;
    invite.replace(addresses);
    try {
      const { failures, unemailed } = await inviteMembers(api, addresses, () => undefined);
      invite.replace(failures.map((failure) => failure.email));
      // Stays open on the notice: closing would hide that these people were never told.
      if (unemailed.length) setNotice(unemailedNotice(unemailed));
      if (failures.length) throw new Error(failuresNotice(failures));
      if (!unemailed.length) onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Something went wrong. Try again.'));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ['workspace-invitations'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-members'] });
    }
  };
  return <Modal open onOpenChange={(next) => { if (!next && !busy) onClose(); }} title="Add new members"
    description="Add teammates by email. They're members right away, and get an email to sign in."
    footer={<>
      <Button disabled={busy} onClick={onClose}>{notice ? 'Done' : 'Cancel'}</Button>
      <Button className="button-primary" disabled={busy || !api} onClick={() => void send()}>
        {busy ? 'Adding…' : count ? `Add ${count} ${count === 1 ? 'teammate' : 'teammates'}` : 'Add teammates'}
      </Button>
    </>}>
    <InviteEmailField invite={invite} disabled={busy} />
    {notice && <p className="invite-unemailed-notice" role="status">{notice}</p>}
    {error && <ErrorNotice occurrence={error}>{error.message}</ErrorNotice>}
  </Modal>;
}
