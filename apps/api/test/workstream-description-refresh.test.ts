import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES,
  DESCRIPTION_WINDOW_MINIMUM_MESSAGES,
  MAXIMUM_DESCRIPTION_CHARACTERS,
  MAXIMUM_DESCRIPTION_WINDOW_MESSAGES,
  isTooGenericDescription,
  judgeDescriptionProposal,
  refreshWorkstreamDescription,
} from "../src/services/workstream-description-service";
import { WorkstreamService } from "../src/services/workstream-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const USER_ID = "00000000-0000-4000-8000-000000000000";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-08-11T12:00:00.000Z");

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
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
  const database = migratedSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'google-description', 'description@example.com', 'Morgan', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Descriptions', 'descriptions', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, description_source, origin_type, created_by_user_id,
       harness_status, next_sequence_number, last_activity_at, created_at, updated_at, archived_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Checkout',
            '${options.objective ?? "Look into the payment error Morgan reported on Monday."}',
            '${options.descriptionSource ?? "derived"}', '${options.originType ?? "ad_hoc"}', '${USER_ID}',
            'idle', 1, '2026-08-11', '2026-01-01', '2026-01-01',
            ${options.archived ? "'2026-08-01'" : "NULL"});
  `);

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

  const env = {
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "error",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_STRUCTURED_MODEL: "test/structured",
    OPENROUTER_FALLBACK_MODELS: "",
    PUBLIC_API_BASE_URL: "https://api.example.com",
  } as unknown as Env;
  return { database, env, prompts };
}

function addMessages(
  database: DatabaseSync,
  count: number,
  options: { createdAt?: string; startSequence?: number; text?: string } = {},
): void {
  const startSequence = options.startSequence ?? 1;
  for (let index = 0; index < count; index += 1) {
    const sequence = startSequence + index;
    database.prepare(
      `INSERT INTO messages
         (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
          message_type, text_content, sequence_number, created_at)
       VALUES (?, ?, ?, ?, 'human', ?, 'text', ?, ?, ?)`,
    ).run(
      `message-${sequence}`,
      `client-${sequence}`,
      WORKSPACE_ID,
      WORKSTREAM_ID,
      USER_ID,
      options.text ?? `Message ${sequence}`,
      sequence,
      options.createdAt ?? NOW.toISOString(),
    );
  }
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

function objective(database: DatabaseSync): string {
  return (database.prepare(
    "SELECT objective FROM workstreams WHERE id = ?",
  ).get(WORKSTREAM_ID) as { objective: string }).objective;
}

function refreshRow(database: DatabaseSync): Record<string, unknown> | undefined {
  return database.prepare(
    "SELECT * FROM workstream_description_refreshes WHERE workstream_id = ?",
  ).get(WORKSTREAM_ID) as Record<string, unknown> | undefined;
}

describe("who wrote the description", () => {
  function service(env: Env): WorkstreamService {
    return new WorkstreamService(env, {
      sessionId: "session-1",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "owner",
    });
  }

  it("marks a description a person edited as authored", async () => {
    const { database, env } = fixture();

    const updated = await service(env).update(WORKSTREAM_ID, {
      objective: "Run the EU payments incident review.",
    });

    expect(updated.objective).toBe("Run the EU payments incident review.");
    expect(database.prepare("SELECT description_source FROM workstreams WHERE id = ?").get(WORKSTREAM_ID))
      .toMatchObject({ description_source: "authored" });
  });

  it("leaves the source alone when an edit does not touch the description", async () => {
    const { database, env } = fixture({ descriptionSource: "authored" });

    const updated = await service(env).update(WORKSTREAM_ID, { title: "EU payments" });

    expect(updated.title).toBe("EU payments");
    expect(objective(database)).toBe("Look into the payment error Morgan reported on Monday.");
    expect(database.prepare("SELECT description_source FROM workstreams WHERE id = ?").get(WORKSTREAM_ID))
      .toMatchObject({ description_source: "authored" });
  });
});

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
  it("leaves a barely-used work stream alone", async () => {
    const { database, env, prompts } = fixture();
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES - 1);

    expect(await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: NOW,
    })).toEqual({ status: "skipped", reason: "insufficient_new_messages" });
    expect(prompts).toHaveLength(0);
    expect(refreshRow(database)).toBeUndefined();
  });

  it("records a keep without touching the description", async () => {
    const { database, env } = fixture();
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES);

    expect(await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: NOW,
    })).toEqual({ status: "kept" });
    expect(objective(database)).toBe("Look into the payment error Morgan reported on Monday.");
    expect(refreshRow(database)).toMatchObject({
      decision: "kept",
      rejection_code: null,
      evaluated_through_sequence: DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES,
    });
  });

  it("rewrites a description the work stream has outgrown and marks it derived", async () => {
    const { database, env } = fixture({
      descriptionSource: "authored",
      proposal: {
        decision: "rewrite",
        description: "Track the 3-D Secure migration for EU card issuers.",
        confidence: 0.92,
        reasoning: "The work stream now runs the migration, not the original bug.",
      },
    });
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES);

    expect(await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: NOW,
    })).toEqual({
      status: "rewritten",
      description: "Track the 3-D Secure migration for EU card issuers.",
    });
    expect(objective(database)).toBe("Track the 3-D Secure migration for EU card issuers.");
    expect(database.prepare(
      "SELECT description_source FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toMatchObject({ description_source: "derived" });
    expect(refreshRow(database)).toMatchObject({
      decision: "rewritten",
      previous_description: "Look into the payment error Morgan reported on Monday.",
      description: "Track the 3-D Secure migration for EU card issuers.",
    });
  });

  it("tells the model how the description in force was written", async () => {
    const { database, env, prompts } = fixture({ descriptionSource: "authored" });
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES);

    await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: NOW,
    });
    expect(prompts[0]!.user).toContain('"descriptionSource":"authored"');
    expect(prompts[0]!.user).toContain("UNTRUSTED RECENT TRANSCRIPT");
  });

  it("refuses to overwrite a description a person changed mid-evaluation", async () => {
    const { database, env } = fixture({
      proposal: () => {
        database.prepare("UPDATE workstreams SET objective = ? WHERE id = ?")
          .run("Run the EU payments incident review.", WORKSTREAM_ID);
        return {
          decision: "rewrite",
          description: "Track the 3-D Secure migration for EU card issuers.",
          confidence: 0.95,
          reasoning: "The work moved.",
        };
      },
    });
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES);

    expect(await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: NOW,
    })).toEqual({ status: "rejected", code: "description_changed_during_evaluation" });
    expect(objective(database)).toBe("Run the EU payments incident review.");
    expect(refreshRow(database)).toMatchObject({
      decision: "rejected",
      rejection_code: "description_changed_during_evaluation",
    });
  });

  it("rests between evaluations and resumes once enough is new", async () => {
    const { database, env, prompts } = fixture();
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES);
    const input = { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID };

    expect(await refreshWorkstreamDescription(env, { ...input, now: NOW })).toEqual({ status: "kept" });
    expect(await refreshWorkstreamDescription(env, {
      ...input,
      now: new Date(NOW.getTime() + 60 * 60 * 1_000),
    })).toEqual({ status: "skipped", reason: "not_due" });

    const later = new Date(NOW.getTime() + 7 * 60 * 60 * 1_000);
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES, {
      startSequence: DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES + 1,
      createdAt: later.toISOString(),
    });
    expect(await refreshWorkstreamDescription(env, { ...input, now: later })).toEqual({ status: "kept" });
    expect(prompts).toHaveLength(2);
  });

  it("waits for new messages even after the interval has passed", async () => {
    const { database, env, prompts } = fixture();
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES);
    const input = { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID };

    await refreshWorkstreamDescription(env, { ...input, now: NOW });
    expect(await refreshWorkstreamDescription(env, {
      ...input,
      now: new Date(NOW.getTime() + 30 * 60 * 60 * 1_000),
    })).toEqual({ status: "skipped", reason: "insufficient_new_messages" });
    expect(prompts).toHaveLength(1);
  });

  it("reads the last 200 messages when the last 72 hours holds fewer", async () => {
    const { database, env, prompts } = fixture();
    const old = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    addMessages(database, 250, { createdAt: old, text: "Historic message" });
    addMessages(database, 20, { startSequence: 251, text: "Recent message" });

    await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: NOW,
    });
    const transcript = transcriptOf(prompts[0]!.user);
    expect(transcript).toHaveLength(DESCRIPTION_WINDOW_MINIMUM_MESSAGES);
    expect(prompts[0]!.user).toContain(`${DESCRIPTION_WINDOW_MINIMUM_MESSAGES} messages, oldest first`);
    expect(prompts[0]!.user).not.toContain("older messages in this window were omitted");
  });

  it("reads every message of a busy 72 hours, up to the ceiling, and says when it capped", async () => {
    const { database, env, prompts } = fixture();
    addMessages(database, MAXIMUM_DESCRIPTION_WINDOW_MESSAGES + 40, { text: "Busy message" });

    await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: NOW,
    });
    const transcript = transcriptOf(prompts[0]!.user);
    expect(transcript).toHaveLength(MAXIMUM_DESCRIPTION_WINDOW_MESSAGES);
    expect(prompts[0]!.user).toContain("older messages in this window were omitted");
  });

  it("leaves an automation's work stream to its automation", async () => {
    const { database, env, prompts } = fixture({ originType: "automation" });
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES);

    expect(await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: NOW,
    })).toEqual({ status: "skipped", reason: "automation_origin" });
    expect(prompts).toHaveLength(0);
  });

  it("leaves an archived work stream alone", async () => {
    const { database, env, prompts } = fixture({ archived: true });
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES);

    expect(await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: NOW,
    })).toEqual({ status: "skipped", reason: "archived" });
    expect(prompts).toHaveLength(0);
  });

  it("spends the window rather than retrying a model that failed", async () => {
    const { database, env } = fixture();
    addMessages(database, DESCRIPTION_REFRESH_MINIMUM_NEW_MESSAGES);
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ error: { message: "model unavailable" } }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    ));

    expect(await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: NOW,
    })).toEqual({ status: "failed", code: "model_unavailable" });
    expect(refreshRow(database)).toMatchObject({
      decision: "failed",
      rejection_code: "model_unavailable",
    });
    expect(await refreshWorkstreamDescription(env, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      now: new Date(NOW.getTime() + 60 * 1_000),
    })).toEqual({ status: "skipped", reason: "not_due" });
  });
});
