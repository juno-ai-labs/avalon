import { nowIso } from "@avalon/db";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import {
  WorkstreamMentionNotificationEffectSchema,
  WorkstreamRegionalEffectEnvelopeSchema,
  WorkstreamRegionalEffectQueueMessageSchema,
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffectEnvelope,
  type WorkstreamRegionalEffectQueueMessage,
} from "../durable-objects/workstream-regional-effect";
import { workspaceDOName, workstreamDOName } from "../durable-objects/names";
import { WorkspaceDirectoryNotificationStateSchema } from "../durable-objects/workspace-directory-protocol";
import { sendWorkstreamMentionEmail } from "./mention-email-service";
import { sendWorkstreamMentionSlack } from "./slack-mention-service";
import { enqueueMentionOpportunitySnapshot } from "./work-opportunity-batching";
import { publishWorkspaceSync } from "./workspace-realtime-service";

function workspaceTopicsForEffect(
  effect: WorkstreamRegionalEffectEnvelope["effect"],
) {
  if (effect.kind === "activity_event") {
    return ["activity", "work_opportunities"] as const;
  }
  return ["activity", "workstream_directory"] as const;
}

interface EffectReceiptRow {
  payload_hash: string;
}

interface NotificationIntentRow {
  intent_id: string;
  workspace_id: string;
  workstream_id: string;
  recipient_user_id: string;
  source_generation: number;
  required_directory_version: number;
  payload_json: string;
  recipient_email: string;
  recipient_name: string;
  workspace_name: string;
}

export interface WorkstreamRegionalEffectResult {
  replayed: boolean;
  notificationIntentId: string | null;
}

/**
 * Apply one WorkstreamDO activity/mention effect to the regional delivery plane.
 * D1.batch is the inbox transaction: either the activity/intent and receipt
 * both commit, or neither does. Workspace directory effects never enter here.
 */
export async function applyWorkstreamRegionalEffect(
  env: Env,
  input: WorkstreamRegionalEffectEnvelope,
): Promise<WorkstreamRegionalEffectResult> {
  const message = WorkstreamRegionalEffectEnvelopeSchema.parse(input);
  if (message.region !== env.AVALON_REGION) throw new Error("workstream_effect_region_mismatch");
  if (
    workstreamRegionalEffectHash(message.effect, message.requiredProjectionVersion)
    !== message.payloadHash
  ) {
    throw new Error("workstream_effect_payload_hash_mismatch");
  }
  if (
    message.effect.kind === "directory_common"
    || message.effect.kind === "directory_user"
    || message.effect.kind === "suggestion_feedback"
  ) {
    throw new Error("workspace_owned_effect_misdirected_to_regional_queue");
  }

  const route = await env.DB.prepare(
    `SELECT state FROM workstream_authority_routes
      WHERE workspace_id = ? AND workstream_id = ? AND generation = ?`,
  ).bind(message.workspaceId, message.workstreamId, message.generation).first<{ state: string }>();
  if (route?.state !== "active") throw new Error("workstream_effect_route_not_active");

  const receipt = await env.DB.prepare(
    `SELECT payload_hash FROM workstream_regional_effect_receipts WHERE message_id = ?`,
  ).bind(message.messageId).first<EffectReceiptRow>();
  if (receipt) {
    if (receipt.payload_hash !== message.payloadHash) {
      throw new Error("workstream_effect_receipt_hash_conflict");
    }
    await publishWorkspaceSync(env, message.workspaceId, workspaceTopicsForEffect(message.effect));
    return {
      replayed: true,
      notificationIntentId: message.effect.kind === "mention_notification"
        ? message.effect.intentId
        : null,
    };
  }

  const at = nowIso();
  const receiptStatement = env.DB.prepare(
    `INSERT INTO workstream_regional_effect_receipts
       (message_id, workspace_id, workstream_id, generation, partition_key,
        source_version, effect_kind, payload_hash, applied_at, acknowledged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    message.messageId,
    message.workspaceId,
    message.workstreamId,
    message.generation,
    message.partitionKey,
    message.sourceVersion,
    message.effect.kind,
    message.payloadHash,
    at,
  );

  switch (message.effect.kind) {
    case "activity_event": {
      const effect = message.effect;
      const existing = await env.DB.prepare(
        `SELECT id FROM activity_events WHERE workspace_id = ? AND dedupe_key = ?`,
      ).bind(message.workspaceId, effect.dedupeKey).first<{ id: string }>();
      if (existing && existing.id !== effect.eventId) {
        throw new Error("workstream_effect_activity_id_conflict");
      }
      const currentActor = effect.actorUserId
        ? await env.DB.prepare(`SELECT id FROM users WHERE id = ?`)
          .bind(effect.actorUserId).first<{ id: string }>()
        : null;
      let targetUserIds = new Set<string>();
      if (effect.targets.length > 0) {
        const placeholders = effect.targets.map(() => "?").join(",");
        const users = await env.DB.prepare(
          `SELECT id FROM users WHERE id IN (${placeholders})`,
        ).bind(...effect.targets.map((target) => target.userId)).all<{ id: string }>();
        targetUserIds = new Set((users.results ?? []).map((user) => user.id));
      }
      const statements = [
        env.DB.prepare(
          `INSERT OR IGNORE INTO activity_events
             (id, workspace_id, event_type, subject_type, subject_id,
              subject_sequence_number, actor_type, actor_user_id, actor_label,
              title, body, canonical_url, audience_kind, audience_user_id,
              audience_workstream_id, occurred_at, created_at, source_kind,
              source_id, dedupe_key, metadata_json, digestible)
           VALUES (?, ?, ?, 'workstream', ?, ?, ?, ?, ?, ?, ?, ?,
                   'workstream', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          effect.eventId,
          message.workspaceId,
          effect.eventType,
          message.workstreamId,
          effect.subjectSequenceNumber,
          effect.actorType,
          currentActor?.id ?? null,
          effect.actorLabel,
          effect.title,
          effect.body,
          effect.canonicalUrl,
          message.workstreamId,
          effect.occurredAt,
          at,
          effect.sourceKind,
          effect.sourceId,
          effect.dedupeKey,
          JSON.stringify(effect.metadata),
          effect.digestible ? 1 : 0,
        ),
        ...effect.targets.filter((target) => targetUserIds.has(target.userId)).map((target) => env.DB.prepare(
          `INSERT OR IGNORE INTO activity_event_targets
             (event_id, workspace_id, user_id, relation, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(effect.eventId, message.workspaceId, target.userId, target.relation, at)),
        receiptStatement,
      ];
      if (effect.sourceKind === "workstream_message" && effect.sourceId && targetUserIds.size > 0) {
        await enqueueMentionOpportunitySnapshot(env, {
          workspaceId: message.workspaceId,
          messageId: effect.sourceId,
          targetUserIds: [...targetUserIds],
          occurredAt: effect.occurredAt,
          inputCharacters: effect.body.length,
        });
      }
      await env.DB.batch(statements);
      await publishWorkspaceSync(env, message.workspaceId, workspaceTopicsForEffect(message.effect));
      return { replayed: false, notificationIntentId: null };
    }
    case "mention_notification": {
      const effect = message.effect;
      const activeMember = await env.DB.prepare(
        `SELECT 1 FROM workspace_members
          WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
      ).bind(message.workspaceId, effect.recipientUserId).first();
      if (!activeMember) {
        await env.DB.batch([receiptStatement]);
        await publishWorkspaceSync(env, message.workspaceId, workspaceTopicsForEffect(message.effect));
        return { replayed: false, notificationIntentId: null };
      }
      const existing = await env.DB.prepare(
        `SELECT intent_id, payload_hash FROM workstream_notification_intents
          WHERE intent_id = ?
             OR (source_message_id = ? AND recipient_user_id = ?
                 AND notification_kind = 'mention')`,
      ).bind(
        effect.intentId,
        effect.messageId,
        effect.recipientUserId,
      ).first<{ intent_id: string; payload_hash: string }>();
      if (
        existing
        && (existing.intent_id !== effect.intentId || existing.payload_hash !== message.payloadHash)
      ) throw new Error("workstream_effect_notification_id_conflict");
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO workstream_notification_intents
             (intent_id, workspace_id, workstream_id, recipient_user_id,
              source_message_id, source_generation, source_version,
              required_directory_version, notification_kind, payload_json,
              payload_hash, state, attempts,
              lease_id, lease_expires_at, last_error_code, created_at, updated_at,
              delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'mention', ?, ?, 'pending', 0,
                   NULL, NULL, NULL, ?, ?, NULL)
           ON CONFLICT(intent_id) DO NOTHING`,
        ).bind(
          effect.intentId,
          message.workspaceId,
          message.workstreamId,
          effect.recipientUserId,
          effect.messageId,
          message.generation,
          message.sourceVersion,
          message.requiredProjectionVersion,
          JSON.stringify(effect),
          message.payloadHash,
          at,
          at,
        ),
        receiptStatement,
      ]);
      await publishWorkspaceSync(env, message.workspaceId, workspaceTopicsForEffect(message.effect));
      return { replayed: false, notificationIntentId: effect.intentId };
    }
  }
}

/** Resolve current regional identity/delivery state and execute one intent. */
export async function processWorkstreamNotificationIntent(
  env: Env,
  intentId: string,
): Promise<"delivered" | "skipped" | "busy"> {
  const leaseId = crypto.randomUUID();
  const at = nowIso();
  const claim = await env.DB.prepare(
    `UPDATE workstream_notification_intents
        SET state = 'processing', attempts = attempts + 1, lease_id = ?,
            lease_expires_at = ?, last_error_code = NULL, updated_at = ?
      WHERE intent_id = ? AND payload_json IS NOT NULL
        AND (state IN ('pending', 'failed')
          OR (state = 'processing' AND COALESCE(lease_expires_at, '') <= ?))`,
  ).bind(
    leaseId,
    new Date(Date.now() + 5 * 60_000).toISOString(),
    at,
    intentId,
    at,
  ).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    const settled = await env.DB.prepare(
      `SELECT state FROM workstream_notification_intents WHERE intent_id = ?`,
    ).bind(intentId).first<{ state: string }>();
    if (!settled || settled.state === "skipped") return "skipped";
    return settled.state === "delivered" ? "delivered" : "busy";
  }

  const row = await env.DB.prepare(
      `SELECT intent.intent_id, intent.workspace_id, intent.workstream_id,
            intent.recipient_user_id, intent.source_generation,
            intent.required_directory_version, intent.payload_json,
            user.email AS recipient_email, user.name AS recipient_name,
            workspace.name AS workspace_name
       FROM workstream_notification_intents intent
       JOIN users user ON user.id = intent.recipient_user_id
       JOIN workspaces workspace ON workspace.id = intent.workspace_id
       JOIN workspace_members member
         ON member.workspace_id = intent.workspace_id
        AND member.user_id = intent.recipient_user_id
        AND member.status = 'active'
      WHERE intent.intent_id = ? AND intent.lease_id = ?`,
  ).bind(intentId, leaseId).first<NotificationIntentRow>();
  if (!row) {
    await settleNotificationIntent(env, intentId, leaseId, "skipped");
    return "skipped";
  }

  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    row.workspace_id,
    workspaceDOName(env.AVALON_REGION, row.workspace_id),
  );
  const rawDirectoryState = await workspace.notificationDirectoryState({
    workspaceId: row.workspace_id,
    workstreamId: row.workstream_id,
    userId: row.recipient_user_id,
  });
  const viewer = rawDirectoryState
    ? WorkspaceDirectoryNotificationStateSchema.parse(rawDirectoryState)
    : null;
  if (
    !viewer
    || viewer.authorityGeneration < row.source_generation
    || (
      viewer.authorityGeneration === row.source_generation
      && viewer.viewerVersion < row.required_directory_version
    )
  ) {
    await env.DB.prepare(
      `UPDATE workstream_notification_intents
          SET state = 'pending', lease_id = NULL, lease_expires_at = NULL,
              last_error_code = 'directory_projection_pending', updated_at = ?
        WHERE intent_id = ? AND lease_id = ?`,
    ).bind(nowIso(), intentId, leaseId).run();
    return "busy";
  }
  if (!viewer.listable) {
    await settleNotificationIntent(env, intentId, leaseId, "skipped");
    return "skipped";
  }

  const effect = WorkstreamMentionNotificationEffectSchema.parse(JSON.parse(row.payload_json));
  if (effect.recipientUserId === effect.authorUserId) {
    await settleNotificationIntent(env, intentId, leaseId, "skipped");
    return "skipped";
  }
  try {
    const common = {
      messageId: effect.messageId,
      recipientUserId: effect.recipientUserId,
      recipientEmail: row.recipient_email,
      authorName: effect.authorNameSnapshot,
      workspaceName: row.workspace_name,
      workstreamId: row.workstream_id,
      workstreamTitle: effect.workstreamTitleSnapshot,
      messageText: effect.messageText,
    };
    const slack = await sendWorkstreamMentionSlack(env, {
      ...common,
      workspaceId: row.workspace_id,
    });
    if (slack !== "sent") {
      await sendWorkstreamMentionEmail(env, {
        ...common,
        recipientName: row.recipient_name,
        workstreamEmailAddress: viewer.emailAddress,
        region: env.AVALON_REGION,
      });
    }
    await settleNotificationIntent(env, intentId, leaseId, "delivered");
    return "delivered";
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "notification_delivery_failed";
    await env.DB.prepare(
      `UPDATE workstream_notification_intents
          SET state = 'failed', lease_id = NULL, lease_expires_at = NULL,
              last_error_code = ?, updated_at = ?
        WHERE intent_id = ? AND lease_id = ?`,
    ).bind(code, nowIso(), intentId, leaseId).run();
    throw error;
  }
}

async function settleNotificationIntent(
  env: Env,
  intentId: string,
  leaseId: string,
  state: "delivered" | "skipped",
): Promise<void> {
  const at = nowIso();
  await env.DB.prepare(
    `UPDATE workstream_notification_intents
        SET state = ?, payload_json = NULL, lease_id = NULL,
            lease_expires_at = NULL, last_error_code = NULL, updated_at = ?,
            delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE NULL END
      WHERE intent_id = ? AND lease_id = ?`,
  ).bind(state, at, state, at, intentId, leaseId).run();
}

export async function acknowledgeWorkstreamRegionalEffect(
  env: Env,
  message: WorkstreamRegionalEffectEnvelope,
): Promise<void> {
  const objectName = workstreamDOName(message.region, message.workspaceId, message.workstreamId);
  const workstream = await durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    message.workspaceId,
    objectName,
  );
  await workstream.acknowledgeRegionalEffect({
    messageId: message.messageId,
    payloadHash: message.payloadHash,
  });
  await markWorkstreamRegionalEffectAcknowledged(env, message.messageId, message.payloadHash);
}

export async function markWorkstreamRegionalEffectAcknowledged(
  env: Env,
  messageId: string,
  payloadHash: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE workstream_regional_effect_receipts
        SET acknowledged_at = COALESCE(acknowledged_at, ?)
      WHERE message_id = ? AND payload_hash = ?`,
  ).bind(nowIso(), messageId, payloadHash).run();
}

const REGIONAL_EFFECT_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export async function reapSettledWorkstreamRegionalEffects(
  env: Env,
  limit = 500,
): Promise<number> {
  const cutoff = new Date(Date.now() - REGIONAL_EFFECT_RECEIPT_RETENTION_MS).toISOString();
  const boundedLimit = Math.max(1, Math.min(limit, 1_000));
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM workstream_regional_effect_receipts
        WHERE message_id IN (
          SELECT message_id FROM workstream_regional_effect_receipts
           WHERE acknowledged_at IS NOT NULL AND acknowledged_at < ?
           ORDER BY acknowledged_at, message_id LIMIT ?
        )`,
    ).bind(cutoff, boundedLimit),
    env.DB.prepare(
      `DELETE FROM workstream_notification_intents
        WHERE intent_id IN (
          SELECT intent_id FROM workstream_notification_intents
           WHERE state IN ('delivered', 'skipped') AND updated_at < ?
           ORDER BY updated_at, intent_id LIMIT ?
        )`,
    ).bind(cutoff, boundedLimit),
  ]);
  return results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
}

export async function loadWorkstreamRegionalEffect(
  env: Env,
  input: WorkstreamRegionalEffectQueueMessage,
): Promise<WorkstreamRegionalEffectEnvelope | null> {
  const wake = WorkstreamRegionalEffectQueueMessageSchema.parse(input);
  const objectName = workstreamDOName(wake.region, wake.workspaceId, wake.workstreamId);
  const workstream = await durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    wake.workspaceId,
    objectName,
  );
  const loaded = await workstream.loadRegionalEffect({
    messageId: wake.messageId,
    payloadHash: wake.payloadHash,
  });
  // A newer coalesced sidebar version or a prior acknowledgement may have
  // removed this row after the wake-up was queued. There is nothing left for
  // this delivery to do, and retrying it cannot recreate the superseded row.
  if (!loaded) return null;
  const envelope = WorkstreamRegionalEffectEnvelopeSchema.parse(loaded);
  if (
    envelope.region !== wake.region
    || envelope.workspaceId !== wake.workspaceId
    || envelope.workstreamId !== wake.workstreamId
    || envelope.generation !== wake.generation
    || envelope.messageId !== wake.messageId
    || envelope.payloadHash !== wake.payloadHash
  ) throw new Error("workstream_effect_fetch_identity_mismatch");
  return envelope;
}
