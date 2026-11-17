/**
 * The SQL condition that a person has signed in to Rally at least once: a
 * session was ever issued to them (sessions are never deleted). Someone an
 * administrator added by address before they ever signed in fails it.
 *
 * Email to a person who has not signed in is dropped, not queued: being added
 * must not turn into a stream of mail they never asked for. Their Activity
 * rows are kept, so they find what happened when they first open Rally. The
 * one email they do get is the one that says they were added
 * (`sendWorkspaceMemberAddedEmail`), which does not use this.
 * `docs/email-delivery.md`.
 */
export function hasSignedIn(userIdColumn: string): string {
  return `EXISTS (SELECT 1 FROM sessions signed_in WHERE signed_in.user_id = ${userIdColumn})`;
}
