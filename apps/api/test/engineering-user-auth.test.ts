import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { engineeringUserAuth } from "../src/services/engineering-user-auth";
import { createTestEnv } from "./helpers/cloudflare-test";
import { openWorkstreamAuthorityForTest } from "./helpers/durable-authority";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * Whom an engineering tool may act as, decided by the real query over the
 * checked-in migrations. The two refusals have different remedies: another
 * user can pass where a member is missing, and nobody can where the
 * Organization is abandoned.
 */

const ORG_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ea1");
const OWNER_ID = asUserId("00000000-0000-7000-8000-000000000ea2");
const MEMBER_ID = asUserId("00000000-0000-7000-8000-000000000ea3");
const GUEST_ID = asUserId("00000000-0000-7000-8000-000000000ea4");
const SUSPENDED_ID = asUserId("00000000-0000-7000-8000-000000000ea5");
const STRANGER_ID = asUserId("00000000-0000-7000-8000-000000000ea6");
const AT = "2026-11-10T00:00:00.000Z";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** An Organization the region serves: its identity, four relationships, and an open authority generation. */
function fixture() {
  const database = migratedSqliteDatabase();
  databases.push(database);
  const user = (id: string, key: string) =>
    `INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
     VALUES ('${id}', '${key}', '${key}@example.com', '${key}', '${AT}', '${AT}');`;
  database.exec(`
    ${user(OWNER_ID, "owner")}
    ${user(MEMBER_ID, "member")}
    ${user(GUEST_ID, "guest")}
    ${user(SUSPENDED_ID, "suspended")}
    ${user(STRANGER_ID, "stranger")}
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${ORG_ID}', 'Auth Organization', 'auth-organization', 'global', '${OWNER_ID}', '${AT}', '${AT}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, access_class) VALUES
      ('${ORG_ID}', '${OWNER_ID}', 'owner', 'active', 'member'),
      ('${ORG_ID}', '${MEMBER_ID}', 'member', 'active', 'member'),
      ('${ORG_ID}', '${GUEST_ID}', NULL, 'active', 'guest'),
      ('${ORG_ID}', '${SUSPENDED_ID}', 'member', 'suspended', 'member');
  `);
  openWorkstreamAuthorityForTest(database, AT);
  return { database, env: createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" }) };
}

describe("whom an engineering tool may act as", () => {
  it("admits an active member with their role, and an active guest with none", async () => {
    const { env } = fixture();

    expect(await engineeringUserAuth(env, ORG_ID, MEMBER_ID)).toEqual({
      sessionId: "engineering-read", workspaceId: ORG_ID, userId: MEMBER_ID, region: "global",
      role: "member", principal: "engineering",
    });
    expect(await engineeringUserAuth(env, ORG_ID, GUEST_ID, { operationId: "send-1" })).toEqual({
      sessionId: "send-1", workspaceId: ORG_ID, userId: GUEST_ID, region: "global",
      role: null, principal: "engineering",
    });
  });

  it("refuses a suspended member and a user with no relationship as not an active user", async () => {
    const { env } = fixture();

    await expect(engineeringUserAuth(env, ORG_ID, SUSPENDED_ID))
      .rejects.toMatchObject({ status: 403, code: "user_not_active_organization_user" });
    await expect(engineeringUserAuth(env, ORG_ID, STRANGER_ID))
      .rejects.toMatchObject({ status: 403, code: "user_not_active_organization_user" });
  });

  it("refuses everyone in an abandoned Organization by naming the abandonment, its active owner included", async () => {
    const { database, env } = fixture();
    database.exec(`UPDATE workspaces SET abandoned_at = '${AT}' WHERE id = '${ORG_ID}'`);

    await expect(engineeringUserAuth(env, ORG_ID, OWNER_ID))
      .rejects.toMatchObject({ status: 409, code: "organization_abandoned" });
    // The Organization's state is the cause whoever was named, so it is not
    // reported as that user's missing membership.
    await expect(engineeringUserAuth(env, ORG_ID, STRANGER_ID))
      .rejects.toMatchObject({ status: 409, code: "organization_abandoned" });
  });

  it("admits an active user into an abandoned Organization for a caller that asks, and still refuses a user with no relationship", async () => {
    const { database, env } = fixture();
    database.exec(`UPDATE workspaces SET abandoned_at = '${AT}' WHERE id = '${ORG_ID}'`);

    expect(await engineeringUserAuth(env, ORG_ID, OWNER_ID, { abandoned: "admit" })).toEqual({
      sessionId: "engineering-read", workspaceId: ORG_ID, userId: OWNER_ID, region: "global",
      role: "owner", principal: "engineering",
    });
    await expect(engineeringUserAuth(env, ORG_ID, STRANGER_ID, { abandoned: "admit" }))
      .rejects.toMatchObject({ status: 403, code: "user_not_active_organization_user" });
  });
});
