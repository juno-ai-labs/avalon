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
import {
  importLegacyAutomationMemory,
  materializeAutomationMemoryDefinitions,
} from "../src/durable-objects/automation-agent-memory";
import { canonicalTranscriptJson } from "../src/durable-objects/ordered-transcript-sqlite/canonical-payload-store";
import { automationAgentName, workspaceDOName } from "../src/durable-objects/names";
import { sha256 } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { AutomationAgentService } from "../src/services/automation-agent-service";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000b1");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-0000000000b2");
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-0000000000b3");
/** The room these fixtures are drafted in, since a draft now always has one. */
const AUTHORING_WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000b9";

function automationStub() {
  return env.AUTOMATION_AGENTS.get(env.AUTOMATION_AGENTS.idFromName(
    automationAgentName("global", WORKSPACE_ID, AUTOMATION_ID),
  ));
}

beforeEach(async () => {
  await reset();
  await env.DB.prepare(`CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, region TEXT NOT NULL, abandoned_at TEXT
  )`).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, region, abandoned_at) VALUES (?, 'global', NULL)`,
  ).bind(WORKSPACE_ID).run();
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

/** The compiled definition a create test submits, in the shape the object stores. */
function readyDefinition(name: string) {
  return {
    name,
    description: "Summarize unread email every weekday morning.",
    overview: "Each weekday at 9:00 AM, write a short digest.",
    instructions: "Summarize the unread email, most important first.",
    triggers: [{ type: "manual" as const }],
    requiredCapabilities: [],
    expectedOutputs: [],
    // Typed rather than inferred: several tests spread this fixture and replace
    // one of these, and an inferred `never[]` refuses every replacement.
    defaultBehavior: {},
    recommendedPlugins: [] as Array<{
      pluginId: string;
      recommendedTools: string[];
      reason: string;
    }>,
    memoryTables: [],
    suggestedScope: "personal" as const,
    followUpQuestion: null,
    elicitation: null,
    ready: true,
  };
}

/**
 * An automation holding one ready definition — the state a person is in when a
 * proposal card offers them Create.
 *
 * Seeded through `admitAuthoredDraft`, which is the only way a draft is made
 * now that the compiler loop is gone. That makes these fixtures exercise the
 * surviving path rather than a retired one, so a change to how a draft is
 * recorded breaks them here rather than in production.
 */
async function seedReadyDraft(definition: ReturnType<typeof readyDefinition>): Promise<void> {
  await runInDurableObject(automationStub(), async (instance: AutomationAgent) => {
    await instance.admitAuthoredDraft({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      authorUserId: AUTHOR_ID,
      region: "global",
      authoredInWorkstreamId: AUTHORING_WORKSTREAM_ID,
      draft: definition,
    });
  });
}

/** The REST boundary, as the author of the seeded draft. */
function authorService(): AutomationAgentService {
  const testEnv: Env = env;
  return new AutomationAgentService(testEnv, {
    sessionId: "session-1",
    userId: AUTHOR_ID,
    workspaceId: WORKSPACE_ID,
    region: "global",
    role: "member",
  });
}

/** Acceptance registers evaluators on WorkspaceDO, and an object that has never
 * been addressed refuses every caller with `workspace_object_identity_mismatch`.
 * Pinning the identity through the method that exists for it keeps an
 * acceptance assertion a real round trip rather than a patched `workspace()`. */
async function pinWorkspaceIdentity(): Promise<void> {
  await env.WORKSPACE_DOS
    .get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
    .initializeWorkspace(WORKSPACE_ID, "wnam");
}

describe("AutomationAgent", () => {
  it("retires scheduled and claimed work after its workspace is abandoned", async () => {
    const now = 1_800_000_000_000;
    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region, authority_generation,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID, WORKSPACE_ID, AUTHOR_ID, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Abandoned helper', 1, 1, 0, ?, ?)`,
        now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_schedules
           (schedule_id, schedule_kind, definition_json, next_due_at, paused, updated_at)
         VALUES ('schedule-abandoned', 'interval', ?, ?, 0, ?)`,
        JSON.stringify({ acceptedAt: now, intervalSeconds: 60 }), now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, admission_state, execution_state,
            delivery_state, context_json, source_version, created_at, updated_at)
         VALUES ('00000000-0000-7000-8000-0000000000c1', 'manual:abandoned', 'manual',
                 'claimed', 'pending', 'pending', '{}', 1, ?, ?)`,
        now, now,
      );
      await env.DB.prepare(`UPDATE workspaces SET abandoned_at = ? WHERE id = ?`)
        .bind('2026-09-01T00:00:00.000Z', WORKSPACE_ID).run();

      await (instance as unknown as { executeSchedule(id: string): Promise<void> })
        .executeSchedule('schedule-abandoned');
      await (instance as unknown as { provisionNextRun(): Promise<void> }).provisionNextRun();

      expect(state.storage.sql.exec<{ paused: number; next_due_at: number | null }>(
        `SELECT paused, next_due_at FROM automation_schedules WHERE schedule_id = 'schedule-abandoned'`,
      ).one()).toEqual({ paused: 1, next_due_at: null });
      expect(state.storage.sql.exec<{
        admission_state: string;
        execution_state: string;
        delivery_state: string;
      }>(`SELECT admission_state, execution_state, delivery_state FROM automation_runs
           WHERE occurrence_key = 'manual:abandoned'`).one()).toEqual({
        admission_state: 'refused',
        execution_state: 'stopped',
        delivery_state: 'not_requested',
      });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_runs WHERE occurrence_key LIKE 'schedule:%'`,
      ).one().count).toBe(0);
    });
  });

  it("refuses an event-driven submission with no rules, and admits one that has them", async () => {
    const NOTION_CONNECTION_ID = "00000000-0000-7000-8000-0000000000ba";
    const eventDriven = (ready: boolean) => ({
      ...readyDefinition("Report on new pages"),
      triggers: [{
        type: "connector_activity" as const,
        connectorType: "notion",
        sourceBindingKey: "notion_source",
        suggestedSourcePluginId: "plugin_notion",
        eventTypes: ["notion.page.created"],
        deterministicFilters: {},
      }],
      ready,
    });
    const rules = {
      schemaVersion: 1 as const,
      evaluators: [{
        evaluatorKey: "page_created",
        source: {
          sourceBindingKey: "notion_source",
          suggestedSourcePluginId: "plugin_notion",
          event: { kind: "event_type" as const, eventType: "notion.page.created" },
        },
        when: { kind: "always" as const },
      }],
    };
    // Notion because the registry admits it without provider credentials, so
    // acceptance resolves a real adapter and validates the rules against its
    // real declared event vocabulary rather than a double.
    await pinWorkspaceIdentity();
    await runInDurableObject(
      env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID))),
      (_workspace, state) => {
        state.storage.sql.exec(
          `INSERT INTO connector_connections
             (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
              display_name, granted_scopes_json, status, cursor_json, config_json,
              created_at, updated_at, model_plugin_id)
           VALUES (?, ?, 'notion', 'personal', ?, 'acct', 'A connection', '[]', 'healthy',
                   '{}', '{}', 1, 1, 'plugin_notion')`,
          NOTION_CONNECTION_ID, WORKSPACE_ID, AUTHOR_ID,
        );
      },
    );

    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      (instance as unknown as { workspace(): unknown }).workspace = async () => ({
        applyExternalEventRegistrations: async () => ({ applied: true, effectiveAfterEventSequence: 7 }),
        applyAutomationProjection: async () => ({ applied: true }),
      });
      // `undefined` means omit the field, so Zod's `.default(null)` supplies it;
      // an explicit set — even an empty one — is the other path through the guard.
      const submit = (draft: unknown, evaluatorRules: unknown) => instance.admitAuthoredDraft({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        authoredInWorkstreamId: AUTHORING_WORKSTREAM_ID,
        ...(evaluatorRules === undefined ? {} : { evaluatorRules }),
        draft,
      });

      // A ready event-driven draft with no rules is what used to reach a person
      // as a proposal card whose Create could only refuse.
      await expect(submit(eventDriven(true), undefined))
        .rejects.toThrow("automation_evaluator_rules_required");
      // An empty set is the same answer, so the guard cannot be satisfied by
      // merely having called the tool.
      await expect(submit(eventDriven(true), { schemaVersion: 1, evaluators: [] }))
        .rejects.toThrow("automation_evaluator_rules_required");
      // The predicate covers three trigger kinds and is shared with acceptance,
      // so it is the single place a new kind would be missed. A second kind is
      // asserted for that reason rather than for the string comparison.
      await expect(submit({
        ...readyDefinition("Watch for a mention"),
        triggers: [{
          type: "semantic_activity" as const,
          connectorType: "notion",
          sourceBindingKey: "notion_source",
          suggestedSourcePluginId: "plugin_notion",
          deterministicPrefilter: { eventType: "notion.comment.created" },
          condition: "The comment asks a question",
        }],
      }, undefined)).rejects.toThrow("automation_evaluator_rules_required");
      // Nothing was created by either refusal.
      expect(state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM automation_definition_revisions`,
      ).one().n).toBe(0);

      // A partial draft has not chosen its rules yet — that is the clarifying
      // question flow, and acceptance refuses it on `ready` alone anyway.
      const partial = await submit(eventDriven(false), undefined);
      expect(partial).toMatchObject({ created: true });
      // As does a draft with no event trigger at all.
      await expect(submit(readyDefinition("Manual helper"), undefined)).resolves.toMatchObject({
        created: false,
      });

      // With real rules it is admitted, and acceptance registers those rules.
      // The binding is named nowhere in this call: `notion_source ->
      // plugin_notion` is read off the draft's own trigger. The projection
      // below resolving to the real connection is what proves the derivation,
      // because nothing here could have supplied it.
      const admitted = await submit(eventDriven(true), rules);
      await instance.acceptDraft({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        definitionRevision: admitted.definitionRevision,
        scope: "personal",
        modelOverride: null,
      });
      expect(JSON.parse(state.storage.sql.exec<{ json: string }>(
        `SELECT evaluator_projection_json AS json FROM automation_acceptance WHERE id = 1`,
      ).one().json)).toEqual([
        expect.objectContaining({
          source: expect.objectContaining({
            connectorType: "notion",
            connectionId: NOTION_CONNECTION_ID,
            eventType: "notion.page.created",
          }),
        }),
      ]);
    });
  });

  it("accepts the canonical revision in place, leaving one definition behind", async () => {
    await seedReadyDraft(readyDefinition("Manual helper"));
    const stub = automationStub();
    await runInDurableObject(stub, async (instance: AutomationAgent, state) => {
      (instance as unknown as { workspace(): unknown }).workspace = async () => ({
        applyExternalEventRegistrations: async () => ({
          applied: true,
          effectiveAfterEventSequence: 7,
        }),
        applyAutomationProjection: async () => ({ applied: true }),
      });

      const detail = await instance.acceptDraft({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        definitionRevision: 1,
        scope: "personal",
        modelOverride: null,
      });

      expect(detail).toMatchObject({ id: AUTOMATION_ID, name: "Manual helper", status: "active" });
      expect(state.storage.sql.exec<{ lifecycle: string }>(
        `SELECT lifecycle FROM automation_state WHERE id = 1`,
      ).one().lifecycle).toBe("active");
      // Accepting settles the revision it accepted rather than accumulating a
      // second one, which is what makes a re-accept idempotent.
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_definition_revisions`,
      ).one().count).toBe(1);
      // The registration's own sequence is carried onto the acceptance, so an
      // event admitted before activation is not replayed into the first run.
      expect(state.storage.sql.exec<{ effective_after_event_sequence: number }>(
        `SELECT effective_after_event_sequence FROM automation_acceptance WHERE id = 1`,
      ).one().effective_after_event_sequence).toBe(7);
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

  it("creates the automation a proposal card offers, from its id alone", async () => {
    // The card's own entry point, which builds the create request server-side
    // rather than taking one. It built `modelOverride: null` for a field whose
    // schema is an `optional()` enum, so `accept`'s re-parse threw a `ZodError`
    // outside every mapping and the boundary answered `500 internal_error` /
    // "An unexpected error occurred" — for every press of every card, with
    // nothing for the person to do about it.
    //
    // Asserted through the service rather than the schema: what failed was the
    // request this constructs, and a schema test would only restate the literal
    // beside it.
    const definition = readyDefinition("Daily joke");
    await seedReadyDraft(definition);
    await pinWorkspaceIdentity();

    await expect(authorService().acceptAuthoredDraft(AUTOMATION_ID))
      .resolves.toMatchObject({ id: AUTOMATION_ID, name: "Daily joke", status: "active" });
  });

  it("creates an external-event automation from a card, binding the draft's own source", async () => {
    // The defect this whole change exists for. Acceptance took its bindings in
    // a request field; the proposal card is the only caller left and cannot
    // fill one, so it sent `{}` and every external-event draft was refused —
    // `automation_evaluator_source_binding_mismatch`, untabled, reaching a
    // member as a generic 409 under a button that then did nothing again.
    //
    // Nothing in this test names `notion_source -> plugin_notion`. That the
    // automation activates, and that the acceptance row records the binding, is
    // the whole proof: the only place it can have come from is the draft.
    const NOTION_CONNECTION_ID = "00000000-0000-7000-8000-0000000000bb";
    await pinWorkspaceIdentity();
    await runInDurableObject(
      env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID))),
      (_workspace, state) => {
        state.storage.sql.exec(
          `INSERT INTO connector_connections
             (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
              display_name, granted_scopes_json, status, cursor_json, config_json,
              created_at, updated_at, model_plugin_id)
           VALUES (?, ?, 'notion', 'personal', ?, 'acct', 'A connection', '[]', 'healthy',
                   '{}', '{}', 1, 1, 'plugin_notion')`,
          NOTION_CONNECTION_ID, WORKSPACE_ID, AUTHOR_ID,
        );
      },
    );
    await runInDurableObject(automationStub(), async (instance: AutomationAgent) => {
      (instance as unknown as { workspace(): unknown }).workspace = async () => ({
        applyExternalEventRegistrations: async () => ({ applied: true, effectiveAfterEventSequence: 7 }),
        applyAutomationProjection: async () => ({ applied: true }),
      });
      await instance.admitAuthoredDraft({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        authoredInWorkstreamId: AUTHORING_WORKSTREAM_ID,
        evaluatorRules: {
          schemaVersion: 1,
          evaluators: [{
            evaluatorKey: "page_created",
            source: {
              sourceBindingKey: "notion_source",
              suggestedSourcePluginId: "plugin_notion",
              event: { kind: "event_type" as const, eventType: "notion.page.created" },
            },
            when: { kind: "always" as const },
          }],
        },
        draft: {
          ...readyDefinition("Report new pages"),
          triggers: [{
            type: "connector_activity" as const,
            connectorType: "notion",
            sourceBindingKey: "notion_source",
            suggestedSourcePluginId: "plugin_notion",
            eventTypes: ["notion.page.created"],
            deterministicFilters: {},
          }],
        },
      });
    });

    await expect(authorService().acceptAuthoredDraft(AUTOMATION_ID))
      .resolves.toMatchObject({ id: AUTOMATION_ID, name: "Report new pages", status: "active" });

    await runInDurableObject(automationStub(), (_instance: AutomationAgent, state) => {
      expect(JSON.parse(state.storage.sql.exec<{ json: string }>(
        `SELECT activity_source_plugin_ids_json AS json FROM automation_acceptance WHERE id = 1`,
      ).one().json)).toEqual({ notion_source: "plugin_notion" });
      expect(JSON.parse(state.storage.sql.exec<{ json: string }>(
        `SELECT connector_bindings_json AS json FROM automation_acceptance WHERE id = 1`,
      ).one().json)).toEqual({ plugin_notion: NOTION_CONNECTION_ID });
    });
  });

  it("binds the plugins a draft recommends, and refuses when one has no connection", async () => {
    // `defaultPluginIds` was the quiet half of the same defect: the card sent
    // `[]`, so an automation was created successfully and ran without the
    // connectors its own overview named. Nothing failed, which is what made it
    // worse than the loud one.
    await pinWorkspaceIdentity();
    const SLACK_CONNECTION_ID = "00000000-0000-7000-8000-0000000000bc";
    await runInDurableObject(
      env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID))),
      (_workspace, state) => {
        state.storage.sql.exec(
          `INSERT INTO connector_connections
             (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
              display_name, granted_scopes_json, status, cursor_json, config_json,
              created_at, updated_at, model_plugin_id)
           VALUES (?, ?, 'slack', 'workspace', NULL, 'acct', 'Slack', '[]', 'healthy',
                   '{}', '{}', 1, 1, 'plugin_slack')`,
          SLACK_CONNECTION_ID, WORKSPACE_ID,
        );
      },
    );
    await seedReadyDraft({
      ...readyDefinition("Standup summary"),
      recommendedPlugins: [{
        pluginId: "plugin_slack",
        recommendedTools: ["slack_read_channel"],
        reason: "Read the standup channel",
      }],
    });

    await expect(authorService().acceptAuthoredDraft(AUTOMATION_ID)).resolves.toMatchObject({
      status: "active",
    });
    await runInDurableObject(automationStub(), (_instance: AutomationAgent, state) => {
      expect(JSON.parse(state.storage.sql.exec<{ json: string }>(
        `SELECT connector_bindings_json AS json FROM automation_acceptance WHERE id = 1`,
      ).one().json)).toEqual({ plugin_slack: SLACK_CONNECTION_ID });
    });
  });

  it("tells a member which connection to reconnect when a recommended plugin has none", async () => {
    // The residual time-gap refusal, and the reason deriving does not simply
    // move the failure: the draft named a plugin whose connection has since
    // gone, and that is a fact about now rather than about the draft. It has to
    // reach the member as an instruction, not as the generic conflict every
    // untabled code used to produce.
    await pinWorkspaceIdentity();
    await seedReadyDraft({
      ...readyDefinition("Standup summary"),
      recommendedPlugins: [{
        pluginId: "plugin_slack",
        recommendedTools: ["slack_read_channel"],
        reason: "Read the standup channel",
      }],
    });

    await expect(authorService().acceptAuthoredDraft(AUTOMATION_ID)).rejects.toMatchObject({
      status: 409,
      code: "automation_plugin_unavailable",
      message: "A connection this automation needs is unavailable. Reconnect it and try again.",
    });
  });

  it("refuses to admit a ready draft whose evaluator names a source no trigger declares", async () => {
    // Triggers and evaluator rules are written by two separate tool calls, and
    // nothing compared them directly: acceptance inferred their agreement from
    // a request field that happened to carry both. Deriving removes that field,
    // so the comparison has to be made where it is actually knowable.
    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      await expect(instance.admitAuthoredDraft({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        authorUserId: AUTHOR_ID,
        region: "global",
        authoredInWorkstreamId: AUTHORING_WORKSTREAM_ID,
        evaluatorRules: {
          schemaVersion: 1,
          evaluators: [{
            evaluatorKey: "page_created",
            source: {
              sourceBindingKey: "a_source_no_trigger_declares",
              suggestedSourcePluginId: "plugin_notion",
              event: { kind: "event_type" as const, eventType: "notion.page.created" },
            },
            when: { kind: "always" as const },
          }],
        },
        draft: {
          ...readyDefinition("Report new pages"),
          triggers: [{
            type: "connector_activity" as const,
            connectorType: "notion",
            sourceBindingKey: "notion_source",
            suggestedSourcePluginId: "plugin_notion",
            eventTypes: ["notion.page.created"],
            deterministicFilters: {},
          }],
        },
      })).rejects.toThrow("automation_activity_source_unbound");
      // Refused before anything was written, so the drafting loop can repair
      // and resubmit rather than leaving a card that cannot work.
      expect(state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM automation_definition_revisions`,
      ).one().n).toBe(0);
    });
  });

  it("answers a directory membership refusal as 403, not a 500 and not a conflict", async () => {
    // `list` reached WorkspaceDO outside `withAutomationErrors` for the same
    // reason `accept` did, so a member removed from the workspace between
    // `requireAuth`'s membership read and this one got 500. 403 rather than the
    // `SAFE_CODE` fallback's 409 is the point of the table row: 409 is the
    // status a client retries, and retrying is the one thing that never turns a
    // non-member into a member.
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id))`).run();
    // An active row for the author, so the refusal below is the membership
    // predicate deciding rather than an empty table. Without it the test
    // survives `if (true) throw new Error("automation_directory_access_denied")`.
    await env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status) VALUES (?, ?, 'active')`,
    ).bind(WORKSPACE_ID, AUTHOR_ID).run();
    await pinWorkspaceIdentity();

    const testEnv: Env = env;
    const member = {
      sessionId: "session-2",
      userId: AUTHOR_ID,
      workspaceId: WORKSPACE_ID,
      region: "global" as const,
      role: "member" as const,
    };

    await expect(new AutomationAgentService(testEnv, member).list()).resolves.toEqual({ items: [] });
    await expect(new AutomationAgentService(testEnv, {
      ...member,
      userId: asUserId("00000000-0000-7000-8000-0000000000b9"),
    }).list()).rejects.toMatchObject({
      status: 403,
      code: "automation_directory_access_denied",
      message: "You do not have access to this workspace's automations.",
    });
  });

  it("answers an ApiError raised inside the object with its own status, not a 500", async () => {
    // The premise `withAutomationErrors` was built on — "a failure inside the
    // object is a bare `Error` whose message is a stable snake_case code" — is
    // true of the object's own refusals and false of the collaborators it calls
    // inside a request. `acceptDraft` reaches `WorkstreamEmailRoutingService`,
    // which throws `ApiError`; the live case is the 503 an EU region raises when
    // the Global address registry is unreachable, on every create.
    //
    // What this asserts is the outcome — the member gets the author's status and
    // code, never `500 internal_error`. It does not discriminate the mechanism:
    // this pool preserves the class across the hop, so it passes with
    // `apiErrorAcrossRpc` removed. That rebuild is for the boundary where the
    // class is lost, which nothing here can reproduce; the comment on it says
    // so rather than letting this test imply a proof it does not carry.
    const key = env.WORKSTREAM_EMAIL_ADDRESS_KEY;
    const signing = env.SESSION_SIGNING_KEY;
    // Short rather than absent: absent falls back to the signing key in a
    // non-production environment, and this has to reach the throw.
    (env as { WORKSTREAM_EMAIL_ADDRESS_KEY?: string }).WORKSTREAM_EMAIL_ADDRESS_KEY = "too-short";
    (env as { SESSION_SIGNING_KEY?: string }).SESSION_SIGNING_KEY = "";
    try {
      const definition = readyDefinition("Address-less automation");
      await seedReadyDraft(definition);
      await pinWorkspaceIdentity();
      // The seeded route row short-circuits the reservation before it reads the
      // key, so this test needs the automation to have no address yet.
      await env.DB.prepare(
        `DELETE FROM workstream_email_routes WHERE automation_subscription_id = ?`,
      ).bind(AUTOMATION_ID).run();

      await expect(authorService().acceptAuthoredDraft(AUTOMATION_ID)).rejects.toMatchObject({
        status: 503,
        code: "workstream_email_key_invalid",
      });
    } finally {
      const restore = env as { WORKSTREAM_EMAIL_ADDRESS_KEY?: string | undefined; SESSION_SIGNING_KEY: string };
      restore.WORKSTREAM_EMAIL_ADDRESS_KEY = key;
      restore.SESSION_SIGNING_KEY = signing;
    }
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

  it("records a durable-table write instead of failing its own constraint", async () => {
    const now = 1_800_000_000_000;
    const runId = "00000000-0000-7000-8000-0000000000d1";
    const harnessRunId = "00000000-0000-7000-8000-0000000000d2";
    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      (instance as unknown as {
        ensureIdentity(input: unknown): void;
      }).ensureIdentity = () => {};
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region, authority_generation,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID, WORKSPACE_ID, AUTHOR_ID, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Table owner', 1, 1, 0, ?, ?)`,
        now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, workstream_id, harness_run_id,
            admission_state, execution_state, delivery_state, context_json,
            source_version, created_at, updated_at)
         VALUES (?, 'manual:table-test', 'manual', ?, ?, 'provisioned', 'running',
                 'pending', '{}', 1, ?, ?)`,
        runId, "00000000-0000-7000-8000-0000000000d3", harnessRunId, now, now,
      );

      // `table_create` — not `create`. The mutation ledger's own CHECK used to
      // list the unprefixed names, so this write rolled its transaction back
      // and took the table the model had just created with it.
      const created = await instance.executeMemoryTool({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        runId,
        harnessRunId,
        authorityGeneration: 1,
        operation: "table_create",
        providerIdempotencyKey: "table-call-1",
        args: {
          scopeKind: "automation",
          rationale: "Track what has shipped.",
          name: "Releases",
          description: "One row per shipped release.",
          usageInstructions: "Look a release up by its tag.",
          columns: [{ name: "tag", description: "The release tag.", type: "string", required: true, searchable: false }],
          keyColumns: ["tag"],
        },
      });

      expect(created).toBeTruthy();
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_memory_tables`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ operation: string }>(
        `SELECT operation FROM automation_memory_mutations ORDER BY settled_at DESC LIMIT 1`,
      ).one().operation).toBe("table_create");
    });
  });

  it("does not let a later work-stream state reopen a finished run", async () => {
    const now = 1_800_000_000_000;
    const runId = "00000000-0000-7000-8000-000000000a01";
    const workstreamId = "00000000-0000-7000-8000-000000000a02";
    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region, authority_generation,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID, WORKSPACE_ID, AUTHOR_ID, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Run owner', 1, 1, 0, ?, ?)`,
        now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, workstream_id, workstream_generation,
            harness_run_id, admission_state, execution_state, delivery_state, context_json,
            source_version, created_at, updated_at)
         VALUES (?, 'manual:terminal', 'manual', ?, 1, ?, 'provisioned', 'completed',
                 'pending', '{}', 5, ?, ?)`,
        runId, workstreamId, "00000000-0000-7000-8000-000000000a03", now, now,
      );

      const project = (sourceVersion: number, projectedState: string) => instance.applyRunProjection({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        runId,
        workstreamId,
        workstreamGeneration: 1,
        sourceVersion,
        payloadHash: `sha256:${projectedState}`,
        state: projectedState,
        completedAt: null,
      });

      // A stop settles the work stream as `idle`, and a member replying on the
      // same stream starts another loop whose first envelope is `scheduled`.
      // Both arrive after the run finished and both used to map to `running`.
      await project(6, "idle");
      expect(state.storage.sql.exec<{ execution_state: string }>(
        `SELECT execution_state FROM automation_runs WHERE run_id = ?`, runId,
      ).one().execution_state).toBe("completed");

      await project(7, "scheduled");
      const settled = state.storage.sql.exec<{ execution_state: string; source_version: number }>(
        `SELECT execution_state, source_version FROM automation_runs WHERE run_id = ?`, runId,
      ).one();
      expect(settled.execution_state).toBe("completed");
      // Still acknowledged: the sender has nothing to retry.
      expect(settled.source_version).toBe(7);
    });
  });

  it("recognises a memory row carried through the cutover instead of duplicating it", async () => {
    const now = 1_800_000_000_000;
    const runId = "00000000-0000-7000-8000-0000000000f1";
    const harnessRunId = "00000000-0000-7000-8000-0000000000f2";
    const legacyTableId = "00000000-0000-7000-8000-0000000000f4";
    const legacyColumnId = "00000000-0000-7000-8000-0000000000f5";
    // What the legacy memory-table service stored: `[name, value]` pairs.
    const naturalKeyHash = await sha256(canonicalTranscriptJson([["tag", "v1.0.0"]]));

    await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region, authority_generation,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID, WORKSPACE_ID, AUTHOR_ID, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Imported memory', 1, 1, 0, ?, ?)`,
        now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, workstream_id, harness_run_id,
            admission_state, execution_state, delivery_state, context_json,
            source_version, created_at, updated_at)
         VALUES (?, 'manual:import', 'manual', ?, ?, 'provisioned', 'running',
                 'pending', '{}', 1, ?, ?)`,
        runId, "00000000-0000-7000-8000-0000000000f3", harnessRunId, now, now,
      );

      importLegacyAutomationMemory(state.storage, AUTOMATION_ID, [], [
        {
          kind: "table",
          recordId: legacyTableId,
          payload: {
            memory_table_id: legacyTableId,
            name: "Releases",
            description: "One row per shipped release.",
            usage_instructions: "Look a release up by its tag.",
            key_column_ids_json: JSON.stringify([legacyColumnId]),
            schema_revision: 1,
            data_revision: 1,
          },
        },
        {
          kind: "table_column",
          recordId: legacyColumnId,
          payload: {
            memory_table_column_id: legacyColumnId,
            memory_table_id: legacyTableId,
            name: "tag",
            description: "The release tag.",
            value_type: "string",
            is_required: 1,
            is_searchable: 0,
            position: 0,
          },
        },
        {
          kind: "table_row",
          recordId: "00000000-0000-7000-8000-0000000000f6",
          payload: {
            memory_table_row_id: "00000000-0000-7000-8000-0000000000f6",
            memory_table_id: legacyTableId,
            natural_key_hash: naturalKeyHash,
            data_json: JSON.stringify({ tag: "v1.0.0" }),
            revision: 1,
          },
        },
      ], now);

      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_memory_rows`,
      ).one().count).toBe(1);

      // The same natural key the legacy runtime already recorded. Before the
      // imported row carried its natural-key identity this wrote a second row,
      // because the write path looks for `${table}:row:${hash}` and the import
      // had kept the legacy UUID.
      await instance.executeMemoryTool({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        runId,
        harnessRunId,
        authorityGeneration: 1,
        operation: "table_insert_rows",
        providerIdempotencyKey: "insert-call-1",
        args: {
          rationale: "Record the release again.",
          memoryTableId: legacyTableId,
          rows: [{ tag: "v1.0.0" }],
        },
      });

      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_memory_rows`,
      ).one().count).toBe(1);
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

  describe("run disposition", () => {
    const now = 1_800_000_000_000;

    /** A settled occurrence with a frozen context, ready to be judged. */
    function seedRun(
      state: DurableObjectState,
      runId: string,
      options: { disposition?: string } = {},
    ): void {
      const context = {
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        runId,
        authorityGeneration: 1,
        definitionRevision: 1,
        definition: {
          name: "Pipeline watch",
          description: "Watches the pipeline sheet.",
          overview: "Watches the pipeline sheet and reports movement.",
          instructions: "Report what moved in the pipeline since the last run.",
          requiredCapabilities: [],
          expectedOutputs: [],
          defaultBehavior: {},
          recommendedPlugins: [],
          memoryTables: [],
        },
        defaultPluginIds: [],
        activitySourcePluginIds: {},
        connectorBindings: {},
        modelOverride: null,
        executionPrincipal: { type: "user", userId: AUTHOR_ID },
        trigger: { kind: "manual", requestedByUserId: AUTHOR_ID },
        opening: null,
        memoryScope: { automationId: AUTOMATION_ID, authorityGeneration: 1 },
      };
      state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, workstream_id, harness_run_id,
            admission_state, execution_state, delivery_state, context_json,
            source_version, disposition, disposition_source, disposition_reason,
            created_at, updated_at)
         VALUES (?, ?, 'manual', ?, ?, 'provisioned', 'completed', 'pending', ?, 1, ?, ?, ?, ?, ?)`,
        runId,
        `manual:${runId}`,
        `00000000-0000-7000-8000-0000000000${runId.slice(-2)}`,
        `00000000-0000-7000-8000-0000000001${runId.slice(-2)}`,
        JSON.stringify(context),
        options.disposition ?? null,
        options.disposition ? "classified" : null,
        options.disposition ? "An earlier judgement." : null,
        now,
        now,
      );
    }

    function seedIdentity(state: DurableObjectState): void {
      state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region, authority_generation,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, 'global', 1, ?, ?)`,
        AUTOMATION_ID, WORKSPACE_ID, AUTHOR_ID, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, created_at, updated_at)
         VALUES (1, 'active', 'Pipeline watch', 1, 1, 0, ?, ?)`,
        now, now,
      );
    }

    it("keeps the first answer, so a delivery retry cannot judge one run twice", async () => {
      const runId = "00000000-0000-7000-8000-0000000000e1";
      await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
        seedIdentity(state);
        seedRun(state, runId, { disposition: "done" });

        const decision = await instance.resolveRunDisposition({
          schemaVersion: 1,
          automationId: AUTOMATION_ID,
          workspaceId: WORKSPACE_ID,
          runId,
          result: "The pipeline moved: two candidates reached final round.",
        });

        // Stored, not recomputed — the result text here would plainly be
        // delivered if this were a fresh judgement.
        expect(decision).toEqual({
          disposition: "done",
          reason: "An earlier judgement.",
          source: "classified",
        });
      });
    });

    it("exposes rather than withholding when the classifier cannot be reached", async () => {
      const runId = "00000000-0000-7000-8000-0000000000e2";
      await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
        seedIdentity(state);
        seedRun(state, runId);

        const decision = await instance.resolveRunDisposition({
          schemaVersion: 1,
          automationId: AUTOMATION_ID,
          workspaceId: WORKSPACE_ID,
          runId,
          result: "Two candidates reached final round.",
        });

        // No provider credentials in workerd here, so the inference fails and
        // the failure direction is what this proves: a result nobody can judge
        // is surfaced, not swallowed. The arm it lands on changed with the
        // destinations: this is a personal run with no owning room, so there is
        // nothing left to `deliver` to and the fail-open answer is to expose
        // the run's own work stream. A room-owned run would default to
        // `deliver` for the same reason.
        expect(decision.disposition).toBe("expose_workstream");
        expect(decision.source).toBe("default");
        expect(state.storage.sql.exec<{ disposition: string; disposition_source: string }>(
          `SELECT disposition, disposition_source FROM automation_runs WHERE run_id = ?`,
          runId,
        ).one()).toEqual({ disposition: "expose_workstream", disposition_source: "default" });
      });
    });

    it("can still open the run when there is nobody to deliver to", async () => {
      const runId = "00000000-0000-7000-8000-0000000000e3";
      await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
        seedIdentity(state);
        seedRun(state, runId);

        const decision = await instance.resolveRunDisposition({
          schemaVersion: 1,
          automationId: AUTOMATION_ID,
          workspaceId: WORKSPACE_ID,
          runId,
          result: "Two candidates reached final round.",
        });

        // Having no destination is not having nothing to decide. An automation
        // no work stream owns can expose the run it executed in, which is the
        // whole of what a workspace automation reaches people with — it acts
        // with its tools rather than delivering. So the question is still live,
        // and with no provider credentials here the fallback is the reachable
        // arm rather than `deliver`, which this automation cannot do.
        expect(decision.disposition).toBe("expose_workstream");
        expect(decision.source).toBe("default");
      });
    });

    it("refuses a run that is not this automation's", async () => {
      const runId = "00000000-0000-7000-8000-0000000000e4";
      await runInDurableObject(automationStub(), async (instance: AutomationAgent, state) => {
        seedIdentity(state);
        seedRun(state, runId);

        await expect(instance.resolveRunDisposition({
          schemaVersion: 1,
          automationId: AUTOMATION_ID,
          workspaceId: WORKSPACE_ID,
          runId: "00000000-0000-7000-8000-0000000000ff",
          result: "anything",
        })).rejects.toThrow("automation_run_not_found");
      });
    });
  });
});

describe("an automation the work stream owns", () => {
  const OWNING_WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000c1";
  const OTHER_USER_ID = "00000000-0000-7000-8000-0000000000c3";
  const OTHER_WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000c2";

  /** Accepted, active, and owned by a room — the state an archive acts on. */
  async function seedActiveOwnedAutomation(): Promise<void> {
    await seedReadyDraft(readyDefinition("Weekly changelog"));
    await pinWorkspaceIdentity();
    await runInDurableObject(automationStub(), (_instance: AutomationAgent, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_acceptance
           (id, definition_revision, request_hash, scope, owning_workstream_id,
            default_plugin_ids_json, activity_source_plugin_ids_json, connector_bindings_json,
            model_override, evaluator_projection_json,
            evaluator_source_hash, accepted_at, activated_at)
         VALUES (1, 1, 'sha256:request', 'workstream', ?, '[]', '{}', '{}', NULL, '[]',
                 'sha256:evaluators', 100, 101)`,
        OWNING_WORKSTREAM_ID,
      );
      state.storage.sql.exec(
        `UPDATE automation_state
            SET lifecycle = 'active', accepted_definition_revision = 1 WHERE id = 1`,
      );
    });
  }

  /** The most recently queued workspace projection, as the outbox holds it. */
  function newestProjection(): Promise<Record<string, unknown>> {
    return runInDurableObject(automationStub(), (_instance: AutomationAgent, state) =>
      JSON.parse(state.storage.sql.exec<{ payload_json: string }>(
        `SELECT payload_json FROM automation_outbox
          WHERE effect_kind = 'workspace_projection'
          ORDER BY created_at DESC, effect_id DESC LIMIT 1`,
      ).one().payload_json) as Record<string, unknown>);
  }

  function lifecycleAndReason(): Promise<{ lifecycle: string; paused_reason: string | null }> {
    return runInDurableObject(automationStub(), (_instance: AutomationAgent, state) =>
      state.storage.sql.exec<{ lifecycle: string; paused_reason: string | null }>(
        `SELECT lifecycle, paused_reason FROM automation_state WHERE id = 1`,
      ).one());
  }

  it("follows its room into the archive and back out again", async () => {
    await seedActiveOwnedAutomation();
    const stub = automationStub();

    expect(await stub.pauseForArchivedWorkstream({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      workstreamId: OWNING_WORKSTREAM_ID,
    })).toEqual({ paused: true, outcomeCode: "automation_paused" });
    // The reason is recorded, not just the lifecycle: unarchiving has to be
    // able to tell what the archive paused from what a person paused.
    expect(await lifecycleAndReason())
      .toEqual({ lifecycle: "paused", paused_reason: "workstream_archived" });
    // The projection this pause queues has to carry the owning work stream
    // beside the scope. The directory pairs the two with a CHECK, so a
    // projection naming one without the other is rejected there — as an
    // asynchronous outbox failure, which no assertion about this object's own
    // lifecycle would ever notice.
    expect(await newestProjection()).toMatchObject({
      lifecycle: "paused",
      scope: "workstream",
      owningWorkstreamId: OWNING_WORKSTREAM_ID,
    });

    expect(await stub.resumeForUnarchivedWorkstream({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      workstreamId: OWNING_WORKSTREAM_ID,
    })).toEqual({ resumed: true, outcomeCode: "automation_resumed" });
    expect(await lifecycleAndReason())
      .toEqual({ lifecycle: "active", paused_reason: null });
  });

  it("gives the author no standing once they leave the room", async () => {
    await seedActiveOwnedAutomation();

    // The scope exists to end exactly this tenure: an automation belongs to the
    // room, so whoever typed it keeps no say after leaving. Checked before the
    // author shortcut, because after it is indistinguishable from no check —
    // the author would go on pausing, editing and deleting for as long as they
    // remained anywhere in the workspace.
    await runInDurableObject(automationStub(), async (instance: AutomationAgent) => {
      await expect(instance.pause({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: AUTHOR_ID,
        actorRole: "member",
        participantOfOwningWorkstream: false,
      })).rejects.toThrow("automation_authority_mismatch");
    });
    expect(await lifecycleAndReason())
      .toEqual({ lifecycle: "active", paused_reason: null });

    // And a participant who never touched it has full standing.
    await runInDurableObject(automationStub(), async (instance: AutomationAgent) => {
      await instance.pause({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: OTHER_USER_ID,
        actorRole: "member",
        participantOfOwningWorkstream: true,
      });
    });
    expect(await lifecycleAndReason())
      .toEqual({ lifecycle: "paused", paused_reason: "person" });
  });

  it("does not start an automation a person paused before the archive", async () => {
    await seedActiveOwnedAutomation();
    const stub = automationStub();

    // As a participant, which is what management of a room's automation now
    // requires: the author shortcut no longer reaches this scope.
    await stub.pause({
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      userId: AUTHOR_ID,
      actorRole: "member",
      participantOfOwningWorkstream: true,
    });
    expect(await lifecycleAndReason())
      .toEqual({ lifecycle: "paused", paused_reason: "person" });

    // Unarchiving resumes exactly what the archive paused. Without the reason
    // these two rows are identical, and a room coming back would restart an
    // automation somebody deliberately stopped.
    expect(await stub.resumeForUnarchivedWorkstream({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      workstreamId: OWNING_WORKSTREAM_ID,
    })).toEqual({ resumed: false, outcomeCode: "automation_not_paused_by_archive" });
    expect(await lifecycleAndReason())
      .toEqual({ lifecycle: "paused", paused_reason: "person" });
  });

  it("is not pausable by a work stream that merely receives from it", async () => {
    await seedActiveOwnedAutomation();

    // Ownership, not destination: a room an automation delivers into has no say
    // over whether it runs.
    expect(await automationStub().pauseForArchivedWorkstream({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      workstreamId: OTHER_WORKSTREAM_ID,
    })).toEqual({ paused: false, outcomeCode: "automation_not_owned_by_workstream" });
    expect(await lifecycleAndReason())
      .toEqual({ lifecycle: "active", paused_reason: null });
  });
});

describe("taking over who an automation runs as", () => {
  const OWNING_WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000d1";
  const LEAVER_ID = "00000000-0000-7000-8000-0000000000d2";
  const CLAIMANT_ID = "00000000-0000-7000-8000-0000000000d3";
  const LEAVER_GMAIL = "00000000-0000-7000-8000-0000000000d4";
  const CLAIMANT_GMAIL = "00000000-0000-7000-8000-0000000000d5";
  const SHARED_SLACK = "00000000-0000-7000-8000-0000000000d6";

  /**
   * A room's automation bound to two connections: the leaver's personal Gmail
   * and a workspace-scoped Slack. Only the first is at risk.
   */
  async function seedOwnedAutomation(): Promise<void> {
    await seedReadyDraft(readyDefinition("Candidate intake"));
    await pinWorkspaceIdentity();
    const workspace = env.WORKSPACE_DOS
      .get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
    await runInDurableObject(workspace, (_instance, state) => {
      const connection = (
        id: string, scope: string, owner: string | null, plugin: string,
      ): void => {
        state.storage.sql.exec(
          `INSERT OR REPLACE INTO connector_connections
             (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
              display_name, granted_scopes_json, status, cursor_json, config_json,
              created_at, updated_at, model_plugin_id)
           VALUES (?, ?, 'google', ?, ?, 'acct', 'A connection', '[]', 'healthy',
                   '{}', '{}', 1, 1, ?)`,
          id, WORKSPACE_ID, scope, owner, plugin,
        );
      };
      connection(LEAVER_GMAIL, "personal", LEAVER_ID, "plugin_gmail");
      connection(CLAIMANT_GMAIL, "personal", CLAIMANT_ID, "plugin_gmail");
      connection(SHARED_SLACK, "workspace", null, "plugin_slack");
    });
    await runInDurableObject(automationStub(), (_instance: AutomationAgent, state) => {
      state.storage.sql.exec(
        `INSERT INTO automation_acceptance
           (id, definition_revision, request_hash, scope, owning_workstream_id,
            default_plugin_ids_json, activity_source_plugin_ids_json, connector_bindings_json,
            model_override, evaluator_projection_json,
            evaluator_source_hash, accepted_at, activated_at)
         VALUES (1, 1, 'sha256:request', 'workstream', ?, '[]', '{}', ?, NULL, '[]',
                 'sha256:evaluators', 100, 101)`,
        OWNING_WORKSTREAM_ID,
        JSON.stringify({ plugin_gmail: LEAVER_GMAIL, plugin_slack: SHARED_SLACK }),
      );
      state.storage.sql.exec(
        `UPDATE automation_state
            SET lifecycle = 'active', accepted_definition_revision = 1, run_as_user_id = ?
          WHERE id = 1`,
        LEAVER_ID,
      );
    });
  }

  function principalState(): Promise<{ run_as_user_id: string | null }> {
    return runInDurableObject(automationStub(), (_instance: AutomationAgent, state) =>
      state.storage.sql.exec<{ run_as_user_id: string | null }>(
        `SELECT run_as_user_id FROM automation_state WHERE id = 1`,
      ).one());
  }

  function bindings(): Promise<Record<string, string>> {
    return runInDurableObject(automationStub(), (_instance: AutomationAgent, state) =>
      JSON.parse(state.storage.sql.exec<{ connector_bindings_json: string }>(
        `SELECT connector_bindings_json FROM automation_acceptance WHERE id = 1`,
      ).one().connector_bindings_json) as Record<string, string>);
  }

  it("moves the dead personal binding and leaves the workspace one alone", async () => {
    await seedOwnedAutomation();

    const claim = await automationStub().claimExecutionPrincipal({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      userId: CLAIMANT_ID,
      participantOfOwningWorkstream: true,
    });

    expect(claim).toEqual({
      principalUserId: CLAIMANT_ID,
      reboundPluginIds: ["plugin_gmail"],
      unboundProviders: [],
      changed: true,
    });
    expect(await principalState()).toEqual({ run_as_user_id: CLAIMANT_ID });
    // The workspace connection belongs to the workspace, not to whoever
    // authorized it: it never broke, and rewriting it would be a write on the
    // one thing that still worked.
    expect(await bindings()).toEqual({
      plugin_gmail: CLAIMANT_GMAIL,
      plugin_slack: SHARED_SLACK,
    });
  });

  it("moves what it can and names what it cannot", async () => {
    await seedOwnedAutomation();
    // The claimant has no Gmail of their own.
    await runInDurableObject(
      env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID))),
      (_instance, state) => {
        state.storage.sql.exec(`DELETE FROM connector_connections WHERE id = ?`, CLAIMANT_GMAIL);
      },
    );

    const claim = await automationStub().claimExecutionPrincipal({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      userId: CLAIMANT_ID,
      participantOfOwningWorkstream: true,
    });

    // The room would rather have most of its automation back than none, so the
    // takeover still happens and the gap is reported rather than refused.
    expect(claim.unboundProviders).toEqual(["plugin_gmail"]);
    expect(claim.reboundPluginIds).toEqual([]);
    expect(claim.changed).toBe(true);
    expect(await principalState()).toEqual({ run_as_user_id: CLAIMANT_ID });
    expect((await bindings()).plugin_gmail).toBe(LEAVER_GMAIL);
  });

  it("is a no-op for whoever already runs it", async () => {
    await seedOwnedAutomation();
    await automationStub().claimExecutionPrincipal({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      userId: CLAIMANT_ID,
      participantOfOwningWorkstream: true,
    });

    const again = await automationStub().claimExecutionPrincipal({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      userId: CLAIMANT_ID,
      participantOfOwningWorkstream: true,
    });

    // A retry after a lost response must not write a second audit row.
    expect(again.changed).toBe(false);
    expect(await runInDurableObject(automationStub(), (_i: AutomationAgent, state) =>
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_principal_claims`,
      ).one())).toEqual({ count: 1 });
  });

  it("refuses somebody who is not in the room that owns it", async () => {
    await seedOwnedAutomation();

    // Ownership is the whole authorization for a room's automation. Without
    // participation there is nothing else to fall back on: the claimant is not
    // the author, and the scope is not workspace.
    await runInDurableObject(automationStub(), async (instance: AutomationAgent) => {
      await expect(instance.claimExecutionPrincipal({
        schemaVersion: 1,
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: CLAIMANT_ID,
        participantOfOwningWorkstream: false,
      })).rejects.toThrow("automation_authority_mismatch");
    });
    expect(await principalState()).toEqual({ run_as_user_id: LEAVER_ID });
  });
});

describe("whose connections a draft may bind", () => {
  const OWNER_ID = "00000000-0000-7000-8000-0000000000f1";
  const OTHER_ID = "00000000-0000-7000-8000-0000000000f2";
  const OTHER_GMAIL = "00000000-0000-7000-8000-0000000000f3";

  it("refuses another member's personal connection at every scope but workspace", async () => {
    await pinWorkspaceIdentity();
    const workspace = env.WORKSPACE_DOS
      .get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO connector_connections
           (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
            display_name, granted_scopes_json, status, cursor_json, config_json,
            created_at, updated_at, model_plugin_id)
         VALUES (?, ?, 'google', 'personal', ?, 'acct', 'Their Gmail', '[]', 'healthy',
                 '{}', '{}', 1, 1, 'plugin_gmail')`,
        OTHER_GMAIL, WORKSPACE_ID, OTHER_ID,
      );
    });

    // A room's automation is managed by everyone in the room and outlives
    // whoever wrote it. Binding a colleague's personal connection to one would
    // lend their credentials to a standing automation they never agreed to —
    // and before `workstream` existed, neither guard covered this case.
    await runInDurableObject(automationStub(), async (instance: AutomationAgent) => {
      await expect((instance as unknown as {
        prepareAcceptance(input: unknown, definition: unknown): Promise<unknown>;
      }).prepareAcceptance({
        automationId: AUTOMATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: OWNER_ID,
        authorUserId: OWNER_ID,
        scope: "workstream",
      }, {
        // The plugin is named by the draft's own recommendation now, which is
        // where acceptance reads it from. Passing it in the request no longer
        // reaches this guard, so a draft carrying it is the only way to prove
        // the guard still fires.
        ...readyDefinition("Candidate intake"),
        recommendedPlugins: [{
          pluginId: "plugin_gmail",
          recommendedTools: ["gmail_search"],
          reason: "Read the candidate's mail",
        }],
      }))
        .rejects.toThrow("automation_personal_connection_access_denied");
    });
  });
});
