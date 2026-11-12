/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutomationDetailSchema, AutomationRunDefinitionV1Schema, AutomationSetEvaluatorRulesInputV1Schema,
  SidekickExecutionDelegationSchema, SidekickSourcesResultSchema, asUserId, asWorkspaceId, type AutomationDraft,
  WorkspaceExternalEventMatchResultSchema,
} from "@rally/contracts";
import { HostedSidekick } from "../src/durable-objects/hosted-sidekick";
import { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { workspaceDOName } from "../src/durable-objects/names";
import { AUTOMATION_SCHEDULE_ALARM_KIND } from "../src/durable-objects/automation-do-protocol";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { queueSidekickSourceReconciliation } from "../src/durable-objects/sidekick-source-registrations";
import { ScheduledAlarmStore } from "../src/durable-objects/scheduled-alarms";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000da00");
const creator = asUserId("00000000-0000-7000-8000-00000000da01");
const other = asUserId("00000000-0000-7000-8000-00000000da02");
const automationId = "00000000-0000-7000-8000-00000000da03";
const connectionId = "00000000-0000-7000-8000-00000000da05";
const resourceId = "00000000-0000-7000-8000-00000000da06";
const address = { workspaceId, automationId };
const actor = (userId = creator) => ({ userId, actorRole: userId === other ? "admin" as const : "member" as const, participantOfOwningWorkstream: false });
const stub = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
const now = "2026-10-22T20:00:00.000Z";
const SOURCE_RECONCILIATION_TIMEOUT_MS = 15_000;
const definition: AutomationDraft = {
  name: "Content calendar", description: "Report content changes", overview: "Watch the calendar",
  instructions: "Read the calendar and report changes.", triggers: [{ type: "manual" }],
  requiredCapabilities: [], expectedOutputs: [], defaultBehavior: {}, recommendedPlugins: [], memoryTables: [], customTools: [],
  suggestedScope: "workspace", followUpQuestion: null, elicitation: null, ready: true, definitionVersion: 2,
};
useHeldEffectQueue();
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: creator, sessionId: crypto.randomUUID() });
  // This suite's D1 starts with no schema: a source request's view reads each person's presentation.
  await env.DB.exec("ALTER TABLE users ADD COLUMN presentation_json TEXT");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,status,role) VALUES (?,?,'active','admin')").bind(workspaceId, other),
    env.DB.prepare("INSERT INTO users(id,name) VALUES (?,'Other delegate')").bind(other),
  ]);
});

async function create(withCreator = true, scope: "workspace" = "workspace") {
  await stub().sidekickCreate({ ...address, authorUserId: creator, scope, authorityGeneration: 1 });
  if (!withCreator) await consent(creator, false);
}

async function consent(userId: typeof creator, allowed: boolean) {
  const request = { ...address, userId, allowed, operationId: crypto.randomUUID() };
  const prepared = await stub().sidekickPrepareMyDelegation(request);
  return stub().sidekickSetDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" });
}

/** `owner` lets one connector's events start the Sidekick: the creator asks, and only the owner answers. */
async function letIn(owner: typeof creator, connectorType: string, eventType: string) {
  const asked = await stub().sidekickRequestSources({ ...address, actor: actor(), actorName: "Creator",
    ask: { userIds: [owner], connectorType, eventTypes: [eventType] } });
  const approval = { ...address, requestId: asked.requests[0]!.requestId, userId: owner, decision: "approve" as const };
  await stub().sidekickDecideSourceRequest(approval);
  return approval;
}

const withdrawSource = (userId: typeof creator, connection = connectionId) =>
  stub().sidekickWithdrawSource({ ...address, userId, connectionId: connection });

const sourceOwners = async () => SidekickSourcesResultSchema.parse(await stub().sidekickReadSources({ ...address, actor: actor() }))
  .sources.filter((source) => source.available).map((source) => source.person.userId);

/** Run the reconciliation a source or connection change queued, to its end. */
async function reconciled() {
  await runDurableObjectAlarm(stub());
  await expect.poll(async () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
    "SELECT count(*) AS count FROM _internal_durable_alarms WHERE kind='sidekick_delegation_sources'",
  ).one().count), { timeout: SOURCE_RECONCILIATION_TIMEOUT_MS }).toBe(0);
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

/**
 * A run's start was handed to provisioning: starting it is what records its
 * conversation, and a blocked run has none. Waited for as long as a
 * reconciliation is, since both are the object's alarm draining.
 */
async function started(runId: string) {
  await expect.poll(async () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
    "SELECT count(*) AS count FROM sidekick_children WHERE sidekick_id=? AND substream_id=?", automationId, runId,
  ).one().count), { timeout: SOURCE_RECONCILIATION_TIMEOUT_MS }).toBe(1);
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

const mailEvent = "email.received";

/** A Sidekick watching new mail on its creator's own Gmail: saving the rule there is the creator's own source. */
async function mailbox(evaluatorKeys = ["received"]) {
  await create();
  await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(`INSERT INTO connector_connections
    (id,workspace_id,connector_type,scope,owner_user_id,display_name,model_plugin_id,granted_scopes_json,status,created_at,updated_at)
    VALUES (?,?,'google','personal',?,'Creator mail','plugin_google','["gmail.read"]','healthy',?,?)`, connectionId, workspaceId, creator, now, now));
  await activate({ ...definition, triggers: [{ type: "connector_activity", connectorType: "google", sourceBindingKey: "mail",
    suggestedSourcePluginId: "plugin_google", eventTypes: [mailEvent], deterministicFilters: {} }] },
  AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: evaluatorKeys.map((evaluatorKey) => ({ evaluatorKey, source: {
    sourceBindingKey: "mail", suggestedSourcePluginId: "plugin_google", event: { kind: "event_type", eventType: mailEvent },
  }, when: { kind: "always" } })) }));
}

/** Somebody's read of one person's place in the Organization, counted where every such read goes through. */
type RelationshipReads = { readRelationship(workspaceId: string, userId: string): Promise<unknown> };

describe("shared Sidekick delegation admission", () => {
  it("reads details without scanning delegate eligibility", async () => {
    await create();
    await consent(other, true);
    const eligibility = vi.spyOn(HostedSidekick.prototype, "delegationEligible");
    const detail = AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() }));
    expect(detail.authorUserId).toBe(creator);
    expect(eligibility).not.toHaveBeenCalled();
  });

  it("checks only the delegate it picks to coordinate, for a manual run and for an admitted event", async () => {
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

  it.each([false, true].flatMap((legacy) => [false, true].map((previouslyAdmitted) => ({ legacy, previouslyAdmitted }))))(
    "shares one request's relationship reads across its sources and fences reactivated sources (admitted: $previouslyAdmitted, legacy: $legacy)", async ({ previouslyAdmitted, legacy }) => {
    await mailbox(["received", "also_received"]);
    if (legacy) await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(
      "UPDATE sidekick_revisions SET definition_json=json_remove(definition_json,'$.definitionVersion') WHERE sidekick_id=?", automationId,
    ));
    await reconciled();
    const eventId = crypto.randomUUID();
    await stub().ingestConnectorEvent({ workspaceId, ingressEventId: eventId, payloadHash: `sha256:${"a".repeat(64)}`, event: {
      connectorType: "google", activity: {
        id: eventId, workspaceId, region: "global", connectionId, connectionScope: "personal", connectionOwnerUserId: creator,
        provider: "google", providerEventId: eventId, eventType: mailEvent, resourceType: "gmail_thread", providerResourceId: `thread-${eventId}`,
        actor: {}, subject: { messageId: `message-${eventId}`, threadId: `thread-${eventId}` }, occurredAt: now, receivedAt: now,
        title: "Mail received", summary: "New mail", textSnippet: "New mail", payloadRef: null,
        visibility: { kind: "personal" }, targetUserIds: [], entityKeys: [], dedupeKey: eventId,
        rawContentHash: null, metadata: {}, externalPeople: [],
      },
    } });
    // Delegation is not asked whose events these are; the source's owner is read once for both registrations.
    const delegation = vi.spyOn(HostedSidekick.prototype, "delegationEligible");
    const relationships = vi.spyOn(WorkspaceDO.prototype as unknown as RelationshipReads, "readRelationship");
    const ownerReads = () => relationships.mock.calls.filter(([, userId]) => userId === creator).length;
    const match = async () => WorkspaceExternalEventMatchResultSchema.parse(await stub().matchExternalEventDestinations({ workspaceId, eventId }));
    const first = await match();
    expect(first.deliveries).toHaveLength(2);
    expect(ownerReads()).toBe(1);
    expect((await match()).deliveries).toHaveLength(2);
    expect(ownerReads()).toBe(2);
    expect(delegation).not.toHaveBeenCalled();
    const delivery = first.deliveries[0]!;
    const admit = () => stub().sidekickAdmitExternalEvent({ ...address, registrationId: delivery.registrationId,
      event: delivery.event, payloadHash: delivery.payloadHash });
    if (previouslyAdmitted) expect(await admit()).toMatchObject({ admitted: true });
    // Withdrawing delegation takes nothing away from a source.
    await consent(creator, false);
    expect((await match()).deliveries).toHaveLength(2);
    await consent(creator, true);
    await withdrawSource(creator);
    expect(await admit()).toMatchObject({ admitted: false });
    expect((await match()).deliveries).toEqual([]);
    const registrationStates = () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{
      state: string; effective_after_event_sequence: number;
    }>("SELECT state,effective_after_event_sequence FROM workspace_external_event_registrations WHERE automation_id=? ORDER BY registration_id", automationId).toArray());
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => (await registrationStates()).map((registration) => registration.state), { timeout: SOURCE_RECONCILIATION_TIMEOUT_MS })
      .toEqual(["removed", "removed"]);
    // The current durable source state must fence an envelope already in flight.
    expect(await admit()).toMatchObject({ admitted: false });
    await letIn(creator, "google", mailEvent);
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => (await registrationStates()).map((registration) => registration.state), { timeout: SOURCE_RECONCILIATION_TIMEOUT_MS })
      .toEqual(["active", "active"]);
    expect((await registrationStates()).every((registration) => registration.effective_after_event_sequence >= delivery.event.eventSequence)).toBe(true);
    expect(await admit()).toMatchObject(previouslyAdmitted
      ? { admitted: true, outcomeCode: "sidekick_occurrence_replayed" }
      : { admitted: false, outcomeCode: "sidekick_event_before_activation_boundary" });
    expect(await runs()).toHaveLength(previouslyAdmitted ? 1 : 0);
  });

  it.each([false, true])("refuses delayed delivery after a disabled connection's registration is removed (legacy: %s)", async (legacy) => {
    const request = await webhook();
    if (legacy) await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(
      "UPDATE sidekick_revisions SET definition_json=json_remove(definition_json,'$.definitionVersion') WHERE sidekick_id=?", automationId,
    ));
    await stub().executeRuntimeSql({ workspaceId, requestId: crypto.randomUUID(), statements: [{
      sql: "UPDATE connector_connections SET status='disabled' WHERE id=?", params: [connectionId],
    }] });
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ state: string }>(
      "SELECT state FROM workspace_external_event_registrations WHERE registration_id=?", request.registrationId,
    ).one().state), { timeout: SOURCE_RECONCILIATION_TIMEOUT_MS }).toBe("removed");
    expect(await stub().sidekickAdmitExternalEvent({ ...request,
      event: { ...request.event, audienceKind: "workspace", audienceUserIds: [] },
    })).toMatchObject({ admitted: false, outcomeCode: "sidekick_trigger_removed" });
    expect(await runs()).toEqual([]);
  });

  it("clears restored source coverage without clearing an unrelated permission warning", async () => {
    await mailbox();
    const attention = async () => AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() })).delegationAttention;
    const registered = () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM workspace_external_event_registrations WHERE automation_id=? AND state='active'", automationId).one().count);
    // A delegate's withdrawal leaves the mailbox covered: its owner's source is what covers it.
    await consent(creator, false);
    await reconciled();
    expect(await registered()).toBe(1);
    expect(await attention()).toBeNull();
    await withdrawSource(creator);
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => (await attention())?.code, { timeout: SOURCE_RECONCILIATION_TIMEOUT_MS }).toBe("event_no_eligible_delegate");
    await letIn(creator, "google", mailEvent);
    await runDurableObjectAlarm(stub());
    await expect.poll(attention, { timeout: SOURCE_RECONCILIATION_TIMEOUT_MS }).toBeNull();
    await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(
      "UPDATE automation_directory SET delegation_attention_code='permission_report_unavailable' WHERE automation_id=?", automationId));
    // Coverage lost and coverage restored each reconcile, and neither touches the other warning.
    await withdrawSource(creator);
    await runDurableObjectAlarm(stub());
    await expect.poll(registered, { timeout: SOURCE_RECONCILIATION_TIMEOUT_MS }).toBe(0);
    expect((await attention())?.code).toBe("permission_report_unavailable");
    await letIn(creator, "google", mailEvent);
    await runDurableObjectAlarm(stub());
    await expect.poll(registered, { timeout: SOURCE_RECONCILIATION_TIMEOUT_MS }).toBe(1);
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
        id!, workspaceId, owner!, id === connectionId ? "plugin_google" : `plugin_${id!.replaceAll("-", "")}`, "healthy", now, now);
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
    await reconciled();
    const queued = (await changed(connectionId, "v1")).deliveries[0]!;
    const original = (await registrations()).find((entry) => entry.connection_id === connectionId)!;
    // Becoming a delegate lends accounts and feeds nothing: the file on the delegate's connection stays unwatched.
    await consent(other, true);
    await reconciled();
    expect((await registrations()).map((entry) => entry.connection_id)).toEqual([connectionId]);
    const asked = await stub().sidekickRequestSources({ ...address, actor: actor(), actorName: "Creator",
      ask: { userIds: [other], connectorType: "google", eventTypes: [eventType] } });
    const approval = { ...address, requestId: asked.requests[0]!.requestId, userId: other, decision: "approve" as const };
    if (!lateConnection) {
      await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(`CREATE TRIGGER fail_source_wake
        BEFORE INSERT ON _internal_durable_alarms WHEN NEW.kind='sidekick_delegation_sources'
        BEGIN SELECT RAISE(ABORT,'source_wake_fault'); END`));
      await runInDurableObject(stub(), async (instance) => {
        await expect(instance.sidekickDecideSourceRequest(approval)).rejects.toThrow("source_wake_fault");
      });
      // A source and the reconciliation it owes are one write: neither is left without the other.
      expect(await sourceOwners()).toEqual([creator]);
      await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec("DROP TRIGGER fail_source_wake"));
    }
    await stub().sidekickDecideSourceRequest(approval);
    expect((await sourceOwners()).sort()).toEqual([creator, other].sort());
    if (lateConnection) {
      // The connection the source names is off when its reconciliation runs, and comes back later.
      const disconnected = await stub().executeRuntimeSql({ workspaceId, requestId: crypto.randomUUID(), statements: [{
        sql: "UPDATE connector_connections SET status='disabled' WHERE id=?", params: [secondConnection],
      }] });
      expect(disconnected.status).toBe(200);
      await reconciled();
      expect(await registrations()).toHaveLength(1);
      const parkedAlarm = Date.now() + 3_600_000;
      await runInDurableObject(stub(), async (_instance, state) => { await state.storage.setAlarm(parkedAlarm); });
      const connected = await stub().executeRuntimeSql({ workspaceId, requestId: crypto.randomUUID(), statements: [{
        sql: "UPDATE connector_connections SET status='healthy' WHERE id=?", params: [secondConnection],
      }] });
      expect(connected.status).toBe(200);
      // The source wake can already have reconciled and scheduled the next
      // maintenance alarm (later than parkedAlarm). Observe either the earlier
      // wake or its completed registration effect, not one transient alarm.
      await expect.poll(async () => {
        const wake = await runInDurableObject(stub(), async (_instance, state) => state.storage.getAlarm());
        return (wake !== null && wake < parkedAlarm) || (await registrations()).length === 2;
      }).toBe(true);
    } else await runDurableObjectAlarm(stub());
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
    // The creator stops lending their accounts and takes their file's events back: the second is what unregisters it.
    await consent(creator, false);
    await withdrawSource(creator);
    await runDurableObjectAlarm(stub());
    await expect.poll(async () => (await registrations()).map((entry) => entry.connection_id)).toEqual([secondConnection]);
    expect(await admit(queued)).toMatchObject({ admitted: false });
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

  it("admits a personal event through its owner's source and keeps a mail thread's rule on that connection", async () => {
    // The held effect queue keeps these assertions before inference.
    await create();
    await consent(other, true);
    const anotherInbox = crypto.randomUUID();
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO connector_connections(id,workspace_id,connector_type,scope,owner_user_id,
        display_name,model_plugin_id,granted_scopes_json,status,created_at,updated_at)
        VALUES (?,?,'google','personal',?,'Maya mail','plugin_google','["gmail.read"]','healthy',?,?)`, connectionId, workspaceId, other, now, now);
      state.storage.sql.exec(`INSERT INTO resources(id,workspace_id,connection_id,resource_type,provider,provider_resource_id,title,metadata_json,created_at,updated_at)
        VALUES (?,?,?,'gmail_thread','google','source-thread','Mail thread','{}',?,?)`, resourceId, workspaceId, connectionId, now, now);
    });
    const eventType = "email.received";
    const draft: AutomationDraft = { ...definition, triggers: [{ type: "connector_activity", connectorType: "google", sourceBindingKey: "mail",
      suggestedSourcePluginId: "plugin_google", eventTypes: [eventType], deterministicFilters: {} }] };
    const evaluatorRules = AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: [{ evaluatorKey: "received", source: {
      sourceBindingKey: "mail", suggestedSourcePluginId: "plugin_google", event: { kind: "event_type", eventType },
      resourceId,
    }, when: { kind: "always" } }] });
    // A colleague who lends their accounts has not let their mail in: the rule cannot be saved on their mailbox yet.
    await runInDurableObject(stub(), async (instance) => {
      await instance.sidekickSubmitDefinition({ ...address, draft, evaluatorRules, submittedByRunId: null });
      await expect(instance.sidekickApply({ ...address, actor: actor() })).rejects.toMatchObject({ status: 422, code: "sidekick_plugin_unavailable" });
    });
    await letIn(other, "google", eventType);
    await activate(draft, evaluatorRules);
    await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(`INSERT INTO connector_connections
      (id,workspace_id,connector_type,scope,owner_user_id,display_name,model_plugin_id,granted_scopes_json,status,created_at,updated_at)
      VALUES (?,?,'google','personal',?,'Another inbox','plugin_other_mail','["gmail.read"]','healthy',?,?)`,
    anotherInbox, workspaceId, creator, now, now));
    // The creator lets their own inbox in too. A rule about one thread still stays on the account that thread is in.
    await letIn(creator, "google", eventType);
    expect((await sourceOwners()).sort()).toEqual([creator, other].sort());
    await reconciled();
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
    // Of the delegates, the one whose connection the rule is configured on coordinates the run.
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
    expect(await stub().sidekickContinueRun({ ...address, runId: first.runId, sender: { kind: "system" } })).toMatchObject({ outcome: "continue", executionPrincipal: { type: "user", userId: creator } });
    await consent(creator, false);
    expect(await stub().sidekickContinueRun({ ...address, runId: first.runId, sender: { kind: "system" } })).toMatchObject({ outcome: "continue", executionPrincipal: { type: "user", userId: other } });
    expect((await runs()).find((row) => row.run_id === first.runId)?.coordinator_user_id).toBe(other);
    expect(AutomationRunDefinitionV1Schema.parse(await stub().sidekickReadRunDefinition({ ...address, runId: first.runId }))).toMatchObject({ coordinatorUserId: other });
    const second = await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "second-coordinator" });
    expect((await runs()).find((row) => row.run_id === second.runId)?.coordinator_user_id).toBe(other);
    const saved = AutomationRunDefinitionV1Schema.parse(await stub().sidekickReadRunDefinition({ ...address, runId: second.runId }));
    expect(saved).toMatchObject({ coordinatorUserId: other, runAsUserId: creator });
  });

  it("starts a manual run as the Sidekick itself, and asks for no attention, when no delegate is eligible", async () => {
    await create(false);
    await activate();
    const manual = await stub().sidekickRunNow({ ...address, actor: actor(), idempotencyKey: "no-delegate-manual" });
    expect(await runs()).toEqual([{ run_id: manual.runId, coordinator_user_id: null, state: "pending", summary: null, opening_json: null }]);
    // Starting it blocks nothing either: it is handed to provisioning with nobody to act as.
    await runDurableObjectAlarm(stub());
    await started(manual.runId);
    expect(await stub().sidekickRunProvisioning({ ...address, runId: manual.runId })).toMatchObject({ runId: manual.runId, runAsUserId: null });
    expect(await stub().sidekickContinueRun({ ...address, runId: manual.runId, sender: { kind: "system" } }))
      .toMatchObject({ outcome: "continue", executionPrincipal: { type: "workspace", workspaceId } });
    expect(await runs()).toEqual([{ run_id: manual.runId, coordinator_user_id: null, state: "pending", summary: null, opening_json: null }]);
    const detail = AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() }));
    expect(detail.delegationAttention).toBeNull();
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

  it("starts an hourly occurrence as the Sidekick itself when nobody is a delegate, and a later one under fresh consent without replaying the first", async () => {
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
    await expect.poll(async () => (await runs()).map((row) => row.state)).toEqual(["pending"]);
    const unattended = (await runs())[0]!.run_id;
    // Not blocked: once its start has been handed on, the occurrence is still to be provisioned, as nobody.
    await started(unattended);
    expect(await stub().sidekickRunProvisioning({ ...address, runId: unattended })).toMatchObject({ runId: unattended, runAsUserId: null });
    expect(AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() })).delegationAttention).toBeNull();
    await consent(creator, true);
    await tick();
    await expect.poll(async () => (await runs()).length).toBe(2);
    expect((await runs()).map((row) => ({ coordinator: row.coordinator_user_id, state: row.state }))).toEqual([
      { coordinator: null, state: "pending" }, { coordinator: creator, state: "pending" },
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

  it("requires the source of somebody inside a workspace event's restricted audience, including old queued payloads", async () => {
    const request = await webhook();
    // The creator's own source on the Organization's connection does not reach an event only `other` can see.
    expect(await sourceOwners()).toEqual([creator]);
    expect(await stub().sidekickAdmitExternalEvent(request)).toEqual({ admitted: false, outcomeCode: "sidekick_source_not_permitted" });
    expect(await runs()).toEqual([]);
    // Lending accounts is not letting events in.
    await consent(other, true);
    expect(await stub().sidekickAdmitExternalEvent(request)).toEqual({ admitted: false, outcomeCode: "sidekick_source_not_permitted" });
    expect(await runs()).toEqual([]);
    await letIn(other, "generic_webhook", "deploy.finished");
    expect(await stub().sidekickAdmitExternalEvent(request)).toMatchObject({ admitted: true });
    // Of the two delegates the run acts as the one whose event it is: the only one in its audience.
    expect(await runs()).toEqual([{ run_id: expect.any(String), coordinator_user_id: other, state: "pending",
      summary: null, opening_json: expect.stringContaining("Private deploy details") }]);
  });

  it("rechecks the source at delivery after a matching view has observed it", async () => {
    const request = await webhook();
    await letIn(other, "generic_webhook", "deploy.finished");
    // The delivery was prepared while this person's source stood; it arrives later.
    expect(await sourceOwners()).toContain(other);
    expect(await withdrawSource(other)).toEqual({ withdrawn: true });
    expect(await stub().sidekickAdmitExternalEvent(request)).toEqual({ admitted: false, outcomeCode: "sidekick_source_not_permitted" });
    expect(await runs()).toEqual([]);
  });

  it.each(["workspace"] as const)("admits a %s-owned personal Sheet event and an hourly occurrence under the same delegate, then refuses that source once its owner withdraws it", async (scope) => {
    await create(true, scope);
    await runInDurableObject(stub(), (_instance, state) => {
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
    await runInDurableObject(stub(), async (_instance, state) => {
      const due = Date.now() - 1;
      state.storage.sql.exec("UPDATE sidekick_schedules SET next_due_at=? WHERE sidekick_id=?", due, automationId);
      state.storage.sql.exec("UPDATE _internal_durable_alarms SET due_at=?,retry_at=0 WHERE kind=? AND alarm_key LIKE ?", due, AUTOMATION_SCHEDULE_ALARM_KIND, `${automationId}:%`);
      // Armed here rather than forced after: the admitted run's row entry is
      // due now, so the object's own alarm may already be draining, and a
      // forced `runDurableObjectAlarm` on top of it is a second pass production
      // cannot have, which starts the occurrence twice. The poll waits.
      await state.storage.setAlarm(Date.now());
    });
    await expect.poll(async () => (await runs()).length).toBe(2);
    expect((await runs()).map((run) => run.coordinator_user_id)).toEqual([creator, creator]);
    // No longer lending accounts takes no events away; taking the source back does.
    if (scope === "workspace") await consent(other, true);
    await consent(creator, false);
    expect((await event("calendar-change-2")).deliveries).toHaveLength(1);
    expect(await withdrawSource(creator)).toEqual({ withdrawn: true });
    expect((await event("calendar-change-3")).deliveries).toEqual([]);
    expect(AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: actor() })).delegationAttention?.code).toBe("event_no_eligible_delegate");
    expect(await stub().sidekickAdmitExternalEvent({ ...address, registrationId: delivery.registrationId,
      event: { ...delivery.event, id: crypto.randomUUID() }, payloadHash: delivery.payloadHash })).toMatchObject({ admitted: false });
    expect(await runs()).toHaveLength(2);
  });
});
