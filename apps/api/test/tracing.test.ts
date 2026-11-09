import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HonoAppEnv } from "../src/env";
import { requestContext } from "../src/middleware/request-context";
import {
  identityAttributes,
  inDurableObjectPhase,
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
  it("records Durable Object initialization as a nested span and queryable timing row", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_250);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await inDurableObjectPhase(envAt("info"), "initialize", {
      component: "substream_agent",
      className: "AgentLoopDO",
      latestVersion: 26,
      startedAt: 1_000,
    }, () => Promise.resolve());

    expect(recordedSpans()[0]).toMatchObject({
      name: "durable_object.initialize",
      ended: true,
      attributes: {
        "rally.component": "substream_agent",
        "rally.durable_object.class": "AgentLoopDO",
        "rally.migration.latest_version": 26,
      },
    });
    expect(rows(info)[0]).toMatchObject({
      event: "durable_object_initialization",
      component: "substream_agent",
      class_name: "AgentLoopDO",
      phase: "initialize",
      status: "completed",
      latest_version: 26,
      duration_ms: 250,
    });
  });

  it("records a failed schema pass without replacing the constructor error", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(2_000).mockReturnValueOnce(2_080);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("workstream_do_schema_hash_mismatch:27");

    await expect(inDurableObjectPhase(envAt("info"), "schema_migrate", {
      component: "workstream_do",
      className: "WorkstreamDO",
      latestVersion: 27,
    }, () => Promise.reject(failure))).rejects.toBe(failure);

    // The mismatch is thrown as a code with the version appended, and the
    // span and the row keep the phase's own constant rather than it: the OTel
    // `error.type` and the row's `code` are grouping keys, and one value per
    // version — or per object key, or per member-chosen name, in the other
    // messages the tree interpolates after a colon — defeats what they exist
    // for. The message is on the row's `message`; the code stays bounded.
    expect(recordedSpans()[0]).toMatchObject({
      name: "durable_object.schema_migrate",
      ended: true,
      callbackFailed: true,
      attributes: {
        "otel.status_code": "ERROR",
        "error.type": "durable_object_schema_migrate_failed",
      },
    });
    expect(rows(error)[0]).toMatchObject({
      event: "durable_object_schema_migration",
      component: "workstream_do",
      status: "failed",
      code: "durable_object_schema_migrate_failed",
      duration_ms: 80,
    });
  });

  it("opens a runtime span per step and ends it, so the platform nests and exports it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await inFlowSpan(envAt("info"), "workstream.create", {
      flow: "workstream_create",
      component: "api",
      identity: { workspaceId: "workspace-1", userId: "user-1", workstreamId: "workstream-1" },
    }, async (span) => {
      await span.step("workstream.create.receipt.reserve", () => Promise.resolve());
      await span.step("workstream.create.object.initialize", () => Promise.resolve());
      span.setAttributes({ "rally.create.path": "fresh" });
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
      "rally.flow": "workstream_create",
      "rally.component": "api",
      "rally.workspace.id": "workspace-1",
      "rally.workstream.id": "workstream-1",
      "user.id": "user-1",
      "rally.create.path": "fresh",
    });
    void info;
  });

  it("also lands the flow in Workers Logs as one row naming the slowest step", async () => {
    // One delta per `Date.now()` the flow makes: opening it, then per step the
    // gap check on entry and the close on exit, then the total at the end. The
    // gaps are zero here — this flow awaits nothing between its steps, which is
    // what the two 0s in the middle say.
    clock(0, 0, 40, 0, 250, 0);
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
    // Pinned, because `step_order` below is asserted exactly. On the real clock
    // this test failed roughly one run in five: `closeGap` charges anything
    // measurable before the first step to `unattributed`, and whether a
    // millisecond elapses between the flow opening and the step starting is a
    // question about the machine, not about the code. The step is still
    // recorded at a duration of zero, so the assertion is unchanged.
    clock();

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
    expect(attributes).toEqual({ "rally.workspace.id": "workspace-1" });
    // A present-but-empty attribute is worse than an absent one: it makes
    // "unknown" indistinguishable from "known to be nothing" in a dashboard.
    expect(Object.keys(attributes)).not.toContain("rally.workstream.id");
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
      "rally.flow": "workstream_open",
      "rally.request.id": requestId,
      "rally.workstream.id": "workstream-1",
      "http.request.method": "GET",
    });
    // The caller's attributes reach the summary row too, so one row explains
    // itself without the trace beside it.
    expect(rows(info).find((row) => row.event === "perf_flow")).toMatchObject({
      request_id: requestId,
      flow: "workstream_open",
      "http.request.method": "GET",
    });
  });

  it("carries the analytics surrogates PostHog is keyed on, when they exist", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await inFlowSpan(envAt("info"), "workstream.create", {
      flow: "workstream_create",
      component: "api",
      identity: {
        userId: "user-1",
        workspaceId: "workspace-1",
        analyticsPersonId: "person-analytics-1",
        analyticsWorkspaceId: "workspace-analytics-1",
      },
    }, async () => undefined);

    expect(recordedSpans()[0]?.attributes).toMatchObject({
      // Both sides of the join: the raw id identifies the person to us, the
      // surrogate identifies the same person to PostHog.
      "user.id": "user-1",
      "rally.workspace.id": "workspace-1",
      "rally.analytics.person_id": "person-analytics-1",
      "rally.analytics.workspace_id": "workspace-analytics-1",
      // PostHog's own key, set to the surrogate rather than left for the
      // destination to infer from `user.id` — which would key the same human
      // differently from the product pipeline and split them in two.
      "posthog.distinct_id": "person-analytics-1",
    });
  });

  it("sets no analytics attribute before the surrogate has been minted", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await inFlowSpan(envAt("info"), "workstream.create", {
      flow: "workstream_create",
      component: "api",
      // What an account that has produced no product event yet looks like:
      // the columns are null, and there is no PostHog person to join to.
      identity: { userId: "user-1", analyticsPersonId: null, analyticsWorkspaceId: null },
    }, async () => undefined);

    const attributes = recordedSpans()[0]?.attributes ?? {};
    expect(attributes["user.id"]).toBe("user-1");
    expect(Object.keys(attributes)).not.toContain("rally.analytics.person_id");
    expect(Object.keys(attributes)).not.toContain("rally.analytics.workspace_id");
    // And no PostHog key either: keying a person before the pipeline has minted
    // their surrogate is what would make the destination fall back to guessing.
    expect(Object.keys(attributes)).not.toContain("posthog.distinct_id");
  });

  it("carries what authentication cost, which the flow's own duration excludes", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const app = new Hono<HonoAppEnv>();
    // Authentication is middleware: it finishes before any route opens a flow
    // span, so its cost lands in `http_request` and not in `perf_flow`. The
    // attribute is what makes the difference between the two readable rather
    // than an unexplained gap.
    app.use("*", async (c, next) => {
      c.set("requestId", "request-1");
      c.set("authDurationMs", 42);
      await next();
    });
    app.get("/probe", (c) => requestFlowSpan(c, "workstream.detail.read", {
      flow: "workstream_open",
    }, async () => c.json({ ok: true })));

    await app.request("/probe", undefined, envAt("info"));

    expect(recordedSpans()[0]?.attributes).toMatchObject({ "rally.auth.duration_ms": 42 });
    expect(rows(info).find((row) => row.event === "perf_flow"))
      .toMatchObject({ "rally.auth.duration_ms": 42 });
  });

  it("repeats the flow onto each step span, which does not inherit it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await inFlowSpan(envAt("info"), "workstream.create", {
      flow: "workstream_create",
      component: "api",
      identity: { workspaceId: "workspace-1" },
    }, async (span) => {
      await span.step("workstream.create.receipt.reserve", async () => undefined);
    });

    // OpenTelemetry does not inherit attributes from a parent, so a step span
    // that omitted these could not be filtered or grouped by its flow.
    const step = recordedSpans().find((s) => s.name === "workstream.create.receipt.reserve");
    expect(step?.attributes).toMatchObject({
      "rally.flow": "workstream_create",
      "rally.component": "api",
    });
    // Identity stays on the root: it is many attributes, the step shares the
    // root's trace, and `perf_flow` carries every step beside the identity.
    expect(Object.keys(step?.attributes ?? {})).not.toContain("rally.workspace.id");
  });

  it("charges work between two steps to `unattributed`, not to the next step", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await inFlowSpan(envAt("info"), "workstream.create", {
      flow: "workstream_create",
      component: "api",
    }, async (span) => {
      await span.step("fast_step", async () => { now += 5; });
      now += 3_000; // an awaited call nobody wrapped in a step
      await span.step("also_fast_step", async () => { now += 10; });
    });

    const row = rows(info).find((entry) => entry.event === "perf_flow");
    // The whole point: `also_fast_step` is 10, not 3010, and the 3000ms it used
    // to absorb is named rather than hidden inside its neighbour.
    expect(row).toMatchObject({
      steps: { fast_step: 5, unattributed: 3_000, also_fast_step: 10 },
      slowest_step: "unattributed",
      duration_ms: 3_015,
    });
  });

  it("keeps the step breakdown summing to the flow duration", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await inFlowSpan(envAt("info"), "workstream.create", {
      flow: "workstream_create",
      component: "api",
    }, async (span) => {
      await span.step("one", async () => { now += 7; });
      now += 11;
      await span.step("two", async () => { now += 13; });
      now += 3;
    });

    const row = rows(info).find((entry) => entry.event === "perf_flow");
    const steps = row?.steps as Record<string, number>;
    // The trailing 3ms after the last step is not in any step, so the parts
    // sum to the total only if the reader knows that. They must never exceed it.
    expect(Object.values(steps).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(row?.duration_ms as number);
    expect(steps["two"]).toBe(13);
  });
});
