import type { SpaceErrorCode } from '@rally/contracts';

import { ApiError } from './api';

/**
 * Every way a Space operation is refused, and the one sentence each refusal is
 * shown as.
 *
 * Exhaustive over the server's closed `SpaceErrorCode` union plus the one code
 * that is not a Space refusal at all — a request that never got an answer. The
 * table is what makes a refusal actionable: each of these says what has to
 * change first, which a status code and a transport message cannot.
 *
 * Two of them are the whole reason **Manage access** exists rather than a
 * toggle. `space_membership_final` is the invariant that every Channel has a
 * home; `space_audience_incompatible` is the weaker one, that a reader who
 * keeps access through another source still has to be able to *find* the
 * Channel.
 *
 * One table for every Space surface, deliberately. It started on the dialog
 * while the dashboard and the sidebar section printed the server's own
 * sentence — the diagnostic a Worker wrote for a log, naming the Channel and
 * the Space in the Organization's internal words and changing whenever the
 * server's wording does.
 */
export type SpaceFailure = SpaceErrorCode | 'unavailable';

export const spaceFailureCopy: Record<SpaceFailure, string> = {
  space_access_denied: 'You can’t change who sees this channel.',
  space_not_found: 'That space no longer exists.',
  space_protected: 'General’s audience can’t be changed.',
  space_membership_final: 'This is the channel’s only space, and every channel needs one. Add it to another space first.',
  space_audience_incompatible: 'Some people who can read this channel would be left with no space to find it in. Add it to a space they can see first.',
  channel_scope_locked_by_space: 'An organization-wide space still makes this channel public. Remove it from that space first.',
  space_membership_content_fence: 'This channel holds content the wider audience isn’t allowed to read.',
  space_default_audience_mismatch: 'Everyone who can read this channel must be able to use that resource or Sidekick.',
  space_revision_conflict: 'The space changed while this was being applied. Try again.',
  space_bootstrap_pending: 'Rally is still opening this organization. Try again in a moment.',
  unavailable: 'That change couldn’t be saved. Try again in a moment.',
};

export function spaceFailureOf(cause: unknown): SpaceFailure {
  const code = cause instanceof ApiError ? cause.code : undefined;
  // A code outside the closed union is a transport or session failure rather
  // than a Space refusal, and `unavailable` is the only honest thing to say
  // about it — never the server's own sentence, which is not written for a
  // person and is not stable.
  return code !== undefined && code in spaceFailureCopy
    ? code as SpaceFailure
    : 'unavailable';
}

/**
 * The sentence for a refusal, or the caller's own when the server named no
 * Space code.
 *
 * The fallback is the action's sentence rather than the generic one, because a
 * surface that knows what was being attempted can say more than "that change
 * couldn't be saved" — "Spaces couldn't be reordered" also says the row on
 * screen snapped back.
 */
export function spaceFailureSentence(cause: unknown, fallback: string): string {
  const failure = spaceFailureOf(cause);
  return failure === 'unavailable' ? fallback : spaceFailureCopy[failure];
}
