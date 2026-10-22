/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A hosted Sidekick: the Sidekick itself, its definition revisions, schedules,
 * runs, inbound email, and the run child it provisions, all held by its
 * Organization's `WorkspaceDO` (`HostedSidekick`).
 *
 * Everything here is driven through the Organization object's `sidekick*` RPC
 * surface and the alarm entries it arms, against the real WorkspaceDO, the
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
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  asAutomationId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  agentAddressForId,
  WorkstreamWorkflowInputSchema,
  AutomationSetEvaluatorRulesModelInputV1Schema,
  type AutomationDraft,
} from "@rally/contracts";
import {
  ConversationEffectEnvelopeSchema,
  conversationEffectHash,
  type ConversationEffectEnvelope,
} from "@rally/contracts/conversation-effects";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { HostedSidekick, SIDEKICK_MEMORY_TABLES_ALARM_KIND, type HostedSidekickHost } from "../src/durable-objects/hosted-sidekick";
import type { SubstreamAgent } from "../src/durable-objects/substream-agent";
import {
  AUTOMATION_RUN_ALARM_KIND,
  AUTOMATION_SCHEDULE_ALARM_KIND,
} from "../src/durable-objects/automation-do-protocol";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { AgentCommunicationService } from "../src/services/agent-communication-service";
import { AuthorizationService } from "../src/services/authorization-service";
import { WorkstreamService } from "../src/services/workstream-service";
import { bootstrapConversationChildRuntime, bootstrapWorkstreamRuntimeEnvironment, provisionWorkstreamObject } from "../src/services/workstream-runtime-database";
import { readWorkstreamAuthorityControl } from "../src/services/workstream-authority";
import {
  consumeEffectBodies,
  deliverChildEffects,
} from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { hostedParentStub } from "./helpers/hosted-parent";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { runSidekickAlarms } from "./helpers/sidekick";
import { SidekickRunProvisionQueueMessageSchema } from "../src/durable-objects/automation-do-protocol";
import { provisionSidekickRun } from "../src/services/sidekick-run-provisioning";
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
let sidekickToolScript: { name: string; arguments: unknown }[] = [];
let submitDraftOnNextTurn = false;
const provider = useOpenRouterDouble((call) => {
  const scripted = sidekickToolScript.shift();
  if (scripted) return { callTool: scripted };
  if (submitDraftOnNextTurn) {
    submitDraftOnNextTurn = false;
    expect(call.toolNames).toContain("sidekick_submit_draft");
    return { callTool: { name: "sidekick_submit_draft", arguments: { ...DEFINITION, triggers: [], icon: "lightbulb", color: "emerald" } } };
  }
  if (loadSkillOnNextTurn) {
    loadSkillOnNextTurn = false;
    return { callTool: { name: "load_skill", arguments: { name: "skill-manual-helper-2" } } };
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
    // Bootstrap reads it to refuse a Space or Sidekick id a Channel create claimed.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
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
    creatorConsent: { requestId: AUTOMATION_ID },
  });
  expect(created).toEqual({ automationId: AUTOMATION_ID, created: true });
}

async function submit(draft: AutomationDraft = DEFINITION): Promise<{ definitionRevision: number; ready: boolean }> {
  return workspaceStub().sidekickSubmitDefinition({ ...addressed(), draft, evaluatorRules: null, submittedByRunId: null });
}

/**
 * Applied inside the object: `AutomationDetail` is what the stub returns, and
 * a rejection over a stub is reported a second time as unhandled, which fails
 * the run even when the assertion held.
 */
async function apply(userId = AUTHOR_ID) {
  return runInDurableObject(workspaceStub(), (instance: WorkspaceDO) =>
    instance.sidekickApply({ ...addressed(), actor: actor(userId) }));
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
  connector_bindings_json: string | null;
  email_address: string | null;
}

async function automationRow(): Promise<AutomationRow> {
  return runInDurableObject(workspaceStub(), (_instance, state) =>
    state.storage.sql.exec<AutomationRow>(
      `SELECT lifecycle, paused_by, accepted_definition_revision, effective_after_event_sequence,
              connector_bindings_json, email_address
         FROM automation_directory WHERE automation_id = ?`, AUTOMATION_ID,
    ).one());
}

async function runRows(): Promise<{ run_id: string; occurrence_key: string; state: string }[]> {
  return runInDurableObject(workspaceStub(), (_instance, state) =>
    state.storage.sql.exec<{ run_id: string; occurrence_key: string; state: string }>(
      `SELECT run_id, occurrence_key, state FROM sidekick_runs WHERE sidekick_id = ? ORDER BY created_at, run_id`,
      AUTOMATION_ID,
    ).toArray());
}

/** This Sidekick's alarm entries in the Organization object, keyed as the Sidekick keys them. */
async function alarms(): Promise<{ kind: string; alarm_key: string; due_at: number }[]> {
  const prefix = `${AUTOMATION_ID}:`;
  const rows = await runInDurableObject(workspaceStub(), (_instance, state) =>
    state.storage.sql.exec<{ kind: string; alarm_key: string; due_at: number }>(
      `SELECT kind, alarm_key, due_at FROM _internal_durable_alarms
        WHERE substr(alarm_key, 1, ?) = ? ORDER BY kind, alarm_key`,
      prefix.length, prefix,
    ).toArray());
  return rows.map((row) => ({ ...row, alarm_key: row.alarm_key.slice(prefix.length) }));
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
  await runSidekickAlarms(TEST_ENV, WORKSPACE_ID);
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
  sidekickToolScript = [];
  loadSkillOnNextTurn = false;
  submitDraftOnNextTurn = false;
  automationOrdinal += 1;
  AUTOMATION_ID = asAutomationId(`00000000-0000-7000-8000-${String(automationOrdinal).padStart(4, "0")}00000ad0`);
  await reset();
  await seedRegionalDatabase();
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("a hosted Sidekick", () => {
  it("lets a child recommend workspace knowledge without activating main or siblings, and loads only locally", async () => {
    const workstreamId = asWorkstreamId('00000000-0000-7000-8000-00000000ad99');
    const parent = hostedParentStub(env, WORKSPACE_ID);
    const root = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName('global', WORKSPACE_ID, workstreamId)));
    await parent.reserveChild({ workspaceId: WORKSPACE_ID, parentId: workstreamId, substreamId: asSubstreamId('0'), kind: 'main', createdByUserId: AUTHOR_ID,
      authorityGeneration: 1, directory: { title: 'Knowledge', description: '', scope: 'workspace', systemKind: null, emailAddress: null, titleStatus: 'settled', createdAt: NOW } });
    await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, workstreamId, 'workstream');
    await provisionWorkstreamObject(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId, title: 'Knowledge', objective: '', scope: 'workspace', createdByUserId: AUTHOR_ID,
      participantUserIds: [AUTHOR_ID], harnessStatus: 'idle', titleStatus: 'settled', emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: 'double/primary', now: Date.now() });
    await deliverChildEffects(TEST_ENV, root);
    async function child(operationId: string) {
      const recipe = { policy: { revision: 'test-empty-v1', strategy: { id: 'empty', version: 1 }, config: {} }, capture: 'none' as const, parts: [] };
      const reserved = await parent.beginPrivateChildPreparation({ workspaceId: WORKSPACE_ID, parentId: workstreamId, operationId, creatorUserId: AUTHOR_ID, title: operationId,
        sourceSubstreamId: '0', sourceThroughTurnId: null, recipe, membershipInitializer: { plugin: { id: 'creator-only', version: 1 }, config: {}, memberUserIds: [AUTHOR_ID] } });
      const hash = '0'.repeat(64);
      await parent.savePreparedPrivateChildContext({ workspaceId: WORKSPACE_ID, parentId: workstreamId, operationId,
        preparedContext: { schemaVersion: 1, recipe, recipeHash: hash, capture: null, captureHash: null, parts: [], contentHash: hash } });
      await parent.claimPrivateChildConfirmation({ workspaceId: WORKSPACE_ID, parentId: workstreamId, operationId, actorUserId: AUTHOR_ID });
      await bootstrapConversationChildRuntime(TEST_ENV, WORKSPACE_ID, 'workstream', workstreamId, reserved.substreamId);
      await provisionWorkstreamObject(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId, substreamId: reserved.substreamId, title: operationId, objective: '', scope: 'personal', createdByUserId: AUTHOR_ID,
        participantUserIds: [AUTHOR_ID], harnessStatus: 'idle', titleStatus: 'settled', emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: 'double/primary', now: Date.now() });
      const agent = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName('global', WORKSPACE_ID, workstreamId, asSubstreamId(reserved.substreamId))));
      await agent.installPreparedSubstreamContext({ workspaceId: WORKSPACE_ID, workstreamId, substreamId: reserved.substreamId, operationId });
      await parent.setPrivateChildTerminalStatus({ workspaceId: WORKSPACE_ID, parentId: workstreamId, operationId, status: 'ready', errorCode: null });
      await deliverChildEffects(TEST_ENV, agent);
      return agent;
    }
    const first = await child('first-child');
    const sibling = await child('sibling-child');
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: 'workspace', owningWorkstreamId: null, automationId: AUTOMATION_ID });
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: { ...DEFINITION, suggestedScope: 'workspace', definitionVersion: 2, triggers: [], instructions: 'Secret body loaded only on request.' }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    let messageOrdinal = 0;
    async function execute(agent: typeof root, script: typeof sidekickToolScript = []) {
      sidekickToolScript = script;
      const before = provider.calls.length;
      const runCount = await runInDurableObject(agent, (_instance, state) => state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM runs').one().n);
      const response = await agent.fetch('https://object.test/internal/product', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'create_message', auth: { sessionId: SESSION_ID, userId: AUTHOR_ID, workspaceId: WORKSPACE_ID, region: 'global', role: 'member' },
          input: { text: 'Use relevant knowledge.', clientMessageId: `recommend-${++messageOrdinal}`, mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } }) });
      expect(response.status, await response.text()).toBe(200);
      await expect.poll(() => runInDurableObject(agent, (_instance, state) => {
        const rows = state.storage.sql.exec<{ status: string }>('SELECT status FROM runs ORDER BY created_at').toArray();
        return rows.length > runCount ? rows.at(-1)?.status : 'waiting';
      }), { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe('completed');
      return provider.calls.slice(before).map((call) => call.messages.filter((message) => message.role === 'system').map((message) => promptText(message.content)).join('\n')).join('\n');
    }
    await execute(first, [{ name: 'load_plugin', arguments: { pluginId: 'rally_skill_recommendations' } }, { name: 'list_skill_recommendations', arguments: {} }, { name: 'recommend_skill', arguments: { skillId: AUTOMATION_ID } }]);
    const listing = provider.calls.flatMap((call) => call.messages).find((message) => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('canRecommend'));
    expect(listing?.content).toContain('"canRecommend":true');
    expect(listing?.content).toContain('"skillId":');
    expect(listing?.content).not.toContain('sidekickId');
    expect(listing?.content).not.toContain('workspaceSidekicks');
    // A room edits no Sidekick here, so its list carries no edit state.
    expect(listing?.content).not.toContain('canEdit');
    expect(await parent.recommendedSidekickIds({ workspaceId: WORKSPACE_ID, parentId: workstreamId }), JSON.stringify(provider.calls.map((call) => call.messages.filter((message) => message.role === 'tool')))).toEqual([AUTOMATION_ID]);
    for (const agent of [root, sibling]) {
      const prompt = await execute(agent);
      expect(prompt).toContain('[Recommended]');
      expect(prompt).not.toContain('Secret body loaded only on request.');
    }
    await execute(first, [{ name: 'load_skill', arguments: { name: 'skill-manual-helper' } }]);
    expect(await first.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId })).toEqual([AUTOMATION_ID]);
    expect(await root.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId })).toEqual([]);
    expect(await sibling.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId })).toEqual([]);
    await execute(sibling, [{ name: 'load_skill', arguments: { name: 'skill-manual-helper' } }]);
    await execute(first, [{ name: 'load_plugin', arguments: { pluginId: 'rally_skill_recommendations' } }, { name: 'unrecommend_skill', arguments: { skillId: AUTOMATION_ID } }]);
    expect(await first.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId }), JSON.stringify(provider.calls.at(-1)?.messages.filter((message) => message.role === 'tool'))).toEqual([]);
    expect(await sibling.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId })).toEqual([AUTOMATION_ID]);
    const after = await execute(root);
    expect(after).not.toContain('[Recommended]');
    expect(after).toContain('skill-manual-helper');
    expect(after).not.toContain('Secret body loaded only on request.');
    // Ownership recommends the Sidekick independently of the explicit table.
    const ownedId = asAutomationId('00000000-0000-7000-8000-00000000ad98');
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: 'workstream', owningWorkstreamId: workstreamId, automationId: ownedId });
    await workspaceStub().sidekickSaveDefinition({ workspaceId: WORKSPACE_ID, automationId: ownedId,
      draft: { ...DEFINITION, name: 'Owned helper', suggestedScope: 'workstream', definitionVersion: 2, triggers: [], instructions: 'Owned body loaded only on request.' },
      evaluatorRules: null, submittedByRunId: null, actor: { ...actor(), participantOfOwningWorkstream: true } });
    for (const agent of [root, first, sibling]) {
      const prompt = await execute(agent);
      expect(prompt.split('\n').find((line) => line.includes('skill-owned-helper'))).toContain('[Recommended]');
      expect(prompt).not.toContain('Owned body loaded only on request.');
    }
    await execute(first, [{ name: 'load_plugin', arguments: { pluginId: 'rally_skill_recommendations' } }, { name: 'unrecommend_skill', arguments: { skillId: ownedId } }]);
    expect((await execute(root)).split('\n').find((line) => line.includes('skill-owned-helper'))).toContain('[Recommended]');

    // A delegated agent has a real local participant but no human-viewable
    // private-child membership. Its tools must use execution authority.
    await execute(root, [{ name: 'load_skill', arguments: { name: 'skill-manual-helper' } }]);
    const input = WorkstreamWorkflowInputSchema.parse({ region: 'global', workspaceId: WORKSPACE_ID,
      parentKind: 'workstream', parentId: workstreamId, substreamId: '0', loopId: `workstream:${workstreamId}:substream:0:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: 'user', userId: AUTHOR_ID }, reason: 'test' });
    const agents = new AgentCommunicationService(TEST_ENV, input);
    const toolContext = { workspaceId: WORKSPACE_ID, workstreamId, harnessRunId: input.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(), executionPrincipal: input.executionPrincipal,
      signal: new AbortController().signal };
    sidekickToolScript = [{ name: 'load_plugin', arguments: { pluginId: 'rally_skill_recommendations' } },
      { name: 'recommend_skill', arguments: { skillId: AUTOMATION_ID } },
      { name: 'load_skill', arguments: { name: 'skill-manual-helper' } }];
    const rootCompletedRuns = () => runInDurableObject(root, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'completed'").one().n);
    const rootRunsBefore = await rootCompletedRuns();
    const started = await agents.start({ name: 'Knowledge helper', description: 'Use shared knowledge',
      message: 'Attach and load relevant knowledge.', attachmentIds: [] }, toolContext);
    const address = agentAddressForId(started.agentId);
    const hidden = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName('global', WORKSPACE_ID, workstreamId, address.substreamId)));
    const completedRuns = () => runInDurableObject(hidden, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'completed'").one().n);
    await expect.poll(completedRuns, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(1);
    // The hidden worker finished without replying, so its owner is told once
    // and runs on that; wait for it, or the next script feeds the wrong run.
    await expect.poll(rootCompletedRuns, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(rootRunsBefore + 1);
    expect(await parent.authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: workstreamId,
      substreamId: address.substreamId, userId: AUTHOR_ID })).toMatchObject({ authorized: false });
    const userService = new WorkstreamService(TEST_ENV, { sessionId: SESSION_ID, userId: AUTHOR_ID,
      workspaceId: WORKSPACE_ID, region: 'global', role: 'member', analyticsWorkspaceId: null });
    await expect(userService.setSidekickRecommendation(workstreamId, AUTOMATION_ID, false, address.substreamId))
      .rejects.toMatchObject({ status: 404 });
    expect(await parent.recommendedSidekickIds({ workspaceId: WORKSPACE_ID, parentId: workstreamId })).toEqual([AUTOMATION_ID]);
    expect(await hidden.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId })).toEqual([AUTOMATION_ID]);
    sidekickToolScript = [{ name: 'load_plugin', arguments: { pluginId: 'rally_skill_recommendations' } },
      { name: 'unrecommend_skill', arguments: { skillId: AUTOMATION_ID } }];
    await agents.send({ agentId: started.agentId, message: 'Detach that recommendation.', attachmentIds: [] },
      { ...toolContext, effectIntentId: crypto.randomUUID() });
    await expect.poll(completedRuns, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(2);
    await expect.poll(rootCompletedRuns, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(rootRunsBefore + 2);
    const managementResults = provider.calls.flatMap((call) => call.messages)
      .filter((message) => message.role === 'tool' && 'tool_call_id' in message
        && ['call-recommend_skill', 'call-unrecommend_skill'].includes(String(message.tool_call_id)));
    expect(managementResults.length).toBeGreaterThan(0);
    for (const message of managementResults) {
      expect(JSON.parse(promptText(message.content)), promptText(message.content)).toMatchObject({ success: true });
    }
    expect(await parent.recommendedSidekickIds({ workspaceId: WORKSPACE_ID, parentId: workstreamId })).toEqual([]);
    expect(await hidden.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId })).toEqual([]);
    expect(await root.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId })).toEqual([AUTOMATION_ID]);
    await hidden.stopOwnedAgent();
    await expect(userService.setSidekickRecommendation(workstreamId, AUTOMATION_ID, true, address.substreamId,
      { ...input, substreamId: address.substreamId, backgroundAgent: true })).rejects.toMatchObject({
      status: 403, code: 'sidekick_attachment_execution_forbidden',
    });
    expect(await parent.recommendedSidekickIds({ workspaceId: WORKSPACE_ID, parentId: workstreamId })).toEqual([]);
  });
  it("publishes through the authoring conversation and completes with a durable final reply", async () => {
    await createDraft();
    const root = childStub("0");
    submitDraftOnNextTurn = true;
    const sent = await root.fetch("https://object.test/internal/product", {
      method: "POST", headers: { "content-type": "application/json" },
      // `parentKind` as the Worker sends it: this conversation belongs to the
      // Sidekick, and a product request that claimed a Channel is refused.
      body: JSON.stringify({ operation: "create_message", parentKind: "automation", auth: {
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
    // The icon and colour the chat chose are the Sidekick's own, not the draft's.
    expect(JSON.parse(await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ appearance_json: string }>(
      `SELECT appearance_json FROM automation_directory WHERE automation_id = '${AUTOMATION_ID}'`,
    ).one().appearance_json))).toEqual({ icon: "lightbulb", color: "emerald" });
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
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    const detail = await runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickReadDetail({ ...addressed(), actor: actor() }));
    expect(detail.loadable).toBe(true);
    expect(detail.emailAddress).toBeNull();
    expect(detail.acceptedDefinitionRevision).toBe(1);
    expect(await workspaceStub().sidekickAdmitExternalEvent({ ...addressed(), registrationId: "00000000-0000-7000-8000-00000000ad51", payloadHash: `sha256:${"a".repeat(64)}`, event: {
      id: "00000000-0000-7000-8000-00000000ad52", eventSequence: 42, eventType: "slack.message.posted", title: "Stale trigger", summary: "An earlier registration delivered late", textSnippet: "hello", metadata: {}, occurredAt: Date.parse(NOW), audienceUserIds: [], audienceKind: "workspace",
    } })).toEqual({ admitted: false, outcomeCode: "sidekick_trigger_removed" });
    await expect(runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "instruction-only" }))).rejects.toThrow("Use this Sidekick in a conversation");
    const source = await workspaceStub().sidekickReadSkillSource({ ...addressed(), principalUserId: AUTHOR_ID, conversationParentId: AUTOMATION_ID, audienceScope: "personal", audienceUserIds: [AUTHOR_ID] });
    expect(source?.instructions).toBe("Use short sentences.");
    await workspaceStub().sidekickSubmitDefinition({ ...addressed(), draft: { ...draft, ready: false, triggers: [{ type: "manual" }] }, evaluatorRules: null, submittedByRunId: null });
    expect((await runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickReadDetail({ ...addressed(), actor: actor() }))).loadable).toBe(true);
    await workspaceStub().sidekickPause({ ...addressed(), actor: actor() });
    expect((await runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickReadDetail({ ...addressed(), actor: actor() }))).loadable).toBe(true);
  });

  it("keeps a person's pick when the chat repeats its own earlier appearance", async () => {
    await createDraft();
    const draft = { ...DEFINITION, definitionVersion: 2 as const, triggers: [] };
    const save = (appearance: { icon: "lightbulb" | "rocket"; color: "emerald" | "red" | "blue" }) => workspaceStub().sidekickSaveDefinition({
      ...addressed(), draft, evaluatorRules: null, submittedByRunId: null, appearance, actor: actor(),
    });
    const stored = async () => JSON.parse((await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ appearance_json: string }>(
      `SELECT appearance_json FROM automation_directory WHERE automation_id = '${AUTOMATION_ID}'`,
    ).one().appearance_json)));
    await save({ icon: "lightbulb", color: "emerald" });
    expect(await stored()).toEqual({ icon: "lightbulb", color: "emerald" });
    await workspaceStub().sidekickSetAppearance({ ...addressed(), actor: actor(), appearance: { color: "red" } });
    // "Also run it on Fridays": the chat copies its earlier call.
    await save({ icon: "lightbulb", color: "emerald" });
    expect(await stored()).toEqual({ icon: "lightbulb", color: "red" });
    // A value it has not submitted before is a choice, and is written.
    await save({ icon: "rocket", color: "blue" });
    expect(await stored()).toEqual({ icon: "rocket", color: "blue" });
  });

  it("keeps a retired colour the Sidekick already wears, and refuses it as a new choice", async () => {
    await createDraft();
    const draft = { ...DEFINITION, definitionVersion: 2 as const, triggers: [] };
    const storedAppearance = () => runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ appearance_json: string | null }>(
      `SELECT appearance_json FROM automation_directory WHERE automation_id = '${AUTOMATION_ID}'`,
    ).one().appearance_json);
    const refused = await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft, evaluatorRules: null, submittedByRunId: null,
      appearance: { icon: "folder", color: "teal" }, actor: actor() }).then(() => null, (error: unknown) => error);
    expect((refused as Error).message).toContain("color teal is kept only when it is the Sidekick's current color");
    expect(await storedAppearance()).toBeNull();
    await workspaceStub().sidekickSetAppearance({ ...addressed(), actor: actor(), appearance: { icon: "folder", color: "teal" } });
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: { ...draft, name: "Edited" }, evaluatorRules: null, submittedByRunId: null,
      appearance: { icon: "folder", color: "teal" }, actor: actor() });
    expect(JSON.parse((await storedAppearance())!)).toEqual({ icon: "folder", color: "teal" });
  });

  it("keeps a retired icon the Sidekick already wears, and refuses it as a new choice", async () => {
    await createDraft();
    const draft = { ...DEFINITION, definitionVersion: 2 as const, triggers: [] };
    const storedAppearance = () => runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ appearance_json: string | null }>(
      `SELECT appearance_json FROM automation_directory WHERE automation_id = '${AUTOMATION_ID}'`,
    ).one().appearance_json);
    const refused = await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft, evaluatorRules: null, submittedByRunId: null,
      appearance: { icon: "workflow", color: "blue" }, actor: actor() }).then(() => null, (error: unknown) => error);
    expect((refused as Error).message).toContain("icon workflow is kept only when it is the Sidekick's current icon");
    expect(await storedAppearance()).toBeNull();
    await workspaceStub().sidekickSetAppearance({ ...addressed(), actor: actor(), appearance: { icon: "workflow", color: "blue" } });
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: { ...draft, name: "Edited" }, evaluatorRules: null, submittedByRunId: null,
      appearance: { icon: "workflow", color: "blue" }, actor: actor() });
    expect(JSON.parse((await storedAppearance())!)).toEqual({ icon: "workflow", color: "blue" });
  });

  it("hides disabled email while retaining its permanent address", async () => {
    await createDraft();
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: DEFINITION, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    const before = await runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickReadDetail({ ...addressed(), actor: actor() }));
    expect(before.emailAddress).toBeTruthy();
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: { ...DEFINITION, definitionVersion: 2, triggers: [] }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    expect((await runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickReadDetail({ ...addressed(), actor: actor() }))).emailAddress).toBeNull();
    expect(await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ email_address: string }>(`SELECT email_address FROM automation_directory WHERE automation_id = '${AUTOMATION_ID}'`).one().email_address)).toBe(before.emailAddress);
  });

  it("reads stored loadability independently of trigger count and contains personal instructions", async () => {
    await createDraft();
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: { ...DEFINITION, definitionVersion: 2, triggers: [] }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    const request = { ...addressed(), principalUserId: AUTHOR_ID, conversationParentId: AUTOMATION_ID, audienceScope: "personal" as const, audienceUserIds: [AUTHOR_ID] };
    expect(await workspaceStub().sidekickReadSkillSource({ ...request, audienceUserIds: [AUTHOR_ID, OUTSIDER_ID] })).toBeNull();
    expect(await workspaceStub().sidekickReadSkillSummary({ ...request,audienceUserIds:[AUTHOR_ID,OUTSIDER_ID] })).toBeNull();
    expect(await workspaceStub().sidekickReadSkillSummary(request)).toEqual({ id:AUTOMATION_ID,name:DEFINITION.name,description:DEFINITION.description,available:true });
    await runInDurableObject(workspaceStub(), (_instance, state) => { state.storage.sql.exec(`UPDATE automation_directory SET loadable = 0 WHERE automation_id = '${AUTOMATION_ID}'`); });
    expect(await workspaceStub().sidekickReadSkillSource(request)).toBeNull();
    expect(await workspaceStub().sidekickReadSkillSummary(request)).toMatchObject({ id:AUTOMATION_ID,available:false });
    await runInDurableObject(workspaceStub(), (_instance, state) => { state.storage.sql.exec(`UPDATE automation_directory SET loadable = 1 WHERE automation_id = '${AUTOMATION_ID}'`); });
    expect((await workspaceStub().sidekickReadSkillSource(request))?.loadable).toBe(true);
  });

  it("retries a refused memory-table step from its stored entry, without another submission", async () => {
    const declared = [{
      name: "Deploys", description: "One row per deploy.", usageInstructions: "Insert a row per deploy.",
      columns: [{ name: "service", description: "The service.", type: "string", required: true, searchable: true }],
      keyColumns: ["service"],
    }] as AutomationDraft["memoryTables"];
    await createDraft();
    // The Organization's memory-table write refuses once, the way a storage
    // hiccup would after the publish has committed.
    await runInDurableObject(workspaceStub(), (instance) => {
      const target = instance as unknown as { createMemoryTable: (...args: unknown[]) => Promise<unknown>; refusedMemoryWrites?: number };
      const original = target.createMemoryTable.bind(target);
      target.createMemoryTable = async () => {
        target.createMemoryTable = original;
        target.refusedMemoryWrites = (target.refusedMemoryWrites ?? 0) + 1;
        throw new Error("memory_table_write_interrupted");
      };
    });
    await submit({ ...DEFINITION, memoryTables: declared });
    expect((await apply()).acceptedDefinitionRevision).toBe(1);
    // Apply's own attempt reached the write and was refused.
    expect(await runInDurableObject(workspaceStub(), (instance) =>
      (instance as unknown as { refusedMemoryWrites?: number }).refusedMemoryWrites)).toBe(1);

    // The stored entry finishes the job on the Organization's alarm, with no
    // second submission or apply, and then leaves.
    const tables = () => runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ name: string }>(
      `SELECT t.name FROM memory_tables t JOIN memory_scopes s ON s.memory_scope_id = t.memory_scope_id
        WHERE s.owner_id = ? AND t.invalidated_at IS NULL`, AUTOMATION_ID,
    ).toArray().map((row) => row.name));
    await runDurableObjectAlarm(workspaceStub());
    await expect.poll(tables, { timeout: RUN_SETTLE_TIMEOUT_MS }).toEqual(["Deploys"]);
    await expect.poll(async () => (await alarms()).map((alarm) => alarm.kind)).not.toContain(SIDEKICK_MEMORY_TABLES_ALARM_KIND);
  });

  it("reconciles stored policy and republishes discovery without accepting a caller boolean", async () => {
    await createDraft();
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: { ...DEFINITION, definitionVersion: 2, triggers: [] }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec(`UPDATE automation_directory SET loadable = 0 WHERE automation_id = '${AUTOMATION_ID}'`));
    await workspaceStub().sidekickReconcileLoadable({ ...addressed(), actor: actor() });
    expect(await workspaceStub().sidekickSkillCandidates({ workspaceId: WORKSPACE_ID })).toContain(AUTOMATION_ID);
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: { ...DEFINITION, definitionVersion: 2 }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec(`UPDATE automation_directory SET loadable = 1 WHERE automation_id = '${AUTOMATION_ID}'`));
    const source = await workspaceStub().sidekickReadSkillSource({ ...addressed(), principalUserId: AUTHOR_ID, conversationParentId: AUTOMATION_ID, audienceScope: "personal", audienceUserIds: [AUTHOR_ID] });
    expect(source?.loadable).toBe(true);
    expect(await workspaceStub().sidekickReconcileLoadable({ ...addressed(), actor: actor() })).toEqual({ loadable: false });
    expect(await workspaceStub().sidekickSkillCandidates({ workspaceId: WORKSPACE_ID })).not.toContain(AUTOMATION_ID);
  });

  it("attaches a loaded main-stream Sidekick and pins the latest revision for later executions", async () => {
    await createDraft();
    const draft: AutomationDraft = { ...DEFINITION, definitionVersion: 2, triggers: [], instructions: "First accepted Sidekick instructions." };
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    const earlierId = asAutomationId("00000000-0000-7000-8000-000000000001");
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "personal", owningWorkstreamId: null, automationId: earlierId });
    await workspaceStub().sidekickSaveDefinition({ workspaceId: WORKSPACE_ID, automationId: earlierId, draft, evaluatorRules: null, submittedByRunId: null, actor: actor() });
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-00000000ad99");
    await hostedParentStub(env, WORKSPACE_ID).reserveChild({
      workspaceId: WORKSPACE_ID, parentId: workstreamId, substreamId: asSubstreamId("0"), kind: "main",
      createdByUserId: AUTHOR_ID, authorityGeneration: 1,
      directory: { title: "Use knowledge", description: "", scope: "personal", systemKind: null, emailAddress: null, titleStatus: "settled", createdAt: NOW },
    });
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
    // Simulate aliases persisted before reusable instructions used skill terms.
    // A later run projects them without rewriting identities or attachments.
    await runInDurableObject(root, (_instance, state) => state.storage.sql.exec(
      `UPDATE sidekick_skill_names SET name = replace(name, 'skill-', 'sidekick-')`,
    ));
    await workspaceStub().sidekickRemove({ workspaceId: WORKSPACE_ID, automationId: earlierId, actor: actor() });
    await evictDurableObject(root);
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: { ...draft, name: "Updated helper", instructions: "Second accepted Sidekick instructions." }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
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
      && promptText(message.content).includes('name="skill-manual-helper-2"'))),
    { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(true);
    expect(await root.sidekickAttachments({ workspaceId: WORKSPACE_ID, workstreamId, removeId: AUTOMATION_ID })).toEqual([]);
  });

  it("keeps the connector tables out of regional D1, which is what makes the binding tests evidence", async () => {
    await expect(env.DB.prepare(`SELECT id FROM connector_connections LIMIT 1`).all())
      .rejects.toThrow(/no such table: connector_connections/u);
  });

  it.each(["plugin_mcp_rally_engineering_3", "plugin_custom_mcp_3"])(
    "binds a named MCP connection through %s and keeps self-consent separate from rebinding",
    async (pluginId) => {
      const customMcpConnectionId = "00000000-0000-7000-8000-00000000ad42";
      await runInDurableObject(workspaceStub(), (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO connector_connections
            (id, workspace_id, connector_type, scope, display_name, granted_scopes_json,
             status, cursor_json, config_json, created_at, updated_at, model_plugin_id)
           VALUES (?, ?, 'custom_mcp', 'workspace', 'Rally Engineering', '["custom_mcp.tools"]',
             'healthy', '{}', '{}', ?, ?, 'plugin_custom_mcp_3')`,
          customMcpConnectionId, WORKSPACE_ID, NOW, NOW,
        );
      });
      await createDraft();
      await submit({ ...DEFINITION,
        recommendedPlugins: [{ pluginId, recommendedTools: [], reason: "Inspect Rally" }],
      });
      expect(await apply()).toMatchObject({
        lifecycle: "active", connectorBindings: { [pluginId]: customMcpConnectionId },
      });
      // Self-consent preserves the configured source, including a stale one;
      // changing a source is a separate definition edit.
      await runInDurableObject(workspaceStub(), (_instance, state) => {
        state.storage.sql.exec(`UPDATE automation_directory SET connector_bindings_json = ? WHERE automation_id = ?`,
          JSON.stringify({ [pluginId]: "00000000-0000-7000-8000-00000000ad41" }), AUTOMATION_ID);
      });
      expect(await workspaceStub().sidekickClaimExecutionPrincipal({ ...addressed(), actor: actor() }))
        .toMatchObject({ reboundPluginIds: [], unboundProviders: [] });
      expect(JSON.parse((await automationRow()).connector_bindings_json!))
        .toEqual({ [pluginId]: "00000000-0000-7000-8000-00000000ad41" });
    },
  );

  it.each([
    { pluginIds: ["plugin_google_mail_calendar", "plugin_google_drive"], retained: ["gmail.read", "calendar.read", "drive.read", "docs.read", "sheets.read"] },
    { pluginIds: ["plugin_google"], retained: ["gmail.read", "calendar.read", "drive.read", "docs.read", "sheets.read"] },
    { pluginIds: ["plugin_google_mail_calendar"], retained: ["gmail.read", "calendar.read"] },
    { pluginIds: ["plugin_google_drive"], retained: ["drive.read", "docs.read", "sheets.read"] },
  ])("binds Google bundle IDs $pluginIds to their shared credential across grant changes", async ({ pluginIds, retained }) => {
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO connector_connections
          (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
           display_name, granted_scopes_json, status, cursor_json, config_json,
           created_at, updated_at, model_plugin_id)
         VALUES (?, ?, 'google', 'personal', ?, 'google-account', 'Google',
           '["gmail.read","calendar.read","drive.read","docs.read","sheets.read"]',
           'healthy', '{}', '{}', ?, ?, 'plugin_google')`,
        SLACK_CONNECTION_ID, WORKSPACE_ID, AUTHOR_ID, NOW, NOW,
      );
    });
    await createDraft();
    const definition = { ...DEFINITION,
      recommendedPlugins: pluginIds.map((pluginId) => ({ pluginId, recommendedTools: [], reason: "Needed" })),
    };
    await submit(definition);
    const detail = await apply();
    expect(detail).toMatchObject({
      lifecycle: "active",
      connectorBindings: Object.fromEntries(pluginIds.map((pluginId) => [pluginId, SLACK_CONNECTION_ID])),
    });
    expect(JSON.parse((await automationRow()).connector_bindings_json ?? "null"))
      .toEqual(Object.fromEntries(pluginIds.map((pluginId) => [pluginId, SLACK_CONNECTION_ID])));
    await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec(
      `UPDATE connector_connections SET granted_scopes_json = ? WHERE id = ?`, JSON.stringify(retained), SLACK_CONNECTION_ID,
    ));
    await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: definition, evaluatorRules: null,
      submittedByRunId: null, actor: actor() });
    expect(await workspaceStub().sidekickReadDetail({ ...addressed(), actor: actor() })).toMatchObject({
      acceptedDefinitionRevision: 2, connectorBindings: Object.fromEntries(pluginIds.map((id) => [id, SLACK_CONNECTION_ID])),
    });
    const replacementId = "00000000-0000-7000-8000-00000000ad06";
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE connector_connections SET status = 'disabled' WHERE id = ?`, SLACK_CONNECTION_ID);
      state.storage.sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, granted_scopes_json, status, cursor_json, config_json, created_at, updated_at, model_plugin_id)
        SELECT ?, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, granted_scopes_json, 'healthy', cursor_json, config_json, created_at, updated_at, model_plugin_id
         FROM connector_connections WHERE id = ?`, replacementId, SLACK_CONNECTION_ID);
    });
    const claim = await workspaceStub().sidekickClaimExecutionPrincipal({ ...addressed(), actor: actor() });
    expect(claim).toMatchObject({ reboundPluginIds: [], unboundProviders: [] });
    expect(JSON.parse((await automationRow()).connector_bindings_json ?? "null"))
      .toEqual(Object.fromEntries(pluginIds.map((pluginId) => [pluginId, SLACK_CONNECTION_ID])));
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
    expect(JSON.parse(row.connector_bindings_json ?? "null")).toEqual({ plugin_slack: SLACK_CONNECTION_ID });
    expect(row.effective_after_event_sequence).toBe(0);
    // The sidebar reads this same row; there is no copy to publish.
    expect(await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ lifecycle: string; title: string }>(
      `SELECT lifecycle, title FROM automation_directory WHERE automation_id = ?`, AUTOMATION_ID,
    ).one())).toEqual({ lifecycle: "active", title: "Manual helper" });
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
            kind: "matching" as const,
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
    const submitted = await workspaceStub().sidekickSubmitDefinition({
      ...addressed(),
      draft: WEBHOOK_DEFINITION,
      // Parsed the way the drafting tool parses it, so this exercises the
      // boundary rather than hand-writing its output: the rules are authored in
      // the model's spelling and reach the object in the stored one.
      evaluatorRules: AutomationSetEvaluatorRulesModelInputV1Schema.parse(rules),
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
    expect(await workspaceStub().sidekickAdmitExternalEvent({
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
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "pause-run-0001" });
    expect(started.reused).toBe(false);
    // The registrations WorkspaceDO holds for this destination are the
    // accepted set, replaced whole; a pause replaces it with nothing.
    // Written by the same writer apply uses, inside the Organization object.
    await runInDurableObject(workspaceStub(), (instance, state) => {
      const writer = instance as unknown as { writeSidekickRegistrations: (id: string, evaluators: unknown[]) => number };
      state.storage.transactionSync(() => writer.writeSidekickRegistrations(AUTOMATION_ID, [{
        evaluatorId: "00000000-0000-7000-8000-00000000ad40",
        source: { connectorType: "slack", connectionId: SLACK_CONNECTION_ID, eventType: "slack.message.posted" },
        when: { kind: "always" },
      }]));
    });
    expect(await activeRegistrations()).toBe(1);

    await workspaceStub().sidekickPause({ ...addressed(), actor: actor() });

    expect(await automationRow()).toMatchObject({ lifecycle: "paused", paused_by: "person" });
    expect(await workspaceStub().sidekickReadRunState({ ...addressed(), runId: started.runId }))
      .toMatchObject({ state: "stopped", lifecycle: "paused" });
    expect((await alarms()).filter((alarm) => (
      alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND || alarm.kind === AUTOMATION_RUN_ALARM_KIND
    ))).toEqual([]);
    expect(await activeRegistrations()).toBe(0);
    await expect(runInDurableObject(workspaceStub(), (instance: WorkspaceDO) =>
      instance.sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "pause-run-0002" })))
      .rejects.toThrow("Only an active Sidekick can run");

    // What a long pause leaves: the schedule's stored instant is in the past.
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE sidekick_schedules SET next_due_at = 1 WHERE sidekick_id = ?`, AUTOMATION_ID);
    });

    await workspaceStub().sidekickResume({ ...addressed(), actor: actor() });

    expect(await automationRow()).toMatchObject({ lifecycle: "active", paused_by: null });
    const rearmed = (await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND);
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]!.due_at).toBeGreaterThan(Date.now());
    // The schedule row moves with its entry, and the Sidekick's next run with it.
    expect(await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ next_due_at: number }>(
      `SELECT next_due_at FROM sidekick_schedules WHERE sidekick_id = ?`, AUTOMATION_ID,
    ).one().next_due_at)).toBe(rearmed[0]!.due_at);
    expect(await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ next_run_at: number }>(
      `SELECT next_run_at FROM automation_directory WHERE automation_id = ?`, AUTOMATION_ID,
    ).one().next_run_at)).toBe(rearmed[0]!.due_at);
    // A stopped run stays stopped: resuming re-arms the future, not the past.
    expect(await workspaceStub().sidekickReadRunState({ ...addressed(), runId: started.runId }))
      .toMatchObject({ state: "stopped", lifecycle: "active" });
  });

  it("keeps configured source bindings when an installed client records self-consent", async () => {
    await activeAutomation();
    await seedSlackConnection();
    // Bound to a connection that is gone; the plugin's live one is the Organization's.
    const foreign = "00000000-0000-7000-8000-00000000ad41";
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE automation_directory SET connector_bindings_json = ? WHERE automation_id = ?`,
        JSON.stringify({ plugin_slack: foreign }), AUTOMATION_ID,
      );
    });

    const claim = await workspaceStub().sidekickClaimExecutionPrincipal({ ...addressed(), actor: actor() });

    expect(claim).toMatchObject({ reboundPluginIds: [], unboundProviders: [] });
    expect(JSON.parse((await automationRow()).connector_bindings_json!)).toEqual({ plugin_slack: foreign });
  });

  it("does not substitute another person's personal source on an installed client's self-consent", async () => {
    await activeAutomation();
    // The plugin's only connection is another member's personal one, which
    // the claimant may neither use nor be handed as a replacement.
    const theirs = "00000000-0000-7000-8000-00000000ad42";
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO connector_connections
           (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
            display_name, granted_scopes_json, status, cursor_json, config_json,
            created_at, updated_at, model_plugin_id)
         VALUES (?, ?, 'slack', 'personal', ?, 'T0THEIRS', 'Theirs', '[]', 'healthy', '{}', '{}', ?, ?, 'plugin_slack')`,
        theirs, WORKSPACE_ID, OUTSIDER_ID, NOW, NOW,
      );
      state.storage.sql.exec(
        `UPDATE automation_directory SET connector_bindings_json = ? WHERE automation_id = ?`,
        JSON.stringify({ plugin_slack: theirs }), AUTOMATION_ID,
      );
    });

    const claim = await workspaceStub().sidekickClaimExecutionPrincipal({ ...addressed(), actor: actor() });

    expect(claim).toMatchObject({ reboundPluginIds: [], unboundProviders: [] });
    expect(JSON.parse((await automationRow()).connector_bindings_json!)).toEqual({ plugin_slack: theirs });
  });

  it("admits one run when its schedule's entry fires, and none while it is paused", async () => {
    await activeAutomation({
      ...DEFINITION,
      triggers: [{ type: "manual" }, { type: "interval", intervalSeconds: 3_600, summary: "Every hour" }],
    });
    // Bring the schedule and its entry due now, as the passing hour would.
    const due = async () => runInDurableObject(workspaceStub(), (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(`UPDATE sidekick_schedules SET next_due_at = ? WHERE sidekick_id = ?`, now - 1, AUTOMATION_ID);
      state.storage.sql.exec(
        `UPDATE _internal_durable_alarms SET due_at = ?, retry_at = 0 WHERE kind = ? AND substr(alarm_key, 1, ?) = ?`,
        now - 1, AUTOMATION_SCHEDULE_ALARM_KIND, `${AUTOMATION_ID}:`.length, `${AUTOMATION_ID}:`,
      );
    });
    const scheduledRuns = async () => runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sidekick_runs WHERE sidekick_id = ? AND json_extract(trigger_json, '$.kind') = 'schedule'`,
      AUTOMATION_ID,
    ).one().count);

    await due();
    await runDurableObjectAlarm(workspaceStub());
    expect(await scheduledRuns()).toBe(1);

    // A paused Sidekick's schedule row is still there, but it fires nothing.
    await workspaceStub().sidekickPause({ ...addressed(), actor: actor() });
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO _internal_durable_alarms (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json, created_at, updated_at)
         SELECT ?, ? || ':' || schedule_id, ?, NULL, 0, 0, NULL, ?, ? FROM sidekick_schedules WHERE sidekick_id = ?`,
        AUTOMATION_SCHEDULE_ALARM_KIND, AUTOMATION_ID, Date.now() - 1, Date.now(), Date.now(), AUTOMATION_ID,
      );
    });
    await due();
    await runDurableObjectAlarm(workspaceStub());
    expect(await scheduledRuns()).toBe(1);
  });

  it("removes: tombstones the row, reports archived, and is gone from the sidebar", async () => {
    await activeAutomation();
    expect((await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID }))
      .items.map((item) => item.id)).toEqual([AUTOMATION_ID]);

    await workspaceStub().sidekickRemove({ ...addressed(), actor: actor() });

    expect((await automationRow()).lifecycle).toBe("deleted");
    expect(await workspaceStub().authority({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: true });
    expect(await workspaceStub().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, userId: AUTHOR_ID }))
      .toEqual({ authorized: false, archived: true });
    expect((await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID })).items)
      .toEqual([]);
    await expect(runInDurableObject(workspaceStub(), (instance: WorkspaceDO) =>
      instance.sidekickReadDetail({ ...addressed(), actor: actor() }))).rejects.toThrow("This Sidekick was archived");
  });

  it("refuses management by a member who is neither author nor principal", async () => {
    await activeAutomation();
    await expect(runInDurableObject(workspaceStub(), (instance: WorkspaceDO) =>
      instance.sidekickPause({ ...addressed(), actor: actor(OUTSIDER_ID) }))).rejects.toThrow("You cannot manage this Sidekick");
    expect((await automationRow()).lifecycle).toBe("active");
  });

  it("leaves nothing applied when a registration is refused, and names why", async () => {
    await seedSlackConnection();
    await createDraft();
    await submit({
      ...DEFINITION,
      triggers: [{ type: "manual" }, { type: "interval", intervalSeconds: 3_600, summary: "Every hour" }],
      recommendedPlugins: [{ pluginId: "plugin_slack", recommendedTools: [], reason: "Needed" }],
    });
    // The registration write refuses inside apply's transaction, the way a
    // registration that fails its own schema would.
    await runInDurableObject(workspaceStub(), (instance) => {
      const target = instance as unknown as { writeSidekickRegistrations: (...args: unknown[]) => number };
      const original = target.writeSidekickRegistrations.bind(target);
      target.writeSidekickRegistrations = () => {
        target.writeSidekickRegistrations = original;
        throw new Error("sidekick_registration_invalid:evaluators.0.source");
      };
    });
    await expect(apply()).rejects.toThrow("sidekick_registration_invalid:evaluators.0.source");
    expect(await automationRow()).toMatchObject({ lifecycle: "draft", accepted_definition_revision: null });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND)).toEqual([]);
    expect(await activeRegistrations()).toBe(0);

    // Nothing half-applied stands in the way of the next attempt.
    expect((await apply()).lifecycle).toBe("active");
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND)).toHaveLength(1);
  });

  it("saves edits while preserving a person pause", async () => {
    await activeAutomation();
    await workspaceStub().sidekickPause({ ...addressed(), actor: actor() });
    const revised = await submit({ ...DEFINITION, instructions: "Say hello twice." });
    expect(revised.definitionRevision).toBe(2);

    // Applying used to write `lifecycle = 'active', paused_by = NULL` with no
    // look at why the automation was paused, which resumed a room-archived
    // automation past the refusal `resume` gives, with its schedules armed
    // and its connector writes back, into a room it could not post to.
    await apply();
    expect(await automationRow()).toMatchObject({ lifecycle: "paused", paused_by: "person", accepted_definition_revision: 2 });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND)).toHaveLength(0);

    await workspaceStub().sidekickResume({ ...addressed(), actor: actor() });
    await apply();
    expect(await automationRow()).toMatchObject({ lifecycle: "active", accepted_definition_revision: 2 });
  });

  it("archives an owned Sidekick with its runs and triggers, retains its history, and never restores it with the room", async () => {
    const roomId = "00000000-0000-7000-8000-00000000ad80";
    await createDraft(roomId);
    await submit({ ...DEFINITION, triggers: [{ type: "manual" }, { type: "interval", intervalSeconds: 3_600, summary: "Every hour" }] });
    await apply();
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "archive-owned-run" });
    await runInDurableObject(workspaceStub(), (instance, state) => {
      const writer = instance as unknown as { writeSidekickRegistrations: (id: string, evaluators: unknown[]) => number };
      state.storage.transactionSync(() => writer.writeSidekickRegistrations(AUTOMATION_ID, [{
        evaluatorId: "00000000-0000-7000-8000-00000000ad40",
        source: { connectorType: "slack", connectionId: SLACK_CONNECTION_ID, eventType: "slack.message.posted" },
        when: { kind: "always" },
      }]));
    });
    expect(await activeRegistrations()).toBe(1);
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND)).toHaveLength(1);

    const archive = (archived: boolean) => runInDurableObject(workspaceStub(), (instance, state) => {
      const host = (instance as unknown as { hostedSidekickHost: () => HostedSidekickHost }).hostedSidekickHost();
      return state.storage.transactionSync(() => new HostedSidekick(host, AUTOMATION_ID)
        .setOwningRoomArchived({ ...addressed(), workstreamId: roomId, archived }, Date.now()));
    });
    expect(await archive(true)).toEqual({ changed: true, outcomeCode: "sidekick_archived" });
    expect(await automationRow()).toMatchObject({ lifecycle: "deleted", paused_by: null, accepted_definition_revision: 1 });
    expect(await workspaceStub().sidekickReadRunState({ ...addressed(), runId: started.runId }))
      .toMatchObject({ state: "stopped", lifecycle: "deleted" });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND || alarm.kind === AUTOMATION_RUN_ALARM_KIND))
      .toEqual([]);
    expect(await activeRegistrations()).toBe(0);
    await expect(runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickSubmitDefinition({
      ...addressed(), draft: DEFINITION, evaluatorRules: null, submittedByRunId: null,
    }))).rejects.toThrow("This Sidekick was archived");
    await expect(apply()).rejects.toMatchObject({ code: "sidekick_not_found" });

    expect(await archive(true)).toEqual({ changed: false, outcomeCode: "sidekick_already_archived" });
    expect(await archive(false)).toEqual({ changed: false, outcomeCode: "sidekick_already_archived" });
    expect((await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID })).items).toEqual([]);
    expect(await workspaceStub().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, userId: AUTHOR_ID }))
      .toEqual({ authorized: false, archived: true });
  });

  it.each(["pause", "resume"] as const)("does not resurrect a Sidekick archived during %s authorization", async (operation) => {
    const roomId = "00000000-0000-7000-8000-00000000ad80";
    await createDraft(roomId);
    await submit();
    await apply();
    if (operation === "resume") await workspaceStub().sidekickPause({ ...addressed(), actor: actor() });
    await runInDurableObject(workspaceStub(), async (instance, state) => {
      const host = (instance as unknown as { hostedSidekickHost: () => HostedSidekickHost }).hostedSidekickHost();
      const sidekick = new HostedSidekick(host, AUTOMATION_ID);
      const pending = sidekick[operation]({ ...addressed(), actor: actor() });
      state.storage.transactionSync(() => sidekick.setOwningRoomArchived({ ...addressed(), workstreamId: roomId, archived: true }, Date.now()));
      await expect(pending).rejects.toMatchObject({ code: "sidekick_not_found" });
    });
    expect(await automationRow()).toMatchObject({ lifecycle: "deleted", paused_by: null });
    expect(await workspaceStub().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, userId: AUTHOR_ID }))
      .toEqual({ authorized: false, archived: true });
  });

  it.each(["room_archive", "person", "draft"] as const)("archives a legacy %s Sidekick when its room is restored", async (stateBeforeRestore) => {
    const roomId = "00000000-0000-7000-8000-00000000ad80";
    await createDraft(roomId);
    if (stateBeforeRestore !== "draft") {
      await submit();
      await apply();
      await workspaceStub().sidekickPause({ ...addressed(), actor: actor() });
    }
    await runInDurableObject(workspaceStub(), (instance, state) => {
      // Historical state written before room archival became terminal.
      state.storage.sql.exec(`UPDATE automation_directory SET owning_room_archived_at = 1000, paused_by = ? WHERE automation_id = ?`,
        stateBeforeRestore === "draft" ? null : stateBeforeRestore, AUTOMATION_ID);
      const host = (instance as unknown as { hostedSidekickHost: () => HostedSidekickHost }).hostedSidekickHost();
      expect(state.storage.transactionSync(() => new HostedSidekick(host, AUTOMATION_ID)
        .setOwningRoomArchived({ ...addressed(), workstreamId: roomId, archived: false }, Date.now())))
        .toEqual({ changed: true, outcomeCode: "sidekick_archived" });
      expect(state.storage.sql.exec(`SELECT owning_room_archived_at FROM automation_directory WHERE automation_id = ?`, AUTOMATION_ID).one())
        .toEqual({ owning_room_archived_at: 1000 });
    });
    expect(await automationRow()).toMatchObject({ lifecycle: "deleted", paused_by: null });
    await expect(runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickResume({ ...addressed(), actor: actor() })))
      .rejects.toMatchObject({ code: "sidekick_not_found" });
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
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "tables-run-01" });
    await settledChildRun(started.runId);
    const systemPrompt = promptText(provider.calls[0]!.messages[0]?.content);
    expect(systemPrompt).toContain("\"Deploys\"");
    expect(systemPrompt).toContain("\"Rollbacks\"");
    expect(systemPrompt).toContain("rollbackId");
  });

  it("arms the run alarm again for a pending run whose admission is retried", async () => {
    await activeAutomation();
    const first = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "rearm-key-0001" });
    // The row commits before the alarm is armed. A retry after a failure
    // between the two found the row and returned `reused` with nothing armed,
    // so the run stayed pending forever: nothing else ever provisions it.
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM _internal_durable_alarms WHERE kind = ?`, AUTOMATION_RUN_ALARM_KIND);
    });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_RUN_ALARM_KIND)).toHaveLength(0);

    const again = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "rearm-key-0001" });

    expect(again).toEqual({ runId: first.runId, reused: true });
    expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_RUN_ALARM_KIND)).toHaveLength(1);
    const run = await settledChildRun(first.runId);
    expect(run).toMatchObject({ status: "completed" });
  });

  it("lets the Sidekick's author open its conversation and refuses an outsider", async () => {
    await activeAutomation();
    const authorization = new AuthorizationService(TEST_ENV);
    expect(await authorization.checkMany({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, delegation: null },
      [{ kind: "conversation", workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, substreamId: asSubstreamId("0") }]))
      .toMatchObject([{ status: "allowed" }]);
    expect(await authorization.checkMany({ workspaceId: WORKSPACE_ID, userId: OUTSIDER_ID, delegation: null },
      [{ kind: "conversation", workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, substreamId: asSubstreamId("0") }]))
      .toMatchObject([{ status: "denied" }]);
  });

  it("asks for a started run's provisioning again later, until the run reports in", async () => {
    await activeAutomation();
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "resend-run-01" });
    // The run alarm hands the run on; nothing consumes the Queue here, so no
    // report comes back. The object's own alarm may already be running the
    // entry, which `runDurableObjectAlarm` does not wait for, so the wait is
    // for the entry to move.
    const before = Date.now();
    await runDurableObjectAlarm(workspaceStub());
    // Well under the 30-second test budget.
    await expect.poll(async () => (await alarms())
      .find((alarm) => alarm.kind === AUTOMATION_RUN_ALARM_KIND && alarm.alarm_key === started.runId)?.due_at,
    { timeout: 10_000 }).toBeGreaterThan(before);
    expect(await workspaceStub().sidekickReadRunState({ ...addressed(), runId: started.runId })).toMatchObject({ state: "pending" });
  });

  it("arms no resend for a run that reported in while its message was being sent", async () => {
    await activeAutomation();
    // The consumer runs before the send returns, the way a fast Queue
    // delivery can, so the report lands while the alarm is still awaiting.
    type QueueSend = { send: (body: unknown, options?: QueueSendOptions) => Promise<void> };
    const prototype = Object.getPrototypeOf(TEST_ENV.ACTIVITY_QUEUE) as QueueSend;
    const original = prototype.send;
    const send = vi.spyOn(prototype, "send").mockImplementation(async function (this: QueueSend, body, options) {
      const provision = SidekickRunProvisionQueueMessageSchema.safeParse(body);
      if (provision.success) return provisionSidekickRun(TEST_ENV, provision.data);
      return original.call(this, body, options);
    });
    try {
      const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "resend-run-02" });
      await runDurableObjectAlarm(workspaceStub());
      await expect.poll(async () => (await workspaceStub().sidekickReadRunState({ ...addressed(), runId: started.runId }))?.state)
        .not.toBe("pending");
      expect((await alarms()).filter((alarm) => alarm.kind === AUTOMATION_RUN_ALARM_KIND && alarm.alarm_key === started.runId))
        .toEqual([]);
    } finally {
      send.mockRestore();
    }
  });

  it("pauses one Sidekick without touching another's pending run", async () => {
    await activeAutomation();
    const otherId = asAutomationId(AUTOMATION_ID.replace(/ad0$/u, "ad9"));
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "personal", owningWorkstreamId: null, automationId: otherId, creatorConsent: { requestId: otherId } });
    const other = { workspaceId: WORKSPACE_ID, automationId: otherId };
    await workspaceStub().sidekickSubmitDefinition({ ...other, draft: DEFINITION, evaluatorRules: null, submittedByRunId: null });
    await runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickApply({ ...other, actor: actor() }));
    const started = await workspaceStub().sidekickRunNow({ ...other, actor: actor(), idempotencyKey: "isolated-run-01" });

    await workspaceStub().sidekickPause({ ...addressed(), actor: actor() });

    expect(await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ kind: string }>(
      `SELECT kind FROM _internal_durable_alarms WHERE kind = ? AND alarm_key = ?`,
      AUTOMATION_RUN_ALARM_KIND, `${otherId}:${started.runId}`,
    ).toArray())).toHaveLength(1);
    expect(await workspaceStub().sidekickReadRunState({ ...other, runId: started.runId })).toMatchObject({ state: "pending", lifecycle: "active" });
  });

  it("provisions the conversation on a replayed create, so a first call that died after the row is repaired", async () => {
    // The object's row commits first; a first call that failed between it
    // and the conversation's provisioning used to answer `created: false`
    // forever after and skip both, leaving an automation nobody could open.
    // Room drafting reaches this directly: its automation id is the stable
    // harness run id, so the retry is the same call again.
    const authority = await readWorkstreamAuthorityControl(TEST_ENV);
    expect(await workspaceStub().sidekickCreate({
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
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "attach-run-01" });
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
    const first = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "manual-key-0001" });
    const again = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "manual-key-0001" });
    const other = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "manual-key-0002" });

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

    expect(await workspaceStub().sidekickAdmitExternalEvent({ ...admission, event }))
      .toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_admitted" });
    expect(await workspaceStub().sidekickAdmitExternalEvent({ ...admission, event }))
      .toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_replayed" });
    expect(await workspaceStub().sidekickAdmitExternalEvent({
      ...admission,
      event: { ...event, id: earlierEventId, eventSequence: 1 },
    })).toEqual({ admitted: false, outcomeCode: "sidekick_event_before_activation_boundary" });
    expect((await runRows()).map((run) => run.occurrence_key)).toEqual([`external:${event.id}`]);
    // The run gets to read the event that woke it: without this it knew only
    // the event's type, and a rule on `channel` produced a run that could not
    // name the channel.
    const [admittedRun] = await runRows();
    const opening = await runInDurableObject(workspaceStub(), (_instance, state) =>
      state.storage.sql.exec<{ opening_json: string | null }>(
        `SELECT opening_json FROM sidekick_runs WHERE sidekick_id = ? AND run_id = ?`, AUTOMATION_ID, admittedRun!.run_id,
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

  it("admits two deliveries for one occurrence once, when the connector names it", async () => {
    // A Granola note reaches the workspace as `note.access_granted` when it
    // is shared and as `note.generated` when its summary is written, in
    // either order; the connector keys both on the note and the Sidekick runs
    // for the note once. An event that names no key admits on its id, in a
    // key space a named one cannot reach.
    await seedSlackConnection();
    await createDraft();
    await submit();
    await apply();
    const base = {
      eventType: "slack.message.posted",
      title: "New message",
      summary: "",
      textSnippet: "",
      occurredAt: Date.parse(NOW),
      audienceUserIds: [],
      audienceKind: "workspace" as const,
    };
    const admission = {
      ...addressed(),
      registrationId: "00000000-0000-7000-8000-00000000ad61",
      payloadHash: `sha256:${"b".repeat(64)}`,
    };
    const occurrenceKey = "granola:connection:note:not_1234567890abcd:transcript";
    const shared = { ...base, id: "00000000-0000-7000-8000-00000000ad62", eventSequence: 2, metadata: {}, occurrenceKey };
    const generated = { ...base, id: "00000000-0000-7000-8000-00000000ad63", eventSequence: 3, metadata: {}, occurrenceKey };
    const unnamed = { ...base, id: "00000000-0000-7000-8000-00000000ad64", eventSequence: 4, metadata: { occurrenceKey } };

    expect(await workspaceStub().sidekickAdmitExternalEvent({ ...admission, event: shared }))
      .toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_admitted" });
    expect(await workspaceStub().sidekickAdmitExternalEvent({ ...admission, event: generated }))
      .toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_replayed" });
    expect(await workspaceStub().sidekickAdmitExternalEvent({ ...admission, event: unnamed }))
      .toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_admitted" });
    // Two runs admitted in the same millisecond have no order to assert.
    expect((await runRows()).map((run) => run.occurrence_key).sort()).toEqual([
      `external:${unnamed.id}`,
      `occurrence:${occurrenceKey}`,
    ].sort());
  });

  it("names the offending field when an admission is refused across the RPC boundary", async () => {
    // What the queue consumer is left holding. A `ZodError` thrown here was
    // reduced by the RPC serializer to a bare `Error` — no `issues`, no
    // message, not even the name — so the delivery consumer logged the
    // constant `external_event_delivery_failed` and retried until the Queue
    // gave up, and a rule-shape change was indistinguishable from an outage.
    // Only the message text crosses, so the path has to be in it.
    const rejection = await workspaceStub().sidekickAdmitExternalEvent({
      ...addressed(),
      registrationId: "00000000-0000-7000-8000-00000000ad51",
      payloadHash: `sha256:${"a".repeat(64)}`,
      event: { id: "00000000-0000-7000-8000-00000000ad52", eventSequence: "2" },
    } as never).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toContain("admit_external_event_invalid");
    expect(message).toContain("event.eventSequence");
  });

  it("names the offending field when a definition save is refused across the RPC boundary", async () => {
    // `saveDefinition` takes the actor beside the definition, so a sweep of
    // `.parse(input)` entry points missed its two parses; the service calls it
    // through a stub, where a `ZodError` arrived as the bare word.
    const rejection = await workspaceStub().sidekickSaveDefinition({
      ...addressed(),
      draft: { ...DEFINITION, definitionVersion: 2, triggers: "none" },
      evaluatorRules: null,
      submittedByRunId: null,
      actor: actor(),
    } as never).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toContain("save_definition_invalid");
    expect(message).toContain("draft.triggers");
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

    const admitted = await workspaceStub().sidekickAdmitInboundEmail(email);
    expect(admitted).toMatchObject({ admitted: true, duplicate: false, outcomeCode: "admitted" });
    expect(await workspaceStub().sidekickAdmitInboundEmail(email))
      .toEqual({ admitted: true, duplicate: true, outcomeCode: "admitted", runId: admitted.runId });
    expect(await workspaceStub().sidekickAdmitInboundEmail({
      ...email,
      resendEmailId: "resend-email-0002",
      senderUserId: OUTSIDER_ID,
    })).toEqual({ admitted: false, duplicate: false, outcomeCode: "email_sender_not_authorized", runId: null });
    expect(await workspaceStub().sidekickAdmitInboundEmail({
      ...email,
      resendEmailId: "resend-email-0003",
      emailAddress: "somebody-else@mail.rallywithai.com",
    })).toEqual({ admitted: false, duplicate: false, outcomeCode: "sidekick_email_route_mismatch", runId: null });
    expect((await runRows()).map((run) => run.occurrence_key)).toEqual(["inbound_email:resend-email-0001"]);
    const receipts = await runInDurableObject(workspaceStub(), (_instance, state) =>
      state.storage.sql.exec<{ resend_email_id: string; outcome_code: string }>(
        `SELECT resend_email_id, outcome_code FROM sidekick_email_receipts WHERE sidekick_id = ? ORDER BY resend_email_id`, AUTOMATION_ID,
      ).toArray());
    expect(receipts).toEqual([
      { resend_email_id: "resend-email-0001", outcome_code: "admitted" },
      { resend_email_id: "resend-email-0002", outcome_code: "email_sender_not_authorized" },
      { resend_email_id: "resend-email-0003", outcome_code: "sidekick_email_route_mismatch" },
    ]);
  });

  it("answers a run conversation's terminal deadline from its own projection, not a Channel's", async () => {
    await activeAutomation();
    const runId = "00000000-0000-7000-8000-00000000ad61";
    const effect = { kind: "directory_common", state: "running", nextTerminalActionAt: "2026-10-06T09:00:00.000Z" };
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO sidekick_child_projections (sidekick_id, substream_id, source_version, payload_hash, effect_json, updated_at)
         VALUES (?, ?, 1, 'hash', ?, ?)`,
        AUTOMATION_ID, runId, JSON.stringify(effect), Date.now(),
      );
    });
    expect(await workspaceStub().childTerminalDeadlines({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID }))
      .toEqual({ items: [{ substreamId: runId, nextTerminalActionAt: "2026-10-06T09:00:00.000Z" }] });
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
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "provision-run-01" });

    const run = await settledChildRun(started.runId);

    expect(run).toMatchObject({ status: "completed", error_json: null });
    expect(await workspaceStub().listChildren({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID }))
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
    expect(await workspaceStub().sidekickReadRunDefinition({ ...addressed(), runId: started.runId })).toMatchObject({
      definitionRevision: 2,
      runId: started.runId,
      state: "running",
      trigger: { kind: "manual", requestedByUserId: AUTHOR_ID },
    });

    // The child's own effects, through the real consumer, move the run row
    // forward and put the automation's sidebar row in the workspace.
    const delivered = await deliverChildEffects(TEST_ENV, childStub(started.runId));
    expect(delivered.some((envelope) => envelope.effect.kind === "directory_common")).toBe(true);
    expect(await workspaceStub().sidekickReadRunState({ ...addressed(), runId: started.runId }))
      .toMatchObject({ state: "completed", lifecycle: "active" });
    const listed = await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID });
    expect(listed.items.map((item) => [item.id, item.status])).toEqual([[AUTOMATION_ID, "active"]]);

    // A stale `running` from the same child, older than the completion the
    // parent holds, cannot reopen the run. A newer one can: that is input
    // continuing the run, which `sidekick-run-continuation.test.ts` covers.
    const latest = delivered
      .filter((envelope) => envelope.effect.kind === "directory_common")
      .reduce((newest, envelope) => envelope.sourceVersion > newest.sourceVersion ? envelope : newest);
    const latestEffect = latest.effect;
    if (latestEffect.kind !== "directory_common") throw new Error("expected the child's directory_common effect");
    const regressed = { ...latestEffect, state: "running" };
    const regression: ConversationEffectEnvelope = ConversationEffectEnvelopeSchema.parse({
      ...latest,
      messageId: `${latest.messageId}:regression`,
      sourceVersion: latest.sourceVersion - 1,
      effect: regressed,
      payloadHash: conversationEffectHash(regressed),
    });
    expect(await consumeEffectBodies(TEST_ENV, [regression])).toEqual({ acked: 1, retried: 0 });
    expect(await workspaceStub().sidekickReadRunState({ ...addressed(), runId: started.runId }))
      .toMatchObject({ state: "completed", lifecycle: "active" });

    // A message already received is answered by its receipt: the same bytes
    // again are accepted, different bytes under its id are refused.
    const changed = { ...latestEffect, preview: "Different bytes under the same message id" };
    const conflicting = ConversationEffectEnvelopeSchema.parse({
      ...latest, effect: changed, payloadHash: conversationEffectHash(changed),
    });
    // Asked inside the object: a rejection over the stub is reported a second
    // time as unhandled, which fails the run even when the assertion held.
    await runInDurableObject(workspaceStub(), async (instance: WorkspaceDO) => {
      await expect(instance.receiveChildEffects({ substreamId: started.runId, envelopes: [latest] }))
        .resolves.toEqual({ accepted: [{ messageId: latest.messageId, payloadHash: latest.payloadHash }] });
      await expect(instance.receiveChildEffects({ substreamId: started.runId, envelopes: [conflicting] }))
        .rejects.toThrow("substream_effect_idempotency_conflict");
    });
  });
});

it("requires an explicit workspace role for unrelated workspace Sidekick viewers", async () => {
  await createDraft();
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    state.storage.sql.exec(`UPDATE automation_directory SET scope = 'workspace' WHERE automation_id = ?`, AUTOMATION_ID);
  });
  const read = (viewer: { actorRole?: "member" | null }) => runInDurableObject(workspaceStub(), (instance: WorkspaceDO) =>
    instance.sidekickReadDetail({ ...addressed(), actor: { userId: asUserId(crypto.randomUUID()), participantOfOwningWorkstream: false, ...viewer } }));
  await expect(read({})).rejects.toThrow("This Sidekick does not exist");
  await expect(read({ actorRole: null })).rejects.toThrow("This Sidekick does not exist");
  await expect(read({ actorRole: "member" })).resolves.toMatchObject({ id: AUTOMATION_ID });
});
