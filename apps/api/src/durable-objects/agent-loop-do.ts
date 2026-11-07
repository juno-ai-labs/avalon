import { readCompletionVerificationSnapshot } from "./completion-verification-storage";
import { projectConversationView } from "@rally/contracts/conversation-view";
import { ConversationViewDeliverySchema, ConversationViewJobSchema, ConversationViewProjectionSchema, completeConversationViewDelivery, nextConversationViewAt, publishConversationViews } from "./conversation-view-projection";
import { zodDiagnosticCode, describeZodIssues } from "@rally/contracts/zod-diagnostics";
import { cleanupCanvaTransactions } from "../services/canva-transaction-cleanup";
import { parseRpcInput } from "../lib/rpc-input";
import { ToolPageError } from "./tool-page-storage";

import { MergeResourceTokenSchema } from "@rally/contracts";
import { AGENT_HANDOFF_TOOL_NAMES, AgentCommunicationService } from "../services/agent-communication-service";
import { RegionSchema } from "@rally/contracts/regions";
import { agentIdForAddress, AgentExchangeSchema } from "@rally/contracts";
import { conversationParentStub } from "../services/conversation-parent-client";
import { ReadTranscriptRequestSchema, ReadTranscriptResultSchema, SidekickRunTranscriptResultSchema, DEFAULT_TRANSCRIPT_READ_TURNS } from "@rally/contracts";
import { conversationAsText } from "../services/conversation-text";
import { safeParseSocketEvent, isUnknownSocketEvent, ClientSocketEventTypeSchema } from "@rally/contracts";
import { SidekickSkillSnapshotSchema } from "@rally/contracts";
import { SlackOriginContextSchema } from "@rally/contracts";
import { sidekickSkillCatalog } from "../services/sidekick-skills";
import { flushAuthorizationProjection, nextAuthorizationProjectionAt } from './authorization-projection';
import { searchIndexingConfigured } from '../services/search-embedding';
import { conversationSearchDocumentIds, prepareConversationLinks, readConversationSearchLink, type ConversationDisplay } from './conversation-link-search';
import {
  drainExternalBindingOutbox,
  nextExternalBindingDueAt,
} from "./external-binding-outbox";
import { drainSearchProjectionOutbox, nextSearchProjectionDueAt, SearchConversationProjectionMessageSchema, SearchProjectionMessageSchema } from './search-projection-outbox';
import { searchDocumentId } from '../services/text-search';
import { conversationSearchAudience } from '../services/search-audience';

import { workspaceDOName } from "./names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { pendingBindToolBatch, type HarnessToolResult } from "@rally/agent-harness";
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import {
  AcknowledgeWorkstreamReadRequestSchema,
  AnswerElicitationRequestSchema,
  AutomationDraftProposedV1Schema,
  ExecutionPrincipalSchema,
  ClientSocketEventSchema,
  ConnectorResourceAuthorizationRequestSchema,
  IdSchema,
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_TOO_LONG_MESSAGE,
  ResourceRelationshipTypeSchema,
  SubstreamSocketMutationTypeSchema,
  SubstreamIdSchema,
  TranscriptTurnIdSchema,
  UserIdSchema,
  type Region,
  type SubstreamId,
  type UserId,
  type WorkspaceId,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
  asSubstreamId,
  asHarnessRunId,
  asUserId,
  asWorkstreamId,
  asWorkspaceId,
  ServerSocketEventSchema,
  UpdateWorkstreamRequestSchema,
  WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkstreamSocketCommandResultSchema,
  WorkstreamWorkflowInputSchema,
  DemoSeedSchema,
  SidekickMessageIntentSchema,
  type ServerSocketEvent,
  type TranscriptRangeResult,
  type TranscriptTurn,
  type User,
  type WorkstreamDetail,
  type WorkstreamMessageAdmissionReceipt,
  type WorkstreamTranscriptSnapshot,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import { z } from "zod";

import { ConversationPostRequestSchema } from "./workspace-conversation-tool-protocol";
import {
  revocationClosesSession,
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  WorkstreamReaderAudienceSchema,
  type WorkstreamReaderAudience,
} from "../lib/audience-containment";
import { assertDurableObjectJurisdiction } from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { uuidV7 } from "../lib/uuid-v7";
import { AUTHORITY_FENCED_CODE } from "../runtime/object-port-error";
import {
  HarnessRunMetricsSchema,
  recordHarnessRunObservation,
} from "../observability/harness-run-observability";
import { diagnosticErrorCode, logError, logInfo, logWarn } from "../observability/logger";
import type { MemoryDigestFact } from "./workspace-memory-facts-protocol";
import { agentProfileFor, type AgentProfile } from "../services/agent-profiles";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import {
  identityAttributes,
  inDurableObjectPhase,
  inFlowSpan,
  inSpan,
  noFlowSpan,
  type FlowSpan,
  type PerfFlow,
  type TracedSpan,
} from "../observability/tracing";
import { latestMigrationVersion } from "./migration-reporting";
import {
  type AttemptLease,
  claimHarnessAttempt,
  repairTerminalResidualReceipts,
  reapStaleHarnessRuns,
  RunOwnershipLostError,
  terminalizeHarnessAttempt,
  terminalizeQueuedHarnessRun,
} from "../runtime/harness-run-runtime";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createToolReceiptObjectPort, createToolReceiptPortFactory } from "../runtime/tool-receipt-port";
import { WorkstreamResidentContextStorage } from "./workstream-resident-context-storage";
import { RESIDENT_CONTEXT_KINDS, renderResidentContextBlock } from "../services/resident-context/blocks";
import {
  type ResidentContextOperationRequest,
  ResidentContextOperationRequestSchema,
} from "./workstream-resident-context-protocol";
import {
  loadToolReplayOutput,
  reenterInterruptedWriteForRecovery,
  runWorkstreamHarness,
  type WorkstreamHarnessResult,
} from "../services/integrations";
import { CODE_PLUGIN_ID, CUSTOM_TOOLS_PLUGIN_ID } from "../services/code-mode";
import { attemptMemorySweep } from "../services/memory-sweep-service";
import { digestReaderFor, refreshMemoryDigestCopy } from "../services/memory-digest-service";
import { loadOpenRouterContextWindows } from "../services/openrouter-context-windows";
import {
  objectOwnsWorkstreamAuthorities,
  withLocalWorkstreamAuthorities,
  type LocalAuthorityExecutor,
} from "../runtime/local-authorities";
import { TerminalObjectPortError } from "../services/terminal/object-port";
import { fireWorkstreamWakeup } from "../services/workstream-service";
import { loadWorkstreamWakeup } from "../services/workstream-wakeup-service";
import { createSchedulingObjectPort } from "../runtime/scheduling-port";
import type { WorkstreamRuntimeResourceAttacher } from "../services/workstream-object-client";
import { recordSupportAction } from "../services/support-access";
import {
  acceptsNewWorkstreamWork,
  permitsLegacyRuntimeDrain,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import {
  conversationEffectHash,
  EFFECT_QUEUE_MESSAGE_MAX_BYTES,
  type ConversationEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import { conversationObjectName, substreamLoopId } from "./names";
import { HostedConversationParentKindSchema, WorkstreamObjectStore } from "./workstream-object-storage";
import type { SequencedSemanticRealtimeReference } from "./workstream-semantic-realtime-outbox";
import { WorkstreamTerminalStorage } from "./workstream-terminal-storage";
import { WorkstreamToolReceiptStorage } from "./workstream-tool-receipt-storage";
import { WorkstreamDesktopActionStorage } from "./workstream-desktop-action-storage";
import type { DesktopAction, DesktopActionOutcome } from "@rally/contracts/desktop-actions";
import {
  type ToolReceiptOperationRequest,
  ToolReceiptOperationRequestSchema,
} from "./workstream-tool-receipt-protocol";
import { WorkstreamMessageStorage } from "./workstream-message-storage";
import {
  WorkstreamTranscriptStorage,
  UnsettledToolBatchError,
  isUnsettledToolBatchError,
} from "./workstream-transcript-storage";
import {
  LOOP_EXECUTION_LEASE_MS,
  SubstreamLoopStorage,
  type PendingLoopInputRow,
  type SubstreamLoopRow,
} from "./substream-loop-storage";
import {
  SidekickRunRowProjectionSchema,
  type SidekickRunContinuation,
  type SidekickRunContinuationRefusalCode,
} from "./automation-do-protocol";
import { sidekickRunRowText } from "./sidekick-run-row";
import {
  insertPreparedCanonicalTranscriptFact,
  prepareCanonicalTranscriptFact,
  type PreparedCanonicalTranscriptFact,
} from "./ordered-transcript-sqlite/canonical-payload-store";
import {
  continuationSource,
  continueSidekickRun,
  routeSidekickConversationMessage,
  sidekickAllowsManager,
  SIDEKICK_MESSAGE_REFUSAL_TEXT,
  SIDEKICK_RUN_REFUSAL_TEXT,
} from "../services/sidekick-run-continuation";
import {
  TranscriptOperationRequestSchema,
  type TranscriptOperationRequest,
} from "./workstream-transcript-protocol";
import {
  AppendMessageInputSchema,
  type MessageOperationRequest,
  MessageOperationRequestSchema,
  mutatesTranscript,
} from "./workstream-message-protocol";
import {
  expireLocalAttemptLeasesFromPreviousInstance,
  previousInstanceRecoveryOwner,
  type PublishHostOutcomeInput,
  WorkstreamHarnessRunStorage,
} from "./workstream-harness-run-storage";
import {
  type HarnessRunOperationRequest,
  HarnessRunOperationRequestSchema,
  mutatesRunState,
} from "./workstream-harness-run-protocol";
import { WorkstreamIdentityStorage, type WorkstreamProvisionInput } from "./workstream-identity-storage";
import {
  type IdentityOperationRequest,
  IdentityOperationRequestSchema,
  mutatesIdentity,
} from "./workstream-identity-protocol";
import { WorkstreamResourceStorage } from "./workstream-resource-storage";
import {
  type ResourceOperationRequest,
  ResourceOperationRequestSchema,
  mutatesInventory,
} from "./workstream-resource-protocol";
import { WorkstreamSchedulingStorage } from "./workstream-scheduling-storage";
import {
  AnswerElicitationExternallyInputSchema,
  OpenElicitationInputSchema,
  type SchedulingOperationRequest,
  armsDerivedAlarm,
  mutatesWakeups,
  SchedulingOperationRequestSchema,
} from "./workstream-scheduling-protocol";
import {
  TerminalOperationRequestSchema,
  terminalOperationAffectsDirectory,
  type TerminalOperationRequest,
} from "./workstream-terminal-protocol";
import {
  WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
  WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
} from "./workstream-object-schema";
import {
  ScheduledDurableObject,
  type ScheduledAlarm,
} from "./scheduled-alarms";
import {
  applyRetirementGate,
  readObjectRetirement,
  retiredObjectResponse,
} from "./object-retirement";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import {
  WorkstreamObjectCreateMessageInputSchema,
  WorkstreamObjectProductService,
  type WorkstreamObjectCreateMessageInput,
  type WorkstreamLoopActivationRequest,
} from "./workstream-object-product";
import {
  AdmitExternalMessageInputSchema,
  AdmitAgentMessageInputSchema,
  type AdmitAgentMessageInput,
  AdmitSidekickReviewInputSchema,
  type AdmitSidekickReviewInput,
  AnswerExternalElicitationInputSchema,
  ExternalMessageAdmissionResultSchema,
  type ExternalMessageAdmissionResult,
} from "./workstream-external-message-protocol";
import { emitCorrelatedRunOutcome } from "../telemetry/run-outcome";
import { DurableAgentDrain, DurableAgentKeepAlive } from "./durable-agent-runtime";
import {
  objectPortRpcResult,
  responseToRpcResult,
  type DurableObjectRpcResult,
  type ObjectPortOutcome,
} from "./rpc-result";

export { applyActiveStreamCheckpointEvent, splitActiveStreamCheckpointText } from "./workstream-object-storage";

function isAppendedMessageOutcome(
  value: unknown,
): value is { outcome: "appended"; messageId: string; sequenceNumber: number } {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.outcome === "appended"
    && typeof candidate.messageId === "string"
    && typeof candidate.sequenceNumber === "number";
}

function isPersistedElicitationOutcome(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const outcome = (value as Record<string, unknown>).outcome;
  return outcome === "opened" || outcome === "answered";
}

const SocketAttachmentSchema = z.object({
  connectionId: z.string().uuid(),
  workspaceId: WorkspaceIdSchema,
  /** The conversation parent's id, of either kind. */
  workstreamId: IdSchema,
  substreamId: SubstreamIdSchema,
  userId: UserIdSchema,
  // Present on current connections so a prepared ticket-transit snapshot can
  // be claimed by exactly the socket that consumed that ticket. Older
  // hibernation attachments legitimately lack it.
  ticketId: z.string().uuid().optional(),
  // Absent only on a socket accepted by a pre-command-gateway deployment. A
  // command on that socket triggers a normal reconnect for a fresh ticket.
  sessionId: z.string().min(1).max(200).optional(),
  // The socket upgrade authorizes the member once. Access-revocation delivery
  // closes this socket when that authorization ends, so commands use the
  // admitted role instead of paying for a second D1 session lookup.
  role: z.enum(["owner", "admin", "member"]).nullable().optional(),
  analyticsWorkspaceId: z.string().nullable().optional(),
  /**
   * The Rally staff member behind a support session (`docs/impersonation.md`):
   * such a socket is never shown as present, never settles the person's
   * unseen or read state, and audits the commands it sends.
   */
  impersonatorUserId: UserIdSchema.optional(),
  connectedAt: z.string().datetime({ offset: true }),
  afterSequence: z.number().int().nonnegative(),
  subscribed: z.boolean().default(false),
  // Missing means a legacy client whose feed subscription still represented
  // viewing. Current proactive clients opt out and use WorkspaceDO presence.
  publishPresence: z.boolean().default(true),
  // A hover-warmed socket may receive canonical state but cannot settle the
  // reader's unseen marker until the renderer commits navigation.
  speculative: z.boolean().default(false),
  /**
   * The parent decided this at admission: an archived parent's conversations
   * stay readable and refuse every write, so a child never outlives its
   * parent's archive. Absent on attachments from before the decision existed.
   */
  parentArchived: z.boolean().default(false),
  membershipVersion: z.number().int().nonnegative().default(0),
  /** A `request_snapshot` from this socket is assembling; broadcasts skip it. */
  snapshotInFlight: z.boolean().default(false),
  transcriptSnapshot: z.object({
    snapshotId: z.string().min(1),
    snapshotThrough: z.number().int().nonnegative(),
    snapshotAtUtc: z.string().datetime({ offset: true }),
  }).nullable().default(null),
});

const SocketAdmissionPreparationSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  /** The parent this conversation belongs to; `workstreamId` is its id whatever the kind. */
  parentKind: HostedConversationParentKindSchema,
  workstreamId: IdSchema,
  substreamId: SubstreamIdSchema,
  userId: UserIdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().uuid(),
  ticketIssuedAt: z.number().int().positive(),
  ticketExpiresAt: z.number().int().positive(),
  authorityGeneration: z.number().int().nonnegative(),
  role: z.enum(["owner", "admin", "member"]).nullable(),
  analyticsWorkspaceId: z.string().nullable(),
  membershipVersion: z.number().int().nonnegative().default(0),
  afterSequence: z.number().int().nonnegative().optional(),
  speculative: z.boolean(),
});

export type SocketAdmissionPreparation = z.input<typeof SocketAdmissionPreparationSchema>;

const SocketUpgradeIdentitySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  /** Sent by the Worker from the ticket; absent only on a self-addressed upgrade, which reads the stored kind. */
  parentKind: HostedConversationParentKindSchema.optional(),
  workstreamId: IdSchema,
  substreamId: SubstreamIdSchema,
  userId: UserIdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().uuid(),
  ticketExpiresAt: z.coerce.number().int().positive(),
  afterSequence: z.coerce.number().int().nonnegative().optional(),
  speculative: z.literal("true").transform(() => true).optional().default(false),
  parentArchived: z.literal("true").transform(() => true).optional().default(false),
  admissionVersion: z.coerce.number().int().optional(),
  authorityGeneration: z.coerce.number().int().nonnegative().optional(),
  role: z.enum(["owner", "admin", "member"]).nullable().optional(),
  analyticsWorkspaceId: z.string().optional(),
  membershipVersion: z.coerce.number().int().nonnegative().optional(),
  impersonatorUserId: UserIdSchema.optional(),
});

type SocketUpgradeIdentity = z.infer<typeof SocketUpgradeIdentitySchema>;

const BroadcastRequestSchema = z.strictObject({
  event: z.unknown(),
});
const RuntimeResourceRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  /** Which of the parent's conversations; this one when absent. */
  substreamId: z.string().min(1).optional(),
  resourceId: IdSchema,
  attachedByUserId: IdSchema.nullable(),
  relationshipType: ResourceRelationshipTypeSchema.optional(),
  eventType: z.enum(["resource_attached", "resource_updated"]).optional(),
});
const RuntimeReaderAudienceRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
});
const RuntimeBootstrapRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  parentKind: HostedConversationParentKindSchema,
  parentId: IdSchema,
  /** Which of the parent's conversations this object is; the main one by default. */
  substreamId: z.union([z.literal("0"), IdSchema]).optional(),
  generation: z.number().int().positive(),
});
const RuntimeDispatchRequestSchema = WorkstreamWorkflowInputSchema;
const AgentTerminalOutcomeSchema = z.strictObject({
  status: z.enum(["completed", "needs_input", "failed", "stopped"]),
  finalTurnId: TranscriptTurnIdSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  metrics: HarnessRunMetricsSchema.optional(),
  cancellationReason: z.string().nullable().optional(),
});
type AgentTerminalOutcome = z.infer<typeof AgentTerminalOutcomeSchema>;
const AgentTimerRefreshRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
});
const ProductAuthSchema = z.strictObject({
  sessionId: z.string().min(1).max(200),
  userId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
  region: RegionSchema,
  role: z.enum(["owner", "admin", "member"]).nullable(),
  // Absent: `sessionId` names a `sessions` row and is verified there.
  // `"connector"`: a connector ingress already verified the link that binds
  // this member on the message being delivered, `sessionId` is correlation
  // only, and the object verifies current membership instead — see
  // `connectorPrincipalAuth`. `"demo_seed"`: the demo seeder acting as a cast
  // member who never signs in, verified the same way. A provider callback
  // uses `"resource_authorization"` after its state and grant are verified.
  // These are constructed only by server code; `IdentityAuthContext.principal`
  // says why.
  principal: z.enum(["connector", "demo_seed", "impersonation", "resource_authorization", "engineering"]).optional(),
});
/**
 * One product operation, with the two fields every one of them carries.
 *
 * `parentKind` is which authority the caller believes owns this conversation's
 * parent, and `runProductRequest` refuses a request whose answer disagrees with
 * the object's own identity: a conversation is addressed by id, and the kind
 * keeps a Sidekick's id from reaching an operation meant for a Canvas's Chat.
 * Required: every caller names its parent, a Sidekick or a Canvas.
 */
function productOperation<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject({
    auth: ProductAuthSchema,
    parentKind: HostedConversationParentKindSchema,
    ...shape,
  });
}

const ProductRequestSchema = z.discriminatedUnion("operation", [
  productOperation({ operation: z.literal("get") }),
  productOperation({ operation: z.literal("boot") }),
  productOperation({ operation: z.literal("search_links"),
    links: z.array(z.strictObject({ turnId: TranscriptTurnIdSchema, linkId: z.string() })) }),
  productOperation({ operation: z.literal("search_link"), turnId: TranscriptTurnIdSchema, linkId: z.string() }),
  productOperation({ operation: z.literal("search_turns"), turnIds: z.array(TranscriptTurnIdSchema) }),
  productOperation({ operation: z.literal("read_transcript"), input: ReadTranscriptRequestSchema }),
  productOperation({ operation: z.literal("inspect_sidekick_run_transcript"), automationId: IdSchema,
    runId: IdSchema, input: ReadTranscriptRequestSchema }),
  productOperation({ operation: z.literal("read_resource_authorization_recovery"), toolCallId: z.string().min(1) }),
  productOperation({ operation: z.literal("update"), input: UpdateWorkstreamRequestSchema }),
  productOperation({ operation: z.literal("acknowledge_read"), input: AcknowledgeWorkstreamReadRequestSchema }),
  productOperation({ operation: z.literal("mark_unread") }),
  productOperation({ operation: z.literal("create_message"),
    input: WorkstreamObjectCreateMessageInputSchema }),
  productOperation({ operation: z.literal("add_participant"), userId: IdSchema }),
  productOperation({ operation: z.literal("remove_participant"), userId: IdSchema,
    operationId: IdSchema.optional(), owningThread: z.boolean().optional() }),
  productOperation({ operation: z.literal("attach_resource"), resourceId: IdSchema }),
  productOperation({ operation: z.literal("attach_resources"), resourceIds: z.array(MergeResourceTokenSchema) }),
  productOperation({ operation: z.literal("detach_resource"), resourceId: IdSchema }),
  productOperation({ operation: z.literal("rename_resource"), resourceId: IdSchema, title: z.string().min(1) }),
  productOperation({ operation: z.literal("answer_elicitation"),
    elicitationId: IdSchema, input: AnswerElicitationRequestSchema,
    slackOrigin: SlackOriginContextSchema.optional() }),
]);
/**
 * The flow a product operation belongs to. An operation outside the three
 * traced flows returns null and opens no spans, rather than being counted under
 * a flow it is not part of.
 */
function productRequestFlow(operation: SubstreamProductRequest["operation"]): PerfFlow | null {
  switch (operation) {
    case "create_message": return "workstream_message_send";
    case "get": case "boot": return "workstream_open";
    default: return null;
  }
}

function recoveredToolReceiptError(value: string | null): {
  code: string | null;
  message: string | null;
} {
  if (!value) return { code: null, message: null };
  try {
    const parsed = JSON.parse(value) as { code?: unknown; message?: unknown };
    return {
      code: typeof parsed.code === "string" ? parsed.code : null,
      message: typeof parsed.message === "string" ? parsed.message : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

/**
 * What a socket's authorization query answers with. The analytics column is
 * absent on the development path, which selects only the role — optional here
 * rather than nullable so that shape stays legal.
 */
interface AuthRoleRow {
  role: AuthContext["role"];
  analytics_workspace_id?: string | null;
  session_expires_at?: string;
  impersonator_user_id?: string | null;
}

const RoomIdentitySchema = z.object({ workspaceId: WorkspaceIdSchema, workstreamId: WorkstreamIdSchema });
export type SubstreamProductRequest = z.infer<typeof ProductRequestSchema>;
/**
 * What a caller puts on the wire, where `parentKind` may be absent because the
 * parse supplies `workstream`. Every existing caller means a Channel and says
 * nothing; the Space authority is the one that has to say so.
 */
export type SubstreamProductRequestInput = z.input<typeof ProductRequestSchema>;
export type SubstreamRuntimeResourceRequest = z.infer<typeof RuntimeResourceRequestSchema>;
export type SubstreamRuntimeBootstrapRequest = z.infer<typeof RuntimeBootstrapRequestSchema>;
export type SubstreamTimerRefreshRequest = z.infer<typeof AgentTimerRefreshRequestSchema>;
export type SubstreamPublishedEvent = z.infer<typeof RoomIdentitySchema> & {
  event: unknown;
};
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 512_000;

/**
 * Remove one whole canonical turn while narrowing coverage to exactly the
 * bytes that remain. A socket frame is only an opening cache: omitted spans
 * stay requestable through the transcript range protocol and are never
 * represented as loaded. Unread context yields before the latest window.
 */
function narrowSocketTranscriptSnapshot(
  snapshot: WorkstreamTranscriptSnapshot,
  excessBytes: number,
): WorkstreamTranscriptSnapshot | null {
  const ranked = snapshot.ranges
    .map((range, index) => ({ range, index }))
    .filter(({ range }) => range.turns.length > 0)
    .sort((left, right) => {
      const rank = (purpose: typeof left.range.purpose): number =>
        purpose === "unread" ? 0 : purpose === "unread_and_latest" ? 1 : 2;
      return rank(left.range.purpose) - rank(right.range.purpose)
        || left.range.covered.startInclusive - right.range.covered.startInclusive;
    });
  const candidate = ranked[0];
  if (candidate) {
    let removedBytes = 0;
    let removedCount = 0;
    for (const turn of candidate.range.turns) {
      removedBytes += textEncoder.encode(JSON.stringify(turn)).byteLength + 1;
      removedCount += 1;
      if (removedBytes >= excessBytes) break;
    }
    const remainingTurns = candidate.range.turns.slice(removedCount);
    const nextStart = remainingTurns[0]?.transcriptSequence
      ?? candidate.range.covered.endExclusive;
    const ranges = snapshot.ranges.flatMap((range, index) => {
      if (index !== candidate.index) return [range];
      if (remainingTurns.length === 0) return [];
      return [{
        ...range,
        covered: { ...range.covered, startInclusive: nextStart },
        turns: remainingTurns,
      }];
    });
    const unreadWasDropped = snapshot.unreadAnchorSequence !== null
      && candidate.range.covered.startInclusive <= snapshot.unreadAnchorSequence
      && nextStart > snapshot.unreadAnchorSequence;
    return {
      ...snapshot,
      ranges,
      ...(unreadWasDropped ? {
        unreadAnchorSequence: null,
        unreadReason: "anchor_unavailable" as const,
      } : {}),
    };
  }
  if (snapshot.activeTurns.length > 0) {
    return { ...snapshot, activeTurns: snapshot.activeTurns.slice(1) };
  }
  return null;
}

/**
 * Remove the newest whole turn from a direct range response. Coverage ends at
 * the removed turn's sequence, rather than continuing to claim bytes the
 * socket did not carry. The original requested interval remains unchanged so
 * the client can distinguish the answer from the question and request the
 * uncovered suffix.
 */
function narrowSocketTranscriptRange(
  result: TranscriptRangeResult,
): TranscriptRangeResult | null {
  const removed = result.turns.at(-1);
  if (!removed) return null;
  const turns = result.turns.slice(0, -1);
  return {
    ...result,
    covered: {
      ...result.covered,
      endExclusive: removed.transcriptSequence,
    },
    turns,
    activities: activitiesForTranscriptTurns(result.activities, turns),
  };
}

function activitiesForTranscriptTurns(
  activities: TranscriptRangeResult["activities"],
  turns: TranscriptRangeResult["turns"],
): TranscriptRangeResult["activities"] {
  const byId = new Map(activities.map((activity) => [activity.activityId, activity]));
  const required = new Set(turns.flatMap((turn) => [
    ...(turn.activityId ? [turn.activityId] : []),
    ...turn.blocks.flatMap((block) => "activityId" in block && block.activityId
      ? [block.activityId]
      : []),
  ]));
  for (const activityId of required) {
    let parentId = byId.get(activityId)?.parentActivityId;
    while (parentId && !required.has(parentId)) {
      required.add(parentId);
      parentId = byId.get(parentId)?.parentActivityId;
    }
  }
  return activities.filter((activity) => required.has(activity.activityId));
}

const MAINTENANCE_RECHECK_MS = 5 * 60_000;
/** Matches the Agents SDK default, while keeping Avalon independent of it. */
const KEEP_ALIVE_INTERVAL_MS = 30_000;
/**
 * Pacing for redelivering a committed realtime reference whose local socket
 * delivery threw, following the alarm coordinator's precedent that retry
 * pacing is a code-owned scheduling constant (`SCHEDULED_ALARM_RETRY_BASE_MS`).
 * Short on purpose: the payload is object-local and the failure mode is a
 * transient socket, and a reconnect snapshot repairs the reader regardless —
 * this only bounds how hot a poisoned row can spin the alarm.
 */
const SEMANTIC_REALTIME_RETRY_MS = 5_000;
/** `_internal_durable_alarms.kind` for a wake-up an agent run scheduled for itself. */
const AGENT_TIMER_ALARM_KIND = "agent_timer";
const RETIRED_MERGE_SUGGESTION_ALARM_KIND = "merge_suggestion";
/**
 * Bound on the entries one sync writes.
 *
 * Comfortably above `MAXIMUM_PENDING_WAKEUPS_PER_WORKSTREAM`, which is the real
 * cap: this exists so a table that somehow outgrew that limit costs a bounded
 * reconcile rather than an unbounded one.
 */
const AGENT_TIMER_ALARM_LIMIT = 100;
type SocketAttachment = z.infer<typeof SocketAttachmentSchema>;

/** An archived parent's conversations are read-only; the Worker's writable client refuses the same way. */
function assertParentWritable(attachment: SocketAttachment): void {
  if (attachment.parentArchived) {
    throw new ApiError(409, "conversation_parent_archived", "This conversation is archived and no longer accepts changes");
  }
}

function recognizableSocketCreateMessage(decoded: unknown): {
  operationId: string;
  clientMessageId: string;
  overLong: boolean;
} | null {
  if (decoded === null || typeof decoded !== "object") return null;
  const frame = decoded as { type?: unknown; operationId?: unknown; payload?: unknown };
  if (frame.type !== "create_message" || frame.payload === null || typeof frame.payload !== "object") {
    return null;
  }
  const operationId = IdSchema.safeParse(frame.operationId);
  if (!operationId.success) return null;
  const payload = frame.payload as { text?: unknown; clientMessageId?: unknown };
  if (typeof payload.clientMessageId !== "string"
    || payload.clientMessageId.length < 1
    || payload.clientMessageId.length > 120) return null;
  return {
    operationId: operationId.data,
    clientMessageId: payload.clientMessageId,
    overLong: typeof payload.text === "string" && payload.text.length > MESSAGE_MAX_CHARACTERS,
  };
}

function recognizableSocketMutation(decoded: unknown): {
  command: z.infer<typeof SubstreamSocketMutationTypeSchema>;
  operationId: string;
  clientMessageId?: string;
} | null {
  if (decoded === null || typeof decoded !== "object") return null;
  const frame = decoded as { type?: unknown; operationId?: unknown; payload?: unknown };
  const command = SubstreamSocketMutationTypeSchema.safeParse(frame.type);
  const operationId = IdSchema.safeParse(frame.operationId);
  if (!command.success || !operationId.success) return null;
  const clientMessageId = frame.payload !== null && typeof frame.payload === "object"
    ? (frame.payload as { clientMessageId?: unknown }).clientMessageId
    : undefined;
  return {
    command: command.data,
    operationId: operationId.data,
    ...(typeof clientMessageId === "string"
      && clientMessageId.length >= 1 && clientMessageId.length <= 120
      ? { clientMessageId }
      : {}),
  };
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  timezone: string;
  created_at: string;
}

const textEncoder = new TextEncoder();

/**
 * Whether this event can have taken somebody's read access away.
 *
 * A work stream becoming `personal` narrows it to its participants, and losing
 * a participant narrows it again. Both are facts this object already holds in
 * its own SQL, which is what makes acting on them here different from the D1
 * membership read that was removed from this path: that one asked a question
 * only the revocation queue can answer, this one asks a question only this
 * object can.
 */
function retractsReadAccess(event: ServerSocketEvent): boolean {
  if (event.type === "workstream_scope_changed") return event.scope === "personal";
  return event.type === "participant_removed";
}

/**
 * Take a socket out of the room and close it.
 *
 * The attachment is marked unsubscribed first, which is what {@link
 * AgentLoopDO.broadcast} filters on. Closing alone would leave the guarantee
 * to the runtime — `send` on a closed socket throws, and that throw is caught —
 * so a disconnected reader would be spared the next frame by accident rather
 * than on purpose. On a privacy path that is the wrong place for the rule to
 * live.
 *
 * `snapshotInFlight` is lowered with it, because it is a second admission flag:
 * {@link AgentLoopDO.fulfillTranscriptRange} serves a range on a socket
 * whose own snapshot is assembling, and a flag this write left standing would
 * be an admission path the privacy write does not close. The close wins that
 * race today — a frame sent after it throws, one racing it is dropped — but
 * that is the runtime sparing the reader by accident again, which is the thing
 * this function exists to not rely on.
 */
function disconnect(socket: WebSocket, code: number, reason: string): void {
  try {
    const attachment = SocketAttachmentSchema.safeParse(socket.deserializeAttachment());
    if (attachment.success) {
      socket.serializeAttachment({
        ...attachment.data,
        subscribed: false,
        snapshotInFlight: false,
      } satisfies SocketAttachment);
    }
  } catch {
    // An unreadable attachment already fails the broadcast filter.
  }
  try {
    socket.close(code, reason);
  } catch {
    // Already gone; the runtime delivers the close separately.
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function userFromRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    timezone: row.timezone,
    createdAt: row.created_at
  };
}

export { conversationObjectName };

/**
 * This object's own name, or `null` while its identity is not yet fully its own.
 *
 * Split out from the object so the rule can be proved rather than reasoned
 * about. An `AgentLoopDO` is named by *two* durable facts — which work stream
 * it belongs to, and which external substream it is — and both have to be
 * present. An object holding only the first would otherwise take the main
 * child's name and answer self-calls addressed to a sibling out of its own
 * storage. `externalSubstreamId`'s `"0"` default is right where it is used as
 * *am I the main child?* and wrong here, which is why this takes the raw row.
 */
export function substreamSelfObjectName(
  region: Region,
  identity: { workspaceId: WorkspaceId; parentId: string } | null,
  externalSubstreamId: string | null,
): string | null {
  if (!identity || externalSubstreamId === null) return null;
  return conversationObjectName(
    region,
    identity.workspaceId,
    identity.parentId,
    asSubstreamId(externalSubstreamId),
  );
}

export function distinctNonParticipantViewers<T extends { userId: string; connectedAt: string }>(
  attachments: T[],
  participantIds: ReadonlySet<string>,
): T[] {
  const firstByUser = new Map<string, T>();
  for (const attachment of attachments) {
    if (participantIds.has(attachment.userId)) continue;
    const existing = firstByUser.get(attachment.userId);
    if (!existing || attachment.connectedAt < existing.connectedAt) {
      firstByUser.set(attachment.userId, attachment);
    }
  }
  return [...firstByUser.values()];
}

export type SocketReplayPlan =
  | { type: "snapshot"; reason: "initial" | "history_unavailable" }
  | { type: "replay"; events: ServerSocketEvent[] }
  | { type: "resync_required"; reason: "history_unavailable" | "sequence_ahead" };

type SocketSnapshotEvent = Extract<ServerSocketEvent, { type: "snapshot" }>;

interface PreparedSocketSnapshot {
  event: SocketSnapshotEvent;
  pendingInputChunks: WorkstreamTranscriptSnapshot["pendingInputs"][];
  encodedBytes: number;
  transcriptSnapshot: SocketAttachment["transcriptSnapshot"];
  settleUnseen: boolean;
}

interface PreparedSocketAdmission {
  input: SocketAdmissionPreparation;
  auth: AuthContext;
  sessionExpiresAt: number | null;
  snapshot: PreparedSocketSnapshot | null;
  snapshotReason: "initial" | "history_unavailable" | null;
  snapshotSequence: number | null;
  snapshotRevision: number | null;
}

/**
 * The replay window intentionally lives only in object memory. Persisting every
 * token event would turn an ephemeral optimization into storage write cost.
 * After hibernation, a stale client receives the current canonical snapshot on
 * the same socket. Only a client cursor ahead of the object's durable sequence
 * requires an out-of-band resync because a lower-sequence snapshot would be
 * rejected by the client's ordinary cursor guard.
 */
export function planSocketReplay(
  afterSequence: number,
  currentSequence: number,
  replayFloorSequence: number | null,
  recentEvents: readonly ServerSocketEvent[],
  allowSnapshot = true,
): SocketReplayPlan {
  if (afterSequence === 0 && allowSnapshot) {
    return { type: "snapshot", reason: "initial" };
  }
  if (afterSequence > currentSequence) {
    return { type: "resync_required", reason: "sequence_ahead" };
  }
  if (afterSequence === currentSequence) return { type: "replay", events: [] };
  if (replayFloorSequence === null || afterSequence < replayFloorSequence) {
    return allowSnapshot
      ? { type: "snapshot", reason: "history_unavailable" }
      : { type: "resync_required", reason: "history_unavailable" };
  }
  const events = recentEvents.filter((event) => event.sequence > afterSequence);
  if (events.length === 0 || events.at(-1)?.sequence !== currentSequence) {
    return allowSnapshot
      ? { type: "snapshot", reason: "history_unavailable" }
      : { type: "resync_required", reason: "history_unavailable" };
  }
  return { type: "replay", events };
}

/**
 * The hibernating realtime, loop, and storage authority for one substream.
 *
 * Main child `0` receives the guarded maintenance import from the historical
 * one-room-per-workstream object. After activation, every child's local SQL is
 * authoritative for its own transcript and loop state; REST is a recovery
 * surface, never a second writer.
 */
/**
 * The first frames of a thrown error, taken as *frames* rather than as the
 * first six lines.
 *
 * `stack` is the message followed by the frames, and a `ZodError`'s message is
 * multi-line JSON — so slicing the first six lines of one captured six lines of
 * the message and no frames at all. Every `workstream_harness_threw` for a
 * validation failure was therefore logged without the one thing the log exists
 * to carry, which is why a run dying inside the retired admission-recall step
 * looked for days like it might have come from any of four call sites. `reason` already
 * carries the message; this carries where it happened.
 *
 * The split is by prefix rather than by parsing, so an error whose message
 * quotes another error's stack contributes those lines too — worth knowing
 * before trusting a frame count, and still strictly better than a slice that
 * captured no frames at all. A frameless error now logs `null` rather than a
 * copy of `reason`, which is the intended trade.
 */
export function harnessErrorFrames(error: unknown): string | null {
  if (!(error instanceof Error) || !error.stack) return null;
  const frames = error.stack.split("\n").filter((line) => line.trimStart().startsWith("at "));
  return frames.length > 0 ? frames.slice(0, 6).join("\n") : null;
}

const PRODUCT_SESSION_AUTH_MAX_AGE_MS = 300_000;

export class AgentLoopDO extends ScheduledDurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly recentEvents: ServerSocketEvent[] = [];
  private recentEventBytes = 0;
  private replayFloorSequence: number | null = null;
  /** Ticket-scoped admission and snapshot work prepared during ticket transit. */
  private readonly preparedSocketAdmissions = new Map<string, PreparedSocketAdmission>();
  /** Newer tickets supersede the one preparation retained by this room. */
  private preparedSocketAdmissionTicketId: string | null = null;
  /** Only the most recently completed room snapshot stays resident. */
  private preparedSocketSnapshotTicketId: string | null = null;
  /** Object-local product mutations invalidate snapshot reuse without a realtime event. */
  private socketSnapshotRevision = 0;
  /** Latest delivered retraction prevents an older in-flight preparation from reappearing. */
  private latestSocketRevocationAt = 0;
  /** Product RPC session evidence only; socket admission still reads D1 live. */
  private readonly productSessionAdmissions = new Map<string, {
    auth: AuthContext;
    validUntil: number;
  }>();
  private productSessionAdmissionRevision = 0;
  /** Avoid a durable-outbox point read on every high-frequency token frame. */
  private semanticRealtimePending = false;
  /** One successful KV read per object lifetime, shared by concurrent runs. */
  private contextWindowSnapshot: Promise<Readonly<Record<string, number>>> | null = null;
  /**
   * Not `readonly`, and not assigned in the constructor body: the store applies
   * this object's schema when it is constructed, and reporting a failed
   * migration needs an `await` before the throw escapes. All three are assigned
   * in the first, synchronous, statements of the `blockConcurrencyWhile`
   * callback below, which runs before the constructor returns and before any
   * handler can observe any of them — every one of them waits on `initialized`
   * first.
   */
  private objectStore!: WorkstreamObjectStore;
  /** This object's own `SUBSTREAM_AGENTS` name; see {@link selfObjectName}. */
  private objectName: string | null = null;
  private product!: WorkstreamObjectProductService;
  private terminal!: WorkstreamTerminalStorage;
  private toolReceipts!: WorkstreamToolReceiptStorage;
  private residentContext!: WorkstreamResidentContextStorage;
  private scheduling!: WorkstreamSchedulingStorage;

  private messages!: WorkstreamMessageStorage;
  private transcript!: WorkstreamTranscriptStorage;
  private loop!: SubstreamLoopStorage;
  private resources!: WorkstreamResourceStorage;
  private identityRows!: WorkstreamIdentityStorage;
  private harnessRuns!: WorkstreamHarnessRunStorage;
  private desktopActions!: WorkstreamDesktopActionStorage;
  /**
   * The tools in this isolate waiting on a desktop, by action id. Memory only:
   * the action and its answer are durable rows, and a tool re-entered after
   * eviction reads its answer there rather than from a waiter that is gone.
   */
  private readonly desktopActionWaiters = new Map<string, (outcome: DesktopActionOutcome) => void>();
  /** Schema, repositories, and identity required to admit and snapshot a feed. */
  private readonly storageReady: Promise<void>;
  private runtimeRecovery: Promise<void> | null = null;
  private get initialized(): Promise<void> {
    return this.startRuntimeRecovery();
  }
  private readonly keepAliveLease: DurableAgentKeepAlive;
  private readonly agentDrain = new DurableAgentDrain();
  /** Queue-acceptance passes serialize without making execution wait for them. */
  private externalProjectionDrain: Promise<void> = Promise.resolve();
  /** Post-run delivery/maintenance proceeds independently of inference. */
  private readonly externalSettlementDrain = new DurableAgentDrain();
  /** Fresh terminal outcomes retain metrics that are not part of the durable receipt. */
  private readonly freshTerminalOutcomes = new Map<string, AgentTerminalOutcome>();
  /** Distinguishes this live object instance from the predecessor it replaces. */
  private readonly harnessLeaseOwnerNonce = uuidV7();
  private readonly recoverableHarnessAttempts = new Map<string, string>();
  /**
   * Whether the drain this alarm just ran left a run in someone else's hands.
   *
   * Read only by `armAlarmAfterDueWork`, and reset at the top of every alarm's
   * work: a deferral means the persistent loop's current execution is still
   * due and still owned, so re-deriving from its receipt would arm for an
   * instant already past.
   */
  private loopDrainDeferred = false;
  private activeLoopExecution: {
    runId: string;
    leaseOwner: string;
    executionEpoch: number;
  } | null = null;

  private harnessAttemptOwner(
    input: Pick<WorkstreamWorkflowInput, "substreamId" | "harnessRunId">,
    attemptId: string,
  ): string {
    return `substream-agent:${input.substreamId ?? "0"}:${input.harnessRunId}:${attemptId}:${this.harnessLeaseOwnerNonce}`;
  }

  constructor(
    state: DurableObjectState,
    env: Env
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    // Everything downstream is handed this environment or one derived from it,
    // so a helper that addresses "the agent that owns this work stream" reaches
    // the object it is already running in rather than the namespace. See
    // `lib/durable-object-self.ts`.
    //
    // The parameter is rebound as well as the field, so the rest of this
    // constructor cannot hand the unregistered environment to something
    // long-lived. That is not hypothetical: `WorkstreamObjectProductService`
    // below keeps its environment for the object's whole life, and resolves
    // this work stream's own model routing through it.
    this.env = env = withDurableObjectSelf(env, {
      namespace: env.SUBSTREAM_AGENTS,
      name: () => this.selfObjectName(),
      id: state.id,
      instance: this,
    });
    this.keepAliveLease = new DurableAgentKeepAlive(async () => { await this.armNextAlarm(); });
    this.storageReady = this.initializeDurableObject(async () => {
      // The store applies this object's schema in its own constructor, so the
      // report wrapper goes around the construction rather than around a
      // migration call this class makes itself. It happens here rather than in
      // the constructor body only so that a failed migration can be reported
      // before the throw leaves this callback — the throw breaks the object's
      // input gate, and a report still in flight dies with it. The construction
      // itself is unchanged and still synchronous: this is the first statement
      // of a callback that `blockConcurrencyWhile` invokes immediately.
      this.objectStore = await this.applyMigrations(() => new WorkstreamObjectStore(
        state.storage,
        env.APP_VERSION ?? "unknown",
        env.AVALON_REGION,
      ));
      this.transcript = new WorkstreamTranscriptStorage(
        state.storage,
        () => this.state.getWebSockets().some((socket) =>
          this.readAttachment(socket)?.transcriptSnapshot != null),
      );
      this.loop = new SubstreamLoopStorage(state.storage);
      this.product = new WorkstreamObjectProductService(
        state.storage,
        this.objectStore,
        env,
        this.transcript,
        this.loop,
        () => this.externalSubstreamId(),
      );
      this.product.sidekickAllowsManager = (input) => sidekickAllowsManager(env, {
        workspaceId: asWorkspaceId(input.workspaceId), automationId: input.automationId,
        actor: { userId: asUserId(input.actor.userId), actorRole: input.actor.actorRole },
      });
      this.terminal = new WorkstreamTerminalStorage(state.storage);
      this.toolReceipts = new WorkstreamToolReceiptStorage(state.storage);
      this.residentContext = new WorkstreamResidentContextStorage(state.storage);
      this.scheduling = new WorkstreamSchedulingStorage(state.storage);
      this.messages = new WorkstreamMessageStorage(state.storage);
      this.resources = new WorkstreamResourceStorage(state.storage);
      this.identityRows = new WorkstreamIdentityStorage(state.storage);
      this.harnessRuns = new WorkstreamHarnessRunStorage(state.storage);
      this.desktopActions = new WorkstreamDesktopActionStorage(state.storage);
      await this.objectStore.waitUntilReady();
      this.semanticRealtimePending = this.objectStore.nextSemanticRealtimeDueAt() !== null;
      // Existing one-room-per-workstream objects become the main child during
      // the maintenance cutover. A non-main child records its external id on
      // its first scoped request and may never change it afterward.
      // Read unnarrowed: an object whose parent was retired (a Thread's or a
      // Space's) must still construct, so the operator dump can read it and
      // `retireObject` can close it; it has no loop to recover.
      const constructedIdentity = this.objectStore.identityForRetirement();
      if (constructedIdentity && HostedConversationParentKindSchema.safeParse(constructedIdentity.parentKind).success) {
        const persistedSubstream = this.state.storage.sql.exec<{
          external_substream_id: string;
        }>(
          `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
        ).toArray()[0];
        if (!persistedSubstream) this.ensureSubstreamIdentity("0");
        {
          // Before the first projection read, which caches every message:
          // loop state written before the harness stopped persisting tool
          // image parts would otherwise load them all, the very load that ran
          // these objects past their memory limit.
          const loopId = substreamLoopId(asWorkstreamId(constructedIdentity.parentId), this.externalSubstreamId());
          const retired = await this.transcript.retireInlineToolMessageContent(loopId);
          if (retired > 0) {
            logWarn(this.env, "bind_loop_inline_tool_content_retired", {
              workspace_id: constructedIdentity.workspaceId,
              workstream_id: constructedIdentity.parentId,
              substream_id: this.externalSubstreamId(),
              messages: retired,
            });
          }
          this.ensurePersistentLoop();
        }
      }
    });
    const initialRecovery = this.initialized;
    this.state.waitUntil(initialRecovery.catch((error) => {
      // Read through a guard: this closure holds the raw receiver, outside the
      // construction window, so on a retired object the id read itself is
      // refused — and a throw inside a `waitUntil` callback is an unhandled
      // rejection rather than the warning this exists to write.
      let substreamId = "unknown";
      try {
        substreamId = this.externalSubstreamId();
      } catch {
        // Logged as unknown rather than not at all.
      }
      logWarn(this.env, "substream_runtime_recovery_failed", {
        substream_id: substreamId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }));
    // Exact text ping/pong frames are answered by the runtime without waking a
    // hibernated object, so keepalives do not accrue Durable Object duration.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * Lease repair and alarm derivation for an isolate that replaced another.
   *
   * A prototype method rather than a closure the constructor binds, and the
   * reason is retirement. This runs *outside* the construction window on
   * purpose — a cold socket upgrade must not wait on the storage alarm round
   * trip — so on a retired object it meets the gate, and the gate can only lift
   * itself for a call whose receiver it supplied. A closure over the
   * constructor's `this` is invisible to that, and is refused on the first
   * private helper it touches — which is what left a retired agent unreachable
   * after its first eviction.
   */
  private runtimeRecoveryAttempt(): Promise<void> {
    return this.storageReady.then(() => inDurableObjectPhase(
      this.env,
      "runtime_recovery",
      {
        component: WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
        className: "AgentLoopDO",
        latestVersion: latestMigrationVersion(WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS),
      },
      async () => {
      // Nothing to recover on a retired object, and nothing this may write.
      // The permit that lets recovery run at all carries the whole call, so
      // without this the lease repair below wrote rows and the alarm sync
      // re-derived wake reasons into `_internal_durable_alarms` on every
      // rebuild of a closed agent — a retired object "writing again", and the
      // one path by which a cleared alarm index could refill.
      if (readObjectRetirement(this.state.storage.sql) !== null) return;
      // Still-live local leases belong to the isolate this one replaced, so
      // their runs are recoverable now. Already-expired rows stay with the
      // ordinary stale-run reaper.
      const recoveryStartedAt = Date.now();
      const recoverableAttempts = expireLocalAttemptLeasesFromPreviousInstance(
        this.state.storage,
        recoveryStartedAt,
      );
      for (const attempt of recoverableAttempts) {
        this.recoverableHarnessAttempts.set(attempt.runId, attempt.attemptId);
      }
      // The singleton execution lease belongs to the same vanished isolate as
      // its harness-attempt lease. Leaving it live would make a replacement
      // wait out the full loop lease even though the constructor has already
      // proved that the subordinate executor cannot write again. Deliberate
      // A receipt due now is equally conclusive: its singleton owner vanished
      // with this isolate even when the provider attempt never acquired its
      // subordinate row. Only an explicit future execution_available_at is a
      // deliberate deferral and keeps the lease alive.
      const activeLoop = this.loop.loop();
      const activeExecutionId = activeLoop?.active_execution_id ?? null;
      const activeReceipt = activeExecutionId === null
        ? undefined
        : this.state.storage.sql.exec<{
          terminalized_at: number | null;
          execution_available_at: number | null;
        }>(
          `SELECT terminalized_at, execution_available_at FROM runs WHERE run_id = ?`,
          activeExecutionId,
        ).toArray()[0];
      const activeReceiptIsDue = activeReceipt?.terminalized_at === null
        && (activeReceipt.execution_available_at === null
          || activeReceipt.execution_available_at <= recoveryStartedAt);
      if (activeLoop?.status === "executing"
        && activeLoop.active_execution_id !== null
        && activeLoop.active_execution_epoch !== null
        && activeLoop.lease_owner !== null
        && (activeReceiptIsDue
          || recoverableAttempts.some(({ runId }) => runId === activeLoop.active_execution_id))) {
        this.loop.expireExecutionLeaseForEvictedOwner({
          executionId: activeLoop.active_execution_id,
          executionEpoch: activeLoop.active_execution_epoch,
          leaseOwner: activeLoop.lease_owner,
          now: recoveryStartedAt,
        });
      }
      // Older versions could admit an ordinary input behind an open question
      // and park it there. Reconcile only rows that were already queued after
      // that question; a message from before it does not supersede it.
      this.state.storage.transactionSync(() => {
        this.loop.cancelPendingElicitations(recoveryStartedAt, true);
      });
      // A run left behind by a previous isolate is rediscovered here, by
      // arming the alarm rather than by starting a drain this constructor
      // cannot stay alive to finish. The full derivation runs rather than an
      // arm-only helper because the keep-alive lease is in-memory: a new
      // instance inherits none of it, so a heartbeat alarm left behind by the
      // evicted one has to be cleared when no durable work remains.
      this.syncAgentTimerAlarms();
      await this.armNextAlarm();
      },
    ));
  }

  /**
   * Runtime repair is single-flight while it is running, but a failed attempt
   * cannot poison this isolate. Mutating entry points see that failure; the
   * next one retries the idempotent lease/alarm derivation. Feed reads continue
   * to wait only for `storageReady`.
   */
  private startRuntimeRecovery(): Promise<void> {
    if (this.runtimeRecovery) return this.runtimeRecovery;
    const attempt = this.runtimeRecoveryAttempt();
    this.runtimeRecovery = attempt;
    void attempt.catch(() => {
      if (this.runtimeRecovery === attempt) this.runtimeRecovery = null;
    });
    return attempt;
  }

  private ensureSubstreamIdentity(substreamId: string): void {
    const existing = this.state.storage.sql.exec<{ external_substream_id: string }>(
      `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
    ).toArray()[0];
    if (existing && existing.external_substream_id !== substreamId) {
      throw new Error("substream_agent_identity_mismatch");
    }
    if (existing) return;
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO substream_agent_identity
         (id, external_substream_id, created_at, updated_at)
       VALUES (1, ?, ?, ?)`,
      substreamId,
      now,
      now,
    );
  }

  private ensurePersistentLoop() {
    const identity = this.objectStore.identity();
    if (!identity) throw new Error("substream_loop_identity_unavailable");
    const substreamId = this.externalSubstreamId();
    const loopId = substreamLoopId(asWorkstreamId(identity.parentId), substreamId);
    const bindStateRevision = this.transcript.readBindProjection(loopId)?.stateRevision ?? 0;
    return this.loop.ensureLoop({ loopId, bindStateRevision, now: Date.now() });
  }

  /**
   * This object's own name in `SUBSTREAM_AGENTS`, or `null` before it has one.
   *
   * Memoized only once a name exists. Both durable facts are write-once — a
   * root identity is never rewritten, and `ensureSubstreamIdentity` refuses a
   * second external id — so a derived name cannot change, while a `null` has to
   * stay re-derivable because the facts arrive on the object's first scoped
   * request. Freezing a `null` would leave the object permanently unable to
   * recognize itself.
   *
   * The substream row is read here rather than through
   * {@link externalSubstreamId}, whose `"0"` default is right for its own
   * callers — they ask it *am I the main child?*, and an unwritten row reads as
   * yes — and wrong as a name. See {@link substreamSelfObjectName}.
   */
  private selfObjectName(): string | null {
    if (this.objectName !== null) return this.objectName;
    // Genuinely absent, definite-assignment notwithstanding: the environment
    // carrying this object's self-registration exists from the first statement
    // of the constructor, and the store is built inside the callback below it.
    if (!this.objectStore) return null;
    // Guarded like every other object's name read. A throw here would not stay
    // local: the thunk runs inside `durableObjectSelfForId`, so a missing table would
    // take down *every* `SUBSTREAM_AGENTS` resolution this object makes,
    // including the sibling calls that have nothing to do with self-recognition.
    try {
      const substream = this.state.storage.sql.exec<{ external_substream_id: string }>(
        `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
      ).toArray()[0];
      this.objectName = substreamSelfObjectName(
        this.env.AVALON_REGION,
        this.objectStore.identity(),
        substream?.external_substream_id ?? null,
      );
    } catch {
      return null;
    }
    return this.objectName;
  }

  private externalSubstreamId(): SubstreamId {
    return asSubstreamId(this.state.storage.sql.exec<{ external_substream_id: string }>(
      `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
    ).toArray()[0]?.external_substream_id ?? "0");
  }

  /**
   * Keep this isolate warm while in-memory Bind work is active.
   *
   * This is the narrow, reference-counted mechanism used by the Agents SDK:
   * the first lease caps the shared alarm at 30 seconds, nested leases share
   * it, and the final idempotent disposer recomputes the alarm exclusively
   * from durable work. The count is intentionally in memory; an evicted
   * isolate also lost the computation it protected, and the durable dispatch
   * ledger is what restarts that computation.
   */
  /**
   * Bring this object up, and nothing else.
   *
   * Awaiting `storageReady` is the whole point: it runs the migrations and the
   * schema work that make the first real call slow, so a caller can start a
   * conversation's cold start before the first request that needs it.
   * Without side effects, so it stays free to call on
   * an object nobody has asked for yet.
   */
  async wake(): Promise<{
    objectId: string;
    authorityMode: "unclaimed" | "preparing" | "authoritative";
  }> {
    await this.storageReady;
    const root = this.state.storage.sql.exec<{ authority_mode: "preparing" | "authoritative" }>(
      `SELECT authority_mode FROM workstream WHERE id = 1`,
    ).toArray()[0];
    return {
      objectId: this.state.id.toString(),
      authorityMode: root?.authority_mode ?? "unclaimed",
    };
  }

  /**
   * Prepare one feed admission while its already-issued ticket is in transit.
   *
   * The Worker calls this only with values it signed into that ticket. Nothing
   * is durable here: losing the isolate loses the optimization and the upgrade
   * takes the ordinary D1-backed path. The ticket receipt remains the one-time
   * authority and is consumed only by the real WebSocket upgrade.
   */
  async prepareSocketAdmission(
    input: SocketAdmissionPreparation,
  ): Promise<{ outcome: "snapshot_prepared" | "admission_prepared" | "refused" }> {
    await this.storageReady;
    const parsed = SocketAdmissionPreparationSchema.safeParse(input);
    if (!parsed.success) return { outcome: "refused" };
    const preparation = parsed.data;
    this.prunePreparedSocketAdmissions();
    if (
      preparation.ticketIssuedAt >= preparation.ticketExpiresAt
      || preparation.ticketExpiresAt <= Math.floor(Date.now() / 1_000)
      || this.socketPreparationWasRevoked(preparation)
    ) {
      return { outcome: "refused" };
    }
    try {
      this.ensureSubstreamIdentity(preparation.substreamId);
      this.objectStore.ensureIdentity({
        workspaceId: preparation.workspaceId,
        parentKind: preparation.parentKind,
        parentId: preparation.workstreamId,
      }, this.env.AVALON_REGION);
    } catch {
      return { outcome: "refused" };
    }
    if (
      this.objectStore.realtimeAuthorityGeneration() !== preparation.authorityGeneration
      || !this.objectStore.isRealtimeWritable()
      || !this.product.canRead(preparation.userId)
    ) return { outcome: "refused" };

    // Ticket issue authenticated this session, but the deferred call can arrive
    // after a logout or membership removal. Recheck during ticket transit so
    // the upgrade can safely reuse the result without paying this D1 join.
    const admission = await this.socketAdmissionAuth(preparation);
    if (
      !admission
      || admission.auth.role !== preparation.role
      || (admission.auth.analyticsWorkspaceId ?? null) !== preparation.analyticsWorkspaceId
      // The revocation handler can interleave while the D1 query above yields.
      // Its latest-per-reader fence closes that ordering before insertion.
      || this.socketPreparationWasRevoked(preparation)
      || this.objectStore.realtimeAuthorityGeneration() !== preparation.authorityGeneration
      || !this.objectStore.isRealtimeWritable()
      || !this.product.canRead(preparation.userId)
    ) return { outcome: "refused" };

    const entry: PreparedSocketAdmission = {
      input: preparation,
      auth: admission.auth,
      sessionExpiresAt: admission.sessionExpiresAt,
      snapshot: null,
      snapshotReason: null,
      snapshotSequence: null,
      snapshotRevision: null,
    };
    this.storePreparedSocketAdmission(entry);

    const sequence = await this.currentSequence();
    const plan = planSocketReplay(
      preparation.afterSequence ?? 0,
      sequence,
      this.replayFloorSequence,
      this.recentEvents,
    );
    // A speculative hover can remain unused for most of the ticket window.
    // Keep its admission warm, but assemble viewer-specific detail only for an
    // immediate non-speculative dial so time-derived and external D1 fields do
    // not sit stale behind the realtime sequence fence.
    if (plan.type !== "snapshot" || preparation.speculative) {
      return { outcome: "admission_prepared" };
    }

    try {
      const snapshotRevision = this.socketSnapshotRevision;
      const snapshot = await this.assembleSocketSnapshot(
        preparation.workspaceId,
        preparation.workstreamId,
        admission.auth,
        preparation.speculative,
        plan.reason,
        sequence,
        false,
      );
      // A revocation or local visibility change may have removed the entry
      // while snapshot assembly yielded to D1. Never resurrect it afterward.
      if (
        this.preparedSocketAdmissions.get(preparation.ticketId) === entry
        && preparation.ticketExpiresAt > Math.floor(Date.now() / 1_000)
        && !this.socketPreparationWasRevoked(preparation)
        && this.objectStore.realtimeAuthorityGeneration() === preparation.authorityGeneration
        && this.product.canRead(preparation.userId)
        && this.socketSnapshotRevision === snapshotRevision
      ) {
        // Pending-input spill is intentionally unbounded by aggregate transport
        // size. It must stay a streaming delivery path, never retained as a
        // prepared array of encoded frames.
        if (snapshot.pendingInputChunks.length > 0) {
          return { outcome: "admission_prepared" };
        }
        this.clearPreparedSocketSnapshot();
        entry.snapshot = snapshot;
        entry.snapshotReason = plan.reason;
        entry.snapshotSequence = sequence;
        entry.snapshotRevision = snapshotRevision;
        this.preparedSocketSnapshotTicketId = preparation.ticketId;
        return { outcome: "snapshot_prepared" };
      }
    } catch (error) {
      logWarn(this.env, "substream_socket_snapshot_prepare_failed", {
        workspace_id: preparation.workspaceId,
        workstream_id: preparation.workstreamId,
        substream_id: preparation.substreamId,
        ticket_id: preparation.ticketId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
    return {
      outcome: this.preparedSocketAdmissions.get(preparation.ticketId) === entry
        ? "admission_prepared"
        : "refused",
    };
  }

  private prunePreparedSocketAdmissions(now = Math.floor(Date.now() / 1_000)): void {
    for (const [ticketId, prepared] of [...this.preparedSocketAdmissions]) {
      if (prepared.input.ticketExpiresAt <= now) this.deletePreparedSocketAdmission(ticketId);
    }
  }

  private storePreparedSocketAdmission(entry: PreparedSocketAdmission): void {
    const olderTicketId = this.preparedSocketAdmissionTicketId;
    if (olderTicketId) this.deletePreparedSocketAdmission(olderTicketId);
    this.preparedSocketAdmissions.set(entry.input.ticketId, entry);
    this.preparedSocketAdmissionTicketId = entry.input.ticketId;
  }

  private deletePreparedSocketAdmission(ticketId: string): void {
    const prepared = this.preparedSocketAdmissions.get(ticketId);
    this.preparedSocketAdmissions.delete(ticketId);
    if (prepared && this.preparedSocketAdmissionTicketId === ticketId) {
      this.preparedSocketAdmissionTicketId = null;
    }
    if (this.preparedSocketSnapshotTicketId === ticketId) {
      this.preparedSocketSnapshotTicketId = null;
    }
  }

  private clearPreparedSocketSnapshot(): void {
    const ticketId = this.preparedSocketSnapshotTicketId;
    if (!ticketId) return;
    const prepared = this.preparedSocketAdmissions.get(ticketId);
    if (prepared) {
      prepared.snapshot = null;
      prepared.snapshotReason = null;
      prepared.snapshotSequence = null;
      prepared.snapshotRevision = null;
    }
    this.preparedSocketSnapshotTicketId = null;
  }

  private invalidatePreparedSocketSnapshots(): void {
    this.socketSnapshotRevision += 1;
    this.clearPreparedSocketSnapshot();
  }

  private socketPreparationWasRevoked(
    preparation: Pick<SocketAdmissionPreparation, "ticketIssuedAt">,
  ): boolean {
    return this.latestSocketRevocationAt >= preparation.ticketIssuedAt;
  }

  private rememberSocketRevocation(): void {
    this.latestSocketRevocationAt = Math.floor(Date.now() / 1_000);
  }

  private preparedSocketAdmission(identity: SocketUpgradeIdentity): PreparedSocketAdmission | null {
    this.prunePreparedSocketAdmissions();
    if (
      identity.admissionVersion !== 1
      || identity.authorityGeneration === undefined
      || identity.role === undefined
    ) return null;
    const prepared = this.preparedSocketAdmissions.get(identity.ticketId);
    if (!prepared) return null;
    const input = prepared.input;
    const matches = input.workspaceId === identity.workspaceId
      && input.workstreamId === identity.workstreamId
      && input.substreamId === identity.substreamId
      && input.userId === identity.userId
      && input.sessionId === identity.sessionId
      && input.ticketId === identity.ticketId
      && input.ticketExpiresAt === identity.ticketExpiresAt
      && input.afterSequence === identity.afterSequence
      && input.speculative === identity.speculative
      && input.authorityGeneration === identity.authorityGeneration
      && (input.membershipVersion ?? 0) === (identity.membershipVersion ?? 0)
      && input.role === identity.role
      && input.analyticsWorkspaceId === (identity.analyticsWorkspaceId ?? null);
    if (
      !matches
      || this.socketPreparationWasRevoked(input)
      || (prepared.sessionExpiresAt !== null && prepared.sessionExpiresAt <= Date.now())
      || this.objectStore.realtimeAuthorityGeneration() !== input.authorityGeneration
      || !this.objectStore.isRealtimeWritable()
      || !this.product.canRead(input.userId)
    ) {
      this.deletePreparedSocketAdmission(identity.ticketId);
      return null;
    }
    return prepared;
  }

  async keepAlive(): Promise<() => void> {
    return this.keepAliveLease.keepAlive();
  }

  async keepAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    return this.keepAliveLease.while(fn);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.storageReady;
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/socket" || url.pathname === "/")) {
      return this.acceptSocket(request, url);
    }

    await this.initialized;

    if (
      request.method === "POST" &&
      (url.pathname === "/internal/events" || url.pathname === "/events")
    ) {
      return this.acceptEvent(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/product") {
      return this.acceptProductRequest(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/tool-receipt") {
      return this.acceptToolReceiptOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/resident-context") {
      return this.acceptResidentContextOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/scheduling") {
      return this.acceptSchedulingOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/messages") {
      return this.acceptMessageOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/resources") {
      return this.acceptResourceOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/harness-runs") {
      return this.acceptHarnessRunOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/identity") {
      return this.acceptIdentityOperation(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/terminal") {
      return this.acceptTerminalOperation(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/runtime-resource") {
      return this.acceptRuntimeResource(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/runtime-bootstrap") {
      return this.acceptRuntimeBootstrap(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/refresh-agent-alarm") {
      const parsed = AgentTimerRefreshRequestSchema.safeParse(await request.json().catch(() => null));
      const identity = this.objectStore.identity();
      if (!parsed.success || !identity
        || identity.workspaceId !== parsed.data.workspaceId
        || identity.parentId !== parsed.data.workstreamId) {
        return jsonResponse({ error: "substream_timer_identity_mismatch" }, 409);
      }
      try {
        this.ensureSubstreamIdentity(parsed.data.substreamId);
        this.syncAgentTimerAlarms();
        await this.armNextAlarm();
        return jsonResponse({ ok: true });
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : "substream_timer_refresh_failed",
        }, 409);
      }
    }

    if (request.method === "GET" && url.pathname === "/presence") {
      const identity = this.objectStore.identity();
      if (!identity) return jsonResponse({ viewers: [] });
      return jsonResponse({
        viewers: await this.loadViewers(identity.workspaceId, identity.parentId),
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        sockets: this.state.getWebSockets().length,
        schema: "workstream-do-v2",
        databaseBytes: this.objectStore.databaseSize(),
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  }

  /**
   * `traced` says whether the caller is inside one of the three work-stream
   * flows. Nothing about the trace itself is passed: a Durable Object call is a
   * traced binding call, so the spans this opens are already children of the
   * caller's by async context. The flag only decides whether to open them.
   */
  async handleProductRequest(
    input: SubstreamProductRequestInput,
    traced = false,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptProductRequest(this.rpcRequest(input), traced));
  }

  async attachRuntimeResource(input: SubstreamRuntimeResourceRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptRuntimeResource(this.rpcRequest(input)));
  }

  /**
   * Recheck a projected watched link and complete audience before appending one
   * connector update. WorkspaceDO discovers the destination; this object owns
   * the final disclosure decision and transcript idempotency.
   */
  async appendWatchedResourceEvent(input: unknown): Promise<{
    outcome: "appended" | "replayed" | "refused";
    code: string;
  }> {
    await this.initialized;
    const request = parseRpcInput(z.strictObject({
      schemaVersion: z.literal(1),
      workspaceId: z.string().min(1),
      workstreamId: z.string().min(1),
      substreamId: z.union([z.literal("0"), z.string().min(1)]),
      resourceId: z.string().min(1),
      registrationId: z.string().min(1),
      event: z.strictObject({
        id: z.string().min(1),
        eventSequence: z.number().int().positive(),
        eventType: z.string().min(1),
        title: z.string().min(1),
        summary: z.string(),
        textSnippet: z.string().default(""),
        metadata: z.record(z.string(), z.unknown()).default({}),
        occurredAt: z.number().int().nonnegative(),
        audienceKind: z.enum(["workspace", "restricted"]),
        audienceUserIds: z.array(z.string().min(1)),
      }),
    }), input, "append_watched_resource_event");
    // The receipt is the event and the registration that matched it: the same
    // event redelivered for the same watch is one row, and the same event
    // matched by a second watch on another resource is another.
    const clientMessageId = `resource-update:${request.event.id}:${request.registrationId}`;
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== request.workspaceId
      || identity.parentId !== request.workstreamId
      || this.externalSubstreamId() !== request.substreamId) {
      return { outcome: "refused", code: "workstream_destination_mismatch" };
    }
    if (this.messages.messageByClientId({ clientMessageId })) {
      return { outcome: "replayed", code: "resource_update_replayed" };
    }
    const prepared = await this.messages.prepareMessage({
      messageId: uuidV7(request.event.occurredAt),
      clientMessageId,
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      messageType: "system",
      text: request.event.summary
        ? `${request.event.title}\n\n${request.event.summary}`
        : request.event.title,
      structuredContentJson: JSON.stringify({
        type: "resource_update",
        eventId: request.event.id,
        eventType: request.event.eventType,
        resourceId: request.resourceId,
      }),
      producedByRunId: null,
      now: request.event.occurredAt,
    });
    return this.product.commitRuntimeMutation(() => {
      const authority = this.ctx.storage.sql.exec<{
        archived_at: number | null;
      }>(`SELECT archived_at FROM workstream WHERE id = 1`).toArray()[0];
      if (!authority) return { outcome: "refused" as const, code: "workstream_not_found" };
      if (authority.archived_at !== null) {
        return { outcome: "refused" as const, code: "workstream_archived" };
      }
      const watched = this.ctx.storage.sql.exec<{ watch_enabled: number }>(
        `SELECT watch_enabled FROM workstream_resource_links WHERE resource_id = ?`,
        request.resourceId,
      ).toArray()[0];
      if (watched?.watch_enabled !== 1) {
        return { outcome: "refused" as const, code: "resource_watch_not_active" };
      }
      if (request.event.audienceKind === "restricted") {
        const audience = new Set(request.event.audienceUserIds);
        const participants = this.ctx.storage.sql.exec<{ user_id: string }>(
          `SELECT user_id FROM participants WHERE status = 'active'`,
        ).toArray();
        if (participants.some((participant) => !audience.has(participant.user_id))) {
          return { outcome: "refused" as const, code: "resource_update_audience_insufficient" };
        }
      }
      const appended = this.messages.appendPreparedMessage(prepared);
      return {
        outcome: appended.outcome === "replayed" ? "replayed" as const : "appended" as const,
        code: appended.outcome === "replayed" ? "resource_update_replayed" : "resource_update_appended",
      };
    }, true);
  }

  /**
   * Propose an automation an agent drafted here, as a card the room can accept.
   *
   * Idempotent on the automation and its revision: refining a draft writes a
   * new card rather than a duplicate of the old one, so the feed reads as the
   * conversation it was — proposal, question, better proposal — and the card
   * somebody accepts is the one they were looking at.
   */
  async appendDraftProposedCard(input: unknown): Promise<{
    outcome: "appended" | "replayed" | "refused";
    code: string;
  }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      workspaceId: z.string().min(1),
      workstreamId: z.string().min(1),
      definitionRevision: z.number().int().positive(),
      occurredAt: z.number().int().nonnegative(),
      card: AutomationDraftProposedV1Schema,
    }).parse(input);
    const card = request.card;
    const clientMessageId =
      `automation:${card.automationId}:draft:${request.definitionRevision}`;
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== request.workspaceId
      || identity.parentId !== request.workstreamId
      || this.externalSubstreamId() !== "0") {
      return { outcome: "refused", code: "workstream_destination_mismatch" };
    }
    if (this.messages.messageByClientId({ clientMessageId })) {
      return { outcome: "replayed", code: "sidekick_draft_card_replayed" };
    }
    const prepared = await this.messages.prepareMessage({
      messageId: uuidV7(request.occurredAt),
      clientMessageId,
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      messageType: "system",
      // Stands alone for a reader with no card: a Slack mirror, a
      // notification, a client that does not know this kind.
      text: card.ready
        ? `Proposed an automation: ${card.automationName}. ${card.description}`
        : `Drafting an automation: ${card.automationName}. Still needs an answer before it can be created.`,
      structuredContentJson: JSON.stringify(card),
      producedByRunId: null,
      now: request.occurredAt,
    });
    return this.product.commitRuntimeMutation(() => {
      const authority = this.ctx.storage.sql.exec<{ archived_at: number | null }>(
        `SELECT archived_at FROM workstream WHERE id = 1`,
      ).toArray()[0];
      if (!authority) return { outcome: "refused" as const, code: "workstream_not_found" };
      if (authority.archived_at !== null) {
        return { outcome: "refused" as const, code: "workstream_archived" };
      }
      const appended = this.messages.appendPreparedMessage(prepared);
      return {
        outcome: appended.outcome === "replayed" ? "replayed" as const : "appended" as const,
        code: appended.outcome === "replayed"
          ? "sidekick_draft_card_replayed"
          : "sidekick_draft_card_appended",
      };
    }, true);
  }

  /**
   * A Sidekick's `conversation_post`, appended to this conversation as a
   * message from the Sidekick, and nothing else.
   *
   * It accepts a Thread's Main or a Breakout, or a Sidekick's own shared
   * conversation (parent kind `automation`, substream `"0"`, never a run's,
   * which no post may reach), and it does not
   * wake this conversation's agent: a post is something people here read, not
   * a request to the agent here. The agent's next run still reads it: the
   * gap-fill appends it to the model's context, attributed to the Sidekick.
   * The row is keyed by the caller's host-derived client message id, so a
   * retried receipt lands once and answers with the message it already wrote.
   * Who may post here was decided by the caller against WorkspaceDO's
   * admission and the Sidekick's attachments; this object decides only that
   * it is the addressed conversation and that it is not archived.
   */
  async appendConversationPost(input: unknown): Promise<{
    outcome: "appended" | "replayed" | "refused";
    code: string;
    messageId: string | null;
  }> {
    await this.initialized;
    const request = parseRpcInput(ConversationPostRequestSchema, input, "append_conversation_post");
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== request.workspaceId
      || identity.parentKind !== request.parentKind
      || identity.parentId !== request.workstreamId
      || this.externalSubstreamId() !== request.substreamId
      // A Sidekick's and a Canvas's posts land only in the shared conversation.
      || request.substreamId !== "0") {
      return { outcome: "refused", code: "workstream_destination_mismatch", messageId: null };
    }
    const existing = this.messages.messageByClientId({ clientMessageId: request.clientMessageId });
    if (existing) return { outcome: "replayed", code: "conversation_post_replayed", messageId: existing.id };
    const prepared = await this.messages.prepareMessage({
      messageId: uuidV7(request.post.occurredAt),
      clientMessageId: request.clientMessageId,
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      // The activation vocabulary is what renders a row under the Sidekick's
      // own name, in the client and in a later model's transcript.
      messageType: "automation_activation",
      text: request.text,
      structuredContentJson: JSON.stringify(request.post),
      producedByRunId: null,
      now: request.post.occurredAt,
    });
    const result = await this.product.commitRuntimeMutation(() => {
      const authority = this.ctx.storage.sql.exec<{ archived_at: number | null }>(
        `SELECT archived_at FROM workstream WHERE id = 1`,
      ).toArray()[0];
      if (!authority) return { outcome: "refused" as const, code: "workstream_not_found", messageId: null };
      if (authority.archived_at !== null) return { outcome: "refused" as const, code: "workstream_archived", messageId: null };
      const appended = this.messages.appendPreparedMessage(prepared);
      return appended.outcome === "replayed"
        ? { outcome: "replayed" as const, code: "conversation_post_replayed", messageId: appended.messageId }
        : { outcome: "appended" as const, code: "conversation_post_appended", messageId: appended.messageId };
    }, true);
    if (result.outcome === "appended") await this.flushSemanticRealtimeOutboxBestEffort();
    return result;
  }

  /**
   * A Sidekick run's row in this conversation, the Sidekick's own `"0"`: a
   * collapsed `automation_activation` turn that shows the run as it stands.
   *
   * The turn is appended when the run's first projection arrives, keyed
   * `sidekick-run:<runId>`; `sidekick_run_rows` holds what it shows now, which
   * the transcript joins in whenever the turn is read, and the turn's stored
   * text is replaced with each change. A projection older than the one held is
   * dropped, so deliveries in any order converge, unless it is a replay's; one
   * that changes what the row shows moves the turn's revision and sends it to
   * the room. Like a `conversation_post` it never wakes this
   * conversation's agent. The Sidekick's `sidekick_runs` row is authoritative;
   * this is its projection, rebuilt from that table by a replay.
   */
  async projectSidekickRunRow(input: unknown): Promise<{ outcome: "appended" | "updated" | "unchanged" | "refused"; code: string }> {
    await this.initialized;
    const request = parseRpcInput(SidekickRunRowProjectionSchema, input, "project_sidekick_run_row");
    const identity = this.objectStore.identity();
    if (!identity) return { outcome: "refused", code: "sidekick_conversation_uninitialized" };
    if (identity.workspaceId !== request.workspaceId || identity.parentKind !== "automation"
      || identity.parentId !== request.automationId || this.externalSubstreamId() !== "0") {
      return { outcome: "refused", code: "sidekick_conversation_mismatch" };
    }
    const clientMessageId = `sidekick-run:${request.runId}`;
    const held = () => this.ctx.storage.sql.exec<{ turn_id: string; source_version: number }>(
      `SELECT turn_id, source_version FROM sidekick_run_rows WHERE run_id = ?`, request.runId,
    ).toArray()[0];
    const text = sidekickRunRowText(request.state, request.reply);
    const existing = held();
    const prepared = existing ? null : await this.messages.prepareMessage({
      messageId: uuidV7(request.createdAt),
      clientMessageId,
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      messageType: "automation_activation",
      text,
      structuredContentJson: JSON.stringify({
        type: "automation_activation",
        schemaVersion: 1,
        automationId: request.automationId,
        automationName: request.automationName,
        runId: request.runId,
        deliveryId: clientMessageId,
        trigger: { kind: request.triggerKind },
        occurredAt: request.createdAt,
      }),
      producedByRunId: null,
      now: Date.now(),
    });
    // The turn's canonical text follows the row too, so every reader of the
    // stored turn (conversation_read, gap-fill, a conversation as text) sees
    // what the row shows, not only the transcript that joins the row in.
    const content = existing ? await this.sidekickRunRowContent(existing.turn_id, text) : null;
    const result = await this.product.commitRuntimeMutation(() => {
      const now = Date.now();
      const current = held();
      if (!current) {
        if (!prepared) throw new Error("sidekick_run_row_turn_unprepared");
        const appended = this.messages.appendPreparedMessage(prepared);
        this.ctx.storage.sql.exec(
          `INSERT INTO sidekick_run_rows (run_id, turn_id, state, step_count, reply, source_version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          request.runId, appended.messageId, request.state, request.stepCount, request.reply, request.version, now,
        );
        return { outcome: "appended" as const, code: "sidekick_run_row_appended" };
      }
      if (current.source_version > request.version && !request.replay) return { outcome: "unchanged" as const, code: "sidekick_run_row_stale" };
      const changed = this.ctx.storage.sql.exec(
        `UPDATE sidekick_run_rows SET state = ?, step_count = ?, reply = ?, source_version = ?, updated_at = ?
          WHERE run_id = ? AND (state IS NOT ? OR step_count IS NOT ? OR reply IS NOT ?)
          RETURNING run_id`,
        request.state, request.stepCount, request.reply, request.version, now,
        request.runId, request.state, request.stepCount, request.reply,
      ).toArray().length > 0;
      if (!changed) return { outcome: "unchanged" as const, code: "sidekick_run_row_unchanged" };
      if (content && content.turnId === current.turn_id) {
        // Through the fact write path, whose upsert repoints the root fact at
        // the new content-addressed payload; the payload it held before, read
        // here inside the write, is dropped once nothing points at it.
        const previous = this.ctx.storage.sql.exec<{ payload_id: string }>(
          `SELECT payload_id FROM transcript_facts WHERE fact_id = ?`, content.prepared.material.factId,
        ).toArray()[0]?.payload_id;
        insertPreparedCanonicalTranscriptFact(this.ctx.storage.sql, content.prepared, now);
        if (previous !== undefined && previous !== content.prepared.payloadId) {
          this.ctx.storage.sql.exec(
            `DELETE FROM transcript_payloads WHERE payload_id = ?
               AND NOT EXISTS (SELECT 1 FROM transcript_facts WHERE payload_id = ?)`,
            previous, previous,
          );
        }
      }
      this.transcript.reviseParticipantTurnInTransaction(current.turn_id, now);
      return { outcome: "updated" as const, code: "sidekick_run_row_updated" };
    }, true);
    if (result.outcome === "appended" || result.outcome === "updated") await this.flushSemanticRealtimeOutboxBestEffort();
    return result;
  }

  /**
   * The run row turn's stored payload with its text replaced, when the text
   * differs; prepared outside the write because hashing is asynchronous.
   */
  private async sidekickRunRowContent(turnId: string, text: string): Promise<{
    turnId: string; prepared: PreparedCanonicalTranscriptFact;
  } | null> {
    const stored = this.ctx.storage.sql.exec<{
      fact_id: string; fact_kind: string; audience: "shared" | "participant" | "model"; payload_json: string;
      origin_kind: string; source_kind: string | null; source_id: string | null; source_revision: number | null;
      run_id: string | null; tool_call_id: string | null;
    }>(
      `SELECT fact.fact_id, fact.fact_kind, payload.audience, payload.payload_json, fact.origin_kind,
              fact.source_kind, fact.source_id, fact.source_revision, fact.run_id, fact.tool_call_id
         FROM participant_transcript_turns turn
         JOIN transcript_facts fact ON fact.fact_id = turn.root_fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE turn.turn_id = ?`, turnId,
    ).toArray()[0];
    if (!stored) return null;
    const payload = JSON.parse(stored.payload_json) as Record<string, unknown>;
    if (payload.content === text) return null;
    const originKind = stored.origin_kind;
    if (originKind !== "canonical" && originKind !== "protocol" && originKind !== "derived" && originKind !== "system_projection") {
      throw new Error("sidekick_run_row_origin_invalid");
    }
    const prepared = await prepareCanonicalTranscriptFact({
      factId: stored.fact_id, factKind: stored.fact_kind, audience: stored.audience,
      payload: { ...payload, content: text },
      origin: {
        originKind, sourceKind: stored.source_kind,
        sourceId: stored.source_id, sourceRevision: stored.source_revision,
      },
      runId: stored.run_id, turnId, toolCallId: stored.tool_call_id,
    });
    return { turnId, prepared };
  }

  /** Internal runtime metadata, never a transcript or a participant-facing inspection API. */
  async agentRuntimeInfo() {
    await this.initialized;
    const identity = this.identityRows.identity();
    if (!identity) return null;
    const background = this.state.storage.sql.exec<{
      execution_principal_json: string; stopped_at: number | null; root_substream_id: string | null;
    }>(
      "SELECT execution_principal_json, stopped_at, root_substream_id FROM background_agent WHERE id = 1",
    ).toArray()[0];
    return {
      name: identity.title, description: identity.description,
      status: background?.stopped_at != null ? "stopped" : this.loop.loop()?.status ?? "idle",
      pendingWork: background?.stopped_at == null && this.loop.hasPendingWork(),
      background: !!background,
      executionPrincipal: background ? ExecutionPrincipalSchema.parse(JSON.parse(background.execution_principal_json)) : null,
      rootSubstreamId: background?.root_substream_id ?? null,
    };
  }

  /** One host RPC; keep bootstrap, identity projection and principal initialization on their existing paths. */
  async initializeDelegatedAgent(input: {
    bootstrap: SubstreamRuntimeBootstrapRequest;
    provision: WorkstreamProvisionInput;
    executionPrincipal: WorkstreamWorkflowInput["executionPrincipal"];
    rootSubstreamId: SubstreamId;
  }): Promise<DurableObjectRpcResult> {
    const boot = await this.bootstrapRuntime(input.bootstrap);
    if (boot.status !== 200) return boot;
    // Marked before provision, because provision publishes this conversation's
    // first directory projection and the parent classifies it by the
    // `backgroundAgent` flag that projection carries. Marked after, the first
    // projection said "breakout", the Channel forwarded it, and the
    // Organization kept an unseen breakout row nobody could open or clear.
    await this.initializeBackgroundAgent({ executionPrincipal: input.executionPrincipal, rootSubstreamId: input.rootSubstreamId });
    return this.executeIdentityOperation({
      workspaceId: input.bootstrap.workspaceId, workstreamId: input.bootstrap.parentId,
      substreamId: input.bootstrap.substreamId ?? "0", operation: "provision", args: [input.provision],
    });
  }

  async initializeBackgroundAgent(input: {
    executionPrincipal: WorkstreamWorkflowInput["executionPrincipal"];
    rootSubstreamId: SubstreamId;
  }) {
    await this.initialized;
    const principal = ExecutionPrincipalSchema.parse(input.executionPrincipal);
    this.state.storage.sql.exec(
      "INSERT OR IGNORE INTO background_agent (id, execution_principal_json, root_substream_id) VALUES (1, ?, ?)",
      JSON.stringify(principal), input.rootSubstreamId,
    );
  }

  /** Ownership is resolved by the host's workspace team authority before this RPC. */
  async stopOwnedAgent() {
    await this.initialized;
    this.state.storage.transactionSync(() => {
      const now = Date.now();
      // Hold future admissions; never terminate or settle an active Bind step
      // here. Active execution observes the same fenced stop as foreground work.
      this.state.storage.sql.exec("UPDATE background_agent SET stopped_at = COALESCE(stopped_at, ?) WHERE id = 1", now);
      const loop = this.loop.loop();
      if (loop?.status === "executing" && loop.active_execution_id !== null
        && loop.active_execution_epoch !== null && loop.lease_owner !== null) {
        this.loop.requestStopInTransaction({
          executionId: loop.active_execution_id,
          executionEpoch: loop.active_execution_epoch, leaseOwner: loop.lease_owner,
          expectedLoopRevision: loop.revision, reason: "stopped_by_parent", now,
        });
      }
    });
    return { stopped: true as const };
  }

  /** Persist a teammate input and request an independent loop activation. */
  async admitAgentMessage(input: AdmitAgentMessageInput): Promise<
    { accepted: true; messageId: string } | { accepted: false; code: string }
  > {
    await this.initialized;
    const request = AdmitAgentMessageInputSchema.parse(input);
    const identity = this.objectStore.identity();
    if (!identity) return { accepted: false, code: "agent_destination_unavailable" };
    if (identity.workspaceId !== request.workspaceId
      || identity.parentId !== request.workstreamId
      || agentIdForAddress({
        parentKind: identity.parentKind, parentId: identity.parentId,
        substreamId: asSubstreamId(this.externalSubstreamId()),
      }) !== request.recipientAgentId) return { accepted: false, code: "agent_destination_mismatch" };
    const parent = await conversationParentStub(this.env, {
      workspaceId: identity.workspaceId, parentKind: identity.parentKind, parentId: identity.parentId,
    });
    const authority = await parent.authority({ workspaceId: asWorkspaceId(identity.workspaceId), parentId: identity.parentId });
    if (!authority.exists || authority.archived) return { accepted: false, code: "workstream_archived" };
    if (authority.authorityGeneration !== this.objectStore.realtimeAuthorityGeneration()) {
      return { accepted: false, code: "workstream_authority_generation_stale" };
    }
    try {
      const background = this.state.storage.sql.exec<{ execution_principal_json: string }>(
        "SELECT execution_principal_json FROM background_agent WHERE id = 1",
      ).toArray()[0];
      const result = await this.product.admitSystemActivation({
        ...request,
        executionPrincipal: background
          ? ExecutionPrincipalSchema.parse(JSON.parse(background.execution_principal_json))
          : request.executionPrincipal,
      });
      if (result.activationRequest) await this.requestPersistentLoopActivation(result.activationRequest);
      if (result.inserted) await this.flushSemanticRealtimeOutboxBestEffort();
      return { accepted: true, messageId: result.turn.turnId };
    } catch (error) {
      if (error instanceof Error && error.message === "workstream_archived") {
        return { accepted: false, code: "workstream_archived" };
      }
      throw error;
    }
  }

  /**
   * The host's review notice for a Sidekick's wizard: this object must be the
   * Sidekick's authoring conversation (parent kind `automation`, substream
   * `0`). Admitted as queued system input under the delegate's authority, so
   * it waits for in-flight authoring work rather than steering into it.
   */
  async admitSidekickReview(input: AdmitSidekickReviewInput): Promise<
    { accepted: true; messageId: string } | { accepted: false; code: string }
  > {
    await this.initialized;
    const request = parseRpcInput(AdmitSidekickReviewInputSchema, input, "admit_sidekick_review");
    const identity = this.objectStore.identity();
    if (!identity) return { accepted: false, code: "sidekick_review_destination_unavailable" };
    if (identity.workspaceId !== request.workspaceId || identity.parentKind !== "automation"
      || identity.parentId !== request.workstreamId || this.externalSubstreamId() !== "0") {
      return { accepted: false, code: "sidekick_review_destination_mismatch" };
    }
    const parent = await conversationParentStub(this.env, {
      workspaceId: identity.workspaceId, parentKind: identity.parentKind, parentId: identity.parentId,
    });
    const authority = await parent.authority({ workspaceId: asWorkspaceId(identity.workspaceId), parentId: identity.parentId });
    if (!authority.exists || authority.archived) return { accepted: false, code: "workstream_archived" };
    if (authority.authorityGeneration !== this.objectStore.realtimeAuthorityGeneration()) {
      return { accepted: false, code: "workstream_authority_generation_stale" };
    }
    try {
      const result = await this.product.admitSystemActivation(request);
      if (result.activationRequest) await this.requestPersistentLoopActivation(result.activationRequest);
      if (result.inserted) await this.flushSemanticRealtimeOutboxBestEffort();
      return { accepted: true, messageId: result.turn.turnId };
    } catch (error) {
      if (error instanceof Error && error.message === "workstream_archived") {
        return { accepted: false, code: "workstream_archived" };
      }
      throw error;
    }
  }

  async readerAudience(input: z.input<typeof RuntimeReaderAudienceRequestSchema>): Promise<WorkstreamReaderAudience | null> {
    await this.initialized;
    const request = RuntimeReaderAudienceRequestSchema.parse(input);
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== request.workspaceId
      || identity.parentId !== request.workstreamId
      || this.externalSubstreamId() !== "0") return null;
    return WorkstreamReaderAudienceSchema.parse(this.product.readerAudience());
  }

  async executeToolReceiptOperation(
    input: ToolReceiptOperationRequest,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptToolReceiptOperation(this.rpcRequest(input)));
  }

  async executeResidentContextOperation(
    input: ResidentContextOperationRequest,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptResidentContextOperation(this.rpcRequest(input)));
  }

  async executeMessageOperation(input: MessageOperationRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return objectPortRpcResult(await this.messageOperationOutcome(input));
  }

  async executeTranscriptOperation(input: TranscriptOperationRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return objectPortRpcResult(await this.transcriptOperationOutcome(input));
  }

  async executeResourceOperation(input: ResourceOperationRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return objectPortRpcResult(await this.resourceOperationOutcome(input));
  }

  async executeHarnessRunOperation(
    input: HarnessRunOperationRequest,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return objectPortRpcResult(await this.harnessRunOperationOutcome(input));
  }

  async executeSchedulingOperation(
    input: SchedulingOperationRequest,
  ): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptSchedulingOperation(this.rpcRequest(input)));
  }

  async executeTerminalOperation(input: TerminalOperationRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptTerminalOperation(this.rpcRequest(input)));
  }

  async bootstrapRuntime(input: SubstreamRuntimeBootstrapRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptRuntimeBootstrap(this.rpcRequest(input)));
  }

  /** Internal content-only RPC. The Worker has already admitted these candidates through search authz. */
  async readAdmittedSearchContent(input: unknown) {
    await this.storageReady;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema,
      substreamId: SubstreamIdSchema, turnIds: z.array(TranscriptTurnIdSchema),
      links: z.array(z.strictObject({ turnId: TranscriptTurnIdSchema, linkId: z.string() })),
    }).parse(input);
    const identity = this.objectStore.identity();
    if (!identity || identity.workspaceId !== request.workspaceId || identity.parentId !== request.parentId
      || this.externalSubstreamId() !== request.substreamId) throw new Error('search_content_identity_mismatch');
    if (this.identityRows.identity()?.archived_at != null) return responseToRpcResult(jsonResponse({ title: '', turns: [], links: [] }));
    return responseToRpcResult(jsonResponse({ title: this.identityRows.identity()?.title ?? '',
      turns: request.turnIds.flatMap((turnId) => {
        const turn = this.transcript.participantTurn(turnId);
        return turn?.entryKind === 'conversation' ? [turn] : [];
      }),
      links: request.links.map(({ turnId, linkId }) => ({ linkId,
        link: readConversationSearchLink(this.state.storage.sql, linkId, this.transcript.participantTurn(turnId)),
      })),
    }));
  }

  async executeIdentityOperation(input: IdentityOperationRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return objectPortRpcResult(await this.identityOperationOutcome(input));
  }

  async activateLoop(input: WorkstreamWorkflowInput): Promise<DurableObjectRpcResult> {
    await this.initialized;
    return responseToRpcResult(await this.acceptLoopActivation(this.rpcRequest(input)));
  }

  private async completeExternalMessageAdmission(
    result: Awaited<ReturnType<WorkstreamObjectProductService["admitExternalMessage"]>>,
  ): Promise<ExternalMessageAdmissionResult> {
    if (result.activationRequest) {
      await this.requestPersistentLoopActivation(result.activationRequest);
    }
    if (result.inserted) await this.flushSemanticRealtimeOutboxBestEffort();
    return ExternalMessageAdmissionResultSchema.parse({
      turn: result.turn,
      deliveryState: result.deliveryState,
    });
  }

  /** Host-authorized connector ingress for an invoked external message. */
  async admitExternalMessage(input: unknown): Promise<DurableObjectRpcResult> {
    await this.initialized;
    const parsed = AdmitExternalMessageInputSchema.safeParse(input);
    if (!parsed.success) {
      return responseToRpcResult(jsonResponse({ error: "invalid_external_message_admission" }, 400));
    }
    const identity = this.objectStore.identity();
    if (!identity || identity.workspaceId !== parsed.data.workspaceId
      || identity.parentId !== parsed.data.workstreamId
      || this.externalSubstreamId() !== (parsed.data.substreamId ?? "0")) {
      return responseToRpcResult(jsonResponse({ error: "external_message_identity_mismatch" }, 409));
    }
    try {
      const result = await this.product.admitExternalMessage(parsed.data);
      return responseToRpcResult(jsonResponse(await this.completeExternalMessageAdmission(result)));
    } catch (error) {
      return responseToRpcResult(jsonResponse({
        error: error instanceof Error ? error.message : "external_message_admission_failed",
      }, 409));
    }
  }

  /** Host-authorized Slack elicitation answer and message admission. */
  async answerExternalElicitation(input: unknown): Promise<DurableObjectRpcResult> {
    await this.initialized;
    const parsed = AnswerExternalElicitationInputSchema.safeParse(input);
    if (!parsed.success) {
      return responseToRpcResult(jsonResponse({ error: "invalid_external_elicitation_answer" }, 400));
    }
    const identity = this.objectStore.identity();
    if (!identity || identity.workspaceId !== parsed.data.workspaceId
      || identity.parentId !== parsed.data.workstreamId
      || this.externalSubstreamId() !== "0") {
      return responseToRpcResult(jsonResponse({ error: "external_message_identity_mismatch" }, 409));
    }
    try {
      const result = await this.product.answerExternalElicitation(parsed.data);
      return responseToRpcResult(jsonResponse(await this.completeExternalMessageAdmission(result)));
    } catch (error) {
      // The product's refusals carry their own status: an authorization
      // refusal — this question is targeted to somebody else — is a 403 the
      // Slack caller reports to the answerer, not a 409 it might retry.
      return responseToRpcResult(jsonResponse({
        error: error instanceof Error ? error.message : "external_elicitation_answer_failed",
      }, error instanceof ApiError ? error.status : 409));
    }
  }

  async publishEvent(input: SubstreamPublishedEvent): Promise<DurableObjectRpcResult> {
    await this.initialized;
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(RALLY_HEADERS.WORKSPACE_ID, input.workspaceId);
    headers.set(RALLY_HEADERS.WORKSTREAM_ID, input.workstreamId);
    return responseToRpcResult(await this.acceptEvent(new Request(
      "https://substream.internal/internal/events",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ event: input.event }),
      },
    )));
  }

  async refreshTimerAlarm(input: SubstreamTimerRefreshRequest): Promise<void> {
    await this.initialized;
    const parsed = AgentTimerRefreshRequestSchema.parse(input);
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== parsed.workspaceId
      || identity.parentId !== parsed.workstreamId) {
      throw new Error("substream_timer_identity_mismatch");
    }
    this.ensureSubstreamIdentity(parsed.substreamId);
    this.syncAgentTimerAlarms();
    await this.armNextAlarm();
  }

  private rpcRequest(body: unknown): Request {
    return new Request("https://substream.internal/internal-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * Run one Terminal operation against this work stream's own tables.
   *
   * Every storage method is synchronous — the object's SQLite API is — so the
   * whole operation runs inside this call with no interleaving. That is the
   * property the previous routed-SQL path could not offer: a load-then-claim
   * sequence crossed the Worker boundary between its two statements, so the
   * lease it took could be decided on state that had already moved.
   */
  /**
   * Settle one durable tool receipt inside the event that owns this object.
   *
   * No `commitRuntimeMutation` wrapper, unlike the Terminal endpoint: receipts
   * move no deadline `channels` projects, so there is no
   * `directory_common` effect to enqueue. That is asserted rather than assumed,
   * against this object's real outbox, in `test-workers/tool-receipt-authority.test.ts`
   * — with a publishing Terminal operation beside it as the control, because
   * inference is what let the Terminal port silently stop publishing once
   * already.
   */
  private async acceptToolReceiptOperation(request: Request): Promise<Response> {
    const outcome = await this.toolReceiptOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  /**
   * The context-residency ledger's endpoint, for the producers of resident
   * context blocks (the Terminal plugin today). Same fence as every other typed
   * endpoint: the addressed object, still authoritative.
   */
  private async acceptResidentContextOperation(request: Request): Promise<Response> {
    const outcome = await this.residentContextOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  private async residentContextOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = ResidentContextOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_resident_context_operation" } };
    }
    const refusal = this.objectPortRefusal(
      parsed.data,
      "workstream_resident_context_identity_mismatch",
    );
    if (refusal) return refusal;
    const method = this.residentContext[parsed.data.operation] as (...args: unknown[]) => unknown;
    const value = await method.apply(this.residentContext, parsed.data.args);
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  private async toolReceiptOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = ToolReceiptOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_tool_receipt_operation" } };
    }
    const refusal = this.objectPortRefusal(
      parsed.data,
      "workstream_tool_receipt_identity_mismatch",
    );
    if (refusal) return refusal;
    const method = this.toolReceipts[parsed.data.operation] as (...args: unknown[]) => unknown;
    try {
      const value = await method.apply(this.toolReceipts, parsed.data.args);
      if (parsed.data.operation === "complete") {
        // A completion may have committed an outbound binding beside it.
        const bindingDueAt = nextExternalBindingDueAt(this.state.storage.sql);
        if (bindingDueAt !== null) await this.ensureAlarmNoLaterThan(bindingDueAt);
      }
      return { status: 200, payload: { ok: true, value: value ?? null } };
    } catch (error) {
      if (error instanceof ToolPageError) return { status: 400, payload: { ok: false, error: error.message } };
      throw error;
    }
  }

  /**
   * Refuse an object-port request the routed path would have refused.
   *
   * The retired routed-SQL endpoint checked two things before running a
   * statement: that this object is the one addressed, and that it was still the
   * work stream's authority. The typed endpoints kept the first and dropped the
   * second, so a write against a `preparing` or `quarantined` object now
   * commits where the routed statement was refused — which is the window that
   * fence exists for. The wake-up mutations kept an equivalent check by
   * accident, through `commitWithRegionalEffects`; nothing else did.
   *
   * `"0"` because every one of these ports addresses the main child: the rows
   * they own live there, and a non-main substream would answer from an empty
   * table rather than fail.
   */
  private objectPortRefusal(
    request: { workspaceId: string; workstreamId: string; substreamId?: string | undefined },
    identityMismatchCode: string,
  ): ObjectPortOutcome | null {
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== request.workspaceId
      || identity.parentId !== request.workstreamId
      || this.externalSubstreamId() !== (request.substreamId ?? "0")) {
      return { status: 409, payload: { ok: false, error: identityMismatchCode } };
    }
    if (!this.objectStore.isAuthoritative()) {
      return { status: 409, payload: { ok: false, error: AUTHORITY_FENCED_CODE } };
    }
    return null;
  }

  /**
   * Dispatch one scheduling operation against this object's own storage.
   *
   * `objectPortRefusal` runs first, so this endpoint refuses three things the
   * routed path refused: another work stream's identity, a non-main substream,
   * and an object whose `authority_mode` is not `authoritative`. The last one
   * matters most here. `persistCompactionCheckpoint`, `recordPluginActivation`
   * and the two description-evaluation writes are the first writes moved off
   * the routed path whose *only* fence was the generic SQL endpoint
   * refusing every statement against a `preparing` or `quarantined` object —
   * the wake-up mutations keep an equivalent one through
   * `commitRuntimeMutation`, and these four would have had none.
   *
   * The non-main refusal is why the port names the main child and nothing
   * carries a substream id: these rows live on the main object, so a child
   * substream must be told so rather than served from an empty table.
   *
   * An operation that can change which wake-ups are pending runs through
   * `commitRuntimeMutation`, re-derives the timer index, and arms the next
   * alarm before answering — so a caller never has to remember to do any of it.
   * A memory sweep write (`armsDerivedAlarm`) arms the next alarm as well,
   * because `retry_at` is a due time the alarm is derived from.
   *
   * All three used to be consequences of the routing. A wake-up write arrived
   * as SQL, and the object matched `workstream_wakeups` in the statement text
   * to decide both that the sidebar's next-wake-up marker had to be
   * republished and that the alarm index had to be re-derived. Naming the
   * operations replaces the regex; running the mutation inside
   * `commitRuntimeMutation` is what keeps the directory effect in the same
   * commit as the write, rather than a second write that could be lost after
   * the first one landed.
   */
  private async acceptSchedulingOperation(request: Request): Promise<Response> {
    const outcome = await this.schedulingOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  private async schedulingOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = SchedulingOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_scheduling_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_scheduling_identity_mismatch");
    if (refusal) return refusal;
    const method = this.scheduling[parsed.data.operation] as (...args: unknown[]) => unknown;
    const mutates = mutatesWakeups(parsed.data.operation);
    const elicitationInput = parsed.data.operation === "openElicitation"
      ? OpenElicitationInputSchema.safeParse(parsed.data.args[0])
      : parsed.data.operation === "answerElicitationExternally"
        ? AnswerElicitationExternallyInputSchema.safeParse(parsed.data.args[0])
        : null;
    if (elicitationInput && !elicitationInput.success) {
      return { status: 400, payload: { ok: false, error: "invalid_scheduling_operation" } };
    }
    const parsedElicitationInput = elicitationInput?.data ?? null;
    const preparedElicitationMessage = parsedElicitationInput
      ? "runId" in parsedElicitationInput
        ? await this.scheduling.prepareOpenElicitationMessage(parsedElicitationInput)
        : await this.scheduling.prepareExternalElicitationAnswerMessage(parsedElicitationInput)
      : null;
    const value = mutates || preparedElicitationMessage
      ? await this.product.commitRuntimeMutation(
        () => {
          if (preparedElicitationMessage && parsedElicitationInput) {
            return "runId" in parsedElicitationInput
              ? this.scheduling.openPreparedElicitation(
                parsedElicitationInput,
                preparedElicitationMessage,
              )
              : this.scheduling.answerPreparedElicitationExternally(
                parsedElicitationInput,
                preparedElicitationMessage,
              );
          }
          return method.apply(this.scheduling, parsed.data.args);
        },
        true,
      )
      : await method.apply(this.scheduling, parsed.data.args);
    if (parsedElicitationInput && isPersistedElicitationOutcome(value)) {
      await this.flushSemanticRealtimeOutboxBestEffort();
    }
    // A sweep write moves only the column the alarm is derived from, so it
    // re-arms without the wake-up index reconcile.
    if (mutates || armsDerivedAlarm(parsed.data.operation)) {
      if (mutates) this.syncAgentTimerAlarms();
      // Arming is best-effort, as it is for every typed mutation endpoint and
      // `runTerminalOperation`, and for the reason those two give: the
      // operation is already durable, so raising here would tell a caller its
      // committed write failed. The wake-up tool's own rollback would then
      // delete a row that was legitimately cancelled. The run's dispatch sweep,
      // any later request and the committed directory effect all re-derive the
      // alarm.
      try {
        await this.armNextAlarm();
      } catch (error) {
        logError(this.env, "workstream_scheduling_alarm_schedule_failed", {
          workspace_id: parsed.data.workspaceId,
          workstream_id: parsed.data.workstreamId,
          operation: parsed.data.operation,
          code: "workstream_scheduling_alarm_failed_after_commit",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  /**
   * Dispatch one transcript operation against this object's own storage.
   *
   * Every write here appends to the transcript a member reads, so it runs
   * inside `commitRuntimeMutation`: the row and the directory projection that
   * shows its preview are one commit. The routed path reached the same place by
   * matching `messages` in statement text, which is the rule this replaces.
   */
  private async acceptMessageOperation(request: Request): Promise<Response> {
    const outcome = await this.messageOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  /**
   * The endpoint's body, with no `Request` or `Response` in the middle.
   *
   * Every port call made from inside this object resolves to itself through the
   * self-registration, and the RPC entry point marshalled its already-parsed
   * input into a `Request` so it could share the `fetch` handler, then read a
   * `Response` body back out. For a local call that is six serializations of
   * one value to move it nowhere — and the drain runs the description refresh
   * through this path at the end of every harness run, where it cost enough to
   * leave a dispatch queued past the end of the run.
   *
   * The module that hands out the self-registration says the point of it is
   * "the same object with the boundary removed". This is the rest of that.
   */
  private async messageOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = MessageOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_message_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_message_identity_mismatch");
    if (refusal) return refusal;
    const method = this.messages[parsed.data.operation] as (...args: unknown[]) => unknown;
    const mutates = mutatesTranscript(parsed.data.operation);
    const appendInput = parsed.data.operation === "appendMessage"
      ? AppendMessageInputSchema.safeParse(parsed.data.args[0])
      : null;
    if (appendInput && !appendInput.success) {
      return { status: 400, payload: { ok: false, error: "invalid_message_operation" } };
    }
    const parsedAppendInput = appendInput?.data ?? null;
    const preparedMessage = parsedAppendInput
      ? await this.messages.prepareMessage(parsedAppendInput)
      : null;
    const value = mutates
      ? await this.product.commitRuntimeMutation(
        () => {
          if (preparedMessage && parsedAppendInput) {
            return this.messages.appendPreparedMessage(preparedMessage);
          }
          return method.apply(this.messages, parsed.data.args);
        },
        true,
      )
      : method.apply(this.messages, parsed.data.args);
    if (preparedMessage && isAppendedMessageOutcome(value)) {
      await this.flushSemanticRealtimeOutboxBestEffort();
    }
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  private async transcriptOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = TranscriptOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_transcript_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_transcript_identity_mismatch");
    if (refusal) return refusal;
    if (parsed.data.operation === "seedDevelopmentConversationTurn"
      && this.env.APP_ENV !== "development") {
      return { status: 404, payload: { ok: false, error: "development_operation_unavailable" } };
    }
    const method = this.transcript[parsed.data.operation] as (...args: unknown[]) => unknown;
    const value = await method.apply(this.transcript, parsed.data.args);
    await this.flushSemanticRealtimeOutboxBestEffort();
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  private async acceptHarnessRunOperation(request: Request): Promise<Response> {
    const outcome = await this.harnessRunOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  /**
   * Dispatch one harness-run operation against this object's own rows.
   *
   * A claim runs inside `commitRuntimeMutation` because the sidebar renders a
   * work stream's harness status, and the routed claim batch wrote that as a
   * third statement guarded on the first having landed. Committing the
   * projection with the claim is what replaces the guard.
   */
  private async harnessRunOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = HarnessRunOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_harness_run_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_harness_run_identity_mismatch");
    if (refusal) return refusal;
    const method = this.harnessRuns[parsed.data.operation] as (...args: unknown[]) => unknown;
    const hostOutcomeInput = parsed.data.operation === "publishHostOutcome"
      ? parsed.data.args[0] as PublishHostOutcomeInput
      : null;
    const preparedHostOutcome = hostOutcomeInput
      ? await this.harnessRuns.prepareHostOutcome(hostOutcomeInput)
      : null;
    const value = mutatesRunState(parsed.data.operation)
      ? await this.product.commitRuntimeMutation(
        () => preparedHostOutcome && hostOutcomeInput
          ? this.harnessRuns.publishPreparedHostOutcome(hostOutcomeInput, preparedHostOutcome)
          : method.apply(this.harnessRuns, parsed.data.args),
        true,
      )
      : method.apply(this.harnessRuns, parsed.data.args);
    if (hostOutcomeInput && value && typeof value === "object"
      && "outcome" in value
      && (value.outcome === "published" || value.outcome === "replayed")) {
      await this.flushSemanticRealtimeOutboxBestEffort();
    }
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  private async acceptResourceOperation(request: Request): Promise<Response> {
    const outcome = await this.resourceOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  /**
   * Dispatch one resource-attachment operation against this object's own rows.
   *
   * The watch toggle runs inside `commitRuntimeMutation` for the reason the
   * transcript's appends do: the sidebar renders what a work stream is watching,
   * and a write whose directory projection is a second commit can lose it.
   *
   * The inventory revision is *not* advanced here, and that is deliberate:
   * `watch_enabled` does not change which resources a run is authorized to see,
   * which is what `inventory:<revision>` fences. The retired
   * `_runtime_workstream_resources` update trigger bumped it on every column it
   * could write, including this one — so this stops invalidating compaction
   * checkpoints that were never affected. The paths that do change the
   * authorized set are the product service's, and they still bump it.
   */
  private async resourceOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = ResourceOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_resource_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_resource_identity_mismatch");
    if (refusal) return refusal;
    const method = this.resources[parsed.data.operation] as (...args: unknown[]) => unknown;
    const value = mutatesInventory(parsed.data.operation)
      ? await this.product.commitRuntimeMutation(
        () => method.apply(this.resources, parsed.data.args),
        true,
      )
      : method.apply(this.resources, parsed.data.args);
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  private async acceptTerminalOperation(request: Request): Promise<Response> {
    const parsed = TerminalOperationRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse({
        ok: false,
        error: "invalid_terminal_operation",
        failure: {
          code: "invalid_terminal_operation",
          message: "Avalon's Terminal authority rejected an internal request because its protocol was invalid. Retry after the application and service versions are aligned.",
          outcome: "rejected",
          retryable: false,
        },
      }, 400);
    }
    try {
      const value = await this.runTerminalOperation(parsed.data);
      return jsonResponse({ ok: true, value: value ?? null });
    } catch (error) {
      if (!(error instanceof TerminalObjectPortError)) throw error;
      return jsonResponse({
        ok: false,
        error: error.code,
        failure: {
          code: error.code,
          message: error.message,
          outcome: error.details.outcome,
          retryable: error.details.retryable,
        },
      }, 409);
    }
  }

  /**
   * Execute Terminal authority inside the event that already owns this object.
   *
   * Worker callers still arrive through RPC. The resident agent loop must not
   * RPC back into itself: those nested events hand later D1/provider work back
   * to the alarm's outer request context, which production rejects after the
   * first command. Both paths share this transaction and alarm boundary.
   */
  private async runTerminalOperation(input: TerminalOperationRequest): Promise<unknown> {
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== input.workspaceId
      || identity.parentId !== input.workstreamId
      || this.externalSubstreamId() !== (input.substreamId ?? "0")) {
      throw new TerminalObjectPortError(input.operation, {
        code: "workstream_terminal_identity_mismatch",
        message: "Avalon's Terminal authority rejected an internal request because it was routed to the wrong work stream. Retrying the same operation will not repair the route.",
        outcome: "rejected",
        retryable: false,
      });
    }
    const operation = input.operation;
    const method = this.terminal[operation] as (...args: unknown[]) => unknown;
    const operationInput = input.args[0];
    const operationRunId = (): string | null => {
      if (operationInput !== undefined && operationInput !== null) {
        return typeof operationInput === "object"
          && "runId" in operationInput
          && typeof operationInput.runId === "string"
          ? operationInput.runId
          : null;
      }
      try {
        return this.terminal.sandbox()?.operationRunId ?? null;
      } catch {
        // Correlation must never replace the typed operation failure that the
        // log is explaining. A broken sandbox read stays secondary evidence.
        return null;
      }
    };
    let value: unknown;
    try {
      // Through `commitRuntimeMutation`, not directly, for the same reason
      // Typed mutation endpoints do: a write that moves a Terminal deadline has to
      // enqueue the `directory_common` effect, because
      // `channels.next_terminal_action_at` is the only
      // thing the workspace's alarm reads to decide a sandbox is due, and that
      // effect is its only writer. Calling the storage method on its own
      // committed the row and told nobody.
      value = await this.product.commitRuntimeMutation(
        () => method.apply(this.terminal, input.args),
        terminalOperationAffectsDirectory(operation),
      );
    } catch (error) {
      // `commitRuntimeMutation` is one synchronous SQLite transaction. If it
      // throws, no Terminal row or regional effect committed, so retrying the
      // exact operation is safe. Keep the raw reason only in operator logs;
      // the RPC carries a stable category and participant-safe instruction.
      logError(this.env, "terminal_operation_commit_failed", {
        workspace_id: input.workspaceId,
        workstream_id: input.workstreamId,
        harness_run_id: operationRunId(),
        operation,
        code: "terminal_operation_not_committed",
        reason: error instanceof Error ? error.message : String(error),
        stack: harnessErrorFrames(error),
      });
      throw new TerminalObjectPortError(operation, {
        code: "terminal_operation_not_committed",
        message: "Avalon could not commit an internal Terminal state change. Resume the run so the durable tool receipt can reconcile it; do not manually repeat a write.",
        outcome: "not_committed",
        retryable: true,
      });
    }
    // Alarm scheduling happens after the transaction. A failure here cannot be
    // returned as an operation failure: the mutation already committed, and a
    // retry could duplicate it. Directory-affecting operations committed their
    // regional effect with the row; otherwise the active dispatch sweep or a
    // later request re-derives the local alarm.
    try {
      // The deadline this operation just wrote is also this object's own next
      // alarm, so re-derive it here rather than waiting for the next request.
      await this.armNextAlarm();
    } catch (error) {
      logError(this.env, "terminal_operation_alarm_schedule_failed", {
        workspace_id: input.workspaceId,
        workstream_id: input.workstreamId,
        harness_run_id: operationRunId(),
        operation,
        code: "terminal_alarm_schedule_failed_after_commit",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return value ?? null;
  }

  /**
   * Resource-link writer for a harness already executing in this object.
   *
   * Handed to every substream's loop, not only the main conversation's: a run
   * under an automation is a child substream, and without its own attacher
   * the plugins fell back to the id-resolved port, which addresses the
   * parent's substream `"0"` by default and so filed a run's generated or
   * imported resources in the drafting conversation, where the run could not
   * see them.
   */
  private localRuntimeResourceAttacher(
    workspaceId: string,
    workstreamId: string,
  ): WorkstreamRuntimeResourceAttacher {
    return (input) => {
      if (input.workspaceId !== workspaceId || input.workstreamId !== workstreamId) {
        throw new Error("workstream_runtime_identity_mismatch");
      }
      return this.runRuntimeResourceAttachment(input);
    };
  }

  private async acceptRuntimeResource(request: Request): Promise<Response> {
    const parsed = RuntimeResourceRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_runtime_resource" }, 400);
    try {
      await this.runRuntimeResourceAttachment(parsed.data);
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "runtime_resource_attach_failed",
      }, 409);
    }
  }

  /** Attach a generated resource without re-entering the resident object. */
  private async runRuntimeResourceAttachment(input: SubstreamRuntimeResourceRequest): Promise<void> {
    const identity = this.objectStore.identity();
    // The attachment carries a scope, not a location: this object refuses one
    // addressed to another work stream or, when it names a conversation, to
    // another conversation of this one.
    if (!identity
      || identity.workspaceId !== input.workspaceId
      || identity.parentId !== input.workstreamId
      || (input.substreamId !== undefined && input.substreamId !== this.externalSubstreamId())) {
      throw new Error("workstream_runtime_identity_mismatch");
    }
    const attachment = await this.product.attachRuntimeResource(
      input.workspaceId,
      input.resourceId,
      input.attachedByUserId,
      input.relationshipType,
    );
    this.invalidatePreparedSocketSnapshots();
    // Attached and reachable, deliberately not advertised. The link committed,
    // so there is nothing to repair and no resync to ask for; the rail a client
    // rebuilds from the canonical detail already omits it.
    if (attachment.outcome === "unlisted") return;
    if (attachment.outcome === "readback_failed") {
      await this.requestCanonicalRoomResyncBestEffort("resource_readback_failed_after_commit");
      return;
    }
    const resource = attachment.resource;
    try {
      const publication = await this.publishLocalProductEvent(
        identity,
        { type: input.eventType ?? "resource_attached", resource },
      );
      if (publication === "deferred") {
        await this.requestCanonicalRoomResyncBestEffort("resource_event_deferred_after_commit");
      }
    } catch (error) {
      logWarn(this.env, "workstream_resource_event_failed_after_commit", {
        workspace_id: input.workspaceId,
        workstream_id: input.workstreamId,
        resource_id: input.resourceId,
        reason: diagnosticErrorCode(error, "resource_event_publish_failed"),
      });
      await this.requestCanonicalRoomResyncBestEffort("resource_event_failed_after_commit");
    }
  }

  private async acceptRuntimeBootstrap(request: Request): Promise<Response> {
    const parsed = RuntimeBootstrapRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_runtime_bootstrap" }, 400);
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (authority.phase !== "durable_object_open" || authority.generation !== parsed.data.generation) {
      return jsonResponse({ error: "workstream_runtime_bootstrap_fenced" }, 409);
    }
    try {
      this.product.bootstrapRuntimeAuthority(parsed.data);
      // What this object durably is, written with its root: every endpoint
      // compares the substream a request names against it, so a child
      // conversation must know its own id before its first port call.
      this.ensureSubstreamIdentity(parsed.data.substreamId ?? "0");
      // Backfill may already have settled this placeholder as missing. Wake
      // its retained ledger now, without waiting for a later product write.
      const viewDueAt = nextConversationViewAt(this.state.storage.sql);
      if (viewDueAt !== null) await this.ensureAlarmNoLaterThan(viewDueAt);
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "workstream_runtime_bootstrap_failed",
      }, 409);
    }
  }

  /**
   * Write what a system-provisioned work stream is, once its object is open.
   *
   * The identity check is `objectPortRefusal`'s, for its reasons: a misrouted
   * stub must not name another work stream, and a non-authoritative object is
   * not the one whose writes count. The provision itself is idempotent, so a
   * producer retrying the bootstrap-then-provision pair is safe.
   */
  private async acceptIdentityOperation(request: Request): Promise<Response> {
    const outcome = await this.identityOperationOutcome(await request.json().catch(() => null));
    return jsonResponse(outcome.payload, outcome.status);
  }

  /**
   * Dispatch one identity operation against this object's own root row.
   *
   * The provision runs inside `commitRuntimeMutation` with the directory flag
   * because it is what makes a system-created work stream appear in a sidebar:
   * a row whose listing projection is a second commit can be created and never
   * shown. The reads do not, for the reason every other authority's reads do
   * not — there is nothing to publish.
   *
   * This replaces a bespoke `provisionRuntime` RPC that validated its own body
   * and re-checked identity inside the product service. Both checks are what
   * `objectPortRefusal` and this dispatcher already do for the five authorities
   * beside it, and having them twice meant a provision could be refused by two
   * different mismatch codes depending on which layer noticed.
   */
  private async identityOperationOutcome(body: unknown): Promise<ObjectPortOutcome> {
    const parsed = IdentityOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, payload: { ok: false, error: "invalid_identity_operation" } };
    }
    const refusal = this.objectPortRefusal(parsed.data, "workstream_identity_mismatch");
    if (refusal) return refusal;
    const method = this.identityRows[parsed.data.operation] as (...args: unknown[]) => unknown;
    const value = mutatesIdentity(parsed.data.operation)
      ? await this.product.commitRuntimeMutation(
        () => method.apply(this.identityRows, parsed.data.args),
        true,
      )
      : method.apply(this.identityRows, parsed.data.args);
    return { status: 200, payload: { ok: true, value: value ?? null } };
  }

  private async acceptLoopActivation(request: Request): Promise<Response> {
    const parsed = RuntimeDispatchRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_substream_run_dispatch" }, 400);
    const identity = this.objectStore.identity();
    if (!identity
      || identity.workspaceId !== parsed.data.workspaceId
      || identity.parentId !== parsed.data.parentId) {
      return jsonResponse({ error: "substream_run_identity_mismatch" }, 409);
    }
    const substreamId = parsed.data.substreamId ?? asSubstreamId("0");
    try {
      this.ensureSubstreamIdentity(substreamId);
      const loop = this.ensurePersistentLoop();
      const input = WorkstreamWorkflowInputSchema.parse({
        ...parsed.data,
        substreamId,
      });
      if (input.loopId !== loop.loop_id) throw new Error("substream_loop_identity_mismatch");
      const encoded = JSON.stringify(input);
      const now = Date.now();
      const executionReceiptId = `substream-agent:${substreamId}:${input.harnessRunId}`;
      const launched = await this.product.commitRuntimeMutation(
        () => this.harnessRuns.launchRun({
          runId: input.harnessRunId,
          workflowInstanceId: executionReceiptId,
          executionContextJson: encoded,
          executionAvailableAt: now,
          startedAt: now,
          now,
        }),
        true,
      );
      if (launched.outcome !== "launched") {
        throw new Error("substream_loop_execution_receipt_not_found");
      }
      await this.state.storage.setAlarm(now + 1);
      return jsonResponse({ accepted: true }, 202);
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "substream_run_dispatch_failed",
      }, 409);
    }
  }

  private async acceptProductRequest(request: Request, traced = false): Promise<Response> {
    const parsed = ProductRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_product_request" }, 400);
    const flow = traced ? productRequestFlow(parsed.data.operation) : null;
    if (flow === null) return this.runProductRequest(parsed.data, noFlowSpan);
    const workstreamId = this.objectStore.identity()?.parentId;
    return inFlowSpan(this.env, `workstream.room.${parsed.data.operation}`, {
      flow,
      component: "substream_do",
      identity: {
        workspaceId: parsed.data.auth.workspaceId,
        userId: parsed.data.auth.userId,
        sessionId: parsed.data.auth.sessionId,
        substreamId: this.externalSubstreamId(),
        ...(workstreamId === undefined ? {} : { workstreamId }),
      },
      attributes: { "rally.room.operation": parsed.data.operation },
    }, (span) => this.runProductRequest(parsed.data, span));
  }

  private async runProductRequest(
    request: SubstreamProductRequest,
    span: FlowSpan,
  ): Promise<Response> {
    // The parent kind first, before the session read and before any other
    // object is addressed. A conversation is reached by *id*, so this is the
    // only place that can tell a Channel's main conversation from a Space's
    // hidden one — and a Space's has no product surface to offer: no feed, no
    // transcript, no archive, no scope. Every member holds every Space id off
    // the workspace socket, so without this `PATCH /workstreams/<spaceId>`
    // archives General or makes it personal behind the Space authority's back.
    //
    // Ahead of authentication deliberately. This is a statement about the
    // address rather than about the caller — the answer is the same for
    // everybody — and running it first keeps a misaddressed request from
    // costing a D1 round trip. `not found` rather than a refusal that confirms
    // the id: the caller asked a question about a Channel, and there is no
    // Channel here.
    const identity = this.objectStore.identity();
    if (identity && identity.parentKind !== request.parentKind) {
      span.setError("conversation_parent_kind_mismatch");
      return jsonResponse({
        error: "conversation_parent_kind_mismatch",
        message: "Thread not found",
      }, 404);
    }
    // Two principals, two verifications. A login session is checked against
    // its `sessions` row and then reused for at most five minutes in this
    // object, bounded by session expiry and cleared by delivered revocation.
    // A connector principal has no `sessions` row to check
    // — its standing authority is the connector link, which the Worker verified
    // on the very message being delivered — so the object re-checks the D1 fact
    // that *is* its to check: current active membership in this workspace, in
    // this region. Before this branch existed, connector ingress synthesized a
    // session id that no `sessions` row could ever match, and every linked
    // member's Slack message died here as `session_revoked` (2026-08-22).
    // Any non-session principal — `connector`, `demo_seed`, `impersonation`, or
    // `resource_authorization` after a consumed provider callback — is verified by
    // membership rather than by a session row. The enum on `principal` is the
    // gate: a value added to it inherits this branch.
    const nonSessionPrincipal = request.auth.principal !== undefined;
    const current = nonSessionPrincipal
      ? await span.step("workstream.room.connector_auth", () => this.connectorPrincipalAuth(request.auth))
      : await span.step("workstream.room.session_auth", () => this.productSessionAuth({
        workspaceId: request.auth.workspaceId,
        userId: request.auth.userId,
        sessionId: request.auth.sessionId,
      }, request.auth.role));
    if (!current || current.role !== request.auth.role || current.region !== request.auth.region) {
      const refusal = request.auth.principal === "impersonation"
        ? "impersonation_member_revoked"
        : nonSessionPrincipal ? "connector_member_revoked" : "session_revoked";
      span.setError(refusal);
      // The message rides to `WorkstreamObjectClient.decode`, whose fallback
      // ("The thread could not be loaded") misdescribes a refused send.
      return jsonResponse({
        error: refusal,
        message: nonSessionPrincipal
          ? "You are no longer an active member of this workspace"
          : "Sign in again to continue",
      }, 401);
    }
    // Set once the object's own authorization query — session or connector
    // membership — has answered, rather than taken
    // from the caller: a correlation value that arrives from outside is one the
    // object would have to decide whether to trust, for something it resolves
    // anyway. Only the workspace surrogate — see `socketAuth` for why the
    // person surrogate stays on the Worker's side of the boundary.
    span.setAttributes(identityAttributes({
      analyticsWorkspaceId: current.analyticsWorkspaceId,
    }));
    // Who sends a message or an answer: the verified identity, still marked
    // with the non-session path it arrived by. A Slack, support, demo-seed or
    // authorization-callback write is not the member sending it, and the
    // object needs to tell (`message_sent`, the reserved resource-authorization
    // message ids).
    const sender: AuthContext = request.auth.principal
      ? { ...current, principal: request.auth.principal } : current;
    // Several product reads settle per-reader state, and several mutations do
    // not allocate a realtime sequence. Clearing the one prepared snapshot at
    // this common admitted boundary prevents either kind from being hidden by
    // an unchanged transcript cursor. A raced assembly also observes the
    // incremented revision before it can install its result.
    this.invalidatePreparedSocketSnapshots();
    try {
      if (request.operation === "search_links") {
        const root = await this.product.authorize(current);
        const links = request.links.map(({ turnId, linkId }) => ({ linkId,
          link: readConversationSearchLink(this.state.storage.sql, linkId, this.transcript.participantTurn(turnId)),
        }));
        return jsonResponse({ title: root.title, links });
      }
      if (request.operation === "search_link") {
        const root = await this.product.authorize(current);
        const link = readConversationSearchLink(this.state.storage.sql, request.linkId, this.transcript.participantTurn(request.turnId));
        return jsonResponse({ title: root.title, link });
      }
      if (request.operation === "search_turns") {
        // Search must authorize the current reader without marking the feed read.
        const root = await this.product.authorize(current);
        const turns = request.turnIds.flatMap((turnId) => {
          const turn = this.transcript.participantTurn(turnId);
          return turn?.entryKind === "conversation" ? [turn] : [];
        });
        return jsonResponse({ title: root.title, turns });
      }
      if (request.operation === "inspect_sidekick_run_transcript") {
        if (request.parentKind !== "automation" || (identity && (identity.parentId !== request.automationId
          || identity.workspaceId !== current.workspaceId || this.externalSubstreamId() !== request.runId))) {
          return jsonResponse({ error: "sidekick_run_not_found", message: "This run does not exist" }, 404);
        }
        const workspace = await durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS,
          current.workspaceId, workspaceDOName(this.env.AVALON_REGION, current.workspaceId));
        await workspace.sidekickReadRunForReview({ workspaceId: current.workspaceId, automationId: request.automationId,
          runId: request.runId, actor: { userId: current.userId, actorRole: current.role, participantOfOwningWorkstream: false } });
        if (!identity) return jsonResponse(SidekickRunTranscriptResultSchema.parse({ transcriptAvailability: "not_provisioned",
          turns: [], throughSequence: 0, nextAfterSequence: null }));
        const through = Math.min(request.input.throughSequence ?? this.transcript.transcriptThrough(), this.transcript.transcriptThrough());
        const start = Math.min(request.input.afterSequence, through) + 1;
        const end = Math.min(through + 1, start + (request.input.limit ?? DEFAULT_TRANSCRIPT_READ_TURNS));
        const range = this.transcript.range({ snapshotId: "run-review", snapshotThrough: through, snapshotAtUtc: new Date().toISOString() },
          { startInclusive: start, endExclusive: end }, "requested", false);
        return jsonResponse(SidekickRunTranscriptResultSchema.parse({ transcriptAvailability: "available", turns: range.turns,
          throughSequence: through, nextAfterSequence: end <= through ? end - 1 : null }));
      }
      if (request.operation === "read_transcript") {
        const root = await this.product.authorize(current);
        const currentThrough = this.transcript.transcriptThrough();
        const through = Math.min(request.input.throughSequence ?? currentThrough, currentThrough);
        const start = Math.min(request.input.afterSequence, through) + 1;
        const end = Math.min(through + 1, start + (request.input.limit ?? DEFAULT_TRANSCRIPT_READ_TURNS));
        const snapshot = { snapshotId: "product-range", snapshotThrough: through, snapshotAtUtc: new Date().toISOString() };
        const range = this.transcript.range(snapshot, { startInclusive: start, endExclusive: end }, "requested", false);
        return jsonResponse(ReadTranscriptResultSchema.parse({ title: root.title, text: conversationAsText(range.turns),
          throughSequence: through, nextAfterSequence: end <= through ? end - 1 : null }));
      }
      if (request.operation === "read_resource_authorization_recovery") {
        await this.product.authorize(current);
        const turn = this.transcript.participantTurnForTool(request.toolCallId);
        const block = turn?.blocks.find((candidate) => candidate.type === "tool"
          && candidate.toolCallId === request.toolCallId && candidate.status === "failed");
        const result = block?.type === "tool" ? block.participantSafeResult : null;
        const recovery = ConnectorResourceAuthorizationRequestSchema.safeParse(
          result && typeof result === "object" && !Array.isArray(result)
            ? (result as Record<string, unknown>).recovery : null,
        );
        return jsonResponse({ recovery: recovery.success ? recovery.data : null });
      }
      if (request.operation === "get") {
        return jsonResponse(await span.step("workstream.room.product.get", () => this.product.get(current)));
      }
      if (request.operation === "boot") {
        const boot = await span.step("workstream.room.product.boot", () => this.product.boot(current));
        return jsonResponse({
          ...boot,
          transcript: this.transcript.createOpeningSnapshot({
            unreadHighWaterAttentionOrdinal: boot.workstream.firstUnreadSequenceNumber,
          }),
        });
      }
      if (!identity) return jsonResponse({ error: "workstream_not_found" }, 404);
      if (request.operation === "update") {
        const result = await this.product.update(current, request.input);
        for (const event of result.events) await this.publishLocalProductEvent(identity, event);
        // Archiving a room is a decision about the room; the automations it
        // owns follow it from WorkspaceDO when the directory row's archive
        // state lands there, so nothing here reaches into another object.
        if (request.input?.archived === false) await this.armNextAlarm();
        return jsonResponse(result.workstream);
      }
      if (request.operation === "acknowledge_read") {
        return jsonResponse(await this.product.acknowledgeRead(current, request.input));
      }
      if (request.operation === "mark_unread") {
        return jsonResponse(await this.product.markUnread(current));
      }
      if (request.operation === "create_message") {
        const { replayed, ...receipt } = await this.admitMessage(sender, request.input, span);
        // Only a merge is told whether it replayed: the receipt is a strict
        // client shape, and the merge service is the one caller that asks.
        return jsonResponse(request.input.merge ? { ...receipt, replayed } : receipt);
      }
      if (request.operation === "add_participant") {
        const participant = await this.product.addParticipant(current, request.userId);
        await this.publishLocalProductEvent(identity, { type: "participant_added", participant });
        return jsonResponse(participant);
      }
      if (request.operation === "remove_participant") {
        const outcome = await this.product.removeParticipant(current, request.userId);
        if (outcome !== "not_found") {
          // The participant fact is already committed. Close every socket it
          // just revoked before any fallible event preparation or publication;
          // a failed response can then be retried without extending access.
          this.evictReadersWhoLostLocalAccess();
          await this.publishLocalProductEvent(identity, {
            type: "participant_removed",
            userId: request.userId,
          });
        }
        return jsonResponse({ ok: true });
      }
      if (request.operation === "attach_resources") {
        const result = await this.product.attachResources(current, request.resourceIds);
        if (result.ok) {
          for (const resource of result.attached) {
            await this.publishLocalProductEvent(identity, { type: "resource_attached", resource });
          }
        }
        return jsonResponse(result.ok ? { ok: true, linked: result.linked, resources: result.resources } : result);
      }
      if (request.operation === "attach_resource") {
        const resource = await this.product.attachResource(current, request.resourceId);
        await this.publishLocalProductEvent(identity, { type: "resource_attached", resource });
        return jsonResponse(resource);
      }
      if (request.operation === "detach_resource") {
        await this.product.detachResource(current, request.resourceId);
        return jsonResponse({ ok: true });
      }
      if (request.operation === "rename_resource") {
        const resource = await this.product.renameResource(current, request.resourceId, request.title);
        if (resource) await this.publishLocalProductEvent(identity, { type: "resource_updated", resource });
        return jsonResponse({ ok: true });
      }
      if (request.operation === "answer_elicitation") {
        const result = await this.product.answerElicitation(
          sender,
          request.elicitationId,
          request.input,
          request.slackOrigin,
        );
        if (result.activationRequest) {
          try {
            await this.requestPersistentLoopActivation(result.activationRequest);
          } catch (error) {
            logWarn(this.env, "substream_elicitation_activation_wakeup_failed", {
              workspace_id: current.workspaceId,
              workstream_id: identity.parentId,
              substream_id: this.externalSubstreamId(),
              elicitation_id: request.elicitationId,
              reason: diagnosticErrorCode(error, "activation_wakeup_failed"),
            });
          }
        }
        if (result.inserted && result.elicitation) {
          try {
            await this.publishLocalProductEvent(identity, {
              type: "elicitation_answered",
              elicitation: result.elicitation,
            });
          } catch (error) {
            logWarn(this.env, "substream_elicitation_publication_failed_after_commit", {
              workspace_id: current.workspaceId,
              workstream_id: identity.parentId,
              substream_id: this.externalSubstreamId(),
              elicitation_id: request.elicitationId,
              reason: diagnosticErrorCode(error, "elicitation_publication_failed"),
            });
          }
        }
        await this.flushSemanticRealtimeOutboxBestEffort();
        return jsonResponse({ elicitation: result.elicitation });
      }
      throw new Error("substream_product_operation_unhandled");
    } catch (error) {
      const diagnostic = zodDiagnosticCode(error, "workstream_product");
      const safe = error instanceof ApiError
        ? error
        : new ApiError(500, diagnostic ?? "workstream_object_request_failed", "The thread could not be loaded");
      if (!(error instanceof ApiError)) {
        // Report schema shape, never rejected values or adapter prose. The
        // same field code survives the RPC hop into demo preparation's status.
        logError(this.env, "workstream_product_request_failed", {
          workspace_id: this.objectStore.identity()?.workspaceId,
          workstream_id: this.objectStore.identity()?.parentId,
          substream_id: this.externalSubstreamId(),
          reason: diagnosticErrorCode(error, "workstream_product_request_failed"),
        });
      }
      span.setError(safe.code, safe.message);
      span.setAttributes({ "http.response.status_code": safe.status });
      return jsonResponse({ error: safe.code, message: safe.message, details: safe.details }, safe.status);
    }
  }

  private async requestExecutionReceiptActivation(
    runId: string | null,
    workflowInput: WorkstreamWorkflowInput | null,
  ): Promise<void> {
    if (!runId || !workflowInput) return;
    const input = WorkstreamWorkflowInputSchema.parse({
      ...workflowInput,
      substreamId: this.externalSubstreamId(),
    });
    if (input.harnessRunId !== runId) throw new Error("substream_loop_execution_receipt_mismatch");
    const loop = this.ensurePersistentLoop();
    if (input.loopId !== loop.loop_id) throw new Error("substream_loop_identity_mismatch");
    this.state.storage.sql.exec(
      `UPDATE runs SET execution_context_json = ?, execution_available_at = COALESCE(execution_available_at, ?),
              updated_at = ? WHERE run_id = ? AND terminalized_at IS NULL`,
      JSON.stringify(input), Date.now(), Date.now(), runId,
    );
  }

  private async requestPersistentLoopActivation(
    request: WorkstreamLoopActivationRequest,
  ): Promise<void> {
    const loop = this.ensurePersistentLoop();
    if (request.loopId !== loop.loop_id) throw new Error("substream_loop_identity_mismatch");
    if (request.inputId !== null) {
      const pending = this.loop.input(request.inputId);
      if (!pending || pending.loop_id !== loop.loop_id) {
        throw new Error("substream_loop_activation_input_unavailable");
      }
    } else {
      await this.requestExecutionReceiptActivation(
        request.receiptRunId,
        request.workflowInput,
      );
    }
    // Pending inputs and the singleton loop are the durable work. Start their
    // drain in this invocation, with an alarm at the keep-alive horizon as the
    // eviction recovery hint. A due-now alarm can race and falsely reclaim the
    // healthy drain before it has acquired its durable execution lease.
    await this.armAlarmDuringRunDrain();
    this.resumePersistentLoopDrain();
  }

  /** Run the one persistent loop in the current invocation. Durable SQL, not
   * the promise, is the restart authority if the isolate is evicted. */
  private async drainLoopToCompletion(): Promise<"drained" | "deferred"> {
    if (this.agentDrain.active) {
      const now = Date.now();
      const loop = this.loop.loop();
      if (loop?.status === "executing" && loop.lease_expires_at !== null
        && loop.lease_expires_at > now) return "deferred";
      const localProgressAt = this.agentDrain.lastProgress ?? this.agentDrain.activeSince;
      if (localProgressAt !== null && now - localProgressAt < KEEP_ALIVE_INTERVAL_MS) {
        return "deferred";
      }
      if (this.agentDrain.abandonActive()) {
        logWarn(this.env, "substream_loop_stale_drain_reclaimed", {
          workspace_id: this.objectStore.identity()?.workspaceId,
          workstream_id: this.objectStore.identity()?.parentId,
          substream_id: this.externalSubstreamId(),
          execution_id: loop?.active_execution_id ?? null,
          execution_epoch: loop?.active_execution_epoch ?? null,
        });
      }
    }
    await this.agentDrain.resume(
      (ownsDrain) => this.drainPersistentLoop(ownsDrain).catch((error: unknown) => {
        logWarn(this.env, "substream_loop_drain_failed", {
          workspace_id: this.objectStore.identity()?.workspaceId,
          workstream_id: this.objectStore.identity()?.parentId,
          substream_id: this.externalSubstreamId(),
          reason: error instanceof Error ? error.message : "unknown",
        });
      }),
      () => undefined,
    );
    return "drained";
  }

  /**
   * Start newly committed loop work in this invocation. Durable input rows and
   * the alarm remain the restart authority; this only removes the alarm
   * scheduler from the latency-critical healthy path.
   */
  private resumePersistentLoopDrain(): void {
    this.state.waitUntil(this.drainLoopToCompletion().catch((error: unknown) => {
      logWarn(this.env, "substream_loop_drain_failed", {
        workspace_id: this.objectStore.identity()?.workspaceId,
        workstream_id: this.objectStore.identity()?.parentId,
        substream_id: this.externalSubstreamId(),
        reason: error instanceof Error ? error.message : "unknown",
      });
    }));
  }

  private async drainPersistentLoop(
    ownsDrain: () => boolean,
  ): Promise<void> {
    while (ownsDrain()) {
      this.agentDrain.touch();

      const preparation = await this.product.resumeOldestInputPreparation();
      if (!ownsDrain()) return;
      if (preparation === "active") return;
      if (preparation === "settled") {
        void this.requestExternalProjectionDrain();
        continue;
      }

      const activation = await this.claimPersistentLoopExecution();
      if (!activation) return;
      if (!ownsDrain()) return;
      this.activeLoopExecution = activation.execution;
      void this.requestExternalProjectionDrain();
      try {
        const identity = { workspaceId: activation.input.workspaceId, parentId: activation.input.parentId };
        await this.product.recordWorkflowStarted(
          activation.input.harnessRunId,
          `substream-loop:${activation.input.loopId}:${activation.execution.runId}`,
        );
        await this.publishLocalProductEvent(identity, {
          type: "harness_status_changed",
          status: "running",
        }).catch(() => undefined);
        const result = await this.keepAliveWhile(() => this.executeAgentRun(activation.input));
        if (result.retryAt !== null) {
          const current = this.loop.loop();
          if (!current || current.status !== "executing"
            || current.active_execution_id !== activation.execution.runId
            || current.active_execution_epoch !== activation.execution.executionEpoch
            || current.lease_owner !== activation.execution.leaseOwner) {
            throw new RunOwnershipLostError();
          }
          this.loop.deferExecution({
            executionId: activation.execution.runId,
            executionEpoch: activation.execution.executionEpoch,
            leaseOwner: activation.execution.leaseOwner,
            expectedLoopRevision: current.revision,
            availableAt: result.retryAt,
            errorCode: result.errorCode,
            now: Date.now(),
          });
          return;
        }
      } catch (error) {
        if (error instanceof RunOwnershipLostError) return;
        // A plain Error whose message is itself a code — `final_turn_required`
        // from terminalization — names the failure as well as an explicit
        // `code` does; reading only `code` reported every such run as the
        // generic `agent_loop_failed`.
        const code = error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : diagnosticErrorCode(error, "agent_loop_failed");
        const loop = this.loop.loop();
        if (loop?.status === "executing"
          && loop.active_execution_id === activation.execution.runId
          && loop.active_execution_epoch === activation.execution.executionEpoch
          && loop.lease_owner === activation.execution.leaseOwner) {
          // Before the release, not after it: this is the last moment the
          // batch can be settled, and settling it is what lets the failure
          // terminalize now instead of waiting out the lease.
          await this.settleInterruptedToolBatchForFailure(activation.input)
            .catch((settleError: unknown) => logWarn(
              this.env,
              "substream_loop_failure_tool_batch_settlement_failed",
              {
                workspace_id: activation.input.workspaceId,
                workstream_id: activation.input.parentId,
                substream_id: activation.input.substreamId ?? "0",
                execution_id: activation.execution.runId,
                reason: settleError instanceof Error ? settleError.message : "unknown",
              },
            ));
          try {
            await this.product.recordWorkflowFailed(
              activation.execution.runId,
              { code, message: "Rally could not complete this execution" },
              {
                loopId: loop.loop_id,
                executionId: activation.execution.runId,
                executionEpoch: activation.execution.executionEpoch,
                leaseOwner: activation.execution.leaseOwner,
              },
            );
          } catch (failure) {
            if (!isUnsettledToolBatchError(failure)) throw failure;
            // Not a failure to record the failure: the loop is deliberately
            // left executing so its lease can expire and hand the interrupted
            // tool batch to `recoverInterruptedToolBatch`, which is the only
            // thing that can settle it and can only run while this run has not
            // terminalized. Recorded under its own name because it is a
            // deferral with a known resolution, and reading it as a drain
            // failure is what turned the same state into a day of hot retries.
            //
            // This is the whole account of the event: the branch returns, so
            // `substream_loop_execution_failed` below never runs, and dropping
            // `reason` here would tell an operator that a batch is stuck while
            // withholding why the run failed in the first place — on the one
            // path this change added in order to make that legible.
            const withheld = failure instanceof UnsettledToolBatchError ? failure : null;
            logWarn(this.env, "substream_loop_failure_awaiting_tool_batch_repair", {
              workspace_id: activation.input.workspaceId,
              workstream_id: activation.input.parentId,
              substream_id: activation.input.substreamId ?? "0",
              execution_id: activation.execution.runId,
              execution_epoch: activation.execution.executionEpoch,
              error_code: code,
              reason: error instanceof Error ? error.message : "unknown",
              stack: harnessErrorFrames(error),
              lease_expires_at: loop.lease_expires_at,
              withheld_turn_id: withheld?.turnId ?? null,
              withheld_model_turn_index: withheld?.modelTurnIndex ?? null,
              withheld_call_count: withheld?.withheldCallCount ?? null,
            });
            return;
          }
          // The run is terminal now, so anything it still had open is a card
          // nobody will close. Awaited rather than deferred: the drain's next
          // pass can evict this isolate, and the sweep that would have caught
          // it runs only while recovering a previous instance's attempt.
          await this.settleResidualReceiptsAfterFailure(activation.input)
            .catch((repairError: unknown) => logWarn(
              this.env,
              "substream_loop_residual_receipt_repair_failed",
              {
                workspace_id: activation.input.workspaceId,
                workstream_id: activation.input.parentId,
                substream_id: activation.input.substreamId ?? "0",
                execution_id: activation.execution.runId,
                reason: repairError instanceof Error ? repairError.message : "unknown",
              },
            ));
        }
        logWarn(this.env, "substream_loop_execution_failed", {
          workspace_id: activation.input.workspaceId,
          workstream_id: activation.input.parentId,
          substream_id: activation.input.substreamId ?? "0",
          execution_id: activation.execution.runId,
          execution_epoch: activation.execution.executionEpoch,
          error_code: code,
          reason: error instanceof Error ? error.message : "unknown",
        });
      } finally {
        if (this.activeLoopExecution?.leaseOwner === activation.execution.leaseOwner) {
          this.activeLoopExecution = null;
        }
        if (ownsDrain()) {
          this.agentDrain.touch();
          void this.requestExternalProjectionDrain();
        }
      }
    }
  }

  private async claimPersistentLoopExecution(): Promise<{
    input: WorkstreamWorkflowInput;
    execution: { runId: string; leaseOwner: string; executionEpoch: number };
  } | null> {
    const authority = this.state.storage.sql.exec<{ archived_at: number | null }>(
      `SELECT archived_at FROM workstream WHERE id = 1`,
    ).toArray()[0];
    if (authority && authority.archived_at !== null) return null;
    const background = this.state.storage.sql.exec<{ stopped_at: number | null; root_substream_id: string | null }>(
      "SELECT stopped_at, root_substream_id FROM background_agent WHERE id = 1",
    ).toArray()[0];
    const backgroundStopped = background?.stopped_at != null;
    let loop = this.ensurePersistentLoop();
    // Initializing the loop can advance its creation time. Sample after it exists.
    const now = Date.now();
    // Messages that start no run land first, whatever else holds the loop:
    // they were waiting only on what was sent ahead of them, not on Rally.
    if (loop.status === "idle" && this.transcript.hasLeadingInputWithoutRun()) {
      this.transcript.deliverLeadingInputsWithoutRun({
        loopId: loop.loop_id,
        enqueueRegionalEffectsInTransaction: (effects) =>
          this.product.enqueueRegionalEffectsInTransaction(effects),
        now,
      });
      await this.flushSemanticRealtimeOutboxBestEffort();
      loop = this.ensurePersistentLoop();
    }
    // A stopped agent can still recover its active lease to let Bind settle
    // the stop and any tool receipts. Only a new execution is held here.
    if (backgroundStopped && loop.status !== "executing") return null;
    if (loop.status === "executing") {
      if (loop.lease_expires_at === null || loop.active_execution_id === null
        || loop.active_execution_epoch === null || loop.lease_expires_at > now) return null;
      const receipt = this.state.storage.sql.exec<{ execution_context_json: string | null }>(
        `SELECT execution_context_json FROM runs WHERE run_id = ?`,
        loop.active_execution_id,
      ).toArray()[0];
      if (!receipt?.execution_context_json) throw new Error("substream_loop_execution_context_missing");
      const input = WorkstreamWorkflowInputSchema.parse(JSON.parse(receipt.execution_context_json));
      const leaseOwner = uuidV7(now);
      const recovered = this.loop.recoverExecution({
        executionId: loop.active_execution_id,
        newExecutionEpoch: loop.active_execution_epoch + 1,
        leaseOwner,
        leaseExpiresAt: now + LOOP_EXECUTION_LEASE_MS,
        expectedLoopRevision: loop.revision,
        now,
      });
      return {
        input,
        execution: {
          runId: input.harnessRunId,
          leaseOwner,
          executionEpoch: recovered.loop.active_execution_epoch!,
        },
      };
    }

    // Not the head of the queue: while a question the model asked is still
    // withheld, Bind takes only its answer, whatever was queued ahead of it.
    const pending = this.transcript.nextActivationInput(loop.loop_id);
    if (pending) {
      const identity = this.objectStore.identity();
      if (!identity) throw new Error("substream_loop_identity_unavailable");
      const authorization = z.looseObject({
        executionPrincipal: z.unknown(),
        reason: z.string().min(1).max(500),
        telemetryOperationId: z.string().nullable().optional(),
        telemetryRequestReceivedAt: z.number().int().nonnegative().nullable().optional(),
        telemetryJourney: z.enum(["workstream_create", "substream_create", "message_send"]).nullable().optional(),
        slackOrigin: z.unknown().nullable().optional(),
        slackSearchAuthorization: z.unknown().nullable().optional(),
        seed: DemoSeedSchema.nullable().optional(),
        agentExchange: AgentExchangeSchema.optional(),
        actorRole: z.enum(["owner", "admin", "member"]).nullable().optional(),
        intent: SidekickMessageIntentSchema.nullable().optional(),
      }).parse(JSON.parse(pending.authorization_json));
      // Input to a Sidekick run child continues that run: its instructions,
      // tools and run-as authority, against the Sidekick's accepted revision
      // today. Asked before anything is activated, so a refusal leaves the
      // loop idle, and the refused input is landed rather than left at the
      // head of the queue holding everything behind it.
      let continuation: Extract<SidekickRunContinuation, { outcome: "continue" }> | null = null;
      let delegation: WorkstreamWorkflowInput["automationDelegation"];
      let delegatedPrincipal: WorkstreamWorkflowInput["executionPrincipal"] | undefined;
      const externalSubstreamId = this.externalSubstreamId();
      // Workers have no run row of their own. A run-rooted worker asks about
      // its root's authority, while authoring-rooted workers have no run gate.
      const authorityRunId = background ? background.root_substream_id ?? "0" : externalSubstreamId;
      if (identity.parentKind === "automation" && authorityRunId !== "0") {
        const decided = await continueSidekickRun(this.env, {
          region: this.env.AVALON_REGION,
          workspaceId: identity.workspaceId,
          automationId: identity.parentId,
          runId: authorityRunId,
        });
        // The answer took an RPC, and the loop may have moved meanwhile: a
        // second input admitted behind this one bumps its revision. Acting on
        // the loop read before the call would trip the activation's revision
        // fence, fail the drain, and leave every queued input waiting for the
        // recovery alarm, so claim again from what is current instead.
        const current = this.loop.loop();
        if (!current || current.status !== "idle" || current.revision !== loop.revision
          || this.transcript.nextActivationInput(loop.loop_id)?.input_id !== pending.input_id) {
          return this.claimPersistentLoopExecution();
        }
        if (decided.outcome === "refused") {
          await this.refuseSidekickRunInput(loop, pending, decided.code, authorityRunId);
          return this.claimPersistentLoopExecution();
        }
        if (background) {
          delegatedPrincipal = decided.executionPrincipal;
          delegation = { runId: authorityRunId, stopGeneration: decided.stopGeneration };
        } else {
          continuation = decided;
        }
      }
      // A person's input in the Sidekick's shared conversation is routed by
      // the Sidekick before anything is activated, exactly as a run child
      // asks above. Input for the wizard is the sender's marked edit, or an
      // answer to what the wizard asked (an elicitation, an authorized
      // resource), and is the wizard's only from a manager; anything else
      // starts a run under the Sidekick's definition with the message as its
      // opening and lands here as said to the room: the run answers in its own
      // conversation, and its row here carries the reply. A demo seed scripts
      // its own turn and is not routed. Whatever activates here past this
      // point is the wizard's, and only such a turn loads the authoring tools.
      const sharedSidekickConversation = identity.parentKind === "automation" && externalSubstreamId === "0" && !background;
      const sender = sharedSidekickConversation && pending.actor === "human" && pending.author_user_id !== null
        && authorization.reason !== "demo_seed" ? pending.author_user_id : null;
      if (sender !== null) {
        const opening = this.transcript.pendingTranscriptInput(pending.input_id);
        const answersWizard = authorization.reason === "elicitation_answer" || authorization.reason === "resource_authorization";
        const routed = await routeSidekickConversationMessage(this.env, {
          workspaceId: asWorkspaceId(identity.workspaceId),
          automationId: identity.parentId,
          actor: { userId: asUserId(sender), actorRole: authorization.actorRole ?? null },
          messageId: pending.prepared_turn_id,
          intent: authorization.intent ?? (answersWizard ? "edit_sidekick" : null),
          authorName: pending.author_name_snapshot,
          text: opening?.block.text || "(no text)",
        });
        const current = this.loop.loop();
        if (!current || current.status !== "idle" || current.revision !== loop.revision
          || this.transcript.nextActivationInput(loop.loop_id)?.input_id !== pending.input_id) {
          return this.claimPersistentLoopExecution();
        }
        if (routed.route !== "wizard") {
          await this.landInputWithoutRun(loop, pending, routed.route === "refused" ? {
            clientMessageId: `sidekick-message-refused:${pending.input_id}`,
            text: SIDEKICK_MESSAGE_REFUSAL_TEXT[routed.code],
            structuredContent: { kind: "sidekick_message_refused", code: routed.code, turnId: pending.prepared_turn_id },
          } : null);
          const fields = {
            workspace_id: identity.workspaceId, automation_id: identity.parentId, input_id: pending.input_id,
          };
          if (routed.route === "run") logInfo(this.env, "sidekick_conversation_message_started_run", { ...fields, run_id: routed.runId, reused: routed.reused });
          else logInfo(this.env, "sidekick_conversation_message_refused", { ...fields, code: routed.code });
          return this.claimPersistentLoopExecution();
        }
      }
      // Read after any continuation call, so the Bind fences the activation
      // carries are the ones current when it commits.
      const projection = this.transcript.readBindProjection(loop.loop_id);
      const executionPrincipal = continuation?.executionPrincipal ?? delegatedPrincipal ?? authorization.executionPrincipal;
      const runId = asHarnessRunId(uuidV7(now));
      const input = WorkstreamWorkflowInputSchema.parse({
        region: this.env.AVALON_REGION,
        workspaceId: asWorkspaceId(identity.workspaceId),
        parentKind: identity.parentKind,
        parentId: identity.parentId,
        substreamId: asSubstreamId(externalSubstreamId),
        loopId: loop.loop_id,
        harnessRunId: runId,
        triggerMessageId: pending.prepared_turn_id,
        activityId: null,
        // A continued run acts as the Sidekick's run-as user whoever sent the
        // input; the sender stays the author of their message.
        executionPrincipal,
        ...(continuation
          ? {
              automationRun: continuation.automationRun,
              automationContinuation: {
                stopGeneration: continuation.stopGeneration,
                ...continuationSource(pending),
              },
            }
          : {}),
        ...(authorization.agentExchange ? { agentExchange: authorization.agentExchange } : {}),
        ...(delegation ? { automationDelegation: delegation } : {}),
        ...(sharedSidekickConversation ? { sidekickWizard: true } : {}),
        backgroundAgent: Boolean(background),
        ...(authorization.telemetryOperationId
          ? {
              telemetryOperationId: authorization.telemetryOperationId,
              // The journey is the sender's, even when the run acts as
              // somebody else.
              ...(typeof authorization.executionPrincipal === "object"
                && authorization.executionPrincipal !== null
                && "type" in authorization.executionPrincipal
                && authorization.executionPrincipal.type === "user"
                && "userId" in authorization.executionPrincipal
                && typeof authorization.executionPrincipal.userId === "string"
                ? { telemetrySubjectUserId: authorization.executionPrincipal.userId }
                : {}),
            }
          : {}),
        ...(authorization.telemetryRequestReceivedAt !== null
          && authorization.telemetryRequestReceivedAt !== undefined
          ? { telemetryRequestReceivedAt: authorization.telemetryRequestReceivedAt }
          : {}),
        ...(authorization.telemetryJourney ? { telemetryJourney: authorization.telemetryJourney } : {}),
        ...(authorization.slackOrigin ? { slackOrigin: authorization.slackOrigin } : {}),
        ...(authorization.slackSearchAuthorization
          ? { slackSearchAuthorization: authorization.slackSearchAuthorization }
          : {}),
        // Carries the seed from the message that started this run onto the
        // run's own execution receipt, which is what the harness reads.
        ...(authorization.seed ? { seed: authorization.seed } : {}),
        reason: authorization.reason,
      });
      const leaseOwner = uuidV7(now + 1);
      const activated = await this.transcript.activatePendingInput({
        loopId: loop.loop_id,
        expectedInputId: pending.input_id,
        expectedLoopRevision: loop.revision,
        expectedBindGeneration: projection?.generation ?? null,
        expectedBindStateRevision: projection?.stateRevision ?? 0,
        receipt: {
          runId,
          // Each AgentLoopDO owns a local root row "0". The external
          // child address belongs in executionContextJson, not this SQL FK.
          substreamId: "0",
          executionEpoch: 1,
          leaseOwner,
          leaseExpiresAt: now + LOOP_EXECUTION_LEASE_MS,
          executionContextJson: JSON.stringify(input),
          executionPrincipalJson: JSON.stringify(input.executionPrincipal),
          origin: input.reason,
          model: null,
        },
        enqueueRegionalEffectsInTransaction: (effects) =>
          this.product.enqueueRegionalEffectsInTransaction(effects),
        now,
      });
      await this.flushSemanticRealtimeOutboxBestEffort();
      return {
        input,
        execution: {
          runId,
          leaseOwner: activated.loop.lease_owner!,
          executionEpoch: activated.loop.active_execution_epoch!,
        },
      };
    }

    const ready = this.state.storage.sql.exec<{
      run_id: string;
      execution_context_json: string;
    }>(
      `SELECT run_id, execution_context_json FROM runs
        WHERE substream_loop_id IS NULL AND execution_context_json IS NOT NULL
          AND terminalized_at IS NULL
          AND status IN ('admitted', 'running')
          AND (execution_available_at IS NULL OR execution_available_at <= ?)
        ORDER BY COALESCE(execution_available_at, created_at), created_at, run_id LIMIT 1`,
      now,
    ).toArray()[0];
    if (!ready) return null;
    const input = WorkstreamWorkflowInputSchema.parse(JSON.parse(ready.execution_context_json));
    if (input.loopId !== loop.loop_id || input.harnessRunId !== ready.run_id) {
      throw new Error("substream_loop_execution_context_mismatch");
    }
    const leaseOwner = uuidV7(now);
    loop = this.loop.activateExecutionReceipt({
      runId: ready.run_id,
      loopId: loop.loop_id,
      expectedLoopRevision: loop.revision,
      expectedBindStateRevision: loop.bind_state_revision,
      executionEpoch: 1,
      leaseOwner,
      leaseExpiresAt: now + LOOP_EXECUTION_LEASE_MS,
      now,
    }).loop;
    return {
      input,
      execution: {
        runId: ready.run_id,
        leaseOwner,
        executionEpoch: loop.active_execution_epoch!,
      },
    };
  }

  /**
   * Settle input the Sidekick would not continue its run for.
   *
   * The input lands as the sender wrote it, and a system row after it says
   * why nothing answered, under the refusal's own code. Both in one
   * transaction, keyed on the input, so a retried drain neither duplicates
   * the note nor lands the input without it.
   */
  private async refuseSidekickRunInput(
    loop: SubstreamLoopRow,
    pending: PendingLoopInputRow,
    code: SidekickRunContinuationRefusalCode,
    authorityRunId: string,
  ): Promise<void> {
    await this.landInputWithoutRun(loop, pending, {
      clientMessageId: `sidekick-run-refused:${pending.input_id}`,
      text: SIDEKICK_RUN_REFUSAL_TEXT[code],
      structuredContent: { kind: "sidekick_run_refused", code, turnId: pending.prepared_turn_id },
    });
    const identity = this.objectStore.identity();
    logInfo(this.env, "sidekick_run_continuation_refused", {
      workspace_id: identity?.workspaceId ?? null,
      automation_id: identity?.parentId ?? null,
      run_id: authorityRunId,
      input_id: pending.input_id,
      code,
    });
  }

  /**
   * Land the input at the head of the queue as the sender wrote it, starting
   * nothing here, with an optional system row after it saying why. Both in one
   * transaction, keyed on the input, so a retried drain neither duplicates the
   * note nor lands the input without it.
   */
  private async landInputWithoutRun(
    loop: SubstreamLoopRow,
    pending: PendingLoopInputRow,
    note: { clientMessageId: string; text: string; structuredContent: Record<string, unknown> } | null,
  ): Promise<void> {
    const now = Date.now();
    const prepared = note === null ? null : await this.messages.prepareMessage({
      messageId: uuidV7(now),
      clientMessageId: note.clientMessageId,
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      messageType: "system",
      text: note.text,
      structuredContentJson: JSON.stringify(note.structuredContent),
      producedByRunId: null,
      now,
    });
    await this.product.commitRuntimeMutation(() => {
      this.product.enqueueRegionalEffectsInTransaction(this.transcript.deliverRefusedInputInTransaction({
        loopId: loop.loop_id,
        inputId: pending.input_id,
        expectedLoopRevision: loop.revision,
        now,
      }));
      if (prepared) this.messages.appendPreparedMessage(prepared);
    }, true);
    await this.flushSemanticRealtimeOutboxBestEffort();
  }

  private nextUnsettledExecutionReceipt(now: number): {
    run_id: string;
    execution_context_json: string;
    status: "completed" | "needs_input" | "failed" | "stopped";
    execution_available_at: number | null;
  } | null {
    const row = this.state.storage.sql.exec<{
      run_id: string;
      execution_context_json: string;
      status: string;
      execution_available_at: number | null;
    }>(
      `SELECT run_id, execution_context_json, status, execution_available_at FROM runs
        WHERE execution_context_json IS NOT NULL AND terminalized_at IS NOT NULL
          AND external_settled_at IS NULL
        ORDER BY terminalized_at, run_id LIMIT 1`,
    ).toArray()[0];
    if (!row) return null;
    // External destinations observe run order. A failed older delivery holds
    // only this lane until its retry time; it never lets a later result pass it
    // and it never holds the inference loop.
    if (row.execution_available_at !== null && row.execution_available_at > now) return null;
    const status = row.status === "cancelled" ? "stopped" : row.status;
    if (!["completed", "needs_input", "failed", "stopped"].includes(status)) {
      throw new Error("substream_loop_terminal_receipt_invalid");
    }
    return { ...row, status: status as "completed" | "needs_input" | "failed" | "stopped" };
  }

  private deferExecutionReceipt(runId: string, availableAt: number, errorCode: string | null): void {
    this.state.storage.sql.exec(
      `UPDATE runs SET execution_available_at = ?, last_settlement_error_code = ?, updated_at = ?
        WHERE run_id = ?`,
      availableAt,
      errorCode,
      Date.now(),
      runId,
    );
  }

  /**
   * Start the independent post-run lane without joining it to inference.
   *
   * `external_settled_at IS NULL` is the restart authority; this in-memory
   * drain only avoids two continuations delivering the same oldest receipt in
   * one isolate. `waitUntil` gives the eager attempt room to finish, while the
   * object's alarm remains the recovery path after eviction or cancellation.
   */
  private resumeExternalSettlementDrain(): void {
    const drain = this.externalSettlementDrain.resume(
      (ownsDrain) => this.drainExternalSettlements(ownsDrain).catch((error: unknown) => {
        logWarn(this.env, "substream_external_settlement_drain_failed", {
          workspace_id: this.objectStore.identity()?.workspaceId,
          workstream_id: this.objectStore.identity()?.parentId,
          substream_id: this.externalSubstreamId(),
          reason: error instanceof Error ? error.message : "unknown",
        });
      }),
      async () => { await this.armNextAlarm(); },
    );
    this.ctx.waitUntil(drain);
  }

  private async drainExternalSettlements(ownsDrain: () => boolean): Promise<void> {
    while (ownsDrain()) {
      this.externalSettlementDrain.touch();
      const settlement = this.nextUnsettledExecutionReceipt(Date.now());
      if (!settlement) return;
      const claimNow = Date.now();
      const claimed = this.state.storage.sql.exec<{ run_id: string }>(
        `UPDATE runs SET execution_available_at = ?, updated_at = ?
          WHERE run_id = ? AND terminalized_at IS NOT NULL AND external_settled_at IS NULL
            AND (execution_available_at IS NULL OR execution_available_at <= ?)
          RETURNING run_id`,
        claimNow + MAINTENANCE_RECHECK_MS,
        claimNow,
        settlement.run_id,
        claimNow,
      ).toArray()[0];
      if (!claimed) continue;
      let encoded: unknown;
      try {
        encoded = JSON.parse(settlement.execution_context_json);
      } catch {
        this.deferExecutionReceipt(settlement.run_id, Date.now() + MAINTENANCE_RECHECK_MS,
          "substream_loop_execution_context_invalid");
        return;
      }
      const parsed = WorkstreamWorkflowInputSchema.safeParse(encoded);
      if (!parsed.success) {
        this.deferExecutionReceipt(settlement.run_id, Date.now() + MAINTENANCE_RECHECK_MS,
          "substream_loop_execution_context_invalid");
        return;
      }
      const executionEnv = this.localRuntimeEnvironment(
        parsed.data.workspaceId,
        parsed.data.parentId,
        parsed.data.substreamId ?? "0",
      );
      let outcome: AgentTerminalOutcome;
      try {
        outcome = this.freshTerminalOutcomes.get(settlement.run_id)
          ?? await this.loadTerminalOutcome(executionEnv, parsed.data, settlement.status);
      } catch (error) {
        this.deferExecutionReceipt(settlement.run_id, Date.now() + MAINTENANCE_RECHECK_MS,
          diagnosticErrorCode(error, "agent_terminal_outcome_missing"));
        return;
      }
      if (!ownsDrain()) return;
      this.freshTerminalOutcomes.delete(settlement.run_id);
      const result = await this.settleAgentRunWithRetry(executionEnv, parsed.data, outcome);
      if (result.retryAt !== null) return;
    }
  }

  /**
   * Wraps the run so no outcome is silent.
   *
   * Every branch below already decides something a member can see — an early
   * settle, a recovered terminal outcome, a backoff — and until now most of
   * them returned without a word. Twice during this incident the telemetry
   * showed a run executing in a second and producing nothing, and there was no
   * way to tell which branch had done it.
   */
  private async executeAgentRun(input: WorkstreamWorkflowInput): Promise<{
    status: WorkstreamHarnessResult["status"];
    errorCode: string | null;
    retryAt: number | null;
  }> {
    const startedAt = Date.now();
    const result = await this.runAgentExecution(input);
    logInfo(this.env, "agent_run_outcome", {
      workspace_id: input.workspaceId,
      workstream_id: input.parentId,
      substream_id: input.substreamId ?? "0",
      harness_run_id: input.harnessRunId,
      status: result.status,
      error_code: result.errorCode,
      retry_at: result.retryAt,
      duration_ms: Date.now() - startedAt,
    });
    return result;
  }

  /** The reap and receipt-repair budget this object runs every sweep under. */
  private harnessRecoveryOptions(
    input: WorkstreamWorkflowInput,
    executionEnv: Env,
  ): Parameters<typeof reapStaleHarnessRuns>[1] {
    return {
      receipts: createToolReceiptPortFactory(executionEnv),
      workspaceId: input.workspaceId,
      workstreamId: input.parentId,
      limit: 25,
      onReceiptRepairFailure: (failure) => logWarn(this.env, "harness_residual_receipt_repair_failed", {
        workspace_id: failure.workspaceId,
        workstream_id: failure.workstreamId,
        harness_run_id: failure.runId,
        attempt_id: failure.attemptId,
        repair_phase: failure.phase,
        reason: failure.reason,
      }),
    };
  }

  /**
   * Settle an interrupted tool batch while the failing run can still do it.
   *
   * This is the ordinary path, and the refusal in `recordWorkflowFailed` is the
   * backstop behind it. Deferring to the lease expiry instead would be correct
   * and far too slow: a run refused before its tool ran — an authorization
   * revoked mid-turn, say — has an unsettled batch with no receipts at all, and
   * making that room wait `LOOP_EXECUTION_LEASE_MS` with every queued message
   * behind it, to append four "did not run" results nobody is waiting for, is a
   * worse product than the wedge this whole change is about.
   *
   * Settling here needs nothing the failing run does not already hold: the loop
   * fence is live, the attempt lease is on the run row because terminalization
   * has not happened yet, and the receipts are addressed by this run's own id.
   * Best-effort on purpose. If it cannot settle — the loop lease lapsed while
   * the run was away, the attempt was taken over — the refusal below keeps the
   * loop executing and the recovery branch gets it, which is slow but correct.
   */
  private async settleInterruptedToolBatchForFailure(
    input: WorkstreamWorkflowInput,
  ): Promise<void> {
    if (!this.transcript.unsettledToolBatchBlockingRelease(input.loopId)) return;
    const attempt = this.state.storage.sql.exec<{
      legacy_attempt_id: string | null;
      lease_owner: string | null;
    }>(
      `SELECT legacy_attempt_id, lease_owner FROM runs WHERE run_id = ?`,
      input.harnessRunId,
    ).toArray()[0];
    // No attempt to fence a receipt settlement with. `recoverInterruptedToolBatch`
    // would refuse one anyway, so leave it to the backstop rather than half-doing it.
    if (!attempt?.legacy_attempt_id || !attempt.lease_owner) return;
    // Handing these straight back to `ToolReceiptStorage#fence` would be asking
    // the row to vouch for itself: that fence compares the values it is given
    // against this same row, so it could only ever fail on expiry or
    // terminalization, never on "another instance owns this attempt now". Every
    // other caller passes a lease `claimHarnessAttempt` minted for it, which
    // proves current ownership; this path has no such lease to pass, so it
    // proves the same thing by reconstructing the owner. `harnessAttemptOwner`
    // ends in a per-isolate nonce, so a takeover does not match — and neither
    // does an attempt recovered from a dead instance, whose owner the reaper
    // rewrites. Either way the settlement stands down and the release guard
    // hands the batch to the lease-expiry recovery, which is the slow path but
    // never the wrong one.
    const ownedHere = attempt.lease_owner === this.harnessAttemptOwner(
      input,
      attempt.legacy_attempt_id,
    ) || attempt.lease_owner === previousInstanceRecoveryOwner(attempt.legacy_attempt_id);
    if (!ownedHere) {
      logWarn(this.env, "substream_loop_failure_tool_batch_settlement_not_owned", {
        workspace_id: input.workspaceId,
        workstream_id: input.parentId,
        substream_id: input.substreamId ?? "0",
        harness_run_id: input.harnessRunId,
        attempt_id: attempt.legacy_attempt_id,
      });
      return;
    }
    await this.recoverInterruptedToolBatch(
      this.localRuntimeEnvironment(
        input.workspaceId,
        input.parentId,
        input.substreamId ?? "0",
      ),
      input,
      { attemptId: attempt.legacy_attempt_id, owner: attempt.lease_owner },
    );
  }

  /**
   * Close the tool receipts a failed run left open.
   *
   * `terminalizeHarnessAttempt` settles these as part of terminalizing, and
   * says at length why every terminal status needs it: an open receipt on a
   * terminal run is a card that spins forever, and nothing downstream repairs
   * it. `recordWorkflowFailed` now shares the object-local terminal commit,
   * but external receipts still belong to their own authority — the sweep
   * below runs only when a previous
   * instance's attempt is being recovered, which on an object whose next run
   * never starts is never. A `web_fetch` on the substream wedged on 2026-09-19
   * was still `executing` a day later for exactly that reason.
   *
   * The bounded sweep rather than a hand-built repair row: it selects the
   * terminal runs whose settlement marker is missing, which is precisely what
   * this path leaves behind, and records the marker so later passes do not
   * rescan them. Best-effort by construction — the run has already failed, and
   * a repair that cannot run now is one the next sweep still owns.
   */
  private async settleResidualReceiptsAfterFailure(
    input: WorkstreamWorkflowInput,
  ): Promise<void> {
    const executionEnv = this.localRuntimeEnvironment(
      input.workspaceId,
      input.parentId,
      input.substreamId ?? "0",
    );
    await repairTerminalResidualReceipts(
      createHarnessRunObjectPort(executionEnv, input.workspaceId, input.parentId),
      this.harnessRecoveryOptions(input, executionEnv),
    );
  }

  private async runAgentExecution(input: WorkstreamWorkflowInput): Promise<{
    status: WorkstreamHarnessResult["status"];
    errorCode: string | null;
    retryAt: number | null;
  }> {
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority)) {
      // Say so. A run that backs off here does it every few minutes for as long
      // as the phase holds, and the member sees only a spinner — during the
      // Global cutover that was eighteen hours of silence.
      logWarn(this.env, "agent_run_deferred_for_maintenance", {
        workspace_id: input.workspaceId,
        workstream_id: input.parentId,
        harness_run_id: input.harnessRunId,
        phase: authority.phase,
        generation: authority.generation,
      });
      return { status: "failed", errorCode: null, retryAt: Date.now() + MAINTENANCE_RECHECK_MS };
    }
    const executionEnv = this.localRuntimeEnvironment(
      input.workspaceId,
      input.parentId,
      input.substreamId ?? "0",
    );
    const runs = createHarnessRunObjectPort(executionEnv, input.workspaceId, input.parentId);
    const loopExecution = this.activeLoopExecution;
    if (!loopExecution || loopExecution.runId !== input.harnessRunId) {
      throw new Error("substream_loop_execution_context_missing");
    }
    const terminalLoopFence = {
      loopId: input.loopId,
      executionId: loopExecution.runId,
      executionEpoch: loopExecution.executionEpoch,
      leaseOwner: loopExecution.leaseOwner,
    };
    const recoveryOptions = this.harnessRecoveryOptions(input, executionEnv);
    const recoverableAttemptId = this.recoverableHarnessAttempts.get(input.harnessRunId) ?? null;
    if (recoverableAttemptId === null) {
      await reapStaleHarnessRuns(runs, recoveryOptions);
    }
    const attemptId = recoverableAttemptId ?? uuidV7();
    const attemptOwner = this.harnessAttemptOwner(input, attemptId);
    const claim = await claimHarnessAttempt(
      runs,
      input,
      {
        attemptId,
        owner: attemptOwner,
        leaseSeconds: 300,
      },
    );
    if (recoverableAttemptId !== null
      && claim.state !== "busy"
      && claim.state !== "cancelled") {
      this.recoverableHarnessAttempts.delete(input.harnessRunId);
    }
    if (recoverableAttemptId !== null && claim.state === "claimed") {
      logWarn(this.env, "substream_agent_previous_instance_attempt_resumed", {
        workspace_id: input.workspaceId,
        workstream_id: input.parentId,
        substream_id: input.substreamId ?? "0",
        harness_run_id: input.harnessRunId,
        attempt_id: recoverableAttemptId,
        attempt_epoch: claim.lease.attemptNumber,
      });
      // The root is live before this pass. Its children were expired with it,
      // so the reaper keeps them resumable instead of treating them as stale.
      await reapStaleHarnessRuns(runs, recoveryOptions);
    } else if (recoverableAttemptId !== null) {
      // The recovered row was busy, cancelled, or terminal. Repair old
      // terminal receipts without letting the general reaper fail the attempt
      // this instance still intends to reclaim on a later busy retry.
      await repairTerminalResidualReceipts(runs, recoveryOptions);
    }
    if (claim.state === "busy") {
      const leaseAt = claim.leaseExpiresAt ? Date.parse(claim.leaseExpiresAt) : Number.NaN;
      // A lease nobody will release leaves the run "running" forever, and this
      // branch is the only place that knows it.
      logWarn(this.env, "agent_run_attempt_busy", {
        workspace_id: input.workspaceId,
        workstream_id: input.parentId,
        harness_run_id: input.harnessRunId,
        lease_expires_at: claim.leaseExpiresAt ?? null,
      });
      return {
        status: "failed",
        errorCode: null,
        retryAt: Number.isFinite(leaseAt) ? Math.max(Date.now() + 1_000, leaseAt + 1) : Date.now() + 5_000,
      };
    }
    if (claim.state === "terminal") {
      try {
        const recovered = await this.loadTerminalOutcome(executionEnv, input, claim.status);
        logWarn(this.env, "agent_run_adopted_terminal_attempt", {
          workspace_id: input.workspaceId,
          workstream_id: input.parentId,
          harness_run_id: input.harnessRunId,
          claim_status: claim.status,
          recovered_status: recovered.status,
        });
        return this.persistAgentRunForExternalSettlement(input, recovered);
      } catch (error) {
        logWarn(this.env, "substream_agent_terminal_recovery_failed", {
          workspace_id: input.workspaceId,
          workstream_id: input.parentId,
          substream_id: input.substreamId ?? "0",
          harness_run_id: input.harnessRunId,
          reason: error instanceof Error ? error.message : "unknown",
        });
        return {
          status: claim.status,
          errorCode: "agent_terminal_recovery_failed",
          retryAt: Date.now() + 30_000,
        };
      }
    }
    if (claim.state === "cancelled") {
      const stopped = {
        status: "stopped",
        error: { code: "run_cancelled", message: "The run was stopped before it started" },
        cancellationReason: "run_cancelled",
      } as const;
      if (recoverableAttemptId !== null) {
        await terminalizeHarnessAttempt(
          runs,
          input,
          { attemptId, owner: previousInstanceRecoveryOwner(attemptId) },
          stopped,
          createToolReceiptObjectPort(executionEnv, input.workspaceId, input.parentId),
          terminalLoopFence,
        );
        this.recoverableHarnessAttempts.delete(input.harnessRunId);
      } else {
        await terminalizeQueuedHarnessRun(
          runs,
          input,
          { attemptId, owner: attemptOwner },
          stopped.error,
          "stopped",
          terminalLoopFence,
        );
      }
      return this.persistAgentRunForExternalSettlement(input, stopped);
    }

    let outcome: WorkstreamHarnessResult;
    try {
      const interruptedReservation = await this.settleInterruptedAssistantReservation(input);
      const recoveredToolBatch = interruptedReservation
        ? null
        // The lease is both arguments: it fences every receipt settlement, and
        // it is the claim a re-entry holds open while the tool runs.
        : await this.recoverInterruptedToolBatch(executionEnv, input, claim.lease, claim.lease);
      // Only when nothing is waiting on a person: `recoverInterruptedToolBatch`
      // reports `waiting_for_input` ahead of `ambiguous`, so this arm is the
      // repaired-and-continuing case rather than every batch that held one.
      if (recoveredToolBatch === "ambiguous") {
        // Recorded, then carried on. The repair has already written every
        // call's outcome into the protocol transcript — the ambiguous one as a
        // failed tool result that names the call and says to check it before
        // repeating it — and the model's next turn reads them. Failing here
        // withheld that account from the only reader able to act on it, and
        // threw away every completed call in the same batch, in exchange for a
        // safety it did not buy: a member who re-sends gets a fresh run with
        // fresh receipt coordinates, and nothing in the receipt layer connects
        // the new call to the abandoned one. The stop cost a work stream its
        // afternoon on 2026-09-19 and prevented no second write.
        logWarn(this.env, "harness_ambiguous_recovery_continued", {
          workspace_id: input.workspaceId,
          workstream_id: input.parentId,
          substream_id: this.externalSubstreamId(),
          harness_run_id: input.harnessRunId,
        });
      }
      outcome = interruptedReservation === "stopped"
        ? {
            status: "stopped",
            error: {
              code: "run_cancelled",
              message: "The run was stopped before its interrupted response could resume",
            },
          }
        : recoveredToolBatch === "waiting_for_input"
          ? { status: "needs_input" }
        : await runWorkstreamHarness(
          executionEnv,
          input,
          (event) => this.publishAgentRuntimeEvent(event),
          {
            lease: claim.lease,
            publishRealtime: false,
            persistentLoop: this.persistentLoopRuntime(input),
            // Terminal reaches this object through the authorities installed on
            // `executionEnv`, so it is not threaded here any more. The resource
            // attacher still is, and deliberately: it carries a *scope* rather
            // than a location — it refuses an attachment addressed to another
            // work stream, which a port resolved by ids would happily deliver.
            // Every substream gets its own, so a run's resources land on the
            // run and not on the parent's main conversation.
            runtimeResourceAttacher: this.localRuntimeResourceAttacher(
              input.workspaceId,
              input.parentId,
            ),
          },
        );
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "harness_execution_failed";
      // A bare `harness_execution_failed` is an uncoded exception, and the
      // member-safe outcome keeps none of it. Without this line the only fact
      // production retains is the catch-all code — which is precisely what an
      // incident hands back when asked what went wrong.
      logError(this.env, "workstream_harness_threw", {
        workspace_id: input.workspaceId,
        workstream_id: input.parentId,
        substream_id: input.substreamId ?? "0",
        harness_run_id: input.harnessRunId,
        error_code: code,
        reason: error instanceof Error ? error.message : String(error),
        stack: harnessErrorFrames(error),
      });
      outcome = {
        status: code === "run_cancelled" ? "stopped" : "failed",
        error: { code, message: "The Avalon harness could not complete this run" },
      };
    }
    await terminalizeHarnessAttempt(
      runs,
      input,
      claim.lease,
      {
        status: outcome.status,
        ...(outcome.finalTurnId ? { finalTurnId: outcome.finalTurnId } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        memberSafePayload: outcome.error ? { code: outcome.error.code } : {},
      },
      createToolReceiptObjectPort(executionEnv, input.workspaceId, input.parentId),
      terminalLoopFence,
    );
    // After the outcome is durable and on every path that reached it — a
    // completed run, a stopped one, and one whose host threw alike.
    await this.endAgentProfileRun(executionEnv, input);
    if (outcome.finalTurnId) {
      await this.publishAgentRuntimeEvent({ type: "stream_completed", streamId: input.harnessRunId });
    }
    const root = this.product.runtimeStatus();
    await this.publishAgentRuntimeEvent({
      type: "harness_status_changed",
      status: root,
    });
    return this.persistAgentRunForExternalSettlement(input, outcome);
  }

  /** The cleanup this conversation's agent profile owes once a run of it has ended. */
  private async endAgentProfileRun(executionEnv: Env, input: WorkstreamWorkflowInput): Promise<void> {
    let profile: AgentProfile | null;
    try {
      profile = agentProfileFor(this.identityRows.identity()?.agent_profile);
    } catch {
      // An unknown profile already failed the run with `agent_profile_unknown`.
      return;
    }
    if (!profile?.ended) return;
    await profile.ended(executionEnv, {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      userId: input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : null,
    }).catch((error: unknown) => {
      logWarn(this.env, "agent_profile_run_end_failed", {
        workspace_id: input.workspaceId,
        workstream_id: input.parentId,
        harness_run_id: input.harnessRunId,
        error_code: diagnosticErrorCode(error, "agent_profile_run_end_failed"),
      });
    });
  }

  /**
   * Repair the provider protocol after an isolate dies between accepting an
   * assistant tool batch and accepting all of its results. Bind is correct to
   * refuse this shape: only the host can read the durable effect receipts and
   * decide which missing calls completed, definitely did not run, or may have
   * crossed an external write boundary.
   */
  /**
   * For an interrupted `code_execute` or `custom_<name>` receipt, the nested
   * calls recorded under it, as one sentence; null for any other tool. The
   * children are receipts at `<toolCallId>:call:<index>`, settled as the
   * program ran, so this is the ledger's own account of how far it got.
   */
  private completedProgramChildren(runId: string, receipt: { toolCallId: string; executionPlanJson: string | null }): string | null {
    let pluginId: unknown;
    try {
      pluginId = receipt.executionPlanJson === null ? null : (JSON.parse(receipt.executionPlanJson) as { pluginId?: unknown }).pluginId;
    } catch {
      return null;
    }
    if (pluginId !== CODE_PLUGIN_ID && pluginId !== CUSTOM_TOOLS_PLUGIN_ID) return null;
    const children = this.state.storage.sql.exec<{ tool_call_id: string; tool_name: string; status: string }>(
      `SELECT tool_call_id, tool_name, status FROM tool_effects
        WHERE run_id = ? AND tool_call_id LIKE ? ORDER BY tool_position`,
      runId,
      `${receipt.toolCallId}:call:%`,
    ).toArray();
    const completed = children.filter((child) => child.status === "completed")
      .map((child) => `${child.tool_name} at ${child.tool_call_id.slice(receipt.toolCallId.length + ":call:".length)}`);
    const unsettled = children.filter((child) => child.status !== "completed" && child.status !== "failed")
      .map((child) => child.tool_name);
    return `program interrupted; completed nested calls: ${completed.length ? completed.join(", ") : "none"}`
      + (unsettled.length ? `; unknown: ${unsettled.join(", ")}` : "");
  }

  private async recoverInterruptedToolBatch(
    executionEnv: Env,
    input: WorkstreamWorkflowInput,
    /** What every receipt settlement below is fenced on. */
    fence: { attemptId: string; owner: string },
    /**
     * The claim this repair holds, when it holds one.
     *
     * Only re-entry needs more than the fence: it settles a result through the
     * same durable path a first-pass completion uses, which proves attempt
     * ownership, and it holds the lease open while a tool runs. The
     * failure-settlement caller reconstructs an owner rather than minting a
     * lease — deliberately, as its own comment explains — so it has none to
     * give, and an interrupted write there stays ambiguous exactly as it did
     * before re-entry existed.
     */
    lease?: AttemptLease,
  ): Promise<"recovered" | "ambiguous" | "waiting_for_input" | null> {
    const projection = this.transcript.readBindProjection(input.loopId);
    if (!projection) return null;
    const batch = pendingBindToolBatch(projection);
    if (!batch) return null;
    const elicitationCallIds = new Set(this.state.storage.sql.exec<{
      tool_call_id: string;
    }>(
      `SELECT tool_call_id FROM elicitation_requests
        WHERE status IN ('pending', 'answered', 'cancelled')`,
    ).toArray().map((row) => row.tool_call_id));
    // A completed core tool receipt is only evidence that the question was
    // made visible. Its deliberately withheld protocol result is the future
    // human answer, which pending-input promotion accepts atomically. Generic
    // crash repair settles every *other* missing sibling first, but never
    // substitutes the question-creation output for that answer.
    const hasWithheldElicitation = batch.calls.some((call) =>
      elicitationCallIds.has(call.receiptToolCallId));
    const recoverableCalls = batch.calls.filter((call) =>
      !elicitationCallIds.has(call.receiptToolCallId));
    if (recoverableCalls.length === 0) return "waiting_for_input";
    const execution = this.activeLoopExecution;
    if (!execution || execution.runId !== input.harnessRunId) {
      throw new Error("substream_loop_execution_unavailable");
    }
    let ambiguous = false;
    for (let offset = 0; offset < recoverableCalls.length; offset += 1) {
      const call = recoverableCalls[offset]!;
      const now = Date.now();
      let receipt = this.toolReceipts.receiptForCall({
        runId: input.harnessRunId,
        toolCallId: call.receiptToolCallId,
      });
      let classification: "completed" | "failed" | "ambiguous" | "not_run";
      // Set only when this repair re-entered the tool and it answered. The
      // receipt is already `completed` by then, so the result is carried here
      // rather than re-read from a row that has just moved underneath us.
      let reenteredResult: HarnessToolResult | null = null;
      let ambiguityReason: string | null = null;
      if (!receipt) {
        classification = "not_run";
      } else if (receipt.status === "admitted") {
        classification = "not_run";
      } else if (receipt.status !== "executing") {
        classification = receipt.status;
      } else if (receipt.mode !== "write") {
        classification = "failed";
      } else if (!lease) {
        // No claim to settle a result under, so there is no way to ask without
        // being unable to record the answer.
        classification = "ambiguous";
        ambiguityReason = "no_repair_lease";
      } else {
        // An interrupted write is only unknowable if nobody asks. A tool that
        // declares itself re-enterable resolves its own durable effect before
        // acting — `run_command` reattaches to the provider task its receipt
        // names, `publish_resource` finds the document its path identity
        // already holds — so running it again over the same receipt returns
        // what the interrupted attempt did rather than doing it twice. Only a
        // tool that cannot be asked, or an attempt to ask that failed, keeps
        // `ambiguous_external_write`.
        const reentry = await reenterInterruptedWriteForRecovery(
          executionEnv,
          input,
          {
            effectIntentId: receipt.effectIntentId,
            toolCallId: receipt.toolCallId,
            toolName: receipt.toolName,
            status: receipt.status,
            requestHash: receipt.requestHash,
            inputJson: receipt.inputJson,
            executionPlanJson: receipt.executionPlanJson,
            startedAt: receipt.startedAt ?? 0,
            providerIdempotencyKey: receipt.providerIdempotencyKey,
          },
          lease,
          // The attempt authority, so the re-entry can hold its lease open and
          // abort the moment it cannot. No ceiling of this repair's own beyond
          // that: the tools reached here carry their own provider budgets, and
          // a number invented on top would be one nobody has measured. See
          // `docs/adding-security-defensive-and-other-limits.md`.
          createHarnessRunObjectPort(
            executionEnv,
            input.workspaceId,
            input.parentId,
            undefined,
            input.substreamId ?? "0",
          ),
          this.localRuntimeResourceAttacher(input.workspaceId, input.parentId),
        );
        if (reentry.outcome === "completed") {
          classification = "completed";
          reenteredResult = reentry.result;
        } else {
          classification = "ambiguous";
          ambiguityReason = reentry.reason;
          // A program has no re-entry executor of its own, but its children
          // are receipts: name the nested calls that completed, so whoever
          // reads the ambiguity knows which writes stand and which are unknown.
          const programChildren = this.completedProgramChildren(input.harnessRunId, receipt);
          if (programChildren !== null) ambiguityReason = programChildren;
        }
        // Named for the attempt rather than the outcome, which travels in
        // `recovery`. The previous name asserted recovery on both branches, so
        // counting repairs by grepping it over-counted by every failure — and
        // the failure is the line worth finding.
        logWarn(this.env, "harness_interrupted_write_reentry", {
          workspace_id: input.workspaceId,
          workstream_id: input.parentId,
          substream_id: this.externalSubstreamId(),
          harness_run_id: input.harnessRunId,
          tool_invocation_id: receipt.effectIntentId,
          tool_name: receipt.toolName,
          idempotency: receipt.idempotency,
          recovery: classification,
          ...(ambiguityReason ? { reason: ambiguityReason } : {}),
        });
      }
      if (receipt && classification === "completed" && reenteredResult) {
        // Re-entry settled the receipt itself, through the same durable result
        // path a first-pass completion uses. Re-read it so the lifecycle row
        // below describes what was actually stored.
        receipt = this.toolReceipts.receiptForCall({
          runId: input.harnessRunId,
          toolCallId: call.receiptToolCallId,
        });
        if (!receipt) throw new Error("recovered_tool_receipt_missing");
      }
      if (receipt && (receipt.status === "admitted" || receipt.status === "executing")) {
        const status = classification === "ambiguous" ? "ambiguous" : "failed";
        const code = classification === "not_run"
          ? "tool_not_run_after_interruption"
          : classification === "ambiguous"
            ? "ambiguous_external_write"
            : "tool_execution_interrupted";
        // Named, not coded. `CLAUDE.md` calls a generic code on a path that
        // had the reason in hand a defect, and this path holds the tool, its
        // idempotency class, and why asking it failed. An operator reading
        // `ambiguous_external_write` alone had none of that and had to go to
        // the receipts to learn which call it was about.
        const message = classification === "not_run"
          ? "The interrupted tool call definitely did not start"
          : classification === "ambiguous"
            ? `Rally could not confirm whether the interrupted ${receipt.toolName} write completed${ambiguityReason ? ` (${ambiguityReason})` : ""}`
            : "The interrupted tool call ended before Rally accepted a result";
        const settlement = this.toolReceipts.fail({
          effectIntentId: receipt.effectIntentId,
          status,
          phase: "host_recovery",
          errorJson: JSON.stringify({ code, message }),
          payloadJson: JSON.stringify({ code, recovery: classification }),
          allowCancellationRequested: true,
          fence: {
            runId: input.harnessRunId,
            attemptId: fence.attemptId,
            owner: fence.owner,
          },
          now,
        });
        if (settlement !== "persisted" && settlement !== "already_persisted") {
          throw new RunOwnershipLostError();
        }
        receipt = this.toolReceipts.receiptForCall({
          runId: input.harnessRunId,
          toolCallId: call.receiptToolCallId,
        });
        if (!receipt) throw new Error("recovered_tool_receipt_missing");
      }

      let result: Record<string, unknown>;
      let participantSafeResult: unknown;
      let participantError: string | null = null;
      if (classification === "completed" && receipt) {
        const exactOutput = reenteredResult?.output
          ?? (receipt.outputRef ? await loadToolReplayOutput(executionEnv, receipt.outputRef) : null);
        const data = exactOutput ?? {
          summary: receipt.outputSummary ?? "The tool completed, but its detailed result is unavailable.",
          resultAvailability: "summary_only",
        };
        result = { success: true, data };
        participantSafeResult = reenteredResult?.summary ?? receipt.outputSummary ?? "Completed";
      } else {
        const durableError = recoveredToolReceiptError(receipt?.errorJson ?? null);
        const code = classification === "not_run"
          ? "tool_not_run_after_interruption"
          : classification === "ambiguous"
            ? "ambiguous_external_write"
            : durableError.code ?? "tool_execution_interrupted";
        participantError = classification === "ambiguous"
          ? `Rally could not confirm whether ${receipt?.toolName ?? "this external action"} completed. Check its result before running it again.`
          : classification === "not_run"
            ? "Rally did not run this tool after recovering the interrupted turn"
            : durableError.message ?? "The interrupted tool did not produce an accepted result";
        // The model gets the same account the member does, and for the same
        // reason the cycle no longer stops here: continuing is only defensible
        // if the reader who could repeat the write is told not to. This
        // carried `{ code, recovery }` alone — a code with no tool name, no
        // reason, and no instruction — which is the generic-code defect
        // `AGENTS.md` names, on a path holding all three. A receipt coordinate
        // is per turn, so nothing downstream stops a blind repeat; this text
        // is what stands between an unconfirmed write and a second one.
        result = {
          success: false,
          kind: classification === "ambiguous" ? "ambiguous_external_write" : "external",
          error: code,
          data: {
            code,
            recovery: classification,
            ...(receipt ? { toolName: receipt.toolName } : {}),
            ...(classification === "ambiguous" && ambiguityReason ? { reason: ambiguityReason } : {}),
            ...(classification === "ambiguous"
              ? {
                  instruction: `Rally could not confirm whether ${receipt?.toolName ?? "this call"} reached the far side, so it may already have taken effect. Do not repeat it. Read back the thing it would have changed, say what you found, and only then decide.`,
                }
              : {}),
          },
        };
        participantSafeResult = participantError;
      }
      ambiguous ||= classification === "ambiguous";
      const current = this.transcript.readBindProjection(input.loopId);
      const loop = this.loop.loop();
      if (!current || !loop
        || loop.loop_id !== input.loopId
        || loop.status !== "executing"
        || loop.active_execution_id !== execution.runId
        || loop.active_execution_epoch !== execution.executionEpoch
        || loop.lease_owner !== execution.leaseOwner
        || loop.bind_state_revision !== current.stateRevision) {
        throw new Error("substream_loop_execution_fence_mismatch");
      }
      await this.transcript.commitRecoveredToolResult({
        transition: {
          kind: "tool_result_accepted",
          loopId: input.loopId,
          generation: current.generation,
          stateRevision: current.stateRevision + 1,
          message: {
            role: "tool",
            tool_call_id: call.providerToolCallId,
            content: JSON.stringify(result),
          },
          turnId: batch.turnId,
          toolCallId: call.providerToolCallId,
          callIndex: call.callIndex,
          resultOrdinal: batch.acceptedResultCount + offset,
          recoverySource: receipt ? "tool_receipt" : "not_run",
        },
        receiptToolCallId: call.receiptToolCallId,
        lifecycle: {
          toolName: receipt?.toolName ?? call.toolName,
          status: classification === "completed"
            ? "completed"
            : classification === "ambiguous" ? "ambiguous" : "failed",
          participantSafeResult,
          error: participantError,
        },
        settlesBatch: !hasWithheldElicitation && offset === recoverableCalls.length - 1,
        executionFence: {
          executionId: execution.runId,
          executionEpoch: execution.executionEpoch,
          leaseOwner: execution.leaseOwner,
          expectedBindStateRevision: loop.bind_state_revision,
        },
        now,
      });
    }
    await this.flushSemanticRealtimeOutboxBestEffort();
    // A withheld elicitation outranks a residual ambiguity, and the order is
    // load-bearing rather than cosmetic. While `ambiguous` failed the cycle
    // outright the two could not collide; now that it continues, reporting it
    // over `waiting_for_input` would discard the one state this repair
    // deliberately declines to settle — the elicitation's protocol result is
    // still withheld pending a human answer, so the assistant turn has a tool
    // call with no result, and entering the harness there hands the provider
    // exactly that. The ambiguity is already recorded either way: on the
    // receipt, in the transcript, and in the per-call line above.
    return hasWithheldElicitation
      ? "waiting_for_input"
      : ambiguous ? "ambiguous" : "recovered";
  }

  /**
   * A provider request cannot survive Durable Object eviction. If Bind had
   * already persisted the reservation, recovery closes that exact canonical
   * slot before any new provider call. Partial bytes stay only in the active
   * stream checkpoint and are removed by `stream_completed`; the immutable
   * status turn explains why the preview disappeared.
   */
  private async settleInterruptedAssistantReservation(
    input: WorkstreamWorkflowInput,
  ): Promise<"retry" | "stopped" | null> {
    const execution = this.activeLoopExecution;
    const loop = this.loop.loop();
    const reservation = this.loop.activeReservation();
    if (!reservation) return null;
    if (!execution || !loop
      || loop.loop_id !== input.loopId
      || loop.status !== "executing"
      || loop.active_execution_id !== execution.runId
      || loop.active_execution_epoch !== execution.executionEpoch
      || loop.lease_owner !== execution.leaseOwner
      || reservation.loop_id !== input.loopId) {
      throw new Error("assistant_reservation_recovery_fence_mismatch");
    }
    const stopped = loop.stop_requested_at !== null;
    const settled = await this.transcript.settleActiveAssistantReservation({
      loopId: input.loopId,
      executionId: execution.runId,
      executionEpoch: execution.executionEpoch,
      leaseOwner: execution.leaseOwner,
      outcome: stopped ? "stopped" : "failed",
      code: stopped ? "run_cancelled" : "assistant_turn_interrupted",
      label: stopped
        ? "Response stopped before it completed"
        : "Response interrupted before it completed",
    });
    if (!settled || settled.turnId !== reservation.turn_id
      || settled.transcriptSequence !== reservation.transcript_sequence) {
      throw new Error("assistant_reservation_recovery_fence_mismatch");
    }
    const turn = this.transcript.participantTurn(reservation.turn_id);
    if (!turn) throw new Error("assistant_reservation_recovery_turn_missing");
    await this.flushSemanticRealtimeOutboxBestEffort();
    await this.publishAgentRuntimeEvent({
      type: "stream_completed",
      streamId: reservation.stream_id,
    }).catch(() => undefined);
    // No assistant response was durably accepted, so no tool from this model
    // turn could have started. The failed reservation remains visible as the
    // honest record of the lost preview, while the same durable execution may
    // safely reserve its next turn and call the provider again.
    return stopped ? "stopped" : "retry";
  }

  private persistentLoopRuntime(
    input: WorkstreamWorkflowInput,
  ): NonNullable<NonNullable<Parameters<typeof runWorkstreamHarness>[3]>["persistentLoop"]> {
    const execution = this.activeLoopExecution;
    if (!execution || execution.runId !== input.harnessRunId) {
      throw new Error("substream_loop_execution_unavailable");
    }
    const fence = () => {
      const loop = this.loop.loop();
      if (!loop
        || loop.loop_id !== input.loopId
        || loop.status !== "executing"
        || loop.active_execution_id !== execution.runId
        || loop.active_execution_epoch !== execution.executionEpoch
        || loop.lease_owner !== execution.leaseOwner) {
        throw new Error("substream_loop_execution_fence_mismatch");
      }
      return loop;
    };
    return {
      completionVerificationSnapshot: () => {
        fence();
        return readCompletionVerificationSnapshot(this.state.storage, execution.runId, input.triggerMessageId ?? null);
      },
      contextWindowTokensByModel: () => this.contextWindowTokensByModel(),
      memoryDigest: (principal) => this.memoryDigestCopy(principal),
      assignSidekickSkillNames: (sources) => {
        fence();
        return this.state.storage.transactionSync(() => {
          const rows = this.state.storage.sql.exec<{ sidekick_id: string; name: string }>(
            `SELECT sidekick_id, name FROM sidekick_skill_names`,
          ).toArray();
          const assigned = new Map(rows.map((row) => [row.sidekick_id, row.name]));
          for (const entry of sidekickSkillCatalog(sources, assigned)) {
            if (assigned.has(entry.source.id)) continue;
            this.state.storage.sql.exec(
              `INSERT INTO sidekick_skill_names (sidekick_id, name) VALUES (?, ?)`,
              entry.source.id, entry.skill.name,
            );
            assigned.set(entry.source.id, entry.skill.name);
          }
          return assigned;
        });
      },
      readSidekickSkills: () => {
        fence();
        const row = this.state.storage.sql.exec<{ snapshot_json: string }>(
          `SELECT snapshot_json FROM sidekick_execution_skills WHERE execution_id = ?`, execution.runId,
        ).toArray()[0];
        return row ? SidekickSkillSnapshotSchema.parse(JSON.parse(row.snapshot_json)) : null;
      },
      // Only a Thread's conversation attached Sidekicks to itself.
      attachedSidekickIds: () => [],
      saveSidekickSkills: (snapshot) => {
        fence();
        this.state.storage.sql.exec(`INSERT OR IGNORE INTO sidekick_execution_skills (execution_id, snapshot_json) VALUES (?, ?)`,
          execution.runId, JSON.stringify(SidekickSkillSnapshotSchema.parse(snapshot)));
      },
      activateSidekickSkill: async (ref) => {
        fence();
        // A new attachment is part of this conversation's directory
        // projection, so it commits with the effect that tells the parent.
        await this.product.commitWithCommonEffect((sql) => {
          const row = sql.exec<{ snapshot_json: string }>(`SELECT snapshot_json FROM sidekick_execution_skills WHERE execution_id = ?`, execution.runId).one();
          const snapshot = SidekickSkillSnapshotSchema.parse(JSON.parse(row.snapshot_json));
          if (!snapshot.activeRefs.includes(ref)) snapshot.activeRefs.push(ref);
          sql.exec(`UPDATE sidekick_execution_skills SET snapshot_json = ? WHERE execution_id = ?`, JSON.stringify(snapshot), execution.runId);
          // Only a Thread's conversation filed a loaded Sidekick as attached.
          return false;
        });
      },
      projection: this.transcript.readBindProjection(input.loopId),
      validateHistoricalAssistantReservation: (projection) => {
        fence();
        return this.transcript.validateHistoricalAssistantReservation(projection);
      },
      modelIterationsUsed: this.loop.assistantTurnCountForExecution(execution.runId),
      // What the projection has considered, not the transcript's high-water
      // mark. A compaction checkpoint records this as the sequence it covers,
      // and a later bootstrap replays everything after it; the high-water mark
      // would have claimed turns the model never saw and lost them for good.
      transcriptThrough: this.transcript.transcriptProjectedThrough(),
      commitActivationInputs: async (boundary) => {
        if (boundary.loopId !== input.loopId
          || boundary.executionId !== execution.runId) {
          throw new Error("substream_loop_activation_boundary_mismatch");
        }
        fence();
        return this.transcript.commitActivationInputs({
          loopId: boundary.loopId,
          executionId: execution.runId,
          executionEpoch: execution.executionEpoch,
          leaseOwner: execution.leaseOwner,
          expectedBindGeneration: boundary.generation,
          expectedBindStateRevision: boundary.stateRevision,
          inputs: boundary.inputs,
        });
      },
      commitBindTransition: async (transition) => {
        const current = fence();
        await this.transcript.commitBindTransition(transition, undefined, {
          executionId: execution.runId,
          executionEpoch: execution.executionEpoch,
          leaseOwner: execution.leaseOwner,
          expectedBindStateRevision: current.bind_state_revision,
        }, (effects) => this.product.enqueueRegionalEffectsInTransaction(effects), () => {
          if (transition.kind === "protocol_user_appended"
            && transition.provenance.sourceKind === "completion_verification"
            && readCompletionVerificationSnapshot(this.state.storage, execution.runId, null).lifecycle === "cancelled") {
            throw new Error("completion_verification_stopped");
          }
        });
        await this.flushSemanticRealtimeOutboxBestEffort();
      },
      commitBindCompaction: async (compaction) => {
        const current = fence();
        const now = Date.now();
        await this.transcript.commitBindCompaction({
          ...compaction,
          now,
          // The ledger's residency transitions ride the checkpoint's commit:
          // either the compacted context carries the blocks and the ledger
          // says `system`, or neither happened.
          applyInTransaction: () => {
            this.residentContext.applyCompactionInTransaction(
              compaction.commit.transition.compactionEventId,
              now,
            );
          },
        }, {
          executionId: execution.runId,
          executionEpoch: execution.executionEpoch,
          leaseOwner: execution.leaseOwner,
          expectedBindStateRevision: current.bind_state_revision,
        });
        await this.flushSemanticRealtimeOutboxBestEffort();
      },
      renderResidentContext: () => {
        fence();
        return this.residentContext.renderSections();
      },
      prepareResidentContextCompaction: ({ compactionEventId, generation, stateRevision }) => {
        fence();
        const projection = this.transcript.readBindProjection(input.loopId);
        if (!projection || projection.generation !== generation || projection.stateRevision !== stateRevision) {
          throw new Error("bind_loop_head_conflict");
        }
        return {
          section: this.residentContext.prepareCompaction(compactionEventId, Date.now()),
          excludedMessagePositions: this.transcript.bindMessagePositionsBySourceKind(
            input.loopId,
            RESIDENT_CONTEXT_KINDS,
          ),
        };
      },
      reserveAssistantTurn: ({ turnId, modelTurnIndex, streamId }) => {
        const loop = fence();
        const result = this.loop.reserveAssistantTurn({
          executionId: execution.runId,
          executionEpoch: execution.executionEpoch,
          leaseOwner: execution.leaseOwner,
          expectedLoopRevision: loop.revision,
          receiptRunId: input.harnessRunId,
          turnId,
          modelTurnIndex,
          streamId,
          now: Date.now(),
        });
        if (result.outcome === "active_reservation" && result.reservation.turn_id !== turnId) {
          throw new Error("substream_loop_has_unmaterialized_turn");
        }
        return { transcriptSequence: result.reservation.transcript_sequence };
      },
      assistantOutputStarted: ({ turnId, transcriptSequence }) => {
        const reservation = this.loop.reservation(turnId);
        if (!reservation || reservation.transcript_sequence !== transcriptSequence) {
          throw new Error("workstream_stream_reservation_mismatch");
        }
        const current = fence();
        this.loop.startAssistantTurn({
          executionId: execution.runId,
          executionEpoch: execution.executionEpoch,
          leaseOwner: execution.leaseOwner,
          expectedLoopRevision: current.revision,
          turnId,
          now: Date.now(),
        });
      },
      settleAssistantFailure: async ({ outcome, code }) => {
        const settled = await this.transcript.settleActiveAssistantReservation({
          loopId: input.loopId,
          executionId: execution.runId,
          executionEpoch: execution.executionEpoch,
          leaseOwner: execution.leaseOwner,
          outcome,
          code,
          label: outcome === "stopped"
            ? "Response stopped before it completed"
            : "Response could not be completed",
        });
        if (settled) await this.flushSemanticRealtimeOutboxBestEffort();
        return settled;
      },
      settleStep: (step) => this.settlePersistentLoopStep(input, execution, step),
      heartbeat: () => {
        const current = fence();
        this.loop.heartbeatExecution({
          executionId: execution.runId,
          executionEpoch: execution.executionEpoch,
          leaseOwner: execution.leaseOwner,
          expectedLoopRevision: current.revision,
          leaseExpiresAt: Date.now() + LOOP_EXECUTION_LEASE_MS,
          now: Date.now(),
        });
      },
    };
  }

  private contextWindowTokensByModel(): Promise<Readonly<Record<string, number>>> {
    if (this.contextWindowSnapshot) return this.contextWindowSnapshot;
    const loading = loadOpenRouterContextWindows(this.env).then((windows) => {
      if (Object.keys(windows).length === 0 && this.contextWindowSnapshot === loading) {
        this.contextWindowSnapshot = null;
      }
      return windows;
    }, (error: unknown) => {
      if (this.contextWindowSnapshot === loading) this.contextWindowSnapshot = null;
      logWarn(this.env, "context_window_snapshot_read_failed", {
        reason: diagnosticErrorCode(error, "context_window_kv_read_failed"),
      });
      return {};
    });
    this.contextWindowSnapshot = loading;
    return loading;
  }

  private async settlePersistentLoopStep(
    input: WorkstreamWorkflowInput,
    execution: { runId: string; leaseOwner: string; executionEpoch: number },
    step: {
      loopId: string;
      executionId: string;
      assistantTurnId: string;
      modelTurnIndex: number;
      generation: number;
      stateRevision: number;
    },
  ) {
    const loop = this.loop.loop();
    if (!loop || loop.loop_id !== input.loopId || loop.loop_id !== step.loopId
      || loop.status !== "executing"
      || loop.active_execution_id !== execution.runId
      || loop.active_execution_epoch !== execution.executionEpoch
      || loop.lease_owner !== execution.leaseOwner
      || loop.bind_state_revision !== step.stateRevision) {
      throw new Error("substream_loop_step_fence_mismatch");
    }
    // Resident context blocks a tool recorded during the batch (a checkout's
    // AGENTS.md, say) are delivered here, ahead of any participant steer, and
    // their ledger rows are closed in the same commit that appends them.
    const now = Date.now();
    const pendingResidentContext = this.residentContext.pendingDeliveries();
    const settled = await this.transcript.settlePendingSteersAtStep({
      loopId: loop.loop_id,
      executionId: execution.runId,
      executionEpoch: execution.executionEpoch,
      leaseOwner: execution.leaseOwner,
      expectedLoopRevision: loop.revision,
      expectedStepOrdinal: loop.step_ordinal,
      expectedBindGeneration: step.generation,
      expectedBindStateRevision: step.stateRevision,
      assistantTurnId: step.assistantTurnId,
      modelTurnIndex: step.modelTurnIndex,
      enqueueRegionalEffectsInTransaction: (effects) =>
        this.product.enqueueRegionalEffectsInTransaction(effects),
      derivedInputs: pendingResidentContext.map((delivery) => ({
        key: delivery.sourceId,
        message: { role: "user", content: renderResidentContextBlock(delivery.block) },
        provenance: {
          originKind: "derived",
          sourceKind: delivery.sourceKind,
          sourceId: delivery.sourceId,
          sourceRevision: null,
        },
      })),
      markDerivedInputsDeliveredInTransaction: (keys) => {
        const delivered = new Set(keys);
        this.residentContext.markDeliveredInTransaction(
          pendingResidentContext.filter((delivery) => delivered.has(delivery.sourceId)),
          now,
        );
      },
      now,
    });
    await this.flushSemanticRealtimeOutboxBestEffort();
    return { transitions: settled.transitions, stop: settled.stop };
  }

  private persistAgentRunForExternalSettlement(
    input: WorkstreamWorkflowInput,
    rawOutcome: AgentTerminalOutcome,
  ): Promise<{
    status: WorkstreamHarnessResult["status"];
    errorCode: string | null;
    retryAt: number | null;
  }> {
    const outcome = AgentTerminalOutcomeSchema.parse(rawOutcome);
    const scheduled = this.state.storage.sql.exec<{ run_id: string }>(
      `UPDATE runs SET execution_available_at = ?, external_settled_at = NULL,
              last_settlement_error_code = NULL, updated_at = ?
        WHERE run_id = ? AND terminalized_at IS NOT NULL AND external_settled_at IS NULL
        RETURNING run_id`,
      Date.now(),
      Date.now(),
      input.harnessRunId,
    ).toArray()[0];
    // This continuation is deliberately not awaited by the persistent loop.
    // The terminal transcript and loop fence are already durable; external
    // delivery plus metadata maintenance have their own receipt and alarm.
    if (scheduled) {
      this.freshTerminalOutcomes.set(input.harnessRunId, outcome);
      this.resumeExternalSettlementDrain();
    }
    return Promise.resolve({
      status: outcome.status,
      errorCode: outcome.error?.code ?? null,
      retryAt: null,
    });
  }

  private async settleAgentRunWithRetry(
    executionEnv: Env,
    input: WorkstreamWorkflowInput,
    outcome: AgentTerminalOutcome,
  ): Promise<{
    status: WorkstreamHarnessResult["status"];
    errorCode: string | null;
    retryAt: number | null;
  }> {
    try {
      const settlementDiagnosticCode = await this.settleAgentRun(executionEnv, input, outcome);
      this.state.storage.sql.exec(
        `UPDATE runs SET external_settled_at = ?, execution_available_at = NULL,
                last_settlement_error_code = ?, updated_at = ?
          WHERE run_id = ? AND terminalized_at IS NOT NULL`,
        Date.now(),
        settlementDiagnosticCode,
        Date.now(),
        input.harnessRunId,
      );
      return {
        status: outcome.status,
        errorCode: outcome.error?.code ?? settlementDiagnosticCode,
        retryAt: null,
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "agent_run_settlement_failed";
      const attempt = this.state.storage.sql.exec<{ retry_count: number }>(
        `SELECT retry_count FROM runs WHERE run_id = ?`,
        input.harnessRunId,
      ).toArray()[0]?.retry_count ?? 0;
      const delay = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
      this.state.storage.sql.exec(
        `UPDATE runs SET retry_count = retry_count + 1, execution_available_at = ?,
                last_settlement_error_code = ?, updated_at = ? WHERE run_id = ?`,
        Date.now() + delay,
        code,
        Date.now(),
        input.harnessRunId,
      );
      logWarn(this.env, "substream_agent_settlement_failed", {
        workspace_id: input.workspaceId,
        workstream_id: input.parentId,
        substream_id: input.substreamId ?? "0",
        harness_run_id: input.harnessRunId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return { status: outcome.status, errorCode: code, retryAt: Date.now() + delay };
    }
  }

  private async loadTerminalOutcome(
    executionEnv: Env,
    input: WorkstreamWorkflowInput,
    status: WorkstreamHarnessResult["status"],
  ): Promise<AgentTerminalOutcome> {
    const row = await createHarnessRunObjectPort(executionEnv, input.workspaceId, input.parentId)
      .run({ runId: input.harnessRunId });
    const publishedStatus = row?.status === "cancelled" ? "stopped" : row?.status;
    if (!row || row.terminalized_at === null || publishedStatus !== status) {
      throw new Error("agent_terminal_outcome_missing");
    }
    let error: { code: string; message: string } | undefined;
    if (row.error_json) {
      try {
        const parsed = z.object({ code: z.string(), message: z.string() }).safeParse(
          JSON.parse(row.error_json),
        );
        if (parsed.success) error = parsed.data;
      } catch {
        // A malformed diagnostic must not block idempotent settlement. Status
        // and the canonical final turn remain authoritative.
      }
    }
    return AgentTerminalOutcomeSchema.parse({
      status,
      ...(row.final_turn_id ? { finalTurnId: row.final_turn_id } : {}),
      ...(error ? { error } : {}),
      // Receipt cancellation is provenance only. It can explain a terminal
      // stopped outcome, but must not change delivery behavior for a loop that
      // reached any other terminal state at its safe boundary.
      ...(status === "stopped" ? { cancellationReason: row.cancellation_reason } : {}),
    });
  }

  private async settleAgentRun(
    executionEnv: Env,
    input: WorkstreamWorkflowInput,
    outcome: AgentTerminalOutcome,
  ): Promise<string | null> {
    if (outcome.metrics) {
      recordHarnessRunObservation(this.env, {
        workspaceId: input.workspaceId,
        workstreamId: input.parentId,
        harnessRunId: input.harnessRunId,
        source: "workstream",
        status: outcome.status,
        ...(outcome.error ? { failureCode: outcome.error.code } : {}),
        metrics: outcome.metrics,
      });
    }
    emitCorrelatedRunOutcome(executionEnv, input);
    const canvaCleanupDiagnostic = await cleanupCanvaTransactions(executionEnv, input);

    const settlementDiagnosticCode = outcome.cancellationReason !== "superseded_by_follow_up"
      ? await this.deliverAgentRunResult(input, outcome)
      : null;
    // The memory sweep admits a Canvas's and a Sidekick's conversations. Two
    // single-row reads on most calls; a claim sends the window to the Queue
    // rather than calling the model here. Never throws.
    if (input.parentKind === "automation" || input.parentKind === "canvas") {
      await attemptMemorySweep(executionEnv, {
        workspaceId: input.workspaceId,
        parentKind: input.parentKind,
        parentId: input.parentId,
        substreamId: input.substreamId ?? "0",
      });
      // The next run of this principal here renders from this copy; the run
      // never reads WorkspaceDO for it. One WorkspaceDO call; never throws.
      await refreshMemoryDigestCopy(executionEnv, {
        workspaceId: input.workspaceId,
        parentKind: input.parentKind,
        parentId: input.parentId,
        substreamId: input.substreamId ?? "0",
      }, digestReaderFor(input));
    }
    return canvaCleanupDiagnostic ?? settlementDiagnosticCode;
  }

  /** Whether a run completed at least one send to another agent. A refused send is not a reply. */
  /**
   * Whether a run handed work or findings to another agent. An `ambiguous`
   * effect is a write whose admission may have committed while its
   * confirmation was lost, so a message that most likely landed counts;
   * reporting it as silence would invite the owner to resend it.
   */
  private runHandedOffToAgent(runId: string): boolean {
    return this.state.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM tool_effects
       WHERE run_id = ? AND status IN ('completed', 'ambiguous') AND tool_name IN (SELECT value FROM json_each(?))`,
      runId, JSON.stringify(AGENT_HANDOFF_TOOL_NAMES),
    ).one().count > 0;
  }

  private async deliverAgentRunResult(
    input: WorkstreamWorkflowInput,
    outcome: AgentTerminalOutcome,
  ): Promise<string | null> {
    const finalMessage = outcome.finalTurnId
      ? await this.product.messageForRuntime(outcome.finalTurnId)
      : null;
    const settlementDiagnosticCode = outcome.finalTurnId && !finalMessage
      ? "agent_final_turn_not_saved"
      : null;
    if (settlementDiagnosticCode) {
      // A null exact lookup is not a persistence race: the transcript write is
      // awaited before terminalization, and both reads address the same durable
      // authority. Preserve the diagnostic without leaving provider status and
      // reactions stuck behind an unbounded retry.
      logWarn(this.env, settlementDiagnosticCode, {
        workspace_id: input.workspaceId,
        workstream_id: input.parentId,
        harness_run_id: input.harnessRunId,
        final_turn_id: outcome.finalTurnId,
      });
    }
    if (input.backgroundAgent && outcome.status === "failed") {
      await new AgentCommunicationService(this.env, input).notifyFailure(outcome.error?.code ?? "unknown reason");
    }
    if (input.backgroundAgent && outcome.status === "completed" && !this.runHandedOffToAgent(input.harnessRunId)) {
      // A worker that finished without a word to anyone has left its owner
      // waiting on a reply that will never come. Say so once, as a failure is
      // said, and let the owner decide.
      await new AgentCommunicationService(this.env, input).notifySilentCompletion((await this.agentRuntimeInfo())?.name ?? null);
    }
    // Only a Thread's run had an external room (a Slack thread) waiting on
    // its outcome; a Canvas's and a Sidekick's results stay in Rally.
    return settlementDiagnosticCode;
  }

  private localRuntimeEnvironment(
    workspaceId: string,
    workstreamId: string,
    substreamId: string,
  ): Env {
    const routed = this.env;
    // Everything this object owns about this work stream, declared in one
    // place. A run executing here reaches each authority by holding it rather
    // than by resolving a name, and the next authority to move into an object
    // is added to `LocalWorkstreamAuthorities` instead of being given its own
    // mechanism — which is how the receipt authority came to be the one that
    // had none on 2026-08-24.
    if (!objectOwnsWorkstreamAuthorities(
      this.objectStore.identity(),
      this.externalSubstreamId(),
      { workspaceId, workstreamId, substreamId },
    )) return routed;
    // Each authority is installed as its *endpoint*, never as its storage: the
    // endpoint is what refuses a fenced object, commits the directory
    // projection with the row, and re-arms the alarm a wake-up write moved.
    // Handing down the tables would drop all three for the caller running
    // closest to them.
    const resident = (
      outcome: (body: unknown) => Promise<ObjectPortOutcome>,
    ): LocalAuthorityExecutor => async (operation, args) => (
      await outcome({ workspaceId, workstreamId, substreamId, operation, args })
    ).payload as { ok?: boolean; value?: unknown; error?: string };
    return withLocalWorkstreamAuthorities(routed, workspaceId, workstreamId, substreamId, {
      harnessRun: resident((body) => this.harnessRunOperationOutcome(body)),
      identity: resident((body) => this.identityOperationOutcome(body)),
      message: resident((body) => this.messageOperationOutcome(body)),
      resource: resident((body) => this.resourceOperationOutcome(body)),
      scheduling: resident((body) => this.schedulingOperationOutcome(body)),
      transcript: resident((body) => this.transcriptOperationOutcome(body)),
      toolReceipt: resident((body) => this.toolReceiptOperationOutcome(body)),
      residentContext: resident((body) => this.residentContextOperationOutcome(body)),
      desktopAction: (request) => this.requestDesktopAction(request),
      terminal: (operation, args) => this.runTerminalOperation({
        workspaceId,
        workstreamId,
        substreamId,
        operation,
        args,
      } as TerminalOperationRequest) as Promise<unknown>,
    });
  }

  private async publishAgentRuntimeEvent(event: Record<string, unknown>, delivery: "best_effort" | "required" = "best_effort"): Promise<void> {
    // A lower canonical sequence must reach the room before a later ephemeral
    // stream frame. If its durable drain is unavailable, best-effort events
    // rely on snapshot recovery; required delivery throws so its caller retries.
    if (this.semanticRealtimePending
      && !await this.flushSemanticRealtimeOutboxBestEffort()) {
      if (delivery === "required") throw new Error("canonical_realtime_pending");
      return;
    }
    const parsed = ServerSocketEventSchema.parse({
      ...event,
      sequence: 0,
      occurredAt: new Date().toISOString(),
    });
    const sequenced = await this.commitRealtimeEvent(parsed);
    await this.deliverCommittedRealtimeEvent(sequenced);
  }

  private async deliverCommittedRealtimeEvent(sequenced: ServerSocketEvent): Promise<void> {
    const encodedBytes = textEncoder.encode(JSON.stringify(sequenced)).byteLength;
    if (encodedBytes > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
      // The source row and canonical transcript turn are already durable by
      // the time publication runs. Reporting a failed mutation here would be
      // false, and an idempotent retry cannot republish an append it correctly
      // recognizes as a replay. Mark this sequence unavailable and make every
      // subscribed reader repair from the canonical snapshot immediately.
      this.replayFloorSequence = sequenced.sequence;
      for (const socket of this.state.getWebSockets()) {
        const attachment = this.readAttachment(socket);
        if (!attachment?.subscribed) continue;
        try {
          this.sendResyncRequired(socket, sequenced.sequence, "history_unavailable");
        } catch {
          // A stale socket cannot turn a committed mutation into a failure.
        }
      }
    } else {
      this.recordRecentEvent(sequenced);
      this.broadcast(sequenced);
    }
  }

  private async semanticRealtimeEvent(
    pending: SequencedSemanticRealtimeReference,
    profiles?: ReadonlyMap<string, User>,
  ): Promise<ServerSocketEvent> {
    const base = {
      sequence: pending.sequence,
      occurredAt: pending.occurredAtUtc,
    };
    switch (pending.reference.kind) {
      case "participant_changed": {
        const userId = pending.reference.userId;
        const participant = await this.product.participant(userId, profiles?.has(userId) ? profiles : undefined);
        // Profile hydration yields. Recheck local authority before publishing,
        // including when a deferred join was overtaken by a removal.
        if (!this.product.isParticipant(userId)) {
          return ServerSocketEventSchema.parse({ ...base, type: "participant_removed", userId });
        }
        if (!participant) throw new Error("semantic_realtime_participant_missing");
        return ServerSocketEventSchema.parse({ ...base, type: "participant_added", participant });
      }
      case "elicitation_cancelled": {
        const elicitation = this.product.elicitationById(pending.reference.elicitationId);
        if (!elicitation) throw new Error("semantic_realtime_elicitation_missing");
        return ServerSocketEventSchema.parse({
          ...base,
          type: "elicitation_answered",
          elicitation,
        });
      }
      case "transcript_turn": {
        const turn = this.transcript.participantTurn(pending.reference.turnId);
        if (!turn) throw new Error("semantic_realtime_turn_missing");
        return ServerSocketEventSchema.parse({
          ...base,
          type: "transcript_turn_upserted",
          turn,
        });
      }
      case "loop_input_upserted": {
        const input = this.transcript.pendingTranscriptInput(pending.reference.inputId);
        if (!input) {
          // The upsert reference can precede an atomic promotion in the durable
          // outbox. The minimal delivery receipt lets that stale reference
          // converge the client by removal without retaining the full overlay.
          const delivered = this.loop.deliveredInput(pending.reference.inputId);
          if (!delivered) throw new Error("semantic_realtime_loop_input_missing");
          return ServerSocketEventSchema.parse({
            ...base,
            type: "loop_input_removed",
            inputId: delivered.input_id,
            outcome: "delivered",
          });
        }
        return ServerSocketEventSchema.parse({
          ...base,
          type: "loop_input_upserted",
          input,
        });
      }
      case "loop_input_removed":
        return ServerSocketEventSchema.parse({
          ...base,
          type: "loop_input_removed",
          inputId: pending.reference.inputId,
          outcome: pending.reference.outcome,
        });
      case "transcript_activity": {
        const activity = this.transcript.transcriptActivity(
          pending.reference.activityId,
          Date.parse(pending.reference.snapshotAtUtc),
        );
        if (!activity) throw new Error("semantic_realtime_activity_missing");
        return ServerSocketEventSchema.parse({
          ...base,
          type: "transcript_activity_upserted",
          activity,
          snapshotAtUtc: pending.reference.snapshotAtUtc,
        });
      }
    }
  }

  /** Internal delivery only. Content is allowlisted before it leaves this authority. */
  async conversationViewProjection(input: unknown) {
    await this.storageReady;
    const request = parseRpcInput(ConversationViewJobSchema, input, "conversation_view_job");
    if (!this.objectStore.isAuthoritative()) return null;
    this.searchProjectionIdentity(request);
    const root = this.identityRows.identity();
    if (!root) return null;
    const sql = this.state.storage.sql;
    const version = sql.exec<{ revision: number; generation: number }>(
      `SELECT c.revision, w.authority_generation AS generation
       FROM conversation_view_clock c, workstream w WHERE c.id = 1 AND w.id = 1`,
    ).one();
    const row = request.turnId ? sql.exec<{ transcript_sequence: number }>(
      "SELECT transcript_sequence FROM participant_transcript_turns WHERE turn_id = ?", request.turnId,
    ).toArray()[0] : undefined;
    const now = Date.now();
    const content = row ? projectConversationView(this.transcript.range({
      snapshotId: uuidV7(now), snapshotThrough: row.transcript_sequence, snapshotAtUtc: new Date(now).toISOString(),
    }, { startInclusive: row.transcript_sequence, endExclusive: row.transcript_sequence + 1 })) : null;
    return parseRpcInput(ConversationViewProjectionSchema, {
      ...request, ...version,
      header: {
        title: root.title, titleStatus: root.title_status, scope: root.scope,
        harnessStatus: this.product.runtimeStatus(),
        createdAt: new Date(root.created_at).toISOString(), updatedAt: new Date(root.updated_at).toISOString(),
      },
      content,
    }, "conversation_view_projection");
  }

  async completeConversationView(input: unknown): Promise<void> {
    await this.storageReady;
    const request = parseRpcInput(ConversationViewDeliverySchema, input, "conversation_view_delivery");
    if (!this.objectStore.identity()) return;
    this.searchProjectionIdentity(request);
    completeConversationViewDelivery(this.state.storage.sql, request);
    const next = nextConversationViewAt(this.state.storage.sql);
    if (next !== null) await this.ensureAlarmNoLaterThan(next);
  }

  async backfillConversationView(input: unknown): Promise<"queued" | "delivered" | "missing"> {
    await this.storageReady;
    const request = parseRpcInput(ConversationViewJobSchema, input, "conversation_view_backfill");
    // An identity-only placeholder has no readable product state. Its pending
    // migration header must not hold every later child of this parent behind it.
    // Activation retains the ledger and the ordinary projection lane drains it.
    if (!this.objectStore.isAuthoritative()) return "missing";
    this.searchProjectionIdentity(request);
    const next = nextConversationViewAt(this.state.storage.sql);
    if (next !== null) await this.ensureAlarmNoLaterThan(next);
    return this.state.storage.sql.exec(
      "SELECT 1 FROM conversation_view_changes WHERE pending = 1 LIMIT 1",
    ).toArray().length ? "queued" : "delivered";
  }

  private async flushConversationViews(): Promise<void> {
    const identity = this.objectStore.identity();
    if (!identity) return;
    try {
      await publishConversationViews(this.state.storage.sql, this.env.ACTIVITY_QUEUE, {
        type: "conversation_view_v1", region: this.env.AVALON_REGION,
        workspaceId: identity.workspaceId, parentId: identity.parentId, substreamId: this.externalSubstreamId(),
      });
    } catch (error) {
      logWarn(this.env, "conversation_view_dispatch_deferred", {
        workspace_id: identity.workspaceId, reason: diagnosticErrorCode(error, "conversation_view_dispatch_failed"),
      });
    }
    const next = nextConversationViewAt(this.state.storage.sql);
    if (next !== null) await this.ensureAlarmNoLaterThan(next);
  }

  private async searchTurnIdentity(input: unknown) {
    await this.storageReady;
    const request = SearchProjectionMessageSchema.parse(input);
    return { request, identity: this.searchProjectionIdentity(request) };
  }

  /** A search job names one conversation; this object answers only for itself. */
  private searchProjectionIdentity(request: { region: string; workspaceId: string; parentId: string; substreamId: string }) {
    const identity = this.objectStore.identity();
    if (!identity || request.region !== this.env.AVALON_REGION
      || request.workspaceId !== identity.workspaceId || request.parentId !== identity.parentId
      || request.substreamId !== this.externalSubstreamId()) throw new Error("search_projection_identity_mismatch");
    return identity;
  }

  /** What every indexed row of this conversation shows for it: read beside the text, never cached. */
  private currentConversationDisplay(): ConversationDisplay | null {
    const row = this.identityRows.identity();
    return row ? { title: row.title, archived: row.archived_at != null } : null;
  }

  /** Internal Queue consumer entrypoint: the display a conversation's indexed rows must carry now. */
  async searchConversationDisplay(input: unknown): Promise<ConversationDisplay | null> {
    await this.storageReady;
    this.searchProjectionIdentity(SearchConversationProjectionMessageSchema.parse(input));
    return this.currentConversationDisplay();
  }

  /** Identity-only discovery keeps sibling bodies out of the source delivery. */
  async searchTurnDocumentIds(input: unknown) {
    const { request, identity } = await this.searchTurnIdentity(input);
    const links = await conversationSearchDocumentIds(this.state.storage.sql,
      { ...identity, substreamId: request.substreamId }, request.turnId,
      () => this.transcript.participantTurn(request.turnId));
    return [await searchDocumentId('messages', identity.parentId, `${request.substreamId}/${request.turnId}`), ...links];
  }

  /** Internal Queue consumer entrypoint; never mounted on the public API. */
  async prepareSearchTurn(input: unknown, captureLinks = true) {
    return this.prepareSearchTurnSource(input, captureLinks);
  }

  /** A distinct RPC makes old instances fail/retry instead of ignoring a target. */
  async prepareSearchTurnDocument(input: unknown, documentId: unknown, captureLinks = true) {
    return this.prepareSearchTurnSource(input, captureLinks, z.string().min(1).parse(documentId));
  }

  private async prepareSearchTurnSource(input: unknown, captureLinks: boolean, documentId?: string) {
    const { request, identity } = await this.searchTurnIdentity(input);
    const links = await prepareConversationLinks(this.state.storage.sql, this.env,
      { ...identity, substreamId: request.substreamId }, request.turnId,
      () => this.transcript.participantTurn(request.turnId), captureLinks, documentId,
      () => this.currentConversationDisplay());
    // Capture awaits external I/O, so read the message and its conversation only after extraction.
    const turn = this.transcript.participantTurn(request.turnId);
    const conversation = this.currentConversationDisplay();
    const sourceId = `${request.substreamId}/${request.turnId}`;
    const id = await searchDocumentId("messages", identity.parentId, sourceId);
    const live = turn?.entryKind === "conversation" ? turn : null;
    if (documentId === undefined || documentId === id) links.documents.unshift({ id, source: "messages", sourceId, scopeId: identity.parentId,
      substreamId: request.substreamId,
      ...(live ? { audience: conversationSearchAudience({ parentKind: identity.parentKind, parentId: identity.parentId,
        substreamId: request.substreamId }) } : {}),
      revision: turn?.revision ?? request.revision,
      text: live ? live.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n") : null,
      // The result renders from the index: the conversation title, when the
      // message was sent, and where it sits in the transcript travel with it.
      ...(live && conversation ? { display: { title: conversation.title, sourceLabel: conversation.title,
        occurredAt: Date.parse(live.createdAtUtc), transcriptSequence: live.transcriptSequence,
        url: null, mimeType: null, archived: conversation.archived } } : {}) });
    return links;
  }

  /**
   * This conversation's memory digest copy for one principal, read
   * synchronously and never refreshed here: the settlement step, the sweep, a
   * forget, a Sidekick run's provisioning, and the copy-sync lane refresh it. An unreadable copy renders no
   * digest rather than failing the run, and names the field it rejected.
   * See docs/agent-memory.md#the-digest.
   */
  private memoryDigestCopy(principal: string): MemoryDigestFact[] | null {
    try {
      return this.scheduling.memoryDigestCopy(principal);
    } catch (error) {
      logWarn(this.env, "memory_digest_copy_unreadable", {
        substream_id: this.externalSubstreamId(),
        reason: zodDiagnosticCode(error, "memory_digest_copy") ?? diagnosticErrorCode(error, "memory_digest_copy_unreadable"),
      });
      return null;
    }
  }

  /**
   * Deliver the outbound bindings this run child's sends committed, to the
   * WorkspaceDO that routes their replies. WorkspaceDO's write is idempotent,
   * so a row delivered twice is `already_bound`.
   */
  private async flushExternalBindingOutbox(): Promise<void> {
    const identity = this.objectStore.identity();
    if (!identity) return;
    try {
      const workspace = await durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS,
        identity.workspaceId, workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(identity.workspaceId)));
      // The thread routes to this run child: the conversation whose receipt
      // committed the row.
      const target = {
        kind: "conversation" as const,
        parentKind: identity.parentKind,
        parentId: identity.parentId,
        substreamId: this.externalSubstreamId(),
      };
      const report = await drainExternalBindingOutbox(this.state.storage.sql, (binding) =>
        workspace.recordOutboundExternalConversationBinding({
          workspaceId: identity.workspaceId,
          installationId: binding.installationId,
          path: binding.path,
          target,
          at: binding.at,
        }));
      for (const [event, rows] of [
        ["external_binding_delivery_dead", report.dead],
        ["external_binding_delivery_deferred", report.deferred],
      ] as const) {
        for (const row of rows) {
          logWarn(this.env, event, {
            workspace_id: identity.workspaceId,
            workstream_id: identity.parentId,
            substream_id: this.externalSubstreamId(),
            message_id: row.messageId,
            reason: row.code,
          });
        }
      }
    } catch (error) {
      logWarn(this.env, "external_binding_delivery_deferred", {
        workspace_id: identity.workspaceId,
        workstream_id: identity.parentId,
        substream_id: this.externalSubstreamId(),
        reason: diagnosticErrorCode(error, "external_binding_delivery_failed"),
      });
    }
    const next = nextExternalBindingDueAt(this.state.storage.sql);
    if (next !== null) await this.ensureAlarmNoLaterThan(next);
  }

  private async flushSearchProjectionOutbox(): Promise<void> {
    if (!searchIndexingConfigured(this.env)) return;
    const identity = this.objectStore.identity();
    if (!identity) return;
    try {
      await drainSearchProjectionOutbox(this.state.storage.sql, this.env.ACTIVITY_QUEUE, {
        region: this.env.AVALON_REGION, workspaceId: identity.workspaceId,
        parentId: identity.parentId, substreamId: this.externalSubstreamId(),
      });
    } catch {
      logWarn(this.env, "search_projection_dispatch_deferred", { workspace_id: identity.workspaceId });
    }
    const next = nextSearchProjectionDueAt(this.state.storage.sql, this.env);
    if (next !== null) await this.ensureAlarmNoLaterThan(next);
  }

  /**
   * Deliver one ordered batch. An outbox row is acknowledged only after the
   * semantic frame has been accepted locally. Replaying the same sequence after
   * a crash is harmless at the client cursor and deduplicated in this isolate.
   */
  private async drainSemanticRealtimeOutbox(profiles?: ReadonlyMap<string, User>): Promise<void> {
    const pending = this.objectStore.dueSemanticRealtime();
    for (const reference of pending) {
      try {
        const event = await this.semanticRealtimeEvent(reference, profiles);
        await this.deliverCommittedRealtimeEvent(event);
        if (!this.objectStore.acknowledgeSemanticRealtime(reference.messageId, reference.sequence)) {
          throw new Error("semantic_realtime_acknowledgement_lost");
        }
      } catch (error) {
        this.objectStore.deferSemanticRealtime(
          reference.messageId,
          reference.sequence,
          Date.now() + SEMANTIC_REALTIME_RETRY_MS,
        );
        throw error;
      }
    }
  }

  /** Accepted canonical state never reports failure because its room cache did. */
  private async flushSemanticRealtimeOutboxBestEffort(profiles?: ReadonlyMap<string, User>): Promise<boolean> {
    // Set before the first await so an interleaving token/presence request
    // cannot allocate past a canonical predecessor this drain is discovering.
    this.semanticRealtimePending = true;
    try {
      await this.drainSemanticRealtimeOutbox(profiles);
    } catch (error) {
      logWarn(this.env, "substream_semantic_realtime_deferred", {
        substream_id: this.externalSubstreamId(),
        reason: diagnosticErrorCode(error, "semantic_realtime_delivery_failed"),
      });
    }
    const authzDueAt = nextAuthorizationProjectionAt(this.state.storage.sql);
    if (authzDueAt !== null) await this.ensureAlarmNoLaterThan(authzDueAt);
    const viewDueAt = nextConversationViewAt(this.state.storage.sql);
    if (viewDueAt !== null) await this.ensureAlarmNoLaterThan(viewDueAt);
    const searchDueAt = nextSearchProjectionDueAt(this.state.storage.sql, this.env);
    if (searchDueAt !== null) await this.ensureAlarmNoLaterThan(searchDueAt);
    const nextDueAt = this.objectStore.nextSemanticRealtimeDueAt();
    this.semanticRealtimePending = nextDueAt !== null;
    if (nextDueAt !== null) {
      try {
        await this.ensureAlarmNoLaterThan(nextDueAt);
      } catch (error) {
        logWarn(this.env, "substream_semantic_realtime_alarm_deferred", {
          substream_id: this.externalSubstreamId(),
          reason: diagnosticErrorCode(error, "semantic_realtime_alarm_failed"),
        });
      }
      return false;
    }
    return true;
  }

  override async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const requestReceivedAt = Date.now();
    await this.storageReady;
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let decoded: unknown;

    try {
      decoded = JSON.parse(raw);
    } catch {
      this.sendError(socket, "invalid_json", "Socket messages must be JSON.");
      return;
    }

    const recognizableCreate = recognizableSocketCreateMessage(decoded);
    if (recognizableCreate?.overLong) {
      this.sendSocketCommandResult(socket, {
        type: "client_command_failed",
        command: "create_message",
        operationId: recognizableCreate.operationId,
        clientMessageId: recognizableCreate.clientMessageId,
        error: { status: 400, code: "message_too_long", message: MESSAGE_TOO_LONG_MESSAGE },
      });
      return;
    }

    if (isUnknownSocketEvent(decoded, ClientSocketEventTypeSchema)) return;
    const parsed = safeParseSocketEvent(ClientSocketEventSchema, decoded);
    if (!parsed.success) {
      const tooLarge = parsed.error.issues.some((issue) => issue.code === 'custom' && issue.message === 'annotations_too_large');
      const rejection = { status: tooLarge ? 422 : 400, code: tooLarge ? 'annotations_too_large' : zodDiagnosticCode(parsed.error,'invalid_event') ?? 'invalid_event', message: tooLarge ? 'These pins are too large to send together' : 'The socket event contains an invalid field.' };
      const recognizableMutation = recognizableSocketMutation(decoded);
      if (recognizableMutation) {
        this.sendSocketCommandResult(socket, {
          type: "client_command_failed",
          command: recognizableMutation.command,
          operationId: recognizableMutation.operationId,
          ...(recognizableMutation.clientMessageId
            ? { clientMessageId: recognizableMutation.clientMessageId }
            : {}),
          error: rejection,
        });
        return;
      }
      this.sendError(socket, "invalid_event", `${rejection.code}: ${rejection.message}`);
      return;
    }

    const attachment = this.readAttachment(socket);
    if (!attachment) {
      socket.close(1011, "Missing connection identity");
      return;
    }
    if (parsed.data.type === "subscribe") {
      const authority = await readWorkstreamAuthorityControl(this.env);
      if (!acceptsNewWorkstreamWork(authority) || !this.objectStore.isRealtimeWritable()) {
        disconnect(socket, 1012, "Work stream maintenance");
        return;
      }
      // The subscription is the half of opening a work stream that a person
      // actually waits on, and it arrives on its own invocation — hence its own
      // trace, joined to the upgrade's by `rally.socket.connection_id`.
      const afterSequence = parsed.data.afterSequence;
      const publishPresence = parsed.data.publishPresence;
      socket.serializeAttachment({
        ...attachment,
        publishPresence,
      } satisfies SocketAttachment);
      await inFlowSpan(this.env, "workstream.room.socket.subscribe", {
        flow: "workstream_open",
        component: "substream_do",
        identity: {
          workspaceId: attachment.workspaceId,
          workstreamId: attachment.workstreamId,
          userId: attachment.userId,
          substreamId: attachment.substreamId,
        },
        attributes: {
          "rally.socket.connection_id": attachment.connectionId,
          "rally.socket.after_sequence": afterSequence,
        },
      }, async (span) => {
        const subscribed = await this.fulfillSubscription(
          socket,
          attachment.workspaceId,
          attachment.workstreamId,
          afterSequence,
          span,
        );
        if (subscribed && publishPresence) {
          await span.step("workstream.room.socket.broadcast_presence", () =>
            this.broadcastPresence(attachment.workspaceId, attachment.workstreamId));
        }
      });
      return;
    }

    if (parsed.data.type === "mark_opened") {
      if (!attachment.speculative) return;
      const auth = await this.socketViewerAuth(attachment);
      if (!auth || !this.product.canRead(attachment.userId)) {
        disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "Work stream access revoked");
        return;
      }
      await this.product.markOpenedAdmitted(auth);
      socket.serializeAttachment({
        ...attachment,
        speculative: false,
      } satisfies SocketAttachment);
      return;
    }

    if (parsed.data.type === "request_snapshot") {
      await this.fulfillSnapshotRequest(socket, attachment);
      return;
    }

    if (parsed.data.type === "load_transcript_range") {
      await this.fulfillTranscriptRange(socket, attachment, parsed.data);
      return;
    }

    // Everything from here on writes. A support session's commands are
    // audited in the background, never ahead of the command itself.
    if (attachment.impersonatorUserId && attachment.sessionId) {
      this.state.waitUntil(recordSupportAction(this.env, {
        workspaceId: attachment.workspaceId,
        impersonatorUserId: attachment.impersonatorUserId,
        representedUserId: attachment.userId,
        sessionId: attachment.sessionId,
        action: "support_session.socket_command",
        workstreamId: attachment.workstreamId,
        metadata: { command: parsed.data.type, substreamId: attachment.substreamId },
      }));
    }

    if (parsed.data.type === "create_message") {
      await this.createSocketMessage(socket, attachment, parsed.data, requestReceivedAt);
      return;
    }
    if (parsed.data.type === "answer_desktop_action") {
      this.answerDesktopAction(socket, attachment, parsed.data.actionId, parsed.data.outcome);
      return;
    }
    await this.mutateSocketSubstream(socket, attachment, parsed.data);
  }

  /**
   * Who may answer this conversation's desktop actions: the person it was
   * created for. A desktop action runs in that person's own browser session,
   * so an answer from anyone else is not theirs to give.
   */
  private answersDesktopActions(userId: string): boolean {
    const creator = this.identityRows.identity()?.created_by_user_id ?? null;
    return creator !== null && creator === userId;
  }

  /**
   * Record a tool's desktop action, publish it, and wait for the answer.
   *
   * The row is written before the request is published, so an answer can
   * never arrive for an action this object has no record of. A call whose
   * earlier attempt was already answered returns that answer without asking
   * again; one still pending is published again, because the desktop that
   * received it before may have gone.
   */
  private async requestDesktopAction(input: {
    runId: string;
    toolCallId: string;
    action: DesktopAction;
    signal: AbortSignal;
  }): Promise<DesktopActionOutcome> {
    input.signal.throwIfAborted();
    const recorded = this.desktopActions.request({
      id: uuidV7(Date.now()),
      runId: input.runId,
      toolCallId: input.toolCallId,
      action: input.action,
      now: Date.now(),
    });
    if (recorded.status === "answered") return recorded.outcome;
    const { request } = recorded;
    return await new Promise<DesktopActionOutcome>((resolve, reject) => {
      const stopWaiting = () => {
        this.desktopActionWaiters.delete(request.id);
        this.desktopActions.abandon(request.id);
        reject(input.signal.reason instanceof Error ? input.signal.reason : new Error("desktop_action_abandoned"));
      };
      input.signal.addEventListener("abort", stopWaiting, { once: true });
      this.desktopActionWaiters.set(request.id, (outcome) => {
        input.signal.removeEventListener("abort", stopWaiting);
        this.desktopActionWaiters.delete(request.id);
        resolve(outcome);
      });
      // Published after the waiter exists, so an answer that comes back before
      // this call returns still finds it.
      void this.publishAgentRuntimeEvent({ type: "desktop_action_requested", request }).catch((error: unknown) => {
        // The row is pending and is offered again to the next subscriber, so a
        // lost publication delays the action rather than losing it.
        logWarn(this.env, "desktop_action_publication_failed", {
          workstream_id: this.objectStore.identity()?.parentId ?? null,
          substream_id: this.externalSubstreamId(),
          action_id: request.id,
          reason: diagnosticErrorCode(error, "desktop_action_publication_failed"),
        });
      });
    });
  }

  private answerDesktopAction(
    socket: WebSocket,
    attachment: SocketAttachment,
    actionId: string,
    answered: DesktopActionOutcome,
  ): void {
    if (!this.answersDesktopActions(attachment.userId)) {
      this.sendError(socket, "desktop_action_forbidden", "Only the person this conversation works for can answer its desktop actions.");
      return;
    }
    // Every answer is recorded before it is used; one the row cannot hold is
    // recorded as a failure the model can act on rather than a write that throws.
    const result = this.desktopActions.answer({
      id: actionId,
      outcome: answered,
      answeredByUserId: attachment.userId,
      now: Date.now(),
    });
    if (result.status === "unknown") {
      this.sendError(socket, "desktop_action_not_found", "No desktop action has that id.");
      return;
    }
    if (result.status === "answered") this.desktopActionWaiters.get(actionId)?.(result.outcome);
  }

  /**
   * Offer a subscriber the actions still waiting on a desktop. Not sequenced
   * events: each is a re-send of one already published, so it carries the
   * subscriber's delivered sequence and a desktop acts on it by id.
   */
  private offerPendingDesktopActions(socket: WebSocket, userId: string, deliveredThrough: number): void {
    if (!this.answersDesktopActions(userId)) return;
    const occurredAt = new Date().toISOString();
    const unreadable = (id: string, code: string, outcome: DesktopActionOutcome) => {
      logWarn(this.env, "desktop_action_unreadable", { action_id: id, error_code: code });
      this.desktopActionWaiters.get(id)?.(outcome);
    };
    for (const request of this.desktopActions.pending(unreadable)) {
      socket.send(JSON.stringify({ type: "desktop_action_requested", request, sequence: deliveredThrough, occurredAt }));
    }
  }

  private async mutateSocketSubstream(
    socket: WebSocket,
    attachment: SocketAttachment,
    command: Exclude<z.infer<typeof ClientSocketEventSchema>,
      { type: "subscribe" | "mark_opened" | "request_snapshot" | "load_transcript_range" | "create_message" | "answer_desktop_action" }>,
  ): Promise<void> {
    await inSpan("workstream.room.substream_command", {
      "rally.component": "substream_do",
      ...identityAttributes({
        workspaceId: attachment.workspaceId,
        workstreamId: attachment.workstreamId,
        substreamId: attachment.substreamId,
        userId: attachment.userId,
        sessionId: attachment.sessionId,
      }),
      "rally.transport": "substream_socket",
      "rally.socket.connection_id": attachment.connectionId,
      "rally.socket.command": command.type,
      "rally.socket.operation_id": command.operationId,
    }, async (span) => this.mutateSocketSubstreamInSpan(socket, attachment, command, span));
  }

  private async mutateSocketSubstreamInSpan(
    socket: WebSocket,
    attachment: SocketAttachment,
    command: Exclude<z.infer<typeof ClientSocketEventSchema>,
      { type: "subscribe" | "mark_opened" | "request_snapshot" | "load_transcript_range" | "create_message" | "answer_desktop_action" }>,
    span: TracedSpan,
  ): Promise<void> {
    try {
      if (!this.objectStore.isRealtimeWritable()) {
        throw new ApiError(503, "workstream_maintenance", "Threads are temporarily unavailable");
      }
      assertParentWritable(attachment);
      const auth = await this.socketViewerAuth(attachment);
      if (!auth) {
        disconnect(socket, 1012, "Reconnect for substream commands");
        return;
      }
      const identity = this.objectStore.identity();
      if (!identity) throw new ApiError(404, "workstream_not_found", "Thread not found");

      if (command.type === "answer_elicitation") {
        const result = await this.product.answerElicitationForAdmittedSocket(
          auth,
          command.elicitationId,
          command.payload,
        );
        if (result.activationRequest) {
          try {
            await this.requestPersistentLoopActivation(result.activationRequest);
          } catch (error) {
            logWarn(this.env, "substream_elicitation_activation_wakeup_failed", {
              workspace_id: attachment.workspaceId,
              workstream_id: attachment.workstreamId,
              substream_id: attachment.substreamId,
              elicitation_id: command.elicitationId,
              reason: diagnosticErrorCode(error, "activation_wakeup_failed"),
            });
          }
        }
        if (result.inserted && result.elicitation) {
          try {
            await this.publishLocalProductEvent(identity, {
              type: "elicitation_answered",
              elicitation: result.elicitation,
            });
          } catch (error) {
            logWarn(this.env, "substream_elicitation_publication_failed_after_commit", {
              workspace_id: attachment.workspaceId,
              workstream_id: attachment.workstreamId,
              substream_id: attachment.substreamId,
              elicitation_id: command.elicitationId,
              reason: diagnosticErrorCode(error, "elicitation_publication_failed"),
            });
          }
        }
        await this.flushSemanticRealtimeOutboxBestEffort();
        this.sendSocketCommandResult(socket, {
          type: "client_command_succeeded",
          command: command.type,
          operationId: command.operationId,
          ...(result.elicitation ? { elicitation: result.elicitation } : {}),
        });
        return;
      }
      if (command.type === "set_workstream_appearance") {
        // A Thread's icon and colour; a Canvas's and a Sidekick's conversation has none.
        throw new ApiError(403, "main_conversation_required", "This conversation has no appearance to change");
      }
      if (command.type === "reorder_pending_inputs") {
        const result = await this.product.reorderPendingInputsForAdmittedSocket(
          auth,
          command.operationId,
          command.inputIds,
        );
        await this.flushSemanticRealtimeOutboxBestEffort();
        this.sendSocketCommandResult(socket, {
          type: "client_command_succeeded",
          command: command.type,
          operationId: command.operationId,
          pendingInputs: result.pendingInputs,
        });
        return;
      }
      if (command.type === "stop_harness") {
        await this.product.stopForAdmittedSocket(auth, command.operationId);
        this.sendSocketCommandResult(socket, {
          type: "client_command_succeeded",
          command: command.type,
          operationId: command.operationId,
        });
        return;
      }

      const result = await this.product.retryForAdmittedSocket(
        auth,
        asHarnessRunId(command.operationId),
      );
      try {
        await this.requestPersistentLoopActivation(result.activationRequest);
      } catch (error) {
        logWarn(this.env, "substream_retry_activation_wakeup_failed", {
          workspace_id: attachment.workspaceId,
          workstream_id: attachment.workstreamId,
          substream_id: attachment.substreamId,
          harness_run_id: result.harnessRunId,
          reason: diagnosticErrorCode(error, "activation_wakeup_failed"),
        });
      }
      this.sendSocketCommandResult(socket, {
        type: "client_command_succeeded",
        command: command.type,
        operationId: command.operationId,
        harnessRunId: result.harnessRunId,
      });
    } catch (error) {
      const diagnostic = zodDiagnosticCode(error, 'substream_command');
      const annotationsTooLarge = error instanceof z.ZodError && error.issues.some((issue) => issue.code === 'custom' && issue.message === 'annotations_too_large');
      const safe = error instanceof ApiError ? error
        : annotationsTooLarge ? new ApiError(422, 'annotations_too_large', 'These pins are too large to send together')
          : diagnostic ? new ApiError(500, diagnostic, 'Stored command data contains an invalid field')
            : new ApiError(500, "substream_command_failed", "The substream command could not be completed");
      this.sendSocketCommandResult(socket, {
        type: "client_command_failed",
        command: command.type,
        operationId: command.operationId,
        error: {
          status: safe.status,
          code: safe.code,
          message: safe.message,
          ...(safe.details ? { details: safe.details } : {}),
        },
      });
      if (!(error instanceof ApiError)) {
        // The only account of a throw the person receives as a flat
        // `substream_command_failed`, so `reason` is a code that groups rather
        // than a message that does not — a `ZodError`'s is multi-line JSON, and
        // `diagnosticErrorCode` keeps an arbitrary runtime message out of an
        // indexed field. Issue paths and codes are schema shape, not member
        // data, as `request_failed` already treats them. See the failure-mode
        // row in `docs/workstream-durable-object.md`.
        const validation = error instanceof z.ZodError ? error : null;
        logWarn(this.env, "substream_socket_command_failed", {
          workspace_id: attachment.workspaceId,
          workstream_id: attachment.workstreamId,
          substream_id: attachment.substreamId,
          user_id: attachment.userId,
          command: command.type,
          operation_id: command.operationId,
          reason: diagnostic ?? diagnosticErrorCode(error, "socket_command_threw"),
          ...(validation
            ? {
              validation_issues: describeZodIssues(validation),
            }
            : {}),
          // `stack`, matching this file's other two `harnessErrorFrames` sites:
          // one value under one key is what makes a single log filter find it.
          stack: harnessErrorFrames(error),
        });
      }
      span.setError(safe.code, safe.message);
      span.setAttributes({ "http.response.status_code": safe.status });
    }
  }

  private async createSocketMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    command: Extract<z.infer<typeof ClientSocketEventSchema>, { type: "create_message" }>,
    requestReceivedAt: number,
  ): Promise<void> {
    await inFlowSpan(this.env, "workstream.room.create_message", {
      flow: "workstream_message_send",
      component: "substream_do",
      identity: {
        workspaceId: attachment.workspaceId,
        workstreamId: attachment.workstreamId,
        substreamId: attachment.substreamId,
        userId: attachment.userId,
        sessionId: attachment.sessionId,
      },
      attributes: {
        "rally.transport": "substream_socket",
        "rally.socket.connection_id": attachment.connectionId,
        "rally.message.client_id": command.payload.clientMessageId,
        "rally.message.attachment_count": command.payload.attachmentIds?.length ?? 0,
      },
    }, async (span) => {
      try {
        if (!this.objectStore.isRealtimeWritable()) {
          throw new ApiError(503, "workstream_maintenance", "Threads are temporarily unavailable");
        }
        assertParentWritable(attachment);
        if (!attachment.sessionId || attachment.role === undefined) {
          // A socket admitted before this command path existed has no role in
          // its hibernation attachment. A normal reconnect obtains a fresh
          // ticket and the complete admitted identity.
          disconnect(socket, 1012, "Reconnect for message commands");
          return;
        }
        const auth: AuthContext = {
          sessionId: attachment.sessionId,
          userId: attachment.userId,
          workspaceId: attachment.workspaceId,
          region: this.env.AVALON_REGION,
          role: attachment.role,
          analyticsWorkspaceId: attachment.analyticsWorkspaceId ?? null,
          ...(attachment.impersonatorUserId ? { impersonatorUserId: attachment.impersonatorUserId } : {}),
        };
        span.setAttributes(identityAttributes({
          analyticsWorkspaceId: auth.analyticsWorkspaceId,
        }));
        const result = await this.admitMessage(auth, {
          ...command.payload,
          telemetryOperationId: command.operationId,
          telemetryRequestReceivedAt: requestReceivedAt,
          telemetryJourney: "message_send",
        }, span, true);
        this.sendSocketCommandResult(socket, {
          type: "client_command_succeeded",
          command: "create_message",
          operationId: command.operationId,
          clientMessageId: command.payload.clientMessageId,
          turn: result.turn,
          deliveryState: result.deliveryState,
        });
        span.mark("workstream.room.create_message.respond");
      } catch (error) {
        const diagnostic = zodDiagnosticCode(error,'message_write');
        const tooLarge = error instanceof z.ZodError && error.issues.some((issue) => issue.code === 'custom' && issue.message === 'annotations_too_large');
        const safe = error instanceof ApiError ? error
          : tooLarge ? new ApiError(422,'annotations_too_large','These pins are too large to send together')
            : diagnostic ? new ApiError(500,diagnostic,'Stored message data contains an invalid field')
              : new ApiError(500, "message_write_failed", "The message could not be sent");
        this.sendSocketCommandResult(socket, {
          type: "client_command_failed",
          command: "create_message",
          operationId: command.operationId,
          clientMessageId: command.payload.clientMessageId,
          error: {
            status: safe.status,
            code: safe.code,
            message: safe.message,
            ...(safe.details ? { details: safe.details } : {}),
          },
        });
        if (!(error instanceof ApiError)) {
          logWarn(this.env, "substream_socket_create_message_failed", {
            workspace_id: attachment.workspaceId,
            workstream_id: attachment.workstreamId,
            substream_id: attachment.substreamId,
            user_id: attachment.userId,
            client_message_id: command.payload.clientMessageId,
            reason: diagnostic ?? diagnosticErrorCode(error,"message_write_failed"),
            ...(error instanceof z.ZodError ? {validation_issues:describeZodIssues(error)} : {}),
          });
        }
        span.setError(safe.code, safe.message);
        span.setAttributes({ "http.response.status_code": safe.status });
      }
    });
  }

  private async admitMessage(
    auth: AuthContext,
    input: WorkstreamObjectCreateMessageInput,
    span: FlowSpan,
    admittedSocket = false,
  ): Promise<WorkstreamMessageAdmissionReceipt & { replayed: boolean }> {
    const result = await span.step("workstream.room.product.create_message", () =>
      admittedSocket
        ? this.product.createMessageForAdmittedSocket(auth, input)
        : this.product.createMessage(auth, input));
    const activationRequest = result.activationRequest;
    if (activationRequest !== null) {
      try {
        await span.step("workstream.room.loop.activate", () =>
          this.requestPersistentLoopActivation(activationRequest));
      } catch (error) {
        // Admission arms cancellation recovery before its durable input row.
        // An eager wake-up failure must not turn that committed message into a
        // client-visible failure whose retry can only replay the same row.
        logWarn(this.env, "substream_message_activation_wakeup_failed", {
          workspace_id: auth.workspaceId,
          workstream_id: this.objectStore.identity()?.parentId,
          client_message_id: input.clientMessageId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    if (result.inserted) {
      await this.flushSemanticRealtimeOutboxBestEffort();
    }
    span.setAttributes({ "rally.message.deduplicated": !result.inserted });
    return { turn: result.turn, deliveryState: result.deliveryState, replayed: !result.inserted };
  }

  /**
   * Re-serve canonical state to a viewer that is already subscribed.
   *
   * This is `fulfillSubscription` at sequence zero, and deliberately nothing
   * more: assembling a snapshot awaits D1, so asking for one mid-connection has
   * exactly the bootstrap race an initial subscription has — an event published
   * inside that window would reach the viewer *before* the snapshot that
   * precedes it, and land as a duplicate or a gap. The initial path closes the
   * race by holding the socket out of broadcasts until an in-memory catch-up
   * runs, so a socket that is already in the room has to be put back into that
   * state to get the same guarantee; `fulfillSubscription` re-marks it
   * subscribed once the catch-up has closed the window.
   *
   * The reply is the ordinary sequenced `snapshot` frame rather than a
   * correlated direct one. That is what makes a stale answer a non-question:
   * the client already drops any frame at or below its cursor, so the room does
   * not have to reason about which of two concurrent answers is newer.
   */
  private async fulfillSnapshotRequest(
    socket: WebSocket,
    attachment: SocketAttachment,
  ): Promise<void> {
    if (!attachment.subscribed) {
      // Two ways to get here, and they are not the same thing. A socket that
      // never subscribed has no feed to refresh. A socket whose own earlier
      // request is still assembling is subscribed — it is only flagged
      // otherwise to keep broadcasts out of the window below — and telling that
      // reader to subscribe first would be a lie it cannot act on.
      const assembling = attachment.snapshotInFlight === true;
      // Uncorrelated on purpose: `request_snapshot` carries no request id, so
      // there is none to name, and the client reads an uncorrelated error as
      // the answer that releases its snapshot slot. Give that command a request
      // id one day and this call has to forward it — leaving it would make the
      // refusal invisible to the caller and, worse, still look like a snapshot
      // answer to every other one.
      this.sendError(
        socket,
        assembling ? "snapshot_in_flight" : "subscription_required",
        assembling
          ? "A snapshot for this socket is already being assembled."
          : "Subscribe to the message feed before requesting a snapshot.",
      );
      return;
    }
    socket.serializeAttachment({
      ...attachment,
      subscribed: false,
      snapshotInFlight: true,
    } satisfies SocketAttachment);
    try {
      const subscribed = await this.fulfillSubscription(
        socket,
        attachment.workspaceId,
        attachment.workstreamId,
        0,
        noFlowSpan,
        "reconciliation",
      );
      if (!subscribed) {
        const current = this.readAttachment(socket);
        if (current) {
          socket.serializeAttachment({
            ...current,
            snapshotInFlight: false,
          } satisfies SocketAttachment);
        }
        return;
      }
      // `fulfillSubscription` re-marks the socket subscribed; only the
      // in-flight flag is this method's to clear.
      const current = this.readAttachment(socket);
      if (current) {
        socket.serializeAttachment({ ...current, snapshotInFlight: false } satisfies SocketAttachment);
      }
    } catch (error) {
      // Put the viewer back in the room rather than leaving it silently out of
      // every future broadcast. It still holds usable state, and a reader that
      // stops receiving frames has no way to tell that from a quiet work
      // stream. An ordinary delivery exception is different from the handled
      // snapshot fallback, which returns above after sending `resync_required`.
      //
      // Restored from the attachment as it stands, not the copy captured before
      // the call: `fulfillSubscription` may have recorded progress before
      // throwing, and rolling that back would discard it.
      const current = this.readAttachment(socket) ?? attachment;
      socket.serializeAttachment({
        ...current,
        subscribed: true,
        snapshotInFlight: false,
      } satisfies SocketAttachment);
      throw error;
    }
  }

  private async fulfillTranscriptRange(
    socket: WebSocket,
    attachment: SocketAttachment,
    request: Extract<z.infer<typeof ClientSocketEventSchema>, { type: "load_transcript_range" }>,
  ): Promise<void> {
    // Subscription admission already verified the session and bound this
    // socket to one object-local work-stream/substream authority. Revocation
    // evicts the socket through the local participant/session epoch path, so a
    // range does not repeat D1 authorization per block or hydrated turn.
    //
    // A socket assembling its own requested snapshot is subscribed. The flag is
    // lowered for that window only to keep *broadcasts* out of it, and a range
    // is not a broadcast: it is a direct reply to this reader, read from the
    // fence this reader named, and it publishes nothing to anybody else. So
    // serve it. Refusing here told a subscribed reader to subscribe — advice it
    // could not act on, delivered through a frame it could not correlate, which
    // is how a "Load earlier messages" click became a 15-second timeout.
    //
    // Once assembly replaces the fence, the snapshot check below answers
    // `snapshot_expired` and the reader reloads under the new snapshot ID. That
    // is the same answer it would get from any other superseding snapshot, and
    // unlike a refusal it is a frame the reader already knows how to act on.
    if (!attachment.subscribed && attachment.snapshotInFlight !== true) {
      // What is left here is a reader asking for history on a socket that never
      // joined the feed, which no client of ours does. It went unlogged before,
      // and that silence is most of why the bug this branch used to cause had
      // to be diagnosed from the renderer's error string rather than from the
      // room. The `warn` is the trace the next one gets.
      logWarn(this.env, "substream_transcript_range_refused", {
        workspace_id: attachment.workspaceId,
        workstream_id: attachment.workstreamId,
        substream_id: attachment.substreamId,
        connection_id: attachment.connectionId,
        request_id: request.requestId,
        code: "subscription_required",
      });
      this.sendError(
        socket,
        "subscription_required",
        "Subscribe before loading transcript ranges",
        request.requestId,
      );
      return;
    }
    const sequence = await this.currentSequence();
    if (request.request.resumeAfterEventSequence > sequence) {
      this.sendResyncRequired(socket, sequence, "sequence_ahead");
      return;
    }
    try {
      const fence = attachment.transcriptSnapshot;
      if (!fence || fence.snapshotId !== request.request.snapshotId) {
        this.sendResyncRequired(socket, sequence, "snapshot_expired");
        return;
      }
      let result = this.transcript.range(fence, request.request.range);
      const occurredAt = new Date().toISOString();
      const encodedRange = (): string => JSON.stringify(ServerSocketEventSchema.parse({
        type: "transcript_range",
        sequence,
        occurredAt,
        requestId: request.requestId,
        snapshotId: request.request.snapshotId,
        result,
      }));
      let encoded = encodedRange();
      if (textEncoder.encode(encoded).byteLength > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
        const envelopes = new Map<string, TranscriptTurn>();
        for (const turn of result.turns) {
          const single = JSON.stringify(ServerSocketEventSchema.parse({
            type: "transcript_range",
            sequence,
            occurredAt,
            requestId: request.requestId,
            snapshotId: request.request.snapshotId,
            result: {
              ...result,
              covered: {
                startInclusive: turn.transcriptSequence,
                endExclusive: turn.transcriptSequence + 1,
              },
              turns: [turn],
              activities: activitiesForTranscriptTurns(result.activities, [turn]),
            },
          }));
          if (textEncoder.encode(single).byteLength <= WORKSTREAM_REALTIME_MAX_FRAME_BYTES) continue;
          // A turn whose serialized blocks alone exceed the frame budget keeps
          // its exact sequence as a placeholder envelope with payloads
          // omitted. Nothing in the product produces such a turn today, so
          // this is logged loudly rather than served through a hydration
          // protocol nobody has needed yet.
          logWarn(this.env, "substream_transcript_turn_oversized", {
            workspace_id: attachment.workspaceId,
            workstream_id: attachment.workstreamId,
            turn_id: turn.turnId,
          });
          envelopes.set(turn.turnId, this.transcript.omittedTurnEnvelope(turn));
        }
        if (envelopes.size > 0) {
          result = {
            ...result,
            turns: result.turns.map((turn) => envelopes.get(turn.turnId) ?? turn),
          };
          encoded = encodedRange();
        }
      }
      while (textEncoder.encode(encoded).byteLength > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
        const narrowed = narrowSocketTranscriptRange(result);
        if (!narrowed) throw new Error("substream_transcript_range_frame_too_large");
        result = narrowed;
        encoded = encodedRange();
      }
      socket.send(encoded);
    } catch {
      this.sendResyncRequired(socket, sequence, "history_unavailable");
    }
  }

  private async publishLocalProductEvent(
    attachment: { workspaceId: string } & ({ workstreamId: string } | { parentId: string }),
    event: Record<string, unknown>,
  ): Promise<"published" | "deferred"> {
    const parentId = "parentId" in attachment ? attachment.parentId : attachment.workstreamId;
    const response = await this.acceptEvent(new Request(
      "https://room.internal/internal/events",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [RALLY_HEADERS.WORKSPACE_ID]: attachment.workspaceId,
          [RALLY_HEADERS.WORKSTREAM_ID]: parentId,
        },
        body: JSON.stringify(event),
      },
    ));
    if (!response.ok) throw new Error("workstream_local_event_publish_failed");
    const outcome = await response.json().catch(() => null) as {
      deferredBehindCanonical?: unknown;
    } | null;
    return outcome?.deferredBehindCanonical === true ? "deferred" : "published";
  }

  private async requestCanonicalRoomResyncBestEffort(cause: string): Promise<void> {
    try {
      const currentSequence = await this.currentSequence();
      this.broadcast(this.resyncRequiredEvent(currentSequence, "history_unavailable"));
    } catch (error) {
      const identity = this.objectStore.identity();
      logWarn(this.env, "workstream_resource_resync_failed_after_commit", {
        workspace_id: identity?.workspaceId,
        workstream_id: identity?.parentId,
        cause,
        reason: diagnosticErrorCode(error, "resource_resync_failed"),
      });
    }
  }

  /**
   * Verification for a product request whose principal is a connector link
   * rather than a login session. Only the product path uses it: a socket can
   * never present a connector principal, because socket tickets are issued to
   * login sessions alone.
   *
   * The link itself — the standing authorization that a Slack identity acts as
   * this member — is a WorkspaceDO fact, and the Worker's ingress verifies it
   * per delivered message (`linkedAccount`), fresher than any token this
   * object could re-check. What remains this object's to verify is the same
   * D1 fact every admission re-checks: that the person is an active member of
   * this workspace, in this region, right now. That is exactly the sessions
   * query minus the `sessions` join, so a member removed from the workspace is
   * refused here with no new revocation machinery.
   *
   * `principal.sessionId` is a correlation value (`slack:{team}:{user}`), kept
   * on the returned context for tracing; nothing looks it up. The parameter is
   * typed off the product auth rather than a socket attachment on purpose —
   * a socket can never present a connector principal, and the product schema
   * is what guarantees the fields are present.
   */
  private async connectorPrincipalAuth(
    principal: Pick<SubstreamProductRequest["auth"], "sessionId" | "userId" | "workspaceId">,
  ): Promise<AuthContext | null> {
    const role = await this.activeMembership(principal.workspaceId, principal.userId);
    if (!role) return null;
    return {
      sessionId: principal.sessionId,
      userId: principal.userId,
      workspaceId: principal.workspaceId,
      region: this.env.AVALON_REGION,
      role: role.role,
      analyticsWorkspaceId: role.analytics_workspace_id ?? null,
    };
  }

  /**
   * The membership fact every non-session verification shares: an active
   * `workspace_members` row for this person, in a `workspaces` row this
   * region owns. `connectorPrincipalAuth` and `socketAuth`'s development
   * branch differ only in what they layer on top — auth SQL that is
   * copy-pasted is auth SQL that drifts, so there is one copy.
   */
  private async activeMembership(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<AuthRoleRow | null> {
    return await this.env.DB.prepare(
      `SELECT member.role, workspace.analytics_workspace_id
         FROM workspace_members member
         JOIN workspaces workspace ON workspace.id = member.workspace_id
        WHERE member.workspace_id = ? AND member.user_id = ?
          AND member.status = 'active' AND workspace.region = ?
          AND workspace.abandoned_at IS NULL`,
    ).bind(workspaceId, userId, this.env.AVALON_REGION).first<AuthRoleRow>();
  }

  private async socketAdmissionAuth(
    attachment: Pick<SocketAttachment, "sessionId" | "userId" | "workspaceId">,
  ): Promise<{ auth: AuthContext; sessionExpiresAt: number | null } | null> {
    const role = this.env.APP_ENV === "development"
      && this.env.RALLY_DEV_AUTH === "true"
      && attachment.sessionId === "development"
      ? await this.activeMembership(attachment.workspaceId, attachment.userId)
      : await this.env.DB.prepare(
        // The workspace surrogate rides this query because `workspaces` is
        // already joined — a socket that authorizes itself also learns what
        // PostHog knows the workspace as, at no extra round trip. The *person*
        // surrogate is deliberately not fetched here: it would mean joining
        // `users` from a Durable Object, and no diagnostic is worth widening
        // what a socket's authorization depends on.
        `SELECT member.role, workspace.analytics_workspace_id,
                session.expires_at AS session_expires_at, session.impersonator_user_id
           FROM sessions session
           JOIN workspace_members member
             ON member.workspace_id = session.workspace_id
            AND member.user_id = session.user_id AND member.incarnation = session.workspace_incarnation
            AND member.status = 'active'
           JOIN workspaces workspace ON workspace.id = session.workspace_id
          WHERE session.id = ? AND session.user_id = ? AND session.workspace_id = ?
            AND session.region = ? AND session.revoked_at IS NULL
            AND session.expires_at > ? AND workspace.region = ?
            AND workspace.abandoned_at IS NULL`,
      ).bind(
        attachment.sessionId,
        attachment.userId,
        attachment.workspaceId,
        this.env.AVALON_REGION,
        new Date().toISOString(),
        this.env.AVALON_REGION,
      ).first<AuthRoleRow>();
    if (!role) return null;
    const sessionExpiresAt = role.session_expires_at === undefined
      ? null
      : Date.parse(role.session_expires_at);
    if (sessionExpiresAt !== null && !Number.isFinite(sessionExpiresAt)) return null;
    return {
      auth: {
        sessionId: attachment.sessionId!,
        userId: attachment.userId,
        workspaceId: attachment.workspaceId,
        region: this.env.AVALON_REGION,
        role: role.role,
        analyticsWorkspaceId: role.analytics_workspace_id ?? null,
        ...(role.impersonator_user_id ? { impersonatorUserId: asUserId(role.impersonator_user_id) } : {}),
      },
      sessionExpiresAt,
    };
  }

  private async socketAuth(
    attachment: Pick<SocketAttachment, "sessionId" | "userId" | "workspaceId">,
  ): Promise<AuthContext | null> {
    return (await this.socketAdmissionAuth(attachment))?.auth ?? null;
  }

  private async productSessionAuth(
    identity: Pick<SocketAttachment, "sessionId" | "userId" | "workspaceId">,
    expectedRole: AuthContext["role"],
  ): Promise<AuthContext | null> {
    const key = JSON.stringify([identity.workspaceId, identity.userId, identity.sessionId]);
    const now = Date.now();
    const cached = this.productSessionAdmissions.get(key);
    if (cached && cached.validUntil > now && cached.auth.role === expectedRole) return cached.auth;
    if (cached) this.productSessionAdmissions.delete(key);
    const revision = this.productSessionAdmissionRevision;
    const admission = await this.socketAdmissionAuth(identity);
    if (!admission) return null;
    const observedAt = Date.now();
    const validUntil = Math.min(observedAt + PRODUCT_SESSION_AUTH_MAX_AGE_MS, admission.sessionExpiresAt ?? Number.POSITIVE_INFINITY);
    if (validUntil <= observedAt) return null;
    // A queued revocation may have arrived while D1 was answering. Do not
    // install an older observation into this object's future requests.
    if (revision === this.productSessionAdmissionRevision) {
      for (const [entryKey, entry] of this.productSessionAdmissions) {
        if (entry.validUntil <= observedAt) this.productSessionAdmissions.delete(entryKey);
      }
      this.productSessionAdmissions.set(key, { auth: admission.auth, validUntil });
    }
    return admission.auth;
  }

  /**
   * The whole committed transcript as room-visible text, for an operator, with
   * the identity this object holds so the caller can confirm it read the
   * conversation it addressed. The same `conversationAsText` the transcript
   * range reader formats with, over every committed turn; no viewer and no
   * authorization, because the only caller is the operator dump that runs
   * before a Thread is retired (`services/thread-retirement-service.ts`). An
   * object with no identity row never held a conversation and answers empty.
   */
  async conversationTranscriptText(): Promise<{
    identity: { workspaceId: string; parentKind: string; parentId: string; substreamId: string } | null;
    throughSequence: number;
    text: string;
  }> {
    await this.storageReady;
    const identity = this.objectStore.identityForRetirement();
    const throughSequence = this.transcript.transcriptThrough();
    const range = this.transcript.range(
      { snapshotId: "operator-dump", snapshotThrough: throughSequence, snapshotAtUtc: new Date().toISOString() },
      { startInclusive: 1, endExclusive: throughSequence + 1 }, "requested", false,
    );
    return {
      identity: identity ? {
        workspaceId: identity.workspaceId, parentKind: identity.parentKind, parentId: identity.parentId,
        substreamId: this.externalSubstreamId(),
      } : null,
      throughSequence,
      text: conversationAsText(range.turns),
    };
  }

  /** Content-free operator inventory, including retired conversations. */
  async meetingRetirementInventory(resourceIds: string[] = []) {
    await this.storageReady;
    const ids = z.array(z.string().uuid()).parse(resourceIds);
    const sql = this.state.storage.sql;
    const retired = sql.exec<{ resource_id: string }>(
      'SELECT resource_id FROM retired_meeting_attachment_ids ORDER BY resource_id',
    ).toArray();
    const selected = [...new Set([...ids, ...retired.map(row => row.resource_id)])];
    const selectedJson = JSON.stringify(selected);
    const imports = sql.exec<{ resource_id: string; destination_path: string; sandbox_generation: number }>(
      'SELECT resource_id, destination_path, sandbox_generation FROM terminal_imported_resources WHERE resource_id IN (SELECT value FROM json_each(?))', selectedJson,
    ).toArray();
    const toolCopies = selected.length === 0 ? 0 : sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM tool_effects effect
      WHERE EXISTS (SELECT 1 FROM json_tree(effect.input_json) field
        WHERE field.key IN ('resourceId', 'resource_id') AND field.value IN (SELECT value FROM json_each(?)))`, selectedJson).one().count;
    return {
      identity: sql.exec('SELECT workstream_key, parent_workspace_key FROM workstream WHERE id = 1').toArray()[0] ?? null,
      retiredResourceIds: retired.map(row => row.resource_id),
      imports, toolCopies,
    };
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return {
      component: WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
      className: "AgentLoopDO",
      migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
    };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  /**
   * The stored parent kind when it names a retired parent (a Thread's or a
   * Space's), which this object no longer hosts; null for a hosted one or an
   * object with no identity yet.
   */
  private retiredParentKind(): string | null {
    const kind = this.objectStore.identityForRetirement()?.parentKind;
    return kind === undefined || HostedConversationParentKindSchema.safeParse(kind).success ? null : kind;
  }

  /**
   * An object whose parent was retired runs nothing on its alarm: every lane
   * reads the hosted identity, which refuses that kind, so a due wake reason
   * left in a Thread's object (a memory sweep retry, an outbox row, an agent
   * timer) would otherwise throw on every pass until `retire_threads` closes
   * the object. It is logged once per firing and the slot is cleared;
   * the rows stay for the retirement to discard.
   */
  override async alarm(): Promise<void> {
    await this.storageReady;
    const retired = this.retiredParentKind();
    if (retired === null) return super.alarm();
    logWarn(this.env, "conversation_alarm_skipped", {
      code: `conversation_parent_kind_retired:${retired}`,
      substream_id: this.externalSubstreamId(),
    });
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * Hold every due wake reason while this work stream's region is closed.
   *
   * Read only when there is work to hold: a keep-alive wake during a streaming
   * run has nothing to defer, and a D1 round trip every thirty seconds to
   * establish that would be paid by every active run in the fleet.
   */
  protected override async scheduledAlarmDeferral(now: number): Promise<number | null> {
    if (!this.hasDueAlarmWork(now)) return null;
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (acceptsNewWorkstreamWork(authority)) return null;
    return now + MAINTENANCE_RECHECK_MS;
  }

  protected override onScheduledAlarmFailure(alarm: ScheduledAlarm, error: unknown, attempt: number): void {
    const identity = this.objectStore.identityForRetirement();
    reportScheduledAlarmAttempt(this.env, (promise) => this.ctx.waitUntil(promise), {
      event: "substream_scheduled_alarm_failed",
      summary: "An agent object's alarm entry keeps throwing; `code` is the handler's error, and `alarm_kind` and `alarm_key` name the entry in the conversation `substream_id` names.",
      attempt,
      fields: {
        workspace_id: identity?.workspaceId ?? null,
        workstream_id: identity?.parentId ?? null,
        substream_id: this.externalSubstreamId(),
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
      },
      error,
    });
  }

  protected override onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void {
    const identity = this.objectStore.identityForRetirement();
    reportScheduledAlarmAttempt(this.env, (promise) => this.ctx.waitUntil(promise), {
      event: "substream_scheduled_alarm_stalled",
      summary: "An agent object's alarm entry keeps coming back due at the same instant after running: the source row behind `alarm_kind` and `alarm_key`, in the conversation `substream_id` names, is not moving. Find why.",
      attempt,
      fields: {
        workspace_id: identity?.workspaceId ?? null,
        workstream_id: identity?.parentId ?? null,
        substream_id: this.externalSubstreamId(),
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
        due_at: new Date(alarm.dueAt).toISOString(),
      },
    });
  }

  protected override onIdleAlarmHeld(attempt: number, heldUntil: number): void {
    const identity = this.objectStore.identityForRetirement();
    reportScheduledAlarmAttempt(this.env, (promise) => this.ctx.waitUntil(promise), {
      event: "substream_alarm_idle_held",
      summary: "An agent object's alarm keeps asking to run again at once while its passes change nothing: one of its derived wake reasons, in the conversation `substream_id` names, reports work at now that the pass then declines. Find which.",
      attempt,
      fields: {
        workspace_id: identity?.workspaceId ?? null,
        workstream_id: identity?.parentId ?? null,
        substream_id: this.externalSubstreamId(),
        held_until: new Date(heldUntil).toISOString(),
      },
    });
  }

  private hasDueAlarmWork(now: number): boolean {
    return this.objectStore.nextRegionalEffectDueAt() !== null
      || nextExternalBindingDueAt(this.state.storage.sql) !== null
      || this.objectStore.nextSemanticRealtimeDueAt() !== null
      || this.nextLoopWorkAt(now) !== null
      || this.nextExternalSettlementAt() !== null
      || this.memorySweepDue(now)
      || this.scheduledAlarms.due(now, 1).length > 0;
  }

  /**
   * When the memory sweep asked to be tried again: a conversation that was
   * resting with person messages behind its cursor, or whose claim failed.
   * `null` for an object below migration 76, which has no row to read.
   */
  private nextMemorySweepAt(): number | null {
    const present = this.state.storage.sql.exec(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_sweep_state'",
    ).toArray().length > 0;
    if (!present) return null;
    const row = this.state.storage.sql.exec<{ retry_at: number | null }>(
      `SELECT retry_at FROM memory_sweep_state WHERE id = 1`,
    ).toArray()[0];
    return row?.retry_at ?? null;
  }

  private memorySweepDue(now: number): boolean {
    const dueAt = this.nextMemorySweepAt();
    return dueAt !== null && dueAt <= now;
  }

  /**
   * The alarm's half of the sweep trigger: the same attempt settlement makes,
   * against this conversation. Every path of the attempt moves `retry_at`, so
   * an alarm that fires here never comes back due at the same instant.
   */
  private async attemptDueMemorySweep(): Promise<void> {
    const identity = this.objectStore.identity();
    if (!identity) return;
    const substreamId = this.externalSubstreamId();
    await attemptMemorySweep(
      this.localRuntimeEnvironment(identity.workspaceId, identity.parentId, substreamId),
      { workspaceId: identity.workspaceId, parentKind: identity.parentKind, parentId: identity.parentId, substreamId },
    );
  }

  /**
   * Fire one agent-created timer.
   *
   * The entry is the index, never the record: `workstream_wakeups` still owns
   * status, principal, and prompt, and this reloads the row so a wake-up
   * cancelled since the entry was written is a no-op rather than a run nobody
   * asked for. Throwing puts this timer — and only this timer — behind the
   * shared retry gate.
   *
   * The port is built without the in-isolate storage seam, so the claim goes
   * through `/internal/scheduling` like every other wake-up write. That is not
   * a round trip: `this.env` was rebound through `withDurableObjectSelf` in the
   * constructor, so the stub resolves to this instance and the endpoint runs
   * here. Taking the seam instead would skip the endpoint — and with it the
   * commit that republishes the sidebar's next-wake-up marker, which after a
   * claim still advertises a wake-up that has already fired.
   *
   * The port names this object's substream. `this.env` carries no installed
   * authorities, so a port without one reaches the parent's Main, which in a
   * Breakout or a Sidekick run child is a different object holding no such
   * row.
   *
   * Every way this returns leaves the row out of `pending` or throws a named
   * code, so a timer that cannot fire is a reported failure rather than a
   * silent stall.
   */
  protected override async runScheduledAlarm(alarm: ScheduledAlarm): Promise<void> {
    // Suggestions are retired; a merge-result judgement a Thread armed before
    // then has nothing left to judge.
    if (alarm.kind === RETIRED_MERGE_SUGGESTION_ALARM_KIND) return;
    if (alarm.kind !== AGENT_TIMER_ALARM_KIND) {
      throw new Error(`substream_unknown_alarm_kind:${alarm.kind}`);
    }
    const identity = this.objectStore.identity();
    if (!identity) throw new Error("agent_timer_identity_unavailable");
    const substreamId = this.externalSubstreamId();
    const executionEnv = this.localRuntimeEnvironment(
      identity.workspaceId,
      identity.parentId,
      substreamId,
    );
    const scheduling = createSchedulingObjectPort(
      this.env,
      identity.workspaceId,
      identity.parentId,
      undefined,
      substreamId,
    );
    const wakeup = await loadWorkstreamWakeup(
      scheduling,
      identity.workspaceId,
      identity.parentId,
      alarm.key,
    );
    if (!wakeup || wakeup.status !== "pending") {
      // The index is reconciled from this object's own table after the drain,
      // so an entry whose row really has settled leaves on its own. One whose
      // row is still pending here was answered by some other object.
      if (this.agentTimerStillPending(alarm.key)) throw new Error("agent_timer_wakeup_unreachable");
      return;
    }
    const background = this.state.storage.sql.exec<{ stopped_at: number | null }>(
      "SELECT stopped_at FROM background_agent WHERE id = 1",
    ).toArray()[0];
    const { fired } = await fireWorkstreamWakeup(executionEnv, wakeup, scheduling, {
      parentKind: identity.parentKind,
      substreamId,
      backgroundAgent: background ? (background.stopped_at !== null ? "stopped" : true) : false,
    });
    // Not firing is a decision that consumes the row. One still pending lost
    // its claim to a writer that has not settled it.
    if (!fired && this.agentTimerStillPending(alarm.key)) throw new Error("agent_timer_claim_lost");
  }

  private agentTimerStillPending(wakeupId: string): boolean {
    return this.state.storage.sql.exec(
      `SELECT 1 FROM workstream_wakeups WHERE wakeup_id = ? AND status = 'pending'`,
      wakeupId,
    ).toArray().length > 0;
  }

  /**
   * Make the `agent_timer` entries match this object's pending wake-ups.
   *
   * Called wherever `workstream_wakeups` can have changed — every mutating
   * scheduling operation, the timer refresh port, and after a timer fires.
   * Reconciling rather than patching is what makes a wake-up scheduled *before*
   * the armed alarm pull that alarm in, and a cancelled one push it back out,
   * without either writer having to know an index exists.
   */
  private syncAgentTimerAlarms(): void {
    const pending = this.state.storage.sql.exec<{ wakeup_id: string; due_at: number }>(
      `SELECT wakeup_id, due_at FROM workstream_wakeups
        WHERE status = 'pending' ORDER BY due_at, wakeup_id LIMIT ?`,
      AGENT_TIMER_ALARM_LIMIT,
    ).toArray();
    this.state.storage.transactionSync(() => {
      this.scheduledAlarms.reconcile(
        AGENT_TIMER_ALARM_KIND,
        pending.map((row) => ({ key: row.wakeup_id, dueAt: row.due_at })),
      );
    });
  }

  protected override async runDueAlarmWork(): Promise<void> {
    this.loopDrainDeferred = false;
    const now = Date.now();
    const nextRegionalEffectAt = this.objectStore.nextRegionalEffectDueAt();
    const nextSemanticRealtimeAt = this.objectStore.nextSemanticRealtimeDueAt();
    const nextSearchProjectionAt = nextSearchProjectionDueAt(this.state.storage.sql, this.env);
    const nextAuthorizationProjectionDueAt = nextAuthorizationProjectionAt(this.state.storage.sql);
    const nextExternalBindingAt = nextExternalBindingDueAt(this.state.storage.sql);
    const nextLoopAt = this.nextLoopWorkAt(now);
    const nextExternalSettlementAt = this.nextExternalSettlementAt();
    // A timer that fired above may have left the index behind the table.
    this.syncAgentTimerAlarms();
    // Started here and joined below: the attempt is two reads and at most one
    // Queue send, and must not wait behind the run lane.
    const memorySweep = this.memorySweepDue(now) ? this.attemptDueMemorySweep() : null;
    try {
      await this.runDueAlarmLanes(now, {
        nextRegionalEffectAt, nextSemanticRealtimeAt, nextSearchProjectionAt,
        nextAuthorizationProjectionDueAt, nextExternalBindingAt, nextLoopAt, nextExternalSettlementAt,
      });
    } finally {
      if (memorySweep) await memorySweep;
    }
  }

  private async runDueAlarmLanes(now: number, due: {
    nextRegionalEffectAt: number | null;
    nextSemanticRealtimeAt: number | null;
    nextSearchProjectionAt: number | null;
    nextAuthorizationProjectionDueAt: number | null;
    nextExternalBindingAt: number | null;
    nextLoopAt: number | null;
    nextExternalSettlementAt: number | null;
  }): Promise<void> {
    const {
      nextRegionalEffectAt, nextSemanticRealtimeAt, nextSearchProjectionAt,
      nextAuthorizationProjectionDueAt, nextExternalBindingAt, nextLoopAt, nextExternalSettlementAt,
    } = due;
    const projectionDue = (nextRegionalEffectAt !== null && nextRegionalEffectAt <= now)
      || (nextConversationViewAt(this.state.storage.sql) ?? Infinity) <= now
      || (nextSearchProjectionAt !== null && nextSearchProjectionAt <= now)
      || (nextAuthorizationProjectionDueAt !== null && nextAuthorizationProjectionDueAt <= now)
      || (nextExternalBindingAt !== null && nextExternalBindingAt <= now);
    const loopDue = nextLoopAt !== null && nextLoopAt <= now;
    if (!projectionDue
      && !loopDue
      && !(nextSemanticRealtimeAt !== null && nextSemanticRealtimeAt <= now)
      && !(nextExternalSettlementAt !== null && nextExternalSettlementAt <= now)) return;

    if (nextExternalSettlementAt !== null && nextExternalSettlementAt <= now) {
      if (this.externalSettlementDrain.abandonActive()) {
        logWarn(this.env, "substream_external_settlement_stale_drain_reclaimed", {
          workspace_id: this.objectStore.identity()?.workspaceId,
          workstream_id: this.objectStore.identity()?.parentId,
          substream_id: this.externalSubstreamId(),
        });
      }
      this.resumeExternalSettlementDrain();
    }

    // Pending canonical events must precede ephemeral run output. Keep this
    // local ordering barrier ahead of activation; cross-authority projections
    // below are independent and must not gate execution readiness.
    if (nextSemanticRealtimeAt !== null && nextSemanticRealtimeAt <= now) {
      await this.flushSemanticRealtimeOutboxBestEffort();
    }

    // Schedule the execution lane first, then begin the projection lane without
    // awaiting either one. Preparation, claim, and settlement request more
    // serialized passes when they may have committed new projection work.
    const loopDrain = loopDue ? this.drainLoopToCompletion() : null;
    if (projectionDue) void this.requestExternalProjectionDrain();
    try {
      if (loopDrain) this.loopDrainDeferred = await loopDrain === "deferred";
    } finally {
      // A final joined pass observes work committed by a short loop and waits
      // for every earlier pass. The lane catches its own failures, so a Queue
      // outage cannot poison this tail or prevent a later alarm from retrying.
      if (loopDrain || projectionDue) await this.requestExternalProjectionDrain();
    }
  }

  private requestExternalProjectionDrain(): Promise<void> {
    const drain = this.externalProjectionDrain.then(async () => {
      try {
        await this.drainDueExternalProjections();
      } catch (error) {
        logWarn(this.env, "substream_external_projection_drain_failed", {
          workspace_id: this.objectStore.identity()?.workspaceId,
          workstream_id: this.objectStore.identity()?.parentId,
          substream_id: this.externalSubstreamId(),
          reason: diagnosticErrorCode(error, "external_projection_drain_failed"),
        });
      }
    });
    this.externalProjectionDrain = drain;
    return drain;
  }

  /**
   * Deliver cross-authority projections that are due now. These sends share a
   * serialized lane beside agent execution: durable outbox rows remain the
   * retry authority, while Queue acceptance never delays claiming loop work.
   */
  private async drainDueExternalProjections(): Promise<void> {
    const authzIdentity = this.objectStore.identity();
    if (authzIdentity) {
      try {
        await flushAuthorizationProjection(this.state.storage.sql, this.env.ACTIVITY_QUEUE, {
          type: 'authorization_projection_v1', region: this.env.AVALON_REGION,
          workspaceId: authzIdentity.workspaceId, parentId: authzIdentity.parentId,
          substreamId: this.externalSubstreamId(),
        });
      } catch { logWarn(this.env, 'authorization_projection_dispatch_deferred', { region: this.env.AVALON_REGION }); }
    }
    await this.flushConversationViews();
    await this.flushSearchProjectionOutbox();
    await this.flushExternalBindingOutbox();
    const nextEffectAt = this.objectStore.nextRegionalEffectDueAt();
    if (nextEffectAt !== null && nextEffectAt <= Date.now()) {
      await this.drainRegionalEffects();
    }
  }

  /**
   * Send every due effect to the activity Queue, one message each, and delete
   * the rows the Queue accepted.
   *
   * From there retry is the Queue's, and the parent's receipt makes a
   * redelivery a no-op: nothing loads an effect back from here and nothing
   * acknowledges one to it. A batch the Queue refused is deferred and the
   * alarm tries again. An effect too large for one message is dropped with a
   * warning, because it would be refused on every attempt. The one exception
   * is a directory effect that fits without its Sidekick attachment list: it
   * is sent without the list, which the parent reads as "not said", rather
   * than losing every other directory field with it.
   */
  private async drainRegionalEffects(): Promise<void> {
    const due = this.objectStore.dueRegionalEffects(Date.now(), 100);
    if (due.length === 0) return;
    const encoder = new TextEncoder();
    const sendable: ConversationEffectEnvelope[] = [];
    // The outbox row each sent body stands for: a trimmed body carries its own
    // hash, and the row is found by the one it was stored under.
    const rows = new Map<ConversationEffectEnvelope, ConversationEffectEnvelope>();
    let batchBytes = 0;
    for (const stored of due) {
      let effect = stored;
      let bytes = encoder.encode(JSON.stringify(effect)).byteLength;
      if (bytes > EFFECT_QUEUE_MESSAGE_MAX_BYTES && effect.effect.kind === "directory_common"
        && effect.effect.sidekickAttachmentIds !== undefined) {
        const { sidekickAttachmentIds, ...withoutAttachments } = effect.effect;
        const trimmed = { ...effect, effect: withoutAttachments, payloadHash: conversationEffectHash(withoutAttachments) };
        const trimmedBytes = encoder.encode(JSON.stringify(trimmed)).byteLength;
        if (trimmedBytes <= EFFECT_QUEUE_MESSAGE_MAX_BYTES) {
          logWarn(this.env, "conversation_effect_oversized", {
            workspace_id: effect.workspaceId,
            workstream_id: effect.parentId,
            parent_kind: effect.parentKind,
            substream_id: effect.substreamId,
            message_id: effect.messageId,
            effect_kind: effect.effect.kind,
            bytes,
            limit_bytes: EFFECT_QUEUE_MESSAGE_MAX_BYTES,
            attachment_count: sidekickAttachmentIds.length,
            outcome: "attachments_omitted",
          });
          effect = trimmed;
          bytes = trimmedBytes;
        }
      }
      if (bytes > EFFECT_QUEUE_MESSAGE_MAX_BYTES) {
        this.objectStore.deleteRegionalEffect(effect.messageId, effect.payloadHash);
        logWarn(this.env, "conversation_effect_oversized", {
          workspace_id: effect.workspaceId,
          workstream_id: effect.parentId,
          parent_kind: effect.parentKind,
          substream_id: effect.substreamId,
          message_id: effect.messageId,
          effect_kind: effect.effect.kind,
          bytes,
          limit_bytes: EFFECT_QUEUE_MESSAGE_MAX_BYTES,
          outcome: "dropped",
        });
        continue;
      }
      // Cloudflare accepts 100 messages and 256 KB per `sendBatch`; whatever
      // does not fit stays due and the next alarm takes it.
      if (sendable.length >= 100 || batchBytes + bytes > 250_000) break;
      sendable.push(effect);
      rows.set(effect, stored);
      batchBytes += bytes;
    }
    if (sendable.length === 0) return;
    const identity = sendable[0]!;
    try {
      await this.env.ACTIVITY_QUEUE.sendBatch(sendable.map((body) => ({ body })));
      let removed = 0;
      for (const effect of sendable) {
        const row = rows.get(effect) ?? effect;
        if (this.objectStore.deleteRegionalEffect(row.messageId, row.payloadHash)) removed += 1;
      }
      logInfo(this.env, "substream_outbox_batch_enqueued", {
        workspace_id: identity.workspaceId,
        workstream_id: identity.parentId,
        parent_kind: identity.parentKind,
        substream_id: identity.substreamId,
        message_ids: sendable.map((effect) => effect.messageId),
        effect_kinds: sendable.map((effect) => effect.effect.kind),
        effect_count: sendable.length,
        removed_count: removed,
        outcome: "queued",
      });
    } catch (error) {
      const retryAt = Date.now() + 5_000;
      this.objectStore.deferRegionalEffects(sendable.map((effect) => rows.get(effect) ?? effect), retryAt);
      logWarn(this.env, "substream_outbox_batch_deferred", {
        workspace_id: identity.workspaceId,
        workstream_id: identity.parentId,
        parent_kind: identity.parentKind,
        substream_id: identity.substreamId,
        message_ids: sendable.map((effect) => effect.messageId),
        effect_kinds: sendable.map((effect) => effect.effect.kind),
        effect_count: sendable.length,
        retry_at: new Date(retryAt).toISOString(),
        outcome: "deferred",
        reason: diagnosticErrorCode(error, "queue_send_failed"),
        error_name: error instanceof Error ? error.name : typeof error,
      });
      await this.ensureAlarmNoLaterThan(retryAt);
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    void code;
    void reason;
    void wasClean;
    const attachment = this.readAttachment(socket);
    if (attachment?.ticketId) this.deletePreparedSocketAdmission(attachment.ticketId);
    if (attachment?.subscribed && attachment.publishPresence) {
      await this.broadcastPresence(attachment.workspaceId, attachment.workstreamId, socket);
    }
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = this.readAttachment(socket);
    if (attachment?.ticketId) this.deletePreparedSocketAdmission(attachment.ticketId);
    try {
      socket.close(1011, "Realtime connection failed");
    } catch {
      // The peer may already be gone; presence cleanup still needs to run.
    }
    if (attachment?.subscribed && attachment.publishPresence) {
      await this.broadcastPresence(attachment.workspaceId, attachment.workstreamId, socket);
    }
  }

  /**
   * The upgrade and the `subscribe` that follows it are separate invocations —
   * `subscribe` arrives over an already-open socket, possibly on a woken
   * isolate — so the platform traces them as two traces. `rally.socket.*`
   * attributes are what join them: the ticket id back to the route that issued
   * it, and the connection id forward to the subscription.
   */
  private async acceptSocket(request: Request, url: URL): Promise<Response> {
    return inFlowSpan(this.env, "workstream.room.socket.accept", {
      flow: "workstream_open",
      component: "substream_do",
    }, (span) => this.acceptSocketInSpan(request, url, span));
  }

  private async acceptSocketInSpan(request: Request, url: URL, span: FlowSpan): Promise<Response> {
    // Read before the accept yields. The edge records the remainder of its
    // wait separately; it includes constructor/readiness work before this point.
    // Instance age is context for interpreting that remainder, not attribution
    // of which concurrent call woke the object.
    const acceptStartedAt = Date.now();
    const instanceAgeMs = this.instanceAgeMs();
    span.setAttributes({ "rally.room.instance_age_ms": instanceAgeMs });
    // The authority control is read once, below, after the identity is parsed.
    // It used to be read here as well, to refuse a socket during maintenance
    // before parsing anything — but the read is an uncached D1 round trip and
    // the second one repeats the same check milliseconds later, so the pair
    // cost every socket accept an extra round trip to save header parsing on
    // the rare maintenance path. It also charged that first wait to whichever
    // step closed next, which is how it was found.
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket_upgrade_required" }, 426);
    }

    const identity = SocketUpgradeIdentitySchema.safeParse({
        workspaceId:
          readRallyHeader(request.headers, RALLY_HEADERS.WORKSPACE_ID) ?? url.searchParams.get("workspaceId"),
        workstreamId:
          readRallyHeader(request.headers, RALLY_HEADERS.WORKSTREAM_ID) ?? url.searchParams.get("workstreamId"),
        parentKind: readRallyHeader(request.headers, RALLY_HEADERS.PARENT_KIND),
        substreamId:
          readRallyHeader(request.headers, RALLY_HEADERS.SUBSTREAM_ID) ?? url.searchParams.get("substreamId"),
        userId: readRallyHeader(request.headers, RALLY_HEADERS.USER_ID) ?? url.searchParams.get("userId"),
        sessionId: readRallyHeader(request.headers, RALLY_HEADERS.SESSION_ID) ?? null,
        ticketId: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_ID) ?? null,
        ticketExpiresAt: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_EXPIRES_AT) ?? null,
        afterSequence: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_AFTER_SEQUENCE),
        speculative: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_SPECULATIVE),
        parentArchived: readRallyHeader(request.headers, RALLY_HEADERS.PARENT_ARCHIVED),
        admissionVersion: readRallyHeader(
          request.headers,
          RALLY_HEADERS.SOCKET_ADMISSION_VERSION,
        ),
        authorityGeneration: readRallyHeader(
          request.headers,
          RALLY_HEADERS.SOCKET_ADMISSION_AUTHORITY_GENERATION,
        ),
        role: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_ADMISSION_ROLE) === "null"
          ? null : readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_ADMISSION_ROLE),
        analyticsWorkspaceId: readRallyHeader(
          request.headers,
          RALLY_HEADERS.SOCKET_ANALYTICS_WORKSPACE_ID,
        ),
        membershipVersion: readRallyHeader(
          request.headers,
          RALLY_HEADERS.SOCKET_ADMISSION_MEMBERSHIP_VERSION,
        ),
        impersonatorUserId: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_IMPERSONATOR_ID),
      });

    if (!identity.success) return jsonResponse({ error: "invalid_socket_identity" }, 400);

    const parentKind = identity.data.parentKind ?? this.objectStore.identity()?.parentKind;
    if (!parentKind) {
      span.setError("conversation_parent_kind_missing");
      return jsonResponse({ error: "conversation_parent_kind_missing" }, 400);
    }

    span.setAttributes({
      "rally.workspace.id": identity.data.workspaceId,
      "rally.workstream.id": identity.data.workstreamId,
      "user.id": identity.data.userId,
      "rally.substream.id": identity.data.substreamId,
      "rally.socket.ticket_id": identity.data.ticketId,
      ...(identity.data.afterSequence === undefined ? {} : {
        "rally.socket.after_sequence": identity.data.afterSequence,
      }),
      ...(identity.data.speculative ? { "rally.socket.speculative": true } : {}),
    });

    try {
      this.ensureSubstreamIdentity(identity.data.substreamId);
      this.objectStore.ensureIdentity({
        workspaceId: identity.data.workspaceId,
        parentKind,
        parentId: identity.data.workstreamId,
      }, this.env.AVALON_REGION);
      this.ensurePersistentLoop();
    } catch (error) {
      if (error instanceof Error && error.message === "workstream_object_identity_mismatch") {
        span.setError("room_identity_mismatch");
        return jsonResponse({ error: "room_identity_mismatch" }, 409);
      }
      span.setError("socket_identity_failed");
      throw error;
    }

    // A generation identifies the object graph, but maintenance can close the
    // current generation in place. Preserve the pre-existing phase fence on
    // both prepared and fallback admissions.
    const currentAuthority = await span.step("workstream.room.socket.authority_read", () =>
      readWorkstreamAuthorityControl(this.env));
    if (!acceptsNewWorkstreamWork(currentAuthority)) {
      span.setError("workstream_maintenance");
      return jsonResponse({
        error: "workstream_maintenance",
        phase: currentAuthority.phase,
        generation: currentAuthority.generation,
      }, 503);
    }

    let prepared = this.preparedSocketAdmission(identity.data);
    if (prepared && prepared.input.authorityGeneration !== currentAuthority.generation) {
      this.deletePreparedSocketAdmission(identity.data.ticketId);
      prepared = null;
    }
    let auth: AuthContext | null;
    if (prepared) {
      auth = prepared.auth;
      span.setAttributes({ "rally.socket.admission_source": "ticket_preparation" });
    } else {
      span.setAttributes({ "rally.socket.admission_source": "regional_fallback" });
      auth = await span.step(
        "workstream.room.socket.member_authorize",
        () => this.socketAuth(identity.data),
      );
      if (!this.objectStore.isRealtimeWritable()) {
        span.setError("workstream_maintenance");
        return jsonResponse({
          error: "workstream_maintenance",
          phase: currentAuthority.phase,
          generation: currentAuthority.generation,
        }, 503);
      }
    }
    if (!auth || !this.product.canRead(identity.data.userId)) {
      span.setError("forbidden");
      return jsonResponse({ error: "forbidden" }, 403);
    }

    if (!this.objectStore.consumeSocketTicket(
      identity.data.ticketId,
      identity.data.ticketExpiresAt,
    )) {
      this.deletePreparedSocketAdmission(identity.data.ticketId);
      span.setError("socket_ticket_replayed");
      return jsonResponse({ error: "socket_ticket_replayed" }, 401);
    }

    const pair = Object.values(new WebSocketPair());
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) {
      span.setError("websocket_unavailable");
      return jsonResponse({ error: "websocket_unavailable" }, 500);
    }

    const attachment: SocketAttachment = {
      connectionId: uuidV7(),
      workspaceId: identity.data.workspaceId,
      workstreamId: identity.data.workstreamId,
      substreamId: identity.data.substreamId,
      userId: identity.data.userId,
      ticketId: identity.data.ticketId,
      sessionId: identity.data.sessionId,
      role: auth.role,
      analyticsWorkspaceId: auth.analyticsWorkspaceId ?? null,
      ...((identity.data.impersonatorUserId ?? auth.impersonatorUserId)
        ? { impersonatorUserId: identity.data.impersonatorUserId ?? auth.impersonatorUserId } : {}),
      connectedAt: new Date().toISOString(),
      afterSequence: identity.data.afterSequence ?? 0,
      subscribed: false,
      publishPresence: identity.data.afterSequence === undefined,
      speculative: identity.data.speculative,
      parentArchived: identity.data.parentArchived,
      membershipVersion: identity.data.membershipVersion ?? 0,
      snapshotInFlight: false,
      transcriptSnapshot: null,
    };

    this.state.acceptWebSocket(server, [attachment.workspaceId, attachment.userId]);
    // Cloudflare's hibernation lifecycle registers the server end first, then
    // persists the connection state that a replacement isolate deserializes.
    // We keep no socket map to rebuild: handlers enumerate getWebSockets() and
    // validate each attachment at the point of use.
    server.serializeAttachment(attachment);

    if (identity.data.afterSequence !== undefined) {
      try {
        const subscribed = await this.fulfillSubscription(
          server,
          attachment.workspaceId,
          attachment.workstreamId,
          identity.data.afterSequence,
          span,
        );
        span.setAttributes({
          "rally.socket.subscription_bootstrap": true,
          "rally.socket.subscription_bootstrap_outcome": subscribed ? "subscribed" : "resync",
        });
      } catch (error) {
        // Admission and ticket consumption have already happened. Return the
        // upgrade and close its registered server end so the client reconnects
        // with a fresh ticket; throwing here would answer 500 while leaving an
        // unreachable socket in the hibernation set.
        logWarn(this.env, "substream_subscription_bootstrap_failed", {
          workspace_id: attachment.workspaceId,
          workstream_id: attachment.workstreamId,
          substream_id: attachment.substreamId,
          reason: error instanceof Error ? error.message : "unknown",
        });
        span.setError("subscription_bootstrap_failed");
        span.setAttributes({
          "rally.socket.subscription_bootstrap": true,
          "rally.socket.subscription_bootstrap_outcome": "failed",
        });
        server.close(1011, "Subscription bootstrap failed");
      }
    }

    span.mark("workstream.room.socket.accept_connection");
    span.setAttributes({
      "rally.socket.outcome": "accepted",
      "rally.socket.connection_id": attachment.connectionId,
    });
    // Only the accepted upgrade carries these: a rejection is already a
    // readable JSON status, and the edge strips both before the 101 reaches a
    // client through `roomUpgradeDiagnostics` in `socket-service.ts`.
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        [RALLY_HEADERS.ROOM_ACCEPT_MS]: String(Math.max(0, Date.now() - acceptStartedAt)),
        [RALLY_HEADERS.ROOM_INSTANCE_AGE_MS]: String(instanceAgeMs),
      },
    });
  }

  private async acceptEvent(request: Request): Promise<Response> {
    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority) && !permitsLegacyRuntimeDrain(authority)) {
      return jsonResponse({
        error: "workstream_maintenance",
        phase: authority.phase,
        generation: authority.generation,
      }, 503);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const wrapped = BroadcastRequestSchema.safeParse(body);
    const unvalidatedEvent = wrapped.success ? wrapped.data.event : body;
    if (typeof unvalidatedEvent !== "object" || unvalidatedEvent === null) {
      return jsonResponse({ error: "invalid_event" }, 400);
    }

    const requestIdentity = RoomIdentitySchema.safeParse({
      workspaceId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSPACE_ID) ?? null,
      workstreamId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSTREAM_ID) ?? null,
    });
    if (!requestIdentity.success) {
      return jsonResponse({ error: "invalid_room_identity" }, 400);
    }
    try {
      // An event is published into an object that already knows what it is;
      // the header names the parent id and the stored row says its kind.
      const stored = this.objectStore.identity();
      if (!stored) return jsonResponse({ error: "room_identity_unavailable" }, 409);
      this.objectStore.ensureIdentity({
        workspaceId: requestIdentity.data.workspaceId,
        parentKind: stored.parentKind,
        parentId: requestIdentity.data.workstreamId,
      }, this.env.AVALON_REGION);
    } catch (error) {
      if (error instanceof Error && error.message === "workstream_object_identity_mismatch") {
        return jsonResponse({ error: "room_identity_mismatch" }, 409);
      }
      throw error;
    }

    const rawEvent = unvalidatedEvent as Record<string, unknown>;
    const requestedSequence =
      typeof rawEvent.sequence === "number" && Number.isSafeInteger(rawEvent.sequence)
        ? rawEvent.sequence
        : undefined;
    const candidate = {
      ...rawEvent,
      // Validate before consuming a room sequence. The committed event is
      // assigned its real sequence atomically with any stream checkpoint.
      sequence: 0,
      occurredAt:
        typeof rawEvent.occurredAt === "string" ? rawEvent.occurredAt : new Date().toISOString()
    };
    const unsequencedEvent = ServerSocketEventSchema.safeParse(candidate);

    if (!unsequencedEvent.success) {
      return jsonResponse(
        { error: "invalid_event", details: unsequencedEvent.error.flatten().fieldErrors },
        400
      );
    }
    if (this.semanticRealtimePending
      && !await this.flushSemanticRealtimeOutboxBestEffort()) {
      // The canonical snapshot already contains both the deferred fact and
      // this object's product state. Do not allocate a higher room sequence
      // ahead of the durable canonical predecessor.
      return jsonResponse({ accepted: true, deferredBehindCanonical: true }, 202);
    }
    const event = await this.commitRealtimeEvent(unsequencedEvent.data, requestedSequence);

    this.recordRecentEvent(event);
    // Before the broadcast, so the event that excluded them is not the last
    // thing they are sent. This is the transcript feed — the highest-frequency
    // socket in the product — so it is gated on an event that can actually
    // narrow visibility, and it reads only this object's own SQL. The D1
    // membership query that used to sit here is gone for good; losing workspace
    // membership is the revocation queue's job. See docs/access-revocation.md.
    const evicted = retractsReadAccess(event) ? this.evictReadersWhoLostLocalAccess() : false;
    this.broadcast(event);
    // After the event, not before: presence allocates a sequence of its own and
    // this event's was allocated first, so sending the roster ahead of it would
    // put a higher sequence on the wire before a lower one and the client would
    // drop the event that closed the work stream. `webSocketClose` fires only
    // for a client-initiated close, so closing here invokes nothing and the
    // people who remain would otherwise keep seeing an evicted reader present.
    if (evicted) {
      const identity = this.objectStore.identity();
      if (identity) await this.broadcastPresence(identity.workspaceId, identity.parentId);
    }
    return jsonResponse({ accepted: true, sequence: event.sequence }, 202);
  }

  protected override armAlarmBeforeDueWork(now: number): Promise<unknown> {
    // Delivery consumes the alarm, so until this returns the object has no
    // wake-up at all. Everything below it awaits the network, and a cancelled
    // continuation never settles — it does not throw, so a `finally` would not
    // run either. Arming first is what makes the sweep floor a floor rather
    // than something reachable only when the work it guards already succeeded.
    return this.armAlarmDuringRunDrain(now);
  }

  protected override armAlarmAfterDueWork(): Promise<unknown> {
    return this.loopDrainDeferred
      ? this.armAlarmDuringRunDrain()
      : this.armNextAlarm();
  }

  /**
   * Re-arm without reclaiming the loop work this invocation is responsible for.
   *
   * Everything else this object waits on keeps its own deadline, so only the
   * run lane is held back, and only to one heartbeat horizon: that bounds
   * recovery if this invocation is cancelled without turning a live drain into
   * an alarm that fires the instant it returns. Pending wake-ups are read from
   * the entry index rather than `workstream_wakeups` so this and the base agree
   * on when the next timer is due.
   */
  private async armAlarmDuringRunDrain(now: number = Date.now()): Promise<void> {
    if (this.retiredParentKind() !== null) return;
    await this.armNextAlarm({
      now,
      overdueAt: now + KEEP_ALIVE_INTERVAL_MS,
      derivedCandidates: [
        this.objectStore.nextRegionalEffectDueAt(),
        this.objectStore.nextSemanticRealtimeDueAt(),
        nextConversationViewAt(this.state.storage.sql),
        nextSearchProjectionDueAt(this.state.storage.sql, this.env),
        nextAuthorizationProjectionAt(this.state.storage.sql),
        this.nextExternalSettlementAt(),
        this.nextMemorySweepAt(),
        now + KEEP_ALIVE_INTERVAL_MS,
      ],
    });
  }

  /**
   * Derived from the persistent loop and subordinate receipt rows alone.
   *
   * This deliberately does not consult `agentDrain.active`. It used to, and an
   * invocation cancelled between claiming a run and finishing it then left the
   * row `running` with the alarm already deleted — nothing was left to
   * rediscover it, and the member watched a spinner that would never resolve.
   * In-memory knowledge that a drain is running belongs to deduplication, not
   * to scheduling.
   */
  private nextLoopWorkAt(now: number = Date.now()): number | null {
    // The loop row is created by first admission, so a run receipt can exist
    // before it does — a recovered pre-loop run, or one seeded across a
    // migration. The receipt scan below must run either way: deriving the next
    // alarm only when the singleton exists is how a claimed run stops
    // contributing a due time and stalls with nothing left to rediscover it.
    const authority = this.state.storage.sql.exec<{ archived_at: number | null }>(
      `SELECT archived_at FROM workstream WHERE id = 1`,
    ).toArray()[0];
    if (authority && authority.archived_at !== null) return null;
    const loop = this.loop.loop();
    if (loop?.status === "executing") return loop.lease_expires_at;
    // What the loop can take, not what is queued. A room parked on a question
    // with a message queued behind it has pending input and no work: waking on
    // it would re-arm at `now` on every alarm, for as long as the question
    // stays open. Admitting the answer arms its own wake.
    if (loop) {
      if (this.transcript.hasLeadingInputWithoutRun()) return now;
      // A stopped background agent holds every new execution (see
      // `claimPersistentLoopExecution`), so its queued activation input is no
      // more work than a parked room's. Waking on it re-armed at `now` on every
      // alarm, several times a second, for as long as the agent stayed
      // stopped. Messages that start no run still land while stopped, so the
      // branch above still wakes for them. Resuming clears `stopped_at` in the
      // same admission that queues the resuming message, and that admission
      // arms its own wake.
      const stopped = this.backgroundAgentStopped();
      if (!stopped && this.transcript.nextActivationInput(loop.loop_id) !== undefined) return now;
      // The room then goes quiet with messages still queued only if the agent
      // is stopped or an open question is waiting for its answer. A newly
      // admitted ordinary message cancels that question and supplies the tool
      // result during promotion.
      const queued = stopped ? [] : this.loop.pendingInputs();
      if (queued.length > 0) {
        logWarn(this.env, "substream_loop_parked_with_queued_input", {
          loop_id: loop.loop_id,
          queued_input_count: queued.length,
        });
      }
    }
    const preparation = this.product.nextRecoverableInputPreparationAt(now);
    if (preparation !== null) return preparation;
    // An admission this isolate is still preparing is in-memory work standing
    // over a durable reservation, and that reservation is hidden from
    // `pendingInputs` until it settles. Returning `null` here instead is what
    // let the re-arm at the end of the very alarm that found it delete the
    // object's only wake-up, stranding that message — and, behind the
    // head-of-line gate, every message queued after it. The instant is when
    // the claim stops being evidence of a running owner, at which point the
    // branch above takes over and resumes it.
    const claimed = this.product.nextInputPreparationWakeAt(now);
    if (claimed !== null) return claimed;
    const receipt = this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(COALESCE(execution_available_at, created_at)) AS due_at FROM runs
        WHERE execution_context_json IS NOT NULL
          AND substream_loop_id IS NULL AND terminalized_at IS NULL
          AND status IN ('admitted', 'running')`,
    ).toArray()[0]?.due_at ?? null;
    return receipt === null ? null : Math.max(now, Number(receipt));
  }

  /** Whether this object is a background agent its owner has stopped. */
  private backgroundAgentStopped(): boolean {
    return this.state.storage.sql.exec<{ stopped_at: number | null }>(
      "SELECT stopped_at FROM background_agent WHERE id = 1",
    ).toArray()[0]?.stopped_at != null;
  }

  /** Oldest post-run receipt, ordered independently from executable work. */
  private nextExternalSettlementAt(): number | null {
    const row = this.state.storage.sql.exec<{ due_at: number }>(
      `SELECT COALESCE(execution_available_at, terminalized_at) AS due_at FROM runs
        WHERE execution_context_json IS NOT NULL AND terminalized_at IS NOT NULL
          AND external_settled_at IS NULL
        ORDER BY terminalized_at, run_id LIMIT 1`,
    ).toArray()[0];
    return row ? Number(row.due_at) : null;
  }

  /**
   * The wake reasons this object derives from its own tables.
   *
   * Agent timers are deliberately absent: they live in `_internal_durable_alarms` as
   * `agent_timer` entries, so every wake-up due at one instant fires in one
   * alarm and a failing one is gated on its own rather than blocking the
   * queue behind it. The keep-alive is not a row at all — it is an in-memory
   * lease held only while a run is streaming — so it stays derived.
   */
  protected override nextDerivedAlarmCandidates(now: number): readonly number[] {
    // A retired parent's object has no lane to wake (see `alarm`).
    if (this.retiredParentKind() !== null) return [];
    const candidates: Array<number | null> = [
      this.objectStore.nextRegionalEffectDueAt(),
      this.objectStore.nextSemanticRealtimeDueAt(),
      nextConversationViewAt(this.state.storage.sql),
      nextSearchProjectionDueAt(this.state.storage.sql, this.env),
        nextAuthorizationProjectionAt(this.state.storage.sql),
      this.nextLoopWorkAt(now),
      this.nextExternalSettlementAt(),
      this.nextMemorySweepAt(),
    ];
    if (this.keepAliveLease.active) candidates.push(now + KEEP_ALIVE_INTERVAL_MS);
    return candidates.filter((candidate): candidate is number => candidate !== null);
  }

  private async fulfillSubscription(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    afterSequence: number,
    span: FlowSpan = noFlowSpan,
    snapshotReasonOverride?: "reconciliation",
  ): Promise<boolean> {
    const preparedTicketId = this.readAttachment(socket)?.ticketId;
    let deliveredThrough = await span.step("workstream.room.subscribe.current_sequence", () =>
      this.currentSequence());
    const plan = planSocketReplay(
      afterSequence,
      deliveredThrough,
      this.replayFloorSequence,
      this.recentEvents,
    );
    // Which of the three plans a subscription takes is the first question
    // asked of a slow open: a snapshot reads canonical state, a replay sends
    // what is already in memory, and a sequence-ahead resync makes the client
    // fetch canonical state over HTTP instead.
    span.setAttributes({
      "rally.subscribe.replay_plan": plan.type,
      ...(plan.type === "snapshot" ? {
        "rally.subscribe.snapshot_reason": snapshotReasonOverride ?? plan.reason,
      } : {}),
      ...(plan.type === "replay" ? { "rally.subscribe.replay_event_count": plan.events.length } : {}),
    });
    const delivered = await span.step("workstream.room.subscribe.deliver", () =>
      this.deliverReplayPlan(
        socket,
        workspaceId,
        workstreamId,
        deliveredThrough,
        plan,
        span,
        snapshotReasonOverride,
      ));
    if (!delivered) {
      if (preparedTicketId) this.deletePreparedSocketAdmission(preparedTicketId);
      return false;
    }

    // Loading a snapshot awaits object storage and can yield to a concurrently
    // published event. Keep this socket out of broadcasts until one in-memory
    // catch-up closes that race. The catch-up may replay or resync, but never
    // assemble a second snapshot whose own wait would need a third stage.
    const catchUpSequence = await span.step("workstream.room.subscribe.catch_up_sequence", () =>
      this.currentSequence());
    if (catchUpSequence > deliveredThrough) {
      span.setAttributes({ "rally.subscribe.catch_up_events": catchUpSequence - deliveredThrough });
      const caughtUp = await span.step("workstream.room.subscribe.deliver_catch_up", () =>
        this.deliverReplayPlan(
          socket,
          workspaceId,
          workstreamId,
          catchUpSequence,
          planSocketReplay(
            deliveredThrough,
            catchUpSequence,
            this.replayFloorSequence,
            this.recentEvents,
            false,
          ),
        ));
      if (!caughtUp) {
        if (preparedTicketId) this.deletePreparedSocketAdmission(preparedTicketId);
        return false;
      }
      deliveredThrough = catchUpSequence;
    }

    const attachment = this.readAttachment(socket);
    if (!attachment) throw new Error("Missing connection identity during subscription");
    socket.serializeAttachment({
      ...attachment,
      afterSequence: deliveredThrough,
      subscribed: true,
    } satisfies SocketAttachment);
    if (preparedTicketId) this.deletePreparedSocketAdmission(preparedTicketId);
    this.offerPendingDesktopActions(socket, attachment.userId, deliveredThrough);
    return true;
  }

  private async deliverReplayPlan(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    currentSequence: number,
    plan: SocketReplayPlan,
    span: FlowSpan = noFlowSpan,
    snapshotReasonOverride?: "reconciliation",
  ): Promise<boolean> {
    if (plan.type === "snapshot") {
      const delivered = await this.sendSnapshot(
        socket,
        workspaceId,
        workstreamId,
        snapshotReasonOverride ?? plan.reason,
        currentSequence,
        span,
      );
      if (delivered) return true;
      this.sendResyncRequired(socket, currentSequence, "history_unavailable");
      return false;
    }
    if (plan.type === "replay") {
      for (const event of plan.events) socket.send(JSON.stringify(event));
      return true;
    }
    this.sendResyncRequired(socket, currentSequence, plan.reason);
    return false;
  }

  private sendResyncRequired(
    socket: WebSocket,
    currentSequence: number,
    reason: "history_unavailable" | "snapshot_expired" | "sequence_ahead",
  ): void {
    socket.send(JSON.stringify(this.resyncRequiredEvent(currentSequence, reason)));
  }

  private resyncRequiredEvent(
    currentSequence: number,
    reason: "history_unavailable" | "snapshot_expired" | "sequence_ahead",
  ): ServerSocketEvent {
    return ServerSocketEventSchema.parse({
      type: "resync_required",
      sequence: currentSequence,
      occurredAt: new Date().toISOString(),
      reason,
      latestSequence: currentSequence,
      activeStreams: reason === "history_unavailable"
        ? this.objectStore.activeStreamCheckpoints()
        : [],
      activeCompaction: this.objectStore.activeCompaction(),
      activeInferenceDelays: this.objectStore.activeInferenceDelays(),
    });
  }

  private async sendSnapshot(
    socket: WebSocket,
    workspaceId: string,
    workstreamId: string,
    reason: "initial" | "reconciliation" | "history_unavailable",
    knownSequence?: number,
    span: FlowSpan = noFlowSpan,
  ): Promise<boolean> {
    try {
      const attachment = this.readAttachment(socket);
      if (!attachment) throw new Error("Missing connection identity while loading snapshot");
      const sequence = knownSequence ?? await this.currentSequence();
      const prepared = attachment.ticketId
        ? this.preparedSocketAdmissions.get(attachment.ticketId)
        : undefined;
      let snapshot: PreparedSocketSnapshot;
      if (
        prepared?.snapshot
        && prepared.snapshotReason === reason
        && prepared.snapshotSequence === sequence
        && prepared.snapshotRevision === this.socketSnapshotRevision
      ) {
        snapshot = prepared.snapshot;
        if (!attachment.speculative && snapshot.settleUnseen) {
          const settled = await span.step("workstream.room.snapshot.mark_opened", () =>
            this.product.markOpenedAdmitted(prepared.auth));
          snapshot = {
            ...snapshot,
            event: {
              ...snapshot.event,
              workstream: { ...snapshot.event.workstream, unseen: !settled },
            },
          };
        }
        span.setAttributes({ "rally.snapshot.source": "ticket_preparation" });
      } else {
        const auth = await this.socketViewerAuth(attachment);
        if (!auth) throw new Error("Snapshot viewer is no longer authorized");
        snapshot = await span.step("workstream.room.snapshot.detail", () =>
          this.assembleSocketSnapshot(
            workspaceId,
            workstreamId,
            auth,
            attachment.speculative,
            reason,
            sequence,
            true,
          ));
        span.setAttributes({
          "rally.snapshot.source": prepared
            ? "ticket_preparation_incomplete"
            : "room_assembly",
        });
      }
      if (attachment.ticketId) this.deletePreparedSocketAdmission(attachment.ticketId);
      span.mark("workstream.room.snapshot.encode");
      span.setAttributes({
        // Bytes, not `encoded.length`: that counts UTF-16 code units, so any
        // non-ASCII transcript under-reported against a cap measured in UTF-8.
        "rally.snapshot.bytes": snapshot.encodedBytes,
        "rally.snapshot.turn_count": snapshot.event.transcript.ranges.reduce(
          (count, range) => count + range.turns.length,
          snapshot.event.transcript.activeTurns.length,
        ),
      });
      socket.send(JSON.stringify(snapshot.event));
      for (const [chunkIndex, inputs] of snapshot.pendingInputChunks.entries()) {
        const frame = JSON.stringify(ServerSocketEventSchema.parse({
          type: "pending_inputs_snapshot_chunk",
          sequence,
          occurredAt: snapshot.event.occurredAt,
          snapshotId: snapshot.event.transcript.snapshotId,
          chunkIndex,
          chunkCount: snapshot.pendingInputChunks.length,
          inputs,
        }));
        if (textEncoder.encode(frame).byteLength > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
          throw new Error("substream_pending_input_snapshot_chunk_too_large");
        }
        socket.send(frame);
      }
      const currentAttachment = this.readAttachment(socket);
      if (currentAttachment) {
        socket.serializeAttachment({
          ...currentAttachment,
          transcriptSnapshot: snapshot.transcriptSnapshot,
        } satisfies SocketAttachment);
      }
      return true;
    } catch (error) {
      // The caller converts this into a resync the client can act on, but a
      // snapshot that cannot be assembled is an object defect, not a client
      // state problem — swallowing the reason here once cost three tests a
      // fifteen-second silent hang each. Name it before degrading.
      logWarn(this.env, "substream_snapshot_assembly_failed", {
        workspace_id: workspaceId,
        workstream_id: workstreamId,
        substream_id: this.externalSubstreamId(),
        reason: error instanceof Error ? error.message : "unknown",
      });
      span.setError("snapshot_unavailable");
      return false;
    }
  }

  private async assembleSocketSnapshot(
    workspaceId: string,
    workstreamId: string,
    auth: AuthContext,
    speculative: boolean,
    reason: "initial" | "reconciliation" | "history_unavailable",
    sequence: number,
    markOpened: boolean,
  ): Promise<PreparedSocketSnapshot> {
    const viewers = await this.loadViewers(workspaceId, workstreamId);
    const loadedWorkstream = await this.product.getAdmitted(
      auth,
      viewers,
      markOpened && !speculative,
    );
    // Preparation must not settle unseen state before a socket actually opens,
    // but the frame it prepares is the post-open view the accepted socket will
    // receive. The accept path performs the real idempotent settlement before
    // sending this frame.
    const workstream = !markOpened && !speculative && loadedWorkstream.unseen
      ? { ...loadedWorkstream, unseen: false }
      : loadedWorkstream;
    let transcript = this.transcript.createOpeningSnapshot({
      unreadHighWaterAttentionOrdinal: reason === "initial"
        ? workstream.firstUnreadSequenceNumber
        : null,
    });
    const storedCheckpoints = this.objectStore.activeStreamCheckpoints();
    const activeStreams = workstream.harnessStatus === "running"
      ? storedCheckpoints.filter((checkpoint) =>
          checkpoint.harnessRunId === workstream.latestHarnessRunId)
      : [];
    const storedCompaction = this.objectStore.activeCompaction();
    const activeCompaction = workstream.harnessStatus === "running"
      && storedCompaction?.harnessRunId === workstream.latestHarnessRunId
      ? storedCompaction
      : null;
    const occurredAt = new Date().toISOString();
    let pendingInputChunks: WorkstreamTranscriptSnapshot["pendingInputs"][] = [];
    const snapshotEvent = (): SocketSnapshotEvent => ServerSocketEventSchema.parse({
      type: "snapshot",
      reason,
      sequence,
      occurredAt,
      workstream,
      transcript,
      pendingInputChunkCount: pendingInputChunks.length,
      // A Breakout's inherited context was the only producer of these chunks.
      initialContextChunkCount: 0,
      activeStreams,
      activeCompaction,
      activeInferenceDelays: workstream.harnessStatus === "running"
        ? this.objectStore.activeInferenceDelays().filter((delay) => delay.harnessRunId === workstream.latestHarnessRunId)
        : [],
    }) as SocketSnapshotEvent;
    let event = snapshotEvent();
    let encodedBytes = textEncoder.encode(JSON.stringify(event)).byteLength;
    if (encodedBytes > WORKSTREAM_REALTIME_MAX_FRAME_BYTES && transcript.pendingInputs.length > 0) {
      // Pending inputs are server-authoritative and cannot be dropped merely
      // to fit one WebSocket frame. Split them into ordered snapshot chunks;
      // one admitted message is bounded far below the frame ceiling, while
      // the complete queue is intentionally unbounded by transport size.
      pendingInputChunks = transcript.pendingInputs.map((input) => [input]);
      transcript = { ...transcript, pendingInputs: [] };
      event = snapshotEvent();
      encodedBytes = textEncoder.encode(JSON.stringify(event)).byteLength;
    }
    while (encodedBytes > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
      const canonicalTurns = [
        ...transcript.ranges.flatMap((range) => range.turns),
        ...transcript.activeTurns,
      ];
      const uniqueTurns = new Map(canonicalTurns.map((turn) => [turn.turnId, turn]));
      if (uniqueTurns.size === 1) {
        const turn = [...uniqueTurns.values()][0]!;
        if (turn.blocksOmitted !== true) {
          logWarn(this.env, "substream_transcript_turn_oversized", {
            workspace_id: workspaceId,
            workstream_id: workstreamId,
            turn_id: turn.turnId,
          });
          const envelope = this.transcript.omittedTurnEnvelope(turn);
          transcript = {
            ...transcript,
            ranges: transcript.ranges.map((range) => ({
              ...range,
              turns: range.turns.map((candidate) =>
                candidate.turnId === turn.turnId ? envelope : candidate),
            })),
            activeTurns: transcript.activeTurns.map((candidate) =>
              candidate.turnId === turn.turnId ? envelope : candidate),
          };
          event = snapshotEvent();
          encodedBytes = textEncoder.encode(JSON.stringify(event)).byteLength;
          if (encodedBytes <= WORKSTREAM_REALTIME_MAX_FRAME_BYTES) break;
        }
      }
      const narrowed = narrowSocketTranscriptSnapshot(transcript, encodedBytes - WORKSTREAM_REALTIME_MAX_FRAME_BYTES);
      if (!narrowed) throw new Error("substream_snapshot_frame_too_large");
      transcript = narrowed;
      event = snapshotEvent();
      encodedBytes = textEncoder.encode(JSON.stringify(event)).byteLength;
    }
    // Validate each spill frame without retaining its serialized form. The
    // complete pending-input queue is intentionally not aggregate-size-bound,
    // so delivery below must hold only one encoded chunk at a time.
    for (const [chunkIndex, inputs] of pendingInputChunks.entries()) {
      const frame = JSON.stringify(ServerSocketEventSchema.parse({
        type: "pending_inputs_snapshot_chunk",
        sequence,
        occurredAt,
        snapshotId: transcript.snapshotId,
        chunkIndex,
        chunkCount: pendingInputChunks.length,
        inputs,
      }));
      if (textEncoder.encode(frame).byteLength > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
        throw new Error("substream_pending_input_snapshot_chunk_too_large");
      }
    }
    return {
      event,
      pendingInputChunks,
      encodedBytes,
      transcriptSnapshot: {
        snapshotId: transcript.snapshotId,
        snapshotThrough: transcript.snapshotThrough,
        snapshotAtUtc: transcript.snapshotAtUtc,
      },
      settleUnseen: !markOpened && !speculative && loadedWorkstream.unseen,
    };
  }

  private async socketViewerAuth(attachment: SocketAttachment): Promise<AuthContext | null> {
    return attachment.sessionId && attachment.role !== undefined
      ? {
          sessionId: attachment.sessionId,
          userId: attachment.userId,
          workspaceId: attachment.workspaceId,
          region: this.env.AVALON_REGION,
          role: attachment.role,
          analyticsWorkspaceId: attachment.analyticsWorkspaceId ?? null,
          ...(attachment.impersonatorUserId ? { impersonatorUserId: attachment.impersonatorUserId } : {}),
        }
      // A socket hibernated by the previous deployment has no admitted role
      // in its attachment. Preserve it through the rolling deploy by taking
      // the old one-time path; new sockets never repeat this regional read.
      : await this.socketAuth(attachment);
  }

  private async loadViewers(
    workspaceId: string,
    workstreamId: string,
    excluding?: WebSocket
  ): Promise<WorkstreamDetail["viewers"]> {
    const attachments = this.state
      .getWebSockets()
      .filter((socket) => socket !== excluding)
      .map((socket) => this.readAttachment(socket))
      .filter((attachment): attachment is SocketAttachment =>
        Boolean(
          attachment
          && attachment.subscribed
          && attachment.publishPresence
          // Staff on a support session are not the person being present.
          && !attachment.impersonatorUserId
          && attachment.workspaceId === workspaceId
          && attachment.workstreamId === workstreamId
        )
      );

    const participantIds = new Set(this.product.activeParticipantIds());
    const viewers = distinctNonParticipantViewers(attachments, participantIds);

    return Promise.all(
      viewers.map(async (attachment) => {
        const user = await this.env.DB.prepare(`SELECT * FROM users WHERE id = ?1 LIMIT 1`)
          .bind(attachment.userId)
          .first<UserRow>();
        if (!user) throw new Error("Viewer no longer exists");
        return { user: userFromRow(user), connectedAt: attachment.connectedAt };
      })
    );
  }

  private async broadcastPresence(
    workspaceId: string,
    workstreamId: string,
    excluding?: WebSocket,
  ): Promise<void> {
    try {
      if (this.semanticRealtimePending
        && !await this.flushSemanticRealtimeOutboxBestEffort()) return;
      const viewers = await this.loadViewers(workspaceId, workstreamId, excluding);
      const sequence = await this.allocateSequence();
      const event = ServerSocketEventSchema.parse({
        type: "presence_changed",
        sequence,
        occurredAt: new Date().toISOString(),
        viewers
      });
      this.recordRecentEvent(event);
      this.broadcast(event, excluding);
    } catch {
      // Presence is deliberately ephemeral. A failed presence refresh must not
      // break the canonical work-stream connection.
    }
  }

  private broadcast(
    event: ServerSocketEvent,
    excluding?: WebSocket,
  ): void {
    const payload = JSON.stringify(event);
    if (textEncoder.encode(payload).byteLength > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
      throw new Error("Realtime event exceeds the bounded frame size");
    }

    for (const socket of this.state.getWebSockets()) {
      if (socket === excluding) continue;
      const attachment = this.readAttachment(socket);
      if (!attachment?.subscribed) continue;
      try {
        socket.send(payload);
      } catch {
        // The runtime will deliver close/error separately; one stale socket must
        // not prevent delivery to healthy clients.
      }
    }
  }

  private recordRecentEvent(event: ServerSocketEvent): void {
    if (event.type === "snapshot" || event.type === "error" || event.type === "resync_required") return;
    const replayedIndex = this.recentEvents.findIndex((candidate) => candidate.sequence === event.sequence);
    if (replayedIndex >= 0) {
      const previous = this.recentEvents[replayedIndex]!;
      this.recentEventBytes -= textEncoder.encode(JSON.stringify(previous)).byteLength;
      this.recentEvents[replayedIndex] = event;
      this.recentEventBytes += textEncoder.encode(JSON.stringify(event)).byteLength;
      while (this.recentEvents.length > MAX_REPLAY_EVENTS || this.recentEventBytes > MAX_REPLAY_BYTES) {
        const removed = this.recentEvents.shift();
        if (!removed) break;
        this.recentEventBytes -= textEncoder.encode(JSON.stringify(removed)).byteLength;
        this.replayFloorSequence = removed.sequence;
      }
      return;
    }
    const bytes = textEncoder.encode(JSON.stringify(event)).byteLength;
    if (this.replayFloorSequence === null) this.replayFloorSequence = Math.max(0, event.sequence - 1);
    this.recentEvents.push(event);
    this.recentEventBytes += bytes;
    while (this.recentEvents.length > MAX_REPLAY_EVENTS || this.recentEventBytes > MAX_REPLAY_BYTES) {
      const removed = this.recentEvents.shift();
      if (!removed) break;
      this.recentEventBytes -= textEncoder.encode(JSON.stringify(removed)).byteLength;
      this.replayFloorSequence = removed.sequence;
    }
  }

  /**
   * Refuse one frame in a way the reader can act on.
   *
   * Pass `requestId` whenever the refused frame carried one, and leave it null
   * only when the frame genuinely had none. A caller that correlated its
   * request is waiting on that identity and on nothing else: an uncorrelated
   * refusal is invisible to it, so its promise survives until a local timeout
   * fires and reports a timeout the room never had. The default is null
   * because most refusals answer no request — a malformed frame, or a mutation
   * that belongs on REST — not because omitting it is free where one exists.
   */
  private sendError(socket: WebSocket, code: string, message: string, requestId: string | null = null): void {
    const event = ServerSocketEventSchema.parse({
      type: "error",
      // A private protocol error is not part of the canonical feed. Reusing
      // the current cursor avoids creating a transcript gap merely because a
      // client sent a malformed or misrouted frame.
      sequence: this.objectStore.currentSequence(),
      occurredAt: new Date().toISOString(),
      code,
      message,
      requestId
    });
    this.sendSocketFrame(socket, JSON.stringify(event));
  }

  /** A closed socket is a delivery miss, not a second command failure. */
  private sendSocketFrame(socket: WebSocket, encoded: string): boolean {
    try {
      socket.send(encoded);
      return true;
    } catch {
      return false;
    }
  }

  private sendSocketCommandResult(socket: WebSocket, result: unknown): boolean {
    return this.sendSocketFrame(
      socket,
      JSON.stringify(WorkstreamSocketCommandResultSchema.parse(result)),
    );
  }

  /**
   * Drop every socket this agent holds for a person whose access ended.
   *
   * The only way a socket here is closed for lost access; see
   * `docs/access-revocation.md`. This agent has no view of D1 membership or
   * sessions on its own, and deliberately does not acquire one — the transcript
   * feed is the highest-frequency socket in the product, and an authorization
   * question on that path would be asked per token frame.
   */
  /**
   * Close the sockets of readers this work stream itself no longer admits.
   *
   * Object-local and synchronous: `product.canRead` reads this object's own
   * root and participant rows. It answers "may this person read *this work
   * stream*", which no queue message carries and no other object knows. Losing
   * workspace membership is the separate question that {@link revokeSocketAccess}
   * answers, and the two must not be confused for each other.
   */
  private evictReadersWhoLostLocalAccess(): boolean {
    let evicted = false;
    for (const [ticketId, prepared] of [...this.preparedSocketAdmissions]) {
      if (this.product.canRead(prepared.input.userId)) continue;
      this.deletePreparedSocketAdmission(ticketId);
    }
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.readAttachment(socket);
      if (!attachment || this.product.canRead(attachment.userId)) continue;
      disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
      evicted = true;
    }
    return evicted;
  }

  async revokeSocketAccess(revocation: SocketAccessRevocation): Promise<void> {
    await this.initialized;
    const request = SocketAccessRevocationSchema.parse(revocation);
    this.productSessionAdmissionRevision += 1;
    this.productSessionAdmissions.clear();
    // Keep the newest retraction per reader even when no socket or preparation
    // exists yet. An older deferred preparation may be suspended in its D1
    // authorization query and must not recreate access after this call.
    this.rememberSocketRevocation();
    let evicted = false;
    for (const [ticketId, prepared] of [...this.preparedSocketAdmissions]) {
      if (!(await revocationClosesSession(this.env, request, prepared.input))) continue;
      this.deletePreparedSocketAdmission(ticketId);
    }
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.readAttachment(socket);
      // This schema alone makes `sessionId` optional, which is why the rule is
      // shared rather than written out at each of the four roles — see
      // `revocationClosesSession`.
      if (!attachment || !(await revocationClosesSession(this.env, request, attachment))) continue;
      disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
      evicted = true;
    }
    // The people still here would otherwise go on seeing an evicted reader
    // listed as present: `webSocketClose` fires for a *client*-initiated close,
    // so closing one here invokes nothing.
    if (evicted) {
      const identity = this.objectStore.identity();
      if (identity) await this.broadcastPresence(identity.workspaceId, identity.parentId);
    }
  }

  private readAttachment(socket: WebSocket): SocketAttachment | null {
    try {
      const parsed = SocketAttachmentSchema.safeParse(socket.deserializeAttachment());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async currentSequence(): Promise<number> {
    return this.objectStore.currentSequence();
  }

  private async allocateSequence(requested?: number): Promise<number> {
    return this.objectStore.allocateSequence(requested);
  }

  /**
   * The event sequence and accumulated active text are one durable commit. A
   * snapshot can therefore be older than a concurrently arriving event (the
   * subscription catch-up handles that), but can never skip a stream frame
   * whose sequence it already claims to include.
   */
  private async commitRealtimeEvent(
    unsequencedEvent: ServerSocketEvent,
    requestedSequence?: number,
  ): Promise<ServerSocketEvent> {
    return this.objectStore.commitRealtimeEvent(unsequencedEvent, requestedSequence);
  }
}

applyRetirementGate(AgentLoopDO, {
  permit: [
    // Construction, arriving late. This object recovers its runtime lazily on
    // first access rather than in its constructor, so the window
    // `blockConcurrencyWhile` opens for the others closes before this runs.
    // It is the same category — making the object exist — and refusing it
    // fences the object out of existence rather than out of use. What recovery
    // must not do, re-arm an alarm, is prevented by those methods being inert.
    "startRuntimeRecovery",
    "meetingRetirementInventory",
  ],
  drop: {
    fetch: () => retiredObjectResponse(),
    // Hibernated socket callbacks. The socket is already dead to the product;
    // throwing here would only turn a quiet close into an error nobody reads.
    webSocketMessage: () => Promise.resolve(),
    webSocketClose: () => Promise.resolve(),
    webSocketError: () => Promise.resolve(),
    // The platform retries an alarm that throws. A retired object answers the
    // wake by doing nothing and arming nothing, which is what quiet means.
    alarm: () => Promise.resolve(),
  },
});
