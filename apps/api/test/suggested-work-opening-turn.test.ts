import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import type * as NamingService from "../src/services/workstream-naming-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/services/integrations", () => ({
  classifyWorkstreamMessage: vi.fn(async () => ({
    classification: "human_only",
    confidence: 1,
    rationaleCode: "test",
  })),
  publishWorkstreamEvent: vi.fn(async () => undefined),
  startWorkstreamWorkflow: vi.fn(async () => "unused"),
}));

vi.mock("../src/services/workstream-naming-service", async (importOriginal) => ({
  ...await importOriginal<typeof NamingService>(),
  nameWorkstream: vi.fn(async () => undefined),
}));

import { WorkstreamService } from "../src/services/workstream-service";
import { publishWorkstreamEvent, startWorkstreamWorkflow } from "../src/services/integrations";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const selectorId = "00000000-0000-7000-8000-000000000002";
const opportunityId = "00000000-0000-7000-8000-00000000000a";
const at = "2026-08-12T09:00:00.000Z";
const displayPrompt = "Chase the failed release and prepare the fix";
const executionPrompt = "Trace the failed release, identify the owner, and prepare the fix.";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(startWorkstreamWorkflow).mockReset();
  vi.mocked(startWorkstreamWorkflow).mockImplementation(async () => "unused");
});

/**
 * Who the opening brief of a started suggestion belongs to.
 *
 * Selecting a suggestion is the request, so the turn carrying it is the
 * selecting member's — not the agent's, which is what it used to be. The
 * distinction is not cosmetic: several things downstream ask a work stream for
 * its human turns, and under agent authorship these work streams had none.
 */
describe("starting a suggestion", () => {
  it("writes the opening brief as the selecting member's own turn", async () => {
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    const created = await service.createFromOpportunity(opportunityRequest());

    expect(messageRow(database, created.messageId)).toMatchObject({
      author_type: "human",
      author_user_id: selectorId,
      text_content: executionPrompt,
    });
  });

  it("keeps the label that says Avalon wrote the words", async () => {
    // The turn is theirs and the text is not. Losing this leaves a member
    // reading a brief they never typed with nothing to explain it, and leaves
    // the model projection — which matches on this, not on the author — quoting
    // connector evidence as if it were instruction.
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    const created = await service.createFromOpportunity(opportunityRequest());

    const row = messageRow(database, created.messageId);
    expect(JSON.parse(String(row.structured_content_json))).toEqual({
      kind: "suggested_work_expansion",
      label: "Expanded by Avalon from suggested work",
      opportunityId,
      opportunityVersion: 3,
    });
  });

  it("publishes the opening turn attributed to the member, not to Avalon", async () => {
    // The socket event is built from the stored row through the message mapper,
    // which resolves a human author against the users table. An author id that
    // did not join would surface here as a message with a stranger's identity.
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    await service.createFromOpportunity(opportunityRequest());

    const published = vi.mocked(publishWorkstreamEvent).mock.calls
      .map((call) => call[3] as { type: string; message?: { author?: { type: string; user?: { id: string } } } })
      .find((event) => event.type === "message_created");
    expect(published?.message?.author).toMatchObject({
      type: "human",
      user: { id: selectorId },
    });
  });

  it("gives a retry the brief to replay against", async () => {
    // `retry` triggers on the latest human message. With the brief authored by
    // the agent there was none, so a retry started a run with a null trigger —
    // and the projection admits the brief only as the trigger, leaving the
    // replayed run with an empty transcript.
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);
    const created = await service.createFromOpportunity(opportunityRequest());
    failLatestRun(database, created.workstream.id);

    await service.retry(created.workstream.id);

    const workflowInputs = vi.mocked(startWorkstreamWorkflow).mock.calls
      .map((call) => call[1] as { triggerMessageId: string | null });
    expect(workflowInputs.at(-1)?.triggerMessageId).toBe(created.messageId);
  });
});

function opportunityRequest() {
  return {
    opportunityId,
    version: 3,
    displayPrompt,
    executionPrompt,
    displayPromptHash: "display-hash",
    executionPromptHash: "execution-hash",
    idempotencyKey: "start-the-suggestion",
  };
}

function auth(): AuthContext {
  return {
    sessionId: "session-1",
    userId: selectorId,
    workspaceId,
    region: "global",
    role: "owner",
  };
}

function environment(database: DatabaseSync): Env {
  return {
    DB: sqliteD1(database),
    APP_ENV: "test",
    AVALON_REGION: "global",
    SESSION_SIGNING_KEY: "session-signing-key-for-suggested-work-opening-turn",
    OPENROUTER_PRIMARY_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
  } as unknown as Env;
}

function messageRow(database: DatabaseSync, id: string): Record<string, unknown> {
  return database.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown>;
}

/** Puts the work stream into the one state `retry` accepts. */
function failLatestRun(database: DatabaseSync, workstreamId: string): void {
  database.prepare(
    `UPDATE harness_runs SET status = 'failed', terminalized_at = ? WHERE workstream_id = ?`,
  ).run(at, workstreamId);
  database.prepare("UPDATE workstreams SET harness_status = 'failed' WHERE id = ?").run(workstreamId);
}

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
     VALUES (?, 'google-selector', 'selector@example.com', 'Selecting Person', NULL, ?, ?)`,
  ).run(selectorId, at, at);
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Avalon Studio', 'avalon-studio', 'global', ?, ?, ?)`,
  ).run(workspaceId, selectorId, at, at);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?)`,
  ).run(workspaceId, selectorId, at);
  // `workstreams.created_from_opportunity_id` references this row, so a work
  // stream cannot be created from a suggestion that does not exist.
  database.prepare(
    `INSERT INTO work_opportunities
     (id, workspace_id, audience_scope, audience_user_id, display_prompt, execution_prompt,
      admission_reasoning, source_fingerprint, version, display_prompt_hash, execution_prompt_hash,
      status, expires_at, created_at, updated_at)
     VALUES (?, ?, 'personal', ?, ?, ?, 'A release failed and nothing else claimed it', 'fingerprint-1',
      3, 'display-hash', 'execution-hash', 'starting', '2026-08-19T09:00:00.000Z', ?, ?)`,
  ).run(opportunityId, workspaceId, selectorId, displayPrompt, executionPrompt, at, at);
  return database;
}
