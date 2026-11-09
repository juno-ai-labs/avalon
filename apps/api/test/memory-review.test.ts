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
 * "What Rally remembers": the review of agent memory in Settings (a
 * person's own and the Organization's) and their Remove
 * action, through the real routes, middleware, services and `WorkspaceDO`.
 * Only the transport to the object is doubled. `docs/agent-memory.md` owns
 * which facts a person sees and who may remove them.
 */

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000201";
const OWNER_ID = "00000000-0000-4000-8000-000000000202";
const MEMBER_ID = "00000000-0000-4000-8000-000000000203";
/** An Organization-wide Canvas both people read. */
const OPEN_CANVAS = "00000000-0000-4000-8000-000000000211";
/** Organization-wide when the sweep promoted from it, narrowed to its creator, the owner, afterwards. */
const PRIVATE_CANVAS = "00000000-0000-4000-8000-000000000212";

const DAY = 24 * 60 * 60 * 1000;

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function sweepAdd(subjectKind: "organization", subjectId: string | null, text: string) {
  return {
    op: "add" as const, subjectKind, subjectId, kind: "standing" as const, text,
    validFrom: null, validUntil: null, validUntilBasis: null, derivedFrom: "person" as const, conflict: false, confidence: 0.9, evidence: [1],
  };
}

const conversation = (parentId: string) => ({ parentKind: "canvas" as const, parentId, substreamId: "0" });

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
  for (const [canvasId, title] of [[OPEN_CANVAS, "Launch"], [PRIVATE_CANVAS, "Side room"]] as const) {
    await object.canvasCreate({ workspaceId: WORKSPACE_ID as never, canvasId: canvasId as never, title,
      createdByUserId: OWNER_ID as never, authorityGeneration: 1 });
  }
  objectDatabase.prepare(`UPDATE canvas_directory SET visibility = 'workspace'`).run();
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
    about: "me", where: conversation(OPEN_CANVAS) })).toMatchObject(written);
  expect(await remember({ actor: MEMBER_ID, factId: "fact-own-expired", text: "Member is out until Monday.", at: now - 2000,
    validUntil: now - DAY, about: "me", where: conversation(OPEN_CANVAS) })).toMatchObject(written);
  expect(await remember({ actor: OWNER_ID, factId: "fact-thread-open", text: "Launch ships behind a flag.", at: now - 1800,
    about: "this conversation", where: conversation(OPEN_CANVAS) })).toMatchObject(written);
  expect(await remember({ actor: OWNER_ID, factId: "fact-thread-private", text: "The side room is about pricing.", at: now - 1700,
    about: "this conversation", where: conversation(PRIVATE_CANVAS) })).toMatchObject(written);

  expect(await object.applyMemorySweep({
    workspaceId: WORKSPACE_ID, conversation: conversation(OPEN_CANVAS), fromSeq: 0, toSeq: 5, model: "test/model",
    inputTokens: null, outputTokens: null, now: now - 1000, factIds: ["fact-org-open"],
    speakerIds: [], candidateFactIds: [],
    operations: [
      sweepAdd("organization", null, "Release day is Thursday."),
    ],
  })).toMatchObject({ outcome: "applied", refused: [] });
  expect(await object.applyMemorySweep({
    workspaceId: WORKSPACE_ID, conversation: conversation(PRIVATE_CANVAS), fromSeq: 0, toSeq: 5, model: "test/model",
    inputTokens: null, outputTokens: null, now: now - 500, factIds: ["fact-org-private"], speakerIds: [], candidateFactIds: [],
    operations: [sweepAdd("organization", null, "The acquisition closes in March.")],
  })).toMatchObject({ outcome: "applied", refused: [] });
  // Narrowed after the promotion: the fact it learned withdraws from everyone who cannot open the room.
  objectDatabase.prepare(`UPDATE canvas_directory SET visibility = 'creator' WHERE canvas_id = ?`).run(PRIVATE_CANVAS);

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
      source: { kind: "thread", workstreamId: OPEN_CANVAS, title: "Launch" }, removable: true,
    });
    expect(member.facts[0]).toMatchObject({ kind: "situational", validUntil: expect.stringMatching(/Z$/) });
    expect(ids(await review(OWNER_ID, "/workspace/me/memory"))).toEqual([]);
  });

  it("keeps a person's own fact after they lose the room it came from, but no longer tells them the room's name", async () => {
    const { objectDatabase, review, forget } = await fixture();
    objectDatabase.prepare(`UPDATE canvas_directory SET visibility = 'creator', title = 'Acquisition' WHERE canvas_id = ?`)
      .run(OPEN_CANVAS);

    const member = await review(MEMBER_ID, "/workspace/me/memory");
    expect(member.facts.map((fact) => [fact.factId, fact.source])).toEqual([
      ["fact-own-expired", { kind: "thread", workstreamId: OPEN_CANVAS, title: null }],
      ["fact-own", { kind: "thread", workstreamId: OPEN_CANVAS, title: null }],
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
    expect(owner.facts[0]?.source).toEqual({ kind: "thread", workstreamId: PRIVATE_CANVAS, title: "Side room" });
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
