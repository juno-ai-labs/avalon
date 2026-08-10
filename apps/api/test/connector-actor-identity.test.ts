import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import {
  recordConnectorActorIdentity,
  resolveConnectorActorIdentity,
} from "../src/services/connector-actor-identity";

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("connector actor identity", () => {
  const linearActor = {
    provider: "linear",
    providerAccountId: "org-avalon",
    providerUserId: "linear-user-taylor",
    displayName: "Taylor",
    avatarUrl: null,
  };

  it("resolves any connector's actor from a member's own personal connection", async () => {
    const database = seededDatabase();
    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, granted_scopes_json, status, cursor_json, config_json,
         created_at, updated_at, model_plugin_id)
      VALUES ('connection-linear', 'workspace-1', 'linear', 'personal', 'user-taylor',
              'linear-user-taylor', 'Linear', '[]', 'healthy', '{}', '{}',
              '2026-01-01', '2026-01-01', 'plugin_linear');
    `);
    const env = { DB: sqliteD1(database) } as unknown as Env;

    await expect(resolveConnectorActorIdentity(env, "workspace-1", linearActor)).resolves.toEqual({
      userId: "user-taylor",
      verification: "personal_connection",
    });
  });

  it("prefers a recorded account link over every weaker mapping", async () => {
    const database = seededDatabase();
    const env = { DB: sqliteD1(database) } as unknown as Env;

    await recordConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      { userId: "user-jordan", verification: "account_link" },
      "jordan@example.com",
    );

    await expect(resolveConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      "taylor@example.com",
    )).resolves.toEqual({ userId: "user-jordan", verification: "account_link" });
  });

  it("falls back to a verified email that exactly one active member holds", async () => {
    const database = seededDatabase();
    const env = { DB: sqliteD1(database) } as unknown as Env;

    await expect(resolveConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      "  Taylor@Example.com ",
    )).resolves.toEqual({ userId: "user-taylor", verification: "verified_email" });
  });

  it("resolves nobody for an unknown actor, a suspended member, or another workspace", async () => {
    const database = seededDatabase();
    const env = { DB: sqliteD1(database) } as unknown as Env;

    await expect(resolveConnectorActorIdentity(env, "workspace-1", linearActor)).resolves.toBeNull();
    await expect(resolveConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      "former@example.com",
    )).resolves.toBeNull();

    await recordConnectorActorIdentity(
      env,
      "workspace-2",
      linearActor,
      { userId: "user-taylor", verification: "account_link" },
      null,
    );
    await expect(resolveConnectorActorIdentity(env, "workspace-1", linearActor)).resolves.toBeNull();
  });

  it("keeps the strongest mapping current as a connector re-verifies it", async () => {
    const database = seededDatabase();
    const env = { DB: sqliteD1(database) } as unknown as Env;

    await recordConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      { userId: "user-taylor", verification: "verified_email" },
      "taylor@example.com",
    );
    await recordConnectorActorIdentity(
      env,
      "workspace-1",
      linearActor,
      { userId: "user-taylor", verification: "account_link" },
      null,
    );

    expect(database.prepare(
      `SELECT user_id, email, display_name, verification_source
       FROM external_user_identities WHERE workspace_id = 'workspace-1'`,
    ).all()).toEqual([{
      user_id: "user-taylor",
      email: "taylor@example.com",
      display_name: "Taylor",
      verification_source: "account_link",
    }]);
  });
});

function seededDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('user-taylor', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01'),
      ('user-jordan', 'google-jordan', 'jordan@example.com', 'Jordan', '2026-01-01', '2026-01-01'),
      ('user-former', 'google-former', 'former@example.com', 'Former', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES
      ('workspace-1', 'One', 'one', 'global', 'user-owner', '2026-01-01', '2026-01-01'),
      ('workspace-2', 'Two', 'two', 'global', 'user-owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES
      ('workspace-1', 'user-owner', 'owner', 'active', '2026-01-01'),
      ('workspace-1', 'user-taylor', 'member', 'active', '2026-01-01'),
      ('workspace-1', 'user-jordan', 'member', 'active', '2026-01-01'),
      ('workspace-1', 'user-former', 'member', 'suspended', '2026-01-01'),
      ('workspace-2', 'user-owner', 'owner', 'active', '2026-01-01'),
      ('workspace-2', 'user-taylor', 'member', 'active', '2026-01-01');
  `);
  return database;
}

function sqliteD1(database: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first<T>() {
        return (database.prepare(sql).get(...values as SQLInputValue[]) as T | undefined) ?? null;
      },
      async all<T>() {
        return {
          success: true,
          results: database.prepare(sql).all(...values as SQLInputValue[]) as T[],
          meta: { changes: 0 },
        } as unknown as D1Result<T>;
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as SQLInputValue[]);
        return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result<T>;
      },
    };
    return statement as unknown as D1PreparedStatement;
  };
  return {
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results as D1Result<T>[];
    },
  } as unknown as D1Database;
}
