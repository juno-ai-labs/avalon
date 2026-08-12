import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import type * as NamingService from "../src/services/workstream-naming-service";
import { sqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/services/integrations", () => ({
  classifyWorkstreamMessage: vi.fn(async () => ({
    classification: "human_only",
    confidence: 1,
    rationaleCode: "test",
  })),
  publishWorkstreamEvent: vi.fn(async () => undefined),
  startWorkstreamWorkflow: vi.fn(async () => "unused"),
}));

// Only the model call is replaced: `provisionalWorkstreamTitle` comes from the
// same module and is what a create names the work stream before the agent answers.
vi.mock("../src/services/workstream-naming-service", async (importOriginal) => ({
  ...await importOriginal<typeof NamingService>(),
  nameWorkstream: vi.fn(async () => undefined),
}));

import { WorkstreamService } from "../src/services/workstream-service";
import { publishWorkstreamEvent, startWorkstreamWorkflow } from "../src/services/integrations";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const authorId = "00000000-0000-7000-8000-000000000002";
const strangerId = "00000000-0000-7000-8000-00000000000f";
const at = "2026-08-11T09:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  // `clearAllMocks` and not `restoreAllMocks`: nothing here is a `vi.spyOn`, so
  // restoring had nothing of its own to undo, and since Vitest 3 it does not
  // touch a `vi.fn()` implementation either — it was a no-op in both directions.
  vi.clearAllMocks();
  // Clearing drops recorded calls but not a queued `mockImplementationOnce`. A
  // leftover would be consumed by whichever test ran next, which is the kind of
  // order dependency that only fails in a full suite run.
  vi.mocked(startWorkstreamWorkflow).mockReset();
  vi.mocked(startWorkstreamWorkflow).mockImplementation(async () => "unused");
});

/**
 * What `POST /workstreams` finishes before it answers.
 *
 * Deferring the two slowest steps to `waitUntil` was tried here and reverted,
 * and these tests are the record of what has to stay true instead: the run is
 * started and the route is active before the response, because a run that never
 * reached a Workflow is a work stream nothing can recover. The launch surface on
 * the client is what makes that wait invisible; see `docs/workstream-creation.md`.
 */
describe("work-stream create", () => {
  it("starts the harness before answering, so a failed start is the caller's answer", async () => {
    const database = seededDatabase();
    vi.mocked(startWorkstreamWorkflow).mockRejectedValueOnce(new Error("Workflows is unavailable"));
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    await expect(service.create(request())).rejects.toMatchObject({ status: 503 });

    // The work stream exists either way, so anyone already watching is told the
    // run failed rather than left on a `running` row nothing will move.
    const run = latestRun(database);
    expect(run).toMatchObject({ status: "failed" });
    expect(vi.mocked(publishWorkstreamEvent).mock.calls.map((call) => call[3])).toContainEqual({
      type: "harness_status_changed",
      status: "failed",
    });
  });

  it("leaves the email route active, not merely reserved", async () => {
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    const created = await service.create(request());

    // `list` backfills any route that is not active, and the create invalidates
    // that list immediately — leaving it reserved here only moves the same hop
    // onto the refresh that follows.
    expect(created.workstream.emailAddress).toEqual(expect.stringContaining("@"));
    expect(workstreamRow(database, created.workstream.id)).toMatchObject({
      email_route_status: "active",
      harness_status: "running",
    });
  });

  it("reports the same refusal whichever of two bad pre-flight checks loses the race", async () => {
    // Both checks run concurrently, so a request that violates both must not
    // report whichever rejection happened to land first.
    const codes = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const database = seededDatabase();
      const service = new WorkstreamService(environment(database), auth(), () => undefined);
      await service.create({
        ...request(),
        participantUserIds: [strangerId],
        attachmentIds: ["00000000-0000-7000-8000-0000000000ee"],
      }).catch((error: unknown) => {
        codes.add((error as { code?: string }).code ?? "unknown");
      });
    }

    expect([...codes]).toEqual(["invalid_workspace_member"]);
  });

  it("does not reserve an address for a work stream it is about to refuse", async () => {
    const database = seededDatabase();
    const service = new WorkstreamService(environment(database), auth(), () => undefined);

    await expect(service.create({ ...request(), participantUserIds: [strangerId] }))
      .rejects.toMatchObject({ status: 422 });

    expect(database.prepare("SELECT COUNT(*) AS count FROM workstream_email_routes").get())
      .toMatchObject({ count: 0 });
  });
});

function request() {
  return {
    openingMessage: "Prepare the launch brief",
    clientMessageId: "client-create-latency",
    participantUserIds: [] as string[],
    attachmentIds: [] as string[],
  };
}

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
  return {
    DB: sqliteD1(database),
    APP_ENV: "test",
    AVALON_REGION: "global",
    // Outside production the address key is derived from this one, and a create
    // reserves an address before it writes anything.
    SESSION_SIGNING_KEY: "session-signing-key-for-workstream-create-latency",
    OPENROUTER_PRIMARY_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_FALLBACK_MODELS: "google/gemini-3.6-flash",
  } as unknown as Env;
}

function latestRun(database: DatabaseSync): Record<string, unknown> {
  return database
    .prepare("SELECT * FROM harness_runs ORDER BY created_at DESC LIMIT 1")
    .get() as Record<string, unknown>;
}

function workstreamRow(database: DatabaseSync, id: string): Record<string, unknown> {
  return database.prepare("SELECT * FROM workstreams WHERE id = ?").get(id) as Record<string, unknown>;
}

function seededDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const fileName of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(fileName, migrations), "utf8"));
  }
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
     VALUES (?, 'google-author', 'author@example.com', 'Author Person', NULL, ?, ?)`,
  ).run(authorId, at, at);
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Avalon Studio', 'avalon-studio', 'global', ?, ?, ?)`,
  ).run(workspaceId, authorId, at, at);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?)`,
  ).run(workspaceId, authorId, at);
  return database;
}
