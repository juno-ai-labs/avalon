import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { ApiError, type RallyApi } from '../lib/api';

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

/** What to tell the person adding when some were added but their email could not be sent. */
export function unemailedNotice(unemailed: readonly string[]): string {
  return `Added, but the email to ${unemailed.join(', ')} could not be sent. Tell them to sign in to Rally with that address.`;
}

/** An address that was not added, and the refusal's own words. */
export interface InviteFailure {
  email: string;
  reason: string;
}

/** What to tell the person adding about the addresses that were not added. */
export function failuresNotice(failures: readonly InviteFailure[]): string {
  return `Could not add: ${failures.map((failure) => `${failure.email} (${failure.reason})`).join(', ')}. Check the addresses and retry.`;
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

export type InviteMembersApi = Pick<RallyApi, 'addWorkspaceMember' | 'getWorkspaceMembers'>;

/**
 * Adds each address as a member, one at a time, and reports which failed.
 * Each is a member as soon as it is added, with nothing to accept. An address
 * already a member counts as added without a second email, whether the list
 * read first or the add itself says so. A guest, or an
 * address an older invitation still waits for, is added: that makes them a
 * member and retires the invitation.
 */
export async function inviteMembers(
  api: InviteMembersApi,
  addresses: readonly string[],
  onInvited: (email: string) => void,
): Promise<{ failures: InviteFailure[]; unemailed: string[] }> {
  const currentMembers = await api.getWorkspaceMembers();
  const alreadyMembers = new Set(currentMembers
    .filter((member) => member.status === 'active' && member.accessClass !== 'guest')
    .map((member) => member.email.toLowerCase()));
  const failures: InviteFailure[] = [];
  // Added, but not told: the membership stands, so the person adding has to tell them.
  const unemailed: string[] = [];
  for (const email of addresses) {
    try {
      if (!alreadyMembers.has(email)) {
        const added = await api.addWorkspaceMember(email, 'member');
        if (added.emailDelivery === 'failed') unemailed.push(email);
      }
      onInvited(email);
    } catch (error) {
      // Added meanwhile, by someone else or a list this one did not see: what the press was for.
      if (error instanceof ApiError && error.code === 'already_workspace_member') { onInvited(email); continue; }
      failures.push({ email, reason: error instanceof Error && error.message ? error.message : 'unknown error' });
    }
  }
  return { failures, unemailed };
}
