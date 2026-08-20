import { asUserId, asWorkspaceId } from "@avalon/contracts";
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
import { createTestEnv } from "./helpers/cloudflare-test";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const selectorId = asUserId("00000000-0000-7000-8000-000000000002");
const opportunityId = "00000000-0000-7000-8000-00000000000a";
const at = "2026-08-12T09:00:00.000Z";
const displayPrompt = "Chase the failed release and prepare the fix";
const executionPrompt = "Trace the failed release, identify the owner, and prepare the fix.";
const databases: DatabaseSync[] = [];

// `clearAllMocks` and not `restoreAllMocks`: nothing here is a `vi.spyOn`, so
// restoring had nothing of its own to undo, and since Vitest 3 it does not touch
// a `vi.fn()` implementation either — it was a no-op in both directions. This
// comment previously claimed restoring wiped the module factory's
// implementations, which was true through Vitest 2 and is not true on the 4.x
// this repo runs. The explicit reset below is a separate matter: it clears a
// queued `mockImplementationOnce`, which clearing does not consume.
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
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

  it("gives a retry of the opening run the brief to replay against", async () => {
    // The projection admits the brief only as the run's trigger, so a retry that
    // resolves no trigger replays this work stream as an empty transcript. The
    // opening run records the brief as what it ran against, and the retry
    // inherits it.
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);
    const created = await service.createFromOpportunity(opportunityRequest());
    failLatestRun(database, created.workstream.id);

    await service.retry(created.workstream.id);

    expect(lastWorkflowInput()?.triggerMessageId).toBe(created.messageId);
  });

  it("does not fence a later trigger-less run's retry back onto the brief", async () => {
    // A scheduled wakeup carries no trigger, and neither does an activity run or
    // an automation run with no opening message. A digest is not in that set: it
    // appends a brief and launches against it. The transcript is fenced at the
    // trigger, so resolving one for a run that never had one would
    // discard everything that happened after the brief and re-execute the
    // original request against days of work it can no longer see.
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);
    const created = await service.createFromOpportunity(opportunityRequest());
    completeLatestRun(database, created.workstream.id);
    insertFailedTriggerlessRun(database, created.workstream.id);

    await service.retry(created.workstream.id);

    expect(lastWorkflowInput()?.triggerMessageId).toBeNull();
  });

  it("lets a retry see a message posted after the run it is retrying", async () => {
    // The trigger is also the transcript's upper bound, so keeping the failed
    // run's trigger without moving the bound would replay the request while
    // hiding the correction somebody posted because it failed. That message
    // starts no run of its own when the work stream has other participants and
    // it was not addressed to the agent, so nothing else brings it into view.
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);
    const created = await service.createFromOpportunity(opportunityRequest());
    failLatestRun(database, created.workstream.id);
    const correction = insertHumanMessage(database, created.workstream.id, "You used the wrong account");

    await service.retry(created.workstream.id);

    // Identity stays the brief — it is what admits the brief to the model at
    // all — while the window now reaches the correction.
    expect(lastWorkflowInput()?.triggerMessageId).toBe(created.messageId);
    expect(lastWorkflowInput()?.transcriptFenceMessageId).toBe(correction);
  });

  it("does not fence a retry behind a message that is already the trigger", async () => {
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);
    const created = await service.createFromOpportunity(opportunityRequest());
    failLatestRun(database, created.workstream.id);

    await service.retry(created.workstream.id);

    expect(lastWorkflowInput()?.transcriptFenceMessageId).toBeUndefined();
  });
});

function lastWorkflowInput(): {
  triggerMessageId: string | null;
  transcriptFenceMessageId?: string | null;
} | undefined {
  return vi.mocked(startWorkstreamWorkflow).mock.calls
    .map((call) => call[1] as { triggerMessageId: string | null; transcriptFenceMessageId?: string | null })
    .at(-1);
}

/** A later human turn, of the kind that starts no run of its own. */
function insertHumanMessage(database: DatabaseSync, workstreamId: string, text: string): string {
  const id = "00000000-0000-7000-8000-0000000000c1";
  const sequence = Number((database.prepare(
    "SELECT next_sequence_number AS next FROM workstreams WHERE id = ?",
  ).get(workstreamId) as { next: number }).next);
  database.prepare(
    `INSERT INTO messages
     (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
      message_type, text_content, sequence_number, created_at)
     VALUES (?, ?, ?, ?, 'human', ?, 'text', ?, ?, ?)`,
  ).run(id, `client-${id}`, workspaceId, workstreamId, selectorId, text, sequence, at);
  database.prepare("UPDATE workstreams SET next_sequence_number = ? WHERE id = ?")
    .run(sequence + 1, workstreamId);
  return id;
}

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
  return createTestEnv({
    DB: sqliteD1(database),
    APP_ENV: "test",
    AVALON_REGION: "global",
    SESSION_SIGNING_KEY: "session-signing-key-for-suggested-work-opening-turn",
    OPENROUTER_PRIMARY_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
  });
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

function completeLatestRun(database: DatabaseSync, workstreamId: string): void {
  database.prepare(
    `UPDATE harness_runs SET status = 'completed', terminalized_at = ? WHERE workstream_id = ?`,
  ).run(at, workstreamId);
}

/**
 * A later run of the kind that has no message behind it, already failed.
 *
 * `created_at` is after the opening run's, which is the order `retry` reads —
 * and it is derived from that run rather than written as a literal. The opening
 * run is created through the service, so it is stamped with the real clock; a
 * fixed timestamp here silently means "later" only until the clock passes it.
 * One did, at 2026-08-14T09:00Z, and this test then failed on every run
 * afterwards rather than intermittently, because `retry` picked the completed
 * opening run and reported it as not retryable.
 */
function insertFailedTriggerlessRun(database: DatabaseSync, workstreamId: string): void {
  const previous = database.prepare(
    "SELECT MAX(created_at) AS latest FROM harness_runs WHERE workstream_id = ?",
  ).get(workstreamId) as { latest: string | null };
  const createdAt = new Date(Date.parse(previous.latest ?? new Date().toISOString()) + 60_000).toISOString();
  const terminalizedAt = new Date(Date.parse(createdAt) + 5 * 60_000).toISOString();
  database.prepare(
    `INSERT INTO harness_runs
     (id, workspace_id, workstream_id, origin, execution_principal_json, status,
      started_at, terminalized_at, created_at, trigger_message_id)
     VALUES (?, ?, ?, 'scheduled_wakeup', ?, 'failed', ?, ?, ?, NULL)`,
  ).run(
    "00000000-0000-7000-8000-0000000000b1",
    workspaceId,
    workstreamId,
    JSON.stringify({ type: "user", userId: selectorId }),
    createdAt,
    terminalizedAt,
    createdAt,
  );
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
