import { Avatar, Badge, Button, IconButton } from '@rally/ui/components/primitives';
import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { asSubstreamId, asWorkspaceId, asWorkstreamId } from '@rally/contracts';
import { CreateScopeInvitationsSchema, type ScopeGrantTarget } from '@rally/contracts/scope-grants';
import { ApiError, type RallyApi } from '../lib/api';
import { ErrorNotice, Modal } from './primitives';

/**
 * A conversation's guest invitations by email: the ones still waiting for
 * their guest to sign in, inviting more, and taking one back. Shared by the
 * share panel and the title menu's People level, which read one cache entry.
 */
export function useScopeInvitations({ api, workspaceId, parentId, substreamId, enabled = true }: {
  api: RallyApi; workspaceId: string; parentId: string; substreamId: string; enabled?: boolean;
}) {
  // One retry identity per batch, kept until that batch is created, so a retry
  // replays the same operation even while another batch is in flight.
  const operations = useRef(new Map<string, string>());
  // Main is conversation 0: a workstream grant would also include inheriting children.
  // Built on use: a surface mounts this before it has a workspace to parse.
  const target = (): ScopeGrantTarget => ({ kind: 'conversation', workspaceId: asWorkspaceId(workspaceId),
    parentId: asWorkstreamId(parentId), substreamId: asSubstreamId(substreamId) });
  // Shares nobody has claimed yet. Someone who already has an account is
  // claimed as the share is made and appears among the participants instead.
  const pending = useQuery({
    queryKey: ['scope-invitations', parentId, substreamId],
    enabled,
    queryFn: async ({ signal }) => {
      const result = await api.listScopeInvitations(target(), signal);
      // Denied means this person cannot share here, so there is nothing of
      // theirs to manage; the form says so if they try.
      if (result.status !== 'ready') return [];
      // One row per address: sharing twice makes two pending shares, and
      // removing the person has to remove both, or the other still lets them in.
      const byEmail = new Map<string, Array<{ id: string; revision: number }>>();
      for (const invitation of result.invitations) {
        if (invitation.status !== 'pending' || (invitation.expiresAt !== null && invitation.expiresAt <= Date.now())) continue;
        byEmail.set(invitation.email, [...byEmail.get(invitation.email) ?? [], { id: invitation.id, revision: invitation.revision }]);
      }
      return [...byEmail].map(([email, shares]) => ({ email, shares }));
    },
  });
  const remove = useMutation({
    mutationFn: async (guest: { shares: Array<{ id: string; revision: number }> }) => {
      const results = await Promise.all(guest.shares.map((share) => api.revokeScopeInvitation(parentId, share.id, share.revision)));
      if (results.some((result) => result.status !== 'revoked')) throw new Error('scope invitation was not revoked');
    },
    onSettled: () => { void pending.refetch(); },
  });
  const invite = useMutation({ mutationFn: async (recipients: string[]) => {
    const targets = [target()];
    const key = JSON.stringify({ recipients, targets });
    const operationId = operations.current.get(key) ?? crypto.randomUUID();
    operations.current.set(key, operationId);
    const result = await api.createScopeInvitations({ operationId, parentId,
      emails: recipients, targets, completeWorkstream: false, expiresAt: null });
    if (result.status !== 'created') throw new Error('scope invitation was not created');
    operations.current.delete(key);
    return result;
  } });
  return { pending, invite, remove };
}

export function ScopeSharingPanel({ api, workspaceId, parentId, substreamId, onShared }: {
  api: RallyApi; workspaceId: string; parentId: string; substreamId: string;
  // Told when an invitation was created. The panel reports the outcome rather
  // than announcing it: the emptied form is what a container that stays open
  // shows, and the share dialog dismisses itself.
  onShared?: () => void;
}): React.JSX.Element {
  const [emails, setEmails] = useState('');
  const [failure, setFailure] = useState<'invalid_emails' | 'share' | 'remove' | 'joined' | null>(null);
  const { pending, invite, remove } = useScopeInvitations({ api, workspaceId, parentId, substreamId });
  return <section className="scope-sharing-panel" aria-label="Share by email" aria-busy={invite.isPending}>
    <form onSubmit={(event) => {
      event.preventDefault(); setFailure(null);
      const parsed = CreateScopeInvitationsSchema.shape.emails.safeParse(emails.split(/[\s,;]+/u).filter(Boolean));
      if (!parsed.success) { setFailure('invalid_emails'); return; }
      // The outcome is handled per call rather than on the hook: a share the
      // user dismissed mid-flight belongs to a panel that is gone, and these
      // callbacks are skipped once it has unmounted. A hook-level `onSuccess`
      // runs regardless, and would close whichever dialog was opened in its
      // place, taking the newly typed addresses with it.
      invite.mutate([...new Set(parsed.data)].sort(), {
        onSuccess: () => { setEmails(''); setFailure(null); void pending.refetch(); onShared?.(); },
        onError: () => { setFailure('share'); },
      });
    }}>
      <label className="form-field">Email addresses<textarea aria-label="Email addresses" value={emails} disabled={invite.isPending}
        onChange={(event) => setEmails(event.target.value)} placeholder="person@example.com" rows={2} /></label>
      <p>Separate email addresses with spaces, commas, or semicolons.</p>
      <Button type="submit" className="button-primary" disabled={invite.isPending || !emails.trim()}>{invite.isPending ? 'Sharing…' : 'Share'}</Button>
    </form>
    {failure ? <ErrorNotice>{failure === 'invalid_emails'
      ? 'Enter valid email addresses, separated by spaces, commas, or semicolons.'
      : failure === 'joined' ? 'They have already joined. Remove them from the participants instead.'
      : failure === 'remove' ? 'That guest couldn’t be removed. Try again.'
        : 'The conversation couldn’t be shared. Try again.'}</ErrorNotice> : null}
    {pending.isError ? <div className="scope-sharing-guests-failed">
      <ErrorNotice>Guests waiting to sign in couldn’t be loaded.</ErrorNotice>
      <Button disabled={pending.isFetching} onClick={() => void pending.refetch()}>Try again</Button>
    </div> : null}
    {pending.data?.length ? <div className="member-action-list" role="group" aria-label="Guests who have not signed in yet">
      {pending.data.map((guest) => <div className="member-action-row" key={guest.email}>
        <Avatar member={{ id: guest.email, name: guest.email, email: guest.email, timezone: 'UTC' }} size="medium" />
        <span><strong>{guest.email}</strong><small>Joins when they sign in with this address</small></span>
        <Badge className="role-badge">Guest</Badge>
        <IconButton label={`Remove ${guest.email}`} disabled={remove.isPending}
          onClick={() => { setFailure(null); remove.mutate(guest, { onError: (error) => setFailure(
            // They signed in between the list loading and this click: the
            // share is claimed, and the person is a participant now.
            error instanceof ApiError && error.code === 'scope_revision_conflict' ? 'joined' : 'remove') }); }}>
          <X aria-hidden="true" size={15} />
        </IconButton>
      </div>)}
    </div> : null}
  </section>;
}

export function ShareConversationDialog({ open, onOpenChange, ...props }: Omit<Parameters<typeof ScopeSharingPanel>[0], 'onShared'> & {
  open: boolean; onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  // Sharing is the dialog's only job, so a created invitation dismisses it.
  return <Modal open={open} onOpenChange={onOpenChange} title="Share conversation" description="Invite people to collaborate using their email address.">
    {open ? <ScopeSharingPanel {...props} onShared={() => onOpenChange(false)} /> : null}
  </Modal>;
}

