import type { SqlStorageValue } from "@cloudflare/workers-types";
import type { ConversationToolScope } from "./workspace-conversation-tool-protocol";

/**
 * Which Rally conversations an agent loop may reach with the conversation
 * tools, decided from WorkspaceDO's own directories.
 *
 * Two kinds of scope, one answer shape:
 *
 * - A **Sidekick** reaches its home (the Channel's Main conversation or the
 *   Breakout named by `automation_directory.owning_workstream_id` and
 *   `owning_substream_id`) and every conversation attached to it in
 *   `sidekick_conversation_attachments`. The home is always attached, so it is
 *   never a row there.
 * - A **Thread or Breakout loop** reaches its own conversation and, for a
 *   Breakout, its Thread's Main conversation, plus every Thread and Breakout
 *   in the readable Channels supplied by WorkspaceDO's Space storage.
 *
 * This is not `sidekick_attachments` (per conversation) or `parent_sidekicks`
 * (per Channel). Those record that a conversation may load a Sidekick as a
 * skill, and loading a skill writes them automatically; reading them as "the
 * Sidekick may read and post here" would hand a Sidekick every conversation
 * that ever used it.
 *
 * Everything here is a local read of `channels`, `breakouts`,
 * `channel_viewers`, `breakout_viewers` and Channel placements, so a list costs no call to a
 * Channel object and no D1 read. The rows are projections; the canonical
 * admission of a single target is still the hosted parent's `authorizeViewer`,
 * which the caller runs before a read or a post.
 */

/**
 * A Rally conversation: a Channel's Main (`"0"`) or one of its Breakouts
 * (parent kind `workstream`), or a Sidekick's own shared conversation (parent
 * kind `automation`, substream `"0"`, whose conversation id is the
 * Sidekick's), or a Canvas's Chat (parent kind `canvas`, substream `"0"`),
 * which a Sidekick may be attached to.
 */
export interface ConversationAddress {
  parentKind: "workstream" | "automation" | "canvas";
  parentId: string;
  substreamId: string;
}

/** A Thread or Breakout address, the only kind the directories describe. */
export type WorkstreamAddress = ConversationAddress & { parentKind: "workstream" };

/** What a Sidekick's conversation attachment names: a Thread or Breakout, or a Canvas's Chat (migration 140). */
export type AttachableAddress = ConversationAddress & { parentKind: "workstream" | "canvas" };

export interface ScopedConversation extends ConversationAddress {
  conversationId: string;
  kind: "channel" | "breakout" | "sidekick";
  title: string;
  isHome: boolean;
  isOwn: boolean;
  /** A conversation the loop's own sits inside: a Breakout loop's Thread Main. */
  isParent: boolean;
  archived: boolean;
  /** Whether the directories say this person can open it. */
  readable: boolean;
}

/** The migration-86 table. Keyed by the Sidekick and the whole address, so a repeat attach is one row. */
export const SIDEKICK_CONVERSATION_ATTACHMENT_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE sidekick_conversation_attachments (
    automation_id TEXT NOT NULL,
    parent_kind TEXT NOT NULL CHECK (parent_kind = 'workstream'),
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    attached_by_user_id TEXT NOT NULL,
    attached_at INTEGER NOT NULL CHECK (attached_at >= 0),
    PRIMARY KEY (automation_id, parent_kind, parent_id, substream_id)
  ) STRICT`,
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `<channelId>` for a Main conversation, `<channelId>/<breakoutId>` for a Breakout. */
export function conversationIdOf(address: Pick<ConversationAddress, "parentId" | "substreamId">): string {
  return address.substreamId === "0" ? address.parentId : `${address.parentId}/${address.substreamId}`;
}

/** The inverse of {@link conversationIdOf}; null for anything that is not one. */
export function parseConversationId(value: string): WorkstreamAddress | null {
  const [parentId, substreamId, extra] = value.trim().split("/");
  if (extra !== undefined || !parentId || !UUID.test(parentId)) return null;
  if (substreamId === undefined) return { parentKind: "workstream", parentId: parentId.toLowerCase(), substreamId: "0" };
  if (!UUID.test(substreamId)) return null;
  return { parentKind: "workstream", parentId: parentId.toLowerCase(), substreamId: substreamId.toLowerCase() };
}

interface DirectoryFacts {
  kind: "channel" | "breakout";
  title: string;
  archived: boolean;
  readable: boolean;
}

/**
 * One conversation's directory facts for one person, or null when the
 * Organization holds no row for it.
 *
 * A Breakout is archived when it or its Channel is. Readable follows the
 * hosted parent's rule on the projected rows: a Main conversation admits
 * every member when its Channel is workspace-scoped and its participants
 * otherwise; a Breakout admits its own members only.
 */
export function describeConversation(
  sql: SqlStorage,
  address: Pick<ConversationAddress, "parentId" | "substreamId">,
  userId: string,
): DirectoryFacts | null {
  return describeConversations(sql, [address], userId).get(conversationIdOf(address)) ?? null;
}

/** One directory read for any number of addresses; canonical admission stays with the caller. */
function describeConversations(
  sql: SqlStorage,
  addresses: readonly Pick<ConversationAddress, "parentId" | "substreamId">[],
  userId: string,
): Map<string, DirectoryFacts> {
  if (addresses.length === 0) return new Map();
  const rows = sql.exec<{
    parent_id: string; substream_id: string; title: string; archived: number; readable: number;
  }>(
    `WITH requested AS (
       SELECT json_extract(value, '$[0]') AS parent_id, json_extract(value, '$[1]') AS substream_id
         FROM json_each(?1)
     )
     SELECT requested.parent_id, requested.substream_id,
            CASE WHEN requested.substream_id = '0' THEN channel.title ELSE breakout.title END AS title,
            (channel.archived_at IS NOT NULL OR breakout.archived_at IS NOT NULL) AS archived,
            COALESCE(CASE WHEN requested.substream_id = '0'
              THEN channel.scope = 'workspace' OR viewer.is_participant = 1
              ELSE breakout_viewer.is_participant = 1 END, 0) AS readable
       FROM requested
       JOIN channels channel ON channel.workstream_id = requested.parent_id
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = requested.parent_id AND viewer.user_id = ?2
       LEFT JOIN breakouts breakout
         ON breakout.workstream_id = requested.parent_id AND breakout.substream_id = requested.substream_id
       LEFT JOIN breakout_viewers breakout_viewer
         ON breakout_viewer.workstream_id = requested.parent_id
        AND breakout_viewer.substream_id = requested.substream_id AND breakout_viewer.user_id = ?2
      WHERE requested.substream_id = '0' OR breakout.substream_id IS NOT NULL`,
    JSON.stringify(addresses.map((address) => [address.parentId, address.substreamId])), userId,
  ).toArray();
  return new Map(rows.map((row) => [conversationIdOf({ parentId: row.parent_id, substreamId: row.substream_id }), {
    kind: row.substream_id === "0" ? "channel" : "breakout",
    title: row.title, archived: row.archived === 1, readable: row.readable === 1,
  }]));
}

/** A Sidekick's home, or null for one no room owns (or one that was deleted). */
export function sidekickHome(sql: SqlStorage, automationId: string): WorkstreamAddress | null {
  const row = sql.exec<{ owning_workstream_id: string | null; owning_substream_id: string }>(
    `SELECT owning_workstream_id, owning_substream_id FROM automation_directory
      WHERE automation_id = ? AND lifecycle <> 'deleted'`,
    automationId,
  ).toArray()[0];
  if (!row?.owning_workstream_id) return null;
  return { parentKind: "workstream", parentId: row.owning_workstream_id, substreamId: row.owning_substream_id };
}

/** A Sidekick's title, or null for one that does not exist or was deleted. */
function sidekickTitle(sql: SqlStorage, automationId: string): string | null {
  const row = sql.exec<{ title: string }>(
    `SELECT title FROM automation_directory WHERE automation_id = ? AND lifecycle <> 'deleted'`,
    automationId,
  ).toArray()[0];
  return row ? row.title || "New Sidekick" : null;
}

/**
 * Every conversation in a scope that the Organization still has a directory
 * row for, with whether this person can open it and whether it is archived.
 *
 * Nothing is filtered on those two flags here: `conversation_list` omits both,
 * while a read or a post names the reason it refuses. Home (or own) comes
 * first, then Main for a Breakout loop, then Channel peers by id. A Sidekick
 * puts its home first and attachments in the order they were made.
 */
export function scopeConversations(
  sql: SqlStorage,
  scope: ConversationToolScope,
  userId: string,
  channelIds: readonly string[] = [],
): ScopedConversation[] {
  const addresses: Array<ConversationAddress & { isHome: boolean; isOwn: boolean; isParent: boolean }> = [];
  // Only a Sidekick's scope has an automation-kind address, its own.
  let sidekick: string | null = null;
  if (scope.kind === "conversation") {
    addresses.push({ parentKind: "workstream", parentId: scope.parentId, substreamId: scope.substreamId,
      isHome: false, isOwn: true, isParent: false });
    if (scope.substreamId !== "0") {
      addresses.push({ parentKind: "workstream", parentId: scope.parentId, substreamId: "0",
        isHome: false, isOwn: false, isParent: true });
    }
    // One hop from the current thread's Channels. A sibling's other Channel
    // never expands the scope again. UNION deduplicates shared placements.
    const ownIds = new Set(addresses.map(conversationIdOf));
    for (const row of channelIds.length === 0 ? [] : sql.exec<{ workstream_id: string; substream_id: string }>(
      `WITH threads AS (
         SELECT DISTINCT workstream_id FROM space_channel_memberships
          WHERE state = 'active' AND space_id IN (SELECT value FROM json_each(?))
       )
       SELECT workstream_id, '0' AS substream_id FROM threads
       UNION
       SELECT breakout.workstream_id, breakout.substream_id
         FROM breakouts breakout JOIN threads USING (workstream_id)
       ORDER BY 1, 2`,
      JSON.stringify(channelIds),
    ).toArray()) {
      if (ownIds.has(conversationIdOf({ parentId: row.workstream_id, substreamId: row.substream_id }))) continue;
      addresses.push({ parentKind: "workstream", parentId: row.workstream_id, substreamId: row.substream_id,
        isHome: false, isOwn: false, isParent: false });
    }
  } else {
    sidekick = sidekickTitle(sql, scope.automationId);
    if (sidekick === null) return [];
    // The Sidekick's own conversation comes first: the wizard's own, the one a
    // run sits inside, and where a post goes when it names no conversation.
    // Its admission is the Sidekick's (`authorizeViewer`), never the directories'.
    addresses.push({ parentKind: "automation", parentId: scope.automationId, substreamId: "0",
      isHome: false, isOwn: scope.authoring === true, isParent: scope.authoring !== true });
    const home = sidekickHome(sql, scope.automationId);
    if (home) addresses.push({ ...home, isHome: true, isOwn: false, isParent: false });
    for (const row of sql.exec<{ parent_kind: AttachableAddress["parentKind"]; parent_id: string; substream_id: string }>(
      `SELECT parent_kind, parent_id, substream_id FROM sidekick_conversation_attachments
        WHERE automation_id = ? ORDER BY attached_at, parent_id, substream_id`,
      scope.automationId,
    ).toArray()) {
      if (home && home.parentId === row.parent_id && home.substreamId === row.substream_id) continue;
      addresses.push({ parentKind: row.parent_kind, parentId: row.parent_id, substreamId: row.substream_id,
        isHome: false, isOwn: false, isParent: false });
    }
  }
  const descriptions = describeConversations(sql, addresses.filter((address) => address.parentKind === "workstream"), userId);
  const scoped: ScopedConversation[] = [];
  for (const address of addresses) {
    const facts = address.parentKind === "automation"
      ? { kind: "sidekick" as const, title: sidekick ?? "", archived: false, readable: true }
      : descriptions.get(conversationIdOf(address));
    if (!facts) continue;
    scoped.push({ ...address, conversationId: conversationIdOf(address), ...facts });
  }
  return scoped;
}

/**
 * The conversation whose admission stands for `target` within `scope`.
 *
 * A Breakout has full access to its Channel's Main, so in a Breakout's scope
 * Main is admitted by the Breakout itself: a Breakout member who cannot open
 * the Channel still reads what was said there. Breakout membership does not
 * require the Channel, so this is what lets a Breakout's agent use the
 * Channel it was branched from at all for such a member. Every other target
 * is admitted as itself.
 *
 * Read access only: a Breakout loop is offered list and read, never post. A
 * post offered to it later must not take this path, or a member outside the
 * Channel could post to Main.
 */
export function admissionAddress(
  scope: ConversationToolScope,
  target: Pick<ConversationAddress, "parentId" | "substreamId">,
): Pick<ConversationAddress, "parentId" | "substreamId"> {
  if (scope.kind === "conversation" && scope.substreamId !== "0"
    && target.parentId === scope.parentId && target.substreamId === "0") {
    return { parentId: scope.parentId, substreamId: scope.substreamId };
  }
  return target;
}

export type ReferenceMatch<T> =
  | { outcome: "found"; conversation: T }
  | { outcome: "ambiguous"; matches: T[] }
  | { outcome: "missing" };

/**
 * Which of `candidates` a model-supplied reference names: a `conversationId`
 * exactly, or else a title, compared without regard to case. More than one
 * title match is ambiguous rather than a guess.
 */
export function matchConversationReference<T extends { conversationId: string; title: string }>(
  candidates: readonly T[],
  reference: string,
): ReferenceMatch<T> {
  const address = parseConversationId(reference);
  if (address) {
    const id = conversationIdOf(address);
    const byId = candidates.find((candidate) => candidate.conversationId === id);
    if (byId) return { outcome: "found", conversation: byId };
  }
  const title = reference.trim().toLowerCase();
  const byTitle = title ? candidates.filter((candidate) => candidate.title.trim().toLowerCase() === title) : [];
  if (byTitle.length === 1) return { outcome: "found", conversation: byTitle[0]! };
  if (byTitle.length > 1) return { outcome: "ambiguous", matches: byTitle };
  return { outcome: "missing" };
}

interface TitledConversation extends WorkstreamAddress, DirectoryFacts {
  conversationId: string;
}

/**
 * Every Channel and Breakout titled `title` that this person can open, for an
 * attach that names a conversation the way the person did. Archived ones are
 * included so the refusal can say that is why.
 */
export function conversationsTitled(sql: SqlStorage, title: string, userId: string): TitledConversation[] {
  const rows = sql.exec<{ workstream_id: string; substream_id: string } & Record<string, SqlStorageValue>>(
    `SELECT channel.workstream_id, '0' AS substream_id
       FROM channels channel
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = channel.workstream_id AND viewer.user_id = ?1
      WHERE channel.title = ?2 COLLATE NOCASE
        AND (channel.scope = 'workspace' OR viewer.is_participant = 1)
     UNION ALL
     SELECT breakout.workstream_id, breakout.substream_id
       FROM breakouts breakout
       JOIN breakout_viewers viewer
         ON viewer.workstream_id = breakout.workstream_id
        AND viewer.substream_id = breakout.substream_id
        AND viewer.user_id = ?1
      WHERE breakout.title = ?2 COLLATE NOCASE AND viewer.is_participant = 1
      ORDER BY 1, 2`,
    userId, title.trim(),
  ).toArray();
  const found: TitledConversation[] = [];
  for (const row of rows) {
    const address: WorkstreamAddress = { parentKind: "workstream", parentId: row.workstream_id, substreamId: row.substream_id };
    const facts = describeConversation(sql, address, userId);
    if (facts) found.push({ ...address, ...facts, conversationId: conversationIdOf(address) });
  }
  return found;
}

/**
 * Record that a Sidekick may read and post in a conversation. Idempotent on
 * the Sidekick and the address; attaching the home is a no-op reported as
 * already attached, since the home always is.
 */
export function attachSidekickConversation(sql: SqlStorage, input: {
  automationId: string;
  address: AttachableAddress;
  userId: string;
  now: number;
}): { alreadyAttached: boolean } {
  const home = sidekickHome(sql, input.automationId);
  if (home && home.parentId === input.address.parentId && home.substreamId === input.address.substreamId) {
    return { alreadyAttached: true };
  }
  const inserted = sql.exec<{ automation_id: string }>(
    `INSERT INTO sidekick_conversation_attachments
       (automation_id, parent_kind, parent_id, substream_id, attached_by_user_id, attached_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING automation_id`,
    input.automationId, input.address.parentKind, input.address.parentId, input.address.substreamId, input.userId, input.now,
  ).toArray();
  return { alreadyAttached: inserted.length === 0 };
}
