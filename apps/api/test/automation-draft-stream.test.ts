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
  it("forwards text deltas before the final typed draft", async () => {
    vi.spyOn(AutomationService.prototype, "compile").mockImplementation(async (_input, _requestId, options) => {
      await options?.onAssistantText?.({ type: "started" });
      await options?.onAssistantText?.({ type: "delta", delta: "Which blog ", reset: false });
      await options?.onAssistantText?.({ type: "delta", delta: "should I monitor?", reset: false });
      await options?.onAssistantText?.({ type: "completed", content: "Which blog should I monitor?" });
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
      { type: "delta", delta: "Which blog ", reset: false },
      { type: "delta", delta: "should I monitor?", reset: false },
      { type: "completed", draft, assistantMessage: "Which blog should I monitor?" },
    ]);
  });
});
