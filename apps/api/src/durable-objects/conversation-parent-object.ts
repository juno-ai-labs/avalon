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
 * An `AgentLoopDO` is one transcript and one loop; it reports what changed
 * (its directory projection, its viewers' projections, an activity event, a
 * notification) to its parent and nothing else. Every parent, a Channel's, a
 * Space's and a Sidekick's, is hosted in the Organization's `WorkspaceDO`
 * (`HostedParent`, `HostedSidekick`); the base class that once gave a parent
 * its own object is gone with the last subclass, `SidekickDO`.
 *
 * What is left is shared by those hosts: the child-effect request shapes, the
 * aggregation helpers and the Queue batching.
 */

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
