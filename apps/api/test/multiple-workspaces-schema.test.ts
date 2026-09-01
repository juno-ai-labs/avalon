import { afterEach, describe, expect, it } from "vitest";

import { migratedSqliteDatabase } from "./helpers/sqlite-d1";

const platformUserId = "00000000-0000-7000-8000-000000000001";
const globalWorkspaceId = "00000000-0000-7000-8000-000000000002";
const euWorkspaceId = "00000000-0000-7000-8000-000000000003";
const at = "2026-08-31T12:00:00.000Z";

const databases: ReturnType<typeof migratedSqliteDatabase>[] = [];

function database(): ReturnType<typeof migratedSqliteDatabase> {
  const value = migratedSqliteDatabase();
  databases.push(value);
  return value;
}

afterEach(() => {
  for (const value of databases.splice(0)) value.close();
});

describe("multiple-workspace regional schema", () => {
  it("stores independent Global and EU routes without rewriting placement", () => {
    const db = database();
    const insert = db.prepare(
      `INSERT INTO platform_workspace_bindings
       (platform_user_id, region, workspace_id, placement_affinity, status,
        operation_id, pending_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?)`,
    );

    insert.run(platformUserId, "global", globalWorkspaceId, "enam", "op-global", at, at);
    insert.run(platformUserId, "eu", euWorkspaceId, "eeur", "op-eu", at, at);

    expect(db.prepare(
      `SELECT region, workspace_id, placement_affinity, status
       FROM platform_workspace_bindings
       WHERE platform_user_id = ? ORDER BY region`,
    ).all(platformUserId)).toEqual([
      { region: "eu", workspace_id: euWorkspaceId, placement_affinity: "eeur", status: "active" },
      { region: "global", workspace_id: globalWorkspaceId, placement_affinity: "enam", status: "active" },
    ]);
  });

  it("allows one pending setup beside active routes but refuses a second pending setup", () => {
    const db = database();
    const insert = db.prepare(
      `INSERT INTO platform_workspace_bindings
       (platform_user_id, region, workspace_id, placement_affinity, status,
        operation_id, pending_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insert.run(platformUserId, "global", globalWorkspaceId, "wnam", "active", "op-active", null, at, at);
    insert.run(platformUserId, "eu", euWorkspaceId, "weur", "pending", "op-pending", at, at, at);

    expect(() => insert.run(
      platformUserId,
      "global",
      "00000000-0000-7000-8000-000000000004",
      "wnam",
      "pending",
      "op-second-pending",
      at,
      at,
      at,
    )).toThrow(/UNIQUE/u);
  });

  it("records setup replay identity and workspace abandonment", () => {
    const db = database();

    const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
    expect(workspaceColumns.map((column) => column.name)).toContain("abandoned_at");

    db.prepare(
      `INSERT INTO platform_workspace_operations
       (operation_id, platform_user_id, action, request_fingerprint, region,
        workspace_id, placement_affinity, invitation_id, status, created_at, updated_at)
       VALUES (?, ?, 'create', ?, 'global', ?, 'wnam', NULL, 'pending', ?, ?)`,
    ).run("00000000-0000-7000-8000-000000000010", platformUserId, "fingerprint", globalWorkspaceId, at, at);

    expect(db.prepare(
      `SELECT action, workspace_id, status FROM platform_workspace_operations
       WHERE operation_id = ?`,
    ).get("00000000-0000-7000-8000-000000000010")).toEqual({
      action: "create",
      workspace_id: globalWorkspaceId,
      status: "pending",
    });
  });
});
