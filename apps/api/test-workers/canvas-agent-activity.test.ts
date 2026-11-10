/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId, WorkspaceSocketSyncEventSchema, WorkspaceCanvasListEventSchema } from "@rally/contracts";
import { ConversationEffectEnvelopeSchema, conversationEffectHash, WorkstreamDirectoryCommonEffectSchema } from "@rally/contracts/conversation-effects";
import type { CanvasSidebarRow } from "@rally/contracts/canvases";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { workspaceDOName } from "../src/durable-objects/names";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const userId = asUserId("00000000-0000-7000-8000-000000ac7101");
let workspaceId = asWorkspaceId(crypto.randomUUID());
let canvasId = asWorkstreamId(crypto.randomUUID());
let otherId = asWorkstreamId(crypto.randomUUID());
let sidekickId = crypto.randomUUID();
const workspace = () => env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, workspaceId)));

beforeEach(async () => {
  await reset();
  workspaceId = asWorkspaceId(crypto.randomUUID());
  canvasId = asWorkstreamId(crypto.randomUUID());
  otherId = asWorkstreamId(crypto.randomUUID());
  sidekickId = crypto.randomUUID();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId, sessionId: `session-${userId}` });
  await env.DB.exec("ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT DEFAULT 'wnam'");
  for (const id of [canvasId, otherId]) await workspace().canvasCreate({ workspaceId, canvasId: id,
    title: id === canvasId ? "Dashboard" : "Other", createdByUserId: userId, authorityGeneration: 1 });
  await workspace().sidekickCreate({ workspaceId, automationId: sidekickId, authorUserId: userId,
    scope: "personal", authorityGeneration: 1, madeInCanvasId: canvasId });
});

async function project(parentId: string, substreamId: string, version: number, state: string,
  options: { background?: boolean; archived?: boolean; root?: string } = {}) {
  const effect = WorkstreamDirectoryCommonEffectSchema.parse({ kind: "directory_common", title: "Helper", description: "",
    preview: "", scope: "personal", state, systemKind: null, lastActivityAt: new Date().toISOString(),
    completedAt: null, archivedAt: options.archived ? new Date().toISOString() : null,
    backgroundAgent: options.background ?? false, backgroundAgentRootSubstreamId: options.root ?? "0" });
  const envelope = ConversationEffectEnvelopeSchema.parse({ kind: "conversation_effect", contractVersion: 1,
    region: "global", workspaceId, parentKind: parentId === sidekickId ? "automation" : "canvas", parentId,
    substreamId, generation: 1, messageId: `${parentId}:${substreamId}:${version}`, partitionKey: "common", sourceVersion: version,
    requiredProjectionVersion: null, payloadHash: conversationEffectHash(effect), effect });
  await workspace().receiveChildEffects({ substreamId: asSubstreamId(substreamId), envelopes: [envelope] });
}

async function connect() {
  const response = await workspace().fetch("https://workspace.test/socket", { headers: {
    Upgrade: "websocket", "x-rally-workspace-id": workspaceId, "x-rally-placement-affinity": "wnam",
    "x-rally-user-id": userId, "x-rally-session-id": `session-${userId}`, "x-rally-socket-ticket-id": crypto.randomUUID(),
    "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1000) + 60),
  } });
  if (!response.webSocket) throw new Error(`socket rejected: ${response.status} ${await response.text()}`);
  const socket = response.webSocket;
  socket.accept();
  const pages: CanvasSidebarRow[][] = [];
  socket.addEventListener("message", (message) => {
    if (String(message.data) === "pong") return;
    const value: unknown = JSON.parse(String(message.data));
    const sync = WorkspaceSocketSyncEventSchema.safeParse(value);
    if (sync.success && sync.data.sidebar?.canvases) pages.push(sync.data.sidebar.canvases.items);
    const push = WorkspaceCanvasListEventSchema.safeParse(value);
    if (push.success) pages.push(push.data.items);
  });
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await expect.poll(() => pages.length).toBeGreaterThan(0);
  return { socket, pages, count: () => pages.at(-1)?.find((row) => row.id === canvasId)?.runningActivity };
}

it("pushes scoped background and draft Sidekick wizard work, settles it, and restores counts on reconnect", async () => {
  const live = await connect();
  const child = crypto.randomUUID();
  const nested = crypto.randomUUID();
  const wizardWorker = crypto.randomUUID();
  try {
    expect(live.count()).toEqual({ backgroundAgents: 0, sidekicks: 0 });
    await project(canvasId, child, 1, "running", { background: true });
    await expect.poll(live.count).toEqual({ backgroundAgents: 1, sidekicks: 0 });
    await project(canvasId, nested, 1, "preparing_context", { background: true });
    await project(sidekickId, "0", 1, "running");
    await expect.poll(live.count).toEqual({ backgroundAgents: 2, sidekicks: 1 });
    // Two conversations of one Sidekick are still one Sidekick.
    await project(sidekickId, wizardWorker, 1, "running", { background: true });
    await project(otherId, crypto.randomUUID(), 1, "running", { background: true });
    await expect.poll(() => live.pages.at(-1)?.find((row) => row.id === otherId)?.runningActivity)
      .toEqual({ backgroundAgents: 1, sidekicks: 0 });
    expect(live.count()).toEqual({ backgroundAgents: 2, sidekicks: 1 });
    const reconnected = await connect();
    expect(reconnected.count()).toEqual({ backgroundAgents: 2, sidekicks: 1 });
    reconnected.socket.close();
    // The wizard can yield while its delegated setup work is still running.
    await project(sidekickId, "0", 2, "idle");
    expect((await workspace().canvasDetail({ workspaceId, canvasId, actor: { userId, actorRole: "member" } })).runningActivity)
      .toEqual({ backgroundAgents: 2, sidekicks: 1 });
    await project(sidekickId, wizardWorker, 2, "completed", { background: true });
    await expect.poll(live.count).toEqual({ backgroundAgents: 2, sidekicks: 0 });
    // Authoring resumes even though this Sidekick has never been published.
    await project(sidekickId, "0", 3, "preparing_context");
    await expect.poll(live.count).toEqual({ backgroundAgents: 2, sidekicks: 1 });
    await project(canvasId, child, 3, "completed", { background: true });
    await expect.poll(live.count).toEqual({ backgroundAgents: 1, sidekicks: 1 });
    // Delayed older execution must not resurrect a completed worker.
    await project(canvasId, child, 2, "running", { background: true });
    await project(canvasId, nested, 2, "needs_input", { background: true });
    await expect.poll(live.count).toEqual({ backgroundAgents: 0, sidekicks: 1 });
    await workspace().sidekickRemove({ workspaceId, automationId: sidekickId,
      actor: { userId, actorRole: "member", participantOfOwningWorkstream: false } });
    await expect.poll(live.count).toEqual({ backgroundAgents: 0, sidekicks: 0 });
    const detail = await workspace().canvasDetail({ workspaceId, canvasId, actor: { userId, actorRole: "member" } });
    expect(detail.runningActivity).toEqual({ backgroundAgents: 0, sidekicks: 0 });
  } finally { live.socket.close(); }
});

it("counts overlapping runs and wizard once until both stop, excluding archived and waiting work", async () => {
  const runs = [crypto.randomUUID(), crypto.randomUUID()];
  // Existing admitted runs, without dispatching an irrelevant real model loop.
  await runInDurableObject(workspace(), (_instance: WorkspaceDO, state) => {
    state.storage.sql.exec("UPDATE automation_directory SET lifecycle = 'active' WHERE automation_id = ?", sidekickId);
    for (const id of runs) state.storage.sql.exec(`INSERT INTO sidekick_runs
      (sidekick_id,run_id,occurrence_key,trigger_json,definition_revision,harness_run_id,state,created_at,updated_at)
      VALUES (?,?,?,'{}',1,?,'running',?,?)`, sidekickId, id, id, crypto.randomUUID(), Date.now(), Date.now());
  });
  const live = await connect();
  try {
    await project(sidekickId, runs[0]!, 1, "running");
    await project(sidekickId, runs[1]!, 1, "running");
    // Read after both writes: a matching earlier socket frame must not make
    // the deduplication assertion pass before the second run's push arrives.
    expect((await workspace().canvasDetail({ workspaceId, canvasId, actor: { userId, actorRole: "member" } })).runningActivity)
      .toEqual({ backgroundAgents: 0, sidekicks: 1 });
    await expect.poll(live.count).toEqual({ backgroundAgents: 0, sidekicks: 1 });
    await project(sidekickId, "0", 1, "running");
    expect((await workspace().canvasDetail({ workspaceId, canvasId, actor: { userId, actorRole: "member" } })).runningActivity)
      .toEqual({ backgroundAgents: 0, sidekicks: 1 });
    await project(sidekickId, runs[0]!, 2, "needs_input");
    await project(sidekickId, runs[1]!, 2, "running", { archived: true });
    // Finishing the runs must not hide a wizard that is still working.
    expect((await workspace().canvasDetail({ workspaceId, canvasId, actor: { userId, actorRole: "member" } })).runningActivity)
      .toEqual({ backgroundAgents: 0, sidekicks: 1 });
    await project(sidekickId, "0", 2, "idle");
    await expect.poll(live.count).toEqual({ backgroundAgents: 0, sidekicks: 0 });
    await project(canvasId, crypto.randomUUID(), 1, "cancelled", { background: true });
    expect((await workspace().canvasDetail({ workspaceId, canvasId, actor: { userId, actorRole: "member" } })).runningActivity)
      .toEqual({ backgroundAgents: 0, sidekicks: 0 });
  } finally { live.socket.close(); }
});
