import { IconShare2 } from '@tabler/icons-react';
import { Button, IconButton } from '@rally/ui/components/primitives';
import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { asSubstreamId, asWorkspaceId, asWorkstreamId } from '@rally/contracts';
import { CreateScopeInvitationsSchema, type ScopeGrantTarget } from '@rally/contracts/scope-grants';
import type { RallyApi } from '../lib/api';
import { InlineError, Modal } from './primitives';

export function ScopeSharingPanel({ api, workspaceId, parentId, substreamId, onShared }: {
  api: RallyApi; workspaceId: string; parentId: string; substreamId: string;
  // Told when an invitation was created. The panel reports the outcome rather
  // than announcing it: the emptied form is what a container that stays open
  // shows, and the share dialog dismisses itself.
  onShared?: () => void;
}): React.JSX.Element {
  const [emails, setEmails] = useState('');
  const [failure, setFailure] = useState<'invalid_emails' | 'share' | null>(null);
  const operation = useRef<{ key: string; id: string } | null>(null);
  // Main is conversation 0: a workstream grant would also include inheriting children.
  const target: ScopeGrantTarget = { kind: 'conversation', workspaceId: asWorkspaceId(workspaceId),
    parentId: asWorkstreamId(parentId), substreamId: asSubstreamId(substreamId) };
  const invite = useMutation({ mutationFn: async (recipients: string[]) => {
    const targets = [target];
    const key = JSON.stringify({ recipients, targets });
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    const result = await api.createScopeInvitations({ operationId: operation.current.id, parentId,
      emails: recipients, targets, completeWorkstream: false, expiresAt: null });
    if (result.status !== 'created') throw new Error('scope invitation was not created');
    return result;
  } });
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
        onSuccess: () => { setEmails(''); setFailure(null); operation.current = null; onShared?.(); },
        onError: () => { setFailure('share'); },
      });
    }}>
      <label className="form-field">Email addresses<textarea aria-label="Email addresses" value={emails} disabled={invite.isPending}
        onChange={(event) => setEmails(event.target.value)} placeholder="person@example.com" rows={2} /></label>
      <p>Separate email addresses with spaces, commas, or semicolons.</p>
      <Button type="submit" className="button-primary" disabled={invite.isPending || !emails.trim()}>{invite.isPending ? 'Sharing…' : 'Share'}</Button>
    </form>
    {failure ? <InlineError>{failure === 'invalid_emails'
      ? 'Enter valid email addresses, separated by spaces, commas, or semicolons.'
      : 'The conversation couldn’t be shared. Try again.'}</InlineError> : null}
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

export function ShareConversationButton({ disabled = false, ...props }: Omit<Parameters<typeof ScopeSharingPanel>[0], 'onShared'> & { disabled?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <><IconButton label="Share" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} data-state={open ? 'open' : 'closed'} onClick={() => setOpen(true)}><IconShare2 aria-hidden="true" size={18} stroke={1.8} /></IconButton>
    <ShareConversationDialog {...props} open={open} onOpenChange={setOpen} /></>;
}
