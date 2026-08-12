import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { findConnectorOfferings } from "../src/services/connector-recommendation-service";

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const USER_ID = "00000000-0000-4000-8000-000000000000";
const OTHER_USER_ID = "00000000-0000-4000-8000-00000000000a";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const HARNESS_RUN_ID = "00000000-0000-4000-8000-000000000003";

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.values = values;
    return this;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return { success: true, meta: { changes: Number(result.changes) } } as unknown as D1Result<unknown>;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.statement.all(...this.values as SQLInputValue[]) as T[],
      meta: { changes: 0 },
    } as unknown as D1Result<T>;
  }
}

const openDatabases: DatabaseSync[] = [];
afterEach(() => {
  pluginCounter = 0;
  for (const database of openDatabases.splice(0)) database.close();
});

/**
 * A migrated database with two members and a work-stream run.
 *
 * The connector credentials here are load-bearing and partial on purpose. Only
 * Google and Slack are configured, so the availability filter has something to
 * exclude — and because an unbuildable registry deliberately fails open, a
 * fixture with no credentials at all would assert the fallback while believing
 * it asserted the filter. Every connector env var this fixture sets is one the
 * assertions below depend on.
 */
function fixture(): { database: DatabaseSync; env: Env } {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'g1', 'one@example.com', 'One', '2026-01-01', '2026-01-01'),
           ('${OTHER_USER_ID}', 'g2', 'two@example.com', 'Two', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Rec', 'rec', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Rec', 'Rec', 'ad_hoc', '${USER_ID}',
            'running', '2026-01-01', '2026-01-01', '2026-01-01');
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES ('${HARNESS_RUN_ID}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'test',
            '{"type":"user","userId":"${USER_ID}"}', 'running', '2026-08-03');
  `);
  return {
    database,
    env: {
      DB: {
        prepare: (sql: string) => new SqliteD1Statement(database.prepare(sql)) as unknown as D1PreparedStatement,
      } as unknown as D1Database,
      AVALON_REGION: "global",
      APP_ENV: "test",
      PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-secret",
      SLACK_CLIENT_ID: "slack-client",
      SLACK_CLIENT_SECRET: "slack-secret",
      SLACK_SIGNING_SECRET: "slack-signing-secret",
    } as Env,
  };
}

let pluginCounter = 0;

function addConnection(database: DatabaseSync, row: {
  id: string;
  connectorType: string;
  scope: "personal" | "workspace";
  ownerUserId: string | null;
  capabilities: string[];
  status?: string;
}): void {
  database.prepare(
    `INSERT INTO connector_connections
     (id, model_plugin_id, workspace_id, connector_type, scope, owner_user_id, display_name,
      granted_scopes_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01', '2026-01-01')`,
  ).run(
    row.id,
    // `^plugin_[a-z][a-z0-9_]*$` is enforced by a CHECK, so the suffix cannot
    // simply be the connection id.
    `plugin_${row.connectorType}_${(pluginCounter += 1)}`,
    WORKSPACE_ID,
    row.connectorType,
    row.scope,
    row.ownerUserId,
    row.connectorType,
    JSON.stringify(row.capabilities),
    row.status ?? "healthy",
  );
}

function freezeRunScope(database: DatabaseSync, connectionIds: string[]): void {
  database.prepare(
    `INSERT INTO harness_run_scopes
     (harness_run_id, workspace_id, workstream_id, attempt_id, execution_principal_json,
      eligible_connection_ids_json, routing_policy_version, prompt_version, tool_surface_hash,
      scope_hash, created_at)
     VALUES (?, ?, ?, 'attempt-1', ?, ?, 'v1', 'v1', 'hash', 'hash', '2026-08-03')`,
  ).run(
    HARNESS_RUN_ID,
    WORKSPACE_ID,
    WORKSTREAM_ID,
    JSON.stringify({ type: "user", userId: USER_ID }),
    JSON.stringify(connectionIds),
  );
}

const userRun = {
  workspaceId: WORKSPACE_ID,
  harnessRunId: HARNESS_RUN_ID,
  executionPrincipal: { type: "user" as const, userId: USER_ID },
};

describe("connector recommendation", () => {
  it("answers a two-category need with the one offering that covers both", async () => {
    const { env } = fixture();

    const found = await findConnectorOfferings(env, { ...userRun, categories: ["email", "calendar"] });

    // "Email my boss three open slots from my calendar" with nothing connected.
    const ids = found.map((offering) => offering.connector);
    expect(ids).toContain("google-mail-calendar");
    expect(ids).not.toContain("google-drive-workspace");
    expect(found.find((offering) => offering.connector === "google-mail-calendar")?.state)
      .toBe("not_connected");
  });

  it("stops recommending what this run can already use", async () => {
    const { database, env } = fixture();
    addConnection(database, {
      id: "00000000-0000-4000-8000-000000000010",
      connectorType: "google",
      scope: "personal",
      ownerUserId: USER_ID,
      capabilities: ["gmail.read", "gmail.send", "calendar.read"],
    });
    freezeRunScope(database, ["00000000-0000-4000-8000-000000000010"]);

    const found = await findConnectorOfferings(env, { ...userRun, categories: ["email"] });
    expect(found.map((offering) => offering.connector)).not.toContain("google-mail-calendar");

    // Unless somebody asked what they have.
    const including = await findConnectorOfferings(env, {
      ...userRun,
      categories: ["email"],
      includeConnected: true,
    });
    expect(including.find((offering) => offering.connector === "google-mail-calendar")?.state)
      .toBe("connected");
  });

  it("separates a connection made after the run was admitted from a usable one", async () => {
    const { database, env } = fixture();
    // The connection exists and every person looking at Settings sees it, but
    // the run's authority was frozen without it. A model told plainly
    // "connected" here announces it sent the email and then finds no tool.
    addConnection(database, {
      id: "00000000-0000-4000-8000-000000000011",
      connectorType: "google",
      scope: "personal",
      ownerUserId: USER_ID,
      capabilities: ["gmail.read", "gmail.send"],
    });
    freezeRunScope(database, []);

    const found = await findConnectorOfferings(env, { ...userRun, categories: ["email"] });

    const google = found.find((offering) => offering.connector === "google-mail-calendar");
    expect(google?.state).toBe("connected_not_yet_usable");
    expect(google?.hint).toMatch(/not available here/u);
  });

  it("reports a connection the provider stopped honouring as needing reconnection", async () => {
    const { database, env } = fixture();
    addConnection(database, {
      id: "00000000-0000-4000-8000-000000000012",
      connectorType: "slack",
      scope: "workspace",
      ownerUserId: null,
      capabilities: ["slack.agent"],
      status: "needs_reconnect",
    });
    freezeRunScope(database, []);

    const found = await findConnectorOfferings(env, { ...userRun, categories: ["messaging"] });
    expect(found.find((offering) => offering.connector === "slack")?.state).toBe("needs_reconnect");
  });

  it("never reports another member's personal connection", async () => {
    const { database, env } = fixture();
    addConnection(database, {
      id: "00000000-0000-4000-8000-000000000013",
      connectorType: "google",
      scope: "personal",
      ownerUserId: OTHER_USER_ID,
      capabilities: ["gmail.read", "gmail.send"],
    });
    freezeRunScope(database, []);

    const asUser = await findConnectorOfferings(env, {
      ...userRun,
      categories: ["email"],
      includeConnected: true,
    });
    // Not "you already have email" — that would describe a colleague's private
    // credential, and this run could not have used it either.
    expect(asUser.find((offering) => offering.connector === "google-mail-calendar")?.state)
      .toBe("not_connected");

    const asWorkspace = await findConnectorOfferings(env, {
      workspaceId: WORKSPACE_ID,
      harnessRunId: HARNESS_RUN_ID,
      executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
      categories: ["email"],
      includeConnected: true,
    });
    expect(asWorkspace.find((offering) => offering.connector === "google-mail-calendar")?.state)
      .toBe("not_connected");
  });

  it("requires every word of a query to match, so one shared word is not a hit", async () => {
    const { env } = fixture();

    const drive = await findConnectorOfferings(env, { ...userRun, query: "google drive" });
    expect(drive.map((offering) => offering.connector)).toEqual(["google-drive-workspace"]);

    const google = await findConnectorOfferings(env, { ...userRun, query: "google" });
    expect(google.map((offering) => offering.connector)).toEqual([
      "google-mail-calendar",
      "google-drive-workspace",
    ]);
  });

  it("omits a connector this region has no credentials for", async () => {
    const { env } = fixture();
    // The fixture configures Google and Slack only, so an unconfigured
    // connector must not be offered — pressing Connect on it would fail at the
    // provider with nothing the reader could do about it.
    const found = await findConnectorOfferings(env, { ...userRun, query: "notion" });
    expect(found).toEqual([]);
  });
});
