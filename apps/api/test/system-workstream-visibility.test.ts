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
    VALUES ('${OWNER}', 'g-owner', 'owner@example.com', 'Owner', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
           ('${OTHER}', 'g-other', 'other@example.com', 'Other', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${OWNER}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '2026-01-01T00:00:00.000Z'),
           ('${WORKSPACE}', '${OTHER}', 'member', 'active', '2026-01-01T00:00:00.000Z');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, email_address, email_route_status, origin_type,
       created_by_user_id, harness_status, next_sequence_number, last_activity_at,
       created_at, updated_at, system_kind)
    VALUES
      ('${ORDINARY}', '${WORKSPACE}', 'Launch', '', 'launch@automation.example', 'active', 'ad_hoc',
       '${OWNER}', 'idle', 1, '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
      ('${HIDDEN}', '${WORKSPACE}', 'Digest · Owner', '', 'digest@automation.example', 'active', 'ad_hoc',
       '${OWNER}', 'idle', 1, '2026-01-03T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'digest');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${HIDDEN}', '${OWNER}', '${OWNER}', 'creator', '2026-01-01T00:00:00.000Z');
  `);
  return database;
}

describe("system work streams", () => {
  it("stays out of the sidebar by default, even for the person it belongs to", async () => {
    const page = await serviceFor(seededDatabase(), OWNER).list(20);

    expect(page.items.map((item) => item.id)).toEqual([ORDINARY]);
  });

  it("appears, marked as system, when the reader asks for it", async () => {
    // Application -> Developer -> Debug enabled is what asks. It widens what is
    // shown, never who may see it.
    const page = await serviceFor(seededDatabase(), OWNER).list(20, undefined, true);

    expect(page.items.map((item) => item.id)).toEqual([HIDDEN, ORDINARY]);
    expect(page.items.find((item) => item.id === HIDDEN)?.systemKind).toBe("digest");
    expect(page.items.find((item) => item.id === ORDINARY)?.systemKind).toBeNull();
  });

  it("stays invisible to another member even when they ask for system rows", async () => {
    // The brief inside it is assembled from one person's private activity, so
    // asking to see system work streams shows only your own.
    const page = await serviceFor(seededDatabase(), OTHER).list(20, undefined, true);

    expect(page.items.map((item) => item.id)).toEqual([ORDINARY]);
  });

  it("opens by id for its own participant", async () => {
    const detail = await serviceFor(seededDatabase(), OWNER).get(HIDDEN);

    expect(detail).toMatchObject({ id: HIDDEN, systemKind: "digest" });
  });

  it("cannot be opened by another member who knows its id", async () => {
    await expect(serviceFor(seededDatabase(), OTHER).get(HIDDEN))
      .rejects.toMatchObject({ status: 404 });
  });
});
