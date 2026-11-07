import type { ConversationToolScope } from "./workspace-conversation-tool-protocol";

/**
 * Which Rally conversations a Sidekick may reach with the conversation tools,
 * decided from WorkspaceDO's own directories.
 *
 * A Sidekick reaches its own shared conversation (substream `"0"` under the
 * Sidekick, `automation_directory`), every Canvas it writes
 * (`canvas_directory.writer_sidekick_id`), and every Canvas's Chat attached to
 * it in `sidekick_conversation_attachments`. A Canvas's Chat is the Canvas's
 * conversation `"0"`, and its conversation id is the Canvas's id.
 *
 * This is not `sidekick_attachments` (per conversation): that recorded that a
 * Thread's conversation loaded a Sidekick as a skill, and reading it as "the
 * Sidekick may read and post here" would have handed a Sidekick every
 * conversation that ever used it.
 *
 * Everything here is a local read, so a list costs no call to another object
 * and no D1 read. The canonical admission of each target is still the hosted
 * parent's `authorizeViewer` (`canvasAdmits` for a Canvas, `sidekickAdmits` for
 * a Sidekick), which the caller runs for the acting person before a list, a
 * read or a post.
 */

/** A Rally conversation a tool can name: a Sidekick's own, or a Canvas's Chat. */
export interface ConversationAddress {
  parentKind: "automation" | "canvas";
  parentId: string;
  substreamId: string;
}

/** What a Sidekick's conversation attachment names: a Canvas's Chat. */
export type AttachableAddress = ConversationAddress & { parentKind: "canvas" };

export interface ScopedConversation extends ConversationAddress {
  conversationId: string;
  kind: "canvas" | "sidekick";
  title: string;
  /** The Sidekick's own conversation, read from its configuration conversation. */
  isOwn: boolean;
  /** The Sidekick's own conversation, read from one of its runs, which sits inside it. */
  isParent: boolean;
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

/** `<parentId>` for a conversation `"0"`, `<parentId>/<substreamId>` for any other. */
export function conversationIdOf(address: Pick<ConversationAddress, "parentId" | "substreamId">): string {
  return address.substreamId === "0" ? address.parentId : `${address.parentId}/${address.substreamId}`;
}

/**
 * The parent a conversation id names, or null for anything that is not one.
 * Only a parent's conversation `"0"` is reachable, so an id is one UUID: a
 * Canvas's or a Sidekick's. Which of the two it is, the directories say.
 */
export function parseConversationId(value: string): { parentId: string; substreamId: "0" } | null {
  const id = value.trim();
  return UUID.test(id) ? { parentId: id.toLowerCase(), substreamId: "0" } : null;
}

/** A Canvas's title, or null when this Organization holds no such Canvas. */
export function canvasTitle(sql: SqlStorage, canvasId: string): string | null {
  return sql.exec<{ title: string }>(`SELECT title FROM canvas_directory WHERE canvas_id = ?`, canvasId)
    .toArray()[0]?.title ?? null;
}

/** A Sidekick's title, or null for one that does not exist or was deleted. */
function sidekickTitle(sql: SqlStorage, automationId: string): string | null {
  const row = sql.exec<{ title: string }>(
    `SELECT title FROM automation_directory WHERE automation_id = ? AND lifecycle <> 'deleted'`,
    automationId,
  ).toArray()[0];
  return row ? row.title || "New Sidekick" : null;
}

function canvasConversation(canvasId: string, title: string): ScopedConversation {
  return { parentKind: "canvas", parentId: canvasId, substreamId: "0", conversationId: canvasId,
    kind: "canvas", title, isOwn: false, isParent: false };
}

/**
 * Every conversation in a Sidekick's scope that the Organization still holds,
 * before admission: the Sidekick's own conversation first, then the Canvases it
 * writes, newest made first (creation, not edit, so a list's pages do not
 * move as a Canvas is edited), then the Canvases attached to it in the order they
 * were attached. A Canvas both written and attached is listed once. An
 * attachment of a retired Thread (`parent_kind = 'workstream'`) names nothing.
 */
export function scopeConversations(sql: SqlStorage, scope: ConversationToolScope): ScopedConversation[] {
  const title = sidekickTitle(sql, scope.automationId);
  if (title === null) return [];
  // The wizard's own conversation, the one a run sits inside, and where a post
  // goes when it names no conversation.
  const scoped: ScopedConversation[] = [{
    parentKind: "automation", parentId: scope.automationId, substreamId: "0", conversationId: scope.automationId,
    kind: "sidekick", title, isOwn: scope.authoring === true, isParent: scope.authoring !== true,
  }];
  const seen = new Set<string>();
  for (const row of sql.exec<{ canvas_id: string; title: string }>(
    `SELECT canvas_id, title FROM canvas_directory WHERE writer_sidekick_id = ?
      ORDER BY created_at DESC, canvas_id`,
    scope.automationId,
  ).toArray()) {
    seen.add(row.canvas_id);
    scoped.push(canvasConversation(row.canvas_id, row.title));
  }
  for (const row of sql.exec<{ canvas_id: string; title: string }>(
    `SELECT canvas.canvas_id, canvas.title
       FROM sidekick_conversation_attachments attachment
       JOIN canvas_directory canvas ON canvas.canvas_id = attachment.parent_id
      WHERE attachment.automation_id = ? AND attachment.parent_kind = 'canvas' AND attachment.substream_id = '0'
      ORDER BY attachment.attached_at, attachment.parent_id`,
    scope.automationId,
  ).toArray()) {
    if (seen.has(row.canvas_id)) continue;
    seen.add(row.canvas_id);
    scoped.push(canvasConversation(row.canvas_id, row.title));
  }
  return scoped;
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

/**
 * Every Canvas titled `title`, compared without regard to case, for an attach
 * that names a Canvas the way the person did. Unadmitted: the caller keeps
 * only those the person can open before it names any.
 */
export function canvasesTitled(sql: SqlStorage, title: string): ScopedConversation[] {
  return sql.exec<{ canvas_id: string; title: string }>(
    `SELECT canvas_id, title FROM canvas_directory WHERE title = ? COLLATE NOCASE ORDER BY canvas_id`,
    title.trim(),
  ).toArray().map((row) => canvasConversation(row.canvas_id, row.title));
}

/** Record that a Sidekick may read and post in a Canvas's Chat. Idempotent on the Sidekick and the Canvas. */
export function attachSidekickConversation(sql: SqlStorage, input: {
  automationId: string;
  address: AttachableAddress;
  userId: string;
  now: number;
}): { alreadyAttached: boolean } {
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
