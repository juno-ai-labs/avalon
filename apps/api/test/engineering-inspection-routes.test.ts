import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import {
  resolveInspectionWorkspaceRoute,
  resolveInspectionWorkstreamRoute,
  searchInspectionOrganizations,
  searchInspectionUsers,
} from "../src/engineering-inspection-routes";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ec1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000ec2");
const USER_ID = "00000000-0000-7000-8000-000000000ec3";
const AT = "2026-08-30T00:00:00.000Z";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'inspection-user', 'inspection@example.com', 'Inspector', '${AT}', '${AT}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Inspection workspace', 'inspection-workspace', 'global',
            '${USER_ID}', '${AT}', '${AT}');
    INSERT INTO workstreams (id, workspace_id, do_identity_anchor)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 1);
  `);
  return {
    database,
    env: { DB: sqliteD1(database), AVALON_REGION: "global" as const },
  };
}

function beginImport(database: DatabaseSync): void {
  database.exec(`
    UPDATE workstream_authority_control
       SET phase = 'maintenance_draining', generation = 3, updated_at = '${AT}'
     WHERE id = 1;
    INSERT INTO workstream_authority_routes
      (workspace_id, workstream_id, generation, object_name, state,
       source_fence_sequence, updated_at)
    VALUES ('${WORKSPACE_ID}', '${WORKSTREAM_ID}', 3,
            'global:${WORKSPACE_ID}:${WORKSTREAM_ID}', 'pending', 0, '${AT}');
    UPDATE workstream_authority_control
       SET phase = 'maintenance_importing', updated_at = '${AT}'
     WHERE id = 1;
  `);
}

function openAuthority(database: DatabaseSync): void {
  database.exec(`
    UPDATE workstream_authority_routes SET state = 'verified', updated_at = '${AT}';
    UPDATE workstream_authority_control
       SET phase = 'maintenance_verified', updated_at = '${AT}'
     WHERE id = 1;
    UPDATE workstream_authority_routes SET state = 'active', updated_at = '${AT}';
    UPDATE workstream_authority_control
       SET phase = 'durable_object_open', serving_contract_version = 1, updated_at = '${AT}'
     WHERE id = 1;
  `);
}

describe("engineering inspection authority routing", () => {
  it("resolves a workspace from its regional identity", async () => {
    const { database, env } = fixture();
    beginImport(database);
    openAuthority(database);
    await expect(resolveInspectionWorkspaceRoute(env, WORKSPACE_ID)).resolves.toMatchObject({
      id: WORKSPACE_ID,
      authority_state: "active",
      authority_generation: 3,
    });
    await expect(resolveInspectionWorkspaceRoute(env, WORKSPACE_ID, 3)).resolves.toMatchObject({
      id: WORKSPACE_ID,
    });
    expect(await resolveInspectionWorkspaceRoute(env, WORKSPACE_ID, 4)).toBeNull();
  });

  it("refuses pending and verified routes until their generation is open and active", async () => {
    const { database, env } = fixture();

    expect(await resolveInspectionWorkspaceRoute(env, WORKSPACE_ID)).toBeNull();
    expect(await resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID)).toBeNull();

    beginImport(database);
    expect(await resolveInspectionWorkspaceRoute(env, WORKSPACE_ID)).toBeNull();
    expect(await resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID)).toBeNull();

    database.exec(`
      UPDATE workstream_authority_routes SET state = 'verified', updated_at = '${AT}';
      UPDATE workstream_authority_control
         SET phase = 'maintenance_verified', updated_at = '${AT}'
       WHERE id = 1;
      UPDATE workstream_authority_routes SET state = 'active', updated_at = '${AT}';
    `);
    expect(await resolveInspectionWorkspaceRoute(env, WORKSPACE_ID)).toBeNull();
    expect(await resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID)).toBeNull();

    database.exec(`
      UPDATE workstream_authority_control
         SET phase = 'durable_object_open', serving_contract_version = 1, updated_at = '${AT}'
       WHERE id = 1;
    `);
    expect(database.prepare(
      "SELECT phase, generation, required_serving_contract_version, serving_contract_version FROM workstream_authority_control WHERE id = 1",
    ).get()).toEqual({
      phase: "durable_object_open",
      generation: 3,
      required_serving_contract_version: 1,
      serving_contract_version: 1,
    });
    await expect(resolveInspectionWorkspaceRoute(env, WORKSPACE_ID)).resolves.toMatchObject({
      authority_state: "active",
      authority_generation: 3,
    });
    await expect(resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID)).resolves.toMatchObject({
      authority_generation: 3,
    });
  });

  it("refuses stale workstream routes and caller generations", async () => {
    const { database, env } = fixture();
    beginImport(database);
    openAuthority(database);

    expect(await resolveInspectionWorkspaceRoute(env, WORKSPACE_ID, 2)).toBeNull();
    expect(await resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID, 2)).toBeNull();

    database.exec(`
      UPDATE workstream_authority_routes SET generation = 4 WHERE workstream_id = '${WORKSTREAM_ID}';
    `);
    await expect(resolveInspectionWorkspaceRoute(env, WORKSPACE_ID, 3)).resolves.toMatchObject({
      authority_generation: 3,
    });
    expect(await resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID, 3)).toBeNull();
  });
});

describe("engineering organization search", () => {
  const ACME = "00000000-0000-7000-8000-000000000ed1";
  const BETA = "00000000-0000-7000-8000-000000000ed2";
  const GONE = "00000000-0000-7000-8000-000000000ed3";
  const GUEST = "00000000-0000-7000-8000-000000000ed4";
  const SUSPENDED = "00000000-0000-7000-8000-000000000ed6";

  function organizations() {
    const { database, env } = fixture();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('${GUEST}', 'guest-user', 'guest@example.com', 'Guest', '${AT}', '${AT}'),
             ('${SUSPENDED}', 'suspended-user', 'suspended@example.com', 'Suspended', '${AT}', '${AT}');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at, plan)
      VALUES ('${ACME}', 'Acme Corp', 'acme', 'global', '${USER_ID}', '2026-09-01T00:00:00.000Z', '${AT}', 'growth'),
             ('${BETA}', 'Beta Labs', 'beta', 'global', '${USER_ID}', '2026-10-01T00:00:00.000Z', '${AT}', 'starter');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at, abandoned_at)
      VALUES ('${GONE}', 'Acme Old', 'acme-old', 'global', '${USER_ID}', '2026-09-15T00:00:00.000Z', '${AT}', '${AT}');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, last_seen_at)
      VALUES ('${ACME}', '${USER_ID}', 'owner', 'active', '2026-10-10T00:00:00.000Z');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, access_class, last_seen_at)
      VALUES ('${ACME}', '${GUEST}', NULL, 'active', 'guest', '2026-10-12T00:00:00.000Z');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, last_seen_at)
      VALUES ('${ACME}', '${SUSPENDED}', 'member', 'suspended', '2026-10-14T00:00:00.000Z');
    `);
    return env;
  }

  it("matches name or slug case-insensitively and leaves abandoned Organizations out", async () => {
    const rows = await searchInspectionOrganizations(organizations(), { query: "ACME" });
    expect(rows).toEqual([{
      id: ACME,
      name: "Acme Corp",
      slug: "acme",
      region: "global",
      plan: "growth",
      created_at: "2026-09-01T00:00:00.000Z",
      abandoned_at: null,
      member_count: 1,
      last_seen_at: "2026-10-12T00:00:00.000Z",
    }]);
  });

  it("matches a name's non-ASCII capitals case-insensitively", async () => {
    const env = organizations();
    const ecole = "00000000-0000-7000-8000-000000000ed5";
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
       VALUES (?, 'École Normale', 'ecole', 'global', ?, ?, ?)`,
    ).bind(ecole, USER_ID, AT, AT).run();
    const rows = await searchInspectionOrganizations(env, { query: "école" });
    expect(rows.map((row) => row.id)).toEqual([ecole]);
  });

  it("returns only abandoned Organizations when asked", async () => {
    const rows = await searchInspectionOrganizations(organizations(), { abandoned: "only" });
    expect(rows.map((row) => row.id)).toEqual([GONE]);
  });

  it("filters by plan and by a creation window given in any offset", async () => {
    const env = organizations();
    const starter = await searchInspectionOrganizations(env, { plan: "starter", abandoned: "include" });
    expect(starter.map((row) => row.id).sort()).toEqual([WORKSPACE_ID, BETA, GONE].sort());
    const window = await searchInspectionOrganizations(env, {
      createdAfter: "2026-08-31T20:00:00.001-04:00",
      createdBefore: "2026-10-01T00:00:00.001Z",
    });
    expect(window.map((row) => row.id)).toEqual([BETA]);
  });
});

describe("engineering user search", () => {
  const OTHER_ORG = "00000000-0000-7000-8000-000000000ee1";
  const ZOE = "00000000-0000-7000-8000-000000000ee2";
  const LONER = "00000000-0000-7000-8000-000000000ee3";

  function users() {
    const { database, env } = fixture();
    database.exec(`
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${OTHER_ORG}', 'Other Org', 'other', 'global', '${USER_ID}', '${AT}', '${AT}');
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('${ZOE}', 'zoe', 'zoe@Örebro.example', 'Zoë Ångström', '2026-09-10T00:00:00.000Z', '${AT}'),
             ('${LONER}', 'loner', 'loner@example.com', 'Loner', '2026-10-10T00:00:00.000Z', '${AT}');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, last_seen_at)
      VALUES ('${WORKSPACE_ID}', '${ZOE}', 'admin', 'active', '2026-10-01T00:00:00.000Z'),
             ('${OTHER_ORG}', '${ZOE}', 'member', 'suspended', '2026-10-05T00:00:00.000Z');
    `);
    return env;
  }

  it("returns each user with every membership, whatever its status, and none for a user without one", async () => {
    const rows = await searchInspectionUsers(users(), { createdAfter: "2026-09-01T00:00:00Z" });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(ZOE)?.memberships.sort((a, b) => a.workspace_id.localeCompare(b.workspace_id))).toEqual([
      {
        workspace_id: WORKSPACE_ID,
        name: "Inspection workspace",
        slug: "inspection-workspace",
        role: "admin",
        access_class: "member",
        status: "active",
        last_seen_at: "2026-10-01T00:00:00.000Z",
      },
      {
        workspace_id: OTHER_ORG,
        name: "Other Org",
        slug: "other",
        role: "member",
        access_class: "member",
        status: "suspended",
        last_seen_at: "2026-10-05T00:00:00.000Z",
      },
    ].sort((a, b) => a.workspace_id.localeCompare(b.workspace_id)));
    // The suspended membership's later visit does not count.
    expect(byId.get(ZOE)?.last_seen_at).toBe("2026-10-01T00:00:00.000Z");
    expect(byId.get(LONER)?.memberships).toEqual([]);
    expect(byId.get(LONER)?.last_seen_at).toBeNull();
    expect([...byId.keys()].sort()).toEqual([ZOE, LONER].sort());
  });

  it("says when a user was shadow banned, and null for one who is not", async () => {
    const { database, env } = fixture();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at, shadow_banned_at)
      VALUES ('${ZOE}', 'zoe', 'zoe@example.com', 'Zoe', '${AT}', '${AT}', '2026-11-02T00:00:00.000Z'),
             ('${LONER}', 'loner', 'loner@example.com', 'Loner', '${AT}', '${AT}', NULL);
    `);
    const rows = await searchInspectionUsers(env, {});
    expect(Object.fromEntries(rows.filter((row) => row.id === ZOE || row.id === LONER).map((row) => [row.id, row.shadow_banned_at])))
      .toEqual({ [ZOE]: "2026-11-02T00:00:00.000Z", [LONER]: null });
  });

  it("matches name or email with non-ASCII capitals, and filters by a creation window", async () => {
    const env = users();
    await expect(searchInspectionUsers(env, { query: "ÅNGSTRÖM" })).resolves.toEqual([expect.objectContaining({ id: ZOE })]);
    await expect(searchInspectionUsers(env, { query: "örebro" })).resolves.toEqual([expect.objectContaining({ id: ZOE })]);
    const window = await searchInspectionUsers(env, {
      createdAfter: "2026-10-09T20:00:00.001-04:00",
      createdBefore: "2026-10-11T00:00:00Z",
    });
    expect(window.map((row) => row.id)).toEqual([]);
    const later = await searchInspectionUsers(env, { createdAfter: "2026-10-09T20:00:00-04:00" });
    expect(later.map((row) => row.id)).toEqual([LONER]);
  });
});
