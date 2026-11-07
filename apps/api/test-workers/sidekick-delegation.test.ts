/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AutomationDetailSchema, asUserId, asWorkspaceId, sidekickCanonicalUrl } from "@rally/contracts";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { seedWorkspaceControlPlane, seedWorkstreamRoot, seedParticipantMessage, seedExecutionReceipt, runInput } from "./helpers/substream-fixture";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { SidekickDelegationService } from "../src/services/sidekick-delegation-service";
import { AgentCommunicationService } from "../src/services/agent-communication-service";
import { sidekickDelegationTools } from "../src/services/sidekick-delegation-tools";
import { validateCompletedToolReplay } from "../src/services/completed-tool-replay";
import { reenterInterruptedWriteForRecovery } from "../src/services/integrations";
import { createHarnessRunObjectPort } from "../src/runtime/harness-run-port";
import { createToolReceiptObjectPort } from "../src/runtime/tool-receipt-port";
import { claimHarnessAttempt } from "../src/runtime/harness-run-runtime";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000e400");
const creator = asUserId("00000000-0000-7000-8000-00000000e401");
const other = asUserId("00000000-0000-7000-8000-00000000e402");
const sidekickId = "00000000-0000-7000-8000-00000000e403";
const address = { workspaceId, automationId: sidekickId };
const stub = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
useHeldEffectQueue();

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: creator, sessionId: crypto.randomUUID() });
  await env.DB.exec("ALTER TABLE users ADD COLUMN presentation_json TEXT");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,status,role) VALUES (?,?,'active','member')`).bind(workspaceId, other),
    env.DB.prepare(`INSERT INTO users(id,name) VALUES (?,'Other person')`).bind(other),
  ]);
});

async function create(scope: "personal" | "workspace" = "workspace") {
  return stub().sidekickCreate({
    ...address, authorUserId: creator, scope, authorityGeneration: 1,
  });
}

async function prepare(allowed: boolean, userId = creator, operationId = crypto.randomUUID()) {
  const request = { ...address, userId, allowed, operationId };
  const { generation } = await stub().sidekickPrepareMyDelegation(request);
  return { ...request, expectedGeneration: generation, source: "self_service" as const };
}

async function own(userId = creator) {
  return stub().sidekickReadMyDelegations({ workspaceId, userId });
}

describe("Sidekick consent authority in real workerd", () => {
  it.each([{ room: false, status: "executing" as const }, { room: true, status: "ambiguous" as const }])(
    "recovers a lost consent response from its accepted receipt after eviction (room $room, $status)", async ({ room, status }) => {
      // No inference: admit the execution receipt without activating its loop.
      await create();
      const parentId = room ? crypto.randomUUID() : sidekickId;
      const triggerMessageId = crypto.randomUUID();
      const child = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, parentId));
      const input = runInput(crypto.randomUUID(), { workspaceId, parentId, parentKind: room ? "workstream" : "automation",
        triggerMessageId, executionPrincipal: { type: "user", userId: other } });
      await runInDurableObject(child, async (_instance, state) => {
        seedWorkstreamRoot(state, Date.now(), { workspaceId, workstreamId: parentId });
        await seedParticipantMessage(state, { id: triggerMessageId, sequence: 1, authorUserId: other, text: "Allow this Sidekick to act as me." });
        seedExecutionReceipt(state, input.harnessRunId, input, Date.now());
      });
      const runs = createHarnessRunObjectPort(env, workspaceId, parentId);
      const claim = await claimHarnessAttempt(runs, input, { attemptId: crypto.randomUUID(), owner: "first", leaseSeconds: 300 });
      if (claim.state !== "claimed") throw new Error("consent_recovery_test_claim_failed");
      const receipts = createToolReceiptObjectPort(env, workspaceId, parentId);
      const tool = sidekickDelegationTools(env, input, other, room)[2]!;
      const args = { sidekickId, userId: other, allowed: true };
      const admit = async (effectIntentId: string, toolCallId: string, lease = claim.lease) => {
        await receipts.admit({ effectIntentId, runId: input.harnessRunId, toolCallId, toolName: tool.definition.name,
          mode: "write", connectionId: null, requestHash: "consent-request", inputJson: JSON.stringify(args),
          executionPlanHash: "consent-plan", executionPlanJson: JSON.stringify({ pluginId: "rally:sidekicks",
            canonicalToolName: tool.definition.name, capability: tool.definition.capability, mode: "write", idempotency: "record_before_execute" }),
          compatiblePriorPlanHashes: [], providerIdempotencyKey: null,
          fence: { runId: input.harnessRunId, attemptId: lease.attemptId, owner: lease.owner }, now: Date.now() });
        return (await receipts.receiptForCall({ runId: input.harnessRunId, toolCallId }))!;
      };
      const accepted = await admit(crypto.randomUUID(), "accepted");
      await tool.execute(args, { workspaceId, workstreamId: parentId, harnessRunId: input.harnessRunId, toolCallId: "accepted",
        effectIntentId: accepted.effectIntentId, executionPrincipal: input.executionPrincipal, signal: new AbortController().signal });
      if (status === "ambiguous") await runInDurableObject(child, (_instance, state) => state.storage.sql.exec(
        "UPDATE tool_effects SET status='ambiguous' WHERE effect_intent_id=?", accepted.effectIntentId));
      // A dead owner's lease must expire before another attempt can claim it.
      // Stage that boundary rather than making this test wait five minutes.
      await runInDurableObject(child, (_instance, state) => state.storage.sql.exec(
        "UPDATE runs SET lease_expires_at=? WHERE run_id=?", Date.now() - 1, input.harnessRunId));
      await evictDurableObject(child);
      const replacement = await claimHarnessAttempt(runs, input, { attemptId: crypto.randomUUID(), owner: "replacement", leaseSeconds: 300 });
      if (replacement.state !== "claimed") throw new Error(`consent_recovery_test_replacement_${replacement.state}`);
      const interrupted = (await receipts.receiptForCall({ runId: input.harnessRunId, toolCallId: "accepted" }))!;
      const result = await reenterInterruptedWriteForRecovery(env, input, { ...interrupted, startedAt: interrupted.startedAt ?? 0 }, replacement.lease, runs);
      expect(result).toMatchObject({ outcome: "completed", result: { output: { sidekickId, userId: other, allowed: true, changed: true } } });
      const completed = (await receipts.receiptForCall({ runId: input.harnessRunId, toolCallId: "accepted" }))!;
      expect(completed.status).toBe("completed");
      const output = await env.PAYLOADS.get(completed.outputRef!);
      expect(await output!.json()).toEqual({ replayVersion: 1, output: { sidekickId, userId: other, allowed: true, changed: true } });
      // A call interrupted before acceptance must not prepare the old intent
      // again after a withdrawal has advanced its generation.
      const missing = await admit(crypto.randomUUID(), "unaccepted", replacement.lease);
      const stale = await admit(crypto.randomUUID(), "superseded", replacement.lease);
      await tool.execute(args, { workspaceId, workstreamId: parentId, harnessRunId: input.harnessRunId, toolCallId: "superseded",
        effectIntentId: stale.effectIntentId, executionPrincipal: input.executionPrincipal, signal: new AbortController().signal });
      await stub().sidekickSetDelegation(await prepare(false, other));
      expect(await reenterInterruptedWriteForRecovery(env, input, { ...missing, startedAt: missing.startedAt ?? 0 }, replacement.lease, runs))
        .toEqual({ outcome: "unknown", reason: "sidekick_delegation_stale_action" });
      expect(await reenterInterruptedWriteForRecovery(env, input, { ...stale, startedAt: stale.startedAt ?? 0 }, replacement.lease, runs))
        .toEqual({ outcome: "unknown", reason: "sidekick_delegation_stale_action" });
      expect((await own(other)).delegations[0]).toMatchObject({ allowed: false, eligible: false });
      expect(await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
        "SELECT count(*) AS count FROM sidekick_delegation_receipts WHERE sidekick_id=?", sidekickId).one().count)).toBe(4);
    });

  it("initializes creators automatically once and never recreates their withdrawn consent on creation replay", async () => {
    await create();
    expect(await own()).toEqual({ userId: creator, delegations: [{ sidekickId, label: "New Sidekick", allowed: true, eligible: true }] });
    await stub().sidekickSetDelegation(await prepare(false));
    expect(await create()).toEqual({ created: false });
    expect((await own()).delegations).toEqual([{ sidekickId, label: "New Sidekick", allowed: false, eligible: false }]);
    expect(await stub().sidekickReadDelegation({ ...address, actor: { userId: creator, participantOfOwningWorkstream: false } })).toEqual({
      sidekickId, creatorUserId: creator,
      creator: { userId: creator, displayName: "Member", avatarUrl: null, presentation: null },
      you: { userId: creator, allowed: false }, delegates: [],
    });
  });

  it("automatically enrolls the creator when an autonomous worker creates a Sidekick", async () => {
    await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
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
    ]);
    const input = runInput(crypto.randomUUID(), { workspaceId, parentId: sidekickId,
      triggerMessageId: null, backgroundAgent: true, executionPrincipal: { type: "user", userId: creator } });
    const context = { workspaceId, workstreamId: sidekickId, harnessRunId: input.harnessRunId,
      toolCallId: "autonomous-create", effectIntentId: crypto.randomUUID(), executionPrincipal: input.executionPrincipal,
      signal: new AbortController().signal };
    const created = await new AgentCommunicationService(env, input).createSidekick("workspace", context);
    expect((await own()).delegations).toEqual([{ sidekickId: created.sidekickId, label: "New Sidekick", allowed: true, eligible: true }]);
  });

  it.each([null, creator])("enrolls an earlier creator without provenance (legacy task account %s) and preserves withdrawal", async (legacyAccount) => {
    await create();
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM sidekick_delegations WHERE sidekick_id=? AND user_id=?", sidekickId, creator);
      state.storage.sql.exec("UPDATE automation_directory SET legacy_account_user_id=?,delegation_migrated=0 WHERE automation_id=?", legacyAccount, sidekickId);
    });
    expect((await stub().sidekickReadExecutionDelegation(address)).delegates.map((grant) => grant.userId)).toEqual([creator]);
    await stub().sidekickSetDelegation(await prepare(false));
    await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec(
      "UPDATE automation_directory SET delegation_migrated=0 WHERE automation_id=?", sidekickId));
    expect((await stub().sidekickReadExecutionDelegation(address)).delegates).toEqual([]);
  });

  it("lets a viewer opt in without acquiring management rights or replacing the creator", async () => {
    await create();
    await stub().sidekickSetDelegation(await prepare(true, other));
    const list = await stub().sidekickReadDelegation({ ...address, actor: { userId: other, participantOfOwningWorkstream: false } });
    expect(list).toEqual({
      sidekickId, creatorUserId: creator,
      creator: { userId: creator, displayName: "Member", avatarUrl: null, presentation: null },
      you: { userId: other, allowed: true },
      delegates: [
        { userId: creator, displayName: "Member", eligible: true, avatarUrl: null, presentation: null },
        { userId: other, displayName: "Other person", eligible: true, avatarUrl: null, presentation: null },
      ],
    });
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickPause({ ...address, actor: { userId: other, participantOfOwningWorkstream: false } })).rejects.toThrow("You cannot manage this Sidekick");
    });
    const detail = AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: { userId: creator, participantOfOwningWorkstream: false } }));
    expect(detail.runAsUserId).toBe(creator);
  });

  it("withdraws a grant and rejects both delayed first delivery and refreshed preparation of the old allow", async () => {
    await create();
    const delayed = await prepare(true);
    expect(await stub().sidekickSetDelegation(await prepare(false))).toEqual({ sidekickId, userId: creator, allowed: false, changed: true });
    expect(await stub().sidekickPrepareMyDelegation({ ...address, userId: creator, allowed: true, operationId: delayed.operationId })).toEqual({ generation: 1 });
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickSetDelegation(delayed)).rejects.toThrow("This delegation changed after this request was prepared");
    });
    expect((await own()).delegations[0]).toMatchObject({ allowed: false, eligible: false });
    await stub().sidekickSetDelegation(await prepare(true));
    expect((await own()).delegations[0]).toMatchObject({ allowed: true, eligible: true });
  });

  it("replays accepted receipts without granting again and refuses stale allow receipts after withdrawal", async () => {
    await create();
    const allow = await prepare(true);
    const accepted = await stub().sidekickSetDelegation(allow);
    expect(await stub().sidekickSetDelegation(allow)).toEqual(accepted);
    expect(await stub().sidekickSetDelegation(await prepare(true))).toMatchObject({ allowed: true, changed: false });
    await stub().sidekickSetDelegation(await prepare(false));
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickSetDelegation(allow)).rejects.toThrow("This delegation changed after this request was prepared");
    });
    expect((await own()).delegations[0]).toMatchObject({ allowed: false, eligible: false });
  });

  it("reads exact self-action receipts without reviving withdrawn or unavailable grants", async () => {
    await create();
    const prepared = { ...await prepare(true, other), source: "agent_request" as const };
    const accepted = await stub().sidekickSetDelegation(prepared);
    const lookup = { ...address, userId: other, operationId: prepared.operationId, allowed: true, source: "agent_request" as const };
    expect(await stub().sidekickReadMyDelegationReceipt(lookup)).toMatchObject({ outcome: "accepted", result: accepted, grant: { generation: 1 } });
    expect(await stub().sidekickReadMyDelegationReceipt({ ...lookup, allowed: false })).toEqual({ outcome: "stale" });
    expect(await stub().sidekickReadMyDelegationReceipt({ ...lookup, userId: creator })).toEqual({ outcome: "stale" });
    expect(await stub().sidekickReadMyDelegationReceipt({ ...lookup, operationId: crypto.randomUUID() })).toEqual({ outcome: "missing" });
    await stub().applyMemberStatus({ workspaceId, sequence: 1, removed: true, relationship: {
      workspaceId, userId: other, accessClass: "member", role: "member", status: "active", incarnation: "existing-member", revision: 1,
    } });
    expect(await stub().sidekickReadMyDelegationReceipt(lookup)).toEqual({ outcome: "unavailable" });
    const withdrawal = await prepare(false, other);
    await stub().sidekickSetDelegation(withdrawal);
    expect(await stub().sidekickReadMyDelegationReceipt(lookup)).toEqual({ outcome: "stale" });
    expect(await stub().sidekickReadMyDelegationReceipt({ ...lookup, allowed: false, source: "self_service", operationId: withdrawal.operationId }))
      .toMatchObject({ outcome: "accepted", result: { allowed: false }, grant: { generation: 2 } });
    expect((await own(other)).delegations).toEqual([{ sidekickId, label: "Unavailable Sidekick", allowed: false, eligible: false }]);
  });

  it("refuses an old acknowledgement after withdrawal and regrant to the same eligible person", async () => {
    await create();
    const original = await prepare(true, other);
    await stub().sidekickSetDelegation(original);
    await stub().sidekickSetDelegation(await prepare(false, other));
    const current = await prepare(true, other);
    await stub().sidekickSetDelegation(current);
    expect((await own(other)).delegations[0]).toMatchObject({ allowed: true, eligible: true });
    const lookup = { ...address, userId: other, allowed: true, source: "self_service" as const };
    expect(await stub().sidekickReadMyDelegationReceipt({ ...lookup, operationId: original.operationId })).toEqual({ outcome: "stale" });
    expect(await stub().sidekickReadMyDelegationReceipt({ ...lookup, operationId: current.operationId }))
      .toMatchObject({ outcome: "accepted", grant: { generation: 3 } });
  });

  it("keeps own reconciliation and withdrawal usable after membership loss, and rejoining does not revive an old incarnation", async () => {
    await create();
    const relationship = {
      workspaceId, userId: creator, status: "active" as const, role: "member" as const,
      accessClass: "member" as const, incarnation: "existing-member", revision: 1,
    };
    await stub().applyMemberStatus({ workspaceId, sequence: 1, removed: true, relationship });
    expect((await own()).delegations[0]).toMatchObject({ allowed: true, eligible: false });
    await stub().applyMemberStatus({ workspaceId, sequence: 2, removed: false, relationship: { ...relationship, incarnation: "rejoined-member" } });
    expect((await own()).delegations[0]).toMatchObject({ allowed: true, eligible: false });
    await stub().applyMemberStatus({ workspaceId, sequence: 3, removed: true, relationship: { ...relationship, incarnation: "rejoined-member" } });
    expect(await stub().sidekickSetDelegation(await prepare(false))).toMatchObject({ allowed: false, changed: true });
    expect((await own()).delegations[0]).toMatchObject({ allowed: false, eligible: false });
  });

  it("does not disclose or enroll a personal Sidekick to another member", async () => {
    await create("personal");
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickReadDelegation({ ...address, actor: { userId: other, participantOfOwningWorkstream: false } })).rejects.toThrow("This Sidekick is unavailable to you");
      const request = { ...address, userId: other, operationId: crypto.randomUUID(), allowed: true };
      const prepared = await instance.sidekickPrepareMyDelegation(request);
      await expect(instance.sidekickSetDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" }))
        .rejects.toThrow("This Sidekick is unavailable to you");
    });
    expect(await own(other)).toEqual({ userId: other, delegations: [] });
  });

  it("resolves viewer-visible names and canonical links and retains account recovery after losing membership", async () => {
    await create();
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE automation_directory SET title='Content calendar' WHERE automation_id=?", sidekickId);
    });
    const service = new SidekickDelegationService(env, workspaceId, other);
    expect((await service.listDelegates("Content calendar")).sidekickId).toBe(sidekickId);
    const link = sidekickCanonicalUrl(env.PUBLIC_WEB_BASE_URL, { region: "global", workspaceId, sidekickId });
    expect((await service.listDelegates(link)).sidekickId).toBe(sidekickId);
    await service.setOwn(sidekickId, true, crypto.randomUUID(), "self_service");
    await stub().applyMemberStatus({ workspaceId, sequence: 1, removed: true, relationship: {
      workspaceId, userId: other, accessClass: "member", role: "member", status: "active", incarnation: "existing-member", revision: 1,
    } });
    expect(await service.listOwn()).toEqual({
      userId: other, delegations: [{ sidekickId, label: "Content calendar", allowed: true, eligible: false }],
    });
    await service.setOwn(sidekickId, false, crypto.randomUUID(), "self_service");
    expect((await service.listOwn()).delegations[0]).toMatchObject({ allowed: false, eligible: false });
  });

  it("names the malformed delegate presentation field across RPC without its value", async () => {
    await create();
    await env.DB.prepare("UPDATE users SET presentation_json=? WHERE id=?")
      .bind(JSON.stringify({ revision: "private-value" }), creator).run();
    const error = await stub().sidekickReadDelegation({ ...address, actor: { userId: creator, participantOfOwningWorkstream: false } })
      .then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/sidekick_delegate_presentation_invalid.*revision/u);
    expect((error as Error).message).not.toContain("private-value");
  });

  it("refuses completed grant replay cleanly when its actor loses Organization access", async () => {
    await create();
    const operationId = crypto.randomUUID();
    const service = new SidekickDelegationService(env, workspaceId, other);
    await service.setFor(sidekickId, creator, true, operationId, "agent_request");
    await stub().applyMemberStatus({ workspaceId, sequence: 1, removed: true, relationship: {
      workspaceId, userId: other, accessClass: "member", role: "member", status: "active", incarnation: "existing-member", revision: 1,
    } });
    expect(await service.readReceipt(sidekickId, creator, true, operationId, "agent_request")).toEqual({ outcome: "unavailable" });
    expect((await own()).delegations[0]).toMatchObject({ allowed: true });
  });

  it("lets an autonomous execution manage another Organization user's delegation", async () => {
    await create();
    const parentId = crypto.randomUUID();
    const input = runInput(crypto.randomUUID(), { workspaceId, parentId, triggerMessageId: null,
      backgroundAgent: true, executionPrincipal: { type: "user", userId: other } });
    const authoring = sidekickDelegationTools(env, input, other, false);
    const room = sidekickDelegationTools(env, input, other, true);
    expect(authoring.map((tool) => `sidekick_${tool.definition.name}`)).toEqual(room.map((tool) => tool.definition.name));
    expect(room.map((tool) => tool.definition.name)).toEqual(["sidekick_my_delegations_list", "sidekick_delegates_list", "sidekick_set_delegation"]);
    const set = room[2]!;
    expect(set.validateInput?.({ sidekickId, allowed: true, userId: creator })).toBeNull();
    expect(set.validateInput?.({ sidekickId })).not.toBeNull();
    const context = { workspaceId, workstreamId: parentId, harnessRunId: input.harnessRunId, toolCallId: "set-1",
      effectIntentId: crypto.randomUUID(), executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    expect((await set.execute({ sidekickId, userId: other, allowed: true }, context)).output).toEqual({ sidekickId, userId: other, allowed: true, changed: true });
    const replayPlugins = [{ canonicalId: "rally:test", modelId: "rally_test", shortWireName: "test", preload: false, description: "test", tools: room }];
    const replayPolicy = { pluginId: "rally:test", canonicalToolName: set.definition.name, capability: set.definition.capability,
      mode: set.definition.mode, idempotency: set.definition.idempotency };
    expect(await validateCompletedToolReplay(replayPlugins, replayPolicy, { sidekickId, userId: other, allowed: true }, context)).toBeNull();
    expect((await room[0]!.execute({}, context)).output).toEqual({ userId: other, delegations: [{ sidekickId, label: "Unavailable Sidekick", allowed: true, eligible: true }] });
    expect((await set.execute({ sidekickId, userId: other, allowed: false }, { ...context, effectIntentId: crypto.randomUUID() })).output).toEqual({ sidekickId, userId: other, allowed: false, changed: true });
    expect(await validateCompletedToolReplay(replayPlugins, replayPolicy, { sidekickId, userId: other, allowed: true }, context)).toEqual({ refusal: {
      code: "sidekick_delegation_stale_action", message: "This delegation changed after this request was prepared. Read the current delegation state. Use a new delegation change to allow it again.",
    } });
    const receipts = await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM sidekick_delegation_receipts WHERE sidekick_id=?", sidekickId).one().count);
    expect(receipts).toBe(3);
    expect((await own(other)).delegations[0]).toMatchObject({ allowed: false, eligible: false });
    expect((await own()).delegations[0]).toMatchObject({ allowed: true });
    // The autonomous agent can target a different current Organization user.
    expect((await set.execute({ sidekickId, userId: creator, allowed: false },
      { ...context, effectIntentId: crypto.randomUUID() })).output).toEqual({ sidekickId, userId: creator, allowed: false, changed: true });
    expect((await own()).delegations[0]).toMatchObject({ allowed: false });
    expect((await set.execute({ sidekickId, userId: creator, allowed: true },
      { ...context, effectIntentId: crypto.randomUUID() })).output).toEqual({ sidekickId, userId: creator, allowed: true, changed: true });
    await expect(set.execute({ sidekickId, userId: asUserId(crypto.randomUUID()), allowed: true },
      { ...context, effectIntentId: crypto.randomUUID() })).rejects.toThrow("Organization membership is unavailable");
  });
});
