import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { z } from "zod";

import { diagnosticErrorCode } from "../observability/logger";

import {
  ExternalInstallationIdSchema,
  ExternalPathSchema,
} from "./workspace-external-binding-protocol";
import { externalPathKey } from "./workspace-external-binding-storage";

/**
 * A run child's outbound bindings, on their way to WorkspaceDO.
 *
 * When a Sidekick run sends a message whose replies reach Rally's ingress (a
 * Slack workspace-bot send), the reply thread must route back to that run.
 * The binding is written here, into the conversation's own `durable_outbox`,
 * in the same transaction that completes the send's tool receipt, so a send
 * that succeeded cannot lose its binding and a send with no receipt has none.
 * The alarm then delivers it to WorkspaceDO, which owns the binding table;
 * WorkspaceDO's write is idempotent, so a redelivery is `already_bound`.
 *
 * A reply that arrives before this row drains finds no binding and follows
 * the one-to-one DM policy. See docs/external-conversation-bindings.md.
 */
export const EXTERNAL_BINDING_OUTBOX_CHANNEL = "external_conversation_binding_v1";

/**
 * What a send reports: where its replies will arrive. The target is not
 * carried: it is the run child whose receipt commits the row, which the
 * child reads from its own identity when it delivers.
 */
export const OutboundExternalBindingSchema = z.strictObject({
  installationId: ExternalInstallationIdSchema,
  path: ExternalPathSchema,
});
export type OutboundExternalBinding = z.infer<typeof OutboundExternalBindingSchema>;

const OutboxPayloadSchema = OutboundExternalBindingSchema.extend({
  at: z.string().datetime({ offset: true }),
}).strict();
type OutboxPayload = z.infer<typeof OutboxPayloadSchema>;

/** Enqueue inside the caller's transaction; a repeat of the same binding is a no-op. */
export function enqueueExternalBindingInTransaction(
  sql: SqlStorage,
  input: OutboxPayload,
  now: number,
): void {
  const payload = OutboxPayloadSchema.parse(input);
  const messageId = `external-binding:${payload.installationId}:${externalPathKey(payload.path)}`;
  sql.exec(
    `INSERT INTO durable_outbox
       (message_id, channel, destination_kind, destination_id, partition_key,
        source_version, source_epoch, contract_version, payload_json, payload_ref,
        payload_hash, state, attempts, not_before, created_at, acked_at)
     VALUES (?, ?, 'durable_object', ?, ?, 1, 0, 1, ?, NULL, ?, 'pending', 0, ?, ?, NULL)
     ON CONFLICT(message_id) DO NOTHING`,
    messageId,
    EXTERNAL_BINDING_OUTBOX_CHANNEL,
    payload.installationId,
    payload.installationId,
    JSON.stringify(payload),
    messageId,
    now,
    now,
  );
}

export function nextExternalBindingDueAt(sql: SqlStorage): number | null {
  return sql.exec<{ due_at: number | null }>(
    `SELECT MIN(not_before) AS due_at FROM durable_outbox
      WHERE channel = ? AND state = 'pending'`,
    EXTERNAL_BINDING_OUTBOX_CHANNEL,
  ).toArray()[0]?.due_at ?? null;
}

/** What one drain did that its caller reports: nothing here logs. */
export interface ExternalBindingDrainReport {
  /** A row that can never be delivered, parked `dead` with the reason. */
  dead: { messageId: string; code: string }[];
  /** Put off on the retry interval; the rows behind it were still tried. */
  deferred: { messageId: string; code: string }[];
}

/**
 * Deliver every due binding, deleting each row once WorkspaceDO has it.
 *
 * One row never holds up the rows behind it. A payload that does not parse
 * cannot succeed on any retry, so it is parked `dead` with its schema reason
 * rather than retried forever; a delivery that failed is put off on the same
 * retry interval as the other outbox lanes. A delivery WorkspaceDO answered
 * with `conflict` is done: the thread's first binding stands, and WorkspaceDO
 * logs it as `external_binding_outbound_conflict`.
 */
export async function drainExternalBindingOutbox(
  sql: SqlStorage,
  deliver: (payload: OutboxPayload) => Promise<unknown>,
  now = Date.now(),
): Promise<ExternalBindingDrainReport> {
  const report: ExternalBindingDrainReport = { dead: [], deferred: [] };
  const rows = sql.exec<{ message_id: string; payload_json: string }>(
    `SELECT message_id, payload_json FROM durable_outbox
      WHERE channel = ? AND state = 'pending' AND not_before <= ?
      ORDER BY created_at, message_id LIMIT 100`,
    EXTERNAL_BINDING_OUTBOX_CHANNEL,
    now,
  ).toArray();
  for (const row of rows) {
    const parsed = OutboxPayloadSchema.safeParse(safeJson(row.payload_json));
    if (!parsed.success) {
      sql.exec(
        `UPDATE durable_outbox SET state = 'dead', attempts = attempts + 1
          WHERE channel = ? AND message_id = ?`,
        EXTERNAL_BINDING_OUTBOX_CHANNEL,
        row.message_id,
      );
      report.dead.push({
        messageId: row.message_id,
        code: zodDiagnosticCode(parsed.error, "external_binding_payload") ?? "external_binding_payload_invalid",
      });
      continue;
    }
    try {
      await deliver(parsed.data);
      sql.exec(
        `DELETE FROM durable_outbox WHERE channel = ? AND message_id = ?`,
        EXTERNAL_BINDING_OUTBOX_CHANNEL,
        row.message_id,
      );
    } catch (error) {
      sql.exec(
        `UPDATE durable_outbox SET attempts = attempts + 1, not_before = ?
          WHERE channel = ? AND message_id = ?`,
        Date.now() + 5_000,
        EXTERNAL_BINDING_OUTBOX_CHANNEL,
        row.message_id,
      );
      report.deferred.push({ messageId: row.message_id, code: diagnosticErrorCode(error, "external_binding_delivery_failed") });
    }
  }
  return report;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
