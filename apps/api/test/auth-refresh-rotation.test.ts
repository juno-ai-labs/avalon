import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { sha256 } from "../src/lib/crypto";
import { AuthService } from "../src/services/auth-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const USER = "00000000-0000-7000-8000-000000000001";
const DAY_MS = 24 * 60 * 60 * 1_000;
const TOKEN = "refresh-token-with-more-than-twenty-characters";

const databases: DatabaseSync[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function service(database: DatabaseSync): AuthService {
  return new AuthService(createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    SESSION_SIGNING_KEY: "global-session-signing-key-with-enough-entropy",
  }));
}

/** A member signed in on one device with the account identity session. */
async function seedSession(): Promise<DatabaseSync> {
  const database = migratedSqliteDatabase();
  databases.push(database);
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, ?, 'member@example.test', 'Member', ?, ?)`,
  ).run(USER, `google-${USER}`, now, now);
  database.prepare(
    `INSERT INTO sessions(id, user_id, workspace_id, region, refresh_token_hash, expires_at, created_at)
     VALUES ('session-1', ?, NULL, 'global', ?, ?, ?)`,
  ).run(USER, await sha256(TOKEN), new Date(Date.now() + DAY_MS).toISOString(), now);
  return database;
}

/** The device slept: the last rotation now lies hours in the past. */
function sleepThreeHours(database: DatabaseSync): void {
  database.prepare("UPDATE sessions SET refresh_rotated_at = ? WHERE id = 'session-1'")
    .run(new Date(Date.now() - 3 * 60 * 60 * 1_000).toISOString());
}

describe("a retired refresh token stays valid until its successor is used", () => {
  it("renews with the retired token hours after the successor's response was lost", async () => {
    const database = await seedSession();
    await service(database).refresh(TOKEN); // The answer never reached the device.
    sleepThreeHours(database);

    const recovered = await service(database).refresh(TOKEN);

    await expect(service(database).refresh(recovered.refreshToken)).resolves.toMatchObject({
      user: { email: "member@example.test" },
      workspace: null,
    });
  });

  it("keeps the retired token through repeated lost responses", async () => {
    const database = await seedSession();
    await service(database).refresh(TOKEN);
    sleepThreeHours(database);
    await service(database).refresh(TOKEN); // Lost again.
    sleepThreeHours(database);

    await expect(service(database).refresh(TOKEN)).resolves.toMatchObject({ workspace: null });
  });

  it("retires the earlier token once the device presents its successor", async () => {
    const database = await seedSession();
    const successor = await service(database).refresh(TOKEN);
    await service(database).refresh(successor.refreshToken);

    await expect(service(database).refresh(TOKEN)).rejects.toMatchObject({
      status: 401,
      code: "invalid_refresh_token",
    });
  });

  it("signs the session out when the retired token is presented to logout", async () => {
    const database = await seedSession();
    const successor = await service(database).refresh(TOKEN);
    sleepThreeHours(database);

    await service(database).logout({ refreshToken: TOKEN });

    await expect(service(database).refresh(successor.refreshToken)).rejects.toMatchObject({
      status: 401,
      code: "invalid_refresh_token",
    });
  });
});
