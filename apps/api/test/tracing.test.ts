import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HonoAppEnv } from "../src/env";
import { requestContext } from "../src/middleware/request-context";
import {
  identityAttributes,
  inFlowSpan,
  inSpan,
  noFlowSpan,
  requestFlowSpan,
} from "../src/observability/tracing";
import { createTestEnv } from "./helpers/cloudflare-test";
import { recordedSpans, resetRecordedSpans } from "./helpers/cloudflare-workers";

function envAt(level: "debug" | "info") {
  return createTestEnv({
    AVALON_REGION: "global",
    APP_VERSION: "1.200.0",
    BUILD_SHA: "abc1234",
    LOG_LEVEL: level,
  });
}

type ConsoleSpy = { mock: { calls: unknown[][] } };

function rows(spy: ConsoleSpy): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

/**
 * The clock is read through `Date.now`, which workerd advances only across
 * I/O. Stepping it explicitly is what lets a step assert on a duration at all —
 * a real one measures zero here, exactly as a CPU-only step does in production.
 */
function clock(...steps: number[]): void {
  let at = 1_000;
  const remaining = [...steps];
  vi.spyOn(Date, "now").mockImplementation(() => {
    at += remaining.shift() ?? 0;
    return at;
  });
}

afterEach(() => {
  resetRecordedSpans();
  vi.restoreAllMocks();
});

describe("custom spans over Cloudflare's automatic tracing", () => {
  it("opens a runtime span per step and ends it, so the platform nests and exports it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await inFlowSpan(envAt("info"), "workstream.create", {
      flow: "workstream_create",
      component: "api",
      identity: { workspaceId: "workspace-1", userId: "user-1", workstreamId: "workstream-1" },
    }, async (span) => {
      await span.step("workstream.create.receipt.reserve", () => Promise.resolve());
      await span.step("workstream.create.object.initialize", () => Promise.resolve());
      span.setAttributes({ "avalon.create.path": "fresh" });
    });

    const opened = recordedSpans();
    expect(opened.map((span) => span.name)).toEqual([
      "workstream.create",
      "workstream.create.receipt.reserve",
      "workstream.create.object.initialize",
    ]);
    // A span left open never reaches the exporter.
    expect(opened.every((span) => span.ended)).toBe(true);
    expect(opened[0]?.attributes).toMatchObject({
      "avalon.flow": "workstream_create",
      "avalon.component": "api",
      "avalon.workspace.id": "workspace-1",
      "avalon.workstream.id": "workstream-1",
      "user.id": "user-1",
      "avalon.create.path": "fresh",
    });
    void info;
  });

  it("also lands the flow in Workers Logs as one row naming the slowest step", async () => {
    // One step per `Date.now()` the flow makes: opening it, closing each of the
    // two steps, and the total at the end.
    clock(0, 40, 250, 0);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await inFlowSpan(envAt("info"), "workstream.create", {
      flow: "workstream_create",
      component: "api",
      identity: { workspaceId: "workspace-1", requestId: "request-1" },
    }, async (span) => {
      await span.step("workstream.create.receipt.reserve", () => Promise.resolve());
      await span.step("workstream.create.object.initialize", () => Promise.resolve());
    });

    expect(rows(info)[0]).toMatchObject({
      event: "perf_flow",
      flow: "workstream_create",
      component: "api",
      workspace_id: "workspace-1",
      request_id: "request-1",
      steps: {
        "workstream.create.receipt.reserve": 40,
        "workstream.create.object.initialize": 250,
      },
      step_order: "workstream.create.receipt.reserve,workstream.create.object.initialize",
      slowest_step: "workstream.create.object.initialize",
      slowest_step_ms: 250,
    });
  });

  it("ends the step that threw and lets the rejection through", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(inFlowSpan(envAt("info"), "workstream.message.send", {
      flow: "workstream_message_send",
      component: "workspace_do",
    }, (span) => span.step("workstream.message.object_write", () => Promise.reject(new Error("boom")))))
      .rejects.toThrow("boom");

    expect(recordedSpans().map((span) => [span.name, span.ended])).toEqual([
      ["workstream.message.send", true],
      ["workstream.message.object_write", true],
    ]);
    // The flow still reaches Workers Logs, naming the step it died in.
    expect(rows(info)[0]).toMatchObject({
      event: "perf_flow",
      step_order: "workstream.message.object_write",
    });
    void warn;
  });

  it("records a failure as the status attributes an OTLP destination reads", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await inFlowSpan(envAt("info"), "workstream.detail.read", {
      flow: "workstream_open",
      component: "api",
    }, async (span) => {
      span.setError("workstream_not_found", "No such work stream");
    });

    expect(recordedSpans()[0]?.attributes).toMatchObject({
      "otel.status_code": "ERROR",
      "error.type": "workstream_not_found",
      "otel.status_description": "No such work stream",
    });
  });

  it("never sets an attribute for an identifier it does not have", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await inSpan("workstream.socket.ticket", identityAttributes({
      workspaceId: "workspace-1",
      workstreamId: null,
      userId: undefined,
    }), () => Promise.resolve());

    const attributes = recordedSpans()[0]?.attributes ?? {};
    expect(attributes).toEqual({ "avalon.workspace.id": "workspace-1" });
    // A present-but-empty attribute is worse than an absent one: it makes
    // "unknown" indistinguishable from "known to be nothing" in a dashboard.
    expect(Object.keys(attributes)).not.toContain("avalon.workstream.id");
  });

  it("opens no span and logs nothing for a path outside the traced flows", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    await expect(noFlowSpan.step("ignored", () => Promise.resolve("kept"))).resolves.toBe("kept");
    noFlowSpan.mark("ignored");
    noFlowSpan.setAttributes({ ignored: true });
    noFlowSpan.setError("ignored");

    expect(recordedSpans()).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it("puts a request's span under the id the desktop client sent", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const app = new Hono<HonoAppEnv>();
    app.use("*", requestContext);
    app.get("/workstreams/:id", (c) => requestFlowSpan(c, "workstream.detail.read", {
      flow: "workstream_open",
      identity: { workstreamId: c.req.param("id") },
    }, async () => c.json({ ok: true })));

    const requestId = "018f22f2-4c22-7abc-8def-0123456789ab";
    const response = await app.request(
      "/workstreams/workstream-1",
      { headers: { "x-request-id": requestId } },
      envAt("info"),
    );

    // Echoed, so the client can print the id its own trace line carries even
    // when the call it belongs to failed.
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(recordedSpans()[0]?.attributes).toMatchObject({
      "avalon.flow": "workstream_open",
      "avalon.request.id": requestId,
      "avalon.workstream.id": "workstream-1",
      "http.request.method": "GET",
    });
    expect(rows(info).find((row) => row.event === "perf_flow"))
      .toMatchObject({ request_id: requestId, flow: "workstream_open" });
  });
});
