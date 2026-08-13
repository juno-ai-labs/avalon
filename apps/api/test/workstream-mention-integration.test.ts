import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";

vi.mock("../src/services/integrations", () => ({
  classifyWorkstreamMessage: vi.fn(async () => ({
    classification: "human_only",
    confidence: 1,
    rationaleCode: "test",
  })),
  publishWorkstreamEvent: vi.fn(async () => undefined),
  startWorkstreamWorkflow: vi.fn(async () => "unused"),
}));

vi.mock("../src/services/mention-email-service", () => ({
  sendWorkstreamMentionEmail: vi.fn(async () => "sent"),
}));

vi.mock("../src/services/slack-mention-service", () => ({
  sendWorkstreamMentionSlack: vi.fn(async () => "skipped"),
}));

import { WorkstreamService } from "../src/services/workstream-service";
import { sendWorkstreamMentionEmail } from "../src/services/mention-email-service";
import { sendWorkstreamMentionSlack } from "../src/services/slack-mention-service";
import { classifyWorkstreamMessage, startWorkstreamWorkflow } from "../src/services/integrations";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const authorId = "00000000-0000-7000-8000-000000000002";
const personId = "00000000-0000-7000-8000-000000000003";
const workstreamId = "00000000-0000-7000-8000-000000000004";
const terminalRequestRunId = "00000000-0000-7000-8000-000000000081";
const terminalRequestInvocationId = "00000000-0000-7000-8000-000000000082";
const terminalContinuationMessageId = "00000000-0000-7000-8000-000000000083";
const at = "2026-08-02T20:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("work-stream addressing", () => {
  it("invokes Avalon without classifying when only one participant is active", async () => {
    const database = migratedDatabase();
    seed(database, false);
    const service = new WorkstreamService(environment(database), auth());

    const result = await service.createMessage(workstreamId, {
      text: "Tell me more",
      clientMessageId: "single-participant-message",
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    });

    expect(result.agentInvoked).toBe(true);
    expect(result.harnessRunId).toEqual(expect.any(String));
    expect(classifyWorkstreamMessage).not.toHaveBeenCalled();
    expect(startWorkstreamWorkflow).toHaveBeenCalledOnce();
  });

  it("supersedes the active interactive turn without cancelling background HyperSight work", async () => {
    const database = migratedDatabase();
    seed(database, false);
    database.exec(`
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES
        ('00000000-0000-7000-8000-000000000091', '${workspaceId}', '${workstreamId}',
         'human_message', '{"type":"user","userId":"${authorId}"}', 'running', '2026-08-07T12:00:00.000Z'),
        ('00000000-0000-7000-8000-000000000092', '${workspaceId}', '${workstreamId}',
         'hypersight_block', '{"type":"workspace","workspaceId":"${workspaceId}"}', 'running', '2026-08-07T12:00:00.000Z');
    `);
    const service = new WorkstreamService(environment(database), auth());

    const result = await service.createMessage(workstreamId, {
      text: "Use this newer direction",
      clientMessageId: "superseding-follow-up",
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    });

    expect(result.agentInvoked).toBe(true);
    expect(database.prepare(
      "SELECT cancellation_reason FROM harness_runs WHERE id = ?",
    ).get("00000000-0000-7000-8000-000000000091")).toEqual({
      cancellation_reason: "superseded_by_follow_up",
    });
    expect(database.prepare(
      "SELECT cancellation_requested_at FROM harness_runs WHERE id = ?",
    ).get("00000000-0000-7000-8000-000000000092")).toEqual({
      cancellation_requested_at: null,
    });
    expect(database.prepare(
      "SELECT cancellation_requested_at FROM harness_runs WHERE id = ?",
    ).get(result.harnessRunId!)).toEqual({ cancellation_requested_at: null });
  });

  it("keeps HyperSight running when the user stops the interactive agent", async () => {
    const database = migratedDatabase();
    seed(database, false);
    database.exec(`
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES
        ('00000000-0000-7000-8000-000000000093', '${workspaceId}', '${workstreamId}',
         'human_message', '{"type":"user","userId":"${authorId}"}', 'running', '2026-08-07T12:00:00.000Z'),
        ('00000000-0000-7000-8000-000000000094', '${workspaceId}', '${workstreamId}',
         'hypersight_block', '{"type":"workspace","workspaceId":"${workspaceId}"}', 'running', '2026-08-07T12:00:00.000Z');
    `);
    const service = new WorkstreamService(environment(database), auth());

    await service.stop(workstreamId);

    expect(database.prepare(
      "SELECT cancellation_reason FROM harness_runs WHERE id = ?",
    ).get("00000000-0000-7000-8000-000000000093")).toEqual({
      cancellation_reason: "stopped_by_user",
    });
    expect(database.prepare(
      "SELECT cancellation_requested_at FROM harness_runs WHERE id = ?",
    ).get("00000000-0000-7000-8000-000000000094")).toEqual({
      cancellation_requested_at: null,
    });
  });

  it("keeps multiplayer classification when more than one participant is active", async () => {
    const database = migratedDatabase();
    seed(database);
    seedConversationHistory(database);
    const service = new WorkstreamService(environment(database), auth());

    const result = await service.createMessage(workstreamId, {
      text: "This is for Ada",
      clientMessageId: "multi-participant-message",
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    });

    expect(result.agentInvoked).toBe(false);
    expect(result.harnessRunId).toBeNull();
    expect(classifyWorkstreamMessage).toHaveBeenCalledOnce();
    expect(classifyWorkstreamMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      message: "This is for Ada",
      recentMessages: Array.from({ length: 10 }, (_, index) => {
        const historyIndex = index + 3;
        return {
          authorType: historyIndex % 2 === 0 ? "agent" : "human",
          authorName: historyIndex % 2 === 0 ? "Avalon" : "Author Person",
          message: `History message ${historyIndex}`,
        };
      }),
    }));
    expect(startWorkstreamWorkflow).not.toHaveBeenCalled();
  });

  it("persists static member-safe copy while logging workflow launch diagnostics", async () => {
    const database = migratedDatabase();
    seed(database, false);
    const diagnostic = "provider response included a private upstream detail";
    vi.mocked(startWorkstreamWorkflow).mockRejectedValueOnce(new Error(diagnostic));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new WorkstreamService(environment(database), auth());

    await expect(service.createMessage(workstreamId, {
      text: "Start a safe run",
      clientMessageId: "launch-failure-message",
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    })).rejects.toMatchObject({
      status: 503,
      code: "workflow_unavailable",
      message: "The Avalon harness could not be started",
    });

    const row = database.prepare(
      "SELECT id, error_json FROM harness_runs WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(workstreamId) as { id: string; error_json: string };
    expect(JSON.parse(row.error_json)).toEqual({
      code: "workflow_unavailable",
      message: "Avalon could not start this run",
    });
    expect(row.error_json).not.toContain(diagnostic);
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      event: "workstream_harness_launch_failed",
      request_id: row.id,
      workspace_id: workspaceId,
      workstream_id: workstreamId,
      error_name: "Error",
      error_message: diagnostic,
    }));
  });
});

describe("Terminal repository continuation", () => {
  it("persists and launches one server-owned continuation", async () => {
    const database = migratedDatabase();
    seed(database, false);
    seedTerminalRepositoryRequest(database);
    const service = new WorkstreamService(environment(database), auth());
    const input = {
      repositoryRequestId: terminalRequestInvocationId,
      harnessRunId: terminalRequestRunId,
      repositoryFullName: "owner/repo",
    };

    const first = await service.continueTerminalRepositoryRequest(workstreamId, input);
    const replay = await service.continueTerminalRepositoryRequest(workstreamId, input);

    expect(first.harnessRunId).toEqual(expect.any(String));
    expect(replay.harnessRunId).toBe(first.harnessRunId);
    expect(startWorkstreamWorkflow).toHaveBeenCalledOnce();
    expect(database.prepare(
      "SELECT origin, parent_harness_run_id FROM harness_runs WHERE id = ?",
    ).get(first.harnessRunId!)).toEqual({
      origin: "terminal_repository_answer",
      parent_harness_run_id: terminalRequestRunId,
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE client_message_id = ?",
    ).get(terminalRequestInvocationId)).toEqual({ count: 1 });
  });

  it("recovers a durable continuation message and launches exactly one continuation run", async () => {
    const database = migratedDatabase();
    seed(database, false);
    seedTerminalRepositoryRequest(database);
    database.prepare(
      `INSERT INTO messages
       (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
        message_type, text_content, sequence_number, created_at)
       VALUES (?, ?, ?, ?, 'human', ?, 'text', ?, 1, ?)`,
    ).run(
      terminalContinuationMessageId,
      terminalRequestInvocationId,
      workspaceId,
      workstreamId,
      authorId,
      "Continue the requested repository work using owner/repo.",
      "2026-08-13T12:00:03.000Z",
    );
    const service = new WorkstreamService(environment(database), auth());

    const first = await service.continueTerminalRepositoryRequest(workstreamId, {
      repositoryRequestId: terminalRequestInvocationId,
      harnessRunId: terminalRequestRunId,
      repositoryFullName: "owner/repo",
    });

    expect(first.harnessRunId).toEqual(expect.any(String));
    expect(startWorkstreamWorkflow).toHaveBeenCalledOnce();
    expect(database.prepare(
      "SELECT origin, parent_harness_run_id FROM harness_runs WHERE id = ?",
    ).get(first.harnessRunId!)).toEqual({
      origin: "terminal_repository_answer",
      parent_harness_run_id: terminalRequestRunId,
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE client_message_id = ?",
    ).get(terminalRequestInvocationId)).toEqual({ count: 1 });
  });

  it("does not persist or launch a continuation after a newer ordinary run", async () => {
    const database = migratedDatabase();
    seed(database, false);
    seedTerminalRepositoryRequest(database);
    database.exec(`
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES
        ('00000000-0000-7000-8000-000000000084', '${workspaceId}', '${workstreamId}',
         'human_message', '{"type":"user","userId":"${authorId}"}', 'completed', '2026-08-13T12:01:00.000Z');
    `);
    const service = new WorkstreamService(environment(database), auth());

    await expect(service.continueTerminalRepositoryRequest(workstreamId, {
      repositoryRequestId: terminalRequestInvocationId,
      harnessRunId: terminalRequestRunId,
      repositoryFullName: "owner/repo",
    })).rejects.toMatchObject({
      status: 409,
      code: "terminal_repository_request_stale",
    });
    expect(startWorkstreamWorkflow).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE client_message_id = ?",
    ).get(terminalRequestInvocationId)).toEqual({ count: 0 });
  });
});

describe("work-stream person mention persistence", () => {
  it("stores canonical person Markdown, hydrates the chip identity, and never repeats side effects on replay", async () => {
    const database = migratedDatabase();
    seed(database);
    const deferred: Promise<unknown>[] = [];
    const service = new WorkstreamService(environment(database), auth(), (promise) => deferred.push(promise));

    const first = await service.createMessage(workstreamId, {
      text: "Please ask @Ada Lovelace.",
      clientMessageId: "mention-message-1",
      mentions: [{
        type: "person",
        userId: personId,
        connectorType: null,
        startOffset: 11,
        endOffset: 24,
      }],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    });
    await Promise.all(deferred);

    const token = `[@Ada Lovelace](person:${personId})`;
    expect(first.message.textContent).toBe(`Please ask ${token}.`);
    expect(first.message.mentions).toEqual([expect.objectContaining({
      type: "person",
      userId: personId,
      displayName: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png",
      startOffset: 11,
      endOffset: 11 + token.length,
    })]);
    // The notification and the naming refresh — a message is both something to
    // tell someone about and a reason to look at the title again.
    expect(deferred).toHaveLength(2);
    expect(sendWorkstreamMentionSlack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipientUserId: personId,
        recipientEmail: "ada@example.com",
        workspaceId,
      }),
    );
    expect(sendWorkstreamMentionEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipientUserId: personId,
        workstreamEmailAddress: "calm-bright-ready-otter@automation.with-avalon.com",
      }),
    );

    const page = await service.messages(workstreamId, 20);
    const stored = page.items.find((message) => message.clientMessageId === "mention-message-1");
    expect(stored?.textContent).toBe(`Please ask ${token}.`);
    expect(stored?.mentions).toEqual([expect.objectContaining({
      userId: personId,
      displayName: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png",
    })]);

    const replay = await service.createMessage(workstreamId, {
      text: "Please ask @Ada Lovelace.",
      clientMessageId: "mention-message-1",
      mentions: [{
        type: "person",
        userId: personId,
        connectorType: null,
        startOffset: 11,
        endOffset: 24,
      }],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    });
    expect(replay.agentInvoked).toBe(false);
    // A replayed message defers nothing new: it is the same message, so no
    // second notification and no second look at the title.
    expect(deferred).toHaveLength(2);
    expect(sendWorkstreamMentionEmail).toHaveBeenCalledTimes(1);
  });

  it("falls back to email when Slack only partially delivers the notification", async () => {
    const database = migratedDatabase();
    seed(database);
    vi.mocked(sendWorkstreamMentionSlack).mockResolvedValueOnce("partial");
    const deferred: Promise<unknown>[] = [];
    const service = new WorkstreamService(environment(database), auth(), (promise) => deferred.push(promise));

    await service.createMessage(workstreamId, {
      text: "Please ask @Ada Lovelace.",
      clientMessageId: "mention-message-slack",
      mentions: [{
        type: "person",
        userId: personId,
        connectorType: null,
        startOffset: 11,
        endOffset: 24,
      }],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    });
    await Promise.all(deferred);

    expect(sendWorkstreamMentionSlack).toHaveBeenCalledOnce();
    expect(sendWorkstreamMentionEmail).toHaveBeenCalledOnce();
  });
});

describe("work-stream elicitation answers", () => {
  it("persists selected and custom responses before starting the continuation", async () => {
    const database = migratedDatabase();
    seed(database, false);
    const { elicitationId, harnessRunId } = seedElicitation(database, "multi_select", 1, 3);
    const service = new WorkstreamService(environment(database), auth());

    const result = await service.answerElicitation(workstreamId, elicitationId, {
      answer: ["compare", "Summarize the payment terms"],
      customResponse: "Summarize the payment terms",
    });

    expect(result.harnessRunId).toEqual(expect.any(String));
    expect(database.prepare("SELECT status, answer_json FROM elicitations WHERE id = ?").get(elicitationId)).toEqual({
      status: "answered",
      answer_json: JSON.stringify(["compare", "Summarize the payment terms"]),
    });
    const responseMessage = database.prepare(
      "SELECT message_type, author_type, structured_content_json FROM messages WHERE client_message_id = ?",
    ).get(`elicitation-response:${elicitationId}`) as {
      message_type: string;
      author_type: string;
      structured_content_json: string;
    };
    expect(responseMessage).toMatchObject({ message_type: "elicitation", author_type: "human" });
    expect(JSON.parse(responseMessage.structured_content_json)).toMatchObject({
      kind: "elicitation_response",
      elicitation: {
        answer: ["compare", "Summarize the payment terms"],
        status: "answered",
      },
    });
    expect(database.prepare("SELECT origin, parent_harness_run_id FROM harness_runs WHERE id = ?").get(result.harnessRunId)).toEqual({
      origin: "elicitation_answer",
      parent_harness_run_id: harnessRunId,
    });
    expect(startWorkstreamWorkflow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      harnessRunId: result.harnessRunId,
      reason: "elicitation_answer",
    }));
  });

  it("records an explicit skip and still resumes the blocked run", async () => {
    const database = migratedDatabase();
    seed(database, false);
    const { elicitationId } = seedElicitation(database, "single_select", 1, 1);
    const service = new WorkstreamService(environment(database), auth());

    const result = await service.answerElicitation(workstreamId, elicitationId, { skipped: true });

    expect(result.harnessRunId).toEqual(expect.any(String));
    expect(database.prepare("SELECT status, answer_json FROM elicitations WHERE id = ?").get(elicitationId)).toEqual({
      status: "answered",
      answer_json: null,
    });
    expect(startWorkstreamWorkflow).toHaveBeenCalledOnce();
  });

  it("rejects arbitrary values that were not declared as the custom response", async () => {
    const database = migratedDatabase();
    seed(database, false);
    const { elicitationId } = seedElicitation(database, "single_select", 1, 1);
    const service = new WorkstreamService(environment(database), auth());

    await expect(service.answerElicitation(workstreamId, elicitationId, { answer: "undeclared" }))
      .rejects.toMatchObject({ code: "invalid_elicitation_option", status: 422 });
    expect(startWorkstreamWorkflow).not.toHaveBeenCalled();
  });
});

function auth(): AuthContext {
  return {
    sessionId: "session-1",
    userId: authorId,
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
    OPENROUTER_PRIMARY_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
  });
}

function seedTerminalRepositoryRequest(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO harness_runs
     (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
     VALUES (?, ?, ?, 'human_message', ?, 'needs_input', ?)`,
  ).run(
    terminalRequestRunId,
    workspaceId,
    workstreamId,
    JSON.stringify({ type: "user", userId: authorId }),
    "2026-08-13T12:00:00.000Z",
  );
  database.prepare(
    `INSERT INTO tool_invocations
     (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
      input_hash, input_json, status, error_json, started_at, completed_at)
     VALUES (?, ?, ?, ?, 'terminal-repository-call', 'terminal_publish_branch_and_pr',
             'hash', '{}', 'failed', ?, ?, ?)`,
  ).run(
    terminalRequestInvocationId,
    workspaceId,
    workstreamId,
    terminalRequestRunId,
    JSON.stringify({
      code: "tool_failed",
      message: "Choose a repository",
      data: { code: "repository_not_configured" },
    }),
    "2026-08-13T12:00:01.000Z",
    "2026-08-13T12:00:02.000Z",
  );
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const fileName of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(fileName, migrations), "utf8"));
  }
  return database;
}

function seed(database: DatabaseSync, includeSecondParticipant = true): void {
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    authorId, "google-author", "author@example.com", "Author Person", null, at, at,
    personId, "google-ada", "ada@example.com", "Ada Lovelace", "https://example.com/ada.png", at, at,
  );
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Avalon Studio', 'avalon-studio', 'global', ?, ?, ?)`,
  ).run(workspaceId, authorId, at, at);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?), (?, ?, 'member', 'active', ?)`,
  ).run(workspaceId, authorId, at, workspaceId, personId, at);
  database.prepare(
    `INSERT INTO workstreams
     (id, workspace_id, title, objective, email_address, email_route_status, origin_type,
      created_by_user_id, harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 'Mention review', 'Review the draft', ?, 'active', 'ad_hoc', ?, 'idle', 1, ?, ?, ?)`,
  ).run(
    workstreamId,
    workspaceId,
    "calm-bright-ready-otter@automation.with-avalon.com",
    authorId,
    at,
    at,
    at,
  );
  database.prepare(
    `INSERT INTO workstream_participants
     (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
     VALUES (?, ?, ?, 'creator', ?, NULL)`,
  ).run(workstreamId, authorId, authorId, at);
  if (includeSecondParticipant) {
    database.prepare(
      `INSERT INTO workstream_participants
       (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
       VALUES (?, ?, ?, 'explicit', ?, NULL)`,
    ).run(workstreamId, personId, authorId, at);
  }
}

function seedConversationHistory(database: DatabaseSync): void {
  const insert = database.prepare(
    `INSERT INTO messages
     (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
      message_type, text_content, sequence_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, ?)`,
  );
  for (let index = 1; index <= 12; index += 1) {
    const authorType = index % 2 === 0 ? "agent" : "human";
    insert.run(
      `history-${index}`,
      `history-${index}`,
      workspaceId,
      workstreamId,
      authorType,
      authorType === "human" ? authorId : null,
      `History message ${index}`,
      index,
      at,
    );
  }
  database.prepare("UPDATE workstreams SET next_sequence_number = 13 WHERE id = ?").run(workstreamId);
}

function seedElicitation(
  database: DatabaseSync,
  responseType: "single_select" | "multi_select",
  minimumSelections: number,
  maximumSelections: number,
): { elicitationId: string; harnessRunId: string } {
  const harnessRunId = "00000000-0000-7000-8000-000000000005";
  const elicitationId = "00000000-0000-7000-8000-000000000006";
  database.prepare(
    `INSERT INTO harness_runs
     (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
     VALUES (?, ?, ?, 'human_message', ?, 'needs_input', ?)`,
  ).run(harnessRunId, workspaceId, workstreamId, JSON.stringify({ type: "user", userId: authorId }), at);
  database.prepare(
    `INSERT INTO elicitations
     (id, workspace_id, workstream_id, harness_run_id, prompt, response_type, options_json,
      minimum_selections, maximum_selections, status, created_at)
     VALUES (?, ?, ?, ?, 'What should Avalon do?', ?, ?, ?, ?, 'open', ?)`,
  ).run(
    elicitationId,
    workspaceId,
    workstreamId,
    harnessRunId,
    responseType,
    JSON.stringify([
      { value: "compare", label: "Compare documents", description: null },
      { value: "review", label: "Review the draft", description: null },
    ]),
    minimumSelections,
    maximumSelections,
    at,
  );
  database.prepare("UPDATE workstreams SET harness_status = 'needs_input' WHERE id = ?").run(workstreamId);
  return { elicitationId, harnessRunId };
}

function sqliteD1(database: DatabaseSync): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first<T>() {
        return (database.prepare(sql).get(...values as never[]) ?? null) as T | null;
      },
      async all<T>() {
        return createTestD1Result<T>({
          results: database.prepare(sql).all(...values as never[]) as T[],
          success: true,
          meta: {},
        });
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as never[]);
        return createTestD1Result<T>({
          results: [],
          success: true,
          meta: { changes: Number(result.changes) },
        });
      },
    };
    return createTestD1PreparedStatement(statement);
  };
  return createTestD1Database({
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      return results;
    },
  });
}
