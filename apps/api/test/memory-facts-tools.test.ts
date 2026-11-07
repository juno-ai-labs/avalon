import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { asAutomationId, asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId, type WorkstreamWorkflowInput } from "@rally/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { createMemoryTools } from "../src/services/memory-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import {
  applyWorkstreamObjectRootFields,
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";
import { migratedSqliteDatabase } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";

/**
 * The `rally:memory` tools over a real `WorkspaceDO`: what a run may recall
 * from where it stands, what it may remember, and what it may forget. Only the
 * transport to the object is doubled; its schema, SQL and visibility rules are
 * the production ones. `docs/agent-memory.md` owns the rules.
 */

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000101");
const OWNER_ID = asUserId("00000000-0000-4000-8000-000000000102");
const MEMBER_ID = asUserId("00000000-0000-4000-8000-000000000103");
/** The owner's private Canvas: only its creator reads it. */
const PRIVATE_CANVAS = asWorkstreamId("00000000-0000-4000-8000-000000000111");
/** An Organization-wide Canvas both people read. */
const OPEN_CANVAS = asWorkstreamId("00000000-0000-4000-8000-000000000112");
const OWNER_RUN = asHarnessRunId("00000000-0000-4000-8000-000000000121");
const MEMBER_RUN = asHarnessRunId("00000000-0000-4000-8000-000000000122");
const OWNER_OPEN_RUN = asHarnessRunId("00000000-0000-4000-8000-000000000123");
/** A Sidekick whose runs act as the owner (`run_as_user`). */
const SIDEKICK_ID = asAutomationId("00000000-0000-4000-8000-000000000131");
const SIDEKICK_RUN = asHarnessRunId("00000000-0000-4000-8000-000000000132");
const SIDEKICK_CANVAS_RUN = asHarnessRunId("00000000-0000-4000-8000-000000000133");

class SqliteD1Statement {
  private values: unknown[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): SqliteD1Statement { this.values = values; return this; }
  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result<unknown>({ success: true, meta: { changes: Number(result.changes) } });
  }
  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }
  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>({ success: true, results: this.statement.all(...this.values as SQLInputValue[]) as T[], meta: { changes: 0 } });
  }
}

function sqliteD1(database: DatabaseSync): D1Database {
  return createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteD1Statement(database.prepare(sql))),
    batch: async (statements: D1PreparedStatement[]) => {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements) results.push(await (statement as unknown as SqliteD1Statement).run());
      return results;
    },
  });
}

const openDatabases: DatabaseSync[] = [];
const objectStores = new Map<string, DatabaseSync>();

afterEach(() => {
  objectStores.clear();
  for (const database of openDatabases.splice(0)) database.close();
});

async function fixture(): Promise<{ env: Env; objectDatabase: DatabaseSync }> {
  // The current regional topology: the object reads a person's relationship
  // from `workspace_members`, and the conversations live in their own objects.
  const database = migratedSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${OWNER_ID}', 'facts-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('${MEMBER_ID}', 'facts-member', 'member@example.com', 'Member', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Facts', 'facts', 'global', '${OWNER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES
      ('${WORKSPACE_ID}', '${OWNER_ID}', 'owner', 'active', '2026-01-01'),
      ('${WORKSPACE_ID}', '${MEMBER_ID}', 'member', 'active', '2026-01-01');
  `);
  const runs: Array<[string, string, string, string]> = [
    [PRIVATE_CANVAS, OWNER_RUN, OWNER_ID, "lease-owner"],
    [OPEN_CANVAS, MEMBER_RUN, MEMBER_ID, "lease-member"],
    [OPEN_CANVAS, OWNER_OPEN_RUN, OWNER_ID, "lease-owner-open"],
    [SIDEKICK_ID, SIDEKICK_RUN, OWNER_ID, "lease-sidekick"],
    [OPEN_CANVAS, SIDEKICK_CANVAS_RUN, OWNER_ID, "lease-sidekick-thread"],
  ];
  for (const [workstreamId, runId, userId, leaseOwner] of runs) {
    let store = objectStores.get(workstreamId);
    if (!store) {
      store = testWorkstreamObjectStore();
      openDatabases.push(store);
      seedWorkstreamObjectRoot(store, { workstreamId, workspaceId: WORKSPACE_ID });
      applyWorkstreamObjectRootFields(store, { title: "Fixture", description: "Fixture", exactState: "running", createdByUserId: OWNER_ID });
      objectStores.set(workstreamId, store);
    }
    seedWorkstreamRun(store, {
      id: runId, executionPrincipalJson: JSON.stringify({ type: "user", userId }), attemptId: `attempt-${runId}`,
      attemptEpoch: 1, leaseOwner, leaseExpiresAt: Date.parse("2099-01-01T00:00:00.000Z"), heartbeatAt: Date.parse("2026-01-01"),
    });
  }
  const workspaceObject = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID, regionalDatabase: database, register: (created) => { openDatabases.push(created); },
  });
  // Both made by the owner: the side room stays theirs alone, the launch Canvas opens to every member.
  for (const [canvasId, title] of [[PRIVATE_CANVAS, "Side room"], [OPEN_CANVAS, "Launch"]] as const) {
    await workspaceObject.instance.canvasCreate({ workspaceId: WORKSPACE_ID, canvasId, title,
      createdByUserId: OWNER_ID, authorityGeneration: 1 });
  }
  workspaceObject.objectDatabase.prepare(`UPDATE canvas_directory SET visibility = 'workspace' WHERE canvas_id = ?`).run(OPEN_CANVAS);
  const rpcs = workspaceObjectRpcs(workspaceObject.instance, [
    "ensureMemoryScope", "recallMemoryFacts", "rememberMemoryFact", "forgetMemoryFact", "applyMemorySweep", "memorySweepCandidates",
  ]);
  const env = createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, { extra: rpcs }),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "warn",
  });
  return { env, objectDatabase: workspaceObject.objectDatabase };
}

type Who = "owner-private" | "member-open" | "owner-open";

function input(who: Who): WorkstreamWorkflowInput {
  const [parentId, runId, userId] = who === "owner-private"
    ? [PRIVATE_CANVAS, OWNER_RUN, OWNER_ID]
    : who === "member-open" ? [OPEN_CANVAS, MEMBER_RUN, MEMBER_ID] : [OPEN_CANVAS, OWNER_OPEN_RUN, OWNER_ID];
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "canvas",
    parentId,
    loopId: `canvas:${parentId}:substream:0:loop`,
    harnessRunId: runId,
    triggerMessageId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId },
    reason: "human_message",
  };
}

function context(runInput: WorkstreamWorkflowInput, receipt: string) {
  return {
    workspaceId: runInput.workspaceId,
    workstreamId: runInput.parentId,
    harnessRunId: runInput.harnessRunId,
    toolCallId: receipt,
    providerIdempotencyKey: receipt,
    executionPrincipal: runInput.executionPrincipal,
    signal: new AbortController().signal,
  };
}

function tool(env: Env, who: Who, name: "recall" | "remember" | "forget") {
  const found = createMemoryTools(env, input(who)).find((candidate) => candidate.definition.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return { execute: (args: unknown, receipt: string) => found.execute(args, context(input(who), receipt)), definition: found.definition };
}

/** A Sidekick run executing as the owner: in the Sidekick's own conversation, or posting into a Canvas. */
function sidekickRunInput(where: "own" | "canvas"): WorkstreamWorkflowInput {
  const [parentKind, parentId, runId] = where === "own"
    ? ["automation" as const, SIDEKICK_ID, SIDEKICK_RUN]
    : ["canvas" as const, OPEN_CANVAS, SIDEKICK_CANVAS_RUN];
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind,
    parentId,
    loopId: `${parentKind}:${parentId}:substream:0:loop`,
    harnessRunId: runId,
    triggerMessageId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: OWNER_ID },
    automationRun: {
      schemaVersion: 1,
      automationId: SIDEKICK_ID,
      runId,
      definitionRevision: 1,
      trigger: { kind: "manual", requestedByUserId: OWNER_ID },
    },
    reason: "human_message",
  };
}

type Recalled = { facts: Array<{ factId: string; text: string; subject: { kind: string; label: string }; source: { conversationId: string; title: string | null } }> };

describe("the rally:memory tools", () => {
  it("remembers a fact about the person, recalls it for them wherever they act, and for nobody else", async () => {
    const { env } = await fixture();
    const remembered = await tool(env, "owner-private", "remember").execute(
      { text: "Owner prefers release notes as bullets.", kind: "standing", about: "me" }, "receipt-remember-1",
    );
    expect(remembered.output).toMatchObject({ subject: { kind: "person" }, deduplicated: false, derivedFrom: "person" });
    const factId = (remembered.output as { factId: string }).factId;

    // The owner's own fact follows them into the open Canvas.
    const ownerRecall = await tool(env, "owner-open", "recall").execute({ query: "release notes bullets" }, "receipt-recall-1");
    expect((ownerRecall.output as Recalled).facts).toEqual([expect.objectContaining({
      factId, subject: { kind: "person", label: "the person you are working for" },
      source: { conversationId: `canvas:${PRIVATE_CANVAS}`, title: "Side room" },
    })]);
    // Another member on the same Canvas never sees it.
    const memberRecall = await tool(env, "member-open", "recall").execute({ query: "release notes bullets" }, "receipt-recall-2");
    expect((memberRecall.output as Recalled).facts).toEqual([]);

    // The same sentence again is the same fact, not a second one.
    const again = await tool(env, "owner-private", "remember").execute(
      { text: "owner prefers release notes as bullets", kind: "standing", about: "me" }, "receipt-remember-2",
    );
    expect(again.output).toMatchObject({ factId, deduplicated: true });
    // And a replayed receipt answers from the first write.
    const replay = await tool(env, "owner-private", "remember").execute(
      { text: "Owner prefers release notes as bullets.", kind: "standing", about: "me" }, "receipt-remember-1",
    );
    expect(replay.output).toEqual(remembered.output);
  });

  it("writes the sentence again when its only match is a fact the person can no longer open", async () => {
    const { env, objectDatabase } = await fixture();
    const first = await tool(env, "owner-private", "remember").execute(
      { text: "Owner prefers release notes as bullets.", kind: "standing", about: "me" }, "receipt-remember-1",
    );
    const firstId = (first.output as { factId: string }).factId;
    // The side room is gone: the fact is still the owner's, and out of their
    // reach. (Handing it to the member would not do: the owner administers
    // the Organization, and an administrator opens every Canvas.)
    objectDatabase.prepare(`DELETE FROM canvas_directory WHERE canvas_id = ?`).run(PRIVATE_CANVAS);
    const again = await tool(env, "owner-open", "remember").execute(
      { text: "Owner prefers release notes as bullets.", kind: "standing", about: "me" }, "receipt-remember-2",
    );
    expect(again.output).toMatchObject({ deduplicated: false });
    const againId = (again.output as { factId: string }).factId;
    expect(againId).not.toBe(firstId);
    // What was remembered can be recalled, which a dedupe against the hidden fact could not promise.
    const recall = await tool(env, "owner-open", "recall").execute({ query: "release notes bullets" }, "receipt-recall-1");
    expect((recall.output as Recalled).facts.map((fact) => fact.factId)).toEqual([againId]);
  });

  it("keeps a conversation's fact to the conversation and its readers", async () => {
    const { env } = await fixture();
    await tool(env, "owner-private", "remember").execute(
      { text: "The side room decided to ship on Friday.", kind: "standing" }, "receipt-side-room",
    );
    // Filed under the private Canvas, so a recall in the open Canvas does not
    // reach it: recall reads the subjects of where the run stands.
    const elsewhere = await tool(env, "owner-open", "recall").execute({ query: "ship Friday" }, "receipt-recall-3");
    expect((elsewhere.output as Recalled).facts).toEqual([]);
    const here = await tool(env, "owner-private", "recall").execute({ query: "ship Friday" }, "receipt-recall-4");
    expect((here.output as Recalled).facts).toEqual([expect.objectContaining({ subject: { kind: "thread", label: "Side room" } })]);
  });

  it("lets a member forget their own facts and the conversation's, and only an administrator forget the Organization's", async () => {
    const { env } = await fixture();
    const member = tool(env, "member-open", "remember");
    const own = (await member.execute({ text: "Member likes short standups.", kind: "standing", about: "me" }, "receipt-member-own")).output as { factId: string };
    const shared = (await member.execute({ text: "The launch Canvas meets on Tuesdays.", kind: "standing" }, "receipt-member-shared")).output as { factId: string };
    // The sweep promotes an Organization fact from the open Canvas.
    const applied = await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName("x")).applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: { parentKind: "canvas", parentId: OPEN_CANVAS, substreamId: "0" },
      fromSeq: 0, toSeq: 5, model: "test/model", inputTokens: null, outputTokens: null, now: Date.now(), factIds: ["fact-org"],
      speakerIds: [], candidateFactIds: [],
      operations: [{
        op: "add", subjectKind: "organization", subjectId: null, kind: "standing", text: "Release day is Thursday.",
        validFrom: null, validUntil: null, validUntilBasis: null, derivedFrom: "person", conflict: false, confidence: 0.9, evidence: [2],
      }],
    });
    expect(applied).toMatchObject({ outcome: "applied", refused: [] });

    // The owner, not the member, may forget the member's own fact: not visible to them.
    await expect(tool(env, "owner-open", "forget").execute({ factId: own.factId }, "receipt-forget-1"))
      .rejects.toMatchObject({ code: "memory_fact_not_visible" });
    // A member may forget what their conversation established, and the Organization's fact is not theirs to forget.
    expect((await tool(env, "member-open", "forget").execute({ factId: shared.factId }, "receipt-forget-2")).output)
      .toMatchObject({ factId: shared.factId, retractedAt: expect.any(String) });
    await expect(tool(env, "member-open", "forget").execute({ factId: "fact-org" }, "receipt-forget-3"))
      .rejects.toMatchObject({ code: "memory_fact_not_forgettable", details: { reason: expect.stringContaining("organization") } });
    // An owner is an administrator and may.
    expect((await tool(env, "owner-open", "forget").execute({ factId: "fact-org" }, "receipt-forget-4")).output)
      .toMatchObject({ factId: "fact-org" });
    // Forgotten means gone from recall, and forgetting again is not an error.
    expect(((await tool(env, "member-open", "recall").execute({ query: "release Thursday Tuesdays" }, "receipt-recall-5")).output as Recalled).facts).toEqual([]);
    expect((await tool(env, "owner-open", "forget").execute({ factId: "fact-org" }, "receipt-forget-5")).summary).toBe("That fact was already forgotten");
    await expect(tool(env, "owner-open", "forget").execute({ factId: "no-such-fact" }, "receipt-forget-6"))
      .rejects.toMatchObject({ code: "memory_fact_not_found" });
  });

  it("reads a Sidekick run as the Sidekick, never as the person it runs as", async () => {
    const { env, objectDatabase } = await fixture();
    // The owner's own fact, which their Sidekick must not be handed.
    await tool(env, "owner-open", "remember").execute(
      { text: "Owner prefers release notes as bullets.", kind: "standing", about: "me" }, "receipt-owner-own",
    );
    for (const where of ["own", "canvas"] as const) {
      const runInput = sidekickRunInput(where);
      const found = createMemoryTools(env, runInput);
      const call = (name: string, args: unknown, receipt: string) =>
        found.find((candidate) => candidate.definition.name === name)!.execute(args, context(runInput, receipt));
      // A Sidekick is nobody, so it has no "me" to remember about...
      await expect(call("remember", { text: "Owner likes short summaries.", kind: "standing", about: "me" }, `receipt-${where}-me`))
        .rejects.toMatchObject({ code: "memory_personal_unavailable" });
      // ...and the person it runs as does not lend it their facts.
      const recalled = await call("recall", { query: "release notes bullets" }, `receipt-${where}-recall`);
      expect((recalled.output as Recalled).facts).toEqual([]);
    }
    expect(objectDatabase.prepare(`SELECT COUNT(*) AS n FROM memory_facts WHERE subject_kind = 'person'`).get()).toEqual({ n: 1 });
  });

  it("names the horizon mistakes a model makes, before any write", async () => {
    const { env, objectDatabase } = await fixture();
    const remember = tool(env, "owner-private", "remember");
    await expect(remember.execute({ text: "Owner is out next week.", kind: "situational" }, "receipt-h1"))
      .rejects.toMatchObject({ code: "memory_horizon_required" });
    await expect(remember.execute({ text: "Owner likes bullets.", kind: "standing", validUntil: "2026-12-01T00:00:00Z" }, "receipt-h2"))
      .rejects.toMatchObject({ code: "memory_horizon_forbidden" });
    expect(objectDatabase.prepare("SELECT COUNT(*) AS n FROM memory_facts").get()).toEqual({ n: 0 });
    // The declared schema carries the same bounds the executor enforces.
    expect(remember.definition.inputSchema).toMatchObject({ required: ["text", "kind"], properties: { text: { maxLength: 600 } } });
    expect(tool(env, "owner-private", "recall").definition.inputSchema).toMatchObject({ properties: { limit: { maximum: 25 } } });
  });
});
