/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutomationDetailSchema, AutomationRunDefinitionV1Schema, AutomationSetEvaluatorRulesInputV1Schema,
  SidekickExecutionDelegationSchema, asUserId, asWorkspaceId, type AutomationDraft,
  WorkspaceExternalEventMatchResultSchema,
} from "@rally/contracts";
import { HostedSidekick } from "../src/durable-objects/hosted-sidekick";
import { workspaceDOName } from "../src/durable-objects/names";
import { AUTOMATION_SCHEDULE_ALARM_KIND } from "../src/durable-objects/automation-do-protocol";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { insertChannelRow } from "./helpers/hosted-parent";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { queueSidekickSourceReconciliation } from "../src/durable-objects/sidekick-source-registrations";
import { ScheduledAlarmStore } from "../src/durable-objects/scheduled-alarms";

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
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: creator, sessionId: crypto.randomUUID() });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,status,role) VALUES (?,?,'active','admin')").bind(workspaceId, other),
    env.DB.prepare("INSERT INTO users(id,name) VALUES (?,'Other delegate')").bind(other),
  ]);
});

async function create(withCreator = true, scope: "workspace" | "workstream" = "workspace") {
  await stub().sidekickCreate({ ...address, authorUserId: creator, scope,
    owningWorkstreamId: scope === "workstream" ? homeId : null, authorityGeneration: 1,
  });
  if (!withCreator) await consent(creator, false);
}

async function consent(userId: typeof creator, allowed: boolean) {
  const request = { ...address, userId, allowed, operationId: crypto.randomUUID() };
  const prepared = await stub().sidekickPrepareMyDelegation(request);
  return stub().sidekickSetDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" });
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

async function webhook(evaluatorKeys = ["deployed"]) {
  await create();
  await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(`INSERT INTO connector_connections
    (id,workspace_id,connector_type,scope,display_name,model_plugin_id,granted_scopes_json,status,config_json,created_at,updated_at)
    VALUES (?,?,'generic_webhook','workspace','Deploy hook','plugin_webhook','[]','healthy','{"eventTypes":["deploy.finished"]}',?,?)`, connectionId, workspaceId, now, now));
  await activate({ ...definition, triggers: [{ type: "connector_activity", connectorType: "generic_webhook", sourceBindingKey: "deploy_hook",
    suggestedSourcePluginId: "plugin_webhook", eventTypes: ["deploy.finished"], deterministicFilters: {} }] },
  AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: evaluatorKeys.map((evaluatorKey) => ({ evaluatorKey, source: {
    sourceBindingKey: "deploy_hook", suggestedSourcePluginId: "plugin_webhook", event: { kind: "event_type", eventType: "deploy.finished" },
  }, when: { kind: "always" } })) }));
  const registration = await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ registration_id: string }>(
    "SELECT registration_id FROM workspace_external_event_registrations WHERE automation_id=? AND state='active'", automationId,
  ).toArray()[0]!);
  return { ...address, registrationId: registration.registration_id, payloadHash: "hash", event: {
    id: crypto.randomUUID(), eventSequence: 1, eventType: "deploy.finished", title: "Private deploy", summary: "A deploy finished",
    textSnippet: "Private deploy details", metadata: {}, occurredAt: Date.now(), audienceKind: "restricted" as const, audienceUserIds: [other],
  } };
}

describe("shared Sidekick delegation admission", () => {
  it("reads details without scanning delegate eligibility", async () => {
    await create();
    await consent(other, true);
    const eligibility = vi.spyOn(HostedSidekick.prototype, "delegationEligible");
    const detail = AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() }));
    expect(detail.authorUserId).toBe(creator);
    expect(eligibility).not.toHaveBeenCalled();
  });

  it("checks only the preferred delegate for manual and personal-event admission", async () => {
    const request = await webhook();
    await consent(other, true);
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM _internal_durable_alarms WHERE kind='sidekick_delegation_sources'",
    ).one().count)).toBe(0);
    const eligibility = vi.spyOn(HostedSidekick.prototype, "delegationEligible");
    const manual = await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "preferred-only" });
    expect((await runs()).find((run) => run.run_id === manual.runId)?.coordinator_user_id).toBe(creator);
    expect(await stub().sidekickAdmitExternalEvent({ ...request, event: { ...request.event,
      sourceConnectionScope: "personal", sourceConnectionOwnerUserId: creator, audienceUserIds: [creator],
    } })).toMatchObject({ admitted: true });
    expect(eligibility.mock.calls.length).toBeGreaterThan(0);
    expect(eligibility.mock.calls.every(([grant]) => grant.userId === creator)).toBe(true);
  });

  it("shares pending eligibility across matching evaluators only within one request", async () => {
    await webhook(["deployed", "also_deployed"]);
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM _internal_durable_alarms WHERE kind='sidekick_delegation_sources'",
    ).one().count)).toBe(0);
    const eventId = crypto.randomUUID();
    await stub().ingestConnectorEvent({ workspaceId, ingressEventId: eventId, payloadHash: `sha256:${"a".repeat(64)}`, event: {
      connectorType: "generic_webhook", activity: {
        id: eventId, workspaceId, region: "global", connectionId, connectionScope: "workspace", connectionOwnerUserId: null,
        provider: "generic_webhook", providerEventId: eventId, eventType: "deploy.finished", resourceType: null, providerResourceId: null,
        actor: {}, subject: {}, occurredAt: now, receivedAt: now, title: "Deployed", summary: "Deploy finished", textSnippet: "Deploy finished",
        payloadRef: null, visibility: { kind: "workspace" }, targetUserIds: [], entityKeys: [], dedupeKey: eventId,
        rawContentHash: null, metadata: {}, externalPeople: [],
      },
    } });
    const eligibility = vi.spyOn(HostedSidekick.prototype, "delegationEligible");
    const match = async () => WorkspaceExternalEventMatchResultSchema.parse(await stub().matchExternalEventDestinations({ workspaceId, eventId }));
    const first = await match();
    expect(first.deliveries).toHaveLength(2);
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect((await match()).deliveries).toHaveLength(2);
    expect(eligibility).toHaveBeenCalledTimes(2);
    await consent(creator, false);
    const delivery = first.deliveries[0]!;
    expect(await stub().sidekickAdmitExternalEvent({ ...address, registrationId: delivery.registrationId,
      event: delivery.event, payloadHash: delivery.payloadHash })).toMatchObject({ admitted: false, outcomeCode: "sidekick_no_eligible_delegate" });
    expect((await match()).deliveries).toEqual([]);
  });

  it("clears restored source coverage without clearing an unrelated permission warning", async () => {
    await webhook();
    const attention = async () => AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() })).delegationAttention;
    await consent(creator, false);
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => (await attention())?.code).toBe("event_no_eligible_delegate");
    await consent(creator, true);
    await runDurableObjectAlarm(stub());
    await expect.poll(attention).toBeNull();
    await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(
      "UPDATE automation_directory SET delegation_attention_code='permission_report_unavailable' WHERE automation_id=?", automationId));
    await consent(other, true);
    await runDurableObjectAlarm(stub());
    expect((await attention())?.code).toBe("permission_report_unavailable");
  });

  it("does not clear a source warning when an unrelated manual run is admitted", async () => {
    await create();
    await activate();
    await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(
      "UPDATE automation_directory SET delegation_attention_code='event_no_eligible_delegate' WHERE automation_id=?", automationId));
    await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "manual-with-source-warning" });
    expect(AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() })).delegationAttention?.code)
      .toBe("event_no_eligible_delegate");
  });

  it("does not turn a legacy claim into permanent manager access", async () => {
    await create();
    await activate();
    await stub().sidekickClaimExecutionPrincipal({ ...address, actor: actor(other) });
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickPause({ ...address, actor: { ...actor(other), actorRole: "member" } }))
        .rejects.toMatchObject({ status: 403 });
    });
    expect((await execution()).delegates.map((grant) => grant.userId)).toContain(other);
  });

  it("coalesces source changes without losing a wake behind an older handler", async () => {
    await webhook();
    const observed = await runInDurableObject(stub(), (_instance, state) => {
      const alarms = new ScheduledAlarmStore(state.storage.sql);
      const kind = "sidekick_delegation_sources", key = `${automationId}:sources`;
      alarms.cancelKind(kind);
      const dueAt = Date.now() + 60_000;
      alarms.schedule({ kind, key, dueAt });
      const running = alarms.get(kind, key)!;
      state.storage.sql.exec("UPDATE connector_connections SET status='disabled' WHERE id=?", connectionId);
      const connectionWake = alarms.get(kind, key)!;
      state.storage.sql.exec("UPDATE connector_connections SET status='healthy' WHERE id=?", connectionId);
      queueSidekickSourceReconciliation(state.storage, automationId);
      const latest = alarms.get(kind, key)!;
      const pending = alarms.list(kind).length;
      alarms.settle(running, Date.now());
      const afterOlderHandler = alarms.list(kind).length;
      alarms.settle(latest, Date.now());
      return { pending, connectionAdvance: connectionWake.dueAt - dueAt,
        totalAdvance: latest.dueAt - dueAt, afterOlderHandler, afterLatestHandler: alarms.list(kind).length };
    });
    expect(observed).toEqual({ pending: 1, connectionAdvance: 1, totalAdvance: 3,
      afterOlderHandler: 1, afterLatestHandler: 0 });
  });

  it.each([false, true])("reconciles configured files, queued events and shared occurrences (connection added later: %s)", async (lateConnection) => {
    await create();
    const secondConnection = crypto.randomUUID(), unconsentedConnection = crypto.randomUUID(), wrongResource = crypto.randomUUID();
    await runInDurableObject(stub(), (_instance, state) => {
      for (const [id, owner] of [[connectionId, creator], [secondConnection, other], [unconsentedConnection, crypto.randomUUID()]]) {
        state.storage.sql.exec(`INSERT INTO connector_connections(id,workspace_id,connector_type,scope,owner_user_id,
          display_name,model_plugin_id,granted_scopes_json,status,created_at,updated_at)
          VALUES (?,?,'google','personal',?,'Calendar account',?,'["drive.read","sheets.read"]',?,?,?)`,
        id!, workspaceId, owner!, id === connectionId ? "plugin_google" : `plugin_${id!.replaceAll("-", "")}`,
        id === secondConnection && lateConnection ? "disabled" : "healthy", now, now);
      }
      for (const [id, connection, file] of [[resourceId, connectionId, "configured-sheet"], [wrongResource, secondConnection, "another-sheet"]]) {
        state.storage.sql.exec(`INSERT INTO resources(id,workspace_id,connection_id,resource_type,provider,provider_resource_id,title,metadata_json,created_at,updated_at)
          VALUES (?,?,?,'google_sheet','google',?,'Same title','{}',?,?)`, id!, workspaceId, connection!, file!, now, now);
      }
    });
    const eventType = "sheets.spreadsheet_changed";
    await activate({ ...definition, triggers: [{ type: "connector_activity", connectorType: "google", sourceBindingKey: "sheet",
      suggestedSourcePluginId: "plugin_google", eventTypes: [eventType], deterministicFilters: {} }] },
    AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: [{ evaluatorKey: "changed", source: {
      sourceBindingKey: "sheet", suggestedSourcePluginId: "plugin_google", resourceId, event: { kind: "event_type", eventType },
    }, when: { kind: "always" } }] }));
    const registrations = () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{
      registration_id: string; connection_id: string; resource_id: string; effective_after_event_sequence: number;
    }>(`SELECT registration_id,connection_id,resource_id,effective_after_event_sequence FROM workspace_external_event_registrations
          WHERE automation_id=? AND state='active' ORDER BY connection_id`, automationId).toArray());
    async function changed(connection: string, version: string, file = "configured-sheet") {
      const id = crypto.randomUUID();
      await stub().ingestConnectorEvent({ workspaceId, ingressEventId: id, payloadHash: `sha256:${"a".repeat(64)}`, event: { connectorType: "google", activity: {
        id, workspaceId, region: "global", connectionId: connection, connectionScope: "personal", connectionOwnerUserId: connection === connectionId ? creator : other,
        provider: "google", providerEventId: `${file}:${version}`, occurrenceKey: `google:${eventType}:drive:${file}:${version}`,
        eventType, resourceType: "google_sheet", providerResourceId: file, actor: {}, subject: { fileId: file },
        occurredAt: now, receivedAt: now, title: "Same title", summary: "Sheet changed", textSnippet: version, payloadRef: null,
        visibility: { kind: "personal" }, targetUserIds: [], entityKeys: [], dedupeKey: `${file}:${version}`, rawContentHash: version,
        metadata: { modifiedTime: version }, externalPeople: [],
      } } });
      return WorkspaceExternalEventMatchResultSchema.parse(await stub().matchExternalEventDestinations({ workspaceId, eventId: id }));
    }
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM _internal_durable_alarms WHERE kind='sidekick_delegation_sources'",
    ).one().count)).toBe(0);
    const queued = (await changed(connectionId, "v1")).deliveries[0]!;
    const original = (await registrations()).find((entry) => entry.connection_id === connectionId)!;
    if (!lateConnection) {
      const request = { ...address, userId: other, allowed: true, operationId: crypto.randomUUID() };
      const prepared = await stub().sidekickPrepareMyDelegation(request);
      await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(`CREATE TRIGGER fail_source_wake
        BEFORE INSERT ON _internal_durable_alarms WHEN NEW.kind='sidekick_delegation_sources'
        BEGIN SELECT RAISE(ABORT,'source_wake_fault'); END`));
      await runInDurableObject(stub(), async (instance) => {
        await expect(instance.sidekickSetDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" }))
          .rejects.toThrow("source_wake_fault");
      });
      expect((await execution()).delegates.map((grant) => grant.userId)).toEqual([creator]);
      expect(await stub().sidekickReadMyDelegationReceipt({ ...request, source: "self_service" })).toEqual({ outcome: "missing" });
      await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec("DROP TRIGGER fail_source_wake"));
      await stub().sidekickSetDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" });
    } else await consent(other, true);
    await runDurableObjectAlarm(stub());
    if (lateConnection) {
      expect(await registrations()).toHaveLength(1);
      const parkedAlarm = Date.now() + 3_600_000;
      await runInDurableObject(stub(), async (_instance, state) => { await state.storage.setAlarm(parkedAlarm); });
      const connected = await stub().executeRuntimeSql({ workspaceId, requestId: crypto.randomUUID(), statements: [{
        sql: "UPDATE connector_connections SET status='healthy' WHERE id=?", params: [secondConnection],
      }] });
      expect(connected.status).toBe(200);
      const wake = await runInDurableObject(stub(), async (_instance, state) => state.storage.getAlarm());
      // An already fired source wake is also observable in the registered set.
      if (wake === null) expect(await registrations()).toHaveLength(2);
      else expect(wake).toBeLessThan(parkedAlarm);
      await runDurableObjectAlarm(stub());
    }
    await expect.poll(async () => (await registrations()).length).toBe(2);
    const expanded = await registrations();
    expect(expanded.find((entry) => entry.connection_id === connectionId)).toEqual(original);
    const alias = expanded.find((entry) => entry.connection_id === secondConnection)!;
    expect(alias.resource_id).not.toBe(resourceId);
    expect(alias.resource_id).not.toBe(wrongResource);
    expect(expanded.some((entry) => entry.connection_id === unconsentedConnection)).toBe(false);
    expect(WorkspaceExternalEventMatchResultSchema.parse(await stub().matchExternalEventDestinations({
      workspaceId, eventId: queued.event.id,
    })).deliveries).toHaveLength(1);
    const admit = (delivery: typeof queued) => stub().sidekickAdmitExternalEvent({ ...address, registrationId: delivery.registrationId,
      event: delivery.event, payloadHash: delivery.payloadHash });
    expect(await admit(queued)).toMatchObject({ admitted: true, outcomeCode: "sidekick_occurrence_admitted" });
    const observedAgain = (await changed(secondConnection, "v1")).deliveries;
    expect(observedAgain).toHaveLength(1);
    expect(await admit(observedAgain[0]!)).toMatchObject({ admitted: true, outcomeCode: "sidekick_occurrence_replayed" });
    expect(await runs()).toHaveLength(1);
    expect((await changed(secondConnection, "unrelated", "another-sheet")).deliveries).toEqual([]);
    await consent(creator, false);
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => (await registrations()).map((entry) => entry.connection_id)).toEqual([secondConnection]);
    expect(await admit(queued)).toMatchObject({ admitted: false, outcomeCode: "sidekick_no_eligible_delegate" });
    const next = (await changed(secondConnection, "v2")).deliveries;
    expect(next).toHaveLength(1);
    expect(await admit(next[0]!)).toMatchObject({ admitted: true });
    expect((await runs()).map((run) => run.coordinator_user_id)).toEqual([creator, other]);
    expect((await execution()).delegates.map((grant) => grant.userId)).toEqual([other]);
    await stub().applyMemberStatus({ workspaceId, sequence: 1, removed: true, relationship: {
      workspaceId, userId: other, status: "active", role: "admin", accessClass: "member", incarnation: "existing-member", revision: 1,
    } });
    await runDurableObjectAlarm(stub());
    await expect.poll(registrations).toEqual([]);
    expect((await execution()).delegates).toEqual([]);
  });

  it("admits a personal event through its source owner and keeps its registration on that connection", async () => {
    // The held effect queue keeps these assertions before inference.
    await create();
    await consent(other, true);
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO connector_connections(id,workspace_id,connector_type,scope,owner_user_id,
        display_name,model_plugin_id,granted_scopes_json,status,created_at,updated_at)
        VALUES (?,?,'google','personal',?,'Maya mail','plugin_google','["gmail.read"]','healthy',?,?)`, connectionId, workspaceId, other, now, now);
      state.storage.sql.exec(`INSERT INTO resources(id,workspace_id,connection_id,resource_type,provider,provider_resource_id,title,metadata_json,created_at,updated_at)
        VALUES (?,?,?,'gmail_thread','google','source-thread','Mail thread','{}',?,?)`, resourceId, workspaceId, connectionId, now, now);
    });
    const eventType = "email.received";
    await activate({ ...definition, triggers: [{ type: "connector_activity", connectorType: "google", sourceBindingKey: "mail",
      suggestedSourcePluginId: "plugin_google", eventTypes: [eventType], deterministicFilters: {} }] },
    AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: [{ evaluatorKey: "received", source: {
      sourceBindingKey: "mail", suggestedSourcePluginId: "plugin_google", event: { kind: "event_type", eventType },
      resourceId,
    }, when: { kind: "always" } }] }));
    await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(`INSERT INTO connector_connections
      (id,workspace_id,connector_type,scope,owner_user_id,display_name,model_plugin_id,granted_scopes_json,status,created_at,updated_at)
      VALUES (?,?,'google','personal',?,'Another inbox','plugin_other_mail','["gmail.read"]','healthy',?,?)`,
    crypto.randomUUID(), workspaceId, creator, now, now));
    await runDurableObjectAlarm(stub());
    expect(await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ connection_id: string }>(
      "SELECT connection_id FROM workspace_external_event_registrations WHERE automation_id=? AND state='active'", automationId).toArray()))
      .toEqual([{ connection_id: connectionId }]);
    const eventId = crypto.randomUUID();
    await stub().ingestConnectorEvent({ workspaceId, ingressEventId: eventId, payloadHash: `sha256:${"b".repeat(64)}`, event: {
      connectorType: "google", activity: { id: eventId, workspaceId, region: "global", connectionId, connectionScope: "personal", connectionOwnerUserId: other,
        provider: "google", providerEventId: "mail-change", eventType, resourceType: "gmail_thread", providerResourceId: "source-thread",
        actor: {}, subject: { messageId: "source-message", threadId: "source-thread" }, occurredAt: now, receivedAt: now,
        title: "Mail received", summary: "New mail", textSnippet: "Read the source-message", payloadRef: null,
        visibility: { kind: "personal" }, targetUserIds: [], entityKeys: [], dedupeKey: "mail-change", rawContentHash: null,
        metadata: { sourceAccount: { connectionId: "forged", resourceKeys: ["google:message:other"] } }, externalPeople: [],
      },
    } });
    const matched = WorkspaceExternalEventMatchResultSchema.parse(await stub().matchExternalEventDestinations({ workspaceId, eventId }));
    const delivery = matched.deliveries[0]!;
    expect(delivery).toBeDefined();
    // An older queue envelope omits source identity. The event row still owns it.
    const oldEvent = { ...delivery.event };
    delete oldEvent.sourceConnectionId;
    delete oldEvent.sourceConnectionScope;
    delete oldEvent.sourceConnectionOwnerUserId;
    expect(await stub().sidekickAdmitExternalEvent({ ...address, registrationId: delivery.registrationId, event: oldEvent, payloadHash: delivery.payloadHash }))
      .toMatchObject({ admitted: true });
    const run = (await runs())[0]!;
    expect(run.coordinator_user_id).toBe(other);
  });

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

  it("replaces an unavailable coordinator for continuation and persists it for later reads", async () => {
    await create();
    await activate();
    await consent(other, true);
    const first = await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "first-coordinator" });
    expect(await stub().sidekickContinueRun({ ...address, runId: first.runId })).toMatchObject({ outcome: "continue", executionPrincipal: { type: "user", userId: creator } });
    await consent(creator, false);
    expect(await stub().sidekickContinueRun({ ...address, runId: first.runId })).toMatchObject({ outcome: "continue", executionPrincipal: { type: "user", userId: other } });
    expect((await runs()).find((row) => row.run_id === first.runId)?.coordinator_user_id).toBe(other);
    expect(AutomationRunDefinitionV1Schema.parse(await stub().sidekickReadRunDefinition({ ...address, runId: first.runId }))).toMatchObject({ coordinatorUserId: other });
    const second = await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "second-coordinator" });
    expect((await runs()).find((row) => row.run_id === second.runId)?.coordinator_user_id).toBe(other);
    const saved = AutomationRunDefinitionV1Schema.parse(await stub().sidekickReadRunDefinition({ ...address, runId: second.runId }));
    expect(saved).toMatchObject({ coordinatorUserId: other, runAsUserId: creator });
  });

  it("records Needs attention without private input when no delegate is eligible", async () => {
    await create(false);
    await activate();
    await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "no-delegate-manual" });
    expect(await runs()).toEqual([{ run_id: expect.any(String), coordinator_user_id: null, state: "needs_input",
      summary: "Needs attention: no delegated user is available", opening_json: null }]);
    const detail = AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() }));
    expect(detail.delegationAttention).toMatchObject({ code: "no_eligible_delegate" });
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

  it("preserves a creator withdrawal during legacy migration", async () => {
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

  it("treats the installed-client claim as self-consent without adding human management rights", async () => {
    await create();
    await activate();
    expect(await stub().sidekickClaimExecutionPrincipal({ ...address, actor: actor(other) })).toMatchObject({ principalUserId: other, changed: true });
    expect((await execution()).delegates.map((grant) => grant.userId)).toEqual([creator, other]);
    await consent(other, false);
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickPause({ ...address, actor: { ...actor(other), actorRole: "member" } }))
        .rejects.toMatchObject({ status: 403 });
    });
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
