import {
  ConversationEffectEnvelopeSchema,
  EFFECT_QUEUE_MESSAGE_MAX_BYTES,
  ParentEffectEnvelopeSchema,
  ParentEffectSchema,
  conversationEffectHash,
  isPersonNotificationEffect,
  type ConversationEffect,
  type ConversationEffectEnvelope,
  type ParentEffect,
  type ParentEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import {
  ConversationParentListChildrenRequestSchema,
  ConversationParentListChildrenResultSchema,
  ConversationParentRetirementChildrenResultSchema,
  type ConversationParentKind,
  type ConversationParentListChildrenRequest,
  type ConversationParentListChildrenResult,
  type ConversationParentRetirementChildrenResult,
} from "@rally/contracts/conversation-parent";
import { asSubstreamId, type Region, type WorkspaceId } from "@rally/contracts";
import { z } from "zod";

import type { Env } from "../env";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { ScheduledDurableObject } from "./scheduled-alarms";
import {
  applyRetirementGate,
  droppedEnvelopeReceipts,
} from "./object-retirement";

/**
 * The half of a conversation parent that is the same for every kind of parent.
 *
 * A `SubstreamAgent` is one transcript and one loop; it reports what changed
 * (its directory projection, its viewers' projections, an activity event, a
 * notification) to its parent and nothing else. The parent keeps one row per
 * child, sums the children into one aggregate, and forwards that aggregate to
 * the workspace through its own outbox. `WorkstreamDO` and `AutomationDO` both
 * extend this; what differs between them (the parent's own row, who may read
 * it, which effect kinds leave it) is answered through the abstract hooks.
 *
 * Both hops are Cloudflare Queue messages carrying the envelope inline. The
 * outbox row is deleted the moment `sendBatch` accepts it: from there retry is
 * the Queue's, and the receiver's receipt makes a redelivery a no-op.
 *
 * Table names are shared between the two classes on purpose. `WorkstreamDO`'s
 * released migrations created them under these names, and giving the new class
 * different ones would have meant every statement here carrying a table-name
 * parameter for no reader's benefit.
 */

/** Tables the shared machinery reads and writes. Rendered into each class's own migration ledger. */
export const CONVERSATION_PARENT_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE conversation_children (
    substream_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('main', 'child')),
    created_by_user_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE substream_directory (
    substream_id TEXT PRIMARY KEY,
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    payload_hash TEXT NOT NULL,
    effect_json TEXT NOT NULL CHECK (
      json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000
    ),
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE substream_user_directory (
    substream_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    payload_hash TEXT NOT NULL,
    effect_json TEXT NOT NULL CHECK (
      json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000
    ),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (substream_id, user_id)
  ) STRICT`,
  `CREATE INDEX substream_user_directory_user_idx
    ON substream_user_directory(user_id, substream_id)`,
  `CREATE TABLE child_effect_receipts (
    substream_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (substream_id, message_id)
  ) STRICT`,
  `CREATE TABLE projection_keys (
    projection_key TEXT PRIMARY KEY,
    next_version INTEGER NOT NULL CHECK (next_version > 0),
    last_payload_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE workstream_state_clock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
    last_event_time INTEGER NOT NULL CHECK (last_event_time >= 0)
  ) STRICT`,
  `INSERT INTO workstream_state_clock(id, next_sequence, last_event_time) VALUES (1, 1, 0)`,
  `CREATE TABLE workstream_state_changes (
    sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
    state_key TEXT NOT NULL CHECK (length(state_key) BETWEEN 1 AND 180),
    waterline INTEGER NOT NULL CHECK (waterline > 0),
    event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 180),
    payload_hash TEXT NOT NULL,
    state_json TEXT NOT NULL CHECK (json_valid(state_json) AND length(state_json) <= 262144),
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    UNIQUE (state_key, waterline)
  ) STRICT`,
  `CREATE INDEX workstream_state_changes_latest_idx
    ON workstream_state_changes(state_key, waterline DESC)`,
  `CREATE TABLE durable_outbox (
    message_id TEXT PRIMARY KEY,
    partition_key TEXT NOT NULL,
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
    effect_kind TEXT NOT NULL CHECK (effect_kind IN (
      'directory_common', 'directory_user', 'directory_automation',
      'activity_event', 'mention_notification', 'participant_notification'
    )),
    payload_json TEXT NOT NULL CHECK (
      json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
    ),
    payload_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    not_before INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX durable_outbox_delivery_idx
    ON durable_outbox(state, not_before, created_at, message_id)`,
];

/** The one table `WorkstreamDO` did not already have; its v6 migration adds it. */
export const CONVERSATION_CHILDREN_SCHEMA_STATEMENTS: readonly string[] = [
  CONVERSATION_PARENT_SCHEMA_STATEMENTS[0]!,
];

export const ReceiveChildEffectsRequestSchema = z.strictObject({
  substreamId: z.string().min(1).max(180),
  envelopes: z.array(ConversationEffectEnvelopeSchema).min(1).max(25),
});
export type ReceiveChildEffectsRequest = z.infer<typeof ReceiveChildEffectsRequestSchema>;

export const ReceiveChildEffectsResultSchema = z.strictObject({
  accepted: z.array(z.strictObject({
    messageId: z.string().min(1).max(500),
    payloadHash: z.string().min(1),
  })).max(25),
});
export type ReceiveChildEffectsResult = z.infer<typeof ReceiveChildEffectsResultSchema>;

export interface ConversationParentIdentity {
  region: Region;
  workspaceId: WorkspaceId;
  parentKind: ConversationParentKind;
  parentId: string;
  /** The generation every envelope this parent emits is stamped with. */
  authorityGeneration: number;
}

export type DirectoryCommonEffect = Extract<ConversationEffect, { kind: "directory_common" }>;
export type DirectoryUserEffect = Extract<ConversationEffect, { kind: "directory_user" }>;

interface ProjectionKeyRow extends Record<string, SqlStorageValue> {
  next_version: number;
  last_payload_hash: string;
}

interface StoredEnvelopeRow extends Record<string, SqlStorageValue> {
  payload_json: string;
  payload_hash: string;
  attempts: number;
}

interface StoredProjectionRow extends Record<string, SqlStorageValue> {
  effect_json: string;
}

export interface StoredStateRow extends Record<string, SqlStorageValue> {
  event_id: string;
  waterline: number;
}

const RETRY_BASE_MS = 5_000;
// Generous fences, not history: the 10 GB object ceiling is the only hard
// bound, so retention errs long. A replay older than the receipt window
// converges on the per-key waterlines.
const CHILD_EFFECT_RECEIPT_RETENTION_MS = 180 * 24 * 60 * 60_000;
/**
 * Cloudflare accepts 100 messages and 256 KB per `sendBatch`. Each message is
 * already bounded below the per-message limit; this keeps a batch of them
 * under the per-call one.
 */
const QUEUE_BATCH_MAX_MESSAGES = 100;
const QUEUE_BATCH_MAX_BYTES = 250_000;

const effectBytes = new TextEncoder();

function first<T extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<T>): T | null {
  return cursor.toArray()[0] ?? null;
}

function canonicalState(effects: readonly DirectoryCommonEffect[]): string {
  const states = new Set(effects.map((effect) => effect.state));
  for (const state of [
    "running", "interrupting", "preparing_context", "waiting_capacity", "scheduled",
    "needs_input", "failed", "budget_exhausted", "idle", "completed", "cancelled",
  ]) {
    if (states.has(state)) return state;
  }
  return "idle";
}

function latestParticipantAddedAt(effects: readonly DirectoryUserEffect[]): string | null {
  let latest: string | null = null;
  for (const effect of effects) {
    if (!effect.isParticipant || effect.participantAddedAt == null) continue;
    if (latest === null || effect.participantAddedAt > latest) latest = effect.participantAddedAt;
  }
  return latest;
}

/** Sum one person's projections across every child into the parent's answer. */
export function aggregateUserProjections(
  userId: string,
  effects: readonly DirectoryUserEffect[],
): DirectoryUserEffect {
  return {
    kind: "directory_user",
    userId,
    isParticipant: effects.some((effect) => effect.isParticipant),
    participantAddedAt: latestParticipantAddedAt(effects),
    unreadCount: effects.reduce((count, effect) => count + effect.unreadCount, 0),
    youAreMentioned: effects.some((effect) => effect.youAreMentioned),
    // An OR across children. A second substream nobody opened would light the
    // parent's dot; whoever adds a child that people are not expected to open
    // decides then whether unseen is per-child or the main conversation's alone.
    unseen: effects.some((effect) => effect.unseen === true),
    listable: effects.some((effect) => effect.listable),
    seenAttentionOrdinal: Math.max(...effects.map((effect) => effect.seenAttentionOrdinal ?? 0)),
    manualUnreadFromOrdinal: effects.reduce<number | null>((earliest, effect) => {
      const value = effect.manualUnreadFromOrdinal ?? null;
      return value === null ? earliest : earliest === null ? value : Math.min(earliest, value);
    }, null),
    manualUnreadGeneration: Math.max(...effects.map((effect) => effect.manualUnreadGeneration ?? 0)),
    latestMentionAttentionOrdinal: Math.max(...effects.map((effect) => effect.latestMentionAttentionOrdinal ?? 0)),
  };
}

export abstract class ConversationParentDurableObject extends ScheduledDurableObject<Env> {
  /** Who this parent is, or `null` before its first row exists. */
  protected abstract parentIdentity(): ConversationParentIdentity | null;

  /**
   * Runs first, inside the transaction that applies one child envelope: assert
   * the envelope names this parent, and do whatever bookkeeping the parent's
   * own row needs before a child's fact lands (create it, move its generation).
   */
  protected abstract admitChildEnvelope(envelope: ConversationEffectEnvelope, now: number): void;

  /** Which of a child's effects this parent carries on to the workspace. */
  protected abstract forwardsChildEffect(substreamId: string, effect: ConversationEffect): boolean;

  /** Automations aggregate local child runs even when they do not forward them. */
  protected aggregatesChildProjection(substreamId: string): boolean {
    void substreamId;
    return true;
  }

  /**
   * A child published its own shared row; still inside the transaction, and
   * called for every child whether or not this parent aggregates or forwards
   * it. The registry a parent keeps beside the projections — a child's title,
   * say — converges here rather than through a second write path.
   */
  protected onChildCommonProjection(
    _substreamId: string,
    _effect: DirectoryCommonEffect,
    _now: number,
  ): void {
    void _substreamId;
    void _effect;
    void _now;
  }

  /** Log fields naming this object, for the outbox drain's records. */
  protected abstract parentLogFields(): Record<string, unknown>;

  /** A child's common aggregate changed; still inside the transaction. */
  protected onChildCommonAggregate(
    _substreamId: string,
    _aggregate: DirectoryCommonEffect,
    _envelope: ConversationEffectEnvelope,
    _now: number,
  ): void {
    void _substreamId;
    void _aggregate;
    void _envelope;
    void _now;
  }

  /** One person's aggregate changed; still inside the transaction. */
  protected onChildUserAggregate(
    _substreamId: string,
    _userId: string,
    _aggregate: DirectoryUserEffect,
    _envelope: ConversationEffectEnvelope,
    _now: number,
  ): void {
    void _substreamId;
    void _userId;
    void _aggregate;
    void _envelope;
    void _now;
  }

  /** After a batch of child effects committed and the alarm is armed. */
  protected afterChildEffects(): Promise<void> {
    return Promise.resolve();
  }

  protected get parentSql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /** Native-RPC entrypoint for ordered child projection delivery. */
  async receiveChildEffects(input: ReceiveChildEffectsRequest): Promise<ReceiveChildEffectsResult> {
    await this.migrationsReady();
    const request = ReceiveChildEffectsRequestSchema.parse(input);
    const accepted: ReceiveChildEffectsResult["accepted"] = [];
    for (const envelope of request.envelopes) {
      if (envelope.region !== this.env.AVALON_REGION) throw new Error("conversation_effect_region_mismatch");
      if (envelope.substreamId !== request.substreamId) throw new Error("conversation_effect_substream_mismatch");
      this.applyChildEnvelope(request.substreamId, envelope);
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    await this.armNextAlarm();
    await this.afterChildEffects();
    return ReceiveChildEffectsResultSchema.parse({ accepted });
  }

  async listChildren(input: ConversationParentListChildrenRequest): Promise<ConversationParentListChildrenResult> {
    await this.migrationsReady();
    const request = ConversationParentListChildrenRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    return ConversationParentListChildrenResultSchema.parse({ children: this.childRegistry() });
  }

  /**
   * The children this parent knows about, for the caller that is about to close
   * it.
   *
   * Separate from {@link listChildren} because retirement has to distinguish
   * three outcomes and act differently on each, and two of them arrive as
   * exceptions there. A parent a directory names but that never materialized is
   * retired anyway — it has no children by construction, and the call fences an
   * id a late create would otherwise take. A parent that disagrees about its own
   * identity is left alone, because closing it would tombstone the wrong object.
   */
  async childrenForRetirement(
    input: ConversationParentListChildrenRequest,
  ): Promise<ConversationParentRetirementChildrenResult> {
    await this.migrationsReady();
    const request = ConversationParentListChildrenRequestSchema.parse(input);
    const identity = this.parentIdentity();
    if (!identity) {
      return ConversationParentRetirementChildrenResultSchema.parse({ status: "missing" });
    }
    if (identity.workspaceId !== request.workspaceId || identity.parentId !== request.parentId) {
      return ConversationParentRetirementChildrenResultSchema.parse({ status: "identity_mismatch" });
    }
    return ConversationParentRetirementChildrenResultSchema.parse({
      status: "ok",
      children: this.childRegistry(),
    });
  }

  protected assertParent(workspaceId: string, parentId: string): ConversationParentIdentity {
    const identity = this.parentIdentity();
    if (!identity) throw new Error("conversation_parent_missing");
    if (identity.workspaceId !== workspaceId || identity.parentId !== parentId) {
      throw new Error("conversation_parent_identity_mismatch");
    }
    return identity;
  }

  /** Record a child; `false` when it was already there. */
  protected registerChild(
    substreamId: string,
    kind: "main" | "child",
    createdByUserId: string | null,
    now: number,
  ): boolean {
    return this.parentSql.exec<{ substream_id: string }>(
      `INSERT OR IGNORE INTO conversation_children(substream_id, kind, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?) RETURNING substream_id`,
      substreamId,
      kind,
      createdByUserId,
      now,
    ).toArray().length === 1;
  }

  /**
   * Every child this parent knows, the main conversation first.
   *
   * `"0"` is always listed: a work stream created before children were
   * registered has no row for it, and the main conversation exists for as long
   * as the parent does.
   */
  protected childRegistry(): { substreamId: string; kind: "main" | "child"; createdAt: number }[] {
    const rows = this.parentSql.exec<{ substream_id: string; kind: "main" | "child"; created_at: number }>(
      `SELECT substream_id, kind, created_at FROM conversation_children
        ORDER BY CASE WHEN substream_id = '0' THEN 0 ELSE 1 END, created_at, substream_id`,
    ).toArray();
    const children = rows.map((row) => ({ substreamId: row.substream_id, kind: row.kind, createdAt: row.created_at }));
    if (!children.some((child) => child.substreamId === "0")) {
      children.unshift({ substreamId: "0", kind: "main", createdAt: 0 });
    }
    return children;
  }

  protected applyChildEnvelope(substreamId: string, envelope: ConversationEffectEnvelope): void {
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.admitChildEnvelope(envelope, now);

      const receipt = first(this.parentSql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM child_effect_receipts WHERE substream_id = ? AND message_id = ?`,
        substreamId,
        envelope.messageId,
      ));
      if (receipt) {
        if (receipt.payload_hash !== envelope.payloadHash) throw new Error("substream_effect_idempotency_conflict");
        return;
      }

      const forwards = this.forwardsChildEffect(substreamId, envelope.effect);
      if (envelope.effect.kind === "directory_common") {
        if (this.upsertChildProjection("common", substreamId, null, envelope, now)) {
          this.onChildCommonProjection(substreamId, envelope.effect, now);
        }
        if (this.aggregatesChildProjection(substreamId)) {
          const aggregate = this.aggregateCommon();
          this.onChildCommonAggregate(substreamId, aggregate, envelope, now);
          if (forwards) this.enqueueProjection("common", aggregate, now);
        }
      } else if (envelope.effect.kind === "directory_user") {
        this.upsertChildProjection("user", substreamId, envelope.effect.userId, envelope, now);
        if (this.aggregatesChildProjection(substreamId)) {
          const aggregate = this.aggregateUser(envelope.effect.userId);
          this.onChildUserAggregate(substreamId, envelope.effect.userId, aggregate, envelope, now);
          if (forwards) this.enqueueProjection(`user:${envelope.effect.userId}`, aggregate, now);
        }
      } else if (forwards) {
        this.enqueueImmutable(substreamId, envelope, now);
      }
      this.parentSql.exec(
        `INSERT INTO child_effect_receipts(substream_id, message_id, payload_hash, received_at)
         VALUES (?, ?, ?, ?)`,
        substreamId,
        envelope.messageId,
        envelope.payloadHash,
        now,
      );
      // The receipt is a replay fence, not history. Past retention a
      // redelivery converges on the per-key waterlines instead.
      this.parentSql.exec(
        `DELETE FROM child_effect_receipts
          WHERE (substream_id, message_id) IN (
            SELECT substream_id, message_id FROM child_effect_receipts
             WHERE received_at < ?
             ORDER BY received_at LIMIT 100
          )`,
        now - CHILD_EFFECT_RECEIPT_RETENTION_MS,
      );
    });
  }

  private upsertChildProjection(
    kind: "common" | "user",
    substreamId: string,
    userId: string | null,
    envelope: ConversationEffectEnvelope,
    now: number,
  ): boolean {
    const table = kind === "common" ? "substream_directory" : "substream_user_directory";
    const where = kind === "common" ? "substream_id = ?" : "substream_id = ? AND user_id = ?";
    const params = kind === "common" ? [substreamId] : [substreamId, userId!];
    const existing = first(this.parentSql.exec<{ source_version: number; payload_hash: string }>(
      `SELECT source_version, payload_hash FROM ${table} WHERE ${where}`,
      ...params,
    ));
    if (existing && existing.source_version > envelope.sourceVersion) return false;
    if (existing?.source_version === envelope.sourceVersion) {
      if (existing.payload_hash === envelope.payloadHash) return false;
      // Same version, different content. The child numbers these itself and
      // restarts its counter when a maintenance import rebuilds it, while this
      // projection survives, so a re-derived effect legitimately arrives under
      // a version this object has already seen carrying different bytes. The
      // child is the authority for its own projection, so the newer payload
      // wins. Outside a rebuild the two should never disagree, hence the log.
      logWarn(this.env, "substream_projection_version_reused", {
        ...this.parentLogFields(),
        substream_id: substreamId,
        source_version: envelope.sourceVersion,
      });
    }
    if (kind === "common") {
      this.parentSql.exec(
        `INSERT INTO substream_directory(substream_id, source_version, payload_hash, effect_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(substream_id) DO UPDATE SET source_version = excluded.source_version,
           payload_hash = excluded.payload_hash, effect_json = excluded.effect_json,
           updated_at = excluded.updated_at`,
        substreamId,
        envelope.sourceVersion,
        envelope.payloadHash,
        JSON.stringify(envelope.effect),
        now,
      );
    } else {
      this.parentSql.exec(
        `INSERT INTO substream_user_directory
           (substream_id, user_id, source_version, payload_hash, effect_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(substream_id, user_id) DO UPDATE SET source_version = excluded.source_version,
           payload_hash = excluded.payload_hash, effect_json = excluded.effect_json,
           updated_at = excluded.updated_at`,
        substreamId,
        userId,
        envelope.sourceVersion,
        envelope.payloadHash,
        JSON.stringify(envelope.effect),
        now,
      );
    }
    return true;
  }

  protected childCommonProjections(): DirectoryCommonEffect[] {
    return this.parentSql.exec<StoredProjectionRow>(
      `SELECT effect_json FROM substream_directory ORDER BY substream_id`,
    ).toArray()
      .map((row) => ParentEffectSchema.parse(JSON.parse(row.effect_json)))
      .filter((effect): effect is DirectoryCommonEffect => effect.kind === "directory_common");
  }

  /**
   * The parent's common row: the most recently active child's projection,
   * with the state and completion that the set of children implies.
   */
  protected aggregateCommon(): DirectoryCommonEffect {
    const common = this.childCommonProjections();
    if (common.length === 0) throw new Error("conversation_parent_common_projection_missing");
    const base = [...common].sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))[0]!;
    const lastActivityAt = common.reduce(
      (latest, effect) => effect.lastActivityAt > latest ? effect.lastActivityAt : latest,
      base.lastActivityAt,
    );
    return {
      ...base,
      state: canonicalState(common),
      lastActivityAt,
      completedAt: common.every((effect) => effect.completedAt !== null) ? lastActivityAt : null,
    };
  }

  /**
   * Whether this person is a participant, as far as the parent knows.
   *
   * The per-user projection is the answer once the child has sent one. Before
   * that, the one thing the parent knows is who created the main conversation,
   * recorded at `reserveChild`: the creator is a participant of a conversation
   * that has not yet reported its participants, and stops being one the moment
   * the child's projection says otherwise. Without this fallback the person who
   * had just created a personal work stream could not open it until the
   * child's first effect had crossed the Queue, and the boot and the socket
   * ticket answered 404 in that window.
   */
  protected isParticipant(userId: string): boolean {
    const projection = this.userProjection(userId);
    if (projection) return projection.isParticipant === true;
    // No projection for this person. If the main conversation has reported
    // at all, its silence about them is the answer; only before its first
    // projection does the creator stand in.
    if (this.mainChildHasReported()) return false;
    return this.mainChildCreatedBy() === userId;
  }

  private mainChildHasReported(): boolean {
    return first(this.parentSql.exec<{ substream_id: string }>(
      `SELECT substream_id FROM substream_directory WHERE substream_id = '0'`,
    )) !== null;
  }

  protected mainChildCreatedBy(): string | null {
    return first(this.parentSql.exec<{ created_by_user_id: string | null }>(
      `SELECT created_by_user_id FROM conversation_children WHERE substream_id = '0'`,
    ))?.created_by_user_id ?? null;
  }

  protected userProjection(userId: string): DirectoryUserEffect | null {
    const effects = this.parentSql.exec<StoredProjectionRow>(
      `SELECT effect_json FROM substream_user_directory WHERE user_id = ? ORDER BY substream_id`,
      userId,
    ).toArray()
      .map((row) => ParentEffectSchema.parse(JSON.parse(row.effect_json)))
      .filter((effect): effect is DirectoryUserEffect => effect.kind === "directory_user");
    return effects.length === 0 ? null : aggregateUserProjections(userId, effects);
  }

  protected aggregateUser(userId: string): DirectoryUserEffect {
    const projection = this.userProjection(userId);
    if (!projection) throw new Error("conversation_parent_user_projection_missing");
    return projection;
  }

  protected latestStateRow(stateKey: string): StoredStateRow | null {
    return first(this.parentSql.exec<StoredStateRow>(
      `SELECT event_id, waterline FROM workstream_state_changes
        WHERE state_key = ? ORDER BY waterline DESC LIMIT 1`,
      stateKey,
    ));
  }

  /**
   * Version one of this parent's projections and put it in the outbox.
   *
   * Returns the envelope enqueued, or `null` when the projection's bytes have
   * not changed since the last one under this key. The parent numbers its own
   * projections (`sourceVersion` here is the parent's waterline, not any
   * child's) because the workspace applies strictly newer versions and two
   * children numbering independently could not be compared.
   */
  protected enqueueProjection(
    projectionKey: string,
    effect: ParentEffect,
    now: number,
  ): ParentEffectEnvelope | null {
    const identity = this.parentIdentity();
    if (!identity) throw new Error("conversation_parent_missing");
    const payloadHash = conversationEffectHash(effect);
    const previous = first(this.parentSql.exec<ProjectionKeyRow>(
      `SELECT next_version, last_payload_hash FROM projection_keys WHERE projection_key = ?`,
      projectionKey,
    ));
    if (previous?.last_payload_hash === payloadHash) return null;
    const sourceVersion = previous?.next_version ?? 1;
    const messageId = this.recordStateChange(projectionKey, sourceVersion, effect, payloadHash, now);
    this.parentSql.exec(
      `INSERT INTO projection_keys(projection_key, next_version, last_payload_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET next_version = excluded.next_version,
         last_payload_hash = excluded.last_payload_hash, updated_at = excluded.updated_at`,
      projectionKey,
      sourceVersion + 1,
      payloadHash,
      now,
    );
    const envelope = ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: identity.region,
      workspaceId: identity.workspaceId,
      parentKind: identity.parentKind,
      parentId: identity.parentId,
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
  protected advanceLocalStateVersion(stateKey: string, state: unknown, now: number): boolean {
    const encoded = JSON.stringify(state);
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(encoded)) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    const payloadHash = `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
    const previous = first(this.parentSql.exec<ProjectionKeyRow>(
      `SELECT next_version, last_payload_hash FROM projection_keys WHERE projection_key = ?`,
      stateKey,
    ));
    if (previous?.last_payload_hash === payloadHash) return false;
    const waterline = previous?.next_version ?? 1;
    this.recordStateChange(stateKey, waterline, { localViewerState: true }, payloadHash, now);
    this.parentSql.exec(
      `INSERT INTO projection_keys(projection_key, next_version, last_payload_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET next_version = excluded.next_version,
         last_payload_hash = excluded.last_payload_hash, updated_at = excluded.updated_at`,
      stateKey, waterline + 1, payloadHash, now,
    );
    return true;
  }

  /**
   * Append one immutable state row before its Queue message can exist.
   *
   * The timestamp-prefixed ID is useful for cross-socket traces and sorts by
   * observed wall time. The state-key waterline remains the correctness clock:
   * clocks in independent Durable Objects cannot provide a global total order.
   */
  private recordStateChange(
    stateKey: string,
    waterline: number,
    effect: ParentEffect | { localViewerState: true },
    payloadHash: string,
    now: number,
  ): string {
    const clock = first(this.parentSql.exec<{ next_sequence: number; last_event_time: number }>(
      `SELECT next_sequence, last_event_time FROM workstream_state_clock WHERE id = 1`,
    ));
    if (!clock) throw new Error("conversation_parent_state_clock_missing");
    const occurredAt = Math.max(now, clock.last_event_time);
    const sequence = clock.next_sequence;
    const eventId = uuidV7(occurredAt);
    this.parentSql.exec(
      `UPDATE workstream_state_clock SET next_sequence = ?, last_event_time = ? WHERE id = 1`,
      sequence + 1,
      occurredAt,
    );
    this.parentSql.exec(
      `INSERT INTO workstream_state_changes
         (sequence, state_key, waterline, event_id, payload_hash, state_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sequence,
      stateKey,
      waterline,
      eventId,
      payloadHash,
      JSON.stringify(effect),
      occurredAt,
    );
    // Reconnects need the current row, not every transition ever observed.
    this.parentSql.exec(
      `DELETE FROM workstream_state_changes WHERE state_key = ? AND waterline <= ?`,
      stateKey,
      waterline - 1_024,
    );
    return eventId;
  }

  protected prepareNotificationProjection(_userId: string, _now: number): void {
    void _userId;
    void _now;
  }

  private enqueueImmutable(substreamId: string, source: ConversationEffectEnvelope, now: number): void {
    const identity = this.parentIdentity();
    if (!identity) throw new Error("conversation_parent_missing");
    const effect = isPersonNotificationEffect(source.effect) && identity.parentKind === "workstream" && substreamId !== "0"
      ? { ...source.effect, substreamId: asSubstreamId(substreamId) } : source.effect;
    let requiredProjectionVersion: number | null = null;
    if (isPersonNotificationEffect(source.effect)) {
      if (substreamId !== "0") this.prepareNotificationProjection(source.effect.recipientUserId, now);
      const key = `user:${source.effect.recipientUserId}`;
      const projection = first(this.parentSql.exec<ProjectionKeyRow>(
        `SELECT next_version, last_payload_hash FROM projection_keys WHERE projection_key = ?`,
        key,
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
    const inserted = this.parentSql.exec<{ message_id: string }>(
      `INSERT OR IGNORE INTO durable_outbox
         (message_id, partition_key, source_version, source_epoch, effect_kind,
          payload_json, payload_hash, state, attempts, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       RETURNING message_id`,
      envelope.messageId,
      envelope.partitionKey,
      envelope.sourceVersion,
      envelope.generation,
      envelope.effect.kind,
      JSON.stringify(envelope),
      envelope.payloadHash,
      now,
      now,
    );
    if (inserted.toArray().length === 0) {
      const existing = first(this.parentSql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM durable_outbox WHERE message_id = ?`,
        envelope.messageId,
      ));
      if (existing?.payload_hash !== envelope.payloadHash) throw new Error("conversation_parent_outbox_conflict");
    }
  }

  protected dueParentEffects(limit = QUEUE_BATCH_MAX_MESSAGES, now = Date.now()): ParentEffectEnvelope[] {
    return this.parentSql.exec<StoredEnvelopeRow>(
      `SELECT payload_json, payload_hash, attempts FROM durable_outbox
        WHERE state IN ('pending', 'inflight') AND not_before <= ?
        ORDER BY CASE effect_kind
                   WHEN 'directory_common' THEN 0
                   WHEN 'directory_user' THEN 1
                   WHEN 'directory_automation' THEN 1
                   ELSE 2
                 END,
                 created_at, message_id LIMIT ?`,
      now,
      limit,
    ).toArray().map((row) => ParentEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
  }

  /** Drop delivered rows; returns how many were still there. */
  protected deleteParentEffects(effects: readonly ParentEffectEnvelope[]): number {
    let removed = 0;
    this.ctx.storage.transactionSync(() => {
      for (const effect of effects) {
        removed += this.parentSql.exec<{ message_id: string }>(
          `DELETE FROM durable_outbox WHERE message_id = ? AND payload_hash = ? RETURNING message_id`,
          effect.messageId,
          effect.payloadHash,
        ).toArray().length;
      }
    });
    return removed;
  }

  protected deferParentEffects(effects: readonly ParentEffectEnvelope[], notBefore: number): void {
    this.ctx.storage.transactionSync(() => {
      for (const effect of effects) {
        this.parentSql.exec(
          `UPDATE durable_outbox SET state = 'pending', attempts = attempts + 1, not_before = ?
            WHERE message_id = ? AND payload_hash = ?`,
          notBefore,
          effect.messageId,
          effect.payloadHash,
        );
      }
    });
  }

  /**
   * Send every due outbox row to the activity Queue and delete what it took.
   *
   * A row the Queue accepted is gone from here: the Queue retries, and the
   * workspace's receipt makes a redelivery a no-op. A row it refused stays,
   * deferred. A row too large for one Queue message is deleted with a warning,
   * because it would be refused on every attempt and nothing here can shrink
   * it; only `resourceLinks` can push an envelope that far.
   */
  protected async drainParentOutbox(): Promise<void> {
    const due = this.dueParentEffects();
    if (due.length === 0) return;
    const batches: { effects: ParentEffectEnvelope[]; bodies: MessageSendRequest<ParentEffectEnvelope>[] }[] = [];
    let current = { effects: [] as ParentEffectEnvelope[], bodies: [] as MessageSendRequest<ParentEffectEnvelope>[], bytes: 0 };
    for (const effect of due) {
      const bytes = effectBytes.encode(JSON.stringify(effect)).byteLength;
      if (bytes > EFFECT_QUEUE_MESSAGE_MAX_BYTES) {
        this.deleteParentEffects([effect]);
        logWarn(this.env, "parent_effect_oversized", {
          ...this.parentLogFields(),
          message_id: effect.messageId,
          effect_kind: effect.effect.kind,
          bytes,
          limit_bytes: EFFECT_QUEUE_MESSAGE_MAX_BYTES,
          outcome: "dropped",
        });
        continue;
      }
      if (current.bodies.length >= QUEUE_BATCH_MAX_MESSAGES || current.bytes + bytes > QUEUE_BATCH_MAX_BYTES) {
        batches.push(current);
        current = { effects: [], bodies: [], bytes: 0 };
      }
      current.effects.push(effect);
      current.bodies.push({ body: effect });
      current.bytes += bytes;
    }
    if (current.bodies.length > 0) batches.push(current);
    for (const batch of batches) {
      try {
        await this.env.ACTIVITY_QUEUE.sendBatch(batch.bodies);
        const removed = this.deleteParentEffects(batch.effects);
        logInfo(this.env, "parent_effect_batch_enqueued", {
          ...this.parentLogFields(),
          message_ids: batch.effects.map((effect) => effect.messageId),
          effect_kinds: batch.effects.map((effect) => effect.effect.kind),
          effect_count: batch.effects.length,
          removed_count: removed,
          outcome: "queued",
        });
      } catch (error) {
        const retryAt = Date.now() + RETRY_BASE_MS;
        this.deferParentEffects(batch.effects, retryAt);
        logWarn(this.env, "parent_effect_enqueue_failed", {
          ...this.parentLogFields(),
          message_ids: batch.effects.map((effect) => effect.messageId),
          effect_kinds: batch.effects.map((effect) => effect.effect.kind),
          effect_count: batch.effects.length,
          retry_at: new Date(retryAt).toISOString(),
          reason: diagnosticErrorCode(error, "queue_send_failed"),
          error_name: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }

  protected nextParentOutboxDueAt(): number | null {
    return first(this.parentSql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM durable_outbox WHERE state IN ('pending', 'inflight')`,
    ))?.due_at ?? null;
  }
}

applyRetirementGate(ConversationParentDurableObject, {
  permit: [
    // Retirement's own read, and the one that makes an interrupted pass
    // resumable. The walk asks for a parent's children, retires them, retires
    // the parent, and only then writes the receipt; a pass that dies between
    // the last two steps leaves a tombstoned parent with no receipt, and the
    // next pass has to be able to ask it again. Refusing here made every such
    // node permanently unreceipted — "incomplete, retire again" forever.
    "childrenForRetirement",
  ],
  drop: {
    // The child's leg of the same Queue path WorkspaceDO's receivers end.
    receiveChildEffects: ([input]) => ({ accepted: droppedEnvelopeReceipts(input) }),
    // No `fetch` and no socket callbacks: this class serves neither, and the
    // gate refuses a policy entry naming a method the class does not have.
    // The platform retries an alarm that throws. A retired object answers the
    // wake by doing nothing and arming nothing, which is what quiet means.
    alarm: () => Promise.resolve(),
  },
});
