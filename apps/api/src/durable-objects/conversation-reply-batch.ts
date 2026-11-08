import type { ActivityParentKind } from "@rally/contracts";
import type { ConversationEffect } from "@rally/contracts/conversation-effects";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { z } from "zod";

import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { logInfo, logWarn } from "../observability/logger";
import { enqueueNotice } from "../services/push-delivery-service";
import { chosenChannels } from "./member-preferences";
import type { ScheduledAlarm, ScheduledAlarmStore } from "./scheduled-alarms";
import type { NoteActivity } from "./workspace-activity";
import type { ParentNotice } from "./workspace-notification-intent-protocol";
import { recordParentNotice } from "./workspace-notification-intent-storage";

/**
 * A person's reply in a Canvas's Chat or a Sidekick's shared conversation,
 * batched per conversation: the first reply arms one `reply_batch` alarm entry
 * `REPLY_BATCH_SECONDS` out, every reply until it runs joins it, and when it
 * runs each recipient is told about the newest reply that named them, once.
 * A recipient told about this conversation within
 * `CONVERSATION_ALERT_COOLDOWN_MS` is recorded but not pushed. Their Activity
 * row is updated in place while it is unseen. `docs/push-notifications.md`
 * owns the rule.
 */
export const REPLY_BATCH_ALARM_KIND = "reply_batch";

/**
 * The team's numbers for the Thread-era reply batch and alert cooldown
 * (`git show 3df4150^:apps/api/src/durable-objects/workspace-activity-push.ts`,
 * the 2026-10-20 entry of docs/push-notifications.md), carried unchanged
 * rather than set again here: collect a short burst of replies into one
 * notice, then space ordinary interruptions.
 */
export const REPLY_BATCH_SECONDS = 15;
export const CONVERSATION_ALERT_COOLDOWN_MS = 120_000;

type NewMessageEffect = Extract<ConversationEffect, { kind: "new_message_notification" }>;

const BatchedMessageSchema = z.strictObject({
  authorUserId: z.string().min(1),
  authorName: z.string(),
  text: z.string(),
  attentionOrdinal: z.number().int().nonnegative(),
  transcriptSequence: z.number().int().positive(),
});

/** One open batch: the replies still owed to someone, and which one each recipient is owed (their newest). */
const ReplyBatchSchema = z.strictObject({
  parentKind: z.enum(["canvas", "automation"]),
  parentId: z.string().min(1),
  messages: z.record(z.string(), BatchedMessageSchema),
  recipients: z.record(z.string(), z.string()),
});
type ReplyBatch = z.infer<typeof ReplyBatchSchema>;

/** `<parentId>:<dueAt>`: one entry per batch, so a reply after a batch ran opens a new one rather than joining one being sent. */
function batchKeyPrefix(parentId: string): string {
  return `${parentId}:`;
}

/**
 * Add one reply to its conversation's open batch, or open one. Called in the
 * transaction that received the effect, so the reply and its place in a batch
 * commit together. The author is dropped from what the batch owes them: they
 * have just written in the conversation, which reads it.
 */
export function addToReplyBatch(
  alarms: ScheduledAlarmStore,
  parent: { kind: ActivityParentKind; id: string },
  effect: NewMessageEffect,
  now: number,
): void {
  const prefix = batchKeyPrefix(parent.id);
  const open = alarms.list(REPLY_BATCH_ALARM_KIND).find((alarm) => alarm.key.startsWith(prefix) && alarm.dueAt > now);
  const batch: ReplyBatch = open?.payload ? ReplyBatchSchema.parse(JSON.parse(open.payload))
    : { parentKind: parent.kind, parentId: parent.id, messages: {}, recipients: {} };
  delete batch.recipients[effect.authorUserId];
  batch.messages[effect.messageId] = {
    authorUserId: effect.authorUserId, authorName: effect.authorNameSnapshot, text: effect.messageText,
    attentionOrdinal: effect.attentionOrdinal, transcriptSequence: effect.transcriptSequence,
  };
  for (const userId of effect.recipientUserIds) {
    const owed = batch.recipients[userId];
    // The Queue does not order effects: a reply delivered late never replaces a newer one.
    if (owed === undefined || (batch.messages[owed]?.transcriptSequence ?? 0) < effect.transcriptSequence) {
      batch.recipients[userId] = effect.messageId;
    }
  }
  const owedIds = new Set(Object.values(batch.recipients));
  for (const messageId of Object.keys(batch.messages)) if (!owedIds.has(messageId)) delete batch.messages[messageId];
  const dueAt = open?.dueAt ?? now + REPLY_BATCH_SECONDS * 1_000;
  alarms.schedule({ kind: REPLY_BATCH_ALARM_KIND, key: open?.key ?? `${prefix}${dueAt}`, dueAt, payload: JSON.stringify(batch) }, now);
}

/** What sending a batch needs from the Organization object that holds it. */
export interface ReplyBatchHost {
  env: Env;
  storage: DurableObjectStorage;
  noteActivityChanged: NoteActivity;
}

/** A Canvas's or Sidekick's row as a notice needs it; null once it is gone. */
function parentRow(sql: SqlStorage, batch: ReplyBatch): { workspaceId: string; title: string; generation: number } | null {
  const row = batch.parentKind === "canvas"
    ? sql.exec<{ workspace_id: string; title: string; authority_generation: number }>(
      `SELECT workspace_id, title, authority_generation FROM canvas_directory WHERE canvas_id = ?`, batch.parentId).toArray()[0]
    : sql.exec<{ workspace_id: string; title: string; authority_generation: number }>(
      `SELECT workspace_id, title, authority_generation FROM automation_directory
        WHERE automation_id = ? AND lifecycle <> 'deleted'`, batch.parentId).toArray()[0];
  return row ? { workspaceId: row.workspace_id, title: row.title || (batch.parentKind === "canvas" ? "Canvas" : "Sidekick"), generation: row.authority_generation } : null;
}

/**
 * Send one batch: for each recipient a `new_message` intent about the newest
 * reply they are owed, and their Activity row, then each push. The cooldown
 * is the person's last delivered reply notice in this conversation
 * (`delivered_at`); within it the intent is `skipped`
 * (`conversation_alert_cooldown`) and their row still moves. A retried entry
 * writes nothing twice and enqueues again, which the push receipts make
 * harmless.
 */
export async function sendReplyBatch(host: ReplyBatchHost, alarm: ScheduledAlarm): Promise<void> {
  const parsed = ReplyBatchSchema.safeParse(alarm.payload === null ? null : JSON.parse(alarm.payload));
  if (!parsed.success) {
    logWarn(host.env, "reply_batch_rejected", { alarm_key: alarm.key, code: zodDiagnosticCode(parsed.error, "reply_batch") });
    return;
  }
  const batch = parsed.data;
  const parent = parentRow(host.storage.sql, batch);
  if (!parent) {
    logInfo(host.env, "reply_batch_skipped", { parent_id: batch.parentId, parent_kind: batch.parentKind, reason: "parent_missing" });
    return;
  }
  const notices = await Promise.all(Object.entries(batch.recipients).map(async ([recipientUserId, messageId]) => {
    const message = batch.messages[messageId]!;
    const notice: ParentNotice = {
      kind: "new_message", parentId: batch.parentId, parentTitle: parent.title, messageId,
      messageSequence: message.transcriptSequence, authorName: message.authorName, text: message.text,
    };
    const payloadJson = JSON.stringify(notice);
    return { recipientUserId, messageId, message, payloadJson, payloadHash: await sha256(payloadJson) };
  }));
  const now = Date.now();
  const cooledSince = new Date(now - CONVERSATION_ALERT_COOLDOWN_MS).toISOString();
  const recorded = host.storage.transactionSync(() => notices.map((notice) => {
    const cooled = host.storage.sql.exec(
      `SELECT 1 FROM workstream_notification_intents
        WHERE recipient_user_id = ? AND notification_kind = 'new_message' AND workstream_id = ? AND delivered_at >= ?
        LIMIT 1`,
      notice.recipientUserId, batch.parentId, cooledSince,
    ).toArray().length > 0;
    return recordParentNotice(host.storage, {
      workspaceId: parent.workspaceId, parentId: batch.parentId, generation: parent.generation, kind: "new_message",
      recipientUserId: notice.recipientUserId, intentId: `new_message:${notice.messageId}:${notice.recipientUserId}`,
      sourceId: `new_message:${notice.messageId}`, payloadJson: notice.payloadJson, payloadHash: notice.payloadHash,
      skipCode: cooled ? "conversation_alert_cooldown" : null, collapse: true,
      activity: {
        parentKind: batch.parentKind, parentId: batch.parentId, substreamId: "0", messageId: notice.messageId,
        messageSequence: notice.message.transcriptSequence, runId: null, actorKind: "person", actorId: notice.message.authorUserId,
        text: notice.message.text, attentionOrdinal: notice.message.attentionOrdinal,
      },
    }, now, host.noteActivityChanged);
  }));
  for (const [index, intent] of recorded.entries()) {
    if (!intent.push) continue;
    const recipientUserId = notices[index]!.recipientUserId;
    await enqueueNotice(host.env, { workspaceId: parent.workspaceId, recipientUserId, intentId: intent.intentId },
      chosenChannels(host.storage.sql, recipientUserId, "new_message"));
  }
  logInfo(host.env, "reply_batch_sent", { parent_id: batch.parentId, parent_kind: batch.parentKind,
    recipients: recorded.length, pushed: recorded.filter((intent) => intent.push).length });
}
