/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Background-workspace attention is one aggregate read over WorkspaceDO's
 * authoritative directory. The test seeds through the same regional effects
 * WorkstreamDO publishes so it proves projection and read semantics together
 * on real workerd SQLite rather than asserting against a SQL double.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  type WorkstreamRegionalEffect,
  workstreamRegionalEffectHash,
} from "../src/durable-objects/workstream-regional-effect";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000009a0");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000009a1");
let sequence = 0;

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

function envelope(effect: WorkstreamRegionalEffect, workstreamId: string) {
  sequence += 1;
  return {
    kind: "workstream_regional_effect" as const,
    contractVersion: 1 as const,
    region: "global" as const,
    workspaceId: WORKSPACE_ID,
    workstreamId: asWorkstreamId(workstreamId),
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion: 1,
    requiredProjectionVersion: null,
    payloadHash: workstreamRegionalEffectHash(effect),
    effect,
  };
}

async function seed(input: {
  id: string;
  scope?: "personal" | "workspace";
  state?: string;
  participant?: boolean;
  unseen?: boolean;
  latest?: number;
  seen?: number;
  mentionedAt?: number;
  archivedAt?: string | null;
  originType?: "ad_hoc" | "automation";
}): Promise<void> {
  const workstreamId = asWorkstreamId(input.id);
  const latest = input.latest ?? 0;
  const common: WorkstreamRegionalEffect = {
    kind: "directory_common",
    title: input.id,
    description: "",
    preview: "",
    scope: input.scope ?? "personal",
    state: input.state ?? "idle",
    systemKind: null,
    lastActivityAt: "2026-08-31T12:00:00.000Z",
    completedAt: null,
    archivedAt: input.archivedAt ?? null,
    originType: input.originType ?? "ad_hoc",
    createdByUserId: MEMBER,
    automationSubscriptionId: null,
    plannedFor: null,
    latestAttentionOrdinal: latest,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:00.000Z",
    resourceLinks: [],
  };
  const viewer: WorkstreamRegionalEffect = {
    kind: "directory_user",
    userId: MEMBER,
    isParticipant: input.participant ?? true,
    unreadCount: Math.max(0, latest - (input.seen ?? 0)),
    youAreMentioned: (input.mentionedAt ?? 0) > (input.seen ?? 0),
    unseen: input.unseen ?? false,
    listable: true,
    seenAttentionOrdinal: input.seen ?? 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: input.mentionedAt ?? 0,
  };
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [envelope(common, workstreamId), envelope(viewer, workstreamId)],
  });
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`)
      .bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`)
      .bind(WORKSPACE_ID, MEMBER),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM workspace_workstream_viewers");
    state.storage.sql.exec("DELETE FROM workspace_workstream_directory");
    state.storage.sql.exec("DELETE FROM workspace_workstream_effect_receipts");
  });
  sequence += 1_000;
}, 30_000);

describe("WorkspaceDO attention", () => {
  it("counts each addressed participant work stream once across mention, unseen, and needs-input reasons", async () => {
    await seed({ id: "00000000-0000-7000-8000-0000000009b1", latest: 3, seen: 1, mentionedAt: 3 });
    await seed({ id: "00000000-0000-7000-8000-0000000009b2", unseen: true });
    await seed({ id: "00000000-0000-7000-8000-0000000009b3", state: "needs_input" });
    await seed({
      id: "00000000-0000-7000-8000-0000000009b4",
      state: "needs_input",
      participant: false,
    });
    await seed({
      id: "00000000-0000-7000-8000-0000000009b5",
      latest: 5,
      seen: 1,
      mentionedAt: 5,
      unseen: true,
      state: "needs_input",
    });

    await expect(workspace().attention({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toEqual({
        waitingForYou: 4,
        waitingReason: "mentioned",
        hasUnreadActivity: true,
      });
  });

  it("reports ordinary unread activity from a visible non-participant row without calling it addressed", async () => {
    await seed({
      id: "00000000-0000-7000-8000-0000000009b6",
      scope: "workspace",
      participant: false,
      latest: 2,
      seen: 0,
    });
    await seed({
      id: "00000000-0000-7000-8000-0000000009b7",
      scope: "personal",
      participant: false,
      latest: 2,
      seen: 0,
    });

    await expect(workspace().attention({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toEqual({
        waitingForYou: 0,
        waitingReason: null,
        hasUnreadActivity: true,
      });
  });
});
