import {
  ConversationEffectEnvelopeSchema,
  EFFECT_QUEUE_MESSAGE_MAX_BYTES,
  type ConversationEffect,
  type ParentEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import type { ConversationParentKind } from "@rally/contracts/conversation-parent";
import type { Region, WorkspaceId } from "@rally/contracts";
import { z } from "zod";

/**
 * What the conversation parents share, now that every parent is hosted.
 *
 * A `SubstreamAgent` is one transcript and one loop; it reports what changed
 * (its directory projection, its viewers' projections, an activity event, a
 * notification) to its parent and nothing else. Every parent, a Channel's, a
 * Space's and a Sidekick's, is hosted in the Organization's `WorkspaceDO`
 * (`HostedParent`, `HostedSidekick`); the base class that once gave a parent
 * its own object is gone with the last subclass, `SidekickDO`.
 *
 * What is left is shared by those hosts: the child-effect request shapes, the
 * aggregation helpers, the Queue batching, and the parent schema statements
 * that the legacy `SidekickDO` ledger still carries inside a released
 * migration, whose bytes are hashed into every deployed object's receipt.
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
export type DirectoryProjectionKind = DirectoryCommonEffect["kind"] | DirectoryUserEffect["kind"];

export interface StoredStateRow extends Record<string, SqlStorageValue> {
  event_id: string;
  waterline: number;
}

/**
 * Cloudflare accepts 100 messages and 256 KB per `sendBatch`. Each message is
 * already bounded below the per-message limit; this keeps a batch of them
 * under the per-call one.
 */
const QUEUE_BATCH_MAX_MESSAGES = 100;
export const QUEUE_BATCH_MAX_BYTES = 250_000;

const effectBytes = new TextEncoder();

/**
 * Split parent effects into `sendBatch` calls the Queue accepts, and set aside
 * any single effect too large for one Queue message: it would be refused on
 * every attempt, and nothing that holds it can shrink it.
 */
export function planParentEffectBatches(effects: readonly ParentEffectEnvelope[]): {
  batches: ParentEffectEnvelope[][];
  oversized: { effect: ParentEffectEnvelope; bytes: number }[];
} {
  const batches: ParentEffectEnvelope[][] = [];
  const oversized: { effect: ParentEffectEnvelope; bytes: number }[] = [];
  let current: ParentEffectEnvelope[] = [];
  let currentBytes = 0;
  for (const effect of effects) {
    const bytes = effectBytes.encode(JSON.stringify(effect)).byteLength;
    if (bytes > EFFECT_QUEUE_MESSAGE_MAX_BYTES) {
      oversized.push({ effect, bytes });
      continue;
    }
    if (current.length >= QUEUE_BATCH_MAX_MESSAGES || currentBytes + bytes > QUEUE_BATCH_MAX_BYTES) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(effect);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return { batches, oversized };
}

export function canonicalState(effects: readonly DirectoryCommonEffect[]): string {
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
