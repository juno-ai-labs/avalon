/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AutomationDetailSchema, AutomationRunDefinitionV1Schema, AutomationSetEvaluatorRulesInputV1Schema,
  SidekickExecutionDelegationSchema, asUserId, asWorkspaceId, type AutomationDraft,
  WorkspaceExternalEventMatchResultSchema,
} from "@rally/contracts";
import { workspaceDOName } from "../src/durable-objects/names";
import { AUTOMATION_SCHEDULE_ALARM_KIND } from "../src/durable-objects/automation-do-protocol";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { insertChannelRow } from "./helpers/hosted-parent";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000da00");
const creator = asUserId("00000000-0000-7000-8000-00000000da01");
const other = asUserId("00000000-0000-7000-8000-00000000da02");
const automationId = "00000000-0000-7000-8000-00000000da03";
const homeId = "00000000-0000-7000-8000-00000000da04";
const connectionId = "00000000-0000-7000-8000-00000000da05";
const resourceId = "00000000-0000-7000-8000-00000000da06";
const address = { workspaceId, automationId };
const actor = (userId = creator) => ({ userId, actorRole: userId === other ? "admin" as const : "member" as const, participantOfOwningWorkstream: false });
const stub = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
const now = "2026-10-22T20:00:00.000Z";
const definition: AutomationDraft = {
  name: "Content calendar", description: "Report content changes", overview: "Watch the calendar",
  instructions: "Read the calendar and report changes.", triggers: [{ type: "manual" }],
  requiredCapabilities: [], expectedOutputs: [], defaultBehavior: {}, recommendedPlugins: [], memoryTables: [],
  suggestedScope: "workspace", followUpQuestion: null, elicitation: null, ready: true, definitionVersion: 2,
};
useHeldEffectQueue();

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: creator, sessionId: crypto.randomUUID() });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,status,role) VALUES (?,?,'active','admin')").bind(workspaceId, other),
    env.DB.prepare("INSERT INTO users(id,name) VALUES (?,'Other delegate')").bind(other),
  ]);
});

async function create(direct = true, scope: "workspace" | "workstream" = "workspace") {
  await stub().sidekickCreate({ ...address, authorUserId: creator, scope,
    owningWorkstreamId: scope === "workstream" ? homeId : null, authorityGeneration: 1,
    ...(direct ? { creatorConsent: { requestId: crypto.randomUUID() } } : {}),
  });
}

async function consent(userId: typeof creator, allowed: boolean) {
  const request = { ...address, userId, allowed, operationId: crypto.randomUUID() };
  const prepared = await stub().sidekickPrepareMyDelegation(request);
  return stub().sidekickSetMyDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" });
}

async function activate(draft = definition, evaluatorRules: Parameters<ReturnType<typeof stub>["sidekickSubmitDefinition"]>[0]["evaluatorRules"] = null) {
  await stub().sidekickSubmitDefinition({ ...address, draft, evaluatorRules, submittedByRunId: null });
  await stub().sidekickApply({ ...address, actor: actor() });
}

async function runs() {
  return runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{
    run_id: string; coordinator_user_id: string | null; state: string; summary: string | null; opening_json: string | null;
  }>("SELECT run_id,coordinator_user_id,state,summary,opening_json FROM sidekick_runs WHERE sidekick_id=? ORDER BY created_at,run_id", automationId).toArray());
}

async function execution() {
  return SidekickExecutionDelegationSchema.parse(await stub().sidekickReadExecutionDelegation(address));
}

async function webhook() {
  await create();
  await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(`INSERT INTO connector_connections
    (id,workspace_id,connector_type,scope,display_name,model_plugin_id,granted_scopes_json,status,config_json,created_at,updated_at)
    VALUES (?,?,'generic_webhook','workspace','Deploy hook','plugin_webhook','[]','healthy','{"eventTypes":["deploy.finished"]}',?,?)`, connectionId, workspaceId, now, now));
  await activate({ ...definition, triggers: [{ type: "connector_activity", connectorType: "generic_webhook", sourceBindingKey: "deploy_hook",
    suggestedSourcePluginId: "plugin_webhook", eventTypes: ["deploy.finished"], deterministicFilters: {} }] },
  AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: [{ evaluatorKey: "deployed", source: {
    sourceBindingKey: "deploy_hook", suggestedSourcePluginId: "plugin_webhook", event: { kind: "event_type", eventType: "deploy.finished" },
  }, when: { kind: "always" } }] }));
  const registration = await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ registration_id: string }>(
    "SELECT registration_id FROM workspace_external_event_registrations WHERE automation_id=? AND state='active'", automationId,
  ).one());
  return { ...address, registrationId: registration.registration_id, payloadHash: "hash", event: {
    id: crypto.randomUUID(), eventSequence: 1, eventType: "deploy.finished", title: "Private deploy", summary: "A deploy finished",
    textSnippet: "Private deploy details", metadata: {}, occurredAt: Date.now(), audienceKind: "restricted" as const, audienceUserIds: [other],
  } };
}

describe("shared Sidekick delegation admission", () => {
  it("manual Run prefers an eligible requester as coordinator without opting in or replacing legacy access", async () => {
    await create();
    await activate();
    await stub().sidekickRunNow({ ...address, actor: actor(other), idempotencyKey: "manual-without-consent" });
    expect((await runs())[0]?.coordinator_user_id).toBe(creator);
    expect((await execution()).delegates.map((grant) => grant.userId)).toEqual([creator]);
    await consent(other, true);
    const request = { ...address, actor: actor(other), idempotencyKey: "manual-with-consent" };
    const run = await stub().sidekickRunNow(request);
    expect(await stub().sidekickRunNow(request)).toEqual({ ...run, reused: true });
    expect((await runs()).map((row) => row.coordinator_user_id)).toEqual([creator, other]);
    const detail = AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() }));
    expect(detail.runAsUserId).toBe(creator);
    expect(detail.recentRuns.find((row) => row.id === run.runId)?.coordinatorUserId).toBe(other);
  });

  it("keeps a run's coordinator fixed after withdrawal while a new occurrence can use another delegate", async () => {
    await create();
    await activate();
    await consent(other, true);
    const first = await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "first-coordinator" });
    expect(await stub().sidekickContinueRun({ ...address, runId: first.runId })).toMatchObject({ outcome: "continue", executionPrincipal: { type: "user", userId: creator } });
    await consent(creator, false);
    expect(await stub().sidekickContinueRun({ ...address, runId: first.runId })).toEqual({ outcome: "refused", code: "run_coordinator_unavailable" });
    expect(await stub().sidekickReadRunState({ ...address, runId: first.runId })).toMatchObject({ coordinatorEligible: false });
    await stub().sidekickNoteCoordinatorUnavailable({ ...address, runId: first.runId });
    expect((await runs()).find((row) => row.run_id === first.runId)).toMatchObject({ state: "needs_input", summary: expect.stringContaining("coordinating delegate is unavailable") });
    expect(AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() })).delegationAttention?.code).toBe("coordinator_unavailable");
    const second = await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "second-coordinator" });
    expect((await runs()).find((row) => row.run_id === second.runId)?.coordinator_user_id).toBe(other);
    const saved = AutomationRunDefinitionV1Schema.parse(await stub().sidekickReadRunDefinition({ ...address, runId: second.runId }));
    expect(saved).toMatchObject({ coordinatorUserId: other, runAsUserId: creator, accountUserId: creator });
  });

  it("records Needs attention without private input when no delegate is eligible", async () => {
    await create(false);
    await activate();
    await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "no-delegate-manual" });
    expect(await runs()).toEqual([{ run_id: expect.any(String), coordinator_user_id: null, state: "needs_input",
      summary: "Needs attention: no delegated user is available", opening_json: null }]);
    const detail = AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() }));
    expect(detail.delegationStatus).toBe("needs_opt_in");
  });

  it("migrates an established non-creator claim once, retaining its task account and never reviving a withdrawal", async () => {
    await create(false);
    await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(
      "UPDATE automation_directory SET run_as_user_id=?,legacy_account_user_id=?,delegation_migrated=0 WHERE automation_id=?", other, other, automationId,
    ));
    expect(await execution()).toMatchObject({ creatorUserId: creator, accountUserId: other, delegates: [{ userId: other, generation: 1 }] });
    await consent(creator, true);
    await activate();
    await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "legacy-creator-coordinator" });
    expect((await runs())[0]?.coordinator_user_id).toBe(creator);
    await consent(other, false);
    await stub().sidekickPause({ ...address, actor: { ...actor(other), actorRole: "member" } });
    await stub().sidekickResume({ ...address, actor: actor() });
    expect(AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() })).runAsUserId).toBe(other);
    await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec("UPDATE automation_directory SET delegation_migrated=0 WHERE automation_id=?", automationId));
    expect((await execution()).delegates.map((grant) => grant.userId)).toEqual([creator]);
  });

  it("does not turn an ambiguous legacy creator or inherited principal into consent", async () => {
    await create(false);
    await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(
      "UPDATE automation_directory SET legacy_account_user_id=?,delegation_migrated=0 WHERE automation_id=?", creator, automationId,
    ));
    expect(await execution()).toMatchObject({ accountUserId: creator, delegates: [] });
  });

  it("records a blocked hourly occurrence and lets a later occurrence use fresh consent without replaying the blocked one", async () => {
    await create(false);
    await activate({ ...definition, triggers: [{ type: "interval", intervalSeconds: 3600, summary: "Hourly" }] });
    async function tick() {
      await runInDurableObject(stub(), (_instance, state) => {
        const due = Date.now() - 1;
        state.storage.sql.exec("UPDATE sidekick_schedules SET next_due_at=? WHERE sidekick_id=?", due, automationId);
        state.storage.sql.exec("UPDATE _internal_durable_alarms SET due_at=?,retry_at=0 WHERE kind=? AND alarm_key LIKE ?", due, AUTOMATION_SCHEDULE_ALARM_KIND, `${automationId}:%`);
      });
      await runDurableObjectAlarm(stub());
    }
    await tick();
    await expect.poll(async () => (await runs()).map((row) => row.state)).toEqual(["needs_input"]);
    await consent(creator, true);
    await tick();
    await expect.poll(async () => (await runs()).length).toBe(2);
    expect((await runs()).map((row) => ({ coordinator: row.coordinator_user_id, state: row.state }))).toEqual([
      { coordinator: null, state: "needs_input" }, { coordinator: creator, state: "pending" },
    ]);
  });

  it("treats the installed-client claim as self-consent and retains explicit human management after withdrawal", async () => {
    await create();
    await activate();
    expect(await stub().sidekickClaimExecutionPrincipal({ ...address, actor: actor(other) })).toMatchObject({ principalUserId: other, changed: true });
    expect((await execution()).delegates.map((grant) => grant.userId)).toEqual([creator, other]);
    await consent(other, false);
    await stub().sidekickPause({ ...address, actor: { ...actor(other), actorRole: "member" } });
    await stub().sidekickResume({ ...address, actor: actor() });
    expect(AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() })).runAsUserId).toBe(creator);
    expect((await execution()).delegates.map((grant) => grant.userId)).toEqual([creator]);
  });

  it("requires an eligible delegate inside a workspace event's restricted audience, including old queued payloads", async () => {
    const request = await webhook();
    expect(await stub().sidekickAdmitExternalEvent(request)).toEqual({ admitted: false, outcomeCode: "sidekick_no_eligible_delegate" });
    expect(await runs()).toEqual([]);
    await consent(other, true);
    expect(await stub().sidekickAdmitExternalEvent(request)).toMatchObject({ admitted: true });
    expect(await runs()).toEqual([{ run_id: expect.any(String), coordinator_user_id: other, state: "pending",
      summary: null, opening_json: expect.stringContaining("Private deploy details") }]);
  });

  it("rechecks consent at delivery after a matching authorization view has observed an eligible recipient", async () => {
    const request = await webhook();
    await consent(other, true);
    // The delivery was prepared while this recipient was eligible; it arrives later.
    expect((await execution()).delegates.map((grant) => grant.userId)).toContain(other);
    await consent(other, false);
    expect(await stub().sidekickAdmitExternalEvent(request)).toEqual({ admitted: false, outcomeCode: "sidekick_no_eligible_delegate" });
    expect(await runs()).toEqual([]);
  });

  it.each(["workstream", "workspace"] as const)("admits a %s-owned personal Sheet event and an hourly occurrence through the same delegate, then refuses that source after withdrawal", async (scope) => {
    await create(true, scope);
    await runInDurableObject(stub(), (_instance, state) => {
      insertChannelRow(state, homeId, "Content planning");
      state.storage.sql.exec(`INSERT INTO connector_connections(id,workspace_id,connector_type,scope,owner_user_id,
        display_name,model_plugin_id,granted_scopes_json,status,created_at,updated_at)
        VALUES (?,?,'google','personal',?,'Calendar account','plugin_google','["drive.read","sheets.read"]','healthy',?,?)`, connectionId, workspaceId, creator, now, now);
      state.storage.sql.exec(`INSERT INTO resources(id,workspace_id,connection_id,resource_type,provider,provider_resource_id,title,metadata_json,created_at,updated_at)
        VALUES (?,?,?,'google_sheet','google','calendar-sheet','Calendar','{}',?,?)`, resourceId, workspaceId, connectionId, now, now);
    });
    const eventType = "sheets.spreadsheet_changed";
    await activate({ ...definition, suggestedScope: scope, triggers: [
      { type: "connector_activity", connectorType: "google", sourceBindingKey: "calendar_sheet", suggestedSourcePluginId: "plugin_google", eventTypes: [eventType], deterministicFilters: {} },
      { type: "interval", intervalSeconds: 3600, summary: "Hourly" },
    ] }, AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: [{ evaluatorKey: "calendar_changed",
      source: { sourceBindingKey: "calendar_sheet", suggestedSourcePluginId: "plugin_google", resourceId, event: { kind: "event_type", eventType } }, when: { kind: "always" },
    }] }));
    async function event(providerEventId: string) {
      const id = crypto.randomUUID();
      await stub().ingestConnectorEvent({ workspaceId, ingressEventId: id, payloadHash: `sha256:${"a".repeat(64)}`, event: { connectorType: "google", activity: {
        id, workspaceId, region: "global", connectionId, connectionScope: "personal", connectionOwnerUserId: creator,
        provider: "google", providerEventId, eventType, resourceType: "google_sheet", providerResourceId: "calendar-sheet",
        actor: {}, subject: {}, occurredAt: now, receivedAt: now, title: "Calendar changed", summary: "Private change", textSnippet: `Private sheet content ${providerEventId}`,
        payloadRef: null, visibility: { kind: "personal" }, targetUserIds: [], entityKeys: [], dedupeKey: providerEventId, rawContentHash: providerEventId, metadata: { revision: providerEventId }, externalPeople: [],
      } } });
      return WorkspaceExternalEventMatchResultSchema.parse(await stub().matchExternalEventDestinations({ workspaceId, eventId: id }));
    }
    const matched = await event("calendar-change-1");
    expect(matched.deliveries).toHaveLength(1);
    const delivery = matched.deliveries[0]!;
    expect(await stub().sidekickAdmitExternalEvent({ ...address, registrationId: delivery.registrationId, event: delivery.event, payloadHash: delivery.payloadHash })).toMatchObject({ admitted: true });
    await runInDurableObject(stub(), (_instance, state) => {
      const due = Date.now() - 1;
      state.storage.sql.exec("UPDATE sidekick_schedules SET next_due_at=? WHERE sidekick_id=?", due, automationId);
      state.storage.sql.exec("UPDATE _internal_durable_alarms SET due_at=?,retry_at=0 WHERE kind=? AND alarm_key LIKE ?", due, AUTOMATION_SCHEDULE_ALARM_KIND, `${automationId}:%`);
    });
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => (await runs()).length).toBe(2);
    expect((await runs()).map((run) => run.coordinator_user_id)).toEqual([creator, creator]);
    if (scope === "workspace") await consent(other, true);
    await consent(creator, false);
    expect((await event("calendar-change-2")).deliveries).toEqual([]);
    expect(AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() })).delegationAttention?.code).toBe("event_no_eligible_delegate");
    expect(await stub().sidekickAdmitExternalEvent({ ...address, registrationId: delivery.registrationId,
      event: { ...delivery.event, id: crypto.randomUUID() }, payloadHash: delivery.payloadHash })).toMatchObject({ admitted: false, outcomeCode: "sidekick_no_eligible_delegate" });
    expect(await runs()).toHaveLength(2);
  });
});
