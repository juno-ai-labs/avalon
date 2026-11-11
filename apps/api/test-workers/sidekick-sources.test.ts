/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AutomationSetEvaluatorRulesInputV1Schema, SidekickExecutionDelegationSchema, SidekickSourcesResultSchema,
  asUserId, asWorkspaceId, type AutomationDraft, WorkspaceExternalEventMatchResultSchema,
} from "@rally/contracts";
import { workspaceDOName } from "../src/durable-objects/names";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { changeRelationships } from "./helpers/workspace-relationship-events";

/**
 * Sources against real workerd: whose events may start a Sidekick is the
 * sources' answer and never the delegates', only the person asked answers a
 * request, a person's own filter gates their events, and a run nobody is
 * behind acts as the Sidekick itself. `docs/sidekick-sources.md`.
 */
const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000ce00");
const creator = asUserId("00000000-0000-7000-8000-00000000ce01");
const jane = asUserId("00000000-0000-7000-8000-00000000ce02");
const outsider = asUserId("00000000-0000-7000-8000-00000000ce03");
const automationId = "00000000-0000-7000-8000-00000000ce04";
const creatorMail = "00000000-0000-7000-8000-00000000ce05";
const janeMail = "00000000-0000-7000-8000-00000000ce06";
const address = { workspaceId, automationId };
const actor = (userId = creator) => ({ userId, actorRole: "member" as const, participantOfOwningWorkstream: false });
const stub = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
const now = "2026-11-10T20:00:00.000Z";
const RECONCILIATION_TIMEOUT_MS = 15_000;
const eventType = "email.received";
const definition: AutomationDraft = {
  name: "Deals", description: "Track deals from mail", overview: "Watch mail",
  instructions: "Update the dashboard from each email.",
  triggers: [{ type: "connector_activity", connectorType: "google", sourceBindingKey: "mail",
    suggestedSourcePluginId: "plugin_google", eventTypes: [eventType], deterministicFilters: {} }],
  requiredCapabilities: [], expectedOutputs: [], defaultBehavior: {}, recommendedPlugins: [], memoryTables: [], customTools: [],
  suggestedScope: "personal", followUpQuestion: null, elicitation: null, ready: true, definitionVersion: 2,
};
const rules = AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: [{ evaluatorKey: "received", source: {
  sourceBindingKey: "mail", suggestedSourcePluginId: "plugin_google", event: { kind: "event_type", eventType },
}, when: { kind: "always" } }] });
useHeldEffectQueue();

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: creator, sessionId: crypto.randomUUID() });
  // This suite's D1 starts with no schema: a request's view reads each person's presentation.
  await env.DB.exec("ALTER TABLE users ADD COLUMN presentation_json TEXT");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,status,role) VALUES (?,?,'active','member')").bind(workspaceId, jane),
    env.DB.prepare("INSERT INTO users(id,name) VALUES (?,'Jane Doe')").bind(jane),
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,status,role) VALUES (?,?,'active','member')").bind(workspaceId, outsider),
    env.DB.prepare("INSERT INTO users(id,name) VALUES (?,'Somebody Else')").bind(outsider),
  ]);
});

/** A Sidekick watching new mail on its creator's own Gmail, with Jane's Gmail connected beside it. */
async function watchingMail() {
  await stub().sidekickCreate({ ...address, authorUserId: creator, scope: "personal", authorityGeneration: 1 });
  await runInDurableObject(stub(), (_instance, state) => {
    for (const [id, owner, plugin] of [[creatorMail, creator, "plugin_google"], [janeMail, jane, "plugin_google_2"]]) {
      state.storage.sql.exec(`INSERT INTO connector_connections(id,workspace_id,connector_type,scope,owner_user_id,
        display_name,model_plugin_id,granted_scopes_json,status,created_at,updated_at)
        VALUES (?,?,'google','personal',?,'Mail',?,'["gmail.read"]','healthy',?,?)`, id!, workspaceId, owner!, plugin!, now, now);
    }
  });
  await stub().sidekickSubmitDefinition({ ...address, draft: definition, evaluatorRules: rules, submittedByRunId: null });
  await stub().sidekickApply({ ...address, actor: actor() });
  await reconciled();
}

async function reconciled() {
  await runDurableObjectAlarm(stub());
  await expect.poll(async () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
    "SELECT count(*) AS count FROM _internal_durable_alarms WHERE kind='sidekick_delegation_sources'",
  ).one().count), { timeout: RECONCILIATION_TIMEOUT_MS }).toBe(0);
}

const registered = () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ connection_id: string }>(
  "SELECT connection_id FROM workspace_external_event_registrations WHERE automation_id=? AND state='active' ORDER BY connection_id", automationId,
).toArray().map((row) => row.connection_id));

const runs = () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{
  run_id: string; coordinator_user_id: string | null; state: string; opening_json: string | null;
}>("SELECT run_id,coordinator_user_id,state,opening_json FROM sidekick_runs WHERE sidekick_id=? ORDER BY created_at,run_id", automationId).toArray());

const delegates = async () => SidekickExecutionDelegationSchema.parse(await stub().sidekickReadExecutionDelegation(address))
  .delegates.map((grant) => grant.userId);

const ask = (userIds: string[], condition?: string) => stub().sidekickRequestSources({
  ...address, actor: actor(), actorName: "Adam",
  ask: { userIds, connectorType: "google", eventTypes: [eventType], ...(condition ? { condition } : {}) },
});

async function setDelegation(userId: typeof creator, allowed: boolean) {
  const request = { ...address, userId, allowed, operationId: crypto.randomUUID() };
  const prepared = await stub().sidekickPrepareMyDelegation(request);
  await stub().sidekickSetDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" });
}
const withdrawDelegation = (userId: typeof creator) => setDelegation(userId, false);

/** Rewrite stored rows the way an older build or the migration left them, then let the registrations follow. */
async function stored(statement: string, ...bindings: (string | null)[]) {
  await runInDurableObject(stub(), (_instance, state) => {
    state.storage.sql.exec(statement, ...bindings);
    // Any change of a connection's authority wakes the Sidekick's source reconciliation.
    state.storage.sql.exec("UPDATE connector_connections SET config_json = json_object('touched', hex(randomblob(4))) WHERE id = ?", janeMail);
  });
  await reconciled();
}

/** New mail arriving on one person's connection, matched to this Sidekick's deliveries. */
async function mail(connectionId: string, owner: string, subject: string) {
  const id = crypto.randomUUID();
  await stub().ingestConnectorEvent({ workspaceId, ingressEventId: id, payloadHash: `sha256:${"c".repeat(64)}`, event: {
    connectorType: "google", activity: { id, workspaceId, region: "global", connectionId, connectionScope: "personal",
      connectionOwnerUserId: owner, provider: "google", providerEventId: id, eventType, resourceType: "gmail_thread",
      providerResourceId: `thread-${id}`, actor: { from: "founder@example.com" }, subject: { messageId: `message-${id}`, threadId: `thread-${id}` },
      occurredAt: now, receivedAt: now, title: `New email: ${subject}`, summary: "From founder@example.com", textSnippet: subject,
      payloadRef: null, visibility: { kind: "personal" }, targetUserIds: [], entityKeys: [], dedupeKey: id, rawContentHash: null,
      metadata: { changeType: "added" }, externalPeople: [],
    },
  } });
  return WorkspaceExternalEventMatchResultSchema.parse(await stub().matchExternalEventDestinations({ workspaceId, eventId: id })).deliveries;
}

const admit = (delivery: Awaited<ReturnType<typeof mail>>[number], verdicts: Record<string, unknown> = {}) =>
  stub().sidekickAdmitExternalEvent({ ...address, registrationId: delivery.registrationId, event: delivery.event,
    payloadHash: delivery.payloadHash, ...verdicts });

const FILTER = "The email is about a pre-seed investment round.";
const met = { admit: true, code: "condition_met" as const, confidence: 0.9, model: "jev-test", conditions: [FILTER] };
const notMet = { admit: false, code: "condition_not_met" as const, confidence: 0.9, model: "jev-test", conditions: [FILTER] };

describe("Sidekick sources", () => {
  it("starts a Sidekick on a person's mail through that person's source, whether or not they are a delegate", async () => {
    await watchingMail();
    // Saving the rule on one's own connection is one's own source; Jane's mailbox is not watched.
    expect(await registered()).toEqual([creatorMail]);
    expect(await mail(janeMail, jane, "Seed round intro")).toEqual([]);

    const asked = await ask([jane]);
    expect(asked.requests.map((request) => ({ user: request.person.userId, state: request.state }))).toEqual([{ user: jane, state: "pending" }]);
    await reconciled();
    // Asking is not approving.
    expect(await registered()).toEqual([creatorMail]);

    await stub().sidekickDecideSourceRequest({ ...address, requestId: asked.requests[0]!.requestId, userId: jane, decision: "approve" });
    await reconciled();
    expect(await registered()).toEqual([creatorMail, janeMail].sort());
    // Jane lent her events and nothing else: she is no delegate.
    expect(await delegates()).toEqual([creator]);

    const fromJane = await mail(janeMail, jane, "Seed round intro");
    expect(fromJane).toHaveLength(1);
    expect(await admit(fromJane[0]!)).toMatchObject({ admitted: true, outcomeCode: "sidekick_occurrence_admitted" });
    // The run acts as a delegate, not as the person whose mail started it.
    expect((await runs()).map((run) => run.coordinator_user_id)).toEqual([creator]);

    // The creator takes their own source back and stays a delegate: their mail stops starting it.
    expect(await stub().sidekickWithdrawSource({ ...address, userId: creator, connectionId: creatorMail })).toEqual({ withdrawn: true });
    await reconciled();
    expect(await registered()).toEqual([janeMail]);
    expect(await mail(creatorMail, creator, "Seed round follow-up")).toEqual([]);
    expect(await delegates()).toEqual([creator]);
  });

  it("refuses at admission an event whose source was taken back after it was matched", async () => {
    await watchingMail();
    const queued = await mail(creatorMail, creator, "Term sheet");
    expect(queued).toHaveLength(1);
    await stub().sidekickWithdrawSource({ ...address, userId: creator, connectionId: creatorMail });
    expect(await admit(queued[0]!)).toMatchObject({ admitted: false, outcomeCode: "sidekick_source_not_permitted" });
    expect(await runs()).toEqual([]);
  });

  it("lets only the person asked answer a request", async () => {
    await watchingMail();
    const asked = await ask([jane]);
    const requestId = asked.requests[0]!.requestId;
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickDecideSourceRequest({ ...address, requestId, userId: creator, decision: "approve" }))
        .rejects.toMatchObject({ status: 403, code: "sidekick_source_request_not_yours" });
    });
    await reconciled();
    expect(await registered()).toEqual([creatorMail]);
    const listed = SidekickSourcesResultSchema.parse(await stub().sidekickReadSources({ ...address, actor: actor() }));
    expect(listed.requests.map((request) => request.state)).toEqual(["pending"]);
    // Somebody who neither manages nor reads the Sidekick cannot ask for anybody's events.
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickRequestSources({ ...address, actor: actor(outsider), actorName: "Else",
        ask: { userIds: [jane], connectorType: "google", eventTypes: [eventType] } }))
        .rejects.toMatchObject({ status: 403, code: "sidekick_source_request_requires_manager" });
    });
  });

  it("holds a person's events to the filter they approved, and nobody else's", async () => {
    await watchingMail();
    const asked = await ask([jane], FILTER);
    await stub().sidekickDecideSourceRequest({ ...address, requestId: asked.requests[0]!.requestId, userId: jane, decision: "approve" });
    await reconciled();

    const fromJane = (await mail(janeMail, jane, "Lunch on Friday?"))[0]!;
    // No verdict: refused, with the filter to judge.
    expect(await admit(fromJane)).toEqual({ admitted: false, outcomeCode: "sidekick_source_condition_unjudged",
      judge: { conditions: [], sourceConditions: [FILTER], connectorType: "google" } });
    expect(await admit(fromJane, { sourceVerdict: notMet })).toEqual({ admitted: false, outcomeCode: "sidekick_source_condition_not_met" });
    // A verdict on a filter that is not hers now, as when she approved another while the classifier ran, admits nothing.
    expect(await admit(fromJane, { sourceVerdict: { ...met, conditions: ["The email mentions money."] } }))
      .toEqual({ admitted: false, outcomeCode: "sidekick_source_condition_changed" });
    expect(await runs()).toEqual([]);
    expect(await admit(fromJane, { sourceVerdict: met })).toMatchObject({ admitted: true });

    // The creator's own source has no filter: their mail needs no verdict.
    const fromCreator = (await mail(creatorMail, creator, "Lunch on Friday?"))[0]!;
    expect(await admit(fromCreator)).toMatchObject({ admitted: true });
    expect(await runs()).toHaveLength(2);
  });

  it("keeps a person's own filter when the definition is saved again", async () => {
    await watchingMail();
    // Asking for one's own account is approved by the act of asking.
    const own = await ask([creator], FILTER);
    expect(own.requests.map((request) => request.state)).toEqual(["approved"]);
    await stub().sidekickSubmitDefinition({ ...address, draft: { ...definition, instructions: "Update the dashboard, briefly." },
      evaluatorRules: rules, submittedByRunId: null });
    await stub().sidekickApply({ ...address, actor: actor() });
    const listed = SidekickSourcesResultSchema.parse(await stub().sidekickReadSources({ ...address, actor: actor() }));
    expect(listed.sources.map((source) => ({ connection: source.connectionId, condition: source.condition }))).toEqual([
      { connection: creatorMail, condition: FILTER },
    ]);
  });

  it("adds nothing of a saver's when a save adds no rule", async () => {
    await watchingMail();
    await stub().sidekickWithdrawSource({ ...address, userId: creator, connectionId: creatorMail });
    await reconciled();
    expect(await registered()).toEqual([]);
    // The same rule, other words in the instructions: no rule is new, so the saver's mailbox is not let back in.
    await stub().sidekickSubmitDefinition({ ...address, draft: { ...definition, instructions: "Update the dashboard, briefly." },
      evaluatorRules: rules, submittedByRunId: null });
    await stub().sidekickApply({ ...address, actor: actor() });
    await reconciled();
    expect(SidekickSourcesResultSchema.parse(await stub().sidekickReadSources({ ...address, actor: actor() })).sources).toEqual([]);
    expect(await registered()).toEqual([]);
  });

  it("carries a rule about a whole account only to an account whose owner approved a request", async () => {
    await watchingMail();
    const asked = await ask([jane]);
    await stub().sidekickDecideSourceRequest({ ...address, requestId: asked.requests[0]!.requestId, userId: jane, decision: "approve" });
    await reconciled();
    expect(await registered()).toEqual([creatorMail, janeMail]);
    // The same source as the migration made it from a delegate's own rule: it stands for that rule
    // and does not turn the creator's rule into all of Jane's mail.
    await stored("UPDATE sidekick_sources SET request_id = NULL WHERE user_id = ?", jane);
    expect(await registered()).toEqual([creatorMail]);
    expect(await mail(janeMail, jane, "Seed round intro")).toEqual([]);
  });

  it("leaves what a person already let in alone when they answer a request about another kind of event", async () => {
    await watchingMail();
    // The creator's own rule lets their new mail in, unfiltered. They then approve an ask about label changes, filtered.
    const asked = await stub().sidekickRequestSources({ ...address, actor: actor(), actorName: "Adam",
      ask: { userIds: [creator], connectorType: "google", eventTypes: ["email.updated"], condition: FILTER } });
    expect(asked.requests.map((request) => request.state)).toEqual(["approved"]);
    await reconciled();
    const listed = SidekickSourcesResultSchema.parse(await stub().sidekickReadSources({ ...address, actor: actor() }));
    expect(listed.sources.map((source) => ({ events: source.eventTypes, condition: source.condition }))).toEqual([
      { events: ["email.received"], condition: null },
      { events: ["email.updated"], condition: FILTER },
    ]);
    // New mail still needs no verdict: the filter is the other event type's.
    expect(await registered()).toEqual([creatorMail]);
    expect(await admit((await mail(creatorMail, creator, "Lunch on Friday?"))[0]!)).toMatchObject({ admitted: true });
  });

  it("refuses a rule on another person's account that they did not approve a request for", async () => {
    await watchingMail();
    const onJanesMail = () => stub().sidekickSubmitDefinition({ ...address, submittedByRunId: null,
      draft: { ...definition, triggers: [{ type: "connector_activity", connectorType: "google", sourceBindingKey: "mail",
        suggestedSourcePluginId: "plugin_google_2", eventTypes: [eventType], deterministicFilters: {} }] },
      evaluatorRules: AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: [{ evaluatorKey: "received",
        source: { sourceBindingKey: "mail", suggestedSourcePluginId: "plugin_google_2", event: { kind: "event_type", eventType } },
        when: { kind: "always" } }] }) });
    const saved = () => runInDurableObject(stub(), (instance) => instance.sidekickApply({ ...address, actor: actor() })
      .then(() => "saved", (error: { code?: string }) => error.code));
    const asked = await ask([jane]);
    await stub().sidekickDecideSourceRequest({ ...address, requestId: asked.requests[0]!.requestId, userId: jane, decision: "approve" });
    await reconciled();
    // Jane's source as her own saved rule, or the migration, would have left it: it stands for that
    // rule alone. A manager cannot put a rule about her whole mailbox on her account with it.
    await stored("UPDATE sidekick_sources SET request_id = NULL WHERE user_id = ?", jane);
    await onJanesMail();
    expect(await saved()).toBe("sidekick_source_owner_must_approve");
    expect(await registered()).toEqual([creatorMail]);
    // Once she has approved a request for that event, the same save goes through.
    await stored("UPDATE sidekick_sources SET request_id = ? WHERE user_id = ?", asked.requests[0]!.requestId, jane);
    expect(await saved()).toBe("saved");
    await reconciled();
    expect(await registered()).toEqual([janeMail]);
  });

  it("acts as the person whose mail started the run when they are a delegate, and as another delegate when they are not", async () => {
    await watchingMail();
    const asked = await ask([jane]);
    await stub().sidekickDecideSourceRequest({ ...address, requestId: asked.requests[0]!.requestId, userId: jane, decision: "approve" });
    await reconciled();
    const acting = async (connectionId: string, owner: string) => {
      const delivery = (await mail(connectionId, owner, "Term sheet"))[0]!;
      expect(await admit(delivery)).toMatchObject({ admitted: true });
      return (await runs()).at(-1)!.coordinator_user_id;
    };
    // Jane lends events and no account: her mail's run acts as the one delegate there is.
    expect(await acting(janeMail, jane)).toBe(creator);
    // Approving made her a reader, so she can lend her accounts too. Her mail's run then acts as her.
    await setDelegation(jane, true);
    expect(await acting(janeMail, jane)).toBe(jane);
    expect(await acting(creatorMail, creator)).toBe(creator);
  });

  it("decides who may ask from the stored role, whatever role the caller names", async () => {
    await watchingMail();
    // An Organization Sidekick somebody else made: its managers are its author and the Organization's admins.
    const shared = "00000000-0000-7000-8000-00000000ce07";
    await env.DB.prepare("UPDATE workspace_members SET role='admin' WHERE workspace_id=? AND user_id=?").bind(workspaceId, outsider).run();
    await stub().sidekickCreate({ workspaceId, automationId: shared, authorUserId: creator, scope: "workspace", authorityGeneration: 1 });
    const asking = (userId: typeof creator, actorRole: "admin" | "member" | null) => runInDurableObject(stub(), (instance) =>
      instance.sidekickRequestSources({ workspaceId, automationId: shared, actorName: "Somebody",
        actor: { userId, actorRole, participantOfOwningWorkstream: false },
        ask: { userIds: [creator], connectorType: "google", eventTypes: [eventType] } })
        .then((result) => result.requests.map((request) => request.state), (error: { code?: string }) => error.code));
    // An agent's tool knows no role: the admin is still an admin.
    expect(await asking(outsider, null)).toEqual(["pending"]);
    // A member is not made an admin by saying so.
    expect(await asking(jane, "admin")).toBe("sidekick_source_request_requires_manager");
  });

  it("answers a repeated ask with the requests it already made, even after they were answered", async () => {
    await watchingMail();
    const operationId = crypto.randomUUID();
    const repeatable = () => stub().sidekickRequestSources({ ...address, actor: actor(), actorName: "Adam",
      ask: { userIds: [jane], connectorType: "google", eventTypes: [eventType], operationId } });
    const first = await repeatable();
    await stub().sidekickDecideSourceRequest({ ...address, requestId: first.requests[0]!.requestId, userId: jane, decision: "decline" });
    const again = await repeatable();
    expect(again.requests.map((request) => ({ id: request.requestId, state: request.state })))
      .toEqual([{ id: first.requests[0]!.requestId, state: "declined" }]);
  });

  it("answers a repeated ask with a request that was already waiting when it asked, and after the person has left", async () => {
    await watchingMail();
    const waiting = (await ask([jane])).requests[0]!.requestId;
    const operationId = crypto.randomUUID();
    const repeatable = () => stub().sidekickRequestSources({ ...address, actor: actor(), actorName: "Adam",
      ask: { userIds: [jane], connectorType: "google", eventTypes: [eventType], operationId } });
    // The same thing asked again finds the request that is waiting and makes no second one.
    expect((await repeatable()).requests.map((request) => request.requestId)).toEqual([waiting]);
    await stub().sidekickDecideSourceRequest({ ...address, requestId: waiting, userId: jane, decision: "approve" });
    // Jane leaves, as the Organization learns it: the row goes and the relationship event follows.
    await changeRelationships(env, workspaceId, [jane],
      env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspaceId, jane));
    expect((await repeatable()).requests.map((request) => ({ id: request.requestId, state: request.state })))
      .toEqual([{ id: waiting, state: "approved" }]);
    expect(await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM sidekick_source_requests WHERE sidekick_id = ?", automationId).one().count)).toBe(1);
  });
});

describe("a run nobody is behind", () => {
  it("starts as the Sidekick itself and is continued by the people who manage it", async () => {
    await watchingMail();
    await withdrawDelegation(creator);
    expect(await delegates()).toEqual([]);
    // The creator's source is not their delegation: their mail still starts the Sidekick.
    const delivery = (await mail(creatorMail, creator, "Term sheet"))[0]!;
    expect(await admit(delivery)).toMatchObject({ admitted: true });
    const [run] = await runs();
    expect(run).toMatchObject({ coordinator_user_id: null, state: "pending" });
    expect(run!.opening_json).toContain("Term sheet");

    await runDurableObjectAlarm(stub());
    const provisioning = await stub().sidekickRunProvisioning({ ...address, runId: run!.run_id });
    expect(provisioning).toMatchObject({ runAsUserId: null, eventContent: { connectionId: creatorMail, connectorType: "google", eventType } });

    const sender = (userId: typeof creator) => ({ kind: "person" as const, userId });
    expect(await stub().sidekickContinueRun({ ...address, runId: run!.run_id, sender: { kind: "system" } }))
      .toMatchObject({ outcome: "continue", executionPrincipal: { type: "workspace", workspaceId } });
    expect(await stub().sidekickContinueRun({ ...address, runId: run!.run_id, sender: sender(creator) }))
      .toMatchObject({ outcome: "continue", executionPrincipal: { type: "workspace", workspaceId } });
    expect(await stub().sidekickContinueRun({ ...address, runId: run!.run_id, sender: sender(outsider) }))
      .toEqual({ outcome: "refused", code: "run_continuation_requires_manager" });
  });

  it("stays stopped where it had already stopped for want of a delegate, until somebody resumes it", async () => {
    await watchingMail();
    await withdrawDelegation(creator);
    // As an earlier build left a Sidekick whose last delegate withdrew.
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE automation_directory SET delegation_attention_code = 'no_eligible_delegate' WHERE automation_id = ?", automationId);
    });
    const started = async () => {
      const delivery = (await mail(creatorMail, creator, "Term sheet"))[0]!;
      expect(await admit(delivery)).toMatchObject({ admitted: true });
      return (await runs()).at(-1)!.state;
    };
    expect(await started()).toBe("needs_input");
    // Another warning does not take the stop away. An event refused for want of a source, and the
    // reconciliation a source's return runs, would each write their own; the Sidekick stays stopped.
    const matched = (await mail(creatorMail, creator, "Follow-up"))[0]!;
    await stub().sidekickWithdrawSource({ ...address, userId: creator, connectionId: creatorMail });
    expect(await admit(matched)).toEqual({ admitted: false, outcomeCode: "sidekick_source_not_permitted" });
    await reconciled();
    expect((await ask([creator])).requests.map((request) => request.state)).toEqual(["approved"]);
    await reconciled();
    expect(await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ code: string | null }>(
      "SELECT delegation_attention_code AS code FROM automation_directory WHERE automation_id = ?", automationId).one().code))
      .toBe("no_eligible_delegate");
    expect(await started()).toBe("needs_input");
    await stub().sidekickPause({ ...address, actor: actor() });
    await stub().sidekickResume({ ...address, actor: actor() });
    await reconciled();
    expect(await started()).toBe("pending");
  });

  it("is handed no event content once the person's source is gone", async () => {
    await watchingMail();
    const delivery = (await mail(creatorMail, creator, "Term sheet"))[0]!;
    expect(await admit(delivery)).toMatchObject({ admitted: true });
    const [run] = await runs();
    await stub().sidekickWithdrawSource({ ...address, userId: creator, connectionId: creatorMail });
    await runDurableObjectAlarm(stub());
    expect(await stub().sidekickRunProvisioning({ ...address, runId: run!.run_id })).toMatchObject({ eventContent: null });
  });
});
