import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { WorkstreamService } from "../src/services/workstream-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async ensureWorkstreamAddress() { return { emailAddress: null }; }
    async backfillWorkstreamAddresses() { return []; }
  },
}));

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const OWNER = "00000000-0000-7000-8000-000000000002";
const OTHER = "00000000-0000-7000-8000-000000000003";
const ORDINARY = "00000000-0000-7000-8000-000000000004";
const HIDDEN = "00000000-0000-7000-8000-000000000005";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function serviceFor(database: DatabaseSync, userId: string): WorkstreamService {
  const auth: AuthContext = {
    sessionId: "session-1", userId, workspaceId: WORKSPACE, region: "global", role: "member",
  };
  return new WorkstreamService(
    { DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" } as unknown as Env,
    auth,
  );
}

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${OWNER}', 'g-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
           ('${OTHER}', 'g-other', 'other@example.com', 'Other', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${OWNER}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '2026-01-01'),
           ('${WORKSPACE}', '${OTHER}', 'member', 'active', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, email_address, email_route_status, origin_type,
       created_by_user_id, harness_status, next_sequence_number, last_activity_at,
       created_at, updated_at, system_kind)
    VALUES
      ('${ORDINARY}', '${WORKSPACE}', 'Launch', '', 'launch@automation.example', 'active', 'ad_hoc',
       '${OWNER}', 'idle', 1, '2026-01-02', '2026-01-01', '2026-01-01', NULL),
      ('${HIDDEN}', '${WORKSPACE}', 'Digest · Owner', '', 'digest@automation.example', 'active', 'ad_hoc',
       '${OWNER}', 'idle', 1, '2026-01-03', '2026-01-01', '2026-01-01', 'digest');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${HIDDEN}', '${OWNER}', '${OWNER}', 'creator', '2026-01-01');
  `);
  return database;
}

describe("hidden system work streams", () => {
  it("is left out of the sidebar for the person it belongs to", async () => {
    const page = await serviceFor(seededDatabase(), OWNER).list(20);

    expect(page.items.map((item) => item.id)).toEqual([ORDINARY]);
  });

  it("is left out of the sidebar for everyone else", async () => {
    const page = await serviceFor(seededDatabase(), OTHER).list(20);

    expect(page.items.map((item) => item.id)).toEqual([ORDINARY]);
  });

  it("cannot be opened by id, even by its own participant", async () => {
    // The brief inside it is assembled from one person's private activity, so
    // being absent from a listing is not enough — knowing the id must not work.
    await expect(serviceFor(seededDatabase(), OWNER).get(HIDDEN))
      .rejects.toMatchObject({ status: 404 });
  });

  it("cannot be opened by another member who knows its id", async () => {
    await expect(serviceFor(seededDatabase(), OTHER).get(HIDDEN))
      .rejects.toMatchObject({ status: 404 });
  });
});
