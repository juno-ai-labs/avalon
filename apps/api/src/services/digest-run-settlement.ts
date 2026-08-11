import type { Env } from "../env";
import { nowIso } from "@avalon/db";
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
}
