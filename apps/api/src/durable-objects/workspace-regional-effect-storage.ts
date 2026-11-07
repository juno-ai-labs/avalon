import type {
  WorkspaceRegionalEffectApplyRequest,
  WorkspaceRegionalEffectApplyResult,
} from "./workspace-directory-protocol";
import { isPersonNotificationEffect } from "@rally/contracts/conversation-effects";

// Conversation-parent effect receipts are a replay fence, not history. After this
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

/**
 * Apply one Channel or Space parent's activity/mention effect and its replay
 * receipt in a single WorkspaceDO transaction. Current D1 identity (surviving actor and
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
    // An `activity_event` fed the Activity log, which is retired (plan step
    // C-2): it is acknowledged by the receipt below and stored nowhere.
    if (effect.kind === "activity_event") {
      // Nothing to store.
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
