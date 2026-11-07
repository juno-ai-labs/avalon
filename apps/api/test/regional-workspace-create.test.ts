import "../../../tests/isolated-region";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { sha256 } from "../src/lib/crypto";
import { RegionalOnboardingService } from "../src/services/platform-onboarding-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * Creating an Organization in its region, against the checked-in migrations.
 *
 * The create writes the Organization, its owner, the journal entry and the
 * creator's session in one batch, then initializes the object once. Nobody is
 * seated anywhere: there is no General or Personal Channel any more.
 */

const platformUserId = asUserId("00000000-0000-7000-8000-00000000c001");
const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000c002");
const operationId = "00000000-0000-7000-8000-00000000c003";
const at = "2026-10-07T00:00:00.000Z";

let database: DatabaseSync;
let initialized: unknown[][];

function workspaceObjects(): Env["WORKSPACE_DOS"] {
  const stub = {
    initializeWorkspace: (...args: unknown[]) => {
      initialized.push(args);
      return Promise.resolve();
    },
  };
  const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
  });
  return binding;
}

function service(): RegionalOnboardingService {
  return new RegionalOnboardingService(createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "development",
    LOG_LEVEL: "error",
    SESSION_SIGNING_KEY: "regional-workspace-create-signing-key",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    WORKSPACE_DOS: workspaceObjects(),
  }));
}

function create() {
  return service().create({
    identity: {
      accountOnboarding: { eligible: true, introduced: true, presentation: null, revision: 0 },
      platformUserId,
      loginIdentities: [{ provider: "google", subject: "creator-google" }],
      email: "creator@example.test",
      name: "Creator",
      avatarUrl: null,
      timezone: "America/Los_Angeles",
      createdAt: at,
    },
    operationId,
    workspaceId,
    placementAffinity: "wnam",
    name: "Northwind",
    preference: { preferenceSubjectHandle: "00000000-0000-7000-8000-00000000c004", enabled: true, version: 1 },
  });
}

function openAuthority(): void {
  database.exec(`
    UPDATE workstream_authority_control SET phase = 'maintenance_draining', generation = 1, updated_at = '${at}' WHERE id = 1;
    UPDATE workstream_authority_control SET phase = 'maintenance_importing' WHERE id = 1;
    UPDATE workstream_authority_control SET phase = 'maintenance_verified' WHERE id = 1;
    UPDATE workstream_authority_control SET phase = 'durable_object_open', serving_contract_version = 1 WHERE id = 1;
  `);
}

beforeEach(() => {
  database = migratedSqliteDatabase();
  initialized = [];
  database.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at, platform_user_id)
    VALUES (?, 'creator-google', 'creator@example.test', 'Creator', ?, ?, ?)`).run(platformUserId, at, at, platformUserId);
});

afterEach(() => database.close());

describe("creating an Organization in its region", () => {
  it("writes the Organization, its owner and a usable session, anchors no Channel, and initializes the object", async () => {
    openAuthority();

    const session = await create();

    expect(session.workspace).toMatchObject({ id: workspaceId, name: "Northwind", role: "owner", region: "global" });
    expect(database.prepare(
      "SELECT role, status FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).get(workspaceId, platformUserId)).toEqual({ role: "owner", status: "active" });
    expect(database.prepare(
      "SELECT workspace_id, revoked_at FROM sessions WHERE user_id = ? AND refresh_token_hash = ?",
    ).get(platformUserId, await sha256(session.refreshToken))).toEqual({ workspace_id: workspaceId, revoked_at: null });
    expect(database.prepare("SELECT COUNT(*) AS routes FROM workstream_authority_routes WHERE workspace_id = ?")
      .get(workspaceId)).toEqual({ routes: 0 });
    expect(initialized).toEqual([[workspaceId, "wnam"]]);
  });
});
