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

import { workspaceDOName } from "../src/durable-objects/names";
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
const EVENT_ID = "00000000-0000-7000-8000-000000000ae6";
const SECOND_EVENT_ID = "00000000-0000-7000-8000-000000000ae7";
const THIRD_EVENT_ID = "00000000-0000-7000-8000-000000000ae8";
const FOURTH_EVENT_ID = "00000000-0000-7000-8000-000000000ae9";
const FIFTH_EVENT_ID = "00000000-0000-7000-8000-000000000aea";
const SIXTH_EVENT_ID = "00000000-0000-7000-8000-000000000aeb";
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
  customTools: [],
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

async function activate(definition: AutomationDraft): Promise<void> {
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR_ID,
    scope: "workspace",
    automationId: AUTOMATION_ID,
  });
  expect(created.created).toBe(true);
  await submitAndApply(definition);
}

/**
 * Accept a new definition on an automation that already exists.
 *
 * Split out of `activate` so a test can change what the accepted revision says
 * without recreating the automation. This reaches the window where a condition
 * moves under a delivery whose plan has already been read.
 */
async function submitAndApply(definition: AutomationDraft): Promise<void> {
  await workspace().sidekickSubmitDefinition({
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
  const detail = await runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.sidekickApply({
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
  const registrationId = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ registration_id: string }>(
    `SELECT registration_id FROM workspace_external_event_registrations
      WHERE automation_id = ? AND event_type = ? AND state = 'active'`, AUTOMATION_ID, EVENT_TYPE,
  ).one().registration_id);
  return {
    workspaceId: WORKSPACE_ID,
    automationId: AUTOMATION_ID,
    registrationId,
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
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
    `SELECT COUNT(*) AS count FROM sidekick_runs WHERE sidekick_id = ?`, AUTOMATION_ID,
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

  it("refuses a gated event that arrives with no verdict, names what to judge, and starts no run", async () => {
    await activate(SEMANTIC_DEFINITION);
    await ingest(EVENT_ID, "event-unjudged");

    // The refusal carries the conditions and their connector, so the caller
    // judges them and asks once more rather than reading a plan first.
    expect(await workspace().sidekickAdmitExternalEvent(await admission(EVENT_ID))).toEqual({
      admitted: false,
      outcomeCode: "sidekick_semantic_condition_unjudged",
      judge: { conditions: [CONDITION], connectorType: "ashby" },
    });
    expect(await runCount()).toBe(0);
  });

  it("refuses a gated event whose condition was judged unmet, and starts no run", async () => {
    await activate(SEMANTIC_DEFINITION);
    await ingest(EVENT_ID, "event-not-met");

    expect(await workspace().sidekickAdmitExternalEvent({
      ...await admission(EVENT_ID),
      conditionVerdict: { admit: false, code: "condition_not_met", confidence: 0.91, model: "jev-1.13.0" },
    })).toEqual({ admitted: false, outcomeCode: "sidekick_semantic_condition_not_met" });
    expect(await runCount()).toBe(0);
  });

  it("admits a gated event whose condition was judged met", async () => {
    await activate(SEMANTIC_DEFINITION);
    await ingest(SECOND_EVENT_ID, "event-met");

    expect(await workspace().sidekickAdmitExternalEvent({
      ...await admission(SECOND_EVENT_ID),
      conditionVerdict: { admit: true, code: "condition_met", confidence: 0.93, model: "jev-1.13.0" },
    })).toEqual({ admitted: true, outcomeCode: "sidekick_occurrence_admitted" });
    expect(await runCount()).toBe(1);
  });

  /**
   * Why a verdict does not need to carry what it judged.
   *
   * The classifier runs between the unjudged refusal and the admission, so an `apply`
   * can change the condition while the model call is in flight. The old
   * registration is then refused. Even if the delivery is replanned against the
   * current registration, `apply` re-establishes
   * `effective_after_event_sequence` at the sequence current when its
   * registration tail lands, and the boundary check is ordered *before* the
   * semantic one. An event ingested before the apply is at or below that
   * boundary, so it never reaches the gate.
   *
   * Both registration removal and the current registration's boundary are
   * asserted below, so neither path can accept the superseded verdict.
   */
  it("refuses a delivery whose condition was replaced after its plan was read", async () => {
    await activate(SEMANTIC_DEFINITION);
    await ingest(FOURTH_EVENT_ID, "event-replanned");

    const request = await admission(FOURTH_EVENT_ID);
    expect(await workspace().sidekickAdmitExternalEvent(request)).toMatchObject({ judge: { conditions: [CONDITION] } });

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
    expect(await workspace().sidekickAdmitExternalEvent({
      ...request,
      conditionVerdict: { admit: true, code: "condition_met", confidence: 0.99, model: "jev-1.13.0" },
    })).toEqual({ admitted: false, outcomeCode: "sidekick_trigger_removed" });
    expect(await workspace().sidekickAdmitExternalEvent({
      ...await admission(FOURTH_EVENT_ID),
      conditionVerdict: { admit: true, code: "condition_met", confidence: 0.99, model: "jev-1.13.0" },
    })).toEqual({ admitted: false, outcomeCode: "sidekick_event_before_activation_boundary" });
    expect(await runCount()).toBe(0);
  });

  /**
   * The fail-open direction, which is the one that reintroduces the defect.
   *
   * The join from a delivery to its conditions is by declared event type, so it
   * comes up empty when a semantic trigger's `deterministicPrefilter.eventType`
   * has drifted from the event type its evaluator rule actually registered. An
   * empty join used to mean "nothing here is gated" and admitted — running the
   * Sidekick with its written condition never applied, and with no outcome code
   * distinguishing that from a clean admission. A definition that gates at all
   * and resolves nothing is refused instead.
   */
  it("refuses rather than admits when a gated Sidekick's condition cannot be resolved for the event", async () => {
    await activate({
      ...SEMANTIC_DEFINITION,
      triggers: [{
        type: "semantic_activity",
        connectorType: "ashby",
        sourceBindingKey: "ashby_events",
        suggestedSourcePluginId: "plugin_ashby",
        // Registered for `applicationSubmit`, declared for something else: the
        // drift this refusal exists for.
        deterministicPrefilter: { eventType: "candidateHire" },
        condition: CONDITION,
      }],
    });
    await ingest(FIFTH_EVENT_ID, "event-unresolved");

    const request = await admission(FIFTH_EVENT_ID);
    expect(await workspace().sidekickAdmitExternalEvent(request)).toEqual({
      admitted: false,
      outcomeCode: "sidekick_semantic_condition_unresolved",
    });
    expect(await runCount()).toBe(0);
  });

  /**
   * The object decides, which means it checks the verdict against itself.
   *
   * `AutomationSemanticConditionVerdictSchema` lets `admit` and `code` disagree,
   * and the delivery path that produces one derives both from a single decision —
   * so this cannot happen today. It is pinned because the doc comments say the
   * object is the authority, and before this the only thing it checked was that a
   * verdict was present.
   */
  it("refuses a verdict whose admit flag disagrees with its code", async () => {
    await activate(SEMANTIC_DEFINITION);
    await ingest(SIXTH_EVENT_ID, "event-incoherent");

    expect(await workspace().sidekickAdmitExternalEvent({
      ...await admission(SIXTH_EVENT_ID),
      conditionVerdict: { admit: true, code: "classifier_unavailable", confidence: null, model: null },
    })).toEqual({ admitted: false, outcomeCode: "sidekick_semantic_classifier_unavailable" });
    expect(await runCount()).toBe(0);
  });

  it("leaves a deterministic activity trigger ungated", async () => {
    await activate(CONNECTOR_DEFINITION);
    await ingest(THIRD_EVENT_ID, "event-deterministic");

    const request = await admission(THIRD_EVENT_ID);
    expect(await workspace().sidekickAdmitExternalEvent(request)).toEqual({
      admitted: true,
      outcomeCode: "sidekick_occurrence_admitted",
    });
    expect(await runCount()).toBe(1);
  });
});
