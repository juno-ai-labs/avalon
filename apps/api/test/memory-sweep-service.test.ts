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
      rest_until: memorySweepRestUntil(NOW, 0), retry_at: null,
    });
    // A second settlement behind it finds the conversation resting with the
    // same messages behind the cursor, and leaves the alarm a time to retry.
    expect(await attemptMemorySweep(env, target)).toEqual({ status: "skipped", reason: "resting" });
    expect(sent).toHaveLength(1);
    expect(state(objectStore)?.retry_at).toBe(NOW + MEMORY_SWEEP_REST_FLOOR_MS);
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
    expect(prompts[0]!.user).toContain(`"people":[{"id":"${USER_ID}","name":null}]`);
    expect(prompts[0]!.user).toContain("Decision 4");
    // Only the coherent operation reached the store, with its horizon as an instant.
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      fromSeq: 0, toSeq: 5, model: "test/primary",
      operations: [expect.objectContaining({ op: "add", subjectKind: "thread", validUntil: Date.parse("2026-10-30T23:59:59.000Z") })],
      factIds: [expect.any(String)],
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
