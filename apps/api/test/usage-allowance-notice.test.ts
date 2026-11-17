import { afterEach, describe, expect, it, vi } from "vitest";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import { noticeUsageAllowanceExhausted } from "../src/services/usage-allowance-notice";
import type * as UsageMetering from "../src/services/usage-metering";

// The publish reaches a Durable Object this suite does not run; what is under test is who is emailed.
vi.mock("../src/services/usage-metering", async (importActual) => ({
  ...await importActual<typeof UsageMetering>(),
  publishOrganizationUsage: vi.fn(async () => undefined),
}));

const WORKSPACE = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b7b01";
const SIGNED_IN = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b7b02";
const ADDED = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b7b03";
const AT = "2026-11-01T00:00:00.000Z";

describe("the usage allowance email", () => {
  const databases: Array<{ close: () => void }> = [];
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });

  it("goes to administrators who have signed in, and not to one added who never has", async () => {
    const database = migratedSqliteDatabase();
    databases.push(database);
    database.prepare(`INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?,?,?,?,?),(?,?,?,?,?)`)
      .run(SIGNED_IN, "owner@example.com", "Owner", AT, AT, ADDED, "added@example.com", "added@example.com", AT, AT);
    database.prepare(`INSERT INTO workspaces (id,name,slug,region,created_by_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(WORKSPACE, "Juno Labs", "juno-labs", "global", SIGNED_IN, AT, AT);
    database.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,access_class,status,joined_at) VALUES (?,?,?,?,?,?),(?,?,?,?,?,?)`)
      .run(WORKSPACE, SIGNED_IN, "owner", "member", "active", AT, WORKSPACE, ADDED, "admin", "member", "active", AT);
    database.prepare(`INSERT INTO sessions (id,user_id,workspace_id,region,refresh_token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run("session-owner", SIGNED_IN, WORKSPACE, "global", "hash-owner", "2099-01-01T00:00:00.000Z", AT);
    const send = vi.fn(async () => ({ messageId: "sent" }));
    const env = createTestEnv({
      DB: sqliteD1(database), APP_ENV: "production", AVALON_REGION: "global", PUBLIC_WEB_BASE_URL: "https://rallywith.ai",
      EMAIL_FROM: "Rally <notify@rallywith.ai>", EMAIL: { send },
    });
    await noticeUsageAllowanceExhausted(env, { workspaceId: WORKSPACE, weekStart: "2026-11-16", resetsAt: "2026-11-23T00:00:00.000Z" });
    expect((send.mock.calls as unknown as Array<[{ to: string }]>).map(([message]) => message.to)).toEqual(["owner@example.com"]);
  });
});
