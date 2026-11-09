import { afterEach, describe, expect, it } from "vitest";

import { AuthService, DEVELOPMENT_USER_ID } from "../src/services/auth-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

describe("development authentication", () => {
  const databases: ReturnType<typeof migratedSqliteDatabase>[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("retains an identity session beside the seeded workspace session", async () => {
    const database = migratedSqliteDatabase();
    databases.push(database);
    const service = new AuthService(createTestEnv({
      APP_ENV: "development",
      RALLY_DEV_AUTH: "true",
      AVALON_REGION: "global",
      DB: sqliteD1(database),
      PUBLIC_API_BASE_URL: "http://127.0.0.1:8787",
    }));

    const workspace = await service.createDevelopmentSession("Rally Development");
    const identity = await service.createDevelopmentIdentitySession();

    expect(workspace).toMatchObject({
      user: { id: DEVELOPMENT_USER_ID },
      workspace: { name: "Rally Development", region: "global" },
    });
    expect(identity).toMatchObject({
      user: { id: DEVELOPMENT_USER_ID },
      workspace: null,
      apiBaseUrl: "http://127.0.0.1:8787",
    });
  });

  it("keeps the Organization's stored name when the development account signs in again with another", async () => {
    const database = migratedSqliteDatabase();
    databases.push(database);
    const service = new AuthService(createTestEnv({
      APP_ENV: "development",
      RALLY_DEV_AUTH: "true",
      AVALON_REGION: "global",
      DB: sqliteD1(database),
      PUBLIC_API_BASE_URL: "http://127.0.0.1:8787",
    }));
    const first = await service.createDevelopmentSession();
    // The desktop's sign-in sends its onboarding name; a bare POST /auth/dev/session takes the default.
    await expect(service.createDevelopmentSession("Rally Development"))
      .resolves.toMatchObject({ workspace: { id: first.workspace!.id, name: "Avalon Development" } });
    expect(database.prepare("SELECT name FROM workspaces WHERE id = ?").get(first.workspace!.id))
      .toEqual({ name: "Avalon Development" });
  });

  it("reopens the fixed development authority after its final member closes it", async () => {
    const database = migratedSqliteDatabase();
    databases.push(database);
    const service = new AuthService(createTestEnv({
      APP_ENV: "development",
      RALLY_DEV_AUTH: "true",
      AVALON_REGION: "global",
      DB: sqliteD1(database),
      PUBLIC_API_BASE_URL: "http://127.0.0.1:8787",
    }));
    const first = await service.createDevelopmentSession("Rally Development");
    database.prepare("UPDATE workspaces SET abandoned_at = ? WHERE id = ?")
      .run("2026-09-01T00:00:00.000Z", first.workspace!.id);
    database.prepare("UPDATE workspace_members SET status = 'suspended' WHERE workspace_id = ?")
      .run(first.workspace!.id);

    await expect(service.createDevelopmentSession("Rally Development"))
      .resolves.toMatchObject({ workspace: { id: first.workspace!.id } });
    expect(database.prepare("SELECT abandoned_at FROM workspaces WHERE id = ?").get(first.workspace!.id))
      .toEqual({ abandoned_at: null });
  });
});
