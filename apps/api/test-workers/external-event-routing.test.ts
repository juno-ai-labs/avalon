/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * One accepted connector event, one matcher call, every destination it
 * reaches, and what happens when the Queue delivers it twice.
 *
 * `matchExternalEventDestinations` answers with complete Queue messages: the
 * registration, the destination and the event travel together, and there is no
 * ledger and no lease. The objects a delivery lands on are idempotent on the
 * pair instead: an automation keys its run on the event (`occurrence_key`, one
 * row per event), and a watched work stream keys its receipt on the event and
 * the registration. A redelivery therefore finds its own receipt and does
 * nothing, which is all a lease ever guaranteed.
 *
 * A registration is effective only for events that arrive after it: an event
 * admitted before an automation was applied is matched by nothing that did not
 * exist when it arrived, and the automation itself refuses it a second time
 * from its own boundary.
 *
 * The automation's registrations are written to WorkspaceDO directly rather
 * than through `apply`: applying an event trigger validates the rules against
 * the connector's manifest, and the test Worker configures no Slack connector.
 * The Ashby case instead applies its actual connector rule against the manifest.
 * A watched work stream's registrations are written the same way; in
 * production WorkspaceDO derives them from the work stream's resource links.
 */

import { env } from "cloudflare:workers";
import { authorizedConnection, createAshbyConnector, AshbyCapabilities } from "@rally/connectors";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asAutomationId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  WorkspaceExternalEventMatchResultSchema,
  AutomationSetEvaluatorRulesInputV1Schema,
  type AutomationDraft,
} from "@rally/contracts";

import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";
import { createResourceObjectPort } from "../src/runtime/resource-port";
import { createAutomation } from "../src/services/automation-service";
import { attachWorkstreamRuntimeResource } from "../src/services/workstream-object-client";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import { consumeEffectBodies } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { runSidekickAlarms, writeSidekickRegistrations } from "./helpers/sidekick";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000009a0");
const CONNECTION_ID = "00000000-0000-7000-8000-0000000009a1";
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-0000000009a2");
const RESOURCE_ID = "00000000-0000-7000-8000-0000000009a3";
const WORKSTREAM_ONE = "00000000-0000-7000-8000-0000000009a4";
const WORKSTREAM_TWO = "00000000-0000-7000-8000-0000000009a5";
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-0000000009a6");
const SESSION_ID = "00000000-0000-7000-8000-0000000009a7";
const EARLIER_EVENT_ID = "00000000-0000-7000-8000-0000000009c0";
const EVENT_ID = "00000000-0000-7000-8000-0000000009c1";
const UNMATCHED_EVENT_ID = "00000000-0000-7000-8000-0000000009c2";
const NOW = "2026-08-28T09:00:00.000Z";
const TEST_ENV: Env = env;
const RUN_SETTLE_TIMEOUT_MS = 15_000;

const DEFINITION: AutomationDraft = {
  name: "Channel watcher",
  description: "Runs when a message is posted",
  overview: "Watches one channel",
  instructions: "Summarize the message in one sentence.",
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

// An admitted event provisions a run whose loop ends at the Slack connector
// the test Worker does not configure; the double keeps that loop off the
// network either way.
useOpenRouterDouble(() => ({ say: "Done." }));
useSelectedModel();
useHeldEffectQueue();

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}


function conversation(parentId: string, substreamId?: string) {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, parentId, substreamId === undefined ? "0" : asSubstreamId(substreamId)),
  ));
}

async function seedRegionalDatabase(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
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
      VALUES ('channel-watcher', 'global', ?, NULL, ?, ?, ?)`)
      .bind(WORKSPACE_ID, AUTOMATION_ID, NOW, NOW),
  ]);
}

async function seedWorkspaceObject(): Promise<void> {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance: WorkspaceDO, state) => {
    state.storage.sql.exec(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, display_name,
          status, config_json, created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'slack', 'workspace', NULL, 'Slack', 'healthy', '{}', ?, ?, ?)`,
      CONNECTION_ID,
      WORKSPACE_ID,
      NOW,
      NOW,
      "plugin_slack",
    );
    state.storage.sql.exec(
      `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider,
          provider_resource_id, title, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'slack_channel', 'slack', 'C123', 'Channel', '{}', ?, ?)`,
      RESOURCE_ID,
      WORKSPACE_ID,
      CONNECTION_ID,
      NOW,
      NOW,
    );
  });
}

/** A work stream watching the channel: opened, provisioned, the resource attached with its watch on. */
async function seedWatchingWorkstream(workstreamId: string): Promise<void> {
  await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, workstreamId, "workstream");
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    workstreamId,
    title: "Watching the channel",
    objective: "",
    scope: "personal",
    createdByUserId: AUTHOR_ID,
    participantUserIds: [AUTHOR_ID],
    harnessStatus: "idle",
    titleStatus: "settled",
    emailAddress: null,
    emailRouteStatus: null,
    systemKind: null,
    modelOverride: null,
    now: Date.now(),
  });
  await attachWorkstreamRuntimeResource(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    workstreamId,
    resourceId: RESOURCE_ID,
    attachedByUserId: AUTHOR_ID,
  });
  const watched = await createResourceObjectPort(TEST_ENV, WORKSPACE_ID, workstreamId)
    .setWatchEnabled({ resourceId: RESOURCE_ID, watchEnabled: 1 });
  expect(watched.outcome).not.toBe("not_attached");
}

async function registerWorkstreamWatch(workstreamId: string): Promise<void> {
  await workspace().applyExternalEventRegistrations({
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    destination: { kind: "workstream_resource_update", workstreamId, substreamId: "0", resourceId: RESOURCE_ID },
    evaluators: [{
      evaluatorId: `${workstreamId.slice(0, -1)}b`,
      source: { connectorType: "slack", connectionId: CONNECTION_ID, eventType: "slack.message.posted", resourceId: RESOURCE_ID },
      when: { kind: "always" },
    }],
  });
}

async function registerAutomation(): Promise<void> {
  await writeSidekickRegistrations(TEST_ENV, WORKSPACE_ID, AUTOMATION_ID, [{
    evaluatorId: "00000000-0000-7000-8000-0000000009b0",
    source: { connectorType: "slack", connectionId: CONNECTION_ID, eventType: "slack.message.posted", resourceId: RESOURCE_ID },
    when: { kind: "always" },
  }]);
}

/** Drafted, applied, and so bounded by the workspace's event sequence at that moment. */
async function activateAutomation(): Promise<void> {
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR_ID,
    scope: "personal",
    owningWorkstreamId: null,
    automationId: AUTOMATION_ID
  });
  expect(created.created).toBe(true);
  await workspace().sidekickSubmitDefinition({
    workspaceId: WORKSPACE_ID,
    automationId: AUTOMATION_ID,
    draft: DEFINITION,
    evaluatorRules: null,
    submittedByRunId: null,
  });
  const detail = await runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.sidekickApply({
    workspaceId: WORKSPACE_ID,
    automationId: AUTOMATION_ID,
    actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: false },
  }));
  expect(detail.lifecycle).toBe("active");
}

async function ingestSlackEvent(
  eventId: string,
  providerEventId: string,
  eventType = "slack.message.posted",
  overrides: { metadata?: Record<string, unknown>; occurrenceKey?: string } = {},
): Promise<void> {
  await workspace().ingestConnectorEvent({
    workspaceId: WORKSPACE_ID,
    ingressEventId: eventId,
    payloadHash: `sha256:${eventId.slice(-2).repeat(32)}`,
    event: {
      connectorType: "slack",
      activity: {
        id: eventId,
        workspaceId: WORKSPACE_ID,
        region: "global",
        connectionId: CONNECTION_ID,
        connectionScope: "workspace",
        connectionOwnerUserId: null,
        provider: "slack",
        providerEventId,
        eventType,
        resourceType: "slack_channel",
        providerResourceId: "C123",
        actor: {},
        subject: {},
        occurredAt: NOW,
        receivedAt: "2026-08-28T09:00:01.000Z",
        title: eventType === "slack.message.posted" ? "New message" : "Reaction",
        summary: eventType === "slack.message.posted" ? "A channel message arrived" : "A reaction arrived",
        textSnippet: "foobar",
        payloadRef: null,
        visibility: { kind: "workspace" },
        targetUserIds: [],
        entityKeys: [],
        dedupeKey: `slack:${providerEventId}`,
        // Production stamps the verified body's hash, which differs per delivery.
        rawContentHash: `slack-body:${providerEventId}`,
        metadata: overrides.metadata ?? { messageText: "foobar" },
        ...(overrides.occurrenceKey ? { occurrenceKey: overrides.occurrenceKey } : {}),
        externalPeople: [],
      },
    },
  });
}

async function match(eventId: string) {
  return WorkspaceExternalEventMatchResultSchema.parse(
    await workspace().matchExternalEventDestinations({ workspaceId: WORKSPACE_ID, eventId }),
  );
}

async function automationRuns(): Promise<{ occurrence_key: string; state: string }[]> {
  return runInDurableObject(workspace(), (_instance, state) =>
    state.storage.sql.exec<{ occurrence_key: string; state: string }>(
      `SELECT occurrence_key, state FROM sidekick_runs WHERE sidekick_id = ? ORDER BY created_at`, AUTOMATION_ID,
    ).toArray());
}

async function resourceUpdateMessages(workstreamId: string): Promise<string[]> {
  return runInDurableObject(conversation(workstreamId), (_instance, state) =>
    state.storage.sql.exec<{ client_message_id: string }>(
      `SELECT client_message_id FROM canonical_conversation_turn_details
        WHERE client_message_id LIKE 'resource-update:%' ORDER BY client_message_id`,
    ).toArray().map((row) => row.client_message_id));
}

/** Let the run the admission armed provision itself and end, so nothing outlives the test. */
async function settleAdmittedRun(): Promise<void> {
  await runSidekickAlarms(TEST_ENV, WORKSPACE_ID);
  const runId = (await runInDurableObject(workspace(), (_instance, state) =>
    state.storage.sql.exec<{ run_id: string }>(`SELECT run_id FROM sidekick_runs WHERE sidekick_id = ?`, AUTOMATION_ID).toArray()))[0]?.run_id;
  if (!runId) throw new Error("no run was admitted");
  await expect.poll(async () => runInDurableObject(conversation(AUTOMATION_ID, runId), (_instance, state) => {
    try {
      return state.storage.sql.exec<{ terminalized_at: number | null }>(
        `SELECT terminalized_at FROM runs`,
      ).toArray().some((row) => row.terminalized_at !== null);
    } catch {
      return false;
    }
  }), { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 100 }).toBe(true);
}

beforeEach(async () => {
  await reset();
  await seedRegionalDatabase();
  await seedWorkspaceObject();
  await seedWatchingWorkstream(WORKSTREAM_ONE);
  await seedWatchingWorkstream(WORKSTREAM_TWO);
});

describe("external event routing", () => {
  it.each(["applicationSubmit", "candidateStageChange"] as const)("routes a signed Ashby %s to a workspace automation exactly once", async (eventType) => {
    // Ashby's HTTP/installation boundary is covered in connector-installation-routes.
    // Here the real adapter, WorkspaceDO matcher, Queue consumer and hosted Sidekick
    // must produce a run. The existing model double lets that run finish locally.
    const ashbyConnectionId = crypto.randomUUID();
    await runInDurableObject(workspace(), (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         status, config_json, granted_scopes_json, created_at, updated_at, model_plugin_id)
        VALUES (?, ?, 'ashby', 'workspace', NULL, 'Ashby events', 'healthy', ?, '["ashby.workspace.events"]', ?, ?, 'plugin_ashby')`,
      ashbyConnectionId, WORKSPACE_ID, JSON.stringify({ selectedEvents: [eventType] }), NOW, NOW);
    });
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID,
      scope: "workspace", owningWorkstreamId: null, automationId: AUTOMATION_ID });
    await workspace().sidekickSubmitDefinition({ workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID,
      draft: { ...DEFINITION, name: "Ashby watcher", suggestedScope: "workspace",
        triggers: [{ type: "connector_activity", connectorType: "ashby", sourceBindingKey: "ashby_events",
          suggestedSourcePluginId: "plugin_ashby", eventTypes: [eventType], deterministicFilters: {} }] },
      evaluatorRules: AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: [{ evaluatorKey: "ashby_event",
        source: { sourceBindingKey: "ashby_events", suggestedSourcePluginId: "plugin_ashby",
          event: { kind: "event_type", eventType } }, when: { kind: "always" } }] }), submittedByRunId: null });
    const detail = await runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.sidekickApply({
      workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID,
      actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: false },
    }));
    expect(detail).toMatchObject({ lifecycle: "active", connectorBindings: { plugin_ashby: ashbyConnectionId } });
    const facet = createAshbyConnector({ redirectUri: "https://api.example.test/connections/ashby/callback" }).webhookActivity!;
    const rawBody = JSON.stringify({ action: eventType, webhookActionId: "ashby-action",
      data: { application: { id: "application-id", candidate: { id: "candidate-id", name: "Private candidate" } } } });
    const secret = "ashby-routing-test-secret";
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const verified = await facet.verify({ rawBody, headers: new Headers({ "Ashby-Signature": `sha256=${signature}` }),
      verificationSecret: secret, receivedAt: NOW, now: Date.parse(NOW), maxBytes: new TextEncoder().encode(rawBody).length });
    const activity = facet.normalize(authorizedConnection({ id: ashbyConnectionId, workspaceId: WORKSPACE_ID,
      scope: "workspace", ownerUserId: null, grantedScopes: [AshbyCapabilities.workspaceEvents],
      credentials: {}, config: { selectedEvents: [eventType], region: "global" }, cursor: {} }),
    { ...verified, event: { ...verified.event as object, observedAt: NOW } }, "regional-payload-reference");
    expect(activity).not.toBeNull();
    await workspace().ingestConnectorEvent({ workspaceId: WORKSPACE_ID, ingressEventId: EVENT_ID,
      payloadHash: `sha256:${verified.bodyHash}`, event: { connectorType: "ashby", activity: { ...activity!, id: EVENT_ID, externalPeople: [] } } });
    const matched = await match(EVENT_ID);
    expect(matched.deliveries).toHaveLength(1);
    expect(matched.deliveries[0]).toMatchObject({ destination: { kind: "automation", automationId: AUTOMATION_ID },
      event: { eventType, audienceKind: "workspace" } });
    expect(JSON.stringify(matched.deliveries)).not.toContain("Private candidate");
    expect(await consumeEffectBodies(TEST_ENV, matched.deliveries)).toEqual({ acked: 1, retried: 0 });
    expect(await consumeEffectBodies(TEST_ENV, matched.deliveries)).toEqual({ acked: 1, retried: 0 });
    expect(await automationRuns()).toEqual([{ occurrence_key: `external:${EVENT_ID}`, state: expect.any(String) }]);
    await settleAdmittedRun();
  });

  it("delivers the occurrence a connector named and drops one planted in provider metadata", async () => {
    // A provider payload cannot pick the key an automation dedupes on. The
    // generic webhook copies a caller's metadata whole, so the workspace
    // store drops a same-named key from metadata at ingest and lifts only the
    // activity's own field, which adapter code alone sets, onto the delivery.
    await activateAutomation();
    await registerAutomation();
    await ingestSlackEvent(EVENT_ID, "event-planted", "slack.message.posted", {
      metadata: { messageText: "foobar", occurrenceKey: "planted:by:caller" },
    });
    const planted = await match(EVENT_ID);
    expect(planted.deliveries).toHaveLength(1);
    expect(planted.deliveries[0]!.event.occurrenceKey).toBeUndefined();
    expect(planted.deliveries[0]!.event.metadata).toMatchObject({ messageText: "foobar" });
    expect(planted.deliveries[0]!.event.metadata).not.toHaveProperty("occurrenceKey");

    const namedEventId = "00000000-0000-7000-8000-0000000009c2";
    await ingestSlackEvent(namedEventId, "event-named", "slack.message.posted", {
      metadata: { messageText: "foobar", occurrenceKey: "planted:by:caller" },
      occurrenceKey: "slack:C123:thread:1712345678.000201",
    });
    const named = await match(namedEventId);
    expect(named.deliveries).toHaveLength(1);
    expect(named.deliveries[0]!.event.occurrenceKey).toBe("slack:C123:thread:1712345678.000201");
    expect(named.deliveries[0]!.event.metadata).toMatchObject({ messageText: "foobar" });
    expect(named.deliveries[0]!.event.metadata).not.toHaveProperty("occurrenceKey");
  });

  it("rejects stale registration effects and keeps retry activation boundaries stable", async () => {
    await activateAutomation();
    const project = (sourceGeneration: number, eventType: string) => workspace().applyExternalEventRegistrations({
      schemaVersion: 1, workspaceId: WORKSPACE_ID, sourceGeneration,
      destination: { kind: "automation", automationId: AUTOMATION_ID },
      evaluators: [{ evaluatorId: sourceGeneration === 2 ? "00000000-0000-7000-8000-0000000009b0" : "00000000-0000-7000-8000-0000000009b1",
        source: { connectorType: "slack", connectionId: CONNECTION_ID, eventType }, when: { kind: "always" } }],
    });
    const accepted = await project(2, "slack.message.posted");
    await ingestSlackEvent(EVENT_ID, "registration-retry");
    expect(await project(2, "slack.message.posted")).toEqual(accepted);
    await project(1, "slack.reaction.added");
    const result = await match(EVENT_ID);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]?.registrationId).toBe("00000000-0000-7000-8000-0000000009b0");
  });

  it("matches one event to every destination once, whatever the Queue redelivers", async () => {
    await registerWorkstreamWatch(WORKSTREAM_ONE);
    await registerWorkstreamWatch(WORKSTREAM_TWO);
    // Arrived before the automation existed: the work streams were already
    // watching, the automation was not.
    await ingestSlackEvent(EARLIER_EVENT_ID, "event-0");
    await activateAutomation();
    await registerAutomation();

    const earlier = await match(EARLIER_EVENT_ID);
    expect(earlier.matched).toBe(true);
    expect(earlier.deliveries.map((delivery) => delivery.destination.kind))
      .toEqual(["workstream_resource_update", "workstream_resource_update"]);
    expect(await workspace().sidekickAdmitExternalEvent({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      registrationId: "00000000-0000-7000-8000-0000000009b0",
      event: {
        id: EARLIER_EVENT_ID,
        eventSequence: 1,
        eventType: "slack.message.posted",
        title: "New message",
        summary: "A channel message arrived",
        textSnippet: "",
        metadata: {},
        occurredAt: Date.parse(NOW),
        audienceUserIds: [],
        audienceKind: "workspace",
      },
      payloadHash: `sha256:${"c0".repeat(32)}`,
    })).toEqual({ admitted: false, outcomeCode: "sidekick_event_before_activation_boundary" });

    await ingestSlackEvent(EVENT_ID, "event-1");
    const matched = await match(EVENT_ID);

    expect(matched.matched).toBe(true);
    expect(matched.deliveries).toHaveLength(3);
    for (const delivery of matched.deliveries) {
      expect(delivery).toMatchObject({
        type: "workspace_external_event_delivery_v1",
        schemaVersion: 1,
        region: "global",
        workspaceId: WORKSPACE_ID,
        registrationId: expect.any(String),
        payloadHash: `sha256:${"c1".repeat(32)}`,
        event: {
          id: EVENT_ID,
          eventSequence: 2,
          eventType: "slack.message.posted",
          title: "New message",
          summary: "A channel message arrived",
          occurredAt: Date.parse(NOW),
          audienceKind: "workspace",
          audienceUserIds: [],
        },
      });
    }
    expect(matched.deliveries.map((delivery) => delivery.destination).sort((left, right) => (
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ))).toEqual([
      { kind: "automation", automationId: AUTOMATION_ID },
      { kind: "workstream_resource_update", workstreamId: WORKSTREAM_ONE, substreamId: "0", resourceId: RESOURCE_ID },
      { kind: "workstream_resource_update", workstreamId: WORKSTREAM_TWO, substreamId: "0", resourceId: RESOURCE_ID },
    ]);
    // Asking again is the same answer: matching keeps no state.
    expect((await match(EVENT_ID)).deliveries).toHaveLength(3);

    // The consumer, twice, as a Queue retry would: once is what lands.
    expect(await consumeEffectBodies(TEST_ENV, matched.deliveries)).toEqual({ acked: 3, retried: 0 });
    expect(await consumeEffectBodies(TEST_ENV, matched.deliveries)).toEqual({ acked: 3, retried: 0 });

    expect(await automationRuns()).toEqual([{ occurrence_key: `external:${EVENT_ID}`, state: expect.any(String) }]);
    const registrationFor = (workstreamId: string) => matched.deliveries.find((delivery) => (
      delivery.destination.kind === "workstream_resource_update" && delivery.destination.workstreamId === workstreamId
    ))!.registrationId;
    expect(await resourceUpdateMessages(WORKSTREAM_ONE))
      .toEqual([`resource-update:${EVENT_ID}:${registrationFor(WORKSTREAM_ONE)}`]);
    expect(await resourceUpdateMessages(WORKSTREAM_TWO))
      .toEqual([`resource-update:${EVENT_ID}:${registrationFor(WORKSTREAM_TWO)}`]);

    await ingestSlackEvent(UNMATCHED_EVENT_ID, "event-2", "slack.reaction.added");
    expect(await match(UNMATCHED_EVENT_ID)).toEqual({ matched: false, deliveries: [] });

    await settleAdmittedRun();
  });
});
