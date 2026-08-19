import { nowIso } from "@avalon/db";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import {
  WorkstreamMentionNotificationEffectSchema,
  WorkstreamRegionalEffectEnvelopeSchema,
  WorkstreamRegionalEffectQueueMessageSchema,
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffectEnvelope,
  type WorkstreamRegionalEffectQueueMessage,
} from "../durable-objects/workstream-regional-effect";
import { workspaceDOName, workstreamDOName } from "../durable-objects/names";
import {
  WorkspaceDirectoryApplyResultSchema,
  WorkspaceDirectoryNotificationStateSchema,
} from "../durable-objects/workspace-directory-protocol";
import { sendWorkstreamMentionEmail } from "./mention-email-service";
import { sendWorkstreamMentionSlack } from "./slack-mention-service";
import { enqueueMentionOpportunitySnapshot } from "./work-opportunity-batching";
import { publishWorkspaceSync } from "./workspace-realtime-service";
import { withWorkspaceRuntimeDatabase, workspaceRegionalDatabase } from "./workspace-runtime-database";
import { refreshWorkspaceSchedulerAlarm } from "./workstream-wakeup-service";

function workspaceTopicsForEffect(
  effect: WorkstreamRegionalEffectEnvelope["effect"],
) {
  if (effect.kind === "activity_event") {
    return ["activity", "work_opportunities"] as const;
  }
  return ["activity", "workstream_directory"] as const;
}

interface EffectReceiptRow {
  message_id: string;
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

export function isWorkspaceDirectoryEffect(
  effect: WorkstreamRegionalEffectEnvelope["effect"],
): effect is Extract<WorkstreamRegionalEffectEnvelope["effect"], {
  kind: "directory_common" | "directory_user" | "suggestion_feedback";
}> {
  return effect.kind === "directory_common"
    || effect.kind === "directory_user"
    || effect.kind === "suggestion_feedback";
}

/** Apply one unordered, at-least-once Queue delivery to WorkspaceDO. */
export async function applyQueuedWorkspaceDirectoryEffect(
  env: Env,
  input: WorkstreamRegionalEffectEnvelope,
): Promise<void> {
  const message = WorkstreamRegionalEffectEnvelopeSchema.parse(input);
  if (!isWorkspaceDirectoryEffect(message.effect)) {
    throw new Error("non_workspace_effect_misdirected_to_workspace_do");
  }
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    message.workspaceId,
    workspaceDOName(message.region, message.workspaceId),
  );
  const result = WorkspaceDirectoryApplyResultSchema.parse(
    await workspace.applyWorkstreamDirectoryEffects({
      workspaceId: message.workspaceId,
      envelopes: [message],
    }),
  );
  if (result.accepted.length !== 1
    || result.accepted[0]?.messageId !== message.messageId
    || result.accepted[0]?.payloadHash !== message.payloadHash) {
    throw new Error("workspace_directory_effect_ack_incomplete");
  }
}

/**
 * Apply one WorkstreamDO activity/mention effect to the regional delivery plane.
 * Product state commits idempotently in WorkspaceDO before the thin D1 Queue
 * receipt; a crash between those authorities retries the same event or intent
 * identity. Directory effects never enter here.
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
    `SELECT generation, state FROM workstream_authority_routes
      WHERE workspace_id = ? AND workstream_id = ?`,
  ).bind(message.workspaceId, message.workstreamId).first<{ generation: number; state: string }>();
  if (route?.state === "active" && route.generation > message.generation) {
    // A previous authority generation can still have Queue messages in flight.
    // Its state was superseded at cutover, so acknowledging it is the only
    // terminal and safe outcome; applying it would regress the current owner.
    return { replayed: true, notificationIntentId: null };
  }
  if (route?.state !== "active" || route.generation !== message.generation) {
    throw new Error("workstream_effect_route_not_active");
  }

  const receipt = await env.DB.prepare(
    `SELECT message_id, payload_hash FROM workstream_regional_effect_receipts
      WHERE message_id = ?
         OR (workstream_id = ? AND generation = ? AND partition_key = ? AND source_version = ?)
      ORDER BY CASE WHEN message_id = ? THEN 0 ELSE 1 END
      LIMIT 1`,
  ).bind(
    message.messageId,
    message.workstreamId,
    message.generation,
    message.partitionKey,
    message.sourceVersion,
    message.messageId,
  ).first<EffectReceiptRow>();
  if (receipt) {
    if (receipt.payload_hash !== message.payloadHash) {
      throw new Error("workstream_effect_receipt_hash_conflict");
    }
    if (receipt.message_id !== message.messageId) {
      await env.DB.prepare(
        `UPDATE workstream_regional_effect_receipts SET message_id = ? WHERE message_id = ?`,
      ).bind(message.messageId, receipt.message_id).run();
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
      const workspace = await durableObjectStubForWorkspace(
        env,
        env.WORKSPACE_DOS,
        message.workspaceId,
        workspaceDOName(message.region, message.workspaceId),
      );
      const activityEventId = await workspace.recordActivityEvent({
        workspaceId: message.workspaceId,
        eventId: effect.eventId,
        eventType: effect.eventType,
        subjectType: "workstream",
        subjectId: message.workstreamId,
        subjectSequenceNumber: effect.subjectSequenceNumber,
        actorType: effect.actorType,
        actorUserId: currentActor?.id ?? null,
        actorLabel: effect.actorLabel,
        title: effect.title,
        body: effect.body,
        canonicalUrl: effect.canonicalUrl,
        audience: { kind: "workstream", workstreamId: message.workstreamId },
        digestible: effect.digestible,
        occurredAt: effect.occurredAt,
        sourceKind: effect.sourceKind,
        sourceId: effect.sourceId,
        dedupeKey: effect.dedupeKey,
        metadata: effect.metadata,
        targets: effect.targets.filter((target) => targetUserIds.has(target.userId)),
      });
      if (activityEventId !== effect.eventId) {
        throw new Error("workstream_effect_activity_id_conflict");
      }
      if (effect.sourceKind === "workstream_message" && effect.sourceId && targetUserIds.size > 0) {
        await enqueueMentionOpportunitySnapshot(env, {
          workspaceId: message.workspaceId,
          messageId: effect.sourceId,
          targetUserIds: [...targetUserIds],
          occurredAt: effect.occurredAt,
          inputCharacters: effect.body.length,
        });
      }
      await env.DB.batch([receiptStatement]);
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
      const workspaceEnv = withWorkspaceRuntimeDatabase(env, message.workspaceId);
      const existing = await workspaceEnv.DB.prepare(
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
      await workspaceEnv.DB.prepare(
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
        ).run();
      // The regional receipt is only a Queue/control-plane acknowledgement.
      // Product delivery state committed in WorkspaceDO first, so a crash here
      // replays into the same intent rather than losing the notification.
      await receiptStatement.run();
      await publishWorkspaceSync(env, message.workspaceId, workspaceTopicsForEffect(message.effect));
      return { replayed: false, notificationIntentId: effect.intentId };
    }
  }
}

/** Resolve current regional identity/delivery state and execute one intent. */
export async function processWorkstreamNotificationIntent(
  env: Env,
  workspaceId: string,
  intentId: string,
): Promise<"delivered" | "skipped" | "busy"> {
  env = withWorkspaceRuntimeDatabase(env, workspaceId);
  const leaseId = uuidV7();
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
    if (!settled) return "skipped";
    if (settled.state === "skipped") {
      await refreshWorkspaceSchedulerAlarm(env, workspaceId);
      return "skipped";
    }
    if (settled.state === "delivered") {
      // A prior delivery may have committed before scheduler refresh failed.
      // Retrying the Queue item repairs that alarm edge without re-sending.
      await refreshWorkspaceSchedulerAlarm(env, workspaceId);
      return "delivered";
    }
    return "busy";
  }

  const intent = await env.DB.prepare(
    `SELECT intent_id, workspace_id, workstream_id, recipient_user_id,
            source_generation, required_directory_version, payload_json
       FROM workstream_notification_intents
      WHERE intent_id = ? AND workspace_id = ? AND lease_id = ?`,
  ).bind(intentId, workspaceId, leaseId).first<Omit<
    NotificationIntentRow,
    "recipient_email" | "recipient_name" | "workspace_name"
  >>();
  const identity = intent ? await workspaceRegionalDatabase(env).prepare(
    `SELECT user.email AS recipient_email, user.name AS recipient_name,
            workspace.name AS workspace_name
       FROM users user JOIN workspaces workspace ON workspace.id = ?
       JOIN workspace_members member ON member.workspace_id = workspace.id
        AND member.user_id = user.id AND member.status = 'active'
      WHERE user.id = ?`,
  ).bind(workspaceId, intent.recipient_user_id).first<Pick<
    NotificationIntentRow,
    "recipient_email" | "recipient_name" | "workspace_name"
  >>() : null;
  const row: NotificationIntentRow | null = intent && identity ? { ...intent, ...identity } : null;
  if (!row) {
    await settleNotificationIntent(env, workspaceId, intentId, leaseId, "skipped");
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
    await settleNotificationIntent(env, workspaceId, intentId, leaseId, "skipped");
    return "skipped";
  }

  const effect = WorkstreamMentionNotificationEffectSchema.parse(JSON.parse(row.payload_json));
  if (effect.recipientUserId === effect.authorUserId) {
    await settleNotificationIntent(env, workspaceId, intentId, leaseId, "skipped");
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
    await settleNotificationIntent(env, workspaceId, intentId, leaseId, "delivered");
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
  workspaceId: string,
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
  await refreshWorkspaceSchedulerAlarm(env, workspaceId);
}

export async function acknowledgeWorkstreamRegionalEffect(
  env: Env,
  message: WorkstreamRegionalEffectEnvelope,
): Promise<void> {
  await acknowledgeWorkstreamOutboxEffect(env, message);
  await markWorkstreamRegionalEffectAcknowledged(env, message.messageId, message.payloadHash);
}

/** Remove an acknowledged DO outbox row without creating a regional D1 receipt. */
export async function acknowledgeWorkstreamOutboxEffect(
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
  const result = await env.DB.prepare(
    `DELETE FROM workstream_regional_effect_receipts
      WHERE message_id IN (
        SELECT message_id FROM workstream_regional_effect_receipts
         WHERE acknowledged_at IS NOT NULL AND acknowledged_at < ?
         ORDER BY acknowledged_at, message_id LIMIT ?
      )`,
  ).bind(cutoff, boundedLimit).run();
  return Number(result.meta.changes ?? 0);
}

/** Reap terminal mention intents inside the one WorkspaceDO that owns them. */
export async function reapSettledWorkspaceNotificationIntents(
  env: Env,
  workspaceId: string,
  limit = 500,
): Promise<number> {
  const workspaceEnv = withWorkspaceRuntimeDatabase(env, workspaceId);
  const cutoff = new Date(Date.now() - REGIONAL_EFFECT_RECEIPT_RETENTION_MS).toISOString();
  const boundedLimit = Math.max(1, Math.min(limit, 1_000));
  const result = await workspaceEnv.DB.prepare(
    `DELETE FROM workstream_notification_intents
      WHERE intent_id IN (
        SELECT intent_id FROM workstream_notification_intents
         WHERE workspace_id = ? AND state IN ('delivered', 'skipped') AND updated_at < ?
         ORDER BY updated_at, intent_id LIMIT ?
      )`,
  ).bind(workspaceId, cutoff, boundedLimit).run();
  return Number(result.meta.changes ?? 0);
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
  // A prior acknowledgement may have removed this row after a duplicate
  // wake-up was queued. There is nothing left for this delivery to do, and
  // retrying it cannot recreate an acknowledged row.
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
