import { ConversationMergeV1Schema } from "@rally/contracts";
import type { ScopeGrant } from "@rally/contracts/scope-grants";
import {
  ClaimScopeInvitationsSchema,
  ConnectorParticipantAdmissionSchema,
  CreateScopeInvitationsSchema,
  ListScopeInvitationsSchema,
  ManagedScopeGrantsSchema,
  ParticipantGrantMutationSchema,
  RevokeScopeInvitationSchema,
  ScopeAccessRequestSchema,
  ScopeAccessResultSchema,
  ScopeGrantManagementRequestSchema,
  ScopeGrantMutationResultSchema,
  ScopeGrantMutationSchema,
  ScopeInvitationResultSchema,
  ScopeSharingOptionsRequestSchema,
  ScopeSharingOptionsSchema,
  SharedNavigationWorkstreamSchema,
  SharedWorkstreamRequestSchema,
  type ParticipantGrantMutation,
  type ScopeAccessRequest,
  type ScopeAccessResult,
  type ScopeGrantMutation,
  type ScopeGrantMutationResult,
  type ScopeGrantTarget,
  type ScopeInvitationResult,
  type ScopeInvitationSummary,
} from "@rally/contracts/scope-grants";
import {
  IdSchema,
  SubstreamIdSchema,
  UserIdSchema,
  WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceIdSchema,
  WorkstreamControlMetadataSchema,
  WorkstreamControlSocketClientEventSchema,
  WorkstreamControlSocketEventSchema,
  WorkstreamIdSchema,
  asSubstreamId,
  asWorkspaceId,
  conversationNeedsViewer,
  isUnknownSocketEvent,
  safeParseSocketEvent,
  type SubstreamId,
  type UserId,
  type WorkspaceId,
  type WorkstreamControlMetadata,
  type WorkstreamControlSocketEvent,
} from "@rally/contracts";
import type { Region } from "@rally/contracts/regions";
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import {
  ParentEffectEnvelopeSchema,
  ParentEffectSchema,
  WorkstreamDirectoryCommonEffectSchema,
  WorkstreamDirectoryUserEffectSchema,
  conversationEffectHash,
  isPersonNotificationEffect,
  type ConversationEffect,
  type ConversationEffectEnvelope,
  type ParentEffect,
  type ParentEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import { breakoutMessageActivity } from "./breakout-activity";
import {
  BeginPrivateChildPreparationRequestSchema,
  ClaimPrivateChildConfirmationRequestSchema,
  ConversationParentAuthorityRequestSchema,
  ConversationParentAuthorityResultSchema,
  ConversationParentAuthorizeViewerRequestSchema,
  ConversationParentAuthorizeViewerResultSchema,
  ConversationParentListChildrenRequestSchema,
  ConversationParentListChildrenResultSchema,
  ConversationParentReserveChildRequestSchema,
  ConversationParentReserveChildResultSchema,
  ConversationParentTerminalDeadlinesRequestSchema,
  ConversationParentTerminalDeadlinesResultSchema,
  MutatePrivateChildParticipantRequestSchema,
  MutatePrivateChildParticipantResultSchema,
  PrivateChildPreparationOperationSchema,
  ReadPrivateChildPreparationRequestSchema,
  SavePreparedPrivateChildContextRequestSchema,
  SavePrivateChildCaptureRequestSchema,
  SavePrivateChildPartRequestSchema,
  SetPrivateChildArchivedRequestSchema,
  SetPrivateChildArchivedResultSchema,
  SetPrivateChildTerminalStatusRequestSchema,
  type BeginPrivateChildPreparationRequest,
  type ClaimPrivateChildConfirmationRequest,
  type ConversationParentAuthorityRequest,
  type ConversationParentAuthorityResult,
  type ConversationParentAuthorizeViewerRequest,
  type ConversationParentAuthorizeViewerResult,
  type ConversationParentKind,
  type ConversationParentListChildrenRequest,
  type ConversationParentListChildrenResult,
  type ConversationParentReserveChildRequest,
  type ConversationParentReserveChildResult,
  type ConversationParentTerminalDeadlinesRequest,
  type ConversationParentTerminalDeadlinesResult,
  type ListVisiblePrivateChildrenResult,
  type MutatePrivateChildParticipantRequest,
  type MutatePrivateChildParticipantResult,
  type PrivateChildPreparationOperation,
  type ReadPrivateChildPreparationRequest,
  type SavePreparedPrivateChildContextRequest,
  type SavePrivateChildCaptureRequest,
  type SavePrivateChildPartRequest,
  type SetPrivateChildArchivedRequest,
  type SetPrivateChildArchivedResult,
  type SetPrivateChildTerminalStatusRequest,
} from "@rally/contracts/conversation-parent";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { z } from "zod";

import type { AuthContext, Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { parseRpcInput } from "../lib/rpc-input";
import { stableUuid } from "../lib/stable-uuid";
import { uuidV7 } from "../lib/uuid-v7";
import { logWarn } from "../observability/logger";
import { createIdentityObjectPort } from "../runtime/identity-port";
import {
  revocationClosesSession,
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";
import { ConversationAuthorizationRequestSchema, type ConversationAuthorizationRequest } from "../services/authorization-policy";
import { resolveScopedAccess, type ScopedAccess } from "../services/scope-grant-policy";
import type { WorkspaceRelationship } from "../services/workspace-relationship-service";
import {
  ReceiveChildEffectsRequestSchema,
  canonicalState,
  type DirectoryCommonEffect,
  type DirectoryProjectionKind,
  type DirectoryUserEffect,
  type ReceiveChildEffectsRequest,
} from "./conversation-parent-object";
import { conversationObjectName } from "./names";
import { ParticipantTransferSnapshotSchema } from "./participant-authority-transfer";
import type { ScheduledAlarmStore } from "./scheduled-alarms";
import {
  PARTICIPANT_MIGRATION_ALARM,
  ScopeGrantStorage,
  participantMigrationAlarmKey,
} from "./scope-grant-storage";
import { ScopeInvitationService, scopeInvitationOrigin } from "./scope-invitation-service";

/**
 * One Channel's or Space's parent authority, hosted inside the Organization's
 * `WorkspaceDO`.
 *
 * This is what `WorkstreamDO` was for one object — the conversation-parent
 * contract, the child registry and projections, grants, invitations, Space
 * access provenance, private breakouts and the Channel control socket — moved
 * into the Organization object and keyed by `parent_id`. The rules, fences and
 * error codes are the ones that object had; `docs/hosted-conversation-parents.md`
 * has the table map and says what changed about where effects go.
 *
 * Constructed per call. It holds no state of its own beyond its parent id and
 * role: every fact is a row, so two instances for one parent inside one event
 * see the same thing.
 *
 * **Every statement names `parent_id`.** The rows of every Channel in the
 * Organization share these tables, and a statement that forgot the predicate
 * reads or rewrites all of them.
 */

/** Every way a Space differs from a Channel as a parent. */
export interface HostedParentRole {
  kind: "workstream" | "space";
  /** Whether the Channel control socket may attach. A Space has no feed to open. */
  admitsClientSockets: boolean;
  /** Whether a committed grant is published to the shared grant directory. */
  publishesGrantDirectory: boolean;
  /** Whether activity, notification and breakout projections leave this parent. */
  forwardsFeedEffects: boolean;
  /**
   * Whether the main conversation's directory effects describe this parent. A
   * Space's are acknowledged and ignored: WorkspaceDO writes every Space fact
   * itself, and only Spaces created before 2026-09-26 have a conversation.
   */
  appliesMainChildDirectory: boolean;
}

export const HOSTED_CHANNEL_ROLE: HostedParentRole = {
  kind: "workstream",
  admitsClientSockets: true,
  publishesGrantDirectory: true,
  forwardsFeedEffects: true,
  appliesMainChildDirectory: true,
};

export const HOSTED_SPACE_ROLE: HostedParentRole = {
  kind: "space",
  admitsClientSockets: false,
  publishesGrantDirectory: false,
  forwardsFeedEffects: false,
  appliesMainChildDirectory: false,
};

/** What the Organization object lends a hosted parent. */
export interface HostedParentHost {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly alarms: ScheduledAlarmStore;
  armNextAlarm(): Promise<void>;
  /** This parent's Channel control sockets. */
  controlSockets(parentId: string): WebSocket[];
  /** Accept a hibernating control socket under this parent's tags. */
  acceptControlSocket(server: WebSocket, parentId: string, userId: string): void;
  /** Push this Channel's workspace-socket row to one viewer, or to every socket. */
  publishChannelRow(parentId: string, userId?: string): Promise<void>;
  /**
   * Apply published effects inside the caller's transaction, and name the
   * ones whose remaining work leaves the object and so needs an outbox row.
   * A failure throws and takes the caller's transaction with it.
   */
  applyLocalEffects(envelopes: readonly ParentEffectEnvelope[]): { outbox: ParentEffectEnvelope[] };
  /** A person's workspace relationship, from the Organization's own table. */
  readRelationship(workspaceId: string, userId: string): Promise<WorkspaceRelationship | null>;
  /** Record a relationship this request just read from or wrote to D1. */
  noteRelationship(relationship: WorkspaceRelationship): void;
}

/** The hibernation tag every control socket of one parent carries. */
export function parentControlSocketTag(parentId: string): string {
  return `parent-control:${parentId}`;
}

/**
 * The breakouts one viewer may open under each of these parents: ready,
 * unarchived, and with the viewer active on the roster. One read for any
 * number of parents, so the sidebar's page costs the same as one Channel.
 */
export function visiblePrivateChildren(
  sql: SqlStorage,
  userId: string,
  parentIds: readonly string[],
): Map<string, ListVisiblePrivateChildrenResult["children"]> {
  const result = new Map<string, ListVisiblePrivateChildrenResult["children"]>();
  if (parentIds.length === 0) return result;
  const rows = sql.exec<{
    resolved: number; parent_id: string; substream_id: string; title: string; effect_json: string | null; user_effect_json: string | null;
    created_by_user_id: string; created_at: number; updated_at: number; origin_turn_id: string | null;
  }>(
    `SELECT child.parent_id, child.substream_id, child.title, child.resolved, directory.effect_json,
            viewer.effect_json AS user_effect_json,
            child.created_by_user_id, child.created_at, child.updated_at,
            json_extract(preparation.request_json, '$.sourceThroughTurnId') AS origin_turn_id
       FROM parent_children child
       JOIN parent_breakout_members member
         ON member.parent_id = child.parent_id AND member.substream_id = child.substream_id
       LEFT JOIN parent_breakout_preparations preparation
         ON preparation.parent_id = child.parent_id AND preparation.substream_id = child.substream_id
       LEFT JOIN parent_child_projections directory
         ON directory.parent_id = child.parent_id AND directory.substream_id = child.substream_id
       LEFT JOIN parent_child_viewer_projections viewer
         ON viewer.parent_id = child.parent_id AND viewer.substream_id = child.substream_id
        AND viewer.user_id = member.user_id
      WHERE child.parent_id IN (SELECT value FROM json_each(?))
        AND child.kind = 'child' AND child.status = 'ready' AND child.archived_at IS NULL
        AND member.user_id = ? AND member.active = 1
      ORDER BY child.parent_id, child.created_at, child.substream_id`,
    JSON.stringify(parentIds), userId,
  ).toArray();
  for (const child of rows) {
    const list = result.get(child.parent_id) ?? [];
    list.push({
      substreamId: asSubstreamId(child.substream_id),
      title: child.title,
      ...(child.resolved === 1 ? { resolved: true } : {}),
      ...(child.effect_json
        ? (() => {
          const common = WorkstreamDirectoryCommonEffectSchema.parse(JSON.parse(child.effect_json));
          return {
            ...(common.appearance ? { appearance: common.appearance } : {}),
            harnessStatus: harnessStatus(common.state),
            lastActivityAt: Date.parse(common.lastActivityAt),
          };
        })()
        : {}),
      ...(child.user_effect_json
        ? (() => {
          const viewer = WorkstreamDirectoryUserEffectSchema.parse(JSON.parse(child.user_effect_json));
          return { unreadCount: viewer.unreadCount, youAreMentioned: viewer.youAreMentioned, unseen: viewer.unseen ?? false };
        })()
        : {}),
      createdByUserId: UserIdSchema.parse(child.created_by_user_id),
      createdAt: child.created_at,
      updatedAt: child.updated_at,
      originTurnId: child.origin_turn_id,
    });
    result.set(child.parent_id, list);
  }
  return result;
}

/** Running background agents per parent, by the conversation each works for. */
export function runningBackgroundAgents(sql: SqlStorage, parentIds: readonly string[]): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  if (parentIds.length === 0) return result;
  for (const row of sql.exec<{ parent_id: string; root: string; n: number }>(
    `SELECT parent_id, COALESCE(json_extract(effect_json, '$.backgroundAgentRootSubstreamId'), '0') AS root,
            COUNT(*) AS n
       FROM parent_child_projections
      WHERE parent_id IN (SELECT value FROM json_each(?)) AND substream_id <> '0'
        AND json_extract(effect_json, '$.backgroundAgent') = 1
        AND json_extract(effect_json, '$.state') = 'running'
        AND json_extract(effect_json, '$.archivedAt') IS NULL
      GROUP BY parent_id, root
      ORDER BY parent_id, root`,
    JSON.stringify(parentIds),
  ).toArray()) {
    const counts = result.get(row.parent_id) ?? new Map<string, number>();
    counts.set(row.root, row.n);
    result.set(row.parent_id, counts);
  }
  return result;
}

/** Only the conversations this viewer can open: Main and their breakouts. */
export function visibleBackgroundAgentCounts(
  counts: ReadonlyMap<string, number>,
  visibleRoots: ReadonlySet<string>,
): Record<string, number> {
  return Object.fromEntries([...counts].filter(([root]) => visibleRoots.has(root)));
}

/** What a workspace-socket Channel row adds for its viewer. */
export interface ChannelViewerState {
  privateChildren: Array<Omit<ListVisiblePrivateChildrenResult["children"][number], "createdAt" | "updatedAt" | "lastActivityAt">
    & { createdAt: string; updatedAt: string; lastActivityAt?: string }>;
  privateChildrenWaterline: number;
  backgroundAgentCounts: Record<string, number>;
  /** `channels.rail_waterline`: when it passes the rail a client holds, it asks again. */
  railWaterline: number;
}

/**
 * The per-viewer Channel state the control socket used to send, for every
 * listed Channel this object hosts.
 */
export function channelViewerStates(
  sql: SqlStorage,
  userId: string,
  parentIds: readonly string[],
  background?: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Map<string, ChannelViewerState> {
  const result = new Map<string, ChannelViewerState>();
  if (parentIds.length === 0) return result;
  const hostedRows = sql.exec<{ parent_id: string; rail_waterline: number | null }>(
    `SELECT metadata.parent_id, channel.rail_waterline FROM parent_metadata metadata
       LEFT JOIN channels channel ON channel.workstream_id = metadata.parent_id
      WHERE metadata.parent_id IN (SELECT value FROM json_each(?)) AND metadata.parent_kind = 'workstream'`,
    JSON.stringify(parentIds),
  ).toArray();
  const hosted = hostedRows.map((row) => row.parent_id);
  const railWaterlines = new Map(hostedRows.map((row) => [row.parent_id, row.rail_waterline ?? 0]));
  if (hosted.length === 0) return result;
  const children = visiblePrivateChildren(sql, userId, hosted);
  const waterlines = new Map(sql.exec<{ parent_id: string; waterline: number }>(
    `SELECT parent_id, MAX(waterline) AS waterline FROM parent_state_changes
      WHERE parent_id IN (SELECT value FROM json_each(?)) AND state_key = ?
      GROUP BY parent_id`,
    JSON.stringify(hosted), `children:${userId}`,
  ).toArray().map((row) => [row.parent_id, row.waterline]));
  const agents = background ?? runningBackgroundAgents(sql, hosted);
  for (const parentId of hosted) {
    const listed = children.get(parentId) ?? [];
    result.set(parentId, {
      privateChildren: listed.map(({ lastActivityAt, ...child }) => ({
        ...child, createdAt: new Date(child.createdAt).toISOString(), updatedAt: new Date(child.updatedAt).toISOString(),
        ...(lastActivityAt === undefined ? {} : { lastActivityAt: new Date(lastActivityAt).toISOString() }),
      })),
      privateChildrenWaterline: waterlines.get(parentId) ?? 0,
      backgroundAgentCounts: visibleBackgroundAgentCounts(agents.get(parentId) ?? new Map(),
        new Set(["0", ...listed.map((child) => child.substreamId)])),
      railWaterline: railWaterlines.get(parentId) ?? 0,
    });
  }
  return result;
}

const PRIVATE_CHILD_EFFECT_RETRY_MS = 5_000;
// Generous fences, not history: a replay older than the receipt window
// converges on the per-key waterlines, as it did in the legacy object.
const CHILD_EFFECT_RECEIPT_RETENTION_MS = 180 * 24 * 60 * 60_000;
const realtimeTextEncoder = new TextEncoder();

function first<T extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<T>): T | null {
  return cursor.toArray()[0] ?? null;
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function harnessStatus(state: string): WorkstreamControlMetadata["harnessStatus"] {
  if (state === "scheduled") return "scheduled";
  if (["running", "interrupting", "preparing_context", "waiting_capacity"].includes(state)) return "running";
  if (state === "needs_input") return "needs_input";
  if (state === "completed") return "completed";
  if (["failed", "budget_exhausted"].includes(state)) return "failed";
  if (state === "cancelled") return "stopped";
  return "idle";
}

function promptPreview(prompt: string): string {
  return truncateUtf16Safe(prompt.replace(/\s+/gu, " ").trim(), 40);
}

function workstreamControlPayload(event: WorkstreamControlSocketEvent): string {
  const payload = JSON.stringify(WorkstreamControlSocketEventSchema.parse(event));
  if (realtimeTextEncoder.encode(payload).byteLength > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
    throw new Error("Work-stream control event exceeds the bounded frame size");
  }
  return payload;
}

const ControlSocketIdentitySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  userId: UserIdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().uuid(),
  ticketExpiresAt: z.coerce.number().int().positive(),
});
type ControlSocketIdentity = z.infer<typeof ControlSocketIdentitySchema>;

/**
 * A Channel control socket's attachment. `role` is what tells it apart from a
 * workspace socket on the same object: the workspace reader requires fields
 * this one does not carry, so each side reads only its own.
 */
const ControlSocketAttachmentSchema = ControlSocketIdentitySchema.extend({
  role: z.literal("parent_control"),
  connectionId: z.string().uuid(),
  connectedAt: z.string().datetime({ offset: true }),
  subscribed: z.boolean(),
});
export type ControlSocketAttachment = z.infer<typeof ControlSocketAttachmentSchema>;

export function readControlSocketAttachment(socket: WebSocket): ControlSocketAttachment | null {
  try {
    const parsed = ControlSocketAttachmentSchema.safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface ParentMetadataRow extends Record<string, SqlStorageValue> {
  parent_kind: "workstream" | "space";
  revision: number;
  authority_generation: number;
  workspace_id: string;
  parent_id: string;
  region: Region;
  title: string;
  description: string;
  preview: string;
  scope: "personal" | "workspace";
  exact_state: string;
  system_kind: "digest" | null;
  last_activity_at: number;
  completed_at: number | null;
  archived_at: number | null;
  email_address: string | null;
  created_by_user_id: string | null;
  title_status: "naming" | "automatic" | "settled";
  latest_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  next_wakeup_due_at: number | null;
  next_wakeup_prompt: string | null;
  next_terminal_action_at: number | null;
  source_created_at: number;
  source_updated_at: number;
}

interface PrivateChildPreparationRow extends Record<string, SqlStorageValue> {
  operation_id: string;
  substream_id: string;
  creator_user_id: string;
  request_json: string;
  capture_json: string | null;
  completed_parts_json: string;
  prepared_context_json: string | null;
  prepared_conversation_hash: string | null;
  status: "preparing" | "prepared" | "confirming" | "ready" | "failed";
  error_code: string | null;
  created_at: number;
  updated_at: number;
  title: string;
  membership_version: number;
}

interface PrivateChildMembershipEffectRow extends Record<string, SqlStorageValue> {
  operation_id: string;
  substream_id: string;
  user_id: string;
  actor_user_id: string;
  active: number;
  membership_version: number;
}

interface ProjectionKeyRow extends Record<string, SqlStorageValue> {
  next_version: number;
  last_payload_hash: string;
}

interface ConversationReadRow extends Record<string, SqlStorageValue> {
  substream_id: string;
  kind: "main" | "child";
  status: "reserved" | "ready" | "failed";
  archived_at: number | null;
  audience: "restricted" | "inherits_workstream";
}

/** One person's read facts for every conversation of a parent; see `conversationReadFacts`. */
interface ConversationReadFacts {
  metadata: ParentMetadataRow;
  migrationPhases: Map<string, "pending" | "complete">;
  conversations: Map<string, ConversationReadRow>;
  grants: ScopeGrant[];
  breakoutMemberships: Set<string>;
  isParticipant: () => boolean;
}

interface StoredStateRow extends Record<string, SqlStorageValue> {
  event_id: string;
  waterline: number;
}

/**
 * A parent's identity from `parent_metadata`, and its presentation from its
 * directory row, the only copy there is: `channels` for a Channel; for a Space,
 * its title, scope, archive state, creator and timestamps from `spaces`, and
 * for the columns only a Channel's surfaces show, the values a Space has.
 */
const CHANNEL_PARENT_ROW_SQL = `SELECT m.parent_kind, m.revision, m.authority_generation, m.workspace_id, m.parent_id, m.region,
  c.title, c.description, c.preview, c.scope, c.exact_state, c.system_kind, c.last_activity_at,
  c.completed_at, c.archived_at, c.email_address, c.created_by_user_id, c.title_status,
  c.latest_attention_ordinal, c.unread_tracking_start_ordinal, c.next_wakeup_due_at, c.next_wakeup_prompt,
  c.next_terminal_action_at, c.source_created_at, c.source_updated_at
  FROM parent_metadata m JOIN channels c ON c.workstream_id = m.parent_id
 WHERE m.parent_id = ?`;
const SPACE_PARENT_ROW_SQL = `SELECT m.parent_kind, m.revision, m.authority_generation, m.workspace_id, m.parent_id, m.region,
  s.title, '' AS description, '' AS preview, s.scope, 'idle' AS exact_state, NULL AS system_kind,
  s.source_updated_at AS last_activity_at, NULL AS completed_at, s.archived_at, NULL AS email_address,
  s.created_by_user_id, 'settled' AS title_status, 0 AS latest_attention_ordinal,
  0 AS unread_tracking_start_ordinal, NULL AS next_wakeup_due_at, NULL AS next_wakeup_prompt,
  NULL AS next_terminal_action_at, s.source_created_at, s.source_updated_at
  FROM parent_metadata m JOIN spaces s ON s.space_id = m.parent_id
 WHERE m.parent_id = ?`;
/**
 * Before the directory row exists: a reservation inside its own transaction,
 * which reads only identity and `archived_at`, or a placeholder a child's
 * effect wrote ahead of Main. `personal`, so a parent nobody has described
 * admits its participants and nobody else.
 */
const OWN_PARENT_ROW_SQL = `SELECT m.parent_kind, m.revision, m.authority_generation, m.workspace_id, m.parent_id, m.region,
  '' AS title, '' AS description, '' AS preview, 'personal' AS scope, 'idle' AS exact_state,
  NULL AS system_kind, m.created_at AS last_activity_at, NULL AS completed_at, NULL AS archived_at,
  NULL AS email_address, NULL AS created_by_user_id, 'settled' AS title_status,
  0 AS latest_attention_ordinal, 0 AS unread_tracking_start_ordinal, NULL AS next_wakeup_due_at,
  NULL AS next_wakeup_prompt, NULL AS next_terminal_action_at, m.created_at AS source_created_at,
  m.updated_at AS source_updated_at
  FROM parent_metadata m WHERE m.parent_id = ?`;

/**
 * The membership version a reserved child's creator holds. A reserved child
 * keeps no roster on the parent, so the code that launches one seats its
 * creator in the child at this version and the parent admits them at it.
 */
export const RESERVED_CHILD_MEMBERSHIP_VERSION = 1;

export class HostedParent {
  constructor(
    private readonly host: HostedParentHost,
    readonly parentId: string,
    readonly role: HostedParentRole,
  ) {}

  private get env(): Env {
    return this.host.env;
  }

  private get storage(): DurableObjectStorage {
    return this.host.storage;
  }

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  /** Viewers whose breakout list moved in this call, for `publishChannelRow`. */
  private readonly childrenMovedFor = new Set<string>();
  private resolutionMoved = false;
  /** The running background agents before this call's child effects, when it applied any. */
  private publishedBackgroundAgents: string | null = null;

  /** Effects published in the open transaction, applied just before it commits. */
  private localEffects: ParentEffectEnvelope[] = [];
  private txDepth = 0;

  /**
   * A transaction whose published effects land in it: the Organization's
   * directory, grant directory, activity feed and notification records
   * commit with the parent change that caused them, in the order the
   * directory needs (a Channel's row before its viewers' rows).
   */
  private tx<T>(fn: () => T): T {
    return this.storage.transactionSync(() => {
      this.txDepth += 1;
      try {
        const result = fn();
        if (this.txDepth === 1) this.flushLocalEffects();
        return result;
      } finally {
        this.txDepth -= 1;
        if (this.txDepth === 0) this.localEffects = [];
      }
    });
  }

  private flushLocalEffects(): void {
    if (this.localEffects.length === 0) return;
    const rank = (envelope: ParentEffectEnvelope) => (envelope.effect.kind === "directory_common" ? 0
      : envelope.effect.kind === "directory_user" ? 1 : envelope.effect.kind === "scope_grant_directory" ? 2 : 3);
    const effects = this.localEffects.splice(0).sort((left, right) => rank(left) - rank(right));
    this.publishLocal(effects, Date.now());
  }

  private publishLocal(envelopes: readonly ParentEffectEnvelope[], now: number): void {
    for (const envelope of this.host.applyLocalEffects(envelopes).outbox) this.writeOutboxRow(envelope, now);
  }

  // ---------------------------------------------------------------------------
  // Identity.
  // ---------------------------------------------------------------------------

  metadataRow(): ParentMetadataRow | null {
    const directory = this.role.kind === "space" ? SPACE_PARENT_ROW_SQL : CHANNEL_PARENT_ROW_SQL;
    return first(this.sql.exec<ParentMetadataRow>(directory, this.parentId))
      ?? first(this.sql.exec<ParentMetadataRow>(OWN_PARENT_ROW_SQL, this.parentId));
  }

  private parentIdentity(): {
    region: Region; workspaceId: WorkspaceId; parentKind: ConversationParentKind;
    parentId: string; authorityGeneration: number;
  } | null {
    const row = this.metadataRow();
    return row ? {
      region: row.region,
      workspaceId: asWorkspaceId(row.workspace_id),
      parentKind: this.role.kind,
      parentId: row.parent_id,
      authorityGeneration: row.authority_generation,
    } : null;
  }

  private assertParent(workspaceId: string, parentId: string): void {
    const identity = this.parentIdentity();
    if (!identity) throw new Error("conversation_parent_missing");
    if (identity.workspaceId !== workspaceId || identity.parentId !== parentId) {
      throw new Error("conversation_parent_identity_mismatch");
    }
  }

  private logFields(): Record<string, unknown> {
    const metadata = this.metadataRow();
    return {
      workspace_id: metadata?.workspace_id ?? null,
      workstream_id: this.parentId,
      parent_kind: this.role.kind,
    };
  }

  // ---------------------------------------------------------------------------
  // The child registry.
  // ---------------------------------------------------------------------------

  /** Record a child; `false` when it was already there. */
  private registerChild(substreamId: string, kind: "main" | "child", createdByUserId: string | null, now: number): boolean {
    return this.sql.exec<{ substream_id: string }>(
      `INSERT OR IGNORE INTO parent_children(parent_id, substream_id, kind, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING substream_id`,
      this.parentId, substreamId, kind, createdByUserId, now,
    ).toArray().length === 1;
  }

  /** Every child this parent knows, the main conversation first; `"0"` always. */
  childRegistry(): { substreamId: string; kind: "main" | "child"; createdAt: number }[] {
    const rows = this.sql.exec<{ substream_id: string; kind: "main" | "child"; created_at: number }>(
      `SELECT substream_id, kind, created_at FROM parent_children WHERE parent_id = ?
        ORDER BY CASE WHEN substream_id = '0' THEN 0 ELSE 1 END, created_at, substream_id`,
      this.parentId,
    ).toArray();
    const children = rows.map((row) => ({ substreamId: row.substream_id, kind: row.kind, createdAt: row.created_at }));
    if (!children.some((child) => child.substreamId === "0")) {
      children.unshift({ substreamId: "0", kind: "main", createdAt: 0 });
    }
    return children;
  }

  listChildren(input: ConversationParentListChildrenRequest): ConversationParentListChildrenResult {
    const request = ConversationParentListChildrenRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    return ConversationParentListChildrenResultSchema.parse({ children: this.childRegistry() });
  }

  childTerminalDeadlines(input: ConversationParentTerminalDeadlinesRequest): ConversationParentTerminalDeadlinesResult {
    const request = ConversationParentTerminalDeadlinesRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    return ConversationParentTerminalDeadlinesResultSchema.parse({
      items: this.sql.exec<{ substream_id: string; next_terminal_action_at: string }>(
        `SELECT substream_id, json_extract(effect_json, '$.nextTerminalActionAt') AS next_terminal_action_at
           FROM parent_child_projections
          WHERE parent_id = ?
            AND json_extract(effect_json, '$.kind') = 'directory_common'
            AND json_extract(effect_json, '$.nextTerminalActionAt') IS NOT NULL
          ORDER BY next_terminal_action_at, substream_id`,
        this.parentId,
      ).toArray().map((row) => ({ substreamId: row.substream_id, nextTerminalActionAt: row.next_terminal_action_at })),
    });
  }

  // ---------------------------------------------------------------------------
  // Child effects: the parent step of every conversation's projection.
  // ---------------------------------------------------------------------------

  /**
   * Apply one batch of a child's effects. Each envelope is its own
   * transaction, and the directory step lands in it; one that throws fails
   * the delivery, and the Queue redelivers it (the receipts answer the ones
   * that already committed).
   */
  receiveChildEffects(input: ReceiveChildEffectsRequest): { messageId: string; payloadHash: string }[] {
    const request = parseRpcInput(ReceiveChildEffectsRequestSchema, input, "receive_child_effects");
    this.publishedBackgroundAgents ??= JSON.stringify([...runningBackgroundAgents(this.sql, [this.parentId]).get(this.parentId) ?? []]);
    const accepted: { messageId: string; payloadHash: string }[] = [];
    for (const envelope of request.envelopes) {
      if (envelope.region !== this.env.AVALON_REGION) throw new Error("conversation_effect_region_mismatch");
      if (envelope.substreamId !== request.substreamId) throw new Error("conversation_effect_substream_mismatch");
      if (envelope.parentId !== this.parentId) throw new Error("workstream_effect_identity_mismatch");
      this.applyChildEnvelope(request.substreamId, envelope);
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    return accepted;
  }

  private applyChildEnvelope(substreamId: string, envelope: ConversationEffectEnvelope): void {
    this.tx(() => {
      const now = Date.now();
      this.admitChildEnvelope(envelope, now);
      const receipt = first(this.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM parent_child_receipts WHERE parent_id = ? AND substream_id = ? AND message_id = ?`,
        this.parentId, substreamId, envelope.messageId,
      ));
      if (receipt) {
        if (receipt.payload_hash !== envelope.payloadHash) throw new Error("substream_effect_idempotency_conflict");
        return;
      }
      // Acknowledged and applied nowhere, so a stale title, scope or roster a
      // retired Space conversation still has in flight cannot overwrite it.
      if (!this.role.appliesMainChildDirectory && substreamId === "0"
        && (envelope.effect.kind === "directory_common" || envelope.effect.kind === "directory_user")) {
        this.recordChildReceipt(substreamId, envelope, now);
        return;
      }
      if (substreamId === "0" && envelope.effect.kind === "activity_event"
        && envelope.effect.eventType === "workstream_message_created") {
        const source = ConversationMergeV1Schema.shape.mergedFrom.safeParse(envelope.effect.metadata.mergedFrom);
        if (source.success) {
          this.markResolved(source.data.breakoutId, now);
        }
      }
      const forwards = this.forwardsChildEffect(substreamId, envelope.effect);
      if (envelope.effect.kind === "directory_common") {
        const accepted = this.upsertChildProjection("common", substreamId, null, envelope, now);
        if (accepted) this.onChildCommonProjection(substreamId, envelope.effect, now);
        if (substreamId === "0") {
          const aggregate = this.aggregateCommon();
          this.upsertMetadata(envelope, now);
          if (forwards) this.enqueueProjection("common", aggregate, now);
        } else if (accepted && this.forwardsChildProjection(substreamId, "directory_common")) {
          this.enqueueProjection(`substream:${substreamId}:common`, envelope.effect, now, substreamId);
        }
      } else if (envelope.effect.kind === "directory_user") {
        const accepted = this.upsertChildProjection("user", substreamId, envelope.effect.userId, envelope, now);
        if (accepted && substreamId !== "0") this.advancePrivateChildrenVersion(envelope.effect.userId, now);
        if (substreamId === "0") {
          const aggregate = this.aggregateUser(envelope.effect.userId);
          this.sql.exec(
            `UPDATE parent_metadata SET revision = revision + 1, updated_at = ? WHERE parent_id = ?`,
            now, this.parentId,
          );
          if (forwards) this.enqueueProjection(`user:${envelope.effect.userId}`, aggregate, now);
        } else if (accepted && this.forwardsChildProjection(substreamId, "directory_user")) {
          this.enqueueProjection(
            `substream:${substreamId}:user:${envelope.effect.userId}`, envelope.effect, now, substreamId,
          );
        }
      } else if (forwards) {
        this.enqueueImmutable(substreamId, envelope, now);
      }
      this.recordChildReceipt(substreamId, envelope, now);
    });
  }

  private recordChildReceipt(substreamId: string, envelope: ConversationEffectEnvelope, now: number): void {
    this.sql.exec(
      `INSERT INTO parent_child_receipts(parent_id, substream_id, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?, ?)`,
      this.parentId, substreamId, envelope.messageId, envelope.payloadHash, now,
    );
    // The receipt is a replay fence, not history. Past retention a
    // redelivery converges on the per-key waterlines instead. Aged out
    // across every parent: retention is a property of the table.
    this.sql.exec(
      `DELETE FROM parent_child_receipts
        WHERE (parent_id, substream_id, message_id) IN (
          SELECT parent_id, substream_id, message_id FROM parent_child_receipts
           WHERE received_at < ? ORDER BY received_at LIMIT 100
        )`,
      now - CHILD_EFFECT_RECEIPT_RETENTION_MS,
    );
  }

  /** The child stamps its own kind; a mismatch is a conversation addressed at the wrong parent. */
  private admitChildEnvelope(envelope: ConversationEffectEnvelope, now: number): void {
    if (envelope.parentKind !== this.role.kind) throw new Error("workstream_effect_parent_kind_mismatch");
    const metadata = this.metadataRow();
    if (metadata && (metadata.workspace_id !== envelope.workspaceId || metadata.parent_id !== envelope.parentId)) {
      throw new Error("workstream_effect_identity_mismatch");
    }
    // The generation is an epoch this row follows, not a gate; see the
    // legacy object's comment. Effects are deduped by the receipt table.
    if (metadata && envelope.generation > metadata.authority_generation) {
      this.sql.exec(`UPDATE parent_metadata SET authority_generation = ? WHERE parent_id = ?`,
        envelope.generation, this.parentId);
    }
    if (!metadata) {
      this.sql.exec(
        `INSERT INTO parent_metadata
           (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        this.parentId, this.role.kind, envelope.workspaceId, envelope.region, envelope.generation, now, now,
      );
    }
  }

  /**
   * A Space forwards only its directory; a Channel its main conversation,
   * person notifications, and a breakout's mentions emptied for the Activity
   * tab (`breakout-activity.ts`).
   */
  private forwardsChildEffect(substreamId: string, effect: ConversationEffect): boolean {
    if (!this.role.forwardsFeedEffects) {
      return effect.kind === "directory_common" || effect.kind === "directory_user";
    }
    if (substreamId === "0") return true;
    return isPersonNotificationEffect(effect) || breakoutMessageActivity(effect, substreamId) !== null;
  }

  /**
   * A Channel's breakouts get a row of their own in the Organization; a
   * Space's children and background agents do not. The legacy object's comment
   * on `forwardsChildProjection` has the whole argument, including the one
   * background agent that still forwards.
   */
  private forwardsChildProjection(substreamId: string, kind: DirectoryProjectionKind): boolean {
    if (!this.role.forwardsFeedEffects) return false;
    if (substreamId === "0") return false;
    if (!this.isBackgroundAgentChild(substreamId)) return true;
    return kind === "directory_common" && this.forwardedAsBreakout(substreamId);
  }

  private isBackgroundAgentChild(substreamId: string): boolean {
    return first(this.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM parent_child_projections
        WHERE parent_id = ? AND substream_id = ? AND json_extract(effect_json, '$.backgroundAgent') = 1`,
      this.parentId, substreamId,
    )) !== null;
  }

  private forwardedAsBreakout(substreamId: string): boolean {
    return first(this.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM parent_projection_keys WHERE parent_id = ? AND projection_key = ?`,
      this.parentId, `substream:${substreamId}:common`,
    )) !== null;
  }

  private upsertChildProjection(
    kind: "common" | "user",
    substreamId: string,
    userId: string | null,
    envelope: ConversationEffectEnvelope,
    now: number,
  ): boolean {
    const existing = kind === "common"
      ? first(this.sql.exec<{ source_version: number; payload_hash: string }>(
        `SELECT source_version, payload_hash FROM parent_child_projections WHERE parent_id = ? AND substream_id = ?`,
        this.parentId, substreamId,
      ))
      : first(this.sql.exec<{ source_version: number; payload_hash: string }>(
        `SELECT source_version, payload_hash FROM parent_child_viewer_projections
          WHERE parent_id = ? AND substream_id = ? AND user_id = ?`,
        this.parentId, substreamId, userId!,
      ));
    if (existing && existing.source_version > envelope.sourceVersion) return false;
    if (existing?.source_version === envelope.sourceVersion) {
      if (existing.payload_hash === envelope.payloadHash) return false;
      // The child restarts its counter when a maintenance import rebuilds it;
      // it is the authority for its own projection, so the newer payload wins.
      logWarn(this.env, "substream_projection_version_reused", {
        ...this.logFields(), substream_id: substreamId, source_version: envelope.sourceVersion,
      });
    }
    if (kind === "common") {
      this.sql.exec(
        `INSERT INTO parent_child_projections(parent_id, substream_id, source_version, payload_hash, effect_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(parent_id, substream_id) DO UPDATE SET source_version = excluded.source_version,
           payload_hash = excluded.payload_hash, effect_json = excluded.effect_json, updated_at = excluded.updated_at`,
        this.parentId, substreamId, envelope.sourceVersion, envelope.payloadHash, JSON.stringify(envelope.effect), now,
      );
    } else {
      this.sql.exec(
        `INSERT INTO parent_child_viewer_projections
           (parent_id, substream_id, user_id, source_version, payload_hash, effect_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(parent_id, substream_id, user_id) DO UPDATE SET source_version = excluded.source_version,
           payload_hash = excluded.payload_hash, effect_json = excluded.effect_json, updated_at = excluded.updated_at`,
        this.parentId, substreamId, userId, envelope.sourceVersion, envelope.payloadHash, JSON.stringify(envelope.effect), now,
      );
    }
    return true;
  }

  /** The main conversation's projection, the only one the parent aggregates. */
  private mainCommonProjection(): DirectoryCommonEffect | null {
    const row = first(this.sql.exec<{ effect_json: string }>(
      `SELECT effect_json FROM parent_child_projections WHERE parent_id = ? AND substream_id = '0'`,
      this.parentId,
    ));
    return row ? WorkstreamDirectoryCommonEffectSchema.parse(JSON.parse(row.effect_json)) : null;
  }

  /**
   * The main conversation's projection, carrying the earliest Terminal
   * deadline of any conversation under this parent: the workspace directory
   * has one deadline per Channel and the sweep it wakes asks here which
   * conversations are due.
   */
  private aggregateCommon(): DirectoryCommonEffect {
    const main = this.mainCommonProjection();
    if (!main) throw new Error("conversation_parent_common_projection_missing");
    return {
      ...main,
      state: canonicalState([main]),
      lastActivityAt: main.lastActivityAt,
      completedAt: main.completedAt !== null ? main.lastActivityAt : null,
      nextTerminalActionAt: this.earliestChildTerminalDeadline(),
    };
  }

  private earliestChildTerminalDeadline(): string | null {
    return first(this.sql.exec<{ due_at: string | null }>(
      `SELECT MIN(json_extract(effect_json, '$.nextTerminalActionAt')) AS due_at
         FROM parent_child_projections
        WHERE parent_id = ?
          AND json_extract(effect_json, '$.kind') = 'directory_common'
          AND json_extract(effect_json, '$.nextTerminalActionAt') IS NOT NULL`,
      this.parentId,
    ))?.due_at ?? null;
  }

  /** Re-publish the common projection when a non-main conversation moved the earliest Terminal deadline. */
  private forwardChildTerminalDeadline(now: number): void {
    if (!this.mainCommonProjection()) return;
    const aggregate = this.aggregateCommon();
    // `enqueueProjection` publishes only a payload whose hash moved, so an
    // unchanged deadline publishes nothing and bumps nothing.
    if (!this.enqueueProjection("common", aggregate, now)) return;
    this.sql.exec(
      `UPDATE parent_metadata SET revision = revision + 1, updated_at = ? WHERE parent_id = ?`,
      now, this.parentId,
    );
  }

  /** Main participation only: membership in a private child never implies it. */
  userProjection(userId: string): DirectoryUserEffect | null {
    const row = first(this.sql.exec<{ effect_json: string }>(
      `SELECT effect_json FROM parent_child_viewer_projections WHERE parent_id = ? AND substream_id = '0' AND user_id = ?`,
      this.parentId, userId,
    ));
    return row ? WorkstreamDirectoryUserEffectSchema.parse(JSON.parse(row.effect_json)) : null;
  }

  /**
   * Main's own viewer projection, as it arrived: a Channel's per-person row is
   * its main conversation's and nothing else's, and re-deriving it would change
   * its bytes and so its hash, which is what the directory's replay fence keys on.
   */
  private aggregateUser(userId: string): DirectoryUserEffect {
    const projection = this.userProjection(userId);
    if (!projection) throw new Error("conversation_parent_user_projection_missing");
    return projection;
  }

  /**
   * Whether this person participates in Main. Before Main has reported at all,
   * the creator recorded at `reserveChild` stands in, so the person who just
   * created a personal Channel can open it before its first projection lands.
   */
  isParticipant(userId: string): boolean {
    const projection = this.userProjection(userId);
    if (projection) return projection.isParticipant;
    const mainReported = first(this.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM parent_child_projections WHERE parent_id = ? AND substream_id = '0'`,
      this.parentId,
    ));
    return mainReported === null && this.mainChildCreatedBy() === userId;
  }

  private mainChildCreatedBy(): string | null {
    return first(this.sql.exec<{ created_by_user_id: string | null }>(
      `SELECT created_by_user_id FROM parent_children WHERE parent_id = ? AND substream_id = '0'`,
      this.parentId,
    ))?.created_by_user_id ?? null;
  }

  /** Keep the child registry's title the child's own, and move the earliest Terminal deadline. */
  private onChildCommonProjection(substreamId: string, effect: DirectoryCommonEffect, now: number): void {
    if (substreamId === "0") return;
    this.forwardChildTerminalDeadline(now);
    if (effect.backgroundAgent) {
      this.sql.exec(`UPDATE parent_metadata SET revision = revision + 1, updated_at = ? WHERE parent_id = ?`,
        now, this.parentId);
      return;
    }
    this.sql.exec(
      `UPDATE parent_children SET title = ?, updated_at = ?
        WHERE parent_id = ? AND substream_id = ? AND kind = 'child' AND title IS NOT ?`,
      effect.title, now, this.parentId, substreamId, effect.title,
    );
    this.advancePrivateChildrenVersionsFor(substreamId, now);
  }

  /**
   * The parent's identity row, advanced on every Main common effect. What Main
   * says about the parent lands in its directory row through the projection.
   */
  private upsertMetadata(envelope: ConversationEffectEnvelope, now: number): void {
    this.sql.exec(
      `INSERT INTO parent_metadata
         (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(parent_id) DO UPDATE SET
         updated_at = excluded.updated_at, revision = parent_metadata.revision + 1`,
      this.parentId, this.role.kind, envelope.workspaceId, envelope.region, envelope.generation, now, now,
    );
  }

  // ---------------------------------------------------------------------------
  // Projection versions and the outbox.
  // ---------------------------------------------------------------------------

  private latestStateRow(stateKey: string): StoredStateRow | null {
    return first(this.sql.exec<StoredStateRow>(
      `SELECT event_id, waterline FROM parent_state_changes
        WHERE parent_id = ? AND state_key = ? ORDER BY waterline DESC LIMIT 1`,
      this.parentId, stateKey,
    ));
  }

  /**
   * Version one of this parent's projections and put it in the outbox.
   * `sourceVersion` is the parent's waterline for the key, because the
   * directory applies strictly newer versions and two children numbering
   * independently could not be compared.
   */
  private enqueueProjection(
    projectionKey: string,
    effect: ParentEffect,
    now: number,
    substreamId?: string,
  ): ParentEffectEnvelope | null {
    const identity = this.parentIdentity();
    if (!identity) throw new Error("conversation_parent_missing");
    const payloadHash = conversationEffectHash(effect);
    const previous = first(this.sql.exec<ProjectionKeyRow>(
      `SELECT next_version, last_payload_hash FROM parent_projection_keys WHERE parent_id = ? AND projection_key = ?`,
      this.parentId, projectionKey,
    ));
    if (previous?.last_payload_hash === payloadHash) return null;
    const sourceVersion = previous?.next_version ?? 1;
    const messageId = this.recordStateChange(projectionKey, sourceVersion, effect, payloadHash, now);
    this.sql.exec(
      `INSERT INTO parent_projection_keys(parent_id, projection_key, next_version, last_payload_hash, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(parent_id, projection_key) DO UPDATE SET next_version = excluded.next_version,
         last_payload_hash = excluded.last_payload_hash, updated_at = excluded.updated_at`,
      this.parentId, projectionKey, sourceVersion + 1, payloadHash, now,
    );
    const envelope = ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: identity.region,
      workspaceId: identity.workspaceId,
      parentKind: identity.parentKind,
      parentId: identity.parentId,
      ...(substreamId === undefined ? {} : { substreamId: asSubstreamId(substreamId) }),
      generation: identity.authorityGeneration,
      messageId,
      partitionKey: projectionKey,
      sourceVersion,
      requiredProjectionVersion: null,
      payloadHash,
      effect,
    });
    this.insertOutbox(envelope, now);
    return envelope;
  }

  /** Version object-local viewer state without publishing a workspace projection. */
  private advanceLocalStateVersion(stateKey: string, state: unknown, now: number): boolean {
    const encoded = JSON.stringify(state);
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(encoded)) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    const payloadHash = `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
    const previous = first(this.sql.exec<ProjectionKeyRow>(
      `SELECT next_version, last_payload_hash FROM parent_projection_keys WHERE parent_id = ? AND projection_key = ?`,
      this.parentId, stateKey,
    ));
    if (previous?.last_payload_hash === payloadHash) return false;
    const waterline = previous?.next_version ?? 1;
    this.recordStateChange(stateKey, waterline, { localViewerState: true }, payloadHash, now);
    this.sql.exec(
      `INSERT INTO parent_projection_keys(parent_id, projection_key, next_version, last_payload_hash, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(parent_id, projection_key) DO UPDATE SET next_version = excluded.next_version,
         last_payload_hash = excluded.last_payload_hash, updated_at = excluded.updated_at`,
      this.parentId, stateKey, waterline + 1, payloadHash, now,
    );
    return true;
  }

  /** Append one immutable state row before its outbox row exists. */
  private recordStateChange(
    stateKey: string,
    waterline: number,
    effect: ParentEffect | { localViewerState: true },
    payloadHash: string,
    now: number,
  ): string {
    const clock = this.sql.exec<{ next_sequence: number; last_event_time: number }>(
      `INSERT INTO parent_state_clock(parent_id, next_sequence, last_event_time) VALUES (?, 1, 0)
       ON CONFLICT(parent_id) DO UPDATE SET next_sequence = next_sequence
       RETURNING next_sequence, last_event_time`,
      this.parentId,
    ).one();
    const occurredAt = Math.max(now, clock.last_event_time);
    const sequence = clock.next_sequence;
    const eventId = uuidV7(occurredAt);
    this.sql.exec(
      `UPDATE parent_state_clock SET next_sequence = ?, last_event_time = ? WHERE parent_id = ?`,
      sequence + 1, occurredAt, this.parentId,
    );
    this.sql.exec(
      `INSERT INTO parent_state_changes
         (parent_id, sequence, state_key, waterline, event_id, payload_hash, state_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.parentId, sequence, stateKey, waterline, eventId, payloadHash, JSON.stringify(effect), occurredAt,
    );
    // Reconnects need the current row, not every transition ever observed.
    this.sql.exec(
      `DELETE FROM parent_state_changes WHERE parent_id = ? AND state_key = ? AND waterline <= ?`,
      this.parentId, stateKey, waterline - 1_024,
    );
    return eventId;
  }

  /** A notification needs a delivery barrier, never a merge of child attention or permissions. */
  private prepareNotificationProjection(userId: string, now: number): void {
    const main = this.userProjection(userId) ?? WorkstreamDirectoryUserEffectSchema.parse({
      kind: "directory_user", userId, isParticipant: false, participantAddedAt: null,
      unreadCount: 0, youAreMentioned: false, unseen: false, listable: false,
      seenAttentionOrdinal: 0, manualUnreadFromOrdinal: null, manualUnreadGeneration: 0,
      latestMentionAttentionOrdinal: 0,
    });
    this.enqueueProjection(`user:${userId}`, main, now);
  }

  private enqueueImmutable(substreamId: string, source: ConversationEffectEnvelope, now: number): void {
    const identity = this.parentIdentity();
    if (!identity) throw new Error("conversation_parent_missing");
    const effect = isPersonNotificationEffect(source.effect) && identity.parentKind === "workstream" && substreamId !== "0"
      ? { ...source.effect, substreamId: asSubstreamId(substreamId) }
      : substreamId !== "0" ? breakoutActivity(source.effect, substreamId) : source.effect;
    let requiredProjectionVersion: number | null = null;
    if (isPersonNotificationEffect(source.effect)) {
      if (substreamId !== "0") this.prepareNotificationProjection(source.effect.recipientUserId, now);
      const projection = first(this.sql.exec<ProjectionKeyRow>(
        `SELECT next_version, last_payload_hash FROM parent_projection_keys WHERE parent_id = ? AND projection_key = ?`,
        this.parentId, `user:${source.effect.recipientUserId}`,
      ));
      requiredProjectionVersion = (projection?.next_version ?? 1) - 1;
      if (requiredProjectionVersion <= 0) throw new Error("workstream_notification_projection_dependency_uncommitted");
    }
    const payloadHash = conversationEffectHash(effect, requiredProjectionVersion);
    this.insertOutbox(ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: identity.region,
      workspaceId: identity.workspaceId,
      parentKind: identity.parentKind,
      parentId: identity.parentId,
      generation: identity.authorityGeneration,
      messageId: `substream:${substreamId}:${source.messageId}`,
      partitionKey: source.partitionKey,
      sourceVersion: source.sourceVersion,
      requiredProjectionVersion,
      payloadHash,
      effect,
    }), now);
  }

  private insertOutbox(envelope: ParentEffectEnvelope, now: number): void {
    if (this.txDepth > 0) {
      this.localEffects.push(envelope);
      return;
    }
    // Published outside this parent's own transaction (an import replay runs
    // inside the Organization's): apply it now, in one of its own.
    this.storage.transactionSync(() => this.publishLocal([envelope], now));
  }

  /** Work that leaves the object: a row the drain sends after the commit. */
  private writeOutboxRow(envelope: ParentEffectEnvelope, now: number): void {
    const inserted = this.sql.exec<{ message_id: string }>(
      `INSERT OR IGNORE INTO parent_outbox
         (message_id, parent_id, partition_key, source_version, source_epoch, effect_kind,
          payload_json, payload_hash, state, attempts, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       RETURNING message_id`,
      envelope.messageId, this.parentId, envelope.partitionKey, envelope.sourceVersion, envelope.generation,
      envelope.effect.kind, JSON.stringify(envelope), envelope.payloadHash, now, now,
    );
    if (inserted.toArray().length === 0) {
      const existing = first(this.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM parent_outbox WHERE parent_id = ? AND message_id = ?`,
        this.parentId, envelope.messageId,
      ));
      if (existing?.payload_hash !== envelope.payloadHash) throw new Error("conversation_parent_outbox_conflict");
    }
  }

  // ---------------------------------------------------------------------------
  // The conversation-parent contract.
  // ---------------------------------------------------------------------------

  async authority(input: ConversationParentAuthorityRequest): Promise<ConversationParentAuthorityResult> {
    const request = ConversationParentAuthorityRequestSchema.parse(input);
    const row = this.metadataRow();
    if (!row) return ConversationParentAuthorityResultSchema.parse({ exists: false, authorityGeneration: 0, archived: false });
    this.assertParent(request.workspaceId, request.parentId);
    return ConversationParentAuthorityResultSchema.parse({
      exists: true,
      authorityGeneration: row.authority_generation,
      archived: row.archived_at !== null,
    });
  }

  async authorizeViewer(input: ConversationParentAuthorizeViewerRequest): Promise<ConversationParentAuthorizeViewerResult> {
    const request = ConversationParentAuthorizeViewerRequestSchema.parse(input);
    const row = this.metadataRow();
    if (!row) return ConversationParentAuthorizeViewerResultSchema.parse({ authorized: false, archived: false });
    this.assertParent(request.workspaceId, request.parentId);
    const substreamId = request.substreamId ?? "0";
    if (this.participantMigrationPhase(substreamId) !== null) {
      const relationship = await this.host.readRelationship(request.workspaceId, request.userId);
      const access = this.migratedConversationAccess(request, asSubstreamId(substreamId), relationship);
      const current = this.metadataRow();
      const child = this.sql.exec<{ archived_at: number | null; status: "reserved" | "ready" | "failed" }>(
        "SELECT archived_at, status FROM parent_children WHERE parent_id = ? AND substream_id = ?",
        this.parentId, substreamId,
      ).toArray()[0];
      return ConversationParentAuthorizeViewerResultSchema.parse({
        authorized: access.allowed,
        archived: current?.archived_at != null || child?.archived_at != null,
        childStatus: child?.status ?? null,
        membershipVersion: substreamId === "0" && access.allowed && access.workspaceMemberAccess && !access.grantIds.length
          ? 0 : this.scopeGrants(request).participantProjection(substreamId, request.userId)?.revision ?? 0,
      });
    }
    if (request.requireGrantAuthority) {
      return ConversationParentAuthorizeViewerResultSchema.parse({ authorized: false, archived: row.archived_at !== null });
    }
    if (substreamId !== "0") {
      const child = first(this.sql.exec<{
        status: "reserved" | "ready" | "failed"; version: number | null; archived_at: number | null;
        created_by_user_id: string | null; preparing: number;
      }>(
        `SELECT child.status, child.archived_at, child.created_by_user_id, member.version,
                EXISTS (SELECT 1 FROM parent_breakout_preparations preparation
                         WHERE preparation.parent_id = child.parent_id
                           AND preparation.substream_id = child.substream_id) AS preparing
           FROM parent_children child
           LEFT JOIN parent_breakout_members member
             ON member.parent_id = child.parent_id AND member.substream_id = child.substream_id
            AND member.user_id = ? AND member.active = 1
          WHERE child.parent_id = ? AND child.substream_id = ? AND child.kind = 'child'`,
        request.userId, this.parentId, substreamId,
      ));
      // Membership of the child alone admits; reading the Channel is neither
      // required nor enough. A reserved child is in no listing and admits only
      // the person it was reserved for: a conversation import's agent runs in
      // one, and the desktop that answers its browser actions is theirs.
      // A Breakout being prepared is also `reserved`, and stays closed until
      // it is ready; only a hidden child, which has no preparation, admits.
      const reservedFor = child?.status === "reserved" && !child.preparing
        && child.created_by_user_id !== null && child.created_by_user_id === request.userId;
      return ConversationParentAuthorizeViewerResultSchema.parse({
        authorized: (child?.status === "ready" && child.version !== null) || reservedFor,
        archived: row.archived_at !== null || child?.archived_at != null,
        childStatus: child?.status ?? null,
        // A reserved child has no roster here; its one member was seated at
        // version 1 by whoever launched it (`SessionImportRunService.launch`).
        membershipVersion: child?.version ?? (reservedFor ? RESERVED_CHILD_MEMBERSHIP_VERSION : 0),
      });
    }
    // Archive is reported, not folded in: archived Channels stay readable.
    const authorized = row.scope === "workspace" || this.isParticipant(request.userId);
    return ConversationParentAuthorizeViewerResultSchema.parse({ authorized, archived: row.archived_at !== null });
  }

  /**
   * Archive a Channel whose main conversation was reserved and never opened,
   * so it leaves every listing.
   *
   * Reached for a conversation-import reservation (see
   * `WorkstreamObjectCreationService.reserveImport`) by discard, abandon and
   * the run-end reclaim, and only while the main conversation has never
   * delivered an effect here: once it has, it owns the
   * Channel's directory and archiving is its own operation. The archive is the
   * same `directory_common` projection a reservation writes, with `archivedAt`
   * set, so the directory and every subscriber learn it the ordinary way. The
   * rows stay: an archived Channel is a state every surface already handles,
   * and nothing reopens it because the caller has already retired the create
   * key that would.
   */
  discardReservedMain(input: { workspaceId: string; parentId: string; userId: string }):
    { status: "discarded" } | { status: "refused"; code: "not_found" | "not_creator" | "already_open" } {
    if (input.parentId !== this.parentId) throw new Error("conversation_parent_identity_mismatch");
    return this.tx(() => {
      const metadata = this.metadataRow();
      if (!metadata) return { status: "refused", code: "not_found" } as const;
      this.assertParent(input.workspaceId, input.parentId);
      if (metadata.created_by_user_id !== input.userId) return { status: "refused", code: "not_creator" } as const;
      const opened = first(this.sql.exec<{ found: number }>(
        `SELECT 1 AS found FROM parent_child_receipts WHERE parent_id = ? AND substream_id = '0' LIMIT 1`,
        this.parentId,
      ));
      if (opened) return { status: "refused", code: "already_open" } as const;
      if (metadata.archived_at !== null) return { status: "discarded" } as const;
      const now = Date.now();
      const at = new Date(now).toISOString();
      this.enqueueProjection("common", {
        kind: "directory_common",
        title: metadata.title,
        description: metadata.description,
        preview: metadata.preview,
        scope: metadata.scope,
        state: "idle",
        systemKind: metadata.system_kind,
        lastActivityAt: new Date(metadata.last_activity_at).toISOString(),
        completedAt: null,
        archivedAt: at,
        emailAddress: metadata.email_address,
        createdByUserId: metadata.created_by_user_id,
        titleStatus: metadata.title_status,
        createdAt: new Date(metadata.source_created_at || now).toISOString(),
        updatedAt: at,
      }, now);
      this.sql.exec(
        `UPDATE parent_children SET archived_at = COALESCE(archived_at, ?), updated_at = ?
          WHERE parent_id = ? AND substream_id = '0'`,
        now, now, this.parentId,
      );
      return { status: "discarded" } as const;
    });
  }

  /**
   * Reserve a child that stays `reserved`: in no listing, with no roster here,
   * admitting only the person it is reserved for (`authorizeViewer`). For a
   * conversation that works on that person's behalf and is never shown as a
   * Breakout — a conversation import's agent is the first. The caller seats
   * its creator in the child at `RESERVED_CHILD_MEMBERSHIP_VERSION`.
   */
  async reserveHiddenChild(
    input: Omit<ConversationParentReserveChildRequest, "authorityGeneration" | "directory" | "kind">
      & { createdByUserId: UserId },
  ): Promise<ConversationParentReserveChildResult> {
    const reserved = await this.reserveAgentChild(input);
    this.sql.exec(
      `UPDATE parent_children SET status = 'reserved', updated_at = ?
        WHERE parent_id = ? AND substream_id = ? AND kind = 'child' AND created_by_user_id = ?`,
      Date.now(), this.parentId, input.substreamId, input.createdByUserId,
    );
    return reserved;
  }

  /**
   * Whether `substreamId` is a hidden child of this parent that `userId`
   * reserved: the one kind of conversation whose agent its creator may stop
   * by id. The main conversation, a Breakout (being prepared or ready) and
   * another person's child are not.
   */
  ownsHiddenChild(input: { parentId: string; substreamId: string; userId: string }): boolean {
    if (input.parentId !== this.parentId || input.substreamId === "0") return false;
    const child = first(this.sql.exec<{ status: string; created_by_user_id: string | null; preparing: number }>(
      `SELECT child.status, child.created_by_user_id,
              EXISTS (SELECT 1 FROM parent_breakout_preparations preparation
                       WHERE preparation.parent_id = child.parent_id
                         AND preparation.substream_id = child.substream_id) AS preparing
         FROM parent_children child
        WHERE child.parent_id = ? AND child.substream_id = ? AND child.kind = 'child'`,
      this.parentId, input.substreamId,
    ));
    return child?.status === "reserved" && !child.preparing && child.created_by_user_id === input.userId;
  }

  /** The hidden children `userId` reserved on this parent, as `ownsHiddenChild` counts them. */
  hiddenChildren(input: { parentId: string; userId: string }): string[] {
    if (input.parentId !== this.parentId) return [];
    return [...this.sql.exec<{ substream_id: string }>(
      `SELECT child.substream_id FROM parent_children child
        WHERE child.parent_id = ? AND child.kind = 'child' AND child.status = 'reserved'
          AND child.created_by_user_id = ?
          AND NOT EXISTS (SELECT 1 FROM parent_breakout_preparations preparation
                           WHERE preparation.parent_id = child.parent_id
                             AND preparation.substream_id = child.substream_id)`,
      this.parentId, input.userId,
    )].map((row) => row.substream_id);
  }

  /** Reserve against current parent authority without a caller-side preflight RPC. */
  async reserveAgentChild(
    input: Omit<ConversationParentReserveChildRequest, "authorityGeneration" | "directory" | "kind">,
  ): Promise<ConversationParentReserveChildResult> {
    const authority = await this.authority({ workspaceId: input.workspaceId, parentId: input.parentId });
    if (!authority.exists || authority.archived) throw new Error("workstream_archived");
    return this.reserveChild({ ...input, kind: "child", authorityGeneration: authority.authorityGeneration });
  }

  /**
   * Record a child before it is addressed. Reserving the main conversation of
   * a parent that does not exist yet creates its row and a version-one
   * provisional directory projection; the caller drains the outbox, which now
   * applies that row in this object rather than over an RPC back into it.
   */
  reserveChild(input: ConversationParentReserveChildRequest): ConversationParentReserveChildResult {
    const request = ConversationParentReserveChildRequestSchema.parse(input);
    if (request.parentId !== this.parentId) throw new Error("conversation_parent_identity_mismatch");
    const now = Date.now();
    const authorityGeneration = this.tx(() => {
      let metadata = this.metadataRow();
      if (!metadata) {
        if (request.substreamId !== "0" || !request.directory) throw new Error("workstream_parent_missing");
        this.insertProvisionalMetadata(request, now);
        metadata = this.metadataRow();
        if (!metadata) throw new Error("workstream_metadata_missing");
      } else {
        this.assertParent(request.workspaceId, request.parentId);
      }
      if (request.kind === "child" && metadata.archived_at !== null) throw new Error("workstream_archived");
      const registered = this.registerChild(request.substreamId, request.kind, request.createdByUserId, now);
      if (registered && request.substreamId === "0" && request.directory) {
        const directory = request.directory;
        this.enqueueProjection("common", {
          kind: "directory_common",
          ...(directory.appearance ? { appearance: directory.appearance } : {}),
          title: directory.title,
          description: directory.description,
          preview: "",
          scope: directory.scope,
          state: "idle",
          systemKind: directory.systemKind,
          lastActivityAt: directory.createdAt,
          completedAt: null,
          archivedAt: null,
          emailAddress: directory.emailAddress,
          createdByUserId: request.createdByUserId,
          titleStatus: directory.titleStatus,
          createdAt: directory.createdAt,
          updatedAt: directory.createdAt,
        }, now);
        if (request.createdByUserId) {
          this.enqueueProjection(`user:${request.createdByUserId}`, {
            kind: "directory_user",
            userId: request.createdByUserId,
            isParticipant: true,
            participantAddedAt: directory.createdAt,
            unreadCount: 0,
            youAreMentioned: false,
            unseen: false,
            listable: true,
          }, now);
        }
      }
      return metadata.authority_generation;
    });
    return ConversationParentReserveChildResultSchema.parse({ reserved: true, authorityGeneration });
  }

  private insertProvisionalMetadata(request: ConversationParentReserveChildRequest, now: number): void {
    this.sql.exec(
      `INSERT INTO parent_metadata
         (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      this.parentId, this.role.kind, request.workspaceId, this.env.AVALON_REGION, request.authorityGeneration, now, now,
    );
  }

  /** Failed or reserved preparations have no readable content to migrate. */
  listAuthorizationChildren(input: ConversationParentAuthorityRequest): { substreamIds: SubstreamId[] } {
    const request = ConversationParentAuthorityRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    return {
      substreamIds: this.sql.exec<{ substream_id: string }>(
        `SELECT substream_id FROM parent_children WHERE parent_id = ? AND (kind = 'main' OR status = 'ready')
          ORDER BY substream_id`,
        this.parentId,
      ).toArray().map((row) => SubstreamIdSchema.parse(row.substream_id)),
    };
  }

  /** Read-only authorization evidence; validates the main roster at its canonical child. */
  async readAuthorizationFacts(input: ConversationAuthorizationRequest) {
    const request = ConversationAuthorizationRequestSchema.parse(input);
    const metadata = this.metadataRow();
    if (!metadata) return { exists: false as const, validatedAt: Date.now() };
    this.assertParent(request.workspaceId, request.parentId);
    const migrated = request.substreamIds.filter((id) => this.participantMigrationPhase(id) !== null);
    const observation = request.relationship;
    const relationship = migrated.length
      ? observation?.workspaceId === request.workspaceId && observation.userId === request.userId
        ? observation : await this.host.readRelationship(request.workspaceId, request.userId)
      : null;
    const store = this.scopeGrants(request);
    const scopes = migrated.map((substreamId) => ({
      substreamId,
      access: this.migratedConversationAccess(request, substreamId, relationship),
      revision: JSON.stringify([relationship?.incarnation, relationship?.revision,
        store.participantProjection(substreamId, request.userId)?.revision ?? 0]),
    }));
    if (migrated.length && migrated.length === request.substreamIds.length) {
      return { exists: true as const, authority: "grants" as const, validatedAt: Date.now(), scopes };
    }
    const main = await createIdentityObjectPort(this.env, request.workspaceId, request.parentId)
      .readAuthorizationFacts({ userId: request.userId });
    const ids = request.substreamIds.length ? request.substreamIds : this.childRegistry().map((child) => child.substreamId);
    const children = ids.map((substreamId) => {
      const child = substreamId === "0" ? null : first(this.sql.exec<{
        status: string; active: number | null; version: number | null;
      }>(
        `SELECT child.status, member.active, member.version FROM parent_children child
           LEFT JOIN parent_breakout_members member
             ON member.parent_id = child.parent_id AND member.substream_id = child.substream_id AND member.user_id = ?
          WHERE child.parent_id = ? AND child.substream_id = ? AND child.kind = 'child'`,
        request.userId, this.parentId, substreamId,
      ));
      return {
        substreamId, exists: substreamId === "0" ? main.exists : Boolean(child),
        ready: substreamId === "0" || child?.status === "ready", failed: child?.status === "failed",
        member: substreamId === "0" || child?.active === 1, version: child?.version ?? 0,
      };
    });
    return {
      exists: true as const, authority: "legacy" as const, main, children, scopes, validatedAt: Date.now(),
      generation: this.metadataRow()?.authority_generation ?? metadata.authority_generation,
    };
  }

  // ---------------------------------------------------------------------------
  // Sidekick recommendations.
  // ---------------------------------------------------------------------------

  recommendedSidekickIds(input: { workspaceId: string; parentId: string }): string[] {
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema }), input,
      "sidekick_recommendations");
    this.assertParent(request.workspaceId, request.parentId);
    return this.sql.exec<{ sidekick_id: string }>(
      `SELECT sidekick_id FROM parent_sidekicks WHERE parent_id = ? ORDER BY attached_at, sidekick_id`,
      this.parentId,
    ).toArray().map((row) => row.sidekick_id);
  }

  /** Parent mutations are distinct from collaboration in Main or a child. */
  async readManagementAccess(input: { workspaceId: string; parentId: string; userId: string }): Promise<ScopeAccessResult> {
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema,
      userId: UserIdSchema }), input, "workstream_management_access");
    this.assertParent(request.workspaceId, request.parentId);
    const relationship = await this.host.readRelationship(request.workspaceId, request.userId);
    return this.managementAccess(request, relationship);
  }

  /** {@link readManagementAccess} for a relationship already in hand: SQL only, so it runs inside a transaction. */
  managementAccess(
    request: { workspaceId: WorkspaceId; parentId: string; userId: UserId },
    relationship: WorkspaceRelationship | null,
  ): ScopeAccessResult {
    const target = { kind: "workstream" as const, workspaceId: request.workspaceId, parentId: request.parentId };
    const access = this.resolveScopeAccess({ userId: request.userId, target }, relationship);
    if (access.allowed || access.reason !== "grant_required") return access;
    // Preserve the existing participant rule only before authority transfers.
    if (relationship?.accessClass === "member" && this.participantMigrationPhase("0") === null
      && this.sql.exec("SELECT 1 FROM parent_grants WHERE parent_id = ? AND scope_kind = 'workstream' LIMIT 1",
        this.parentId).toArray().length === 0
      && this.isParticipant(request.userId)) {
      return { allowed: true, writable: this.metadataRow()?.archived_at === null, grantIds: [], workspaceMemberAccess: false };
    }
    return access;
  }

  async setSidekickRecommendation(input: {
    workspaceId: string; parentId: string; userId: string; sidekickId: string; attached: boolean;
  }, assertRecommendable: (sidekickId: string) => void = () => {}): Promise<string[]> {
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema,
      userId: UserIdSchema, sidekickId: IdSchema, attached: z.boolean() }), input, "sidekick_recommendation");
    this.assertParent(request.workspaceId, request.parentId);
    const access = await this.readManagementAccess({ workspaceId: request.workspaceId, parentId: request.parentId, userId: request.userId });
    if (!access.allowed) throw new Error("sidekick_attachment_participant_required");
    if (!access.writable) throw new Error("sidekick_attachment_workstream_archived");
    if (request.attached) assertRecommendable(request.sidekickId);
    this.writeSidekickRecommendation(request.sidekickId, request.attached);
    return this.recommendedSidekickIds({ workspaceId: request.workspaceId, parentId: request.parentId });
  }

  /**
   * The recommendation row alone, for a caller that has already authorized
   * the write: a Space's default, which WorkspaceDO authorizes from the Space
   * rows because this parent holds no current copy of a Space's audience.
   */
  writeSidekickRecommendation(sidekickId: string, attached: boolean): void {
    if (attached) {
      this.sql.exec(`INSERT OR IGNORE INTO parent_sidekicks (parent_id, sidekick_id, attached_at) VALUES (?, ?, ?)`,
        this.parentId, sidekickId, Date.now());
    } else {
      this.sql.exec(`DELETE FROM parent_sidekicks WHERE parent_id = ? AND sidekick_id = ?`, this.parentId, sidekickId);
    }
  }

  // ---------------------------------------------------------------------------
  // Grants and the participant handoff.
  // ---------------------------------------------------------------------------

  private scopeGrants(address: { workspaceId: string; parentId: string }): ScopeGrantStorage {
    if (address.parentId !== this.parentId) throw new Error("scope_grant_parent_mismatch");
    return new ScopeGrantStorage(this.storage, address, this.grantDirectoryWriter());
  }

  /**
   * A role that does not publish still supplies a writer: `mutate` throws when
   * handed nothing, and a Space's grants must still commit. Only discovery is
   * suppressed.
   */
  private grantDirectoryWriter(): (grant: ScopeGrant, now: number) => void {
    if (!this.role.publishesGrantDirectory) return () => undefined;
    return (grant, now) => {
      const scopeKey = grant.target.kind === "workstream" ? "workstream" : `conversation:${grant.target.substreamId}`;
      this.enqueueProjection(`grant:${grant.userId}:${scopeKey}`, { kind: "scope_grant_directory", grant }, now);
    };
  }

  private participantMigrationPhase(substreamId: string): "pending" | "complete" | null {
    return this.sql.exec<{ phase: "pending" | "complete" }>(
      "SELECT phase FROM parent_participant_migrations WHERE parent_id = ? AND substream_id = ?",
      this.parentId, substreamId,
    ).toArray()[0]?.phase ?? null;
  }

  private migratedConversationAccess(
    request: { workspaceId: string; parentId: string; userId: UserId },
    substreamId: SubstreamId,
    relationship: WorkspaceRelationship | null,
  ): ScopeAccessResult {
    if (this.participantMigrationPhase(substreamId) !== "complete") return { allowed: false, reason: "not_ready" };
    return this.resolveScopeAccess({
      userId: request.userId,
      target: { kind: "conversation", workspaceId: asWorkspaceId(request.workspaceId), parentId: request.parentId, substreamId },
    }, relationship);
  }

  /**
   * Every conversation of this parent the person may read, each decided by
   * {@link canReadConversation}, the rule this parent's own reads apply. Search
   * lists them as the person's audience groups (`readSearchAudience`), so the
   * index admits exactly what opening the conversation would.
   */
  readableSubstreams(userId: UserId, relationship: WorkspaceRelationship | null): SubstreamId[] {
    const facts = this.conversationReadFacts({ parentId: this.parentId, userId });
    if (!facts) return [];
    const address = { workspaceId: facts.metadata.workspace_id, parentId: this.parentId, userId };
    // The same children `childRegistry` lists: every row, and Main even before it has one.
    return [...new Set(["0", ...facts.conversations.keys()])].map(asSubstreamId)
      .filter((substreamId) => this.canReadConversation(address, substreamId, relationship, facts));
  }

  /**
   * What {@link canReadConversation} decides from, read once for every
   * conversation of this parent. A caller that checks many conversations for
   * one person passes it in: search asks for every conversation in the
   * Organization on each query, and reading these per conversation cost six
   * to eight statements each.
   */
  private conversationReadFacts(address: { workspaceId?: string; parentId: string; userId: UserId }): ConversationReadFacts | null {
    const metadata = this.metadataRow();
    if (!metadata) return null;
    this.assertParent(address.workspaceId ?? metadata.workspace_id, address.parentId);
    let participant: boolean | undefined;
    return {
      metadata,
      migrationPhases: new Map(this.sql.exec<{ substream_id: string; phase: "pending" | "complete" }>(
        "SELECT substream_id, phase FROM parent_participant_migrations WHERE parent_id = ?", this.parentId,
      ).toArray().map((row) => [row.substream_id, row.phase])),
      conversations: new Map(this.sql.exec<ConversationReadRow>(
        "SELECT substream_id, kind, status, archived_at, audience FROM parent_children WHERE parent_id = ?", this.parentId,
      ).toArray().map((row) => [row.substream_id, row])),
      grants: this.scopeGrants({ workspaceId: metadata.workspace_id, parentId: address.parentId }).forUser(address.userId),
      breakoutMemberships: new Set(this.sql.exec<{ substream_id: string }>(
        "SELECT substream_id FROM parent_breakout_members WHERE parent_id = ? AND user_id = ? AND active = 1",
        this.parentId, address.userId,
      ).toArray().map((row) => row.substream_id)),
      isParticipant: () => participant ??= this.isParticipant(address.userId),
    };
  }

  /** A union of the grant authority and the legacy roster; see the legacy object's comment. */
  private canReadConversation(
    address: { workspaceId: string; parentId: string; userId: UserId },
    substreamId: SubstreamId,
    relationship: WorkspaceRelationship | null,
    facts: ConversationReadFacts | null = this.conversationReadFacts(address),
  ): boolean {
    if (!facts) return false;
    const conversation = facts.conversations.get(substreamId) ?? null;
    const scoped = () => this.scopedAccess({ userId: address.userId, target: { kind: "conversation",
      workspaceId: asWorkspaceId(address.workspaceId), parentId: address.parentId, substreamId } },
    relationship, facts.metadata, conversation, facts.grants).allowed;
    const phase = facts.migrationPhases.get(substreamId) ?? null;
    if (phase !== null) return phase === "complete" && scoped();
    if (scoped()) return true;
    if (relationship?.status !== "active" || relationship.accessClass !== "member") return false;
    if (substreamId === "0") return facts.metadata.scope === "workspace" || facts.isParticipant();
    return conversation?.kind === "child" && conversation.status === "ready" && facts.breakoutMemberships.has(substreamId);
  }

  private resolveScopeAccess(request: ScopeAccessRequest, relationship: WorkspaceRelationship | null): ScopeAccessResult {
    const metadata = this.metadataRow();
    if (!metadata) return { allowed: false, reason: "not_found" };
    this.assertParent(request.target.workspaceId, request.target.parentId);
    const conversation = request.target.kind === "conversation" ? first(this.sql.exec<ConversationReadRow>(
      `SELECT substream_id, kind, status, archived_at, audience FROM parent_children WHERE parent_id = ? AND substream_id = ?`,
      this.parentId, request.target.substreamId)) : null;
    return ScopeAccessResultSchema.parse(this.scopedAccess(request, relationship, metadata, conversation,
      this.scopeGrants(request.target).forUser(request.userId)));
  }

  private scopedAccess(
    request: ScopeAccessRequest,
    relationship: WorkspaceRelationship | null,
    metadata: ParentMetadataRow,
    conversation: ConversationReadRow | null,
    grants: ScopeGrant[],
  ): ScopedAccess {
    return resolveScopedAccess({
      userId: request.userId, target: request.target, relationship,
      parentExists: true, parentArchived: metadata.archived_at !== null,
      parentVisibility: metadata.scope,
      conversation: conversation
        ? { status: conversation.status, archived: conversation.archived_at !== null, audience: conversation.audience }
        : null,
      grants,
    });
  }

  private async membershipIncarnations(workspaceId: string): Promise<Record<string, string>> {
    const rows = await this.env.DB.prepare(
      "SELECT user_id, incarnation FROM workspace_members WHERE workspace_id = ? AND status = 'active'",
    ).bind(workspaceId).all<{ user_id: string; incarnation: string }>();
    return Object.fromEntries(rows.results.map((row) => [row.user_id, row.incarnation]));
  }

  async deliverParticipantProjection(substreamId: string, userId: string, revision?: number): Promise<void> {
    const metadata = this.metadataRow();
    if (!metadata) throw new Error("participant_projection_parent_missing");
    const store = this.scopeGrants({ workspaceId: metadata.workspace_id, parentId: this.parentId });
    const delivery = store.pendingParticipantProjection(substreamId, userId, revision);
    if (!delivery) return;
    const child = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS,
      metadata.workspace_id, conversationObjectName(this.env.AVALON_REGION, asWorkspaceId(metadata.workspace_id),
        this.parentId, delivery.substreamId));
    const result = await child.applyParticipantProjection({ workspaceId: metadata.workspace_id,
      parentId: this.parentId, substreamId: delivery.substreamId, projection: delivery.projection });
    if (result.status !== "applied" && result.status !== "unchanged" && result.status !== "stale") {
      throw new Error(`participant_projection_delivery_${result.status}`);
    }
    store.acknowledgeParticipantProjection(delivery.substreamId, delivery.projection.userId, delivery.projection.revision);
  }

  /** Resumes from canonical receipts after failure at any cross-object boundary. */
  async runParticipantMigration(substreamId: SubstreamId): Promise<void> {
    if (substreamId === "0") await this.runMainParticipantMigration();
    else await this.runChildParticipantMigration(substreamId);
    // The handoff changes socket admission for every existing participant.
    // Finish their projections before an explicit share reports success;
    // persisted delivery intents still recover interrupted calls.
    const pending = this.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM parent_participant_deliveries
        WHERE parent_id = ? AND substream_id = ? AND acknowledged_revision IS NOT revision`,
      this.parentId, substreamId,
    ).toArray();
    for (const row of pending) await this.deliverParticipantProjection(substreamId, row.user_id);
  }

  private async runMainParticipantMigration(): Promise<void> {
    const migration = this.sql.exec<{ transfer_id: string; phase: string; incarnations_json: string | null }>(
      "SELECT transfer_id, phase, incarnations_json FROM parent_participant_migrations WHERE parent_id = ? AND substream_id = '0'",
      this.parentId,
    ).toArray()[0];
    if (!migration || migration.phase === "complete") return;
    const metadata = this.metadataRow();
    if (!metadata) throw new Error("participant_migration_parent_missing");
    const workspaceId = asWorkspaceId(metadata.workspace_id);
    const source = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, workspaceId,
      conversationObjectName(this.env.AVALON_REGION, workspaceId, this.parentId));
    const address = { workspaceId, parentId: this.parentId, substreamId: asSubstreamId("0"), transferId: migration.transfer_id };
    const prepared = await source.transferParticipantAuthority({ ...address, phase: "prepare" });
    if (prepared.status !== "prepared") throw new Error(`participant_migration_prepare_${prepared.status}`);
    const store = this.scopeGrants(address);
    store.importParticipants({ kind: "workstream", workspaceId, parentId: this.parentId }, prepared.snapshot,
      z.record(z.string(), z.string().min(1)).parse(JSON.parse(migration.incarnations_json ?? "{}")));
    const committed = await source.transferParticipantAuthority({ ...address, phase: "commit" });
    if (committed.status !== "committed") throw new Error(`participant_migration_commit_${committed.status}`);
    this.tx(() => {
      store.registerParticipantProjection("0", migration.transfer_id);
      this.sql.exec(
        "UPDATE parent_participant_migrations SET phase = 'complete' WHERE parent_id = ? AND substream_id = '0' AND transfer_id = ?",
        this.parentId, migration.transfer_id,
      );
    });
  }

  /** Internal cutover command; callers must migrate legacy writers before invoking it. */
  async beginMainParticipantMigration(input: ConversationParentAuthorityRequest): Promise<{
    status: "pending" | "complete" | "conflict"; transferId?: string;
  }> {
    const request = parseRpcInput(ConversationParentAuthorityRequestSchema, input, "main_participant_migration");
    this.assertParent(request.workspaceId, request.parentId);
    const incarnations = await this.membershipIncarnations(request.workspaceId);
    return this.tx(() => {
      const existing = this.sql.exec<{ transfer_id: string; phase: string }>(
        "SELECT transfer_id, phase FROM parent_participant_migrations WHERE parent_id = ? AND substream_id = '0'",
        this.parentId,
      ).toArray()[0];
      if (existing) return { status: z.enum(["pending", "complete"]).parse(existing.phase), transferId: existing.transfer_id };
      if (this.sql.exec("SELECT 1 FROM parent_grants WHERE parent_id = ? AND scope_kind = 'workstream' LIMIT 1",
        this.parentId).toArray().length > 0) {
        return { status: "conflict" as const };
      }
      const main = this.sql.exec<{ status: string }>(
        "SELECT status FROM parent_children WHERE parent_id = ? AND substream_id = '0'", this.parentId,
      ).toArray()[0];
      if (main?.status !== "ready") return { status: "conflict" as const };
      const transferId = uuidV7();
      this.sql.exec(
        `INSERT INTO parent_participant_migrations (parent_id, substream_id, transfer_id, phase, incarnations_json)
         VALUES (?, '0', ?, 'pending', ?)`,
        this.parentId, transferId, JSON.stringify(incarnations),
      );
      this.host.alarms.schedule({ kind: PARTICIPANT_MIGRATION_ALARM, key: participantMigrationAlarmKey(this.parentId, "0"),
        dueAt: Date.now() });
      return { status: "pending" as const, transferId };
    });
  }

  private async runChildParticipantMigration(substreamId: SubstreamId): Promise<void> {
    const migration = this.sql.exec<{ transfer_id: string; phase: string }>(
      "SELECT transfer_id, phase FROM parent_participant_migrations WHERE parent_id = ? AND substream_id = ?",
      this.parentId, substreamId,
    ).toArray()[0];
    if (!migration || migration.phase === "complete") return;
    const metadata = this.metadataRow();
    if (!metadata) throw new Error("participant_migration_parent_missing");
    const workspaceId = asWorkspaceId(metadata.workspace_id);
    const source = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, workspaceId,
      conversationObjectName(this.env.AVALON_REGION, workspaceId, this.parentId, substreamId));
    const address = { workspaceId, parentId: this.parentId, substreamId, transferId: migration.transfer_id };
    const prepared = await source.transferParticipantAuthority({ ...address, phase: "prepare" });
    if (prepared.status !== "prepared") throw new Error(`participant_migration_prepare_${prepared.status}`);
    const committed = await source.transferParticipantAuthority({ ...address, phase: "commit" });
    if (committed.status !== "committed") throw new Error(`participant_migration_commit_${committed.status}`);
    this.tx(() => {
      // Parent membership was imported before any external await. The child's
      // local roster is only a reconciliation audience, never granting evidence.
      this.scopeGrants(address).registerParticipantProjection(substreamId, migration.transfer_id,
        prepared.snapshot.participants.map((participant) => participant.userId));
      this.sql.exec(
        "UPDATE parent_participant_migrations SET phase = 'complete' WHERE parent_id = ? AND substream_id = ? AND transfer_id = ?",
        this.parentId, substreamId, migration.transfer_id,
      );
    });
  }

  async beginChildParticipantMigration(input: { workspaceId: string; parentId: string; substreamId: string }): Promise<{
    status: "pending" | "complete" | "conflict"; transferId?: string;
  }> {
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema,
      substreamId: SubstreamIdSchema.refine((id) => id !== "0") }), input, "child_participant_migration");
    this.assertParent(request.workspaceId, request.parentId);
    const incarnations = await this.membershipIncarnations(request.workspaceId);
    return this.startChildParticipantMigration(request, incarnations);
  }

  private startChildParticipantMigration(
    request: { workspaceId: WorkspaceId; parentId: string; substreamId: SubstreamId },
    incarnations: Record<string, string>,
  ): { status: "pending" | "complete" | "conflict"; transferId?: string } {
    return this.tx(() => {
      const existing = this.sql.exec<{ transfer_id: string; phase: string }>(
        "SELECT transfer_id, phase FROM parent_participant_migrations WHERE parent_id = ? AND substream_id = ?",
        this.parentId, request.substreamId,
      ).toArray()[0];
      if (existing) return { status: z.enum(["pending", "complete"]).parse(existing.phase), transferId: existing.transfer_id };
      const child = this.sql.exec<{ status: string }>(
        "SELECT status FROM parent_children WHERE parent_id = ? AND substream_id = ? AND kind = 'child'",
        this.parentId, request.substreamId,
      ).toArray()[0];
      if (child?.status !== "ready" || this.sql.exec(
        "SELECT 1 FROM parent_grants WHERE parent_id = ? AND scope_kind = 'conversation' AND substream_id = ? LIMIT 1",
        this.parentId, request.substreamId,
      ).toArray().length) return { status: "conflict" as const };
      const transferId = uuidV7();
      const participants = this.sql.exec<{ user_id: string; added_by_user_id: string; added_at: number }>(
        `SELECT user_id, added_by_user_id, added_at FROM parent_breakout_members
          WHERE parent_id = ? AND substream_id = ? AND active = 1 ORDER BY user_id`,
        this.parentId, request.substreamId,
      ).toArray();
      this.sql.exec(
        "INSERT INTO parent_participant_migrations (parent_id, substream_id, transfer_id, phase) VALUES (?, ?, ?, 'pending')",
        this.parentId, request.substreamId, transferId,
      );
      this.scopeGrants(request).importParticipants({ kind: "conversation", ...request },
        ParticipantTransferSnapshotSchema.parse({ transferId, participants: participants.map((participant) => ({
          userId: participant.user_id, addedByUserId: participant.added_by_user_id, addedAt: participant.added_at,
          reason: "explicit",
        })) }), incarnations);
      this.host.alarms.schedule({ kind: PARTICIPANT_MIGRATION_ALARM,
        key: participantMigrationAlarmKey(this.parentId, request.substreamId), dueAt: Date.now() });
      return { status: "pending" as const, transferId };
    });
  }

  private scopeInvitations(): ScopeInvitationService {
    return new ScopeInvitationService(this.env, this.storage, this.parentId,
      (request, relationship) => this.resolveScopeAccess(request, relationship),
      (request) => this.completeWorkstreamCoverage(request.targets),
      this.grantDirectoryWriter(),
      (workspaceId, userId) => this.host.readRelationship(workspaceId, userId),
      (relationship) => this.host.noteRelationship(relationship));
  }

  async indexPendingInvitations(): Promise<void> {
    const metadata = this.metadataRow();
    if (metadata) await this.scopeInvitations().indexPending(metadata.workspace_id);
  }

  async deliverInvitation(invitationId: string): Promise<void> {
    return this.scopeInvitations().deliver(invitationId);
  }

  private completeWorkstreamCoverage(targets: readonly ScopeGrantTarget[]): boolean {
    if (!targets.some((target) => target.kind === "workstream")) return false;
    return this.sql.exec<{ substream_id: string; audience: string }>(
      "SELECT substream_id, audience FROM parent_children WHERE parent_id = ? AND kind = 'child' AND status = 'ready'",
      this.parentId,
    ).toArray().every((child) => child.audience === "inherits_workstream" || targets.some((target) =>
      target.kind === "conversation" && target.substreamId === child.substream_id));
  }

  /** Advisory choices; invitation creation repeats authorization after all awaits. */
  async scopeSharingOptions(input: z.infer<typeof ScopeSharingOptionsRequestSchema>) {
    const request = ScopeSharingOptionsRequestSchema.parse(input);
    if (!this.metadataRow()) return ScopeSharingOptionsSchema.parse({ scopes: [], completeWorkstreamTargets: null });
    this.assertParent(request.workspaceId, request.parentId);
    let actor = await this.host.readRelationship(request.workspaceId, request.actorUserId);
    if (actor?.status !== "active") return ScopeSharingOptionsSchema.parse({ scopes: [], completeWorkstreamTargets: null });
    let legacyMainParticipant = false;
    if (this.participantMigrationPhase("0") === null) {
      const main = await createIdentityObjectPort(this.env, request.workspaceId, request.parentId)
        .readAuthorizationFacts({ userId: request.actorUserId });
      legacyMainParticipant = main.exists && main.participant && !main.archived;
      actor = await this.host.readRelationship(request.workspaceId, request.actorUserId);
    }
    const metadata = this.metadataRow();
    if (!metadata || actor?.status !== "active" || metadata.archived_at !== null) {
      return ScopeSharingOptionsSchema.parse({ scopes: [], completeWorkstreamTargets: null });
    }
    const parent: ScopeGrantTarget = { kind: "workstream", workspaceId: request.workspaceId, parentId: request.parentId };
    const canShare = (target: ScopeGrantTarget) => {
      const access = this.resolveScopeAccess({ userId: request.actorUserId, target }, actor);
      if (access.allowed && access.writable && access.grantIds.length > 0) return true;
      const id = target.kind === "workstream" ? "0" : target.substreamId;
      if (this.participantMigrationPhase(id) !== null) return false;
      return id === "0" ? legacyMainParticipant : this.sql.exec(
        "SELECT 1 FROM parent_breakout_members WHERE parent_id = ? AND substream_id = ? AND user_id = ? AND active = 1",
        this.parentId, id, request.actorUserId,
      ).toArray().length > 0;
    };
    const scopes: Array<{ target: ScopeGrantTarget; title: string }> = [];
    if (canShare(parent)) scopes.push({ target: parent, title: "Main and inheriting substreams" });
    for (const child of this.sql.exec<{ substream_id: string; title: string | null; archived_at: number | null }>(
      "SELECT substream_id, title, archived_at FROM parent_children WHERE parent_id = ? AND status = 'ready' ORDER BY substream_id",
      this.parentId,
    ).toArray()) {
      const target: ScopeGrantTarget = { ...parent, kind: "conversation", substreamId: asSubstreamId(child.substream_id) };
      if (child.archived_at === null && canShare(target)) scopes.push({ target,
        title: child.substream_id === "0" ? "Main" : child.title ?? "Shared substream" });
    }
    if (legacyMainParticipant && !scopes.some((scope) => scope.target.kind === "conversation" && scope.target.substreamId === "0")
      && !this.sql.exec("SELECT 1 FROM parent_children WHERE parent_id = ? AND substream_id = '0'", this.parentId).toArray().length) {
      scopes.push({ target: { ...parent, kind: "conversation", substreamId: asSubstreamId("0") }, title: "Main" });
    }
    const restricted = new Set(this.sql.exec<{ substream_id: string }>(
      `SELECT substream_id FROM parent_children
        WHERE parent_id = ? AND kind = 'child' AND status = 'ready' AND audience = 'restricted'`,
      this.parentId,
    ).toArray().map((child) => child.substream_id));
    const targets = scopes.map((scope) => scope.target).filter((target) => target.kind === "workstream"
      || restricted.has(target.substreamId));
    return ScopeSharingOptionsSchema.parse({ scopes,
      completeWorkstreamTargets: this.completeWorkstreamCoverage(targets) ? targets : null });
  }

  /** Cut over only addressed legacy scopes; invitation creation rechecks grants afterwards. */
  private async prepareSharingTargets(
    request: Pick<z.infer<typeof CreateScopeInvitationsSchema>, "workspaceId" | "parentId" | "actorUserId" | "targets">,
  ): Promise<{ status: "denied"; reason: "relationship_required" | "sharing_required" | "migration_pending" } | null> {
    const inherited = request.targets.some((target) => target.kind === "workstream")
      ? this.sql.exec<{ substream_id: string }>(
        `SELECT substream_id FROM parent_children
          WHERE parent_id = ? AND kind = 'child' AND status = 'ready' AND audience = 'inherits_workstream'`,
        this.parentId,
      ).toArray().map((child) => child.substream_id) : [];
    const substreamIds = [...new Set([...request.targets.map((target) =>
      target.kind === "workstream" ? "0" : target.substreamId), ...inherited])];
    const legacy = substreamIds.filter((id) => this.participantMigrationPhase(id) !== "complete");
    if (!legacy.length) return null;
    const actor = await this.host.readRelationship(request.workspaceId, request.actorUserId);
    if (actor?.status !== "active") return { status: "denied", reason: "relationship_required" };
    const parentAccess = this.resolveScopeAccess({ userId: request.actorUserId,
      target: { kind: "workstream", workspaceId: request.workspaceId, parentId: request.parentId } }, actor);
    let sharesInherited = parentAccess.allowed && parentAccess.writable && parentAccess.grantIds.length > 0;
    if (legacy.includes("0")) {
      const main = await createIdentityObjectPort(this.env, request.workspaceId, request.parentId)
        .readAuthorizationFacts({ userId: request.actorUserId });
      if (!main.exists || !main.participant || main.archived) return { status: "denied", reason: "sharing_required" };
      this.registerChild("0", "main", null, Date.now());
      sharesInherited = true;
    }
    for (const substreamId of legacy) {
      if (substreamId !== "0" && !(sharesInherited && inherited.includes(substreamId)) && !this.sql.exec(
        "SELECT 1 FROM parent_breakout_members WHERE parent_id = ? AND substream_id = ? AND user_id = ? AND active = 1",
        this.parentId, substreamId, request.actorUserId,
      ).toArray().length) return { status: "denied", reason: "sharing_required" };
    }
    for (const substreamId of legacy) {
      const address = { workspaceId: request.workspaceId, parentId: request.parentId };
      const migration = substreamId === "0"
        ? await this.beginMainParticipantMigration(address)
        : await this.beginChildParticipantMigration({ ...address, substreamId });
      if (migration.status === "conflict") return { status: "denied", reason: "migration_pending" };
      // Foreground progress; the persisted alarm recovers any interrupted boundary.
      await this.runParticipantMigration(asSubstreamId(substreamId));
    }
    return null;
  }

  async listManagedScopeGrants(input: z.infer<typeof ScopeGrantManagementRequestSchema>) {
    const request = ScopeGrantManagementRequestSchema.parse(input);
    this.assertParent(request.target.workspaceId, request.target.parentId);
    const denied = { status: "denied" as const, reason: "sharing_required" as const };
    const actor = await this.host.readRelationship(request.target.workspaceId, request.actorUserId);
    const canManage = (relationship: WorkspaceRelationship | null) => {
      const access = this.resolveScopeAccess({ target: request.target, userId: request.actorUserId }, relationship);
      return access.allowed && access.writable && access.grantIds.length > 0;
    };
    if (!canManage(actor)) return ManagedScopeGrantsSchema.parse(denied);
    const store = this.scopeGrants(request.target);
    const initial = store.forTarget(request.target).filter((grant) => grant.active);
    const profiles = new Map(await Promise.all(initial.map(async (grant) => [grant.userId,
      await this.env.DB.prepare("SELECT name, email FROM users WHERE id = ?").bind(grant.userId)
        .first<{ name: string; email: string }>(),
    ] as const)));
    const current = await this.host.readRelationship(request.target.workspaceId, request.actorUserId);
    // Profile lookup interleaves. Re-read authority and grants before releasing labels.
    if (!canManage(current) || current?.incarnation !== actor?.incarnation || current?.revision !== actor?.revision) {
      return ManagedScopeGrantsSchema.parse(denied);
    }
    return ManagedScopeGrantsSchema.parse({ status: "ready", grants: store.forTarget(request.target)
      .filter((grant) => grant.active && profiles.has(grant.userId)).map((grant) => ({ grant,
        name: profiles.get(grant.userId)?.name ?? null, email: profiles.get(grant.userId)?.email ?? null })) });
  }

  async listScopeInvitations(input: z.infer<typeof ListScopeInvitationsSchema>) {
    const request = ListScopeInvitationsSchema.parse(input);
    this.assertParent(request.target.workspaceId, request.target.parentId);
    return this.scopeInvitations().list(request);
  }

  async createScopeInvitations(input: z.infer<typeof CreateScopeInvitationsSchema>): Promise<ScopeInvitationResult> {
    const request = parseRpcInput(CreateScopeInvitationsSchema, input, "create_scope_invitations");
    this.assertParent(request.workspaceId, request.parentId);
    if (!scopeInvitationOrigin(this.env)) return { status: "denied", reason: "configuration_required" };
    const denied = await this.prepareSharingTargets(request);
    if (denied) return denied;
    return ScopeInvitationResultSchema.parse(await this.scopeInvitations().create(request));
  }

  /** Shares pending for these verified addresses become this user's grants; returns those claimed. */
  async claimScopeInvitations(input: z.infer<typeof ClaimScopeInvitationsSchema>): Promise<ScopeInvitationSummary[]> {
    const request = parseRpcInput(ClaimScopeInvitationsSchema, input, "claim_scope_invitations");
    this.assertParent(request.workspaceId, request.parentId);
    return this.scopeInvitations().claim(request);
  }

  async revokeScopeInvitation(input: z.infer<typeof RevokeScopeInvitationSchema>): Promise<ScopeInvitationResult> {
    const request = parseRpcInput(RevokeScopeInvitationSchema, input, "revoke_scope_invitation");
    this.assertParent(request.workspaceId, request.parentId);
    return ScopeInvitationResultSchema.parse(await this.scopeInvitations().revoke(request));
  }

  /** Canonical exact-scope admission for the new sharing protocol. No Main preflight. */
  async readScopeAccess(input: ScopeAccessRequest): Promise<ScopeAccessResult> {
    const request = parseRpcInput(ScopeAccessRequestSchema, input, "scope_access");
    const relationship = await this.host.readRelationship(request.target.workspaceId, request.userId);
    return this.resolveScopeAccess(request, relationship);
  }

  async readSharedWorkstream(input: z.infer<typeof SharedWorkstreamRequestSchema>) {
    const request = SharedWorkstreamRequestSchema.parse(input);
    const relationship = await this.host.readRelationship(request.workspaceId, request.userId);
    const metadata = this.metadataRow();
    if (!metadata || relationship?.status !== "active" || relationship.incarnation !== request.membershipIncarnation) return null;
    this.assertParent(request.workspaceId, request.parentId);
    const facts = this.conversationReadFacts(request);
    const projections = new Map(this.sql.exec<{ substream_id: string; effect_json: string }>(
      "SELECT substream_id, effect_json FROM parent_child_projections WHERE parent_id = ?", this.parentId,
    ).toArray().map((row) => [row.substream_id, WorkstreamDirectoryCommonEffectSchema.parse(JSON.parse(row.effect_json))]));
    const viewerProjections = request.includeAttention
      ? new Map(this.sql.exec<{ substream_id: string; effect_json: string }>(
        "SELECT substream_id, effect_json FROM parent_child_viewer_projections WHERE parent_id = ? AND user_id = ?",
        this.parentId, request.userId,
      ).toArray().map((row) => [row.substream_id, WorkstreamDirectoryUserEffectSchema.parse(JSON.parse(row.effect_json))]))
      : null;
    const conversations = this.sql.exec<{
      substream_id: string; title: string | null; archived_at: number | null; audience: "restricted" | "inherits_workstream";
      origin_turn_id: string | null; resolved: number;
    }>(
      `SELECT child.substream_id, child.title, child.archived_at, child.audience, child.resolved,
              json_extract(preparation.request_json, '$.sourceThroughTurnId') AS origin_turn_id
         FROM parent_children child
         LEFT JOIN parent_breakout_preparations preparation
           ON preparation.parent_id = child.parent_id AND preparation.substream_id = child.substream_id
        WHERE child.parent_id = ? ORDER BY child.substream_id`,
      this.parentId,
    ).toArray().filter((child) => this.canReadConversation(request, asSubstreamId(child.substream_id), relationship, facts))
      .map((child) => {
        const common = projections.get(child.substream_id);
        const viewer = viewerProjections?.get(child.substream_id);
        const appearance = common?.appearance;
        return {
          substreamId: child.substream_id,
          ...(request.includeResolution && child.resolved === 1 ? { resolved: true } : {}),
          archived: metadata.archived_at !== null || child.archived_at !== null,
          title: child.substream_id === "0" ? "Main" : child.title ?? "Shared breakout",
          scope: child.substream_id === "0" || child.audience === "inherits_workstream" ? metadata.scope : "personal",
          ...(child.substream_id === "0" ? {} : { originTurnId: child.origin_turn_id }),
          ...(appearance ? { appearance } : {}),
          ...(viewerProjections ? { needsAttention: conversationNeedsViewer({
            harnessStatus: common ? harnessStatus(common.state) : "completed",
            hasUnread: (viewer?.unreadCount ?? 0) > 0,
            youAreMentioned: viewer?.youAreMentioned,
            unseen: viewer?.unseen,
          }) } : {}),
        };
      });
    if (!conversations.length) return null;
    return SharedNavigationWorkstreamSchema.parse({
      parentId: request.parentId, archived: metadata.archived_at !== null,
      title: metadata.title, scope: metadata.scope,
      ...(projections.get("0")?.appearance ? { appearance: projections.get("0")!.appearance } : {}),
      conversations,
    });
  }

  /**
   * Workers supply the authenticated actor, never an actor chosen by the model.
   * Local grants and lifecycle are re-read after the external relationship
   * reads, with no await between the sharing decision and its durable mutation.
   */
  async mutateScopeGrant(input: ScopeGrantMutation): Promise<ScopeGrantMutationResult> {
    const request = parseRpcInput(ScopeGrantMutationSchema, input, "scope_grant_mutation");
    const result = await this.authorizedGrantMutation(request, false);
    if (result.status === "committed") {
      const targets = request.target.kind === "conversation" ? [request.target.substreamId]
        : this.sql.exec<{ substream_id: string }>(
          "SELECT substream_id FROM parent_participant_targets WHERE parent_id = ?", this.parentId,
        ).toArray().map((row) => row.substream_id);
      await Promise.all(targets.map((substreamId) => this.deliverParticipantProjection(substreamId, request.userId)));
    }
    return result;
  }

  async mutateParticipantGrant(input: ParticipantGrantMutation): Promise<ScopeGrantMutationResult> {
    const request = parseRpcInput(ParticipantGrantMutationSchema, input, "participant_grant_mutation");
    if (request.active) {
      const denied = await this.prepareSharingTargets({ ...request.target,
        actorUserId: request.actorUserId, targets: [request.target] });
      if (denied) return { status: "denied", reason: denied.reason === "relationship_required" ? "sharing_required" : denied.reason };
    }
    const result = await this.authorizedGrantMutation({ ...request, expectedRevision: 0 }, true);
    if (result.status === "committed") {
      // Converge the addressed roster before replying; the alarm is the recovery path.
      await this.deliverParticipantProjection(
        request.target.kind === "workstream" ? "0" : request.target.substreamId, request.userId,
      );
    }
    return result;
  }

  async admitConnectorParticipants(
    input: z.infer<typeof ConnectorParticipantAdmissionSchema>,
  ): Promise<{ status: "legacy" | "ready" | "pending" }> {
    const request = ConnectorParticipantAdmissionSchema.parse(input);
    if (this.metadataRow()) this.assertParent(request.workspaceId, request.parentId);
    if (this.participantMigrationPhase("0") === null) return { status: "legacy" };
    const userIds = [...new Set(request.userIds)].sort();
    const canonical = JSON.stringify({ ...request, userIds });
    const receipt = this.sql.exec<{ request_json: string }>(
      "SELECT request_json FROM parent_connector_admissions WHERE parent_id = ? AND event_id = ?",
      this.parentId, request.eventId,
    ).toArray()[0];
    if (receipt) {
      if (receipt.request_json !== canonical) throw new Error("connector_participant_admission_conflict");
      const store = this.scopeGrants(request);
      for (const userId of userIds) {
        if (store.pendingParticipantProjection("0", userId)) await this.deliverParticipantProjection("0", userId);
      }
      return { status: "ready" };
    }
    const relationships = await Promise.all(userIds.map((userId) =>
      this.host.readRelationship(request.workspaceId, userId)));
    const target = { kind: "conversation" as const, workspaceId: request.workspaceId,
      parentId: request.parentId, substreamId: asSubstreamId("0") };
    const store = this.scopeGrants(target);
    const result = this.tx(() => {
      if (this.participantMigrationPhase("0") !== "complete") return { status: "pending" as const };
      const prior = this.sql.exec<{ request_json: string }>(
        "SELECT request_json FROM parent_connector_admissions WHERE parent_id = ? AND event_id = ?",
        this.parentId, request.eventId,
      ).toArray()[0];
      if (prior) {
        if (prior.request_json !== canonical) throw new Error("connector_participant_admission_conflict");
        return { status: "ready" as const };
      }
      if (this.metadataRow()?.archived_at !== null) return { status: "pending" as const };
      for (const [index, userId] of userIds.entries()) {
        const relationship = relationships[index];
        // Provider membership can seat an ordinary member; a guest still needs an explicit share.
        if (relationship?.status !== "active" || relationship.accessClass !== "member") continue;
        const access = this.resolveScopeAccess({ target, userId }, relationship);
        if (access.allowed && access.grantIds.length > 0) continue;
        const mutation = store.mutateCurrent({ target, userId, actorUserId: request.addedByUserId ?? userId,
          operationId: uuidV7(), active: true }, relationship.incarnation);
        if (mutation.status !== "committed") throw new Error("connector_participant_admission_conflict");
      }
      this.sql.exec("INSERT INTO parent_connector_admissions(parent_id, event_id, request_json) VALUES (?, ?, ?)",
        this.parentId, request.eventId, canonical);
      return { status: "ready" as const };
    });
    if (result.status === "ready") {
      for (const userId of userIds) {
        if (store.pendingParticipantProjection("0", userId)) await this.deliverParticipantProjection("0", userId);
      }
    }
    return result;
  }

  /** Posting may join a member-readable conversation, never grant a parent or another user. */
  async joinConversation(input: ParticipantGrantMutation): Promise<{ status: "ready" | "denied" }> {
    const request = parseRpcInput(ParticipantGrantMutationSchema, input, "join_conversation");
    if (!request.active || request.userId !== request.actorUserId || request.target.kind !== "conversation") {
      return { status: "denied" };
    }
    const relationship = await this.host.readRelationship(request.target.workspaceId, request.userId);
    const access = this.migratedConversationAccess({ ...request.target, userId: request.userId },
      request.target.substreamId, relationship);
    if (!access.allowed || !access.writable || relationship?.status !== "active") return { status: "denied" };
    const store = this.scopeGrants(request.target);
    // Existing inherited access remains inherited.
    if (access.grantIds.length === 0) {
      const result = store.mutateCurrent(request, relationship.incarnation);
      if (result.status !== "committed") return { status: "denied" };
    }
    await this.deliverParticipantProjection(request.target.substreamId, request.userId);
    return { status: store.participantProjection(request.target.substreamId, request.userId)?.active ? "ready" : "denied" };
  }

  private async authorizedGrantMutation(request: ScopeGrantMutation, useCurrentRevision: boolean): Promise<ScopeGrantMutationResult> {
    const [actor, recipient, activeIncarnations] = await Promise.all([
      this.host.readRelationship(request.target.workspaceId, request.actorUserId),
      this.host.readRelationship(request.target.workspaceId, request.userId),
      !request.active ? this.membershipIncarnations(request.target.workspaceId) : Promise.resolve(null),
    ]);
    if (this.sql.exec("SELECT 1 FROM parent_participant_migrations WHERE parent_id = ? AND phase = 'pending' LIMIT 1",
      this.parentId).toArray().length) {
      return { status: "denied", reason: "migration_pending" };
    }
    const admission = this.resolveScopeAccess({ target: request.target, userId: request.actorUserId }, actor);
    // Implicit workspace-public reading is not the right to invite somebody.
    if (!admission.allowed || !admission.writable || admission.grantIds.length === 0) {
      return { status: "denied", reason: "sharing_required" };
    }
    if (request.active && recipient?.status !== "active") return { status: "denied", reason: "recipient_relationship_required" };
    const store = this.scopeGrants(request.target);
    if (useCurrentRevision && !request.active && request.target.kind === "conversation"
      && !store.hasOperation(request.operationId)) {
      const inherited = store.read(request.userId, { kind: "workstream", workspaceId: request.target.workspaceId,
        parentId: request.target.parentId });
      const inherits = request.target.substreamId === "0" || this.sql.exec<{ audience: string }>(
        "SELECT audience FROM parent_children WHERE parent_id = ? AND substream_id = ?",
        this.parentId, request.target.substreamId,
      ).toArray()[0]?.audience === "inherits_workstream";
      if (inherits && inherited?.active && inherited.membershipIncarnation === recipient?.incarnation) {
        return { status: "denied", reason: "inherited_access" };
      }
    }
    if (!request.active && !store.hasOperation(request.operationId)
      && !store.hasParticipantAfterRemoval(request.userId, request.target, activeIncarnations ?? {})) {
      return { status: "denied", reason: "participant_required" };
    }
    return ScopeGrantMutationResultSchema.parse(useCurrentRevision
      ? store.mutateCurrent(ParticipantGrantMutationSchema.parse({ operationId: request.operationId,
        actorUserId: request.actorUserId, userId: request.userId, target: request.target, active: request.active,
        ...(request.participationReason ? { participationReason: request.participationReason } : {}),
      }), recipient?.incarnation ?? null)
      : store.mutate(request, recipient?.incarnation ?? null));
  }

  // ---------------------------------------------------------------------------
  // Private breakouts.
  // ---------------------------------------------------------------------------

  private canPreparePrivateChild(address: { workspaceId: string; parentId: string }, userId: UserId,
    relationship: WorkspaceRelationship | null): boolean {
    if (this.participantMigrationPhase("0") !== null) {
      const access = this.migratedConversationAccess({ ...address, userId }, asSubstreamId("0"), relationship);
      return access.allowed && access.writable;
    }
    return this.canRead(userId);
  }

  /** Reserve one creator-only nonzero child and its immutable preparation receipt. */
  async beginPrivateChildPreparation(input: BeginPrivateChildPreparationRequest): Promise<PrivateChildPreparationOperation> {
    const request = BeginPrivateChildPreparationRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const initialMembers = [...new Set(request.membershipInitializer.memberUserIds)];
    if (initialMembers.length !== request.membershipInitializer.memberUserIds.length
      || !initialMembers.includes(request.creatorUserId)) {
      throw new Error("private_child_membership_initializer_invalid");
    }
    const relationships = new Map(this.participantMigrationPhase("0") !== null
      ? await Promise.all(initialMembers.map(async (userId) => [userId,
        await this.host.readRelationship(request.workspaceId, userId)] as const)) : []);
    if (!this.canPreparePrivateChild(request, request.creatorUserId, relationships.get(request.creatorUserId) ?? null)) {
      throw new Error("private_child_creator_not_admitted_to_parent");
    }
    for (const userId of initialMembers) {
      if (!this.canPreparePrivateChild(request, userId, relationships.get(userId) ?? null)) {
        throw new Error("private_child_initial_member_not_admitted_to_parent");
      }
    }
    const canonicalRequest = JSON.stringify(request);
    const existing = this.privateChildPreparation(request.operationId);
    if (existing) {
      const stored = first(this.sql.exec<{ request_json: string }>(
        `SELECT request_json FROM parent_breakout_preparations WHERE parent_id = ? AND operation_id = ?`,
        this.parentId, request.operationId,
      ));
      if (stored?.request_json !== canonicalRequest) throw new Error("private_child_preparation_conflict");
      return existing;
    }
    const now = Date.now();
    const substreamId = uuidV7(now);
    this.tx(() => {
      this.registerChild(substreamId, "child", request.creatorUserId, now);
      this.sql.exec(
        `UPDATE parent_children SET status = 'reserved', title = ?, updated_at = ? WHERE parent_id = ? AND substream_id = ?`,
        request.title, now, this.parentId, substreamId,
      );
      for (const userId of initialMembers) {
        this.sql.exec(
          `INSERT INTO parent_breakout_members
             (parent_id, substream_id, user_id, active, version, added_by_user_id, added_at, removed_at, updated_at)
           VALUES (?, ?, ?, 1, 1, ?, ?, NULL, ?)`,
          this.parentId, substreamId, userId, request.creatorUserId, now, now,
        );
      }
      this.sql.exec(
        `INSERT INTO parent_breakout_preparations
           (parent_id, operation_id, substream_id, creator_user_id, request_json, capture_json,
            completed_parts_json, prepared_context_json, status, error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, '[]', NULL, 'preparing', NULL, ?, ?)`,
        this.parentId, request.operationId, substreamId, request.creatorUserId, canonicalRequest, now, now,
      );
      for (const userId of initialMembers) {
        this.insertPrivateChildMembershipEffect({
          operationId: `prepare:${request.operationId}:${userId}`, substreamId, userId,
          actorUserId: request.creatorUserId, active: true, membershipVersion: 1, now,
        });
      }
    });
    return this.requirePrivateChildPreparation(request.operationId);
  }

  readPrivateChildPreparation(input: ReadPrivateChildPreparationRequest): PrivateChildPreparationOperation | null {
    const request = ReadPrivateChildPreparationRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    return this.privateChildPreparation(request.operationId);
  }

  async claimPrivateChildConfirmation(input: ClaimPrivateChildConfirmationRequest): Promise<PrivateChildPreparationOperation> {
    const request = parseRpcInput(ClaimPrivateChildConfirmationRequestSchema, input, "private_child_confirmation");
    this.assertParent(request.workspaceId, request.parentId);
    const relationship = this.participantMigrationPhase("0") !== null
      ? await this.host.readRelationship(request.workspaceId, request.actorUserId) : null;
    this.tx(() => {
      const operation = this.requirePrivateChildPreparation(request.operationId);
      if (operation.creatorUserId !== request.actorUserId) throw new Error("private_child_confirmation_forbidden");
      if (!this.canPreparePrivateChild(request, request.actorUserId, relationship)) throw new Error("private_child_confirmation_forbidden");
      if (operation.status === "failed") throw new Error("private_child_preparation_failed");
      if (operation.status === "preparing") throw new Error("private_child_context_not_prepared");
      if (operation.status !== "prepared" && operation.preparedConversationHash !== (request.preparedConversationHash ?? null)) {
        throw new Error("private_child_initialization_conflict");
      }
      if (operation.status === "prepared") {
        this.sql.exec(
          `UPDATE parent_breakout_preparations SET status = 'confirming', prepared_conversation_hash = ?, updated_at = ?
            WHERE parent_id = ? AND operation_id = ?`,
          request.preparedConversationHash ?? null, Date.now(), this.parentId, request.operationId,
        );
      }
    });
    return this.requirePrivateChildPreparation(request.operationId);
  }

  savePrivateChildCapture(input: SavePrivateChildCaptureRequest): PrivateChildPreparationOperation {
    const request = SavePrivateChildCaptureRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const value = JSON.stringify(request.capture);
    this.tx(() => {
      const row = first(this.sql.exec<{ status: string; value: string | null }>(
        `SELECT status, capture_json AS value FROM parent_breakout_preparations WHERE parent_id = ? AND operation_id = ?`,
        this.parentId, request.operationId,
      ));
      if (!row) throw new Error("private_child_preparation_not_found");
      if (row.value !== null) {
        if (row.value !== value) throw new Error("private_child_preparation_conflict");
        return;
      }
      if (row.status !== "preparing") throw new Error("private_child_preparation_not_writable");
      this.sql.exec(
        `UPDATE parent_breakout_preparations SET capture_json = ?, updated_at = ? WHERE parent_id = ? AND operation_id = ?`,
        value, Date.now(), this.parentId, request.operationId,
      );
    });
    return this.requirePrivateChildPreparation(request.operationId);
  }

  savePrivateChildPart(input: SavePrivateChildPartRequest): PrivateChildPreparationOperation {
    const request = SavePrivateChildPartRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const operation = this.requirePrivateChildPreparation(request.operationId);
    if (operation.status !== "preparing") throw new Error("private_child_preparation_not_writable");
    const existing = operation.completedParts.find((part) => part.recipe.id === request.part.recipe.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(request.part)) throw new Error("private_child_part_conflict");
    if (!existing) {
      this.sql.exec(
        `UPDATE parent_breakout_preparations SET completed_parts_json = ?, updated_at = ?
          WHERE parent_id = ? AND operation_id = ? AND status = 'preparing'`,
        JSON.stringify([...operation.completedParts, request.part]), Date.now(), this.parentId, request.operationId,
      );
    }
    return this.requirePrivateChildPreparation(request.operationId);
  }

  async savePreparedPrivateChildContext(input: SavePreparedPrivateChildContextRequest): Promise<PrivateChildPreparationOperation> {
    const request = SavePreparedPrivateChildContextRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const json = JSON.stringify(request.preparedContext);
    const creator = this.requirePrivateChildPreparation(request.operationId).creatorUserId;
    const relationship = this.participantMigrationPhase("0") !== null
      ? await this.host.readRelationship(request.workspaceId, creator) : null;
    const operation = this.requirePrivateChildPreparation(request.operationId);
    // Re-read local grant authority after the relationship read, before commit/return.
    if (!this.canPreparePrivateChild(request, operation.creatorUserId, relationship)) throw new Error("private_child_preparation_forbidden");
    if (operation.preparedContext && JSON.stringify(operation.preparedContext) !== json) {
      throw new Error("private_child_context_conflict");
    }
    if (!operation.preparedContext) {
      this.tx(() => {
        const current = this.requirePrivateChildPreparation(request.operationId);
        if (current.status !== "preparing") throw new Error("private_child_preparation_not_writable");
        this.sql.exec(
          `UPDATE parent_breakout_preparations
              SET prepared_context_json = ?, completed_parts_json = ?, status = 'prepared', updated_at = ?
            WHERE parent_id = ? AND operation_id = ?`,
          json, JSON.stringify(request.preparedContext.parts), Date.now(), this.parentId, request.operationId,
        );
      });
    }
    return this.requirePrivateChildPreparation(request.operationId);
  }

  async setPrivateChildTerminalStatus(input: SetPrivateChildTerminalStatusRequest): Promise<PrivateChildPreparationOperation> {
    const request = SetPrivateChildTerminalStatusRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const selectedOperation = this.requirePrivateChildPreparation(request.operationId);
    if (request.status === "ready" && selectedOperation.status === "confirming") {
      await this.drainPrivateChildMembershipEffects(selectedOperation.substreamId);
    }
    const incarnations = request.status === "ready" && this.participantMigrationPhase("0") !== null
      ? await this.membershipIncarnations(request.workspaceId) : {};
    const relationship = this.participantMigrationPhase("0") !== null
      ? await this.host.readRelationship(request.workspaceId, selectedOperation.creatorUserId) : null;
    this.tx(() => {
      const operation = this.requirePrivateChildPreparation(request.operationId);
      if (!this.canPreparePrivateChild(request, operation.creatorUserId, relationship)) throw new Error("private_child_preparation_forbidden");
      if (operation.status === request.status) return;
      if (operation.status === "ready" || operation.status === "failed") throw new Error("private_child_terminal_status_conflict");
      if (request.status === "failed" && operation.status === "confirming") throw new Error("private_child_confirmation_in_progress");
      if (request.status === "ready" && operation.status !== "confirming") throw new Error("private_child_context_not_prepared");
      if (request.status === "ready" && first(this.sql.exec(
        `SELECT operation_id FROM parent_breakout_member_effects
          WHERE parent_id = ? AND substream_id = ? AND state <> 'delivered' LIMIT 1`,
        this.parentId, operation.substreamId,
      ))) throw new Error("private_child_membership_delivery_pending");
      const now = Date.now();
      this.sql.exec(
        `UPDATE parent_breakout_preparations SET status = ?, error_code = ?, updated_at = ?
          WHERE parent_id = ? AND operation_id = ?`,
        request.status, request.status === "failed" ? request.errorCode : null, now, this.parentId, request.operationId,
      );
      this.sql.exec(
        `UPDATE parent_children SET status = ?, title = COALESCE(?, title), updated_at = ?
          WHERE parent_id = ? AND substream_id = ?`,
        request.status, request.title ?? null, now, this.parentId, operation.substreamId,
      );
      // Publication and durable handoff intent share one commit.
      if (request.status === "ready" && this.participantMigrationPhase("0") !== null) {
        const migration = this.startChildParticipantMigration({ workspaceId: asWorkspaceId(request.workspaceId),
          parentId: request.parentId, substreamId: asSubstreamId(operation.substreamId) }, incarnations);
        if (migration.status === "conflict") throw new Error("private_child_participant_migration_conflict");
      }
    });
    if (request.status === "ready") {
      await this.host.armNextAlarm();
      await this.runChildParticipantMigration(asSubstreamId(selectedOperation.substreamId));
      const now = Date.now();
      for (const member of this.sql.exec<{ user_id: string }>(
        `SELECT user_id FROM parent_breakout_members WHERE parent_id = ? AND substream_id = ? AND active = 1`,
        this.parentId, selectedOperation.substreamId,
      ).toArray()) {
        this.advancePrivateChildrenVersion(member.user_id, now);
      }
    }
    await this.broadcastMetadata();
    return this.requirePrivateChildPreparation(request.operationId);
  }

  /** Called inside the caller's transaction for both merge and manual resolution. */
  private markResolved(substreamId: string, now: number): boolean {
    const moved = this.sql.exec(
      "UPDATE parent_children SET resolved = 1 WHERE parent_id = ? AND substream_id = ? AND resolved = 0 RETURNING substream_id",
      this.parentId, substreamId,
    ).toArray().length > 0;
    if (moved) {
      this.advancePrivateChildrenVersionsFor(substreamId, now);
      this.resolutionMoved = true;
    }
    return moved;
  }

  /** One idempotent parent-owned write for manual Thread and Breakout resolution. */
  async resolveConversation(input: ConversationParentAuthorizeViewerRequest) {
    const request = ConversationParentAuthorizeViewerRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const substreamId = asSubstreamId(request.substreamId ?? "0");
    const relationship = await this.host.readRelationship(request.workspaceId, request.userId);
    const result = this.tx(() => {
      if (!this.canReadConversation(request, substreamId, relationship)) return { outcome: "forbidden" as const };
      const now = Date.now();
      // Main may still be implicit on an older parent, as childRegistry permits.
      if (substreamId === "0") this.registerChild("0", "main", null, now);
      const child = this.sql.exec<{ status: string; archived_at: number | null }>(
        "SELECT status, archived_at FROM parent_children WHERE parent_id = ? AND substream_id = ?",
        this.parentId, substreamId,
      ).toArray()[0];
      if (!child || child.status !== "ready") return { outcome: "not_ready" as const };
      if (this.metadataRow()?.archived_at != null || child.archived_at !== null) return { outcome: "archived" as const };
      const moved = this.markResolved(substreamId, now);
      return { outcome: moved ? "resolved" as const : "unchanged" as const };
    });
    if (result.outcome === "resolved") await this.broadcastMetadata();
    return result;
  }

  readConversationResolved(input: { workspaceId: string; parentId: string; substreamId: string }): boolean {
    const request = parseRpcInput(z.strictObject({
      workspaceId: WorkspaceIdSchema, parentId: IdSchema, substreamId: SubstreamIdSchema,
    }), input, "conversation_resolution_read");
    if (!this.metadataRow()) return false;
    this.assertParent(request.workspaceId, request.parentId);
    return first(this.sql.exec<{ resolved: number }>(
      `SELECT resolved FROM parent_children WHERE parent_id = ? AND substream_id = ?`,
      this.parentId, request.substreamId,
    ))?.resolved === 1;
  }

  /** Archive the child registry entry without deleting membership or transcript. */
  async setPrivateChildArchived(input: SetPrivateChildArchivedRequest): Promise<SetPrivateChildArchivedResult> {
    const request = SetPrivateChildArchivedRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const relationship = this.participantMigrationPhase(request.substreamId) !== null
      ? await this.host.readRelationship(request.workspaceId, request.actorUserId) : null;
    const now = Date.now();
    const result = this.tx(() => {
      const child = first(this.sql.exec<{ status: string; archived_at: number | null }>(
        `SELECT status, archived_at FROM parent_children WHERE parent_id = ? AND substream_id = ? AND kind = 'child'`,
        this.parentId, request.substreamId,
      ));
      if (!child || child.status !== "ready") throw new Error("private_child_not_ready");
      if (this.metadataRow()?.archived_at != null) throw new Error("workstream_archived");
      if (this.participantMigrationPhase(request.substreamId) !== null) {
        if (!this.migratedConversationAccess({ ...request, userId: request.actorUserId },
          request.substreamId, relationship).allowed) throw new Error("private_child_participant_required");
      } else {
        const actor = first(this.sql.exec<{ active: number }>(
          `SELECT active FROM parent_breakout_members WHERE parent_id = ? AND substream_id = ? AND user_id = ?`,
          this.parentId, request.substreamId, request.actorUserId,
        ));
        if (actor?.active !== 1) throw new Error("private_child_participant_required");
      }
      if ((child.archived_at !== null) === request.archived) {
        return { outcome: "unchanged" as const, archivedAt: child.archived_at };
      }
      const archivedAt = request.archived ? now : null;
      this.sql.exec(
        `UPDATE parent_children SET archived_at = ?, updated_at = ?, lifecycle_version = lifecycle_version + 1,
           lifecycle_not_before = 0 WHERE parent_id = ? AND substream_id = ?`,
        archivedAt, now, this.parentId, request.substreamId,
      );
      this.advancePrivateChildrenVersionsFor(request.substreamId, now);
      return { outcome: request.archived ? "archived" as const : "restored" as const, archivedAt };
    });
    await this.host.armNextAlarm();
    await this.drainPrivateChildLifecycleEffects();
    if (result.outcome !== "unchanged") await this.broadcastMetadata();
    return SetPrivateChildArchivedResultSchema.parse(result);
  }

  async drainPrivateChildLifecycleEffects(): Promise<void> {
    const identity = this.parentIdentity();
    if (!identity) return;
    const rows = this.sql.exec<{ substream_id: string; archived_at: number | null; lifecycle_version: number }>(
      `SELECT substream_id, archived_at, lifecycle_version FROM parent_children
        WHERE parent_id = ? AND lifecycle_version > lifecycle_delivered_version AND lifecycle_not_before <= ?`,
      this.parentId, Date.now(),
    ).toArray();
    for (const row of rows) {
      try {
        const child = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS,
          identity.workspaceId, conversationObjectName(this.env.AVALON_REGION,
            identity.workspaceId, identity.parentId, asSubstreamId(row.substream_id)));
        await child.applyPrivateChildLifecycle({ workspaceId: identity.workspaceId,
          parentId: identity.parentId, substreamId: row.substream_id,
          version: row.lifecycle_version, archivedAt: row.archived_at });
        this.sql.exec(
          `UPDATE parent_children SET lifecycle_delivered_version = MAX(lifecycle_delivered_version, ?)
            WHERE parent_id = ? AND substream_id = ?`,
          row.lifecycle_version, this.parentId, row.substream_id,
        );
      } catch (error) {
        this.sql.exec(`UPDATE parent_children SET lifecycle_not_before = ? WHERE parent_id = ? AND substream_id = ?`,
          Date.now() + PRIVATE_CHILD_EFFECT_RETRY_MS, this.parentId, row.substream_id);
        logWarn(this.env, "private_child_lifecycle_effect_failed", {
          ...this.logFields(), substream_id: row.substream_id, error: String(error),
        });
      }
    }
  }

  private privateChildPreparation(operationId: string): PrivateChildPreparationOperation | null {
    const row = first(this.sql.exec<PrivateChildPreparationRow>(
      `SELECT preparation.operation_id, preparation.substream_id, preparation.creator_user_id,
              preparation.request_json, preparation.capture_json, preparation.completed_parts_json,
              preparation.prepared_context_json, preparation.prepared_conversation_hash,
              preparation.status, preparation.error_code, preparation.created_at, preparation.updated_at,
              child.title, COALESCE(member.version, 1) AS membership_version
         FROM parent_breakout_preparations preparation
         JOIN parent_children child
           ON child.parent_id = preparation.parent_id AND child.substream_id = preparation.substream_id
         LEFT JOIN parent_breakout_members member
           ON member.parent_id = preparation.parent_id
          AND member.substream_id = preparation.substream_id
          AND member.user_id = preparation.creator_user_id
        WHERE preparation.parent_id = ? AND preparation.operation_id = ?`,
      this.parentId, operationId,
    ));
    if (!row) return null;
    const request = BeginPrivateChildPreparationRequestSchema.parse(JSON.parse(row.request_json));
    return PrivateChildPreparationOperationSchema.parse({
      operationId: row.operation_id,
      substreamId: row.substream_id,
      creatorUserId: row.creator_user_id,
      title: row.title,
      sourceSubstreamId: request.sourceSubstreamId,
      sourceThroughTurnId: request.sourceThroughTurnId,
      recipe: request.recipe,
      status: row.status,
      preparedConversationHash: row.prepared_conversation_hash,
      capture: row.capture_json ? JSON.parse(row.capture_json) : null,
      completedParts: JSON.parse(row.completed_parts_json),
      preparedContext: row.prepared_context_json ? JSON.parse(row.prepared_context_json) : null,
      errorCode: row.error_code,
      membershipVersion: row.membership_version,
      membershipInitializer: request.membershipInitializer,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private requirePrivateChildPreparation(operationId: string): PrivateChildPreparationOperation {
    const operation = this.privateChildPreparation(operationId);
    if (!operation) throw new Error("private_child_preparation_not_found");
    return operation;
  }

  async addPrivateChildParticipant(input: MutatePrivateChildParticipantRequest): Promise<MutatePrivateChildParticipantResult> {
    return this.mutatePrivateChildParticipant(input, true);
  }

  async removePrivateChildParticipant(input: MutatePrivateChildParticipantRequest): Promise<MutatePrivateChildParticipantResult> {
    return this.mutatePrivateChildParticipant(input, false);
  }

  private async mutatePrivateChildParticipant(
    input: MutatePrivateChildParticipantRequest,
    active: boolean,
  ): Promise<MutatePrivateChildParticipantResult> {
    const request = MutatePrivateChildParticipantRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const migration = this.participantMigrationPhase(request.substreamId);
    if (migration) {
      if (migration !== "complete") throw new Error("participant_migration_pending");
      const operationId = await stableUuid(["legacy-child-participant", request.operationId]);
      const result = await this.mutateParticipantGrant({ operationId, actorUserId: request.actorUserId, userId: request.userId,
        target: { kind: "conversation", workspaceId: request.workspaceId, parentId: request.parentId, substreamId: request.substreamId },
        active });
      if (result.status === "denied") {
        if (result.reason === "participant_required") throw new Error("private_child_last_participant");
        throw new Error(result.reason === "migration_pending" ? "participant_migration_pending" : "private_child_participant_required");
      }
      if (result.status !== "committed") throw new Error("participant_grant_conflict");
      return { outcome: active ? "added" : "removed", membershipVersion: result.grant.revision };
    }
    // A breakout's roster is its own; a guest is shared the breakout instead.
    if (active && (await this.host.readRelationship(request.workspaceId, request.userId))?.accessClass !== "member") {
      throw new Error("private_child_guest_requires_share");
    }
    const now = Date.now();
    const result = this.tx(() => {
      const child = first(this.sql.exec<{ status: string; archived_at: number | null }>(
        `SELECT status, archived_at FROM parent_children WHERE parent_id = ? AND substream_id = ? AND kind = 'child'`,
        this.parentId, request.substreamId,
      ));
      if (!child || child.status !== "ready") throw new Error("private_child_not_ready");
      if (this.metadataRow()?.archived_at != null) throw new Error("workstream_archived");
      if (child.archived_at !== null) throw new Error("private_child_archived");
      const actor = first(this.sql.exec<{ active: number }>(
        `SELECT active FROM parent_breakout_members WHERE parent_id = ? AND substream_id = ? AND user_id = ?`,
        this.parentId, request.substreamId, request.actorUserId,
      ));
      if (actor?.active !== 1) throw new Error("private_child_participant_required");
      const replay = first(this.sql.exec<PrivateChildMembershipEffectRow>(
        `SELECT operation_id, substream_id, user_id, actor_user_id, active, membership_version
           FROM parent_breakout_member_effects WHERE parent_id = ? AND operation_id = ?`,
        this.parentId, request.operationId,
      ));
      if (replay) {
        if (replay.substream_id !== request.substreamId || replay.user_id !== request.userId
          || replay.actor_user_id !== request.actorUserId || replay.active !== Number(active)) {
          throw new Error("private_child_membership_operation_conflict");
        }
        return { outcome: "unchanged" as const, membershipVersion: replay.membership_version };
      }
      const current = first(this.sql.exec<{ active: number; version: number }>(
        `SELECT active, version FROM parent_breakout_members WHERE parent_id = ? AND substream_id = ? AND user_id = ?`,
        this.parentId, request.substreamId, request.userId,
      ));
      if (!active && !current) {
        this.insertPrivateChildMembershipEffect({ operationId: request.operationId, substreamId: request.substreamId,
          userId: request.userId, actorUserId: request.actorUserId, active, membershipVersion: 1, now, state: "delivered" });
        return { outcome: "not_found" as const, membershipVersion: 1 };
      }
      if (current?.active === Number(active)) {
        this.insertPrivateChildMembershipEffect({ operationId: request.operationId, substreamId: request.substreamId,
          userId: request.userId, actorUserId: request.actorUserId, active, membershipVersion: current.version, now,
          state: "delivered" });
        return { outcome: "unchanged" as const, membershipVersion: current.version };
      }
      if (!active) {
        const remaining = first(this.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM parent_breakout_members WHERE parent_id = ? AND substream_id = ? AND active = 1`,
          this.parentId, request.substreamId,
        ))?.count ?? 0;
        if (remaining <= 1) throw new Error("private_child_last_participant");
      }
      const version = (current?.version ?? 0) + 1;
      this.sql.exec(
        `INSERT INTO parent_breakout_members
           (parent_id, substream_id, user_id, active, version, added_by_user_id, added_at, removed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(parent_id, substream_id, user_id) DO UPDATE SET
           active = excluded.active, version = excluded.version,
           added_by_user_id = CASE WHEN excluded.active = 1 THEN excluded.added_by_user_id
                                   ELSE parent_breakout_members.added_by_user_id END,
           added_at = CASE WHEN excluded.active = 1 THEN excluded.added_at ELSE parent_breakout_members.added_at END,
           removed_at = excluded.removed_at, updated_at = excluded.updated_at`,
        this.parentId, request.substreamId, request.userId, Number(active), version, request.actorUserId,
        now, active ? null : now, now,
      );
      this.insertPrivateChildMembershipEffect({ operationId: request.operationId, substreamId: request.substreamId,
        userId: request.userId, actorUserId: request.actorUserId, active, membershipVersion: version, now });
      return { outcome: active ? "added" as const : "removed" as const, membershipVersion: version };
    });
    await this.host.armNextAlarm();
    await this.drainPrivateChildMembershipEffects(request.substreamId);
    this.advancePrivateChildrenVersion(request.userId, Date.now());
    await this.broadcastMetadata();
    return MutatePrivateChildParticipantResultSchema.parse(result);
  }

  private insertPrivateChildMembershipEffect(input: {
    operationId: string; substreamId: string; userId: string; actorUserId: string;
    active: boolean; membershipVersion: number; now: number; state?: "pending" | "delivered";
  }): void {
    this.sql.exec(
      `INSERT INTO parent_breakout_member_effects
         (parent_id, operation_id, substream_id, user_id, actor_user_id, active,
          membership_version, state, attempts, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      this.parentId, input.operationId, input.substreamId, input.userId, input.actorUserId,
      Number(input.active), input.membershipVersion, input.state ?? "pending", input.now, input.now,
    );
  }

  async drainPrivateChildMembershipEffects(substreamId?: string): Promise<void> {
    const rows = this.sql.exec<PrivateChildMembershipEffectRow>(
      `SELECT effect.operation_id, effect.substream_id, effect.user_id, effect.actor_user_id,
              effect.active, effect.membership_version
         FROM parent_breakout_member_effects effect
         JOIN parent_children child ON child.parent_id = effect.parent_id AND child.substream_id = effect.substream_id
        WHERE effect.parent_id = ? AND effect.state IN ('pending', 'inflight') AND effect.not_before <= ?
          AND NOT EXISTS(SELECT 1 FROM parent_participant_migrations migration
                          WHERE migration.parent_id = effect.parent_id AND migration.substream_id = effect.substream_id)
          AND (${substreamId ? "effect.substream_id = ?" : "child.status = 'ready'"})
        ORDER BY effect.created_at, effect.operation_id LIMIT 25`,
      ...(substreamId ? [this.parentId, Date.now(), substreamId] : [this.parentId, Date.now()]),
    ).toArray();
    for (const row of rows) {
      try {
        const identity = this.parentIdentity();
        if (!identity) throw new Error("conversation_parent_missing");
        const stub = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, identity.workspaceId,
          conversationObjectName(this.env.AVALON_REGION, identity.workspaceId, identity.parentId, asSubstreamId(row.substream_id)));
        await stub.applyPrivateChildMembership({
          workspaceId: identity.workspaceId, parentId: identity.parentId, substreamId: row.substream_id,
          userId: row.user_id, actorUserId: row.actor_user_id, active: row.active === 1,
          membershipVersion: row.membership_version,
        });
        this.sql.exec(
          `UPDATE parent_breakout_member_effects SET state = 'delivered'
            WHERE parent_id = ? AND operation_id = ? AND membership_version = ?`,
          this.parentId, row.operation_id, row.membership_version,
        );
      } catch (error) {
        const retryAt = Date.now() + PRIVATE_CHILD_EFFECT_RETRY_MS;
        this.sql.exec(
          `UPDATE parent_breakout_member_effects SET state = 'pending', attempts = attempts + 1, not_before = ?
            WHERE parent_id = ? AND operation_id = ? AND membership_version = ?`,
          retryAt, this.parentId, row.operation_id, row.membership_version,
        );
        logWarn(this.env, "private_child_membership_effect_failed", {
          ...this.logFields(), operation_id: row.operation_id, substream_id: row.substream_id, user_id: row.user_id,
          membership_version: row.membership_version, retry_at: new Date(retryAt).toISOString(),
          reason: error instanceof Error ? error.message : "unknown",
        });
        throw error;
      }
    }
  }

  private visiblePrivateChildrenForUser(userId: string): ListVisiblePrivateChildrenResult["children"] {
    return visiblePrivateChildren(this.sql, userId, [this.parentId]).get(this.parentId) ?? [];
  }

  private advancePrivateChildrenVersion(userId: string, now: number): void {
    if (this.advanceLocalStateVersion(`children:${userId}`, this.visiblePrivateChildrenForUser(userId), now)) {
      this.childrenMovedFor.add(userId);
    }
  }

  private advancePrivateChildrenVersionsFor(substreamId: string, now: number): void {
    for (const row of this.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM parent_breakout_members WHERE parent_id = ? AND substream_id = ? AND active = 1`,
      this.parentId, substreamId,
    ).toArray()) {
      this.advancePrivateChildrenVersion(row.user_id, now);
    }
  }

  // ---------------------------------------------------------------------------
  // After a batch of child effects: archive enforcement and the control socket.
  // ---------------------------------------------------------------------------

  async afterChildEffects(): Promise<void> {
    const row = this.metadataRow();
    if (row?.archived_at != null) {
      // The durable archive is the retry authority. Every owned worker uses
      // this same parent; a shared Sidekick has a different one.
      for (const child of this.childRegistry()) {
        const stub = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS,
          row.workspace_id, conversationObjectName(this.env.AVALON_REGION, asWorkspaceId(row.workspace_id),
            this.parentId, asSubstreamId(child.substreamId)));
        await stub.stopOwnedAgent();
      }
    }
    await this.broadcastMetadata();
  }

  // ---------------------------------------------------------------------------
  // The Channel control socket.
  // ---------------------------------------------------------------------------

  /** Whether one person may currently read this Channel's Main; archived Channels answer no. */
  canRead(userId: string): boolean {
    const row = this.metadataRow();
    if (!row || row.archived_at !== null) return false;
    if (row.scope === "workspace") return true;
    return this.isParticipant(userId);
  }

  async acceptSocket(request: Request): Promise<Response> {
    if (!this.role.admitsClientSockets) return json({ error: `${this.role.kind}_socket_refused` }, 403);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    const identity = ControlSocketIdentitySchema.safeParse({
      workspaceId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSPACE_ID) ?? null,
      workstreamId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSTREAM_ID) ?? null,
      userId: readRallyHeader(request.headers, RALLY_HEADERS.USER_ID) ?? null,
      sessionId: readRallyHeader(request.headers, RALLY_HEADERS.SESSION_ID) ?? null,
      ticketId: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_ID) ?? null,
      ticketExpiresAt: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_EXPIRES_AT) ?? null,
    });
    if (!identity.success) return json({ error: "invalid_socket_identity" }, 400);
    const metadata = this.metadataRow();
    if (!metadata || metadata.workspace_id !== identity.data.workspaceId || metadata.parent_id !== identity.data.workstreamId) {
      return json({ error: "workstream_identity_mismatch" }, 409);
    }
    if (!this.consumeSocketTicket(identity.data)) return json({ error: "socket_ticket_replayed" }, 401);
    const auth = await this.sessionAuth(identity.data);
    if (!auth || !this.canRead(identity.data.userId)) return json({ error: "forbidden" }, 403);
    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) return json({ error: "websocket_unavailable" }, 500);
    const attachment: ControlSocketAttachment = {
      ...identity.data,
      role: "parent_control",
      connectionId: uuidV7(),
      connectedAt: new Date().toISOString(),
      subscribed: false,
    };
    this.host.acceptControlSocket(server, this.parentId, attachment.userId);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Ticket claims carry epoch seconds; object SQL stores unix-ms. */
  private consumeSocketTicket(identity: ControlSocketIdentity): boolean {
    const now = Date.now();
    const expiresAtMs = identity.ticketExpiresAt * 1_000;
    if (expiresAtMs <= now) return false;
    return this.tx(() => {
      this.sql.exec(`DELETE FROM workspace_socket_ticket_receipts WHERE expires_at < ?`, now - 300_000);
      return this.sql.exec<{ ticket_id: string }>(
        `INSERT OR IGNORE INTO workspace_socket_ticket_receipts (ticket_id, user_id, expires_at, consumed_at)
         VALUES (?, ?, ?, ?) RETURNING ticket_id`,
        identity.ticketId, identity.userId, expiresAtMs, now,
      ).toArray().length === 1;
    });
  }

  private async sessionAuth(
    identity: Pick<ControlSocketIdentity, "sessionId" | "userId" | "workspaceId">,
  ): Promise<AuthContext | null> {
    const role = this.env.APP_ENV === "development"
      && this.env.RALLY_DEV_AUTH === "true"
      && identity.sessionId === "development"
      ? await this.env.DB.prepare(
        `SELECT member.role FROM workspace_members member
          JOIN workspaces workspace ON workspace.id = member.workspace_id
         WHERE member.workspace_id = ? AND member.user_id = ?
           AND member.status = 'active' AND workspace.region = ?
           AND workspace.abandoned_at IS NULL`,
      ).bind(identity.workspaceId, identity.userId, this.env.AVALON_REGION)
        .first<{ role: AuthContext["role"] }>()
      : await this.env.DB.prepare(
        `SELECT member.role FROM sessions session
          JOIN workspace_members member
            ON member.workspace_id = session.workspace_id
           AND member.user_id = session.user_id AND member.incarnation = session.workspace_incarnation AND member.status = 'active'
          JOIN workspaces workspace ON workspace.id = session.workspace_id
         WHERE session.id = ? AND session.user_id = ? AND session.workspace_id = ?
           AND session.region = ? AND session.revoked_at IS NULL
           AND session.expires_at > ? AND workspace.region = ?
           AND workspace.abandoned_at IS NULL`,
      ).bind(
        identity.sessionId, identity.userId, identity.workspaceId, this.env.AVALON_REGION,
        new Date().toISOString(), this.env.AVALON_REGION,
      ).first<{ role: AuthContext["role"] }>();
    return role ? {
      sessionId: identity.sessionId, userId: identity.userId, workspaceId: identity.workspaceId,
      region: this.env.AVALON_REGION, role: role.role,
    } : null;
  }

  async onSocketMessage(socket: WebSocket, attachment: ControlSocketAttachment, message: ArrayBuffer | string): Promise<void> {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      socket.close(1008, "Work-stream control events must be JSON");
      return;
    }
    if (isUnknownSocketEvent(decoded, WorkstreamControlSocketClientEventSchema.shape.type)) return;
    const parsed = safeParseSocketEvent(WorkstreamControlSocketClientEventSchema, decoded);
    if (!parsed.success) {
      socket.close(1008, "Invalid work-stream control event");
      return;
    }
    const auth = await this.sessionAuth(attachment);
    if (!auth || !this.canRead(attachment.userId)) {
      socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
      return;
    }
    const metadata = this.metadataForUser(attachment.userId);
    if (!metadata) {
      socket.close(1011, "Work-stream metadata is not initialized");
      return;
    }
    socket.serializeAttachment({ ...attachment, subscribed: true } satisfies ControlSocketAttachment);
    socket.send(workstreamControlPayload({ type: "workstream_metadata", occurredAt: new Date().toISOString(), metadata }));
  }

  private stateVersionForUser(row: ParentMetadataRow, userId: string) {
    const common = this.latestStateRow("common");
    if (!common) throw new Error("workstream_common_state_missing");
    const viewer = this.latestStateRow(`user:${userId}`);
    return {
      commonEventId: common.event_id,
      viewerEventId: viewer?.event_id ?? null,
      authorityGeneration: row.authority_generation,
      commonWaterline: common.waterline,
      viewerWaterline: viewer?.waterline ?? 0,
    };
  }

  private backgroundAgentCounts(visibleRoots: ReadonlySet<string>): {
    backgroundAgentCount: number; backgroundAgentCounts: Record<string, number>;
  } {
    const counts = runningBackgroundAgents(this.sql, [this.parentId]).get(this.parentId) ?? new Map<string, number>();
    return {
      backgroundAgentCount: [...counts.values()].reduce((total, n) => total + n, 0),
      backgroundAgentCounts: visibleBackgroundAgentCounts(counts, visibleRoots),
    };
  }

  private metadataForUser(userId: string): WorkstreamControlMetadata | null {
    const row = this.metadataRow();
    if (!row) return null;
    const viewer = this.userProjection(userId);
    const readThrough = viewer?.seenAttentionOrdinal ?? row.unread_tracking_start_ordinal;
    const nextPendingWakeup = row.next_wakeup_due_at && row.next_wakeup_prompt
      ? { dueAt: iso(row.next_wakeup_due_at), promptPreview: promptPreview(row.next_wakeup_prompt) }
      : null;
    const privateChildren = this.visiblePrivateChildrenForUser(userId);
    return WorkstreamControlMetadataSchema.parse({
      stateVersion: this.stateVersionForUser(row, userId),
      privateChildrenWaterline: this.latestStateRow(`children:${userId}`)?.waterline ?? 0,
      revision: row.revision,
      id: row.parent_id,
      workspaceId: row.workspace_id,
      title: row.title,
      appearance: this.mainCommonProjection()?.appearance,
      description: row.description,
      preview: row.preview,
      emailAddress: row.email_address,
      createdByUserId: row.created_by_user_id,
      titleStatus: row.title_status,
      exactState: row.exact_state,
      harnessStatus: harnessStatus(row.exact_state),
      ...this.backgroundAgentCounts(new Set(["0", ...privateChildren.map((child) => child.substreamId)])),
      latestAttentionSequenceNumber: row.latest_attention_ordinal,
      unreadTrackingStartSequenceNumber: row.unread_tracking_start_ordinal,
      lastActivityAt: iso(row.last_activity_at),
      completedAt: iso(row.completed_at),
      archivedAt: iso(row.archived_at),
      createdAt: iso(row.source_created_at),
      updatedAt: iso(row.source_updated_at),
      scope: row.scope,
      systemKind: row.system_kind,
      nextPendingWakeup,
      nextTerminalActionAt: iso(row.next_terminal_action_at),
      privateChildren: privateChildren.map(({ lastActivityAt, ...child }) => ({
        ...child, createdAt: iso(child.createdAt), updatedAt: iso(child.updatedAt),
        ...(lastActivityAt === undefined ? {} : { lastActivityAt: iso(lastActivityAt) }),
      })),
      viewer: {
        isParticipant: viewer?.isParticipant ?? false,
        listable: row.archived_at === null
          && (row.scope === "workspace" || viewer?.isParticipant === true)
          && (viewer?.listable ?? true),
        unreadCount: viewer?.unreadCount ?? 0,
        youAreMentioned: viewer?.youAreMentioned ?? false,
        unseen: viewer?.unseen ?? false,
        readThroughSequenceNumber: readThrough,
        manualUnreadFromSequenceNumber: viewer?.manualUnreadFromOrdinal ?? null,
        manualUnreadGeneration: viewer?.manualUnreadGeneration ?? 0,
        latestMentionSequenceNumber: viewer?.latestMentionAttentionOrdinal ?? 0,
      },
    });
  }

  /**
   * Push the current metadata to every subscribed control socket, closing any
   * whose reader can no longer read this Channel. Object-local: whether a
   * person may still read is answered from these rows alone.
   */
  async broadcastMetadata(): Promise<void> {
    await this.publishChannelRow();
    const sockets = this.host.controlSockets(this.parentId);
    if (sockets.length === 0) return;
    const occurredAt = new Date().toISOString();
    for (const socket of sockets) {
      const attachment = readControlSocketAttachment(socket);
      if (!attachment?.subscribed) continue;
      if (!this.canRead(attachment.userId)) {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
        continue;
      }
      const metadata = this.metadataForUser(attachment.userId);
      if (!metadata) continue;
      try {
        socket.send(workstreamControlPayload({ type: "workstream_metadata", occurredAt, metadata }));
      } catch {
        // A socket that cannot take a frame is reconnecting.
      }
    }
  }

  /**
   * Republish this Channel's workspace-socket row to whoever the change moved
   * that the directory follow-up does not already cover: a viewer whose
   * breakout list moved, or everyone when the running background agents did.
   * Main's own row changes arrive as directory rows and are published there.
   */
  private async publishChannelRow(): Promise<void> {
    if (!this.role.admitsClientSockets) return;
    const counts = JSON.stringify([...runningBackgroundAgents(this.sql, [this.parentId]).get(this.parentId) ?? []]);
    const everyone = this.resolutionMoved || (this.publishedBackgroundAgents !== null && counts !== this.publishedBackgroundAgents);
    this.resolutionMoved = false;
    this.publishedBackgroundAgents = counts;
    const users = [...this.childrenMovedFor];
    this.childrenMovedFor.clear();
    if (everyone) await this.host.publishChannelRow(this.parentId);
    else for (const userId of users) await this.host.publishChannelRow(this.parentId, userId);
  }

  /** Drop the sockets this parent can no longer admit, and say whose they were. */
  async revokeNarrowedAudienceAccess(input: { workspaceId: string; parentId: string }): Promise<{ closedUserIds: string[] }> {
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema }),
      input, "workstream_audience_narrowed");
    this.assertParent(request.workspaceId, request.parentId);
    const holders = new Map<string, Array<{ socket: WebSocket; attachment: ControlSocketAttachment }>>();
    for (const socket of this.host.controlSockets(this.parentId)) {
      const attachment = readControlSocketAttachment(socket);
      if (!attachment) continue;
      holders.set(attachment.userId, [...holders.get(attachment.userId) ?? [], { socket, attachment }]);
    }
    const closedUserIds: string[] = [];
    for (const [userId, sockets] of holders) {
      const viewer = await this.authorizeViewer({
        workspaceId: asWorkspaceId(request.workspaceId), parentId: request.parentId, userId: UserIdSchema.parse(userId),
      });
      if (viewer.authorized) continue;
      closedUserIds.push(userId);
      for (const held of sockets) closeRevoked(held.socket, held.attachment);
    }
    return { closedUserIds };
  }

  /** Close this parent's sockets for lost access, and name the conversations the revocation continues to. */
  async revokeSocketAccess(revocation: SocketAccessRevocation): Promise<{ substreamIds: string[] }> {
    const request = SocketAccessRevocationSchema.parse(revocation);
    for (const socket of this.host.controlSockets(this.parentId)) {
      const attachment = readControlSocketAttachment(socket);
      if (!attachment || !(await revocationClosesSession(this.env, request, attachment))) continue;
      closeRevoked(socket, attachment);
    }
    const identity = this.metadataRow();
    if (!identity) return { substreamIds: [] };
    const substreamIds = [...new Set([
      ...this.childRegistry().map((child) => child.substreamId),
      ...this.sql.exec<{ substream_id: string }>(
        `SELECT substream_id FROM parent_child_projections WHERE parent_id = ? ORDER BY substream_id`, this.parentId,
      ).toArray().map((row) => row.substream_id),
    ])];
    if (request.reason !== "workstream_participant_removed") return { substreamIds };
    // Losing this Channel is not losing a breakout, whose roster is its own.
    const relationship = await this.host.readRelationship(request.workspaceId, request.userId);
    const address = { workspaceId: request.workspaceId, parentId: this.parentId, userId: UserIdSchema.parse(request.userId) };
    const facts = this.conversationReadFacts(address);
    return { substreamIds: substreamIds.filter((substreamId) => substreamId === "0"
      || !this.canReadConversation(address, asSubstreamId(substreamId), relationship, facts)) };
  }

  /** Every child this parent knows about, for the retirement walk. */
  childrenForRetirement(): { substreamId: string; kind: "main" | "child"; createdAt: number }[] {
    return this.childRegistry();
  }

  /** Whether a pending breakout lifecycle or membership delivery is due for this parent. */
  static dueParentIds(sql: SqlStorage, now: number): string[] {
    return [...new Set([
      ...sql.exec<{ parent_id: string }>(
        `SELECT DISTINCT parent_id FROM parent_children
          WHERE lifecycle_version > lifecycle_delivered_version AND lifecycle_not_before <= ?`, now,
      ).toArray().map((row) => row.parent_id),
      ...sql.exec<{ parent_id: string }>(
        `SELECT DISTINCT effect.parent_id FROM parent_breakout_member_effects effect
           JOIN parent_children child ON child.parent_id = effect.parent_id AND child.substream_id = effect.substream_id
          WHERE effect.state IN ('pending', 'inflight') AND effect.not_before <= ? AND child.status = 'ready'
            AND NOT EXISTS(SELECT 1 FROM parent_participant_migrations migration
                            WHERE migration.parent_id = effect.parent_id AND migration.substream_id = effect.substream_id)`,
        now,
      ).toArray().map((row) => row.parent_id),
    ])];
  }

  /** The earliest time any hosted parent has breakout work due. */
  static nextDueAt(sql: SqlStorage): number | null {
    const lifecycle = sql.exec<{ due_at: number | null }>(
      `SELECT MIN(lifecycle_not_before) AS due_at FROM parent_children WHERE lifecycle_version > lifecycle_delivered_version`,
    ).toArray()[0]?.due_at ?? null;
    const membership = sql.exec<{ due_at: number | null }>(
      `SELECT MIN(effect.not_before) AS due_at FROM parent_breakout_member_effects effect
         JOIN parent_children child ON child.parent_id = effect.parent_id AND child.substream_id = effect.substream_id
        WHERE effect.state IN ('pending', 'inflight') AND child.status = 'ready'
          AND NOT EXISTS(SELECT 1 FROM parent_participant_migrations migration
                          WHERE migration.parent_id = effect.parent_id AND migration.substream_id = effect.substream_id)`,
    ).toArray()[0]?.due_at ?? null;
    const candidates = [lifecycle, membership].filter((due): due is number => due !== null);
    return candidates.length ? Math.min(...candidates) : null;
  }
}

function closeRevoked(socket: WebSocket, attachment: ControlSocketAttachment): void {
  try {
    socket.serializeAttachment({ ...attachment, subscribed: false } satisfies ControlSocketAttachment);
  } catch {
    // An unreadable attachment already fails the broadcast filter.
  }
  try {
    socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
  } catch {
    // Already closing; the runtime owns the rest of the teardown.
  }
}

/** Parse the parent effects a hosted parent put in its outbox. */
export function parseParentOutboxEnvelope(payloadJson: string): ParentEffectEnvelope {
  return ParentEffectEnvelopeSchema.parse(JSON.parse(payloadJson));
}

/** Guard an envelope's effect against the parent effect union; kept for the drain's own checks. */
export const HostedParentEffectSchema = ParentEffectSchema;

/**
 * The only form a breakout's own activity event leaves its parent in. Anything
 * else reaching here is a forwarding bug, and passing it on whole would carry
 * the breakout's text into the shared log, so it throws instead.
 */
function breakoutActivity(effect: ConversationEffect, substreamId: string): ConversationEffect {
  if (effect.kind !== "activity_event") return effect;
  const emptied = breakoutMessageActivity(effect, substreamId);
  if (emptied === null) throw new Error("breakout_activity_not_forwardable");
  return emptied;
}
