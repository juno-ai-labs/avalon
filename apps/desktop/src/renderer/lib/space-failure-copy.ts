import { SpaceRefusalDetailsSchema, type SpaceErrorCode } from '@rally/contracts';

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
 * `space_membership_final` is the invariant that every Channel has a home.
 * `space_audience_incompatible` remains here only so an older server's refusal
 * still has product copy during a rolling deployment.
 *
 * One table for every Space surface, deliberately. Each sentence is therefore
 * written to be true wherever the refusal can arrive — the same
 * `space_membership_final` answers a Channel leaving its last Space and a
 * Space archive that would leave one of its Channels homeless, so it names the
 * invariant rather than the row the reader happens to be looking at.
 *
 * It started on the dialog while the dashboard and the sidebar section printed
 * the server's own sentence — the diagnostic a Worker wrote for a log, naming
 * the Channel and the Space in the Organization's internal words and changing
 * whenever the server's wording does.
 */
export type SpaceFailure = SpaceErrorCode | 'unavailable';

export const spaceFailureCopy: Record<SpaceFailure, string> = {
  // A read refusal as well as a write one: the same code answers a guest or a
  // removed member who cannot see a space at all, and somebody who reaches one
  // through a channel in it and cannot change it. Naming only the change told
  // the first the wrong thing.
  space_access_denied: 'Your access to that space doesn’t allow this.',
  space_not_found: 'That space no longer exists.',
  space_protected: 'General’s audience can’t be changed.',
  space_membership_final: 'Every channel needs a space, and this would leave one with none. Add it to another space first.',
  space_audience_incompatible: 'Some people who can read the channel would be left with no space to find it in. Add it to a space they can see first.',
  channel_scope_locked_by_space: 'An organization-wide space still makes this channel public. Remove it from that space first.',
  space_membership_content_fence: 'The channel holds content the wider audience isn’t allowed to read.',
  space_default_audience_mismatch: 'Everyone who can read the channel must be able to use that resource or Sidekick.',
  space_revision_conflict: 'The space changed while this was being applied. Try again.',
  space_bootstrap_pending: 'Rally is still opening this organization. Try again in a moment.',
  space_conversation_unreachable: 'One of the channels couldn’t be reached to check whether the new audience may read it. Try again in a moment.',
  // Its own sentence rather than `unavailable`'s, because the two are not the
  // same news: `unavailable` is "we don't know what happened", and this is the
  // space's own authority saying nothing — nothing about the request, the
  // organization or the channels needs changing before a retry.
  space_authority_unreachable: 'That space couldn’t be reached to make the change. Try again in a moment.',
  // Named rather than folded into `space_access_denied`: nothing is wrong with
  // this person's permission, and the fix is one word of the request — put
  // themselves back on the list.
  space_audience_self_excluded: 'You can’t make a space private without yourself in it. Add yourself back to keep access.',
  // Nothing a person did, and nothing they can fix: a stale cursor is the
  // client asking for a page of an ordering that has moved on. The sentence is
  // what the reader should do, which is look at the list again.
  space_cursor_invalid: 'That list has moved on. Reopen the space to see it from the top.',
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

/**
 * The Channels a refusal named as the ones to move first.
 *
 * Two Space refusals are about a Channel while the caller was acting on a
 * Space — the one that would be left with no home, and the one whose readers
 * would lose every way of finding it. The server carries their ids in the
 * error's `details`, narrowed to the Channels this viewer may already read, so
 * this can be empty on a genuine refusal and the sentence beside it still has
 * to stand on its own.
 */
export function spaceRefusalChannelIds(cause: unknown): string[] {
  if (!(cause instanceof ApiError)) return [];
  const parsed = SpaceRefusalDetailsSchema.safeParse(cause.details);
  return parsed.success ? [...parsed.data.channelIds] : [];
}

/** Title from the catalogs the caller has, or a fallback if this device has not listed the Channel. */
export function blockedChannelLabel(
  channelId: string,
  catalogs: readonly { id: string; title: string }[],
): string {
  return catalogs.find((item) => item.id === channelId)?.title
    ?? 'A channel that isn’t showing here';
}
