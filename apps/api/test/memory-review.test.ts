import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { MemoryReviewSchema, type MemoryReview } from "@rally/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { HonoAppEnv } from "../src/env";
import { requireAuth } from "../src/middleware/auth";
import { errorHandler } from "../src/middleware/errors";
import { workspaceRoutes } from "../src/routes/workspace";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, testWorkspaceObjectBinding } from "./helpers/workspace-object-rpcs";

/**
 * "What Rally remembers": a person's review of agent memory and its Remove
 * action, through the real route, middleware, service and `WorkspaceDO`. Only
 * the transport to the object is doubled. `docs/agent-memory.md` owns which
 * facts a person sees and who may remove them.
 */

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000201";
const OWNER_ID = "00000000-0000-4000-8000-000000000202";
const MEMBER_ID = "00000000-0000-4000-8000-000000000203";
/** An Organization-wide thread both people take part in. */
const OPEN_THREAD = "00000000-0000-4000-8000-000000000211";
/** Organization-wide when the sweep promoted from it, narrowed to the owner afterwards. */
const PRIVATE_THREAD = "00000000-0000-4000-8000-000000000212";
/** An Organization-wide Channel the open thread sits in. */
const OPEN_CHANNEL = "00000000-0000-4000-8000-000000000221";
/** A private Channel only the owner takes part in; the open thread sits in it too. */
const PRIVATE_CHANNEL = "00000000-0000-4000-8000-000000000222";

const DAY = 24 * 60 * 60 * 1000;

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function seedThread(objectDatabase: DatabaseSync, workstreamId: string, title: string, participants: string[]) {
  objectDatabase.prepare(`INSERT INTO channels (
      workstream_id, authority_generation, waterline, source_event_id, payload_hash,
      title, description, preview, scope, exact_state, origin_type, title_status,
      latest_attention_ordinal, unread_tracking_start_ordinal, last_activity_at,
      source_created_at, source_updated_at, projected_at
    ) VALUES (?, 1, 1, ?, 'hash', ?, '', '', 'workspace', 'idle', 'ad_hoc', 'settled', 0, 0, 200, 200, 200, 200)`)
    .run(workstreamId, `event-${workstreamId}`, title);
  for (const userId of participants) {
    objectDatabase.prepare(`INSERT INTO channel_viewers (
        workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash,
        is_participant, unread_count, you_are_mentioned, listable, seen_attention_ordinal,
        manual_unread_from_ordinal, manual_unread_generation, latest_mention_attention_ordinal, projected_at
      ) VALUES (?, ?, 1, 1, ?, 'hash', 1, 0, 0, 1, 0, NULL, 0, 0, 200)`)
      .run(workstreamId, userId, `event-${workstreamId}-${userId}`);
  }
}

function seedChannel(objectDatabase: DatabaseSync, spaceId: string, title: string, scope: "workspace" | "personal", participants: string[]) {
  objectDatabase.prepare(`INSERT INTO spaces (
      space_id, title, scope, created_by_user_id, authority_generation, source_version, payload_hash, revision,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 1, 'hash', 1, 200, 200)`).run(spaceId, title, scope, OWNER_ID);
  objectDatabase.prepare(`INSERT INTO space_channel_memberships (space_id, workstream_id, state, generation, joined_at, updated_at)
    VALUES (?, ?, 'active', 1, 200, 200)`).run(spaceId, OPEN_THREAD);
  for (const userId of participants) {
    objectDatabase.prepare(`INSERT INTO space_viewers (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
      VALUES (?, ?, 1, 1, 1, 'hash')`).run(spaceId, userId);
  }
}

function sweepAdd(subjectKind: "organization" | "channel", subjectId: string | null, text: string) {
  return {
    op: "add" as const, subjectKind, subjectId, kind: "standing" as const, text,
    validFrom: null, validUntil: null, validUntilBasis: null, derivedFrom: "person" as const, conflict: false, confidence: 0.9, evidence: [1],
  };
}

const conversation = (parentId: string) => ({ parentKind: "workstream" as const, parentId, substreamId: "0" });

async function fixture() {
  const database = migratedSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${OWNER_ID}', 'review-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('${MEMBER_ID}', 'review-member', 'member@example.com', 'Member', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Review', 'review', 'global', '${OWNER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES
      ('${WORKSPACE_ID}', '${OWNER_ID}', 'owner', 'active', '2026-01-01'),
      ('${WORKSPACE_ID}', '${MEMBER_ID}', 'member', 'active', '2026-01-01');
  `);
  const workspace = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID, regionalDatabase: database, register: (created) => { openDatabases.push(created); },
  });
  const objectDatabase = workspace.objectDatabase;
  const object: WorkspaceDO = workspace.instance;
  seedThread(objectDatabase, OPEN_THREAD, "Launch", [OWNER_ID, MEMBER_ID]);
  seedThread(objectDatabase, PRIVATE_THREAD, "Side room", [OWNER_ID]);
  seedChannel(objectDatabase, OPEN_CHANNEL, "Design", "workspace", []);
  seedChannel(objectDatabase, PRIVATE_CHANNEL, "Board", "personal", [OWNER_ID]);

  const now = Date.now();
  const remember = (factId: string, text: string, at: number, validUntil: number | null) => object.rememberMemoryFact({
    workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER_ID }, conversation: conversation(OPEN_THREAD),
    receiptId: `receipt-${factId}`, harnessRunId: "run-member", factId, text,
    kind: validUntil === null ? "standing" : "situational", validUntil, about: "me", derivedFrom: "person", now: at,
  });
  expect(await remember("fact-own", "Member likes short standups.", now - 3000, null)).toMatchObject({ outcome: "written" });
  expect(await remember("fact-own-expired", "Member is out until Monday.", now - 2000, now - DAY)).toMatchObject({ outcome: "written" });

  expect(await object.applyMemorySweep({
    workspaceId: WORKSPACE_ID, conversation: conversation(OPEN_THREAD), fromSeq: 0, toSeq: 5, model: "test/model",
    inputTokens: null, outputTokens: null, now: now - 1000, factIds: ["fact-org-open", "fact-channel-open", "fact-channel-private"],
    speakerIds: [], candidateFactIds: [],
    operations: [
      sweepAdd("organization", null, "Release day is Thursday."),
      sweepAdd("channel", OPEN_CHANNEL, "Design reviews happen on Wednesdays."),
      sweepAdd("channel", PRIVATE_CHANNEL, "The board meets quarterly."),
    ],
  })).toMatchObject({ outcome: "applied", refused: [] });
  expect(await object.applyMemorySweep({
    workspaceId: WORKSPACE_ID, conversation: conversation(PRIVATE_THREAD), fromSeq: 0, toSeq: 5, model: "test/model",
    inputTokens: null, outputTokens: null, now: now - 500, factIds: ["fact-org-private"], speakerIds: [], candidateFactIds: [],
    operations: [sweepAdd("organization", null, "The acquisition closes in March.")],
  })).toMatchObject({ outcome: "applied", refused: [] });
  // Narrowed after the promotion: the fact it learned withdraws from everyone who cannot open the room.
  objectDatabase.prepare(`UPDATE channels SET scope = 'personal' WHERE workstream_id = ?`).run(PRIVATE_THREAD);

  const env = createTestEnv({
    DB: sqliteD1(database),
    WORKSPACE_DOS: testWorkspaceObjectBinding(object, ["reviewMemoryFacts", "forgetReviewedMemoryFact"]),
    AVALON_REGION: "global",
    APP_ENV: "development",
    RALLY_DEV_AUTH: "true",
  });
  const app = new Hono<HonoAppEnv>();
  app.use("*", requireAuth);
  app.route("/workspace", workspaceRoutes);
  app.onError(errorHandler);
  const request = (actor: string, method: "GET" | "DELETE", path: string) => app.request(`/workspace${path}`, {
    method,
    headers: { "x-rally-dev-user-id": actor, "x-rally-dev-workspace-id": WORKSPACE_ID },
  }, env);
  const review = async (actor: string): Promise<MemoryReview> => {
    const response = await request(actor, "GET", "/me/memory");
    expect(response.status).toBe(200);
    return MemoryReviewSchema.parse(await response.json());
  };
  const forget = async (actor: string, factId: string) => {
    const response = await request(actor, "DELETE", `/me/memory/${factId}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { object, objectDatabase, review, forget };
}

describe("reviewing what Rally remembers", () => {
  it("lists a member's own facts, newest first with the expired one marked, and only the shared facts they may open, read-only", async () => {
    const { review } = await fixture();
    const member = await review(MEMBER_ID);

    expect(member.own.map((fact) => [fact.factId, fact.expired, fact.removable])).toEqual([
      ["fact-own-expired", true, true],
      ["fact-own", false, true],
    ]);
    expect(member.own[1]).toMatchObject({
      subjectKind: "person", subjectTitle: null, kind: "standing", text: "Member likes short standups.",
      validUntil: null, upcoming: false, source: { kind: "thread", workstreamId: OPEN_THREAD, title: "Launch" },
    });
    expect(member.own[0]).toMatchObject({ kind: "situational", validUntil: expect.stringMatching(/Z$/) });

    // The private room's Organization fact and the private Channel's fact are not theirs to see.
    expect(member.shared.map((fact) => [fact.factId, fact.subjectKind, fact.subjectTitle, fact.removable])).toEqual([
      ["fact-org-open", "organization", null, false],
      ["fact-channel-open", "channel", "Design", false],
    ]);
  });

  it("lets an administrator see and remove every shared fact they may open", async () => {
    const { review } = await fixture();
    const owner = await review(OWNER_ID);

    expect(owner.own).toEqual([]);
    expect(owner.shared.map((fact) => [fact.factId, fact.removable])).toEqual([
      ["fact-org-private", true],
      ["fact-org-open", true],
      ["fact-channel-open", true],
      ["fact-channel-private", true],
    ]);
    expect(owner.shared[0]?.source).toEqual({ kind: "thread", workstreamId: PRIVATE_THREAD, title: "Side room" });
  });

  // Marking every digest holder runs a two-statement SQL batch the Node SQL
  // double executes only the first statement of; the mark is proved on
  // workerd in `test-workers/memory-facts.test.ts`.
  it("removes a member's own fact, refuses them a shared one, and lets the owner remove it", async () => {
    const { objectDatabase, review, forget } = await fixture();
    const retractedBy = (factId: string) =>
      objectDatabase.prepare(`SELECT retracted_by FROM memory_facts WHERE fact_id = ?`).get(factId);

    expect(await forget(MEMBER_ID, "fact-org-open")).toEqual({
      status: 403,
      body: { error: expect.objectContaining({ code: "memory_fact_not_removable" }) },
    });
    expect(retractedBy("fact-org-open")).toEqual({ retracted_by: null });
    expect((await forget(OWNER_ID, "fact-org-open"))).toEqual({
      status: 200, body: { factId: "fact-org-open", retractedAt: expect.stringMatching(/Z$/) },
    });
    expect(retractedBy("fact-org-open")).toEqual({ retracted_by: `person:${OWNER_ID}` });

    const first = await forget(MEMBER_ID, "fact-own");
    expect(first).toEqual({ status: 200, body: { factId: "fact-own", retractedAt: expect.stringMatching(/Z$/) } });
    // A repeat answers as the first did.
    expect(await forget(MEMBER_ID, "fact-own")).toEqual(first);
    expect((await review(MEMBER_ID)).own.map((fact) => fact.factId)).toEqual(["fact-own-expired"]);
    expect((await review(MEMBER_ID)).shared.map((fact) => fact.factId)).toEqual(["fact-channel-open"]);
  });

  it("answers not found for a fact the person's review does not list", async () => {
    const { forget } = await fixture();
    // Another person's fact, an Organization fact from a room they cannot open, and no fact at all read the same.
    expect((await forget(OWNER_ID, "fact-own")).status).toBe(404);
    expect((await forget(MEMBER_ID, "fact-org-private"))).toEqual({
      status: 404, body: { error: expect.objectContaining({ code: "memory_fact_not_found" }) },
    });
    expect((await forget(MEMBER_ID, "no-such-fact")).status).toBe(404);
  });

  it("keeps a person's own fact in their review after they lose the room it came from", async () => {
    const { objectDatabase, review, forget } = await fixture();
    objectDatabase.prepare(`DELETE FROM channel_viewers WHERE workstream_id = ? AND user_id = ?`).run(OPEN_THREAD, MEMBER_ID);
    objectDatabase.prepare(`UPDATE channels SET scope = 'personal' WHERE workstream_id = ?`).run(OPEN_THREAD);

    expect((await review(MEMBER_ID)).own.map((fact) => fact.factId)).toEqual(["fact-own-expired", "fact-own"]);
    expect((await forget(MEMBER_ID, "fact-own")).status).toBe(200);
  });
});
