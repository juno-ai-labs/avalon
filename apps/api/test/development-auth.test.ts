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
});
