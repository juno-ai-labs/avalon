import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  MEMORY_SWEEP_MINIMUM_PERSON_MESSAGES,
  MEMORY_SWEEP_REST_FLOOR_MS,
  attemptMemorySweep,
  memorySweepRestUntil,
  runMemorySweep,
  sweepTerms,
  type MemorySweepMessage,
} from "../src/services/memory-sweep-service";
import { createCloudflareTestBinding, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";
import {
  applyWorkstreamObjectRootFields,
  seedCanonicalConversationTurn,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * The sweep lane's two halves over a real conversation object store: the
 * settlement-time attempt (gates, claim, one Queue send) and the consumer's
 * run (window, candidates, model, apply, settle). The model and the
 * `WorkspaceDO` are doubled at their transports; the cursor and cadence rows
 * are the production SQL. `docs/agent-memory.md#the-sweep` owns the lane.
 */

const USER_ID = asUserId("00000000-0000-4000-8000-000000000000");
const OTHER_ID = asUserId("00000000-0000-4000-8000-000000000009");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-10-19T09:00:00.000Z");

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Fixture {
  objectStore: DatabaseSync;
  env: Env;
  sent: MemorySweepMessage[];
  candidates: ReturnType<typeof vi.fn>;
  applied: ReturnType<typeof vi.fn>;
  prompts: Array<{ system: string; user: string }>;
}

function fixture(options: {
  decision?: unknown;
  modelFails?: boolean;
  applyOutcome?: unknown;
  candidatesOutcome?: unknown;
} = {}): Fixture {
  const database = preRetirementProductSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'google-sweep', 'sweep@example.com', 'Morgan', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Sweeps', 'sweeps', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
  `);
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: WORKSTREAM_ID, workspaceId: WORKSPACE_ID });
  applyWorkstreamObjectRootFields(objectStore, {
    title: "Pricing", description: "Settle the Q4 pricing rollout.", createdByUserId: USER_ID, exactState: "idle",
  });

  const prompts: Array<{ system: string; user: string }> = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    if (options.modelFails) return new Response("upstream down", { status: 503 });
    const request = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    prompts.push({
      system: request.messages.find((message) => message.role === "system")?.content ?? "",
      user: request.messages.find((message) => message.role === "user" && message.content.includes("PLACEMENT"))?.content ?? "",
    });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(options.decision ?? { operations: [] }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const sent: MemorySweepMessage[] = [];
  const candidates = vi.fn(async () => options.candidatesOutcome ?? {
    outcome: "ready",
    placement: {
      conversation: { parentKind: "workstream", parentId: WORKSTREAM_ID, substreamId: "0" },
      subject: { kind: "thread", id: WORKSTREAM_ID, title: "Pricing" },
      thread: null,
      channels: [{ id: "space-1", title: "Go-to-market" }],
      organizationWide: true,
      people: [{ id: USER_ID }],
    },
    candidates: [],
  });
  const applied = vi.fn(async (request: { fromSeq: number; toSeq: number; operations: unknown[] }) => options.applyOutcome ?? {
    outcome: "applied",
    receipt: { conversation: WORKSTREAM_ID, fromSeq: request.fromSeq, toSeq: request.toSeq, appliedAt: NOW, operationCount: request.operations.length },
    refused: [],
    revision: 1,
    markedHolders: false,
  });
  const workspaceStub = { memorySweepCandidates: candidates, applyMemorySweep: applied };
  const workspaces: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => workspaceStub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => workspaces,
  });
  const env = createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
    WORKSPACE_DOS: workspaces,
    ACTIVITY_QUEUE: {
      send: async (body: unknown) => { sent.push(body as MemorySweepMessage); },
      sendBatch: async () => undefined,
    },
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "error",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_PRIMARY_MODEL: "test/primary",
    OPENROUTER_FALLBACK_MODELS: "",
    PUBLIC_API_BASE_URL: "https://api.example.com",
  });
  return { objectStore, env, sent, candidates, applied, prompts };
}

function say(objectStore: DatabaseSync, sequence: number, text: string, author: "person" | "other" | "agent" = "person") {
  seedCanonicalConversationTurn(objectStore, {
    turnId: `turn-${sequence}`,
    actor: author === "agent" ? "assistant" : "human",
    authorUserId: author === "agent" ? null : author === "person" ? USER_ID : OTHER_ID,
    authorSnapshot: author === "agent" ? null : { displayName: author === "person" ? "Morgan" : "Alex", avatarUrl: null },
    messageType: "text",
    text,
    transcriptSequence: sequence,
    createdAt: NOW - (100 - sequence) * 60_000,
  });
}

const target = { workspaceId: WORKSPACE_ID, parentKind: "workstream" as const, parentId: WORKSTREAM_ID, substreamId: "0" };

function state(objectStore: DatabaseSync) {
  return objectStore.prepare(
    `SELECT swept_through_seq, rest_until, consecutive_quiet, claim_from_seq, claim_to_seq, claim_attempt, claim_at, retry_at
       FROM memory_sweep_state WHERE id = 1`,
  ).get() as Record<string, number | null> | undefined;
}

describe("the sweep attempt at settlement", () => {
  it("sends nothing for a conversation with too little new person conversation", async () => {
    const { objectStore, env, sent } = fixture();
    vi.useFakeTimers({ now: NOW });
    say(objectStore, 1, "Let's settle the Q4 pricing rollout this week and keep the enterprise tier.");
    say(objectStore, 2, "On it.", "agent");
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "skipped", reason: "insufficient_new_conversation" });
    expect(sent).toEqual([]);
    // Nothing to retry: the next run is the next chance.
    expect(state(objectStore)?.retry_at ?? null).toBeNull();
  });

  it("claims the window, pushes the rest before the model is asked, and sends one message", async () => {
    const { objectStore, env, sent } = fixture();
    vi.useFakeTimers({ now: NOW });
    for (let sequence = 1; sequence <= MEMORY_SWEEP_MINIMUM_PERSON_MESSAGES; sequence += 1) {
      say(objectStore, sequence, `We decided point ${sequence}: the pricing page ships on 2026-10-30 with the enterprise tier unchanged.`);
    }
    say(objectStore, 10, "Noted, drafting the announcement now.", "agent");
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "published", fromSeq: 0, toSeq: 10, attempt: 1 });
    expect(sent).toEqual([{
      type: "memory_sweep", region: "global", workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: WORKSTREAM_ID,
      substreamId: "0", fromSeq: 0, toSeq: 10, attempt: 1,
    }]);
    expect(state(objectStore)).toMatchObject({
      swept_through_seq: 0, claim_from_seq: 0, claim_to_seq: 10, claim_attempt: 1, claim_at: NOW,
      // The claim leaves the alarm its rest, so a delivery lost with its release is tried again.
      rest_until: memorySweepRestUntil(NOW, 0), retry_at: memorySweepRestUntil(NOW, 0),
    });
    // A second settlement behind it finds the conversation resting with the
    // same messages behind the cursor, and leaves the alarm a time to retry.
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "skipped", reason: "resting" });
    expect(sent).toHaveLength(1);
    expect(state(objectStore)?.retry_at).toBe(NOW + MEMORY_SWEEP_REST_FLOOR_MS);
    // The delivery never settled or released. At the rest the claim has timed
    // out, and the alarm's attempt claims the same window again.
    vi.setSystemTime(NOW + MEMORY_SWEEP_REST_FLOOR_MS);
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "published", fromSeq: 0, toSeq: 10, attempt: 2 });
    expect(sent).toHaveLength(2);
    expect(state(objectStore)).toMatchObject({ claim_attempt: 2, claim_at: NOW + MEMORY_SWEEP_REST_FLOOR_MS });
  });

  it("asks the alarm back while resting when anything follows the cursor, without reading the window", async () => {
    const { objectStore, env } = fixture({ decision: { operations: [] } });
    vi.useFakeTimers({ now: NOW });
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      say(objectStore, sequence, `Decision ${sequence}: the pricing page ships on 2026-10-30 with the enterprise tier unchanged.`);
    }
    const claimed = await attemptMemorySweep(env, target);
    if (claimed.status !== "published") throw new Error("expected a claim");
    await runMemorySweep(env, { type: "memory_sweep", region: "global", ...target, workspaceId: WORKSPACE_ID, parentKind: "workstream", fromSeq: 0, toSeq: claimed.toSeq, attempt: claimed.attempt });
    const rested = state(objectStore)!;
    expect(rested).toMatchObject({ swept_through_seq: 4, retry_at: null });
    // Resting with nothing after the cursor: nothing to come back for.
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "skipped", reason: "resting" });
    expect(state(objectStore)?.retry_at).toBeNull();
    // One new message is below the floors, but the alarm comes back at the
    // rest to look: the floors are checked then, not while resting.
    say(objectStore, 5, "One more thing on pricing.");
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "skipped", reason: "resting" });
    expect(state(objectStore)?.retry_at).toBe(rested.rest_until);
  });

  it("clears a due retry when there is no model access, so the alarm does not wake into the same answer", async () => {
    const { objectStore, env } = fixture();
    vi.useFakeTimers({ now: NOW });
    for (let sequence = 1; sequence <= MEMORY_SWEEP_MINIMUM_PERSON_MESSAGES; sequence += 1) {
      say(objectStore, sequence, `We decided point ${sequence}: the pricing page ships on 2026-10-30 with the enterprise tier unchanged.`);
    }
    expect(await attemptMemorySweep(env, target)).toMatchObject({ status: "published" });
    expect(state(objectStore)?.retry_at).toBe(memorySweepRestUntil(NOW, 0));
    const keyless: Env = { ...env, OPENROUTER_API_KEY: "" };
    expect(await attemptMemorySweep(keyless, target)).toEqual({ status: "skipped", reason: "no_model_access" });
    expect(state(objectStore)?.retry_at).toBeNull();
  });

  it("ends a window that outgrows its character budget at the last message that fit, oldest first", async () => {
    const { objectStore, env, sent } = fixture();
    vi.useFakeTimers({ now: NOW });
    // Five 50,000-character messages against a 160,000-character budget: three fit.
    for (let sequence = 1; sequence <= 5; sequence += 1) say(objectStore, sequence, `${sequence}`.repeat(50_000));
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "published", fromSeq: 0, toSeq: 3, attempt: 1 });
    expect(sent).toEqual([expect.objectContaining({ fromSeq: 0, toSeq: 3 })]);
  });

  it("moves past a full page with too little person conversation, with a receipt and no model call", async () => {
    const { objectStore, env, sent, applied, prompts } = fixture();
    vi.useFakeTimers({ now: NOW });
    // A page is the window plus its overlap plus one: 321 rows, of which two are a person's.
    for (let sequence = 1; sequence <= 330; sequence += 1) {
      say(objectStore, sequence, sequence % 100 === 0 ? `Person note ${sequence} on the pricing rollout.` : `Tool-driven step ${sequence}.`,
        sequence % 100 === 0 ? "person" : "agent");
    }
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "skipped", reason: "page_without_conversation" });
    expect(sent).toEqual([]);
    expect(prompts).toEqual([]);
    // The store's fence moves with the cursor, so the next sweep is not rewound over the page.
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ fromSeq: 0, toSeq: 321, operations: [], model: "none" }));
    const after = state(objectStore)!;
    expect(after).toMatchObject({ swept_through_seq: 321, consecutive_quiet: 1, claim_at: null });
    // Rows after the page remain, so the alarm comes back for them at the rest.
    expect(after.retry_at).toBe(after.rest_until);
  });

  it("moves past an over-budget run of agent text to the person conversation behind it", async () => {
    const { objectStore, env, sent, applied } = fixture();
    vi.useFakeTimers({ now: NOW });
    // Four 50,000-character agent messages spend the budget before the people speak.
    for (let sequence = 1; sequence <= 4; sequence += 1) say(objectStore, sequence, `${sequence}`.repeat(50_000), "agent");
    for (let sequence = 5; sequence <= 7; sequence += 1) {
      say(objectStore, sequence, `We decided point ${sequence}: the pricing page ships on 2026-10-30 with the enterprise tier unchanged.`);
    }
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "skipped", reason: "page_without_conversation" });
    // Only what was read is passed: the three messages that fit.
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ fromSeq: 0, toSeq: 3, operations: [] }));
    expect(state(objectStore)).toMatchObject({ swept_through_seq: 3 });
    // At the rest, the window from there holds the people, and is claimed.
    vi.setSystemTime(Number(state(objectStore)!.rest_until));
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "published", fromSeq: 3, toSeq: 7, attempt: 1 });
    expect(sent).toEqual([expect.objectContaining({ fromSeq: 3, toSeq: 7 })]);
  });

  it("never sweeps a Channel's own feed in this release", async () => {
    const { env, sent } = fixture();
    expect(await attemptMemorySweep(env, { ...target, parentKind: "space" })).toEqual({ status: "skipped", reason: "space_parent" });
    expect(sent).toEqual([]);
  });
});

describe("the sweep run in the consumer", () => {
  const decision = {
    operations: [
      {
        op: "add", subjectKind: "thread", subjectId: null, kind: "situational",
        text: "The pricing page ships on 2026-10-30.", validFrom: null, validUntil: "2026-10-30T23:59:59.000Z",
        validUntilBasis: "stated", derivedFrom: "person", conflict: false, confidence: 0.9, evidence: [1], factId: null, reason: null,
      },
      {
        // An update with no id is incoherent and is dropped before the store sees it.
        op: "update", subjectKind: null, subjectId: null, kind: null, text: "Something", validFrom: null, validUntil: null,
        validUntilBasis: null, derivedFrom: null, conflict: false, confidence: 0.5, evidence: [], factId: null, reason: null,
      },
    ],
  };

  async function claimed(objectStore: DatabaseSync, env: Env): Promise<MemorySweepMessage> {
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      say(objectStore, sequence, `Decision ${sequence}: the pricing page ships on 2026-10-30 with the enterprise tier unchanged.`);
    }
    say(objectStore, 5, "Alex here, agreed on the thirtieth.", "other");
    const outcome = await attemptMemorySweep(env, target);
    if (outcome.status !== "published") throw new Error(`expected a claim, got ${JSON.stringify(outcome)}`);
    return {
      type: "memory_sweep", region: "global", workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: WORKSTREAM_ID,
      substreamId: "0", fromSeq: outcome.fromSeq, toSeq: outcome.toSeq, attempt: outcome.attempt,
    };
  }

  it("reads the window, asks the model with the placement and candidates, applies, and settles the cursor", async () => {
    const { objectStore, env, candidates, applied, prompts } = fixture({ decision });
    vi.useFakeTimers({ now: NOW });
    const message = await claimed(objectStore, env);
    vi.useRealTimers();

    expect(await runMemorySweep(env, message)).toEqual({ status: "applied", operations: 1, refused: 0, toSeq: 5 });
    // The store was asked for candidates by the window's own words and speakers.
    expect(candidates).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      conversation: { parentKind: "workstream", parentId: WORKSTREAM_ID, substreamId: "0" },
      speakerIds: [USER_ID, OTHER_ID],
      terms: expect.arrayContaining(["pricing", "enterprise"]),
    }));
    // The model saw the placement, the people, and every message, oldest first.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.user).toContain('"organizationWide":true');
    // Members are named from the directory, in the placement and on their messages.
    expect(prompts[0]!.user).toContain(`"people":[{"id":"${USER_ID}","name":"Morgan"}]`);
    expect(prompts[0]!.user).toContain(`"authorId":"${USER_ID}","authorName":"Morgan"`);
    expect(prompts[0]!.user).toContain("Decision 4");
    // Only the coherent operation reached the store, with its horizon as an instant.
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      fromSeq: 0, toSeq: 5, model: "test/primary",
      operations: [expect.objectContaining({ op: "add", subjectKind: "thread", validUntil: Date.parse("2026-10-30T23:59:59.000Z") })],
      factIds: [expect.any(String)],
      // The store is told who spoke and which candidates the model saw, and fences to both.
      speakerIds: [USER_ID, OTHER_ID],
      candidateFactIds: [],
    }));
    // The cursor moved to the applied range; a sweep that wrote rests at the floor.
    expect(state(objectStore)).toMatchObject({ swept_through_seq: 5, consecutive_quiet: 0, claim_at: null, retry_at: null });
  });

  it("releases the claim and rethrows when the model fails, so the alarm retries at the rest", async () => {
    const { objectStore, env, applied } = fixture({ modelFails: true });
    vi.useFakeTimers({ now: NOW });
    const message = await claimed(objectStore, env);
    vi.useRealTimers();
    await expect(runMemorySweep(env, message)).rejects.toThrow();
    expect(applied).not.toHaveBeenCalled();
    expect(state(objectStore)).toMatchObject({
      swept_through_seq: 0, claim_at: null, retry_at: memorySweepRestUntil(NOW, 0),
    });
  });

  it("finishes a redelivery from the store's receipt, and rewinds when the store is behind", async () => {
    const replayed = fixture({
      decision: { operations: [] },
      applyOutcome: { outcome: "already_applied", receipt: { conversation: WORKSTREAM_ID, fromSeq: 0, toSeq: 5, appliedAt: NOW, operationCount: 1 } },
    });
    vi.useFakeTimers({ now: NOW });
    const message = await claimed(replayed.objectStore, replayed.env);
    vi.useRealTimers();
    expect(await runMemorySweep(replayed.env, message)).toEqual({ status: "already_applied", toSeq: 5 });
    expect(state(replayed.objectStore)).toMatchObject({ swept_through_seq: 5, consecutive_quiet: 0 });

    const behind = fixture({ decision: { operations: [] }, applyOutcome: { outcome: "cursor_ahead", storedToSeq: 2 } });
    vi.useFakeTimers({ now: NOW });
    const second = await claimed(behind.objectStore, behind.env);
    vi.useRealTimers();
    expect(await runMemorySweep(behind.env, second)).toEqual({ status: "rewound", toSeq: 2 });
    expect(state(behind.objectStore)).toMatchObject({ swept_through_seq: 2 });
  });

  it("keeps a follow-up a run asked for while the sweep was in flight", async () => {
    const { objectStore, env } = fixture({ decision: { operations: [] } });
    vi.useFakeTimers({ now: NOW });
    const message = await claimed(objectStore, env);
    // A run settles mid-sweep with a new message, finds the conversation
    // resting, and asks the alarm back at the claim's rest.
    say(objectStore, 6, "Also, the enterprise tier gets annual billing only.");
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "skipped", reason: "resting" });
    expect(state(objectStore)?.retry_at).toBe(memorySweepRestUntil(NOW, 0));
    vi.useRealTimers();
    // The sweep's settle moves the rest and keeps the follow-up at it.
    expect(await runMemorySweep(env, message)).toMatchObject({ status: "applied", toSeq: 5 });
    const after = state(objectStore)!;
    expect(after).toMatchObject({ swept_through_seq: 5, consecutive_quiet: 1, claim_at: null });
    expect(after.retry_at).not.toBeNull();
    expect(after.retry_at).toBe(after.rest_until);
  });

  it("records a range with nothing to sweep in the store before moving the cursor", async () => {
    const { objectStore, env, applied, prompts } = fixture({ candidatesOutcome: { outcome: "conversation_missing" } });
    vi.useFakeTimers({ now: NOW });
    const message = await claimed(objectStore, env);
    vi.useRealTimers();
    expect(await runMemorySweep(env, message)).toEqual({ status: "nothing_to_sweep" });
    expect(prompts).toEqual([]);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ fromSeq: 0, toSeq: 5, operations: [], model: "none" }));
    expect(state(objectStore)).toMatchObject({ swept_through_seq: 5, claim_at: null });
  });

  it("drops a malformed operation and applies the rest of the paid answer", async () => {
    const good = decision.operations[0]!;
    const { objectStore, env, applied } = fixture({
      decision: { operations: [{ ...good, text: "Out of range.", confidence: 2 }, good] },
    });
    vi.useFakeTimers({ now: NOW });
    const message = await claimed(objectStore, env);
    vi.useRealTimers();
    expect(await runMemorySweep(env, message)).toEqual({ status: "applied", operations: 1, refused: 0, toSeq: 5 });
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({ text: "The pricing page ships on 2026-10-30." })],
    }));
  });

  it("derives a fact's trust class from who wrote the messages it cites, not from the model", async () => {
    const add = (evidence: number[], derivedFrom: string | null, text: string) => ({
      op: "add", subjectKind: "thread", subjectId: null, kind: "standing", text, validFrom: null, validUntil: null,
      validUntilBasis: null, derivedFrom, conflict: false, confidence: 0.9, evidence, factId: null, reason: null,
    });
    const { objectStore, env, applied } = fixture({
      decision: {
        operations: [
          add([1, 2], "agent", "People said it."),
          add([6], "person", "Only the agent said it."),
          add([1, 6], "person", "Both said it."),
          add([], null, "Nobody is cited."),
          add([], "external", "Nobody is cited, the model says external."),
        ],
      },
    });
    vi.useFakeTimers({ now: NOW });
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      say(objectStore, sequence, `Decision ${sequence}: the pricing page ships on 2026-10-30 with the enterprise tier unchanged.`);
    }
    say(objectStore, 6, "I will draft the pricing announcement for the thirtieth.", "agent");
    const outcome = await attemptMemorySweep(env, target);
    if (outcome.status !== "published") throw new Error("expected a claim");
    vi.useRealTimers();
    await runMemorySweep(env, {
      type: "memory_sweep", region: "global", workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: WORKSTREAM_ID,
      substreamId: "0", fromSeq: outcome.fromSeq, toSeq: outcome.toSeq, attempt: outcome.attempt,
    });
    const operations = (applied.mock.calls[0]![0] as { operations: Array<{ derivedFrom: string }> }).operations;
    expect(operations.map((operation) => operation.derivedFrom)).toEqual(["person", "agent", "mixed", "agent", "external"]);
  });

  it("counts a quiet sweep toward a longer rest", async () => {
    const { objectStore, env } = fixture({ decision: { operations: [] } });
    vi.useFakeTimers({ now: NOW });
    const message = await claimed(objectStore, env);
    vi.useRealTimers();
    expect(await runMemorySweep(env, message)).toEqual({ status: "applied", operations: 0, refused: 0, toSeq: 5 });
    const after = state(objectStore)!;
    expect(after.consecutive_quiet).toBe(1);
    expect(Number(after.rest_until) - Date.now()).toBeGreaterThan(MEMORY_SWEEP_REST_FLOOR_MS);
  });
});

describe("sweep terms", () => {
  it("keeps the words worth matching facts on, most frequent first", () => {
    expect(sweepTerms([{ text: "The pricing page, the pricing tier, and a date." }])).toEqual(["pricing", "page", "tier", "date"]);
  });
});
