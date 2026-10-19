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
 *   Breakout, its Thread's Main conversation. The Channels the Thread is in
 *   are added by WorkspaceDO from its Space storage, not here.
 *
 * This is not `sidekick_attachments` (per conversation) or `parent_sidekicks`
 * (per Channel). Those record that a conversation may load a Sidekick as a
 * skill, and loading a skill writes them automatically; reading them as "the
 * Sidekick may read and post here" would hand a Sidekick every conversation
 * that ever used it.
 *
 * Everything here is a local read of `channels`, `breakouts`,
 * `channel_viewers` and `breakout_viewers`, so a list costs no call to a
 * Channel object and no D1 read. The rows are projections; the canonical
 * admission of a single target is still the hosted parent's `authorizeViewer`,
 * which the caller runs before a read or a post.
 */

/** A Rally conversation: a Channel's Main (`"0"`) or one of its Breakouts. */
export interface ConversationAddress {
  parentKind: "workstream";
  parentId: string;
  substreamId: string;
}


export interface ScopedConversation extends ConversationAddress {
  conversationId: string;
  kind: "channel" | "breakout";
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
export function parseConversationId(value: string): ConversationAddress | null {
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
  const channel = sql.exec<{ title: string; scope: string; archived_at: number | null; participant: number | null }>(
    `SELECT channel.title, channel.scope, channel.archived_at, viewer.is_participant AS participant
       FROM channels channel
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = channel.workstream_id AND viewer.user_id = ?
      WHERE channel.workstream_id = ?`,
    userId, address.parentId,
  ).toArray()[0];
  if (!channel) return null;
  if (address.substreamId === "0") {
    return {
      kind: "channel",
      title: channel.title,
      archived: channel.archived_at !== null,
      readable: channel.scope === "workspace" || channel.participant === 1,
    };
  }
  const breakout = sql.exec<{ title: string; archived_at: number | null; participant: number | null }>(
    `SELECT breakout.title, breakout.archived_at, viewer.is_participant AS participant
       FROM breakouts breakout
       LEFT JOIN breakout_viewers viewer
         ON viewer.workstream_id = breakout.workstream_id
        AND viewer.substream_id = breakout.substream_id
        AND viewer.user_id = ?
      WHERE breakout.workstream_id = ? AND breakout.substream_id = ?`,
    userId, address.parentId, address.substreamId,
  ).toArray()[0];
  if (!breakout) return null;
  return {
    kind: "breakout",
    title: breakout.title,
    archived: breakout.archived_at !== null || channel.archived_at !== null,
    readable: breakout.participant === 1,
  };
}

/** A Sidekick's home, or null for one no room owns (or one that was deleted). */
export function sidekickHome(sql: SqlStorage, automationId: string): ConversationAddress | null {
  const row = sql.exec<{ owning_workstream_id: string | null; owning_substream_id: string }>(
    `SELECT owning_workstream_id, owning_substream_id FROM automation_directory
      WHERE automation_id = ? AND lifecycle <> 'deleted'`,
    automationId,
  ).toArray()[0];
  if (!row?.owning_workstream_id) return null;
  return { parentKind: "workstream", parentId: row.owning_workstream_id, substreamId: row.owning_substream_id };
}

function sidekickExists(sql: SqlStorage, automationId: string): boolean {
  return sql.exec(
    `SELECT 1 FROM automation_directory WHERE automation_id = ? AND lifecycle <> 'deleted'`,
    automationId,
  ).toArray().length > 0;
}

/**
 * Every conversation in a scope that the Organization still has a directory
 * row for, with whether this person can open it and whether it is archived.
 *
 * Nothing is filtered on those two flags here: `conversation_list` omits both,
 * while a read or a post names the reason it refuses. Home (or own) comes
 * first, then Main for a Breakout loop, then attachments in the order they
 * were made.
 */
export function scopeConversations(sql: SqlStorage, scope: ConversationToolScope, userId: string): ScopedConversation[] {
  const addresses: Array<ConversationAddress & { isHome: boolean; isOwn: boolean; isParent: boolean }> = [];
  if (scope.kind === "conversation") {
    addresses.push({ parentKind: "workstream", parentId: scope.parentId, substreamId: scope.substreamId,
      isHome: false, isOwn: true, isParent: false });
    if (scope.substreamId !== "0") {
      addresses.push({ parentKind: "workstream", parentId: scope.parentId, substreamId: "0",
        isHome: false, isOwn: false, isParent: true });
    }
  } else {
    if (!sidekickExists(sql, scope.automationId)) return [];
    const home = sidekickHome(sql, scope.automationId);
    if (home) addresses.push({ ...home, isHome: true, isOwn: false, isParent: false });
    for (const row of sql.exec<{ parent_id: string; substream_id: string }>(
      `SELECT parent_id, substream_id FROM sidekick_conversation_attachments
        WHERE automation_id = ? ORDER BY attached_at, parent_id, substream_id`,
      scope.automationId,
    ).toArray()) {
      if (home && home.parentId === row.parent_id && home.substreamId === row.substream_id) continue;
      addresses.push({ parentKind: "workstream", parentId: row.parent_id, substreamId: row.substream_id,
        isHome: false, isOwn: false, isParent: false });
    }
  }
  const scoped: ScopedConversation[] = [];
  for (const address of addresses) {
    const facts = describeConversation(sql, address, userId);
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

interface TitledConversation extends ConversationAddress, DirectoryFacts {
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
    const address: ConversationAddress = { parentKind: "workstream", parentId: row.workstream_id, substreamId: row.substream_id };
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
  address: ConversationAddress;
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
     VALUES (?, 'workstream', ?, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING automation_id`,
    input.automationId, input.address.parentId, input.address.substreamId, input.userId, input.now,
  ).toArray();
  return { alreadyAttached: inserted.length === 0 };
}
