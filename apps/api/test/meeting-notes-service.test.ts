import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RunHarnessInput } from "@rally/agent-harness";
import type { AuthContext } from "../src/env";
import { MeetingNotesService } from "../src/services/meeting-notes-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: asUserId("00000000-0000-4000-8000-000000000011"),
  workspaceId: asWorkspaceId("00000000-0000-4000-8000-000000000012"),
  region: "global",
  role: "member",
};

const env = createTestEnv({
  OPENROUTER_API_KEY: "test-key",
  OPENROUTER_PRIMARY_MODEL: "test/model",
  OPENROUTER_FALLBACK_MODELS: "fallback/one, fallback/two",
  PUBLIC_API_BASE_URL: "https://api.example.com",
});

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
      refreshSeconds: null,
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
      traceContext: {
        source: "meeting_notes",
        feature: "agent-model-meeting-notes",
      },
      config: {
        maxIterations: 1,
        maxToolCalls: 0,
        reasoningEffort: "low",
        fallbackModels: ["fallback/one", "fallback/two"],
        // The live pass declines the harness's transport retry: its one-minute
        // cadence is the recovery, and the next tick reads the same transcript
        // window. Flattening this to the deployment budget makes a briefing wait
        // and re-ask inside a sixty-second wall clock.
        ttftTimeoutMs: 45_000,
        transportRetries: 0,
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
    expect(captured!.systemPrompt).toContain("Rally Control Tower");
    expect(captured!.systemPrompt).toContain("directed unanswered question");
    expect(captured!.systemPrompt).toContain("complete replacement briefing");
    // The formatting policy's TeX rule is the prompt half of the repair pair
    // (docs/model-text-normalization.md); a hash cannot say which line left.
    expect(captured!.systemPrompt).toContain("Never write TeX or math delimiters");
    // The cadence is a served flag, so it reaches the model as run data. With
    // no binding attached this is the checked-in default — the same value the
    // desktop falls back to, which is the point of resolving both from one
    // definition.
    expect(request).toContain("You refresh every 60 seconds");
    expect(captured!.systemPrompt).not.toContain("a minute from now");
  });

  it("tells the model the cadence Flagship serves rather than a fixed interval", async () => {
    let captured: RunHarnessInput | undefined;
    const runner = vi.fn(async (input: RunHarnessInput) => {
      captured = input;
      return completed("## Right now\n\n- Still discussing launch timing.");
    });
    const flaggedEnv = createTestEnv({
      ...env,
      FLAGS: {
        getNumberDetails: vi.fn(async (flagKey: string) => ({
          flagKey,
          value: 120,
          variant: "slower",
          reason: "TARGETING_MATCH",
        })),
      },
    });

    await new MeetingNotesService(flaggedEnv, auth, runner).generate({
      mode: "live",
      meetingTitle: "Launch readiness",
      previousNotes: "",
      userNotes: "",
      transcript: "[00:00:00–00:00:10] We approved launching Tuesday.",
      recentTranscript: "[00:00:00–00:00:10] We approved launching Tuesday.",
      startedAt: "2026-08-07T18:00:00.000Z",
      endedAt: null,
      transcriptStatus: "partial",
      refreshSeconds: null,
    }, "request-cadence");

    const request = String(captured!.messages.at(-1)!.content);
    expect(request).toContain("You refresh every 120 seconds");
    expect(request).not.toContain("60 seconds");
  });

  it("describes the cadence the client is keeping rather than the one the flag now serves", async () => {
    let captured: RunHarnessInput | undefined;
    const runner = vi.fn(async (input: RunHarnessInput) => {
      captured = input;
      return completed("## Right now\n\n- Still discussing launch timing.");
    });
    const resolver = vi.fn(async (flagKey: string) => ({
      flagKey,
      value: 300,
      variant: "slower",
      reason: "TARGETING_MATCH",
    }));
    const flaggedEnv = createTestEnv({ ...env, FLAGS: { getNumberDetails: resolver } });

    await new MeetingNotesService(flaggedEnv, auth, runner).generate({
      mode: "live",
      meetingTitle: "Launch readiness",
      previousNotes: "",
      userNotes: "",
      transcript: "[00:00:00–00:00:10] We approved launching Tuesday.",
      recentTranscript: "[00:00:00–00:00:10] We approved launching Tuesday.",
      startedAt: "2026-08-07T18:00:00.000Z",
      endedAt: null,
      transcriptStatus: "partial",
      // The meeting settled on 30 seconds before the flag moved to 300. The
      // client is still keeping 30, so that is the schedule the briefing has to
      // be written for — and the flag is not worth resolving at all.
      refreshSeconds: 30,
    }, "request-client-cadence");

    expect(String(captured!.messages.at(-1)!.content)).toContain("You refresh every 30 seconds");
    expect(resolver).not.toHaveBeenCalled();
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
      refreshSeconds: null,
    }, "request-final");

    expect(captured!.config).toMatchObject({
      reasoningEffort: "medium",
      maxWallClockMs: 120_000,
      ttftTimeoutMs: 45_000,
      // The final pass has no successor to defer to, so it takes the
      // deployment's budget rather than a literal that would outrank an
      // operator turning the retry off.
      transportRetries: 1,
    });
    expect(captured!.messages).toHaveLength(5);
    const request = String(captured!.messages.at(-1)!.content);
    expect(request).toContain("Complete ordered transcript");
    expect(request).toContain("Transcript status: complete");
    expect(request).toContain("The beta is for enterprise customers");
    expect(request).not.toContain("THIS LIVE BRIEF MUST NOT BE USED");
    expect(request).not.toContain("THIS RECENT WINDOW MUST NOT BE USED");
    expect(captured!.systemPrompt).toContain("end-of-meeting chief of staff");
    expect(captured!.systemPrompt).toContain("Action items");
    expect(captured!.systemPrompt).not.toContain("Rally Control Tower");
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
      refreshSeconds: null,
    }, "request-2")).rejects.toMatchObject({
      status: 502,
      code: "meeting_notes_generation_failed",
      // Control Tower keeps its own sentence rather than forwarding the
      // harness's. Someone reading this is sitting in a meeting, on a surface
      // where nothing is called a run and they started no run — and for a live
      // pass the true next step is one Avalon takes itself, a minute from now.
      // The harness's own code and message stay in the logs, where the person
      // who needs the cause is looking.
      message: "Rally could not update Control Tower. The next refresh will try again",
    });
  });

  it("never forwards a harness failure message to the meeting surface", async () => {
    const runner = vi.fn(async () => ({
      ...completed(""),
      status: "failed" as const,
      failure: {
        kind: "provider" as const,
        code: "provider_unavailable" as const,
        message: "OpenRouter rejected sk-secret with upstream body: private",
      },
    }));

    await expect(new MeetingNotesService(env, auth, runner).generate({
      mode: "final",
      meetingTitle: "Meeting notes",
      previousNotes: "",
      userNotes: "",
      transcript: "A valid transcript",
      recentTranscript: "A valid transcript",
      startedAt: null,
      endedAt: null,
      transcriptStatus: "complete",
      refreshSeconds: null,
    }, "request-3")).rejects.toMatchObject({
      status: 502,
      code: "meeting_notes_generation_failed",
      // The final pass has no successor, so it does not promise one.
      message: "Rally could not create the final meeting summary",
    });
  });
});
