import type {
  AutomationSummary,
  ExternalActor,
  Scope,
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
   * Who may read it. Defaults to `personal` — the creator and everyone in
   * `participantUserIds`, and nobody else — which is what a work stream nobody
   * has said anything about is. A caller passes `workspace` when it *knows* the
   * audience is wider than the room: a thread in a public Slack channel, whose
   * members are not seated as participants and would otherwise be handed a work
   * stream none of them could open.
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
  // The work-stream repository is gone with the compatibility views it wrote.
  // `create` batched the root, its participants and the opening message
  // through `_runtime_workstreams`, `_runtime_workstream_participants` and
  // `_runtime_messages`, and `addParticipant` wrote the participant view; each
  // is an operation on the work stream's own authority now, reached from
  // `apps/api` where the object ports live. This module keeps the tables D1
  // still owns.
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

  return { raw: db, automations, activities };
}

export type AvalonDatabase = ReturnType<typeof createDatabase>;
