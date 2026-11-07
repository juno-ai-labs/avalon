import { WorkspaceService } from "../src/services/workspace-service";
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { workspaceDOName } from "../src/durable-objects/names";
import { dispatchWorkspaceRelationshipChanges, type WorkspaceRelationshipChangeMessage } from "../src/services/workspace-relationship-delivery";
import { consumeAccessRevocationQueue } from "../src/queues/access-revocation-consumer";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000061");
const userId = asUserId("00000000-0000-4000-8000-000000000062");
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
const message = (removed = false): WorkspaceRelationshipChangeMessage => ({
  kind: "workspace_relationship_changed", sequence: 1, removed,
  relationship: { workspaceId, userId, incarnation: "existing-member", revision: 2, accessClass: "member", role: "member", status: "active" },
});

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workstream_authority_control (id INTEGER PRIMARY KEY, phase TEXT, generation INTEGER, required_serving_contract_version INTEGER, serving_contract_version INTEGER)"),
    env.DB.prepare("INSERT INTO workstream_authority_control VALUES (1,'durable_object_open',1,1,1)"),
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY,region TEXT,placement_affinity TEXT,analytics_workspace_id TEXT,abandoned_at TEXT)"),
    env.DB.prepare("INSERT INTO workspaces (id,region,placement_affinity) VALUES (?,'global','wnam')").bind(workspaceId),
    env.DB.prepare("CREATE TABLE workspace_members (incarnation TEXT DEFAULT 'existing-member', workspace_id TEXT,user_id TEXT,role TEXT,status TEXT,last_seen_at TEXT,revision INTEGER DEFAULT 1,access_class TEXT DEFAULT 'member')"),
    env.DB.prepare("INSERT INTO workspace_members (incarnation,workspace_id,user_id,role,status,last_seen_at) VALUES ('existing-member',?,?,'member','active',NULL)").bind(workspaceId,userId),
    env.DB.prepare("CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member', id TEXT,user_id TEXT,workspace_id TEXT,region TEXT,revoked_at TEXT,expires_at TEXT, impersonator_user_id TEXT)"),
    env.DB.prepare("INSERT INTO sessions VALUES ('existing-member','session',?,?,'global',NULL,'2099-01-01T00:00:00.000Z', NULL)").bind(userId,workspaceId),
    // Runtime tests declare the D1 slice they use; the Node suite separately
    // proves the actual migration, triggers and foreign-key preservation.
    env.DB.prepare(`CREATE TABLE workspace_relationship_deliveries (sequence INTEGER PRIMARY KEY,
      workspace_id TEXT,user_id TEXT,incarnation TEXT,revision INTEGER,change_kind TEXT,access_class TEXT,
      role TEXT,status TEXT,dispatched_at TEXT,processed_at TEXT)`),
    env.DB.prepare(`INSERT INTO workspace_relationship_deliveries
      (sequence,workspace_id,user_id,incarnation,revision,change_kind,access_class,role,status)
      VALUES (1,?,?,'existing-member',2,'upsert','member','member','active')`).bind(workspaceId,userId),
  ]);
  await workspace().initializeWorkspace(workspaceId, "wnam");
});
afterEach(() => vi.restoreAllMocks());

async function consume(body: WorkspaceRelationshipChangeMessage) {
  const batch = createMessageBatch("avalon-do-runtime-test-access-revocations", [
    { id: crypto.randomUUID(), body, timestamp: new Date(), attempts: 1 },
  ]);
  await consumeAccessRevocationQueue(batch, env);
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([]);
}

it("keeps an intent pending if the dispatch marker fails, then safely retries the real queue send", async () => {
  const send = vi.spyOn(env.ACCESS_REVOCATION_QUEUE, "send");
  await env.DB.prepare(`CREATE TRIGGER fail_dispatch_marker BEFORE UPDATE OF dispatched_at ON workspace_relationship_deliveries
    BEGIN SELECT RAISE(ABORT, 'marker unavailable'); END`).run();
  expect(await dispatchWorkspaceRelationshipChanges(env)).toBe(0);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare("SELECT dispatched_at FROM workspace_relationship_deliveries").first()).toEqual({ dispatched_at: null });
  await env.DB.prepare("DROP TRIGGER fail_dispatch_marker").run();
  expect(await dispatchWorkspaceRelationshipChanges(env)).toBe(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(await dispatchWorkspaceRelationshipChanges(env)).toBe(0);
  expect(await env.DB.prepare("SELECT processed_at FROM workspace_relationship_deliveries").first()).toEqual({ processed_at: null });
});

it("processes promotion through real WorkspaceDO invalidation before recording root completion", async () => {
  await consume(message());
  await runInDurableObject(workspace(), (_instance, state) => {
    const row = state.storage.sql.exec<{ topics_json: string }>("SELECT topics_json FROM workspace_sync_events ORDER BY waterline DESC LIMIT 1").one();
    expect(JSON.parse(row.topics_json)).toEqual(expect.arrayContaining(["workspace_profile", "member_directory"]));
  });
  expect((await env.DB.prepare("SELECT processed_at FROM workspace_relationship_deliveries").first<{ processed_at: string | null }>())?.processed_at).not.toBeNull();
});

it("closes a real admitted workspace socket for a removed relationship", async () => {
  const response = await workspace().fetch("https://workspace.test/socket", { headers: {
    Upgrade: "websocket", "x-rally-workspace-id": workspaceId, "x-rally-placement-affinity": "wnam",
    "x-rally-user-id": userId, "x-rally-session-id": "session", "x-rally-socket-ticket-id": crypto.randomUUID(),
    "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1000) + 60),
  } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
  try {
    await env.DB.prepare("DELETE FROM workspace_members WHERE user_id=?").bind(userId).run();
    await env.DB.prepare("UPDATE workspace_relationship_deliveries SET change_kind='removed'").run();
    await consume(message(true));
    expect((await closed).code).toBe(1008);
  } finally { socket.close(1000, "test complete"); }
});

it("does not let delayed removal close a rejoined membership's socket", async () => {
  const connect = async (sessionId:string) => {
    const response = await workspace().fetch("https://workspace.test/socket",{ headers:{
      Upgrade:"websocket", "x-rally-workspace-id":workspaceId,"x-rally-placement-affinity":"wnam",
      "x-rally-user-id":userId,"x-rally-session-id":sessionId,"x-rally-socket-ticket-id":crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at":String(Math.floor(Date.now()/1000)+60),
    } });
    expect(response.status).toBe(101);
    const socket=response.webSocket!; socket.accept(); return socket;
  };
  const old = await connect("session");
  const closed = new Promise<CloseEvent>((resolve) => old.addEventListener("close",resolve,{ once:true }));
  await env.DB.prepare("DELETE FROM workspace_members WHERE user_id=?").bind(userId).run();
  await env.DB.prepare("INSERT INTO workspace_members (incarnation,workspace_id,user_id,role,status) VALUES ('replacement',?,?,'member','active')").bind(workspaceId,userId).run();
  await env.DB.prepare("INSERT INTO sessions VALUES ('replacement','new-session',?,?,'global',NULL,'2099-01-01T00:00:00.000Z', NULL)").bind(userId,workspaceId).run();
  const current = await connect("new-session");
  try {
    await consume(message(true));
    expect((await closed).code).toBe(1008);
    await runInDurableObject(workspace(),(_instance,state) => {
      const socket = state.getWebSockets().find((candidate) => candidate.deserializeAttachment().sessionId === "new-session");
      expect(socket?.readyState).toBe(WebSocket.OPEN);
    });
  } finally { old.close(); current.close(); }
});

it("lets an administrator remove a null-role guest and publishes its exact incarnation", async () => {
  const guestId=asUserId("00000000-0000-4000-8000-000000000063");
  await env.DB.prepare("UPDATE workspace_members SET role='owner' WHERE user_id=?").bind(userId).run();
  await env.DB.prepare("INSERT INTO workspace_members (incarnation,workspace_id,user_id,role,status,access_class) VALUES ('guest-incarnation',?,?,NULL,'active','guest')").bind(workspaceId,guestId).run();
  // The production deletion trigger records the intent consumed by immediate
  // dispatch; the Node migration suite owns its full schema integration.
  await env.DB.prepare(`CREATE TRIGGER workspace_member_delivery_delete AFTER DELETE ON workspace_members
    BEGIN
      INSERT INTO workspace_relationship_deliveries
        (workspace_id,user_id,incarnation,revision,change_kind,access_class,role,status)
      VALUES (OLD.workspace_id,OLD.user_id,OLD.incarnation,OLD.revision+1,'removed',OLD.access_class,OLD.role,OLD.status);
    END`).run();
  const sent = vi.spyOn(env.ACCESS_REVOCATION_QUEUE,"send");
  await new WorkspaceService(env,{ userId,workspaceId,role:"owner",region:"global",sessionId:"session" }).removeMember(guestId);
  expect(await env.DB.prepare("SELECT 1 FROM workspace_members WHERE user_id=?").bind(guestId).first()).toBeNull();
  expect(sent).toHaveBeenCalledWith(expect.objectContaining({ kind: "workspace_relationship_changed", removed: true,
    relationship: expect.objectContaining({ userId: guestId, incarnation: "guest-incarnation", accessClass: "guest", role: null, revision: 2 }) }));
});
