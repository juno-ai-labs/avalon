import { renderPersonalSystemPrompt } from "@rally/agent-harness";
import { AnnotatedMessageContentSchema, annotationCommentText } from "@rally/contracts";
import { AnnotationsSchema, validateAnnotationAttachments } from "@rally/contracts";
import { ResourceService } from "../services/resource-service";
import { mergeEmbedsOf, resolveShareableResources } from "../services/resource-share-rules";
import { stableUuid } from "../lib/stable-uuid";
import { AGENT_MESSAGE_CONTENT_KIND, ConversationInitializationSchema, ImportedMessageProvenanceSchema, PreparedConversationSchema, type PreparedConversation } from "@rally/contracts";
import { WorkstreamAppearanceSchema, WorkstreamAppearancePatchSchema, type MergeEmbed, type WorkstreamAppearancePatch } from "@rally/contracts";
import { renderAgentMessage } from "../services/agent-message-content";
import type { ConversationParentKind } from "@rally/contracts/conversation-parent";
import {
  AcknowledgeWorkstreamReadRequestSchema,
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
  DemoSeedSchema,
  ConversationMergeV1Schema,
  type ConversationMergeV1,
  type Elicitation,
  type Message,
  type ResourceRelationshipType,
  type WorkstreamResource,
  type Workstream,
  type WorkstreamBatchUpdate,
  type WorkstreamDetail,
  type WorkstreamWorkflowInput,
  type WorkstreamMessageAdmissionReceipt,
  type PendingTranscriptInput,
  SpaceColorKeySchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
  UserIdSchema,
  WORKSTREAM_NAMING_GRACE_MS,
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type HarnessRunId,
  type SubstreamId,
  type WorkspaceId,
  type WorkstreamId,
} from "@rally/contracts";
import type { AddressingContextMessage, PromptMessage } from "@rally/agent-harness";
import { stripPersonalSystemPrompt, truncateUtf16Safe } from "@rally/contracts/text";
import { z } from "zod";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { runtimeDeferral, type WorkDeferral } from "../lib/defer";
import {
  connectorRegistryForEnv,
  connectorSupportsResourceHydration,
} from "../lib/connector-registry";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import {
  ContentAudienceSchema,
  contentAudienceContainsWorkstream,
  type ContentAudience,
  type WorkstreamReaderAudience,
} from "../lib/audience-containment";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { mentionedPersonNames, prepareMentionMarkdown, type MentionPerson } from "@rally/contracts/message-mentions";
import { uuidV7 } from "../lib/uuid-v7";
import { connectionFromRow } from "../mappers/connection";
import {
  agentModelOverride,
  pinnedModelRouting,
  resolveAgentModelRouting,
  resolveNewWorkstreamModelRouting,
} from "../services/agent-model-flags";
import { classifyWorkstreamMessage } from "../services/integrations";
import { openingMessageStartsRun } from "../services/opening-message-classifier";
import {
  isUnlistedResourceMetadata,
  listedResourceVisibilitySql,
} from "../services/resource-listing";
import {
  canonicalModelMessageJson,
  projectParticipantModelMessage,
} from "../services/workstream-participant-model-message";
import type { ModelAttachmentSource } from "../services/attachment-model-content";
import { memberSafeHarnessError } from "../services/workstream-service";
import { recordMessageSentTelemetry, type MessageSentObservation } from "../telemetry/message-sent";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "../services/workspace-runtime-database";
import {
  SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS,
  ensureStorageAlarmNoLaterThan,
} from "./scheduled-alarms";
import { WorkstreamIdentityStorage } from "./workstream-identity-storage";
import { enqueueSemanticRealtimeReference } from "./workstream-semantic-realtime-outbox";
import { admitsOrganizationWide, spaceListedSql } from "./listing-rules";
import { substreamLoopId, workspaceDOName } from "./names";
import { ParticipantAuthorityTransferStorage } from "./participant-authority-transfer";
import { workstreamImportHash } from "./workstream-import-hash";
import { WorkspaceReserveDraftAttachmentsResultSchema } from "./workspace-draft-attachment-protocol";
import { WORKSTREAM_DIRECTORY_RESOURCE_LINK_LIMIT } from "@rally/contracts/conversation-effects";
import type { RegionalEffectCommand, WorkstreamObjectStore } from "./workstream-object-storage";
import {
  LOOP_EXECUTION_LEASE_MS,
  SubstreamLoopStorage,
  type PendingInputPreparationKind,
  type PendingInputPreparationRow,
  type PendingLoopInputRow,
} from "./substream-loop-storage";
import {
  WorkstreamTranscriptStorage,
  type PendingInputAttachmentDescriptor,
  type PendingInputDeliveryEffectInput,
  type PreparedParticipantMessage,
} from "./workstream-transcript-storage";
import { WorkstreamHarnessRunStorage } from "./workstream-harness-run-storage";
import {
  AdmitExternalMessageInputSchema,
  AnswerExternalElicitationInputSchema,
  AdmitSystemActivationInputSchema,
  type AdmitSystemActivationInput,
  type AdmitExternalMessageInput,
  type AnswerExternalElicitationInput,
  type ExternalMessageAdmissionResult,
} from "./workstream-external-message-protocol";
import { startReadCursorAtLatest } from "./member-attention";
import { PERSONAL_SYSTEM_PROMPT_REASONS, PersonalSystemPromptRecordSchema } from "./personal-system-prompt";

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
  annotations: AnnotationsSchema.optional(),
  runMode: z.enum(["steer", "queue"]).optional(),
  telemetryOperationId: z.string().min(1).max(180).optional(),
  telemetryRequestReceivedAt: z.number().int().nonnegative().optional(),
  telemetryJourney: z.enum(["workstream_create", "substream_create", "message_send"]).optional(),
  forcedHarnessOrigin: z.string().min(1).max(80).optional(),
  parentHarnessRunId: z.string().uuid().optional(),
  expectedLatestHarnessRunId: z.string().uuid().optional(),
  expectedToolInvocationId: z.string().uuid().optional(),
  slackOrigin: z.unknown().optional(),
  slackSearchAuthorization: z.unknown().optional(),
  /**
   * Present on a demo seed action, and what decides its addressing — see
   * `DemoSeedSchema`. Reaches the object only over its internal RPC: the
   * message route's request schema has no such field, so nothing a client
   * sends can carry one.
   */
  seed: DemoSeedSchema.optional(),
  /**
   * Present when the message is a Breakout's merged result, written by the
   * merge service after it checked the Breakout is this Thread's and the
   * person can read it. Like `seed`, it reaches the object only over its
   * internal RPC: the message route's request schema has no such field.
   */
  merge: ConversationMergeV1Schema.optional(),
}).superRefine(validateAnnotationAttachments).refine((value) => value.text.trim().length > 0 || value.attachmentIds.length > 0 || value.annotations?.some((a) => a.comment.trim()), {
  message: "A message must include text or an attachment",
});

export const InitializeWorkstreamObjectInputSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  generation: z.number().int().positive(),
  title: z.string().min(1).max(180),
  objective: z.string().max(WORKSTREAM_DESCRIPTION_MAX_CHARACTERS),
  descriptionSource: z.enum(["authored", "derived"]),
  titleStatus: z.enum(["naming", "automatic", "settled"]),
  emailAddress: z.string().email().max(254).nullable(),
  creatorUserId: z.string().uuid(),
  initialization: ConversationInitializationSchema.default({ kind: "prompt" }),
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
   * The thread's Channel colour, written as its appearance at birth so no
   * surface draws the id-derived colour while the sync lane catches up.
   * `channel-color-sync.ts` stays the colour's writer after this; see
   * `docs/workstream-appearance.md`.
   */
  color: SpaceColorKeySchema.optional(),
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
  telemetryRequestReceivedAt: z.number().int().nonnegative().optional(),
  telemetryJourney: z.enum(["workstream_create", "substream_create", "message_send"]).optional(),
  /**
   * Present when a demo seed opens the work stream. A scripted opening always
   * starts a run, so the seed's turn is what that run says; a seed that says
   * nothing is refused rather than left to reach a provider.
   */
  seed: DemoSeedSchema.optional(),
  reason: z.string().min(1).max(80),
});

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

const HumanMessagePreparationEnvelopeSchema = z.object({
  auth: z.object({ userId: UserIdSchema }),
  input: WorkstreamObjectCreateMessageInputSchema,
});

/** One logical request identity for preparing, pending, and canonical replays. */
function messageAdmissionRequestHash(authorUserId: string, input: WorkstreamObjectCreateMessageInput): string {
  const receiptInput = { ...input };
  delete receiptInput.telemetryOperationId;
  delete receiptInput.telemetryRequestReceivedAt;
  delete receiptInput.telemetryJourney;
  // The merge title is a server snapshot and may change between attempts.
  if (receiptInput.merge) {
    receiptInput.merge = { ...receiptInput.merge, mergedFrom: { ...receiptInput.merge.mergedFrom, title: "" } };
  }
  return workstreamImportHash({ command: "create_message", authorUserId, input: receiptInput });
}

export type WorkstreamObjectUpdateInput = z.infer<typeof UpdateWorkstreamRequestSchema>;
export type WorkstreamObjectAcknowledgeReadInput = z.infer<typeof AcknowledgeWorkstreamReadRequestSchema>;
export type WorkstreamObjectAnswerElicitationInput = z.infer<typeof AnswerElicitationRequestSchema>;

interface RootRow extends SqlRow {
  appearance_json: string | null;
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
  created_by_user_id: string | null;
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

/** Strip the generated envelope before applying the existing notification budget. */
function notificationMessageExcerpt(text: string): string {
  return truncateUtf16Safe(stripPersonalSystemPrompt(text), 8_000);
}

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
  inserted: boolean;
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
 * Product repository for one conversation: the `SubstreamAgent` whose storage
 * this is.
 *
 * Every method reads or mutates only this object's normalized SQL for product
 * state. Regional D1 is consulted only for current workspace membership,
 * profiles, and other control-plane facts. Workspace-owned resources,
 * connectors, automation labels, and pins resolve through WorkspaceDO.
 */

/**
 * A message event's targets: who it mentions, then who takes part. Mentions
 * lead because the Activity tab reads them and a digest only ranks by them, and
 * the list is cut at the effect schema's hundred so a crowded thread can never
 * make the effect fail to parse inside the commit that carries it.
 */
function activityTargets(
  participantIds: readonly string[],
  mentionedIds: readonly string[],
  authorUserId: string | null,
): Array<{ userId: string; relation: "mentioned" | "participant" }> {
  return [
    ...mentionedIds
      .filter((userId) => userId !== authorUserId)
      .map((userId) => ({ userId, relation: "mentioned" as const })),
    ...participantIds.map((userId) => ({ userId, relation: "participant" as const })),
  ].slice(0, 100);
}

export class WorkstreamObjectProductService {
  /**
   * The admissions this isolate believes it is still preparing, by input id.
   *
   * `depth` is a re-entrancy count: a recovery takeover can legitimately run
   * alongside the original. `claimedAt` is the first claim's instant and is
   * never refreshed — the question it answers is *how long has this row been
   * claimed without settling*, and a takeover that re-claims it must not reset
   * that clock and hide an owner that is already gone.
   */
  private readonly activeInputPreparations = new Map<string, {
    depth: number;
    claimedAt: number;
  }>();
  private readonly inputPreparationWaiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly objectStore: WorkstreamObjectStore,
    private readonly env: Env,
    private readonly transcript = new WorkstreamTranscriptStorage(storage),
    private readonly loops = new SubstreamLoopStorage(storage),
    private readonly externalSubstreamId: () => SubstreamId = () => asSubstreamId("0"),
    private readonly defer: WorkDeferral = runtimeDeferral,
  ) {}

  /** Store instructions as part of the user's ordinary message text. */
  private withPersonalSystemPrompt(text: string, userId: string | undefined, reason: string): string {
    const identity = this.objectStore.identity();
    if (!identity || !userId || !PERSONAL_SYSTEM_PROMPT_REASONS.has(reason)
      || identity.parentKind === "automation") return text;
    if (this.storage.sql.exec("SELECT 1 FROM background_agent WHERE id = 1").toArray().length > 0) return text;
    const copy = this.storage.sql.exec<{ text: string }>(
      "SELECT text FROM personal_system_prompt_copies WHERE user_id = ?", userId,
    ).toArray()[0];
    this.defer(this.refreshPersonalSystemPromptCopy(identity.workspaceId, userId).catch((error: unknown) => {
      logWarn(this.env, "personal_system_prompt_refresh_failed", {
        workspace_id: identity.workspaceId,
        substream_id: this.externalSubstreamId(),
        reason: diagnosticErrorCode(error, "personal_system_prompt_refresh_failed"),
      });
    }));
    const prefix = renderPersonalSystemPrompt(copy?.text ?? "");
    return prefix ? [prefix, text].filter(Boolean).join("\n\n") : text;
  }

  private async refreshPersonalSystemPromptCopy(workspaceId: string, userId: string): Promise<void> {
    const workspace = await this.workspaceDirectory(workspaceId);
    const source = PersonalSystemPromptRecordSchema.parse(
      await workspace.personalSystemPrompt({ workspaceId: asWorkspaceId(workspaceId), userId }));
    // A late, older refresh must not replace a newer copy.
    this.storage.sql.exec(
      `INSERT INTO personal_system_prompt_copies (user_id, text, source_revision, copied_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET text = excluded.text, source_revision = excluded.source_revision,
         copied_at = excluded.copied_at
       WHERE excluded.source_revision > personal_system_prompt_copies.source_revision`,
      userId, source.personalSystemPrompt, source.revision, Date.now(),
    );
  }

  private conversationLoopId(root: RootRow): string {
    return substreamLoopId(
      asWorkstreamId(root.workstream_key),
      this.externalSubstreamId(),
    );
  }

  private socketCommandReceipt(
    sql: SqlStorage,
    auth: AuthContext,
    operationId: string,
    requestHash: string,
  ): "new" | "replayed" {
    const sourceId = `user:${auth.userId}`;
    const receipt = first(sql.exec<{ request_hash: string }>(
      `SELECT request_hash FROM durable_inbox_receipts
        WHERE channel = 'substream_socket_command'
          AND source_kind = 'regional_service' AND source_id = ?
          AND source_generation = 1 AND message_id = ?`,
      sourceId,
      operationId,
    ));
    if (receipt) {
      if (receipt.request_hash !== requestHash) {
        throw new ApiError(
          409,
          "substream_command_idempotency_conflict",
          "This substream command id was already used for another command",
        );
      }
      return "replayed";
    }
    return "new";
  }

  private recordSocketCommandReceipt(
    sql: SqlStorage,
    auth: AuthContext,
    operationId: string,
    command: "reorder_pending_inputs" | "stop_harness" | "set_workstream_appearance",
    requestHash: string,
    resultHash: string,
    now: number,
  ): void {
    const sourceId = `user:${auth.userId}`;
    sql.exec(
      `INSERT INTO durable_inbox_receipts
         (channel, source_kind, source_id, source_generation, message_id,
          partition_key, source_version, source_epoch, request_hash,
          result_code, result_hash, received_at)
       VALUES ('substream_socket_command', 'regional_service', ?, 1, ?,
               ?, 1, 0, ?, 'succeeded', ?, ?)`,
      sourceId,
      operationId,
      `${this.externalSubstreamId()}:${command}`,
      requestHash,
      resultHash,
      now,
    );
  }

  /** Bind a client message id to the exact author and request it first admitted. */
  private messageAdmissionReceipt(
    sql: SqlStorage,
    clientMessageId: string,
    requestHash: string,
    conflict: {
      code: string;
      message: string;
    } = {
      code: "substream_message_idempotency_conflict",
      message: "This client message id was already used for another message",
    },
  ): "new" | "replayed" {
    const sourceId = `substream:${this.externalSubstreamId()}`;
    const receipt = first(sql.exec<{ request_hash: string }>(
      `SELECT request_hash FROM durable_inbox_receipts
        WHERE channel = 'substream_message_admission'
          AND source_kind = 'regional_service' AND source_id = ?
          AND source_generation = 1 AND message_id = ?`,
      sourceId,
      clientMessageId,
    ));
    if (!receipt) return "new";
    if (receipt.request_hash !== requestHash) {
      throw new ApiError(
        409,
        conflict.code,
        conflict.message,
      );
    }
    return "replayed";
  }

  private recordMessageAdmissionReceipt(
    sql: SqlStorage,
    clientMessageId: string,
    requestHash: string,
    now: number,
  ): void {
    sql.exec(
      `INSERT INTO durable_inbox_receipts
         (channel, source_kind, source_id, source_generation, message_id,
          partition_key, source_version, source_epoch, request_hash,
          result_code, result_hash, received_at)
       VALUES ('substream_message_admission', 'regional_service', ?, 1, ?,
               ?, 1, 0, ?, 'succeeded', ?, ?)`,
      `substream:${this.externalSubstreamId()}`,
      clientMessageId,
      this.externalSubstreamId(),
      requestHash,
      requestHash,
      now,
    );
  }

  /** Fence the active loop in the same commit which makes its room unreadable. */
  private requestArchiveStopInTransaction(sql: SqlStorage, now: number): void {
    sql.exec(
      `UPDATE substream_loops
          SET stop_requested_at = ?, stop_after_step_ordinal = step_ordinal,
              stop_reason = 'workstream_archived', revision = revision + 1,
              updated_at = ?
        WHERE id = 1 AND status = 'executing' AND stop_requested_at IS NULL`,
      now,
      now,
    );
  }

  /** Parent-owned archive delivery; stop and archive share the local commit. */
  async applyPrivateChildLifecycle(version: number, archivedAt: number | null): Promise<void> {
    const now = Date.now();
    await this.objectStore.commitWithRegionalEffects((sql) => {
      const current = first(sql.exec<{ version: number; archived_at: number | null }>(
        `SELECT version, archived_at FROM private_child_lifecycle_authority WHERE id = 1`));
      if (current && current.version >= version) return false;
      sql.exec(`INSERT INTO private_child_lifecycle_authority (id, version, archived_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, archived_at = excluded.archived_at`, version, archivedAt);
      if (archivedAt !== null) this.requestArchiveStopInTransaction(sql, now);
      sql.exec(`UPDATE workstream SET archived_at = ?,
        exact_state = CASE WHEN ? IS NOT NULL THEN 'archived' WHEN exact_state = 'archived' THEN 'idle' ELSE exact_state END,
        listing_epoch = listing_epoch + 1, updated_at = ? WHERE id = 1`, archivedAt, archivedAt, now);
      return true;
    }, (_sql, changed) => changed ? [{ partitionKey: "common", effect: this.commonEffect(this.root()) }] : []);
  }

  private beginInputPreparation(inputId: string, now: number): void {
    const claim = this.activeInputPreparations.get(inputId);
    this.activeInputPreparations.set(inputId, {
      depth: (claim?.depth ?? 0) + 1,
      claimedAt: claim?.claimedAt ?? now,
    });
  }

  private endInputPreparation(inputId: string): void {
    const claim = this.activeInputPreparations.get(inputId);
    if (!claim || claim.depth <= 1) this.activeInputPreparations.delete(inputId);
    else this.activeInputPreparations.set(inputId, { ...claim, depth: claim.depth - 1 });
    this.releaseInputPreparationWaiters(inputId);
  }

  private releaseInputPreparationWaiters(inputId: string): void {
    if (this.loops.inputPreparation(inputId)?.state !== "preparing") {
      const waiters = this.inputPreparationWaiters.get(inputId);
      this.inputPreparationWaiters.delete(inputId);
      for (const resolve of waiters ?? []) resolve();
    }
  }

  private async waitForEarlierInputPreparations(inputSequence: number): Promise<void> {
    for (;;) {
      const earlier = this.loops.oldestPreparingInput();
      if (!earlier || earlier.input_sequence >= inputSequence) return;
      if (!this.inputPreparationClaimIsLive(earlier.input_id, Date.now())) {
        await this.resumeOldestInputPreparation();
        continue;
      }
      // Recovery of a cancelled invocation settles the same durable mailbox row
      // and releases these waiters through endInputPreparation as well.
      await this.waitForInputPreparation(earlier.input_id);
    }
  }

  private waitForInputPreparation(inputId: string): Promise<void> {
    if (this.loops.inputPreparation(inputId)?.state !== "preparing") return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.inputPreparationWaiters.get(inputId) ?? new Set();
      waiters.add(resolve);
      this.inputPreparationWaiters.set(inputId, waiters);
    });
  }

  /**
   * Whether this isolate's claim on a preparation is still evidence its owner
   * is running, rather than a claim whose owner the runtime cancelled.
   *
   * A cancelled invocation leaves the claim behind with nothing to release it,
   * so without an expiry a surviving isolate would refuse to resume that row
   * forever — and the head-of-line gate would hold every message queued behind
   * it forever with it. The horizon is the object's existing one for exactly
   * this question; see {@link LOOP_EXECUTION_LEASE_MS}.
   */
  private inputPreparationClaimIsLive(inputId: string, now: number): boolean {
    const expiresAt = this.inputPreparationClaimExpiresAt(inputId);
    return expiresAt !== null && now < expiresAt;
  }

  /** When this isolate's claim on a preparation stops being evidence of life. */
  private inputPreparationClaimExpiresAt(inputId: string): number | null {
    const claim = this.activeInputPreparations.get(inputId);
    return claim === undefined ? null : claim.claimedAt + LOOP_EXECUTION_LEASE_MS;
  }

  private preparationFailureCode(error: unknown): string {
    if (error instanceof ApiError && /^[a-z0-9_]{1,160}$/.test(error.code)) return error.code;
    if (error instanceof Error && /^[a-z0-9_]{1,160}$/.test(error.message)) return error.message;
    return "pending_input_preparation_failed";
  }

  private async runInputPreparation<T extends { activationRequest: WorkstreamLoopActivationRequest | null }>(
    preparation: PendingInputPreparationRow,
    work: () => Promise<T>,
  ): Promise<T> {
    if (preparation.state === "failed") {
      throw new ApiError(409, "pending_input_preparation_failed", "This message could not be prepared");
    }
    if (preparation.state !== "preparing") {
      throw new Error(`pending_input_preparation_${preparation.state}`);
    }
    this.beginInputPreparation(preparation.input_id, Date.now());
    let callerOwnsActivation = false;
    try {
      const result = await work();
      callerOwnsActivation = result.activationRequest !== null;
      return result;
    } catch (error) {
      this.loops.failInputPreparation({
        inputId: preparation.input_id,
        terminalCode: this.preparationFailureCode(error),
        now: Date.now(),
      });
      throw error;
    } finally {
      this.endInputPreparation(preparation.input_id);
      // Settling a preparation can expose later ready inputs without handing
      // this invocation an activation request: failures do, but so do
      // successful non-invoking messages and messages admitted while another
      // execution owns the loop. Only an actual activation handoff makes the
      // caller the owner of the eager wake. The reservation's longer
      // cancellation-recovery alarm remains armed before the durable row
      // either way.
      if (!callerOwnsActivation && (this.loops.pendingInputs().length > 0
        || this.nextRecoverableInputPreparationAt() !== null)) {
        await ensureStorageAlarmNoLaterThan(this.storage, Date.now() + 1);
      }
    }
  }

  private async reserveInputPreparation(input: {
    root: RootRow;
    inputId: string;
    clientMessageId: string;
    preparationKind: PendingInputPreparationKind;
    envelope: unknown;
    validateReplay?: (originalEnvelopeJson: string) => void;
    now: number;
  }): Promise<PendingInputPreparationRow> {
    const loop = this.ensureExternalMessageLoop(input.root, input.now);
    // Before the row, not after it. A `preparing` row is hidden from
    // `pendingInputs` — and so is every input queued behind it — so nothing
    // else in this object derives a wake-up for it, and a runtime cancellation
    // neither throws nor runs a `finally`. Arming after the commit would leave
    // a window, however narrow, in which the reservation is durable and the
    // wake-up is not; arming first inverts that, and the worst an admission
    // that then fails can cost is one wake that finds nothing to do. The
    // horizon is the base class's, for the same cancellation it names — see
    // `ScheduledDurableObject.armAlarmBeforeDueWork`.
    await ensureStorageAlarmNoLaterThan(
      this.storage,
      input.now + SCHEDULED_ALARM_CANCELLATION_RECOVERY_MS,
    );
    let envelopeJson = JSON.stringify(input.envelope);
    // Read after the alarm await: another attempt can reserve while it yields.
    // Each caller decides logical request identity; storage retains the first
    // recovery envelope once that caller has validated a matching replay.
    if (input.validateReplay) {
      const existing = this.loops.inputPreparationByClientMessageId(input.clientMessageId);
      if (existing?.preparation_kind === input.preparationKind && existing.state === "preparing") {
        const originalEnvelopeJson = existing.envelope_json ?? "null";
        input.validateReplay(originalEnvelopeJson);
        envelopeJson = originalEnvelopeJson;
      }
    }
    return this.loops.reserveInputPreparation({
      inputId: input.inputId,
      loopId: loop.loop_id,
      clientMessageId: input.clientMessageId,
      preparationKind: input.preparationKind,
      envelopeJson,
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
    preparationId?: string;
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
              release_authority, created_at, preparation_id)
           VALUES (?, ?, ?, ?, 'preparation', ?, ?)
           ON CONFLICT(input_id, resource_id) DO NOTHING`,
          input.inputId,
          resourceId,
          input.workspaceId,
          input.workstreamId,
          input.now, input.preparationId ?? null,
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
              recovery.release_authority, COALESCE(mailbox.state, 'failed') AS mailbox_state
         FROM pending_attachment_reservation_recovery recovery
         LEFT JOIN pending_loop_input_mailbox mailbox ON mailbox.input_id = recovery.input_id
         LEFT JOIN prepared_conversation_receipts preparation ON preparation.operation_id = recovery.preparation_id
        WHERE mailbox.state IN ('failed', 'discarded') OR preparation.state = 'failed'
        ORDER BY recovery.created_at, recovery.input_id LIMIT 1`,
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
    if (!preparation) return null;
    return this.inputPreparationClaimIsLive(preparation.input_id, now) ? null : now;
  }

  /**
   * When to look at an unsettled admission this isolate is still claiming.
   *
   * Deliberately separate from {@link nextRecoverableInputPreparationAt}, which
   * answers *may I resume it now* and has to keep saying no while the claim is
   * live, or the drain would re-enter a preparation that is genuinely running.
   * This answers what the alarm needs instead: a `preparing` row is hidden from
   * `pendingInputs` until it settles, so without this the re-arm at the end of
   * a handler deletes the object's only wake-up and the admission is stranded.
   *
   * The instant is the claim's expiry rather than a heartbeat: a live claim
   * needs no attention until it stops being evidence of a running owner, and
   * waking every interval in the meantime would spend the object's alarm on a
   * question whose answer cannot change until then.
   */
  nextInputPreparationWakeAt(now: number = Date.now()): number | null {
    const preparation = this.loops.oldestPreparingInput();
    if (!preparation) return null;
    const expiresAt = this.inputPreparationClaimExpiresAt(preparation.input_id);
    return expiresAt !== null && now < expiresAt ? expiresAt : null;
  }

  async resumeOldestInputPreparation(): Promise<"none" | "active" | "settled"> {
    // An invocation may have committed and then been cancelled before its
    // finally. The durable mailbox, rather than that invocation, releases waiters.
    for (const inputId of this.inputPreparationWaiters.keys()) this.releaseInputPreparationWaiters(inputId);
    if (await this.recoverTerminalAttachmentReservation()) return "settled";
    const preparation = this.loops.oldestPreparingInput();
    if (!preparation) return "none";
    // A live claim is the original invocation still running; anything past the
    // recovery horizon is a claim whose owner cannot be shown to exist, and
    // resuming is idempotent against every durable row it re-enters.
    if (this.inputPreparationClaimIsLive(preparation.input_id, Date.now())) return "active";
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
      this.releaseInputPreparationWaiters(preparation.input_id);
      return "settled";
    }
    try {
      if (preparation.preparation_kind === "human_message") {
        await this.createMessage(envelope.auth as AuthContext, envelope.input as WorkstreamObjectCreateMessageInput);
      } else if (preparation.preparation_kind === "external_message") {
        await this.admitExternalMessage(envelope.input as AdmitExternalMessageInput);
      } else if (preparation.preparation_kind === "automation_activation") {
        await this.admitSystemActivation(envelope.input as AdmitSystemActivationInput);
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
    if (!row) throw new ApiError(404, "workstream_not_found", "Thread not found");
    if (row.authority_mode !== "authoritative" || row.authority_generation <= 0) {
      throw new ApiError(503, "workstream_maintenance", "Work-stream maintenance is in progress");
    }
    return row;
  }

  bootstrapRuntimeAuthority(input: {
    workspaceId: WorkspaceId;
    parentKind: ConversationParentKind;
    parentId: string;
    generation: number;
  }): void {
    this.objectStore.ensureIdentity({
      workspaceId: input.workspaceId,
      parentKind: input.parentKind,
      parentId: input.parentId,
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
   * requires an opening message and writes the first part, an optional run and
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
    createdByUserId: string;
    participantUserIds: readonly string[];
    harnessStatus: string;
    emailAddress: string | null;
    emailRouteStatus: string | null;
    systemKind: string | null;
    modelOverride: string | null;
    now: number;
  }): Promise<{ outcome: "provisioned" | "already_provisioned" }> {
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== input.workspaceId
      || identity.parentId !== input.workstreamId) {
      throw new Error("workstream_provision_identity_mismatch");
    }
    return this.commitRuntimeMutation(
      () => new WorkstreamIdentityStorage(this.storage).provision(input),
      true,
    );
  }

  private async prepareConversationMaterialization(input: {
    conversation: PreparedConversation; operationId: string; identityHash?: string;
    firstTurnId: string; clientMessageId: string; userId: string;
    snapshot: { displayName: string; avatarUrl: string | null }; now: number;
    workspaceId: string; workstreamId: string;
  }) {
    const hash = input.identityHash ?? workstreamImportHash(input.conversation);
    const conversation = this.storage.transactionSync(() => {
      const existing = first(this.storage.sql.exec<{ content_hash: string; content_json: string; state: string }>(
        `SELECT content_hash, content_json, state FROM prepared_conversation_receipts WHERE operation_id = ?`, input.operationId));
      if (existing) {
        if (existing.content_hash !== hash || existing.state === "failed") throw new ApiError(409, "conversation_initialization_conflict", "This preparation changed or failed; start a new import");
        return PreparedConversationSchema.parse(JSON.parse(existing.content_json));
      }
      this.storage.sql.exec(`INSERT INTO prepared_conversation_receipts(operation_id, content_hash, first_turn_id, content_json, state, created_at)
        VALUES (?, ?, ?, ?, 'preparing', ?)`, input.operationId, hash, input.firstTurnId, JSON.stringify(input.conversation), input.now);
      return input.conversation;
    });
    try {
      const turns = await this.transcript.prepareConversation({ conversation,
        firstTurnId: input.firstTurnId, clientMessageId: input.clientMessageId,
        human: { userId: input.userId, snapshot: input.snapshot }, now: input.now });
      const attachments: AttachmentResourceRow[] = [];
      for (const [index, turn] of turns.entries()) attachments.push(...await this.reserveAttachmentDrafts({
        workspaceId: input.workspaceId, workstreamId: input.workstreamId, inputId: turn.input.turnId,
        preparationId: input.operationId, userId: input.userId, resourceIds: conversation.messages[index]?.attachmentIds ?? [], now: input.now,
      }));
      return { conversation, turns, attachments };
    } catch (error) {
      // Only definite input refusals end this operation. An uncertain RPC
      // response leaves the durable owner preparing, so the same request can
      // reconcile its reservation rather than delete possibly committed bytes.
      if (error instanceof ApiError && [409, 422].includes(error.status)) await this.failConversationPreparation(input.operationId);
      throw error;
    }
  }

  private async failConversationPreparation(operationId: string): Promise<void> {
    this.storage.sql.exec(`UPDATE prepared_conversation_receipts SET state = 'failed' WHERE operation_id = ? AND state = 'preparing'`, operationId);
    while (await this.recoverTerminalAttachmentReservation()) { /* release durable terminal owners */ }
  }

  private commitConversationPreparation(operationId: string): void {
    const receipt = first(this.storage.sql.exec<{ state: string }>(`SELECT state FROM prepared_conversation_receipts WHERE operation_id = ?`, operationId));
    if (!receipt || receipt.state === "failed") throw new ApiError(409, "conversation_initialization_failed", "The preparation failed; start a new import");
    this.storage.sql.exec(`UPDATE prepared_conversation_receipts SET state = 'committed' WHERE operation_id = ?`, operationId);
  }

  /** Joins the caller's identity/publication transaction for roots and children. */
  private commitPreparedConversation(
    conversation: PreparedConversation,
    transcriptMessages: Awaited<ReturnType<WorkstreamTranscriptStorage["prepareConversation"]>>,
    attachments: AttachmentResourceRow[], userId: string, now: number,
    recordSource = true,
  ): void {
    for (const message of transcriptMessages) this.transcript.appendPreparedParticipantMessage(message);
      transcriptMessages.forEach((turn, turnIndex) => (conversation.messages[turnIndex]?.attachmentIds ?? []).forEach((resourceId, position) => {
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
          turn.input.turnId, resourceId, position, JSON.stringify({ attachedAt: iso(now) }),
        );
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO workstream_resource_links
             (resource_id, attached_by_user_id, watch_enabled, relationship_type,
              resource_json, attached_at, updated_at)
           VALUES (?, ?, 0, 'message_attachment', ?, ?, ?)`,
          resourceId, userId, JSON.stringify(descriptor), now, now,
        );
      }));
    for (const turn of transcriptMessages) this.markAttachmentReleaseOwnedByProjection(turn.input.turnId);
    const imports = conversation.messages.flatMap((message) => {
      const parsed = ImportedMessageProvenanceSchema.safeParse(message.structuredContent);
      return parsed.success ? [parsed.data] : [];
    });
    if (recordSource && imports.length === conversation.messages.length
      && imports.every((result) => result.source.sessionId && result.sourceMessageId && result.sourceRevision)) {
      const source = imports[0]!;
      if (imports.some((result) => result.source.provider !== source.source.provider
        || result.source.sessionId !== source.source.sessionId
        || result.source.url !== source.source.url)) {
        throw new ApiError(422, "session_import_source_mismatch", "Imported messages must belong to one source session");
      }
      const ids = imports.map((result) => result.sourceMessageId!);
      if (new Set(ids).size !== ids.length) throw new ApiError(422, "session_import_duplicate_message", "The source contains duplicate message IDs");
      this.storage.sql.exec(`INSERT INTO imported_session_sources(id, provider, session_id, source_url, created_at, updated_at)
        VALUES (1, ?, ?, ?, ?, ?)`, source.source.provider, source.source.sessionId!, source.source.url, now, now);
      imports.forEach((result, index) => this.storage.sql.exec(`INSERT INTO imported_session_messages
        (source_message_id, source_revision, source_position, latest_turn_id, updated_at) VALUES (?, ?, ?, ?, ?)`,
        result.sourceMessageId!, result.sourceRevision!, index, transcriptMessages[index]!.input.turnId, now));
    }
  }

  /** The import checkpoint belongs to this conversation, never to its regional directory row. */
  async importedSessionSource(auth: AuthContext): Promise<{ provider: string; sessionId: string; url: string | null } | null> {
    const root = await this.authorize(auth);
    if (root.created_by_user_id !== auth.userId) return null;
    const row = first(this.storage.sql.exec<{ provider: string; session_id: string; source_url: string | null }>(
      `SELECT provider, session_id, source_url FROM imported_session_sources WHERE id = 1`));
    return row ? { provider: row.provider, sessionId: row.session_id, url: row.source_url } : null;
  }

  async importedSessionCheckpoint(auth: AuthContext): Promise<Array<{ sourceMessageId: string; sourceRevision: string }>> {
    const root = await this.authorize(auth);
    if (root.created_by_user_id !== auth.userId) {
      throw new ApiError(403, "session_import_update_denied", "Only the original importer can update this thread");
    }
    return this.storage.sql.exec<{ source_message_id: string; source_revision: string }>(
      `SELECT source_message_id, source_revision FROM imported_session_messages ORDER BY source_position`).toArray()
      .map((row) => ({ sourceMessageId: row.source_message_id, sourceRevision: row.source_revision }));
  }

  /** Append only source changes. Rally-authored turns can occupy any positions between imports. */
  async updateImportedSession(auth: AuthContext, operationId: string, rawConversation: PreparedConversation): Promise<{
    added: number; updated: number;
  }> {
    const conversation = PreparedConversationSchema.parse(rawConversation);
    const root = await this.authorize(auth);
    if (root.created_by_user_id !== auth.userId) {
      throw new ApiError(403, "session_import_update_denied", "Only the original importer can update this thread");
    }
    const source = first(this.storage.sql.exec<{ provider: string; session_id: string; source_url: string | null }>(
      `SELECT provider, session_id, source_url FROM imported_session_sources WHERE id = 1`));
    if (!source) throw new ApiError(409, "session_import_source_missing", "This thread has no updateable source session");
    const entries = conversation.messages.map((message, position) => ({
      message, position, provenance: ImportedMessageProvenanceSchema.parse(message.structuredContent),
    }));
    if (entries.some(({ provenance }) => provenance.source.provider !== source.provider
      || provenance.source.sessionId !== source.session_id
      || provenance.source.url !== source.source_url
      || !provenance.sourceMessageId || !provenance.sourceRevision)) {
      throw new ApiError(409, "session_import_source_mismatch", "Select the original source conversation for this thread");
    }
    const ids = entries.map(({ provenance }) => provenance.sourceMessageId!);
    if (new Set(ids).size !== ids.length) throw new ApiError(422, "session_import_duplicate_message", "The source contains duplicate message IDs");
    const requestHash = workstreamImportHash({ source, messages: entries.map(({ provenance }) => ({
      sourceMessageId: provenance.sourceMessageId, sourceRevision: provenance.sourceRevision,
    })) });
    const receipt = () => first(this.storage.sql.exec<{ request_hash: string; added_count: number; updated_count: number }>(
      `SELECT request_hash, added_count, updated_count FROM imported_session_update_receipts WHERE operation_id = ?`, operationId));
    const replay = receipt();
    if (replay) {
      if (replay.request_hash !== requestHash) throw new ApiError(409, "session_import_update_conflict", "This update key was used for different content");
      return { added: Number(replay.added_count), updated: Number(replay.updated_count) };
    }
    const previous = new Map(this.storage.sql.exec<{ source_message_id: string; source_revision: string; source_position: number; latest_turn_id: string }>(
      `SELECT source_message_id, source_revision, source_position, latest_turn_id FROM imported_session_messages`).toArray()
      .map((row) => [row.source_message_id, row]));
    const checkpointUnchanged = (): boolean => {
      const current = this.storage.sql.exec<{ source_message_id: string; source_revision: string; source_position: number; latest_turn_id: string }>(
        `SELECT source_message_id, source_revision, source_position, latest_turn_id FROM imported_session_messages`).toArray();
      return current.length === previous.size && current.every((row) => {
        const old = previous.get(row.source_message_id);
        return old?.source_revision === row.source_revision
          && old.source_position === row.source_position && old.latest_turn_id === row.latest_turn_id;
      });
    };
    if ([...previous.keys()].some((id) => !ids.includes(id))
      || entries.some(({ position, provenance }) => {
        const old = previous.get(provenance.sourceMessageId!);
        return old && Number(old.source_position) !== position;
      })) {
      throw new ApiError(409, "session_import_branch_changed", "The source removed or reordered earlier messages. Import this branch into a new thread");
    }
    const changes = entries.filter(({ provenance }) => previous.get(provenance.sourceMessageId!)?.source_revision !== provenance.sourceRevision);
    const added = changes.filter(({ provenance }) => !previous.has(provenance.sourceMessageId!)).length;
    const updated = changes.length - added;
    if (changes.length === 0) {
      let result = { added: 0, updated: 0 };
      this.storage.transactionSync(() => {
        const raced = receipt();
        if (raced) {
          if (raced.request_hash !== requestHash) throw new ApiError(409, "session_import_update_conflict", "This update key was used for different content");
          result = { added: Number(raced.added_count), updated: Number(raced.updated_count) };
          return;
        }
        if (!checkpointUnchanged()) throw new ApiError(409, "session_import_update_raced", "The source was updated concurrently; retry the import");
        this.storage.sql.exec(`INSERT INTO imported_session_update_receipts
          (operation_id, request_hash, added_count, updated_count, missing_count, committed_at) VALUES (?, ?, 0, 0, 0, ?)`,
          operationId, requestHash, Date.now());
      });
      return result;
    }
    const now = Date.now();
    const delta: PreparedConversation = { messages: changes.map(({ message, provenance }) => ({
      ...message,
      structuredContent: { ...provenance,
        ...(previous.get(provenance.sourceMessageId!) ? { supersedesTurnId: previous.get(provenance.sourceMessageId!)!.latest_turn_id } : {}),
      },
    })) };
    const firstTurnId = await stableUuid(["session-import-update", root.workstream_key, operationId]);
    const names = await this.messageUsers([auth.userId]);
    const person = names.get(auth.userId);
    const prepared = await this.prepareConversationMaterialization({
      conversation: delta, operationId, firstTurnId, clientMessageId: operationId,
      userId: auth.userId,
      snapshot: { displayName: person?.name ?? UNKNOWN_MEMBER_DISPLAY_NAME, avatarUrl: person?.avatar_url ?? null },
      now, workspaceId: auth.workspaceId, workstreamId: root.workstream_key,
    });
    try {
      this.storage.transactionSync(() => {
        const racedReceipt = receipt();
        if (racedReceipt) {
          if (racedReceipt.request_hash !== requestHash) throw new ApiError(409, "session_import_update_conflict", "This update key was used for different content");
          return;
        }
        if (!checkpointUnchanged()) throw new ApiError(409, "session_import_update_raced", "The source was updated concurrently; retry the import");
        const currentRoot = this.root();
        prepared.turns.forEach((turn, index) => {
          turn.input.messageSequenceNumber = currentRoot.next_sequence_number + index;
          turn.input.attentionOrdinal = currentRoot.next_attention_ordinal + index;
        });
        this.commitConversationPreparation(operationId);
        this.commitPreparedConversation(prepared.conversation, prepared.turns, prepared.attachments, auth.userId, now, false);
        changes.forEach(({ position, provenance }, index) => this.storage.sql.exec(`INSERT INTO imported_session_messages
          (source_message_id, source_revision, source_position, latest_turn_id, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source_message_id) DO UPDATE SET source_revision = excluded.source_revision,
            source_position = excluded.source_position, latest_turn_id = excluded.latest_turn_id, updated_at = excluded.updated_at`,
          provenance.sourceMessageId!, provenance.sourceRevision!, position, prepared.turns[index]!.input.turnId, now));
        this.storage.sql.exec(`UPDATE workstream SET next_sequence_number = next_sequence_number + ?,
          next_attention_ordinal = next_attention_ordinal + ?, last_people_activity_at = ?, updated_at = ? WHERE id = 1`,
          changes.length, changes.length, now, now);
        this.storage.sql.exec(`INSERT INTO member_attention
          (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
           manual_unread_from_ordinal, latest_mention_attention_ordinal,
           last_seen_at, version, updated_at)
          VALUES (?, ?, ?, NULL, 0, ?, 0, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            seen_attention_ordinal = MAX(member_attention.seen_attention_ordinal, excluded.seen_attention_ordinal),
            manual_unread_from_ordinal = NULL, last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at`,
          auth.userId, currentRoot.unread_tracking_start_ordinal,
          currentRoot.next_attention_ordinal + changes.length - 1, now, now);
        this.storage.sql.exec(`INSERT INTO imported_session_update_receipts
          (operation_id, request_hash, added_count, updated_count, missing_count, committed_at) VALUES (?, ?, ?, ?, 0, ?)`,
          operationId, requestHash, added, updated, now);
      });
    } catch (error) {
      await this.failConversationPreparation(operationId);
      throw error;
    }
    await this.enqueueDirectorySnapshot();
    return { added, updated };
  }

  /** Internal coordinator operation, valid only for a freshly provisioned conversation. */
  async installPreparedConversation(auth: AuthContext, operationId: string, rawConversation: PreparedConversation, replayOnly = false): Promise<{ turnId: string }> {
    const conversation = PreparedConversationSchema.parse(rawConversation);
    const root = this.root();
    const identity = this.objectStore.identity();
    if (!identity || identity.workspaceId !== auth.workspaceId || root.created_by_user_id !== auth.userId) {
      throw new ApiError(403, "conversation_initialization_denied", "Only the creator may initialize this conversation");
    }
    const hash = workstreamImportHash(conversation);
    const replay = () => {
      const receipt = first(this.storage.sql.exec<{ content_hash: string; first_turn_id: string }>(
        `SELECT content_hash, first_turn_id FROM prepared_conversation_receipts WHERE operation_id = ? AND state = 'committed'`, operationId));
      if (receipt && receipt.content_hash !== hash) throw new ApiError(409, "conversation_initialization_conflict", "This preparation already has different content");
      return receipt;
    };
    const existing = replay();
    if (existing) { await this.enqueueDirectorySnapshot(); return { turnId: existing.first_turn_id }; }
    if (replayOnly) throw new ApiError(409, "conversation_initialization_missing", "A published conversation cannot receive initial history");
    if (this.transcript.transcriptThrough() > 0) throw new ApiError(409, "conversation_already_started", "Prepared history requires an empty conversation");
    const now = Date.now();
    const firstTurnId = await stableUuid(["prepared-conversation", identity, operationId]);
    const names = await this.messageUsers([auth.userId]);
    const person = names.get(auth.userId);
    const prepared = await this.prepareConversationMaterialization({ conversation, firstTurnId, operationId,
      clientMessageId: operationId, userId: auth.userId, snapshot: {
        displayName: person?.name ?? UNKNOWN_MEMBER_DISPLAY_NAME, avatarUrl: person?.avatar_url ?? null }, now,
      workspaceId: auth.workspaceId, workstreamId: identity.parentId });
    const { turns, attachments } = prepared;
    try {
    this.storage.transactionSync(() => {
      if (replay()) return;
      if (this.transcript.transcriptThrough() > 0) throw new ApiError(409, "conversation_already_started", "The conversation started during preparation");
      this.commitConversationPreparation(operationId);
      this.commitPreparedConversation(prepared.conversation, turns, attachments, auth.userId, now);
      this.storage.sql.exec(`UPDATE workstream SET next_sequence_number = ?, next_attention_ordinal = ?, updated_at = ? WHERE id = 1`, turns.length + 1, turns.length + 1, now);

    });
    } catch (error) { await this.failConversationPreparation(operationId); throw error; }
    await this.enqueueDirectorySnapshot();
    return { turnId: firstTurnId };
  }

  async initialize(
    auth: AuthContext,
    rawInput: InitializeWorkstreamObjectRequest,
  ): Promise<{
    workstream: Workstream;
    turnId: string;
    harnessRunId: string | null;
    workflowInput: WorkstreamWorkflowInput | null;
  }> {
    const input = InitializeWorkstreamObjectInputSchema.parse(rawInput);
    const history = input.initialization.kind === "history" ? input.initialization.conversation : null;
    if (history && (input.seed || input.mentions.length || input.attachmentIds.length || input.openingStructuredContent !== null)) {
      throw new ApiError(422, "invalid_initial_content", "Prepared history cannot also execute a scripted opening or attach opening-message metadata");
    }
    if (input.seed && input.seed.assistant === null) {
      throw new ApiError(
        422,
        "demo_seed_opening_without_script",
        "A scripted opening starts a run, so its seed must say what the run says",
      );
    }
    if (auth.workspaceId !== input.workspaceId || auth.userId !== input.creatorUserId) {
      throw new ApiError(403, "workstream_create_denied", "The thread cannot be created for this identity");
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
    if (existing && (existing.workspaceId !== input.workspaceId || existing.parentId !== input.workstreamId)) {
      throw new ApiError(409, "workstream_object_identity_mismatch", "The object identity does not match");
    }
    // A member initializes a work stream; an automation's conversation is
    // bootstrapped by its object and never comes through here.
    this.objectStore.ensureIdentity({
      workspaceId: input.workspaceId,
      parentKind: "workstream",
      parentId: input.workstreamId,
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
      if (part && !run) {
        await this.enqueueDirectorySnapshot();
        return { workstream: await this.summary(existingRoot, auth.userId), turnId: part.id,
          harnessRunId: null, workflowInput: null };
      }
      if (!part || !run || run.execution_context_json === null) {
        throw new ApiError(409, "workstream_create_replay_incomplete", "The thread is incomplete");
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
    const messageId = await stableUuid(["conversation-initialization", input.workstreamId, input.clientMessageId]);
    const runId = asHarnessRunId(uuidV7(now));
    const authorSnapshot = {
      displayName: names.get(input.creatorUserId)?.name ?? UNKNOWN_MEMBER_DISPLAY_NAME,
      avatarUrl: names.get(input.creatorUserId)?.avatar_url ?? null,
    };
    const annotations = AnnotatedMessageContentSchema.safeParse(input.openingStructuredContent);
    // Only member-composed openings need addressing. Explicit summons and
    // started work already authorize a run, even when their text looks like a title.
    const classifyOpening = input.reason === "opening_message" && !input.slackOrigin
      && !input.createdFromOpportunityId && !input.seed;
    const initialConversation: PreparedConversation = history ?? { messages: [{ role: "user", text: prepared.text,
      structuredContent: input.openingStructuredContent, attachmentIds: input.attachmentIds }] };
    const [startsRun, [routing], materialization] = await Promise.all([
      history ? false : !classifyOpening || openingMessageStartsRun(this.env, {
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        substreamId: "0",
        message: annotations.success
          ? annotationCommentText(input.openingMessage, annotations.data.annotations)
          : input.openingMessage,
        humanMentions: mentionedPersonNames(prepared.mentions),
        connectorMentions: prepared.mentions.flatMap((mention) => mention.type === "connector" && mention.connectorType ? [mention.connectorType] : []),
        attachmentCount: input.attachmentIds.length,
        defer: this.defer,
      }),
      // Overlap independent routing and materialization with JEV. A routing
      // failure must not prevent a silent opening from being persisted.
      Promise.allSettled([history ? null : input.modelOverride
        ? pinnedModelRouting(input.modelOverride).model
        : resolveNewWorkstreamModelRouting(this.env, {
            workspaceId: input.workspaceId, workstreamId: input.workstreamId,
          }).then((route) => route.model)]),
      this.prepareConversationMaterialization({
        conversation: history ?? { messages: [{ ...initialConversation.messages[0]!,
          text: this.withPersonalSystemPrompt(prepared.text, input.creatorUserId, input.reason) }] },
        operationId: input.clientMessageId, firstTurnId: messageId, clientMessageId: input.clientMessageId,
        // Receipt identity follows the request; a cache refresh may change the
        // proposed prefix on retry, but the receipt replays its frozen content.
        identityHash: input.initialization.kind === "history" && input.initialization.identityHash
          ? input.initialization.identityHash : workstreamImportHash(initialConversation),
        userId: input.creatorUserId, snapshot: authorSnapshot, now,
        workspaceId: input.workspaceId, workstreamId: input.workstreamId,
      }),
    ]);
    if (startsRun && routing.status === "rejected") throw routing.reason;
    const model = startsRun && routing.status === "fulfilled" ? routing.value : null;
    const { conversation, turns: transcriptMessages, attachments } = materialization;
    const initialMessages = conversation.messages;
    const openingWorkflowInput = startsRun ? this.workflowInput(input, runId, messageId) : null;
    let initializedElsewhere = false;
    this.storage.transactionSync(() => {
      // Hashing and directory reads yield. Another delivery can initialize
      // the room while those awaits are in flight; decide against current SQL.
      if (first(this.storage.sql.exec<RootRow>(`SELECT * FROM workstream WHERE id = 1`))?.authority_mode === "authoritative") {
        initializedElsewhere = true;
        return;
      }
      this.storage.sql.exec(
        `UPDATE workstream SET authority_mode = 'authoritative', authority_generation = ?,
             title = ?, description = ?, scope = ?, exact_state = ?,
             state_reason_code = ?, next_sequence_number = ?, next_attention_ordinal = ?,
             authority_epoch = 1, scope_epoch = 0, listing_epoch = 1, run_revision = 1,
             created_at = ?, last_people_activity_at = ?, state_changed_at = ?,
             created_by_user_id = ?, email_address = ?, email_route_status = 'active',
             created_from_opportunity_id = ?, opportunity_version = ?,
             opportunity_display_prompt_hash = ?, opportunity_execution_prompt_hash = ?,
             description_source = ?, system_kind = ?, title_status = ?, model_override = ?,
             appearance_json = COALESCE(appearance_json, ?), updated_at = ?
         WHERE id = 1 AND authority_mode = 'preparing'`,
        input.generation, input.title, input.objective, input.scope, startsRun ? "scheduled" : "idle",
        input.reason, initialMessages.length + 1, initialMessages.length + 1, now, now, now,
        input.creatorUserId, input.emailAddress, input.createdFromOpportunityId, input.opportunityVersion,
        input.opportunityDisplayPromptHash, input.opportunityExecutionPromptHash,
        input.descriptionSource, input.systemKind, input.titleStatus, input.modelOverride,
        input.color ? JSON.stringify({ icon: null, color: input.color }) : null, now,
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
         VALUES (?, 0, ?, NULL, 0, ?, 0, ?)`,
        input.creatorUserId, initialMessages.length, now, now,
      );
      this.commitConversationPreparation(input.clientMessageId);
      this.commitPreparedConversation(conversation, transcriptMessages, attachments, input.creatorUserId, now);
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
      if (openingWorkflowInput) {
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
      }
      // Product identity, never an activation receipt, owns the singleton.
      // Every later message, retry, and recovery therefore derives this exact
      // same loop instead of minting a new logical conversation.
      this.loops.ensureLoop({
        loopId: substreamLoopId(input.workstreamId),
        bindStateRevision: 0,
        now,
      });
    });
    if (initializedElsewhere) return this.initialize(auth, rawInput);
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
            body: notificationMessageExcerpt(prepared.text),
            canonicalUrl: null,
            digestible: true,
            occurredAt,
            sourceKind: "workstream_message",
            sourceId: messageId,
            dedupeKey: `message:${messageId}`,
            // Which conversation of the thread spoke: "0" for the thread itself,
            // a breakout's id otherwise. The Activity tab tells the two apart,
            // and reads a mention as read once the reader's position in that
            // conversation reaches `attentionOrdinal` — the one the mention
            // rows above were stamped with.
            metadata: { substreamId: this.externalSubstreamId(), attentionOrdinal: 1 },
            targets: activityTargets(memberIds, mentionedPersonIds, input.creatorUserId),
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
              messageText: notificationMessageExcerpt(prepared.text),
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
    // Only the composer's create carries this journey; Slack, suggestions,
    // imports and Sidekicks open Channels with text nobody typed here.
    if (input.telemetryJourney === "workstream_create" && !history && !input.seed) {
      recordMessageSentTelemetry(this.env, auth, {
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        messageId,
        scope: input.scope,
        origin: new WorkstreamIdentityStorage(this.storage).identity()?.origin_type ?? "ad_hoc",
        messageKind: "message",
        attachmentCount: input.attachmentIds.length,
        mentionCount: prepared.mentions.length,
        // Everyone seated besides the creator: explicit picks and accepted mentions.
        participantAddedCount: memberIds.length - 1,
      }, this.defer);
    }
    return {
      workstream: await this.summary(this.root(), auth.userId),
      turnId: messageId,
      harnessRunId: openingWorkflowInput ? runId : null,
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
      parentKind: this.objectStore.identity()?.parentKind ?? "workstream",
      parentId: input.workstreamId,
      loopId: substreamLoopId(input.workstreamId),
      harnessRunId: runId,
      triggerMessageId: messageId,
      activityId: null,
      executionPrincipal: input.executionPrincipal as WorkstreamWorkflowInput["executionPrincipal"],
      ...(input.slackOrigin ? { slackOrigin: input.slackOrigin as WorkstreamWorkflowInput["slackOrigin"] } : {}),
      ...(input.slackSearchAuthorization ? {
        slackSearchAuthorization: input.slackSearchAuthorization as WorkstreamWorkflowInput["slackSearchAuthorization"],
      } : {}),
      ...(input.telemetryOperationId ? { telemetryOperationId: input.telemetryOperationId } : {}),
      ...(input.telemetrySubjectUserId ? { telemetrySubjectUserId: input.telemetrySubjectUserId } : {}),
      ...(input.telemetryRequestReceivedAt !== undefined
        ? { telemetryRequestReceivedAt: input.telemetryRequestReceivedAt }
        : {}),
      ...(input.telemetryJourney ? { telemetryJourney: input.telemetryJourney } : {}),
      // Rides the execution receipt, so the run this create starts answers
      // from the seed rather than reaching a provider.
      ...(input.seed ? { seed: input.seed } : {}),
      reason: input.reason,
    };
  }

  isParticipant(userId: string): boolean {
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
  private async markOpened(userId: string): Promise<boolean> {
    if (!this.isUnseen(userId)) return true;
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
      return !this.isUnseen(userId);
    } catch (error) {
      logWarn(this.env, "workstream_mark_opened_failed", {
        workstreamId: this.root().workstream_key,
        userId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return false;
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
      throw new ApiError(404, "workstream_not_found", "Thread not found");
    }
    if (!participantVisible(root, this.isParticipant(auth.userId))) {
      throw new ApiError(404, "workstream_not_found", "Thread not found");
    }
    if (!includeArchived && root.archived_at !== null) {
      throw new ApiError(404, "workstream_not_found", "Thread not found");
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
      throw new ApiError(404, "workstream_not_found", "Thread not found");
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
    const pins = await workspaceDatabase.prepare(
      `SELECT pin.space_id, pin.position
         FROM workspace_workstream_pins pin
         JOIN space_channel_memberships membership
           ON membership.space_id = pin.space_id
          AND membership.workstream_id = pin.workstream_id
          AND membership.state = 'active'
         JOIN spaces space ON space.space_id = pin.space_id
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE pin.workstream_id = ? AND pin.user_id = ? AND space.archived_at IS NULL
          -- A pin is a member's, placed in a Space they listed when pinning;
          -- this remote read cannot ask for the Breakout projection.
          AND ${spaceListedSql("space", "viewer", "member", { breakouts: false })}
        ORDER BY pin.space_id`,
    ).bind(userId, root.workstream_key, userId, userId).all<{ space_id: string; position: number }>();
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
      appearance: root.appearance_json ? WorkstreamAppearanceSchema.parse(JSON.parse(root.appearance_json)) : undefined,
      objective: truncateUtf16Safe(root.description, WORKSTREAM_DESCRIPTION_MAX_CHARACTERS),
      emailAddress: root.email_address,
      createdByUserId: root.created_by_user_id,
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
      // Through the same validator routing reads it with, so a model retired
      // from `AGENT_MODEL_OVERRIDES` reads here as unpinned exactly as it
      // resolves on the way into a run. Parsing the stored string directly
      // would fail the whole response instead.
      modelOverride: agentModelOverride(root.model_override),
      nextPendingWakeup: wakeup ? {
        dueAt: iso(wakeup.due_at),
        promptPreview: truncateUtf16Safe(wakeup.prompt.replace(/\s+/gu, " ").trim(), 40),
      } : null,
      // Pin identity belongs to a Channel's placement in a Space. A detail
      // read has no selected Space, so the legacy scalar must stay empty.
      pinPosition: null,
      spacePins: pins.results.map((pin) => ({ spaceId: pin.space_id, position: pin.position })),
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
      && before.system_kind !== null
    ) {
      throw new ApiError(
        422,
        "scope_change_unsupported",
        before.system_kind !== null
          ? "This thread belongs to Rally itself, so its visibility cannot be changed"
          : "Sidekick run threads are private and their visibility cannot be changed",
      );
    }
    const now = Date.now();
    const scopeChanged = input.scope !== undefined && input.scope !== before.scope;
    if (scopeChanged && input.scope === "workspace") {
      this.assertRetainedContentContains({ scope: "workspace" });
    }
    const joined = scopeChanged && input.scope === "personal" && !this.isParticipant(auth.userId);
    // Narrowing takes away the reading everybody in the Organization had, so
    // whoever narrows is seated — otherwise they lock themselves out of the
    // Channel they just made private. Where that seat is *written* depends on
    // which authority owns the roster.
    //
    // On a Channel whose participants have moved to the grant ledger, the
    // roster is a projection and `participants` is frozen by
    // `participant_authority_freeze_insert`. The seat therefore goes through
    // the same grant mutation `add_participant` takes on a migrated Channel,
    // and the projection puts the row back. Writing it here instead aborted the
    // whole narrowing — which is how a shared Channel that had ever been shared
    // could not be made private at all, and how a Space retraction whose plan
    // narrows the scope failed on a trigger rather than on a decision.
    //
    // And the seat is written only when it is *needed*. The upsert below used
    // to run on every `scope: "personal"` update, so re-stating a scope that
    // had not changed fired the same frozen insert for a row that was already
    // active.
    const seatThroughGrants = joined && await this.migratedRosterSeat(auth);
    await this.objectStore.commitWithRegionalEffects(
      (sql) => {
        // A mention's grants and canonical turn must precede narrowing. The
        // durable mailbox also covers recovery and messages waiting in the loop.
        if (input.scope === "personal" && this.root().scope === "workspace"
          && (first(sql.exec(`SELECT 1 FROM pending_loop_input_mailbox
               WHERE state = 'preparing' AND preparation_kind = 'human_message'
                 AND EXISTS (SELECT 1 FROM json_each(envelope_json, '$.input.mentions')
                   WHERE json_extract(value, '$.type') = 'person') LIMIT 1`))
            || first(sql.exec(`SELECT 1 FROM pending_loop_inputs
                 WHERE json_array_length(authorization_json, '$.confirmedParticipantUserIds') > 0 LIMIT 1`)))) {
          throw new ApiError(409, "conversation_message_pending",
            "Wait for the pending mention to finish before making this conversation private");
        }
        if (joined && !seatThroughGrants) {
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
          startReadCursorAtLatest(sql, auth.userId, now, false);
        }
        if (input.archived === true) {
          // Archiving removes the interactive surface that can issue a stop.
          // Commit the stop request with the archive so no client-side request
          // ordering can strand an executing loop behind an unreadable room.
          this.requestArchiveStopInTransaction(sql, now);
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
    // Rally staff on a support session read without moving the person's read
    // position (`docs/impersonation.md`).
    if (auth.impersonatorUserId) return this.summary(root, auth.userId);
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
    if (auth.impersonatorUserId) return this.summary(root, auth.userId);
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
          this.requestArchiveStopInTransaction(sql, now);
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
    return this.detailAfterAdmission(auth, root, viewers);
  }

  /**
   * Detail for a socket whose session and membership were admitted at upgrade.
   * Revocation closes that socket; repeating the regional membership read
   * while assembling its first frame only lengthens the admission it already
   * passed.
   */
  async getAdmitted(
    auth: AuthContext,
    viewers: WorkstreamDetail["viewers"] = [],
    markOpened = true,
  ): Promise<WorkstreamDetail> {
    const root = this.locallyAuthorizedRoot(auth);
    return this.detailAfterAdmission(auth, root, viewers, markOpened);
  }

  /** Settle unseen state after a speculative socket is promoted by navigation. */
  async markOpenedAdmitted(auth: AuthContext): Promise<boolean> {
    this.locallyAuthorizedRoot(auth);
    if (auth.impersonatorUserId) return false;
    return this.markOpened(auth.userId);
  }

  private async detailAfterAdmission(
    auth: AuthContext,
    root: RootRow,
    viewers: WorkstreamDetail["viewers"],
    markOpened = true,
  ): Promise<WorkstreamDetail> {
    // Both ways of opening a work stream — the socket's snapshot and
    // `GET /workstreams/:id` — assemble their answer here, so this is where
    // "they have now seen it" is true. Ordered before the read below so the
    // detail this call returns already says so, rather than telling the
    // client it is unseen and correcting itself over the socket a beat later.
    // A support session opens it without it becoming opened for the person.
    if (markOpened && !auth.impersonatorUserId) await this.markOpened(auth.userId);
    const [workstream, participants, resources, connections] = await Promise.all([
      this.summary(root, auth.userId),
      this.participants(),
      this.resources(auth.userId),
      this.connections(auth.userId),
    ]);
    const elicitations = this.elicitations();
    const latestRun = first(this.storage.sql.exec<{
      run_id: string; origin: string; status: string; model: string | null;
      error_json: string | null; started_at: number; completed_at: number | null; created_at: number;
    }>(
      `SELECT run_id, origin, status, model, error_json, started_at, completed_at, created_at
         FROM runs WHERE parent_tool_call_id IS NULL
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

  /** The blocking question created by one run, read through its canonical turn. */
  async elicitationMessageForRunForRuntime(runId: string): Promise<Message | null> {
    const row = this.storage.sql.exec<PartRow>(
      `SELECT turn.id, turn.sequence_number, turn.attention_ordinal, turn.author_type,
              turn.author_user_id, turn.external_actor_json, turn.message_type, turn.content,
              turn.structured_content_json, turn.client_message_id, turn.edited_at, turn.created_at
         FROM elicitation_requests request
         JOIN canonical_conversation_turn_details turn
           ON turn.client_message_id = 'elicitation:' || request.elicitation_id
        WHERE request.run_id = ? AND turn.substream_id = '0'
          AND turn.visibility IN ('people', 'both')
        ORDER BY request.created_at, request.elicitation_id
        LIMIT 1`,
      runId,
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

  private async resources(
    viewerUserId: string,
    resourceIds?: readonly string[],
  ): Promise<WorkstreamDetail["resources"]> {
    const links = resourceIds === undefined
      ? this.storage.sql.exec<{
        resource_id: string;
        watch_enabled: number;
        relationship_type: string;
        resource_json: string;
      }>(
        `SELECT resource_id, watch_enabled, relationship_type, resource_json
           FROM workstream_resource_links ORDER BY attached_at DESC`,
      ).toArray()
      : resourceIds.length === 0
        ? []
        : this.storage.sql.exec<{
      resource_id: string;
      watch_enabled: number;
      relationship_type: string;
      resource_json: string;
    }>(
      `SELECT resource_id, watch_enabled, relationship_type, resource_json
         FROM workstream_resource_links
        WHERE resource_id IN (${resourceIds.map(() => "?").join(",")})
        ORDER BY attached_at DESC`,
      ...resourceIds,
    ).toArray();
    if (links.length === 0) return [];
    const placeholders = links.map(() => "?").join(",");
    // Same split as `loadVisibleRows`: this method's two branches share one
    // statement, so the clause is chosen with the branch rather than left to
    // the caller. `docs/agent-attachments.md`.
    const listed = resourceIds === undefined
      ? ` AND ${listedResourceVisibilitySql("resource")}`
      : "";
    const rows = await this.workspaceDatabase(this.root().parent_workspace_key).prepare(
      `SELECT resource.*,
              connection.connector_type AS connector_type,
              CASE WHEN watch.id IS NULL THEN 0 ELSE 1 END AS active_watch
         FROM resources resource
         LEFT JOIN connector_connections connection ON connection.id = resource.connection_id
         LEFT JOIN resource_watches watch
           ON watch.resource_id = resource.id AND watch.enabled = 1
        WHERE resource.workspace_id = ? AND resource.id IN (${placeholders})
          AND resource.provider != 'avalon_note'${listed}`,
    ).bind(
      this.root().parent_workspace_key,
      ...links.map((link) => link.resource_id),
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

  private async readBackAttachedResource(
    viewerUserId: string,
    resourceId: string,
  ): Promise<WorkstreamResource | null> {
    const attached = (await this.resources(viewerUserId, [resourceId]))[0];
    return attached ? WorkstreamResourceSchema.parse(attached) : null;
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

  async participant(userId: string): Promise<WorkstreamDetail["participants"][number] | null> {
    const user = await this.env.DB.prepare(
      `SELECT id, email, name, avatar_url, timezone, created_at FROM users WHERE id = ?`,
    ).bind(userId).first<UserRow>();
    // Hydrating the profile yields; read membership afterward so a concurrent
    // removal or re-add cannot publish the roster we observed before that await.
    const row = first(this.storage.sql.exec<{
      participation_reason: WorkstreamDetail["participants"][number]["participationReason"];
      added_at: number;
    }>(`SELECT participation_reason, added_at FROM participants WHERE user_id = ? AND status = 'active'`, userId));
    if (!row) return null;
    if (!user) throw new Error("participant_user_missing");
    return { user: userFromRow(user), participationReason: row.participation_reason, joinedAt: iso(row.added_at)! };
  }

  async authorizeParticipantAddition(auth: AuthContext, userId: string): Promise<void> {
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
      this.assertRetainedContentContains({
        scope: "personal",
        userIds: [...audience.userIds, userId],
      });
    }
  }

  /**
   * Seat the person narrowing this Channel through the grant authority, when
   * that is where its roster lives.
   *
   * Answers `false` for a Channel that has never been shared — `participants`
   * is still the authority there and the caller writes the row itself — and
   * `true` once the seat has been written as a grant and projected back.
   *
   * A refusal is named rather than swallowed. Narrowing to yourself is a share
   * decision, and the grant authority is what decides whether this person may
   * make one: somebody who reads the Channel only because it is
   * Organization-wide holds no grant, so they have nothing to narrow it *from*
   * and the ledger refuses them. Returning `false` there would send the write
   * back to the frozen table and abort on the trigger with no reason attached.
   */
  private async migratedRosterSeat(auth: AuthContext): Promise<boolean> {
    const identity = this.objectStore.identity();
    if (identity?.parentKind !== "workstream" || this.externalSubstreamId() !== "0") return false;
    if (new ParticipantAuthorityTransferStorage(this.storage).currentTransferId() === null) return false;
    const parent = await durableObjectStubForWorkspace(
      this.env, this.env.WORKSPACE_DOS, identity.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(identity.workspaceId)),
    );
    const result = await parent.mutateParticipantGrant({
      operationId: await stableUuid(["narrow-scope-seat", identity.parentId, auth.userId]),
      actorUserId: asUserId(auth.userId),
      userId: asUserId(auth.userId),
      active: true,
      target: {
        kind: "conversation",
        workspaceId: identity.workspaceId,
        parentId: identity.parentId,
        substreamId: this.externalSubstreamId(),
      },
    });
    if (result.status === "denied" || result.status === "conflict") {
      throw new ApiError(
        403,
        "workstream_scope_narrow_forbidden",
        "Share this thread with yourself before making it private",
      );
    }
    if (!this.isParticipant(auth.userId)) {
      throw new ApiError(
        409,
        "participant_access_changed",
        "Participant access changed; refresh and try again",
      );
    }
    return true;
  }

  private async prepareMessageParticipants(auth: AuthContext, clientMessageId: string, missingUserIds: readonly string[]): Promise<void> {
    const identity = this.objectStore.identity();
    if (identity?.parentKind !== "workstream"
      || new ParticipantAuthorityTransferStorage(this.storage).currentTransferId() === null) return;
    const target = { kind: "conversation" as const, workspaceId: identity.workspaceId,
      parentId: identity.parentId, substreamId: this.externalSubstreamId() };
    const parent = await durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, identity.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(identity.workspaceId)));
    for (const userId of missingUserIds) {
      const request = { target, actorUserId: auth.userId, userId: asUserId(userId), active: true, participationReason: "message" as const,
        operationId: await stableUuid(["message-participant", target, auth.userId, clientMessageId, userId]) };
      const result = userId === auth.userId
        ? await parent.joinConversation(request)
        : await parent.mutateParticipantGrant(request);
      if (result.status !== "ready" && result.status !== "committed") {
        throw new ApiError(409, "participant_access_changed", "Participant access changed; refresh and try again");
      }
      // A retried receipt must not restore a later revocation. The owner
      // delivers its newest projection, so check the resulting local roster.
      if (!this.isParticipant(userId)) {
        throw new ApiError(409, "participant_access_changed", "Participant access changed; refresh and try again");
      }
    }
  }

  async addParticipant(
    auth: AuthContext,
    userId: string,
  ): Promise<WorkstreamDetail["participants"][number]> {
    await this.authorizeParticipantAddition(auth, userId);
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
        if (!alreadyActive) startReadCursorAtLatest(sql, userId, now, userId !== auth.userId);
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

  /** Commit the child's roster projection and participant-added notification together. */
  privateChildMembershipEffects(input: {
    substreamId: string;
    userId: string;
    actorUserId: string;
    actorName: string;
    recipientName: string;
    active: boolean;
    now: number;
    suppressNotification?: boolean;
  }): RegionalEffectCommand[] {
    const root = this.root();
    const viewer = { partitionKey: `user:${input.userId}`, effect: this.userEffect(root, input.userId) };
    if (!input.active || input.userId === input.actorUserId || input.suppressNotification) return [viewer];
    const epoch = first(this.storage.sql.exec<{ participant_epoch: number }>(
      `SELECT participant_epoch FROM participants WHERE user_id = ?`,
      input.userId,
    ))?.participant_epoch ?? 0;
    return [
      viewer,
      ...this.participantAddedEffects({
        root,
        userId: input.userId,
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        recipientName: input.recipientName,
        epoch,
        now: input.now,
        substreamId: input.substreamId,
      }),
    ];
  }

  /** Names for an effect payload, read before a commit that cannot await. */
  async participantEffectNames(actorUserId: string, userId: string): Promise<{
    actorName: string;
    recipientName: string;
  }> {
    const names = await this.messageUsers([actorUserId, userId]);
    return {
      actorName: names.get(actorUserId)?.name ?? "A workspace member",
      recipientName: names.get(userId)?.name ?? "a workspace member",
    };
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
    // Child membership epochs share a parent ID, so scope notification identities
    // by child while preserving already-delivered Main identities.
    substreamId?: string;
  }): RegionalEffectCommand[] {
    const substreamId = input.substreamId ?? this.externalSubstreamId();
    const scope = substreamId === "0"
      ? input.root.workstream_key
      : `${input.root.workstream_key}:${substreamId}`;
    const sourceId = `participant:${scope}:${input.userId}:${input.epoch}`;
    const intentId = `participant_added:${scope}:${input.userId}:${input.epoch}`;
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
            `${input.actorName} added ${input.recipientName} to this ${
              substreamId === "0" ? "work stream" : "substream"
            }.`,
            8_000,
          ),
          canonicalUrl: null,
          digestible: true,
          occurredAt,
          sourceKind: "workstream_participant",
          sourceId,
          dedupeKey: sourceId,
          metadata: { participantUserId: input.userId, addedByUserId: input.actorUserId, substreamId },
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
            "At least one participant must remain in this thread",
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

  /**
   * Attach several resources at once, all or none: every one passes
   * {@link attachResource}'s source checks before any link is written, then
   * every link is written in one commit. A merge's embeds take this path, so a
   * refused embed refuses the merge before anything is shared
   * (docs/conversation-merge.md).
   *
   * A refusal names the position that failed, never the resource. `linked`
   * lists the ids this call newly linked; `resources` describes each in the
   * order asked, for a merge's stored embeds.
   */
  async attachResources(auth: AuthContext, resourceTokens: readonly string[]): Promise<
    | {
      ok: true;
      linked: string[];
      resources: MergeEmbed[];
      /** The newly linked resources as the rail reads them, for its live event. */
      attached: WorkstreamResource[];
    }
    | { ok: false; index: number; code: "resource_not_found" | "resource_access_denied" | "attachment_draft_requires_message" }
  > {
    await this.authorize(auth);
    // A citation names a resource by its UUID or by its alias
    // (resource-slug.ts); both resolve to the one row. A merge shares only
    // what its author may read (resource-share-rules.ts).
    if (resourceTokens.length === 0) return { ok: true, linked: [], resources: [], attached: [] };
    const resolved = await resolveShareableResources(this.env, auth, resourceTokens, { readCheck: true });
    if (!resolved.ok) return { ok: false, index: resolved.index, code: resolved.code };
    const rows = resolved.rows;
    const ids = [...rows.keys()];
    this.locallyAuthorizedRoot(auth);
    const present = new Set(this.storage.sql.exec<{ resource_id: string } & Record<string, SqlStorageValue>>(
      "SELECT resource_id FROM workstream_resource_links WHERE resource_id IN (SELECT value FROM json_each(?))",
      JSON.stringify(ids),
    ).toArray().map((row) => row.resource_id));
    const linked = ids.filter((id) => !present.has(id));
    if (linked.length > 0) {
      const now = Date.now();
      await this.objectStore.commitWithRegionalEffects(
        (sql) => {
          for (const resourceId of linked) {
            const resource = rows.get(resourceId)!;
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
            sql.exec(
              `INSERT INTO workstream_resource_links
                 (resource_id, attached_by_user_id, watch_enabled, relationship_type,
                  resource_json, attached_at, updated_at)
               VALUES (?, ?, 0, 'attachment', ?, ?, ?)
               ON CONFLICT(resource_id) DO NOTHING`,
              resourceId, auth.userId, JSON.stringify(descriptor), now, now,
            );
          }
          sql.exec(
            `INSERT INTO resource_inventory_revision(id, revision, updated_at) VALUES (1, 1, ?)
             ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
            now,
          );
        },
        () => [{ partitionKey: "common", effect: this.commonEffect(this.root()) }],
      );
    }
    const attached: WorkstreamResource[] = [];
    for (const resourceId of linked) {
      const resource = await this.readBackAttachedResource(auth.userId, resourceId);
      if (resource) attached.push(resource);
    }
    return {
      ok: true,
      linked,
      attached,
      resources: mergeEmbedsOf(rows),
    };
  }

  async attachResource(auth: AuthContext, resourceId: string): Promise<WorkstreamResource> {
    await this.authorize(auth);
    // Product dispatch has reloaded this relationship. Preserve the existing
    // member attachment path; guests additionally need an existing shared
    // exposure, established by the ordinary resource authorizer.
    const resolved = await resolveShareableResources(this.env, auth, [resourceId], { readCheck: auth.role === null });
    if (!resolved.ok) {
      if (resolved.code === "resource_not_found") throw new ApiError(404, "resource_not_found", "Resource not found");
      if (resolved.code === "attachment_draft_requires_message") {
        throw new ApiError(409,"attachment_draft_requires_message","Send this upload with a message before attaching it as an existing resource");
      }
      throw new ApiError(403, "resource_access_denied", "This personal resource is not available to the thread");
    }
    const resource = [...resolved.rows.values()][0]!;
    this.locallyAuthorizedRoot(auth);
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
    const attached = await this.readBackAttachedResource(auth.userId, resourceId);
    if (!attached) {
      throw new ApiError(409, "resource_reload_failed", "The resource was attached but could not be read back");
    }
    return attached;
  }

  /** Attach a resource already durably created by this run in WorkspaceDO. */
  /**
   * The outcome of a runtime attachment, as its one consumer needs it.
   *
   * `unlisted` is not a failure and is not `readback_failed`: the link
   * committed and the resource is reachable, and the only thing withheld is the
   * socket event. Keeping them apart matters because the caller answers a
   * missing resource with a canonical room resync, which for an unlisted one
   * would be a round trip to re-derive a rail that is already correct.
   */
  async attachRuntimeResource(
    workspaceId: string,
    resourceId: string,
    attachedByUserId: string | null,
    relationshipType: ResourceRelationshipType = "generated",
  ): Promise<
    | { outcome: "attached"; resource: WorkstreamResource }
    | { outcome: "unlisted" }
    | { outcome: "readback_failed" }
  > {
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
    // A socket event is how the member's rail learns about a resource without
    // reloading, so it advertises — and the listing rule is about advertising,
    // not about the shape of the read underneath it. Withholding it here leaves
    // the live rail agreeing with the enumeration that assembles the initial
    // detail; publishing it would put the row on screen that the enumeration
    // deliberately leaves out, until the next reload.
    if (isUnlistedResourceMetadata(String(resource.metadata_json ?? "{}"))) {
      return { outcome: "unlisted" };
    }
    try {
      const attached = await this.readBackAttachedResource(this.runtimeAuth().userId, resourceId);
      if (attached) return { outcome: "attached", resource: attached };
      logWarn(this.env, "workstream_runtime_resource_readback_failed_after_commit", {
        workspace_id: workspaceId,
        workstream_id: root.workstream_key,
        resource_id: resourceId,
        relationship_type: relationshipType,
        reason: "resource_not_visible",
      });
    } catch (error) {
      logWarn(this.env, "workstream_runtime_resource_readback_failed_after_commit", {
        workspace_id: workspaceId,
        workstream_id: root.workstream_key,
        resource_id: resourceId,
        relationship_type: relationshipType,
        reason: error instanceof Error ? error.message : "resource_readback_failed",
      });
    }
    return { outcome: "readback_failed" };
  }

  /**
   * Rename an artifact this thread generated, as the person asking. The title
   * lives on the workspace's resource row, which every thread linking it reads
   * live; this thread's frozen descriptor, which its message chips read, takes
   * it too. Answers the resource for this room's `resource_updated`, or null
   * when there is nothing to tell: the title was already this one here too, or
   * the resource is one enumeration leaves out.
   */
  async renameResource(auth: AuthContext, resourceId: string, title: string): Promise<WorkstreamResource | null> {
    await this.authorize(auth);
    const linked = await this.readBackAttachedResource(auth.userId, resourceId);
    if (!linked) throw new ApiError(404, "resource_not_found", "Resource not found");
    if (linked.direction !== "artifact") {
      throw new ApiError(409, "resource_not_artifact", "Only an artifact can be renamed");
    }
    const workspaceId = this.root().parent_workspace_key;
    const result = await (await this.workspaceDirectory(workspaceId)).renameResource({
      workspaceId, resourceId, title, renamedByUserId: auth.userId, at: new Date().toISOString(),
    });
    if (result.outcome === "not_found") throw new ApiError(404, "resource_not_found", "Resource not found");
    // The same write a runtime republish makes to its link, so the projection
    // that follows the inventory revision moves with it. It runs on
    // `unchanged` too: a retry after this write failed finds the workspace
    // already renamed, and only this descriptor still behind.
    const changed = await this.objectStore.commitWithRegionalEffects(
      (sql) => {
        const now = Date.now();
        const updated = sql.exec(
          `UPDATE workstream_resource_links SET resource_json = json_set(resource_json, '$.title', ?), updated_at = ?
            WHERE resource_id = ? AND json_extract(resource_json, '$.title') IS NOT ?
            RETURNING resource_id`,
          title, now, resourceId, title,
        ).toArray().length > 0;
        if (updated) {
          sql.exec(
            `INSERT INTO resource_inventory_revision(id, revision, updated_at) VALUES (1, 1, ?)
             ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
            now,
          );
        }
        return updated;
      },
      (updated) => updated ? [{ partitionKey: "common", effect: this.commonEffect(this.root()) }] : [],
    );
    // A resource enumeration leaves out keeps its new title but is not
    // advertised, as a runtime attach withholds its event.
    if (!result.listed || (!changed && result.outcome === "unchanged")) return null;
    return this.readBackAttachedResource(auth.userId, resourceId);
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

  elicitationById(elicitationId: string): Elicitation | undefined {
    return this.elicitationsIncludingResolved(elicitationId)[0];
  }

  private elicitationsIncludingResolved(elicitationId?: string): Elicitation[] {
    const root = this.root();
    return this.storage.sql.exec<{
      elicitation_id: string; run_id: string; prompt: string; response_type: string;
      options_json: string; minimum_selections: number; maximum_selections: number | null;
      target_user_id: string | null; status: string; answer_json: string | null;
      answered_by_user_id: string | null; created_at: number; answered_at: number | null;
    }>(
      `SELECT * FROM elicitation_requests
        ${elicitationId === undefined ? "" : "WHERE elicitation_id = ?"}
        ORDER BY created_at`,
      ...(elicitationId === undefined ? [] : [elicitationId]),
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

  private contentFenceAudience(value: string): ContentAudience | null {
    const parsed = ContentAudienceSchema.safeParse(parseJson<unknown>(value, null));
    return parsed.success ? parsed.data : null;
  }

  /**
   * Whether every retained attachment's source audience already contains this
   * proposed one.
   *
   * The predicate behind {@link assertRetainedContentContains}, exposed so a
   * caller that is about to widen several Channels at once can ask before it
   * starts. A Space audience change is exactly that: applying it Channel by
   * Channel and discovering a fence on the fourth leaves three already widened,
   * and widening is the one effect that cannot be taken back — somebody may
   * have read.
   */
  retainedContentContains(targetAudience: WorkstreamReaderAudience): boolean {
    const rows = this.storage.sql.exec<{ audience_json: string }>(
      `SELECT audience_json FROM content_audience_fences`,
    ).toArray();
    return rows.every((row) => {
      const sourceAudience = this.contentFenceAudience(row.audience_json);
      return Boolean(sourceAudience && contentAudienceContainsWorkstream(sourceAudience, targetAudience));
    });
  }

  /** Retained attachments cannot acquire readers outside their original source audience. */
  private assertRetainedContentContains(targetAudience: WorkstreamReaderAudience): void {
    if (this.retainedContentContains(targetAudience)) return;
    throw new ApiError(
      409,
      "workstream_audience_restricted_content",
      "This thread contains retained content that the wider audience cannot view",
    );
  }

  private backgroundTasks(): WorkstreamDetail["backgroundTasks"] {
    const harness = this.storage.sql.exec<{
      run_id: string; origin: string; status: string; usage_json: string | null;
      started_at: number; completed_at: number | null; created_at: number; final_turn_id: string | null;
    }>(
      `SELECT run_id, origin, status, usage_json, started_at, completed_at, created_at, final_turn_id
         FROM runs
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

  /**
   * Commit `mutate`, and this conversation's `directory_common` projection
   * with it when `mutate` says it changed something the projection carries.
   * For a caller outside this service whose write the parent must hear about,
   * such as a Sidekick attachment.
   */
  async commitWithCommonEffect(mutate: (sql: SqlStorage) => boolean): Promise<void> {
    await this.objectStore.commitWithRegionalEffects(
      mutate,
      (_sql, changed) => changed ? [{ partitionKey: "common", effect: this.commonEffect(this.root()) }] : [],
    );
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
    // A claim keeps projecting the deadline it claimed (see "Invariants" in
    // docs/terminal-workspaces.md); its own expiry stays as a floor in case a
    // claimed deadline is pushed out mid-claim. The provider-observation
    // deadline is deliberately absent: it moves on every check, and this
    // object's own alarm runs the check, so projecting it only made each check
    // a directory write that changed nothing else.
    const terminalCandidates = terminal?.sandbox_id
      ? [
          ["running", "stopping"].includes(terminal.lifecycle_state) ? terminal.idle_expires_at : null,
          ["stopped", "archiving"].includes(terminal.lifecycle_state) ? terminal.archive_due_at : null,
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
    const background = this.storage.sql.exec<{ root_substream_id: string | null }>(
      "SELECT root_substream_id FROM background_agent WHERE id = 1",
    ).toArray()[0];
    // Main's list is the Channel rail's. A breakout sends its own too, which
    // its parent does not read.
    const sidekickAttachmentIds = this.storage.sql.exec<{ sidekick_id: string }>(
      `SELECT sidekick_id FROM sidekick_attachments ORDER BY attached_at, sidekick_id`,
    ).toArray().map((row) => row.sidekick_id);
    return {
      kind: "directory_common" as const,
      backgroundAgent: background !== undefined,
      ...(background?.root_substream_id != null
        ? { backgroundAgentRootSubstreamId: asSubstreamId(background.root_substream_id) }
        : {}),
      appearance: root.appearance_json ? WorkstreamAppearanceSchema.parse(JSON.parse(root.appearance_json)) : undefined,
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
      createdByUserId: root.created_by_user_id,
      titleStatus: root.title_status,
      latestAttentionOrdinal: Math.max(0, root.next_attention_ordinal - 1),
      unreadTrackingStartOrdinal: root.unread_tracking_start_ordinal,
      nextWakeupDueAt: wakeup ? iso(wakeup.due_at) : null,
      nextWakeupPrompt: wakeup ? truncateUtf16Safe(wakeup.prompt, 500) : null,
      nextTerminalActionAt: terminalCandidates.length > 0
        ? iso(Math.min(...terminalCandidates))
        : null,
      resourceLinks,
      sidekickAttachmentIds,
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

  private async recentAddressingMessages(beforeTranscriptSequence: number, beforeInputSequence = 0): Promise<AddressingContextMessage[]> {
    const rows = this.storage.sql.exec<{
      author_type: "member" | "agent";
      author_user_id: string | null;
      content: string | null;
    }>(
      `SELECT author_type, author_user_id, content FROM (
         SELECT author_type, author_user_id, content, 0 AS source_order, sequence_number AS turn_order
           FROM canonical_conversation_turn_details
          WHERE substream_id = '0' AND sequence_number < ? AND message_type = 'text'
            AND author_type IN ('member', 'agent')
         UNION ALL
         SELECT 'member' AS author_type,
                author_user_id, json_extract(prepared_payload_json, '$.content') AS content,
                1 AS source_order, input_sequence AS turn_order
           FROM pending_loop_inputs
          WHERE input_sequence < ? AND message_type = 'text' AND actor = 'human'
       ) WHERE trim(content, char(9, 10, 13, 32)) <> ''
        ORDER BY source_order DESC, turn_order DESC LIMIT 10`,
      beforeTranscriptSequence,
      beforeInputSequence,
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
      // The classifier's system prompt names the agent Rally; labelling its own
      // turns with the code name would hide from the model who spoke last.
      authorName: row.author_type === "agent"
        ? "Rally"
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
    const common = this.commonEffect(root);
    // Transcript promotion has consumed its preparation rows by this point.
    // Carry its exact holds in the delivery result rather than reconstructing
    // them from a mailbox that no longer exists (or conflating input and turn).
    const attachmentReservationReleases = [
      ...(common.attachmentReservationReleases ?? []),
      ...deliveryEffects.flatMap((delivery) => (delivery.attachmentResourceIds ?? []).map((resourceId) => ({
        inputId:delivery.inputId,resourceId,
      }))),
    ];
    const commands: RegionalEffectCommand[] = [
      { partitionKey: "common", effect: { ...common,
        ...(attachmentReservationReleases.length ? { attachmentReservationReleases } : {}),
      } },
      ...affectedUserIds.map((userId) => ({
        partitionKey: `user:${userId}`,
        effect: this.userEffect(root, userId),
      })),
    ];
    const occurredAt = new Date(root.updated_at).toISOString();
    const title = truncateUtf16Safe(root.title, 500);

    for (const delivery of deliveryEffects) {
      // The canonical view, not `participant_transcript_turns`: the turn
      // table has no structured content, and reading it there threw here and
      // stopped every queued message's delivery.
      const turn = first(this.storage.sql.exec<{ message_type: string; structured_content_json: string | null }>(
        `SELECT message_type, structured_content_json FROM canonical_conversation_turn_details WHERE id = ? LIMIT 1`,
        delivery.turnId,
      ));
      const messageType = turn?.message_type;
      // A merge that queued behind input carries its tag here, as one written
      // at once does, so it is a `merged` Activity row either way.
      const merge = (() => {
        try {
          const parsed = ConversationMergeV1Schema.safeParse(JSON.parse(turn?.structured_content_json ?? "null"));
          return parsed.success ? parsed.data : undefined;
        } catch {
          return undefined;
        }
      })();
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
          body: notificationMessageExcerpt(delivery.text),
          canonicalUrl: null,
          digestible: true,
          occurredAt,
          sourceKind: "workstream_message",
          sourceId: delivery.turnId,
          dedupeKey: `message:${delivery.turnId}`,
          metadata: {
            substreamId: this.externalSubstreamId(),
            attentionOrdinal: delivery.attentionOrdinal,
            ...mergeActivityMetadata(merge),
          },
          targets: activityTargets(
            delivery.affectedUserIds,
            delivery.authorUserId === null ? [] : delivery.mentionedUserIds,
            delivery.authorUserId,
          ),
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
              messageText: notificationMessageExcerpt(delivery.text),
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
    const loopId = this.conversationLoopId(root);
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
    const text = this.withPersonalSystemPrompt(input.text,
      input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : undefined, input.origin);
    const participant = await this.transcript.prepareParticipantMessage({
      turnId: input.messageId,
      actor: "external",
      authorUserId: null,
      authorSnapshot: null,
      clientMessageId: input.clientMessageId,
      messageType: input.messageType,
      text,
      structuredContentJson: input.structuredContentJson,
      externalActorJson: JSON.stringify(input.actor),
      producedByRunId: null,
      messageSequenceNumber: this.root().next_sequence_number,
      createdAtUtc: new Date(input.now).toISOString(),
      attentionOrdinal: null,
    });
    const bindMessage = await projectParticipantModelMessage(this.env, {
      author: { type: "external", actor: input.actor },
      externalFraming: this.transcript.externalInputFraming(),
      messageType: input.messageType,
      text,
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

  /** Shared durable admission for non-human conversation inputs. */
  async admitSystemActivation(
    rawInput: AdmitSystemActivationInput,
  ): Promise<WorkstreamObjectExternalMessageResult> {
    const input = AdmitSystemActivationInputSchema.parse(rawInput);
    const root = this.assertExternalMessageIdentity(input);
    if (root.archived_at !== null) throw new Error("workstream_archived");
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
    const preparation = await this.reserveInputPreparation({
      root,
      inputId: input.messageId,
      clientMessageId: input.clientMessageId,
      preparationKind: "automation_activation",
      envelope: { input },
      now: input.now,
    });
    return this.runInputPreparation(preparation, async () => {
      const prepared = await this.prepareSystemActivation({
        ...input,
        messageId: preparation.input_id,
        now: preparation.created_at,
      });
      const admitted = this.storage.transactionSync(() => {
        if (this.root().archived_at !== null) throw new Error("workstream_archived");
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
        const completed = this.completePreparedSystemActivation(
          { ...input, messageId: preparation.input_id, now: preparation.created_at },
          prepared,
          preparation.loop_id,
        );
        if ("agentExchange" in input && input.resumeStopped !== false && completed.outcome === "admitted") {
          // Continuation and admission are one durable transition. Replaying
          // an older message must never clear a stop requested after it.
          this.storage.sql.exec("UPDATE background_agent SET stopped_at = NULL WHERE id = 1");
        }
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
      return this.externalPendingMessageResult(admitted.input, admitted.inserted);
    });
  }

  private async prepareSystemActivation(input: AdmitSystemActivationInput) {
    const attachmentIds = "agentExchange" in input ? input.attachmentIds : [];
    const resources = attachmentIds.length === 0 ? [] : (await (await this.workspaceDirectory(input.workspaceId))
      .resourceDescriptors({ workspaceId: input.workspaceId, resourceIds: attachmentIds, draftUploadedByUserId: null })).items;
    // Prepare immutable descriptors without linking anything. The ordinary
    // input promotion commits attachment links with the admitted transcript.
    const attachments: PendingInputAttachmentDescriptor[] = attachmentIds.map((resourceId, position) => {
      const resource = resources.find((row) => String(row.id) === resourceId);
      if (!resource) throw new ApiError(422, "agent_attachment_unavailable", "The agent attachment is unavailable");
      return {
        resourceId, position,
        resourceJson: JSON.stringify({
          id: resourceId,
          connectionId: resource.connection_id == null ? null : String(resource.connection_id),
          type: String(resource.resource_type), provider: String(resource.provider),
          providerResourceId: resource.provider_resource_id == null ? null : String(resource.provider_resource_id),
          title: String(resource.title),
          mimeType: resource.mime_type == null ? null : String(resource.mime_type),
          contentRef: resource.content_ref == null ? null : String(resource.content_ref),
          canonicalUrl: resource.canonical_url == null ? null : String(resource.canonical_url),
          metadata: parseJson(String(resource.metadata_json ?? "{}"), {}),
        }),
        attachmentJson: JSON.stringify({ attachedAt: new Date(input.now).toISOString() }),
        attachedByUserId: input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : null,
        watchEnabled: false, relationshipType: "message_attachment",
        attachedAt: input.now, updatedAt: input.now,
      };
    });
    const agentExchange = "agentExchange" in input ? input.agentExchange : null;
    const agentContent = "agentExchange" in input
      ? { kind: AGENT_MESSAGE_CONTENT_KIND, ...input.agentExchange, attachmentIds: input.attachmentIds } : null;
    const structuredContentJson = JSON.stringify(agentContent ?? ("activation" in input ? input.activation : null));
    const participant = await this.transcript.prepareParticipantMessage({
      turnId: input.messageId,
      actor: "system",
      authorUserId: null,
      authorSnapshot: null,
      clientMessageId: input.clientMessageId,
      messageType: agentExchange ? "system" : "automation_activation",
      text: input.text,
      structuredContentJson,
      externalActorJson: null,
      producedByRunId: null,
      messageSequenceNumber: this.root().next_sequence_number,
      createdAtUtc: new Date(input.now).toISOString(),
      attentionOrdinal: null,
    });
    // Agent messages are ordinary instructions with explicit sender/reply
    // identity. They never impersonate a workspace participant.
    const bindMessage: PromptMessage = {
      role: "user",
      content: agentContent
        ? renderAgentMessage(agentContent, input.text)
        : [
            `"${"activation" in input ? input.activation.automationName : ""}", delivered ${new Date(input.now).toISOString()}.`,
            input.text,
          ].join("\n"),
    };
    return { participant, attachments, bindPayloadJson: canonicalModelMessageJson(bindMessage) };
  }

  private completePreparedSystemActivation(
    input: AdmitSystemActivationInput,
    prepared: { participant: PreparedParticipantMessage; attachments: PendingInputAttachmentDescriptor[]; bindPayloadJson: string },
    expectedLoopId: string,
  ) {
    const currentLoop = this.loops.loop();
    if (!currentLoop || currentLoop.loop_id !== expectedLoopId) {
      throw new Error("substream_loop_identity_mismatch");
    }
    return this.loops.completeInputPreparation({
      inputId: input.messageId,
      preparedTurnId: input.messageId,
      // Agent messages enter at a safe tool boundary; scheduled activations
      // wait for the current execution. Neither interrupts in-flight work.
      mode: "agentExchange" in input ? "steer" : "queue",
      actor: "system",
      authorUserId: null,
      authorNameSnapshot: null,
      authorAvatarUrlSnapshot: null,
      clientMessageId: input.clientMessageId,
      externalActorJson: null,
      messageType: "agentExchange" in input ? "system" : "automation_activation",
      preparedPayloadId: prepared.participant.fact.payloadId,
      preparedFactId: prepared.participant.fact.factId,
      preparedPayloadAudience: prepared.participant.fact.audience,
      preparedPayloadMediaType: "application/json",
      preparedPayloadJson: prepared.participant.fact.canonical,
      preparedPayloadSha256: prepared.participant.fact.hash,
      preparedPayloadByteLength:
        new TextEncoder().encode(prepared.participant.fact.canonical).byteLength,
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
        ...("agentExchange" in input ? { agentExchange: input.agentExchange } : {}),
        parentHarnessRunId: null,
        slackOrigin: null,
        slackSearchAuthorization: null,
      }),
      attachmentsJson: JSON.stringify(prepared.attachments),
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
    const preparation = await this.reserveInputPreparation({
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
    const preparation = await this.reserveInputPreparation({
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
            const cancelled = first(this.storage.sql.exec<{ ok: number }>(
              `SELECT 1 AS ok FROM elicitation_requests
                WHERE elicitation_id = ? AND status = 'cancelled'`,
              input.elicitationId,
            ));
            if (cancelled) {
              this.loops.discardInputPreparation({ inputId: preparation.input_id, now: input.now });
              return { kind: "cancelled" as const };
            }
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
            const cancelled = first(this.storage.sql.exec<{ ok: number }>(
              `SELECT 1 AS ok FROM elicitation_requests
                WHERE elicitation_id = ? AND status = 'cancelled'`,
              input.elicitationId,
            ));
            if (cancelled) {
              throw new ApiError(409, "elicitation_cancelled", "This question was cancelled by a newer message");
            }
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
      if (result.kind === "cancelled") {
        throw new ApiError(409, "elicitation_cancelled", "This question was cancelled by a newer message");
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
    return this.createMessageWithAuthority(auth, rawInput, true);
  }

  /** Admit a command whose live room socket already carries this identity. */
  async createMessageForAdmittedSocket(
    auth: AuthContext,
    rawInput: WorkstreamObjectCreateMessageInput,
  ): Promise<WorkstreamObjectCreateMessageResult> {
    return this.createMessageWithAuthority(auth, rawInput, false);
  }

  private async createMessageWithAuthority(
    auth: AuthContext,
    rawInput: WorkstreamObjectCreateMessageInput,
    reauthorizeWorkspaceMembership: boolean,
  ): Promise<WorkstreamObjectCreateMessageResult> {
    const input = WorkstreamObjectCreateMessageInputSchema.parse(rawInput);
    if (input.clientMessageId.startsWith("resource-authorization:")
      && auth.principal !== "resource_authorization") {
      throw new ApiError(403, "resource_authorization_message_id_reserved", "This message ID is reserved for connector authorization");
    }
    const requestHash = messageAdmissionRequestHash(auth.userId, input);
    const authorizedRoot = () => reauthorizeWorkspaceMembership
      ? this.authorize(auth)
      : Promise.resolve(this.locallyAuthorizedRoot(auth));
    const localRoot = this.locallyAuthorizedRoot(auth);
    const replayAcceptedMessage = async (): Promise<WorkstreamObjectCreateMessageResult | null> => {
      this.messageAdmissionReceipt(
        this.storage.sql,
        input.clientMessageId,
        requestHash,
      );
      const existing = first(this.storage.sql.exec<{
        id: string; created_at: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT id, created_at FROM canonical_conversation_turn_details WHERE client_message_id = ?`,
        input.clientMessageId,
      ));
      if (existing) {
        await authorizedRoot();
        return this.canonicalMessageReplay(existing, input.clientMessageId);
      }
      const existingPending = this.loops.inputByClientMessageId(input.clientMessageId);
      if (existingPending) {
        const root = await authorizedRoot();
        const loop = this.loops.loop();
        if (!loop || loop.loop_id !== existingPending.loop_id
          || loop.loop_id !== this.conversationLoopId(root)) {
          throw new Error("substream_loop_identity_mismatch");
        }
        return this.pendingMessageResult(existingPending, false);
      }
      return null;
    };
    const replay = await replayAcceptedMessage();
    if (replay) return replay;
    const reservationNow = Date.now();
    const reservation = await this.reserveInputPreparation({
      root: localRoot,
      inputId: uuidV7(reservationNow),
      clientMessageId: input.clientMessageId,
      preparationKind: "human_message",
      envelope: { auth, input },
      validateReplay: (originalEnvelopeJson) => {
        const original = HumanMessagePreparationEnvelopeSchema.parse(JSON.parse(originalEnvelopeJson));
        if (messageAdmissionRequestHash(original.auth.userId, original.input) !== requestHash) {
          throw new ApiError(409, "substream_message_idempotency_conflict",
            "This client message id was already used for another message");
        }
      },
      now: reservationNow,
    });
    // Reservation yields: its owner may already have settled by this continuation.
    const preparation = this.loops.inputPreparation(reservation.input_id);
    if (!preparation || preparation.state === "ready" || preparation.state === "discarded"
      || this.inputPreparationClaimIsLive(preparation.input_id, Date.now())) {
      // Promotion removes the mailbox. Both a missing row and a settled live
      // owner must replay accepted authority before reporting a genuine failure.
      if (preparation) await this.waitForInputPreparation(preparation.input_id);
      const replay = await replayAcceptedMessage();
      if (replay) return replay;
      const state = this.loops.inputPreparation(reservation.input_id)?.state;
      if (state === "failed") {
        throw new ApiError(409, "pending_input_preparation_failed", "This message could not be prepared");
      }
      throw new Error(`pending_input_preparation_${state ?? "not_found"}`);
    }
    const sent: { value?: Omit<MessageSentObservation, "messageId"> } = {};
    const result = await this.runInputPreparation<WorkstreamObjectCreateMessageResult>(preparation, async () => {
    const root = await authorizedRoot();

    const requestedPersonIds = [...new Set(input.mentions.flatMap((mention) =>
      mention.type === "person" && mention.userId ? [mention.userId] : []))];
    const allMemberIds = [...new Set([auth.userId, ...requestedPersonIds, ...input.confirmedParticipantUserIds])];
    const people = new Map<string, MentionPerson>();
    const accessClasses = new Map<string, "member" | "guest">();
    if (allMemberIds.length > 0) {
      const placeholders = allMemberIds.map(() => "?").join(",");
      const result = await this.env.DB.prepare(
        `SELECT user.id, user.name, user.avatar_url, member.access_class
           FROM workspace_members member JOIN users user ON user.id = member.user_id
          WHERE member.workspace_id = ? AND member.status = 'active'
            AND user.id IN (${placeholders})`,
      ).bind(auth.workspaceId, ...allMemberIds).all<{
        id: string; name: string; avatar_url: string | null; access_class: "member" | "guest";
      }>();
      for (const row of result.results ?? []) {
        people.set(row.id, { id: row.id, name: row.name, avatarUrl: row.avatar_url });
        accessClasses.set(row.id, row.access_class);
      }
      if (people.size !== allMemberIds.length) {
        throw new ApiError(422, "invalid_workspace_member", "A mentioned person is not an active workspace member");
      }
    }
    const prepared = prepareMentionMarkdown(input.text, input.mentions, people);
    const personIds = [...new Set(prepared.mentions.flatMap((mention) =>
      mention.type === "person" && mention.userId ? [mention.userId] : []))];
    // Only members already have Organization-wide read access. Guests and
    // personal audiences still require confirmation to enlarge access; only
    // canonical mentions, never raw IDs from rejected ranges, can seat people.
    const confirmedParticipantUserIds = personIds.filter((userId) =>
      input.confirmedParticipantUserIds.includes(userId)
      || (root.scope === "workspace" && admitsOrganizationWide(accessClasses.get(userId)!)));
    if (root.scope === "personal" && confirmedParticipantUserIds.length > 0) {
      const currentAudience = this.readerAudience(root);
      if (currentAudience.scope !== "personal") throw new Error("personal_reader_audience_expected");
      this.assertRetainedContentContains({
        scope: "personal",
        userIds: [...new Set([...currentAudience.userIds, ...confirmedParticipantUserIds])],
      });
    }
    const unconfirmed = personIds.filter((userId) =>
      !this.isParticipant(userId) && !confirmedParticipantUserIds.includes(userId));
    if (unconfirmed.length > 0) {
      throw new ApiError(409, "participant_confirmation_required", "Confirm before mentioning a nonparticipant", {
        people: unconfirmed.map((userId) => ({ userId, name: people.get(userId)?.name ?? "Workspace member" })),
      });
    }
    // Most messages change no participation. Stay synchronous on that path,
    // without reading identity/transfer state or contacting the grant owner.
    // Counted before anything seats them: once participant authority has
    // moved to the parent, preparation below projects them into the roster.
    const participantCount = Number(first(this.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM participants WHERE status = 'active'`,
    ))?.count ?? 0);
    const participantAddedCount = new Set(confirmedParticipantUserIds.filter((userId) => !this.isParticipant(userId))).size;
    const missingParticipantUserIds = [...new Set([auth.userId, ...confirmedParticipantUserIds])]
      .filter((userId) => !this.isParticipant(userId));
    const structuredContent = input.merge ?? (input.annotations?.length
      ? await new ResourceService(this.env,auth).annotationContent(input.annotations) : null);
    if (missingParticipantUserIds.length > 0) {
      await this.prepareMessageParticipants(auth, input.clientMessageId, missingParticipantUserIds);
    }
    const attachmentRows = await this.reserveAttachmentDrafts({
      workspaceId: auth.workspaceId,
      workstreamId: root.workstream_key,
      inputId: preparation.input_id,
      userId: auth.userId,
      resourceIds: input.attachmentIds,
      now: preparation.created_at,
    });
    sent.value = {
      workspaceId: auth.workspaceId,
      workstreamId: root.workstream_key,
      scope: root.scope,
      origin: new WorkstreamIdentityStorage(this.storage).identity()?.origin_type ?? "ad_hoc",
      messageKind: "message",
      attachmentCount: input.attachmentIds.length,
      mentionCount: prepared.mentions.length,
      participantAddedCount,
    };

    const connectorMentions = prepared.mentions
      .flatMap((mention) => mention.type === "connector" && mention.connectorType
        ? [mention.connectorType] : []);
    let shouldInvoke = Boolean(input.forcedHarnessOrigin) || participantCount <= 1 || attachmentRows.length > 0 || Boolean(input.annotations?.some((a)=>a.comment.trim()));
    if (input.merge) {
      // A merge is a result posted for the thread's readers, never a request
      // to Rally: it starts no run, whatever the room's size.
      shouldInvoke = false;
    } else if (input.seed) {
      // A seed action states its addressing outcome instead of being classified.
      // A scripted assistant turn means this message starts a run; `null` means
      // it starts none — whatever the room's size or the message's attachments
      // would otherwise force. Admitting a human message in a multi-person room
      // otherwise asks a *model* whether it addresses Rally, and seeding a
      // scripted conversation cannot wait on a live guess about each line when
      // the pack is the authority on which lines start a run.
      shouldInvoke = input.seed.assistant !== null;
    } else if (!input.forcedHarnessOrigin && this.objectStore.identity()?.parentKind === "workstream"
      && this.root().next_sequence_number === 1 && !this.loops.hasInputAhead(preparation.input_sequence)) {
      // Read current state after preparation's awaits. A prior input can have
      // become canonical while this request was resolving people/attachments.
      shouldInvoke = await openingMessageStartsRun(this.env, {
        workspaceId: auth.workspaceId,
        workstreamId: root.workstream_key,
        substreamId: this.externalSubstreamId(),
        message: annotationCommentText(input.text, input.annotations),
        humanMentions: mentionedPersonNames(prepared.mentions),
        connectorMentions,
        attachmentCount: attachmentRows.length,
        defer: this.defer,
      });
    } else if (!shouldInvoke) {
      await this.waitForEarlierInputPreparations(preparation.input_sequence);
      const activeTask = this.loops.loop()?.status === "executing";
      const classification = await classifyWorkstreamMessage(this.env, {
        workspaceId: auth.workspaceId,
        workstreamId: root.workstream_key,
        userId: auth.userId,
        message: annotationCommentText(input.text, input.annotations),
        authorName: people.get(auth.userId)?.name ?? null,
        activeTask,
        connectorMentions,
        humanMentions: mentionedPersonNames(prepared.mentions),
        recentMessages: await this.recentAddressingMessages(Number(this.storage.sql.exec<{
          next_transcript_sequence: number;
        } & Record<string, SqlStorageValue>>(
          `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
        ).one().next_transcript_sequence), preparation.input_sequence),
        defer: this.defer,
      });
      shouldInvoke = classification.classification === "agent_action"
        || classification.classification === "both"
        || (classification.classification === "uncertain" && (activeTask || connectorMentions.length > 0));
    }
    // A message for the people in the room lands at once — unless something
    // sent before it is still queued for Rally. Written straight away it would
    // take a transcript sequence ahead of that input, and a reply would read
    // above the message it answers. It queues behind instead, and starts no run.
    // Not behind a stopped background agent: its queue does not move until
    // someone resumes it, and the room should not wait on that.
    const waitsForInputAhead = !shouldInvoke
      && this.storage.sql.exec<{ stopped: number }>(
        "SELECT COUNT(*) AS stopped FROM background_agent WHERE stopped_at IS NOT NULL",
      ).one().stopped === 0
      && this.loops.hasInputAhead(preparation.input_sequence);
    const now = preparation.created_at;
    const messageId = preparation.input_id;
    const messageText = this.withPersonalSystemPrompt(prepared.text, auth.userId,
      input.forcedHarnessOrigin ?? (input.seed ? "demo_seed" : "human_message"));
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
      text: messageText,
      structuredContentJson: structuredContent ? JSON.stringify(structuredContent) : null,
      externalActorJson: null,
      producedByRunId: null,
      messageSequenceNumber: root.next_sequence_number,
      createdAtUtc: new Date(now).toISOString(),
      attentionOrdinal: root.next_attention_ordinal,
    });
    if (shouldInvoke || waitsForInputAhead) {
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
        author: {
          type: "human",
          // `null` rather than the transcript's UNKNOWN_MEMBER_DISPLAY_NAME:
          // that placeholder exists so a row has something to render, and the
          // model is better served by an attribution that carries the id alone
          // than by one asserting this person is called "A workspace member".
          userId: auth.userId,
          displayName: people.get(auth.userId)?.name ?? null,
        },
        messageType: "text",
        text: messageText,
        structuredContent,
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
      if (loop.loop_id !== this.conversationLoopId(root)) {
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
      const committed = await this.objectStore.commitWithRegionalEffects(() => {
        const receipt = this.messageAdmissionReceipt(
          this.storage.sql,
          input.clientMessageId,
          requestHash,
        );
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
          return { kind: "pending" as const, input: concurrentPending, inserted: false, authorJoined: false };
        }
        if (receipt === "replayed") {
          throw new Error("substream_message_receipt_without_projection");
        }
        const currentLoop = this.loops.loop();
        if (!currentLoop || currentLoop.loop_id !== loop.loop_id) {
          throw new Error("substream_loop_identity_mismatch");
        }
        if (input.expectedLatestHarnessRunId) {
          const latest = first(this.storage.sql.exec<{ run_id: string }>(
            `SELECT run_id FROM runs WHERE parent_tool_call_id IS NULL
              ORDER BY created_at DESC, run_id DESC LIMIT 1`,
          ));
          if (latest?.run_id !== input.expectedLatestHarnessRunId) {
            throw new ApiError(409, "terminal_repository_request_stale", "The thread changed before this message was admitted");
          }
        }
        // Sending is participation when the message is accepted, even while
        // its turn waits behind an active run. Handoff-owned rosters were
        // already seated through prepareMessageParticipants above.
        const authorJoined = !this.isParticipant(auth.userId);
        if (authorJoined) {
          if (new ParticipantAuthorityTransferStorage(this.storage).currentTransferId() !== null) {
            throw new ApiError(409, "participant_access_changed", "Participant access changed; refresh and try again");
          }
          new WorkstreamIdentityStorage(this.storage).admitParticipant({
            userId: auth.userId, addedByUserId: auth.userId, reason: "message", now,
          });
          this.storage.sql.exec(
            `UPDATE participants SET first_opened_at = ?, updated_at = ? WHERE user_id = ?`,
            now, now, auth.userId,
          );
          enqueueSemanticRealtimeReference(this.storage.sql, { kind: "participant_changed", userId: auth.userId }, now);
        }
        const result = this.loops.completeInputPreparation({
          inputId: messageId,
          preparedTurnId: messageId,
          mode: shouldInvoke ? input.runMode ?? "queue" : "queue",
          startsRun: shouldInvoke,
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
            reason: input.forcedHarnessOrigin ?? (input.seed ? "demo_seed" : "human_message"),
            parentHarnessRunId: input.parentHarnessRunId ?? null,
            expectedLatestHarnessRunId: input.expectedLatestHarnessRunId ?? null,
            expectedToolInvocationId: input.expectedToolInvocationId ?? null,
            telemetryOperationId: input.telemetryOperationId ?? null,
            telemetryRequestReceivedAt: input.telemetryRequestReceivedAt ?? null,
            telemetryJourney: input.telemetryJourney ?? null,
            slackOrigin: input.slackOrigin ?? null,
            slackSearchAuthorization: input.slackSearchAuthorization ?? null,
            // The only carrier available: a message-started run's execution
            // context is rebuilt from this blob at activation.
            seed: input.seed ?? null,
          }),
          attachmentsJson: JSON.stringify(attachmentDescriptors),
          mentionsJson: JSON.stringify(mentions),
          now,
        });
        this.recordMessageAdmissionReceipt(
          this.storage.sql,
          input.clientMessageId,
          requestHash,
          now,
        );
        return {
          kind: "pending" as const,
          input: result.input,
          inserted: result.outcome === "admitted",
          authorJoined,
        };
      }, (_sql, write) => write.kind === "pending" && write.authorJoined ? [{
        partitionKey: `user:${auth.userId}`, effect: this.userEffect(this.root(), auth.userId),
      }] : []);
      const admitted = committed.result;
      if (admitted.kind === "canonical") {
        return this.canonicalMessageReplay(admitted.existing, input.clientMessageId);
      }
      return this.pendingMessageResult(admitted.input, admitted.inserted);
    }
    const affectedUsers = [...new Set([auth.userId, ...personIds, ...confirmedParticipantUserIds])];
    const committed = await this.objectStore.commitWithRegionalEffects<LocalMessageWrite>(
      (sql) => {
        const receipt = this.messageAdmissionReceipt(
          sql,
          input.clientMessageId,
          requestHash,
        );
        const current = first(sql.exec<RootRow>(`SELECT * FROM workstream WHERE id = 1`));
        if (!current) throw new ApiError(404, "workstream_not_found", "Thread not found");
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
        if (receipt === "replayed") {
          throw new Error("substream_message_receipt_without_projection");
        }
        this.loops.cancelPendingElicitations(now);
        const sequence = current.next_sequence_number;
        const attention = current.next_attention_ordinal;
        const openedParticipant = first(sql.exec<{ user_id: string }>(
          `UPDATE participants SET first_opened_at = COALESCE(first_opened_at, ?), updated_at = ?
           WHERE user_id = ? AND status = 'active' RETURNING user_id`,
          now, now, auth.userId,
        ));
        if (!openedParticipant) sql.exec(
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
        if (!openedParticipant) {
          enqueueSemanticRealtimeReference(sql, { kind: "participant_changed", userId: auth.userId }, now);
        }
        for (const userId of confirmedParticipantUserIds) {
          if (this.isParticipant(userId)) continue;
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
          // Before this message takes its ordinal, so it is the first unread.
          startReadCursorAtLatest(sql, userId, now, false);
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
        this.recordMessageAdmissionReceipt(
          sql,
          input.clientMessageId,
          requestHash,
          now,
        );
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
            body: notificationMessageExcerpt(prepared.text),
            canonicalUrl: null,
            digestible: true,
            occurredAt,
            sourceKind: "workstream_message",
            sourceId: messageId,
            dedupeKey: `message:${messageId}`,
            metadata: {
              substreamId: this.externalSubstreamId(),
              attentionOrdinal: write.attentionOrdinal,
              // What makes the message a `merged` Activity row.
              ...mergeActivityMetadata(input.merge),
            },
            targets: activityTargets(affectedUsers, personIds, auth.userId),
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
            messageText: notificationMessageExcerpt(prepared.text),
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
    if (result.inserted && sent.value) {
      recordMessageSentTelemetry(this.env, auth, { ...sent.value, messageId: result.turn.turnId }, this.defer);
    }
    return result;
  }

  async answerElicitation(
    auth: AuthContext,
    elicitationId: string,
    rawInput: WorkstreamObjectAnswerElicitationInput,
    /**
     * The Slack message that carried the answer, when one did. Server-owned,
     * like `createMessage`'s: only the internal product request reaches here
     * with it, and the run the answer starts delivers back to that message.
     */
    slackOrigin?: unknown,
  ): Promise<WorkstreamObjectAnswerElicitationResult> {
    return this.answerElicitationWithAuthority(auth, elicitationId, rawInput, true, slackOrigin);
  }

  /** Answer from a room socket whose hibernation attachment already admitted this identity. */
  async answerElicitationForAdmittedSocket(
    auth: AuthContext,
    elicitationId: string,
    rawInput: WorkstreamObjectAnswerElicitationInput,
  ): Promise<WorkstreamObjectAnswerElicitationResult> {
    return this.answerElicitationWithAuthority(auth, elicitationId, rawInput, false);
  }

  private async answerElicitationWithAuthority(
    auth: AuthContext,
    elicitationId: string,
    rawInput: WorkstreamObjectAnswerElicitationInput,
    reauthorizeWorkspaceMembership: boolean,
    slackOrigin?: unknown,
  ): Promise<WorkstreamObjectAnswerElicitationResult> {
    const input = AnswerElicitationRequestSchema.parse(rawInput);
    const requestHash = workstreamImportHash({
      command: "answer_elicitation",
      elicitationId,
      authorUserId: auth.userId,
      input,
    });
    const authorizedRoot = () => reauthorizeWorkspaceMembership
      ? this.authorize(auth)
      : Promise.resolve(this.locallyAuthorizedRoot(auth));
    const replayedElicitation = (): Elicitation | undefined => {
      const elicitation = this.elicitationsIncludingResolved().find((entry) => entry.id === elicitationId);
      if (!elicitation) return undefined;
      const skipped = "skipped" in input && input.skipped;
      const sameAnswer = skipped
        ? elicitation.answer === null
        : JSON.stringify(elicitation.answer) === JSON.stringify(input.answer);
      if (elicitation.answeredByUserId !== auth.userId || !sameAnswer) {
        throw new ApiError(
          409,
          "elicitation_response_idempotency_conflict",
          "This question was already answered with another response",
        );
      }
      return elicitation;
    };
    const clientMessageId = `elicitation-response:${elicitationId}`;
    this.messageAdmissionReceipt(this.storage.sql, clientMessageId, requestHash, {
      code: "elicitation_response_idempotency_conflict",
      message: "This question was already answered with another response",
    });
    const canonicalReplay = first(this.storage.sql.exec<{
      id: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT id FROM canonical_conversation_turn_details WHERE client_message_id = ?`,
      clientMessageId,
    ));
    if (canonicalReplay) {
      await authorizedRoot();
      return {
        elicitation: replayedElicitation(),
        responsePartId: canonicalReplay.id,
        activationRequest: null,
        inserted: false,
      };
    }
    const replay = this.loops.inputByClientMessageId(clientMessageId);
    if (replay) {
      const root = await authorizedRoot();
      const loop = this.loops.loop();
      if (!loop || loop.loop_id !== replay.loop_id
        || loop.loop_id !== this.conversationLoopId(root)) {
        throw new Error("substream_loop_identity_mismatch");
      }
      return {
        elicitation: replayedElicitation(),
        responsePartId: replay.prepared_turn_id,
        activationRequest: loop.status === "idle" ? {
          kind: "activate_substream_loop",
          loopId: loop.loop_id,
          cause: "pending_input",
          inputId: replay.input_id,
        } : null,
        inserted: false,
      };
    }
    const localRoot = this.locallyAuthorizedRoot(auth);
    const reservationNow = Date.now();
    const preparation = await this.reserveInputPreparation({
      root: localRoot,
      inputId: uuidV7(reservationNow),
      clientMessageId,
      preparationKind: "human_elicitation",
      envelope: { auth, elicitationId, input },
      now: reservationNow,
    });
    const sent: { value?: Omit<MessageSentObservation, "messageId"> } = {};
    const result = await this.runInputPreparation<WorkstreamObjectAnswerElicitationResult>(preparation, async () => {
    const root = await authorizedRoot();
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
    if (!row) {
      const cancelled = first(this.storage.sql.exec<{ ok: number }>(
        `SELECT 1 AS ok FROM elicitation_requests
          WHERE elicitation_id = ? AND status = 'cancelled'`,
        elicitationId,
      ));
      if (cancelled) {
        throw new ApiError(409, "elicitation_cancelled", "This question was cancelled by a newer message");
      }
      throw new ApiError(404, "elicitation_not_found", "This question is no longer open");
    }
    if (row.target_user_id !== null && row.target_user_id !== auth.userId) {
      throw new ApiError(403, "elicitation_target_mismatch", "This question is targeted to another participant");
    }
    const skipped = "skipped" in input && input.skipped;
    const answer = skipped ? null : input.answer;
    if (!skipped) this.validateElicitationAnswer(row, input.answer, input.customResponse);
    if (!skipped) {
      sent.value = {
        workspaceId: auth.workspaceId,
        workstreamId: root.workstream_key,
        scope: root.scope,
        origin: new WorkstreamIdentityStorage(this.storage).identity()?.origin_type ?? "ad_hoc",
        messageKind: "elicitation_response",
        attachmentCount: 0,
        mentionCount: 0,
        participantAddedCount: 0,
      };
    }
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
    const messageText = this.withPersonalSystemPrompt("", auth.userId, "elicitation_answer");
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
      text: messageText,
      structuredContentJson: structuredResponse,
      externalActorJson: null,
      producedByRunId: null,
      createdAtUtc: new Date(now).toISOString(),
      attentionOrdinal: null,
    });
    const bindMessage = await projectParticipantModelMessage(this.env, {
      author: {
        type: "human",
        userId: auth.userId,
        displayName: author?.name ?? null,
      },
      messageType: "elicitation",
      text: messageText,
      structuredContent: JSON.parse(structuredResponse),
      mentions: [],
      attachments: [],
      includeAttachmentContents: true,
    });
    if (!bindMessage) throw new Error("pending_input_bind_payload_invalid");
    const bindPayloadJson = canonicalModelMessageJson(bindMessage);
    const loop = this.loops.loop();
    if (!loop) throw new Error("substream_loop_not_initialized");
    if (loop.loop_id !== this.conversationLoopId(root)) {
      throw new Error("substream_loop_identity_mismatch");
    }
    let remaining = 0;
    const admitted = this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const current = first(sql.exec<RootRow>(`SELECT * FROM workstream WHERE id = 1`));
      if (!current) throw new ApiError(404, "workstream_not_found", "Thread not found");
      const changed = sql.exec<{ elicitation_id: string }>(
        `UPDATE elicitation_requests SET status = 'answered', answer_json = ?,
                answered_by_user_id = ?, answered_at = ?
          WHERE elicitation_id = ? AND status = 'pending'
          RETURNING elicitation_id`,
        answer === null ? null : JSON.stringify(answer), auth.userId, now, elicitationId,
      );
      if (changed.toArray().length !== 1) {
        const cancelled = first(sql.exec<{ ok: number }>(
          `SELECT 1 AS ok FROM elicitation_requests
            WHERE elicitation_id = ? AND status = 'cancelled'`,
          elicitationId,
        ));
        if (cancelled) {
          throw new ApiError(409, "elicitation_cancelled", "This question was cancelled by a newer message");
        }
        throw new ApiError(409, "elicitation_already_answered", "This question was answered by someone else");
      }
      remaining = Number(first(sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM elicitation_requests WHERE status = 'pending'`,
      ))?.count ?? 0);
      const completed = this.loops.completeInputPreparation({
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
          slackOrigin: slackOrigin ?? null,
        }),
        attachmentsJson: "[]",
        mentionsJson: "[]",
        now,
      });
      this.recordMessageAdmissionReceipt(sql, clientMessageId, requestHash, now);
      return completed;
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
      inserted: true,
    };
    });
    if (result.inserted && sent.value) {
      recordMessageSentTelemetry(this.env, auth, { ...sent.value, messageId: result.responsePartId }, this.defer);
    }
    return result;
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
    operationId: string,
    inputIds: readonly string[],
  ): Promise<{ pendingInputs: PendingTranscriptInput[] }> {
    return this.reorderPendingInputsWithAuthority(auth, operationId, inputIds, true);
  }

  async setAppearanceForAdmittedSocket(auth: AuthContext, operationId: string, raw: WorkstreamAppearancePatch): Promise<void> {
    this.locallyAuthorizedRoot(auth);
    if (this.objectStore.identity()?.parentKind !== "workstream") throw new ApiError(403, "main_conversation_required", "Change the thread appearance from Main");
    return this.applyAppearance(auth, operationId, raw);
  }

  /**
   * The same appearance write, reached over the product request rather than an
   * admitted feed socket.
   *
   * A Space has no socket to admit — its role refuses the upgrade — and its
   * icon and colour are the same stored appearance a Channel's are. So the
   * write is one implementation with two doors, rather than a second appearance
   * writer whose payload hash and effect would have to be kept in step with
   * this one.
   */
  async setAppearance(auth: AuthContext, operationId: string, raw: WorkstreamAppearancePatch): Promise<void> {
    await this.authorize(auth);
    const parentKind = this.objectStore.identity()?.parentKind;
    if (parentKind !== "workstream" && parentKind !== "space") {
      throw new ApiError(403, "main_conversation_required", "Change the appearance from Main");
    }
    return this.applyAppearance(auth, operationId, raw);
  }

  private async applyAppearance(auth: AuthContext, operationId: string, raw: WorkstreamAppearancePatch): Promise<void> {
    const parsed = WorkstreamAppearancePatchSchema.parse(raw);
    // A thread's or a Breakout's colour is its Channel's, and only the server
    // writes it (`recolor`, `channel-color-sync.ts`). A Space keeps its own.
    const patch: WorkstreamAppearancePatch = this.objectStore.identity()?.parentKind !== "workstream" ? parsed
      : parsed.icon === undefined ? {} : { icon: parsed.icon };
    const requestHash = workstreamImportHash({ command: "set_workstream_appearance", patch });
    let changed = false;
    await this.objectStore.commitWithRegionalEffects((sql) => {
      if (this.socketCommandReceipt(sql, auth, operationId, requestHash) !== "new") return;
      const root = this.root();
      const current = root.appearance_json ? WorkstreamAppearanceSchema.parse(JSON.parse(root.appearance_json)) : { icon: null, color: null };
      const appearance = WorkstreamAppearanceSchema.parse({ ...current, ...patch });
      const now = Date.now();
      sql.exec(`UPDATE workstream SET appearance_json = ?, updated_at = ? WHERE id = 1`, JSON.stringify(appearance), now);
      this.recordSocketCommandReceipt(sql, auth, operationId, "set_workstream_appearance", requestHash, workstreamImportHash(appearance), now);
      changed = true;
    }, () => changed ? [{ partitionKey: "common", effect: this.commonEffect(this.root()) }] : []);
  }

  async reorderPendingInputsForAdmittedSocket(
    auth: AuthContext,
    operationId: string,
    inputIds: readonly string[],
  ): Promise<{ pendingInputs: PendingTranscriptInput[] }> {
    return this.reorderPendingInputsWithAuthority(auth, operationId, inputIds, false);
  }

  private async reorderPendingInputsWithAuthority(
    auth: AuthContext,
    operationId: string,
    inputIds: readonly string[],
    reauthorizeWorkspaceMembership: boolean,
  ): Promise<{ pendingInputs: PendingTranscriptInput[] }> {
    const root = reauthorizeWorkspaceMembership
      ? await this.authorize(auth)
      : this.locallyAuthorizedRoot(auth);
    const requestHash = workstreamImportHash({ command: "reorder_pending_inputs", inputIds });
    return this.storage.transactionSync(() => {
      const replay = this.socketCommandReceipt(
        this.storage.sql,
        auth,
        operationId,
        requestHash,
      );
      if (replay === "new") {
        const loop = this.loops.loop();
        if (!loop) throw new Error("substream_loop_not_initialized");
        if (loop.loop_id !== this.conversationLoopId(root)) {
          throw new Error("substream_loop_identity_mismatch");
        }
        this.loops.reorderPendingInputsInTransaction({ inputIds, now: Date.now() });
      }
      const result = { pendingInputs: this.transcript.pendingTranscriptInputs() };
      if (replay === "new") {
        this.recordSocketCommandReceipt(
          this.storage.sql,
          auth,
          operationId,
          "reorder_pending_inputs",
          requestHash,
          workstreamImportHash(result),
          Date.now(),
        );
      }
      return result;
    });
  }

  async stop(auth: AuthContext, operationId: string): Promise<void> {
    return this.stopWithAuthority(auth, operationId, true);
  }

  async stopForAdmittedSocket(auth: AuthContext, operationId: string): Promise<void> {
    return this.stopWithAuthority(auth, operationId, false);
  }

  private async stopWithAuthority(
    auth: AuthContext,
    operationId: string,
    reauthorizeWorkspaceMembership: boolean,
  ): Promise<void> {
    const root = reauthorizeWorkspaceMembership
      ? await this.authorize(auth)
      : this.locallyAuthorizedRoot(auth);
    const requestHash = workstreamImportHash({ command: "stop_harness" });
    this.storage.transactionSync(() => {
      const replay = this.socketCommandReceipt(
        this.storage.sql,
        auth,
        operationId,
        requestHash,
      );
      if (replay === "replayed") return;
      const loop = this.loops.loop();
      if (!loop) throw new Error("substream_loop_not_initialized");
      if (loop.loop_id !== this.conversationLoopId(root)) {
        throw new Error("substream_loop_identity_mismatch");
      }
      if (loop.status !== "idle") {
        if (loop.active_execution_id === null || loop.active_execution_epoch === null
          || loop.lease_owner === null) throw new Error("substream_loop_execution_fence_missing");
        this.loops.requestStopInTransaction({
          executionId: loop.active_execution_id,
          executionEpoch: loop.active_execution_epoch,
          leaseOwner: loop.lease_owner,
          expectedLoopRevision: loop.revision,
          reason: "stopped_by_user",
          now: Date.now(),
        });
      }
      this.recordSocketCommandReceipt(
        this.storage.sql,
        auth,
        operationId,
        "stop_harness",
        requestHash,
        workstreamImportHash({ stopped: loop.status !== "idle" }),
        Date.now(),
      );
    });
  }

  async retry(auth: AuthContext, runId: HarnessRunId): Promise<WorkstreamObjectRetryResult> {
    return this.retryWithAuthority(auth, runId, true);
  }

  async retryForAdmittedSocket(
    auth: AuthContext,
    runId: HarnessRunId,
  ): Promise<WorkstreamObjectRetryResult> {
    return this.retryWithAuthority(auth, runId, false);
  }

  private async retryWithAuthority(
    auth: AuthContext,
    runId: HarnessRunId,
    reauthorizeWorkspaceMembership: boolean,
  ): Promise<WorkstreamObjectRetryResult> {
    const root = reauthorizeWorkspaceMembership
      ? await this.authorize(auth)
      : this.locallyAuthorizedRoot(auth);
    const loop = this.loops.loop();
    if (!loop) throw new Error("substream_loop_not_initialized");
    if (loop.loop_id !== this.conversationLoopId(root)) {
      throw new Error("substream_loop_identity_mismatch");
    }
    const replay = first(this.storage.sql.exec<{
      origin: string;
      execution_context_json: string | null;
      execution_principal_json: string;
    }>(
      `SELECT origin, execution_context_json, execution_principal_json FROM runs
        WHERE run_id = ? AND substream_id = '0'`,
      runId,
    ));
    if (replay) {
      const principal = JSON.parse(replay.execution_principal_json) as { type?: unknown; userId?: unknown };
      if (replay.origin !== "manual_retry"
        || principal.type !== "user" || principal.userId !== auth.userId) {
        throw new ApiError(
          409,
          "substream_command_idempotency_conflict",
          "This substream command id was already used for another run",
        );
      }
      if (replay.execution_context_json === null) {
        throw new Error("substream_retry_replay_context_missing");
      }
      const workflowInput = WorkstreamWorkflowInputSchema.parse(JSON.parse(replay.execution_context_json));
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
    if (loop.status === "executing") {
      throw new ApiError(409, "harness_already_running", "This thread already has an active run");
    }
    const latest = first(this.storage.sql.exec<{
      run_id: string;
      status: string;
      trigger_part_id: string | null;
      model: string | null;
      execution_context_json: string | null;
    }>(
      // `created_at` is milliseconds and not a total order, so this read and the
      // one that revalidates it inside the commit below must break a tie the
      // same way or the transaction refuses a retryable run. Which row wins
      // matters far less than the two agreeing.
      `SELECT run_id, status, trigger_part_id, model, execution_context_json FROM runs
        WHERE substream_id = '0' AND parent_tool_call_id IS NULL
        -- Must match the stillLatest re-read in the commit below.
        ORDER BY created_at DESC, run_id DESC LIMIT 1`,
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
    const workflowInput = WorkstreamWorkflowInputSchema.parse({
      ...previousContext,
      region: this.env.AVALON_REGION,
      workspaceId: auth.workspaceId,
      parentKind: root.parent_kind,
      parentId: root.workstream_key,
      substreamId: this.externalSubstreamId(),
      loopId: loop.loop_id,
      harnessRunId: runId,
      triggerMessageId: latest.trigger_part_id,
      transcriptFenceMessageId: newest?.id ?? null,
      executionPrincipal: { type: "user", userId: auth.userId },
      reason: "manual_retry",
    });
    const model = latest.model ?? await this.model(root);
    const committed = await this.objectStore.commitWithRegionalEffects(
      (sql) => {
        const concurrentReplay = first(sql.exec<{
          origin: string;
          execution_context_json: string | null;
          execution_principal_json: string;
        }>(
          `SELECT origin, execution_context_json, execution_principal_json FROM runs
            WHERE run_id = ? AND substream_id = '0'`,
          runId,
        ));
        if (concurrentReplay) {
          const principal = JSON.parse(concurrentReplay.execution_principal_json) as {
            type?: unknown; userId?: unknown;
          };
          if (concurrentReplay.origin !== "manual_retry"
            || principal.type !== "user" || principal.userId !== auth.userId) {
            throw new ApiError(
              409,
              "substream_command_idempotency_conflict",
              "This substream command id was already used for another run",
            );
          }
          if (concurrentReplay.execution_context_json === null) {
            throw new Error("substream_retry_replay_context_missing");
          }
          return {
            inserted: false,
            workflowInput: WorkstreamWorkflowInputSchema.parse(
              JSON.parse(concurrentReplay.execution_context_json),
            ),
          };
        }
        const currentLoop = this.loops.loop();
        if (!currentLoop || currentLoop.loop_id !== loop.loop_id
          || currentLoop.revision !== loop.revision || currentLoop.status !== "idle") {
          throw new ApiError(409, "harness_already_running", "This thread already has an active run");
        }
        const stillLatest = first(sql.exec<{ run_id: string; status: string }>(
          `SELECT run_id, status FROM runs
            WHERE substream_id = '0' AND parent_tool_call_id IS NULL
            -- Must match the latest read above.
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
        return { inserted: true, workflowInput };
      },
      (_sql, result) => result.inserted
        ? [{ partitionKey: "common", effect: this.commonEffect(this.root()) }]
        : [],
    );
    const committedWorkflowInput = committed.result.workflowInput;
    return {
      harnessRunId: runId,
      activationRequest: {
        kind: "activate_substream_loop",
        loopId: loop.loop_id,
        cause: "manual_retry",
        inputId: null,
        receiptRunId: runId,
        workflowInput: committedWorkflowInput,
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
      () => {
        const now = Date.now();
        // A failing run does not get to abandon the provider protocol. Only a
        // live execution can settle an interrupted tool batch — the repair
        // reads the durable receipts and writes under this lease — so
        // releasing the loop here with one open strands it permanently: Bind
        // then refuses every queued input, and the only path back to an
        // execution is the admission it refuses. Terminal receipt publication
        // has always refused this; this path did not, and that is the whole of
        // the 2026-09-19 wedge.
        //
        // Refusing leaves the run `running` and the loop `executing`, which is
        // the honest state: its protocol work is unfinished. The lease then
        // expires and `claimPersistentLoopExecution` hands it to
        // `recoverInterruptedToolBatch`, the path written for exactly this and
        // reachable only while the run has not terminalized.
        const outcome = new WorkstreamHarnessRunStorage(this.storage)
          .terminalizeWorkflowFailureInCurrentTransaction({
            runId,
            errorJson: JSON.stringify(error),
            memberSafePayloadJson: JSON.stringify({ code: error.code }),
            lifecycleEventId: uuidV7(),
            stateReasonCode: error.code,
            loopExecutionFence: execution,
            now,
          });
        if (outcome.outcome === "ownership_lost") {
          throw new Error("workstream_run_failure_fenced");
        }
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

  /**
   * Seed or repair this conversation's directory rows in its parent after
   * import/restore.
   */
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

/**
 * A Breakout merge's activity-event metadata: the source the `merged`
 * Activity row names, frozen at merge time, as the message's own tag is.
 * Empty for any other message. The feed reads `mergedFrom.breakoutId` through
 * a partial index (WorkspaceDO migration 109).
 */
function mergeActivityMetadata(merge: ConversationMergeV1 | undefined): { mergedFrom?: { breakoutId: string; title: string } } {
  return merge ? { mergedFrom: { breakoutId: merge.mergedFrom.breakoutId, title: merge.mergedFrom.title } } : {};
}
