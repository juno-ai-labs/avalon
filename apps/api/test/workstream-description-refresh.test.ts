import { asUserId, asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES,
  DESCRIPTION_REFRESH_MINIMUM_NOVEL_TERMS,
  DESCRIPTION_WINDOW_MINIMUM_MESSAGES,
  MAXIMUM_DESCRIPTION_CHARACTERS,
  MAXIMUM_DESCRIPTION_WINDOW_CHARACTERS,
  MAXIMUM_DESCRIPTION_WINDOW_MESSAGES,
  countNovelSubjectTerms,
  isTooGenericDescription,
  judgeDescriptionProposal,
  refreshWorkstreamDescription,
  restUntil,
} from "../src/services/workstream-description-service";
import { withWorkstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  executeWorkstreamObjectSql,
  testSubstreamAgentsBinding,
  seedWorkstreamObjectRoot,
  testWorkstreamObjectStore,
  workstreamObjectRun,
  workstreamObjectRootRow,
  applyWorkstreamObjectRootFields,
} from "./helpers/durable-authority";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000000");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-08-11T12:00:00.000Z");

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Proposal {
  decision: "keep" | "rewrite";
  description: string | null;
  confidence: number;
  reasoning: string;
}

interface Fixture {
  database: DatabaseSync;
  /** The work stream's own object database — transcript, product row, refresh state. */
  objectStore: DatabaseSync;
  env: Env;
  /** Every prompt the loop actually sent, so a test can assert on the window it built. */
  prompts: Array<{ system: string; user: string }>;
}

function fixture(options: {
  proposal?: Proposal | (() => Proposal);
  objective?: string;
  descriptionSource?: "authored" | "derived";
  originType?: "ad_hoc" | "automation";
  archived?: boolean;
} = {}): Fixture {
  const database = preRetirementProductSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'google-description', 'description@example.com', 'Morgan', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Descriptions', 'descriptions', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Checkout', 'directory copy',
            '${options.originType ?? "ad_hoc"}', '${USER_ID}',
            'idle', 1, '2026-08-11', '2026-01-01', '2026-01-01');
  `);
  // Since migration 0090 the transcript, the product `workstreams` row, and
  // the refresh state live only in the work stream's object; the service
  // reads and writes them through the routed environment below.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM_ID,
    workspaceId: WORKSPACE_ID,
    title: "Checkout",
    description: options.objective ?? "Look into the payment error Morgan reported on Monday.",
    descriptionSource: options.descriptionSource ?? "derived",
    originType: options.originType ?? "ad_hoc",
    createdByUserId: USER_ID,
    exactState: "idle",
    archivedAt: options.archived ? Date.parse("2026-08-01T00:00:00.000Z") : null,
  });

  const prompts: Array<{ system: string; user: string }> = [];
  const proposal = options.proposal ?? {
    decision: "keep" as const,
    description: null,
    confidence: 0.9,
    reasoning: "Still the same work.",
  };
  const fetcher = async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    // The client appends its own schema-reminder user message; the one this
    // loop rendered is the one carrying the work stream under review.
    prompts.push({
      system: request.messages.find((message) => message.role === "system")?.content ?? "",
      user: request.messages.find(
        (message) => message.role === "user" && message.content.includes("WORK STREAM UNDER REVIEW"),
      )?.content ?? "",
    });
    const resolved = typeof proposal === "function" ? proposal() : proposal;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(resolved) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  vi.stubGlobal("fetch", fetcher);

  // Production hands the refresh loop a routed environment — the substream
  // agent's local runtime environment; the local executor is that agent-side
  // port over the object store.
  const env = withWorkstreamRuntimeDatabase(
    createTestEnv({
      DB: sqliteD1(database),
      // The refresh cadence's own rows reach the object through the scheduling
      // port rather than the runtime router, so the fixture needs the binding
      // that port dispatches through — over this same object store.
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
      AVALON_REGION: "global",
      APP_ENV: "test",
      LOG_LEVEL: "error",
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_STRUCTURED_MODEL: "test/structured",
      OPENROUTER_FALLBACK_MODELS: "",
      PUBLIC_API_BASE_URL: "https://api.example.com",
    }),
    WORKSPACE_ID,
    WORKSTREAM_ID,
    "0",
    async (statements) => executeWorkstreamObjectSql(objectStore, statements),
  );
  return { database, objectStore, env, prompts };
}

/**
 * A message substantial enough to be conversation and specific enough to be
 * about something the seeded description does not name — what the admission
 * gates are looking for, so a test that wants an evaluation gets one.
 */
const DRIFTING_MESSAGE =
  "The 3-D Secure migration for our EU issuers needs a rollout plan, and issuer "
  + "sandbox coverage is still short of the acquirer requirements we agreed.";
/**
 * Substantial conversation that raises nothing the description does not already
 * name — a busy work stream that has not changed.
 */
const ON_TOPIC_MESSAGE =
  "Morgan reported the payment error on Monday, and the payment error Morgan "
  + "reported on Monday is still the payment error we are looking into.";

function addMessages(
  objectStore: DatabaseSync,
  count: number,
  options: {
    createdAt?: string;
    startSequence?: number;
    text?: string;
    /**
     * A Slack participant is stored as `author_type = 'external'` with the
     * actor alongside — the object's parts schema enforces that pairing, where
     * the dropped D1 table stored `system` next to the actor JSON.
     */
    authorType?: "human" | "external" | "agent" | "system";
  } = {},
): void {
  const startSequence = options.startSequence ?? 1;
  const authorType = options.authorType ?? "human";
  const storedAuthorType = authorType;
  for (let index = 0; index < count; index += 1) {
    const sequence = startSequence + index;
    workstreamObjectRun(
      objectStore,
      `INSERT INTO messages
         (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
          message_type, text_content, sequence_number, created_at, external_actor_json)
       VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, ?, ?)`,
      `message-${sequence}`,
      `client-${sequence}`,
      WORKSPACE_ID,
      WORKSTREAM_ID,
      storedAuthorType,
      authorType === "human" ? USER_ID : null,
      options.text ?? DRIFTING_MESSAGE,
      sequence,
      options.createdAt ?? NOW.toISOString(),
      authorType === "external"
        ? JSON.stringify({
            provider: "slack",
            providerAccountId: "TACME",
            providerUserId: "UROWAN",
            displayName: "Rowan (Slack)",
            avatarUrl: null,
          })
        : null,
    );
  }
}

/** The smallest transcript that clears every admission gate. */
function addQualifyingConversation(
  objectStore: DatabaseSync,
  options: { createdAt?: string; startSequence?: number } = {},
): void {
  addMessages(objectStore, DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES, options);
}

/**
 * The rendered transcript, dug back out of the prompt. The client appends its
 * schema reminder to the same user message, so the transcript is the JSON array
 * line rather than the last one.
 */
function transcriptOf(user: string): unknown[] {
  const line = user.split("\n").find((candidate) => candidate.startsWith("["));
  return JSON.parse(line ?? "[]") as unknown[];
}

function objective(objectStore: DatabaseSync): string {
  return workstreamObjectRootRow<{ description: string }>(objectStore, "description").description;
}

/**
 * The object's own refresh row.
 *
 * Read directly rather than through `workstreamObjectGet`, which renames the
 * table onto `_runtime_description_refreshes` — the view this slice deletes.
 * Its columns are the object's: unix milliseconds, and no fabricated
 * `workstream_id`.
 */
function refreshRow(objectStore: DatabaseSync): Record<string, unknown> | undefined {
  return (objectStore.prepare(
    "SELECT * FROM description_refresh_state WHERE id = 1",
  ).get() as Record<string, unknown> | undefined) ?? undefined;
}

describe("description proposal guards", () => {
  const rewrite = (description: string | null, confidence = 0.95): Proposal => ({
    decision: "rewrite",
    description,
    confidence,
    reasoning: "The work moved.",
  });
  const current = "Look into the payment error Morgan reported on Monday.";

  it("applies a confident, specific rewrite", () => {
    expect(judgeDescriptionProposal(rewrite("Track the 3-D Secure migration for EU card issuers."), current)).toEqual({
      status: "rewritten",
      description: "Track the 3-D Secure migration for EU card issuers.",
    });
  });

  it("keeps the saved description when the model is not confident", () => {
    expect(judgeDescriptionProposal(rewrite("Track the 3-D Secure migration for EU card issuers.", 0.79), current))
      .toEqual({ status: "kept" });
  });

  it.each([
    "General discussion",
    "general discussion.",
    "  Ongoing work  ",
    "Chat",
    "Various topics",
  ])("refuses the catch-all description %j", (description) => {
    expect(isTooGenericDescription(description)).toBe(true);
    expect(judgeDescriptionProposal(rewrite(description), current)).toEqual({
      status: "rejected",
      code: "description_too_generic",
    });
  });

  it("keeps a rewrite that only restyles the saved wording", () => {
    expect(judgeDescriptionProposal(rewrite("Look into the payment error Morgan reported on Monday!"), current))
      .toEqual({ status: "kept" });
  });

  it.each([
    ["", "empty_description"],
    ["Payments", "description_too_short"],
    ["Fix it now", "description_too_short"],
    ["x".repeat(MAXIMUM_DESCRIPTION_CHARACTERS + 1), "description_too_long"],
  ])("rejects the unusable proposal %j", (description, code) => {
    expect(judgeDescriptionProposal(rewrite(description), current)).toEqual({ status: "rejected", code });
  });
});

describe("work-stream description refresh", () => {
  const input = { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID };

  it("records a keep without touching the description", async () => {
    const { objectStore, env } = fixture();
    addQualifyingConversation(objectStore);

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW })).toEqual({ status: "kept" });
    expect(objective(objectStore)).toBe("Look into the payment error Morgan reported on Monday.");
    expect(refreshRow(objectStore)).toMatchObject({
      decision: "kept",
      rejection_code: null,
      consecutive_keeps: 1,
      evaluated_through_sequence: DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES,
    });
  });

  it("rewrites a description the work stream has outgrown and marks it derived", async () => {
    const { objectStore, env } = fixture({
      descriptionSource: "authored",
      proposal: {
        decision: "rewrite",
        description: "Track the 3-D Secure migration for EU card issuers.",
        confidence: 0.92,
        reasoning: "The work stream now runs the migration, not the original bug.",
      },
    });
    addQualifyingConversation(objectStore);

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW })).toEqual({
      status: "rewritten",
      description: "Track the 3-D Secure migration for EU card issuers.",
    });
    expect(objective(objectStore)).toBe("Track the 3-D Secure migration for EU card issuers.");
    expect(workstreamObjectRootRow(objectStore, "description_source"))
      .toMatchObject({ description_source: "derived" });
    expect(refreshRow(objectStore)).toMatchObject({
      decision: "rewritten",
      previous_description: "Look into the payment error Morgan reported on Monday.",
      description: "Track the 3-D Secure migration for EU card issuers.",
    });
  });

  it("tells the model how the description in force was written", async () => {
    const { objectStore, env, prompts } = fixture({ descriptionSource: "authored" });
    addQualifyingConversation(objectStore);

    await refreshWorkstreamDescription(env, { ...input, now: NOW });
    expect(prompts[0]!.user).toContain('"descriptionSource":"authored"');
    expect(prompts[0]!.user).toContain("UNTRUSTED RECENT TRANSCRIPT");
  });

  it("refuses to overwrite a description a person changed mid-evaluation", async () => {
    const { objectStore, env } = fixture({
      proposal: () => {
        applyWorkstreamObjectRootFields(objectStore, {
          description: "Run the EU payments incident review.",
        });
        return {
          decision: "rewrite",
          description: "Track the 3-D Secure migration for EU card issuers.",
          confidence: 0.95,
          reasoning: "The work moved.",
        };
      },
    });
    addQualifyingConversation(objectStore);

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW }))
      .toEqual({ status: "rejected", code: "description_changed_during_evaluation" });
    expect(objective(objectStore)).toBe("Run the EU payments incident review.");
    expect(refreshRow(objectStore)).toMatchObject({
      decision: "rejected",
      rejection_code: "description_changed_during_evaluation",
      previous_description: "Look into the payment error Morgan reported on Monday.",
      // What is in force afterwards is the other writer's text, not the text
      // this evaluation read.
      description: "Run the EU payments incident review.",
    });
  });

  it("reads the last 200 messages when the last 72 hours holds fewer", async () => {
    const { objectStore, env, prompts } = fixture();
    const old = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    addMessages(objectStore, 250, { createdAt: old });
    addQualifyingConversation(objectStore, { startSequence: 251 });

    await refreshWorkstreamDescription(env, { ...input, now: NOW });
    const transcript = transcriptOf(prompts[0]!.user);
    expect(transcript).toHaveLength(DESCRIPTION_WINDOW_MINIMUM_MESSAGES);
    expect(prompts[0]!.user).toContain(`${DESCRIPTION_WINDOW_MINIMUM_MESSAGES} messages, oldest first`);
    expect(prompts[0]!.user).not.toContain("older messages in this window were omitted");
  });

  it("reads every message of a busy 72 hours, up to the ceiling, and says when it capped", async () => {
    const { objectStore, env, prompts } = fixture();
    addMessages(objectStore, MAXIMUM_DESCRIPTION_WINDOW_MESSAGES + 40);

    await refreshWorkstreamDescription(env, { ...input, now: NOW });
    const transcript = transcriptOf(prompts[0]!.user);
    expect(transcript).toHaveLength(MAXIMUM_DESCRIPTION_WINDOW_MESSAGES);
    expect(prompts[0]!.user).toContain("older messages in this window were omitted");
  });

  it("bounds the window by characters as well as rows, keeping the newest", async () => {
    const { objectStore, env, prompts } = fixture();
    // Every message renders at the per-message cap, so the character budget
    // binds well before the row cap does.
    const long = `${DRIFTING_MESSAGE} ${"padding ".repeat(200)}`;
    addMessages(objectStore, MAXIMUM_DESCRIPTION_WINDOW_MESSAGES, { text: long });

    await refreshWorkstreamDescription(env, { ...input, now: NOW });
    const transcript = transcriptOf(prompts[0]!.user) as Array<{ text: string }>;
    const characters = transcript.reduce((total, message) => total + message.text.length, 0);

    expect(transcript.length).toBeLessThan(MAXIMUM_DESCRIPTION_WINDOW_MESSAGES);
    expect(characters).toBeLessThanOrEqual(MAXIMUM_DESCRIPTION_WINDOW_CHARACTERS + transcript.length);
    expect(prompts[0]!.user).toContain("older messages in this window were omitted");
    // The newest message survives; the budget is spent from the oldest end.
    expect(refreshRow(objectStore)).toMatchObject({
      evaluated_through_sequence: MAXIMUM_DESCRIPTION_WINDOW_MESSAGES,
    });
  });

  it("leaves an automation's work stream to its automation", async () => {
    const { objectStore, env, prompts } = fixture({ originType: "automation" });
    addQualifyingConversation(objectStore);

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW }))
      .toEqual({ status: "skipped", reason: "automation_origin" });
    expect(prompts).toHaveLength(0);
  });

  it("leaves an archived work stream alone", async () => {
    const { objectStore, env, prompts } = fixture({ archived: true });
    addQualifyingConversation(objectStore);

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW }))
      .toEqual({ status: "skipped", reason: "archived" });
    expect(prompts).toHaveLength(0);
  });

  it("spends the window rather than retrying a model that failed", async () => {
    const { objectStore, env } = fixture();
    addQualifyingConversation(objectStore);
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ error: { message: "model unavailable" } }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    ));

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW }))
      .toEqual({ status: "failed", code: "model_unavailable" });
    expect(refreshRow(objectStore)).toMatchObject({
      decision: "failed",
      rejection_code: "model_unavailable",
      consecutive_keeps: 0,
    });
    expect(await refreshWorkstreamDescription(env, {
      ...input,
      now: new Date(NOW.getTime() + 60 * 1_000),
    })).toEqual({ status: "skipped", reason: "resting" });
  });
});

describe("what it takes to spend a model call", () => {
  const input = { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID };

  it("will not look at a work stream that has not rested, however much was said", async () => {
    const { objectStore, env, prompts } = fixture();
    addQualifyingConversation(objectStore);
    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW })).toEqual({ status: "kept" });

    const soon = new Date(NOW.getTime() + 60 * 1_000);
    addQualifyingConversation(objectStore, {
      startSequence: DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES + 1,
      createdAt: soon.toISOString(),
    });

    expect(await refreshWorkstreamDescription(env, { ...input, now: soon }))
      .toEqual({ status: "skipped", reason: "resting" });
    expect(prompts).toHaveLength(1);
  });

  it("will not look at a rested work stream that has not changed", async () => {
    const { objectStore, env, prompts } = fixture();
    addQualifyingConversation(objectStore);
    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW })).toEqual({ status: "kept" });

    expect(await refreshWorkstreamDescription(env, {
      ...input,
      now: new Date(NOW.getTime() + 20 * 60 * 60 * 1_000),
    })).toEqual({ status: "skipped", reason: "insufficient_new_conversation" });
    expect(prompts).toHaveLength(1);
  });

  it("looks once the work stream has both rested and changed", async () => {
    const { objectStore, env, prompts } = fixture();
    addQualifyingConversation(objectStore);
    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW })).toEqual({ status: "kept" });

    const later = new Date(NOW.getTime() + 20 * 60 * 60 * 1_000);
    addQualifyingConversation(objectStore, {
      startSequence: DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES + 1,
      createdAt: later.toISOString(),
    });

    expect(await refreshWorkstreamDescription(env, { ...input, now: later })).toEqual({ status: "kept" });
    expect(prompts).toHaveLength(2);
  });

  it("counts a Slack participant as a person, and names them to the model", async () => {
    const { objectStore, env, prompts } = fixture();
    addMessages(objectStore, DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES, { authorType: "external" });

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW })).toEqual({ status: "kept" });
    const transcript = transcriptOf(prompts[0]!.user) as Array<{ authorType: string; authorName: string }>;
    expect(transcript[0]).toMatchObject({ authorType: "external", authorName: "Rowan (Slack)" });
  });

  it("does not count an agent's own turns as the work stream changing", async () => {
    const { objectStore, env, prompts } = fixture();
    addMessages(objectStore, 1);
    addMessages(objectStore, 40, { startSequence: 2, authorType: "agent" });
    addMessages(objectStore, 10, { startSequence: 42, authorType: "system" });

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW }))
      .toEqual({ status: "skipped", reason: "insufficient_new_conversation" });
    expect(prompts).toHaveLength(0);
  });

  it("does not count a row of acknowledgements as a conversation", async () => {
    const { objectStore, env, prompts } = fixture();
    addMessages(objectStore, DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES * 2, { text: "ack" });

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW }))
      .toEqual({ status: "skipped", reason: "insufficient_new_conversation" });
    expect(prompts).toHaveLength(0);
  });

  it("does not pay a model to confirm a description the conversation keeps restating", async () => {
    const { objectStore, env, prompts } = fixture();
    addMessages(objectStore, DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES * 3, { text: ON_TOPIC_MESSAGE });

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW }))
      .toEqual({ status: "skipped", reason: "nothing_new_discussed" });
    expect(prompts).toHaveLength(0);
  });

  it("rests longer after each consecutive confirmation, and returns to the floor on a rewrite", () => {
    const hours = (keeps: number) =>
      (restUntil(NOW, keeps) - NOW.getTime()) / (60 * 60 * 1_000);

    expect(hours(0)).toBe(6);
    expect(hours(1)).toBe(12);
    expect(hours(2)).toBe(24);
    expect(hours(3)).toBe(48);
    // Capped, so a long-settled description is still re-read every two days.
    expect(hours(9)).toBe(48);
  });

  it("backs off across repeated confirmations and resets when the description is rewritten", async () => {
    let proposal: Proposal = {
      decision: "keep",
      description: null,
      confidence: 0.9,
      reasoning: "Still the same work.",
    };
    const { objectStore, env } = fixture({ proposal: () => proposal });

    let sequence = 1;
    let now = NOW;
    // Each confirmation walks the ratchet 1, 2, 3, extending the rest toward
    // the 48-hour cap. Object schema v6 rebuilt the claim trigger so a claim
    // that names no keeps value preserves the standing count instead of
    // zeroing it — the same semantics the D1 claim update always had.
    for (const expectedKeeps of [1, 2, 3]) {
      addQualifyingConversation(objectStore, {
        startSequence: sequence,
        createdAt: now.toISOString(),
      });
      sequence += DESCRIPTION_REFRESH_MINIMUM_NEW_HUMAN_MESSAGES;
      expect(await refreshWorkstreamDescription(env, { ...input, now })).toEqual({ status: "kept" });
      expect(refreshRow(objectStore)).toMatchObject({ consecutive_keeps: expectedKeeps });
      // Two days clears every rest the backoff can produce.
      now = new Date(now.getTime() + 49 * 60 * 60 * 1_000);
    }

    proposal = {
      decision: "rewrite",
      description: "Track the 3-D Secure migration for EU card issuers.",
      confidence: 0.95,
      reasoning: "The work moved.",
    };
    addQualifyingConversation(objectStore, { startSequence: sequence, createdAt: now.toISOString() });
    await refreshWorkstreamDescription(env, { ...input, now });
    expect(refreshRow(objectStore)).toMatchObject({ decision: "rewritten", consecutive_keeps: 0 });
    expect(refreshRow(objectStore)!.rest_until).toBe(restUntil(now, 0));
  });
});

describe("measuring what is new in a conversation", () => {
  const description = "Resolve the EU checkout authorization failures Morgan reported.";
  const title = "Checkout";

  it("counts a subject the description does not name", () => {
    expect(countNovelSubjectTerms({
      newText: [
        "The 3-D Secure migration needs a rollout plan.",
        "Sandbox coverage for the migration is short, and the rollout plan needs issuer sign-off.",
        "Each issuer wants its own sandbox window before we schedule the migration rollout.",
      ].join("\n"),
      description,
      title,
    })).toBeGreaterThanOrEqual(DESCRIPTION_REFRESH_MINIMUM_NOVEL_TERMS);
  });

  it("counts nothing when the conversation restates the description", () => {
    expect(countNovelSubjectTerms({
      newText: "The EU checkout authorization failures Morgan reported are still failures in EU checkout.",
      description,
      title,
    })).toBe(0);
  });

  it("ignores a subject mentioned only once, and ordinary sentence words", () => {
    expect(countNovelSubjectTerms({
      newText: "We should probably think about whether the invoicing thing matters here.",
      description,
      title,
    })).toBe(0);
  });
});
