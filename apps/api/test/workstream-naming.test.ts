import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  nameWorkstream,
  normalizeGeneratedTitle,
  provisionalWorkstreamTitle,
  refreshWorkstreamName,
} from "../src/services/workstream-naming-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";

const workspaceId = "workspace-naming";
const userId = "user-owner";
const workstreamId = "00000000-0000-7000-8000-0000000000a1";
const at = "2026-08-11T09:00:00.000Z";
const provisionalTitle = "Create an email **draft** to Danny from Mucker that shares the avalon download link";
const objective = `${provisionalTitle} and asks him to add Alex and Katherine to the recurring Tuesday call.`;

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
});

describe("work-stream naming", () => {
  it("replaces the provisional title and tells the open work stream about it", async () => {
    const database = seededDatabase();
    const requests: Array<Record<string, unknown>> = [];
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Avalon download link email to Danny");
    const env = environment(database, published);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
      userId,
    });

    expect(workstreamRow(database)).toMatchObject({
      title: "Avalon download link email to Danny",
      title_status: "automatic",
    });
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: "Avalon download link email to Danny",
      titleStatus: "automatic",
    }]);
  });

  it("asks the naming agent's own model for a name, with reasoning switched off", async () => {
    const database = seededDatabase();
    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Recurring Tuesday call invitations");
    const env = environment(database, []);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({
      model: "google/gemini-2.5-flash-lite",
      // Not `{ effort: "low" }`: on a model that does no thinking by default,
      // asking for the lowest effort turns thinking on.
      reasoning: { enabled: false },
      response_format: { json_schema: { name: "workstream_name", strict: true } },
    });
    // The request is what is being named, and it is data: it reaches the model
    // as user-role content and never as part of the naming policy.
    const messages = request?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.content).not.toContain("Danny");
    expect(messages.at(-1)).toMatchObject({ role: "user" });
    expect(messages.at(-1)?.content).toContain("Danny");
  });

  it("keeps a title a person set while the naming call was in flight", async () => {
    const database = seededDatabase();
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter([], "Avalon download link email to Danny", () => {
      // The rename lands between the model answering and the title being
      // written — exactly the window the conditional update exists to lose.
      // Naming a work stream settles it, which is what makes it untouchable.
      database.prepare("UPDATE workstreams SET title = ?, title_status = 'settled' WHERE id = ?")
        .run("Mucker intro thread", workstreamId);
    });
    const env = environment(database, published);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(title(database)).toBe("Mucker intro thread");
    expect(published).toEqual([]);
  });

  it("leaves the provisional title standing when the model cannot be reached", async () => {
    const database = seededDatabase();
    const published: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection reset");
    }));
    const env = environment(database, published);

    await expect(nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    })).resolves.toBeUndefined();

    // The provisional title stands, but the work stream stops waiting: a
    // skeleton that never resolves is worse than a title taken from the
    // request, and the same event carries that to whoever is looking at it.
    expect(workstreamRow(database)).toMatchObject({
      title: provisionalTitle,
      title_status: "automatic",
    });
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: provisionalTitle,
      titleStatus: "automatic",
    }]);
  });

  it("never names a work stream without an OpenRouter key", async () => {
    const database = seededDatabase();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = createTestEnv({ ...environment(database, []), OPENROUTER_API_KEY: "" });

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(workstreamRow(database)).toMatchObject({
      title: provisionalTitle,
      title_status: "automatic",
    });
  });

  it("names the work stream again from the conversation once it has five messages", async () => {
    const database = seededDatabase();
    database.prepare("UPDATE workstreams SET title = ?, title_status = 'automatic' WHERE id = ?")
      .run("Draft email to Danny", workstreamId);
    seedMessages(database, 5);
    const requests: Array<Record<string, unknown>> = [];
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Mucker download link for founder@example.com");
    const env = environment(database, published);

    await refreshWorkstreamName(env, { workspaceId, workstreamId, userId });

    // The detail that names this work stream — the address the first attempt
    // bounced off — only exists in the replies, which is the whole reason for
    // a second pass.
    // The client appends the expected JSON Schema to the last message, so the
    // rendered payload is the part before it.
    const [rendered] = (requests[0]?.messages as Array<{ content: string }>)[1]!.content.split("\n\n");
    const payload = JSON.parse(String(rendered)) as {
      conversation: Array<{ author: string; text: string }>;
    };
    expect(payload.conversation).toHaveLength(5);
    expect(payload.conversation[1]).toMatchObject({ author: "avalon" });
    expect(workstreamRow(database)).toMatchObject({
      title: "Mucker download link for founder@example.com",
      title_status: "settled",
    });
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: "Mucker download link for founder@example.com",
      titleStatus: "settled",
    }]);
  });

  it("repairs a work stream whose first naming pass never finished", async () => {
    // The isolate went away between creating the work stream and settling its
    // title, so the row is still `naming` — and the client is still showing a
    // skeleton — long after anything was going to name it.
    const database = seededDatabase();
    seedMessages(database, 6);
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter([], "Mucker download link for founder@example.com");
    const env = environment(database, published);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    expect(workstreamRow(database)).toMatchObject({
      title: "Mucker download link for founder@example.com",
      title_status: "settled",
    });
    expect(published).toHaveLength(1);
  });

  it("keeps its one retry when the model cannot be reached at the five-message mark", async () => {
    const database = seededDatabase();
    database.prepare("UPDATE workstreams SET title = ?, title_status = 'automatic' WHERE id = ?")
      .run("Invoice export totals", workstreamId);
    seedMessages(database, 5);
    const published: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection reset"); }));
    const env = environment(database, published);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    // Nothing is waiting on this pass — `automatic` and `settled` render the
    // same — so a model that happened to be unreachable must not spend the one
    // second look this work stream gets, or publish a rename of nothing.
    expect(workstreamRow(database)).toMatchObject({
      title: "Invoice export totals",
      title_status: "automatic",
    });
    expect(published).toEqual([]);

    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Invoice INV-2291 VAT totals");
    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    expect(workstreamRow(database)).toMatchObject({
      title: "Invoice INV-2291 VAT totals",
      title_status: "settled",
    });
  });

  it("still resolves a stalled first pass when the model cannot be reached", async () => {
    const database = seededDatabase();
    seedMessages(database, 5);
    const published: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection reset"); }));
    const env = environment(database, published);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    // The exception to the rule above: this row is a first pass that never
    // finished, and something on screen is waiting for it to end.
    expect(workstreamRow(database)).toMatchObject({
      title: provisionalTitle,
      title_status: "automatic",
    });
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: provisionalTitle,
      titleStatus: "automatic",
    }]);
  });

  it("counts what the work stream said, not what the harness wrote down", async () => {
    const database = seededDatabase();
    database.prepare("UPDATE workstreams SET title_status = 'automatic' WHERE id = ?").run(workstreamId);
    // An opening request, one reply, and three tool calls. A run ends where
    // tool rows accumulate, and that is one of the two places the second pass
    // is called from — counting them would name this from what the first pass
    // already saw.
    seedMessages(database, 2);
    for (const [index, kind] of (["tool", "tool", "tool"] as const).entries()) {
      database.prepare(
        `INSERT INTO messages
         (id, client_message_id, workspace_id, workstream_id, author_type, message_type,
          text_content, sequence_number, created_at)
         VALUES (?, ?, ?, ?, 'agent', ?, '', ?, ?)`,
      ).run(
        `00000000-0000-7000-8000-00000000d0${String(index).padStart(2, "0")}`,
        `tool-${index}`,
        workspaceId,
        workstreamId,
        kind,
        20 + index,
        at,
      );
    }
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = environment(database, []);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    expect(fetcher).not.toHaveBeenCalled();
    expect(workstreamRow(database)).toMatchObject({ title_status: "automatic" });
  });

  it("names a work stream again only once, however often the transcript grows", async () => {
    const database = seededDatabase();
    database.prepare("UPDATE workstreams SET title_status = 'automatic' WHERE id = ?").run(workstreamId);
    seedMessages(database, 9);
    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Mucker download link for founder@example.com");
    const env = environment(database, []);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });
    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    expect(requests).toHaveLength(1);
  });

  it("leaves a short work stream and a title a person chose alone", async () => {
    const database = seededDatabase();
    database.prepare("UPDATE workstreams SET title_status = 'automatic' WHERE id = ?").run(workstreamId);
    seedMessages(database, 4);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = environment(database, []);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });
    expect(fetcher).not.toHaveBeenCalled();

    seedMessages(database, 6);
    database.prepare("UPDATE workstreams SET title = ?, title_status = 'settled' WHERE id = ?")
      .run("Mucker intro thread", workstreamId);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    expect(fetcher).not.toHaveBeenCalled();
    expect(title(database)).toBe("Mucker intro thread");
  });

  it("never fails the creation or the run it was called from", async () => {
    const database = seededDatabase();
    stubOpenRouter([], "Avalon download link email to Danny");
    // Both passes write; a database that refuses the write is the failure the
    // callers cannot absorb — one awaits naming having already created the work
    // stream and launched its run, and the other is a durable workflow step
    // that would retry the model call and then fail a committed run.
    const failing = createTestEnv({
      ...environment(database, []),
      DB: {
        prepare: () => { throw new Error("D1_ERROR: network"); },
      },
    });

    await expect(nameWorkstream(failing, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    })).resolves.toBeUndefined();
    await expect(refreshWorkstreamName(failing, { workspaceId, workstreamId }))
      .resolves.toBeUndefined();
  });

  it("reads no more of a transcript than it takes to know the work stream is due", async () => {
    const database = seededDatabase();
    database.prepare("UPDATE workstreams SET title_status = 'settled' WHERE id = ?").run(workstreamId);
    seedMessages(database, 40);
    const counted: string[] = [];
    const env = environment(database, []);
    const settled = createTestEnv({
      ...env,
      DB: {
        ...env.DB,
        prepare: (sql: string) => {
          counted.push(sql);
          return env.DB.prepare(sql);
        },
      },
    });

    await refreshWorkstreamName(settled, { workspaceId, workstreamId });

    // A settled work stream is the overwhelmingly common case, and this runs
    // after every message and every run: the status has to be a `WHERE` clause
    // rather than a check in JS after a transcript-wide count.
    expect(counted).toHaveLength(1);
    expect(counted[0]).toContain("title_status IN ('naming', 'automatic')");
    expect(counted[0]).toContain("LIMIT ?");
  });

  it("writes a name a person would read rather than whatever the model returned", () => {
    expect(normalizeGeneratedTitle('"Avalon download link email to Danny."'))
      .toBe("Avalon download link email to Danny");
    expect(normalizeGeneratedTitle("## Mucker\n  intro  thread")).toBe("Mucker intro thread");
    expect(normalizeGeneratedTitle("   ")).toBeNull();
    // A name that starts mid-sentence is capitalized; one that starts on
    // something that spells itself is not.
    expect(normalizeGeneratedTitle("invoice INV-2291 VAT totals")).toBe("Invoice INV-2291 VAT totals");
    expect(normalizeGeneratedTitle("iPhone build failures")).toBe("iPhone build failures");
    expect(normalizeGeneratedTitle("founder@example.com bounce")).toBe("founder@example.com bounce");
    expect(normalizeGeneratedTitle("n".repeat(200))).toHaveLength(80);
    // A cut that lands inside a surrogate pair would leave a lone half that
    // renders as a replacement character in the sidebar.
    const emojiName = `${"n".repeat(79)}\u{1F600}`;
    expect(normalizeGeneratedTitle(emojiName)).toBe("n".repeat(79));
  });

  it("derives the provisional title from the first line that has anything in it", () => {
    expect(provisionalWorkstreamTitle("\n\n  Draft the release note  \nand send it", "New work stream"))
      .toBe("Draft the release note");
    expect(provisionalWorkstreamTitle("   \n \n", "New work stream")).toBe("New work stream");
    expect(provisionalWorkstreamTitle("", "Slack task")).toBe("Slack task");
    expect(provisionalWorkstreamTitle("x".repeat(400), "New work stream")).toHaveLength(180);
  });
});

/** Replaces the transcript with `count` alternating messages. */
function seedMessages(database: DatabaseSync, count: number): void {
  database.prepare("DELETE FROM messages WHERE workstream_id = ?").run(workstreamId);
  const texts = [
    objective,
    "Danny bounced — the address on file is his old Mucker one.",
    "Use founder@example.com.",
    "Sent. Do you want the Tuesday call mentioned?",
    "Yes, and include the download link for Mucker.",
  ];
  for (let index = 0; index < count; index += 1) {
    database.prepare(
      `INSERT INTO messages
       (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
        message_type, text_content, sequence_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, ?)`,
    ).run(
      `00000000-0000-7000-8000-00000000c0${String(index).padStart(2, "0")}`,
      `seed-${index}`,
      workspaceId,
      workstreamId,
      index % 2 === 0 ? "human" : "agent",
      index % 2 === 0 ? userId : null,
      texts[index % texts.length] ?? `Message ${index}`,
      index + 1,
      at,
    );
  }
}

function workstreamRow(database: DatabaseSync): { title: string; title_status: string } {
  return database.prepare(
    "SELECT title, title_status FROM workstreams WHERE id = ?",
  ).get(workstreamId) as { title: string; title_status: string };
}

function title(database: DatabaseSync): string {
  return workstreamRow(database).title;
}

/** Answers one OpenRouter structured request, recording what was asked. */
function stubOpenRouter(
  requests: Array<Record<string, unknown>>,
  generatedTitle: string,
  beforeResponding?: () => void,
): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    beforeResponding?.();
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: generatedTitle }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

function environment(database: DatabaseSync, published: Array<Record<string, unknown>>): Env {
  const rooms = {
    jurisdiction: () => rooms,
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => ({
      publishEvent: async (input: { event: Record<string, unknown> }) => {
        const event = input.event;
        published.push(event);
        return { status: 202, bodyJson: "null" };
      },
    }),
  };
  return createTestEnv({
    DB: sqliteD1(database),
    APP_ENV: "test",
    AVALON_REGION: "global",
    LOG_LEVEL: "error",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_FALLBACK_MODELS: "",
    PUBLIC_API_BASE_URL: "https://api.test.with-avalon.com",
    SUBSTREAM_AGENTS: rooms,
  });
}

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${userId}', 'google-owner', 'owner@example.com', 'Owner', '${at}', '${at}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Avalon', 'avalon', 'global', '${userId}', '${at}', '${at}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${workspaceId}', '${userId}', 'owner', 'active', '${at}');
  `);
  database.prepare(
    `INSERT INTO workstreams
     (id, workspace_id, title, title_status, objective, email_address, email_route_status, origin_type,
      created_by_user_id, harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
     VALUES (?, ?, ?, 'naming', ?, ?, 'active', 'ad_hoc', ?, 'running', 2, ?, ?, ?)`,
  ).run(
    workstreamId,
    workspaceId,
    provisionalTitle,
    objective,
    "calm-bright-gentle-otter@automation.with-avalon.com",
    userId,
    at,
    at,
    at,
  );
  return database;
}
