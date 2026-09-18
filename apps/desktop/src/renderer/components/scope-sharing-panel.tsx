import { Share2 } from 'lucide-react';
import { Button } from '@rally/ui/components/primitives';
import { useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { asSubstreamId, asWorkspaceId, asWorkstreamId } from '@rally/contracts';
import { CreateScopeInvitationsSchema, type ScopeGrantTarget, type ScopeGrant } from '@rally/contracts/scope-grants';
import type { RallyApi } from '../lib/api';
import { InlineError, Modal } from './primitives';

export function ScopeSharingPanel({ api, workspaceId, parentId, substreamId }: {
  api: RallyApi; workspaceId: string; parentId: string; substreamId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [emails, setEmails] = useState('');
  const [completeWorkstream, setCompleteWorkstream] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const operation = useRef<{ key: string; id: string } | null>(null);
  const initial: ScopeGrantTarget = { kind: 'conversation', workspaceId: asWorkspaceId(workspaceId),
    parentId: asWorkstreamId(parentId), substreamId: asSubstreamId(substreamId) };
  const [selected, setSelected] = useState<ScopeGrantTarget[]>([initial]);
  const options = useQuery({ queryKey: ['scope-sharing-options', parentId],
    queryFn: ({ signal }) => api.getScopeSharingOptions(parentId, signal) });
  const targets = completeWorkstream ? options.data?.completeWorkstreamTargets ?? [] : selected;
  const scopeKey = (target: ScopeGrantTarget) => target.kind === 'workstream' ? 'workstream' : target.substreamId;
  const invitationQueries = useQueries({ queries: (targets.length ? targets : [initial]).map((target) => ({
    queryKey: ['scope-invitations', parentId, scopeKey(target)],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.listScopeInvitations(target, signal),
  })) });
  const grantQueries = useQueries({ queries: (targets.length ? targets : [initial]).map((target) => ({
    queryKey: ['managed-scope-grants', parentId, scopeKey(target)],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.listManagedScopeGrants(target, signal),
  })) });
  const grants = [...new Map(grantQueries.flatMap((query) => query.data?.status === 'ready'
    ? query.data.grants.map((entry) => [entry.grant.id, entry] as const) : [])).values()];
  const removalOperations = useRef(new Map<string, string>());
  const invitations = [...new Map(invitationQueries.flatMap((query) => query.data?.status === 'ready'
    ? query.data.invitations.map((invitation) => [invitation.id, invitation] as const) : [])).values()];
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['scope-invitations', parentId] });
    await queryClient.invalidateQueries({ queryKey: ['scope-sharing-options', parentId] });
    await queryClient.invalidateQueries({ queryKey: ['managed-scope-grants', parentId] });
  };
  const invite = useMutation({ mutationFn: async () => {
    const parsedEmails = CreateScopeInvitationsSchema.shape.emails.safeParse(emails.split(/[\s,;]+/u).filter(Boolean));
    if (!parsedEmails.success) throw new Error('Enter valid email addresses, separated by commas or spaces.');
    const recipients = [...new Set(parsedEmails.data)].sort();
    if (!targets.length) throw new Error('Choose at least one scope to share.');
    const key = JSON.stringify({ recipients, targets, completeWorkstream });
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    const result = await api.createScopeInvitations({ operationId: operation.current.id, parentId,
      emails: recipients, targets, completeWorkstream, expiresAt: null });
    if (result.status !== 'created') throw new Error('The invitation could not be created. Refresh and try again.');
    return result;
  }, onSuccess: async (result) => {
    setNotice(`Invited ${result.invitations.map((item) => item.email).join(', ')}.`);
    setEmails(''); operation.current = null; await refresh();
  } });
  const revoke = useMutation({ mutationFn: async (invitation: { id: string; revision: number }) => {
    const result = await api.revokeScopeInvitation(parentId, invitation.id, invitation.revision);
    if (result.status !== 'revoked') throw new Error('The invitation could not be revoked. Refresh and try again.');
  }, onSuccess: refresh });
  const removeGrant = useMutation({ mutationFn: async (grant: ScopeGrant) => {
    const key = `${grant.id}:${grant.revision}`;
    let operationId = removalOperations.current.get(key);
    if (!operationId) { operationId = crypto.randomUUID(); removalOperations.current.set(key, operationId); }
    const result = await api.revokeScopeGrant({ operationId, target: grant.target, userId: grant.userId, expectedRevision: grant.revision });
    if (result.status === 'conflict') {
      await refresh(); throw new Error('This share changed. Review the updated list before removing it.');
    }
    if (result.status === 'denied') throw new Error(result.reason === 'participant_required'
      ? 'At least one participant must retain access.' : 'You can no longer remove this share. Refresh and try again.');
  }, onSuccess: refresh });
  const pending = invite.isPending || revoke.isPending || removeGrant.isPending;
  const loadingInvitations = invitationQueries.some((query) => query.isPending);
  const loadingGrants = grantQueries.some((query) => query.isPending);
  const refreshing = options.isFetching || invitationQueries.some((query) => query.isFetching) || grantQueries.some((query) => query.isFetching);
  return <section className="scope-sharing-panel" aria-label="Share by email" aria-busy={options.isPending || loadingInvitations || loadingGrants}>
    <form onSubmit={(event) => { event.preventDefault(); setNotice(null); invite.mutate(); }}>
      <h3>Invite by email</h3>
      <label className="form-field">Email addresses<textarea aria-label="Email addresses" value={emails} disabled={pending}
        onChange={(event) => setEmails(event.target.value)} placeholder="person@example.com" rows={2} /></label>
      <fieldset disabled={pending || options.isPending}>
        <legend>Access</legend>
        {options.isPending && <p role="status">Loading sharing options…</p>}
        {options.data?.completeWorkstreamTargets ? <label className="scope-sharing-choice">
          <input type="checkbox" checked={completeWorkstream} onChange={(event) => setCompleteWorkstream(event.target.checked)} />
          Complete workstream, including existing restricted substreams
        </label> : null}
        {options.data?.scopes.map((scope) => <label className="scope-sharing-choice" key={scopeKey(scope.target)}>
          <input type="checkbox" disabled={completeWorkstream} checked={completeWorkstream || targets.some((target) => scopeKey(target) === scopeKey(scope.target))}
            onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, scope.target]
              : previous.filter((target) => scopeKey(target) !== scopeKey(scope.target)))} />
          {scope.title}
        </label>)}
      </fieldset>
      {options.isError ? <p role="alert">Unable to load sharing options. <Button type="button" onClick={() => { void options.refetch(); }}>Retry</Button></p> : null}
      {options.data?.scopes.length === 0 ? <p>You do not have sharing access here.</p> : null}
      <p>{completeWorkstream ? 'Includes every existing substream and its resources. Future restricted substreams need their own share.'
        : 'Shares the selected conversations and their resources. Sharing Main does not include private substreams unless selected separately.'}</p>
      <Button type="submit" className="button-primary" disabled={pending || !emails.trim() || !targets.length || !options.data?.scopes.length}>{invite.isPending ? 'Inviting…' : 'Send invitations'}</Button>
    </form>
    {notice ? <p role="status">{notice}</p> : null}
    {invite.error || revoke.error || removeGrant.error ? <InlineError>{invite.error?.message ?? revoke.error?.message ?? removeGrant.error?.message}</InlineError> : null}
    <h3>Invitations</h3>
    {loadingInvitations && <p role="status">Loading invitations…</p>}
    {!loadingInvitations && invitationQueries.every((query) => query.isSuccess && query.data.status === 'ready') && invitations.length === 0 && <p>No invitations for the selected conversations.</p>}
    {invitationQueries.some((query) => query.isError) ? <p role="alert">Unable to load invitations. <Button type="button" onClick={() => { void refresh(); }}>Retry</Button></p> : null}
    {invitations.length > 0 ? <ul aria-label="Invitations">
      {invitations.map((invitation) => <li key={invitation.id}>
        <span>{invitation.email} — {invitation.status === 'pending' && invitation.expiresAt !== null && invitation.expiresAt <= Date.now() ? 'expired' : invitation.status}</span>
        {invitation.status === 'pending' ? <Button type="button" disabled={pending} aria-label={`Revoke invitation for ${invitation.email}`} onClick={() => revoke.mutate(invitation)}>Revoke</Button> : null}
      </li>)}
    </ul> : null}
    <h3>Direct shares in selected conversations</h3>
    <p>Removing one share leaves access from other shares intact.</p>
    {loadingGrants && <p role="status">Loading direct shares…</p>}
    {!loadingGrants && grantQueries.every((query) => query.isSuccess && query.data.status === 'ready') && grants.length === 0 && <p>No direct shares for the selected conversations.</p>}
    {grantQueries.some((query) => query.isError) ? <p role="alert">Unable to load direct shares.</p> : null}
    <Button type="button" disabled={pending || refreshing} onClick={() => { void refresh(); }}>Refresh shares</Button>
    {grants.length > 0 ? <ul aria-label="Direct shares">{grants.map((entry) => {
      const label = options.data?.scopes.find((scope) => scopeKey(scope.target) === scopeKey(entry.grant.target))?.title ?? 'Selected conversation';
      const person = entry.name ?? entry.email ?? 'Former member';
      return <li key={entry.grant.id}><span>{person}{entry.email && entry.email !== person ? ` (${entry.email})` : ''} — {label}</span>
        <Button type="button" disabled={pending} aria-label={`Remove ${entry.email ?? person} from ${label}`}
          onClick={() => removeGrant.mutate(entry.grant)}>Remove share</Button></li>;
    })}</ul> : null}
  </section>;
}

export function ShareConversationButton(props: Parameters<typeof ScopeSharingPanel>[0]): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <><Button aria-label="Share conversation" onClick={() => setOpen(true)}><Share2 aria-hidden="true" size={16} />Share</Button>
    <Modal open={open} onOpenChange={setOpen} title="Share conversation" description="Invite people to collaborate using their email address.">
      {open ? <ScopeSharingPanel {...props} /> : null}
    </Modal></>;
}
