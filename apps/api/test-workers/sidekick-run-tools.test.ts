/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, AutomationRunSchema,
  WorkstreamWorkflowInputSchema, type AutomationDraft } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { __integrationTesting } from "../src/services/integrations";
import { createToolReceiptObjectPort } from "../src/runtime/tool-receipt-port";
import { withToolPagination } from "../src/services/tool-pagination";
import { CONVERSATION_READ_CHARACTER_BUDGET } from "../src/services/conversation-tools";
import { bootstrapConversationChildRuntime, provisionWorkstreamObject } from "../src/services/workstream-runtime-database";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { seedCanonicalMessageRecord, seedRun, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000fa30");
const USER = asUserId("00000000-0000-7000-8000-00000000fa31");
const SIDEKICK = asAutomationId("00000000-0000-7000-8000-00000000fa32");
const OTHER = asAutomationId("00000000-0000-7000-8000-00000000fa33");
const ACTIVATION = "00000000-0000-7000-8000-00000000fa34";
const VIEWER = asUserId("00000000-0000-7000-8000-00000000fa35");
const RESOURCE = "00000000-0000-7000-8000-00000000fa36";
const runId = (index: number) => `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`;
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE));
const child = (id: string) => env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE, SIDEKICK, asSubstreamId(id)));
const draft: AutomationDraft = { name: "Incident report", description: "Reports incidents", overview: "Report preparation",
  instructions: "List only active incidents, with their owners.", triggers: [{ type: "manual" }], requiredCapabilities: [],
  expectedOutputs: [], defaultBehavior: {}, recommendedPlugins: [], memoryTables: [], customTools: [], suggestedScope: "personal",
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
function evidence(output: unknown) {
  const { content } = z.object({ content: z.string() }).parse(output);
  return z.object({ turns: z.array(z.object({ blocks: z.array(z.object({ type: z.string() }).passthrough()) })) })
    .passthrough().parse(JSON.parse(content));
}
function toolsIn(output: unknown) {
  return evidence(output).turns.flatMap((turn) => turn.blocks).filter((block) => block.type === "tool");
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
    expect(result.output).toMatchObject({ status: "failed", transcriptAvailability: "available", pageComplete: true });
    const page = evidence(result.output);
    expect(page).toMatchObject({ definitionRevision: 1, definition: { instructions: draft.instructions } });
    expect(toolsIn(result.output)).toEqual([expect.objectContaining({ toolCallId: "delivery-call", status: "failed",
      input: { channel: "incidents", text: "Active incident: service outage" }, output: { delivered: false, channel: "incidents" },
      error: { code: "channel_not_found", message: "Channel is unavailable" }, resultAvailability: "full" })]);
    expect(JSON.stringify(page)).toContain("Owner: Maya");
    expect(JSON.stringify(page)).toContain("https://example.com/report");
    expect(JSON.stringify(page)).toContain("Use the engineering Channel for future reports.");
    expect(JSON.stringify(result.output)).not.toContain("sidekick-history/");
  });

  it("opens a run with what it spent: model calls and tokens, each tool's calls and time, and each call's duration", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    await runInDurableObject(child(runId(1)), (_instance, state) => {
      state.storage.sql.exec(`UPDATE tool_effects SET started_at = 40 WHERE tool_call_id = 'delivery-call'`);
      // Two requests a saved tool's program made: counted apart from the model's own calls.
      for (const [index, startedAt, settledAt] of [[0, 10, 30], [1, 30, 80]] as const) {
        state.storage.sql.exec(`INSERT INTO tool_effects
          (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name, mode, request_hash,
           authority_revision, status, tool_call_id, input_json, started_at, settled_at)
          VALUES (?, ?, 0, ?, ?, 'run_sql', 'read', 'hash', '1', 'completed', ?, '{}', ?, ?)`,
        `nested-${index}`, ACTIVATION, index + 1, `nested-${index}`, `scan-call:call:${index}`, startedAt, settledAt);
      }
      // A write whose outcome is unknown: ambiguous, not a failure.
      state.storage.sql.exec(`INSERT INTO tool_effects
        (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name, mode, request_hash,
         authority_revision, status, tool_call_id, input_json, started_at, settled_at)
        VALUES ('post-effect', ?, 0, 3, 'post', 'post_update', 'write', 'hash', '1', 'ambiguous', 'post-call', '{}', 0, 5)`,
      ACTIVATION);
      // Three provider attempts: two calls whose input grew with the conversation, and one retry.
      for (const [id, outcome, input, created] of [["a1", "success", 1000, 1], ["a2", "retry", 1500, 2], ["a3", "success", 2500, 3]] as const) {
        state.storage.sql.exec(`INSERT INTO inference_attempts
          (inference_attempt_id, run_id, attempt_id, turn_id, endpoint_attempt, fallback_attempt, provider, model,
           workspace_identity_hash, routing_decision_json, outcome, latency_ms, input_tokens, output_tokens,
           cached_tokens, cost_micros, started_at, completed_at, created_at)
          VALUES (?, ?, 'attempt', 'turn', 1, 0, 'openrouter', 'model', 'hash', '{}', ?, 400, ?, 50, 800, 25000, 0, 0, ?)`,
        id, ACTIVATION, outcome, input, created);
      }
    });
    const result = await tool("runs_read").execute({ runId: runId(1) }, context);
    expect(evidence(result.output).usage).toEqual({ model: { calls: 2, failedAttempts: 1, inputTokens: 5000,
      outputTokens: 150, cachedInputTokens: 2400, costUsd: 0.075, firstCallInputTokens: 1000, lastCallInputTokens: 2500,
      largestCallInputTokens: 2500, ms: 1200 }, note: expect.stringContaining("sends the whole conversation"), tools: [
      { toolName: "run_sql", fromProgram: true, calls: 2, failed: 0, ambiguous: 0, ms: 70, maxMs: 50 },
      { toolName: "slack_send_message", fromProgram: false, calls: 1, failed: 1, ambiguous: 0, ms: 60, maxMs: 60 },
      { toolName: "post_update", fromProgram: false, calls: 1, failed: 0, ambiguous: 1, ms: 5, maxMs: 5 },
    ] });
    expect(toolsIn(result.output)).toEqual([expect.objectContaining({ toolCallId: "delivery-call", ms: 60 })]);
  });

  it("continues transcript pages under their original fence and marks missing detailed results", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    const read = tool("runs_read");
    const first = await read.execute({ runId: runId(1), limit: 1 }, context);
    await env.PAYLOADS.delete(`sidekick-history/${runId(1)}`);
    const second = await read.execute(first.pagination!.continuations[0]!.input, context);
    expect(toolsIn(second.output)).toEqual([expect.objectContaining({ error: { code: "channel_not_found", message: "Channel is unavailable" }, resultAvailability: "not_available" })]);
    expect(evidence(second.output)).not.toHaveProperty("definition");
    await runInDurableObject(child(runId(1)), async (_instance, state) => {
      await new WorkstreamTranscriptStorage(state.storage).appendParticipantMessage({ turnId: "later-feedback", actor: "assistant",
        authorUserId: null, authorSnapshot: null, text: "Newer message outside the snapshot", createdAtUtc: "2026-10-23T01:00:00.000Z", attentionOrdinal: null });
    });
    const third = await read.execute(second.pagination!.continuations[0]!.input, context);
    expect(JSON.stringify(evidence(third.output))).toContain("Use the engineering Channel");
    expect(third.output).toMatchObject({ throughSequence: 3 });
    expect(third.pagination?.continuations).toEqual([]);
  });

  it("refuses another Sidekick's run and rejects a caller-supplied Sidekick selector", async () => {
    await seedRuns(OTHER, 1, 100);
    // An existing child is not sufficient: background children are not runs.
    await seedHistory(runId(100));
    await expect(tool("runs_read").execute({ runId: runId(100) }, context)).rejects.toThrow("This run does not exist");
    await expect(tool("runs_list").execute({ sidekickId: OTHER }, context)).rejects.toThrow("Unrecognized key");
    await expect(tool("runs_read").execute({ runId: runId(100), sidekickId: OTHER }, context)).rejects.toThrow("Unrecognized key");
  });

  it("marks results summary-only when a completed payload or its receipt is missing", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    await env.PAYLOADS.delete(`sidekick-history/${runId(1)}`);
    await runInDurableObject(child(runId(1)), (_instance, state) => {
      state.storage.sql.exec("UPDATE tool_effects SET status = 'completed' WHERE tool_call_id = 'delivery-call'");
    });
    expect(toolsIn((await tool("runs_read").execute({ runId: runId(1) }, context)).output)).toEqual([expect.objectContaining({ toolCallId: "delivery-call", summary: "Delivery refused", resultAvailability: "summary_only" })]);
    await runInDurableObject(child(runId(1)), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM tool_effects WHERE tool_call_id = 'delivery-call'");
    });
    expect(toolsIn((await tool("runs_read").execute({ runId: runId(1) }, context)).output)).toEqual([expect.objectContaining({ toolCallId: "delivery-call", resultAvailability: "summary_only" })]);
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
    await expect(list.execute(first.pagination!.continuations[0]!.input, context)).rejects.toThrow("archived");
  });

  it("offers run inspection to the authoring conversation and the agents it starts there", () => {
    const reads = (overrides: Partial<typeof input> = {}) =>
      plugin(overrides).tools.some((candidate) => candidate.definition.capability.startsWith("rally.sidekick.runs."));
    expect(plugin().tools.filter((candidate) => candidate.definition.capability.startsWith("rally.sidekick.runs.")).map((candidate) => candidate.definition.mode)).toEqual(["read", "read"]);
    expect(reads({ substreamId: asSubstreamId(runId(8)), backgroundAgent: true })).toBe(true);
    for (const overrides of [{ parentKind: "workstream" as const }, { substreamId: asSubstreamId(runId(1)) },
      { substreamId: asSubstreamId(runId(9)), backgroundAgent: true, automationDelegation: { runId: runId(1), stopGeneration: 0 } }]) {
      expect(reads(overrides)).toBe(false);
    }
  });

  it("reads the due review's runs in the notice's order when no run is named", async () => {
    await seedRuns(SIDEKICK, 3);
    const agent = { substreamId: asSubstreamId(runId(8)), backgroundAgent: true };
    await expect(tool("runs_read", agent).execute({}, context)).rejects.toThrow("Pass a runId");
    const reviewId = "00000000-0000-7000-8000-00000000fa41";
    const notice = { kind: "sidekick_review_due", schemaVersion: 1, reviewId, automationId: SIDEKICK, definitionRevision: 1,
      since: null, until: "2026-10-30T00:00:00.000Z", announceTo: null,
      finished: { completed: 2, failed: 1, needsInput: 0, stopped: 0 },
      sample: { failed: [runId(2)], needsInput: [], completed: [runId(1), runId(3)] } };
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO sidekick_reviews(sidekick_id, review_id, definition_revision, coordinator_user_id, notice_json, requested_at, delivered_at)
         VALUES (?, ?, 1, ?, ?, 100, 101)`, SIDEKICK, reviewId, USER, JSON.stringify(notice));
    });
    // The agent names nothing; the cursor carries the rest of the list.
    const read = tool("runs_read", agent);
    const visited: [string, number][] = [];
    let result = await read.execute({}, context);
    for (;;) {
      const { runId: id, runsRemaining } = z.object({ runId: z.string(), runsRemaining: z.number() }).parse(result.output);
      visited.push([id, runsRemaining]);
      const next = result.pagination?.continuations[0];
      if (!next) break;
      result = await read.execute(next.input, context);
    }
    expect(visited).toEqual([[runId(2), 2], [runId(1), 1], [runId(3), 0]]);
  });

  it.each(["needs_input", "stopped"])("returns stored evidence for an unprovisioned %s run", async (status) => {
    await seedRuns(SIDEKICK, 1);
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE sidekick_runs SET state = ?, summary = 'No delegated user is available', started_at = NULL WHERE run_id = ?", status, runId(1));
    });
    const read = await tool("runs_read").execute({ runId: runId(1) }, context);
    expect(read.output).toMatchObject({ status, transcriptAvailability: "not_provisioned" });
    expect(evidence(read.output)).toMatchObject({ definition: { instructions: draft.instructions },
      resultSummary: "No delegated user is available", turns: [] });
    expect(read.pagination?.continuations).toEqual([]);
  });

  it("inspects as another authorized viewer without seating them or changing unread state", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    await env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,status,role) VALUES (?,?,'active','member')").bind(WORKSPACE, VIEWER).run();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE automation_directory SET scope = 'workspace' WHERE automation_id = ?", SIDEKICK);
    });
    const snapshot = () => runInDurableObject(child(runId(1)), (_instance, state) => ({
      participants: state.storage.sql.exec("SELECT * FROM participants ORDER BY user_id").toArray(),
      attention: state.storage.sql.exec("SELECT * FROM member_attention ORDER BY user_id").toArray(),
    }));
    const before = await snapshot();
    const read = await tool("runs_read", { executionPrincipal: { type: "user", userId: VIEWER } }).execute({ runId: runId(1) }, context);
    expect(JSON.stringify(evidence(read.output))).toContain("Owner: Maya");
    expect(await snapshot()).toEqual(before);
  });

  it.each([{ transient: true, summary: "Transient search" }, { truncated: true, preview: "Serialization unavailable" }])(
    "marks persisted placeholders summary-only (%j)", async (placeholder) => {
      await seedRuns(SIDEKICK, 1);
      await seedHistory();
      await env.PAYLOADS.put(`sidekick-history/${runId(1)}`, JSON.stringify({ replayVersion: 1, output: placeholder }));
      const results = toolsIn((await tool("runs_read").execute({ runId: runId(1) }, context)).output);
      expect(results).toEqual([expect.objectContaining({ resultAvailability: "summary_only", summary: "Delivery refused" })]);
      expect(results[0]).not.toHaveProperty("output");
    });

  it("pages oversized evidence losslessly within the existing conversation character budget", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    const text = "Large result with an emoji 🙂. ".repeat(2000);
    await env.PAYLOADS.put(`sidekick-history/${runId(1)}`, JSON.stringify({ replayVersion: 1, output: { text } }));
    const read = tool("runs_read");
    let result = await read.execute({ runId: runId(1) }, context);
    let collected = "";
    let pages = 0;
    for (;;) {
      const part = z.object({ content: z.string(), contentOffset: z.number(), pageComplete: z.boolean() }).parse(result.output);
      expect(part.content.length).toBeLessThanOrEqual(CONVERSATION_READ_CHARACTER_BUDGET);
      expect(part.contentOffset).toBe(collected.length);
      collected += part.content;
      pages++;
      const next = result.pagination?.continuations[0];
      if (!next) { expect(part.pageComplete).toBe(true); break; }
      result = await read.execute(next.input, context);
    }
    expect(pages).toBeGreaterThan(1);
    const reconstructed = evidence({ content: collected });
    expect(reconstructed.turns.flatMap((turn) => turn.blocks)).toContainEqual(expect.objectContaining({ type: "tool", output: { text } }));
    expect(collected.split(draft.instructions)).toHaveLength(2);
  });

  it("refuses a fragment continuation after the run's result moved", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    await env.PAYLOADS.put(`sidekick-history/${runId(1)}`, JSON.stringify({ replayVersion: 1, output: { text: "x".repeat(20000) } }));
    const first = await tool("runs_read").execute({ runId: runId(1) }, context);
    // The evidence is the run and its transcript: a run whose result moved is a different run.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE sidekick_runs SET summary = 'Report delivered after all' WHERE run_id = ?", runId(1));
    });
    // A fresh tool instance rebuilds the page rather than serving the one it remembers.
    await expect(tool("runs_read").execute(first.pagination!.continuations[0]!.input, context)).rejects.toThrow("Run evidence changed");
  });

  it("serves every fragment of a page from one document, whatever a payload read does meanwhile", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    const text = "x".repeat(20000);
    await env.PAYLOADS.put(`sidekick-history/${runId(1)}`, JSON.stringify({ replayVersion: 1, output: { text } }));
    // Full output on the first fragment, then the payload becomes unreadable:
    // the activation that served the first fragment still serves the rest,
    // and the whole parses to the output it started with.
    const read = tool("runs_read");
    const first = await read.execute({ runId: runId(1) }, context);
    await env.PAYLOADS.delete(`sidekick-history/${runId(1)}`);
    // A read restarted meanwhile builds its own document and does not replace the one still being sliced.
    await read.execute({ runId: runId(1) }, context);
    let collected = z.object({ content: z.string() }).parse(first.output).content;
    let result = first;
    while (result.pagination?.continuations[0]) {
      result = await read.execute(result.pagination.continuations[0].input, context);
      collected += z.object({ content: z.string() }).parse(result.output).content;
    }
    expect(toolsIn({ content: collected })).toEqual([expect.objectContaining({ toolCallId: "delivery-call", output: { text }, resultAvailability: "full" })]);
    // Another activation cannot serve the first fragment's document and says so, rather than splicing a summary into it.
    await expect(tool("runs_read").execute(first.pagination!.continuations[0]!.input, context)).rejects.toThrow("can no longer be loaded");
  });

  it("keeps a summary on every fragment once the payload becomes readable", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    const text = "x".repeat(20000);
    // A summary on the first fragment stays a summary on every later one,
    // whichever activation serves them, so the fragments join into one document.
    await env.PAYLOADS.put(`sidekick-history/${runId(1)}`, JSON.stringify({ replayVersion: 1, output: { text } }));
    await runInDurableObject(child(runId(1)), async (_instance, state) => {
      await new WorkstreamTranscriptStorage(state.storage).appendParticipantMessage({ turnId: "long-feedback", actor: "human",
        authorUserId: USER, authorSnapshot: { displayName: "Adam", avatarUrl: null }, text: "y".repeat(20000),
        createdAtUtc: "2026-10-23T00:00:03.000Z", attentionOrdinal: null });
    });
    await env.PAYLOADS.delete(`sidekick-history/${runId(1)}`);
    const summaryFirst = await tool("runs_read").execute({ runId: runId(1) }, context);
    await env.PAYLOADS.put(`sidekick-history/${runId(1)}`, JSON.stringify({ replayVersion: 1, output: { text } }));
    let joined = z.object({ content: z.string() }).parse(summaryFirst.output).content;
    let result = summaryFirst;
    while (result.pagination?.continuations[0]) {
      result = await tool("runs_read").execute(result.pagination.continuations[0].input, context);
      joined += z.object({ content: z.string() }).parse(result.output).content;
    }
    const [block] = toolsIn({ content: joined });
    expect(block).toMatchObject({ toolCallId: "delivery-call", resultAvailability: "not_available" });
    expect(block).not.toHaveProperty("output");
  });

  it("reauthorizes resource results against the selected run and withholds revoked content", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    await bootstrapConversationChildRuntime(env, WORKSPACE, "automation", SIDEKICK, "0");
    await provisionWorkstreamObject(env, { workspaceId: WORKSPACE, workstreamId: SIDEKICK, substreamId: "0",
      title: "Incident report wizard", objective: draft.instructions, scope: "personal", createdByUserId: USER,
      participantUserIds: [USER], harnessStatus: "idle", emailAddress: null, emailRouteStatus: null,
      systemKind: null, modelOverride: null, now: 100 });
    const hash = "a".repeat(64);
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id,workspace_id,resource_type,provider,title,mime_type,model_content_sha256,metadata_json,attachment_status,created_at,updated_at)
        VALUES (?,?,'generated_file','avalon_generated','Private report','text/plain',?,'{}','attached','2026-10-23','2026-10-23')`, RESOURCE, WORKSPACE, hash);
    });
    await runInDurableObject(child(runId(1)), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO workstream_resource_links
        (resource_id,attached_by_user_id,watch_enabled,relationship_type,resource_json,attached_at,updated_at)
        VALUES (?,NULL,0,'attachment','{}',1,1)`, RESOURCE);
      state.storage.sql.exec(`UPDATE tool_effects SET status='completed',tool_name='workstream_read_resource',
        execution_plan_json='{"capability":"workstream.resources.read","canonicalToolName":"read_resource"}',
        input_json=?,error_json=NULL,output_summary='Private report summary' WHERE effect_intent_id='delivery-effect'`, JSON.stringify({ resourceId: RESOURCE }));
      state.storage.sql.exec(`INSERT INTO attachment_tool_receipts
        (workspace_id,resource_id,tool_invocation_id,derivative_sha256,created_at) VALUES (?,?,'delivery-effect',?,1)`, WORKSPACE, RESOURCE, hash);
    });
    await env.PAYLOADS.put(`sidekick-history/${runId(1)}`, JSON.stringify({ replayVersion: 1,
      output: { resourceId: RESOURCE, text: "Confidential attachment content", version: { sha256: hash } } }));
    const first = await tool("runs_read").execute({ runId: runId(1) }, context);
    expect(toolsIn(first.output)).toEqual([expect.objectContaining({ resultAvailability: "full", output: expect.objectContaining({ text: "Confidential attachment content" }) })]);
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET model_content_sha256 = ? WHERE id = ?", "b".repeat(64), RESOURCE);
    });
    const changed = await tool("runs_read").execute({ runId: runId(1) }, context);
    expect(toolsIn(changed.output)).toEqual([expect.objectContaining({ resultAvailability: "unavailable" })]);
    expect(JSON.stringify(changed.output)).not.toContain("Confidential attachment");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET model_content_sha256 = ? WHERE id = ?", hash, RESOURCE);
    });
    await runInDurableObject(child(runId(1)), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM workstream_resource_links WHERE resource_id = ?", RESOURCE);
    });
    const detached = await tool("runs_read").execute({ runId: runId(1) }, context);
    expect(toolsIn(detached.output)).toEqual([{ type: "tool", toolCallId: "delivery-call", toolName: "slack_send_message",
      resultAvailability: "unavailable", reason: "resource_access_or_version_unavailable" }]);
    expect(JSON.stringify(detached.output)).not.toContain("Confidential attachment");
    expect(JSON.stringify(detached.output)).not.toContain("Private report summary");
    expect(JSON.stringify(detached.output)).not.toContain(RESOURCE);

    // A page that holds a resource result is reauthorized on every fragment,
    // not served from memory: once the version moves, the continuation that
    // carried the content in full is refused rather than sliced from a cache.
    await runInDurableObject(child(runId(1)), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO workstream_resource_links
        (resource_id,attached_by_user_id,watch_enabled,relationship_type,resource_json,attached_at,updated_at)
        VALUES (?,NULL,0,'attachment','{}',1,1)`, RESOURCE);
    });
    await env.PAYLOADS.put(`sidekick-history/${runId(1)}`, JSON.stringify({ replayVersion: 1,
      output: { resourceId: RESOURCE, text: `Confidential attachment content ${"x".repeat(20000)}`, version: { sha256: hash } } }));
    const read = tool("runs_read");
    const fragment = await read.execute({ runId: runId(1) }, context);
    expect(fragment.output).toMatchObject({ pageComplete: false });
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET model_content_sha256 = ? WHERE id = ?", "c".repeat(64), RESOURCE);
    });
    await expect(read.execute(fragment.pagination!.continuations[0]!.input, context)).rejects.toThrow("can no longer be loaded");
  });

  it("records a revision against the review while its notice is the authoring conversation's last word", async () => {
    // The wizard may hand reads to a background agent and end its turn; the
    // agent's reply wakes it with that reply as the reason, and the revision
    // it then saves is still the review's. A person's message ends the review.
    await bootstrapConversationChildRuntime(env, WORKSPACE, "automation", SIDEKICK, "0");
    await provisionWorkstreamObject(env, { workspaceId: WORKSPACE, workstreamId: SIDEKICK, substreamId: "0",
      title: "Incident report", objective: draft.instructions, scope: "personal", createdByUserId: USER,
      participantUserIds: [USER], harnessStatus: "idle", emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: null, now: 100 });
    const delivered = "00000000-0000-7000-8000-00000000fa40";
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO sidekick_reviews(sidekick_id, review_id, definition_revision, coordinator_user_id, notice_json, requested_at, delivered_at)
         VALUES (?, ?, 1, ?, '{}', 100, 101)`, SIDEKICK, delivered, USER);
    });
    const say = (turnId: string, message: Partial<Parameters<WorkstreamTranscriptStorage["appendParticipantMessage"]>[0]>) =>
      runInDurableObject(child("0"), (_instance, state) => new WorkstreamTranscriptStorage(state.storage).appendParticipantMessage({
        turnId, actor: "assistant", authorUserId: null, authorSnapshot: null, text: turnId, createdAtUtc: "2026-10-30T00:00:00.000Z",
        attentionOrdinal: null, ...message }));
    const agentRow = (turnId: string, senderAgentId: string) => say(turnId, { actor: "system", messageType: "system",
      structuredContentJson: JSON.stringify({ kind: "agent_message", senderAgentId, teamId: senderAgentId, messageId: runId(50) }) });
    // The review's agents are the ones the wizard started: a delegation, not
    // an address. A run of the same Sidekick has the same address shape.
    const wizard = `automation/${SIDEKICK}/0` as never;
    const ownAgent = `automation/${SIDEKICK}/${runId(8)}`;
    const { teamId } = await workspace().ensureAgentTeam({ workspaceId: WORKSPACE, originAgentId: wizard });
    expect(await workspace().registerAgentDelegation({ workspaceId: WORKSPACE, teamId: teamId as never,
      ownerAgentId: wizard, agentId: ownAgent as never })).toMatchObject({ ok: true });
    await say("notice", { actor: "system", messageType: "system", structuredContentJson: JSON.stringify({ kind: "sidekick_review_due", reviewId: delivered }) });
    await agentRow("agent-reply", ownAgent);
    const submit = (reason: string, instructions: string) => tool("submit_draft", { reason })
      .execute({ ...draft, sidekickId: null, icon: "inbox", color: "blue", instructions, ready: true }, context);
    await submit("agent_message", "Reviewed: list active incidents with owners.");
    // A turn the person woke is theirs before any row is read.
    await submit("human_message", "A person's own change.");
    // The wizard's own agents keep the review open; a request from any other agent ends it.
    await agentRow("agent-reply-again", ownAgent);
    await submit("agent_message", "Reviewed again: name the owner first.");
    // One of this Sidekick's runs passing on a person's change request is not the review's.
    await agentRow("run-change-request", `automation/${SIDEKICK}/${runId(9)}`);
    await submit("agent_message", "A change a person asked for in a run's Slack thread.");
    await agentRow("outside-request", `workstream/${runId(7)}/0`);
    await submit("agent_message", "A change a person asked for from another Thread.");
    await say("person", { actor: "human", authorUserId: USER, authorSnapshot: { displayName: "Adam", avatarUrl: null } });
    await submit("agent_message", "An agent's reply after the person spoke.");
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ definition_revision: number; review_id: string | null }>(
      `SELECT definition_revision, review_id FROM sidekick_revisions WHERE sidekick_id = ? AND definition_revision >= 2 ORDER BY definition_revision`,
      SIDEKICK).toArray())).toEqual([{ definition_revision: 2, review_id: delivered }, { definition_revision: 3, review_id: null },
      { definition_revision: 4, review_id: delivered }, { definition_revision: 5, review_id: null }, { definition_revision: 6, review_id: null },
      { definition_revision: 7, review_id: null }]);
  });

  it("exposes first/next companions and rejects invented page IDs before reading history", async () => {
    const history = plugin({}, true).tools.filter((candidate) => candidate.definition.capability.startsWith("rally.sidekick.runs."));
    expect(history.map((candidate) => candidate.definition.name)).toEqual(["runs_list", "runs_list_next", "runs_read", "runs_read_next"]);
    await expect(history[1]!.execute({ pageId: "invented" }, context)).rejects.toThrow("pageId");
    await expect(history[0]!.execute({ cursor: "forged" }, context)).rejects.toThrow();
  });
});
