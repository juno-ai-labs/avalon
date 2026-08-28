/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import {
  asAutomationId,
  asUserId,
  asWorkspaceId,
} from "@rally/contracts";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AutomationAgent } from "../src/durable-objects/automation-agent";
import { materializeAutomationMemoryDefinitions } from "../src/durable-objects/automation-agent-memory";
import { canonicalTranscriptJson } from "../src/durable-objects/ordered-transcript-sqlite/canonical-payload-store";
import { automationAgentName } from "../src/durable-objects/names";
import { sha256 } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { AutomationAgentService } from "../src/services/automation-agent-service";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000b1");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-0000000000b2");
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-0000000000b3");
const CLIENT_MESSAGE_ID = "00000000-0000-7000-8000-0000000000b4";

function automationStub() {
  return env.AUTOMATION_AGENTS.get(env.AUTOMATION_AGENTS.idFromName(
    automationAgentName("global", WORKSPACE_ID, AUTOMATION_ID),
  ));
}

beforeEach(async () => {
  await reset();
  await env.DB.prepare(`CREATE TABLE workstream_email_routes (
    local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
    workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (region, workspace_id, workstream_id),
    UNIQUE (region, workspace_id, automation_subscription_id))`).run();
  await env.DB.prepare(
    `INSERT INTO workstream_email_routes
       (local_part, region, workspace_id, workstream_id, automation_subscription_id, created_at, updated_at)
     VALUES ('amber-cobalt-jade-river', 'global', ?, NULL, ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`,
  ).bind(WORKSPACE_ID, AUTOMATION_ID).run();
});

describe("AutomationAgent", () => {
  it("persists identity, the first human turn, and one compiler admission before dispatch", async () => {
    const stub = automationStub();
    await runInDurableObject(stub, async (instance: AutomationAgent, state) => {
      (instance as unknown as { executeCompilerRun(runId: string): Promise<void> }).executeCompilerRun = async () => {};
      const request = {
        schemaVersion: 1 as const,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global" as const,
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "Tell me when a Slack message contains foobar",
        attachmentIds: [],
        inputMode: "typed" as const,
      };

      const first = await instance.admitDraftTurn(request);
      const retry = await instance.admitDraftTurn(request);

      expect(first.admitted).toBe(true);
      expect(retry).toEqual({ ...first, admitted: false });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM transcript_payloads`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_compiler_runs`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ author_user_id: string }>(
        `SELECT author_user_id FROM automation_identity WHERE id = 1`,
      ).one().author_user_id).toBe(AUTHOR_ID);
      expect(await state.storage.getAlarm()).not.toBeNull();

      await expect(instance.admitDraftTurn({
        ...request,
        clientMessageId: "00000000-0000-7000-8000-0000000000b5",
        content: "A second concurrent turn",
      })).rejects.toThrow("automation_compiler_busy");
    });
  });

  it("records evaluator replacement and receipt in the same object transaction", async () => {
    const stub = automationStub();
    await runInDurableObject(stub, async (instance: AutomationAgent, state) => {
      (instance as unknown as { executeCompilerRun(runId: string): Promise<void> }).executeCompilerRun = async () => {};
      const admission = await instance.admitDraftTurn({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "Watch Slack",
        attachmentIds: [],
        inputMode: "typed",
      });
      state.storage.sql.exec(
        `UPDATE automation_compiler_runs SET state = 'running' WHERE run_id = ?`,
        admission.compilerRunId,
      );
      const mutation = {
        schemaVersion: 1 as const,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        compilerRunId: admission.compilerRunId,
        providerCallId: "call-1",
        inputHash: "sha256:rules",
        evaluatorRules: { schemaVersion: 1, evaluators: [] },
      };

      expect(await instance.setEvaluatorRules(mutation)).toEqual({ accepted: true });
      expect(await instance.setEvaluatorRules(mutation)).toEqual({ accepted: true });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_tool_receipts`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ evaluator_rules_json: string }>(
        `SELECT evaluator_rules_json FROM automation_draft_evaluator_sets`,
      ).one().evaluator_rules_json).toBe('{"schemaVersion":1,"evaluators":[]}');
    });
  });

  it("accepts the canonical revision in place and deletes only the draft conversation", async () => {
    const stub = automationStub();
    await runInDurableObject(stub, async (instance: AutomationAgent, state) => {
      (instance as unknown as { executeCompilerRun(runId: string): Promise<void> }).executeCompilerRun = async () => {};
      (instance as unknown as { workspace(): unknown }).workspace = async () => ({
        applyExternalEventRegistrations: async () => ({
          applied: true,
          effectiveAfterEventSequence: 7,
        }),
        applyAutomationProjection: async () => ({ applied: true }),
      });
      const admission = await instance.admitDraftTurn({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        clientMessageId: CLIENT_MESSAGE_ID,
        content: "Run when I ask",
        attachmentIds: [],
        inputMode: "typed",
      });
      const definition = {
        name: "Manual helper",
        description: "Runs on request",
        overview: "A manual automation",
        instructions: "Do the requested work.",
        triggers: [{ type: "manual" as const }],
        requiredCapabilities: [],
        expectedOutputs: [],
        requestedDelivery: [],
        defaultBehavior: {},
        recommendedPlugins: [],
        memoryTables: [],
        suggestedScope: "personal" as const,
        followUpQuestion: null,
        elicitation: null,
        ready: true,
      };
      state.storage.sql.exec(
        `UPDATE automation_compiler_runs SET state = 'completed', settled_at = 1 WHERE run_id = ?`,
        admission.compilerRunId,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_definition_revisions
           (definition_revision, compiler_run_id, definition_json, definition_hash, ready, created_at)
         VALUES (1, ?, ?, 'sha256:definition', 1, 1)`,
        admission.compilerRunId,
        JSON.stringify(definition),
      );
      state.storage.sql.exec(
        `UPDATE automation_state SET definition_revision = 1, title = ? WHERE id = 1`,
        definition.name,
      );

      const detail = await instance.acceptDraft({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        definitionRevision: 1,
        scope: "personal",
        defaultPluginIds: [],
        activitySourcePluginIds: {},
        deliveryTargets: [],
        modelOverride: null,
      });

      expect(detail).toMatchObject({ id: AUTOMATION_ID, name: "Manual helper", status: "active" });
      expect(state.storage.sql.exec<{ lifecycle: string }>(
        `SELECT lifecycle FROM automation_state WHERE id = 1`,
      ).one().lifecycle).toBe("active");
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns`,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_definition_revisions`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ effective_after_event_sequence: number }>(
        `SELECT effective_after_event_sequence FROM automation_acceptance WHERE id = 1`,
      ).one().effective_after_event_sequence).toBe(7);

      const started = await instance.runNow({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
        idempotencyKey: "manual-overview-run",
      });
      const afterRun = await instance.readDetail({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
      });
      expect(afterRun.recentRuns).toEqual([expect.objectContaining({
        id: started.runId,
        workstreamId: started.workstreamId,
        triggerType: "manual",
        status: "scheduled",
      })]);
      await expect(instance.listRuns({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
      })).resolves.toEqual({ items: afterRun.recentRuns });
    });
  });

  it("owns generated-run memory behind a generation fence and replays write receipts", async () => {
    const stub = automationStub();
    await runInDurableObject(stub, async (instance: AutomationAgent, state) => {
      const now = Date.now();
      const runId = "00000000-0000-7000-8000-0000000000c1";
      const harnessRunId = "00000000-0000-7000-8000-0000000000c2";
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region,
            authority_generation, created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID,
        WORKSPACE_ID,
        AUTHOR_ID,
        now,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Memory owner', 1, 1, 0, ?, ?)`,
        now,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, workstream_id, harness_run_id,
            admission_state, execution_state, delivery_state, context_json,
            source_version, created_at, updated_at)
         VALUES (?, 'manual:memory-test', 'manual', ?, ?, 'provisioned', 'running',
                 'pending', '{}', 1, ?, ?)`,
        runId,
        "00000000-0000-7000-8000-0000000000c3",
        harnessRunId,
        now,
        now,
      );
      const fence = {
        schemaVersion: 1 as const,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        runId,
        harnessRunId,
        authorityGeneration: 1,
      };
      const add = {
        ...fence,
        operation: "add" as const,
        providerIdempotencyKey: "memory-call-1",
        args: {
          scopeKind: "automation",
          text: "The release channel is #shipping.",
          rationale: "Remember the canonical release destination.",
        },
      };

      const first = await instance.executeMemoryTool(add);
      const replay = await instance.executeMemoryTool(add);
      expect(replay).toEqual(first);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_memory_items`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_memory_mutations`,
      ).one().count).toBe(1);

      await expect(instance.executeMemoryTool({
        ...fence,
        operation: "search",
        args: { query: "release channel" },
      })).resolves.toMatchObject({
        output: { results: [{ text: "The release channel is #shipping." }] },
      });
      await expect(instance.executeMemoryTool({
        ...fence,
        authorityGeneration: 2,
        operation: "search",
        args: { query: "release" },
      })).rejects.toThrow("automation_memory_authority_fenced");
    });
  });

  it("answers a refusal from a real stub as the API's own error, not a 500", async () => {
    // Against a real Durable Object stub, deliberately. The mapping used to be
    // a `Proxy` around the stub, which every plain-object double in the tree
    // accepted and workerd did not: the trap handed the stub's own method the
    // proxy as its receiver, and an RPC's return value is a pipelining thenable
    // rather than a native `Promise`, so the branch attaching the mapping never
    // ran. Only a real stub can tell those apart.
    const testEnv: Env = env;
    const service = new AutomationAgentService(testEnv, {
      sessionId: "session-1",
      userId: AUTHOR_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "member",
    });

    // Nobody has opened this automation, so the object has no identity and
    // refuses with `automation_identity_missing` — a 404, not a server fault.
    await expect(service.detail(AUTOMATION_ID)).rejects.toMatchObject({
      status: 404,
      code: "automation_identity_missing",
    });
  });

  it("tells a reader why an imported automation with an unrunnable trigger is stopped", async () => {
    // The one thing a person has to be told after the cutover: this automation
    // is not waiting for its next run, it has none. The reason travels on the
    // detail the screen reads and on every projection the sidebar reads, or the
    // person is left with a red dot and no sentence.
    const source = {
      definition: {
        name: "Release watcher",
        description: "Summarizes a watched release document when it changes",
        overview: "Watches one document",
        instructions: "Summarize what changed.",
        triggers: [{ type: "resource_watch" as const, resourceId: "00000000-0000-7000-8000-0000000000d1" }],
        requiredCapabilities: [],
        expectedOutputs: [],
        requestedDelivery: [],
        defaultBehavior: {},
        recommendedPlugins: [],
        memoryTables: [],
        suggestedScope: "personal" as const,
        followUpQuestion: null,
        elicitation: null,
        ready: true,
      },
      status: "active" as const,
      scope: "personal" as const,
      unsupportedTrigger: true,
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      connectorBindings: {},
      deliveryTargets: [],
      emailAddress: null,
      modelOverride: null,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_001,
      schedules: [],
      runs: [],
      memoryRecords: [],
    };
    const sourceHash = await sha256(canonicalTranscriptJson(source));

    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      (instance as unknown as { workspace(): unknown }).workspace = async () => ({
        applyExternalEventRegistrations: async () => ({ applied: true, effectiveAfterEventSequence: 0 }),
        applyAutomationProjection: async () => ({ applied: true }),
      });

      await instance.importAcceptedAutomation({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        sourceHash,
        source,
      });

      const detail = await instance.readDetail({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
      });
      expect(detail).toMatchObject({ status: "paused", attention: "unsupported_trigger" });

      // Resuming does not make the trigger expressible, and it is the moment
      // the directory's copy of the reason used to be overwritten with "nothing
      // is wrong" — leaving the sidebar marker to disappear off a button press
      // while this object still says the automation cannot run.
      await instance.resume({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
      });
      const projected = state.storage.sql.exec<{ payload_json: string }>(
        `SELECT payload_json FROM automation_outbox
          WHERE effect_kind = 'workspace_projection' ORDER BY created_at DESC LIMIT 1`,
      ).one();
      expect(JSON.parse(projected.payload_json)).toMatchObject({
        lifecycle: "active",
        attentionCode: "unsupported_trigger",
      });
    });
  });

  it("keeps a memory table's identity when a later revision adds one ahead of it", async () => {
    const table = (name: string) => ({
      name,
      description: `Rows about ${name}.`,
      usageInstructions: `Look up ${name} by key.`,
      columns: [{ name: "key", description: "The natural key.", type: "string", required: true, searchable: false }],
      keyColumns: ["key"],
    });
    await runInDurableObject(automationStub(), async (_instance: AutomationAgent, state) => {
      const materialize = (definitions: unknown): void =>
        materializeAutomationMemoryDefinitions(state.storage, AUTOMATION_ID, definitions, 1_800_000_000_000);

      materialize([table("Releases")]);
      const before = state.storage.sql.exec<{ table_id: string; name: string }>(
        `SELECT table_id, name FROM automation_memory_tables`,
      ).toArray();

      // The compiler is free to emit the set in any order, and a later
      // revision that puts a new table first used to be handed the id the
      // surviving table already holds.
      materialize([table("Incidents"), table("Releases")]);

      const after = state.storage.sql.exec<{ table_id: string; name: string }>(
        `SELECT table_id, name FROM automation_memory_tables ORDER BY name`,
      ).toArray();
      expect(after.map((row) => row.name)).toEqual(["Incidents", "Releases"]);
      expect(new Set(after.map((row) => row.table_id)).size).toBe(2);
      expect(after.find((row) => row.name === "Releases")?.table_id)
        .toBe(before[0]?.table_id);
    });
  });
});
