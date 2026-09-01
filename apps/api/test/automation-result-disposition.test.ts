import { asWorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyAutomationResult } from "../src/services/automation-result-disposition";
import { createTestEnv } from "./helpers/cloudflare-test";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";

/** Only what the gateway and its logger read; nothing here touches storage. */
function env(): ReturnType<typeof createTestEnv> {
  return createTestEnv({
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "error",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_STRUCTURED_MODEL: "test/structured",
    OPENROUTER_FALLBACK_MODELS: "",
    PUBLIC_API_BASE_URL: "https://api.example.com",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** One OpenRouter answer, in the envelope the structured gateway unwraps. */
function providerReply(content: unknown): Response {
  return new Response(JSON.stringify({
    id: "gen-1",
    model: "test/structured",
    choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function input(overrides: Partial<Parameters<typeof classifyAutomationResult>[1]> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    automationName: "Candidate email intake",
    automationObjective: "Summarize candidate mail about the CFO search.",
    triggerKind: "external_event" as const,
    triggerSummary: "google / email.received",
    result: "A candidate replied about the CFO role and asked for the salary band.",
    recentDispositions: [],
    reach: { canDeliver: true, canExpose: false },
    ...overrides,
  };
}

describe("automation result disposition", () => {
  it("returns what the classifier decided, and records that it decided it", async () => {
    const fetch = vi.fn(async () => providerReply({
      disposition: "deliver",
      reason: "A named candidate asked a question the recruiter has to answer.",
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(classifyAutomationResult(env(), input())).resolves.toEqual({
      disposition: "deliver",
      reason: "A named candidate asked a question the recruiter has to answer.",
      source: "classified",
    });
  });

  it("offers only the arms the automation can reach, in the schema itself", async () => {
    let body: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      body = String(init.body);
      return providerReply({ disposition: "done", reason: "Nothing moved this week." });
    }));

    await classifyAutomationResult(env(), input({
      reach: { canDeliver: false, canExpose: true },
    }));

    const sent = JSON.parse(body!) as { response_format?: { json_schema?: { schema?: unknown } } };
    const schema = JSON.stringify(sent.response_format?.json_schema?.schema);
    expect(schema).toContain("expose_workstream");
    // Not a post-hoc check: an arm this automation cannot reach is not a value
    // the model is given the option of returning.
    expect(schema).not.toContain("deliver");
  });

  it("delivers when the classifier cannot answer, rather than swallowing the result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream is down", { status: 502 })));

    const decision = await classifyAutomationResult(env(), input());

    expect(decision.disposition).toBe("deliver");
    expect(decision.source).toBe("default");
  });

  it("falls back to exposing the run when there is nobody to deliver to", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream is down", { status: 502 })));

    const decision = await classifyAutomationResult(env(), input({
      reach: { canDeliver: false, canExpose: true },
    }));

    expect(decision.disposition).toBe("expose_workstream");
    expect(decision.source).toBe("default");
  });

  it("spends no inference when the automation can reach nobody", async () => {
    const fetch = vi.fn(async () => providerReply({ disposition: "deliver", reason: "x" }));
    vi.stubGlobal("fetch", fetch);

    const decision = await classifyAutomationResult(env(), input({
      reach: { canDeliver: false, canExpose: false },
    }));

    expect(decision).toEqual({
      disposition: "done",
      reason: "This automation has no destination and no work stream to expose.",
      source: "default",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an arm the schema never offered rather than honouring it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerReply({
      disposition: "expose_workstream",
      reason: "Worth opening in full.",
    })));

    const decision = await classifyAutomationResult(env(), input({
      reach: { canDeliver: true, canExpose: false },
    }));

    expect(decision.disposition).toBe("deliver");
    expect(decision.source).toBe("default");
  });

  it("hands the model what it needs to see repetition", async () => {
    let body: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      body = String(init.body);
      return providerReply({ disposition: "done", reason: "Same as the last three." });
    }));

    await classifyAutomationResult(env(), input({
      recentDispositions: ["done", "done", "deliver"],
    }));

    expect(body).toContain("done, done, deliver");
    expect(body).toContain("Candidate email intake");
    expect(body).toContain("UNTRUSTED AUTOMATION RESULT");
  });
});
