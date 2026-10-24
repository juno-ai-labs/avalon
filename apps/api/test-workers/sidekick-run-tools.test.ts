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

  it("offers run inspection only to the authoring conversation", () => {
    expect(plugin().tools.filter((candidate) => candidate.definition.capability.startsWith("rally.sidekick.runs.")).map((candidate) => candidate.definition.mode)).toEqual(["read", "read"]);
    for (const overrides of [{ parentKind: "workstream" as const }, { substreamId: asSubstreamId(runId(1)) }, { backgroundAgent: true }]) {
      expect(plugin(overrides).tools.some((candidate) => candidate.definition.capability.startsWith("rally.sidekick.runs."))).toBe(false);
    }
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

  it("refuses a fragment continuation when the evidence changes", async () => {
    await seedRuns(SIDEKICK, 1);
    await seedHistory();
    await env.PAYLOADS.put(`sidekick-history/${runId(1)}`, JSON.stringify({ replayVersion: 1, output: { text: "x".repeat(20000) } }));
    const read = tool("runs_read");
    const first = await read.execute({ runId: runId(1) }, context);
    await env.PAYLOADS.delete(`sidekick-history/${runId(1)}`);
    await expect(read.execute(first.pagination!.continuations[0]!.input, context)).rejects.toThrow("Run evidence changed");
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
  });

  it("exposes first/next companions and rejects invented page IDs before reading history", async () => {
    const history = plugin({}, true).tools.filter((candidate) => candidate.definition.capability.startsWith("rally.sidekick.runs."));
    expect(history.map((candidate) => candidate.definition.name)).toEqual(["runs_list", "runs_list_next", "runs_read", "runs_read_next"]);
    await expect(history[1]!.execute({ pageId: "invented" }, context)).rejects.toThrow("pageId");
    await expect(history[0]!.execute({ cursor: "forged" }, context)).rejects.toThrow();
  });
});
