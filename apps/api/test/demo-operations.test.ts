import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { demoOperatorRoutes } from "../src/routes/demo-operations";
import { DEMO_TEMPLATE_WORKSPACE_ID } from "../src/services/demo-workspace-visibility";
import { listDemoCastCandidates, mintDemoPersona } from "../src/services/demo-cast";
import { __demoPreparationTesting } from "../src/services/demo-preparation";
import {
  abandonDemoOperation,
  activeDemoPack,
  demoOperationStatus,
  demoTemplate,
  failDemoPreparationDriver,
  listDemoOperations,
  retryDemoOperation,
  runDemoPreparationPhase,
  startDemoOperation,
  demoPreparationInstanceId,
} from "../src/services/demo-preparation";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// The template check counts the template's connections through the
// workspace's runtime database, which is routed through its Durable Object —
// the one thing this suite cannot run. The regional D1 stands in for it here;
// the workerd suite proves the count against the real object.
vi.mock("../src/services/workspace-runtime-database", () => ({
  workspaceRuntimeDatabase: (env: { DB: D1Database }) => env.DB,
}));

/**
 * Operation identity, one driver at a time, and the door it sits behind.
 *
 * One operation id is one demo: submitting it again returns the progress it
 * already has and starts nothing, and a retry is a new attempt of the same
 * operation rather than a new one. Every attempt has a number the row carries,
 * and a driver whose attempt is no longer the row's writes nothing. The rows
 * are proved against the real migration, and the Workflow binding is the one
 * thing doubled — what is asserted is whether it was asked to start, which is
 * the whole of its contract here.
 *
 * The routes are proved with the real service over the same database: the
 * operator credential and its `demos` role are the only way in, and an abandon
 * is refused unless the confirmation names its target.
 */

const PRESENTER_ID = "00000000-0000-7000-8000-0000000000a1";
const PRIYA_ID = "00000000-0000-7000-8000-0000000000a2";
const MARCUS_ID = "00000000-0000-7000-8000-0000000000a3";
const DANA_ID = "00000000-0000-7000-8000-0000000000a4";
/** A namesake of Sam Burton (`MARCUS_ID`): two of them is one ambiguous mention. */
const NAMESAKE_ID = "00000000-0000-7000-8000-0000000000a5";
/** On the company's domain, but has never signed in, so there is nobody to seat. */
const UNSEEN_ID = "00000000-0000-7000-8000-0000000000a6";
/** Not on the company's domain: neither a presenter nor a cast member. */
const OUTSIDER_ID = "00000000-0000-7000-8000-0000000000a9";
const OPERATION_ID = "00000000-0000-7000-8000-0000000000e2";
const DEMOS_TOKEN = "demos-operator-token-0123456789abcdef0123456789";
const SUPPORT_TOKEN = "support-operator-token-0123456789abcdef012345678";
const MISFILED_SUPPORT_TOKEN = "support-token-in-the-demo-map-0123456789abcdef";
const NOW = "2026-09-07T12:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

it("creates every ordered impersonation pair for a seated demo, including self-pairs", () => {
  const relationships = __demoPreparationTesting.demoImpersonationRelationships(
    [PRESENTER_ID, PRIYA_ID, MARCUS_ID],
    OPERATION_ID,
  );
  expect(relationships).toHaveLength(9);
  expect(new Set(relationships.map((item) => `${item.impersonatorUserId}->${item.representedUserId}`)).size).toBe(9);
  expect(relationships).toContainEqual({
    impersonatorUserId: PRESENTER_ID,
    representedUserId: PRESENTER_ID,
    authorityBasis: `demo:${OPERATION_ID}`,
  });
  expect(relationships).toContainEqual({
    impersonatorUserId: MARCUS_ID,
    representedUserId: PRIYA_ID,
    authorityBasis: `demo:${OPERATION_ID}`,
  });
});

/** The cast as the operator gives it: an account per role, chosen from colleagues. */
function cast(): Record<string, string> {
  return { priya: PRIYA_ID, theo: DANA_ID };
}

function request(): { operationId: string; companyName: string; presenterUserId: string; cast: Record<string, string> } {
  return { operationId: OPERATION_ID, companyName: "Alto Capital", presenterUserId: PRESENTER_ID, cast: cast() };
}

interface Fixture {
  env: Env;
  launched: { id: string; params: unknown }[];
  create: ReturnType<typeof vi.fn>;
  app: Hono<HonoAppEnv>;
}

function fixture(overrides: Partial<Env> = {}, options: { withoutDriver?: boolean } = {}): Fixture {
  const database = migratedSqliteDatabase();
  databases.push(database);
  // The company's directory: colleagues on its own domain, and one person who
  // is not on it. `email` is what decides who may be cast, so it is the only
  // thing that differs between them.
  const directory: [string, string, string, boolean][] = [
    [PRESENTER_ID, "Adam", "adam@rallywith.ai", true],
    [PRIYA_ID, "Priya Raman", "priya@rallywith.ai", true],
    [MARCUS_ID, "Sam Burton", "kb@rallywith.ai", true],
    [DANA_ID, "Ben Diaz", "ben@rallywith.ai", true],
    [NAMESAKE_ID, "Sam Burton", "sam.burton@rallywith.ai", true],
    [UNSEEN_ID, "Nadia Okafor", "nadia@rallywith.ai", false],
    [OUTSIDER_ID, "Sam Outsider", "sam@contractor.example.com", true],
  ];
  for (const [id, name, email, signedIn] of directory) {
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at, platform_user_id)
      VALUES ('${id}', 'sub-${id}', '${email}', '${name}', '${NOW}', '${NOW}', ${signedIn ? `'${id}'` : "NULL"});
    `);
  }
  // The connections table lives in the workspace's runtime database, which the
  // double above answers from this one; the template holds none here.
  database.exec("CREATE TABLE connector_connections (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL)");
  // The template, with the presenter seated and nobody else. The cast are not
  // seated here: they are cast from the company's directory, not the
  // template's membership.
  database.exec(`
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${DEMO_TEMPLATE_WORKSPACE_ID}', 'demo-template', 'demo-template', 'global', '${PRESENTER_ID}', '${NOW}', '${NOW}');
  `);
  database.exec(`
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${DEMO_TEMPLATE_WORKSPACE_ID}', '${PRESENTER_ID}', 'owner', 'active', '${NOW}');
  `);
  const launched: { id: string; params: unknown }[] = [];
  const create = vi.fn(async (input: { id: string; params: unknown }) => { launched.push(input); });
  const env = createTestEnv({
    APP_ENV: "development",
    AVALON_REGION: "global",
    DB: sqliteD1(database),
    // The demo routes read the demo secret only; the telemetry map's tokens
    // are not credentials here whatever role they carry.
    DEMO_OPERATORS_JSON: JSON.stringify({
      [DEMOS_TOKEN]: { operatorId: "00000000-0000-7000-8000-0000000000d1", role: "demos" },
      [MISFILED_SUPPORT_TOKEN]: { operatorId: "00000000-0000-7000-8000-0000000000d3", role: "support" },
    }),
    TELEMETRY_OPERATORS_JSON: JSON.stringify({
      [SUPPORT_TOKEN]: { operatorId: "00000000-0000-7000-8000-0000000000d2", role: "support" },
    }),
    DEMO_PREPARATION_WORKFLOW: { create } as unknown as Workflow,
    ...overrides,
  });
  if (options.withoutDriver) delete (env as { DEMO_PREPARATION_WORKFLOW?: Workflow }).DEMO_PREPARATION_WORKFLOW;
  const app = new Hono<HonoAppEnv>();
  app.route("/internal/demos", demoOperatorRoutes);
  app.onError(errorHandler);
  return { env, launched, create, app };
}

async function row(env: Env, operationId: string): Promise<{ status: string; attempt: number; failed_phase: string | null; error_code: string | null; workspace_id: string | null }> {
  return (await env.DB.prepare(
    "SELECT status, attempt, failed_phase, error_code, workspace_id FROM demo_operations WHERE operation_id = ?",
  ).bind(operationId).first())!;
}

describe("a demo preparation operation", () => {
  it("starts once per operation id and answers a repeat with the same progress", async () => {
    const { env, launched } = fixture();
    const first = await startDemoOperation(env, request());
    expect(first).toMatchObject({
      operationId: OPERATION_ID,
      status: "running",
      attempt: 1,
      presenterName: "Adam",
      workspaceId: null,
      packVersion: activeDemoPack().version,
      seeding: { confirmed: 0, total: activeDemoPack().steps.length },
    });
    expect(launched).toEqual([{
      id: `demo-preparation-${OPERATION_ID}-1`,
      params: { region: "global", operationId: OPERATION_ID, attempt: 1 },
    }]);

    const again = await startDemoOperation(env, { ...request(), companyName: "Alto Capital (again)" });
    // The first submission's facts, and no second Workflow.
    expect(again.companyName).toBe("Alto Capital");
    expect(launched).toHaveLength(1);
  });

  it("refuses a cast that leaves a pack role uncast, names a role the pack has not got, or seats one person twice", async () => {
    const { env } = fixture();
    const short = Object.fromEntries(Object.entries(cast()).filter(([role]) => role !== "theo"));
    await expect(startDemoOperation(env, { ...request(), cast: short })).rejects.toMatchObject({ code: "demo_pack_role_unbound" });
    await expect(startDemoOperation(env, { ...request(), cast: { ...cast(), sam: DANA_ID } })).rejects.toMatchObject({ code: "demo_pack_role_unknown" });
    await expect(startDemoOperation(env, { ...request(), cast: { ...cast(), theo: PRIYA_ID } })).rejects.toMatchObject({ code: "demo_cast_duplicate" });
    // The presenter is in the demo already, so the cast may not seat them
    // again; and the presenter is chosen by their own field, never cast.
    await expect(startDemoOperation(env, { ...request(), cast: { ...cast(), theo: PRESENTER_ID } })).rejects.toMatchObject({ code: "demo_cast_duplicate" });
    await expect(startDemoOperation(env, { ...request(), cast: { ...cast(), presenter: PRESENTER_ID } })).rejects.toMatchObject({ code: "demo_presenter_cast" });
    // Two different colleagues under one name is the other collision: a
    // mention resolves to an id, and nobody watching can attribute it.
    await expect(startDemoOperation(env, { ...request(), cast: { priya: MARCUS_ID, theo: NAMESAKE_ID } }))
      .rejects.toMatchObject({ code: "demo_cast_name_duplicate" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM demo_operations").first()).toEqual({ count: 0 });
  });

  it("refuses the template outside the region demos are prepared in", async () => {
    // The answer is the company's directory now, so an enterprise call would read out
    // every European colleague's name and address from a route that cannot
    // prepare a demo there anyway.
    const { env } = fixture({ AVALON_REGION: "enterprise" });
    await expect(demoTemplate(env)).rejects.toMatchObject({ code: "demo_region_unsupported" });
  });

  it("refuses to cast anybody who is not a colleague, before writing a row", async () => {
    const { env, launched } = fixture();
    // Being cast seats the account in the demo workspace, which receives
    // copies of the template's connections; the domain is what bounds who
    // that can be, and the page's list is not what enforces it.
    await expect(startDemoOperation(env, { ...request(), cast: { ...cast(), theo: OUTSIDER_ID } }))
      .rejects.toMatchObject({ code: "demo_cast_not_a_colleague" });
    // Somebody who has never signed in is not one either, whatever their
    // address: there is no account to seat.
    await expect(startDemoOperation(env, { ...request(), cast: { ...cast(), theo: UNSEEN_ID } }))
      .rejects.toMatchObject({ code: "demo_cast_not_a_colleague" });
    // Nor is a near miss. `_` is one character to LIKE and an ordinary one in
    // a hostname, and a subdomain or a lookalike registered by somebody else
    // is a different company: only the domain itself is castable.
    for (const address of ["ben@x.rallywith.ai", "ben@notrallywith.ai", "ben@rallywith0ai", "ben@rallywith.ai.evil.example"]) {
      await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(address, DANA_ID).run();
      await expect(startDemoOperation(env, request()))
        .rejects.toMatchObject({ code: "demo_cast_not_a_colleague" });
      expect((await listDemoCastCandidates(env)).some((candidate) => candidate.userId === DANA_ID)).toBe(false);
    }
    expect(launched).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM demo_operations").first()).toEqual({ count: 0 });
  });

  it("refuses a presenter the template does not seat, before writing a row", async () => {
    const { env, launched } = fixture();
    // The new workspace is owned by the presenter and receives the template's
    // credentials; a presenter outside the template would be handed them.
    await expect(startDemoOperation(env, { ...request(), presenterUserId: OUTSIDER_ID }))
      .rejects.toMatchObject({ code: "demo_presenter_not_in_template" });
    expect(launched).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM demo_operations").first()).toEqual({ count: 0 });
  });

  it("stores the cast as the accounts it was given, and answers their directory names", async () => {
    const { env } = fixture();
    const started = await startDemoOperation(env, request());
    // The row stores user ids, the way every phase after this reads it, and
    // the status answers the name each of them carries in the directory —
    // never a name the request supplied.
    expect(started.cast).toEqual({ presenter: PRESENTER_ID, priya: PRIYA_ID, theo: DANA_ID });
    expect(started.castNames).toEqual({
      presenter: "Adam", priya: "Priya Raman", theo: "Ben Diaz",
    });
    // Nobody was invented for it: the demo's people are the accounts that
    // were already there.
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first()).toEqual({ count: 7 });

    // A repeat of the same operation id meets the cast it was started with,
    // whoever the second request names.
    const again = await startDemoOperation(env, {
      ...request(),
      cast: { priya: DANA_ID, theo: PRIYA_ID },
    });
    expect(again.cast).toEqual(started.cast);

    // And it is answered without validating the request against a directory
    // that has moved since: a client retrying a lost response would otherwise
    // be refused about a preparation of its own that is running fine.
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind("ben@elsewhere.example.com", DANA_ID).run();
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind("Priya Raman", DANA_ID).run();
    expect((await startDemoOperation(env, request())).cast).toEqual(started.cast);
  });

  it("refuses to prepare a demo whose cast stopped being a colleague after the row was written", async () => {
    // The same question the start request answered, asked again on a row
    // written minutes ago: an account that left the company between the two
    // would be seated in the demo and handed the template's connections.
    const { env } = fixture();
    await startDemoOperation(env, request());
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind("ben@elsewhere.example.com", DANA_ID).run();
    await expect(runDemoPreparationPhase(env, OPERATION_ID, "checking_template", { attempt: 1 }))
      .rejects.toMatchObject({ code: "demo_cast_not_a_colleague" });
    expect(await row(env, OPERATION_ID)).toMatchObject({ status: "failed", error_code: "demo_cast_not_a_colleague" });
  });

  it("plays a typed name with a persona that cannot sign in, and refuses one that is somebody else's", async () => {
    const { env } = fixture();
    // The presenter's own name, typed into a part, is the same collision as two colleagues'.
    await expect(startDemoOperation(env, { ...request(), cast: { priya: PRIYA_ID, theo: { name: "adam" } } }))
      .rejects.toMatchObject({ code: "demo_cast_name_duplicate" });
    const started = await startDemoOperation(env, {
      ...request(),
      cast: { priya: { name: "Jane Doe" }, theo: { name: "Johnny Appleseed" } },
    });
    expect(started.castNames).toMatchObject({ priya: "Jane Doe", theo: "Johnny Appleseed" });
    const persona = await env.DB.prepare("SELECT email, platform_user_id FROM users WHERE id = ?")
      .bind(started.cast.priya).first<{ email: string; platform_user_id: string | null }>();
    expect(persona).toEqual({ email: `${OPERATION_ID}.priya@persona.invalid`, platform_user_id: null });
    // And the first phase accepts it as castable.
    await runDemoPreparationPhase(env, OPERATION_ID, "checking_template", { attempt: 1 });
    expect(await row(env, OPERATION_ID)).toMatchObject({ error_code: null });
    // A persona is only ever reached by typing a name: its id is not an account a request may cast.
    await expect(startDemoOperation(env, {
      ...request(), operationId: "00000000-0000-7000-8000-00000000ffe1", cast: { priya: started.cast.priya!, theo: DANA_ID },
    })).rejects.toMatchObject({ code: "demo_cast_not_a_colleague" });
  });

  it("names a persona after the submission that claimed the operation, not one that lost", async () => {
    const { env } = fixture();
    // The loser of a concurrent first submission has already minted the persona under its name.
    await mintDemoPersona(env, { operationId: OPERATION_ID, role: "priya", name: "Loser Name" });
    const started = await startDemoOperation(env, { ...request(), cast: { priya: { name: "Jane Doe" }, theo: DANA_ID } });
    expect(started.castNames.priya).toBe("Jane Doe");
    // And a later mint for the claimed operation does not rename it back.
    await mintDemoPersona(env, { operationId: OPERATION_ID, role: "priya", name: "Loser Name" });
    expect((await startDemoOperation(env, request())).castNames.priya).toBe("Jane Doe");
  });

  it("refuses to prepare a demo whose cast came to share a name after the row was written", async () => {
    // A name is not fixed: it is rewritten from the platform identity every
    // time somebody signs in, so two people in one demo can collide between
    // the start request and the phase that acts on it — and a retry can be
    // days later. A mention resolves to a user id, and nobody watching could
    // attribute it to either of them.
    const { env } = fixture();
    await startDemoOperation(env, request());
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind("Priya Raman", DANA_ID).run();
    await expect(runDemoPreparationPhase(env, OPERATION_ID, "checking_template", { attempt: 1 }))
      .rejects.toMatchObject({ code: "demo_cast_name_duplicate" });
    expect(await row(env, OPERATION_ID)).toMatchObject({ status: "failed", error_code: "demo_cast_name_duplicate" });

    // The presenter is in the demo under their own name too, so they are one
    // of the people the check covers. A second operation, because the first is
    // failed and every phase refuses one that is not running.
    const second = "00000000-0000-7000-8000-0000000000e3";
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind("Ben Diaz", DANA_ID).run();
    await startDemoOperation(env, { ...request(), operationId: second });
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind("Adam", PRIYA_ID).run();
    await expect(runDemoPreparationPhase(env, second, "checking_template", { attempt: 1 }))
      .rejects.toMatchObject({ code: "demo_cast_name_duplicate" });
  });

  it("allocates a workspace id onto the row before the workspace exists", async () => {
    // The creating phase writes the id first so a crash between the two
    // retries the same id. The real migration has to accept that write — a
    // foreign key to `workspaces` would refuse it, and this is the statement
    // the phase issues.
    const { env } = fixture();
    await startDemoOperation(env, request());
    const workspaceId = "00000000-0000-7000-8000-00000000c0de";
    await env.DB.prepare(
      "UPDATE demo_operations SET workspace_id = ?, updated_at = ? WHERE operation_id = ? AND workspace_id IS NULL",
    ).bind(workspaceId, NOW, OPERATION_ID).run();
    expect((await row(env, OPERATION_ID)).workspace_id).toBe(workspaceId);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE id = ?").bind(workspaceId).first()).toEqual({ count: 0 });
  });

  it("retries a failed operation as the next attempt, and a running one whose driver died", async () => {
    const { env, launched } = fixture();
    await startDemoOperation(env, request());
    await env.DB.prepare(
      `UPDATE demo_operations SET status = 'failed', failed_phase = 'copying_connections',
              error_code = 'demo_template_missing', error_message = 'gone' WHERE operation_id = ?`,
    ).bind(OPERATION_ID).run();
    const retried = await retryDemoOperation(env, OPERATION_ID);
    expect(retried).toMatchObject({ status: "running", attempt: 2, failedPhase: null, error: null });
    expect(launched.at(-1)).toMatchObject({ id: `demo-preparation-${OPERATION_ID}-2`, params: { attempt: 2 } });

    // A driver the platform ended without a word leaves the row `running`;
    // the operator's Retry is the way back, and it is the next attempt.
    const again = await retryDemoOperation(env, OPERATION_ID);
    expect(again).toMatchObject({ status: "running", attempt: 3 });

    await env.DB.prepare("UPDATE demo_operations SET status = 'ready' WHERE operation_id = ?").bind(OPERATION_ID).run();
    await expect(retryDemoOperation(env, OPERATION_ID)).rejects.toMatchObject({ code: "demo_operation_not_retryable" });
  });

  it("refuses a phase call from a superseded attempt without writing", async () => {
    const { env } = fixture();
    await startDemoOperation(env, request());
    await env.DB.prepare("UPDATE demo_operations SET status = 'failed' WHERE operation_id = ?").bind(OPERATION_ID).run();
    await retryDemoOperation(env, OPERATION_ID);

    // Attempt 1's driver is still alive and reaches its next phase.
    await expect(runDemoPreparationPhase(env, OPERATION_ID, "checking_template", { attempt: 1 }))
      .rejects.toMatchObject({ code: "demo_operation_superseded" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM demo_operation_phases").first()).toEqual({ count: 0 });
    expect(await row(env, OPERATION_ID)).toMatchObject({ status: "running", attempt: 2 });
  });

  it("refuses a resumed later phase when deployment changed the pack", async () => {
    const { env } = fixture();
    await startDemoOperation(env, request());
    await runDemoPreparationPhase(env, OPERATION_ID, "checking_template", { attempt: 1 });
    await env.DB.prepare("UPDATE demo_operations SET pack_version = 'previous-pack' WHERE operation_id = ?")
      .bind(OPERATION_ID).run();
    await expect(runDemoPreparationPhase(env, OPERATION_ID, "seeding_conversations", { attempt: 1 }))
      .rejects.toMatchObject({ code: "demo_pack_changed" });
    expect(await row(env, OPERATION_ID)).toMatchObject({ status: "failed", error_code: "demo_pack_changed" });
  });

  it("runs the template check against the real rows and fails the operation on a presenter the template lost", async () => {
    const { env } = fixture();
    await startDemoOperation(env, request());
    const checked = await runDemoPreparationPhase(env, OPERATION_ID, "checking_template", { attempt: 1 });
    expect(checked).toMatchObject({ outcome: "completed", detail: { templateConnections: 0 } });

    await env.DB.prepare("UPDATE workspace_members SET status = 'suspended' WHERE workspace_id = ? AND user_id = ?")
      .bind(DEMO_TEMPLATE_WORKSPACE_ID, PRESENTER_ID).run();
    await env.DB.prepare("UPDATE demo_operation_phases SET status = 'running' WHERE operation_id = ?").bind(OPERATION_ID).run();
    await expect(runDemoPreparationPhase(env, OPERATION_ID, "checking_template", { attempt: 1 }))
      .rejects.toMatchObject({ code: "demo_presenter_not_in_template" });
    expect(await row(env, OPERATION_ID)).toMatchObject({ status: "failed", failed_phase: "checking_template", error_code: "demo_presenter_not_in_template" });
    const status = await demoOperationStatus(env, OPERATION_ID);
    expect(status?.phases).toEqual([expect.objectContaining({ phase: "checking_template", status: "failed" })]);
  });

  it("records a driver that stopped outside a phase, for the attempt that owns the row only", async () => {
    const { env } = fixture();
    await startDemoOperation(env, request());
    await runDemoPreparationPhase(env, OPERATION_ID, "checking_template", { attempt: 1 });
    await env.DB.prepare("UPDATE demo_operation_phases SET status = 'running', finished_at = NULL WHERE operation_id = ?").bind(OPERATION_ID).run();

    await failDemoPreparationDriver(env, OPERATION_ID, 7, new Error("a stale driver"));
    expect(await row(env, OPERATION_ID)).toMatchObject({ status: "running", attempt: 1 });

    await failDemoPreparationDriver(env, OPERATION_ID, 1, new Error("step ended by the platform"));
    expect(await row(env, OPERATION_ID)).toMatchObject({ status: "failed", failed_phase: "checking_template", error_code: "demo_driver_failed" });
    const status = await demoOperationStatus(env, OPERATION_ID);
    expect(status?.phases[0]).toMatchObject({ phase: "checking_template", status: "failed", error: { code: "demo_driver_failed" } });
    // Internal text stays in the log, not on the page.
    expect(status?.error?.message).not.toContain("platform");
  });

  it("marks the operation failed when its driver cannot be started", async () => {
    const { env, create } = fixture();
    create.mockRejectedValueOnce(new Error("workflow create refused"));
    await expect(startDemoOperation(env, request())).rejects.toMatchObject({ code: "demo_preparation_launch_failed" });
    expect(await row(env, OPERATION_ID)).toMatchObject({ status: "failed", error_code: "demo_preparation_launch_failed" });
    // And Retry is the way back.
    const retried = await retryDemoOperation(env, OPERATION_ID);
    expect(retried).toMatchObject({ status: "running", attempt: 2 });
  });

  it("abandons only with a confirmation, never a published demo, and closes an operation with no workspace", async () => {
    const { env } = fixture();
    await startDemoOperation(env, request());
    await expect(abandonDemoOperation(env, OPERATION_ID, { confirmOperationId: "00000000-0000-7000-8000-00000000dead" }))
      .rejects.toMatchObject({ code: "demo_abandon_unconfirmed" });

    await env.DB.prepare("UPDATE demo_operations SET ready_at = ? WHERE operation_id = ?").bind(NOW, OPERATION_ID).run();
    await expect(abandonDemoOperation(env, OPERATION_ID, { confirmOperationId: OPERATION_ID }))
      .rejects.toMatchObject({ code: "demo_operation_ready" });

    // Allocated but never created: nothing to retire, and the row closes.
    await env.DB.prepare("UPDATE demo_operations SET ready_at = NULL, workspace_id = ? WHERE operation_id = ?")
      .bind("00000000-0000-7000-8000-00000000c0de", OPERATION_ID).run();
    const abandoned = await abandonDemoOperation(env, OPERATION_ID, { confirmOperationId: OPERATION_ID });
    expect(abandoned.status).toBe("abandoned");
    await expect(retryDemoOperation(env, OPERATION_ID)).rejects.toMatchObject({ code: "demo_operation_not_retryable" });
  });

  it("leaves a failed row untouched when a retry cannot start its driver", async () => {
    // The row moves only once the driver is known to exist: bumping the
    // attempt first left a `running` operation nothing was running, with the
    // diagnosis the operator was reading erased.
    const { env } = fixture({}, { withoutDriver: true });
    await env.DB.prepare(
      `INSERT INTO demo_operations (operation_id, company_name, presenter_user_id, pack_version, cast_json, workspace_id,
         status, attempt, failed_phase, error_code, error_message, created_at, updated_at)
       VALUES (?, 'Alto Capital', ?, 'v1', '{}', NULL, 'failed', 1, 'checking_template', 'demo_cast_not_a_colleague', 'Sam is not a colleague', ?, ?)`,
    ).bind(OPERATION_ID, PRESENTER_ID, NOW, NOW).run();
    await expect(retryDemoOperation(env, OPERATION_ID)).rejects.toMatchObject({ code: "demo_preparation_unavailable" });
    expect(await row(env, OPERATION_ID)).toMatchObject({ status: "failed", attempt: 1, failed_phase: "checking_template", error_code: "demo_cast_not_a_colleague" });
  });

  it("orders phases by the pipeline, and lists more operations than one statement can name", async () => {
    const { env } = fixture();
    // A retried operation: attempt 1 died copying connections and its row
    // keeps the older `started_at`; attempt 2 has re-checked the template and
    // is creating the workspace. The page reads the list in order to find
    // where the operation is, so the order is the pipeline's — not the
    // clock's (the stale copy first), not insertion's (the same), and not the
    // phase name's (`copying` sorts before `creating`), which is what the
    // unique index would hand back without a sort.
    await startDemoOperation(env, request());
    const row = (phase: string, attempt: number, startedAt: string) => env.DB.prepare(
      `INSERT INTO demo_operation_phases (operation_id, phase, status, attempt, detail_json, started_at, finished_at)
       VALUES (?, ?, 'running', ?, '{}', ?, NULL)`,
    ).bind(OPERATION_ID, phase, attempt, startedAt);
    await env.DB.batch([
      row("copying_connections", 1, "2026-09-07T12:01:00.000Z"),
      row("checking_template", 2, "2026-09-07T13:00:00.000Z"),
      row("creating_workspace", 2, "2026-09-07T13:00:10.000Z"),
    ]);
    const status = await demoOperationStatus(env, OPERATION_ID);
    expect(status?.phases.map((phase) => [phase.phase, phase.attempt])).toEqual([
      ["checking_template", 2], ["creating_workspace", 2], ["copying_connections", 1],
    ]);

    // Every operation ever prepared is listed, and D1 refuses a statement past
    // its bound-parameter ceiling: past a hundred demos the list used to fail
    // for good, live ones included.
    const statements = Array.from({ length: 120 }, (_, index) => env.DB.prepare(
      `INSERT INTO demo_operations (operation_id, company_name, presenter_user_id, pack_version, cast_json, workspace_id,
         status, attempt, created_at, updated_at)
       VALUES (?, ?, ?, 'v1', '{}', NULL, 'ready', 1, ?, ?)`,
    ).bind(`00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`, `Company ${index}`, PRESENTER_ID, NOW, NOW));
    await env.DB.batch(statements);
    const listed = await listDemoOperations(env);
    expect(listed).toHaveLength(121);
  });

  it("is prepared in Global only, and says so when the driver is not bound", async () => {
    const enterprise = fixture({ AVALON_REGION: "enterprise" });
    await expect(startDemoOperation(enterprise.env, request())).rejects.toMatchObject({ code: "demo_region_unsupported" });
    const unbound = fixture({}, { withoutDriver: true });
    await expect(startDemoOperation(unbound.env, request())).rejects.toMatchObject({ code: "demo_preparation_unavailable" });
    expect(await unbound.env.DB.prepare("SELECT COUNT(*) AS count FROM demo_operations").first()).toEqual({ count: 0 });
  });
});

describe("the operator routes", () => {
  it("admit only the demos role, from the demo secret", async () => {
    const { env, app } = fixture();
    const anonymous = await app.request("/internal/demos", {}, env);
    expect(anonymous.status).toBe(401);
    // A telemetry token is not a credential here: the telemetry map is never read.
    const support = await app.request("/internal/demos", { headers: { authorization: `Bearer ${SUPPORT_TOKEN}` } }, env);
    expect(support.status).toBe(401);
    await expect(support.json()).resolves.toMatchObject({ error: { code: "operator_authentication_invalid" } });
    // A support principal filed in the demo map verifies and is refused by role.
    const misfiled = await app.request("/internal/demos", { headers: { authorization: `Bearer ${MISFILED_SUPPORT_TOKEN}` } }, env);
    expect(misfiled.status).toBe(403);
    await expect(misfiled.json()).resolves.toMatchObject({ error: { code: "operator_role_forbidden" } });
    const demos = await app.request("/internal/demos", { headers: { authorization: `Bearer ${DEMOS_TOKEN}` } }, env);
    expect(demos.status).toBe(200);
    await expect(demos.json()).resolves.toEqual({ operations: [] });

    // The template route answers the company's directory now, so its own door
    // is asserted rather than assumed from the router it shares.
    const anonymousTemplate = await app.request("/internal/demos/template", {}, env);
    expect(anonymousTemplate.status).toBe(401);
    const misfiledTemplate = await app.request("/internal/demos/template", { headers: { authorization: `Bearer ${MISFILED_SUPPORT_TOKEN}` } }, env);
    expect(misfiledTemplate.status).toBe(403);
    expect(await anonymousTemplate.text()).not.toContain("@rallywith.ai");
    expect(await misfiledTemplate.text()).not.toContain("@rallywith.ai");
  });

  it("refuses a bare name where an account id belongs: a typed name is sent as { name }", async () => {
    // A string is always an account id, so a name cannot be mistaken for one
    // and reach the directory read.
    const { env, app, launched } = fixture();
    const headers = { authorization: `Bearer ${DEMOS_TOKEN}`, "content-type": "application/json" };
    const named = await app.request("/internal/demos", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request(), cast: { priya: "Priya Raman", theo: "Ben Diaz" } }),
    }, env);
    expect(named.status).toBe(400);
    expect(launched).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM demo_operations").first()).toEqual({ count: 0 });
  });

  it("start, read and list an operation through the real rows, starting its Workflow once", async () => {
    const { env, app, launched } = fixture();
    const headers = { authorization: `Bearer ${DEMOS_TOKEN}`, "content-type": "application/json" };
    const body = JSON.stringify(request());
    const started = await app.request("/internal/demos", { method: "POST", headers, body }, env);
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({ operationId: OPERATION_ID, status: "running", attempt: 1 });
    // The route starts the real Workflow binding, with the pointer payload.
    expect(launched).toEqual([{ id: `demo-preparation-${OPERATION_ID}-1`, params: { region: "global", operationId: OPERATION_ID, attempt: 1 } }]);

    const repeated = await app.request("/internal/demos", { method: "POST", headers, body }, env);
    expect(repeated.status).toBe(200);
    expect(launched).toHaveLength(1);

    const read = await app.request(`/internal/demos/${OPERATION_ID}`, { headers }, env);
    await expect(read.json()).resolves.toMatchObject({ operationId: OPERATION_ID, companyName: "Alto Capital" });
    const listed = await app.request("/internal/demos", { headers }, env);
    await expect(listed.json()).resolves.toMatchObject({ operations: [{ operationId: OPERATION_ID }] });
    const missing = await app.request("/internal/demos/00000000-0000-7000-8000-00000000dead", { headers }, env);
    expect(missing.status).toBe(404);
  });

  it("answer the template's cast candidates, and retry through the route", async () => {
    const { env, app, launched } = fixture();
    const headers = { authorization: `Bearer ${DEMOS_TOKEN}`, "content-type": "application/json" };
    const template = await app.request("/internal/demos/template", { headers }, env);
    expect(template.status).toBe(200);
    const body = await template.json() as {
      workspaceId: string;
      pack: { roles: string[]; presenterRole: string | null; roleLabels: Record<string, string> };
      members: { userId: string; role: string }[];
      castCandidates: { userId: string; name: string; email: string }[];
      castEmailDomain: string;
    };
    expect(body.workspaceId).toBe(DEMO_TEMPLATE_WORKSPACE_ID);
    expect(body.pack.roles).toEqual(["presenter", "theo", "priya"]);
    expect(body.pack.presenterRole).toBe("presenter");
    // Each part is labelled, so the form's dropdowns say which one they are.
    expect(body.pack.roleLabels).toEqual({ theo: "Finance lead", priya: "Engineering lead" });
    // The presenter is chosen from the template's active members alone.
    expect(body.members.map((member) => member.userId)).toEqual([PRESENTER_ID]);
    // The rest are cast from the company's directory: everyone on its domain
    // who has signed in, by address, and nobody else — the outsider is on
    // another domain, so the form never offers them.
    expect(body.castEmailDomain).toBe("rallywith.ai");
    // By name, which is what the dropdown shows, with the address breaking the
    // tie between the two Sam Burtons.
    expect(body.castCandidates.map((candidate) => `${candidate.name} · ${candidate.email}`)).toEqual([
      "Adam · adam@rallywith.ai",
      "Ben Diaz · ben@rallywith.ai",
      "Priya Raman · priya@rallywith.ai",
      "Sam Burton · kb@rallywith.ai",
      "Sam Burton · sam.burton@rallywith.ai",
    ]);
    // Nadia is on the domain but has never signed in, so there is no account
    // to seat and she is not offered.
    expect(body.castCandidates.some((candidate) => candidate.userId === UNSEEN_ID)).toBe(false);

    await app.request("/internal/demos", { method: "POST", headers, body: JSON.stringify(request()) }, env);
    await env.DB.prepare("UPDATE demo_operations SET status = 'failed', failed_phase = 'seeding_conversations' WHERE operation_id = ?").bind(OPERATION_ID).run();
    const retried = await app.request(`/internal/demos/${OPERATION_ID}/retry`, { method: "POST", headers }, env);
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({ operationId: OPERATION_ID, status: "running", attempt: 2 });
    expect(launched.map((launch) => launch.id)).toEqual([`demo-preparation-${OPERATION_ID}-1`, `demo-preparation-${OPERATION_ID}-2`]);
    const unknown = await app.request("/internal/demos/00000000-0000-7000-8000-00000000dead/retry", { method: "POST", headers }, env);
    expect(unknown.status).toBe(404);
  });

  it("reject a malformed start and an unconfirmed abandon at the boundary", async () => {
    const { env, app, launched } = fixture();
    const headers = { authorization: `Bearer ${DEMOS_TOKEN}`, "content-type": "application/json" };
    const malformed = await app.request("/internal/demos", { method: "POST", headers, body: JSON.stringify({ operationId: "not-a-uuid", companyName: "" }) }, env);
    expect(malformed.status).toBe(400);
    expect(launched).toEqual([]);

    await app.request("/internal/demos", { method: "POST", headers, body: JSON.stringify(request()) }, env);
    const noBody = await app.request(`/internal/demos/${OPERATION_ID}/abandon`, { method: "POST", headers, body: "{}" }, env);
    expect(noBody.status).toBe(400);
    const wrong = await app.request(`/internal/demos/${OPERATION_ID}/abandon`, { method: "POST", headers, body: JSON.stringify({ confirmOperationId: "00000000-0000-7000-8000-00000000dead" }) }, env);
    expect(wrong.status).toBe(409);
    await expect(wrong.json()).resolves.toMatchObject({ error: { code: "demo_abandon_unconfirmed" } });
    expect((await row(env, OPERATION_ID)).status).toBe("running");
  });
});

describe("the Workflow instance id", () => {
  it("is one the platform accepts: hyphens only, under the length limit", () => {
    // The rule Cloudflare enforces on `create` (`workflows-shared` validators).
    // The first id joined its parts with colons and failed every production
    // launch while the fake driver here accepted anything.
    const id = demoPreparationInstanceId(OPERATION_ID, 12);
    expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id).toBe(`demo-preparation-${OPERATION_ID}-12`);
  });
});

describe("what the operator reads when a phase stops", () => {
  it("names the field a stored demo record failed, where it said demo_internal_error", () => {
    // The pack and the copied-connection rows are this repository's own
    // writes; one that no longer parses is a version skew, and the field is
    // the whole diagnosis. The rejection's text stays in the log.
    const rejection = z.strictObject({ cast: z.array(z.strictObject({ role: z.string() })) })
      .safeParse({ cast: [{ role: 42 }] });
    if (rejection.success) throw new Error("expected a rejection");

    expect(__demoPreparationTesting.operatorError(rejection.error)).toMatchObject({
      code: "demo_phase_invalid:cast.0.role:invalid_type",
    });
    expect(__demoPreparationTesting.operatorError(new Error("D1_ERROR: no such table")))
      .toMatchObject({ code: "demo_internal_error" });
  });

  it("names the field a stored cast failed in the reader that actually meets it", () => {
    // `castOf` answers a corrupt `cast_json` with an `ApiError` before the
    // phase's own error path runs, so the field has to be named here or it is
    // `demo_cast_unreadable` on the operator's page and nowhere else.
    let thrown: unknown;
    try {
      __demoPreparationTesting.castOf({ cast_json: JSON.stringify({ presenter: 42 }) } as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: expect.stringMatching(/^demo_cast_unreadable:.*invalid_type/u) });
  });
});
