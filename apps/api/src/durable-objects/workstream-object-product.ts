import {
  AcknowledgeWorkstreamReadRequestSchema,
  ActivitySuggestionSchema,
  AnswerElicitationRequestSchema,
  MESSAGE_MAX_CHARACTERS,
  MentionSchema,
  MessageSchema,
  ParticipantSchema,
  ResourceRelationshipTypeSchema,
  WorkstreamResourceSchema,
  resourceDirectionForRelationship,
  ScopeSchema,
  UpdateWorkstreamRequestSchema,
  WorkstreamBatchUpdateSchema,
  WORKSTREAM_DESCRIPTION_MAX_CHARACTERS,
  WorkstreamDetailSchema,
  WorkstreamSchema,
  WorkstreamWorkflowInputSchema,
  workstreamParticipantPreview,
  type Elicitation,
  type ActivitySuggestion,
  type Message,
  type ResourceRelationshipType,
  type WorkstreamResource,
  type Workstream,
  type WorkstreamBatchUpdate,
  type WorkstreamDetail,
  type WorkstreamWorkflowInput,
  type WorkstreamMessageAdmissionReceipt,
  type PendingTranscriptInput,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
  WORKSTREAM_NAMING_GRACE_MS,
  asHarnessRunId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type HarnessRunId,
  type WorkspaceId,
  type WorkstreamId,
} from "@rally/contracts";
import type { AddressingContextMessage } from "@rally/agent-harness";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { z } from "zod";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  connectorRegistryForEnv,
  connectorSupportsResourceHydration,
} from "../lib/connector-registry";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logWarn } from "../observability/logger";
import {
  ContentAudienceSchema,
  contentAudienceContainsWorkstream,
  type ContentAudience,
  type WorkstreamReaderAudience,
} from "../lib/audience-containment";
import { prepareMentionMarkdown, type MentionPerson } from "../lib/message-mentions";
import { SUGGESTED_CONTEXT_ENABLED } from "../lib/suggested-context";
import { uuidV7 } from "../lib/uuid-v7";
import { connectionFromRow } from "../mappers/connection";
import {
  pinnedModelRouting,
  resolveAgentModelRouting,
  resolveNewWorkstreamModelRouting,
} from "../services/agent-model-flags";
import { classifyWorkstreamMessage } from "../services/integrations";
import {
  canonicalModelMessageJson,
  projectParticipantModelMessage,
} from "../services/workstream-participant-model-message";
import type { ModelAttachmentSource } from "../services/attachment-model-content";
import { memberSafeHarnessError } from "../services/workstream-service";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "../services/workspace-runtime-database";
import { WorkstreamIdentityStorage } from "./workstream-identity-storage";
import { substreamLoopId, workspaceDOName } from "./names";
import { WorkspaceAutomationOriginLabelSchema } from "./workspace-directory-protocol";
import { WorkspaceReserveDraftAttachmentsResultSchema } from "./workspace-draft-attachment-protocol";
import { WORKSTREAM_DIRECTORY_RESOURCE_LINK_LIMIT } from "./workstream-regional-effect";
import type { RegionalEffectCommand, WorkstreamObjectStore } from "./workstream-object-storage";
import {
  SubstreamLoopStorage,
  type PendingInputPreparationKind,
  type PendingInputPreparationRow,
  type PendingLoopInputRow,
} from "./substream-loop-storage";
import {
  WorkstreamTranscriptStorage,
  type PendingInputDeliveryEffectInput,
  type PreparedParticipantMessage,
} from "./workstream-transcript-storage";
import {
  AdmitExternalMessageInputSchema,
  AnswerExternalElicitationInputSchema,
  type AdmitExternalMessageInput,
  type AnswerExternalElicitationInput,
  type ExternalMessageAdmissionResult,
} from "./workstream-external-message-protocol";

type SqlRow = Record<string, SqlStorageValue>;
interface AttachmentResourceRow {
  id: string;
  connection_id: string | null;
  resource_type: string;
  provider: string;
  provider_resource_id: string | null;
  title: string;
  mime_type: string | null;
  content_ref: string | null;
  content_sha256: string | null;
  canonical_url: string | null;
  metadata_json: string;
  model_content_ref: string | null;
  model_mime_type: string | null;
  model_content_sha256: string | null;
  model_metadata_json: string | null;
  model_content_status: "pending" | "processing" | "ready" | "failed" | "unsupported" | null;
  model_content_extractor_version: string | null;
  model_content_error_code: string | null;
  created_at: string;
  updated_at: string;
}
const UNKNOWN_MEMBER_DISPLAY_NAME = "A workspace member";

export const WorkstreamObjectCreateMessageInputSchema = z.object({
  text: z.string().max(MESSAGE_MAX_CHARACTERS),
  clientMessageId: z.string().min(1).max(120),
  mentions: z.array(MentionSchema).default([]),
  confirmedParticipantUserIds: z.array(z.string().uuid()).default([]),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
  runMode: z.enum(["steer", "queue"]).optional(),
  telemetryOperationId: z.string().min(1).max(180).optional(),
  forcedHarnessOrigin: z.string().min(1).max(80).optional(),
  parentHarnessRunId: z.string().uuid().optional(),
  expectedLatestHarnessRunId: z.string().uuid().optional(),
  expectedToolInvocationId: z.string().uuid().optional(),
  slackOrigin: z.unknown().optional(),
  slackSearchAuthorization: z.unknown().optional(),
}).refine((value) => value.text.trim().length > 0 || value.attachmentIds.length > 0, {
  message: "A message must include text or an attachment",
});

export const WorkstreamObjectCreateSuggestionInputSchema = z.object({
  id: z.string().uuid(),
  activityId: z.string().uuid(),
  title: z.string().min(1).max(300),
  summary: z.string().max(2_000),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(1_200),
  matchedEntities: z.array(z.string().max(500)).max(100),
  source: z.enum(["contextual_routing", "suggested_work"]),
  sourceAudience: ContentAudienceSchema,
}).strict();

export type WorkstreamObjectCreateSuggestionInput = z.infer<
  typeof WorkstreamObjectCreateSuggestionInputSchema
>;

export const InitializeWorkstreamObjectInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  generation: z.number().int().positive(),
  title: z.string().min(1).max(180),
  objective: z.string().max(WORKSTREAM_DESCRIPTION_MAX_CHARACTERS),
  descriptionSource: z.enum(["authored", "derived"]),
  titleStatus: z.enum(["naming", "automatic", "settled"]),
  emailAddress: z.string().email().max(254).nullable(),
  creatorUserId: z.string().uuid(),
  openingMessage: z.string().max(MESSAGE_MAX_CHARACTERS),
  mentions: z.array(MentionSchema).default([]),
  openingStructuredContent: z.unknown().nullable().default(null),
  clientMessageId: z.string().min(1).max(120),
  participantUserIds: z.array(z.string().uuid()),
  attachmentIds: z.array(z.string().uuid()).max(10),
  originResourceIds: z.array(z.string().uuid()).default([]),
  /**
   * Who may read it from birth. Defaulted to `personal`: a work stream nobody
   * has said anything about is the one somebody just started for themselves,
   * and the two mistakes are not symmetrical — a private work stream that
   * should have been public is opened from its own right-click menu, while the
   * reverse has already been read. A caller that *knows* the audience is public
   * — a public Slack channel's thread, for example — says `workspace` outright.
   * Automation executions remain private and seat their creator.
   *
   * Defaulted rather than required so a rolling deploy stays safe in the one
   * direction it can go wrong: the previous Worker's creation service names no
   * scope, and a required field would turn every create it issues against a
   * replaced object into a validation failure for the length of the deploy.
   */
  scope: ScopeSchema.default("personal"),
  /**
   * Whether the people in `participantUserIds` are told they were added.
   *
   * Separate from the list for the same reason `scope` is separate from it: the
   * object cannot tell one kind of list from the other, and they are not the
   * same event. A person picking names in "Add people" is inviting them, and
   * being invited is worth a Slack DM and an inbox. A connector ingress fills
   * the same field with a conversation's resolved roster — `CreateWorkstreamRequestSchema`
   * says so where the cap used to be, and a Slack channel's audience "can be
   * hundreds" — and nobody in that channel was added by anybody. Telling them
   * so would DM a roster on somebody else's behalf about something that did not
   * happen, in a thread they are already reading.
   *
   * Defaulted to `false`, which is both halves of the safe direction: a caller
   * that has not thought about it does not send mail, and a rolling deploy in
   * which the previous Worker's creation service names no value stays quiet
   * rather than validating-failing every create against a replaced object.
   */
  notifyParticipants: z.boolean().default(false),
  modelOverride: z.string().max(200).nullable(),
  originType: z.enum(["ad_hoc", "automation"]).default("ad_hoc"),
  automationSubscriptionId: z.string().uuid().nullable().default(null),
  automationRunId: z.string().uuid().nullable().default(null),
  plannedFor: z.string().datetime({ offset: true }).nullable().default(null),
  systemKind: z.literal("digest").nullable().default(null),
  createdFromOpportunityId: z.string().uuid().nullable().default(null),
  opportunityVersion: z.number().int().positive().nullable().default(null),
  opportunityDisplayPromptHash: z.string().max(200).nullable().default(null),
  opportunityExecutionPromptHash: z.string().max(200).nullable().default(null),
  executionPrincipal: z.unknown(),
  slackOrigin: z.unknown().optional(),
  slackSearchAuthorization: z.unknown().optional(),
  telemetryOperationId: z.string().uuid().optional(),
  telemetrySubjectUserId: z.string().uuid().optional(),
  reason: z.string().min(1).max(80),
}).strict();

export type InitializeWorkstreamObjectInput = z.infer<typeof InitializeWorkstreamObjectInputSchema>;

/**
 * What a caller hands `initialize`, before the schema fills its defaults in.
 *
 * Separate from {@link InitializeWorkstreamObjectInput} — the parsed shape the
 * method works with — because a defaulted field is optional on the way in and
 * present on the way out. Typing the boundary with the output shape would make
 * every default unreachable, which is how `scope` would have arrived required
 * at exactly the callers the default exists for.
 */
export type InitializeWorkstreamObjectRequest = z.input<typeof InitializeWorkstreamObjectInputSchema>;

export type WorkstreamObjectCreateMessageInput = z.infer<typeof WorkstreamObjectCreateMessageInputSchema>;
export type WorkstreamObjectUpdateInput = z.infer<typeof UpdateWorkstreamRequestSchema>;
export type WorkstreamObjectAcknowledgeReadInput = z.infer<typeof AcknowledgeWorkstreamReadRequestSchema>;
export type WorkstreamObjectAnswerElicitationInput = z.infer<typeof AnswerElicitationRequestSchema>;

interface RootRow extends SqlRow {
  workstream_key: string;
  parent_workspace_key: string;
  authority_mode: string;
  authority_generation: number;
  title: string;
  description: string;
  preview: string;
  scope: "personal" | "workspace";
  exact_state: string;
  next_sequence_number: number;
  next_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  created_at: number;
  last_people_activity_at: number;
  updated_at: number;
  completed_at: number | null;
  archived_at: number | null;
  origin_type: "ad_hoc" | "automation";
  created_by_user_id: string | null;
  automation_subscription_id: string | null;
  automation_run_id: string | null;
  planned_for: number | null;
  email_address: string | null;
  system_kind: "digest" | null;
  title_status: "naming" | "automatic" | "settled";
  model_override: string | null;
}

interface AttentionRow extends SqlRow {
  unread_tracking_start_ordinal: number;
  seen_attention_ordinal: number;
  manual_unread_from_ordinal: number | null;
  latest_mention_attention_ordinal: number;
  version: number;
}

interface PartRow extends SqlRow {
  id: string;
  sequence_number: number;
  attention_ordinal: number | null;
  author_type: string;
  author_user_id: string | null;
  external_actor_json: string | null;
  message_type: Message["messageType"];
  content: string | null;
  structured_content_json: string | null;
  client_message_id: string | null;
  edited_at: number | null;
  created_at: number;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  timezone: string;
  created_at: string;
}

interface PartMentionRow extends SqlRow {
  part_id: string;
  mention_kind: "person" | "connector";
  target_user_id: string | null;
  connector_type: string | null;
  start_offset: number;
  end_offset: number;
}

interface PartAttachmentRow extends SqlRow {
  part_id: string;
  resource_id: string;
  attachment_json: string;
}

const D1_ID_CHUNK_SIZE = 90;

function chunks<T>(values: readonly T[], size = D1_ID_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

interface LocalMessageWrite {
  messageId: string;
  sequenceNumber: number;
  attentionOrdinal: number;
  createdAt: number;
  inserted: boolean;
}

/** A durable-loop wakeup request for the SubstreamAgent that owns execution. */
interface WorkstreamPendingInputActivationRequest {
  kind: "activate_substream_loop";
  loopId: string;
  cause: "pending_input";
  inputId: string;
}

interface WorkstreamManualRetryActivationRequest {
  kind: "activate_substream_loop";
  loopId: string;
  cause: "manual_retry";
  inputId: null;
  receiptRunId: HarnessRunId;
  workflowInput: WorkstreamWorkflowInput;
}

export type WorkstreamLoopActivationRequest =
  | WorkstreamPendingInputActivationRequest
  | WorkstreamManualRetryActivationRequest;

export interface WorkstreamObjectCreateMessageResult extends WorkstreamMessageAdmissionReceipt {
  activationRequest: WorkstreamLoopActivationRequest | null;
  inserted: boolean;
}

export interface WorkstreamObjectAnswerElicitationResult {
  elicitation: Elicitation | undefined;
  responsePartId: string;
  activationRequest: WorkstreamLoopActivationRequest | null;
}

export interface WorkstreamObjectRetryResult {
  harnessRunId: HarnessRunId;
  activationRequest: WorkstreamManualRetryActivationRequest;
}

export interface WorkstreamObjectExternalMessageResult extends ExternalMessageAdmissionResult {
  activationRequest: WorkstreamLoopActivationRequest | null;
  inserted: boolean;
}

function first<T extends SqlRow>(cursor: SqlStorageCursor<T>): T | null {
  return cursor.toArray()[0] ?? null;
}

function iso(epoch: number | null): string | null {
  return epoch === null ? null : new Date(epoch).toISOString();
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function harnessStatus(exactState: string): Workstream["harnessStatus"] {
  if (exactState === "scheduled") return "scheduled";
  if (["running", "interrupting", "preparing_context", "waiting_capacity"].includes(exactState)) {
    return "running";
  }
  if (exactState === "needs_input") return "needs_input";
  if (exactState === "completed") return "completed";
  if (["failed", "budget_exhausted"].includes(exactState)) return "failed";
  if (exactState === "cancelled") return "stopped";
  return "idle";
}

function participantVisible(root: RootRow, participant: boolean): boolean {
  return root.scope === "workspace" || participant;
}

function userFromRow(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    timezone: row.timezone,
    createdAt: row.created_at,
  };
}

/**
 * Product repository for one WorkstreamDO.
 *
 * Every method reads or mutates only this object's normalized SQL for product
 * state. Regional D1 is consulted only for current workspace membership,
 * profiles, and other control-plane facts. Workspace-owned resources,
 * connectors, automation labels, and pins resolve through WorkspaceDO.
 */
export class WorkstreamObjectProductService {
  private readonly activeInputPreparations = new Map<string, number>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly objectStore: WorkstreamObjectStore,
    private readonly env: Env,
    private readonly transcript = new WorkstreamTranscriptStorage(storage),
    private readonly loops = new SubstreamLoopStorage(storage),
  ) {}

  private beginInputPreparation(inputId: string): void {
    this.activeInputPreparations.set(
      inputId,
      (this.activeInputPreparations.get(inputId) ?? 0) + 1,
    );
  }

  private endInputPreparation(inputId: string): void {
    const active = this.activeInputPreparations.get(inputId) ?? 0;
    if (active <= 1) this.activeInputPreparations.delete(inputId);
    else this.activeInputPreparations.set(inputId, active - 1);
  }

  private preparationFailureCode(error: unknown): string {
    if (error instanceof ApiError && /^[a-z0-9_]{1,160}$/.test(error.code)) return error.code;
    if (error instanceof Error && /^[a-z0-9_]{1,160}$/.test(error.message)) return error.message;
    return "pending_input_preparation_failed";
  }

  private async runInputPreparation<T>(
    preparation: PendingInputPreparationRow,
    work: () => Promise<T>,
  ): Promise<T> {
    if (preparation.state === "failed") {
      throw new ApiError(409, "pending_input_preparation_failed", "This message could not be prepared");
    }
    if (preparation.state !== "preparing") {
      throw new Error(`pending_input_preparation_${preparation.state}`);
    }
    this.beginInputPreparation(preparation.input_id);
    try {
      return await work();
    } catch (error) {
      this.loops.failInputPreparation({
        inputId: preparation.input_id,
        terminalCode: this.preparationFailureCode(error),
        now: Date.now(),
      });
      throw error;
    } finally {
      this.endInputPreparation(preparation.input_id);
      // A settled earlier preparation can make later ready inputs runnable.
      // The alarm is only a wake-up hint; the loop/mailbox rows remain truth.
      if (this.loops.pendingInputs().length > 0
        || this.nextRecoverableInputPreparationAt() !== null) {
        await this.storage.setAlarm(Date.now() + 1);
      }
    }
  }

  private reserveInputPreparation(input: {
    root: RootRow;
    inputId: string;
    clientMessageId: string;
    preparationKind: PendingInputPreparationKind;
    envelope: unknown;
    now: number;
  }): PendingInputPreparationRow {
    const loop = this.ensureExternalMessageLoop(input.root, input.now);
    return this.loops.reserveInputPreparation({
      inputId: input.inputId,
      loopId: loop.loop_id,
      clientMessageId: input.clientMessageId,
      preparationKind: input.preparationKind,
      envelopeJson: JSON.stringify(input.envelope),
      now: input.now,
    }).preparation;
  }

  private workspaceDirectory(workspaceId: string) {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      asWorkspaceId(workspaceId),
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(workspaceId)),
    );
  }

  private async reserveAttachmentDrafts(input: {
    workspaceId: string;
    workstreamId: string;
    inputId: string;
    userId: string;
    resourceIds: string[];
    now: number;
  }): Promise<AttachmentResourceRow[]> {
    if (input.resourceIds.length === 0) return [];
    if (new Set(input.resourceIds).size !== input.resourceIds.length) {
      throw new ApiError(
        422,
        "invalid_message_attachment",
        "One or more attachments are unavailable or already sent",
      );
    }
    // Record the recovery obligation before crossing the authority boundary.
    // A crash before the RPC is harmless; replay reserves idempotently. A
    // crash after the RPC leaves a durable row that can release the hold once
    // this preparation has reached a terminal state.
    this.storage.transactionSync(() => {
      for (const resourceId of input.resourceIds) {
        this.storage.sql.exec(
          `INSERT INTO pending_attachment_reservation_recovery
             (input_id, resource_id, workspace_id, workstream_id,
              release_authority, created_at)
           VALUES (?, ?, ?, ?, 'preparation', ?)
           ON CONFLICT(input_id, resource_id) DO NOTHING`,
          input.inputId,
          resourceId,
          input.workspaceId,
          input.workstreamId,
          input.now,
        );
      }
      const tracked = this.storage.sql.exec<{
        resource_id: string;
        workspace_id: string;
        workstream_id: string;
      }>(
        `SELECT resource_id, workspace_id, workstream_id
           FROM pending_attachment_reservation_recovery WHERE input_id = ?`,
        input.inputId,
      ).toArray();
      if (tracked.length !== input.resourceIds.length
        || tracked.some((row) => row.workspace_id !== input.workspaceId
          || row.workstream_id !== input.workstreamId)) {
        throw new Error("pending_attachment_reservation_recovery_conflict");
      }
    });
    const workspace = await this.workspaceDirectory(input.workspaceId);
    const result = WorkspaceReserveDraftAttachmentsResultSchema.parse(
      await workspace.reserveDraftAttachments({
        workspaceId: asWorkspaceId(input.workspaceId),
        workstreamId: asWorkstreamId(input.workstreamId),
        inputId: input.inputId,
        userId: asUserId(input.userId),
        resourceIds: input.resourceIds,
      }),
    );
    if (result.outcome === "unavailable") {
      throw new ApiError(
        422,
        "invalid_message_attachment",
        "One or more attachments are unavailable or already sent",
      );
    }
    return result.resources.map((resource) => ({
      id: resource.id,
      connection_id: resource.connectionId,
      resource_type: resource.resourceType,
      provider: resource.provider,
      provider_resource_id: resource.providerResourceId,
      title: resource.title,
      mime_type: resource.mimeType,
      content_ref: resource.contentRef,
      content_sha256: resource.contentSha256,
      canonical_url: resource.canonicalUrl,
      metadata_json: resource.metadataJson,
      model_content_ref: resource.modelContentRef,
      model_mime_type: resource.modelMimeType,
      model_content_sha256: resource.modelContentSha256,
      model_metadata_json: resource.modelMetadataJson,
      model_content_status: resource.modelContentStatus,
      model_content_extractor_version: resource.modelContentExtractorVersion,
      model_content_error_code: resource.modelContentErrorCode,
      created_at: resource.createdAt,
      updated_at: resource.updatedAt,
    }));
  }

  private markAttachmentReleaseOwnedByProjection(inputId: string): void {
    this.storage.sql.exec(
      `UPDATE pending_attachment_reservation_recovery
          SET release_authority = 'projection' WHERE input_id = ?`,
      inputId,
    );
  }

  private terminalAttachmentReservation() {
    return first(this.storage.sql.exec<{
      input_id: string;
      workspace_id: string;
      workstream_id: string;
      release_authority: "preparation" | "projection";
      mailbox_state: "failed" | "discarded";
    } & SqlRow>(
      `SELECT recovery.input_id, recovery.workspace_id, recovery.workstream_id,
              recovery.release_authority, mailbox.state AS mailbox_state
         FROM pending_attachment_reservation_recovery recovery
         JOIN pending_loop_input_mailbox mailbox ON mailbox.input_id = recovery.input_id
        WHERE mailbox.state IN ('failed', 'discarded')
        ORDER BY mailbox.input_sequence, recovery.input_id LIMIT 1`,
    ));
  }

  private async recoverTerminalAttachmentReservation(): Promise<boolean> {
    const recovery = this.terminalAttachmentReservation();
    if (!recovery) return false;
    if (recovery.release_authority === "preparation") {
      const workspace = await this.workspaceDirectory(recovery.workspace_id);
      await workspace.releaseDraftAttachments({
        workspaceId: asWorkspaceId(recovery.workspace_id),
        workstreamId: asWorkstreamId(recovery.workstream_id),
        inputId: recovery.input_id,
      });
    }
    // Projection-owned holds are released by WorkspaceDO with its canonical
    // resource link. Successful delivery deletes this recovery row and its
    // mailbox in the same local transaction that queues that common effect.
    this.storage.sql.exec(
      `DELETE FROM pending_attachment_reservation_recovery WHERE input_id = ?`,
      recovery.input_id,
    );
    return true;
  }

  nextRecoverableInputPreparationAt(now: number = Date.now()): number | null {
    if (this.terminalAttachmentReservation()) return now;
    const preparation = this.loops.oldestPreparingInput();
    if (!preparation || this.activeInputPreparations.has(preparation.input_id)) return null;
    return now;
  }

  async resumeOldestInputPreparation(): Promise<"none" | "active" | "settled"> {
    if (await this.recoverTerminalAttachmentReservation()) return "settled";
    const preparation = this.loops.oldestPreparingInput();
    if (!preparation) return "none";
    if (this.activeInputPreparations.has(preparation.input_id)) return "active";
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(preparation.envelope_json ?? "null") as Record<string, unknown>;
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
        throw new Error("pending_input_preparation_envelope_invalid");
      }
    } catch (error) {
      this.loops.failInputPreparation({
        inputId: preparation.input_id,
        terminalCode: this.preparationFailureCode(error),
        now: Date.now(),
      });
      return "settled";
    }
    try {
      if (preparation.preparation_kind === "human_message") {
        await this.createMessage(envelope.auth as AuthContext, envelope.input as WorkstreamObjectCreateMessageInput);
      } else if (preparation.preparation_kind === "external_message") {
        await this.admitExternalMessage(envelope.input as AdmitExternalMessageInput);
      } else if (preparation.preparation_kind === "external_elicitation") {
        await this.answerExternalElicitation(envelope.input as AnswerExternalElicitationInput);
      } else {
        await this.answerElicitation(
          envelope.auth as AuthContext,
          String(envelope.elicitationId),
          envelope.input as WorkstreamObjectAnswerElicitationInput,
        );
      }
    } catch {
      // Admission methods terminalize preparation failures before returning.
    }
    return "settled";
  }

  private workspaceDatabase(workspaceId: string): D1Database {
    return withWorkspaceRuntimeDatabase(this.env, workspaceId).DB;
  }

  private root(): RootRow {
    const row = first(this.storage.sql.exec<RootRow>(`SELECT * FROM workstream WHERE id = 1`));
    if (!row) throw new ApiError(404, "workstream_not_found", "Work stream not found");
    if (row.authority_mode !== "authoritative" || row.authority_generation <= 0) {
      throw new ApiError(503, "workstream_maintenance", "Work-stream maintenance is in progress");
    }
    return row;
  }

  bootstrapRuntimeAuthority(input: {
    workspaceId: WorkspaceId;
    workstreamId: WorkstreamId;
    generation: number;
  }): void {
    this.objectStore.ensureIdentity({
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
    }, this.env.AVALON_REGION);
    const now = Date.now();
    const row = first(this.storage.sql.exec<{
      authority_mode: string;
      authority_generation: number;
    }>(`SELECT authority_mode, authority_generation FROM workstream WHERE id = 1`));
    if (!row) throw new Error("workstream_runtime_bootstrap_missing_root");
    if (row.authority_mode === "authoritative") {
      if (row.authority_generation !== input.generation) {
        throw new Error("workstream_runtime_bootstrap_generation_mismatch");
      }
      return;
    }
    this.storage.sql.exec(
      `UPDATE workstream SET authority_mode = 'authoritative', authority_generation = ?,
              exact_state = 'idle', state_reason_code = 'runtime_bootstrap',
              authority_epoch = authority_epoch + 1, state_changed_at = ?, updated_at = ?
        WHERE id = 1 AND authority_mode = 'preparing'`,
      input.generation,
      now,
      now,
    );
  }

  /**
   * The product half of a system producer's bootstrap.
   *
   * `bootstrapRuntimeAuthority` above opens an empty authoritative object; this
   * writes what the work stream *is* — its title, its origin, its creator, and
   * the members who can see it. Split that way because the two halves have
   * different callers: the runtime bootstrap is reached by anything that needs
   * an object at all, and this only by the four producers that create a work
   * stream nobody typed into.
   *
   * Deliberately not `initialize`, which is the member path. That method
   * requires an opening message and writes the first part, the first run and
   * the creator's attention row, leaving `next_sequence_number` at 2. A work
   * stream provisioned for an automation, a schedule or a digest has none of
   * those yet — content arrives on its first run — so sharing one method would
   * make every one of those invariants conditional, and a counter that is
   * sometimes 1 and sometimes 2 is how the transcript's ordering breaks. It
   * also keeps `initialize`'s `auth.userId === creatorUserId` check where it
   * is rather than widening it to admit a system caller.
   *
   * Idempotent on replay: a producer that crashed between the runtime
   * bootstrap and this call retries the whole pair, and the row is already
   * authoritative by then. Re-running the write would reset counters a first
   * run may already have advanced, so a root that has left `runtime_bootstrap`
   * answers `provisioned` without touching anything.
   */
  async provisionWorkstream(input: {
    workspaceId: string;
    workstreamId: string;
    title: string;
    objective: string;
    scope: string;
    originType: string;
    createdByUserId: string;
    participantUserIds: readonly string[];
    harnessStatus: string;
    emailAddress: string | null;
    emailRouteStatus: string | null;
    systemKind: string | null;
    automationSubscriptionId: string | null;
    automationRunId: string | null;
    plannedFor: number | null;
    modelOverride: string | null;
    now: number;
  }): Promise<{ outcome: "provisioned" | "already_provisioned" }> {
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== input.workspaceId
      || identity.workstreamId !== input.workstreamId) {
      throw new Error("workstream_provision_identity_mismatch");
    }
    return this.commitRuntimeMutation(
      () => new WorkstreamIdentityStorage(this.storage).provision(input),
      true,
    );
  }

  async initialize(
    auth: AuthContext,
    rawInput: InitializeWorkstreamObjectRequest,
  ): Promise<{
    workstream: Workstream;
    turnId: string;
    harnessRunId: string;
    workflowInput: WorkstreamWorkflowInput;
  }> {
    const input = InitializeWorkstreamObjectInputSchema.parse(rawInput);
    if (auth.workspaceId !== input.workspaceId || auth.userId !== input.creatorUserId) {
      throw new ApiError(403, "workstream_create_denied", "The work stream cannot be created for this identity");
    }
    const requestedPersonIds = [...new Set(input.mentions.flatMap((mention) =>
      mention.type === "person" && mention.userId ? [mention.userId] : []))];
    const candidateMemberIds = [...new Set([
      input.creatorUserId,
      ...input.participantUserIds,
      ...requestedPersonIds,
    ])];
    const members = await this.env.DB.prepare(
      `SELECT user_id FROM workspace_members
        WHERE workspace_id = ? AND status = 'active'
          AND user_id IN (${candidateMemberIds.map(() => "?").join(",")})`,
    ).bind(input.workspaceId, ...candidateMemberIds).all<{ user_id: string }>();
    if ((members.results ?? []).length !== candidateMemberIds.length) {
      throw new ApiError(422, "invalid_workspace_member", "A participant is not an active workspace member");
    }
    // Typed reads against the workspace object that owns `resources`: the
    // draft filter travels with the request so somebody else's draft — or an
    // already sent one — cannot be attached by id.
    const workspaceObject = await this.workspaceDirectory(input.workspaceId);
    const attachments = input.attachmentIds.length === 0 ? [] : (await workspaceObject
      .resourceDescriptors({
        workspaceId: input.workspaceId,
        resourceIds: [...new Set(input.attachmentIds)],
        draftUploadedByUserId: input.creatorUserId,
      })).items;
    if (attachments.length !== input.attachmentIds.length) {
      throw new ApiError(422, "invalid_message_attachment", "One or more attachments are unavailable or already sent");
    }
    const originResources = input.originResourceIds.length === 0 ? [] : (await workspaceObject
      .resourceDescriptors({
        workspaceId: input.workspaceId,
        resourceIds: [...new Set(input.originResourceIds)],
        draftUploadedByUserId: null,
      })).items;
    if (originResources.length !== new Set(input.originResourceIds).size) {
      throw new ApiError(422, "invalid_origin_resource", "One or more origin resources are unavailable");
    }
    const existing = this.objectStore.identity();
    if (existing && (existing.workspaceId !== input.workspaceId || existing.workstreamId !== input.workstreamId)) {
      throw new ApiError(409, "workstream_object_identity_mismatch", "The object identity does not match");
    }
    this.objectStore.ensureIdentity({
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
    }, this.env.AVALON_REGION);
    const existingRoot = first(this.storage.sql.exec<RootRow>(`SELECT * FROM workstream WHERE id = 1`));
    if (existingRoot?.authority_mode === "authoritative") {
      const part = first(this.storage.sql.exec<{ id: string }>(
        `SELECT id FROM canonical_conversation_turn_details WHERE client_message_id = ?`, input.clientMessageId,
      ));
      const run = first(this.storage.sql.exec<{
        run_id: string;
        execution_context_json: string | null;
      }>(
        `SELECT run_id, execution_context_json FROM runs
          WHERE trigger_part_id = ? ORDER BY created_at LIMIT 1`, part?.id ?? "",
      ));
      if (!part || !run || run.execution_context_json === null) {
        throw new ApiError(409, "workstream_create_replay_incomplete", "The work stream is incomplete");
      }
      const workflowInput = WorkstreamWorkflowInputSchema.parse(
        JSON.parse(run.execution_context_json),
      );
      const loopId = substreamLoopId(asWorkstreamId(existingRoot.workstream_key));
      const bindHead = first(this.storage.sql.exec<{ state_revision: number }>(
        `SELECT state_revision FROM bind_loop_heads WHERE loop_id = ?`, loopId,
      ));
      this.loops.ensureLoop({
        loopId,
        bindStateRevision: Number(bindHead?.state_revision ?? 0),
        now: existingRoot.created_at,
      });
      // The authoritative root and first run commit before projection effects
      // are built. A retry repairs an effect-construction failure; unchanged
      // snapshots are suppressed by projection_keys.
      await this.enqueueDirectorySnapshot();
      return {
        workstream: await this.summary(existingRoot, auth.userId),
        turnId: part.id,
        harnessRunId: run.run_id,
        workflowInput,
      };
    }
    // Resolve from the authoritative workspace directory before accepting any
    // visible range. The client sends identity and offsets, not Markdown; the
    // object owns the durable spelling and target.
    // The opening human turn carries an immutable author snapshot. Participant
    // membership is mutable and cannot be the historical display authority.
    const names = await this.messageUsers(candidateMemberIds);
    const mentionPeople = new Map<string, MentionPerson>([...names].map(([userId, user]) => [userId, {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatar_url,
    }]));
    const prepared = prepareMentionMarkdown(input.openingMessage, input.mentions, mentionPeople);
    const mentionedPersonIds = [...new Set(prepared.mentions.flatMap((mention) =>
      mention.type === "person" && mention.userId ? [mention.userId] : []))];
    // Only a mention that survived authoritative visible-range validation can
    // grant mention-derived access. Raw IDs are candidates, not audience.
    const memberIds = [...new Set([
      input.creatorUserId,
      ...input.participantUserIds,
      ...mentionedPersonIds,
    ])];
    // Everybody the creator explicitly invited, minus the creator and anyone
    // who receives the more specific mention notification. One action must not
    // become both "you were added" and "you were mentioned" in Slack.
    const invitedUserIds = input.notifyParticipants
      ? [...new Set(input.participantUserIds)].filter((userId) => (
          userId !== input.creatorUserId && !mentionedPersonIds.includes(userId)
        ))
      : [];
    const actorName = names.get(input.creatorUserId)?.name ?? UNKNOWN_MEMBER_DISPLAY_NAME;
    const now = Date.now();
    const messageId = uuidV7(now);
    const runId = asHarnessRunId(uuidV7(now));
    const model = input.modelOverride
      ? pinnedModelRouting(input.modelOverride).model
      : (await resolveNewWorkstreamModelRouting(this.env, {
          workspaceId: input.workspaceId,
          workstreamId: input.workstreamId,
        })).model;
    const transcriptMessage = await this.transcript.prepareParticipantMessage({
      turnId: messageId,
      actor: "human",
      authorUserId: input.creatorUserId,
      authorSnapshot: {
        displayName: names.get(input.creatorUserId)?.name ?? UNKNOWN_MEMBER_DISPLAY_NAME,
        avatarUrl: names.get(input.creatorUserId)?.avatar_url ?? null,
      },
      clientMessageId: input.clientMessageId,
      messageType: "text",
      text: prepared.text,
      structuredContentJson: input.openingStructuredContent === null
        ? null
        : JSON.stringify(input.openingStructuredContent),
      externalActorJson: null,
      producedByRunId: null,
      messageSequenceNumber: 1,
      createdAtUtc: new Date(now).toISOString(),
      attentionOrdinal: 1,
    });
    const openingWorkflowInput = this.workflowInput(input, runId, messageId);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE workstream SET authority_mode = 'authoritative', authority_generation = ?,
             title = ?, description = ?, scope = ?, exact_state = 'scheduled',
             state_reason_code = ?, next_sequence_number = 2, next_attention_ordinal = 2,
             authority_epoch = 1, scope_epoch = 0, listing_epoch = 1, run_revision = 1,
             created_at = ?, last_people_activity_at = ?, state_changed_at = ?,
             origin_type = ?, created_by_user_id = ?, automation_subscription_id = ?,
             automation_run_id = ?, planned_for = ?, email_address = ?, email_route_status = 'active',
             created_from_opportunity_id = ?, opportunity_version = ?,
             opportunity_display_prompt_hash = ?, opportunity_execution_prompt_hash = ?,
             description_source = ?, system_kind = ?, title_status = ?, model_override = ?, updated_at = ?
         WHERE id = 1 AND authority_mode = 'preparing'`,
        input.generation, input.title, input.objective, input.scope, input.reason, now, now, now,
        input.originType, input.creatorUserId, input.automationSubscriptionId,
        input.automationRunId, input.plannedFor ? Date.parse(input.plannedFor) : null,
        input.emailAddress, input.createdFromOpportunityId, input.opportunityVersion,
        input.opportunityDisplayPromptHash, input.opportunityExecutionPromptHash,
        input.descriptionSource, input.systemKind, input.titleStatus, input.modelOverride, now,
      );
      for (const userId of memberIds) {
        const creator = userId === input.creatorUserId;
        this.storage.sql.exec(
          `INSERT INTO participants
             (user_id, participation_reason, added_by_user_id, status, participant_epoch,
              added_at, removed_at, first_opened_at, updated_at)
           VALUES (?, ?, ?, 'active', 0, ?, NULL, ?, ?)`,
          userId,
          creator ? "creator" : "explicit",
          input.creatorUserId,
          now,
          // The person who typed the opening message is looking at the work
          // stream they just started; everybody they named on the way in is
          // not, and stays unseen until they open it themselves.
          creator ? now : null,
          now,
        );
      }
      this.storage.sql.exec(
        `INSERT INTO member_attention
           (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
            manual_unread_from_ordinal, latest_mention_attention_ordinal,
            last_seen_at, version, updated_at)
         VALUES (?, 0, 1, NULL, 0, ?, 0, ?)`,
        input.creatorUserId, now, now,
      );
      this.transcript.appendPreparedParticipantMessage(transcriptMessage);
      prepared.mentions.forEach((mention, index) => {
        this.storage.sql.exec(
          `INSERT INTO participant_transcript_mentions
             (turn_id, mention_index, mention_kind, target_user_id, connector_type,
              start_offset, end_offset, attention_ordinal)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          messageId, index, mention.type, mention.userId, mention.connectorType,
          mention.startOffset, mention.endOffset,
        );
        if (mention.type === "person" && mention.userId) {
          this.storage.sql.exec(
            `INSERT INTO member_attention
               (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
                manual_unread_from_ordinal, latest_mention_attention_ordinal,
                last_seen_at, version, updated_at)
             VALUES (?, 0, 0, NULL, 1, ?, 0, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               latest_mention_attention_ordinal = MAX(
                 member_attention.latest_mention_attention_ordinal,
                 excluded.latest_mention_attention_ordinal
               ), updated_at = excluded.updated_at`,
            mention.userId, now, now,
          );
        }
      });
      input.attachmentIds.forEach((resourceId, position) => {
        const resource = attachments.find((candidate) => String(candidate.id) === resourceId)!;
        const descriptor = {
          id: resourceId,
          connectionId: resource.connection_id == null ? null : String(resource.connection_id),
          type: String(resource.resource_type),
          provider: String(resource.provider),
          providerResourceId: resource.provider_resource_id == null ? null : String(resource.provider_resource_id),
          title: String(resource.title),
          mimeType: resource.mime_type == null ? null : String(resource.mime_type),
          contentRef: resource.content_ref == null ? null : String(resource.content_ref),
          canonicalUrl: resource.canonical_url == null ? null : String(resource.canonical_url),
          metadata: parseJson(String(resource.metadata_json ?? "{}"), {}),
        };
        this.storage.sql.exec(
          `INSERT INTO participant_transcript_attachments(turn_id, resource_id, position, attachment_json)
           VALUES (?, ?, ?, ?)`,
          messageId, resourceId, position, JSON.stringify({ attachedAt: iso(now) }),
        );
        this.storage.sql.exec(
          `INSERT INTO workstream_resource_links
             (resource_id, attached_by_user_id, watch_enabled, relationship_type,
              resource_json, attached_at, updated_at)
           VALUES (?, ?, 0, 'message_attachment', ?, ?, ?)`,
          resourceId, input.creatorUserId, JSON.stringify(descriptor), now, now,
        );
      });
      for (const resourceId of input.originResourceIds) {
        const resource = originResources.find((candidate) => String(candidate.id) === resourceId)!;
        const descriptor = {
          id: resourceId,
          connectionId: resource.connection_id == null ? null : String(resource.connection_id),
          type: String(resource.resource_type),
          provider: String(resource.provider),
          providerResourceId: resource.provider_resource_id == null ? null : String(resource.provider_resource_id),
          title: String(resource.title),
          mimeType: resource.mime_type == null ? null : String(resource.mime_type),
          contentRef: resource.content_ref == null ? null : String(resource.content_ref),
          canonicalUrl: resource.canonical_url == null ? null : String(resource.canonical_url),
          metadata: parseJson(String(resource.metadata_json ?? "{}"), {}),
        };
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO workstream_resource_links
             (resource_id, attached_by_user_id, watch_enabled, relationship_type,
              resource_json, attached_at, updated_at)
           VALUES (?, ?, 0, 'origin', ?, ?, ?)`,
          resourceId, input.creatorUserId, JSON.stringify(descriptor), now, now,
        );
      }
      this.storage.sql.exec(
        `INSERT INTO runs
           (run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
            model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
            active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
            tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
            terminal_reason, origin, execution_principal_json, chain_depth, model,
            trigger_part_id, execution_context_json, created_at, updated_at)
         VALUES (?, '0', NULL, 'admitted', '{}', 0, 0, '', 1, 0, ?,
                 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, ?, ?, 0, ?, ?, ?, ?, ?)`,
        runId, now, input.reason, JSON.stringify(input.executionPrincipal), model,
        messageId, JSON.stringify(openingWorkflowInput), now, now,
      );
      // Product identity, never an activation receipt, owns the singleton.
      // Every later message, retry, and recovery therefore derives this exact
      // same loop instead of minting a new logical conversation.
      this.loops.ensureLoop({
        loopId: substreamLoopId(input.workstreamId),
        bindStateRevision: 0,
        now,
      });
    });
    await this.objectStore.commitWithRegionalEffects(
      () => undefined,
      () => {
        const root = this.root();
        const occurredAt = new Date(now).toISOString();
        const activity = {
          partitionKey: `activity:${messageId}`,
          sourceVersion: 1,
          dedupeKey: `message:${messageId}`,
          effect: {
            kind: "activity_event" as const,
            eventId: uuidV7(now),
            eventType: "workstream_message_created",
            subjectSequenceNumber: 1,
            actorType: "user" as const,
            actorUserId: input.creatorUserId,
            actorLabel: actorName,
            title: truncateUtf16Safe(root.title, 500),
            body: truncateUtf16Safe(prepared.text, 8_000),
            canonicalUrl: null,
            digestible: true,
            occurredAt,
            sourceKind: "workstream_message",
            sourceId: messageId,
            dedupeKey: `message:${messageId}`,
            metadata: {},
            targets: memberIds.map((userId) => ({ userId, relation: "participant" })),
          },
        };
        const mentionNotifications = mentionedPersonIds
          .filter((userId) => userId !== input.creatorUserId)
          .map((userId) => ({
            partitionKey: `notification:${messageId}:${userId}`,
            sourceVersion: 1,
            dedupeKey: `mention:${messageId}:${userId}`,
            dependsOnProjectionKey: `user:${userId}`,
            effect: {
              kind: "mention_notification" as const,
              intentId: `mention:${messageId}:${userId}`,
              messageId,
              recipientUserId: userId,
              authorUserId: input.creatorUserId,
              authorNameSnapshot: actorName,
              workstreamTitleSnapshot: truncateUtf16Safe(root.title, 500),
              messageText: truncateUtf16Safe(prepared.text, 8_000),
              occurredAt,
            },
          }));
        return [
          { partitionKey: "common", effect: this.commonEffect(root) },
          ...memberIds.map((userId) => ({
            partitionKey: `user:${userId}`,
            effect: this.userEffect(root, userId),
          })),
          // After every viewer effect, which is all the gate below needs:
          // each recipient's own directory row is written earlier in this same
          // array. The epoch is a literal zero rather than a read — these rows
          // were inserted by the transaction above with `participant_epoch = 0`
          // and nothing can have removed them yet.
          ...invitedUserIds.flatMap((userId) => this.participantAddedEffects({
            root,
            userId,
            actorUserId: input.creatorUserId,
            actorName,
            recipientName: names.get(userId)?.name ?? "a workspace member",
            epoch: 0,
            now,
          })),
          ...(mentionedPersonIds.length > 0 ? [activity] : []),
          ...mentionNotifications,
        ];
      },
    );
    return {
      workstream: await this.summary(this.root(), auth.userId),
      turnId: messageId,
      harnessRunId: runId,
      workflowInput: openingWorkflowInput,
    };
  }

  private workflowInput(
    input: InitializeWorkstreamObjectInput,
    runId: HarnessRunId,
    messageId: string,
  ): WorkstreamWorkflowInput {
    return {
      region: this.env.AVALON_REGION,
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      loopId: substreamLoopId(input.workstreamId),
      harnessRunId: runId,
      triggerMessageId: messageId,
      automationSubscriptionId: input.automationSubscriptionId,
      activityId: null,
      executionPrincipal: input.executionPrincipal as WorkstreamWorkflowInput["executionPrincipal"],
      ...(input.slackOrigin ? { slackOrigin: input.slackOrigin as WorkstreamWorkflowInput["slackOrigin"] } : {}),
      ...(input.slackSearchAuthorization ? {
        slackSearchAuthorization: input.slackSearchAuthorization as WorkstreamWorkflowInput["slackSearchAuthorization"],
      } : {}),
      ...(input.telemetryOperationId ? { telemetryOperationId: input.telemetryOperationId } : {}),
      ...(input.telemetrySubjectUserId ? { telemetrySubjectUserId: input.telemetrySubjectUserId } : {}),
      reason: input.reason,
    };
  }

  private isParticipant(userId: string): boolean {
    return first(this.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM participants WHERE user_id = ? AND status = 'active' LIMIT 1`,
      userId,
    )) !== null;
  }

  /** Freeze the participant epoch observed when a pending human input is admitted. */
  private pendingParticipantEpochs(userIds: readonly string[]): Record<string, number | null> {
    return Object.fromEntries([...new Set(userIds)].map((userId) => {
      const row = first(this.storage.sql.exec<{ participant_epoch: number }>(
        `SELECT participant_epoch FROM participants WHERE user_id = ?`,
        userId,
      ));
      return [userId, row?.participant_epoch ?? null];
    }));
  }

  /**
   * Whether this person has been put in the work stream and never opened it.
   *
   * Asked of the membership row rather than of `member_attention`, because the
   * attention row is written by being read to and by being mentioned — it does
   * not exist for somebody who has only been added, and its absence cannot be
   * told apart from the absence of any relationship at all. Somebody reading a
   * workspace-scoped work stream they are not in is not unseen: nobody put
   * them there, so there is nothing for them to have missed.
   */
  private isUnseen(userId: string): boolean {
    return first(this.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM participants
        WHERE user_id = ? AND status = 'active' AND first_opened_at IS NULL LIMIT 1`,
      userId,
    )) !== null;
  }

  /**
   * Settles the unseen state the first time somebody opens the work stream.
   *
   * On the open path rather than on `acknowledgeRead`, which the client sends
   * only when a message it has not accounted for is on screen: a work stream
   * somebody is added to and opens while nothing new has arrived would never
   * produce one, and its dot would stay lit for a room they are looking at.
   *
   * Writes at most once per participant, and only through the effect commit,
   * so the sidebar the dot is on hears about it the same way it heard about
   * every other viewer change.
   *
   * **Never allowed to fail the open.** This is bookkeeping about a dot running
   * inside what every caller treats as a read, so a marker that stays lit until
   * the next open is the better failure. It must not turn an otherwise valid
   * socket snapshot or REST recovery boot into an unavailable work stream.
   *
   * Not a guard against the authority fence, which was the first suspicion:
   * `commitWithRegionalEffects` refuses a non-authoritative object, but the
   * product route ahead of this refuses one too, with `workstream_maintenance`
   * and a 503 — on either half of the fence, mode or generation — so a request
   * that reaches here has already proved it can commit. What is left is
   * everything else a commit can fail on, none of which is worth a work stream
   * that will not open.
   */
  private async markOpened(userId: string): Promise<void> {
    if (!this.isUnseen(userId)) return;
    const now = Date.now();
    try {
      await this.objectStore.commitWithRegionalEffects(
        (sql) => sql.exec(
          `UPDATE participants SET first_opened_at = ?, updated_at = ?
            WHERE user_id = ? AND status = 'active' AND first_opened_at IS NULL`,
          now, now, userId,
        ),
        () => [{ partitionKey: `user:${userId}`, effect: this.userEffect(this.root(), userId) }],
      );
    } catch (error) {
      logWarn(this.env, "workstream_mark_opened_failed", {
        workstreamId: this.root().workstream_key,
        userId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  canRead(userId: string): boolean {
    const root = this.root();
    return participantVisible(root, this.isParticipant(userId));
  }

  activeParticipantIds(): string[] {
    return this.storage.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM participants WHERE status = 'active' ORDER BY user_id`,
    ).toArray().map((row) => row.user_id);
  }

  /** Active participants, newest join first, for the sidebar facepile preview. */
  private recentParticipantUserIds(): string[] {
    return this.storage.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM participants WHERE status = 'active' ORDER BY added_at DESC, user_id`,
    ).toArray().map((row) => row.user_id);
  }

  private locallyAuthorizedRoot(auth: AuthContext, includeArchived = false): RootRow {
    const root = this.root();
    if (root.parent_workspace_key !== auth.workspaceId || root.workstream_key === "") {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
    if (!participantVisible(root, this.isParticipant(auth.userId))) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
    if (!includeArchived && root.archived_at !== null) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
    return root;
  }

  async authorize(auth: AuthContext, includeArchived = false): Promise<RootRow> {
    const root = this.locallyAuthorizedRoot(auth, includeArchived);
    const membership = await this.env.DB.prepare(
      `SELECT 1 AS one FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
    ).bind(auth.workspaceId, auth.userId).first<{ one: number }>();
    if (!membership) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
    return root;
  }

  private attention(userId: string, root: RootRow): AttentionRow {
    return first(this.storage.sql.exec<AttentionRow>(
      `SELECT unread_tracking_start_ordinal, seen_attention_ordinal,
              manual_unread_from_ordinal, latest_mention_attention_ordinal, version
         FROM member_attention WHERE user_id = ?`,
      userId,
    )) ?? {
      unread_tracking_start_ordinal: root.unread_tracking_start_ordinal,
      seen_attention_ordinal: root.unread_tracking_start_ordinal,
      manual_unread_from_ordinal: null,
      latest_mention_attention_ordinal: 0,
      version: 0,
    };
  }

  private async summary(root: RootRow, userId: string): Promise<Workstream> {
    const attention = this.attention(userId, root);
    const latest = Math.max(0, root.next_attention_ordinal - 1);
    const firstUnread = attention.manual_unread_from_ordinal
      ?? (latest > attention.seen_attention_ordinal
        ? Math.min(latest, attention.seen_attention_ordinal + 1)
        : null);
    const workspaceDatabase = this.workspaceDatabase(root.parent_workspace_key);
    const pin = await workspaceDatabase.prepare(
      `SELECT position FROM workspace_workstream_pins WHERE workstream_id = ? AND user_id = ?`,
    ).bind(root.workstream_key, userId).first<{ position: number }>();
    // The automation's title is a typed question to the object that holds the
    // directory, not SQL through the runtime facade. The facade routes by table
    // name and sends anything unlisted to the regional database, which is how
    // this read came to answer `no such table: automation_directory`. A work
    // stream with no automation asks nothing.
    const originLabel = root.automation_subscription_id === null ? null : WorkspaceAutomationOriginLabelSchema
      .parse(await (await this.workspaceDirectory(root.parent_workspace_key)).automationOriginLabel({
        workspaceId: root.parent_workspace_key,
        automationId: root.automation_subscription_id,
      })).title;
    const wakeup = first(this.storage.sql.exec<{ due_at: number; prompt: string }>(
      `SELECT due_at, prompt FROM workstream_wakeups
        WHERE status = 'pending' ORDER BY due_at, wakeup_id LIMIT 1`,
    ));
    const titleStatus = root.title_status === "naming"
      && Date.now() - root.created_at > WORKSTREAM_NAMING_GRACE_MS
      ? "automatic"
      : root.title_status;
    return WorkstreamSchema.parse({
      id: root.workstream_key,
      workspaceId: root.parent_workspace_key,
      title: truncateUtf16Safe(root.title, 180),
      titleStatus,
      objective: truncateUtf16Safe(root.description, WORKSTREAM_DESCRIPTION_MAX_CHARACTERS),
      emailAddress: root.email_address,
      originType: root.origin_type,
      originLabel: originLabel ? truncateUtf16Safe(originLabel, 120) : null,
      createdByUserId: root.created_by_user_id,
      automationSubscriptionId: root.automation_subscription_id,
      automationRunId: root.automation_run_id,
      plannedFor: iso(root.planned_for),
      harnessStatus: harnessStatus(root.exact_state),
      latestAttentionSequenceNumber: latest,
      readThroughSequenceNumber: attention.seen_attention_ordinal,
      manualUnreadFromSequenceNumber: attention.manual_unread_from_ordinal,
      manualUnreadGeneration: attention.version,
      hasUnread: firstUnread !== null,
      youAreMentioned: attention.latest_mention_attention_ordinal > attention.seen_attention_ordinal,
      unseen: this.isUnseen(userId),
      firstUnreadSequenceNumber: firstUnread,
      lastActivityAt: iso(root.last_people_activity_at),
      createdAt: iso(root.created_at),
      updatedAt: iso(root.updated_at),
      archivedAt: iso(root.archived_at),
      scope: root.scope,
      systemKind: root.system_kind,
      nextPendingWakeup: wakeup ? {
        dueAt: iso(wakeup.due_at),
        promptPreview: truncateUtf16Safe(wakeup.prompt.replace(/\s+/gu, " ").trim(), 40),
      } : null,
      pinPosition: pin?.position ?? null,
      ...(root.scope === "personal"
        ? workstreamParticipantPreview(this.recentParticipantUserIds())
        : { participantUserIds: [], participantExtraCount: 0 }),
    });
  }


  async update(
    auth: AuthContext,
    rawInput: WorkstreamObjectUpdateInput,
  ): Promise<{ workstream: Workstream; events: Record<string, unknown>[] }> {
    const input = UpdateWorkstreamRequestSchema.parse(rawInput);
    if (Object.keys(input).length === 0) {
      throw new ApiError(422, "empty_update", "No work-stream fields were provided");
    }
    const before = await this.authorize(auth, true);
    if (
      input.scope !== undefined
      && input.scope !== before.scope
      && (before.system_kind !== null || before.automation_subscription_id !== null)
    ) {
      throw new ApiError(
        422,
        "scope_change_unsupported",
        before.system_kind !== null
          ? "This work stream belongs to Avalon itself, so its visibility cannot be changed"
          : "Automation execution work streams are private and their visibility cannot be changed",
      );
    }
    const now = Date.now();
    const scopeChanged = input.scope !== undefined && input.scope !== before.scope;
    if (scopeChanged && input.scope === "workspace") {
      this.assertAcceptedContentContains({ scope: "workspace" });
    }
    const joined = scopeChanged && input.scope === "personal" && !this.isParticipant(auth.userId);
    await this.objectStore.commitWithRegionalEffects(
      (sql) => {
        if (input.scope === "personal") {
          sql.exec(
            `INSERT INTO participants
               (user_id, participation_reason, added_by_user_id, status, participant_epoch,
                added_at, removed_at, first_opened_at, updated_at)
             VALUES (?, 'explicit', ?, 'active', 0, ?, NULL, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               status = 'active', removed_at = NULL,
               participant_epoch = CASE WHEN participants.status = 'removed'
                 THEN participants.participant_epoch + 1 ELSE participants.participant_epoch END,
               first_opened_at = COALESCE(participants.first_opened_at, excluded.first_opened_at),
               updated_at = excluded.updated_at`,
            // Joining by narrowing the work stream to yourself is done from
            // inside it, so this is not a room anybody has yet to look at.
            auth.userId, auth.userId, now, now, now,
          );
        }
        sql.exec(
          `UPDATE workstream SET
             title = COALESCE(?, title),
             description = COALESCE(?, description),
             description_source = CASE
               WHEN ? IS NULL OR ? = description THEN description_source ELSE 'authored' END,
             scope = COALESCE(?, scope),
             title_status = CASE WHEN ? IS NULL THEN title_status ELSE 'settled' END,
             archived_at = CASE WHEN ? IS NULL THEN archived_at WHEN ? = 1 THEN ? ELSE NULL END,
             exact_state = CASE WHEN ? = 1 THEN 'archived'
                                WHEN ? = 0 AND exact_state = 'archived' THEN 'idle'
                                ELSE exact_state END,
             listing_epoch = listing_epoch + CASE
               WHEN ? IS NOT NULL OR ? IS NOT NULL THEN 1 ELSE 0 END,
             scope_epoch = scope_epoch + CASE WHEN ? IS NULL OR ? = scope THEN 0 ELSE 1 END,
             updated_at = ?
           WHERE id = 1`,
          input.title ?? null,
          input.objective ?? null,
          input.objective ?? null,
          input.objective ?? null,
          input.scope ?? null,
          input.title ?? null,
          input.archived == null ? null : Number(input.archived),
          Number(input.archived ?? false),
          now,
          input.archived == null ? null : Number(input.archived),
          input.archived == null ? null : Number(input.archived),
          input.archived == null ? null : Number(input.archived),
          input.scope ?? null,
          input.scope ?? null,
          input.scope ?? null,
          now,
        );
      },
      () => {
        const root = this.root();
        return [
          { partitionKey: "common", effect: this.commonEffect(root) },
          { partitionKey: `user:${auth.userId}`, effect: this.userEffect(root, auth.userId) },
        ];
      },
    );
    const root = this.root();
    const events: Record<string, unknown>[] = [];
    if (input.title !== undefined) {
      events.push({ type: "workstream_renamed", title: root.title, titleStatus: "settled" });
    }
    if (joined) {
      const participant = (await this.participants()).find((entry) => entry.user.id === auth.userId);
      if (participant) events.push({ type: "participant_added", participant });
    }
    if (scopeChanged) events.push({ type: "workstream_scope_changed", scope: root.scope });
    return { workstream: await this.summary(root, auth.userId), events };
  }

  async acknowledgeRead(
    auth: AuthContext,
    rawInput: WorkstreamObjectAcknowledgeReadInput,
  ): Promise<Workstream> {
    const input = AcknowledgeWorkstreamReadRequestSchema.parse(rawInput);
    const root = await this.authorize(auth);
    const latest = Math.max(0, root.next_attention_ordinal - 1);
    if (input.readThroughSequenceNumber > latest) {
      throw new ApiError(
        422,
        "invalid_read_sequence",
        "The read cursor is ahead of the latest message requiring attention",
      );
    }
    const now = Date.now();
    await this.objectStore.commitWithRegionalEffects(
      (sql) => sql.exec(
        `INSERT INTO member_attention
           (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
            manual_unread_from_ordinal, latest_mention_attention_ordinal,
            last_seen_at, version, updated_at)
         VALUES (?, ?, ?, NULL, 0, ?, 0, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           seen_attention_ordinal = MAX(member_attention.seen_attention_ordinal,
                                        excluded.seen_attention_ordinal),
           manual_unread_from_ordinal = CASE
             WHEN member_attention.version = ?
              AND excluded.seen_attention_ordinal >= COALESCE(
                member_attention.manual_unread_from_ordinal,
                excluded.seen_attention_ordinal)
             THEN NULL ELSE member_attention.manual_unread_from_ordinal END,
           last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
        auth.userId,
        root.unread_tracking_start_ordinal,
        input.readThroughSequenceNumber,
        now,
        now,
        input.observedManualUnreadGeneration,
      ),
      () => [{ partitionKey: `user:${auth.userId}`, effect: this.userEffect(this.root(), auth.userId) }],
    );
    return this.summary(this.root(), auth.userId);
  }

  async markUnread(auth: AuthContext): Promise<Workstream> {
    const root = await this.authorize(auth);
    const latest = Math.max(0, root.next_attention_ordinal - 1);
    if (latest === 0) return this.summary(root, auth.userId);
    const now = Date.now();
    const attention = this.attention(auth.userId, root);
    await this.objectStore.commitWithRegionalEffects(
      (sql) => sql.exec(
        `INSERT INTO member_attention
           (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
            manual_unread_from_ordinal, latest_mention_attention_ordinal,
            last_seen_at, version, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, 1, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           manual_unread_from_ordinal = excluded.manual_unread_from_ordinal,
           version = member_attention.version + 1, updated_at = excluded.updated_at`,
        auth.userId,
        root.unread_tracking_start_ordinal,
        attention.seen_attention_ordinal,
        latest,
        now,
        now,
      ),
      () => [{ partitionKey: `user:${auth.userId}`, effect: this.userEffect(this.root(), auth.userId) }],
    );
    return this.summary(this.root(), auth.userId);
  }

  /**
   * Apply one event from the generic regional batch-update queue.
   *
   * The receipt shares the transaction with the product rows and the regional
   * outbox, so Queue redelivery cannot repeat the mutation or publish another
   * projection waterline. A mass read settles the state that exists when the
   * event reaches this authority without first loading a per-work-stream cursor.
   */
  async applyQueuedBatchUpdate(
    auth: AuthContext,
    input: {
      operationId: string;
      requestHash: string;
      update: WorkstreamBatchUpdate;
    },
  ): Promise<"applied" | "replayed"> {
    const update = WorkstreamBatchUpdateSchema.parse(input.update);
    const before = await this.authorize(auth, update.kind === "archive");
    const now = Date.now();
    const committed = await this.objectStore.commitWithRegionalEffects(
      (sql) => {
        const receipt = first(sql.exec<{ request_hash: string }>(
          `SELECT request_hash FROM durable_inbox_receipts
            WHERE channel = 'workstream_batch_update'
              AND source_kind = 'regional_service'
              AND source_id = 'regional_worker'
              AND source_generation = 1 AND message_id = ?`,
          input.operationId,
        ));
        if (receipt) {
          if (receipt.request_hash !== input.requestHash) {
            throw new Error("workstream_batch_update_idempotency_conflict");
          }
          return "replayed" as const;
        }

        if (update.kind === "mark_read") {
          const latest = Math.max(0, before.next_attention_ordinal - 1);
          sql.exec(
            `UPDATE participants SET first_opened_at = ?, updated_at = ?
              WHERE user_id = ? AND status = 'active' AND first_opened_at IS NULL`,
            now,
            now,
            auth.userId,
          );
          sql.exec(
            `INSERT INTO member_attention
               (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
                manual_unread_from_ordinal, latest_mention_attention_ordinal,
                last_seen_at, version, updated_at)
             VALUES (?, ?, ?, NULL, 0, ?, 0, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               seen_attention_ordinal = MAX(member_attention.seen_attention_ordinal,
                                            excluded.seen_attention_ordinal),
               manual_unread_from_ordinal = NULL,
               version = member_attention.version + 1,
               last_seen_at = excluded.last_seen_at,
               updated_at = excluded.updated_at`,
            auth.userId,
            before.unread_tracking_start_ordinal,
            latest,
            now,
            now,
          );
        } else if (before.archived_at === null) {
          sql.exec(
            `UPDATE substream_loops
                SET stop_requested_at = ?, stop_after_step_ordinal = step_ordinal,
                    stop_reason = 'workstream_archived', revision = revision + 1,
                    updated_at = ?
              WHERE id = 1 AND status = 'executing' AND stop_requested_at IS NULL`,
            now,
            now,
          );
          sql.exec(
            `UPDATE workstream SET archived_at = ?, exact_state = 'archived',
                    listing_epoch = listing_epoch + 1, updated_at = ?
              WHERE id = 1`,
            now,
            now,
          );
        }

        sql.exec(
          `INSERT INTO durable_inbox_receipts
             (channel, source_kind, source_id, source_generation, message_id,
              partition_key, source_version, source_epoch, request_hash,
              result_code, result_hash, received_at)
           VALUES ('workstream_batch_update', 'regional_service', 'regional_worker', 1, ?,
                   ?, 1, 0, ?, 'applied', ?, ?)`,
          input.operationId,
          update.kind,
          input.requestHash,
          input.requestHash,
          now,
        );
        return "applied" as const;
      },
      (_sql, outcome) => {
        if (outcome === "replayed") return [];
        const root = this.root();
        return update.kind === "mark_read"
          ? [{ partitionKey: `user:${auth.userId}`, effect: this.userEffect(root, auth.userId) }]
          : [
              { partitionKey: "common", effect: this.commonEffect(root) },
              { partitionKey: `user:${auth.userId}`, effect: this.userEffect(root, auth.userId) },
            ];
      },
    );
    return committed.result;
  }

  /** Detail for the canonical transcript snapshot assembled by SubstreamAgent. */
  async boot(auth: AuthContext, viewers: WorkstreamDetail["viewers"] = []): Promise<{
    workstream: WorkstreamDetail;
  }> {
    return { workstream: await this.get(auth, viewers) };
  }

  async get(auth: AuthContext, viewers: WorkstreamDetail["viewers"] = []): Promise<WorkstreamDetail> {
    const root = await this.authorize(auth);
    // Both ways of opening a work stream — the socket's snapshot and
    // `GET /workstreams/:id` — assemble their answer here, so this is where
    // "they have now seen it" is true. Ordered before the read below so the
    // detail this call returns already says so, rather than telling the
    // client it is unseen and correcting itself over the socket a beat later.
    await this.markOpened(auth.userId);
    const [workstream, participants, resources, connections] = await Promise.all([
      this.summary(root, auth.userId),
      this.participants(),
      this.resources(auth.userId),
      this.connections(auth.userId),
    ]);
    const elicitations = this.elicitations();
    const suggestions = this.suggestions();
    const latestRun = first(this.storage.sql.exec<{
      run_id: string; origin: string; status: string; model: string | null;
      error_json: string | null; started_at: number; completed_at: number | null; created_at: number;
    }>(
      `SELECT run_id, origin, status, model, error_json, started_at, completed_at, created_at
         FROM runs WHERE parent_tool_call_id IS NULL AND origin != 'block_dashboard_block'
        ORDER BY created_at DESC, run_id DESC LIMIT 1`,
    ));
    return WorkstreamDetailSchema.parse({
      ...workstream,
      stopRequested: this.loops.loop()?.stop_requested_at != null,
      participants,
      viewers,
      resources,
      connections,
      backgroundTasks: this.backgroundTasks(),
      openElicitations: elicitations,
      suggestions,
      latestHarnessRunId: latestRun?.run_id ?? null,
      latestHarnessRun: latestRun ? {
        id: latestRun.run_id,
        origin: latestRun.origin,
        status: latestRun.status === "admitted" ? "scheduled"
          : latestRun.status === "cancelled" ? "stopped" : latestRun.status,
        model: latestRun.model,
        error: memberSafeHarnessError(latestRun.error_json),
        requestId: latestRun.run_id,
        startedAt: iso(latestRun.started_at),
        completedAt: iso(latestRun.completed_at),
        createdAt: iso(latestRun.created_at),
      } : null,
    });
  }

  async messages(
    auth: AuthContext,
    limit: number,
    before?: number,
    after?: number,
    around?: number,
  ): Promise<{ items: Message[]; nextCursor: string | null; newerCursor: string | null }> {
    await this.authorize(auth);
    return this.messagesAfterAdmission(auth, limit, before, after, around);
  }

  private async messagesAfterAdmission(
    auth: AuthContext,
    limit: number,
    before?: number,
    after?: number,
    around?: number,
  ): Promise<{ items: Message[]; nextCursor: string | null; newerCursor: string | null }> {
    if (around !== undefined) {
      const olderLimit = Math.max(1, Math.min(50, Math.floor(limit / 4)));
      const newerLimit = Math.max(1, limit - olderLimit);
      const older = await this.messageRows(auth, olderLimit + 1, "before", around + 1);
      const newer = await this.messageRows(auth, newerLimit + 1, "after", around);
      const hasOlder = older.length > olderLimit;
      const hasNewer = newer.length > newerLimit;
      if (hasOlder) older.shift();
      if (hasNewer) newer.pop();
      const items = [...older, ...newer];
      return {
        items,
        nextCursor: hasOlder ? String(items[0]?.sequenceNumber ?? "") : null,
        newerCursor: hasNewer ? String(items.at(-1)?.sequenceNumber ?? "") : null,
      };
    }
    const direction = after === undefined ? "before" : "after";
    const items = await this.messageRows(auth, limit + 1, direction, after ?? before);
    const hasMore = items.length > limit;
    if (hasMore) {
      if (direction === "before") items.shift();
      else items.pop();
    }
    return {
      items,
      nextCursor: direction === "before" && hasMore ? String(items[0]?.sequenceNumber ?? "") : null,
      newerCursor: direction === "after" && hasMore ? String(items.at(-1)?.sequenceNumber ?? "") : null,
    };
  }

  /** Exact internal read used by terminal side effects after a turn is saved. */
  async messageForRuntime(turnId: string): Promise<Message | null> {
    const row = this.storage.sql.exec<PartRow>(
      `SELECT id, sequence_number, attention_ordinal, author_type, author_user_id, external_actor_json,
              message_type, content, structured_content_json, client_message_id,
              edited_at, created_at
         FROM canonical_conversation_turn_details
        WHERE substream_id = '0' AND visibility IN ('people', 'both') AND id = ?
        LIMIT 1`,
      turnId,
    ).toArray()[0];
    return row ? this.hydrateMessageRow(this.runtimeAuth(), row) : null;
  }

  /** The oldest blocking question, read through the canonical turn it created. */
  async openElicitationMessageForRuntime(): Promise<Message | null> {
    const row = this.storage.sql.exec<PartRow>(
      `SELECT turn.id, turn.sequence_number, turn.attention_ordinal, turn.author_type,
              turn.author_user_id, turn.external_actor_json, turn.message_type, turn.content,
              turn.structured_content_json, turn.client_message_id, turn.edited_at, turn.created_at
         FROM elicitation_requests request
         JOIN canonical_conversation_turn_details turn
           ON turn.client_message_id = 'elicitation:' || request.elicitation_id
        WHERE request.status = 'pending' AND turn.substream_id = '0'
          AND turn.visibility IN ('people', 'both')
        ORDER BY request.created_at, request.elicitation_id
        LIMIT 1`,
    ).toArray()[0];
    return row ? this.hydrateMessageRow(this.runtimeAuth(), row) : null;
  }

  private runtimeAuth(): AuthContext {
    const root = this.root();
    return {
      sessionId: "substream-agent-runtime",
      userId: asUserId(root.created_by_user_id ?? root.workstream_key),
      workspaceId: asWorkspaceId(root.parent_workspace_key),
      region: this.env.AVALON_REGION,
      role: "owner",
    };
  }

  runtimeStatus(): Workstream["harnessStatus"] {
    return harnessStatus(this.root().exact_state);
  }

  private async messageRows(
    auth: AuthContext,
    limit: number,
    direction: "before" | "after",
    cursor?: number,
  ): Promise<Message[]> {
    const comparator = direction === "before" ? "<" : ">";
    const order = direction === "before" ? "DESC" : "ASC";
    const rows = this.storage.sql.exec<PartRow>(
      `SELECT id, sequence_number, attention_ordinal, author_type, author_user_id, external_actor_json,
              message_type, content, structured_content_json, client_message_id,
              edited_at, created_at
         FROM canonical_conversation_turn_details
        WHERE substream_id = '0' AND visibility IN ('people', 'both')
          ${cursor === undefined ? "" : `AND sequence_number ${comparator} ?`}
        ORDER BY sequence_number ${order} LIMIT ?`,
      ...(cursor === undefined ? [limit] : [cursor, limit]),
    ).toArray();
    const ordered = direction === "before" ? rows.reverse() : rows;
    return this.hydrateMessageRows(auth, ordered);
  }

  private async hydrateMessageRows(auth: AuthContext, ordered: readonly PartRow[]): Promise<Message[]> {
    if (ordered.length === 0) return [];
    const partIds = ordered.map((row) => row.id);
    const mentionRows = chunks(partIds).flatMap((ids) => this.storage.sql.exec<PartMentionRow>(
      `SELECT turn_id AS part_id, mention_kind, target_user_id, connector_type, start_offset, end_offset
         FROM participant_transcript_mentions WHERE turn_id IN (${ids.map(() => "?").join(",")})
        ORDER BY turn_id, mention_index`,
      ...ids,
    ).toArray());
    const attachmentRows = chunks(partIds).flatMap((ids) => this.storage.sql.exec<PartAttachmentRow>(
      `SELECT turn_id AS part_id, resource_id, attachment_json
         FROM participant_transcript_attachments WHERE turn_id IN (${ids.map(() => "?").join(",")})
        ORDER BY turn_id, position`,
      ...ids,
    ).toArray());
    const authorIds = [...new Set(ordered.flatMap((row) => row.author_user_id ? [row.author_user_id] : []))];
    const resourceIds = [...new Set(attachmentRows.map((row) => row.resource_id))];
    const [users, resources] = await Promise.all([
      this.messageUsers(authorIds),
      this.messageResources(resourceIds),
    ]);
    const mentionsByPart = new Map<string, PartMentionRow[]>();
    for (const mention of mentionRows) {
      const grouped = mentionsByPart.get(mention.part_id) ?? [];
      grouped.push(mention);
      mentionsByPart.set(mention.part_id, grouped);
    }
    const attachmentsByPart = new Map<string, PartAttachmentRow[]>();
    for (const attachment of attachmentRows) {
      const grouped = attachmentsByPart.get(attachment.part_id) ?? [];
      grouped.push(attachment);
      attachmentsByPart.set(attachment.part_id, grouped);
    }
    const workstreamId = this.root().workstream_key;
    return ordered.map((row) => this.messageFromRow(
      auth,
      workstreamId,
      row,
      users,
      mentionsByPart.get(row.id) ?? [],
      attachmentsByPart.get(row.id) ?? [],
      resources,
    ));
  }

  private async hydrateMessageRow(auth: AuthContext, row: PartRow): Promise<Message> {
    const message = (await this.hydrateMessageRows(auth, [row]))[0];
    if (!message) throw new Error("workstream_message_hydration_failed");
    return message;
  }

  private messageFromRow(
    auth: AuthContext,
    workstreamId: string,
    row: PartRow,
    users: ReadonlyMap<string, UserRow>,
    mentionRows: readonly PartMentionRow[],
    attachmentRows: readonly PartAttachmentRow[],
    resources: ReadonlyMap<string, Record<string, unknown>>,
  ): Message {
    const user = row.author_user_id ? users.get(row.author_user_id) ?? null : null;
    const mentions = mentionRows.map((mention) => ({
      type: mention.mention_kind,
      userId: mention.target_user_id,
      connectorType: mention.connector_type,
      startOffset: mention.start_offset,
      endOffset: mention.end_offset,
    }));
    const attachments = this.messageAttachments(attachmentRows, resources);
    const external = parseJson<Record<string, unknown> | null>(row.external_actor_json, null);
    const author = external
      ? { type: "external" as const, actor: external }
      : row.author_type === "member" && user
        ? { type: "human" as const, user: userFromRow(user) }
        : row.author_type === "agent"
          ? { type: "agent" as const }
          : { type: "system" as const };
    return MessageSchema.parse({
      id: row.id,
      clientMessageId: row.client_message_id,
      workspaceId: auth.workspaceId,
      workstreamId,
      author,
      messageType: row.message_type,
      textContent: row.content ?? "",
      structuredContent: parseJson(row.structured_content_json, null),
      mentions,
      attachments,
      sequenceNumber: row.sequence_number,
      attentionSequenceNumber: row.attention_ordinal,
      createdAt: iso(row.created_at),
      editedAt: iso(row.edited_at),
    });
  }

  private messageAttachments(
    links: readonly PartAttachmentRow[],
    resources: ReadonlyMap<string, Record<string, unknown>>,
  ): Message["attachments"] {
    return links.flatMap((link) => {
      const resource = resources.get(link.resource_id);
      if (!resource) return [];
      const metadata = parseJson<{ attachedAt?: string }>(link.attachment_json, {});
      return [{
        id: link.resource_id,
        fileName: truncateUtf16Safe(String(resource.title), 300),
        mimeType: truncateUtf16Safe(String(resource.mime_type ?? "application/octet-stream"), 160),
        sizeBytes: Math.max(0, Number(
          parseJson<{ size?: number }>(String(resource.metadata_json ?? "{}"), {}).size ?? 0,
        )),
        contentAvailable: resource.content_ref != null,
        createdAt: metadata.attachedAt ?? String(resource.created_at),
      }];
    });
  }

  private async messageUsers(ids: readonly string[]): Promise<Map<string, UserRow>> {
    if (ids.length === 0) return new Map();
    const results = await this.env.DB.batch<UserRow>(chunks(ids).map((chunk) => this.env.DB.prepare(
      `SELECT id, email, name, avatar_url, timezone, created_at
         FROM users WHERE id IN (${chunk.map(() => "?").join(",")})`,
    ).bind(...chunk)));
    return new Map(results.flatMap((result) => result.results ?? []).map((user) => [user.id, user]));
  }

  private async messageResources(ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    if (ids.length === 0) return new Map();
    const workspaceId = this.root().parent_workspace_key;
    // One typed request; the workspace object chunks the id list under the
    // engine's bound-parameter ceiling itself.
    const descriptors = await (await this.workspaceDirectory(workspaceId)).resourceDescriptors({
      workspaceId,
      resourceIds: [...new Set(ids)],
      draftUploadedByUserId: null,
    });
    return new Map(descriptors.items.map((resource) => [resource.id, resource]));
  }

  private async participants(): Promise<WorkstreamDetail["participants"]> {
    const rows = this.storage.sql.exec<{
      user_id: string;
      participation_reason: WorkstreamDetail["participants"][number]["participationReason"];
      added_at: number;
    }>(
      `SELECT user_id, participation_reason, added_at FROM participants
        WHERE status = 'active' ORDER BY added_at, user_id`,
    ).toArray();
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(",");
    const users = await this.env.DB.prepare(
      `SELECT id, email, name, avatar_url, timezone, created_at FROM users
        WHERE id IN (${placeholders})`,
    ).bind(...rows.map((row) => row.user_id)).all<UserRow>();
    const byId = new Map((users.results ?? []).map((user) => [user.id, user]));
    return rows.flatMap((row) => {
      const user = byId.get(row.user_id);
      return user ? [{
        user: userFromRow(user),
        participationReason: row.participation_reason,
        joinedAt: iso(row.added_at)!,
      }] : [];
    });
  }

  private async resources(viewerUserId: string): Promise<WorkstreamDetail["resources"]> {
    const links = this.storage.sql.exec<{
      resource_id: string;
      watch_enabled: number;
      relationship_type: string;
      resource_json: string;
    }>(
      `SELECT resource_id, watch_enabled, relationship_type, resource_json
         FROM workstream_resource_links ORDER BY attached_at DESC`,
    ).toArray();
    if (links.length === 0) return [];
    const placeholders = links.map(() => "?").join(",");
    const rows = await this.workspaceDatabase(this.root().parent_workspace_key).prepare(
      `SELECT resource.*,
              connection.connector_type AS connector_type,
              CASE WHEN watch.id IS NULL THEN 0 ELSE 1 END AS active_watch
         FROM resources resource
         LEFT JOIN connector_connections connection ON connection.id = resource.connection_id
         LEFT JOIN resource_watches watch
           ON watch.resource_id = resource.id AND watch.enabled = 1
        WHERE resource.workspace_id = ? AND resource.id IN (${placeholders})
          AND (resource.provider != 'avalon_note' OR EXISTS (
            SELECT 1 FROM notes note
             WHERE note.resource_id = resource.id AND note.archived_at IS NULL
               AND (note.scope = 'workspace' OR note.owner_user_id = ?)
          ))`,
    ).bind(
      this.root().parent_workspace_key,
      ...links.map((link) => link.resource_id),
      viewerUserId,
    ).all<Record<string, unknown>>();
    const byId = new Map((rows.results ?? []).map((row) => [String(row.id), row]));
    let connectorRegistry: ReturnType<typeof connectorRegistryForEnv> | undefined;
    return links.flatMap((link) => {
      const row = byId.get(link.resource_id);
      if (!row) return [];
      const relationshipType = ResourceRelationshipTypeSchema.parse(link.relationship_type);
      const metadata = parseJson<Record<string, unknown>>(String(row.metadata_json ?? "{}"), {});
      return [{
        id: String(row.id),
        slug: row.slug == null ? null : String(row.slug),
        workspaceId: String(row.workspace_id),
        connectionId: row.connection_id == null ? null : String(row.connection_id),
        resourceType: String(row.resource_type),
        provider: String(row.provider),
        providerResourceId: row.provider_resource_id == null ? null : String(row.provider_resource_id),
        title: truncateUtf16Safe(String(row.title), 300),
        mimeType: row.mime_type == null ? null : truncateUtf16Safe(String(row.mime_type), 160),
        canonicalUrl: row.canonical_url == null ? null : String(row.canonical_url),
        refreshSupported: row.connector_type == null
          ? false
          : connectorSupportsResourceHydration(
              connectorRegistry ??= connectorRegistryForEnv(this.env),
              row.connector_type,
            ),
        watchEnabled: link.watch_enabled === 1,
        watchStatus: row.connection_id == null ? "unsupported"
          : Number(row.active_watch) === 1 ? "watching" : "paused",
        lastHydratedAt: row.last_hydrated_at == null ? null : String(row.last_hydrated_at),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        contentAvailable: row.content_ref != null,
        sizeBytes: Math.max(0, Number(metadata.size ?? 0)),
        currentVersion: Math.max(1, Number(row.current_version ?? 1)),
        relationshipType,
        direction: resourceDirectionForRelationship(relationshipType),
      }];
    });
  }

  private async connections(viewerUserId: string): Promise<WorkstreamDetail["connections"]> {
    const workspaceId = this.root().parent_workspace_key;
    const result = await this.workspaceDatabase(workspaceId).prepare(
      `SELECT connection.*
         FROM connector_connections connection
        WHERE connection.workspace_id = ?
          AND (connection.scope = 'workspace' OR connection.owner_user_id = ?)
        ORDER BY connection.display_name`,
    ).bind(workspaceId, viewerUserId).all<Record<string, unknown>>();
    const ownerIds = [...new Set(result.results.flatMap((row) =>
      typeof row.owner_user_id === "string" ? [row.owner_user_id] : []))];
    const owners = ownerIds.length === 0 ? [] : (await workspaceRegionalDatabase(this.env).prepare(
      `SELECT id, name FROM users WHERE id IN (${ownerIds.map(() => "?").join(",")})`,
    ).bind(...ownerIds).all<{ id: string; name: string }>()).results;
    const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]));
    return (result.results ?? []).map((row) => connectionFromRow({
      ...row,
      owner_name: typeof row.owner_user_id === "string"
        ? ownerNames.get(row.owner_user_id) ?? null
        : null,
    }));
  }

  async addParticipant(
    auth: AuthContext,
    userId: string,
  ): Promise<WorkstreamDetail["participants"][number]> {
    await this.authorize(auth);
    const member = await this.env.DB.prepare(
      `SELECT 1 AS one FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
    ).bind(auth.workspaceId, userId).first<{ one: number }>();
    if (!member) {
      throw new ApiError(422, "invalid_workspace_member", "A participant is not an active workspace member");
    }
    const audience = this.readerAudience();
    if (audience.scope === "personal" && !audience.userIds.includes(userId)) {
      this.assertAcceptedContentContains({
        scope: "personal",
        userIds: [...audience.userIds, userId],
      });
    }
    // Both names are read before the commit because the effects that carry
    // them are built inside it: an effect callback runs against object SQL and
    // cannot await a regional round trip.
    const names = await this.messageUsers([auth.userId, userId]);
    const actorName = names.get(auth.userId)?.name ?? "A workspace member";
    const recipientName = names.get(userId)?.name ?? "a workspace member";
    const now = Date.now();
    await this.objectStore.commitWithRegionalEffects<{ alreadyActive: boolean }>(
      (sql) => {
        // Read before the upsert, because the upsert erases the difference:
        // adding somebody who is already in the room is a no-op, and the
        // effects below turn on which of the two just happened.
        const alreadyActive = first(sql.exec<{ one: number }>(
          `SELECT 1 AS one FROM participants WHERE user_id = ? AND status = 'active'`,
          userId,
        )) !== null;
        sql.exec(
        `INSERT INTO participants
           (user_id, participation_reason, added_by_user_id, status, participant_epoch,
            added_at, removed_at, first_opened_at, updated_at)
         VALUES (?, 'explicit', ?, 'active', 0, ?, NULL, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           status = 'active', removed_at = NULL,
           participant_epoch = CASE WHEN participants.status = 'removed'
             THEN participants.participant_epoch + 1 ELSE participants.participant_epoch END,
           participation_reason = CASE WHEN participants.status = 'removed'
             THEN 'explicit' ELSE participants.participation_reason END,
           added_by_user_id = CASE WHEN participants.status = 'removed'
             THEN excluded.added_by_user_id ELSE participants.added_by_user_id END,
           added_at = CASE WHEN participants.status = 'removed'
             THEN excluded.added_at ELSE participants.added_at END,
           -- Being put back in a room you were taken out of is being added
           -- again: the work stream has moved on without you, and the epoch
           -- bump beside this says the same thing about the notification.
           first_opened_at = CASE WHEN participants.status = 'removed'
             THEN excluded.first_opened_at ELSE participants.first_opened_at END,
           updated_at = excluded.updated_at`,
          // Null unless you added yourself, which is the one add made by
          // somebody who is already looking at the work stream.
          userId, auth.userId, now, userId === auth.userId ? now : null, now,
        );
        return { alreadyActive };
      },
      (sql, write) => {
        const current = this.root();
        const viewer = {
          partitionKey: `user:${userId}`,
          effect: this.userEffect(current, userId),
        };
        // Adding yourself is not news. `update` takes exactly this path when a
        // work stream is narrowed to personal by somebody not already in it.
        //
        // Neither is adding somebody who is already here. Beyond being noise,
        // re-announcing a participation would re-enqueue an effect this object
        // has already had acknowledged, under the same identity but against a
        // newer projection version — which the parent refuses as a hash
        // conflict and then cannot drain. Somebody is told once per
        // participation, not once per click.
        if (userId === auth.userId || write.alreadyActive) return [viewer];
        // The epoch is what separates one add from the next: re-adding
        // somebody who was removed notifies them again, while a redelivery of
        // this add converges on the same intent and the same activity row.
        //
        // The work stream is in the identity because both things this keys are
        // workspace-wide while the epoch is object-local and starts at zero:
        // `workspace_activity_events.dedupe_key` is UNIQUE across the
        // workspace, and an intent is fenced on its id and on
        // `(source_message_id, recipient_user_id, notification_kind)`. Without
        // it, adding the same person to a second work stream reuses the first
        // one's identity, and the effect is refused as a conflict and retried
        // forever instead of delivered. A mention avoids this for free by
        // keying on a message id, which is already unique.
        const epoch = first(sql.exec<{ participant_epoch: number }>(
          `SELECT participant_epoch FROM participants WHERE user_id = ?`,
          userId,
        ))?.participant_epoch ?? 0;
        return [
          viewer,
          ...this.participantAddedEffects({
            root: current,
            userId,
            actorUserId: auth.userId,
            actorName,
            recipientName,
            epoch,
            now,
          }),
        ];
      },
    );
    const participant = (await this.participants()).find((entry) => entry.user.id === userId);
    if (!participant) {
      throw new ApiError(409, "participant_reload_failed", "The participant was added but could not be read back");
    }
    return ParticipantSchema.parse(participant);
  }

  /**
   * The two effects that say "this person was put in this room", for one person.
   *
   * One copy because there are two callers and two more seating paths named in
   * `docs/workstream-durable-object.md` that will want it: the payload is what
   * a person reads in a Slack DM and an inbox, and two transcriptions of it
   * would drift on the first change to either.
   *
   * **Every caller must place these after that recipient's own `directory_user`
   * effect in the same returned array.** The notification's
   * `requiredProjectionVersion` is read from the projection key that effect
   * advances, in the same `commitWithRegionalEffects` loop pass — so the
   * delivery side cannot tell somebody about a work stream their own sidebar
   * row has not reached the workspace yet. Earlier in the array is the whole
   * requirement; adjacency is not, and `createMessage` groups all viewer
   * effects ahead of all notifications for that reason.
   *
   * `epoch` is what separates one participation from the next: re-adding
   * somebody who was removed notifies them again, while a redelivery of the
   * same add converges on one intent and one activity row. The work stream is
   * in both identities because what they key is workspace-wide while the epoch
   * is object-local and starts at zero — `workspace_activity_events.dedupe_key`
   * is UNIQUE across the workspace, and an intent is fenced on its id and on
   * `(source_message_id, recipient_user_id, notification_kind)`. Without it,
   * adding one person to a second work stream reuses the first one's identity
   * and the effect is refused as a conflict, then retried forever instead of
   * delivered. A mention avoids this for free by keying on a message id.
   */
  private participantAddedEffects(input: {
    root: RootRow;
    userId: string;
    actorUserId: string;
    actorName: string;
    recipientName: string;
    epoch: number;
    now: number;
  }): RegionalEffectCommand[] {
    const sourceId = `participant:${input.root.workstream_key}:${input.userId}:${input.epoch}`;
    const intentId = `participant_added:${input.root.workstream_key}:${input.userId}:${input.epoch}`;
    const occurredAt = new Date(input.now).toISOString();
    const title = truncateUtf16Safe(input.root.title, 500);
    return [
      {
        partitionKey: `activity:${sourceId}`,
        sourceVersion: 1,
        dedupeKey: sourceId,
        effect: {
          kind: "activity_event" as const,
          eventId: uuidV7(input.now),
          eventType: "workstream_participant_added",
          // Nothing in the transcript ordered this: a person joined the room,
          // which sits outside the message sequence.
          subjectSequenceNumber: null,
          actorType: "user" as const,
          actorUserId: input.actorUserId,
          // Both names are truncated to the schema's own ceiling rather than
          // trusted: they are read from `users.name`, and a value over the
          // effect schema's bound would throw inside the effect callback —
          // which, on the create path, is after the root has already committed.
          actorLabel: truncateUtf16Safe(input.actorName, 300),
          title,
          body: truncateUtf16Safe(
            `${input.actorName} added ${input.recipientName} to this work stream.`,
            8_000,
          ),
          canonicalUrl: null,
          digestible: true,
          occurredAt,
          sourceKind: "workstream_participant",
          sourceId,
          dedupeKey: sourceId,
          metadata: { participantUserId: input.userId, addedByUserId: input.actorUserId },
          targets: [{ userId: input.userId, relation: "added" }],
        },
      },
      {
        partitionKey: `notification:${intentId}`,
        sourceVersion: 1,
        dedupeKey: intentId,
        dependsOnProjectionKey: `user:${input.userId}`,
        effect: {
          kind: "participant_notification" as const,
          intentId,
          sourceId,
          recipientUserId: input.userId,
          actorUserId: input.actorUserId,
          actorNameSnapshot: truncateUtf16Safe(input.actorName, 300),
          workstreamTitleSnapshot: title,
          workstreamObjectiveSnapshot: truncateUtf16Safe(input.root.description, 500),
          // Read from the root rather than passed in, so both callers get it
          // right: a create is always naming, and somebody hand-added during
          // the seconds before the naming pass lands is in the same position.
          titleIsProvisional: input.root.title_status === "naming",
          occurredAt,
        },
      },
    ];
  }

  async removeParticipant(
    auth: AuthContext,
    userId: string,
  ): Promise<"removed" | "already_removed" | "not_found"> {
    await this.authorize(auth);
    const now = Date.now();
    const { result: outcome } = await this.objectStore.commitWithRegionalEffects(
      (sql) => {
        const target = first(sql.exec<{ status: "active" | "removed" }>(
          `SELECT status FROM participants WHERE user_id = ?`,
          userId,
        ));
        if (!target) return "not_found" as const;
        // A DELETE whose first response was lost or whose local publication
        // failed must be able to replay the idempotent removal event.
        if (target.status === "removed") return "already_removed" as const;
        const active = first(sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM participants WHERE status = 'active'`,
        ))?.count ?? 0;
        if (active <= 1) {
          throw new ApiError(
            409,
            "workstream_participant_required",
            "At least one participant must remain in this work stream",
          );
        }
        sql.exec(
          `UPDATE participants SET status = 'removed', removed_at = ?,
                 participant_epoch = participant_epoch + 1, updated_at = ?
           WHERE user_id = ? AND status = 'active'`,
          now, now, userId,
        );
        return "removed" as const;
      },
      (_sql, result) => result === "removed"
        ? [{ partitionKey: `user:${userId}`, effect: this.userEffect(this.root(), userId) }]
        : [],
    );
    return outcome;
  }

  async attachResource(auth: AuthContext, resourceId: string): Promise<WorkstreamResource> {
    await this.authorize(auth);
    const resource = await this.workspaceDatabase(auth.workspaceId).prepare(
      `SELECT resource.*, connection.scope AS connection_scope,
              connection.owner_user_id, note.scope AS note_scope
         FROM resources resource
         LEFT JOIN connector_connections connection ON connection.id = resource.connection_id
         LEFT JOIN notes note ON note.resource_id = resource.id AND note.archived_at IS NULL
        WHERE resource.id = ? AND resource.workspace_id = ?`,
    ).bind(resourceId, auth.workspaceId).first<Record<string, unknown>>();
    if (!resource) throw new ApiError(404, "resource_not_found", "Resource not found");
    if (resource.connection_scope === "personal" && resource.owner_user_id !== auth.userId) {
      throw new ApiError(403, "resource_access_denied", "This personal resource is not available to the work stream");
    }
    const descriptor = {
      id: resourceId,
      connectionId: resource.connection_id == null ? null : String(resource.connection_id),
      type: String(resource.resource_type),
      provider: String(resource.provider),
      providerResourceId: resource.provider_resource_id == null ? null : String(resource.provider_resource_id),
      title: String(resource.title),
      mimeType: resource.mime_type == null ? null : String(resource.mime_type),
      contentRef: resource.content_ref == null ? null : String(resource.content_ref),
      canonicalUrl: resource.canonical_url == null ? null : String(resource.canonical_url),
      metadata: parseJson(String(resource.metadata_json ?? "{}"), {}),
    };
    const now = Date.now();
    await this.objectStore.commitWithRegionalEffects(
      (sql) => {
      sql.exec(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES (?, ?, 0, 'attachment', ?, ?, ?)
         ON CONFLICT(resource_id) DO NOTHING`,
        resourceId, auth.userId, JSON.stringify(descriptor), now, now,
      );
      sql.exec(
        `INSERT INTO resource_inventory_revision(id, revision, updated_at) VALUES (1, 1, ?)
         ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
        now,
      );
      },
      () => [{ partitionKey: "common", effect: this.commonEffect(this.root()) }],
    );
    const attached = (await this.resources(auth.userId)).find((entry) => entry.id === resourceId);
    if (!attached) {
      throw new ApiError(409, "resource_reload_failed", "The resource was attached but could not be read back");
    }
    return WorkstreamResourceSchema.parse(attached);
  }

  /** Attach a resource already durably created by this run in WorkspaceDO. */
  async attachRuntimeResource(
    workspaceId: string,
    resourceId: string,
    attachedByUserId: string | null,
    relationshipType: ResourceRelationshipType = "generated",
  ): Promise<void> {
    const root = this.root();
    if (root.parent_workspace_key !== workspaceId) {
      throw new ApiError(409, "workstream_object_identity_mismatch", "The object identity does not match");
    }
    const resource = (await (await this.workspaceDirectory(workspaceId)).resourceDescriptors({
      workspaceId,
      resourceIds: [resourceId],
      draftUploadedByUserId: null,
    })).items[0];
    if (!resource) throw new ApiError(404, "resource_not_found", "Resource not found");
    const descriptor = {
      id: resourceId,
      connectionId: resource.connection_id == null ? null : String(resource.connection_id),
      type: String(resource.resource_type),
      provider: String(resource.provider),
      providerResourceId: resource.provider_resource_id == null ? null : String(resource.provider_resource_id),
      title: String(resource.title),
      mimeType: resource.mime_type == null ? null : String(resource.mime_type),
      contentRef: resource.content_ref == null ? null : String(resource.content_ref),
      canonicalUrl: resource.canonical_url == null ? null : String(resource.canonical_url),
      metadata: parseJson(String(resource.metadata_json ?? "{}"), {}),
    };
    const now = Date.now();
    await this.objectStore.commitWithRegionalEffects(
      (sql) => {
      sql.exec(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT(resource_id) DO UPDATE SET resource_json = excluded.resource_json,
           relationship_type = excluded.relationship_type, updated_at = excluded.updated_at`,
        resourceId, attachedByUserId, relationshipType, JSON.stringify(descriptor), now, now,
      );
      sql.exec(
        `INSERT INTO resource_inventory_revision(id, revision, updated_at) VALUES (1, 1, ?)
         ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
        now,
      );
      },
      () => [{ partitionKey: "common", effect: this.commonEffect(this.root()) }],
    );
  }

  async detachResource(auth: AuthContext, resourceId: string): Promise<void> {
    await this.authorize(auth);
    await this.objectStore.commitWithRegionalEffects(
      (sql) => {
      const removed = sql.exec<{ resource_id: string }>(
        `DELETE FROM workstream_resource_links WHERE resource_id = ?
         RETURNING resource_id`,
        resourceId,
      ).toArray().length > 0;
      if (removed) {
        sql.exec(
          `INSERT INTO resource_inventory_revision(id, revision, updated_at) VALUES (1, 1, ?)
           ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
          Date.now(),
        );
      }
        return removed;
      },
      (removed) => removed
        ? [{ partitionKey: "common", effect: this.commonEffect(this.root()) }]
        : [],
    );
  }

  private elicitations(): WorkstreamDetail["openElicitations"] {
    return this.elicitationsIncludingResolved().filter((elicitation) => elicitation.status === "open");
  }

  private elicitationsIncludingResolved(): Elicitation[] {
    const root = this.root();
    return this.storage.sql.exec<{
      elicitation_id: string; run_id: string; prompt: string; response_type: string;
      options_json: string; minimum_selections: number; maximum_selections: number | null;
      target_user_id: string | null; status: string; answer_json: string | null;
      answered_by_user_id: string | null; created_at: number; answered_at: number | null;
    }>(
      `SELECT * FROM elicitation_requests ORDER BY created_at`,
    ).toArray().map((row) => ({
      id: row.elicitation_id,
      workstreamId: root.workstream_key,
      harnessRunId: row.run_id,
      prompt: row.prompt,
      responseType: row.response_type as "text" | "radio" | "single_select" | "multi_select",
      options: parseJson(row.options_json, []),
      minimumSelections: row.minimum_selections,
      maximumSelections: row.maximum_selections,
      targetUserId: row.target_user_id,
      status: row.status === "pending" ? "open" as const
        : row.status as "answered" | "cancelled",
      answer: parseJson(row.answer_json, null),
      answeredByUserId: row.answered_by_user_id,
      createdAt: iso(row.created_at)!,
      answeredAt: iso(row.answered_at),
    }));
  }

  readerAudience(root: RootRow = this.root()): WorkstreamReaderAudience {
    if (root.scope === "workspace") return { scope: "workspace" };
    const userIds = this.storage.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM participants WHERE status = 'active'`,
    ).toArray().map((participant) => participant.user_id);
    return { scope: "personal", userIds };
  }

  private sourceAudience(value: string | null): ContentAudience | null {
    const intent = parseJson<{ sourceAudience?: unknown }>(value, {});
    const parsed = ContentAudienceSchema.safeParse(intent.sourceAudience);
    return parsed.success ? parsed.data : null;
  }

  /** Accepted activity resources remain attached, so their audience remains a lifetime fence. */
  private assertAcceptedContentContains(targetAudience: WorkstreamReaderAudience): void {
    const rows = this.storage.sql.exec<{ share_intent_json: string | null }>(
      `SELECT share_intent_json FROM suggested_actions WHERE status = 'accepted'`,
    ).toArray();
    for (const row of rows) {
      const sourceAudience = this.sourceAudience(row.share_intent_json);
      if (sourceAudience && contentAudienceContainsWorkstream(sourceAudience, targetAudience)) continue;
      throw new ApiError(
        409,
        "workstream_audience_restricted_content",
        "This work stream contains accepted content that the wider audience cannot view",
      );
    }
  }

  private suggestions(): WorkstreamDetail["suggestions"] {
    if (!SUGGESTED_CONTEXT_ENABLED) return [];
    const root = this.root();
    const targetAudience = this.readerAudience(root);
    return this.storage.sql.exec<{
      action_id: string; source_activity_id: string; display_title: string; display_body: string;
      share_intent_json: string | null; status: string; created_at: number; resolved_at: number | null;
    }>(
      `SELECT action_id, source_activity_id, display_title, display_body, share_intent_json,
              status, created_at, resolved_at
         FROM suggested_actions WHERE status = 'pending'
        ORDER BY created_at DESC, action_id`,
    ).toArray().flatMap((row) => {
      const sourceAudience = this.sourceAudience(row.share_intent_json);
      if (!sourceAudience || !contentAudienceContainsWorkstream(sourceAudience, targetAudience)) {
        return [];
      }
      const intent = parseJson<{ confidence?: number; reason?: string }>(row.share_intent_json, {});
      return [{
        id: row.action_id,
        activityId: row.source_activity_id,
        workstreamId: root.workstream_key,
        title: truncateUtf16Safe(row.display_title, 300),
        summary: truncateUtf16Safe(row.display_body, 2_000),
        confidence: Math.max(0, Math.min(1, Number(intent.confidence ?? 0))),
        reason: truncateUtf16Safe(intent.reason ?? row.display_body, 1_200),
        status: "pending" as const,
        createdAt: iso(row.created_at)!,
        resolvedAt: iso(row.resolved_at),
      }];
    });
  }

  private suggestion(actionId: string): ActivitySuggestion | undefined {
    const root = this.root();
    const row = first(this.storage.sql.exec<{
      action_id: string; source_activity_id: string; display_title: string; display_body: string;
      share_intent_json: string | null; status: string; created_at: number; resolved_at: number | null;
    }>(
      `SELECT action_id, source_activity_id, display_title, display_body, share_intent_json,
              status, created_at, resolved_at
         FROM suggested_actions WHERE action_id = ? ORDER BY version DESC LIMIT 1`,
      actionId,
    ));
    if (!row || !["pending", "accepted", "dismissed"].includes(row.status)) return undefined;
    const sourceAudience = this.sourceAudience(row.share_intent_json);
    if (!sourceAudience || !contentAudienceContainsWorkstream(sourceAudience, this.readerAudience(root))) {
      return undefined;
    }
    const intent = parseJson<{ confidence?: number; reason?: string }>(row.share_intent_json, {});
    return ActivitySuggestionSchema.parse({
      id: row.action_id,
      activityId: row.source_activity_id,
      workstreamId: root.workstream_key,
      title: truncateUtf16Safe(row.display_title, 300),
      summary: truncateUtf16Safe(row.display_body, 2_000),
      confidence: Math.max(0, Math.min(1, Number(intent.confidence ?? 0))),
      reason: truncateUtf16Safe(intent.reason ?? row.display_body, 1_200),
      status: row.status,
      createdAt: iso(row.created_at),
      resolvedAt: iso(row.resolved_at),
    });
  }

  async createSuggestion(
    workspaceId: string,
    rawInput: WorkstreamObjectCreateSuggestionInput,
  ): Promise<{ suggestion: ActivitySuggestion; inserted: boolean }> {
    const root = this.root();
    if (root.parent_workspace_key !== workspaceId) {
      throw new ApiError(409, "workstream_object_identity_mismatch", "The object identity does not match");
    }
    const input = WorkstreamObjectCreateSuggestionInputSchema.parse(rawInput);
    if (!contentAudienceContainsWorkstream(input.sourceAudience, this.readerAudience(root))) {
      throw new ApiError(
        403,
        "suggestion_audience_mismatch",
        "The activity audience does not contain every reader of this work stream",
      );
    }
    const now = Date.now();
    const inserted = this.storage.sql.exec<{ action_id: string }>(
      `INSERT OR IGNORE INTO suggested_actions
         (action_id, version, source_activity_id, delivery_id, audience_kind,
          audience_user_id, provenance_ref, authorization_selector_hash,
          source_revisions_json, source_authorization_epoch, display_title,
          display_body, status, created_at, expires_at, resolved_at, retracted_at,
          resolved_by_user_id, resolution_client_id, share_intent_json,
          authored_message_id, feedback_message_id)
       VALUES (?, 1, ?, ?, 'workstream', NULL, ?, 'regional-activity-authority',
               '[]', 0, ?, ?, 'pending', ?, 253402300799000, NULL, NULL,
               NULL, NULL, ?, NULL, NULL)
       RETURNING action_id`,
      input.id,
      input.activityId,
      `suggestion:${input.source}:${input.activityId}`,
      `activity:${input.activityId}`,
      input.title,
      input.summary,
      now,
      JSON.stringify({
        confidence: input.confidence,
        reason: input.reason,
        matchedEntities: input.matchedEntities,
        source: input.source,
        sourceAudience: input.sourceAudience,
      }),
    ).toArray().length > 0;
    const suggestion = this.suggestion(input.id);
    if (!suggestion) {
      const replay = first(this.storage.sql.exec<{ action_id: string }>(
        `SELECT action_id FROM suggested_actions WHERE delivery_id = ?`,
        `suggestion:${input.source}:${input.activityId}`,
      ));
      const existing = replay ? this.suggestion(replay.action_id) : undefined;
      if (!existing) throw new Error("workstream_suggestion_reload_failed");
      return { suggestion: existing, inserted: false };
    }
    return { suggestion, inserted };
  }

  async resolveSuggestion(
    auth: AuthContext,
    actionId: string,
    action: "accepted" | "dismissed",
  ): Promise<{ suggestion: ActivitySuggestion | undefined; resourceId: string | null; changed: boolean }> {
    await this.authorize(auth);
    const existing = this.suggestion(actionId);
    if (!existing) throw new ApiError(404, "suggestion_not_found", "Activity suggestion not found");
    if (existing.status !== "pending") {
      if (existing.status !== action) {
        throw new ApiError(409, "suggestion_already_resolved", existing.status === "accepted"
          ? "This suggestion was already added to the work stream"
          : "This suggestion was already dismissed");
      }
      return {
        suggestion: existing,
        resourceId: action === "accepted"
          ? await this.attachedActivityResourceId(existing.activityId)
          : null,
        changed: false,
      };
    }
    const resource = action === "accepted"
      ? await this.activityResource(existing.activityId, auth.workspaceId)
      : null;
    const now = Date.now();
    const sourceRow = first(this.storage.sql.exec<{ share_intent_json: string | null }>(
      `SELECT share_intent_json FROM suggested_actions WHERE action_id = ?`,
      actionId,
    ));
    const source = parseJson<{ source?: string }>(sourceRow?.share_intent_json ?? null, {}).source
      === "suggested_work" ? "suggested_work" as const : "contextual_routing" as const;
    const committed = await this.objectStore.commitWithRegionalEffects(
      (sql) => {
        const changed = sql.exec<{ action_id: string }>(
        `UPDATE suggested_actions SET status = ?, resolved_at = ?,
                resolved_by_user_id = ?, resolution_client_id = ?
          WHERE action_id = ? AND status = 'pending'
          RETURNING action_id`,
        action, now, auth.userId, `${auth.userId}:${action}`, actionId,
      ).toArray().length > 0;
      if (changed && resource) {
        sql.exec(
          `INSERT INTO workstream_resource_links
             (resource_id, attached_by_user_id, watch_enabled, relationship_type,
              resource_json, attached_at, updated_at)
           VALUES (?, ?, 0, 'suggested_activity', ?, ?, ?)
           ON CONFLICT(resource_id) DO NOTHING`,
          resource.id, auth.userId, JSON.stringify(resource.descriptor), now, now,
        );
        sql.exec(
          `INSERT INTO resource_inventory_revision(id, revision, updated_at) VALUES (1, 1, ?)
           ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
          now,
        );
      }
        return changed;
      },
      (changed) => changed ? [
        {
          partitionKey: `suggestion:${actionId}`,
          sourceVersion: 1,
          dedupeKey: `suggestion-feedback:${actionId}:${action}`,
          effect: {
            kind: "suggestion_feedback" as const,
            actionId,
            activityId: existing.activityId,
            source,
            status: action,
            resolvedAt: iso(now)!,
            resolvedByUserId: auth.userId,
          },
        },
        ...(resource ? [{ partitionKey: "common", effect: this.commonEffect(this.root()) }] : []),
      ] : [],
    );
    const changed = committed.result;
    const resolved = this.suggestion(actionId);
    if (!resolved) throw new Error("workstream_suggestion_reload_failed");
    if (!changed && resolved.status !== action) {
      throw new ApiError(409, "suggestion_resolution_conflict", "This suggestion could not be resolved. Try again.");
    }
    return { suggestion: resolved, resourceId: resource?.id ?? null, changed };
  }

  private async activityResource(
    activityId: string,
    workspaceId: string,
  ): Promise<{ id: string; descriptor: Record<string, unknown> } | null> {
    const row = await this.workspaceDatabase(workspaceId).prepare(
      `SELECT resource.id, resource.connection_id, resource.resource_type,
              resource.provider, resource.provider_resource_id, resource.title,
              resource.mime_type, resource.content_ref, resource.canonical_url,
              resource.metadata_json
         FROM workspace_connector_events activity
         JOIN resources resource
           ON resource.provider = activity.provider
          AND resource.provider_resource_id = activity.provider_resource_id
          AND (resource.connection_id = activity.connection_id
               OR (resource.connection_id IS NULL AND activity.connection_id IS NULL))
        WHERE activity.event_id = ? AND resource.workspace_id = ? LIMIT 1`,
    ).bind(activityId, workspaceId).first<Record<string, unknown>>();
    if (!row) return null;
    return {
      id: String(row.id),
      descriptor: {
        id: String(row.id),
        connectionId: row.connection_id == null ? null : String(row.connection_id),
        type: String(row.resource_type),
        provider: String(row.provider),
        providerResourceId: row.provider_resource_id == null ? null : String(row.provider_resource_id),
        title: String(row.title),
        mimeType: row.mime_type == null ? null : String(row.mime_type),
        contentRef: row.content_ref == null ? null : String(row.content_ref),
        canonicalUrl: row.canonical_url == null ? null : String(row.canonical_url),
        metadata: parseJson(String(row.metadata_json ?? "{}"), {}),
      },
    };
  }

  private async attachedActivityResourceId(activityId: string): Promise<string | null> {
    const resource = await this.activityResource(activityId, this.root().parent_workspace_key);
    if (!resource) return null;
    return first(this.storage.sql.exec<{ resource_id: string }>(
      `SELECT resource_id FROM workstream_resource_links WHERE resource_id = ?`, resource.id,
    ))?.resource_id ?? null;
  }

  private backgroundTasks(): WorkstreamDetail["backgroundTasks"] {
    const harness = this.storage.sql.exec<{
      run_id: string; origin: string; status: string; usage_json: string | null;
      started_at: number; completed_at: number | null; created_at: number; final_turn_id: string | null;
    }>(
      `SELECT run_id, origin, status, usage_json, started_at, completed_at, created_at, final_turn_id
         FROM runs WHERE origin != 'block_dashboard_block'
        ORDER BY started_at DESC LIMIT 250`,
    ).toArray().map((row) => {
      if (row.status === "waiting" || row.status === "steering") {
        throw new Error("retired_run_status");
      }
      const usage = parseJson<Record<string, unknown>>(row.usage_json, {});
      const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
      const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
      return {
        id: row.run_id,
        harnessRunId: row.run_id,
        title: row.origin.replaceAll("_", " "),
        taskType: "agent" as const,
        status: row.status === "cancelled" ? "failed" as const
          : row.status === "admitted"
            ? "running" as const
            : row.status as "running" | "needs_input" | "completed" | "failed",
        startedAt: iso(row.started_at)!,
        completedAt: iso(row.completed_at),
        tokenCount: Number.isFinite(input + output) ? input + output : null,
        toolUses: Number(first(this.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM tool_effects WHERE run_id = ?`, row.run_id,
        ))?.count ?? 0),
        transcriptTurnId: row.final_turn_id,
      };
    });
    const tools = this.storage.sql.exec<{
      effect_intent_id: string; run_id: string; tool_name: string; status: string;
      connection_id: string | null; started_at: number | null; settled_at: number | null;
    }>(
      `SELECT effect_intent_id, run_id, tool_name, status, connection_id, started_at, settled_at
         FROM tool_effects ORDER BY COALESCE(started_at, 0) DESC LIMIT 500`,
    ).toArray().map((row) => ({
      id: row.effect_intent_id,
      harnessRunId: row.run_id,
      title: row.tool_name.replaceAll("_", " "),
      taskType: row.connection_id ? "connector" as const : "tool" as const,
      status: row.status === "admitted" || row.status === "executing" ? "running" as const
        : row.status === "completed" ? "completed" as const : "failed" as const,
      startedAt: iso(row.started_at ?? 0)!,
      completedAt: iso(row.settled_at),
      tokenCount: null,
      toolUses: null,
      transcriptTurnId: null,
    }));
    return [...harness, ...tools].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  private commonEffect(root: RootRow) {
    const wakeup = first(this.storage.sql.exec<{ due_at: number; prompt: string }>(
      `SELECT due_at, prompt FROM workstream_wakeups
        WHERE status = 'pending' ORDER BY due_at, wakeup_id LIMIT 1`,
    ));
    // These four were `json_extract` calls against `lifecycle_json` until the
    // Terminal lifecycle was promoted to real columns in schema version 12.
    // They are already epoch milliseconds, so the `Date.parse` that used to
    // wrap each one is gone with the strings it parsed.
    const terminal = first(this.storage.sql.exec<{
      lifecycle_state: string;
      sandbox_id: string | null;
      idle_expires_at: number | null;
      archive_due_at: number | null;
      expire_due_at: number | null;
      lifecycle_claim_expires_at: number | null;
    }>(
      `SELECT lifecycle_state, sandbox_id, idle_expires_at, archive_due_at,
              expire_due_at, lifecycle_claim_expires_at
         FROM terminal_workspace WHERE id = 1`,
    ));
    const terminalCandidates = terminal?.sandbox_id
      ? [
          terminal.lifecycle_state === "running" ? terminal.idle_expires_at : null,
          terminal.lifecycle_state === "stopped" ? terminal.archive_due_at : null,
          terminal.expire_due_at,
          ["stopping", "archiving", "expiring"].includes(terminal.lifecycle_state)
            ? terminal.lifecycle_claim_expires_at
            : null,
        ].filter((value): value is number => value !== null && Number.isFinite(value))
      : [];
    // Bounded to the envelope contract's maximum so an effect this object can
    // commit is always one the parent will accept — an unbounded selection
    // could exceed the contract and permanently poison the outbox retry. Past
    // ten thousand links the directory index carries the newest attachments;
    // this object remains the authoritative full set.
    const resourceLinks = this.storage.sql.exec<{
      resource_id: string;
      watch_enabled: number;
      relationship_type: ResourceRelationshipType;
    }>(
      `SELECT resource_id, watch_enabled, relationship_type
         FROM workstream_resource_links link
        ORDER BY EXISTS (
          SELECT 1
            FROM pending_attachment_reservation_recovery recovery
            JOIN participant_transcript_attachments attachment
              ON attachment.turn_id = recovery.input_id
             AND attachment.resource_id = recovery.resource_id
           WHERE recovery.resource_id = link.resource_id
        ) DESC, attached_at DESC, resource_id
        LIMIT ${WORKSTREAM_DIRECTORY_RESOURCE_LINK_LIMIT}`,
    ).toArray().map((row) => ({
      resourceId: row.resource_id,
      watchEnabled: row.watch_enabled === 1,
      relationshipType: row.relationship_type,
    }));
    const attachmentReservationReleases = this.storage.sql.exec<{
      input_id: string;
      resource_id: string;
    }>(
      `SELECT recovery.input_id, recovery.resource_id
         FROM pending_attachment_reservation_recovery recovery
         JOIN participant_transcript_attachments attachment
           ON attachment.turn_id = recovery.input_id
          AND attachment.resource_id = recovery.resource_id
        ORDER BY recovery.created_at, recovery.input_id, recovery.resource_id
        LIMIT ${WORKSTREAM_DIRECTORY_RESOURCE_LINK_LIMIT}`,
    ).toArray().map((row) => ({
      inputId: row.input_id,
      resourceId: row.resource_id,
    }));
    return {
      kind: "directory_common" as const,
      title: truncateUtf16Safe(root.title, 500),
      description: truncateUtf16Safe(root.description, WORKSTREAM_DESCRIPTION_MAX_CHARACTERS),
      preview: truncateUtf16Safe(root.preview, 1_000),
      scope: root.scope,
      state: root.exact_state,
      systemKind: root.system_kind,
      lastActivityAt: iso(root.last_people_activity_at)!,
      completedAt: iso(root.completed_at),
      archivedAt: iso(root.archived_at),
      emailAddress: root.email_address,
      originType: root.origin_type,
      createdByUserId: root.created_by_user_id,
      automationSubscriptionId: root.automation_subscription_id,
      automationRunId: root.automation_run_id,
      plannedFor: iso(root.planned_for),
      titleStatus: root.title_status,
      latestAttentionOrdinal: Math.max(0, root.next_attention_ordinal - 1),
      unreadTrackingStartOrdinal: root.unread_tracking_start_ordinal,
      nextWakeupDueAt: wakeup ? iso(wakeup.due_at) : null,
      nextWakeupPrompt: wakeup ? truncateUtf16Safe(wakeup.prompt, 500) : null,
      nextTerminalActionAt: terminalCandidates.length > 0
        ? iso(Math.min(...terminalCandidates))
        : null,
      resourceLinks,
      ...(attachmentReservationReleases.length > 0 ? { attachmentReservationReleases } : {}),
      createdAt: iso(root.created_at)!,
      updatedAt: iso(root.updated_at)!,
    };
  }

  private userEffect(root: RootRow, userId: string) {
    const attention = this.attention(userId, root);
    const latest = Math.max(0, root.next_attention_ordinal - 1);
    const unreadFrom = attention.manual_unread_from_ordinal
      ?? (latest > attention.seen_attention_ordinal ? attention.seen_attention_ordinal + 1 : null);
    const participantRow = first(this.storage.sql.exec<{ added_at: number }>(
      `SELECT added_at FROM participants WHERE user_id = ? AND status = 'active' LIMIT 1`,
      userId,
    ));
    const participant = participantRow !== null;
    return {
      kind: "directory_user" as const,
      userId,
      isParticipant: participant,
      participantAddedAt: participantRow ? iso(participantRow.added_at) : null,
      unreadCount: unreadFrom === null ? 0 : Math.max(1, latest - unreadFrom + 1),
      youAreMentioned: attention.latest_mention_attention_ordinal > attention.seen_attention_ordinal,
      unseen: this.isUnseen(userId),
      listable: root.archived_at === null && participantVisible(root, participant),
      seenAttentionOrdinal: attention.seen_attention_ordinal,
      manualUnreadFromOrdinal: attention.manual_unread_from_ordinal,
      manualUnreadGeneration: attention.version,
      latestMentionAttentionOrdinal: attention.latest_mention_attention_ordinal,
    };
  }

  private model(root: RootRow): Promise<string> {
    if (root.model_override) return Promise.resolve(pinnedModelRouting(root.model_override).model);
    return resolveAgentModelRouting(this.env, "workstream", {
      workspaceId: root.parent_workspace_key,
      workstreamId: root.workstream_key,
    }).then((routing) => routing.model);
  }

  private async recentAddressingMessages(beforeTranscriptSequence: number): Promise<AddressingContextMessage[]> {
    const rows = this.storage.sql.exec<{
      author_type: "member" | "agent";
      author_user_id: string | null;
      content: string | null;
    }>(
      `SELECT author_type, author_user_id, content FROM canonical_conversation_turn_details
        WHERE substream_id = '0' AND sequence_number < ? AND message_type = 'text'
          AND author_type IN ('member', 'agent')
        ORDER BY sequence_number DESC LIMIT 10`,
      beforeTranscriptSequence,
    ).toArray().reverse();
    const memberIds = [...new Set(rows.flatMap((row) =>
      row.author_type === "member" && row.author_user_id ? [row.author_user_id] : []))];
    const names = new Map<string, string>();
    if (memberIds.length > 0) {
      const result = await this.env.DB.prepare(
        `SELECT id, name FROM users WHERE id IN (${memberIds.map(() => "?").join(",")})`,
      ).bind(...memberIds).all<{ id: string; name: string }>();
      for (const row of result.results ?? []) names.set(row.id, row.name);
    }
    return rows.map((row) => ({
      authorType: row.author_type === "agent" ? "agent" : "human",
      authorName: row.author_type === "agent"
        ? "Avalon"
        : row.author_user_id ? names.get(row.author_user_id) ?? null : null,
      message: row.content ?? "",
    }));
  }

  /**
   * Join transcript promotion's SQLite transaction so no acknowledged input
   * can commit without its regional projections and notifications in outbox.
   */
  enqueueRegionalEffectsInTransaction(
    deliveryEffects: readonly PendingInputDeliveryEffectInput[],
  ): number {
    if (deliveryEffects.length === 0) return 0;
    const root = this.root();
    const affectedUserIds = [...new Set(deliveryEffects.flatMap((delivery) =>
      delivery.affectedUserIds))];
    const commands: RegionalEffectCommand[] = [
      { partitionKey: "common", effect: this.commonEffect(root) },
      ...affectedUserIds.map((userId) => ({
        partitionKey: `user:${userId}`,
        effect: this.userEffect(root, userId),
      })),
    ];
    const occurredAt = new Date(root.updated_at).toISOString();
    const title = truncateUtf16Safe(root.title, 500);

    for (const delivery of deliveryEffects) {
      const messageType = first(this.storage.sql.exec<{ message_type: string }>(
        `SELECT message_type FROM participant_transcript_turns WHERE turn_id = ?`,
        delivery.turnId,
      ))?.message_type;
      // Elicitation answers historically advance the transcript/directory but
      // do not create a blank digest activity or a notification. Their typed
      // structured payload remains in the canonical turn itself.
      if (messageType === "elicitation") continue;
      const authorLabel = truncateUtf16Safe(
        delivery.authorNameSnapshot
          ?? (delivery.actor === "external" ? "External participant" : "Rally"),
        300,
      );
      const actorType = delivery.actor === "human"
        ? "user" as const
        : delivery.actor === "external" ? "external" as const : "system" as const;
      commands.push({
        partitionKey: `activity:${delivery.turnId}`,
        sourceVersion: 1,
        dedupeKey: `message:${delivery.turnId}`,
        effect: {
          kind: "activity_event",
          eventId: uuidV7(root.updated_at),
          eventType: "workstream_message_created",
          subjectSequenceNumber: delivery.transcriptSequence,
          actorType,
          actorUserId: delivery.authorUserId,
          actorLabel: authorLabel,
          title,
          body: truncateUtf16Safe(delivery.text, 8_000),
          canonicalUrl: null,
          digestible: true,
          occurredAt,
          sourceKind: "workstream_message",
          sourceId: delivery.turnId,
          dedupeKey: `message:${delivery.turnId}`,
          metadata: {},
          targets: delivery.affectedUserIds.map((userId) => ({
            userId,
            relation: "participant" as const,
          })),
        },
      });
      if (delivery.authorUserId !== null) {
        for (const userId of delivery.mentionedUserIds) {
          if (userId === delivery.authorUserId) continue;
          commands.push({
            partitionKey: `notification:${delivery.turnId}:${userId}`,
            sourceVersion: 1,
            dedupeKey: `mention:${delivery.turnId}:${userId}`,
            dependsOnProjectionKey: `user:${userId}`,
            effect: {
              kind: "mention_notification",
              intentId: `mention:${delivery.turnId}:${userId}`,
              messageId: delivery.turnId,
              recipientUserId: userId,
              authorUserId: delivery.authorUserId,
              authorNameSnapshot: authorLabel,
              workstreamTitleSnapshot: title,
              messageText: truncateUtf16Safe(delivery.text, 8_000),
              occurredAt,
            },
          });
        }
        const mentioned = new Set(delivery.mentionedUserIds);
        for (const participant of delivery.activatedParticipants) {
          // A confirmed mention already has the more specific notification;
          // never tell one person both that they were added and mentioned by
          // the same delivered message.
          if (mentioned.has(participant.userId)) continue;
          commands.push(...this.participantAddedEffects({
            root,
            userId: participant.userId,
            actorUserId: delivery.authorUserId,
            actorName: authorLabel,
            recipientName: "a workspace member",
            epoch: participant.participantEpoch,
            now: root.updated_at,
          }));
        }
      }
    }
    return this.objectStore.enqueueEffectsInCurrentTransaction(commands);
  }

  private pendingMessageResult(
    input: PendingLoopInputRow,
    inserted: boolean,
  ): WorkstreamObjectCreateMessageResult {
    const loop = this.loops.loop();
    if (!loop || loop.loop_id !== input.loop_id) throw new Error("substream_loop_not_found");
    return {
      turn: {
        turnId: input.prepared_turn_id,
        clientMessageId: input.client_message_id ?? "",
        createdAt: new Date(input.created_at).toISOString(),
      },
      deliveryState: "pending",
      activationRequest: loop.status === "idle" ? {
        kind: "activate_substream_loop",
        loopId: loop.loop_id,
        cause: "pending_input",
        inputId: input.input_id,
      } : null,
      inserted,
    };
  }

  private canonicalMessageReplay(
    existing: { id: string; created_at: number },
    clientMessageId: string,
  ): WorkstreamObjectCreateMessageResult {
    return {
      turn: {
        turnId: existing.id,
        clientMessageId,
        createdAt: new Date(existing.created_at).toISOString(),
      },
      deliveryState: "canonical",
      activationRequest: null,
      inserted: false,
    };
  }

  private ensureExternalMessageLoop(root: RootRow, now: number) {
    const loopId = substreamLoopId(asWorkstreamId(root.workstream_key));
    const projection = this.transcript.readBindProjection(loopId);
    return this.loops.ensureLoop({
      loopId,
      bindStateRevision: projection?.stateRevision ?? 0,
      now,
    });
  }

  private assertExternalMessageIdentity(input: {
    workspaceId: WorkspaceId;
    workstreamId: WorkstreamId;
  }): RootRow {
    const root = this.root();
    if (root.parent_workspace_key !== input.workspaceId
      || root.workstream_key !== input.workstreamId) {
      throw new Error("external_message_identity_mismatch");
    }
    return root;
  }

  private externalMessageReplay(
    messageId: string,
    clientMessageId: string,
    createdAt: number,
  ): WorkstreamObjectExternalMessageResult {
    return {
      turn: { turnId: messageId, clientMessageId, createdAt: new Date(createdAt).toISOString() },
      deliveryState: "canonical",
      activationRequest: null,
      inserted: false,
    };
  }

  private externalPendingMessageResult(
    input: PendingLoopInputRow,
    inserted: boolean,
  ): WorkstreamObjectExternalMessageResult {
    const loop = this.loops.loop();
    if (!loop || loop.loop_id !== input.loop_id) throw new Error("substream_loop_not_found");
    return {
      turn: {
        turnId: input.prepared_turn_id,
        clientMessageId: input.client_message_id ?? "",
        createdAt: new Date(input.created_at).toISOString(),
      },
      deliveryState: "pending",
      activationRequest: loop.status === "idle" ? {
        kind: "activate_substream_loop",
        loopId: loop.loop_id,
        cause: "pending_input",
        inputId: input.input_id,
      } : null,
      inserted,
    };
  }

  private async prepareExternalMessage(
    input: AdmitExternalMessageInput | AnswerExternalElicitationInput,
  ) {
    const participant = await this.transcript.prepareParticipantMessage({
      turnId: input.messageId,
      actor: "external",
      authorUserId: null,
      authorSnapshot: null,
      clientMessageId: input.clientMessageId,
      messageType: input.messageType,
      text: input.text,
      structuredContentJson: input.structuredContentJson,
      externalActorJson: JSON.stringify(input.actor),
      producedByRunId: null,
      messageSequenceNumber: this.root().next_sequence_number,
      createdAtUtc: new Date(input.now).toISOString(),
      attentionOrdinal: null,
    });
    const bindMessage = await projectParticipantModelMessage(this.env, {
      author: { type: "external", actor: input.actor },
      messageType: input.messageType,
      text: input.text,
      structuredContent: input.structuredContentJson === null
        ? null : JSON.parse(input.structuredContentJson),
      mentions: [],
      attachments: [],
      includeAttachmentContents: true,
    });
    if (!bindMessage) throw new Error("pending_input_bind_payload_invalid");
    return { participant, bindPayloadJson: canonicalModelMessageJson(bindMessage) };
  }

  private completePreparedExternalMessage(
    input: AdmitExternalMessageInput | AnswerExternalElicitationInput,
    prepared: { participant: PreparedParticipantMessage; bindPayloadJson: string },
    expectedLoopId: string,
  ) {
    const currentLoop = this.loops.loop();
    if (!currentLoop || currentLoop.loop_id !== expectedLoopId) {
      throw new Error("substream_loop_identity_mismatch");
    }
    return this.loops.completeInputPreparation({
      inputId: input.messageId,
      preparedTurnId: input.messageId,
      mode: input.runMode,
      actor: "external",
      authorUserId: null,
      authorNameSnapshot: null,
      authorAvatarUrlSnapshot: null,
      clientMessageId: input.clientMessageId,
      externalActorJson: JSON.stringify(input.actor),
      messageType: input.messageType,
      preparedPayloadId: prepared.participant.fact.payloadId,
      preparedFactId: prepared.participant.fact.factId,
      preparedPayloadAudience: prepared.participant.fact.audience,
      preparedPayloadMediaType: "application/json",
      preparedPayloadJson: prepared.participant.fact.canonical,
      preparedPayloadSha256: prepared.participant.fact.hash,
      preparedPayloadByteLength: new TextEncoder().encode(prepared.participant.fact.canonical).byteLength,
      bindPayloadJson: prepared.bindPayloadJson,
      provenanceJson: JSON.stringify({
        factKind: prepared.participant.fact.factKind,
        originKind: prepared.participant.fact.origin.originKind,
        sourceKind: prepared.participant.fact.origin.sourceKind,
        sourceId: prepared.participant.fact.origin.sourceId,
        sourceRevision: prepared.participant.fact.origin.sourceRevision,
        runId: prepared.participant.fact.runId,
        toolCallId: prepared.participant.fact.toolCallId,
      }),
      authorizationJson: JSON.stringify({
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        executionPrincipal: input.executionPrincipal,
        confirmedParticipantUserIds: [],
        reason: input.origin,
        parentHarnessRunId: input.parentHarnessRunId ?? null,
        ...(input.messageType === "elicitation" ? { elicitationId: input.elicitationId } : {}),
        slackOrigin: input.slackOrigin ?? null,
        slackSearchAuthorization: input.slackSearchAuthorization ?? null,
      }),
      attachmentsJson: "[]",
      mentionsJson: "[]",
      now: input.now,
    });
  }

  /**
   * Admit an invoked connector message as immutable future loop input. No
   * participant turn, attention ordinal, regional effect, or run exists until
   * the loop promotes it at an eligible delivery boundary.
   */
  async admitExternalMessage(
    rawInput: AdmitExternalMessageInput,
  ): Promise<WorkstreamObjectExternalMessageResult> {
    const input = AdmitExternalMessageInputSchema.parse(rawInput);
    const root = this.assertExternalMessageIdentity(input);
    const existing = first(this.storage.sql.exec<{ id: string; created_at: number }>(
      `SELECT id, created_at FROM canonical_conversation_turn_details
        WHERE client_message_id = ?`,
      input.clientMessageId,
    ));
    if (existing) {
      return this.externalMessageReplay(existing.id, input.clientMessageId, existing.created_at);
    }
    const existingPending = this.loops.inputByClientMessageId(input.clientMessageId);
    if (existingPending) return this.externalPendingMessageResult(existingPending, false);
    const preparation = this.reserveInputPreparation({
      root,
      inputId: input.messageId,
      clientMessageId: input.clientMessageId,
      preparationKind: "external_message",
      envelope: { input },
      now: input.now,
    });
    return this.runInputPreparation(preparation, async () => {
      const prepared = await this.prepareExternalMessage({
        ...input,
        messageId: preparation.input_id,
        now: preparation.created_at,
      });
      const admitted = this.storage.transactionSync(() => {
        const concurrentCanonical = first(this.storage.sql.exec<{ id: string; created_at: number }>(
          `SELECT id, created_at FROM canonical_conversation_turn_details
            WHERE client_message_id = ?`,
          input.clientMessageId,
        ));
        if (concurrentCanonical) {
          this.loops.discardInputPreparation({ inputId: preparation.input_id, now: input.now });
          return { kind: "canonical" as const, existing: concurrentCanonical };
        }
        const concurrentPending = this.loops.inputByClientMessageId(input.clientMessageId);
        if (concurrentPending) {
          return { kind: "pending" as const, input: concurrentPending, inserted: false };
        }
        const completed = this.completePreparedExternalMessage({
          ...input,
          messageId: preparation.input_id,
          now: preparation.created_at,
        }, prepared, preparation.loop_id);
        return {
          kind: "pending" as const,
          input: completed.input,
          inserted: completed.outcome === "admitted",
        };
      });
      if (admitted.kind === "canonical") {
        return this.externalMessageReplay(
          admitted.existing.id,
          input.clientMessageId,
          admitted.existing.created_at,
        );
      }
      return this.externalPendingMessageResult(
        admitted.input,
        admitted.inserted,
      );
    });
  }

  /**
   * Answer and publish one external elicitation response atomically. Only the
   * answer that clears the final open elicitation is invoked; earlier answers
   * remain immediate canonical transcript turns.
   */
  async answerExternalElicitation(
    rawInput: AnswerExternalElicitationInput,
  ): Promise<WorkstreamObjectExternalMessageResult> {
    const input = AnswerExternalElicitationInputSchema.parse(rawInput);
    const root = this.assertExternalMessageIdentity(input);
    const canonicalReplay = first(this.storage.sql.exec<{ id: string; created_at: number }>(
      `SELECT id, created_at FROM canonical_conversation_turn_details
        WHERE client_message_id = ?`,
      input.clientMessageId,
    ));
    if (canonicalReplay) {
      return this.externalMessageReplay(
        canonicalReplay.id,
        input.clientMessageId,
        canonicalReplay.created_at,
      );
    }
    const pendingReplay = this.loops.inputByClientMessageId(input.clientMessageId);
    if (pendingReplay) return this.externalPendingMessageResult(pendingReplay, false);
    const preparation = this.reserveInputPreparation({
      root,
      inputId: input.messageId,
      clientMessageId: input.clientMessageId,
      preparationKind: "external_elicitation",
      envelope: { input },
      now: input.now,
    });
    return this.runInputPreparation(preparation, async () => {
      const preparedInput = {
        ...input,
        messageId: preparation.input_id,
        now: preparation.created_at,
      };
      const prepared = await this.prepareExternalMessage(preparedInput);
      const committed = await this.objectStore.commitWithRegionalEffects(
        () => {
          const canonical = first(this.storage.sql.exec<{ id: string; created_at: number }>(
            `SELECT id, created_at FROM canonical_conversation_turn_details
              WHERE client_message_id = ?`,
            input.clientMessageId,
          ));
          if (canonical) {
            this.loops.discardInputPreparation({ inputId: preparation.input_id, now: input.now });
            return { kind: "replayed_canonical" as const, canonical };
          }
          const pending = this.loops.inputByClientMessageId(input.clientMessageId);
          if (pending) return { kind: "replayed_pending" as const, input: pending };
          const answeringUserId = input.executionPrincipal.type === "user"
            ? input.executionPrincipal.userId : null;
          const open = first(this.storage.sql.exec<{ ok: number }>(
            `SELECT 1 AS ok FROM elicitation_requests
              WHERE elicitation_id = ? AND status = 'pending'
                AND (target_user_id IS NULL OR target_user_id = ?)`,
            input.elicitationId,
            answeringUserId,
          ));
          if (!open) {
            const stillPending = first(this.storage.sql.exec<{ ok: number }>(
              `SELECT 1 AS ok FROM elicitation_requests
                WHERE elicitation_id = ? AND status = 'pending'`,
              input.elicitationId,
            ));
            if (stillPending) {
              throw new ApiError(403, "elicitation_target_mismatch", "This question is targeted to another participant");
            }
            this.loops.discardInputPreparation({ inputId: preparation.input_id, now: input.now });
            return { kind: "already_answered" as const };
          }
          const answered = this.storage.sql.exec<{ elicitation_id: string }>(
            `UPDATE elicitation_requests
                SET status = 'answered', answer_json = ?, answered_by_user_id = NULL,
                    external_actor_json = ?, answered_at = ?
              WHERE elicitation_id = ? AND status = 'pending'
                AND (target_user_id IS NULL OR target_user_id = ?)
            RETURNING elicitation_id`,
            input.answerJson,
            JSON.stringify(input.actor),
            input.now,
            input.elicitationId,
            answeringUserId,
          );
          if (answered.toArray().length !== 1) {
            throw new ApiError(409, "elicitation_already_answered", "This question was answered by someone else");
          }
          const remaining = Number(first(this.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM elicitation_requests WHERE status = 'pending'`,
          ))?.count ?? 0);
          if (remaining === 0) {
            return {
              kind: "pending" as const,
              input: this.completePreparedExternalMessage(
                preparedInput,
                prepared,
                preparation.loop_id,
              ).input,
            };
          }
          const current = this.root();
          prepared.participant.input.messageSequenceNumber = current.next_sequence_number;
          prepared.participant.input.attentionOrdinal = current.next_attention_ordinal;
          const sequenceNumber = this.transcript.appendPreparedParticipantMessage(prepared.participant);
          this.storage.sql.exec(
            `UPDATE workstream
                SET next_sequence_number = next_sequence_number + 1,
                    next_attention_ordinal = next_attention_ordinal + 1,
                    last_people_activity_at = ?, updated_at = ?
              WHERE id = 1`,
            input.now,
            input.now,
          );
          this.loops.discardInputPreparation({ inputId: preparation.input_id, now: input.now });
          return { kind: "canonical" as const, sequenceNumber };
        },
        (_sql, result) => result.kind === "canonical"
          ? [{ partitionKey: "common", effect: this.commonEffect(this.root()) }]
          : [],
      );
      const result = committed.result;
      if (result.kind === "replayed_canonical") {
        return this.externalMessageReplay(
          result.canonical.id,
          input.clientMessageId,
          result.canonical.created_at,
        );
      }
      if (result.kind === "replayed_pending") {
        return this.externalPendingMessageResult(result.input, false);
      }
      if (result.kind === "already_answered") {
        throw new ApiError(
          409,
          "elicitation_already_answered",
          "This question was answered by someone else",
        );
      }
      if (result.kind === "pending") return this.externalPendingMessageResult(result.input, true);
      return {
        turn: {
          turnId: preparation.input_id,
          clientMessageId: input.clientMessageId,
          createdAt: new Date(preparation.created_at).toISOString(),
        },
        deliveryState: "canonical",
        activationRequest: null,
        inserted: true,
      };
    });
  }

  async createMessage(
    auth: AuthContext,
    rawInput: WorkstreamObjectCreateMessageInput,
  ): Promise<WorkstreamObjectCreateMessageResult> {
    const input = WorkstreamObjectCreateMessageInputSchema.parse(rawInput);
    const localRoot = this.locallyAuthorizedRoot(auth);
    const existing = first(this.storage.sql.exec<{
      id: string; created_at: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT id, created_at FROM canonical_conversation_turn_details WHERE client_message_id = ?`,
      input.clientMessageId,
    ));
    if (existing) {
      await this.authorize(auth);
      return this.canonicalMessageReplay(existing, input.clientMessageId);
    }
    const existingPending = this.loops.inputByClientMessageId(input.clientMessageId);
    if (existingPending) {
      const root = await this.authorize(auth);
      const loop = this.loops.loop();
      if (!loop || loop.loop_id !== existingPending.loop_id
        || loop.loop_id !== substreamLoopId(asWorkstreamId(root.workstream_key))) {
        throw new Error("substream_loop_identity_mismatch");
      }
      return this.pendingMessageResult(existingPending, false);
    }
    const reservationNow = Date.now();
    const preparation = this.reserveInputPreparation({
      root: localRoot,
      inputId: uuidV7(reservationNow),
      clientMessageId: input.clientMessageId,
      preparationKind: "human_message",
      envelope: { auth, input },
      now: reservationNow,
    });
    return this.runInputPreparation(preparation, async () => {
    const root = await this.authorize(auth);

    const requestedPersonIds = [...new Set(input.mentions.flatMap((mention) =>
      mention.type === "person" && mention.userId ? [mention.userId] : []))];
    const allMemberIds = [...new Set([auth.userId, ...requestedPersonIds, ...input.confirmedParticipantUserIds])];
    const people = new Map<string, MentionPerson>();
    if (allMemberIds.length > 0) {
      const placeholders = allMemberIds.map(() => "?").join(",");
      const result = await this.env.DB.prepare(
        `SELECT user.id, user.name, user.avatar_url
           FROM workspace_members member JOIN users user ON user.id = member.user_id
          WHERE member.workspace_id = ? AND member.status = 'active'
            AND user.id IN (${placeholders})`,
      ).bind(auth.workspaceId, ...allMemberIds).all<{
        id: string; name: string; avatar_url: string | null;
      }>();
      for (const row of result.results ?? []) {
        people.set(row.id, { id: row.id, name: row.name, avatarUrl: row.avatar_url });
      }
      if (people.size !== allMemberIds.length) {
        throw new ApiError(422, "invalid_workspace_member", "A mentioned person is not an active workspace member");
      }
    }
    const prepared = prepareMentionMarkdown(input.text, input.mentions, people);
    const personIds = [...new Set(prepared.mentions.flatMap((mention) =>
      mention.type === "person" && mention.userId ? [mention.userId] : []))];
    // Confirmation is authority for an accepted mention, not a second generic
    // participant-add API. A malformed or spoofed range cannot smuggle its raw
    // target into the audience after canonicalization rejects it.
    const confirmedParticipantUserIds = input.confirmedParticipantUserIds.filter((userId) => personIds.includes(userId));
    if (root.scope === "personal" && confirmedParticipantUserIds.length > 0) {
      const currentAudience = this.readerAudience(root);
      if (currentAudience.scope !== "personal") throw new Error("personal_reader_audience_expected");
      this.assertAcceptedContentContains({
        scope: "personal",
        userIds: [...new Set([...currentAudience.userIds, ...confirmedParticipantUserIds])],
      });
    }
    const unconfirmed = personIds.filter((userId) =>
      !this.isParticipant(userId) && !confirmedParticipantUserIds.includes(userId));
    if (root.scope === "personal" && unconfirmed.length > 0) {
      throw new ApiError(409, "participant_confirmation_required", "Confirm before mentioning a nonparticipant", {
        people: unconfirmed.map((userId) => ({ userId, name: people.get(userId)?.name ?? "Workspace member" })),
      });
    }
    const attachmentRows = await this.reserveAttachmentDrafts({
      workspaceId: auth.workspaceId,
      workstreamId: root.workstream_key,
      inputId: preparation.input_id,
      userId: auth.userId,
      resourceIds: input.attachmentIds,
      now: preparation.created_at,
    });

    const participantCount = Number(first(this.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM participants WHERE status = 'active'`,
    ))?.count ?? 0);
    const connectorMentions = prepared.mentions
      .flatMap((mention) => mention.type === "connector" && mention.connectorType
        ? [mention.connectorType] : []);
    let shouldInvoke = Boolean(input.forcedHarnessOrigin) || participantCount <= 1 || attachmentRows.length > 0;
    if (!shouldInvoke) {
      const activeTask = this.loops.loop()?.status === "executing";
      const classification = await classifyWorkstreamMessage(this.env, {
        workspaceId: auth.workspaceId,
        workstreamId: root.workstream_key,
        userId: auth.userId,
        message: input.text,
        activeTask,
        connectorMentions,
        recentMessages: await this.recentAddressingMessages(Number(this.storage.sql.exec<{
          next_transcript_sequence: number;
        } & Record<string, SqlStorageValue>>(
          `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
        ).one().next_transcript_sequence)),
      });
      shouldInvoke = classification.classification === "agent_action"
        || classification.classification === "both"
        || (classification.classification === "uncertain" && (activeTask || connectorMentions.length > 0));
    }
    const now = preparation.created_at;
    const messageId = preparation.input_id;
    const transcriptMessage = await this.transcript.prepareParticipantMessage({
      turnId: messageId,
      actor: "human",
      authorUserId: auth.userId,
      authorSnapshot: {
        displayName: people.get(auth.userId)?.name ?? UNKNOWN_MEMBER_DISPLAY_NAME,
        avatarUrl: people.get(auth.userId)?.avatarUrl ?? null,
      },
      clientMessageId: input.clientMessageId,
      messageType: "text",
      text: prepared.text,
      structuredContentJson: null,
      externalActorJson: null,
      producedByRunId: null,
      messageSequenceNumber: root.next_sequence_number,
      createdAtUtc: new Date(now).toISOString(),
      attentionOrdinal: root.next_attention_ordinal,
    });
    if (shouldInvoke) {
      const modelAttachments: ModelAttachmentSource[] = attachmentRows.map((row) => ({
        id: String(row.id),
        workspaceId: auth.workspaceId,
        fileName: String(row.title),
        mimeType: row.mime_type == null ? "application/octet-stream" : String(row.mime_type),
        sizeBytes: attachmentMetadataSize(row.metadata_json),
        contentRef: row.content_ref == null ? null : String(row.content_ref),
        contentSha256: row.content_sha256 == null ? null : String(row.content_sha256),
        modelContentRef: row.model_content_ref == null ? null : String(row.model_content_ref),
        modelMimeType: row.model_mime_type == null ? null : String(row.model_mime_type),
        modelContentSha256: row.model_content_sha256 == null ? null : String(row.model_content_sha256),
        modelMetadataJson: row.model_metadata_json == null ? null : String(row.model_metadata_json),
        ...(row.model_content_status == null ? {} : {
          modelContentStatus: String(row.model_content_status) as NonNullable<
            ModelAttachmentSource["modelContentStatus"]
          >,
        }),
        modelContentExtractorVersion: row.model_content_extractor_version == null
          ? null : String(row.model_content_extractor_version),
        modelContentErrorCode: row.model_content_error_code == null
          ? null : String(row.model_content_error_code),
      }));
      const bindMessage = await projectParticipantModelMessage(this.env, {
        author: { type: "human" },
        messageType: "text",
        text: prepared.text,
        structuredContent: null,
        mentions: prepared.mentions.map((mention) => ({
          type: mention.type,
          userId: mention.userId,
          displayName: mention.userId ? people.get(mention.userId)?.name ?? null : null,
        })),
        attachments: modelAttachments,
        includeAttachmentContents: true,
      });
      if (!bindMessage) throw new Error("pending_input_bind_payload_invalid");
      const bindPayloadJson = canonicalModelMessageJson(bindMessage);
      const loop = this.loops.loop();
      if (!loop) throw new Error("substream_loop_not_initialized");
      if (loop.loop_id !== substreamLoopId(asWorkstreamId(root.workstream_key))) {
        throw new Error("substream_loop_identity_mismatch");
      }
      const attachmentDescriptors = input.attachmentIds.map((resourceId, position) => {
        const row = attachmentRows.find((candidate) => String(candidate.id) === resourceId)!;
        return {
          resourceId,
          position,
          attachmentJson: JSON.stringify({ attachedAt: new Date(now).toISOString() }),
          attachedByUserId: auth.userId,
          watchEnabled: false,
          relationshipType: "message_attachment",
          resourceJson: JSON.stringify({
            id: resourceId,
            connectionId: row.connection_id == null ? null : String(row.connection_id),
            type: String(row.resource_type),
            provider: String(row.provider),
            providerResourceId: row.provider_resource_id == null ? null : String(row.provider_resource_id),
            title: String(row.title),
            mimeType: row.mime_type == null ? null : String(row.mime_type),
            contentRef: row.content_ref == null ? null : String(row.content_ref),
            canonicalUrl: row.canonical_url == null ? null : String(row.canonical_url),
            metadata: parseJson(String(row.metadata_json ?? "{}"), {}),
          }),
          attachedAt: now,
          updatedAt: now,
        };
      });
      const mentions = prepared.mentions.map((mention, mentionIndex) => ({
        mentionIndex,
        mentionKind: mention.type,
        targetUserId: mention.userId,
        connectorType: mention.connectorType,
        startOffset: mention.startOffset,
        endOffset: mention.endOffset,
      }));
      const admitted = this.storage.transactionSync(() => {
        const concurrentCanonical = first(this.storage.sql.exec<{
          id: string;
          created_at: number;
        } & Record<string, SqlStorageValue>>(
          `SELECT id, created_at FROM canonical_conversation_turn_details
            WHERE client_message_id = ?`,
          input.clientMessageId,
        ));
        if (concurrentCanonical) {
          this.markAttachmentReleaseOwnedByProjection(preparation.input_id);
          this.loops.discardInputPreparation({ inputId: preparation.input_id, now });
          return { kind: "canonical" as const, existing: concurrentCanonical };
        }
        const concurrentPending = this.loops.inputByClientMessageId(input.clientMessageId);
        if (concurrentPending) {
          return { kind: "pending" as const, input: concurrentPending, inserted: false };
        }
        const currentLoop = this.loops.loop();
        if (!currentLoop || currentLoop.loop_id !== loop.loop_id) {
          throw new Error("substream_loop_identity_mismatch");
        }
        if (input.expectedLatestHarnessRunId) {
          const latest = first(this.storage.sql.exec<{ run_id: string }>(
            `SELECT run_id FROM runs WHERE parent_tool_call_id IS NULL
              AND origin != 'block_dashboard_block' ORDER BY created_at DESC, run_id DESC LIMIT 1`,
          ));
          if (latest?.run_id !== input.expectedLatestHarnessRunId) {
            throw new ApiError(409, "terminal_repository_request_stale", "The work stream changed before this message was admitted");
          }
        }
        const result = this.loops.completeInputPreparation({
          inputId: messageId,
          preparedTurnId: messageId,
          mode: input.runMode ?? "queue",
          actor: "human",
          authorUserId: auth.userId,
          authorNameSnapshot: transcriptMessage.input.authorSnapshot?.displayName ?? null,
          authorAvatarUrlSnapshot: transcriptMessage.input.authorSnapshot?.avatarUrl ?? null,
          clientMessageId: input.clientMessageId,
          externalActorJson: null,
          messageType: "text",
          preparedPayloadId: transcriptMessage.fact.payloadId,
          preparedFactId: transcriptMessage.fact.factId,
          preparedPayloadAudience: transcriptMessage.fact.audience,
          preparedPayloadMediaType: "application/json",
          preparedPayloadJson: transcriptMessage.fact.canonical,
          preparedPayloadSha256: transcriptMessage.fact.hash,
          preparedPayloadByteLength: new TextEncoder().encode(transcriptMessage.fact.canonical).byteLength,
          bindPayloadJson,
          provenanceJson: JSON.stringify({
            factKind: transcriptMessage.fact.factKind,
            originKind: transcriptMessage.fact.origin.originKind,
            sourceKind: transcriptMessage.fact.origin.sourceKind,
            sourceId: transcriptMessage.fact.origin.sourceId,
            sourceRevision: transcriptMessage.fact.origin.sourceRevision,
            runId: transcriptMessage.fact.runId,
            toolCallId: transcriptMessage.fact.toolCallId,
          }),
          authorizationJson: JSON.stringify({
            workspaceId: auth.workspaceId,
            workstreamId: root.workstream_key,
            executionPrincipal: { type: "user", userId: auth.userId },
            sessionId: auth.sessionId,
            principal: auth.principal ?? "session",
            confirmedParticipantUserIds,
            participantEpochs: this.pendingParticipantEpochs([
              auth.userId,
              ...confirmedParticipantUserIds,
            ]),
            reason: input.forcedHarnessOrigin ?? "human_message",
            parentHarnessRunId: input.parentHarnessRunId ?? null,
            expectedLatestHarnessRunId: input.expectedLatestHarnessRunId ?? null,
            expectedToolInvocationId: input.expectedToolInvocationId ?? null,
            telemetryOperationId: input.telemetryOperationId ?? null,
            slackOrigin: input.slackOrigin ?? null,
            slackSearchAuthorization: input.slackSearchAuthorization ?? null,
          }),
          attachmentsJson: JSON.stringify(attachmentDescriptors),
          mentionsJson: JSON.stringify(mentions),
          now,
        });
        return {
          kind: "pending" as const,
          input: result.input,
          inserted: result.outcome === "admitted",
        };
      });
      if (admitted.kind === "canonical") {
        return this.canonicalMessageReplay(admitted.existing, input.clientMessageId);
      }
      return this.pendingMessageResult(admitted.input, admitted.inserted);
    }
    const affectedUsers = [...new Set([auth.userId, ...personIds, ...confirmedParticipantUserIds])];
    const committed = await this.objectStore.commitWithRegionalEffects<LocalMessageWrite>(
      (sql) => {
        const current = first(sql.exec<RootRow>(`SELECT * FROM workstream WHERE id = 1`));
        if (!current) throw new ApiError(404, "workstream_not_found", "Work stream not found");
        const replay = first(sql.exec<{
          id: string; sequence_number: number; attention_ordinal: number | null; created_at: number;
        } & Record<string, SqlStorageValue>>(
          `SELECT id, sequence_number, attention_ordinal, created_at
             FROM canonical_conversation_turn_details WHERE client_message_id = ?`,
          input.clientMessageId,
        ));
        if (replay) {
          if (replay.attention_ordinal == null) {
            throw new Error("replayed_message_missing_attention_ordinal");
          }
          this.markAttachmentReleaseOwnedByProjection(preparation.input_id);
          this.loops.discardInputPreparation({ inputId: preparation.input_id, now });
          return {
            messageId: replay.id,
            sequenceNumber: replay.sequence_number,
            attentionOrdinal: replay.attention_ordinal,
            createdAt: replay.created_at,
            inserted: false,
          };
        }
        const sequence = current.next_sequence_number;
        const attention = current.next_attention_ordinal;
        sql.exec(
          `INSERT INTO participants
             (user_id, participation_reason, added_by_user_id, status, participant_epoch,
              added_at, removed_at, first_opened_at, updated_at)
           VALUES (?, 'message', ?, 'active', 0, ?, NULL, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             status = 'active', removed_at = NULL,
             participant_epoch = CASE WHEN participants.status = 'removed'
               THEN participants.participant_epoch + 1 ELSE participants.participant_epoch END,
             participation_reason = CASE WHEN participants.status = 'removed'
               THEN 'message' ELSE participants.participation_reason END,
             added_by_user_id = CASE WHEN participants.status = 'removed'
               THEN excluded.added_by_user_id ELSE participants.added_by_user_id END,
             added_at = CASE WHEN participants.status = 'removed'
               THEN excluded.added_at ELSE participants.added_at END,
             first_opened_at = COALESCE(participants.first_opened_at, excluded.first_opened_at),
             updated_at = excluded.updated_at`,
          // Writing into a work stream is a stronger statement than opening it.
          auth.userId, auth.userId, now, now, now,
        );
        for (const userId of confirmedParticipantUserIds) {
          sql.exec(
            `INSERT INTO participants
               (user_id, participation_reason, added_by_user_id, status, participant_epoch,
                added_at, removed_at, first_opened_at, updated_at)
             VALUES (?, 'explicit', ?, 'active', 0, ?, NULL, NULL, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               status = 'active', removed_at = NULL,
               participant_epoch = CASE WHEN participants.status = 'removed'
                 THEN participants.participant_epoch + 1 ELSE participants.participant_epoch END,
               first_opened_at = CASE WHEN participants.status = 'removed'
                 THEN NULL ELSE participants.first_opened_at END,
               updated_at = excluded.updated_at`,
            // Somebody the author named on the way past. They have not been
            // here, which is exactly what the dot is for.
            userId, auth.userId, now, now,
          );
        }
        transcriptMessage.input.attentionOrdinal = attention;
        transcriptMessage.input.messageSequenceNumber = sequence;
        const transcriptSequence = this.transcript.appendPreparedParticipantMessage(transcriptMessage);
        input.attachmentIds.forEach((resourceId, position) => {
          const row = attachmentRows.find((candidate) => String(candidate.id) === resourceId)!;
          const descriptor = {
            id: resourceId,
            connectionId: row.connection_id == null ? null : String(row.connection_id),
            type: String(row.resource_type),
            provider: String(row.provider),
            providerResourceId: row.provider_resource_id == null ? null : String(row.provider_resource_id),
            title: String(row.title),
            mimeType: row.mime_type == null ? null : String(row.mime_type),
            contentRef: row.content_ref == null ? null : String(row.content_ref),
            canonicalUrl: row.canonical_url == null ? null : String(row.canonical_url),
            metadata: parseJson(String(row.metadata_json ?? "{}"), {}),
          };
          sql.exec(
            `INSERT INTO participant_transcript_attachments(turn_id, resource_id, position, attachment_json)
             VALUES (?, ?, ?, ?)`,
            messageId, resourceId, position, JSON.stringify({ attachedAt: new Date(now).toISOString() }),
          );
          sql.exec(
            `INSERT INTO workstream_resource_links
               (resource_id, attached_by_user_id, watch_enabled, relationship_type,
                resource_json, attached_at, updated_at)
             VALUES (?, ?, 0, 'message_attachment', ?, ?, ?)
             ON CONFLICT(resource_id) DO NOTHING`,
            resourceId, auth.userId, JSON.stringify(descriptor), now, now,
          );
        });
        prepared.mentions.forEach((mention, index) => {
          sql.exec(
            `INSERT INTO participant_transcript_mentions
               (turn_id, mention_index, mention_kind, target_user_id, connector_type,
                start_offset, end_offset, attention_ordinal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            messageId, index, mention.type, mention.userId, mention.connectorType,
            mention.startOffset, mention.endOffset, attention,
          );
          if (mention.type === "person" && mention.userId) {
            sql.exec(
              `INSERT INTO member_attention
                 (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
                  manual_unread_from_ordinal, latest_mention_attention_ordinal,
                  last_seen_at, version, updated_at)
               VALUES (?, ?, ?, NULL, ?, ?, 0, ?)
               ON CONFLICT(user_id) DO UPDATE SET
                 latest_mention_attention_ordinal = MAX(
                   member_attention.latest_mention_attention_ordinal,
                   excluded.latest_mention_attention_ordinal
                 ), updated_at = excluded.updated_at`,
              mention.userId, current.unread_tracking_start_ordinal,
              current.unread_tracking_start_ordinal, attention, now, now,
            );
          }
        });
        sql.exec(
          `INSERT INTO member_attention
             (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
              manual_unread_from_ordinal, latest_mention_attention_ordinal,
              last_seen_at, version, updated_at)
           VALUES (?, ?, ?, NULL, 0, ?, 0, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             seen_attention_ordinal = MAX(member_attention.seen_attention_ordinal, excluded.seen_attention_ordinal),
             manual_unread_from_ordinal = NULL, last_seen_at = excluded.last_seen_at,
             updated_at = excluded.updated_at`,
          auth.userId, current.unread_tracking_start_ordinal, attention, now, now,
        );
        sql.exec(
          `UPDATE workstream
              SET next_sequence_number = next_sequence_number + 1,
                  next_attention_ordinal = next_attention_ordinal + 1,
                  last_people_activity_at = ?, updated_at = ?
            WHERE id = 1`,
          now, now,
        );
        this.markAttachmentReleaseOwnedByProjection(preparation.input_id);
        this.loops.discardInputPreparation({ inputId: preparation.input_id, now });
        return {
          messageId,
          sequenceNumber: transcriptSequence,
          attentionOrdinal: attention,
          createdAt: now,
          inserted: true,
        };
      },
      (_sql, write) => {
        if (!write.inserted) return [];
        const current = this.root();
        const common = { partitionKey: "common", effect: this.commonEffect(current) };
        const userEffects = affectedUsers.map((userId) => ({
          partitionKey: `user:${userId}`,
          effect: this.userEffect(current, userId),
        }));
        const occurredAt = new Date(now).toISOString();
        const activityId = uuidV7(now);
        const activity = {
          partitionKey: `activity:${messageId}`,
          sourceVersion: 1,
          dedupeKey: `message:${messageId}`,
          effect: {
            kind: "activity_event" as const,
            eventId: activityId,
            eventType: "workstream_message_created",
            subjectSequenceNumber: write.sequenceNumber,
            actorType: "user" as const,
            actorUserId: auth.userId,
            actorLabel: people.get(auth.userId)?.name ?? "Workspace member",
            title: truncateUtf16Safe(current.title, 500),
            body: truncateUtf16Safe(prepared.text, 8_000),
            canonicalUrl: null,
            digestible: true,
            occurredAt,
            sourceKind: "workstream_message",
            sourceId: messageId,
            dedupeKey: `message:${messageId}`,
            metadata: {},
            targets: affectedUsers.map((userId) => ({ userId, relation: "participant" })),
          },
        };
        const notifications = personIds.filter((userId) => userId !== auth.userId).map((userId) => ({
          partitionKey: `notification:${messageId}:${userId}`,
          sourceVersion: 1,
          dedupeKey: `mention:${messageId}:${userId}`,
          dependsOnProjectionKey: `user:${userId}`,
          effect: {
            kind: "mention_notification" as const,
            intentId: `mention:${messageId}:${userId}`,
            messageId,
            recipientUserId: userId,
            authorUserId: auth.userId,
            authorNameSnapshot: people.get(auth.userId)?.name ?? "Workspace member",
            workstreamTitleSnapshot: truncateUtf16Safe(current.title, 500),
            messageText: truncateUtf16Safe(prepared.text, 8_000),
            occurredAt,
          },
        }));
        return [common, ...userEffects, activity, ...notifications];
      },
    );
    return {
      turn: {
        turnId: committed.result.messageId,
        clientMessageId: input.clientMessageId,
        createdAt: new Date(committed.result.createdAt).toISOString(),
      },
      deliveryState: "canonical",
      activationRequest: null,
      inserted: committed.result.inserted,
    };
    });
  }

  async answerElicitation(
    auth: AuthContext,
    elicitationId: string,
    rawInput: WorkstreamObjectAnswerElicitationInput,
  ): Promise<WorkstreamObjectAnswerElicitationResult> {
    const input = AnswerElicitationRequestSchema.parse(rawInput);
    const clientMessageId = `elicitation-response:${elicitationId}`;
    const canonicalReplay = first(this.storage.sql.exec<{
      id: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT id FROM canonical_conversation_turn_details WHERE client_message_id = ?`,
      clientMessageId,
    ));
    if (canonicalReplay) {
      await this.authorize(auth);
      return {
        elicitation: this.elicitationsIncludingResolved().find((entry) => entry.id === elicitationId),
        responsePartId: canonicalReplay.id,
        activationRequest: null,
      };
    }
    const replay = this.loops.inputByClientMessageId(clientMessageId);
    if (replay) {
      const root = await this.authorize(auth);
      const loop = this.loops.loop();
      if (!loop || loop.loop_id !== replay.loop_id
        || loop.loop_id !== substreamLoopId(asWorkstreamId(root.workstream_key))) {
        throw new Error("substream_loop_identity_mismatch");
      }
      return {
        elicitation: this.elicitationsIncludingResolved().find((entry) => entry.id === elicitationId),
        responsePartId: replay.prepared_turn_id,
        activationRequest: loop.status === "idle" ? {
          kind: "activate_substream_loop",
          loopId: loop.loop_id,
          cause: "pending_input",
          inputId: replay.input_id,
        } : null,
      };
    }
    const localRoot = this.locallyAuthorizedRoot(auth);
    const reservationNow = Date.now();
    const preparation = this.reserveInputPreparation({
      root: localRoot,
      inputId: uuidV7(reservationNow),
      clientMessageId,
      preparationKind: "human_elicitation",
      envelope: { auth, elicitationId, input },
      now: reservationNow,
    });
    return this.runInputPreparation(preparation, async () => {
    const root = await this.authorize(auth);
    const row = first(this.storage.sql.exec<{
      elicitation_id: string; run_id: string; prompt: string; response_type: string;
      options_json: string; minimum_selections: number; maximum_selections: number | null;
      target_user_id: string | null; status: string; created_at: number;
    }>(
      `SELECT elicitation_id, run_id, prompt, response_type, options_json,
              minimum_selections, maximum_selections, target_user_id, status, created_at
         FROM elicitation_requests WHERE elicitation_id = ? AND status = 'pending'`,
      elicitationId,
    ));
    if (!row) throw new ApiError(404, "elicitation_not_found", "This question is no longer open");
    if (row.target_user_id !== null && row.target_user_id !== auth.userId) {
      throw new ApiError(403, "elicitation_target_mismatch", "This question is targeted to another participant");
    }
    const skipped = "skipped" in input && input.skipped;
    const answer = skipped ? null : input.answer;
    if (!skipped) this.validateElicitationAnswer(row, input.answer, input.customResponse);
    const now = preparation.created_at;
    const responsePartId = preparation.input_id;
    const author = (await this.messageUsers([auth.userId])).get(auth.userId);
    const persisted: Elicitation = {
      id: elicitationId,
      workstreamId: root.workstream_key,
      harnessRunId: row.run_id,
      prompt: row.prompt,
      responseType: row.response_type as Elicitation["responseType"],
      options: parseJson(row.options_json, []),
      minimumSelections: row.minimum_selections,
      maximumSelections: row.maximum_selections,
      targetUserId: row.target_user_id,
      status: "answered",
      answer,
      answeredByUserId: auth.userId,
      createdAt: iso(row.created_at)!,
      answeredAt: iso(now),
    };
    const structuredResponse = JSON.stringify({ kind: "elicitation_response", elicitation: persisted });
    const transcriptMessage = await this.transcript.prepareParticipantMessage({
      turnId: responsePartId,
      actor: "human",
      authorUserId: auth.userId,
      authorSnapshot: {
        displayName: author?.name ?? UNKNOWN_MEMBER_DISPLAY_NAME,
        avatarUrl: author?.avatar_url ?? null,
      },
      clientMessageId,
      messageType: "elicitation",
      text: "",
      structuredContentJson: structuredResponse,
      externalActorJson: null,
      producedByRunId: null,
      createdAtUtc: new Date(now).toISOString(),
      attentionOrdinal: null,
    });
    const bindMessage = await projectParticipantModelMessage(this.env, {
      author: { type: "human" },
      messageType: "elicitation",
      text: "",
      structuredContent: JSON.parse(structuredResponse),
      mentions: [],
      attachments: [],
      includeAttachmentContents: true,
    });
    if (!bindMessage) throw new Error("pending_input_bind_payload_invalid");
    const bindPayloadJson = canonicalModelMessageJson(bindMessage);
    const loop = this.loops.loop();
    if (!loop) throw new Error("substream_loop_not_initialized");
    if (loop.loop_id !== substreamLoopId(asWorkstreamId(root.workstream_key))) {
      throw new Error("substream_loop_identity_mismatch");
    }
    let remaining = 0;
    const admitted = this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const current = first(sql.exec<RootRow>(`SELECT * FROM workstream WHERE id = 1`));
      if (!current) throw new ApiError(404, "workstream_not_found", "Work stream not found");
      const changed = sql.exec<{ elicitation_id: string }>(
        `UPDATE elicitation_requests SET status = 'answered', answer_json = ?,
                answered_by_user_id = ?, answered_at = ?
          WHERE elicitation_id = ? AND status = 'pending'
          RETURNING elicitation_id`,
        answer === null ? null : JSON.stringify(answer), auth.userId, now, elicitationId,
      );
      if (changed.toArray().length !== 1) {
        throw new ApiError(409, "elicitation_already_answered", "This question was answered by someone else");
      }
      remaining = Number(first(sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM elicitation_requests WHERE status = 'pending'`,
      ))?.count ?? 0);
      return this.loops.completeInputPreparation({
        inputId: responsePartId,
        preparedTurnId: responsePartId,
        mode: "steer",
        actor: "human",
        authorUserId: auth.userId,
        authorNameSnapshot: transcriptMessage.input.authorSnapshot?.displayName ?? null,
        authorAvatarUrlSnapshot: transcriptMessage.input.authorSnapshot?.avatarUrl ?? null,
        clientMessageId,
        externalActorJson: null,
        messageType: "elicitation",
        preparedPayloadId: transcriptMessage.fact.payloadId,
        preparedFactId: transcriptMessage.fact.factId,
        preparedPayloadAudience: transcriptMessage.fact.audience,
        preparedPayloadMediaType: "application/json",
        preparedPayloadJson: transcriptMessage.fact.canonical,
        preparedPayloadSha256: transcriptMessage.fact.hash,
        preparedPayloadByteLength: new TextEncoder().encode(transcriptMessage.fact.canonical).byteLength,
        bindPayloadJson,
        provenanceJson: JSON.stringify({
          factKind: transcriptMessage.fact.factKind,
          originKind: transcriptMessage.fact.origin.originKind,
          sourceKind: transcriptMessage.fact.origin.sourceKind,
          sourceId: transcriptMessage.fact.origin.sourceId,
          sourceRevision: transcriptMessage.fact.origin.sourceRevision,
          runId: transcriptMessage.fact.runId,
          toolCallId: transcriptMessage.fact.toolCallId,
        }),
        authorizationJson: JSON.stringify({
          workspaceId: auth.workspaceId,
          workstreamId: root.workstream_key,
          executionPrincipal: { type: "user", userId: auth.userId },
          sessionId: auth.sessionId,
          principal: auth.principal ?? "session",
          confirmedParticipantUserIds: [],
          participantEpochs: this.pendingParticipantEpochs([auth.userId]),
          reason: "elicitation_answer",
          elicitationId,
          parentHarnessRunId: row.run_id,
        }),
        attachmentsJson: "[]",
        mentionsJson: "[]",
        now,
      });
    });
    const answered = this.elicitationsIncludingResolved().find((entry) => entry.id === elicitationId);
    const after = this.loops.loop();
    if (!after) throw new Error("substream_loop_not_found");
    return {
      elicitation: answered,
      responsePartId: admitted.input.prepared_turn_id,
      activationRequest: remaining === 0 && after.status === "idle" ? {
        kind: "activate_substream_loop",
        loopId: after.loop_id,
        cause: "pending_input",
        inputId: admitted.input.input_id,
      } : null,
    };
    });
  }

  private validateElicitationAnswer(
    elicitation: { response_type: string; options_json: string; minimum_selections: number; maximum_selections: number | null },
    answer: string | string[],
    customResponse?: string,
  ): void {
    const type = elicitation.response_type;
    if (type === "text" && typeof answer !== "string") {
      throw new ApiError(422, "invalid_elicitation_answer", "This question requires text");
    }
    if (type === "multi_select" && !Array.isArray(answer)) {
      throw new ApiError(422, "invalid_elicitation_answer", "This question requires one or more selections");
    }
    if (type !== "text" && type !== "multi_select" && Array.isArray(answer)) {
      throw new ApiError(422, "invalid_elicitation_answer", "This question requires one selection");
    }
    const values = Array.isArray(answer) ? answer : [answer];
    const options = parseJson<Array<{ value: string }>>(elicitation.options_json, []);
    if (type !== "text") {
      const customMatches = customResponse == null
        ? 0
        : values.filter((value) => value === customResponse).length;
      if (customResponse != null && customMatches !== 1) {
        throw new ApiError(422, "invalid_custom_elicitation_answer", "The custom response is not part of the answer");
      }
      if (values.some((value) =>
        !options.some((option) => option.value === value) && value !== customResponse)) {
        throw new ApiError(422, "invalid_elicitation_option", "An answer is not one of the available choices");
      }
    }
    if (
      values.length < elicitation.minimum_selections
      || (elicitation.maximum_selections !== null && values.length > elicitation.maximum_selections)
    ) {
      throw new ApiError(422, "invalid_selection_count", "The answer has an invalid number of selections");
    }
  }

  async reorderPendingInputs(
    auth: AuthContext,
    inputIds: readonly string[],
  ): Promise<{ pendingInputs: PendingTranscriptInput[] }> {
    const root = await this.authorize(auth);
    const loop = this.loops.loop();
    if (!loop) throw new Error("substream_loop_not_initialized");
    if (loop.loop_id !== substreamLoopId(asWorkstreamId(root.workstream_key))) {
      throw new Error("substream_loop_identity_mismatch");
    }
    this.loops.reorderPendingInputs({ inputIds, now: Date.now() });
    return { pendingInputs: this.transcript.pendingTranscriptInputs() };
  }

  async stop(auth: AuthContext): Promise<void> {
    const root = await this.authorize(auth);
    const loop = this.loops.loop();
    if (!loop) throw new Error("substream_loop_not_initialized");
    if (loop.loop_id !== substreamLoopId(asWorkstreamId(root.workstream_key))) {
      throw new Error("substream_loop_identity_mismatch");
    }
    if (loop.status === "idle") return;
    if (loop.active_execution_id === null || loop.active_execution_epoch === null
      || loop.lease_owner === null) throw new Error("substream_loop_execution_fence_missing");
    this.loops.requestStop({
      executionId: loop.active_execution_id,
      executionEpoch: loop.active_execution_epoch,
      leaseOwner: loop.lease_owner,
      expectedLoopRevision: loop.revision,
      reason: "stopped_by_user",
      now: Date.now(),
    });
  }

  async retry(auth: AuthContext): Promise<WorkstreamObjectRetryResult> {
    const root = await this.authorize(auth);
    const loop = this.loops.loop();
    if (!loop) throw new Error("substream_loop_not_initialized");
    if (loop.loop_id !== substreamLoopId(asWorkstreamId(root.workstream_key))) {
      throw new Error("substream_loop_identity_mismatch");
    }
    if (loop.status === "executing") {
      throw new ApiError(409, "harness_already_running", "This work stream already has an active run");
    }
    const latest = first(this.storage.sql.exec<{
      run_id: string;
      status: string;
      trigger_part_id: string | null;
      model: string | null;
      execution_context_json: string | null;
    }>(
      `SELECT run_id, status, trigger_part_id, model, execution_context_json FROM runs
        WHERE substream_id = '0' AND parent_tool_call_id IS NULL AND origin != 'block_dashboard_block'
        ORDER BY created_at DESC LIMIT 1`,
    ));
    if (!latest || !["failed", "cancelled"].includes(latest.status)) {
      throw new ApiError(409, "harness_not_retryable", "The latest run is not retryable");
    }
    if (latest.execution_context_json === null) {
      throw new ApiError(409, "harness_retry_context_missing", "The failed execution cannot be retried safely");
    }
    const previousContext = WorkstreamWorkflowInputSchema.parse(
      JSON.parse(latest.execution_context_json),
    );
    const newest = first(this.storage.sql.exec<{ id: string; sequence_number: number }>(
      `SELECT id, sequence_number FROM canonical_conversation_turn_details
        WHERE substream_id = '0' ORDER BY sequence_number DESC LIMIT 1`,
    ));
    const now = Date.now();
    const runId = asHarnessRunId(uuidV7(now));
    const workflowInput = WorkstreamWorkflowInputSchema.parse({
      ...previousContext,
      region: this.env.AVALON_REGION,
      workspaceId: auth.workspaceId,
      workstreamId: asWorkstreamId(root.workstream_key),
      substreamId: "0",
      loopId: loop.loop_id,
      harnessRunId: runId,
      triggerMessageId: latest.trigger_part_id,
      transcriptFenceMessageId: newest?.id ?? null,
      executionPrincipal: { type: "user", userId: auth.userId },
      reason: "manual_retry",
    });
    const model = latest.model ?? await this.model(root);
    await this.objectStore.commitWithRegionalEffects(
      (sql) => {
        const currentLoop = this.loops.loop();
        if (!currentLoop || currentLoop.loop_id !== loop.loop_id
          || currentLoop.revision !== loop.revision || currentLoop.status !== "idle") {
          throw new ApiError(409, "harness_already_running", "This work stream already has an active run");
        }
        const stillLatest = first(sql.exec<{ run_id: string; status: string }>(
          `SELECT run_id, status FROM runs
            WHERE substream_id = '0' AND parent_tool_call_id IS NULL
              AND origin != 'block_dashboard_block'
            ORDER BY created_at DESC, run_id DESC LIMIT 1`,
        ));
        if (!stillLatest || stillLatest.run_id !== latest.run_id
          || !["failed", "cancelled"].includes(stillLatest.status)) {
          throw new ApiError(409, "harness_not_retryable", "The latest run is not retryable");
        }
        sql.exec(
          `INSERT INTO runs
             (run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
              model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
              active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
              tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
              terminal_reason, origin, execution_principal_json, chain_depth, model,
              trigger_part_id, execution_context_json, created_at, updated_at)
           VALUES (?, '0', NULL, 'admitted', '{}', 0, 0, '', ?, 0, ?,
                   0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, 'manual_retry', ?, 0, ?, ?, ?, ?, ?)`,
          runId,
          newest?.sequence_number ?? 0,
          now,
          JSON.stringify(workflowInput.executionPrincipal),
          model,
          latest.trigger_part_id,
          JSON.stringify(workflowInput),
          now,
          now,
        );
        sql.exec(
          `UPDATE workstream SET exact_state = 'scheduled', state_reason_code = 'manual_retry',
                  state_changed_at = ?, run_revision = run_revision + 1, updated_at = ?
            WHERE id = 1`,
          now,
          now,
        );
      },
      () => [{ partitionKey: "common", effect: this.commonEffect(this.root()) }],
    );
    return {
      harnessRunId: runId,
      activationRequest: {
        kind: "activate_substream_loop",
        loopId: loop.loop_id,
        cause: "manual_retry",
        inputId: null,
        receiptRunId: runId,
        workflowInput,
      },
    };
  }

  async recordWorkflowStarted(runId: string, instanceId: string): Promise<void> {
    await this.objectStore.commitWithRegionalEffects(
      (sql) => {
        const now = Date.now();
        const changed = sql.exec<{ run_id: string }>(
          `UPDATE runs SET workflow_instance_id = ?, status = 'running',
                  started_at = MIN(started_at, ?), updated_at = ?
            WHERE run_id = ? AND status IN ('admitted', 'running')
            RETURNING run_id`,
          instanceId, now, now, runId,
        );
        if (changed.toArray().length === 0) throw new Error("workstream_run_start_fenced");
        sql.exec(
          `UPDATE workstream SET exact_state = 'running', state_reason_code = 'workflow_started',
                  state_changed_at = ?, updated_at = ? WHERE id = 1`,
          now, now,
        );
      },
      () => [{ partitionKey: "common", effect: this.commonEffect(this.root()) }],
    );
  }

  async recordWorkflowFailed(
    runId: string,
    error: { code: string; message: string },
    execution: {
      loopId: string;
      executionId: string;
      executionEpoch: number;
      leaseOwner: string;
    },
  ): Promise<void> {
    await this.objectStore.commitWithRegionalEffects(
      (sql) => {
        const now = Date.now();
        const changed = sql.exec<{ run_id: string }>(
          `UPDATE runs SET status = 'failed', terminal_reason = 'failed', error_json = ?,
                  completed_at = ?, terminalized_at = ?, updated_at = ?
            WHERE run_id = ? AND status IN ('admitted', 'running')
              AND substream_loop_id = ?
              AND loop_execution_id = ? AND loop_execution_epoch = ?
              AND EXISTS (
                SELECT 1 FROM substream_loops loop
                 WHERE loop.id = 1 AND loop.loop_id = ? AND loop.status = 'executing'
                   AND loop.active_execution_id = ? AND loop.active_execution_epoch = ?
                   AND loop.lease_owner = ?
              )
            RETURNING run_id`,
          JSON.stringify(error), now, now, now, runId,
          execution.loopId, execution.executionId, execution.executionEpoch,
          execution.loopId, execution.executionId, execution.executionEpoch,
          execution.leaseOwner,
        );
        if (changed.toArray().length === 0) throw new Error("workstream_run_failure_fenced");
        const closedLoop = sql.exec<{
          loop_id: string;
        } & Record<string, SqlStorageValue>>(
          `UPDATE substream_loops
              SET status = 'idle', active_execution_id = NULL,
                  active_execution_epoch = NULL, lease_owner = NULL,
                  lease_expires_at = NULL, stop_requested_at = NULL,
                  stop_after_step_ordinal = NULL, stop_reason = NULL,
                  revision = revision + 1, updated_at = ?
            WHERE id = 1 AND loop_id = ? AND status = 'executing'
              AND active_execution_id = ? AND active_execution_epoch = ?
              AND lease_owner = ?
              AND NOT EXISTS (
                SELECT 1 FROM assistant_turn_reservations reservation
                 WHERE reservation.loop_id = substream_loops.loop_id
                   AND reservation.cycle_ordinal = substream_loops.cycle_ordinal
                   AND reservation.state IN ('reserved', 'streaming')
              )
            RETURNING loop_id`,
          now,
          execution.loopId,
          execution.executionId,
          execution.executionEpoch,
          execution.leaseOwner,
        ).toArray()[0];
        if (closedLoop?.loop_id !== execution.loopId) {
          throw new Error("workstream_run_failure_loop_fenced");
        }
        sql.exec(
          `UPDATE workstream SET exact_state = 'failed', state_reason_code = ?,
                  state_changed_at = ?, updated_at = ? WHERE id = 1`,
          error.code, now, now,
        );
      },
      () => [{ partitionKey: "common", effect: this.commonEffect(this.root()) }],
    );
  }

  /**
   * Run one Workflow runtime transaction against the normalized local tables.
   * Directory projection generation stays in the same SQLite commit whenever
   * the transaction can change transcript or root lifecycle state.
   */
  async commitRuntimeMutation<T>(
    mutate: (sql: SqlStorage) => T,
    affectsDirectory: boolean,
  ): Promise<T> {
    const committed = await this.objectStore.commitWithRegionalEffects(
      mutate,
      () => {
        if (!affectsDirectory) return [];
        const root = this.root();
        const participantIds = this.activeParticipantIds();
        return [
          { partitionKey: "common", effect: this.commonEffect(root) },
          ...participantIds.map((userId) => ({
            partitionKey: `user:${userId}`,
            effect: this.userEffect(root, userId),
          })),
        ];
      },
    );
    return committed.result;
  }

  /** Seed or repair the parent WorkstreamDO after import/restore. */
  async enqueueDirectorySnapshot(): Promise<void> {
    await this.objectStore.commitWithRegionalEffects(
      () => undefined,
      () => {
        const root = this.root();
        return [
          { partitionKey: "common", effect: this.commonEffect(root) },
          ...this.activeParticipantIds().map((userId) => ({
            partitionKey: `user:${userId}`,
            effect: this.userEffect(root, userId),
          })),
        ];
      },
    );
  }
}

function attachmentMetadataSize(metadataJson: unknown): number {
  if (typeof metadataJson !== "string" || metadataJson.length === 0) return 0;
  try {
    const size = Number((JSON.parse(metadataJson) as { size?: unknown }).size ?? 0);
    return Number.isSafeInteger(size) && size >= 0 ? size : 0;
  } catch {
    return 0;
  }
}
