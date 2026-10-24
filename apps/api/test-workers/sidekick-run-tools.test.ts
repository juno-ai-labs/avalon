/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, AutomationRunSchema,
  TranscriptTurnSchema, WorkstreamWorkflowInputSchema, type AutomationDraft } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { __integrationTesting } from "../src/services/integrations";
import { createToolReceiptObjectPort } from "../src/runtime/tool-receipt-port";
import { withToolPagination } from "../src/services/tool-pagination";
import { bootstrapConversationChildRuntime, provisionWorkstreamObject } from "../src/services/workstream-runtime-database";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { seedCanonicalMessageRecord, seedRun, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000fa30");
const USER = asUserId("00000000-0000-7000-8000-00000000fa31");
const SIDEKICK = asAutomationId("00000000-0000-7000-8000-00000000fa32");
const OTHER = asAutomationId("00000000-0000-7000-8000-00000000fa33");
const ACTIVATION = "00000000-0000-7000-8000-00000000fa34";
const runId = (index: number) => `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`;
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE));
const child = (id: string) => env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE, SIDEKICK, asSubstreamId(id)));
const draft: AutomationDraft = { name: "Incident report", description: "Reports incidents", overview: "Report preparation",
  instructions: "List only active incidents, with their owners.", triggers: [{ type: "manual" }], requiredCapabilities: [],
  expectedOutputs: [], defaultBehavior: {}, recommendedPlugins: [], memoryTables: [], suggestedScope: "personal",
  followUpQuestion: null, elicitation: null, ready: false };
const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE, parentKind: "automation",
  parentId: SIDEKICK, substreamId: "0", loopId: "wizard-history", harnessRunId: ACTIVATION, triggerMessageId: null,
  activityId: null, executionPrincipal: { type: "user", userId: USER }, reason: "user_message" });
const context: HarnessToolContext = { workspaceId: WORKSPACE, workstreamId: SIDEKICK, harnessRunId: ACTIVATION,
  toolCallId: "review-history", executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
function plugin(overrides: Partial<typeof input> = {}, paginate = false) {
  return __integrationTesting.createAvalonAutomationsPlugin(withWorkspaceRuntimeDatabase(env, WORKSPACE),
    { ...input, ...overrides }, new Set(), (tool) => paginate ? withToolPagination(tool, {
      prefix: "sidekick", connectionId: null,
      receipts: createToolReceiptObjectPort(env, WORKSPACE, SIDEKICK),
      fence: { runId: ACTIVATION, attemptId: "history-attempt", owner: "history-owner" },
    }) : [tool]);
}
function tool(name: string, overrides: Partial<typeof input> = {}) {
  const found = plugin(overrides).tools.find((candidate) => candidate.definition.name === name);
  if (!found) throw new Error(`missing_tool:${name}`);
  return found;
}
async function seedRuns(sidekickId: string, count: number, start = 1) {
  await runInDurableObject(workspace(), (_instance, state) => {
    for (let index = start; index < start + count; index++) {
      const id = runId(index);
      state.storage.sql.exec(`INSERT INTO sidekick_runs
        (sidekick_id, run_id, occurrence_key, trigger_json, definition_revision, harness_run_id, state, summary,
         run_as_user_id, created_at, started_at, completed_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, 'failed', 'Report delivery failed', ?, 100, 101, 102, 102)`,
      sidekickId, id, `manual:${id}`, JSON.stringify({ kind: "manual", requestedByUserId: USER }), `activation:${id}`, USER);
    }
  });
}
async function seedHistory(id = runId(1)) {
  await bootstrapConversationChildRuntime(env, WORKSPACE, "automation", SIDEKICK, id);
  await provisionWorkstreamObject(env, { workspaceId: WORKSPACE, workstreamId: SIDEKICK, substreamId: id,
    title: "Incident report", objective: draft.instructions, scope: "personal", createdByUserId: USER,
    participantUserIds: [USER], harnessStatus: "idle", emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: null, now: 100 });
  await runInDurableObject(child(id), async (_instance, state) => {
    seedRun(state, ACTIVATION);
    const transcript = new WorkstreamTranscriptStorage(state.storage);
    await transcript.appendParticipantMessage({ turnId: "report-output", actor: "assistant", authorUserId: null, authorSnapshot: null,
      text: "Active incident: service outage. Owner: Maya. Report: [incident-report](https://example.com/report)",
      createdAtUtc: "2026-10-23T00:00:00.000Z", attentionOrdinal: null });
    await seedCanonicalMessageRecord(state, { id: "delivery-tool", sequence: 2, messageType: "tool", toolName: "slack_send_message",
      toolStatus: "failed", effectIntentId: "delivery-call" });
    await transcript.upsertToolLifecycle({ toolCallId: "delivery-call", toolName: "slack_send_message", pluginId: "plugin_slack",
      status: "failed", participantSafeInput: { channel: "incidents" }, participantSafeResult: "Delivery refused",
      error: "channel_not_found", occurredAtUtc: "2026-10-23T00:00:01.000Z" });
    await transcript.appendParticipantMessage({ turnId: "report-feedback", actor: "human", authorUserId: USER,
      authorSnapshot: { displayName: "Adam", avatarUrl: null }, text: "Use the engineering Channel for future reports.",
      createdAtUtc: "2026-10-23T00:00:02.000Z", attentionOrdinal: null });
    state.storage.sql.exec(`INSERT INTO tool_effects
      (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name, mode, request_hash,
       authority_revision, status, tool_call_id, input_json, output_ref, error_json, output_summary, settled_at)
      VALUES ('delivery-effect', ?, 0, 0, 'delivery', 'slack_send_message', 'write', 'hash', '1', 'failed',
       'delivery-call', '{"channel":"incidents","text":"Active incident: service outage"}', ?,
       '{"code":"channel_not_found","message":"Channel is unavailable"}', 'Delivery refused', 100)`,
    ACTIVATION, `sidekick-history/${id}`);
  });
  await env.PAYLOADS.put(`sidekick-history/${id}`, JSON.stringify({ replayVersion: 1, output: { delivered: false, channel: "incidents" } }));
}
beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE, userId: USER, sessionId: "history-test" });
  await workspace().initializeWorkspace(WORKSPACE, "wnam");
  for (const automationId of [SIDEKICK, OTHER]) {
    await workspace().sidekickCreate({ workspaceId: WORKSPACE, automationId, authorUserId: USER, scope: "personal",
      owningWorkstreamId: null, owningSubstreamId: asSubstreamId("0"), authorityGeneration: 1 });
    await workspace().sidekickSubmitDefinition({ workspaceId: WORKSPACE, automationId, draft, evaluatorRules: null, submittedByRunId: null });
  }
});

describe("Sidekick wizard run inspection", () => {
  it("lists only its own runs and pages beyond the recent-history limit without losing timestamp ties", async () => {
    await seedRuns(SIDEKICK, 55);
    await seedRuns(OTHER, 1, 100);
    const first = await tool("runs_list").execute({}, context);
    const runs = z.object({ runs: z.array(AutomationRunSchema.extend({ definitionRevision: z.number() })) }).parse(first.output).runs;
    expect(runs).toHaveLength(50);
    expect(runs[0]).toMatchObject({ id: runId(1), automationId: SIDEKICK, status: "failed", definitionRevision: 1,
      triggerType: "manual", resultSummary: "Report delivery failed" });
    const second = await tool("runs_list").execute(first.pagination!.continuations[0]!.input, context);
    expect(second.output).toMatchObject({ runs: Array.from({ length: 5 }, (_, index) => ({ id: runId(index + 51), automationId: SIDEKICK })) });
    expect(second.pagination?.continuations).toEqual([]);
  });

  it("reads the original procedure, transcript, exact tool result, output and subsequent feedback after eviction", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    await evictDurableObject(child(runId(1)));
    const result = await tool("runs_read").execute({ runId: runId(1) }, context);
    expect(result.output).toMatchObject({ definitionRevision: 1, definition: { instructions: draft.instructions }, status: "failed",
      toolResults: [{ toolCallId: "delivery-call", status: "failed", input: { channel: "incidents" },
        output: { delivered: false, channel: "incidents" }, error: { code: "channel_not_found" }, resultAvailability: "full" }] });
    const page = z.object({ text: z.string(), turns: z.array(TranscriptTurnSchema) }).parse(result.output);
    expect(page.text).toContain("Owner: Maya");
    expect(page.turns.flatMap((turn) => turn.blocks)).toContainEqual(expect.objectContaining({ type: "text",
      text: expect.stringContaining("https://example.com/report") }));
    expect(page.text).toContain("Use the engineering Channel for future reports.");
    expect(page.turns.flatMap((turn) => turn.blocks)).toContainEqual(expect.objectContaining({ type: "tool", status: "failed", toolCallId: "delivery-call" }));
    expect(JSON.stringify(result.output)).not.toContain("sidekick-history/");
  });

  it("continues transcript pages under their original fence and marks missing detailed results", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    const read = tool("runs_read");
    const first = await read.execute({ runId: runId(1), limit: 1 }, context);
    await env.PAYLOADS.delete(`sidekick-history/${runId(1)}`);
    const second = await read.execute(first.pagination!.continuations[0]!.input, context);
    expect(second.output).toMatchObject({ toolResults: [{ output: null, error: { code: "channel_not_found" }, resultAvailability: "not_available" }] });
    await runInDurableObject(child(runId(1)), async (_instance, state) => {
      await new WorkstreamTranscriptStorage(state.storage).appendParticipantMessage({ turnId: "later-feedback", actor: "assistant",
        authorUserId: null, authorSnapshot: null, text: "Newer message outside the snapshot", createdAtUtc: "2026-10-23T01:00:00.000Z", attentionOrdinal: null });
    });
    const third = await read.execute(second.pagination!.continuations[0]!.input, context);
    expect(third.output).toMatchObject({ text: expect.stringContaining("Use the engineering Channel"), throughSequence: 3 });
    expect(third.pagination?.continuations).toEqual([]);
  });

  it("refuses another Sidekick's run and rejects a caller-supplied Sidekick selector", async () => {
    await seedRuns(OTHER, 1, 100);
    // An existing child is not sufficient: background children are not runs.
    await seedHistory(runId(100));
    await expect(tool("runs_read").execute({ runId: runId(100) }, context)).rejects.toThrow();
    await expect(tool("runs_list").execute({ sidekickId: OTHER }, context)).rejects.toThrow();
    await expect(tool("runs_read").execute({ runId: runId(100), sidekickId: OTHER }, context)).rejects.toThrow();
  });

  it("marks results summary-only when a completed payload or its receipt is missing", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    await env.PAYLOADS.delete(`sidekick-history/${runId(1)}`);
    await runInDurableObject(child(runId(1)), (_instance, state) => {
      state.storage.sql.exec("UPDATE tool_effects SET status = 'completed' WHERE tool_call_id = 'delivery-call'");
    });
    expect((await tool("runs_read").execute({ runId: runId(1) }, context)).output).toMatchObject({
      toolResults: [{ toolCallId: "delivery-call", output: null, summary: "Delivery refused", resultAvailability: "summary_only" }],
    });
    await runInDurableObject(child(runId(1)), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM tool_effects WHERE tool_call_id = 'delivery-call'");
    });
    expect((await tool("runs_read").execute({ runId: runId(1) }, context)).output).toMatchObject({
      toolResults: [{ toolCallId: "delivery-call", output: null, resultAvailability: "summary_only" }],
    });
  });

  it("rechecks membership and Sidekick access on later history pages", async () => {
    await seedRuns(SIDEKICK, 2);
    const list = tool("runs_list");
    const first = await list.execute({ limit: 1 }, context);
    await env.DB.prepare("UPDATE workspace_members SET status = 'removed' WHERE user_id = ?").bind(USER).run();
    await expect(list.execute(first.pagination!.continuations[0]!.input, context)).rejects.toThrow("Active Organization membership");
    await env.DB.prepare("UPDATE workspace_members SET status = 'active' WHERE user_id = ?").bind(USER).run();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE automation_directory SET lifecycle = 'deleted' WHERE automation_id = ?", SIDEKICK);
    });
    await expect(list.execute(first.pagination!.continuations[0]!.input, context)).rejects.toThrow();
  });

  it("offers run inspection only to the authoring conversation", () => {
    expect(plugin().tools.filter((candidate) => candidate.definition.capability.startsWith("rally.sidekick.runs.")).map((candidate) => candidate.definition.mode)).toEqual(["read", "read"]);
    for (const overrides of [{ parentKind: "workstream" as const }, { substreamId: asSubstreamId(runId(1)) }, { backgroundAgent: true }]) {
      expect(plugin(overrides).tools.some((candidate) => candidate.definition.capability.startsWith("rally.sidekick.runs."))).toBe(false);
    }
  });

  it("exposes first/next companions and rejects invented page IDs before reading history", async () => {
    const history = plugin({}, true).tools.filter((candidate) => candidate.definition.capability.startsWith("rally.sidekick.runs."));
    expect(history.map((candidate) => candidate.definition.name)).toEqual(["runs_list", "runs_list_next", "runs_read", "runs_read_next"]);
    await expect(history[1]!.execute({ pageId: "invented" }, context)).rejects.toThrow("pageId");
    await expect(history[0]!.execute({ cursor: "forged" }, context)).rejects.toThrow();
  });
});
