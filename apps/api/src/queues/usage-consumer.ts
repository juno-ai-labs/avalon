import { configuredRegions } from "@rally/contracts/regions";
import { ORGANIZATION_PAYS, UsageEventSchema, type UsageEvent } from "@rally/contracts/usage";
import { describeZodIssues } from "@rally/contracts/zod-diagnostics";
import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import { applyUsageBatch } from "../services/usage-metering";

export const USAGE_QUEUE_NAMES = new Set(configuredRegions.map((region) => `avalon-${region}-usage`));

export function isUsageQueue(queue: string): boolean {
  return USAGE_QUEUE_NAMES.has(queue);
}

/**
 * The only writer of the usage ledger. An invalid message is acked and logged,
 * since retrying cannot fix it. A message from another region is a misrouted
 * producer: it retries here until it reaches the dead-letter queue and is
 * never applied to this region's ledger. See docs/usage-metering.md.
 */
export async function consumeUsageQueue(
  batch: MessageBatch<unknown>,
  env: Pick<Env, "DB" | "USAGE_DB" | "USAGE_LAKEHOUSE" | "AVALON_REGION" | "APP_ENV" | "LOG_LEVEL">,
  now: () => number = Date.now,
): Promise<void> {
  const accepted: { message: Message<unknown>; event: UsageEvent }[] = [];
  let invalid = 0;
  let misrouted = 0;
  for (const message of batch.messages) {
    const parsed = UsageEventSchema.safeParse(message.body);
    if (!parsed.success) {
      invalid += 1;
      logStructuredEvent(env, "warn", "usage_event_rejected", {
        message_id: message.id,
        reason: `usage_event_invalid:${describeZodIssues(parsed.error)}`,
      });
      message.ack();
      continue;
    }
    if (parsed.data.region !== env.AVALON_REGION) {
      misrouted += 1;
      logStructuredEvent(env, "warn", "usage_event_rejected", {
        message_id: message.id,
        event_id: parsed.data.eventId,
        reason: `usage_event_misrouted:${parsed.data.region}:${env.AVALON_REGION}`,
      });
      message.retry();
      continue;
    }
    accepted.push({ message, event: parsed.data });
  }
  const receivedAt = new Date(now()).toISOString();
  const events = accepted.map((entry) => entry.event);
  const outcome = await applyUsageBatch(env, events, receivedAt);
  // D1 first, so a Pipelines outage never stalls the meter. If this send
  // fails the batch retries: D1 skips what it already holds, and the whole
  // batch is sent again, so R2 can hold an event twice and readers
  // deduplicate by event_id. Local hosts without the binding skip it.
  if (env.USAGE_LAKEHOUSE && events.length > 0) {
    await env.USAGE_LAKEHOUSE.send(events.map((event) => usageLakehouseRecord(event, receivedAt)));
  }
  for (const entry of accepted) entry.message.ack();
  logStructuredEvent(env, "info", "usage_batch_applied", {
    queue: batch.queue,
    messages: batch.messages.length,
    applied: outcome.applied,
    duplicates: outcome.duplicates,
    unknown_workspace: outcome.unknownWorkspace,
    invalid,
    misrouted,
    per_activity: JSON.stringify(outcome.perActivity),
  });
}

/** One `avalon.usage_events` row; see config/usage-lakehouse-stream-schema.json. */
export function usageLakehouseRecord(event: UsageEvent, receivedAt: string): Record<string, unknown> {
  return {
    schema_version: event.v,
    event_id: event.eventId,
    workspace_id: event.workspaceId,
    region: event.region,
    activity: event.activity,
    occurred_at: event.occurredAt,
    received_at: receivedAt,
    cost_microusd: event.costMicrousd,
    organization_pays: ORGANIZATION_PAYS[event.activity],
    model: event.model,
    user_id: event.refs.userId ?? null,
    workstream_id: event.refs.workstreamId ?? null,
    substream_id: event.refs.substreamId ?? null,
    sidekick_id: event.refs.sidekickId ?? null,
  };
}
