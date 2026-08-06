import { AutomationDraftStreamEventSchema } from "@avalon/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoAppEnv } from "../src/env";
import { automationRoutes } from "../src/routes/automations";
import { AutomationService } from "../src/services/automation-service";

const draft = {
  name: "Blog monitor",
  description: "Check a blog for new posts.",
  overview: "Checks the configured blog every day.",
  instructions: "Check the configured blog and report new posts.",
  triggers: [{ type: "interval" as const, intervalSeconds: 86_400, summary: "Every 24 hours" }],
  requiredCapabilities: [],
  expectedOutputs: ["New post summary"],
  defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
  suggestedScope: "personal" as const,
  followUpQuestion: "Which blog should I monitor?",
  elicitation: {
    responseType: "free_text" as const,
    prompt: "Paste the full blog URL.",
    placeholder: "https://example.com/blog",
    options: [],
    minimumSelections: 0,
    maximumSelections: null,
    allowOther: false,
  },
  ready: false,
};

function testApp(): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "request-stream-1");
    c.set("auth", {
      sessionId: "session-1",
      userId: "00000000-0000-7000-8000-000000000001",
      workspaceId: "00000000-0000-7000-8000-000000000002",
      region: "global",
      role: "owner",
    });
    await next();
  });
  app.route("/automations", automationRoutes);
  return app;
}

afterEach(() => vi.restoreAllMocks());

describe("automation draft stream", () => {
  it("forwards activity and derives the final message from the submitted draft", async () => {
    vi.spyOn(AutomationService.prototype, "compile").mockImplementation(async (_input, _requestId, options) => {
      await options?.onStreamEvent?.({ type: "started" });
      await options?.onStreamEvent?.({
        type: "thinking",
        inferenceRequestId: "inference-1",
        status: "started",
        durationMs: 0,
      });
      await options?.onStreamEvent?.({
        type: "thinking",
        inferenceRequestId: "inference-1",
        status: "completed",
        durationMs: 1_234,
      });
      await options?.onStreamEvent?.({
        type: "tool",
        toolCallId: "tool-1",
        name: "Reviewing connected tools",
        summary: "Reviewed the authorized plugin catalog",
        status: "completed",
        plugins: [{ pluginId: "plugin_github", displayName: "GitHub", icon: "brand-github" }],
        durationMs: 42,
      });
      await options?.onStreamEvent?.({ type: "completed" });
      return draft;
    });

    const response = await testApp().request("/automations/draft/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Check this blog every day." }] }),
    }, {} as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => AutomationDraftStreamEventSchema.parse(JSON.parse(line.slice(6))));
    expect(events).toEqual([
      { type: "started" },
      {
        type: "thinking",
        inferenceRequestId: "inference-1",
        status: "started",
        durationMs: 0,
      },
      {
        type: "thinking",
        inferenceRequestId: "inference-1",
        status: "completed",
        durationMs: 1_234,
      },
      {
        type: "tool",
        toolCallId: "tool-1",
        name: "Reviewing connected tools",
        summary: "Reviewed the authorized plugin catalog",
        status: "completed",
        plugins: [{ pluginId: "plugin_github", displayName: "GitHub", icon: "brand-github" }],
        durationMs: 42,
      },
      { type: "completed", draft, assistantMessage: "Paste the full blog URL." },
    ]);
  });
});
