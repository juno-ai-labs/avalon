/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A `semantic_activity` trigger's written condition, against the real object.
 *
 * The condition is the only trigger gate in the product that is a sentence
 * rather than a field comparison, and for its first year nothing applied it: the
 * draft schema required it, the accepted revision stored it, the approval card
 * showed it as what starts the run, and admission matched on the evaluator rules
 * alone. So the invariant this file guards is the one that was missing — an
 * event that reaches a gated Sidekick starts a run only when a verdict says the
 * condition holds.
 *
 * The verdict crosses the RPC boundary because the classifier runs in a Worker,
 * where every other model call in this tree runs; the object is still the
 * authority, which is what the first case asserts. The classifier itself is
 * exercised in `packages/agent-harness`, over a stubbed provider — what needs
 * real workerd is that a stored definition, a real registration and a real
 * occurrence key combine into a refusal rather than a run.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asAutomationId,
  asUserId,
  asWorkspaceId,
  AutomationSetEvaluatorRulesInputV1Schema,
  type AutomationDraft,
} from "@rally/contracts";

import type { AutomationDO } from "../src/durable-objects/automation-do";
import { automationDOName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ae0");
const CONNECTION_ID = "00000000-0000-7000-8000-000000000ae1";
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-000000000ae2");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-000000000ae3");
const SESSION_ID = "00000000-0000-7000-8000-000000000ae4";
const REGISTRATION_ID = "00000000-0000-7000-8000-000000000ae5";
const EVENT_ID = "00000000-0000-7000-8000-000000000ae6";
const SECOND_EVENT_ID = "00000000-0000-7000-8000-000000000ae7";
const THIRD_EVENT_ID = "00000000-0000-7000-8000-000000000ae8";
const FOURTH_EVENT_ID = "00000000-0000-7000-8000-000000000ae9";
const EVENT_TYPE = "applicationSubmit";
const CONDITION = "The application is for a design role.";
const NOW = "2026-09-18T09:00:00.000Z";
const TEST_ENV: Env = env;

const SEMANTIC_DEFINITION: AutomationDraft = {
  name: "Design applications watcher",
  description: "Runs when a design candidate applies",
  overview: "Watches Ashby for design applications",
  instructions: "Summarize the application in one sentence.",
  triggers: [{
    type: "semantic_activity",
    connectorType: "ashby",
    sourceBindingKey: "ashby_events",
    suggestedSourcePluginId: "plugin_ashby",
    deterministicPrefilter: { eventType: EVENT_TYPE },
    condition: CONDITION,
  }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  suggestedScope: "workspace",
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

const CONNECTOR_DEFINITION: AutomationDraft = {
  ...SEMANTIC_DEFINITION,
  name: "Every application watcher",
  description: "Runs when any candidate applies",
  triggers: [{
    type: "connector_activity",
    connectorType: "ashby",
    sourceBindingKey: "ashby_events",
    suggestedSourcePluginId: "plugin_ashby",
    eventTypes: [EVENT_TYPE],
    deterministicFilters: {},
  }],
};

useOpenRouterDouble(() => ({ say: "Done." }));
useSelectedModel();
useHeldEffectQueue();

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function automation(): DurableObjectStub<AutomationDO> {
  return env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(
    automationDOName("global", WORKSPACE_ID, AUTOMATION_ID),
  ));
}

async function activate(definition: AutomationDraft): Promise<void> {
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR_ID,
    scope: "workspace",
    owningWorkstreamId: null,
    automationId: AUTOMATION_ID,
  });
  expect(created.created).toBe(true);
  await submitAndApply(definition);
  // Registrations are written directly rather than through the apply tail, so
  // the activation boundary is set once and the event sequence stays this test's
  // to control.
  await workspace().applyExternalEventRegistrations({
    sourceGeneration: await runInDurableObject(automation(), (_instance, state) => state.storage.sql.exec<{ registration_generation: number }>(
      `UPDATE automation SET registration_generation = registration_generation + 1 WHERE id = 1 RETURNING registration_generation`,
    ).one().registration_generation),
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    destination: { kind: "automation", automationId: AUTOMATION_ID },
    evaluators: [{
      evaluatorId: REGISTRATION_ID,
      source: { connectorType: "ashby", connectionId: CONNECTION_ID, eventType: EVENT_TYPE },
      when: { kind: "always" },
    }],
  });
}

/**
 * Accept a new definition on an automation that already exists.
 *
 * Split out of `activate` so a test can change what the accepted revision says
 * without recreating the automation or rewriting its registrations — which is the
 * only way to reach the window where a condition moves under a delivery whose
 * plan has already been read.
 */
async function submitAndApply(definition: AutomationDraft): Promise<void> {
  await automation().submitDefinition({
    workspaceId: WORKSPACE_ID,
    automationId: AUTOMATION_ID,
    draft: definition,
    evaluatorRules: AutomationSetEvaluatorRulesInputV1Schema.parse({
      schemaVersion: 1,
      evaluators: [{
        evaluatorKey: "ashby_event",
        source: {
          sourceBindingKey: "ashby_events",
          suggestedSourcePluginId: "plugin_ashby",
          event: { kind: "event_type", eventType: EVENT_TYPE },
        },
        when: { kind: "always" },
      }],
    }),
    submittedByRunId: null,
  });
  const detail = await runInDurableObject(automation(), (instance: AutomationDO) => instance.apply({
    workspaceId: WORKSPACE_ID,
    automationId: AUTOMATION_ID,
    actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: false },
  }));
  expect(detail.lifecycle).toBe("active");
}

async function ingest(eventId: string, providerEventId: string): Promise<void> {
  await workspace().ingestConnectorEvent({
    workspaceId: WORKSPACE_ID,
    ingressEventId: eventId,
    payloadHash: `sha256:${eventId.slice(-2).repeat(32)}`,
    event: {
      connectorType: "ashby",
      activity: {
        id: eventId,
        workspaceId: WORKSPACE_ID,
        region: "global",
        connectionId: CONNECTION_ID,
        connectionScope: "workspace",
        connectionOwnerUserId: null,
        provider: "ashby",
        providerEventId,
        eventType: EVENT_TYPE,
        resourceType: null,
        providerResourceId: "application-id",
        actor: {},
        subject: {},
        occurredAt: NOW,
        receivedAt: NOW,
        title: "Application submitted",
        summary: "A candidate applied",
        textSnippet: "The application names a senior design role.",
        payloadRef: null,
        visibility: { kind: "workspace" },
        targetUserIds: [],
        entityKeys: [],
        dedupeKey: `ashby:${providerEventId}`,
        rawContentHash: null,
        metadata: {},
        externalPeople: [],
      },
    },
  });
}

/** The delivery an admitted match would carry, for one ingested event. */
async function admission(eventId: string) {
  const sequence = await runInDurableObject(workspace(), (_instance: WorkspaceDO, state) => state.storage.sql.exec<{ event_sequence: number }>(
    `SELECT event_sequence FROM workspace_connector_events WHERE event_id = ?`, eventId,
  ).one().event_sequence);
  return {
    workspaceId: WORKSPACE_ID,
    automationId: AUTOMATION_ID,
    registrationId: REGISTRATION_ID,
    payloadHash: `sha256:${eventId.slice(-2).repeat(32)}`,
    event: {
      id: eventId,
      eventSequence: sequence,
      eventType: EVENT_TYPE,
      title: "Application submitted",
      summary: "A candidate applied",
      textSnippet: "The application names a senior design role.",
      metadata: {},
      occurredAt: Date.parse(NOW),
      audienceUserIds: [] as string[],
      audienceKind: "workspace" as const,
    },
  };
}

function runCount(): Promise<number> {
  return runInDurableObject(automation(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
    `SELECT COUNT(*) AS count FROM runs`,
  ).one().count);
}

describe("semantic trigger conditions", () => {
  beforeEach(async () => {
    await reset();
    await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
    // This suite's D1 starts with no schema, so the tables creating a Sidekick
    // writes through are declared here rather than migrated in.
    await env.DB.batch([
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
    ]);
    // The Sidekick's address is reserved up front: minting one needs a signing
    // key this test Worker has no reason to configure, and the address is not
    // what any case below is about.
    await env.DB.prepare(`INSERT OR REPLACE INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, automation_subscription_id, created_at, updated_at)
      VALUES ('design-applications-watcher', 'global', ?, NULL, ?, ?, ?)`)
      .bind(WORKSPACE_ID, AUTOMATION_ID, NOW, NOW).run();
    await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
    await runInDurableObject(workspace(), (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO connector_connections
           (id, workspace_id, connector_type, scope, owner_user_id, display_name,
            status, config_json, granted_scopes_json, created_at, updated_at, model_plugin_id)
         VALUES (?, ?, 'ashby', 'workspace', NULL, 'Ashby events', 'healthy', ?, '["ashby.workspace.events"]', ?, ?, 'plugin_ashby')`,
        CONNECTION_ID, WORKSPACE_ID, JSON.stringify({ selectedEvents: [EVENT_TYPE] }), NOW, NOW,
      );
    });
  });

  it("names the conditions a delivery has to judge, and the connector they watch", async () => {
    await activate(SEMANTIC_DEFINITION);
    await ingest(EVENT_ID, "event-plan");

    expect(await automation().externalEventAdmissionPlan(await admission(EVENT_ID))).toEqual({
      kind: "judge",
      conditions: [CONDITION],
      connectorType: "ashby",
    });
  });

  it("refuses a gated event that arrives with no verdict, and starts no run", async () => {
    await activate(SEMANTIC_DEFINITION);
    await ingest(EVENT_ID, "event-unjudged");

    expect(await automation().admitExternalEvent(await admission(EVENT_ID))).toEqual({
      admitted: false,
      outcomeCode: "sidekick_semantic_condition_unjudged",
    });
    expect(await runCount()).toBe(0);
  });

  it("refuses a gated event whose condition was judged unmet, and starts no run", async () => {
    await activate(SEMANTIC_DEFINITION);
    await ingest(EVENT_ID, "event-not-met");

    expect(await automation().admitExternalEvent({
      ...await admission(EVENT_ID),
      conditionVerdict: { admit: false, code: "condition_not_met", confidence: 0.91, model: "jev-1.13.0" },
    })).toEqual({ admitted: false, outcomeCode: "sidekick_semantic_condition_not_met" });
    expect(await runCount()).toBe(0);
  });

  it("admits a gated event whose condition was judged met", async () => {
    await activate(SEMANTIC_DEFINITION);
    await ingest(SECOND_EVENT_ID, "event-met");

    expect(await automation().admitExternalEvent({
      ...await admission(SECOND_EVENT_ID),
      conditionVerdict: { admit: true, code: "condition_met", confidence: 0.93, model: "jev-1.13.0" },
    })).toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_admitted" });
    expect(await runCount()).toBe(1);
  });

  /**
   * Why a verdict does not need to carry what it judged.
   *
   * The classifier runs between the plan read and the admission, so an `apply`
   * can change the condition while the model call is in flight, keeping the same
   * registration identity — which looks like a window where the object sees the
   * new condition and admits on a verdict for the old one. It is closed, by
   * something one clause earlier and for an unrelated reason: `apply` is the only
   * path that can move an accepted condition, it re-establishes
   * `effective_after_event_sequence` at the sequence current when its
   * registration tail lands, and the boundary check is ordered *before* the
   * semantic one. An event ingested before the apply is at or below that
   * boundary, so it never reaches the gate.
   *
   * Both halves were checked by breaking them. Removing the `= NULL` that apply
   * writes does **not** open the hole, because the registration tail sets the
   * boundary forward anyway. Moving the semantic check above the boundary check
   * does: the delivery then admits on the superseded verdict, which is exactly
   * the failure this pins. So what protects the gate is the ordering, and the
   * ordering is invisible from the gate's own clause.
   */
  it("refuses a delivery whose condition was replaced after its plan was read", async () => {
    await activate(SEMANTIC_DEFINITION);
    await ingest(FOURTH_EVENT_ID, "event-replanned");

    const request = await admission(FOURTH_EVENT_ID);
    expect(await automation().externalEventAdmissionPlan(request)).toMatchObject({ kind: "judge" });

    await submitAndApply({
      ...SEMANTIC_DEFINITION,
      triggers: [{
        type: "semantic_activity",
        connectorType: "ashby",
        sourceBindingKey: "ashby_events",
        suggestedSourcePluginId: "plugin_ashby",
        deterministicPrefilter: { eventType: EVENT_TYPE },
        condition: "The candidate withdrew from the process.",
      }],
    });

    // A verdict for the condition that has just been replaced, at the highest
    // confidence the classifier can report: the point is that it cannot admit.
    expect(await automation().admitExternalEvent({
      ...request,
      conditionVerdict: { admit: true, code: "condition_met", confidence: 0.99, model: "jev-1.13.0" },
    })).toEqual({ admitted: false, outcomeCode: "sidekick_event_before_activation_boundary" });
    expect(await runCount()).toBe(0);
  });

  it("leaves a deterministic activity trigger ungated", async () => {
    await activate(CONNECTOR_DEFINITION);
    await ingest(THIRD_EVENT_ID, "event-deterministic");

    const request = await admission(THIRD_EVENT_ID);
    expect(await automation().externalEventAdmissionPlan(request)).toEqual({ kind: "admit" });
    expect(await automation().admitExternalEvent(request)).toEqual({
      admitted: true,
      outcomeCode: "sidekick_occurrence_admitted",
    });
    expect(await runCount()).toBe(1);
  });
});
