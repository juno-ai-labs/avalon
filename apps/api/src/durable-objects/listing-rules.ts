/**
 * Who may be told a Space, a Channel or a Breakout exists: one ladder of
 * composable rules, the same for a member and a guest.
 *
 * Every rule is built from the one below it. A conversation (a Channel's Main
 * or a Breakout) is the leaf; a Channel is listed when any conversation in it
 * is one this person can open; a Space is listed when any Channel placed in it
 * is listed. So reach flows up from children and grandchildren and never down:
 * seeing a Space or a Channel is never a reason to see what is in it.
 *
 * The one difference between a member and a guest is the leaf term
 * {@link organizationWideSql}: Organization-wide scope admits members only.
 * Everything else is participation or an explicit grant, which a guest has
 * exactly as a member does, so a call site never branches on the access class;
 * it passes it in.
 *
 * Listing is not reading. Each conversation's own authority still decides
 * whether its content may be opened; these rules decide only what a directory,
 * a sidebar or a socket frame may name. See `docs/listing-rules.md`.
 *
 * Every SQL fragment here is code-owned text over caller-chosen aliases; none
 * interpolates a value. The ones that look across tables **bind one `?` for the
 * user id** at the position the fragment sits, unless the caller passes the
 * user id expression it already has (a numbered `?1`).
 */

export type AccessClass = "member" | "guest";

/** The person a listing is for, and their relationship to the Organization. */
export interface Viewer {
  userId: string;
  accessClass: AccessClass;
}

/** A member viewer, for the writes and durable intents only a member reaches. */
export function member(userId: string): Viewer {
  return { userId, accessClass: "member" };
}

/**
 * The one difference between a member and a guest, everywhere a person is
 * told something exists or may read it: Organization-wide scope admits a
 * member and never a guest. Listing (below), read authority
 * (`scope-grant-policy.ts`) and search's audience all ask this.
 */
export function admitsOrganizationWide(accessClass: AccessClass): boolean {
  return accessClass === "member";
}

/** The leaf term: Organization-wide scope, which admits members only. */
export function organizationWideSql(scope: string, accessClass: AccessClass): string {
  return admitsOrganizationWide(accessClass) ? `(${scope} = 'workspace')` : "(0)";
}

/**
 * Whether this person may open a Channel's Main, from the projection.
 *
 * `viewer` is the Channel's `channel_viewers` row, left-joined under the
 * directory row's authority generation, so a missing or stale row reads as
 * "not a participant". A Channel grant makes a guest a Main participant.
 */
export function mainOpenableSql(directory: string, viewer: string, accessClass: AccessClass): string {
  return `(${organizationWideSql(`${directory}.scope`, accessClass)} OR ${viewer}.is_participant = 1)`;
}

/**
 * Whether this person may list a Breakout inside a Channel they may list.
 *
 * `listable` is the Breakout's own authority's answer for this person: their
 * membership of a private child, or a grant. An Organization-wide Breakout
 * inherits its Channel's audience, which is why the scope term is asked only
 * after the Channel's own rule has passed.
 */
export function breakoutListedSql(breakout: string, viewer: string, accessClass: AccessClass): string {
  return `(${organizationWideSql(`${breakout}.scope`, accessClass)} OR ${viewer}.listable = 1)`;
}

/**
 * Whether this person reaches a Channel through a Breakout in it: any
 * unarchived Breakout their own access opens. Only explicit access counts
 * here; an Organization-wide Breakout inherits from the Channel, so it cannot
 * be the reason the Channel is listed.
 */
export function channelReachedThroughBreakoutSql(directory: string, userId = "?"): string {
  return `EXISTS (SELECT 1
            FROM breakouts reach_breakout
            JOIN breakout_viewers reach_breakout_viewer
              ON reach_breakout_viewer.workstream_id = reach_breakout.workstream_id
             AND reach_breakout_viewer.substream_id = reach_breakout.substream_id
             AND reach_breakout_viewer.authority_generation = reach_breakout.authority_generation
           WHERE reach_breakout.workstream_id = ${directory}.workstream_id
             AND reach_breakout_viewer.user_id = ${userId}
             AND reach_breakout.archived_at IS NULL
             AND reach_breakout_viewer.listable = 1)`;
}

/**
 * Whether this person may be told a Channel exists: its Main or any Breakout
 * in it is theirs to open.
 *
 * `breakouts` is whether this object has the Breakout projection; an object
 * that has not reached it lists by Main alone. Binds one `?` for the user id
 * when it does, unless `userId` names an expression the statement already has.
 */
export function channelListedSql(
  directory: string,
  viewer: string,
  accessClass: AccessClass,
  options: { breakouts: boolean; userId?: string },
): string {
  const main = mainOpenableSql(directory, viewer, accessClass);
  if (!options.breakouts) return main;
  return `(${main} OR ${channelReachedThroughBreakoutSql(directory, options.userId)})`;
}

/**
 * Whether this person reaches a Space through a Channel placed in it: any
 * active placement of a Channel they may list.
 *
 * Binds one `?` for the user id for the Channel's viewer join, then whatever
 * {@link channelListedSql} binds, unless `userId` is given.
 */
export function spaceReachedThroughChannelSql(
  space: string,
  accessClass: AccessClass,
  options: { breakouts: boolean; userId?: string },
): string {
  const userId = options.userId ?? "?";
  return `EXISTS (SELECT 1
            FROM space_channel_memberships reach_membership
            JOIN channels reach_directory
              ON reach_directory.workstream_id = reach_membership.workstream_id
            LEFT JOIN channel_viewers reach_viewer
              ON reach_viewer.workstream_id = reach_directory.workstream_id
             AND reach_viewer.user_id = ${userId}
             AND reach_viewer.authority_generation = reach_directory.authority_generation
           WHERE reach_membership.space_id = ${space}.space_id
             AND reach_membership.state = 'active'
             AND reach_directory.archived_at IS NULL
             AND ${channelListedSql("reach_directory", "reach_viewer", accessClass, options)})`;
}

/**
 * Whether this person may be told a Space exists: Organization-wide (members),
 * a participant, or a Channel in it they may list — the last only while the
 * Space is Organization-wide.
 *
 * A private Space (the product's private Channel) is listed to its
 * participants alone. Reaching it through a thread placed in it would name a
 * private Channel to somebody its owners did not add, which is the one thing
 * making it private is for.
 *
 * `viewer` is the Space's own viewer row, already narrowed to participants by
 * its join, so `user_id IS NOT NULL` is participation.
 */
export function spaceListedSql(
  space: string,
  viewer: string,
  accessClass: AccessClass,
  options: { breakouts: boolean; userId?: string },
): string {
  return `(${organizationWideSql(`${space}.scope`, accessClass)}
            OR ${viewer}.user_id IS NOT NULL
            OR (${space}.scope = 'workspace'
                AND ${spaceReachedThroughChannelSql(space, accessClass, options)}))`;
}

/** The TypeScript form of {@link organizationWideSql}, for rows already read. */
export function organizationWide(scope: string, accessClass: AccessClass): boolean {
  return admitsOrganizationWide(accessClass) && scope === "workspace";
}

/** The TypeScript form of {@link channelListedSql}, for rows already read. */
export function channelListed(input: {
  scope: string;
  accessClass: AccessClass;
  mainParticipant: boolean;
  reachedThroughBreakout: boolean;
}): boolean {
  return organizationWide(input.scope, input.accessClass) || input.mainParticipant || input.reachedThroughBreakout;
}
