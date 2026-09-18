import { DigestDeliveryTargetTypeSchema, asUserId, asWorkspaceId } from "@rally/contracts";

import type { Env } from "../env";
import { newId, nowIso } from "@rally/db";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceDigestDeliveryContextSchema,
  WorkspaceDigestSettleResultSchema,
  WorkspaceDigestTerminalContextSchema,
  type WorkspaceDigestSettleResult,
} from "../durable-objects/workspace-digests-protocol";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logWarn } from "../observability/logger";
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
  workstream_id: string | null;
  timezone: string;
  user_name: string;
  workspace_name: string;
}

/** The WorkspaceDO that owns this workspace's digest tables. */
function workspaceDigests(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

async function emitDigestTerminal(env: Env, delivery: DigestDeliveryRow, result: "success" | "failed"): Promise<void> {
  const context = WorkspaceDigestTerminalContextSchema.parse(
    await (await workspaceDigests(env, delivery.workspace_id)).digestTerminalTelemetryContext({
      workspaceId: delivery.workspace_id,
      deliveryId: delivery.id,
    }),
  );
  emitProductUsageTelemetry(env, {
    workspaceId: asWorkspaceId(delivery.workspace_id),
    userId: asUserId(delivery.user_id),
    name: "digest_delivery_terminal",
    properties: {
      deliveryId: delivery.id,
      result,
      activityCount: telemetryCountBucket(Number(delivery.event_count)),
      // The object stores the type as bare text — the value list is enforced
      // on the write path, not by a CHECK — so an unknown destination is
      // filtered out rather than parsed against. A strict parse here would
      // throw the moment a third target type or a backfilled row appeared,
      // and the swallowed rejection would silently lose the whole terminal
      // event, `result` and `firstDelivery` with it.
      targetTypes: context.targetTypes.flatMap((targetType) => {
        const known = DigestDeliveryTargetTypeSchema.safeParse(targetType);
        return known.success ? [known.data] : [];
      }),
      firstDelivery: context.priorDeliveredCount === 0,
    },
    operationId: delivery.id,
    eventId: resourceTelemetryEventId(delivery.id, 10),
  });
}

/** Settle exactly once; only the attempt that wins the transition owns its side effects. */
async function settleDelivery(
  env: Env,
  workspaceId: string,
  deliveryId: string,
  status: "delivered" | "failed",
  errorJson: string | null,
): Promise<WorkspaceDigestSettleResult> {
  return WorkspaceDigestSettleResultSchema.parse(
    await (await workspaceDigests(env, workspaceId)).settleDigestDelivery({
      workspaceId,
      deliveryId,
      status,
      errorJson,
      at: nowIso(),
    }),
  );
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
  const workspace = await workspaceDigests(env, workspaceId);
  const context = WorkspaceDigestDeliveryContextSchema.parse(await workspace.digestDeliveryContext({
    workspaceId,
    deliveryId,
  }));
  const identity = context.delivery ? await workspaceRegionalDatabase(env).prepare(
    `SELECT u.timezone, u.name AS user_name, w.name AS workspace_name
       FROM users u JOIN workspaces w ON w.id = ? WHERE u.id = ?`,
  ).bind(workspaceId, context.delivery.userId).first<Pick<
    DigestDeliveryRow,
    "timezone" | "user_name" | "workspace_name"
  >>() : null;
  const delivery: DigestDeliveryRow | null = context.delivery && identity
    ? {
      id: context.delivery.id,
      workspace_id: workspaceId,
      user_id: context.delivery.userId,
      planned_for: context.delivery.plannedFor,
      event_count: context.delivery.eventCount,
      highlight_count: context.delivery.highlightCount,
      workstream_id: context.delivery.workstreamId,
      ...identity,
    }
    : null;
  if (!delivery || !context.delivery) return;
  // Already settled by an earlier attempt of this step. The cursor has moved and
  // the destinations have their copy; re-sending would duplicate it. This is a
  // fast path, not the guard — two attempts of one retried step can overlap,
  // both read an unsettled status here, and both reach the settle below. The
  // settle's own compare-and-set is what decides which of them won.
  if (context.delivery.status === "delivered" || context.delivery.status === "failed") return;

  const summary = text?.trim() ?? "";
  if (outcomeStatus !== "completed" || summary.length < MINIMUM_DIGEST_CHARACTERS) {
    // A run that could not write a digest sends nothing. The delivery is marked
    // failed rather than delivered, and because only settled deliveries advance
    // the cursor, this window is folded into the next digest rather than lost.
    const settled = await settleDelivery(env, workspaceId, deliveryId, "failed", JSON.stringify({
      code: `digest_run_${outcomeStatus}`,
      message: "The digest run produced no summary",
    }));
    if (settled.outcome === "settled") await emitDigestTerminal(env, delivery, "failed").catch(() => undefined);
    return;
  }

  await workspace.recordDigestSummary({
    workspaceId,
    deliveryId,
    summaryMarkdown: summary,
    at: nowIso(),
  });

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
    const settled = await settleDelivery(env, workspaceId, deliveryId, "failed", JSON.stringify({
      code: "digest_not_delivered",
      message: "No destination accepted this digest",
    }));
    if (settled.outcome === "settled") await emitDigestTerminal(env, delivery, "failed").catch(() => undefined);
    return;
  }

  // Marked delivered only after every destination has settled, so a delivery
  // that throws mid-way is retried by the workflow step rather than recorded as
  // done. Each destination's own `last_delivered_delivery_id` keeps that retry
  // from re-sending what already landed. The compare-and-set answers which
  // attempt settled it: the loser used to fall through here anyway and emit the
  // terminal telemetry and the transcript note a second time.
  const settled = await settleDelivery(env, workspaceId, deliveryId, "delivered", null);
  if (settled.outcome !== "settled") return;
  await emitDigestTerminal(env, delivery, "success").catch(() => undefined);
  // Best effort, like the telemetry beside it: the delivery is already
  // settled, so a note that throws here would fail the step, and its retry
  // would read `already_settled` and return before ever reaching this line —
  // the note would be lost anyway, with a failed run as the price.
  await noteDeliveryInTranscript(env, delivery, delivered.delivered)
    .catch((error: unknown) => {
      logWarn(env, "digest_delivery_note_failed", {
        delivery_id: delivery.id,
        reason: error instanceof Error ? error.message : "unknown",
      });
    });
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
 * run id on the delivery. A delivery claimed before the column existed carries
 * NULL and deliberately gets no note — the settlement itself must still land
 * rather than fail the whole run over a missing note.
 */
async function noteDeliveryInTranscript(
  env: Env,
  delivery: DigestDeliveryRow,
  destinations: number,
): Promise<void> {
  if (!delivery.workstream_id) return;
  await createMessageObjectPort(env, delivery.workspace_id, delivery.workstream_id)
    .appendMessage({
      messageId: newId(),
      clientMessageId: `digest-delivered:${delivery.id}`,
      authorType: "system",
      authorUserId: null,
      externalActorJson: null,
      messageType: "system",
      text: `Delivered to ${destinations} destination${destinations === 1 ? "" : "s"}.`,
      structuredContentJson: null,
      producedByRunId: null,
      now: Date.now(),
    });
  // The outcome is not read, unlike the other four converted appends. This row
  // is the delivery's own announcement rather than a member-visible write, and
  // nothing downstream is conditioned on whether the redelivery was the first:
  // there is no event to publish and no run to start.
}
