/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AutomationDetailSchema, asUserId, asWorkspaceId, sidekickCanonicalUrl } from "@rally/contracts";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { seedWorkspaceControlPlane, seedWorkstreamRoot, seedParticipantMessage, runInput } from "./helpers/substream-fixture";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { directSidekickDelegationUser, SidekickDelegationService, ownSidekickDelegationsAcrossOrganizations } from "../src/services/sidekick-delegation-service";
import { sidekickDelegationTools } from "../src/services/sidekick-delegation-tools";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000de00");
const creator = asUserId("00000000-0000-7000-8000-00000000de01");
const other = asUserId("00000000-0000-7000-8000-00000000de02");
const sidekickId = "00000000-0000-7000-8000-00000000de03";
const address = { workspaceId, automationId: sidekickId };
const stub = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
useHeldEffectQueue();

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: creator, sessionId: crypto.randomUUID() });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,status,role) VALUES (?,?,'active','member')`).bind(workspaceId, other),
    env.DB.prepare(`INSERT INTO users(id,name) VALUES (?,'Other person')`).bind(other),
  ]);
});

async function create(direct = false, scope: "personal" | "workspace" = "workspace") {
  return stub().sidekickCreate({
    ...address, authorUserId: creator, scope, owningWorkstreamId: null, authorityGeneration: 1,
    ...(direct ? { creatorConsent: { requestId: crypto.randomUUID() } } : {}),
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
  it("initializes direct creators once and never recreates their withdrawn consent on creation replay", async () => {
    await create(true);
    expect(await own()).toEqual({ userId: creator, delegations: [{ sidekickId, label: "New Sidekick", allowed: true, eligible: true }] });
    await stub().sidekickSetMyDelegation(await prepare(false));
    expect(await create(true)).toEqual({ created: false });
    expect((await own()).delegations).toEqual([{ sidekickId, label: "New Sidekick", allowed: false, eligible: false }]);
  });

  it("does not infer consent from the creator identity of autonomous or old callers", async () => {
    await create();
    expect(await own()).toEqual({ userId: creator, delegations: [] });
    const request = await prepare(true);
    expect(await stub().sidekickSetMyDelegation(request)).toEqual({ sidekickId, userId: creator, allowed: true, changed: true });
    expect((await own()).delegations[0]).toMatchObject({ allowed: true, eligible: true });
  });

  it("lets a viewer opt in without acquiring management rights or replacing the creator", async () => {
    await create(true);
    await stub().sidekickSetMyDelegation(await prepare(true, other));
    const list = await stub().sidekickReadDelegation({ ...address, actor: { userId: other, participantOfOwningWorkstream: false } });
    expect(list).toEqual({
      sidekickId, creatorUserId: creator, you: { userId: other, allowed: true },
      delegates: [
        { userId: creator, displayName: "Member", eligible: true },
        { userId: other, displayName: "Other person", eligible: true },
      ],
    });
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickPause({ ...address, actor: { userId: other, participantOfOwningWorkstream: false } })).rejects.toThrow("You cannot manage this Sidekick");
    });
    const detail = AutomationDetailSchema.parse(await stub().sidekickReadDetail({ ...address, actor: { userId: creator, participantOfOwningWorkstream: false } }));
    expect(detail.runAsUserId).toBe(creator);
  });

  it("withdraws an absent grant and rejects both delayed first delivery and refreshed preparation of the old allow", async () => {
    await create();
    const delayed = await prepare(true);
    expect(await stub().sidekickSetMyDelegation(await prepare(false))).toEqual({ sidekickId, userId: creator, allowed: false, changed: false });
    expect(await stub().sidekickPrepareMyDelegation({ ...address, userId: creator, allowed: true, operationId: delayed.operationId })).toEqual({ generation: 0 });
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickSetMyDelegation(delayed)).rejects.toThrow("This delegation changed after this request was prepared");
    });
    expect((await own()).delegations[0]).toMatchObject({ allowed: false, eligible: false });
    await stub().sidekickSetMyDelegation(await prepare(true));
    expect((await own()).delegations[0]).toMatchObject({ allowed: true, eligible: true });
  });

  it("replays accepted receipts without granting again and refuses stale allow receipts after withdrawal", async () => {
    await create();
    const allow = await prepare(true);
    const accepted = await stub().sidekickSetMyDelegation(allow);
    expect(await stub().sidekickSetMyDelegation(allow)).toEqual(accepted);
    expect(await stub().sidekickSetMyDelegation(await prepare(true))).toMatchObject({ allowed: true, changed: false });
    await stub().sidekickSetMyDelegation(await prepare(false));
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickSetMyDelegation(allow)).rejects.toThrow("This delegation changed after this request was prepared");
    });
    expect((await own()).delegations[0]).toMatchObject({ allowed: false, eligible: false });
  });

  it("lets managers remove a delegate but requires that person's new intent to regrant", async () => {
    await create(true);
    await stub().sidekickSetMyDelegation(await prepare(true, other));
    const oldAllow = await prepare(true, other);
    await stub().sidekickRemoveDelegate({ ...address, actor: { userId: creator, participantOfOwningWorkstream: false }, userId: other, operationId: crypto.randomUUID() });
    expect((await own(other)).delegations[0]).toMatchObject({ allowed: false, eligible: false });
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickSetMyDelegation(oldAllow)).rejects.toThrow("This delegation changed after this request was prepared");
    });
    await stub().sidekickSetMyDelegation(await prepare(true, other));
    expect((await own(other)).delegations[0]).toMatchObject({ allowed: true, eligible: true });
  });

  it("keeps own reconciliation and withdrawal usable after membership loss, and rejoining does not revive an old incarnation", async () => {
    await create(true);
    const relationship = {
      workspaceId, userId: creator, status: "active" as const, role: "member" as const,
      accessClass: "member" as const, incarnation: "existing-member", revision: 1,
    };
    await stub().applyMemberStatus({ workspaceId, sequence: 1, removed: true, relationship });
    expect((await own()).delegations[0]).toMatchObject({ allowed: true, eligible: false });
    await stub().applyMemberStatus({ workspaceId, sequence: 2, removed: false, relationship: { ...relationship, incarnation: "rejoined-member" } });
    expect((await own()).delegations[0]).toMatchObject({ allowed: true, eligible: false });
    await stub().applyMemberStatus({ workspaceId, sequence: 3, removed: true, relationship: { ...relationship, incarnation: "rejoined-member" } });
    expect(await stub().sidekickSetMyDelegation(await prepare(false))).toMatchObject({ allowed: false, changed: true });
    expect((await own()).delegations[0]).toMatchObject({ allowed: false, eligible: false });
  });

  it("does not disclose or enroll a personal Sidekick to another member", async () => {
    await create(true, "personal");
    await runInDurableObject(stub(), async (instance) => {
      await expect(instance.sidekickReadDelegation({ ...address, actor: { userId: other, participantOfOwningWorkstream: false } })).rejects.toThrow("This Sidekick is unavailable to you");
      await expect(instance.sidekickPrepareMyDelegation({ ...address, userId: other, allowed: true, operationId: crypto.randomUUID() })).rejects.toThrow("This Sidekick is unavailable to you");
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
    expect(await ownSidekickDelegationsAcrossOrganizations(env, other)).toEqual({ organizations: [{
      workspaceId, userId: other, delegations: [{ sidekickId, label: "Content calendar", allowed: true, eligible: false }],
    }] });
    await service.setOwn(sidekickId, false, crypto.randomUUID(), "self_service");
    expect((await service.listOwn()).delegations[0]).toMatchObject({ allowed: false, eligible: false });
  });

  it("binds consent to a real human trigger, with identical wire names and strict inputs in room and authoring tools", async () => {
    await create();
    const parentId = crypto.randomUUID();
    const triggerMessageId = crypto.randomUUID();
    const child = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, parentId));
    await runInDurableObject(child, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
      await seedParticipantMessage(state, { id: triggerMessageId, sequence: 1, authorUserId: other, text: "Allow this Sidekick to act as me." });
    });
    const input = runInput(crypto.randomUUID(), { workspaceId, parentId, triggerMessageId, executionPrincipal: { type: "user", userId: other } });
    expect(await directSidekickDelegationUser(env, input)).toBe(other);
    expect(await directSidekickDelegationUser(env, { ...input, backgroundAgent: true })).toBeNull();
    expect(await directSidekickDelegationUser(env, { ...input, scheduledWakeupId: crypto.randomUUID() })).toBeNull();
    expect(await directSidekickDelegationUser(env, { ...input, executionPrincipal: { type: "user", userId: creator } })).toBeNull();
    const authoring = sidekickDelegationTools(env, input, other, false);
    const room = sidekickDelegationTools(env, input, other, true);
    expect(authoring.map((tool) => `sidekick_${tool.definition.name}`)).toEqual(room.map((tool) => tool.definition.name));
    expect(room.map((tool) => tool.definition.name)).toEqual(["sidekick_my_delegations_list", "sidekick_delegates_list", "sidekick_set_my_delegation"]);
    const set = room[2]!;
    expect(set.validateInput?.({ sidekickId, allowed: true, userId: creator })).not.toBeNull();
    expect(set.validateInput?.({ sidekickId })).not.toBeNull();
    const context = { workspaceId, workstreamId: parentId, harnessRunId: input.harnessRunId, toolCallId: "set-1",
      effectIntentId: crypto.randomUUID(), executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    expect((await set.execute({ sidekickId, allowed: true }, context)).output).toEqual({ sidekickId, userId: other, allowed: true, changed: true });
    expect((await room[0]!.execute({}, context)).output).toEqual({ userId: other, delegations: [{ sidekickId, label: "Unavailable Sidekick", allowed: true, eligible: true }] });
    expect((await set.execute({ sidekickId, allowed: false }, { ...context, effectIntentId: crypto.randomUUID() })).output).toEqual({ sidekickId, userId: other, allowed: false, changed: true });
    expect((await own()).delegations).toEqual([]);
  });
});
