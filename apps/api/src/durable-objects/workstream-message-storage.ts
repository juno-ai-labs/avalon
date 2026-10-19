/**
 * Object-local transcript for one work stream.
 *
 * Ordered canonical conversation turns are the work stream's record of what was said and by whom.
 * Members read it through `WorkstreamObjectProductService`, which has always
 * been object-native. This class is the other reader and writer: the harness,
 * the digest, Slack, inbound email, and the automation service, all of which
 * reached the same rows from the Worker by preparing D1-shaped SQL against
 * `_runtime_messages` — a compatibility view whose INSTEAD OF trigger mapped
 * `member` to `human`, the stored payload's content to `text_content`, invented
 * `workspace_id` and `workstream_id` from the object's identity row, converted
 * unix milliseconds to ISO-8601, and — the part that is easy to miss — advanced
 * the work stream's `next_attention_ordinal` and `last_people_activity_at` as a
 * side effect of the insert.
 *
 * That side effect is why every routed transcript write was a *batch*: the
 * trigger moved one set of counters and the caller's own second statement moved
 * the rest. Here an append is one operation, and the counters it owns are the
 * counters it moves.
 *
 * Two things this deliberately does *not* improve, because they are other
 * slices' to make:
 *
 * - Author identity is projected exactly as `_runtime_users` projected it —
 *   name is the member's own id, email is empty, avatar is null. The object can
 *   reach the real profile (the product service reads regional `users` one
 *   layer away), and the identity slice is where these readers start seeing it.
 *   Changing it here would put a data change inside a compatibility retirement.
 * - An attachment's resource is read from `workstream_resource_links`, the
 *   object's own frozen descriptor. That is not a new source: the retired
 *   reader's `JOIN resources` was rewritten onto `_runtime_resources`, a view
 *   that `json_extract`s the same frozen copy. So this reader sees exactly what
 *   it saw. It is worth naming because the *product* service reads the live
 *   regional row instead, and the two have been able to disagree — a resource
 *   renamed after it was attached renders one way in the app and another in the
 *   harness's transcript. Reconciling them is the resources slice's job.
 *
 * Timestamps are unix milliseconds, the object's convention.
 */

import { boundParameterChunks } from "./bound-parameters";
import {
  prepareConversationTurn,
  type PreparedConversationTurn,
  type ConversationTurnInput,
  WorkstreamTranscriptStorage,
} from "./workstream-transcript-storage";

/** One transcript row, in the vocabulary the retired view projected. */
export interface MessageRow extends Record<string, SqlStorageValue> {
  id: string;
  client_message_id: string | null;
  author_type: string;
  author_user_id: string | null;
  external_actor_json: string | null;
  message_type: string;
  text_content: string;
  structured_content_json: string | null;
  sequence_number: number;
  attention_ordinal: number | null;
  created_at: number;
  edited_at: number | null;
  harness_run_id: string | null;
  harness_attempt_id: string | null;
}

export interface MessageMentionRow extends Record<string, SqlStorageValue> {
  part_id: string;
  mention_kind: string;
  target_user_id: string | null;
  connector_type: string | null;
  start_offset: number;
  end_offset: number;
}

export interface MessageAttachmentRow extends Record<string, SqlStorageValue> {
  part_id: string;
  resource_id: string;
  position: number;
  title: string | null;
  mime_type: string | null;
  content_ref: string | null;
  metadata_json: string | null;
  attached_at: number;
}

/** The member profile the retired `_runtime_users` view fabricated. */
export interface MessageAuthorRow extends Record<string, SqlStorageValue> {
  user_id: string;
  added_at: number;
}

/**
 * Whether an append landed, and what it landed as.
 *
 * `replayed` is not a failure. Every transcript write in this product is keyed
 * by a client message id derived from the thing that caused it — a Slack
 * delivery, a harness run, a digest — so a redelivery naming the same id is the
 * ordinary case, and the caller wants the row that already exists rather than a
 * second one.
 */
export type MessageAppendOutcome =
  | { outcome: "appended"; messageId: string; sequenceNumber: number }
  | { outcome: "replayed"; messageId: string; sequenceNumber: number };

export type MessageAppendInput = Omit<
  ConversationTurnInput,
  "sequenceNumber" | "attentionOrdinal" | "messageType" | "authorType" | "authorUserId"
> & {
  authorType: "agent" | "external" | "system";
  authorUserId: null;
  messageType: "text" | "system" | "elicitation" | "automation_activation";
};

const MESSAGE_COLUMNS = `part.id, part.client_message_id,
        CASE part.author_type WHEN 'member' THEN 'human' WHEN 'agent' THEN 'agent'
          WHEN 'external' THEN 'external' ELSE 'system' END AS author_type,
        part.author_user_id, part.external_actor_json, part.message_type,
        COALESCE(part.content, '') AS text_content, part.structured_content_json,
        part.sequence_number, part.attention_ordinal, part.created_at, part.edited_at,
        part.produced_by_run_id AS harness_run_id,
        run.legacy_attempt_id AS harness_attempt_id`;

function first<T>(cursor: SqlStorageCursor<T extends Record<string, SqlStorageValue> ? T : never>) {
  return cursor.toArray()[0];
}

/**
 * Which message types a window is about, as the question its caller asks.
 *
 * Not one list. "these types" and "everything but these" are genuinely different questions:
 * an `include` list silently drops a type nobody has added yet, and an
 * `exclude` list silently admits one. Naming means the first — `text` alone,
 * because an elicitation or a host notice is not the conversation a name should
 * describe — and the description refresh means the second, because a host
 * notice *is* part of where a work stream has got to and a type added later
 * would be too. Both readers wrote their own predicate before this, and the
 * difference between them was invisible.
 */
export type MessageTypeFilter =
  | { include: readonly string[] }
  | { exclude: readonly string[] };

function messageTypePredicate(
  filter: MessageTypeFilter,
  column: string,
): { sql: string; params: string[] } {
  const types = "include" in filter ? filter.include : filter.exclude;
  if (types.length === 0) {
    return { sql: "include" in filter ? "0" : "1", params: [] };
  }
  const placeholders = types.map(() => "?").join(", ");
  return {
    sql: `${column} ${"include" in filter ? "IN" : "NOT IN"} (${placeholders})`,
    params: [...types],
  };
}

export class WorkstreamMessageStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /** One message by the id its author generated, or nothing. */
  messageByClientId(input: { clientMessageId: string }): MessageRow | undefined {
    return first(this.sql.exec<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM canonical_conversation_turn_details part LEFT JOIN runs run ON run.run_id = part.produced_by_run_id
        WHERE part.substream_id = '0' AND part.client_message_id = ?`,
      input.clientMessageId,
    ));
  }

  /** One message by its own id. */
  message(input: { messageId: string }): MessageRow | undefined {
    return first(this.sql.exec<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM canonical_conversation_turn_details part LEFT JOIN runs run ON run.run_id = part.produced_by_run_id
        WHERE part.substream_id = '0' AND part.id = ?`,
      input.messageId,
    ));
  }

  /**
   * A page of transcript ending before a sequence number, oldest first.
   *
   * The caller's `beforeSequence` is exclusive and the page comes back in
   * reading order, which is the reverse of the order it is selected in — the
   * routed reader did that reversal in TypeScript after the fact, and it
   * belongs with the query that made it necessary.
   */
  messagesBefore(input: { beforeSequence: number; limit: number }): MessageRow[] {
    return this.sql.exec<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM canonical_conversation_turn_details part LEFT JOIN runs run ON run.run_id = part.produced_by_run_id
        WHERE part.substream_id = '0' AND part.sequence_number < ?
        ORDER BY part.sequence_number DESC LIMIT ?`,
      input.beforeSequence,
      input.limit,
    ).toArray().reverse();
  }

  /**
   * What another agent may read of this conversation, newest first: every
   * message before a sequence number except tool cards and suggestions, which
   * are one run's working state rather than something said here. The
   * conversation tools' `conversation_read` pages through this.
   */
  readableMessagesBefore(input: { beforeSequence: number; limit: number }): MessageRow[] {
    return this.sql.exec<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM canonical_conversation_turn_details part LEFT JOIN runs run ON run.run_id = part.produced_by_run_id
        WHERE part.substream_id = '0' AND part.sequence_number < ?
          AND part.message_type NOT IN ('tool', 'suggestion')
        ORDER BY part.sequence_number DESC LIMIT ?`,
      input.beforeSequence,
      input.limit,
    ).toArray();
  }

  /** A page of transcript after a sequence number, oldest first. */
  messagesAfter(input: { afterSequence: number; limit: number }): MessageRow[] {
    return this.sql.exec<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM canonical_conversation_turn_details part LEFT JOIN runs run ON run.run_id = part.produced_by_run_id
        WHERE part.substream_id = '0' AND part.sequence_number > ?
        ORDER BY part.sequence_number ASC LIMIT ?`,
      input.afterSequence,
      input.limit,
    ).toArray();
  }

  /**
   * Whether anything other than a tool row follows a sequence number: the
   * memory sweep's "is there more to read", asked without reading it.
   */
  hasMessageAfter(input: { afterSequence: number }): boolean {
    return first(this.sql.exec<{ present: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS present FROM canonical_conversation_turn_details
        WHERE substream_id = '0' AND sequence_number > ? AND message_type <> 'tool'
        LIMIT 1`,
      input.afterSequence,
    )) !== undefined;
  }

  /** One message at a transcript position, or nothing. */
  messageAtSequence(input: { sequenceNumber: number }): MessageRow | undefined {
    return first(this.sql.exec<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM canonical_conversation_turn_details part LEFT JOIN runs run ON run.run_id = part.produced_by_run_id
        WHERE part.substream_id = '0' AND part.sequence_number = ?`,
      input.sequenceNumber,
    ));
  }

  /**
   * The messages someone actually said, oldest or newest first.
   *
   * Two readers want this window — naming and the description refresh — and
   * each wrote its own predicate before this. They agree that an empty message
   * is not something *said*, and they disagree, on purpose, about what else
   * counts; {@link MessageTypeFilter} is where that disagreement lives now.
   *
   * `order` is the same difference read the other way: a name describes what a
   * work stream is *for*, established in its opening exchange, so naming reads
   * oldest-first; a description says where it has got to, so it reads the most
   * recent. Both come back in reading order.
   */
  saidMessages(input: {
    messageTypes: MessageTypeFilter;
    order: "oldest" | "newest";
    limit: number;
    /** Only messages at or after this instant, for a windowed read. */
    since?: number | null;
  }): MessageRow[] {
    const types = messageTypePredicate(input.messageTypes, "part.message_type");
    const rows = this.sql.exec<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM canonical_conversation_turn_details part LEFT JOIN runs run ON run.run_id = part.produced_by_run_id
        WHERE part.substream_id = '0' AND ${types.sql}
          AND trim(COALESCE(part.content, '')) <> ''
          AND (? IS NULL OR part.created_at >= ?)
        ORDER BY part.sequence_number ${input.order === "newest" ? "DESC" : "ASC"}
        LIMIT ?`,
      ...types.params,
      input.since ?? null,
      input.since ?? null,
      input.limit,
    ).toArray();
    return input.order === "newest" ? rows.reverse() : rows;
  }

  /**
   * How many of those there are, up to a ceiling the caller names.
   *
   * Bounded by the caller because both readers only ever ask a threshold
   * question — "are there at least N" for naming, "how many in the last window,
   * capped" for the description — and neither wants the count of a work stream
   * that has been talking for a year.
   */
  saidMessageCount(input: {
    messageTypes: MessageTypeFilter;
    limit: number;
    since?: number | null;
  }): number {
    const types = messageTypePredicate(input.messageTypes, "message_type");
    return Number(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM (
         SELECT 1 FROM canonical_conversation_turn_details
          WHERE substream_id = '0' AND ${types.sql}
            AND trim(COALESCE(content, '')) <> ''
            AND (? IS NULL OR created_at >= ?)
          LIMIT ?)`,
      ...types.params,
      input.since ?? null,
      input.since ?? null,
      input.limit,
    ).one().count);
  }

  /**
   * The whole window the description refresh reads, in one round trip.
   *
   * Three questions that are one question: how many turns the window holds, the
   * page that fits, and who wrote them. Asked separately they are three round
   * trips on a path that runs at the end of every harness run, and the count is
   * only ever asked in order to size the page — so the arithmetic between them
   * belongs on the side of the boundary that already has the rows.
   *
   * The numbers stay the caller's. `minimum` and `maximum` are the refresh's
   * own window policy and are not this class's to know; what is here is the
   * order they combine in, which is the part that has to happen in one
   * transaction to describe a single transcript.
   */
  saidWindow(input: {
    messageTypes: MessageTypeFilter;
    since: number | null;
    /** The floor on the page, so a quiet work stream is still judged on enough. */
    minimum: number;
    /** The ceiling, which is what a single Worker request can render and send. */
    maximum: number;
  }): { rows: MessageRow[]; authors: MessageAuthorRow[]; requested: number } {
    return this.storage.transactionSync(() => {
      // One past the ceiling, so `requested > limit` can still be true at the
      // ceiling — that comparison is how the caller knows the window capped,
      // and a count clamped at the ceiling could never say so.
      const recent = this.saidMessageCount({
        messageTypes: input.messageTypes,
        limit: input.maximum + 1,
        since: input.since,
      });
      const requested = Math.max(input.minimum, recent);
      const rows = this.saidMessages({
        messageTypes: input.messageTypes,
        order: "newest",
        limit: Math.min(requested, input.maximum),
      });
      const authors = this.authorsFor({
        userIds: [...new Set(rows.flatMap((row) => row.author_user_id ? [row.author_user_id] : []))],
      });
      return { rows, authors, requested };
    });
  }

  /**
   * Whether a message was written by someone still in the work stream.
   *
   * The join Terminal's admission check wrote as `messages JOIN
   * workstream_participants`, which was two compatibility views over two tables
   * in this same object. What it is asking is whether the person who sent the
   * trigger message is a participant, because a repository command runs with
   * their authorization.
   */
  messageFromParticipant(input: {
    messageId: string;
    authorUserId: string;
  }): { text_content: string } | undefined {
    return first(this.sql.exec<{ text_content: string } & Record<string, SqlStorageValue>>(
      `SELECT COALESCE(part.content, '') AS text_content
         FROM canonical_conversation_turn_details part
         JOIN participants participant ON participant.user_id = part.author_user_id
        WHERE part.substream_id = '0' AND part.id = ?1
          AND part.author_type = 'member' AND part.author_user_id = ?2
          AND participant.removed_at IS NULL`,
      input.messageId,
      input.authorUserId,
    ));
  }

  /** How many attachments the work stream's opening message carries. */
  openingAttachmentCount(): number {
    return Number(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count
         FROM participant_transcript_attachments attachment
         JOIN canonical_conversation_turn_details part ON part.id = attachment.turn_id
        WHERE part.substream_id = '0' AND part.sequence_number = 1`,
    ).one().count);
  }

  /** The mentions on a page of messages, in one read rather than one per row. */
  mentionsFor(input: { messageIds: readonly string[] }): MessageMentionRow[] {
    if (input.messageIds.length === 0) return [];
    // Chunked, because a page is wider than one statement can bind. The
    // transcript walk asks for up to 250 messages and the engine takes 100
    // parameters, so an unchunked `IN` list fails the whole page rather than
    // returning part of it. `WorkstreamObjectProductService` reads these two
    // tables the same way, for the same reason.
    return boundParameterChunks(input.messageIds).flatMap((ids) =>
      this.sql.exec<MessageMentionRow>(
        `SELECT turn_id AS part_id, mention_kind, target_user_id, connector_type, start_offset, end_offset
           FROM participant_transcript_mentions
          WHERE turn_id IN (${ids.map(() => "?").join(", ")})
          ORDER BY turn_id, mention_index`,
        ...ids,
      ).toArray());
  }

  /**
   * The attachments on a page of messages, with the descriptor the object froze.
   *
   * The join the retired reader wrote as `JOIN resources` — which was rewritten
   * onto a view that `json_extract`ed these same columns out of
   * `workstream_resource_links.resource_json`. An attachment whose link has
   * since been removed produced no row through that join, and produces none
   * here.
   */
  attachmentsFor(input: { messageIds: readonly string[] }): MessageAttachmentRow[] {
    if (input.messageIds.length === 0) return [];
    return boundParameterChunks(input.messageIds).flatMap((ids) =>
      this.sql.exec<MessageAttachmentRow>(
        `SELECT attachment.turn_id AS part_id, attachment.resource_id, attachment.position,
                json_extract(link.resource_json, '$.title') AS title,
                json_extract(link.resource_json, '$.mimeType') AS mime_type,
                json_extract(link.resource_json, '$.contentRef') AS content_ref,
                json_extract(link.resource_json, '$.metadata') AS metadata_json,
                link.attached_at
           FROM participant_transcript_attachments attachment
           JOIN workstream_resource_links link ON link.resource_id = attachment.resource_id
          WHERE attachment.turn_id IN (${ids.map(() => "?").join(", ")})
          ORDER BY attachment.turn_id, attachment.position`,
        ...ids,
      ).toArray());
  }

  /**
   * The members a page of messages names, as participants of this work stream.
   *
   * The shape the retired `_runtime_users` view had: a participant row and
   * nothing else, because that is all the object holds.
   *
   * Unfiltered on purpose, and not because a removed member has no row. The
   * retired `_runtime_workstream_participants` upsert kept a removed member and
   * set `status = 'removed'`, and `_runtime_users` selected `FROM participants`
   * with no status or `removed_at` predicate at all — so a removed author did
   * produce a join row, carrying the same fabricated name and empty email as a
   * current one. The only author with no row here is someone who was never a
   * participant. Adding a filter would be a behaviour change, not a fix.
   */
  authorsFor(input: { userIds: readonly string[] }): MessageAuthorRow[] {
    if (input.userIds.length === 0) return [];
    return boundParameterChunks(input.userIds).flatMap((ids) =>
      this.sql.exec<MessageAuthorRow>(
        `SELECT user_id, added_at FROM participants
          WHERE user_id IN (${ids.map(() => "?").join(", ")})`,
        ...ids,
      ).toArray());
  }

  /**
   * Append one message and move the counters that belong to it.
   *
   * Every routed transcript write was a batch of two: an insert whose trigger
   * advanced `next_attention_ordinal` and `last_people_activity_at`, and the
   * caller's own `UPDATE workstreams` for `next_sequence_number` and
   * `latest_attention_sequence_number`. Two halves of one fact, in two
   * statements, kept together only because the router happened to send them as
   * one batch.
   *
   * Tool cards do not come through here; they have their own operation, because
   * they are keyed by the invocation rather than by a client message id and are
   * written more than once. So every message this appends takes an attention
   * ordinal — the retired trigger's `CASE WHEN message_type = 'tool'` had one
   * live arm and one that the tool path never reached, and splitting the two
   * operations is what makes that visible rather than a branch nothing runs.
   *
   * `messageType` is the retired vocabulary minus `tool`, so that split is a
   * type error at the call site rather than a sentence here. The body depends
   * on it: `kind` is hardcoded `'text'`, an attention ordinal is always
   * consumed, and the people clock always moves — a `'tool'` slipping through
   * would write a row the retired trigger would have branched away from.
   */
  async prepareMessage(input: MessageAppendInput): Promise<PreparedConversationTurn> {
    return prepareConversationTurn({
      ...input,
      sequenceNumber: 0,
      attentionOrdinal: null,
    });
  }

  async appendMessage(input: MessageAppendInput): Promise<MessageAppendOutcome> {
    const prepared = await this.prepareMessage(input);
    return this.storage.transactionSync(() => this.appendPreparedMessage(prepared));
  }

  appendPreparedMessage(prepared: PreparedConversationTurn): MessageAppendOutcome {
      const { input } = prepared;
      if (input.authorType === "human" || input.authorUserId !== null) {
        throw new Error("message_append_human_author_forbidden");
      }
      const existing = this.messageByClientId({ clientMessageId: input.clientMessageId });
      if (existing) {
        return {
          outcome: "replayed" as const,
          messageId: existing.id,
          sequenceNumber: existing.sequence_number,
        };
      }
      const root = this.sql.exec<{
        next_sequence_number: number; next_attention_ordinal: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT next_sequence_number, next_attention_ordinal FROM workstream WHERE id = 1`,
      ).one();
      const attention = root.next_attention_ordinal;
      prepared.input.sequenceNumber = root.next_sequence_number;
      prepared.input.attentionOrdinal = attention;
      if (input.messageType === "tool" || input.messageType === "suggestion") {
        throw new Error("participant_message_type_not_appendable");
      }
      const transcriptSequence = new WorkstreamTranscriptStorage(this.storage).appendPreparedParticipantMessage({
        input: {
          turnId: input.messageId,
          actor: input.authorType === "agent" ? "assistant" : input.authorType,
          authorUserId: input.authorUserId,
          authorSnapshot: null,
          clientMessageId: input.clientMessageId,
          messageType: input.messageType,
          text: input.text,
          structuredContentJson: input.structuredContentJson,
          externalActorJson: input.externalActorJson,
          producedByRunId: input.producedByRunId,
          messageSequenceNumber: root.next_sequence_number,
          createdAtUtc: new Date(input.now).toISOString(),
          attentionOrdinal: attention,
        },
        fact: prepared.fact,
        occurredAt: input.now,
      });
      this.#advanceCounters(false, input.now);
      return {
        outcome: "appended" as const,
        messageId: input.messageId,
        sequenceNumber: transcriptSequence,
      };
  }

  /**
   * Move the counters an appended part consumed.
   *
   * `next_attention_ordinal` and `last_people_activity_at` were the retired
   * insert trigger's, `next_sequence_number` was the caller's own follow-up
   * statement, and the two were one fact split across a batch. The compat
   * view's `latest_attention_sequence_number` is not written here because it
   * was never a column: the view derived it as `next_attention_ordinal - 1`,
   * and its update trigger silently ignored every caller that assigned to it.
   */
  #advanceCounters(isToolCard: boolean, now: number): void {
    this.sql.exec(
      `UPDATE workstream
          SET next_sequence_number = next_sequence_number + 1,
              next_attention_ordinal = next_attention_ordinal + ?1,
              last_people_activity_at = CASE WHEN ?1 = 0
                THEN last_people_activity_at ELSE ?2 END,
              updated_at = ?2
        WHERE id = 1`,
      isToolCard ? 0 : 1,
      now,
    );
  }
}
