import { WorkerEntrypoint } from "cloudflare:workers";

import {
  sendPostHogBatch,
  sendPostHogCrashBatch,
  sendPostHogJavascriptExceptionBatch,
  sendPostHogProfileBatch,
} from "./telemetry/posthog-adapter";
import type { TelemetryDeliveryRpcBinding } from "./telemetry/telemetry-delivery-contract";

/**
 * The one Global-only static module graph for telemetry destination adapters.
 * PostHog is the first destination. New provider destinations extend this
 * Worker with an independent result instead of creating another Worker.
 * Regional APIs retain policy, outbox authority, and delivery receipts.
 */
export default class TelemetryDeliveryWorker
  extends WorkerEntrypoint
  implements TelemetryDeliveryRpcBinding {
  /** Cloudflare requires a named handler even when only RPC is reachable. */
  override fetch(): Response {
    return new Response(null, { status: 404 });
  }

  async deliverTelemetryBatch(
    input: Parameters<TelemetryDeliveryRpcBinding["deliverTelemetryBatch"]>[0],
  ) {
    return { postHog: await sendPostHogBatch(input) };
  }

  async deliverJavascriptExceptionBatch(
    input: Parameters<TelemetryDeliveryRpcBinding["deliverJavascriptExceptionBatch"]>[0],
  ) {
    return { postHog: await sendPostHogJavascriptExceptionBatch(input) };
  }

  async deliverCrashBatch(input: Parameters<TelemetryDeliveryRpcBinding["deliverCrashBatch"]>[0]) {
    return { postHog: await sendPostHogCrashBatch(input) };
  }

  async deliverProfileBatch(input: Parameters<TelemetryDeliveryRpcBinding["deliverProfileBatch"]>[0]) {
    return { postHog: await sendPostHogProfileBatch(input) };
  }
}
