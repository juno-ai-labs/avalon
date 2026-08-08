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
  it("runs Control Tower with full context, a recent focus window, examples, and no plugins", async () => {
    let captured: RunHarnessInput | undefined;
    const runner = vi.fn(async (input: RunHarnessInput) => {
      captured = input;
      return completed("## Summary\n\nThe team approved the launch.");
    });
    const service = new MeetingNotesService(env, auth, runner);

    await expect(service.generate({
      mode: "live",
      meetingTitle: "Launch readiness",
      previousNotes: "## Right now\n\nThe team is discussing launch timing.",
      userNotes: "Acme is the priority account.",
      transcript: "[00:00:00–00:00:10] We approved launching Tuesday.\n\n[00:09:00–00:09:10] Morgan owns the checklist.",
      recentTranscript: "[00:09:00–00:09:10] Morgan owns the checklist.",
      startedAt: "2026-08-07T18:00:00.000Z",
      endedAt: null,
      transcriptStatus: "partial",
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
        reasoningEffort: "low",
        fallbackModels: ["fallback/one", "fallback/two"],
      },
    });
    expect(captured!.messages).toHaveLength(5);
    expect(captured!.messages.slice(0, 4).map((message) => message.role)).toEqual([
      "user", "assistant", "user", "assistant",
    ]);
    const request = String(captured!.messages.at(-1)!.content);
    expect(request).toContain("<previous_control_tower>");
    expect(request).toContain("<full_transcript>");
    expect(request).toContain("<recent_transcript>");
    expect(request).toContain("Morgan owns the checklist");
    expect(captured!.systemPrompt).toContain("Avalon Control Tower");
    expect(captured!.systemPrompt).toContain("directed unanswered question");
    expect(captured!.systemPrompt).toContain("complete replacement briefing");
  });

  it("uses a distinct whole-transcript final-summary pass without prior Control Tower prose", async () => {
    let captured: RunHarnessInput | undefined;
    const runner = vi.fn(async (input: RunHarnessInput) => {
      captured = input;
      return completed("## Action items\n\nNo explicit action items captured.");
    });
    const service = new MeetingNotesService(env, auth, runner);

    await service.generate({
      mode: "final",
      meetingTitle: "Beta review",
      previousNotes: "THIS LIVE BRIEF MUST NOT BE USED",
      userNotes: "The beta is for enterprise customers.",
      transcript: "[00:00:00–00:00:12] The conversion rate is 4.8 percent.",
      recentTranscript: "THIS RECENT WINDOW MUST NOT BE USED",
      startedAt: "2026-08-07T18:00:00.000Z",
      endedAt: "2026-08-07T18:30:00.000Z",
      transcriptStatus: "complete",
    }, "request-final");

    expect(captured!.config).toMatchObject({ reasoningEffort: "medium", maxWallClockMs: 120_000 });
    expect(captured!.messages).toHaveLength(5);
    const request = String(captured!.messages.at(-1)!.content);
    expect(request).toContain("Complete ordered transcript");
    expect(request).toContain("Transcript status: complete");
    expect(request).toContain("The beta is for enterprise customers");
    expect(request).not.toContain("THIS LIVE BRIEF MUST NOT BE USED");
    expect(request).not.toContain("THIS RECENT WINDOW MUST NOT BE USED");
    expect(captured!.systemPrompt).toContain("end-of-meeting chief of staff");
    expect(captured!.systemPrompt).toContain("Action items");
    expect(captured!.systemPrompt).not.toContain("Avalon Control Tower");
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
      mode: "live",
      meetingTitle: "Meeting notes",
      previousNotes: "",
      userNotes: "",
      transcript: "A valid transcript",
      recentTranscript: "A valid transcript",
      startedAt: null,
      endedAt: null,
      transcriptStatus: "partial",
    }, "request-2")).rejects.toMatchObject({
      status: 502,
      code: "meeting_notes_generation_failed",
      message: "This run reached its time limit",
    });
  });
});
