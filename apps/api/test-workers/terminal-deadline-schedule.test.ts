/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { ConversationEffectEnvelopeSchema, conversationEffectHash, WorkstreamDirectoryCommonEffectSchema } from "@rally/contracts/conversation-effects";
import { workspaceDOName } from "../src/durable-objects/names";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

// A Canvas's and a Sidekick's conversations report their sandbox deadlines to
// the Organization object; its schedule is what advances each sandbox to a
// warm stop, an archive or an expiry. See docs/terminal-workspaces.md.

const userId = asUserId("00000000-0000-7000-8000-000000ac7201");
let workspaceId = asWorkspaceId(crypto.randomUUID());
let canvasId = asWorkstreamId(crypto.randomUUID());
let sidekickId = crypto.randomUUID();
const workspace = () => env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, workspaceId)));

beforeEach(async () => {
  await reset();
  workspaceId = asWorkspaceId(crypto.randomUUID());
  canvasId = asWorkstreamId(crypto.randomUUID());
  sidekickId = crypto.randomUUID();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId, sessionId: `session-${userId}` });
  await env.DB.exec("ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT DEFAULT 'wnam'");
  await workspace().canvasCreate({ workspaceId, canvasId, title: "Dashboard", createdByUserId: userId, authorityGeneration: 1 });
  await workspace().sidekickCreate({ workspaceId, automationId: sidekickId, authorUserId: userId,
    scope: "personal", authorityGeneration: 1, madeInCanvasId: canvasId });
});

async function project(parentId: string, substreamId: string, version: number, nextTerminalActionAt: string | null) {
  const effect = WorkstreamDirectoryCommonEffectSchema.parse({ kind: "directory_common", title: "Chat", description: "",
    preview: "", scope: "personal", state: "idle", systemKind: null, lastActivityAt: new Date().toISOString(),
    completedAt: null, archivedAt: null, nextTerminalActionAt });
  const envelope = ConversationEffectEnvelopeSchema.parse({ kind: "conversation_effect", contractVersion: 1,
    region: "global", workspaceId, parentKind: parentId === sidekickId ? "automation" : "canvas", parentId,
    substreamId, generation: 1, messageId: `${parentId}:${substreamId}:${version}`, partitionKey: "common", sourceVersion: version,
    requiredProjectionVersion: null, payloadHash: conversationEffectHash(effect), effect });
  await workspace().receiveChildEffects({ substreamId: asSubstreamId(substreamId), envelopes: [envelope] });
}

async function terminalAlarms(): Promise<Record<string, string>> {
  return runInDurableObject(workspace(), (_instance, state) => Object.fromEntries(
    state.storage.sql.exec<{ alarm_key: string; due_at: number }>(
      `SELECT alarm_key, due_at FROM _internal_durable_alarms WHERE kind = 'terminal' ORDER BY alarm_key`,
    ).toArray().map((row) => [row.alarm_key, new Date(row.due_at).toISOString()])));
}

it("schedules each Canvas's and Sidekick's earliest sandbox deadline, and keeps it through the full reconcile", async () => {
  const backgroundAgent = crypto.randomUUID();
  const sidekickRun = crypto.randomUUID();
  await project(canvasId, "0", 1, "2026-11-20T10:00:00.000Z");
  await project(canvasId, backgroundAgent, 1, "2026-11-20T09:00:00.000Z");
  await project(sidekickId, sidekickRun, 1, "2026-11-21T08:00:00.000Z");
  expect(await terminalAlarms()).toEqual({
    [canvasId]: "2026-11-20T09:00:00.000Z",
    [sidekickId]: "2026-11-21T08:00:00.000Z",
  });

  // The whole index is re-derived at the end of every Organization alarm;
  // that pass has to find the same deadlines rather than clear them.
  await workspace().refreshSchedule(workspaceId);
  expect(await terminalAlarms()).toEqual({
    [canvasId]: "2026-11-20T09:00:00.000Z",
    [sidekickId]: "2026-11-21T08:00:00.000Z",
  });

  // A sandbox advanced past its last deadline reports none.
  await project(canvasId, backgroundAgent, 2, null);
  expect(await terminalAlarms()).toEqual({
    [canvasId]: "2026-11-20T10:00:00.000Z",
    [sidekickId]: "2026-11-21T08:00:00.000Z",
  });
  await project(canvasId, "0", 2, null);
  await project(sidekickId, sidekickRun, 2, null);
  await workspace().refreshSchedule(workspaceId);
  expect(await terminalAlarms()).toEqual({});
});
