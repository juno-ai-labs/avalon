import { useId, useState } from 'react';
import { X } from 'lucide-react';
import type { RallyApi } from '../lib/api';

/**
 * Inviting teammates by a list of addresses, shared by onboarding and the
 * account menu's **Add new member** dialog. The hook holds the list, the field
 * draws it as chips, and `inviteMembers` sends it.
 */

const inviteEmailPattern = /^[^\s@]+@[^\s@]+$/u;
const separators = /[\s,;]+/u;

export function isInviteEmail(email: string): boolean {
  return inviteEmailPattern.test(email);
}

export interface InviteEmails {
  emails: string[];
  draft: string;
  /** Every address entered, the unfinished draft included, lowercased and once each. */
  addresses: string[];
  invalid: boolean;
  /** Turns separated text into chips; the last part stays a draft unless `commitLast`. */
  add: (value: string, commitLast: boolean) => void;
  setDraft: (value: string) => void;
  remove: (email: string) => void;
  /** Replaces the chips and clears the draft, as a send does with what failed. */
  replace: (emails: string[]) => void;
}

export function useInviteEmails(): InviteEmails {
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const addresses = [...new Set([...emails, ...draft.split(separators)].map((email) => email.trim().toLowerCase()).filter(Boolean))];
  return {
    emails,
    draft,
    addresses,
    invalid: addresses.some((email) => !isInviteEmail(email)),
    add: (value, commitLast) => {
      const parts = value.split(separators);
      const remaining = commitLast ? '' : parts.pop() ?? '';
      setEmails((previous) => [...new Set([...previous, ...parts.map((email) => email.trim().toLowerCase()).filter(Boolean)])]);
      setDraft(remaining);
    },
    setDraft,
    remove: (email) => setEmails((values) => values.filter((value) => value !== email)),
    replace: (next) => { setEmails(next); setDraft(''); },
  };
}

/** Why the list cannot be sent yet, or null when it can. */
export function inviteEmailsProblem(invite: InviteEmails): string | null {
  if (!invite.addresses.length) return 'Enter at least one email address.';
  if (invite.invalid) return 'One or more of the addresses are not a valid email address.';
  return null;
}

export function InviteEmailField({ invite, disabled }: { invite: InviteEmails; disabled: boolean }): React.JSX.Element {
  const id = useId();
  return (
    <div className="invite-email-field">
      <label htmlFor={`${id}-input`}>Email addresses</label>
      <div className="invite-email-chips">
        {invite.emails.map((email) => <span className="invite-email-chip" key={email} aria-invalid={!isInviteEmail(email) || undefined}>
          <span>{email}</span><button type="button" disabled={disabled} aria-label={`Remove ${email}`} onClick={() => invite.remove(email)}><X size={14} /></button>
        </span>)}
        <input id={`${id}-input`} aria-describedby={`${id}-hint`} disabled={disabled} autoComplete="off" autoCapitalize="none" spellCheck={false} value={invite.draft} placeholder="teammate@company.com"
          onChange={(event) => { if ('isComposing' in event.nativeEvent && event.nativeEvent.isComposing) invite.setDraft(event.target.value); else invite.add(event.target.value, false); }}
          onBlur={() => invite.add(invite.draft, true)}
          onPaste={(event) => { event.preventDefault(); const input = event.currentTarget; const value = invite.draft.slice(0, input.selectionStart ?? invite.draft.length) + event.clipboardData.getData('text') + invite.draft.slice(input.selectionEnd ?? invite.draft.length); invite.add(value, true); }}
          onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); invite.add(invite.draft, true); } }} />
      </div>
      <p id={`${id}-hint`}>Separate emails with a space, comma, or semicolon.</p>
    </div>
  );
}

export type InviteMembersApi = Pick<RallyApi, 'createWorkspaceInvitation' | 'getWorkspaceInvitees' | 'getWorkspaceMembers'>;

/**
 * Invites each address as a member, one at a time, and reports which failed.
 * An address already pending or already an active member counts as invited
 * without a second email: a second invitation would revoke the first link.
 * Pending addresses come from `/workspace/invitees`, which lists every one;
 * `/workspace/invitations` stops at the newest 100 of any status.
 */
export async function inviteMembers(
  api: InviteMembersApi,
  addresses: readonly string[],
  onInvited: (email: string) => void,
): Promise<{ failures: string[] }> {
  const [pendingInvitees, currentMembers] = await Promise.all([api.getWorkspaceInvitees(), api.getWorkspaceMembers()]);
  const alreadyInvited = new Set([
    ...pendingInvitees.map((invitee) => invitee.email.toLowerCase()),
    ...currentMembers.filter((member) => member.status === 'active').map((member) => member.email.toLowerCase()),
  ]);
  const failures: string[] = [];
  for (const email of addresses) {
    try { if (!alreadyInvited.has(email)) await api.createWorkspaceInvitation(email, 'member'); onInvited(email); }
    catch { failures.push(email); }
  }
  return { failures };
}
