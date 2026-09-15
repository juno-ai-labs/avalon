import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  diagnosticErrorCode,
  logError,
  logInfo,
  logRequestEvent,
  logStructuredEvent,
  logWarn,
  summarizeEvent,
} from "../src/observability/logger";
import { createTestEnv } from "./helpers/cloudflare-test";

const env = createTestEnv({
  AVALON_REGION: "global",
  APP_VERSION: "0.24.0",
  BUILD_SHA: "abc1234",
  LOG_LEVEL: "info",
});

function capture(level: "info" | "warn" | "error", emit: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, level).mockImplementation(() => undefined);
  try {
    emit();
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0]?.[0] as Record<string, unknown>;
  } finally {
    spy.mockRestore();
  }
}

describe("structured logging", () => {
  it("extracts stable runtime error codes without logging arbitrary error text", () => {
    expect(diagnosticErrorCode(
      new Error("Failed to create instance: (instance.invalid_id) details follow"),
      "connector_event_failed",
    )).toBe("instance_invalid_id");
    expect(diagnosticErrorCode(
      new Error("Provider included customer@example.com in its response"),
      "connector_event_failed",
    )).toBe("connector_event_failed");
  });

  it("names the field a schema rejection rejected, behind the caller's own code", () => {
    // The consumer delivering an external event to a Sidekick reduced a
    // rejection to the constant `external_event_delivery_failed` and retried
    // until the Queue gave up; the failing path is the whole diagnosis, and
    // the rejected value is member content that stays behind.
    const rejection = z.strictObject({ event: z.strictObject({ eventSequence: z.number() }) })
      .safeParse({ event: { eventSequence: "customer@example.com" } });
    if (rejection.success) throw new Error("expected a rejection");
    const code = diagnosticErrorCode(rejection.error, "external_event_delivery_failed");
    expect(code).toBe("external_event_delivery_failed:event.eventSequence:invalid_type");
    expect(code).not.toContain("customer");
  });

  it("carries a code a Durable Object named across the RPC hop, separators included", () => {
    // `parseRpcInput` composes `<method>_invalid:<path>:<issue>`. The earlier
    // character class refused the `:` and `.` and answered the fallback — one
    // hop after the field had been named.
    expect(diagnosticErrorCode(
      new Error("admit_external_event_invalid:event.eventSequence:invalid_type"),
      "external_event_delivery_failed",
    )).toBe("admit_external_event_invalid:event.eventSequence:invalid_type");
  });

  it("keeps the request context authoritative over caller-supplied correlation", () => {
    const entry = capture("warn", () => logRequestEvent(
      env,
      { requestId: "req-1", workspaceId: "workspace-1" },
      "warn",
      "connector_oauth_callback_failed",
      {
      request_id: "spoofed",
      workspace_id: "someone-elses-workspace",
      code: "connector_unauthorized",
      },
    ));

    expect(entry).toMatchObject({
      code: "connector_unauthorized",
      request_id: "req-1",
      workspace_id: "workspace-1",
    });
  });

  it("lets an unauthenticated route name the workspace the context does not know", () => {
    // A connector OAuth callback carries no session, so overwriting the field
    // with the context's `undefined` would erase what the caller knows.
    const entry = capture("warn", () => logRequestEvent(env, { requestId: "req-2" }, "warn", "connector_oauth_callback_failed", {
      workspace_id: "workspace-2",
    }));

    expect(entry).toMatchObject({ request_id: "req-2", workspace_id: "workspace-2" });
  });

  it("logs an object so Workers Logs indexes each field", () => {
    const entry = capture("info", () =>
      logStructuredEvent(env, "info", "http_request", {
        method: "GET",
        path: "/notes",
        status: 200,
        duration_ms: 96,
      }));

    expect(typeof entry).toBe("object");
    expect(entry).toMatchObject({
      event: "http_request",
      method: "GET",
      path: "/notes",
      region: "global",
      status: 200,
    });
  });

  it("summarizes every entry so no row lists as a blank message", () => {
    const request = capture("info", () =>
      logStructuredEvent(env, "info", "http_request", {
        method: "GET",
        path: "/notes",
        status: 200,
        duration_ms: 96,
      }));
    expect(request.message).toBe("http_request GET /notes 200 96ms");

    const failure = capture("warn", () =>
      logStructuredEvent(env, "warn", "request_failed", { code: "not_found", status: 404 }));
    expect(failure.message).toBe("request_failed 404 not_found");

    const bare = capture("warn", () => logStructuredEvent(env, "warn", "connector_poll_timeout"));
    expect(bare.message).toBe("connector_poll_timeout");
  });

  it("keeps a caller-supplied message instead of the summary", () => {
    const entry = capture("warn", () =>
      logStructuredEvent(env, "warn", "slack_ingress_failed", {
        message: "Slack ingress exhausted its retry budget",
        status: 429,
      }));

    expect(entry.message).toBe("Slack ingress exhausted its retry budget");
    expect(entry.status).toBe(429);
  });

  it("redacts the entry after summarizing it", () => {
    const entry = capture("warn", () =>
      logStructuredEvent(env, "warn", "connector_oauth_callback_failed", {
        code: "unauthorized",
        authorization: "Bearer secret",
      }));

    expect(entry.message).toBe("connector_oauth_callback_failed unauthorized");
    expect(entry.authorization).toBe("[REDACTED]");
  });

  it("keeps the reserved `message` slot a string", () => {
    const entry = capture("warn", () => logWarn(env, "slack_thread_title_failed", {
      // @ts-expect-error `message` becomes the row summary rather than a field,
      // so a structured value there is a type error, not something the logger
      // would silently drop on its way to Workers Logs.
      message: { code: "ratelimited" },
    }));

    expect(entry.message).toBe("slack_thread_title_failed");
  });

  it("derives the summary from the redacted fields, not the caller's", () => {
    // The guarantee is structural rather than a property of what
    // SUMMARY_FIELDS happens to name today: whatever redaction does to a
    // summarized field has to reach the summary as well. `redact` truncates a
    // long string, so a long `path` proves which copy the summary was built
    // from.
    const entry = capture("info", () => logInfo(env, "http_request", {
      method: "GET",
      path: `/notes/${"a".repeat(2_500)}`,
      status: 200,
    }));

    expect(entry.path).toMatch(/…$/u);
    expect(entry.message).toBe(`http_request GET ${entry.path as string} 200`);
    expect((entry.message as string).length).toBeLessThan(2_100);
  });

  it("routes each level helper to the console method Workers Logs reads it from", () => {
    expect(capture("info", () => logInfo(env, "slack_public_channel_sync_completed", { joined: 3 })))
      .toMatchObject({ event: "slack_public_channel_sync_completed", joined: 3, level: "info" });
    expect(capture("warn", () => logWarn(env, "slack_thread_title_failed", { reason: "ratelimited" })))
      .toMatchObject({ event: "slack_thread_title_failed", level: "warn", reason: "ratelimited" });
    expect(capture("error", () => logError(env, "realtime_transcription_session_release_failed")))
      .toMatchObject({ event: "realtime_transcription_session_release_failed", level: "error" });
  });

  it("drops an entry below the configured level", () => {
    const quiet = createTestEnv({ ...env, LOG_LEVEL: "error" });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      logWarn(quiet, "slack_thread_title_failed");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("omits fields the summary cannot read", () => {
    expect(summarizeEvent("automation_compiler", { stage: { name: "model_response" }, latency_ms: 12_000 }))
      .toBe("automation_compiler");
  });
});
