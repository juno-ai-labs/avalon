import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { logStructuredEvent, summarizeEvent } from "../src/observability/logger";

const env = {
  AVALON_REGION: "global",
  APP_VERSION: "0.24.0",
  BUILD_SHA: "abc1234",
  LOG_LEVEL: "info",
} as unknown as Env;

function capture(level: "info" | "warn", emit: () => void): Record<string, unknown> {
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

  it("omits fields the summary cannot read", () => {
    expect(summarizeEvent("automation_compiler", { stage: { name: "model_response" }, latency_ms: 12_000 }))
      .toBe("automation_compiler");
  });
});
