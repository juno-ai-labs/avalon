import type { DigestDeliveryTargetType } from "@avalon/contracts";
import { nowIso } from "@avalon/db";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { digestEmailHtml, digestMarkdownToText } from "./digest-email-content";
import { sendResendEmail, singleLine } from "./resend";
import { SlackAgentService } from "./slack-agent-service";

const EMAIL_ERRORS = {
  unavailable: { code: "digest_email_unavailable", message: "Digest email is temporarily unavailable" },
  failed: { code: "digest_email_failed", message: "The digest email could not be sent" },
};

export interface DigestDeliveryContext {
  workspaceId: string;
  deliveryId: string;
  userId: string;
  recipientName: string;
  workspaceName: string;
  timezone: string;
  plannedFor: string;
  bodyMarkdown: string;
  itemCount: number;
  highlightCount: number;
}

export interface DigestDeliveryTargetRow {
  id: string;
  target_type: string;
  connection_id: string | null;
  provider_tenant_id: string | null;
  provider_user_id: string | null;
  email_address: string | null;
  last_delivered_delivery_id: string | null;
}

/**
 * How one destination family actually receives a digest.
 *
 * Delivery is a registry rather than a chain of `if`s because the set of
 * destinations is open: a connector declares a `userDelivery` surface, the
 * settings screen offers it, and the only thing missing is an entry here. A
 * target type with no entry is skipped rather than failing the run — it was
 * saved by a region that has the connector, and this region does not.
 */
const CONNECTOR_DELIVERIES: Partial<Record<
  DigestDeliveryTargetType,
  (env: Env, context: DigestDeliveryContext, target: DigestDeliveryTargetRow) => Promise<void>
>> = {
  slack_agent_dm: async (env, context, target) => {
    await new SlackAgentService(env).deliverDigest({
      workspaceId: context.workspaceId,
      userId: context.userId,
      deliveryId: context.deliveryId,
      targetId: target.id,
      connectionId: target.connection_id!,
      slackUserId: target.provider_user_id!,
      title: digestTitle(context),
      markdown: context.bodyMarkdown,
    });
  },
};

/**
 * Sends one written digest to every destination frozen on the schedule.
 *
 * Each destination settles on its own: one failing does not hold back the
 * others, and each records its own delivery so a retry of this step re-sends
 * only what has not landed. The first failure is rethrown so the workflow step
 * retries, and the rest are logged rather than lost to settle order.
 *
 * The three counts are distinct on purpose. `skipped` is "nothing was sent and
 * nothing went wrong" — a destination that already received this digest on an
 * earlier attempt, or a non-production run that never sends at all — and must
 * not read as a failure to the caller deciding whether the window was consumed.
 */
export async function deliverDigest(
  env: Env,
  context: DigestDeliveryContext,
  request: typeof fetch = fetch,
): Promise<{ delivered: number; skipped: number; failed: number }> {
  const result = await env.DB.prepare(
    `SELECT t.id, t.target_type, t.connection_id, t.provider_tenant_id, t.provider_user_id,
            t.email_address, t.last_delivered_delivery_id
       FROM digest_delivery_targets t
       JOIN digest_deliveries d ON d.id = ?
       JOIN workspace_members m
         ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id AND m.status = 'active'
      WHERE t.digest_schedule_id = d.digest_schedule_id
        AND t.status IN ('active', 'needs_input')
      ORDER BY t.target_type ASC`,
  ).bind(context.deliveryId).all<DigestDeliveryTargetRow>();

  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  const failures: unknown[] = [];
  for (const target of result.results ?? []) {
    // The target already received this digest on an earlier attempt of the same
    // step. Delivery is at-least-once at the transport and exactly-once here.
    if (target.last_delivered_delivery_id === context.deliveryId) {
      skipped += 1;
      continue;
    }
    try {
      const sent = await deliverToTarget(env, context, target, request);
      if (sent) {
        await markDelivered(env, target.id, context.deliveryId);
        delivered += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      // A frozen destination that the provider permanently rejects never fixes
      // itself, so it is surfaced on the digest rather than failing silently on
      // every occurrence from now on.
      failed += 1;
      const permanent = error instanceof ApiError && error.details?.retryable === false;
      await markFailed(env, target.id, permanent ? "needs_input" : "active", error);
      // A permanent rejection is recorded and not rethrown: retrying the step
      // would only reach the same answer, and the target now says so.
      if (!permanent) failures.push(error);
    }
  }

  for (const failure of failures) {
    console.warn("Digest delivery failed", {
      delivery_id: context.deliveryId,
      reason: failure instanceof Error ? failure.message : "unknown",
    });
  }
  if (failures.length > 0) throw failures[0];
  return { delivered, skipped, failed };
}

async function deliverToTarget(
  env: Env,
  context: DigestDeliveryContext,
  target: DigestDeliveryTargetRow,
  request: typeof fetch,
): Promise<boolean> {
  if (target.target_type === "email") {
    if (!target.email_address) return false;
    const delivery = await sendResendEmail(env, {
      recipientEmail: target.email_address,
      subject: digestTitle(context),
      html: digestEmailHtml({
        recipientName: singleLine(context.recipientName),
        workspaceName: singleLine(context.workspaceName),
        occurrenceLabel: occurrenceLabel(context.plannedFor, context.timezone),
        bodyMarkdown: context.bodyMarkdown,
        itemCount: context.itemCount,
        highlightCount: context.highlightCount,
        appUrl: env.PUBLIC_WEB_BASE_URL,
        settingsUrl: `${env.PUBLIC_WEB_BASE_URL}/app/settings/digest`,
      }),
      text: [digestTitle(context), "", digestMarkdownToText(context.bodyMarkdown)].join("\n"),
      idempotencyKey: `avalon-digest/${target.id}/${context.deliveryId}`,
      category: "scheduled_digest",
      region: env.AVALON_REGION,
      sender: "notification",
      errors: EMAIL_ERRORS,
    }, request);
    // Non-production never sends, so nothing is recorded as delivered.
    return delivery === "sent";
  }

  const connectorDelivery = CONNECTOR_DELIVERIES[target.target_type as DigestDeliveryTargetType];
  if (!connectorDelivery || !target.connection_id || !target.provider_user_id) return false;
  await connectorDelivery(env, context, target);
  return true;
}

/** Localized to the recipient's own timezone — a digest is a time of *their* day. */
export function occurrenceLabel(plannedFor: string, timezone: string): string {
  const at = new Date(plannedFor);
  if (Number.isNaN(at.getTime())) return "Your digest";
  try {
    const day = new Intl.DateTimeFormat("en-GB", {
      weekday: "long", day: "numeric", month: "long", timeZone: timezone,
    }).format(at);
    const time = new Intl.DateTimeFormat("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: timezone,
    }).format(at);
    return `${day} · ${time}`;
  } catch {
    // A stored timezone the runtime does not know must not stop the digest.
    return "Your digest";
  }
}

function digestTitle(context: DigestDeliveryContext): string {
  return `Your ${singleLine(context.workspaceName)} digest · ${occurrenceLabel(context.plannedFor, context.timezone)}`;
}

async function markDelivered(env: Env, targetId: string, deliveryId: string): Promise<void> {
  const at = nowIso();
  await env.DB.prepare(
    `UPDATE digest_delivery_targets
        SET status = 'active', last_delivered_at = ?, last_delivered_delivery_id = ?,
            last_error_json = NULL, updated_at = ?
      WHERE id = ?`,
  ).bind(at, deliveryId, at, targetId).run();
}

async function markFailed(
  env: Env,
  targetId: string,
  status: "active" | "needs_input",
  error: unknown,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE digest_delivery_targets SET status = ?, last_error_json = ?, updated_at = ? WHERE id = ?",
  ).bind(
    status,
    JSON.stringify({
      code: "digest_delivery_failed",
      message: error instanceof Error ? error.message.slice(0, 500) : "Digest delivery failed",
    }),
    nowIso(),
    targetId,
  ).run();
}
