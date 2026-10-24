import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceInvitee } from '@rally/contracts';
import { emailMentionAddresses } from '@rally/contracts/email-mentions';
import type { RallyApi } from './api';
import type { WorkspaceMember } from './types';

/**
 * Under the roster's key, so the `member_directory` publication that an
 * invitation, an acceptance and a revocation each send refreshes both.
 */
export const WORKSPACE_INVITEES_QUERY_KEY = ['workspace-members', 'invitees'] as const;

export const NO_INVITEES: readonly WorkspaceInvitee[] = [];

/**
 * People invited to the Organization who have not joined, for the pickers that
 * offer them beside members. A guest is never shown an address, so a guest
 * never asks.
 */
export function useWorkspaceInvitees(api: Pick<RallyApi, 'getWorkspaceInvitees'> | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: WORKSPACE_INVITEES_QUERY_KEY,
    queryFn: ({ signal }) => api!.getWorkspaceInvitees(signal),
    enabled: Boolean(api) && enabled,
    staleTime: 60_000,
  });
}

/**
 * An invitee where a member would be: the roster's own `invited` status, with
 * the address standing in for the name. Its id is `invitee:` and the address,
 * never a user id, and every surface that sends ids to the server already keeps
 * a membership that is not active out of what it sends.
 */
export function inviteeAsMember(email: string): WorkspaceMember {
  return { id: `invitee:${email}`, name: email, email, timezone: 'UTC', status: 'invited' };
}

export function isInvitee(member: WorkspaceMember): boolean {
  return member.status === 'invited';
}

/**
 * What an `@address` in a person's message names: the member who now holds
 * the address, or an invitee still waiting to join. Keyed by lower-case
 * address.
 */
export type EmailMentionTarget =
  | { kind: 'member'; member: WorkspaceMember }
  | { kind: 'invited'; email: string };

export type EmailMentionDirectory = ReadonlyMap<string, EmailMentionTarget>;

const EMPTY_DIRECTORY: EmailMentionDirectory = new Map();

/**
 * A member wins over an invitation for the same address, which is the moment
 * someone joins: the chip that read as their address now reads as their name.
 */
export function emailMentionDirectory(
  members: readonly WorkspaceMember[],
  invitees: readonly WorkspaceInvitee[],
): EmailMentionDirectory {
  const directory = new Map<string, EmailMentionTarget>();
  for (const invitee of invitees) directory.set(invitee.email.toLowerCase(), { kind: 'invited', email: invitee.email.toLowerCase() });
  for (const member of members) {
    if (member.email) directory.set(member.email.toLowerCase(), { kind: 'member', member });
  }
  return directory;
}

export const EmailMentionContext = createContext<EmailMentionDirectory>(EMPTY_DIRECTORY);

export function useEmailMentionTarget(email: string): EmailMentionTarget | undefined {
  return useContext(EmailMentionContext).get(email.toLowerCase());
}

/**
 * The invitees a draft names: the addresses it mentions, read as the renderer
 * reads them (`emailMentionAddresses`), that are exactly a pending invitee's.
 */
export function mentionedInvitees(text: string, invitees: readonly WorkspaceInvitee[]): string[] {
  const pending = new Set(invitees.map((invitee) => invitee.email.toLowerCase()));
  return emailMentionAddresses(text).filter((email) => pending.has(email));
}
