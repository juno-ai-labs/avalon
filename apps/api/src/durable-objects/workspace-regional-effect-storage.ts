import type {
  WorkspaceRegionalEffectApplyRequest,
  WorkspaceRegionalEffectApplyResult,
} from "./workspace-directory-protocol";
import { isPersonNotificationEffect } from "@rally/contracts/conversation-effects";

// WorkstreamDO effect receipts are a replay fence, not history. After this
// window a redelivery falls back to the idempotent product guards
// (generation/waterline, event dedupe key, intent identity) instead.
export const WORKSTREAM_EFFECT_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Record one effect receipt and age the oldest ones out past retention. */
export function insertWorkstreamEffectReceipt(
  storage: DurableObjectStorage,
  messageId: string,
  workstreamId: string,
  payloadHash: string,
  now: number,
): void {
  storage.sql.exec(
    `INSERT INTO workspace_workstream_effect_receipts
       (message_id, workstream_id, payload_hash, received_at)
     VALUES (?, ?, ?, ?)`,
    messageId,
    workstreamId,
    payloadHash,
    now,
  );
  storage.sql.exec(
    `DELETE FROM workspace_workstream_effect_receipts
      WHERE message_id IN (
        SELECT message_id FROM workspace_workstream_effect_receipts
         WHERE received_at < ?
         ORDER BY received_at, message_id LIMIT 100
      )`,
    now - WORKSTREAM_EFFECT_RECEIPT_RETENTION_MS,
  );
}

function epochMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("workstream_effect_timestamp_invalid");
  }
  return parsed;
}

/**
 * Apply one WorkstreamDO activity/mention effect and its replay receipt in a
 * single WorkspaceDO transaction. Current D1 identity (surviving actor and
 * targets, mention-recipient membership) arrives as data on the request; this
 * function never reads outside the object, so the effect and the receipt that
 * acknowledges it can never commit separately.
 */
export function applyWorkstreamRegionalEnvelope(
  storage: DurableObjectStorage,
  request: WorkspaceRegionalEffectApplyRequest,
  now: number,
): WorkspaceRegionalEffectApplyResult {
  const envelope = request.envelope;
  const effect = envelope.effect;
  return storage.transactionSync((): WorkspaceRegionalEffectApplyResult => {
    const receipt = storage.sql.exec<{ payload_hash: string }>(
      `SELECT payload_hash FROM workspace_workstream_effect_receipts WHERE message_id = ?`,
      envelope.messageId,
    ).toArray()[0];
    if (receipt) {
      if (receipt.payload_hash !== envelope.payloadHash) {
        throw new Error("workstream_effect_receipt_hash_conflict");
      }
      return {
        replayed: true,
        // Every person notification, not only a mention. The caller schedules
        // delivery from this id, so returning null for a kind that has one
        // means a redelivery is acknowledged without anything being sent —
        // which is exactly the path a transient Slack or email failure takes
        // to get its second attempt.
        notificationIntentId: isPersonNotificationEffect(effect) ? effect.intentId : null,
      };
    }
    let notificationIntentId: string | null = null;
    if (effect.kind === "activity_event") {
      storage.sql.exec(
        `INSERT OR IGNORE INTO workspace_activity_events (
          event_id, event_type, subject_type, subject_id, subject_sequence_number,
          actor_type, actor_user_id, actor_label, title, body, canonical_url,
          audience_kind, audience_user_id, audience_workstream_id, digestible,
          occurred_at, created_at, source_kind, source_id, dedupe_key, metadata_json
        ) VALUES (?, ?, 'workstream', ?, ?, ?, ?, ?, ?, ?, ?, 'workstream', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        effect.eventId,
        effect.eventType,
        envelope.parentId,
        effect.subjectSequenceNumber ?? null,
        effect.actorType,
        request.actorUserId,
        effect.actorLabel,
        effect.title,
        effect.body,
        effect.canonicalUrl,
        envelope.parentId,
        effect.digestible ? 1 : 0,
        epochMs(effect.occurredAt),
        now,
        effect.sourceKind,
        effect.sourceId,
        effect.dedupeKey,
        JSON.stringify(effect.metadata ?? {}),
      );
      const canonical = storage.sql.exec<{ event_id: string }>(
        `SELECT event_id FROM workspace_activity_events WHERE dedupe_key = ?`,
        effect.dedupeKey,
      ).one().event_id;
      if (canonical !== effect.eventId) {
        throw new Error("workstream_effect_activity_id_conflict");
      }
      const currentTargets = new Set(request.targetUserIds);
      for (const target of effect.targets) {
        if (!currentTargets.has(target.userId)) continue;
        storage.sql.exec(
          `INSERT OR IGNORE INTO workspace_activity_event_targets
             (event_id, user_id, relation, created_at) VALUES (?, ?, ?, ?)`,
          canonical,
          target.userId,
          target.relation,
          now,
        );
      }
    } else if (isPersonNotificationEffect(effect)) {
      if (request.recipientIsActiveMember) {
        // A mention is identified by the message that carried it; being added
        // has no message, so the effect names its own source. Both land in
        // `source_message_id`, which together with the recipient and the kind
        // is what makes a redelivery of either one intent rather than two.
        const notificationKind = effect.kind === "mention_notification" ? "mention" : "participant_added";
        const sourceId = effect.kind === "mention_notification" ? effect.messageId : effect.sourceId;
        const existing = storage.sql.exec<{ intent_id: string; payload_hash: string }>(
          `SELECT intent_id, payload_hash FROM workstream_notification_intents
            WHERE intent_id = ?
               OR (source_message_id = ? AND recipient_user_id = ?
                   AND notification_kind = ?)`,
          effect.intentId,
          sourceId,
          effect.recipientUserId,
          notificationKind,
        ).toArray()[0];
        if (
          existing
          && (existing.intent_id !== effect.intentId
            || existing.payload_hash !== envelope.payloadHash)
        ) {
          throw new Error("workstream_effect_notification_id_conflict");
        }
        const at = new Date(now).toISOString();
        storage.sql.exec(
          `INSERT INTO workstream_notification_intents
             (intent_id, workspace_id, workstream_id, recipient_user_id,
              source_message_id, source_generation, source_version,
              required_directory_version, notification_kind, payload_json,
              payload_hash, state, attempts,
              lease_id, lease_expires_at, last_error_code, created_at, updated_at,
              delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0,
                   NULL, NULL, NULL, ?, ?, NULL)
           ON CONFLICT(intent_id) DO NOTHING`,
          effect.intentId,
          envelope.workspaceId,
          envelope.parentId,
          effect.recipientUserId,
          sourceId,
          envelope.generation,
          envelope.sourceVersion,
          envelope.requiredProjectionVersion,
          notificationKind,
          JSON.stringify(effect),
          envelope.payloadHash,
          at,
          at,
        );
        notificationIntentId = effect.intentId;
      }
    } else {
      throw new Error("workspace_regional_effect_kind_invalid");
    }
    insertWorkstreamEffectReceipt(
      storage,
      envelope.messageId,
      envelope.parentId,
      envelope.payloadHash,
      now,
    );
    return { replayed: false, notificationIntentId };
  });
}
