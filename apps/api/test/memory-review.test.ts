import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { MemoryReviewSchema, type MemoryReview } from "@rally/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { HonoAppEnv } from "../src/env";
import { requireAuth } from "../src/middleware/auth";
import { errorHandler } from "../src/middleware/errors";
import { spaceRoutes } from "../src/routes/spaces";
import { workspaceRoutes } from "../src/routes/workspace";
import { workstreamRoutes } from "../src/routes/workstreams";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, testWorkspaceObjectBinding } from "./helpers/workspace-object-rpcs";

/**
 * "What Rally remembers": the review of agent memory in its four places (a
 * person's own, the Organization's, a Thread's, a Channel's) and their Remove
 * action, through the real routes, middleware, services and `WorkspaceDO`.
 * Only the transport to the object is doubled. `docs/agent-memory.md` owns
 * which facts a person sees and who may remove them.
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
/** A private Breakout of the open thread that only the member takes part in. */
const BREAKOUT = "00000000-0000-4000-8000-000000000213";
/** The member's Personal Channel. */
const PERSONAL_CHANNEL = "00000000-0000-4000-8000-000000000223";

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

function seedBreakout(objectDatabase: DatabaseSync, workstreamId: string, substreamId: string, title: string, participants: string[]) {
  objectDatabase.prepare(`INSERT INTO breakouts (
      workstream_id, substream_id, authority_generation, waterline, source_event_id, payload_hash, title,
      description, scope, exact_state, title_status, last_activity_at, archived_at, latest_attention_ordinal,
      unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at
    ) VALUES (?, ?, 1, 1, ?, 'hash', ?, '', 'personal', 'idle', 'settled', 200, NULL, 0, 0, 200, 200, 200)`)
    .run(workstreamId, substreamId, `event-${substreamId}`, title);
  for (const userId of participants) {
    objectDatabase.prepare(`INSERT INTO breakout_viewers (
        workstream_id, substream_id, user_id, authority_generation, waterline, source_event_id, payload_hash,
        is_participant, unread_count, you_are_mentioned, unseen, listable, seen_attention_ordinal,
        manual_unread_generation, latest_mention_attention_ordinal, projected_at
      ) VALUES (?, ?, ?, 1, 1, ?, 'hash', 1, 0, 0, 0, 1, 0, 0, 0, 200)`)
      .run(workstreamId, substreamId, userId, `event-${substreamId}-${userId}`);
  }
}

function seedChannel(
  objectDatabase: DatabaseSync,
  spaceId: string,
  title: string,
  scope: "workspace" | "personal" | "individual",
  participants: string[],
  createdBy = OWNER_ID,
) {
  objectDatabase.prepare(`INSERT INTO spaces (
      space_id, title, scope, created_by_user_id, authority_generation, source_version, payload_hash, revision,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 1, 'hash', 1, 200, 200)`).run(spaceId, title, scope, createdBy);
  if (scope !== "individual") {
    objectDatabase.prepare(`INSERT INTO space_channel_memberships (space_id, workstream_id, state, generation, joined_at, updated_at)
      VALUES (?, ?, 'active', 1, 200, 200)`).run(spaceId, OPEN_THREAD);
  }
  for (const userId of participants) {
    objectDatabase.prepare(`INSERT INTO space_viewers (space_id, user_id, is_participant, authority_generation, source_version, payload_hash, joined_at)
      VALUES (?, ?, 1, 1, 1, 'hash', 200)`).run(spaceId, userId);
  }
}

function sweepAdd(subjectKind: "organization" | "channel", subjectId: string | null, text: string) {
  return {
    op: "add" as const, subjectKind, subjectId, kind: "standing" as const, text,
    validFrom: null, validUntil: null, validUntilBasis: null, derivedFrom: "person" as const, conflict: false, confidence: 0.9, evidence: [1],
  };
}

const conversation = (parentId: string, parentKind: "workstream" | "space" = "workstream", substreamId = "0") =>
  ({ parentKind, parentId, substreamId });

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
  seedBreakout(objectDatabase, OPEN_THREAD, BREAKOUT, "Member's notes", [MEMBER_ID]);
  seedChannel(objectDatabase, OPEN_CHANNEL, "Design", "workspace", []);
  seedChannel(objectDatabase, PRIVATE_CHANNEL, "Board", "personal", [OWNER_ID]);
  seedChannel(objectDatabase, PERSONAL_CHANNEL, "Member", "individual", [MEMBER_ID], MEMBER_ID);

  const now = Date.now();
  const remember = (input: {
    actor: string; factId: string; text: string; at: number; validUntil?: number | null;
    about: "me" | "this conversation"; where: ReturnType<typeof conversation>;
  }) => object.rememberMemoryFact({
    workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: input.actor }, conversation: input.where,
    receiptId: `receipt-${input.factId}`, harnessRunId: `run-${input.actor}`, factId: input.factId, text: input.text,
    kind: input.validUntil ? "situational" : "standing", validUntil: input.validUntil ?? null, about: input.about,
    derivedFrom: "person", now: input.at,
  });
  const written = { outcome: "written" };
  expect(await remember({ actor: MEMBER_ID, factId: "fact-own", text: "Member likes short standups.", at: now - 3000,
    about: "me", where: conversation(OPEN_THREAD) })).toMatchObject(written);
  expect(await remember({ actor: MEMBER_ID, factId: "fact-own-expired", text: "Member is out until Monday.", at: now - 2000,
    validUntil: now - DAY, about: "me", where: conversation(OPEN_THREAD) })).toMatchObject(written);
  expect(await remember({ actor: OWNER_ID, factId: "fact-thread-open", text: "Launch ships behind a flag.", at: now - 1800,
    about: "this conversation", where: conversation(OPEN_THREAD) })).toMatchObject(written);
  expect(await remember({ actor: OWNER_ID, factId: "fact-thread-private", text: "The side room is about pricing.", at: now - 1700,
    about: "this conversation", where: conversation(PRIVATE_THREAD) })).toMatchObject(written);
  expect(await remember({ actor: MEMBER_ID, factId: "fact-breakout", text: "The notes track open questions.", at: now - 1650,
    about: "this conversation", where: conversation(OPEN_THREAD, "workstream", BREAKOUT) })).toMatchObject(written);
  expect(await remember({ actor: MEMBER_ID, factId: "fact-personal-channel", text: "Member keeps drafts here.", at: now - 1600,
    about: "this conversation", where: conversation(PERSONAL_CHANNEL, "space") })).toMatchObject(written);

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
  app.route("/workstreams", workstreamRoutes);
  app.route("/spaces", spaceRoutes);
  app.onError(errorHandler);
  const request = (actor: string, method: "GET" | "DELETE", path: string) => app.request(path, {
    method,
    headers: { "x-rally-dev-user-id": actor, "x-rally-dev-workspace-id": WORKSPACE_ID },
  }, env);
  const review = async (actor: string, path: string): Promise<MemoryReview> => {
    const response = await request(actor, "GET", path);
    expect(response.status).toBe(200);
    return MemoryReviewSchema.parse(await response.json());
  };
  const refusedReview = async (actor: string, path: string) => {
    const response = await request(actor, "GET", path);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const forget = async (actor: string, path: string) => {
    const response = await request(actor, "DELETE", path);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const retractedBy = (factId: string) =>
    objectDatabase.prepare(`SELECT retracted_by FROM memory_facts WHERE fact_id = ?`).get(factId);
  return { objectDatabase, review, refusedReview, forget, retractedBy };
}

const ids = (review: MemoryReview) => review.facts.map((fact) => fact.factId);
const removed = (factId: string) => ({ status: 200, body: { factId, retractedAt: expect.stringMatching(/Z$/) } });
const notRemovable = { status: 403, body: { error: expect.objectContaining({ code: "memory_fact_not_removable" }) } };
const notFound = { status: 404, body: { error: expect.objectContaining({ code: "memory_fact_not_found" }) } };

describe("a person's own facts, under Settings → Account", () => {
  it("lists only the person's own facts, newest first with the expired one included, each removable", async () => {
    const { review } = await fixture();
    const member = await review(MEMBER_ID, "/workspace/me/memory");

    expect(member.facts.map((fact) => [fact.factId, fact.removable])).toEqual([
      ["fact-own-expired", true],
      ["fact-own", true],
    ]);
    expect(member.facts[1]).toEqual({
      factId: "fact-own", subjectKind: "person", subjectTitle: null, kind: "standing", text: "Member likes short standups.",
      validFrom: null, validUntil: null, recordedAt: expect.stringMatching(/Z$/), conflict: false, derivedFrom: "person",
      source: { kind: "thread", workstreamId: OPEN_THREAD, title: "Launch" }, removable: true,
    });
    expect(member.facts[0]).toMatchObject({ kind: "situational", validUntil: expect.stringMatching(/Z$/) });
    expect(ids(await review(OWNER_ID, "/workspace/me/memory"))).toEqual([]);
  });

  it("keeps a person's own fact after they lose the room it came from, but no longer tells them the room's name", async () => {
    const { objectDatabase, review, forget } = await fixture();
    objectDatabase.prepare(`DELETE FROM channel_viewers WHERE workstream_id = ? AND user_id = ?`).run(OPEN_THREAD, MEMBER_ID);
    objectDatabase.prepare(`UPDATE channels SET scope = 'personal', title = 'Acquisition' WHERE workstream_id = ?`).run(OPEN_THREAD);

    const member = await review(MEMBER_ID, "/workspace/me/memory");
    expect(member.facts.map((fact) => [fact.factId, fact.source])).toEqual([
      ["fact-own-expired", { kind: "thread", workstreamId: OPEN_THREAD, title: null }],
      ["fact-own", { kind: "thread", workstreamId: OPEN_THREAD, title: null }],
    ]);
    expect(await forget(MEMBER_ID, "/workspace/me/memory/fact-own")).toEqual(removed("fact-own"));
  });

  it("removes an own fact, answers a repeat as the first, and lists nothing outside the scope", async () => {
    const { review, forget, retractedBy } = await fixture();
    const first = await forget(MEMBER_ID, "/workspace/me/memory/fact-own");
    expect(first).toEqual(removed("fact-own"));
    expect(retractedBy("fact-own")).toEqual({ retracted_by: `person:${MEMBER_ID}` });
    expect(await forget(MEMBER_ID, "/workspace/me/memory/fact-own")).toEqual(first);
    expect(ids(await review(MEMBER_ID, "/workspace/me/memory"))).toEqual(["fact-own-expired"]);

    // Another person's fact, an Organization fact even to an administrator, and no fact at all read the same.
    expect(await forget(OWNER_ID, "/workspace/me/memory/fact-own-expired")).toEqual(notFound);
    expect(await forget(OWNER_ID, "/workspace/me/memory/fact-org-open")).toEqual(notFound);
    expect(await forget(MEMBER_ID, "/workspace/me/memory/no-such-fact")).toEqual(notFound);
  });
});

describe("the Organization's facts, under Settings → Organization", () => {
  it("lists the Organization facts a member may open, read-only, and every one to an administrator, removable", async () => {
    const { review } = await fixture();

    // The private room's fact is not the member's to see.
    expect((await review(MEMBER_ID, "/workspace/memory")).facts.map((fact) => [fact.factId, fact.subjectKind, fact.removable]))
      .toEqual([["fact-org-open", "organization", false]]);
    const owner = await review(OWNER_ID, "/workspace/memory");
    expect(owner.facts.map((fact) => [fact.factId, fact.removable])).toEqual([
      ["fact-org-private", true],
      ["fact-org-open", true],
    ]);
    expect(owner.facts[0]?.source).toEqual({ kind: "thread", workstreamId: PRIVATE_THREAD, title: "Side room" });
  });

  // Marking every digest holder runs a two-statement SQL batch the Node SQL
  // double executes only the first statement of; the mark is proved on
  // workerd in `test-workers/memory-facts.test.ts`.
  it("refuses a member's removal and takes an administrator's", async () => {
    const { forget, retractedBy } = await fixture();

    expect(await forget(MEMBER_ID, "/workspace/memory/fact-org-open")).toEqual(notRemovable);
    expect(retractedBy("fact-org-open")).toEqual({ retracted_by: null });
    expect(await forget(MEMBER_ID, "/workspace/memory/fact-org-private")).toEqual(notFound);
    expect(await forget(OWNER_ID, "/workspace/memory/fact-org-open")).toEqual(removed("fact-org-open"));
    expect(retractedBy("fact-org-open")).toEqual({ retracted_by: `person:${OWNER_ID}` });
  });

  it("answers not found for a fact a sweep superseded after the list was read, leaving it unretracted", async () => {
    const { objectDatabase, forget, retractedBy } = await fixture();
    objectDatabase.prepare(`UPDATE memory_facts SET superseded_by_fact_id = 'fact-org-private' WHERE fact_id = ?`)
      .run("fact-org-open");

    expect(await forget(OWNER_ID, "/workspace/memory/fact-org-open")).toEqual(notFound);
    expect(retractedBy("fact-org-open")).toEqual({ retracted_by: null });
  });
});

describe("a Thread's facts, in its title pop-out", () => {
  it("lists the Thread's own facts to a participant, removable, and refuses a non-participant of a private one", async () => {
    const { review, refusedReview } = await fixture();

    const member = await review(MEMBER_ID, `/workstreams/${OPEN_THREAD}/memory`);
    expect(member.facts.map((fact) => [fact.factId, fact.subjectKind, fact.subjectTitle, fact.removable])).toEqual([
      ["fact-thread-open", "thread", "Launch", true],
    ]);
    expect(await refusedReview(MEMBER_ID, `/workstreams/${PRIVATE_THREAD}/memory`)).toEqual({
      status: 404, body: { error: expect.objectContaining({ code: "conversation_not_found" }) },
    });
    expect(ids(await review(OWNER_ID, `/workstreams/${PRIVATE_THREAD}/memory`))).toEqual(["fact-thread-private"]);
  });

  it("lists a Breakout's own facts under its substreamId and not under the Thread's Main", async () => {
    const { review, refusedReview, forget } = await fixture();

    const breakout = await review(MEMBER_ID, `/workstreams/${OPEN_THREAD}/memory?substreamId=${BREAKOUT}`);
    expect(breakout.facts.map((fact) => [fact.factId, fact.subjectKind, fact.subjectTitle, fact.removable, fact.source])).toEqual([
      ["fact-breakout", "breakout", "Member's notes", true,
        { kind: "breakout", workstreamId: OPEN_THREAD, substreamId: BREAKOUT, title: "Member's notes" }],
    ]);
    expect(ids(await review(MEMBER_ID, `/workstreams/${OPEN_THREAD}/memory`))).toEqual(["fact-thread-open"]);
    // The owner is not in the Breakout, so it is not theirs to open.
    expect((await refusedReview(OWNER_ID, `/workstreams/${OPEN_THREAD}/memory?substreamId=${BREAKOUT}`)).status).toBe(404);
    expect(await forget(MEMBER_ID, `/workstreams/${OPEN_THREAD}/memory/fact-breakout?substreamId=${BREAKOUT}`))
      .toEqual(removed("fact-breakout"));
  });

  it("lets a participant remove the Thread's own fact, and nobody else's through it", async () => {
    const { forget, retractedBy } = await fixture();

    expect(await forget(MEMBER_ID, `/workstreams/${OPEN_THREAD}/memory/fact-thread-open`)).toEqual(removed("fact-thread-open"));
    expect(retractedBy("fact-thread-open")).toEqual({ retracted_by: `person:${MEMBER_ID}` });
    // The Organization's fact is not the Thread's, even though it came from here.
    expect(await forget(MEMBER_ID, `/workstreams/${OPEN_THREAD}/memory/fact-org-open`)).toEqual(notFound);
    expect((await forget(MEMBER_ID, `/workstreams/${PRIVATE_THREAD}/memory/fact-thread-private`)).status).toBe(404);
    expect(retractedBy("fact-thread-private")).toEqual({ retracted_by: null });
  });
});

describe("a Channel's facts, in its title pop-out", () => {
  it("lists a Channel's facts to whoever it is listed to, removable by an administrator", async () => {
    const { review, refusedReview } = await fixture();

    expect((await review(MEMBER_ID, `/spaces/${OPEN_CHANNEL}/memory`)).facts
      .map((fact) => [fact.factId, fact.subjectKind, fact.subjectTitle, fact.removable]))
      .toEqual([["fact-channel-open", "channel", "Design", false]]);
    expect((await review(OWNER_ID, `/spaces/${OPEN_CHANNEL}/memory`)).facts.map((fact) => fact.removable)).toEqual([true]);
    expect(await refusedReview(MEMBER_ID, `/spaces/${PRIVATE_CHANNEL}/memory`)).toEqual({
      status: 404, body: { error: expect.objectContaining({ code: "space_not_found" }) },
    });
    expect(ids(await review(OWNER_ID, `/spaces/${PRIVATE_CHANNEL}/memory`))).toEqual(["fact-channel-private"]);
  });

  it("refuses a member's removal of a Channel fact and takes an administrator's", async () => {
    const { forget } = await fixture();
    expect(await forget(MEMBER_ID, `/spaces/${OPEN_CHANNEL}/memory/fact-channel-open`)).toEqual(notRemovable);
    expect(await forget(OWNER_ID, `/spaces/${OPEN_CHANNEL}/memory/fact-channel-open`)).toEqual(removed("fact-channel-open"));
  });

  it("lets the owner of a Personal Channel remove its facts, which no administrator is listed", async () => {
    const { review, refusedReview, forget, retractedBy } = await fixture();

    expect((await review(MEMBER_ID, `/spaces/${PERSONAL_CHANNEL}/memory`)).facts.map((fact) => [fact.factId, fact.removable]))
      .toEqual([["fact-personal-channel", true]]);
    expect((await refusedReview(OWNER_ID, `/spaces/${PERSONAL_CHANNEL}/memory`)).status).toBe(404);
    expect(await forget(MEMBER_ID, `/spaces/${PERSONAL_CHANNEL}/memory/fact-personal-channel`))
      .toEqual(removed("fact-personal-channel"));
    expect(retractedBy("fact-personal-channel")).toEqual({ retracted_by: `person:${MEMBER_ID}` });
  });
});
