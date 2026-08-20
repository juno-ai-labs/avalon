import {
  AgentModelOverrideSchema,
  ExternalActorSchema,
  WORKSTREAM_WAKEUP_PROMPT_PREVIEW_LENGTH,
} from "@avalon/contracts";
import { truncateUtf16Safe } from "@avalon/contracts/text";
import type {
  AutomationSummary,
  ExternalActor,
  HarnessStatus,
  Message,
  Scope,
  Workstream
} from "@avalon/contracts";

export interface D1ResultLike<T = unknown> {
  success: boolean;
  results?: T[];
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
}

export type ParticipationReason = "explicit" | "message" | "elicitation" | "action";

/**
 * Add somebody to a work stream, or bring them back if they had been removed.
 *
 * A statement rather than a write, because two callers need it inside a batch
 * with something else — a message and its participant, a work stream going
 * private and the person who closed it — and both pairs have to be
 * all-or-nothing.
 */
export function buildParticipantUpsertStatement<TStatement extends D1PreparedStatementLike>(
  db: { prepare(query: string): TStatement },
  input: {
    workspaceId: string;
    workstreamId: string;
    userId: string;
    addedByUserId: string;
    reason: ParticipationReason;
  },
): TStatement {
  return db
    .prepare(
      `INSERT INTO workstream_participants
       (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
       SELECT ?, ?, ?, ?, ?, NULL
       WHERE EXISTS (SELECT 1 FROM workstreams WHERE id = ? AND workspace_id = ?)
       ON CONFLICT(workstream_id, user_id) DO UPDATE SET
         removed_at = NULL,
         added_by_user_id = CASE WHEN workstream_participants.removed_at IS NOT NULL
           THEN excluded.added_by_user_id ELSE workstream_participants.added_by_user_id END,
         participation_reason = CASE WHEN workstream_participants.removed_at IS NOT NULL
           THEN excluded.participation_reason ELSE workstream_participants.participation_reason END,
         joined_at = CASE WHEN workstream_participants.removed_at IS NOT NULL
           THEN excluded.joined_at ELSE workstream_participants.joined_at END`
    )
    .bind(
      input.workstreamId,
      input.userId,
      input.addedByUserId,
      input.reason,
      nowIso(),
      input.workstreamId,
      input.workspaceId,
    ) as TStatement;
}

export function buildMessageAttachmentStatements<TStatement extends D1PreparedStatementLike>(
  db: { prepare(query: string): TStatement },
  input: {
    attachmentIds: string[];
    attachedAt: string;
    attachedByUserId: string | null;
    messageId: string;
    workspaceId: string;
    workstreamId: string;
  },
): TStatement[] {
  return [...new Set(input.attachmentIds)].flatMap((resourceId, position) => [
    db
      .prepare(
        `INSERT INTO message_attachments (message_id, resource_id, position, attached_at)
         SELECT ?, r.id, ?, ? FROM resources r
         WHERE r.id = ? AND r.workspace_id = ? AND r.provider = 'avalon_upload'
           AND r.uploaded_by_user_id = ? AND r.attachment_status = 'draft'
           AND EXISTS (SELECT 1 FROM messages WHERE id = ?)
         ON CONFLICT(message_id, resource_id) DO NOTHING`
      )
      .bind(
        input.messageId,
        position,
        input.attachedAt,
        resourceId,
        input.workspaceId,
        input.attachedByUserId,
        input.messageId,
      ),
    db
      .prepare(
        `INSERT INTO workstream_resources
         (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
         SELECT ?, r.id, ?, 0, 'message_attachment', ? FROM resources r
         WHERE r.id = ? AND r.workspace_id = ? AND r.provider = 'avalon_upload'
           AND r.uploaded_by_user_id = ? AND r.attachment_status = 'draft'
           AND EXISTS (
             SELECT 1 FROM message_attachments ma
             WHERE ma.message_id = ? AND ma.resource_id = r.id
           )
         ON CONFLICT(workstream_id, resource_id) DO NOTHING`
      )
      .bind(
        input.workstreamId,
        input.attachedByUserId,
        input.attachedAt,
        resourceId,
        input.workspaceId,
        input.attachedByUserId,
        input.messageId,
      ),
    db
      .prepare(
        `UPDATE resources SET attachment_status = 'attached', updated_at = ?
         WHERE id = ? AND workspace_id = ? AND uploaded_by_user_id = ?
           AND EXISTS (SELECT 1 FROM message_attachments WHERE message_id = ? AND resource_id = ?)`
      )
      .bind(
        input.attachedAt,
        resourceId,
        input.workspaceId,
        input.attachedByUserId,
        input.messageId,
        resourceId,
      ),
  ]) as TStatement[];
}

export class RepositoryError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "constraint" | "database_error",
    message: string,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function workstreamTitleStatus(value: unknown): Workstream["titleStatus"] {
  return value === "naming" || value === "automatic" ? value : "settled";
}

/** Turns the bounded database prefix into the exact compact wire preview. */
function wakeupPromptPreview(prefix: string): string {
  const truncated = truncateUtf16Safe(prefix, WORKSTREAM_WAKEUP_PROMPT_PREVIEW_LENGTH);
  const trimmed = truncated.trimEnd();
  return truncated.length < prefix.length ? `${trimmed}…` : truncated;
}

function toWorkstream(row: Record<string, unknown>): Workstream {
  const latestAttentionSequenceNumber = Number(row.latest_attention_sequence_number ?? 0);
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    objective: String(row.objective ?? ""),
    emailAddress: row.email_address == null ? null : String(row.email_address),
    originType: row.origin_type === "automation" ? "automation" : "ad_hoc",
    originLabel: row.origin_label == null ? null : String(row.origin_label),
    createdByUserId: row.created_by_user_id == null ? null : String(row.created_by_user_id),
    automationSubscriptionId:
      row.automation_subscription_id == null ? null : String(row.automation_subscription_id),
    automationRunId: row.automation_run_id == null ? null : String(row.automation_run_id),
    plannedFor: row.planned_for == null ? null : String(row.planned_for),
    harnessStatus: String(row.harness_status) as HarnessStatus,
    titleStatus: workstreamTitleStatus(row.title_status),
    latestAttentionSequenceNumber,
    readThroughSequenceNumber: latestAttentionSequenceNumber,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    youAreMentioned: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: String(row.last_activity_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    scope: row.scope === "personal" ? "personal" : "workspace",
    systemKind: row.system_kind == null ? null : (String(row.system_kind) as "digest"),
    // Re-validated on read rather than trusted, the same way the API's mapper
    // does it: a model retired from the closed set reads as unpinned here
    // because that is what the work stream will actually run as.
    modelOverride: AgentModelOverrideSchema.safeParse(row.model_override).data ?? null,
    nextPendingWakeup: row.next_pending_wakeup_at != null
      && row.next_pending_wakeup_prompt_prefix != null
      ? {
        dueAt: String(row.next_pending_wakeup_at),
        promptPreview: wakeupPromptPreview(String(row.next_pending_wakeup_prompt_prefix)),
      }
      : null,
    // Nothing is pinned at the moment it is created. Viewer-specific pin state
    // is added by WorkspaceDO's directory response, not this object-local
    // compatibility mapper.
    pinPosition: null
  };
}

function toMessage(row: Record<string, unknown>): Message {
  const authorType = String(row.author_type);
  const externalActor = ExternalActorSchema.safeParse(
    parseJson<unknown>(row.external_actor_json, null),
  );
  const author =
    externalActor.success
      ? { type: "external" as const, actor: externalActor.data }
      : authorType === "human"
      ? {
          type: "human" as const,
          user: {
            id: String(row.author_user_id),
            email: String(row.author_email),
            name: String(row.author_name),
            avatarUrl: row.author_avatar_url == null ? null : String(row.author_avatar_url),
            timezone: String(row.author_timezone),
            createdAt: String(row.author_created_at)
          }
        }
      : authorType === "agent"
        ? ({ type: "agent" } as const)
        : ({ type: "system" } as const);
  return {
    id: String(row.id),
    clientMessageId: row.client_message_id == null ? null : String(row.client_message_id),
    workspaceId: String(row.workspace_id),
    workstreamId: String(row.workstream_id),
    author,
    messageType: String(row.message_type) as Message["messageType"],
    textContent: String(row.text_content ?? ""),
    structuredContent: parseJson<Record<string, unknown> | null>(row.structured_content_json, null),
    mentions: parseJson<Message["mentions"]>(row.mentions_json, []),
    attachments: parseMessageAttachments(row.attachments_json),
    sequenceNumber: Number(row.sequence_number),
    createdAt: String(row.created_at),
    editedAt: row.edited_at == null ? null : String(row.edited_at)
  };
}

function parseMessageAttachments(value: unknown): Message["attachments"] {
  const rows = parseJson<Array<Record<string, unknown>>>(value, []);
  return rows.map((attachment) => ({
    id: String(attachment.id),
    // Bounded to `MessageAttachmentSchema`'s own limits. `resources.title` and
    // `resources.mime_type` carry no length constraint, so a single over-long
    // upload title would otherwise fail the transcript page for every
    // participant, on every page containing that message, forever.
    fileName: truncateUtf16Safe(String(attachment.fileName), 300),
    mimeType: truncateUtf16Safe(String(attachment.mimeType || "application/octet-stream"), 160),
    sizeBytes: Math.max(0, Number(attachment.sizeBytes ?? 0)),
    contentAvailable: Number(attachment.contentAvailable ?? 0) === 1 || attachment.contentAvailable === true,
    createdAt: String(attachment.createdAt),
  }));
}

export interface CreateWorkstreamInput {
  id?: string;
  workspaceId: string;
  title: string;
  /** `naming` when the title is a placeholder the naming agent will replace. */
  titleStatus?: "naming" | "automatic" | "settled";
  objective: string;
  /**
   * Whether a person wrote `objective` or it was derived at creation. Defaults
   * to `derived`, which is what every path that infers it from an opening
   * message or a generated prompt produces; only a caller carrying text a
   * person typed passes `authored`.
   */
  descriptionSource?: "authored" | "derived";
  emailAddress: string;
  creatorUserId: string | null;
  openingAuthor:
    | { type: "human"; userId: string }
    | { type: "external"; actor: ExternalActor }
    | { type: "agent" };
  openingMessage: string;
  openingStructuredContent?: Record<string, unknown> | null;
  clientMessageId: string;
  participantUserIds: string[];
  /**
   * Who may read it. Defaults to `workspace`; a caller passes `personal` when
   * the work stream is born private — a connector conversation that was itself
   * private, whose members are `participantUserIds`.
   */
  scope?: Scope;
  attachmentIds?: string[];
  /**
   * An OpenRouter model id every run of this work stream is pinned to, ahead of
   * the `agent-model-workstream` flag. Omitted — the usual case — leaves model
   * selection to the flag.
   */
  modelOverride?: string | null;
  opportunitySnapshot?: {
    opportunityId: string;
    version: number;
    displayPromptHash: string;
    executionPromptHash: string;
  };
}

export interface CreateMessageInput {
  workspaceId: string;
  workstreamId: string;
  authorUserId: string;
  text: string;
  clientMessageId: string;
  mentions: Array<Record<string, unknown>>;
  attachmentIds?: string[];
}

export interface CreateExternalMessageInput {
  workspaceId: string;
  workstreamId: string;
  actor: ExternalActor;
  text: string;
  clientMessageId: string;
  structuredContent?: Record<string, unknown> | null;
  messageType?: "text" | "elicitation";
}

export function createDatabase(db: D1DatabaseLike) {
  const workstreams = {
    async get(workspaceId: string, id: string): Promise<Workstream | null> {
      // Two statements by necessity: workstreams and wakeups are work-stream
      // authority while the automation tables are workspace authority, and a
      // single statement cannot span authorities through the runtime router.
      // The origin label resolves separately, against whichever side of the
      // router owns the automation tables for the handle in use.
      const row = await db
        .prepare(
          `SELECT w.*,
                  next_wakeup.due_at AS next_pending_wakeup_at,
                  substr(
                    next_wakeup.prompt,
                    1,
                    ${WORKSTREAM_WAKEUP_PROMPT_PREVIEW_LENGTH + 1}
                  ) AS next_pending_wakeup_prompt_prefix
           FROM workstreams w
           LEFT JOIN workstream_wakeups next_wakeup ON next_wakeup.id = (
             SELECT wakeup.id FROM workstream_wakeups wakeup
             WHERE wakeup.workspace_id = w.workspace_id
               AND wakeup.workstream_id = w.id
               AND wakeup.status = 'pending'
             ORDER BY wakeup.due_at, wakeup.id
             LIMIT 1
           )
           WHERE w.workspace_id = ? AND w.id = ? AND w.archived_at IS NULL`
        )
        .bind(workspaceId, id)
        .first<Record<string, unknown>>();
      if (!row) return null;
      let originLabel: string | null = null;
      if (row.automation_subscription_id != null) {
        const label = await db
          .prepare(
            `SELECT t.name AS origin_label
             FROM automation_subscriptions s
             JOIN automation_templates t ON t.id = s.template_id
             WHERE s.id = ?`
          )
          .bind(row.automation_subscription_id)
          .first<{ origin_label: string | null }>();
        originLabel = label?.origin_label ?? null;
      }
      return toWorkstream({ ...row, origin_label: originLabel });
    },

    async create(input: CreateWorkstreamInput): Promise<{ workstream: Workstream; messageId: string }> {
      const workstreamId = input.id ?? newId();
      const messageId = newId();
      const at = nowIso();
      const uniqueParticipants = [...new Set([
        ...(input.creatorUserId ? [input.creatorUserId] : []),
        ...input.participantUserIds,
      ])];
      const openingAuthorUserId = input.openingAuthor.type === "human"
        ? input.openingAuthor.userId
        : null;
      const externalActorJson = input.openingAuthor.type === "external"
        ? JSON.stringify(ExternalActorSchema.parse(input.openingAuthor.actor))
        : null;
      const attachmentStatements = buildMessageAttachmentStatements(db, {
        attachmentIds: input.attachmentIds ?? [],
        attachedAt: at,
        attachedByUserId: input.creatorUserId,
        messageId,
        workspaceId: input.workspaceId,
        workstreamId,
      });
      const statements = [
        db
          .prepare(
            `INSERT INTO workstreams
             (id, workspace_id, title, title_status, objective, description_source, email_address, email_route_status, origin_type, created_by_user_id, harness_status,
              next_sequence_number, latest_attention_sequence_number, last_activity_at, created_at, updated_at, model_override,
              created_from_opportunity_id, opportunity_version, opportunity_display_prompt_hash, opportunity_execution_prompt_hash, scope)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', 'ad_hoc', ?, 'running', 2, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            workstreamId,
            input.workspaceId,
            input.title,
            input.titleStatus ?? "settled",
            input.objective,
            input.descriptionSource ?? "derived",
            input.emailAddress,
            input.creatorUserId,
            at,
            at,
            at,
            input.modelOverride ?? null,
            input.opportunitySnapshot?.opportunityId ?? null,
            input.opportunitySnapshot?.version ?? null,
            input.opportunitySnapshot?.displayPromptHash ?? null,
            input.opportunitySnapshot?.executionPromptHash ?? null,
            input.scope ?? "workspace",
          ),
        db
          .prepare(
            `INSERT INTO messages
             (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
              message_type, text_content, structured_content_json, sequence_number, created_at, external_actor_json)
             VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, 1, ?, ?)`
          )
          .bind(
            messageId,
            input.clientMessageId,
            input.workspaceId,
            workstreamId,
            // The object's parts CHECK pairs actor JSON with author_type
            // 'external' and requires NULL actor JSON on 'system'; the legacy
            // D1 encoding ('system' + actor JSON) fails the compat view.
            input.openingAuthor.type === "human"
              ? "human"
              : input.openingAuthor.type === "agent"
                ? "agent"
                : input.openingAuthor.type === "external" ? "external" : "system",
            openingAuthorUserId,
            input.openingMessage,
            input.openingStructuredContent == null ? null : JSON.stringify(input.openingStructuredContent),
            at,
            externalActorJson,
          ),
        ...uniqueParticipants.map((userId) =>
          db
            .prepare(
              `INSERT INTO workstream_participants
               (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .bind(
              workstreamId,
              userId,
              input.creatorUserId,
              input.creatorUserId === userId ? "creator" : "explicit",
              at
            )
        ),
        ...attachmentStatements,
      ];
      const results = await db.batch(statements);
      if (results.some((result) => !result.success)) {
        throw new RepositoryError("database_error", "Could not create work stream");
      }
      // Deliberately no separate read-state insert. Object initialization
      // creates the creator's authoritative attention row; the regional D1
      // schema has no read-state table after migration 0090.
      const created = await workstreams.get(input.workspaceId, workstreamId);
      if (!created) throw new RepositoryError("database_error", "Created work stream was not readable");
      return { workstream: created, messageId };
    },

    async getMessageByClientId(
      workspaceId: string,
      workstreamId: string,
      clientMessageId: string,
    ): Promise<Message | null> {
      const row = await db.prepare(
        `SELECT m.*, u.email AS author_email, u.name AS author_name,
           u.avatar_url AS author_avatar_url, u.timezone AS author_timezone,
           u.created_at AS author_created_at,
           COALESCE((SELECT json_group_array(json_object(
             'type', mm.mention_type,
             'userId', mm.mentioned_user_id,
             'connectorType', mm.connector_type,
             'displayName', mentioned_person.name,
             'avatarUrl', mentioned_person.avatar_url,
             'startOffset', mm.start_offset,
             'endOffset', mm.end_offset
           )) FROM message_mentions mm
             LEFT JOIN users mentioned_person ON mentioned_person.id = mm.mentioned_user_id
             WHERE mm.message_id = m.id), '[]') AS mentions_json,
           COALESCE((SELECT json_group_array(json_object(
             'id', attachment_resource.id,
             'fileName', attachment_resource.title,
             'mimeType', COALESCE(attachment_resource.mime_type, 'application/octet-stream'),
             'sizeBytes', COALESCE(json_extract(attachment_resource.metadata_json, '$.size'), 0),
             'contentAvailable', CASE WHEN attachment_resource.content_ref IS NULL THEN 0 ELSE 1 END,
             'createdAt', attachment_resource.created_at
           )) FROM message_attachments ma
             JOIN resources attachment_resource ON attachment_resource.id = ma.resource_id
             WHERE ma.message_id = m.id ORDER BY ma.position), '[]') AS attachments_json
         FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
         WHERE m.workspace_id = ? AND m.workstream_id = ? AND m.client_message_id = ?`,
      ).bind(workspaceId, workstreamId, clientMessageId).first<Record<string, unknown>>();
      return row ? toMessage(row) : null;
    },

    async createExternalMessage(input: CreateExternalMessageInput): Promise<{ message: Message; inserted: boolean }> {
      const existing = await this.getMessageByClientId(
        input.workspaceId,
        input.workstreamId,
        input.clientMessageId,
      );
      if (existing) return { message: existing, inserted: false };
      const messageId = newId();
      const at = nowIso();
      const results = await db.batch([
        db.prepare(
          `INSERT INTO messages
           (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
            message_type, text_content, structured_content_json, sequence_number, created_at,
            external_actor_json)
           SELECT ?, ?, ?, w.id, 'external', NULL, ?, ?, ?, w.next_sequence_number, ?, ?
           FROM workstreams w WHERE w.id = ? AND w.workspace_id = ?
           ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
        ).bind(
          messageId,
          input.clientMessageId,
          input.workspaceId,
          input.messageType ?? "text",
          input.text,
          input.structuredContent == null ? null : JSON.stringify(input.structuredContent),
          at,
          JSON.stringify(ExternalActorSchema.parse(input.actor)),
          input.workstreamId,
          input.workspaceId,
        ),
        db.prepare(
          `UPDATE workstreams SET next_sequence_number = next_sequence_number + 1,
             latest_attention_sequence_number = next_sequence_number,
             last_activity_at = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ?
             AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
        ).bind(at, at, input.workstreamId, input.workspaceId, messageId),
      ]);
      const message = await this.getMessageByClientId(
        input.workspaceId,
        input.workstreamId,
        input.clientMessageId,
      );
      if (!message) throw new RepositoryError("database_error", "Could not store external message");
      return { message, inserted: Number(results[0]?.meta?.changes ?? 0) > 0 };
    },

    async addParticipant(
      workspaceId: string,
      workstreamId: string,
      userId: string,
      addedByUserId: string,
      reason: ParticipationReason
    ): Promise<void> {
      const result = await buildParticipantUpsertStatement(db, {
        workspaceId, workstreamId, userId, addedByUserId, reason,
      }).run();
      if (!result.success) throw new RepositoryError("database_error", "Could not add participant");
    },

    async createMessage(input: CreateMessageInput): Promise<Message> {
      await workstreams.addParticipant(
        input.workspaceId,
        input.workstreamId,
        input.authorUserId,
        input.authorUserId,
        "message"
      );
      const messageId = newId();
      const at = nowIso();
      const increment = db
        .prepare(
          `UPDATE workstreams SET next_sequence_number = next_sequence_number + 1,
             last_activity_at = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? RETURNING next_sequence_number - 1 AS sequence_number`
        )
        .bind(at, at, input.workstreamId, input.workspaceId);
      const incrementResult = await increment.first<{ sequence_number: number }>();
      if (!incrementResult) throw new RepositoryError("not_found", "Work stream not found");
      await db
        .prepare(
          `INSERT INTO messages
           (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
            message_type, text_content, structured_content_json, sequence_number, created_at)
           VALUES (?, ?, ?, ?, 'human', ?, 'text', ?, NULL, ?, ?)
           ON CONFLICT(workstream_id, client_message_id) DO NOTHING`
        )
        .bind(
          messageId,
          input.clientMessageId,
          input.workspaceId,
          input.workstreamId,
          input.authorUserId,
          input.text,
          incrementResult.sequence_number,
          at
        )
        .run();
      const row = await db
        .prepare(
          `SELECT m.*, u.email AS author_email, u.name AS author_name,
             u.avatar_url AS author_avatar_url, u.timezone AS author_timezone, u.created_at AS author_created_at,
             '[]' AS mentions_json, '[]' AS attachments_json
           FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
           WHERE m.workstream_id = ? AND m.client_message_id = ?`
        )
        .bind(input.workstreamId, input.clientMessageId)
        .first<Record<string, unknown>>();
      if (!row) throw new RepositoryError("database_error", "Could not store message");
      return toMessage(row);
    },

    async listMessages(
      workspaceId: string,
      workstreamId: string,
      limit = 100,
      beforeSequence?: number
    ): Promise<Message[]> {
      const cursor = beforeSequence ?? Number.MAX_SAFE_INTEGER;
      const result = await db
        .prepare(
          `SELECT m.*, u.email AS author_email, u.name AS author_name,
             u.avatar_url AS author_avatar_url, u.timezone AS author_timezone, u.created_at AS author_created_at,
             COALESCE((SELECT json_group_array(json_object(
               'type', mm.mention_type,
               'userId', mm.mentioned_user_id,
               'connectorType', mm.connector_type,
               'displayName', mentioned_person.name,
               'avatarUrl', mentioned_person.avatar_url,
               'startOffset', mm.start_offset,
               'endOffset', mm.end_offset
             )) FROM message_mentions mm
               LEFT JOIN users mentioned_person ON mentioned_person.id = mm.mentioned_user_id
               WHERE mm.message_id = m.id), '[]') AS mentions_json,
             COALESCE((SELECT json_group_array(json_object(
               'id', attachment_resource.id,
               'fileName', attachment_resource.title,
               'mimeType', COALESCE(attachment_resource.mime_type, 'application/octet-stream'),
               'sizeBytes', COALESCE(json_extract(attachment_resource.metadata_json, '$.size'), 0),
               'contentAvailable', CASE WHEN attachment_resource.content_ref IS NULL THEN 0 ELSE 1 END,
               'createdAt', attachment_resource.created_at
             )) FROM message_attachments ma
               JOIN resources attachment_resource ON attachment_resource.id = ma.resource_id
               WHERE ma.message_id = m.id ORDER BY ma.position), '[]') AS attachments_json
           FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
           WHERE m.workspace_id = ? AND m.workstream_id = ? AND m.sequence_number < ?
           ORDER BY m.sequence_number DESC LIMIT ?`
        )
        .bind(workspaceId, workstreamId, cursor, Math.min(limit, 250))
        .all<Record<string, unknown>>();
      return (result.results ?? []).reverse().map(toMessage);
    },

    async listMessagesAfter(
      workspaceId: string,
      workstreamId: string,
      afterSequence: number,
      limit = 100
    ): Promise<Message[]> {
      const result = await db
        .prepare(
          `SELECT m.*, u.email AS author_email, u.name AS author_name,
             u.avatar_url AS author_avatar_url, u.timezone AS author_timezone, u.created_at AS author_created_at,
             COALESCE((SELECT json_group_array(json_object(
               'type', mm.mention_type,
               'userId', mm.mentioned_user_id,
               'connectorType', mm.connector_type,
               'displayName', mentioned_person.name,
               'avatarUrl', mentioned_person.avatar_url,
               'startOffset', mm.start_offset,
               'endOffset', mm.end_offset
             )) FROM message_mentions mm
               LEFT JOIN users mentioned_person ON mentioned_person.id = mm.mentioned_user_id
               WHERE mm.message_id = m.id), '[]') AS mentions_json,
             COALESCE((SELECT json_group_array(json_object(
               'id', attachment_resource.id,
               'fileName', attachment_resource.title,
               'mimeType', COALESCE(attachment_resource.mime_type, 'application/octet-stream'),
               'sizeBytes', COALESCE(json_extract(attachment_resource.metadata_json, '$.size'), 0),
               'contentAvailable', CASE WHEN attachment_resource.content_ref IS NULL THEN 0 ELSE 1 END,
               'createdAt', attachment_resource.created_at
             )) FROM message_attachments ma
               JOIN resources attachment_resource ON attachment_resource.id = ma.resource_id
               WHERE ma.message_id = m.id ORDER BY ma.position), '[]') AS attachments_json
           FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
           WHERE m.workspace_id = ? AND m.workstream_id = ? AND m.sequence_number > ?
           ORDER BY m.sequence_number ASC LIMIT ?`
        )
        .bind(workspaceId, workstreamId, afterSequence, Math.min(limit, 250))
        .all<Record<string, unknown>>();
      return (result.results ?? []).map(toMessage);
    }
  };

  const automations = {
    async list(workspaceId: string): Promise<AutomationSummary[]> {
      const result = await db
        .prepare(
          `SELECT s.id, s.email_address, t.name, t.description, s.scope, s.status,
             s.next_run_at, s.last_run_at, s.updated_at,
             CASE WHEN t.latest_version_number > v.version_number THEN 1 ELSE 0 END AS update_available
           FROM automation_subscriptions s
           JOIN automation_templates t ON t.id = s.template_id
           JOIN automation_template_versions v ON v.id = s.template_version_id
           WHERE s.workspace_id = ? AND t.archived_at IS NULL AND s.lifecycle_state = 'visible'
           ORDER BY t.name COLLATE NOCASE`
        )
        .bind(workspaceId)
        .all<Record<string, unknown>>();
      return (result.results ?? []).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        description: String(row.description),
        emailAddress: row.email_address == null ? null : String(row.email_address),
        scope: String(row.scope) as Scope,
        status: String(row.status) as AutomationSummary["status"],
        nextRunAt: row.next_run_at == null ? null : String(row.next_run_at),
        lastRunAt: row.last_run_at == null ? null : String(row.last_run_at),
        updatedAt: String(row.updated_at),
        updateAvailable: Number(row.update_available) === 1
      }));
    }
  };

  const activities = {
    async claim(activityId: string): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE activities SET processing_status = 'processing'
           WHERE id = ? AND processing_status IN ('pending', 'failed')`
        )
        .bind(activityId)
        .run();
      return result.success && Number(result.meta?.changes ?? 0) > 0;
    },
    async markProcessed(activityId: string): Promise<void> {
      await db
        .prepare("UPDATE activities SET processing_status = 'processed' WHERE id = ?")
        .bind(activityId)
        .run();
    }
  };

  return { raw: db, workstreams, automations, activities };
}

export type AvalonDatabase = ReturnType<typeof createDatabase>;
