/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Two Channels hosted in one Organization object never read each other's rows.
 *
 * Every hosted parent's rows share the same tables in `WorkspaceDO`, keyed by
 * `parent_id`, so the filter on that column is the only wall between two
 * Channels. One Organization, two Channels, one person who belongs to both,
 * and one who belongs only to the second: each path the review named is driven
 * against the first Channel and read back against the second.
 * `docs/hosted-conversation-parents.md` owns the layout.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { ScopeGrantTarget } from "@rally/contracts/scope-grants";
import { beforeEach, describe, expect, it } from "vitest";

import { hostedParentStub, withHostedParent } from "./helpers/hosted-parent";
import { LINK_PAYLOADS_TABLE } from "./helpers/link-payloads-table";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000e0001");
const channelA = asWorkstreamId("00000000-0000-4000-8000-0000000e00a0");
const channelB = asWorkstreamId("00000000-0000-4000-8000-0000000e00b0");
const breakoutA = asSubstreamId("00000000-0000-4000-8000-0000000e00a1");
const breakoutB = asSubstreamId("00000000-0000-4000-8000-0000000e00b1");
/** In both Channels. */
const shared = asUserId("00000000-0000-4000-8000-0000000e0011");
/** Only in Channel B. */
const onlyB = asUserId("00000000-0000-4000-8000-0000000e0012");
/** In neither until somebody shares a Channel with them. */
const recipient = asUserId("00000000-0000-4000-8000-0000000e0013");
const sessionId = "hosted-parent-isolation-session";
const spaceId = "00000000-0000-4000-8000-0000000e0021";

const whole = (parentId: string): ScopeGrantTarget => ({ kind: "workstream", workspaceId, parentId });
const main = (parentId: string): ScopeGrantTarget => ({
  kind: "conversation", workspaceId, parentId, substreamId: asSubstreamId("0"),
});
const organization = () => hostedParentStub(env, workspaceId);

/** A grant written straight into the parent's store, as its creator's would be. */
async function seedGrant(parentId: string, userId: string): Promise<void> {
  await withHostedParent(organization(), parentId, (hosted) => {
    const result = hosted["scopeGrants"]({ workspaceId, parentId }).mutate({
      operationId: crypto.randomUUID(), actorUserId: userId, userId, target: whole(parentId),
      active: true, expectedRevision: 0,
    }, userId);
    if (result.status !== "committed") throw new Error(`seed grant for ${userId} was ${result.status}`);
  });
}

async function grantRevision(parentId: string, userId: string): Promise<number> {
  return withHostedParent(organization(), parentId, (hosted) =>
    hosted["scopeGrants"]({ workspaceId, parentId }).read(asUserId(userId), whole(parentId))!.revision);
}

function share(parentId: string, userId: string, active: boolean, expectedRevision: number) {
  return organization().mutateScopeGrant({
    operationId: crypto.randomUUID(), actorUserId: shared, userId, target: whole(parentId), active, expectedRevision,
  });
}

beforeEach(async () => {
  await reset();
  const people = [shared, onlyB, recipient];
  await env.DB.batch([
    env.DB.prepare(LINK_PAYLOADS_TABLE),
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT)"),
    ...people.map((id) => env.DB.prepare(
      "INSERT INTO users VALUES (?, 'Person', 'person@example.test', NULL, 'UTC', '2026-09-25T00:00:00.000Z')",
    ).bind(id)),
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, abandoned_at TEXT, region TEXT DEFAULT 'global',
      placement_affinity TEXT DEFAULT 'wnam', analytics_workspace_id TEXT)`),
    env.DB.prepare("INSERT INTO workspaces (id) VALUES (?)").bind(workspaceId),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, access_class TEXT,
      role TEXT, status TEXT, incarnation TEXT, revision INTEGER)`),
    // Guests, so nothing but a grant in the Channel itself admits anybody.
    ...people.map((id) => env.DB.prepare(
      "INSERT INTO workspace_members VALUES (?, ?, 'guest', NULL, 'active', ?, 1)",
    ).bind(workspaceId, id, id)),
    env.DB.prepare(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL, workspace_incarnation TEXT)`),
    env.DB.prepare("INSERT INTO sessions VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z', ?)")
      .bind(sessionId, shared, workspaceId, shared),
  ]);
  await organization().initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(organization(), (_instance, state) => {
    for (const [parentId, title, breakout] of [[channelA, "Channel A", breakoutA], [channelB, "Channel B", breakoutB]] as const) {
      state.storage.sql.exec(`INSERT INTO parent_metadata
        (parent_id, parent_kind, workspace_id, region, authority_generation, title, description, preview, scope,
         exact_state, last_activity_at, created_at, updated_at)
        VALUES (?, 'workstream', ?, 'global', 1, ?, '', '', 'personal', 'idle', 0, 0, 0)`, parentId, workspaceId, title);
      state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_at, title)
        VALUES (?, '0', 'main', 0, 'Main'), (?, ?, 'child', 0, 'Breakout')`, parentId, parentId, breakout);
    }
  });
  await seedGrant(channelA, shared);
  await seedGrant(channelB, shared);
  await seedGrant(channelB, onlyB);
});

describe("hosted parent isolation", () => {
  it("admits a person shared into Channel A to Channel A and not to Channel B", async () => {
    expect(await share(channelA, recipient, true, 0)).toMatchObject({ status: "committed" });

    expect(await organization().readScopeAccess({ userId: recipient, target: whole(channelA) }))
      .toMatchObject({ allowed: true });
    expect(await organization().readScopeAccess({ userId: recipient, target: main(channelA) }))
      .toMatchObject({ allowed: true });
    expect(await organization().readScopeAccess({ userId: recipient, target: whole(channelB) }))
      .toEqual({ allowed: false, reason: "grant_required" });
    expect(await organization().readScopeAccess({ userId: recipient, target: main(channelB) }))
      .toEqual({ allowed: false, reason: "grant_required" });
    expect(await organization().authorizeViewer({ workspaceId, parentId: channelB, userId: recipient }))
      .toMatchObject({ authorized: false });
  });

  it("leaves a person's Channel B grant standing when Channel A revokes theirs", async () => {
    expect(await share(channelA, recipient, true, 0)).toMatchObject({ status: "committed" });
    expect(await share(channelB, recipient, true, 0)).toMatchObject({ status: "committed" });

    const revoked = await share(channelA, recipient, false, await grantRevision(channelA, recipient));

    expect(revoked).toMatchObject({ status: "committed", grant: { active: false } });
    expect(await organization().readScopeAccess({ userId: recipient, target: whole(channelA) }))
      .toEqual({ allowed: false, reason: "grant_required" });
    expect(await organization().readScopeAccess({ userId: recipient, target: whole(channelB) }))
      .toMatchObject({ allowed: true, writable: true });
  });

  it("lists only Channel A's own conversations to a reader of both, and nothing of it to a reader of B alone", async () => {
    const read = (parentId: string, userId: string) => organization().readSharedWorkstream({
      workspaceId, parentId, userId, membershipIncarnation: userId,
    });

    expect(await read(channelA, shared)).toEqual({
      parentId: channelA, title: "Channel A", scope: "personal", archived: false,
      conversations: [{ substreamId: "0", title: "Main", scope: "personal", archived: false }],
    });
    expect(await read(channelB, shared)).toMatchObject({ parentId: channelB, title: "Channel B" });
    expect(await read(channelA, onlyB)).toBeNull();
  });

  it("refuses the last participant of Channel A leaving it, whoever remains in Channel B", async () => {
    const leaveA = await share(channelA, shared, false, await grantRevision(channelA, shared));
    expect(leaveA).toEqual({ status: "denied", reason: "participant_required" });

    // The same person may leave Channel B, where somebody else remains.
    const leaveB = await share(channelB, shared, false, await grantRevision(channelB, shared));
    expect(leaveB).toMatchObject({ status: "committed", grant: { active: false } });
  });

  it("claims a Space-seated reader as direct in Channel A without touching Channel B's attribution", async () => {
    await runInDurableObject(organization(), (_instance, state) => {
      for (const parentId of [channelA, channelB]) {
        state.storage.sql.exec(`INSERT INTO parent_space_sources
          (parent_id, space_id, scope, participants_json, space_revision, membership_generation, operation_id, applied_at, updated_at)
          VALUES (?, ?, 'personal', json(?), 1, 1, ?, 0, 0)`, parentId, spaceId, JSON.stringify([shared]), crypto.randomUUID());
        state.storage.sql.exec("INSERT INTO parent_space_readers (parent_id, space_id, user_id) VALUES (?, ?, ?)",
          parentId, spaceId, shared);
      }
    });

    expect(await organization().noteDirectReader({ workspaceId, parentId: channelA, userId: shared })).toEqual({ ok: true });

    await runInDurableObject(organization(), (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT parent_id, user_id FROM parent_space_readers ORDER BY parent_id",
      ).toArray()).toEqual([{ parent_id: channelB, user_id: shared }]);
    });
  });

  it("closes Channel A's control socket on a revocation for Channel A and leaves Channel B's open", async () => {
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec("UPDATE parent_metadata SET scope = 'workspace'");
    });
    const [socketA, socketB] = await Promise.all([openControlSocket(channelA), openControlSocket(channelB)]);
    const closedA = closeOf(socketA);
    const closedB = closeOf(socketB);

    const result = await organization().revokeParentSocketAccess({
      parentId: channelA,
      revocation: { reason: "workstream_participant_removed", workspaceId, userId: shared, sessionId: null },
    });

    expect(result.substreamIds).toEqual(["0", breakoutA]);
    expect(await closedA).toEqual({ code: 1008, reason: "You can no longer read this work stream" });
    // Channel B's socket is still served: the first close it sees is the one
    // this malformed frame earns, not the revocation's.
    try {
      socketB.send("not json");
    } catch {
      // A socket the revocation already closed refuses the frame; its close says so below.
    }
    expect(await closedB).toEqual({ code: 1008, reason: "Work-stream control events must be JSON" });
  });
});

async function openControlSocket(parentId: string): Promise<WebSocket> {
  const response = await organization().fetch("https://workspace.test/parent-socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": workspaceId,
      "x-rally-workstream-id": parentId,
      "x-rally-user-id": shared,
      "x-rally-session-id": sessionId,
      "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  return socket;
}

function closeOf(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
  });
}
