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

import {
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ParentEffect,
} from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000009f7");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000009a1");
let sequence = 0;

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

function envelope(effect: ParentEffect, workstreamId: string) {
  sequence += 1;
  return {
    kind: "parent_effect" as const,
    contractVersion: 1 as const,
    region: "global" as const,
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream" as const,
    parentId: asWorkstreamId(workstreamId),
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion: 1,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
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
}): Promise<void> {
  const workstreamId = asWorkstreamId(input.id);
  const latest = input.latest ?? 0;
  const common: ParentEffect = {
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
    createdByUserId: MEMBER,
    latestAttentionOrdinal: latest,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:00.000Z",
    resourceLinks: [],
  };
  const viewer: ParentEffect = {
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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (access_class TEXT NOT NULL DEFAULT 'member', incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
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
    state.storage.sql.exec("DELETE FROM breakout_viewers");
    state.storage.sql.exec("DELETE FROM breakouts");
    state.storage.sql.exec("DELETE FROM channel_viewers");
    state.storage.sql.exec("DELETE FROM channels");
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
        readerAttentionCount: 3,
      });
  });

  it("reports unread activity from a visible non-participant row without calling it addressed or counting it on the badge", async () => {
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
        readerAttentionCount: 0,
      });
  });

  it("counts unread streams but not a needs-input run the reader has already read", async () => {
    await seed({ id: "00000000-0000-7000-8000-0000000009b8", latest: 3, seen: 1 });
    await seed({ id: "00000000-0000-7000-8000-0000000009b9", state: "needs_input", latest: 2, seen: 2 });
    await seed({ id: "00000000-0000-7000-8000-0000000009ba", latest: 4, seen: 1, state: "needs_input" });
    await seed({
      id: "00000000-0000-7000-8000-0000000009bb",
      latest: 3,
      seen: 1,
      archivedAt: "2026-09-01T00:00:00.000Z",
    });

    await expect(workspace().attention({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toEqual({
        waitingForYou: 2,
        waitingReason: "needs_input",
        hasUnreadActivity: true,
        readerAttentionCount: 2,
      });
  });

  it("leaves Organization-wide conversations the reader is not in out of a member's and a guest's count alike", async () => {
    await seed({ id: "00000000-0000-7000-8000-0000000009e1", scope: "workspace", participant: false, latest: 2, seen: 0 });
    await seed({ id: "00000000-0000-7000-8000-0000000009e2", latest: 2, seen: 0 });

    await expect(workspace().attention({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toMatchObject({ readerAttentionCount: 1 });
    await expect(workspace().attention({ workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass: "guest" }))
      .resolves.toMatchObject({ readerAttentionCount: 1 });
  });

  it("counts each Breakout the reader may list that is unread or unseen, as the sidebar menu does", async () => {
    const channelId = "00000000-0000-7000-8000-0000000009c1";
    await seed({ id: channelId, latest: 2, seen: 2 });
    const breakout = (index: number) => `00000000-0000-7000-8000-0000000009d${index}`;
    await runInDurableObject(workspace(), (_instance, state) => {
      const insert = (input: {
        id: string; latest: number; seen: number; unseen?: boolean; listable: boolean;
        state?: string; archivedAt?: number;
      }) => {
        state.storage.sql.exec(
          `INSERT INTO breakouts
             (workstream_id, substream_id, authority_generation, waterline, source_event_id,
              payload_hash, title, description, scope, exact_state, title_status,
              created_by_user_id, last_activity_at, completed_at, archived_at,
              latest_attention_ordinal, unread_tracking_start_ordinal,
              source_created_at, source_updated_at, projected_at)
           VALUES (?, ?, 1, 1, ?, 'fnv1a64:0000000000000000', ?, '', 'personal',
                   ?, 'settled', NULL, 1, NULL, ?, ?, 0, 1, 1, 1)`,
          channelId, input.id, `breakout-event-${input.id}`, input.id, input.state ?? "idle",
          input.archivedAt ?? null, input.latest,
        );
        state.storage.sql.exec(
          `INSERT INTO breakout_viewers
             (workstream_id, substream_id, user_id, authority_generation, waterline,
              source_event_id, payload_hash, is_participant, unread_count,
              you_are_mentioned, unseen, listable, seen_attention_ordinal,
              manual_unread_from_ordinal, manual_unread_generation,
              latest_mention_attention_ordinal, projected_at)
           VALUES (?, ?, ?, 1, 1, ?, 'fnv1a64:0000000000000000', 1, 0, 0, ?, ?, ?, NULL, 0, 0, 1)`,
          channelId, input.id, MEMBER, `breakout-viewer-${input.id}`,
          input.unseen ? 1 : 0, input.listable ? 1 : 0, input.seen,
        );
      };
      insert({ id: breakout(1), latest: 3, seen: 1, listable: true });
      insert({ id: breakout(2), latest: 0, seen: 0, unseen: true, listable: true });
      // Not this reader's to list, already read, and archived: none counts.
      insert({ id: breakout(3), latest: 3, seen: 1, listable: false });
      insert({ id: breakout(4), latest: 2, seen: 2, listable: true, state: "needs_input" });
      insert({ id: breakout(5), latest: 3, seen: 1, listable: true, archivedAt: 1 });
    });

    await expect(workspace().attention({ workspaceId: WORKSPACE_ID, userId: MEMBER }))
      .resolves.toMatchObject({ readerAttentionCount: 2 });
  });
});
