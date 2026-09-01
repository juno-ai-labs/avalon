import { WorkerEntrypoint } from "cloudflare:workers";

export default class PostHogRpcTestService extends WorkerEntrypoint {
  sendTelemetryBatch(input) {
    const row = input.rows[0];
    return {
      result: "delivered",
      requestId: `${row.eventId}:${row.envelope.name}:${input.webBaseUrl}`,
      retryAfterMs: null,
    };
  }

  sendJavascriptExceptionBatch(input) {
    return {
      result: "delivered",
      requestId: input.rows[0]?.symbolicatedFrames?.[0] ?? null,
      retryAfterMs: null,
    };
  }

  sendCrashBatch(input) {
    return {
      result: "delivered",
      requestId: input.rows[0]?.report?.status ?? null,
      retryAfterMs: null,
    };
  }

  sendProfileBatch(input) {
    return {
      result: "delivered",
      requestId: input.rows[0]?.kind ?? null,
      retryAfterMs: null,
    };
  }
}
