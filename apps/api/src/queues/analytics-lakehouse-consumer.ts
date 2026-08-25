import type { Env } from "../env";
import { logStructuredEvent } from "../observability/logger";
import {
  AnalyticsLakehousePointerSchema,
  deliverAnalyticsLakehousePointer,
} from "../services/analytics-lakehouse";

export async function consumeAnalyticsLakehouseQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    const parsed = AnalyticsLakehousePointerSchema.safeParse(message.body);
    if (!parsed.success) {
      logStructuredEvent(env, "error", "analytics_lakehouse_pointer_invalid", {
        queue: batch.queue,
        errors: parsed.error.issues.slice(0, 4).map((issue) =>
          `${issue.path.map(String).join(".") || "(root)"}: ${issue.code}`),
      });
      message.ack();
      return;
    }
    if (env.AVALON_REGION !== "global") {
      logStructuredEvent(env, "error", "analytics_lakehouse_pointer_misrouted", {
        queue: batch.queue,
        event_id: parsed.data.eventId,
        actual_region: env.AVALON_REGION,
      });
      message.ack();
      return;
    }
    try {
      const result = await deliverAnalyticsLakehousePointer(env, parsed.data);
      logStructuredEvent(env, result.outcome === "delivered" ? "info" : "warn",
        `analytics_lakehouse_${result.outcome}`, {
        queue: batch.queue,
        event_id: parsed.data.eventId,
        ...(result.outcome === "delivered"
          ? { event_name: result.record.event_name, source: result.record.source }
          : {}),
      });
      message.ack();
    } catch (error) {
      logStructuredEvent(env, "warn", "analytics_lakehouse_delivery_failed", {
        queue: batch.queue,
        event_id: parsed.data.eventId,
        error_name: error instanceof Error ? error.name : "UnknownError",
        error_message: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }));
}
