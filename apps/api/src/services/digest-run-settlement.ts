import type { Env } from "../env";
import { newId, nowIso } from "@avalon/db";
import { deliverDigest } from "./digest-delivery-service";

/**
 * Settles one digest run: record what it wrote, then send it.
 *
 * This is separate from the run service because the two halves belong to
 * different owners. Starting a digest is the workspace scheduler's job and
 * happens in a Durable Object alarm; finishing one is the workflow's, and runs
 * inside a durable step that retries. Keeping them apart means neither has to
 * import the other's machinery, and the retry semantics of each stay their own.
 */

interface DigestDeliveryRow {
  id: string;
  workspace_id: string;
  user_id: string;
  planned_for: string;
  event_count: number;
  highlight_count: number;
  status: string;
  timezone: string;
  user_name: string;
  workspace_name: string;
}

export async function settleDigestRun(
  env: Env,
  deliveryId: string,
  outcomeStatus: "completed" | "needs_input" | "failed" | "stopped",
  /**
   * What the run wrote, or null when it finished without a final message. Null
   * rather than a placeholder: the caller's fallback text describes a run to a
   * person watching a work stream, and mailing it as though it were a digest
   * would consume the window and tell the recipient nothing.
   */
  text: string | null,
): Promise<void> {
  const delivery = await env.DB.prepare(
    `SELECT d.id, d.workspace_id, d.user_id, d.planned_for, d.event_count,
            d.highlight_count, d.status,
            u.timezone, u.name AS user_name, w.name AS workspace_name
       FROM digest_deliveries d
       JOIN users u ON u.id = d.user_id
       JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.id = ?`,
  ).bind(deliveryId).first<DigestDeliveryRow>();
  if (!delivery) return;
  // Already settled by an earlier attempt of this step. The cursor has moved and
  // the destinations have their copy; re-sending would duplicate it.
  if (delivery.status === "delivered" || delivery.status === "failed") return;

  const summary = text?.trim() ?? "";
  if (outcomeStatus !== "completed" || summary.length === 0) {
    // A run that could not write a digest sends nothing. The delivery is marked
    // failed rather than delivered, and because only settled deliveries advance
    // the cursor, this window is folded into the next digest rather than lost.
    await env.DB.prepare(
      `UPDATE digest_deliveries
          SET status = 'failed', error_json = ?, updated_at = ?
        WHERE id = ? AND status NOT IN ('delivered', 'failed')`,
    ).bind(
      JSON.stringify({ code: `digest_run_${outcomeStatus}`, message: "The digest run produced no summary" }),
      nowIso(),
      deliveryId,
    ).run();
    return;
  }

  await env.DB.prepare(
    "UPDATE digest_deliveries SET summary_markdown = ?, updated_at = ? WHERE id = ?",
  ).bind(summary, nowIso(), deliveryId).run();

  // Counted when the window was taken, against the events the run was actually
  // given. Recomputing it here would have to re-derive the audience filter, the
  // first-digest look-back floor, and the per-run cap to reach the same number.
  const delivered = await deliverDigest(env, {
    workspaceId: delivery.workspace_id,
    deliveryId: delivery.id,
    userId: delivery.user_id,
    recipientName: delivery.user_name,
    workspaceName: delivery.workspace_name,
    timezone: delivery.timezone,
    plannedFor: delivery.planned_for,
    bodyMarkdown: summary,
    itemCount: Number(delivery.event_count),
    highlightCount: Number(delivery.highlight_count),
  });

  // Every destination actually failed. Recording that as delivered would consume
  // the window, so the events it covered would never appear in a later digest.
  // A run where nothing was *sent* but nothing failed either — a retry finding
  // its destinations already served, or a non-production run — is not this case.
  if (delivered.delivered === 0 && delivered.failed > 0) {
    await env.DB.prepare(
      `UPDATE digest_deliveries SET status = 'failed', error_json = ?, updated_at = ?
        WHERE id = ? AND status NOT IN ('delivered', 'failed')`,
    ).bind(
      JSON.stringify({
        code: "digest_not_delivered",
        message: "No destination accepted this digest",
      }),
      nowIso(),
      deliveryId,
    ).run();
    return;
  }

  // Marked delivered only after every destination has settled, so a delivery
  // that throws mid-way is retried by the workflow step rather than recorded as
  // done. Each destination's own `last_delivered_delivery_id` keeps that retry
  // from re-sending what already landed.
  await env.DB.prepare(
    `UPDATE digest_deliveries SET status = 'delivered', updated_at = ?
      WHERE id = ? AND status NOT IN ('delivered', 'failed')`,
  ).bind(nowIso(), deliveryId).run();
  await noteDeliveryInTranscript(env, delivery.id, delivered.delivered);
}

/**
 * Records in the occurrence's work stream that this digest actually reached
 * someone.
 *
 * It no longer feeds the next run — that used to be its point, back when every
 * occurrence shared one transcript and the brief told the model to skip what
 * earlier digests had already sent; a summary followed by this row was sent, one
 * without it was not. A per-occurrence work stream ends with its own delivery,
 * so this is now for the person who opens it: a transcript ending in a summary
 * with no note is one whose digest never went anywhere, which is exactly what
 * somebody debugging a missing email is looking for.
 *
 * Resolved through `digest_deliveries.workstream_id` rather than by joining back
 * through `harness_runs`, so it still lands when the launch never recorded its
 * run id on the delivery.
 */
async function noteDeliveryInTranscript(
  env: Env,
  deliveryId: string,
  destinations: number,
): Promise<void> {
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages
         (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
          message_type, text_content, structured_content_json, sequence_number, created_at)
       SELECT ?, ?, w.workspace_id, w.id, 'system', NULL, 'system', ?, NULL,
              w.next_sequence_number, ?
         FROM workstreams w
         JOIN digest_deliveries d ON d.workstream_id = w.id
        WHERE d.id = ?
       ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
    ).bind(
      newId(),
      `digest-delivered:${deliveryId}`,
      `Delivered to ${destinations} destination${destinations === 1 ? "" : "s"}.`,
      at,
      deliveryId,
    ),
    env.DB.prepare(
      `UPDATE workstreams
          SET next_sequence_number = next_sequence_number + 1, updated_at = ?
        WHERE id = (SELECT d.workstream_id FROM digest_deliveries d WHERE d.id = ?)
          AND EXISTS (
            SELECT 1 FROM messages WHERE client_message_id = ? AND workstream_id = workstreams.id
          )`,
    ).bind(at, deliveryId, `digest-delivered:${deliveryId}`),
  ]);
}
