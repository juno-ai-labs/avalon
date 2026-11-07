/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The daily digest: what is still unread in a person's Activity, kept on the
 * occurrence and sent to each destination. Driven from a thread start the way
 * production writes one (`receiveChildEffects`), and read back from the
 * occurrence the Organization object keeps. Email does not leave a
 * non-production Worker, so what was sent is read from the occurrence.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  conversationEffectHash,
  type ConversationEffect,
  type ConversationEffectEnvelope,
  type UserId,
} from "@rally/contracts";

import { stableUuid } from "../src/lib/stable-uuid";
import { fireDigestSchedule } from "../src/services/digest-run-service";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import { hostedParentStub } from "./helpers/hosted-parent";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000d0001");
const thread = asWorkstreamId("00000000-0000-4000-8000-0000000d00a0");
/** A second thread, for a digest that holds two rows. */
const otherThread = asWorkstreamId("00000000-0000-4000-8000-0000000d00a1");
/** Starts the thread. */
const owner = asUserId("00000000-0000-4000-8000-0000000d0011");
/** Gets the digest. */
const member = asUserId("00000000-0000-4000-8000-0000000d0012");
const scheduleId = "00000000-0000-4000-8000-0000000d00c0";
const plannedFor = "2026-10-15T16:00:00.000Z";

const organization = () => hostedParentStub(env, workspaceId);

let messageSeq = 0;
function envelope(effect: ConversationEffect, parentId = thread): ConversationEffectEnvelope {
  messageSeq += 1;
  return {
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId,
    parentKind: "workstream",
    parentId,
    substreamId: asSubstreamId("0"),
    generation: 1,
    messageId: `00000000-0000-7000-8000-${String(messageSeq).padStart(12, "0")}`,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion: messageSeq,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

function common(title: string): ConversationEffect {
  const now = new Date().toISOString();
  return {
    kind: "directory_common",
    title,
    description: "",
    preview: "",
    scope: "workspace",
    state: "running",
    systemKind: null,
    lastActivityAt: now,
    completedAt: null,
    archivedAt: null,
    createdByUserId: owner,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function viewer(userId: UserId): ConversationEffect {
  return {
    kind: "directory_user",
    userId,
    isParticipant: true,
    unreadCount: 0,
    youAreMentioned: false,
    listable: true,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  };
}

async function startThread(title: string, parentId = thread): Promise<void> {
  await organization().receiveChildEffects({
    substreamId: asSubstreamId("0"),
    envelopes: [envelope(common(title), parentId), envelope(viewer(owner), parentId)],
  });
}

async function occurrence(): Promise<{ status: string; event_count: number; summary_markdown: string | null } | undefined> {
  return runInDurableObject(organization(), (_instance, state) => state.storage.sql.exec<{
    status: string; event_count: number; summary_markdown: string | null;
  }>(`SELECT status, event_count, summary_markdown FROM digest_deliveries WHERE digest_schedule_id = ? AND planned_for = ?`, scheduleId, plannedFor).toArray()[0]);
}

beforeEach(async () => {
  await reset();
  clearFlagTargetingAttributeCache();
  messageSeq = 0;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (id INTEGER PRIMARY KEY, phase TEXT NOT NULL,
      generation INTEGER NOT NULL, required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL)`),
    env.DB.prepare(`INSERT INTO workstream_authority_control VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, region TEXT NOT NULL, analytics_workspace_id TEXT,
      abandoned_at TEXT, placement_affinity TEXT DEFAULT 'wnam')`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, region) VALUES (?, 'Test', 'global')`).bind(workspaceId),
    env.DB.prepare(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles')`),
    env.DB.prepare(`CREATE TABLE workspace_members (access_class TEXT NOT NULL DEFAULT 'member',
      incarnation TEXT DEFAULT 'existing-member', workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL, role TEXT NOT NULL, last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, user_id))`),
    ...[[owner, "Maya"], [member, "Theo"]].flatMap(([userId, name]) => [
      env.DB.prepare(`INSERT INTO users (id, email, name) VALUES (?, ?, ?)`).bind(userId, `${name}@example.test`, name),
      env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`)
        .bind(workspaceId, userId),
    ]),
  ]);
  await organization().initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(organization(), (_instance, state) => {
    for (const parentId of [thread, otherThread]) {
      state.storage.sql.exec(`INSERT INTO parent_metadata
        (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
        VALUES (?, 'workstream', ?, 'global', 1, 0, 0)`, parentId, workspaceId);
      state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, title)
        VALUES (?, '0', 'main', ?, 0, 'Main')`, parentId, owner);
    }
    state.storage.sql.exec(`INSERT INTO digest_schedules
      (id, workspace_id, user_id, day_mask, enabled, execution_principal_json, version, created_at, updated_at)
      VALUES (?, ?, ?, 62, 1, ?, 1, '2026-01-01', '2026-01-01')`,
    scheduleId, workspaceId, member, JSON.stringify({ type: "user", userId: member }));
    state.storage.sql.exec(`INSERT INTO digest_delivery_targets
      (id, workspace_id, digest_schedule_id, user_id, target_type, email_address, status, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-0000000d00c1', ?, ?, ?, 'email', 'Theo@example.test', 'active', '2026-01-01', '2026-01-01')`,
    workspaceId, scheduleId, member);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the daily digest", () => {
  it("given a thread someone started that the member has not read, then the digest lists it, worded as the sidebar words it", async () => {
    await startThread("Q3 plan");

    expect(await fireDigestSchedule(env, { scheduleId, workspaceId, plannedFor }))
      .toMatchObject({ sent: true, itemCount: 1 });
    const kept = await occurrence();
    expect(kept).toMatchObject({ status: "delivered", event_count: 1 });
    // A Thread has no link now that no surface opens one, so its row is named unlinked (`docs/links.md`).
    expect(kept!.summary_markdown).toMatch(/^1 unread item in your Activity\.\n\n## New threads\n- Maya started Q3 plan$/u);
  });

  it("counts a mentioned human reply once in the digest", async () => {
    await startThread("Q3 plan");
    await organization().recordActivityEvents({ workspaceId, userId: member,
      events: [{ kind: "read", subject: { kind: "thread", threadId: thread }, through: 0 }] });
    const event: ConversationEffect = {
      kind: "activity_event", eventId: "00000000-0000-7000-8000-0000000d0f01",
      eventType: "workstream_message_created", subjectSequenceNumber: 2,
      actorType: "user", actorUserId: owner, actorLabel: "Maya", title: "Q3 plan", body: "Please review",
      canonicalUrl: null, digestible: true, occurredAt: new Date().toISOString(), sourceKind: "workstream_message",
      sourceId: "reply", dedupeKey: "reply", metadata: { substreamId: "0", attentionOrdinal: 2 },
      targets: [{ userId: member, relation: "mentioned" }],
    };
    await organization().receiveChildEffects({ substreamId: asSubstreamId("0"),
      envelopes: [envelope(viewer(member)), envelope(event)] });
    expect(await fireDigestSchedule(env, { scheduleId, workspaceId, plannedFor })).toMatchObject({ sent: true, itemCount: 1 });
    const kept = await occurrence();
    expect(kept).toMatchObject({ event_count: 1 });
    expect(kept!.summary_markdown).toContain("## Mentions");
    expect(kept!.summary_markdown).not.toContain("## New messages");
  });

  it("given nothing unread, then nothing is sent and the occurrence is settled as empty", async () => {
    await startThread("Q3 plan");
    await organization().markActivitySeen({ workspaceId, userId: member, seenThrough: Date.now() + 1_000 });

    expect(await fireDigestSchedule(env, { scheduleId, workspaceId, plannedFor }))
      .toEqual({ sent: false, reason: "empty" });
    expect(await occurrence()).toMatchObject({ status: "empty", event_count: 0, summary_markdown: null });
  });

  it("given an unread row older than two days beside a new one, then the old one is counted at the bottom rather than listed again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(plannedFor) - 3 * DAY_MS);
    await startThread("Old plan");
    vi.setSystemTime(Date.parse(plannedFor) - DAY_MS);
    await startThread("Q3 plan", otherThread);
    vi.useRealTimers();

    expect(await fireDigestSchedule(env, { scheduleId, workspaceId, plannedFor }))
      .toMatchObject({ sent: true, itemCount: 1 });
    const kept = await occurrence();
    expect(kept!.summary_markdown).toMatch(/^1 unread item in your Activity\.\n\n## New threads\n- Maya started Q3 plan\n\n1 more older than 2 days\.$/u);
  });

  it("given a gap since the last delivered digest longer than two days, then a row no digest has listed yet is still listed", async () => {
    // A weekday schedule's Monday: the last digest went out Friday morning, and
    // the row arrived after it, more than two days before Monday's.
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO digest_deliveries
        (id, workspace_id, digest_schedule_id, user_id, planned_for, cursor_through, event_count, highlight_count,
         status, summary_markdown, created_at, updated_at)
        VALUES ('00000000-0000-4000-8000-0000000d00d1', ?, ?, ?, ?, 0, 1, 0, 'delivered', 'Friday.', '2026-01-01', '2026-01-01')`,
      workspaceId, scheduleId, member, new Date(Date.parse(plannedFor) - 4 * DAY_MS).toISOString());
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(plannedFor) - 3 * DAY_MS);
    await startThread("Q3 plan");
    vi.useRealTimers();

    expect(await fireDigestSchedule(env, { scheduleId, workspaceId, plannedFor }))
      .toMatchObject({ sent: true, itemCount: 1 });
    expect((await occurrence())!.summary_markdown)
      .toMatch(/^1 unread item in your Activity\.\n\n## New threads\n- Maya started Q3 plan$/u);
  });

  it("given only unread rows older than two days, then nothing is sent and the occurrence is settled as empty", async () => {
    await startThread("Q3 plan");
    const later = new Date(Date.now() + 3 * DAY_MS).toISOString();

    expect(await fireDigestSchedule(env, { scheduleId, workspaceId, plannedFor: later }))
      .toEqual({ sent: false, reason: "empty" });
  });

  it("given an occurrence already sent, when its alarm fires again, then nothing is sent twice", async () => {
    await startThread("Q3 plan");
    await fireDigestSchedule(env, { scheduleId, workspaceId, plannedFor });

    expect(await fireDigestSchedule(env, { scheduleId, workspaceId, plannedFor }))
      .toEqual({ sent: false, reason: "already_settled" });
  });

  it("given an occurrence claimed but not sent, when its alarm fires again, then it sends the text the claim kept rather than reading Activity again", async () => {
    // A first attempt that claimed and then failed before sending: what was
    // unread then is kept, and Activity has since been read.
    const deliveryId = await stableUuid(["digest_delivery", scheduleId, plannedFor]);
    await runInDurableObject(organization(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO digest_deliveries
        (id, workspace_id, digest_schedule_id, user_id, planned_for, cursor_through, event_count, highlight_count,
         status, summary_markdown, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 2, 1, 'planned', 'Kept from the first attempt.', '2026-01-01', '2026-01-01')`,
      deliveryId, workspaceId, scheduleId, member, plannedFor);
    });

    expect(await fireDigestSchedule(env, { scheduleId, workspaceId, plannedFor }))
      .toEqual({ sent: true, deliveryId, itemCount: 2 });
    expect(await occurrence()).toMatchObject({ status: "delivered", event_count: 2, summary_markdown: "Kept from the first attempt." });
  });
});
