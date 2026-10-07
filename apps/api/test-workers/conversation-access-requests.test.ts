/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * What a member holding a link to a Channel or Breakout they are not in may
 * see of it: `WorkspaceDO.accessRequestSubject`, fed by the same conversation
 * effects production publishes. `docs/channel-access-requests.md` owns the rule.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ConversationEffect,
  type SubstreamId,
  type WorkstreamId,
} from "@rally/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { hostedParentStub } from "./helpers/hosted-parent";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000ac001");
const privateChannel = asWorkstreamId("00000000-0000-4000-8000-0000000ac0a0");
const archivedChannel = asWorkstreamId("00000000-0000-4000-8000-0000000ac0b0");
const plainBreakout = asSubstreamId("00000000-0000-4000-8000-0000000ac0a1");
const markedBreakout = asSubstreamId("00000000-0000-4000-8000-0000000ac0a2");
const creator = asUserId("00000000-0000-4000-8000-0000000ac011");
const breakoutCreator = asUserId("00000000-0000-4000-8000-0000000ac012");
const at = "2026-10-07T12:00:00.000Z";

const organization = () => hostedParentStub(env, workspaceId);

type CommonEffect = Extract<ConversationEffect, { kind: "directory_common" }>;
function common(title: string, extra: Partial<CommonEffect> = {}): CommonEffect {
  return {
    kind: "directory_common", title, description: "Never shown to a requester", preview: "", scope: "personal",
    state: "idle", systemKind: null, lastActivityAt: at, completedAt: null, archivedAt: null,
    createdByUserId: creator, latestAttentionOrdinal: 0, unreadTrackingStartOrdinal: 0, createdAt: at, updatedAt: at,
    ...extra,
  };
}

let messageSeq = 0;
async function publish(parentId: WorkstreamId, effect: ConversationEffect, substreamId: SubstreamId = asSubstreamId("0")) {
  messageSeq += 1;
  await organization().receiveChildEffects({
    substreamId,
    envelopes: [{
      kind: "conversation_effect", contractVersion: 1, region: "global", workspaceId, parentKind: "workstream",
      parentId, substreamId, generation: 1,
      messageId: `00000000-0000-7000-8000-${String(messageSeq).padStart(12, "0")}`,
      partitionKey: "common", sourceVersion: messageSeq, requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect), effect,
    }],
  });
}

const subject = (parentId: string, substreamId: string) =>
  organization().accessRequestSubject({ workspaceId, parentId, substreamId });

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (id INTEGER PRIMARY KEY, phase TEXT NOT NULL,
      generation INTEGER NOT NULL, required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL)`),
    env.DB.prepare(`INSERT INTO workstream_authority_control VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT,
      abandoned_at TEXT, placement_affinity TEXT DEFAULT 'wnam')`),
    env.DB.prepare(`INSERT INTO workspaces (id, region) VALUES (?, 'global')`).bind(workspaceId),
  ]);
  await organization().initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(organization(), (_instance, state) => {
    for (const parentId of [privateChannel, archivedChannel]) {
      state.storage.sql.exec(`INSERT INTO parent_metadata
        (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
        VALUES (?, 'workstream', ?, 'global', 1, 0, 0)`, parentId, workspaceId);
      state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, title)
        VALUES (?, '0', 'main', ?, 0, 'Main')`, parentId, creator);
    }
    for (const substreamId of [plainBreakout, markedBreakout]) {
      state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, title)
        VALUES (?, ?, 'child', ?, 1, 'Breakout')`, privateChannel, substreamId, breakoutCreator);
    }
  });
  await publish(privateChannel, common("Launch plan", { appearance: { icon: "rocket", color: "teal" } }));
  await publish(privateChannel, common("Pricing", { createdByUserId: breakoutCreator }), plainBreakout);
  await publish(privateChannel, common("Copy", {
    createdByUserId: breakoutCreator, appearance: { icon: null, color: "amber" },
  }), markedBreakout);
  await publish(archivedChannel, common("Old plan", { archivedAt: at }));
});

describe("accessRequestSubject", () => {
  it("names a private Channel with its mark and its creator, and nothing else", async () => {
    expect(await subject(privateChannel, "0")).toEqual({
      kind: "channel", title: "Launch plan", appearance: { icon: "rocket", color: "teal" },
      markId: privateChannel, createdByUserId: creator,
    });
  });

  it("gives a Breakout with no look of its own the Channel's, resolved from the Channel's id", async () => {
    expect(await subject(privateChannel, plainBreakout)).toEqual({
      kind: "breakout", title: "Pricing", appearance: { icon: "rocket", color: "teal" },
      markId: privateChannel, createdByUserId: breakoutCreator,
    });
  });

  it("keeps a Breakout's own look, resolved from its own id", async () => {
    expect(await subject(privateChannel, markedBreakout)).toEqual({
      kind: "breakout", title: "Copy", appearance: { icon: null, color: "amber" },
      markId: markedBreakout, createdByUserId: breakoutCreator,
    });
  });

  it("names nothing archived or unknown", async () => {
    expect(await subject(archivedChannel, "0")).toBeNull();
    expect(await subject(privateChannel, "00000000-0000-4000-8000-0000000ac0ff")).toBeNull();
  });
});
