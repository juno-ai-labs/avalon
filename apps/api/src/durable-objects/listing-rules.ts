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
 * For a thread the leaf is {@link threadOrganizationWideSql}, which admits a
 * guest too when they take part in a Channel the thread is placed in
 * ({@link channelReaderSql}). Everything else is participation or an explicit
 * grant, which a guest has exactly as a member does, so a call site never
 * branches on the access class; it passes it in.
 *
 * Listing is not reading. Each conversation's own authority still decides
 * whether its content may be opened; these rules decide only what a directory,
 * a sidebar or a socket frame may name. See `docs/listing-rules.md`.
 *
 * Every SQL fragment here is code-owned text over caller-chosen aliases; none
 * interpolates a value. The ones that look across tables **bind one `?` for the
 * user id** at the position the fragment sits, unless the caller passes the
 * user id expression it already has (a numbered `?1`). Every bare `?` a
 * fragment renders is the user id, so a caller binding positionally binds the
 * user id {@link userIdBindCount} times; how many depends on the access class.
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
 * Whether this person takes part in a Channel (a stored Space) this thread is
 * placed in: an active placement in an unarchived Space where they are a
 * participant. That is one path to reading every Organization-wide thread in
 * the Channel, and the only one a guest has to a thread they were not added
 * to. A Personal Channel is its owner's alone and lends nobody a thread.
 *
 * `workstreamId` is the thread's id column. Binds one `?` for the user id
 * unless `userId` names an expression the statement already has.
 */
export function channelReaderSql(workstreamId: string, userId = "?"): string {
  return `EXISTS (SELECT 1 ${CHANNEL_READER_FROM}
           WHERE reader_membership.workstream_id = ${workstreamId}
             AND reader_viewer.user_id = ${userId}
             AND ${CHANNEL_READER_WHERE})`;
}

/**
 * {@link channelReaderSql} as rows: every `(workstream_id, user_id)` pair it
 * admits for the threads `workstreamIds` names (a SQL list expression, such
 * as `SELECT value FROM json_each(?)`). Binds nothing of its own.
 */
export function channelReadersSql(workstreamIds: string): string {
  return `SELECT DISTINCT reader_membership.workstream_id, reader_viewer.user_id ${CHANNEL_READER_FROM}
           WHERE reader_membership.workstream_id IN (${workstreamIds})
             AND ${CHANNEL_READER_WHERE}`;
}

const CHANNEL_READER_FROM = `FROM space_channel_memberships reader_membership
            JOIN spaces reader_space
              ON reader_space.space_id = reader_membership.space_id
            JOIN space_viewers reader_viewer
              ON reader_viewer.space_id = reader_membership.space_id`;

const CHANNEL_READER_WHERE = `reader_membership.state = 'active'
             AND reader_space.archived_at IS NULL
             AND reader_space.scope <> 'individual'
             AND reader_viewer.is_participant = 1`;

/**
 * The leaf term for a thread or a Breakout: Organization-wide scope admits a
 * member, and a guest who is a Channel reader of the thread
 * ({@link channelReaderSql}). For a member the Channel adds nothing, so their
 * text carries no subquery and binds nothing.
 *
 * `row` is the thread or Breakout row's alias; both carry `scope` and
 * `workstream_id`. A guest's text binds one `?` unless `userId` is given.
 */
export function threadOrganizationWideSql(row: string, accessClass: AccessClass, userId = "?"): string {
  return admitsOrganizationWide(accessClass)
    ? `(${row}.scope = 'workspace')`
    : `(${row}.scope = 'workspace' AND ${channelReaderSql(`${row}.workstream_id`, userId)})`;
}

/**
 * How many times a positionally bound statement binds the user id for `sql`,
 * a fragment from this module rendered with the default `?`. Every bare `?`
 * this module writes is the user id, and a numbered one (`?1`) is the caller's.
 */
export function userIdBindCount(sql: string): number {
  return sql.match(/\?(?!\d)/g)?.length ?? 0;
}

/**
 * Whether this person may open a Channel's Main, from the projection.
 *
 * `viewer` is the Channel's `channel_viewers` row, left-joined under the
 * directory row's authority generation, so a missing or stale row reads as
 * "not a participant". A Channel grant makes a guest a Main participant.
 * A guest's text binds one `?` for the user id unless `userId` is given.
 */
export function mainOpenableSql(directory: string, viewer: string, accessClass: AccessClass, userId = "?"): string {
  return `(${threadOrganizationWideSql(directory, accessClass, userId)} OR ${viewer}.is_participant = 1)`;
}

/**
 * Whether this person may list a Breakout inside a Channel they may list.
 *
 * `listable` is the Breakout's own authority's answer for this person: their
 * membership of a private child, or a grant. An Organization-wide Breakout
 * inherits its Channel's audience, which is why the scope term is asked only
 * after the Channel's own rule has passed. A guest's text binds one `?` for
 * the user id unless `userId` is given.
 */
export function breakoutListedSql(breakout: string, viewer: string, accessClass: AccessClass, userId = "?"): string {
  return `(${threadOrganizationWideSql(breakout, accessClass, userId)} OR ${viewer}.listable = 1)`;
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
 * that has not reached it lists by Main alone. Binds the user id as
 * {@link userIdBindCount} counts, unless `userId` names an expression the
 * statement already has.
 */
export function channelListedSql(
  directory: string,
  viewer: string,
  accessClass: AccessClass,
  options: { breakouts: boolean; userId?: string },
): string {
  const main = mainOpenableSql(directory, viewer, accessClass, options.userId);
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
 * A Personal Channel (`individual`) is narrower still: its owner, and only
 * while they are a member. A participant row for anybody else does not list
 * it, and a guest has no Personal Channel, including one kept from before
 * they became a guest. See docs/spaces.md#the-personal-channel.
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
  const owned = admitsOrganizationWide(accessClass)
    ? `${space}.created_by_user_id = ${viewer}.user_id`
    : "0";
  return `(${organizationWideSql(`${space}.scope`, accessClass)}
            OR (${viewer}.user_id IS NOT NULL AND (${space}.scope <> 'individual' OR ${owned}))
            OR (${space}.scope = 'workspace'
                AND ${spaceReachedThroughChannelSql(space, accessClass, options)}))`;
}

/** The TypeScript form of {@link organizationWideSql}, for rows already read. */
export function organizationWide(scope: string, accessClass: AccessClass): boolean {
  return admitsOrganizationWide(accessClass) && scope === "workspace";
}

/**
 * The TypeScript form of {@link threadOrganizationWideSql}. `channelReader` is
 * {@link channelReaderSql}'s answer for this person and thread; a member's
 * answer does not depend on it.
 */
export function threadOrganizationWide(scope: string, accessClass: AccessClass, channelReader: boolean): boolean {
  return scope === "workspace" && (admitsOrganizationWide(accessClass) || channelReader);
}

/** The TypeScript form of {@link channelListedSql}, for rows already read. */
export function channelListed(input: {
  scope: string;
  accessClass: AccessClass;
  channelReader: boolean;
  mainParticipant: boolean;
  reachedThroughBreakout: boolean;
}): boolean {
  return threadOrganizationWide(input.scope, input.accessClass, input.channelReader)
    || input.mainParticipant || input.reachedThroughBreakout;
}
