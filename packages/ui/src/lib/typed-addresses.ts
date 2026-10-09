import { CreateScopeInvitationsSchema } from '@rally/contracts/scope-grants';

import type { WorkspaceMember } from './types';

/**
 * Email addresses typed into a people search, read the same way everywhere a
 * search also invites: the title menu's People level and the new-Channel
 * Participants row.
 */

/** What may separate addresses typed into a people search. */
const ADDRESS_SEPARATORS = /[\s,;]+/u;
const EMAIL = CreateScopeInvitationsSchema.shape.emails.element;

export const ADDRESS_FORMAT_MESSAGE = 'Enter email addresses separated by spaces, commas or semicolons.';
export const MEMBERS_ONLY_MESSAGE = 'Only people in the organization can be added here.';

export function inactiveAccountsMessage(emails: readonly string[]): string {
  return `${emails.join(', ')} ${emails.length === 1 ? 'has' : 'have'} an organization account that isn’t active.`;
}

/** The query's words, lower case. */
export function typedTokens(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(ADDRESS_SEPARATORS).filter(Boolean);
}

/** Whether every word typed is an email address, so Enter reads them as addresses. */
export function areAddresses(tokens: readonly string[]): boolean {
  return tokens.length > 0 && tokens.every((token) => EMAIL.safeParse(token).success);
}

export interface TypedAddresses {
  /** People who hold an address, to add. */
  adds: WorkspaceMember[];
  /** Addresses whose membership is not active, which nothing may add or invite. */
  inactive: string[];
  /** Addresses nobody known holds, to invite. */
  strangers: string[];
}

/**
 * Sorts typed addresses by who holds them. `known` is the Organization's
 * members, whatever their status; `present` is the addresses already here,
 * lower case, which are skipped. An address invited to the Organization but
 * not yet joined has no membership, so it is a stranger, and inviting it is
 * the same share as picking it.
 */
export function resolveTypedAddresses(
  tokens: readonly string[],
  known: readonly WorkspaceMember[],
  present: ReadonlySet<string>,
): TypedAddresses {
  const byEmail = new Map(known.flatMap((member) => member.email ? [[member.email.toLocaleLowerCase(), member] as const] : []));
  const resolved: TypedAddresses = { adds: [], inactive: [], strangers: [] };
  for (const email of new Set(tokens)) {
    if (present.has(email)) continue;
    const member = byEmail.get(email);
    if (!member) resolved.strangers.push(email);
    else if ((member.status ?? 'active') === 'active') resolved.adds.push(member);
    else resolved.inactive.push(email);
  }
  return resolved;
}
