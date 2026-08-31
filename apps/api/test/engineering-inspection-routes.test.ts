import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import {
  resolveInspectionWorkspaceRoute,
  resolveInspectionWorkstreamRoute,
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
    INSERT INTO workspace_product_authority_routes
      (workspace_id, generation, state, updated_at)
    VALUES ('${WORKSPACE_ID}', 3, 'pending', '${AT}');
    UPDATE workstream_authority_control
       SET phase = 'maintenance_importing', updated_at = '${AT}'
     WHERE id = 1;
  `);
}

function openAuthority(database: DatabaseSync): void {
  database.exec(`
    UPDATE workstream_authority_routes SET state = 'verified', updated_at = '${AT}';
    UPDATE workspace_product_authority_routes SET state = 'verified', updated_at = '${AT}';
    UPDATE workstream_authority_control
       SET phase = 'maintenance_verified', updated_at = '${AT}'
     WHERE id = 1;
    UPDATE workstream_authority_routes SET state = 'active', updated_at = '${AT}';
    UPDATE workspace_product_authority_routes SET state = 'active', updated_at = '${AT}';
    UPDATE workstream_authority_control
       SET phase = 'durable_object_open', serving_contract_version = 1, updated_at = '${AT}'
     WHERE id = 1;
  `);
}

describe("engineering inspection authority routing", () => {
  it("refuses pending and verified routes until their generation is open and active", async () => {
    const { database, env } = fixture();

    expect(await resolveInspectionWorkspaceRoute(env, WORKSPACE_ID)).toBeNull();
    expect(await resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID)).toBeNull();

    beginImport(database);
    expect(await resolveInspectionWorkspaceRoute(env, WORKSPACE_ID)).toBeNull();
    expect(await resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID)).toBeNull();

    database.exec(`
      UPDATE workstream_authority_routes SET state = 'verified', updated_at = '${AT}';
      UPDATE workspace_product_authority_routes SET state = 'verified', updated_at = '${AT}';
      UPDATE workstream_authority_control
         SET phase = 'maintenance_verified', updated_at = '${AT}'
       WHERE id = 1;
      UPDATE workstream_authority_routes SET state = 'active', updated_at = '${AT}';
      UPDATE workspace_product_authority_routes SET state = 'active', updated_at = '${AT}';
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
    expect(database.prepare(
      "SELECT generation, state FROM workspace_product_authority_routes WHERE workspace_id = ?",
    ).get(WORKSPACE_ID)).toEqual({ generation: 3, state: "active" });
    await expect(resolveInspectionWorkspaceRoute(env, WORKSPACE_ID)).resolves.toMatchObject({
      authority_state: "active",
      authority_generation: 3,
    });
    await expect(resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID)).resolves.toMatchObject({
      authority_generation: 3,
    });
  });

  it("refuses stale route and caller generations", async () => {
    const { database, env } = fixture();
    beginImport(database);
    openAuthority(database);

    expect(await resolveInspectionWorkspaceRoute(env, WORKSPACE_ID, 2)).toBeNull();
    expect(await resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID, 2)).toBeNull();

    database.exec(`
      UPDATE workstream_authority_routes SET generation = 4 WHERE workstream_id = '${WORKSTREAM_ID}';
      UPDATE workspace_product_authority_routes SET generation = 4 WHERE workspace_id = '${WORKSPACE_ID}';
    `);
    expect(await resolveInspectionWorkspaceRoute(env, WORKSPACE_ID, 3)).toBeNull();
    expect(await resolveInspectionWorkstreamRoute(env, WORKSTREAM_ID, 3)).toBeNull();
  });
});
