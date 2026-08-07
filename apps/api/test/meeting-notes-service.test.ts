import { describe, expect, it, vi } from "vitest";
import type { RunHarnessInput } from "@avalon/agent-harness";
import type { AuthContext, Env } from "../src/env";
import { MeetingNotesService } from "../src/services/meeting-notes-service";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: "00000000-0000-4000-8000-000000000011",
  workspaceId: "00000000-0000-4000-8000-000000000012",
  region: "global",
  role: "member",
};

const env = {
  OPENROUTER_API_KEY: "test-key",
  OPENROUTER_PRIMARY_MODEL: "test/model",
  OPENROUTER_FALLBACK_MODELS: "fallback/one, fallback/two",
  PUBLIC_API_BASE_URL: "https://api.example.com",
} as Env;

function completed(content: string) {
  return {
    status: "completed" as const,
    content,
    model: "test/model",
    iterations: 1,
    toolCalls: 0,
    usage: {},
    stats: {
      turns: 1,
      toolCalls: 0,
      inputTokens: 10,
      outputTokens: 5,
      modelTimeMs: 10,
      toolTimeMs: 0,
      outputTokensPerSecond: 500,
      toolTimeBreakdownMs: {},
    },
  };
}

describe("MeetingNotesService", () => {
  it("reuses the bounded harness with every plugin surface disabled", async () => {
    let captured: RunHarnessInput | undefined;
    const runner = vi.fn(async (input: RunHarnessInput) => {
      captured = input;
      return completed("## Summary\n\nThe team approved the launch.");
    });
    const service = new MeetingNotesService(env, auth, runner);

    await expect(service.generate({
      previousNotes: "## Summary\n\nThe team discussed launch timing.",
      transcript: "We approved launching Tuesday. Morgan owns the checklist.",
    }, "request-1")).resolves.toMatchObject({
      notes: "## Summary\n\nThe team approved the launch.",
      generatedAt: expect.any(String),
    });

    expect(captured).toMatchObject({
      pluginDiscovery: false,
      corePlugins: [],
      plugins: [],
      includeWebSearch: false,
      onInferenceRequest: expect.any(Function),
      onInferenceAttempt: expect.any(Function),
      executionPrincipal: { type: "user", userId: auth.userId },
      config: {
        maxIterations: 1,
        maxToolCalls: 0,
        fallbackModels: ["fallback/one", "fallback/two"],
      },
    });
    expect(String(captured!.messages[0]!.content)).toContain("<previous_notes>");
    expect(String(captured!.messages[0]!.content)).toContain("<transcript>");
  });

  it("returns a safe API error when the notes loop fails", async () => {
    const runner = vi.fn(async () => ({
      ...completed(""),
      status: "failed" as const,
      failure: {
        kind: "limit" as const,
        code: "run_wall_time_limit_exceeded" as const,
        message: "provider detail",
      },
    }));

    await expect(new MeetingNotesService(env, auth, runner).generate({
      previousNotes: "",
      transcript: "A valid transcript",
    }, "request-2")).rejects.toMatchObject({
      status: 502,
      code: "meeting_notes_generation_failed",
      message: "This run reached its time limit",
    });
  });
});
