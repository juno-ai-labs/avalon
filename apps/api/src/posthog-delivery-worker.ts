import { WorkerEntrypoint } from "cloudflare:workers";

import {
  sendPostHogBatch,
  sendPostHogCrashBatch,
  sendPostHogJavascriptExceptionBatch,
  sendPostHogProfileBatch,
} from "./telemetry/posthog-adapter";
import type { PostHogDeliveryRpcBinding } from "./telemetry/posthog-delivery-contract";

/**
 * The Global-only static module graph for PostHog's provider SDK and mapping.
 * The regional API retains policy, outbox authority, and delivery receipts.
 */
export default class PostHogDeliveryWorker
  extends WorkerEntrypoint
  implements PostHogDeliveryRpcBinding {
  /** Cloudflare requires a named handler even when only RPC is reachable. */
  override fetch(): Response {
    return new Response(null, { status: 404 });
  }

  sendTelemetryBatch(input: Parameters<PostHogDeliveryRpcBinding["sendTelemetryBatch"]>[0]) {
    return sendPostHogBatch(input);
  }

  sendJavascriptExceptionBatch(
    input: Parameters<PostHogDeliveryRpcBinding["sendJavascriptExceptionBatch"]>[0],
  ) {
    return sendPostHogJavascriptExceptionBatch(input);
  }

  sendCrashBatch(input: Parameters<PostHogDeliveryRpcBinding["sendCrashBatch"]>[0]) {
    return sendPostHogCrashBatch(input);
  }

  sendProfileBatch(input: Parameters<PostHogDeliveryRpcBinding["sendProfileBatch"]>[0]) {
    return sendPostHogProfileBatch(input);
  }
}
