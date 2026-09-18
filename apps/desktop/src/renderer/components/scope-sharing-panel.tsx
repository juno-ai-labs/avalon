import { IconShare2 } from '@tabler/icons-react';
import { Button, IconButton } from '@rally/ui/components/primitives';
import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { asSubstreamId, asWorkspaceId, asWorkstreamId } from '@rally/contracts';
import { CreateScopeInvitationsSchema, type ScopeGrantTarget } from '@rally/contracts/scope-grants';
import type { RallyApi } from '../lib/api';
import { InlineError, Modal } from './primitives';

export function ScopeSharingPanel({ api, workspaceId, parentId, substreamId }: {
  api: RallyApi; workspaceId: string; parentId: string; substreamId: string;
}): React.JSX.Element {
  const [emails, setEmails] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const operation = useRef<{ key: string; id: string } | null>(null);
  // Main is conversation 0: a workstream grant would also include inheriting children.
  const target: ScopeGrantTarget = { kind: 'conversation', workspaceId: asWorkspaceId(workspaceId),
    parentId: asWorkstreamId(parentId), substreamId: asSubstreamId(substreamId) };
  const invite = useMutation({ mutationFn: async () => {
    const parsedEmails = CreateScopeInvitationsSchema.shape.emails.safeParse(emails.split(/[\s,;]+/u).filter(Boolean));
    if (!parsedEmails.success) throw new Error('Enter valid email addresses, separated by spaces, commas, or semicolons.');
    const recipients = [...new Set(parsedEmails.data)].sort();
    const targets = [target];
    const key = JSON.stringify({ recipients, targets });
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    const result = await api.createScopeInvitations({ operationId: operation.current.id, parentId,
      emails: recipients, targets, completeWorkstream: false, expiresAt: null });
    if (result.status !== 'created') throw new Error('Unable to share this conversation. Please try again.');
    return result;
  }, onSuccess: (result) => {
    setNotice(`Invited ${result.invitations.map((item) => item.email).join(', ')}.`);
    setEmails(''); operation.current = null;
  } });
  return <section className="scope-sharing-panel" aria-label="Share by email" aria-busy={invite.isPending}>
    <form onSubmit={(event) => { event.preventDefault(); setNotice(null); invite.mutate(); }}>
      <label className="form-field">Email addresses<textarea aria-label="Email addresses" value={emails} disabled={invite.isPending}
        onChange={(event) => setEmails(event.target.value)} placeholder="person@example.com" rows={2} /></label>
      <p>Separate email addresses with spaces, commas, or semicolons.</p>
      <Button type="submit" className="button-primary" disabled={invite.isPending || !emails.trim()}>{invite.isPending ? 'Sharing…' : 'Share'}</Button>
    </form>
    {notice ? <p role="status">{notice}</p> : null}
    {invite.error ? <InlineError>{invite.error.message}</InlineError> : null}
  </section>;
}

export function ShareConversationDialog({ open, onOpenChange, ...props }: Parameters<typeof ScopeSharingPanel>[0] & {
  open: boolean; onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return <Modal open={open} onOpenChange={onOpenChange} title="Share conversation" description="Invite people to collaborate using their email address.">
    {open ? <ScopeSharingPanel {...props} /> : null}
  </Modal>;
}

export function ShareConversationButton({ disabled = false, ...props }: Parameters<typeof ScopeSharingPanel>[0] & { disabled?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <><IconButton label="Share" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} data-state={open ? 'open' : 'closed'} onClick={() => setOpen(true)}><IconShare2 aria-hidden="true" size={18} stroke={1.8} /></IconButton>
    <ShareConversationDialog {...props} open={open} onOpenChange={setOpen} /></>;
}
