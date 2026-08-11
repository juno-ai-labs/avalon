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
import { WorkstreamEmailRoutingService } from "../src/services/workstream-email-routing-service";
import { publishWorkstreamEvent, startWorkstreamWorkflow } from "../src/services/integrations";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const authorId = "00000000-0000-7000-8000-000000000002";
const at = "2026-08-11T09:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  // `clearAllMocks` clears calls but not a queued `mockImplementationOnce`, and
  // every test here queues one. A leftover would be consumed by whichever test
  // ran next, which is the kind of order dependency that only fails in a full
  // suite run.
  vi.mocked(startWorkstreamWorkflow).mockReset();
  vi.mocked(startWorkstreamWorkflow).mockImplementation(async () => "unused");
});

/**
 * What a person waiting on `POST /workstreams` is made to wait for.
 *
 * Everything here is about the boundary rather than the behaviour on either
 * side of it: the run is real and the address is reserved before the response,
 * and the two slowest steps — the Workflows round trip and the route
 * activation — happen after it. A regression that quietly moves either back
 * onto the critical path is invisible in every other test, because the result
 * is identical once the dust settles.
 */
describe("work-stream create latency", () => {
  it("answers before the Workflows round trip when a person is waiting on it", async () => {
    const database = seededDatabase();
    let startWorkflow = (): void => undefined;
    vi.mocked(startWorkstreamWorkflow).mockImplementationOnce(() => new Promise<string>((resolve) => {
      startWorkflow = () => resolve("workflow-1");
    }));
    const deferred: Promise<unknown>[] = [];
    const service = new WorkstreamService(environment(database), auth(), (promise) => {
      deferred.push(promise);
    });

    // Deliberately not released first: if the create ever waits on the workflow
    // start again, this line never returns and the test times out.
    const created = await service.create(request());

    expect(created.harnessRunId).toEqual(expect.any(String));
    // The run the response names is already recorded and already running, which
    // is what makes waiting for the workflow start pointless.
    expect(harnessRun(database, created.harnessRunId)).toMatchObject({ status: "running" });
    expect(workstreamRow(database, created.workstream.id)).toMatchObject({ harness_status: "running" });

    startWorkflow();
    await Promise.all(deferred);
    expect(startWorkstreamWorkflow).toHaveBeenCalledOnce();
  });

  it("activates the email route after answering rather than before", async () => {
    const database = seededDatabase();
    // Against an in-memory D1 the activation would finish inside the create
    // whether it was awaited or not, so it is held open here: the point being
    // fixed is that the response does not depend on it, and outside Global it
    // is a second hop to the Global registry.
    let activateRoute = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      activateRoute = () => resolve();
    });
    const activate = WorkstreamEmailRoutingService.prototype.activateWorkstreamRoute;
    vi.spyOn(WorkstreamEmailRoutingService.prototype, "activateWorkstreamRoute")
      .mockImplementation(async function activateAfterRelease(
        this: WorkstreamEmailRoutingService,
        input: Parameters<typeof activate>[0],
      ) {
        await held;
        return activate.call(this, input);
      });
    const deferred: Promise<unknown>[] = [];
    const service = new WorkstreamService(environment(database), auth(), (promise) => {
      deferred.push(promise);
    });

    const created = await service.create(request());

    // The address itself is settled — it is in the response and on the row.
    // Only the routing status is outstanding, and nothing the caller received
    // depends on it.
    expect(created.workstream.emailAddress).toEqual(expect.stringContaining("@"));
    expect(workstreamRow(database, created.workstream.id)).toMatchObject({ email_route_status: "reserved" });

    activateRoute();
    await Promise.all(deferred);
    expect(workstreamRow(database, created.workstream.id)).toMatchObject({ email_route_status: "active" });
  });

  it("still waits for the workflow start when nobody is waiting on a response", async () => {
    const database = seededDatabase();
    let startWorkflow = (): void => undefined;
    // Resolved when the create actually reaches the workflow start. Waiting a
    // fixed delay instead would be a race: under a loaded suite the create can
    // still be several D1 round trips away, and releasing a workflow that has
    // not been started yet leaves it pending for ever.
    const reachedWorkflowStart = new Promise<void>((reached) => {
      vi.mocked(startWorkstreamWorkflow).mockImplementationOnce(() => new Promise<string>((resolve) => {
        startWorkflow = () => resolve("workflow-1");
        reached();
      }));
    });
    // Slack ingress and the tests below it supply no deferral, and an unawaited
    // promise in a Worker is not guaranteed to finish once the response is sent.
    const service = new WorkstreamService(environment(database), auth());

    const pending = service.create(request());
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await reachedWorkflowStart;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(settled).toBe(false);
    startWorkflow();
    await pending;
    expect(settled).toBe(true);
  });

  it("reports a deferred launch failure on the run instead of failing the create", async () => {
    const database = seededDatabase();
    vi.mocked(startWorkstreamWorkflow).mockRejectedValueOnce(new Error("Workflows is unavailable"));
    const deferred: Promise<unknown>[] = [];
    const service = new WorkstreamService(environment(database), auth(), (promise) => {
      deferred.push(promise);
    });

    const created = await service.create(request());
    // The work stream exists either way, so a 503 would have been an error
    // about something that already happened. The failure belongs on the run.
    await expect(Promise.all(deferred)).resolves.toBeDefined();

    expect(harnessRun(database, created.harnessRunId)).toMatchObject({ status: "failed" });
    expect(workstreamRow(database, created.workstream.id)).toMatchObject({ harness_status: "failed" });
    expect(vi.mocked(publishWorkstreamEvent).mock.calls.map((call) => call[3])).toContainEqual({
      type: "harness_status_changed",
      status: "failed",
    });
  });
});

function request() {
  return {
    openingMessage: "Prepare the launch brief",
    clientMessageId: "client-create-latency",
    participantUserIds: [],
    attachmentIds: [],
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

function harnessRun(database: DatabaseSync, id: string): Record<string, unknown> {
  return database.prepare("SELECT * FROM harness_runs WHERE id = ?").get(id) as Record<string, unknown>;
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
