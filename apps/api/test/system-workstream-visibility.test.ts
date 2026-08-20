import { asUserId, type UserId } from "@avalon/contracts";
import { asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { WorkstreamService } from "../src/services/workstream-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";

/** Which work streams the list asked to have an inbound address reserved for. */
const backfilled: string[] = [];
vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async ensureWorkstreamAddress() { return { emailAddress: null }; }
    async backfillWorkstreamAddresses(rows: Array<{ workstreamId: string }>) {
      backfilled.push(...rows.map((row) => row.workstreamId));
      return [];
    }
  },
}));

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const OWNER = asUserId("00000000-0000-7000-8000-000000000002");
const OTHER = asUserId("00000000-0000-7000-8000-000000000003");
const ORDINARY = "00000000-0000-7000-8000-000000000004";
const HIDDEN = "00000000-0000-7000-8000-000000000005";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  backfilled.length = 0;
});

function serviceFor(database: DatabaseSync, userId: UserId): WorkstreamService {
  const auth: AuthContext = {
    sessionId: "session-1", userId, workspaceId: WORKSPACE, region: "global", role: "member",
  };
  return new WorkstreamService(
    createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" }),
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
       created_at, updated_at, system_kind, scope)
    VALUES
      ('${ORDINARY}', '${WORKSPACE}', 'Launch', '', 'launch@automation.example', 'active', 'ad_hoc',
       '${OWNER}', 'idle', 1, '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'workspace'),
      ('${HIDDEN}', '${WORKSPACE}', 'Digest · Owner', '', 'digest@automation.example', 'active', 'ad_hoc',
       '${OWNER}', 'idle', 1, '2026-01-03T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'digest', 'personal');
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

    // Paged with everything else, in recency order: `HIDDEN` is the newer row.
    expect(page.items.map((item) => item.id)).toEqual([HIDDEN, ORDINARY]);
    expect(page.items.find((item) => item.id === HIDDEN)).toMatchObject({
      systemKind: "digest",
      // Declared private, the same way a personal note is, rather than left for
      // a caller to infer from `systemKind`.
      scope: "personal",
    });
    expect(page.items.find((item) => item.id === ORDINARY)).toMatchObject({
      systemKind: null,
      scope: "workspace",
    });
  });

  it("never reserves an inbound mailbox for machinery", async () => {
    const database = seededDatabase();
    const occurrence = '00000000-0000-7000-8000-000000000009';
    // Inserted exactly as `createDigestWorkstream` writes one — no address, no
    // route — rather than blanking the seeded row, which a trigger refuses:
    // work-stream addresses are immutable once assigned.
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
         next_sequence_number, last_activity_at, created_at, updated_at, system_kind, scope)
      VALUES ('${occurrence}', '${WORKSPACE}', 'Digest · 12 Aug · 9:00 AM', '', 'ad_hoc',
              '${OWNER}', 'idle', 1, '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z',
              '2026-01-04T00:00:00.000Z', 'digest', 'personal');
      INSERT INTO workstream_participants
        (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
      VALUES ('${occurrence}', '${OWNER}', '${OWNER}', 'creator', '2026-01-04T00:00:00.000Z');
    `);

    const page = await serviceFor(database, OWNER).list(20, undefined, true);

    expect(page.items.map((item) => item.id)).toContain(occurrence);

    // Reserving one activates a route in the global registry and nothing
    // reclaims it, so with a work stream per digest occurrence this would mint
    // a permanent mailbox per occurrence — and make a run emailable.
    expect(backfilled).toEqual([]);
    expect(page.items.find((item) => item.id === occurrence)?.emailAddress ?? null).toBeNull();
  });

  it("stays invisible to another member even when they ask for system rows", async () => {
    // The brief inside it is assembled from one person's private activity, so
    // asking to see system work streams shows only your own.
    const page = await serviceFor(seededDatabase(), OTHER).list(20, undefined, true);

    expect(page.items.map((item) => item.id)).toEqual([ORDINARY]);
  });

  it("opens by id for its own participant", async () => {
    const detail = await serviceFor(seededDatabase(), OWNER).get(HIDDEN);

    expect(detail).toMatchObject({ id: HIDDEN, systemKind: "digest", scope: "personal" });
  });

  it("is private because it says so, not because it is machinery", async () => {
    const database = seededDatabase();
    // A private work stream that is not machinery is refused just the same, so
    // privacy does not depend on anyone remembering to check `system_kind`.
    database.exec(`UPDATE workstreams SET system_kind = NULL WHERE id = '${HIDDEN}'`);

    await expect(serviceFor(database, OTHER).get(HIDDEN)).rejects.toMatchObject({ status: 404 });
    expect((await serviceFor(database, OTHER).list(20)).items.map((item) => item.id)).toEqual([ORDINARY]);
    // Its own participant still reaches it, and now sees it in the ordinary
    // list, because it is no longer machinery.
    expect((await serviceFor(database, OWNER).list(20)).items.map((item) => item.id))
      .toEqual([HIDDEN, ORDINARY]);
  });

  it("cannot be opened by another member who knows its id", async () => {
    await expect(serviceFor(seededDatabase(), OTHER).get(HIDDEN))
      .rejects.toMatchObject({ status: 404 });
  });
});
