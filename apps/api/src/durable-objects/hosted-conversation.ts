import { isPersonNotificationEffect, type ConversationEffectEnvelope } from "@rally/contracts/conversation-effects";
import {
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
  type ConversationParentAuthorityRequest,
  type ConversationParentAuthorityResult,
  type ConversationParentAuthorizeViewerRequest,
  type ConversationParentAuthorizeViewerResult,
  type ConversationParentListChildrenRequest,
  type ConversationParentListChildrenResult,
  type ConversationParentReserveChildRequest,
  type ConversationParentReserveChildResult,
  type ConversationParentTerminalDeadlinesRequest,
  type ConversationParentTerminalDeadlinesResult,
} from "@rally/contracts/conversation-parent";

import type { WorkspaceRelationship } from "@rally/contracts/scope-grants";

import type { Env } from "../env";
import type { ApiError } from "../lib/api-error";
import { parseRpcInput } from "../lib/rpc-input";
import { logWarn } from "../observability/logger";
import { ReceiveChildEffectsRequestSchema, type DirectoryCommonEffect, type ReceiveChildEffectsRequest } from "./conversation-parent-object";
import { recordPersonNotificationIntent, type PersonNotificationEnvelope } from "./workspace-notification-intent-storage";

/** What one batch of a conversation's effects left for the consumer to do. */
export interface ReceivedChildEffects {
  accepted: { messageId: string; payloadHash: string }[];
  /**
   * The intent of every mention or add the batch carried, new or replayed,
   * for the consumer to deliver. A replay names it again because the
   * delivery, not the record, is what a redelivery may still owe: a Slack
   * send that failed transiently gets its second attempt this way.
   */
  notificationIntentIds: string[];
}

// The same replay window `SidekickDO` kept: a fence, not history.
const CHILD_EFFECT_RECEIPT_RETENTION_MS = 180 * 24 * 60 * 60_000;

/** The kinds of parent this primitive hosts: a Sidekick (`automation`, its wire name) and a Canvas. */
export type HostedConversationKind = "automation" | "canvas";

/** What the parent's own row says, as the contract needs it. */
export interface HostedConversationIdentity {
  workspaceId: string;
  authorityGeneration: number;
  /** Archived: readers are admitted, a new child is refused. */
  archived: boolean;
}

/** The newest common projection a child had before this one, the fields a parent reacts to. */
export interface PriorChildProjection {
  state: string;
  archivedAt: string | null;
  backgroundAgent: boolean;
  latestAttentionOrdinal: number | null;
}

/** What a hosted conversation needs from the Organization object that holds it. */
export interface HostedConversationHost {
  env: Env;
  storage: DurableObjectStorage;
  readRelationship(workspaceId: string, userId: string): Promise<WorkspaceRelationship | null>;
  /**
   * An Activity row was written for this person, inside the caller's
   * transaction: their Activity list's waterline moves and it is sent to them
   * after the write (`docs/activity.md`).
   */
  noteActivityChanged(userId: string): void;
  /**
   * A read report for this person on this parent was accepted, inside its
   * transaction, whether or not the cursor moved: Activity derives seen from
   * the report's time as well as its cursor (`docs/activity.md`).
   */
  noteActivityReadMoved(userId: string, parentId: string): void;
}

type DirectoryUserEffect = Extract<ConversationEffectEnvelope["effect"], { kind: "directory_user" }>;

function first<T extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<T>): T | null {
  return cursor.toArray()[0] ?? null;
}

/**
 * A hosted conversation: a parent whose conversations live in conversation
 * objects and whose parent state lives in `WorkspaceDO`, keyed by its id.
 * Substream `"0"` is its shared conversation and any other substream a child
 * (a Sidekick's run, a background agent). It owns the conversation-parent
 * contract — authority, the viewer check, child reservation and registry,
 * the children's effects, and each reader's read of `"0"` — over four tables
 * keyed by the parent id in their `sidekick_id` column: `sidekick_children`,
 * `sidekick_child_projections`, `sidekick_child_receipts` and
 * `sidekick_viewer_reads`. The column keeps its name because released
 * migrations created it; every parent kind this hosts shares the tables.
 *
 * A Sidekick extends it with its definition, triggers and runs
 * (`HostedSidekick`); a Canvas with its directory row and audience
 * (`HostedCanvas`). `docs/hosted-conversation-parents.md` owns the mechanism.
 */
export abstract class HostedConversation<Host extends HostedConversationHost = HostedConversationHost> {
  constructor(
    protected readonly host: Host,
    readonly parentId: string,
    readonly parentKind: HostedConversationKind,
  ) {}

  protected get env(): Env {
    return this.host.env;
  }

  protected get storage(): DurableObjectStorage {
    return this.host.storage;
  }

  protected get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  /** The noun this parent's failure codes start with (`<noun>_missing`, `<noun>_effect_…`). */
  protected abstract readonly codeNoun: string;

  /** The parent's own row as the contract reads it; null when there is none. */
  protected abstract identity(): HostedConversationIdentity | null;

  /** Whether this viewer reads the parent's conversations. Called only for a parent that exists and is not archived. */
  protected abstract admitsViewer(request: ConversationParentAuthorizeViewerRequest): boolean | Promise<boolean>;

  /** Refuse an id or Organization that is not this parent's, the way the parent's own reads refuse it. */
  protected abstract assertParent(workspaceId: string, parentId: string): HostedConversationIdentity;

  /** One reader's read of `"0"` moved: their sidebar row is republished to them. */
  protected abstract onViewerReadChanged(userId: string): void;

  /** A child's newer common projection was stored; the parent's own reaction to it, in the same transaction. */
  protected abstract onChildProjection(substreamId: string, effect: DirectoryCommonEffect,
    prior: PriorChildProjection | null, now: number): void;

  protected logFields(): Record<string, unknown> {
    return { workspace_id: this.identity()?.workspaceId ?? null, parent_id: this.parentId, parent_kind: this.parentKind };
  }

  /**
   * The conversation-parent viewer check. A guest asks with
   * `requireGrantAuthority`; the parent's own rule decides what that admits.
   */
  async authorizeViewer(input: ConversationParentAuthorizeViewerRequest): Promise<ConversationParentAuthorizeViewerResult> {
    const request = parseRpcInput(ConversationParentAuthorizeViewerRequestSchema, input, "authorize_viewer");
    const identity = this.identity();
    if (!identity || identity.archived) {
      return ConversationParentAuthorizeViewerResultSchema.parse({ authorized: false, archived: true });
    }
    this.assertParent(request.workspaceId, request.parentId);
    return ConversationParentAuthorizeViewerResultSchema.parse({ authorized: await this.admitsViewer(request), archived: false });
  }

  authorizationDiscoveryChildren(input: ConversationParentAuthorityRequest): { substreamIds: string[] } {
    const request = parseRpcInput(ConversationParentAuthorityRequestSchema, input, "authorization_discovery_children");
    const identity = this.identity();
    if (!identity || identity.archived) return { substreamIds: [] };
    this.assertParent(request.workspaceId, request.parentId);
    // A registered, unprovisioned child is unresolved authority, not evidence
    // that its content can be discarded.
    return { substreamIds: this.childRegistry().map((child) => child.substreamId) };
  }

  authority(input: ConversationParentAuthorityRequest): ConversationParentAuthorityResult {
    const request = parseRpcInput(ConversationParentAuthorityRequestSchema, input, "authority");
    const identity = this.identity();
    if (!identity) return ConversationParentAuthorityResultSchema.parse({ exists: false, authorityGeneration: 0, archived: false });
    this.assertParent(request.workspaceId, request.parentId);
    return ConversationParentAuthorityResultSchema.parse({
      exists: true, authorityGeneration: identity.authorityGeneration, archived: identity.archived,
    });
  }

  /** Reserve against current parent authority without a caller-side preflight call. */
  reserveAgentChild(input: Omit<ConversationParentReserveChildRequest, "authorityGeneration" | "directory" | "kind">): ConversationParentReserveChildResult {
    const request = parseRpcInput(AgentChildReservationSchema, input, "reserve_agent_child");
    const identity = this.identity();
    if (!identity || identity.archived) throw new Error("workstream_archived");
    this.assertParent(request.workspaceId, request.parentId);
    this.registerChild(request.substreamId, "child", request.createdByUserId, Date.now());
    return ConversationParentReserveChildResultSchema.parse({ reserved: true, authorityGeneration: identity.authorityGeneration });
  }

  reserveChild(input: ConversationParentReserveChildRequest): ConversationParentReserveChildResult {
    const request = parseRpcInput(ConversationParentReserveChildRequestSchema, input, "reserve_child");
    const identity = this.assertParent(request.workspaceId, request.parentId);
    if (request.kind === "child" && identity.archived) throw new Error("workstream_archived");
    this.registerChild(request.substreamId, request.kind, request.createdByUserId, Date.now());
    return ConversationParentReserveChildResultSchema.parse({ reserved: true, authorityGeneration: identity.authorityGeneration });
  }

  /** The children whose own projection names a terminal action, soonest first. */
  childTerminalDeadlines(input: ConversationParentTerminalDeadlinesRequest): ConversationParentTerminalDeadlinesResult {
    const request = ConversationParentTerminalDeadlinesRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    return ConversationParentTerminalDeadlinesResultSchema.parse({
      items: this.sql.exec<{ substream_id: string; next_terminal_action_at: string }>(
        `SELECT substream_id, json_extract(effect_json, '$.nextTerminalActionAt') AS next_terminal_action_at
           FROM sidekick_child_projections
          WHERE sidekick_id = ? AND json_extract(effect_json, '$.kind') = 'directory_common'
            AND json_extract(effect_json, '$.nextTerminalActionAt') IS NOT NULL
          ORDER BY next_terminal_action_at, substream_id`,
        this.parentId,
      ).toArray().map((row) => ({ substreamId: row.substream_id, nextTerminalActionAt: row.next_terminal_action_at })),
    });
  }

  listChildren(input: ConversationParentListChildrenRequest): ConversationParentListChildrenResult {
    const request = ConversationParentListChildrenRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    return ConversationParentListChildrenResultSchema.parse({ children: this.childRegistry() });
  }

  /** The children the retirement walk closes; `missing` when no row exists. */
  childrenForRetirement(): { status: "missing" } | { status: "ok"; children: ReturnType<HostedConversation["childRegistry"]> } {
    return this.identity() ? { status: "ok", children: this.childRegistry() } : { status: "missing" };
  }

  /**
   * Apply one batch of a child's or the shared conversation's effects. Each
   * envelope is its own transaction; nothing leaves this object, and a
   * redelivery is answered by its receipt.
   */
  receiveChildEffects(input: ReceiveChildEffectsRequest): ReceivedChildEffects {
    const request = parseRpcInput(ReceiveChildEffectsRequestSchema, input, "receive_child_effects");
    // The parent's identity does not change inside a batch, so it is read
    // once; each envelope is still its own transaction.
    const identity = this.identity();
    if (!identity) throw new Error(`${this.codeNoun}_missing`);
    const accepted: { messageId: string; payloadHash: string }[] = [];
    const notificationIntentIds: string[] = [];
    for (const envelope of request.envelopes) {
      if (envelope.region !== this.env.AVALON_REGION) throw new Error("conversation_effect_region_mismatch");
      if (envelope.substreamId !== request.substreamId) throw new Error("conversation_effect_substream_mismatch");
      if (envelope.parentKind !== this.parentKind) {
        throw new Error(`${this.codeNoun}_effect_parent_kind_mismatch`);
      }
      if (identity.workspaceId !== envelope.workspaceId || this.parentId !== envelope.parentId) {
        throw new Error(`${this.codeNoun}_effect_identity_mismatch`);
      }
      const intentId = this.applyChildEnvelope(request.substreamId, envelope);
      if (intentId !== null) notificationIntentIds.push(intentId);
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    // The receipt is a replay fence, not history: past retention a
    // redelivery converges on the projection's version. Once per batch.
    const now = Date.now();
    this.sql.exec(
      `DELETE FROM sidekick_child_receipts
        WHERE (sidekick_id, substream_id, message_id) IN (
          SELECT sidekick_id, substream_id, message_id FROM sidekick_child_receipts
           WHERE received_at < ? ORDER BY received_at LIMIT 100
        )`,
      now - CHILD_EFFECT_RECEIPT_RETENTION_MS,
    );
    return { accepted, notificationIntentIds };
  }

  /**
   * Apply one envelope with its receipt, in one transaction. A mention or an
   * add is recorded as a notification intent (one per recipient: the
   * conversation sends one effect per person) and its id returned, also on a
   * replay; every other kind returns null.
   */
  private applyChildEnvelope(substreamId: string, envelope: ConversationEffectEnvelope): string | null {
    const notification = isPersonNotificationEffect(envelope.effect) ? envelope as PersonNotificationEnvelope : null;
    return this.storage.transactionSync(() => {
      const now = Date.now();
      // The receipt first: its insert is the witness that this envelope is
      // new, and a redelivery reads the hash it was first accepted with.
      const fresh = this.sql.exec(
        `INSERT INTO sidekick_child_receipts(sidekick_id, substream_id, message_id, payload_hash, received_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sidekick_id, substream_id, message_id) DO NOTHING
         RETURNING message_id`,
        this.parentId, substreamId, envelope.messageId, envelope.payloadHash, now,
      ).toArray().length === 1;
      if (!fresh) {
        const receipt = first(this.sql.exec<{ payload_hash: string }>(
          `SELECT payload_hash FROM sidekick_child_receipts WHERE sidekick_id = ? AND substream_id = ? AND message_id = ?`,
          this.parentId, substreamId, envelope.messageId,
        ));
        if (receipt?.payload_hash !== envelope.payloadHash) throw new Error("substream_effect_idempotency_conflict");
        return notification?.effect.intentId ?? null;
      }
      if (envelope.effect.kind === "directory_common") {
        const accepted = this.acceptChildProjection(substreamId, envelope, now);
        if (accepted) this.onChildProjection(substreamId, envelope.effect, accepted.prior, now);
      }
      if (envelope.effect.kind === "directory_user" && substreamId === "0") {
        this.acceptViewerRead(envelope.effect, envelope.sourceVersion, now);
      }
      // The Thread host recorded these from a `parent_effect`; a hosted
      // parent records them here, beside the receipt that fences a replay.
      return notification ? recordPersonNotificationIntent(this.storage, notification, now, (userId) => this.host.noteActivityChanged(userId)) : null;
    });
  }

  /**
   * Keep what one person has read of the shared conversation, its own
   * `directory_user` report of `member_attention`, so the sidebar row can say
   * whether they have something unread; the newest report wins. A change
   * republishes the list to that reader alone.
   */
  private acceptViewerRead(effect: DirectoryUserEffect, sourceVersion: number, now: number): void {
    const seen = effect.seenAttentionOrdinal ?? 0;
    const manual = effect.manualUnreadFromOrdinal ?? null;
    const existing = first(this.sql.exec<{ source_version: number; seen_attention_ordinal: number; manual_unread_from_ordinal: number | null }>(
      `SELECT source_version, seen_attention_ordinal, manual_unread_from_ordinal FROM sidekick_viewer_reads
        WHERE sidekick_id = ? AND user_id = ?`, this.parentId, effect.userId,
    ));
    if (existing && existing.source_version > sourceVersion) return;
    // The version always moves, so a later report older than this one is
    // dropped even when this one changed nothing the row shows.
    this.sql.exec(
      `INSERT INTO sidekick_viewer_reads
         (sidekick_id, user_id, source_version, seen_attention_ordinal, manual_unread_from_ordinal, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(sidekick_id, user_id) DO UPDATE SET source_version = excluded.source_version,
         seen_attention_ordinal = excluded.seen_attention_ordinal,
         manual_unread_from_ordinal = excluded.manual_unread_from_ordinal, updated_at = excluded.updated_at`,
      this.parentId, effect.userId, sourceVersion, seen, manual, now,
    );
    if (!existing || existing.seen_attention_ordinal !== seen || existing.manual_unread_from_ordinal !== manual) {
      this.onViewerReadChanged(effect.userId);
    }
    this.host.noteActivityReadMoved(effect.userId, this.parentId);
  }

  /** Keep a child's newest common projection; `null` for one that is not newer. */
  private acceptChildProjection(substreamId: string, envelope: ConversationEffectEnvelope, now: number): { prior: PriorChildProjection | null } | null {
    const existing = first(this.sql.exec<{
      source_version: number; payload_hash: string; state: string; archived_at: string | null; background_agent: number | null;
      latest_attention_ordinal: number | null;
    }>(
      `SELECT source_version, payload_hash, json_extract(effect_json, '$.state') AS state,
         json_extract(effect_json, '$.latestAttentionOrdinal') AS latest_attention_ordinal,
         json_extract(effect_json, '$.archivedAt') AS archived_at,
         json_extract(effect_json, '$.backgroundAgent') AS background_agent FROM sidekick_child_projections WHERE sidekick_id = ? AND substream_id = ?`,
      this.parentId, substreamId,
    ));
    if (existing && existing.source_version > envelope.sourceVersion) return null;
    if (existing?.source_version === envelope.sourceVersion) {
      if (existing.payload_hash === envelope.payloadHash) return null;
      // The child is the authority for its own projection and restarts its
      // counter when a maintenance import rebuilds it, so the newer bytes win.
      logWarn(this.env, "substream_projection_version_reused", {
        ...this.logFields(), substream_id: substreamId, source_version: envelope.sourceVersion,
      });
    }
    this.sql.exec(
      `INSERT INTO sidekick_child_projections(sidekick_id, substream_id, source_version, payload_hash, effect_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(sidekick_id, substream_id) DO UPDATE SET source_version = excluded.source_version,
         payload_hash = excluded.payload_hash, effect_json = excluded.effect_json, updated_at = excluded.updated_at`,
      this.parentId, substreamId, envelope.sourceVersion, envelope.payloadHash, JSON.stringify(envelope.effect), now,
    );
    return {
      prior: existing ? {
        state: existing.state, archivedAt: existing.archived_at, backgroundAgent: existing.background_agent === 1,
        latestAttentionOrdinal: existing.latest_attention_ordinal,
      } : null,
    };
  }

  /** Whether anyone has a read of `"0"` recorded: only then can its latest message be unread to someone. */
  protected hasReaders(): boolean {
    return this.sql.exec(`SELECT 1 FROM sidekick_viewer_reads WHERE sidekick_id = ? LIMIT 1`, this.parentId).toArray().length > 0;
  }

  /** Record a child; `false` when it was already there. */
  protected registerChild(substreamId: string, kind: "main" | "child", createdByUserId: string | null, now: number): boolean {
    return this.sql.exec<{ substream_id: string }>(
      `INSERT OR IGNORE INTO sidekick_children(sidekick_id, substream_id, kind, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING substream_id`,
      this.parentId, substreamId, kind, createdByUserId, now,
    ).toArray().length === 1;
  }

  /** Every child this parent knows, the shared conversation first; `"0"` always. */
  childRegistry(): { substreamId: string; kind: "main" | "child"; createdAt: number }[] {
    const rows = this.sql.exec<{ substream_id: string; kind: "main" | "child"; created_at: number }>(
      `SELECT substream_id, kind, created_at FROM sidekick_children WHERE sidekick_id = ?
        ORDER BY CASE WHEN substream_id = '0' THEN 0 ELSE 1 END, created_at, substream_id`,
      this.parentId,
    ).toArray();
    const children = rows.map((row) => ({ substreamId: row.substream_id, kind: row.kind, createdAt: row.created_at }));
    if (!children.some((child) => child.substreamId === "0")) children.unshift({ substreamId: "0", kind: "main", createdAt: 0 });
    return children;
  }
}

/**
 * Refuse an audience change that names anyone outside the Organization: every
 * person a Sidekick or Canvas is shared with must be an active member or
 * guest. One check for both, so neither list admits someone the other would
 * refuse.
 */
export async function assertAudienceInOrganization(
  readRelationship: (workspaceId: string, userId: string) => Promise<WorkspaceRelationship | null>,
  workspaceId: string,
  userIds: readonly string[],
  refusal: () => ApiError,
): Promise<void> {
  const relationships = await Promise.all(userIds.map((userId) => readRelationship(workspaceId, userId)));
  if (relationships.some((relationship) => relationship?.status !== "active")) throw refusal();
}

/** An agent's child reservation: the reservation request without what the parent supplies itself. */
const AgentChildReservationSchema = ConversationParentReserveChildRequestSchema.omit({
  authorityGeneration: true, directory: true, kind: true,
});
