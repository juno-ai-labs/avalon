import { WorkerEntrypoint } from "cloudflare:workers";

export default class TelemetryRpcTestService extends WorkerEntrypoint {
  deliverTelemetryBatch(input) {
    const row = input.rows[0];
    return {
      postHog: {
        result: "delivered",
        requestId: `${row.eventId}:${row.envelope.name}:${input.webBaseUrl}`,
        retryAfterMs: null,
      },
    };
  }

  deliverJavascriptExceptionBatch(input) {
    return {
      postHog: {
        result: "delivered",
        requestId: input.rows[0]?.symbolicatedFrames?.[0] ?? null,
        retryAfterMs: null,
      },
    };
  }

  deliverCrashBatch(input) {
    return {
      postHog: {
        result: "delivered",
        requestId: input.rows[0]?.report?.status ?? null,
        retryAfterMs: null,
      },
    };
  }

  deliverProfileBatch(input) {
    return {
      postHog: {
        result: "delivered",
        requestId: input.rows[0]?.kind ?? null,
        retryAfterMs: null,
      },
    };
  }
}
