import { ExternalActorSchema } from "@rally/contracts";
import type { Message, User } from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";

import type {
  MessageAttachmentRow,
  MessageAuthorRow,
  MessageMentionRow,
  MessageRow,
} from "../durable-objects/workstream-message-storage";
import type { MessageObjectPort } from "../durable-objects/workstream-message-protocol";

/**
 * Build the `Message` shape from what the object stores.
 *
 * This is the half of the retired transcript read that was never SQL's to do.
 * `_runtime_messages` and its two sibling views could only project columns, so
 * the reader assembled a message by joining four tables and aggregating two of
 * them into JSON inside the query — a shape that existed because the caller had
 * one round trip and no way to do anything between statements.
 *
 * Here the object answers with rows and this assembles them, one query per page
 * rather than a correlated subquery per row.
 *
 * **Author identity is fabricated, deliberately and temporarily.** The retired
 * `_runtime_users` view returned `''` for email, the member's own id for name,
 * `NULL` for avatar and `'UTC'` for timezone, because the object holds
 * participants rather than profiles. Every reader converted here has been
 * getting that, and this reproduces it exactly rather than quietly starting to
 * answer with the real profile the object could reach one layer away. The
 * identity slice is where that changes, and it should change for all of these
 * readers at once and on purpose.
 */
export interface MessagePageSources {
  rows: readonly MessageRow[];
  mentions: readonly MessageMentionRow[];
  attachments: readonly MessageAttachmentRow[];
  authors: readonly MessageAuthorRow[];
  workspaceId: string;
  workstreamId: string;
}

/** One page of transcript, assembled from the object's rows. */
export function projectMessagePage(sources: MessagePageSources): Message[] {
  const mentionsByMessage = groupBy(sources.mentions, (mention) => mention.part_id);
  const attachmentsByMessage = groupBy(sources.attachments, (attachment) => attachment.part_id);
  const authors = new Map(sources.authors.map((author) => [author.user_id, author]));
  return sources.rows.map((row) => projectMessage(
    row,
    mentionsByMessage.get(row.id) ?? [],
    attachmentsByMessage.get(row.id) ?? [],
    authors,
    sources,
  ));
}

function projectMessage(
  row: MessageRow,
  mentions: readonly MessageMentionRow[],
  attachments: readonly MessageAttachmentRow[],
  authors: ReadonlyMap<string, MessageAuthorRow>,
  sources: MessagePageSources,
): Message {
  // Parsed rather than trusted, which is what the retired `toMessage` did with
  // this column and the one thing in this projection that is a real boundary:
  // the JSON comes from a connector's own payload, and `publishWorkstreamEvent`
  // puts the result in front of clients. A malformed actor falls through to the
  // `author_type` branch, exactly as the retired reader's `safeParse` did.
  const externalActor = ExternalActorSchema
    .safeParse(parseJson<Record<string, unknown> | null>(row.external_actor_json, null));
  const author: Message["author"] = externalActor.success
    ? { type: "external", actor: externalActor.data }
    : row.author_type === "human" && row.author_user_id
      ? { type: "human", user: fabricatedUser(row.author_user_id, row.author_name_snapshot, authors) }
      : row.author_type === "agent"
        ? { type: "agent" }
        : { type: "system" };
  const message: Message = {
    id: row.id,
    clientMessageId: row.client_message_id,
    workspaceId: sources.workspaceId,
    workstreamId: sources.workstreamId,
    author,
    messageType: messageTypeOf(row.message_type),
    textContent: row.text_content,
    structuredContent: parseJson<Record<string, unknown> | null>(row.structured_content_json, null),
    mentions: mentions.map((mention) => ({
      type: mention.mention_kind === "connector" ? "connector" as const : "person" as const,
      userId: mention.target_user_id,
      connectorType: mention.connector_type,
      // What the retired join produced: the mentioned member's `users.name`,
      // which that view answered with their own id, and a null avatar.
      displayName: mention.target_user_id,
      avatarUrl: null,
      startOffset: mention.start_offset,
      endOffset: mention.end_offset,
    })),
    attachments: attachments.map((attachment) => {
      const metadata = parseJson<{ size?: number }>(attachment.metadata_json, {});
      return {
        id: attachment.resource_id,
        // Bounded here for the reason the retired reader bounded it: a
        // resource's title and MIME type carry no length constraint, so one
        // over-long upload title would otherwise fail the transcript page for
        // every participant, on every page containing that message, forever.
        fileName: truncateUtf16Safe(String(attachment.title ?? ""), 300),
        mimeType: truncateUtf16Safe(attachment.mime_type || "application/octet-stream", 160),
        sizeBytes: Math.max(0, Number(metadata.size ?? 0)),
        contentAvailable: attachment.content_ref != null,
        createdAt: new Date(attachment.attached_at).toISOString(),
      };
    }),
    sequenceNumber: row.sequence_number,
    createdAt: new Date(row.created_at).toISOString(),
    editedAt: row.edited_at == null ? null : new Date(row.edited_at).toISOString(),
  };
  return message;
}

/**
 * The published spelling of a stored message type.
 *
 * Canonical conversation turns currently write this exact vocabulary. Keep a
 * fallback rather than casting storage input so an unexpected future value is
 * rendered safely instead of escaping the protocol mapper.
 */
function messageTypeOf(stored: string): Message["messageType"] {
  switch (stored) {
    case "text": case "system": case "tool": case "elicitation": case "suggestion":
    case "automation_activation":
      return stored;
    default:
      return "system";
  }
}

/**
 * The member profile the retired `_runtime_users` view answered with.
 *
 * A member with no participant row produced no join row at all, and the reader
 * fell through to `String(undefined)` for every field — so an author who has
 * since been removed rendered with the literal name "undefined". Reproducing
 * that would be reproducing a bug rather than a behaviour, so a missing
 * participant falls back to the member's own id, which is what the view
 * answered with for everyone who *was* a participant.
 */
function fabricatedUser(
  userId: string,
  nameSnapshot: string | null,
  authors: ReadonlyMap<string, MessageAuthorRow>,
): User {
  const participant = authors.get(userId);
  return {
    id: userId,
    // `UserSchema` requires a deliverable address and this is not one, so a
    // human-authored message assembled here has never satisfied its own
    // published contract — not since the cutover, and not before it either,
    // because `_runtime_users` answered with the same empty string. Nothing
    // parses a `Message` on the way out, which is why it has gone unnoticed.
    // Recorded rather than papered over: the identity slice is where this stops
    // being fabricated, and this is the field that proves it has to.
    email: "",
    // The name the author had when they wrote the turn. The schema requires a
    // snapshot on every human turn; the id is only for older rows without one.
    name: nameSnapshot ?? userId,
    avatarUrl: null,
    timezone: "UTC",
    createdAt: new Date(participant?.added_at ?? 0).toISOString(),
  };
}

/** Every message in a page, with its mentions, attachments and authors read once each. */
export async function readMessagePage(
  messages: MessageObjectPort,
  identity: { workspaceId: string; workstreamId: string },
  rows: readonly MessageRow[],
): Promise<Message[]> {
  if (rows.length === 0) return [];
  const messageIds = rows.map((row) => row.id);
  const authorIds = [...new Set(rows.flatMap((row) => row.author_user_id ? [row.author_user_id] : []))];
  const [mentions, attachments, authors] = await Promise.all([
    messages.mentionsFor({ messageIds }),
    messages.attachmentsFor({ messageIds }),
    messages.authorsFor({ userIds: authorIds }),
  ]);
  return projectMessagePage({
    rows,
    mentions,
    attachments,
    authors,
    workspaceId: identity.workspaceId,
    workstreamId: identity.workstreamId,
  });
}

/** One message by the id its author generated, assembled as a page of one. */
export async function readMessage(
  messages: MessageObjectPort,
  identity: { workspaceId: string; workstreamId: string },
  clientMessageId: string,
): Promise<Message | null> {
  const row = await messages.messageByClientId({ clientMessageId });
  if (!row) return null;
  return (await readMessagePage(messages, identity, [row]))[0] ?? null;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(key(row));
    if (existing) existing.push(row);
    else grouped.set(key(row), [row]);
  }
  return grouped;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * A page-at-a-time transcript reader, in the shape the loaders already take.
 *
 * The harness's fence walk pages backward from an immutable boundary until it
 * reaches the prior compaction, and it takes its reader as an argument so the
 * walk itself can be tested without a database. That argument used to be the
 * repository's `listMessages`, whose SQL joined four tables and aggregated two
 * of them into JSON. It is this now, and the walk is untouched.
 */
export function transcriptLister(
  messages: MessageObjectPort,
  identity: { workspaceId: string; workstreamId: string },
): (
  workspaceId: string,
  workstreamId: string,
  limit: number,
  beforeSequence?: number,
) => Promise<Message[]> {
  return async (_workspaceId, _workstreamId, limit, beforeSequence) => {
    const rows = await messages.messagesBefore({
      // The repository's cursor was exclusive and defaulted to "everything", and
      // its `LIMIT` was capped at 250. Both are the contract its callers walk
      // against, so both come with it.
      beforeSequence: beforeSequence ?? Number.MAX_SAFE_INTEGER,
      limit: Math.min(limit, 250),
    });
    return readMessagePage(messages, identity, rows);
  };
}
