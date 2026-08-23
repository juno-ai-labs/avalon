import { asUserId, asWorkspaceId } from "@avalon/contracts";

import type { Env } from "../env";
import { newId, nowIso } from "@avalon/db";
import { deliverDigest } from "./digest-delivery-service";
import {
  emitProductUsageTelemetry,
  resourceTelemetryEventId,
  telemetryCountBucket,
} from "../telemetry/product-usage";
import { createMessageObjectPort } from "../runtime/message-port";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "./workspace-runtime-database";

/**
 * Settles one digest run: record what it wrote, then send it.
 *
 * This is separate from the run service because the two halves belong to
 * different owners. Starting a digest is the workspace scheduler's job and
 * happens in a Durable Object alarm; finishing one is the workflow's, and runs
 * inside a durable step that retries. Keeping them apart means neither has to
 * import the other's machinery, and the retry semantics of each stay their own.
 */

/**
 * The shortest final message this will accept as a digest.
 *
 * A bound on the one failure here cannot detect on its own. Settlement mails
 * the run's last message and has no way to tell a digest from a sign-off, so a
 * run that ended "Outcome: digest written (id …)" — 120 characters — settled as
 * `delivered` and advanced `cursor_through` past events nobody was ever told
 * about. That loss is silent and permanent: only settled deliveries move the
 * cursor, so the window never comes back.
 *
 * This is a floor on *implausibility*, not a judgement about quality. A run only
 * reaches settlement when the window held at least one event, and the brief
 * mandates an opening sentence, `## ` sections, and `- ` bullets, so a real
 * digest clears this by an order of magnitude. It is deliberately not a check
 * that the text *looks* like a digest — that is the send-time heuristic this
 * subsystem already rejected once; it only refuses text that cannot be one.
 *
 * The asymmetry is the whole argument. Rejecting a real digest costs one delayed
 * occurrence, and the events return in the next one because a failed delivery
 * does not move the cursor. Accepting a receipt costs the window forever.
 */
const MINIMUM_DIGEST_CHARACTERS = 200;

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

async function emitDigestTerminal(env: Env, delivery: DigestDeliveryRow, result: "success" | "failed"): Promise<void> {
  const [targets, prior] = await Promise.all([
    env.DB.prepare(
      `SELECT DISTINCT target_type FROM digest_delivery_targets target
       JOIN digest_deliveries delivery ON delivery.digest_schedule_id = target.digest_schedule_id
       WHERE delivery.id = ? ORDER BY target_type LIMIT 2`,
    ).bind(delivery.id).all<{ target_type: "email" | "slack_agent_dm" }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM digest_deliveries current
       JOIN digest_deliveries previous ON previous.digest_schedule_id = current.digest_schedule_id
       WHERE current.id = ? AND previous.status = 'delivered' AND previous.id <> current.id`,
    ).bind(delivery.id).first<{ count: number }>(),
  ]);
  await emitProductUsageTelemetry(env, {
    workspaceId: asWorkspaceId(delivery.workspace_id),
    userId: asUserId(delivery.user_id),
    name: "digest_delivery_terminal",
    properties: {
      deliveryId: delivery.id,
      result,
      activityCount: telemetryCountBucket(Number(delivery.event_count)),
      targetTypes: targets.results.map((row) => row.target_type),
      firstDelivery: Number(prior?.count ?? 0) === 0,
    },
    operationId: delivery.id,
    eventId: resourceTelemetryEventId(delivery.id, 10),
  }).catch(() => undefined);
}

export async function settleDigestRun(
  env: Env,
  workspaceId: string,
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
  env = withWorkspaceRuntimeDatabase(env, workspaceId);
  const localDelivery = await env.DB.prepare(
    `SELECT id, workspace_id, user_id, planned_for, event_count, highlight_count, status
       FROM digest_deliveries WHERE id = ? AND workspace_id = ?`,
  ).bind(deliveryId, workspaceId).first<Omit<
    DigestDeliveryRow,
    "timezone" | "user_name" | "workspace_name"
  >>();
  const identity = localDelivery ? await workspaceRegionalDatabase(env).prepare(
    `SELECT u.timezone, u.name AS user_name, w.name AS workspace_name
       FROM users u JOIN workspaces w ON w.id = ? WHERE u.id = ?`,
  ).bind(workspaceId, localDelivery.user_id).first<Pick<
    DigestDeliveryRow,
    "timezone" | "user_name" | "workspace_name"
  >>() : null;
  const delivery: DigestDeliveryRow | null = localDelivery && identity
    ? { ...localDelivery, ...identity }
    : null;
  if (!delivery) return;
  // Already settled by an earlier attempt of this step. The cursor has moved and
  // the destinations have their copy; re-sending would duplicate it.
  if (delivery.status === "delivered" || delivery.status === "failed") return;

  const summary = text?.trim() ?? "";
  if (outcomeStatus !== "completed" || summary.length < MINIMUM_DIGEST_CHARACTERS) {
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
    await emitDigestTerminal(env, delivery, "failed").catch(() => undefined);
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
    await emitDigestTerminal(env, delivery, "failed").catch(() => undefined);
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
  await emitDigestTerminal(env, delivery, "success").catch(() => undefined);
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
 *
 * The `COALESCE` covers the deploy window running the other way. Migrations land
 * before either Worker deploys, so the *previous* Worker claims deliveries into
 * the new schema without writing the new column; resolving through
 * `workstream_id` alone would drop the note for every one of them and invert the
 * signal above — the digest went out, and its transcript would say it did not.
 * `harness_runs` is what the migration's own backfill reads for exactly the same
 * reason, and it is only ever consulted here when the column is NULL.
 */
async function noteDeliveryInTranscript(
  env: Env,
  deliveryId: string,
  destinations: number,
): Promise<void> {
  const at = nowIso();
  const delivery = await env.DB.prepare(
    `SELECT workspace_id, workstream_id FROM digest_deliveries WHERE id = ?`,
  ).bind(deliveryId).first<{ workspace_id: string; workstream_id: string | null }>();
  if (!delivery?.workstream_id) return;
  await createMessageObjectPort(env, delivery.workspace_id, delivery.workstream_id)
    .appendMessage({
      messageId: newId(),
      clientMessageId: `digest-delivered:${deliveryId}`,
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      messageType: "system",
      text: `Delivered to ${destinations} destination${destinations === 1 ? "" : "s"}.`,
      structuredContentJson: null,
      producedByRunId: null,
      now: Date.parse(at),
    });
}
