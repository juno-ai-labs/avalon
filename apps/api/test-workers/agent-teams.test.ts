/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { agentIdForAddress, asSubstreamId, asWorkspaceId } from "@rally/contracts";
import { workspaceDOName } from "../src/durable-objects/names";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000f70");
const firstParent = "00000000-0000-7000-8000-000000000f71";
const secondParent = "00000000-0000-7000-8000-000000000f72";
const sidekickParent = "00000000-0000-7000-8000-000000000f73";
const root = agentIdForAddress({ parentKind: "canvas", parentId: firstParent, substreamId: asSubstreamId("0") });
const second = agentIdForAddress({ parentKind: "canvas", parentId: secondParent, substreamId: asSubstreamId("0") });
const sidekick = agentIdForAddress({ parentKind: "automation", parentId: sidekickParent, substreamId: asSubstreamId("0") });
const worker = agentIdForAddress({ parentKind: "canvas", parentId: firstParent, substreamId: asSubstreamId("00000000-0000-7000-8000-000000000f74") });
const nested = agentIdForAddress({ parentKind: "canvas", parentId: firstParent, substreamId: asSubstreamId("00000000-0000-7000-8000-000000000f75") });
const address = { workspaceId: WORKSPACE_ID };
function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM agent_message_routes");
    state.storage.sql.exec("DELETE FROM agent_delegations");
    state.storage.sql.exec("DELETE FROM agent_team_members");
    state.storage.sql.exec("DELETE FROM agent_teams");
  });
});

describe("durable agent teams", () => {
  it("keeps a shared Sidekick in both teams without joining their rosters or ownership", async () => {
    const firstTeam = await workspace().ensureAgentTeam({ ...address, originAgentId: root });
    const secondTeam = await workspace().ensureAgentTeam({ ...address, originAgentId: second });
    await workspace().joinAgentTeam({ ...address, teamId: firstTeam.teamId, agentId: sidekick });
    await workspace().joinAgentTeam({ ...address, teamId: secondTeam.teamId, agentId: sidekick });
    await workspace().joinAgentTeam({ ...address, teamId: firstTeam.teamId, agentId: sidekick });
    expect(await workspace().listAgentTeammates({ ...address, teamId: firstTeam.teamId, requesterAgentId: sidekick }))
      .toEqual({ ok: true, value: { agentIds: [sidekick, root].sort() } });
    expect(await workspace().listAgentTeammates({ ...address, teamId: secondTeam.teamId, requesterAgentId: sidekick }))
      .toEqual({ ok: true, value: { agentIds: [sidekick, second].sort() } });
    expect(await workspace().ownedAgentDescendants({ ...address, agentId: root })).toEqual({ agentIds: [] });
    expect(await workspace().resolveAgentMessage({ ...address, messageId: crypto.randomUUID(), senderAgentId: root, recipientAgentId: second }))
      .toEqual({ ok: false, code: "agent_not_teammate" });
  });

  it("returns replies to the original sender in the original team and preserves replay identities", async () => {
    const { teamId } = await workspace().ensureAgentTeam({ ...address, originAgentId: root });
    await workspace().joinAgentTeam({ ...address, teamId, agentId: sidekick });
    const messageId = crypto.randomUUID();
    const sent = await workspace().resolveAgentMessage({ ...address, messageId, senderAgentId: root, recipientAgentId: sidekick });
    expect(await workspace().resolveAgentMessage({ ...address, messageId, senderAgentId: root, recipientAgentId: sidekick })).toEqual(sent);
    const replyId = crypto.randomUUID();
    expect(await workspace().resolveAgentMessage({ ...address, messageId: replyId, senderAgentId: sidekick, replyToMessageId: messageId }))
      .toEqual({ ok: true, value: { messageId: replyId, teamId, senderAgentId: sidekick, recipientAgentId: root } });
    expect(await workspace().resolveAgentMessage({ ...address, messageId: crypto.randomUUID(), senderAgentId: root, replyToMessageId: messageId }))
      .toEqual({ ok: false, code: "agent_message_not_received" });
    expect(await workspace().resolveAgentMessage({ ...address, messageId, senderAgentId: sidekick, recipientAgentId: root }))
      .toEqual({ ok: false, code: "agent_message_identity_conflict" });
  });

  it("tracks nested owned descendants independently of teammates and refuses reparenting", async () => {
    const { teamId } = await workspace().ensureAgentTeam({ ...address, originAgentId: root });
    await workspace().registerAgentDelegation({ ...address, teamId, ownerAgentId: root, agentId: worker });
    await workspace().registerAgentDelegation({ ...address, teamId, ownerAgentId: worker, agentId: nested });
    await workspace().registerAgentDelegation({ ...address, teamId, ownerAgentId: worker, agentId: nested });
    await workspace().joinAgentTeam({ ...address, teamId, agentId: sidekick });
    expect(await workspace().ownedAgentDescendants({ ...address, agentId: root })).toEqual({ agentIds: [worker, nested].sort() });
    expect(await workspace().ownedAgentDescendants({ ...address, agentId: worker })).toEqual({ agentIds: [nested] });
    expect(await workspace().registerAgentDelegation({ ...address, teamId, ownerAgentId: root, agentId: nested }))
      .toEqual({ ok: false, code: "agent_ownership_conflict" });
    expect(await workspace().registerAgentDelegation({ ...address, teamId, ownerAgentId: nested, agentId: root }))
      .toEqual({ ok: false, code: "agent_ownership_cycle" });
  });

  it("leaves a Thread-era teammate out of the roster, and names the retired kind for its owner and its message", async () => {
    const { teamId } = await workspace().ensureAgentTeam({ ...address, originAgentId: root });
    await workspace().registerAgentDelegation({ ...address, teamId, ownerAgentId: root, agentId: worker });
    const thread = "workstream/00000000-0000-7000-8000-000000000f76/0";
    const messageId = crypto.randomUUID();
    // Rows a Thread wrote before Threads were retired; no current writer can.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("INSERT INTO agent_team_members VALUES (?, ?)", teamId, thread);
      state.storage.sql.exec("UPDATE agent_delegations SET owner_agent_id = ? WHERE agent_id = ?", thread, worker);
      state.storage.sql.exec("INSERT INTO agent_message_routes VALUES (?, ?, ?, ?)", messageId, teamId, thread, root);
    });

    expect(await workspace().listAgentTeammates({ ...address, teamId, requesterAgentId: root }))
      .toEqual({ ok: true, value: { agentIds: [root, worker].sort() } });
    expect(await workspace().agentOwner({ ...address, agentId: worker }))
      .toEqual({ ok: false, code: "conversation_parent_kind_retired:workstream" });
    expect(await workspace().resolveAgentMessage({ ...address, messageId: crypto.randomUUID(), senderAgentId: root, replyToMessageId: messageId }))
      .toEqual({ ok: false, code: "conversation_parent_kind_retired:workstream" });
  });
});
