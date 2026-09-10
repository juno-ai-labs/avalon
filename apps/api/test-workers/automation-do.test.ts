/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * `AutomationDO`: the automation itself, its definition revisions, schedules,
 * runs, inbound email, and the run child it provisions under itself.
 *
 * Everything here is driven through the object's own RPC surface and the
 * alarms it arms, against the real WorkspaceDO the object registers with, the
 * real regional D1 it reads members and email routes from, and a real run
 * child (a `SubstreamAgent`) whose loop reads its definition back from this
 * object by revision. The one thing replaced is the model: the OpenRouter
 * double answers every turn, so the run reaches inference and ends, and what
 * it was asked is readable in the double's calls.
 *
 * Connector bindings are read from the workspace object's `connector_connections`
 * and nowhere else. Migration 0090 dropped that table from regional D1, and a
 * statement pointed back at D1 raised `no such table` in production; the first
 * test keeps the table out of D1 so the binding tests here stay evidence.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asAutomationId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  AutomationSetEvaluatorRulesInputV1Schema,
  type AutomationDraft,
} from "@rally/contracts";
import {
  ConversationEffectEnvelopeSchema,
  conversationEffectHash,
  type ConversationEffectEnvelope,
} from "@rally/contracts/conversation-effects";

import type { AutomationDO } from "../src/durable-objects/automation-do";
import type { SubstreamAgent } from "../src/durable-objects/substream-agent";
import {
  AUTOMATION_RUN_ALARM_KIND,
  AUTOMATION_SCHEDULE_ALARM_KIND,
} from "../src/durable-objects/automation-do-protocol";
import { automationDOName, conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { readWorkstreamAuthorityControl } from "../src/services/workstream-authority";
import {
  consumeEffectBodies,
  deliverChildEffects,
  deliverParentEffects,
  pendingParentEffects,
} from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ad00");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000ad01");
const OUTSIDER_ID = asUserId("00000000-0000-7000-8000-00000000ad02");
const SESSION_ID = "00000000-0000-7000-8000-00000000ad03";
const SLACK_CONNECTION_ID = "00000000-0000-7000-8000-00000000ad04";
const RESOURCE_ID = "00000000-0000-7000-8000-00000000ad05";
const EMAIL_LOCAL_PART = "amber-cobalt-jade-brook";
const EMAIL_ADDRESS = `${EMAIL_LOCAL_PART}@automation.rallywith.ai`;
const NOW = "2026-08-29T10:00:00.000Z";
const TEST_ENV: Env = env;
const RUN_SETTLE_TIMEOUT_MS = 15_000;

/**
 * Reassigned per test: a finished test's objects keep draining after
 * `reset()`, and their leftover work must land on their own objects rather
 * than on the next test's.
 */
let automationOrdinal = 0;
let AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-0000000000ad");

const WEBHOOK_CONNECTION_ID = "00000000-0000-7000-8000-00000000ad70";

const WEBHOOK_DEFINITION: AutomationDraft = {
  name: "Deploy watcher",
  description: "Reports checkout deploys",
  overview: "Watches deploy events on a webhook",
  instructions: "Say which service deployed.",
  triggers: [{
    type: "connector_activity",
    connectorType: "generic_webhook",
    sourceBindingKey: "deploy_hook",
    suggestedSourcePluginId: "plugin_webhook",
    eventTypes: ["deploy.finished", "deploy.failed"],
    deterministicFilters: {},
  }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  suggestedScope: "personal",
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

const DEFINITION: AutomationDraft = {
  name: "Manual helper",
  description: "Runs on request",
  overview: "A manual automation",
  instructions: "Do the requested work and say so in one sentence.",
  triggers: [{ type: "manual" }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  suggestedScope: "personal",
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

let loadSkillOnNextTurn = false;
let submitDraftOnNextTurn = false;
const provider = useOpenRouterDouble((call) => {
  if (submitDraftOnNextTurn) {
    submitDraftOnNextTurn = false;
    expect(call.toolNames).toContain("sidekick_submit_draft");
    return { callTool: { name: "sidekick_submit_draft", arguments: { ...DEFINITION, triggers: [] } } };
  }
  if (loadSkillOnNextTurn) {
    loadSkillOnNextTurn = false;
    return { callTool: { name: "load_skill", arguments: { name: "sidekick-manual-helper-2" } } };
  }
  return { say: "Done." };
});
useSelectedModel();
useHeldEffectQueue();

function actor(userId = AUTHOR_ID) {
  return { userId, actorRole: "member" as const, participantOfOwningWorkstream: false };
}

function addressed() {
  return { workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID };
}

function automationStub(): DurableObjectStub<AutomationDO> {
  return env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(
    automationDOName("global", WORKSPACE_ID, AUTOMATION_ID),
  ));
}

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function childStub(runId: string) {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, AUTOMATION_ID, asSubstreamId(runId)),
  ));
}

/**
 * The regional half: identity, membership, the route table the conversation
 * bootstrap reserves, and the legacy-shaped email registry with this
 * automation's address already in it. Deliberately no `connector_connections`:
 * that is a migrated region, and creating it here would let the defect the
 * binding tests cover pass.
 */
async function seedRegionalDatabase(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, OUTSIDER_ID, NOW),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'outsider@example.com', 'Outsider', NULL, 'UTC', ?)`).bind(OUTSIDER_ID, NOW),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, automation_subscription_id, created_at, updated_at)
      VALUES (?, 'global', ?, NULL, ?, ?, ?)`)
      .bind(EMAIL_LOCAL_PART, WORKSPACE_ID, AUTOMATION_ID, NOW, NOW),
  ]);
}

/**
 * The workspace half: one Slack connection a draft can bind, and one resource
 * on it. Seeded by the tests that need it rather than by every test, because
 * the run child's harness loads every connection in the workspace and the
 * test Worker configures no Slack connector.
 */
async function seedSlackConnection(): Promise<void> {
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, granted_scopes_json, status, cursor_json, config_json,
          created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'slack', 'workspace', NULL, 'T0AUTOMATION', 'Juno Labs', '[]', 'healthy',
               '{}', '{}', ?, ?, 'plugin_slack')`,
      SLACK_CONNECTION_ID,
      WORKSPACE_ID,
      NOW,
      NOW,
    );
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO resources
         (id, workspace_id, connection_id, resource_type, provider,
          provider_resource_id, title, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'slack_channel', 'slack', 'C123', 'Channel', '{}', ?, ?)`,
      RESOURCE_ID,
      WORKSPACE_ID,
      SLACK_CONNECTION_ID,
      NOW,
      NOW,
    );
  });
}

/** A generic webhook connection whose configured event types are its triggers. */
async function seedWebhookConnection(): Promise<void> {
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, granted_scopes_json, status, cursor_json, config_json,
          created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'generic_webhook', 'workspace', NULL, 'deploy-hook', 'Deploy hook', '[]', 'healthy',
               '{}', ?, ?, ?, 'plugin_webhook')`,
      WEBHOOK_CONNECTION_ID,
      WORKSPACE_ID,
      JSON.stringify({ eventTypes: ["deploy.finished", "deploy.failed"] }),
      NOW,
      NOW,
    );
  });
}

/** One accepted Slack event in the workspace, which moves its event sequence. */
async function ingestSlackEvent(eventId: string, providerEventId: string): Promise<void> {
  await workspaceStub().ingestConnectorEvent({
    workspaceId: WORKSPACE_ID,
    ingressEventId: eventId,
    payloadHash: `sha256:${"b".repeat(64)}`,
    event: {
      connectorType: "slack",
      activity: {
        id: eventId,
        workspaceId: WORKSPACE_ID,
        region: "global",
        connectionId: SLACK_CONNECTION_ID,
        connectionScope: "workspace",
        connectionOwnerUserId: null,
        provider: "slack",
        providerEventId,
        eventType: "slack.message.posted",
        resourceType: "slack_channel",
        providerResourceId: "C123",
        actor: {},
        subject: {},
        occurredAt: NOW,
        receivedAt: NOW,
        title: "New message",
        summary: "A channel message arrived",
        textSnippet: "foobar",
        payloadRef: null,
        visibility: { kind: "workspace" },
        targetUserIds: [],
        entityKeys: [],
        dedupeKey: `slack:${providerEventId}`,
        rawContentHash: null,
        metadata: { messageText: "foobar" },
        externalPeople: [],
      },
    },
  });
}

async function createDraft(owningWorkstreamId: string | null = null): Promise<void> {
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR_ID,
    scope: owningWorkstreamId ? "workstream" : "personal",
    owningWorkstreamId,
    automationId: AUTOMATION_ID,
  });
  expect(created).toEqual({ automationId: AUTOMATION_ID, created: true });
}

async function submit(draft: AutomationDraft = DEFINITION): Promise<{ definitionRevision: number; ready: boolean }> {
  return automationStub().submitDefinition({ ...addressed(), draft, evaluatorRules: null, submittedByRunId: null });
}

/**
 * Applied inside the object: `AutomationDetail` is what the stub returns, and
 * a rejection over a stub is reported a second time as unhandled, which fails
 * the run even when the assertion held.
 */
async function apply(userId = AUTHOR_ID) {
  return runInDurableObject(automationStub(), (instance: AutomationDO) =>
    instance.apply({ ...addressed(), actor: actor(userId) }));
}

async function activeAutomation(draft: AutomationDraft = DEFINITION): Promise<void> {
  await createDraft();
  await submit(draft);
  const detail = await apply();
  expect(detail.lifecycle).toBe("active");
}

interface AutomationRow extends Record<string, SqlStorageValue> {
  lifecycle: string;
  paused_by: string | null;
  accepted_definition_revision: number | null;
  effective_after_event_sequence: number | null;
  connector_bindings_json: string;
  email_address: string | null;
}

async function automationRow(): Promise<AutomationRow> {
  return runInDurableObject(automationStub(), (_instance, state) =>
    state.storage.sql.exec<AutomationRow>(
      `SELECT lifecycle, paused_by, accepted_definition_revision, effective_after_event_sequence,
              applied_effects_revision, connector_bindings_json, email_address
         FROM automation WHERE id = 1`,
    ).one());
}

async function runRows(): Promise<{ run_id: string; occurrence_key: string; state: string }[]> {
  return runInDurableObject(automationStub(), (_instance, state) =>
    state.storage.sql.exec<{ run_id: string; occurrence_key: string; state: string }>(
      `SELECT run_id, occurrence_key, state FROM runs ORDER BY created_at, run_id`,
    ).toArray());
}

async function alarms(): Promise<{ kind: string; alarm_key: string; due_at: number }[]> {
  return runInDurableObject(automationStub(), (_instance, state) =>
    state.storage.sql.exec<{ kind: string; alarm_key: string; due_at: number }>(
      `SELECT kind, alarm_key, due_at FROM _internal_durable_alarms ORDER BY kind, alarm_key`,
    ).toArray());
}

async function activeRegistrations(): Promise<number> {
  return runInDurableObject(workspaceStub(), (_instance, state) =>
    state.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workspace_external_event_registrations
        WHERE destination_kind = 'automation' AND automation_id = ? AND state = 'active'`,
      AUTOMATION_ID,
    ).one().count);
}

/** The text of one protocol message, whichever shape the harness sent it in. */
function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (
    typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""
  )).join("\n");
}

/**
 * Let the run alarm provision the child and its loop run to a terminal state.
 * Forced first, then polled: an overdue alarm may already have fired on its
 * own, and the poll is what proves the loop ended.
 */
async function settledChildRun(runId: string): Promise<{ status: string; error_json: string | null }> {
  await runDurableObjectAlarm(automationStub());
  let settled: { status: string; error_json: string | null } | null = null;
  await expect.poll(async () => {
    const row = await runInDurableObject(childStub(runId), (_instance, state) => {
      try {
        return state.storage.sql.exec<{ status: string; error_json: string | null; terminalized_at: number | null }>(
          `SELECT status, error_json, terminalized_at FROM runs ORDER BY created_at LIMIT 1`,
        ).toArray()[0] ?? null;
      } catch {
        return null;
      }
    });
    if (row?.terminalized_at != null) {
      settled = row;
      return "terminal";
    }
    return `run ${runId} not terminal: ${JSON.stringify(row)}`;
  }, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 100 }).toBe("terminal");
  return settled!;
}

beforeEach(async () => {
  loadSkillOnNextTurn = false;
  submitDraftOnNextTurn = false;
  automationOrdinal += 1;
  AUTOMATION_ID = asAutomationId(`00000000-0000-7000-8000-${String(automationOrdinal).padStart(4, "0")}00000ad0`);
  await reset();
  await seedRegionalDatabase();
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("AutomationDO", () => {
  it("publishes through the authoring conversation and completes with a durable final reply", async () => {
    await createDraft();
    const root = childStub("0");
    submitDraftOnNextTurn = true;
    const sent = await root.fetch("https://object.test/internal/product", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "create_message", auth: {
        sessionId: SESSION_ID, userId: AUTHOR_ID, workspaceId: WORKSPACE_ID, region: "global", role: "member",
      }, input: { text: "Publish a personal knowledge Sidekick.", clientMessageId: "sidekick-authoring", mentions: [], confirmedParticipantUserIds: [], attachmentIds: [], modelOverride: "double/primary" } }),
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    await runDurableObjectAlarm(root);
    const latestRun = () => runInDurableObject(root, (_instance, state) => state.storage.sql.exec<{
      status: string; final_turn_id: string | null; terminalized_at: number | null; error_json: string | null;
    }>(`SELECT status, final_turn_id, terminalized_at, error_json FROM runs ORDER BY created_at DESC LIMIT 1`).one());
    await expect.poll(async () => (await latestRun()).terminalized_at, { timeout: RUN_SETTLE_TIMEOUT_MS }).not.toBeNull();
    expect(await automationRow()).toMatchObject({ lifecycle: "active", accepted_definition_revision: 1 });
    const run = await latestRun();
    expect(run).toMatchObject({ status: "completed", error_json: null, final_turn_id: expect.any(String) });
    expect(await runInDurableObject(root, (_instance, state) => state.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE turn_id = ?`, run.final_turn_id,
    ).one().count)).toBe(1);
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("publishes instruction-only Sidekicks without execution setup and stores their loading capability", async () => {
    await createDraft();
    const draft: AutomationDraft = { ...DEFINITION, definitionVersion: 2, triggers: [], instructions: "Use short sentences." };
    await automationStub().saveDefinition({ ...addressed(), draft, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    const detail = await runInDurableObject(automationStub(), (instance: AutomationDO) => instance.readDetail({ ...addressed(), actor: actor() }));
    expect(detail.loadable).toBe(true);
    expect(detail.emailAddress).toBeNull();
    expect(detail.acceptedDefinitionRevision).toBe(1);
    expect(await automationStub().admitExternalEvent({ ...addressed(), registrationId: "00000000-0000-7000-8000-00000000ad51", payloadHash: `sha256:${"a".repeat(64)}`, event: {
      id: "00000000-0000-7000-8000-00000000ad52", eventSequence: 42, eventType: "slack.message.posted", title: "Stale trigger", summary: "An earlier registration delivered late", textSnippet: "hello", metadata: {}, occurredAt: Date.parse(NOW), audienceUserIds: [], audienceKind: "workspace",
    } })).toEqual({ admitted: false, outcomeCode: "sidekick_trigger_removed" });
    await expect(runInDurableObject(automationStub(), (instance: AutomationDO) => instance.runNow({ ...addressed(), actor: actor(), idempotencyKey: "instruction-only" }))).rejects.toThrow("Use this Sidekick in a conversation");
    const source = await automationStub().readSkillSource({ ...addressed(), principalUserId: AUTHOR_ID, conversationParentId: AUTOMATION_ID, audienceScope: "personal", audienceUserIds: [AUTHOR_ID] });
    expect(source?.instructions).toBe("Use short sentences.");
    await automationStub().submitDefinition({ ...addressed(), draft: { ...draft, ready: false, triggers: [{ type: "manual" }] }, evaluatorRules: null, submittedByRunId: null });
    expect((await runInDurableObject(automationStub(), (instance: AutomationDO) => instance.readDetail({ ...addressed(), actor: actor() }))).loadable).toBe(true);
    await automationStub().pause({ ...addressed(), actor: actor() });
    expect((await runInDurableObject(automationStub(), (instance: AutomationDO) => instance.readDetail({ ...addressed(), actor: actor() }))).loadable).toBe(true);
  });

  it("hides disabled email while retaining its permanent address", async () => {
    await createDraft();
    await automationStub().saveDefinition({ ...addressed(), draft: DEFINITION, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    const before = await runInDurableObject(automationStub(), (instance: AutomationDO) => instance.readDetail({ ...addressed(), actor: actor() }));
    expect(before.emailAddress).toBeTruthy();
    await automationStub().saveDefinition({ ...addressed(), draft: { ...DEFINITION, definitionVersion: 2, triggers: [] }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    expect((await runInDurableObject(automationStub(), (instance: AutomationDO) => instance.readDetail({ ...addressed(), actor: actor() }))).emailAddress).toBeNull();
    expect(await runInDurableObject(automationStub(), (_instance, state) => state.storage.sql.exec<{ email_address: string }>(`SELECT email_address FROM automation`).one().email_address)).toBe(before.emailAddress);
  });

  it("reads stored loadability independently of trigger count and contains personal instructions", async () => {
    await createDraft();
    await automationStub().saveDefinition({ ...addressed(), draft: { ...DEFINITION, definitionVersion: 2, triggers: [] }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    const request = { ...addressed(), principalUserId: AUTHOR_ID, conversationParentId: AUTOMATION_ID, audienceScope: "personal" as const, audienceUserIds: [AUTHOR_ID] };
    expect(await automationStub().readSkillSource({ ...request, audienceUserIds: [AUTHOR_ID, OUTSIDER_ID] })).toBeNull();
    await runInDurableObject(automationStub(), (_instance, state) => { state.storage.sql.exec(`UPDATE automation SET loadable = 0`); });
    expect(await automationStub().readSkillSource(request)).toBeNull();
    await runInDurableObject(automationStub(), (_instance, state) => { state.storage.sql.exec(`UPDATE automation SET loadable = 1`); });
    expect((await automationStub().readSkillSource(request))?.loadable).toBe(true);
  });

  it("durably retries a publication tail without another conversational submission", async () => {
    await createDraft();
    await runInDurableObject(automationStub(), (instance) => {
      const target = instance as unknown as { applyEffects: (...args: unknown[]) => Promise<void> };
      const original = target.applyEffects.bind(target);
      target.applyEffects = async (...args) => {
        target.applyEffects = original;
        void args;
        throw new Error("publication_effect_interrupted");
      };
    });
    await expect(runInDurableObject(automationStub(), (instance: AutomationDO) => instance.saveDefinition({ ...addressed(), draft: { ...DEFINITION, definitionVersion: 2, triggers: [] }, evaluatorRules: null, submittedByRunId: null, actor: actor() }))).rejects.toThrow("publication_effect_interrupted");
    await expect.poll(async () => (await automationRow()).applied_effects_revision, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(1);
    const detail = await runInDurableObject(automationStub(), (instance: AutomationDO) => instance.readDetail({ ...addressed(), actor: actor() }));
    expect(detail.acceptedDefinitionRevision).toBe(1);
    expect(detail.loadable).toBe(true);
  });

  it("backfills a populated legacy owner without changing its accepted revision or permanent address", async () => {
    await activeAutomation();
    const before = await automationRow();
    await runInDurableObject(automationStub(), (_instance, state) => {
      state.storage.sql.exec(`ALTER TABLE automation DROP COLUMN loadable`);
      state.storage.sql.exec(`DELETE FROM _sql_schema_migrations WHERE version = 3`);
    });
    await evictDurableObject(automationStub());
    const detail = await runInDurableObject(automationStub(), (instance: AutomationDO) => instance.readDetail({ ...addressed(), actor: actor() }));
    expect(detail.loadable).toBe(false);
    expect(detail.acceptedDefinitionRevision).toBe(before.accepted_definition_revision);
    expect(detail.emailAddress).toBe(before.email_address);
    expect(detail.runnable).toBe(true);
  });

  it("reconciles stored policy and republishes discovery without accepting a caller boolean", async () => {
    await createDraft();
    await automationStub().saveDefinition({ ...addressed(), draft: { ...DEFINITION, definitionVersion: 2, triggers: [] }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    await runInDurableObject(automationStub(), (_instance, state) => state.storage.sql.exec(`UPDATE automation SET loadable = 0`));
    await automationStub().reconcileLoadable({ ...addressed(), actor: actor() });
    await deliverParentEffects(TEST_ENV, automationStub());
    expect(await workspaceStub().sidekickSkillCandidates({ workspaceId: WORKSPACE_ID })).toContain(AUTOMATION_ID);
    await automationStub().saveDefinition({ ...addressed(), draft: { ...DEFINITION, definitionVersion: 2 }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    await runInDurableObject(automationStub(), (_instance, state) => state.storage.sql.exec(`UPDATE automation SET loadable = 1`));
    const source = await automationStub().readSkillSource({ ...addressed(), principalUserId: AUTHOR_ID, conversationParentId: AUTOMATION_ID, audienceScope: "personal", audienceUserIds: [AUTHOR_ID] });
    expect(source?.loadable).toBe(true);
    expect(await automationStub().reconcileLoadable({ ...addressed(), actor: actor() })).toEqual({ loadable: false });
    await deliverParentEffects(TEST_ENV, automationStub());
    expect(await workspaceStub().sidekickSkillCandidates({ workspaceId: WORKSPACE_ID })).not.toContain(AUTOMATION_ID);
  });

  it("attaches a loaded main-stream Sidekick and pins the latest revision for later executions", async () => {
    await createDraft();
    const draft: AutomationDraft = { ...DEFINITION, definitionVersion: 2, triggers: [], instructions: "First accepted Sidekick instructions." };
    await automationStub().saveDefinition({ ...addressed(), draft, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    await deliverParentEffects(TEST_ENV, automationStub());
    const earlierId = asAutomationId("00000000-0000-7000-8000-000000000001");
    const earlier = env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(automationDOName("global", WORKSPACE_ID, earlierId)));
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "personal", owningWorkstreamId: null, automationId: earlierId });
    await earlier.saveDefinition({ workspaceId: WORKSPACE_ID, automationId: earlierId, draft, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    await deliverParentEffects(TEST_ENV, earlier);
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-00000000ad99");
    const root = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, workstreamId)));
    const auth = { sessionId: SESSION_ID, userId: AUTHOR_ID, workspaceId: WORKSPACE_ID, region: "global", role: "member" };
    loadSkillOnNextTurn = true;
    const opened = await root.fetch("https://object.test/internal/product", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "initialize", auth, input: {
        workspaceId: WORKSPACE_ID, workstreamId, generation: 1, title: "Use knowledge", objective: "",
        descriptionSource: "derived", titleStatus: "settled", emailAddress: null, creatorUserId: AUTHOR_ID,
        openingMessage: "Load the writing Sidekick.", clientMessageId: "sidekick-load", participantUserIds: [], attachmentIds: [],
        modelOverride: "double/primary", executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "user_message",
      } }),
    });
    expect(opened.status, await opened.clone().text()).toBe(200);
    const snapshots = () => runInDurableObject(root, (_instance, state) => state.storage.sql.exec<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM sidekick_execution_skills ORDER BY rowid`,
    ).toArray().map((row) => JSON.parse(row.snapshot_json)));
    await expect.poll(() => root.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId }), { timeout: RUN_SETTLE_TIMEOUT_MS }).toEqual([AUTOMATION_ID]);
    await expect.poll(() => runInDurableObject(root, (_instance, state) => state.storage.sql.exec<{ status: string }>(`SELECT status FROM runs ORDER BY created_at DESC LIMIT 1`).one().status), { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe("completed");
    expect((await snapshots())[0].sources).toContainEqual(expect.objectContaining({ id: AUTOMATION_ID, revision: 1 }));
    await earlier.remove({ workspaceId: WORKSPACE_ID, automationId: earlierId, actor: actor() });
    await deliverParentEffects(TEST_ENV, earlier);
    await evictDurableObject(root);
    await automationStub().saveDefinition({ ...addressed(), draft: { ...draft, name: "Updated helper", instructions: "Second accepted Sidekick instructions." }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    const sent = await root.fetch("https://object.test/internal/product", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "create_message", auth, input: { text: "Use the attached knowledge.", clientMessageId: "sidekick-again", mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } }),
    });
    expect(sent.status).toBe(200);
    await expect.poll(async () => (await snapshots()).length, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(2);
    const admitted = await snapshots();
    expect(admitted[0].sources).toContainEqual(expect.objectContaining({ id: AUTOMATION_ID, instructions: draft.instructions }));
    expect(admitted[1].sources).toContainEqual(expect.objectContaining({ id: AUTOMATION_ID, revision: 2 }));
    expect(admitted[1].activeRefs).toContain(`platform:sidekick-${AUTOMATION_ID}`);
    expect(await runInDurableObject(root, (_instance, state) => state.storage.sql.exec<{ name: string }>(
      `SELECT name FROM sidekick_skill_names WHERE sidekick_id = ?`, AUTOMATION_ID,
    ).one().name)).toBe("sidekick-manual-helper-2");
    await expect.poll(() => provider.calls.some((call) => call.messages.some((message) =>
      message.role === "system" && promptText(message.content).includes("Second accepted Sidekick instructions.")
      && promptText(message.content).includes('name="sidekick-manual-helper-2"'))),
    { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(true);
    expect(await root.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId, removeId: AUTOMATION_ID })).toEqual([]);
  });

  it("keeps the connector tables out of regional D1, which is what makes the binding tests evidence", async () => {
    await expect(env.DB.prepare(`SELECT id FROM connector_connections LIMIT 1`).all())
      .rejects.toThrow(/no such table: connector_connections/u);
  });

  it("applies a ready revision: binds the workspace connection, reserves the address, activates", async () => {
    await seedSlackConnection();
    await createDraft();
    expect((await automationRow()).lifecycle).toBe("draft");
    const submitted = await submit({
      ...DEFINITION,
      recommendedPlugins: [{ pluginId: "plugin_slack", recommendedTools: [], reason: "Needed" }],
    });
    expect(submitted).toEqual({ definitionRevision: 1, ready: true });

    const detail = await apply();

    expect(detail).toMatchObject({
      id: AUTOMATION_ID,
      lifecycle: "active",
      status: "active",
      acceptedDefinitionRevision: 1,
      currentDefinitionRevision: 1,
      emailAddress: EMAIL_ADDRESS,
      connectorBindings: { plugin_slack: SLACK_CONNECTION_ID },
    });
    const row = await automationRow();
    expect(JSON.parse(row.connector_bindings_json)).toEqual({ plugin_slack: SLACK_CONNECTION_ID });
    expect(row.effective_after_event_sequence).toBe(0);
    // The parent outbox carries the sidebar row, one per change, and nothing else.
    const queued = await pendingParentEffects(automationStub());
    expect(queued.length).toBeGreaterThanOrEqual(1);
    expect(new Set(queued.map((envelope) => envelope.effect.kind))).toEqual(new Set(["directory_automation"]));
    expect(queued.at(-1)?.effect).toMatchObject({ lifecycle: "active", title: "Manual helper" });
  });

  it("applies a webhook rule whatever the model put in resourceId, since a delivery is about no resource", async () => {
    await seedWebhookConnection();
    await createDraft();
    // What the drafting model sends: an optional id filled with a placeholder
    // reshaped to satisfy the pattern, and once a real-looking one. A webhook
    // trigger declares no resource relationship, so neither can mean anything,
    // and a revision that carries them is read as if it did not.
    const rules = {
      schemaVersion: 1 as const,
      evaluators: [
        {
          evaluatorKey: "checkout_deploys",
          source: {
            sourceBindingKey: "deploy_hook",
            suggestedSourcePluginId: "plugin_webhook",
            resourceId: "00000000-0000-4000-8000-000000000000",
            event: { kind: "event_type" as const, eventType: "deploy.finished" },
          },
          when: {
            kind: "all" as const,
            allOf: [{ kind: "string" as const, attribute: "service", operator: "equals" as const, value: "checkout" }],
          },
        },
        {
          evaluatorKey: "any_failure",
          source: {
            sourceBindingKey: "deploy_hook",
            suggestedSourcePluginId: "plugin_webhook",
            resourceId: "3d1f8c2a-5b6e-4c7d-8e9f-0a1b2c3d4e5f",
            event: { kind: "event_type" as const, eventType: "deploy.failed" },
          },
          when: { kind: "always" as const },
        },
      ],
    };
    const submitted = await automationStub().submitDefinition({
      ...addressed(),
      draft: WEBHOOK_DEFINITION,
      evaluatorRules: AutomationSetEvaluatorRulesInputV1Schema.parse(rules),
      submittedByRunId: null,
    });
    expect(submitted).toEqual({ definitionRevision: 1, ready: true });

    const detail = await apply();

    expect(detail).toMatchObject({
      lifecycle: "active",
      acceptedDefinitionRevision: 1,
      connectorBindings: { plugin_webhook: WEBHOOK_CONNECTION_ID },
    });
    expect(await activeRegistrations()).toBe(2);

    // The event that wakes the run is what the run reads: a matching delivery
    // is admitted, and the loop puts the event's fields in front of the model
    // as the run's input, labelled as the connector's words. Every event
    // automation drafted live fired correctly and then answered that the
    // event's fields were not provided, because the row never reached the
    // model.
    expect(await automationStub().admitExternalEvent({
      ...addressed(),
      registrationId: "00000000-0000-7000-8000-00000000ad71",
      payloadHash: `sha256:${"d".repeat(64)}`,
      event: {
        id: "00000000-0000-7000-8000-00000000ad72",
        eventSequence: 1,
        eventType: "deploy.finished",
        title: "checkout deployed",
        summary: "Deploy of checkout finished.",
        textSnippet: "",
        metadata: { service: "checkout", durationSeconds: 240 },
        occurredAt: Date.parse(NOW),
        audienceUserIds: [],
        audienceKind: "workspace",
      },
    })).toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_admitted" });
    const [admitted] = await runRows();
    const run = await settledChildRun(admitted!.run_id);
    expect(run).toMatchObject({ status: "completed", error_json: null });
    const eventInput = provider.calls.flatMap((call) => call.messages)
      .map((message) => promptText(message.content))
      .find((text) => text.includes("EVENT THAT STARTED THIS RUN"));
    expect(eventInput).toContain("checkout deployed");
    expect(eventInput).toContain("\"service\": \"checkout\"");
  });

  it("refuses to apply a revision naming a plugin the workspace has no connection for", async () => {
    await createDraft();
    await submit({
      ...DEFINITION,
      recommendedPlugins: [{ pluginId: "plugin_absent", recommendedTools: [], reason: "Needed" }],
    });
    await expect(apply()).rejects.toMatchObject({ code: "sidekick_plugin_unavailable" });
    expect((await automationRow()).lifecycle).toBe("draft");
  });

  it("re-applies a second ready revision on an active automation and leaves the old schedule behind", async () => {
    await activeAutomation();
    const before = await automationRow();
    expect(before.accepted_definition_revision).toBe(1);
    const second = await submit({
      ...DEFINITION,
      name: "Hourly helper",
      triggers: [{ type: "interval", intervalSeconds: 3_600, summary: "Every hour" }],
    });
    expect(second.definitionRevision).toBe(2);

    const detail = await apply();

    expect(detail.acceptedDefinitionRevision).toBe(2);
    expect(detail.name).toBe("Hourly helper");
    expect(detail.nextRunAt).not.toBeNull();
    const armed = (await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND);
    expect(armed).toHaveLength(1);
  });

  it("pauses: stops the in-flight run, cancels schedules, clears the workspace registrations; resumes: re-arms", async () => {
    await activeAutomation({
      ...DEFINITION,
      triggers: [{ type: "manual" }, { type: "interval", intervalSeconds: 3_600, summary: "Every hour" }],
    });
    const started = await automationStub().runNow({ ...addressed(), actor: actor(), idempotencyKey: "pause-run-0001" });
    expect(started.reused).toBe(false);
    // The registrations WorkspaceDO holds for this destination are the
    // accepted set, replaced whole; a pause replaces it with nothing.
    await workspaceStub().applyExternalEventRegistrations({
      sourceGeneration: await runInDurableObject(automationStub(), (_instance, state) => state.storage.sql.exec<{ registration_generation: number }>(
        `UPDATE automation SET registration_generation = registration_generation + 1 WHERE id = 1 RETURNING registration_generation`,
      ).one().registration_generation),
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      destination: { kind: "automation", automationId: AUTOMATION_ID },
      evaluators: [{
        evaluatorId: "00000000-0000-7000-8000-00000000ad40",
        source: { connectorType: "slack", connectionId: SLACK_CONNECTION_ID, eventType: "slack.message.posted" },
        when: { kind: "always" },
      }],
    });
    expect(await activeRegistrations()).toBe(1);

    await automationStub().pause({ ...addressed(), actor: actor() });

    expect(await automationRow()).toMatchObject({ lifecycle: "paused", paused_by: "person" });
    expect(await automationStub().readRunState({ ...addressed(), runId: started.runId }))
      .toEqual({ state: "stopped", lifecycle: "paused" });
    expect((await alarms()).filter((alarm) => (
      alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND || alarm.kind === AUTOMATION_RUN_ALARM_KIND
    ))).toEqual([]);
    expect(await activeRegistrations()).toBe(0);
    await expect(runInDurableObject(automationStub(), (instance: AutomationDO) =>
      instance.runNow({ ...addressed(), actor: actor(), idempotencyKey: "pause-run-0002" })))
      .rejects.toThrow("Only an active Sidekick can run");

    await automationStub().resume({ ...addressed(), actor: actor() });

    expect(await automationRow()).toMatchObject({ lifecycle: "active", paused_by: null });
    const rearmed = (await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND);
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]!.due_at).toBeGreaterThan(Date.now());
    // A stopped run stays stopped: resuming re-arms the future, not the past.
    expect(await automationStub().readRunState({ ...addressed(), runId: started.runId }))
      .toEqual({ state: "stopped", lifecycle: "active" });
  });

  it("removes: tombstones the row, reports archived, and is gone from the sidebar", async () => {
    await activeAutomation();
    await deliverParentEffects(TEST_ENV, automationStub());
    expect((await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID }))
      .items.map((item) => item.id)).toEqual([AUTOMATION_ID]);

    await automationStub().remove({ ...addressed(), actor: actor() });

    expect((await automationRow()).lifecycle).toBe("deleted");
    expect(await automationStub().authority({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: true });
    expect(await automationStub().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, userId: AUTHOR_ID }))
      .toEqual({ authorized: false, archived: true });
    await deliverParentEffects(TEST_ENV, automationStub());
    expect((await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID })).items)
      .toEqual([]);
    await expect(runInDurableObject(automationStub(), (instance: AutomationDO) =>
      instance.readDetail({ ...addressed(), actor: actor() }))).rejects.toThrow("This Sidekick was deleted");
  });

  it("refuses management by a member who is neither author nor principal", async () => {
    await activeAutomation();
    await expect(runInDurableObject(automationStub(), (instance: AutomationDO) =>
      instance.pause({ ...addressed(), actor: actor(OUTSIDER_ID) }))).rejects.toThrow("You cannot manage this Sidekick");
    expect((await automationRow()).lifecycle).toBe("active");
  });

  it("re-runs the tail of an apply whose effects never landed, instead of answering that it did", async () => {
    await seedSlackConnection();
    await createDraft();
    await submit({
      ...DEFINITION,
      triggers: [{ type: "manual" }, { type: "interval", intervalSeconds: 3_600, summary: "Every hour" }],
      recommendedPlugins: [{ pluginId: "plugin_slack", recommendedTools: [], reason: "Needed" }],
    });
    await apply();
    expect(await automationRow()).toMatchObject({ lifecycle: "active", accepted_definition_revision: 1, applied_effects_revision: 1 });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND)).toHaveLength(1);

    // The state a crash between the transaction and the marker leaves: the
    // row says applied, the alarm and the registrations never happened.
    // Before the marker, the replay guard read the accepted revision and
    // returned, so the automation stayed "active" with nothing armed and
    // nothing registered, and Apply was disabled because the revisions
    // matched: no way to repair it from anywhere.
    await runInDurableObject(automationStub(), (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM _internal_durable_alarms WHERE kind = ?`, AUTOMATION_SCHEDULE_ALARM_KIND);
      state.storage.sql.exec(`UPDATE automation SET applied_effects_revision = NULL, effective_after_event_sequence = NULL WHERE id = 1`);
    });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND)).toHaveLength(0);

    await apply();

    expect(await automationRow()).toMatchObject({ applied_effects_revision: 1, effective_after_event_sequence: 0 });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND)).toHaveLength(1);
  });

  it("saves edits while preserving a person pause", async () => {
    await activeAutomation();
    await automationStub().pause({ ...addressed(), actor: actor() });
    const revised = await submit({ ...DEFINITION, instructions: "Say hello twice." });
    expect(revised.definitionRevision).toBe(2);

    // Applying used to write `lifecycle = 'active', paused_by = NULL` with no
    // look at why the automation was paused, which resumed a room-archived
    // automation past the refusal `resume` gives, with its schedules armed
    // and its connector writes back, into a room it could not post to.
    await apply();
    expect(await automationRow()).toMatchObject({ lifecycle: "paused", paused_by: "person", accepted_definition_revision: 2 });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND)).toHaveLength(0);

    await automationStub().resume({ ...addressed(), actor: actor() });
    await apply();
    expect(await automationRow()).toMatchObject({ lifecycle: "active", accepted_definition_revision: 2 });
  });

  it("refuses to apply to an automation whose owning room is archived", async () => {
    const roomId = "00000000-0000-7000-8000-00000000ad80";
    await createDraft(roomId);
    await submit();
    await apply();
    await automationStub().setOwningRoomArchived({ ...addressed(), workstreamId: roomId, archived: true });
    expect(await automationRow()).toMatchObject({ lifecycle: "paused", paused_by: "room_archive" });
    await submit({ ...DEFINITION, instructions: "Say hello three times." });

    // The archive holds until the room comes back; `resume` refuses with this
    // code, and apply now answers the same instead of walking around it.
    await expect(apply()).rejects.toMatchObject({ code: "sidekick_room_archived" });
    expect(await automationRow()).toMatchObject({ lifecycle: "paused", paused_by: "room_archive", accepted_definition_revision: 1 });
  });

  it("creates the tables a definition declares in the automation's memory scope, once", async () => {
    const declared = [{
      name: "Deploys",
      description: "One row per deploy the automation has seen.",
      usageInstructions: "Insert a row for every deploy; update it when the deploy is rolled back.",
      columns: [
        { name: "service", description: "The service deployed.", type: "string", required: true, searchable: true },
        { name: "deployedAt", description: "When it finished.", type: "datetime", required: true, searchable: false },
      ],
      keyColumns: ["service"],
    }, {
      name: "Rollbacks",
      description: "Deploys that were rolled back.",
      usageInstructions: "One row per rollback.",
      columns: [{ name: "rollbackId", description: "The rollback.", type: "string", required: true, searchable: true }],
      keyColumns: ["rollbackId"],
    }];
    await createDraft();
    await submit({ ...DEFINITION, memoryTables: declared as AutomationDraft["memoryTables"] });
    await apply();

    // The draft asked the model for these, the definition carried them, and
    // nothing made them: a run went looking for a table its own definition
    // named and found nothing.
    const tables = async () => runInDurableObject(workspaceStub(), (_instance, state) =>
      state.storage.sql.exec<{ name: string; kind: string; owner_id: string; columns: number }>(
        `SELECT t.name, s.kind, s.owner_id,
                (SELECT COUNT(*) FROM memory_table_columns c WHERE c.memory_table_id = t.memory_table_id) AS columns
           FROM memory_tables t JOIN memory_scopes s ON s.memory_scope_id = t.memory_scope_id
          WHERE t.invalidated_at IS NULL ORDER BY t.name`,
      ).toArray());
    expect(await tables()).toEqual([
      { name: "Deploys", kind: "sidekick", owner_id: AUTOMATION_ID, columns: 2 },
      { name: "Rollbacks", kind: "sidekick", owner_id: AUTOMATION_ID, columns: 1 },
    ]);

    // A second revision declaring the same tables reopens them; nothing is
    // duplicated and nothing is dropped.
    await submit({ ...DEFINITION, instructions: "Report deploys.", memoryTables: declared as AutomationDraft["memoryTables"] });
    await apply();
    expect(await tables()).toHaveLength(2);

    // The run is told what exists in its scope.
    const started = await automationStub().runNow({ ...addressed(), actor: actor(), idempotencyKey: "tables-run-01" });
    await settledChildRun(started.runId);
    const systemPrompt = promptText(provider.calls[0]!.messages[0]?.content);
    expect(systemPrompt).toContain("\"Deploys\"");
    expect(systemPrompt).toContain("\"Rollbacks\"");
    expect(systemPrompt).toContain("rollbackId");
  });

  it("arms the run alarm again for a pending run whose admission is retried", async () => {
    await activeAutomation();
    const first = await automationStub().runNow({ ...addressed(), actor: actor(), idempotencyKey: "rearm-key-0001" });
    // The row commits before the alarm is armed. A retry after a failure
    // between the two found the row and returned `reused` with nothing armed,
    // so the run stayed pending forever: nothing else ever provisions it.
    await runInDurableObject(automationStub(), (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM _internal_durable_alarms WHERE kind = ?`, AUTOMATION_RUN_ALARM_KIND);
    });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_RUN_ALARM_KIND)).toHaveLength(0);

    const again = await automationStub().runNow({ ...addressed(), actor: actor(), idempotencyKey: "rearm-key-0001" });

    expect(again).toEqual({ runId: first.runId, reused: true });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_RUN_ALARM_KIND)).toHaveLength(1);
    const run = await settledChildRun(first.runId);
    expect(run).toMatchObject({ status: "completed" });
  });

  it("provisions the conversation on a replayed create, so a first call that died after the row is repaired", async () => {
    // The object's row commits first; a first call that failed between it
    // and the conversation's provisioning used to answer `created: false`
    // forever after and skip both, leaving an automation nobody could open.
    // Room drafting reaches this directly: its automation id is the stable
    // harness run id, so the retry is the same call again.
    const authority = await readWorkstreamAuthorityControl(TEST_ENV);
    expect(await automationStub().create({
      ...addressed(),
      authorUserId: AUTHOR_ID,
      scope: "personal",
      owningWorkstreamId: null,
      authorityGeneration: authority.generation,
    })).toEqual({ created: true });

    const replayed = await createAutomation(TEST_ENV, {
      workspaceId: WORKSPACE_ID,
      authorUserId: AUTHOR_ID,
      scope: "personal",
      owningWorkstreamId: null,
      automationId: AUTOMATION_ID,
    });

    expect(replayed).toEqual({ automationId: AUTOMATION_ID, created: false });
    const conversation = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, AUTOMATION_ID),
    ));
    expect(await runInDurableObject(conversation, (_instance, state) =>
      state.storage.sql.exec<{ title: string }>(`SELECT title FROM workstream WHERE id = 1`).one().title))
      .toBe("New Sidekick");
    // And a second replay is a no-op rather than a second provisioning.
    await expect(createAutomation(TEST_ENV, {
      workspaceId: WORKSPACE_ID,
      authorUserId: AUTHOR_ID,
      scope: "personal",
      owningWorkstreamId: null,
      automationId: AUTOMATION_ID,
    })).resolves.toEqual({ automationId: AUTOMATION_ID, created: false });
  });

  it("attaches a run's resources to the run, not to the drafting conversation", async () => {
    await activeAutomation();
    const started = await automationStub().runNow({ ...addressed(), actor: actor(), idempotencyKey: "attach-run-01" });
    await settledChildRun(started.runId);
    const resourceId = "00000000-0000-7000-8000-00000000ad90";
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO resources
           (id, workspace_id, connection_id, resource_type, provider,
            provider_resource_id, title, metadata_json, created_at, updated_at)
         VALUES (?, ?, NULL, 'generated_image', 'rally', ?, 'Chart', '{}', ?, ?)`,
        resourceId, WORKSPACE_ID, resourceId, NOW, NOW,
      );
    });
    const links = (stub: DurableObjectStub<SubstreamAgent>) => runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ resource_id: string }>(`SELECT resource_id FROM workstream_resource_links`).toArray()
        .map((row) => row.resource_id));

    // The attacher a run's harness holds is the run object's own: it takes an
    // attachment for this conversation and refuses one addressed to another.
    // Before, only substream "0" had one, and a run's plugins fell back to a
    // port addressed at the parent's main conversation.
    await runInDurableObject(childStub(started.runId), async (instance) => {
      const attacher = (instance as unknown as {
        localRuntimeResourceAttacher: (workspaceId: string, workstreamId: string) =>
          (input: Record<string, unknown>) => Promise<void>;
      }).localRuntimeResourceAttacher(WORKSPACE_ID, AUTOMATION_ID);
      await attacher({
        workspaceId: WORKSPACE_ID,
        workstreamId: AUTOMATION_ID,
        substreamId: started.runId,
        resourceId,
        attachedByUserId: null,
      });
      await expect(attacher({
        workspaceId: WORKSPACE_ID,
        workstreamId: AUTOMATION_ID,
        substreamId: "0",
        resourceId,
        attachedByUserId: null,
      })).rejects.toThrow("workstream_runtime_identity_mismatch");
    });

    expect(await links(childStub(started.runId))).toEqual([resourceId]);
    expect(await links(env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, AUTOMATION_ID),
    )))).toEqual([]);
  });

  it("admits a manual run once per idempotency key", async () => {
    await activeAutomation();
    const first = await automationStub().runNow({ ...addressed(), actor: actor(), idempotencyKey: "manual-key-0001" });
    const again = await automationStub().runNow({ ...addressed(), actor: actor(), idempotencyKey: "manual-key-0001" });
    const other = await automationStub().runNow({ ...addressed(), actor: actor(), idempotencyKey: "manual-key-0002" });

    expect(again).toEqual({ runId: first.runId, reused: true });
    expect(other.reused).toBe(false);
    expect(other.runId).not.toBe(first.runId);
    expect((await runRows()).map((run) => run.occurrence_key).sort())
      .toEqual(["manual:manual-key-0001", "manual:manual-key-0002"]);
  });

  it("admits an external event once, and refuses one from before the activation boundary", async () => {
    await seedSlackConnection();
    await createDraft();
    await submit();
    // An event that arrived before the automation was applied: the boundary
    // the apply records is the workspace's latest event sequence at that
    // moment, and a rule that did not exist when the event arrived must not
    // match it later.
    const earlierEventId = "00000000-0000-7000-8000-00000000ad50";
    await ingestSlackEvent(earlierEventId, "event-before-activation");
    await apply();
    expect((await automationRow()).effective_after_event_sequence).toBe(1);
    const event = {
      id: "00000000-0000-7000-8000-00000000ad52",
      eventSequence: 2,
      eventType: "slack.message.posted",
      title: "New message",
      summary: "A channel message arrived",
      textSnippet: "foobar",
      metadata: { messageText: "foobar", channel: "C123" },
      occurredAt: Date.parse(NOW),
      audienceUserIds: [],
      audienceKind: "workspace" as const,
    };
    const admission = {
      ...addressed(),
      registrationId: "00000000-0000-7000-8000-00000000ad51",
      payloadHash: `sha256:${"a".repeat(64)}`,
    };

    expect(await automationStub().admitExternalEvent({ ...admission, event }))
      .toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_admitted" });
    expect(await automationStub().admitExternalEvent({ ...admission, event }))
      .toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_replayed" });
    expect(await automationStub().admitExternalEvent({
      ...admission,
      event: { ...event, id: earlierEventId, eventSequence: 1 },
    })).toEqual({ admitted: false, outcomeCode: "sidekick_event_before_activation_boundary" });
    expect((await runRows()).map((run) => run.occurrence_key)).toEqual([`external:${event.id}`]);
    // The run gets to read the event that woke it: without this it knew only
    // the event's type, and a rule on `channel` produced a run that could not
    // name the channel.
    const [admittedRun] = await runRows();
    const opening = await runInDurableObject(automationStub(), (_instance, state) =>
      state.storage.sql.exec<{ opening_json: string | null }>(
        `SELECT opening_json FROM runs WHERE run_id = ?`, admittedRun!.run_id,
      ).one().opening_json);
    const parsed = JSON.parse(opening ?? "null") as {
      textContent: string;
      structuredContent: Record<string, unknown>;
      resourceId: string | null;
    } | null;
    expect(parsed?.textContent).toContain("New message");
    expect(parsed?.textContent).toContain("\"channel\": \"C123\"");
    expect(parsed?.structuredContent).toMatchObject({
      kind: "external_event",
      untrusted: true,
      workspaceEventId: event.id,
      metadata: { channel: "C123" },
    });
    expect(parsed?.resourceId).toBeNull();
  });

  it("admits an inbound email once, answers a resend retry from its receipt, and refuses a stranger", async () => {
    await activeAutomation();
    const email = {
      ...addressed(),
      emailAddress: EMAIL_ADDRESS,
      resendEmailId: "resend-email-0001",
      senderUserId: AUTHOR_ID,
      receivedAt: Date.parse(NOW),
      payloadRef: "emails/resend-email-0001",
      resourceId: "00000000-0000-7000-8000-00000000ad60",
      textContent: "Please summarize the attached thread.",
      structuredContent: { subject: "Summary" },
    };

    const admitted = await automationStub().admitInboundEmail(email);
    expect(admitted).toMatchObject({ admitted: true, duplicate: false, outcomeCode: "admitted" });
    expect(await automationStub().admitInboundEmail(email))
      .toEqual({ admitted: true, duplicate: true, outcomeCode: "admitted", runId: admitted.runId });
    expect(await automationStub().admitInboundEmail({
      ...email,
      resendEmailId: "resend-email-0002",
      senderUserId: OUTSIDER_ID,
    })).toEqual({ admitted: false, duplicate: false, outcomeCode: "email_sender_not_authorized", runId: null });
    expect(await automationStub().admitInboundEmail({
      ...email,
      resendEmailId: "resend-email-0003",
      emailAddress: "somebody-else@mail.rallywithai.com",
    })).toEqual({ admitted: false, duplicate: false, outcomeCode: "sidekick_email_route_mismatch", runId: null });
    expect((await runRows()).map((run) => run.occurrence_key)).toEqual(["inbound_email:resend-email-0001"]);
    const receipts = await runInDurableObject(automationStub(), (_instance, state) =>
      state.storage.sql.exec<{ resend_email_id: string; outcome_code: string }>(
        `SELECT resend_email_id, outcome_code FROM inbound_email_receipts ORDER BY resend_email_id`,
      ).toArray());
    expect(receipts).toEqual([
      { resend_email_id: "resend-email-0001", outcome_code: "admitted" },
      { resend_email_id: "resend-email-0002", outcome_code: "email_sender_not_authorized" },
      { resend_email_id: "resend-email-0003", outcome_code: "sidekick_email_route_mismatch" },
    ]);
  });

  it("provisions the run as a child substream whose loop reads its definition by revision, then follows its state", async () => {
    await activeAutomation();
    const revised = await submit({ ...DEFINITION, instructions: "Count the open pull requests and report the number." });
    await apply();
    expect(revised.definitionRevision).toBe(2);
    // A newer draft the conversation has written but nobody has applied: the
    // run reads the revision it was admitted under, not whatever is current.
    const unapplied = await submit({ ...DEFINITION, instructions: "Count the closed pull requests instead." });
    expect(unapplied.definitionRevision).toBe(3);
    const started = await automationStub().runNow({ ...addressed(), actor: actor(), idempotencyKey: "provision-run-01" });

    const run = await settledChildRun(started.runId);

    expect(run).toMatchObject({ status: "completed", error_json: null });
    expect(await automationStub().listChildren({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID }))
      .toEqual({ children: [
        { substreamId: "0", kind: "main", createdAt: expect.any(Number) },
        { substreamId: started.runId, kind: "child", createdAt: expect.any(Number) },
      ] });
    // The loop asked this object for revision 2 and put its instructions in
    // front of the model.
    expect(provider.calls.length).toBeGreaterThanOrEqual(1);
    const systemPrompt = promptText(provider.calls[0]!.messages[0]?.content);
    expect(systemPrompt).toContain("Count the open pull requests and report the number.");
    expect(systemPrompt).not.toContain("Count the closed pull requests instead.");
    expect(await automationStub().readRunDefinition({ ...addressed(), runId: started.runId })).toMatchObject({
      definitionRevision: 2,
      runId: started.runId,
      state: "running",
      trigger: { kind: "manual", requestedByUserId: AUTHOR_ID },
    });

    // The child's own effects, through the real consumer, move the run row
    // forward and put the automation's sidebar row in the workspace.
    const delivered = await deliverChildEffects(TEST_ENV, childStub(started.runId));
    expect(delivered.some((envelope) => envelope.effect.kind === "directory_common")).toBe(true);
    expect(await automationStub().readRunState({ ...addressed(), runId: started.runId }))
      .toEqual({ state: "completed", lifecycle: "active" });
    const parent = await deliverParentEffects(TEST_ENV, automationStub());
    expect(parent.length).toBeGreaterThanOrEqual(1);
    expect(new Set(parent.map((envelope) => envelope.effect.kind))).toEqual(new Set(["directory_automation"]));
    const listed = await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID });
    expect(listed.items.map((item) => [item.id, item.status])).toEqual([[AUTOMATION_ID, "active"]]);

    // Forward only: a later `running` from the same child cannot reopen a
    // completed run.
    const latest = delivered.filter((envelope) => envelope.effect.kind === "directory_common").at(-1)!;
    const latestEffect = latest.effect;
    if (latestEffect.kind !== "directory_common") throw new Error("expected the child's directory_common effect");
    const regressed = { ...latestEffect, state: "running" };
    const regression: ConversationEffectEnvelope = ConversationEffectEnvelopeSchema.parse({
      ...latest,
      messageId: `${latest.messageId}:regression`,
      sourceVersion: latest.sourceVersion + 1,
      effect: regressed,
      payloadHash: conversationEffectHash(regressed),
    });
    expect(await consumeEffectBodies(TEST_ENV, [regression])).toEqual({ acked: 1, retried: 0 });
    expect(await automationStub().readRunState({ ...addressed(), runId: started.runId }))
      .toEqual({ state: "completed", lifecycle: "active" });
  });
});
