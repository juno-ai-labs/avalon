import "../../../tests/isolated-region";
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asWorkspaceId } from "@rally/contracts";
import { WorkspaceRelationshipSchema } from "@rally/contracts/scope-grants";
import { writeSidekickDirectoryRow } from "./helpers/sidekick";
import { workspaceDOName } from "../src/durable-objects/names";
import { searchAudienceGroup, searchAudienceGroupIds } from "../src/services/search-audience";

/**
 * Search's person side (`WorkspaceDO.readSearchAudience`) against the rule
 * table in docs/PRDs/2026-09-26_search-audience-filtering/design.md: each
 * person's groups are exactly the conversations, Sidekicks and connections
 * the canonical rules let them read, plus their own and, for a member, the
 * Organization's. A row is searchable by someone only when its audience
 * shares one of these groups, so a group too many shows a row and one too few
 * hides it.
 */
const WORKSPACE_ID = "00000000-0000-7000-8000-00000000a0d1";
const MEMBER = "00000000-0000-7000-8000-00000000a001";
const PARTICIPANT = "00000000-0000-7000-8000-00000000a002";
const BREAKOUT_MEMBER = "00000000-0000-7000-8000-00000000a003";
const EXECUTOR = "00000000-0000-7000-8000-00000000a004";
const GUEST = "00000000-0000-7000-8000-00000000a005";
const SUSPENDED = "00000000-0000-7000-8000-00000000a006";
const REJOINED = "00000000-0000-7000-8000-00000000a007";
const PRIVATE = "00000000-0000-7000-8000-00000000c002";
const SIDEKICK_WORKSPACE = "00000000-0000-7000-8000-00000000d001";
const SIDEKICK_PERSONAL = "00000000-0000-7000-8000-00000000d002";
const SIDEKICK_OWNED = "00000000-0000-7000-8000-00000000d003";
const SIDEKICK_DELETED = "00000000-0000-7000-8000-00000000d004";
const SIDEKICK_GRANTED = "00000000-0000-7000-8000-00000000d006";
const CONNECTION_WORKSPACE = "00000000-0000-7000-8000-00000000e001";
const CONNECTION_PERSONAL = "00000000-0000-7000-8000-00000000e002";
const CONNECTION_DISABLED = "00000000-0000-7000-8000-00000000e003";

const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", asWorkspaceId(WORKSPACE_ID)));
let sequence = 0;

async function relate(userId: string, accessClass: "member" | "guest", status: "active" | "suspended" = "active") {
  sequence += 1;
  await workspace().applyMemberStatus({ workspaceId: WORKSPACE_ID, sequence, removed: false,
    relationship: WorkspaceRelationshipSchema.parse({ workspaceId: WORKSPACE_ID, userId, accessClass,
      role: accessClass === "member" ? "member" : null, status, incarnation: `incarnation-${userId}`, revision: sequence }) });
}

let seeded = false;
async function seedOrganization() {
  if (seeded) return;
  seeded = true;
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await relate(MEMBER, "member");
  await relate(PARTICIPANT, "member");
  await relate(BREAKOUT_MEMBER, "member");
  await relate(EXECUTOR, "member");
  await relate(GUEST, "guest");
  await relate(SUSPENDED, "member", "suspended");
  await relate(REJOINED, "member");
  await runInDurableObject(workspace(), (_instance, state) => {
    const sql = state.storage.sql;
    const sidekick = (id: string, scope: string, author: string, runAs: string | null, owning: string | null, lifecycle = "active") =>
      sql.exec(`INSERT INTO automation_directory (automation_id, workspace_id, author_user_id, run_as_user_id, source_version,
          payload_hash, lifecycle, scope, owning_workstream_id, title, description, projected_at)
        VALUES (?, ?, ?, ?, 1, 'hash', ?, ?, ?, 'Sidekick', '', 1)`, id, WORKSPACE_ID, author, runAs, lifecycle, scope, owning);
    sidekick(SIDEKICK_WORKSPACE, "workspace", MEMBER, MEMBER, null);
    sidekick(SIDEKICK_PERSONAL, "personal", PARTICIPANT, EXECUTOR, null);
    sidekick(SIDEKICK_OWNED, "personal", BREAKOUT_MEMBER, BREAKOUT_MEMBER, null);
    sidekick(SIDEKICK_DELETED, "workspace", MEMBER, MEMBER, null, "deleted");
    sidekick(SIDEKICK_GRANTED, "personal", GUEST, GUEST, null);
    const connection = (id: string, scope: string, owner: string | null, status: string) =>
      sql.exec(`INSERT INTO connector_connections (id, workspace_id, connector_type, scope, owner_user_id, display_name, status,
          created_at, updated_at, model_plugin_id)
        VALUES (?, ?, 'github', ?, ?, 'Connection', ?, '2026-09-28', '2026-09-28', ?)`, id, WORKSPACE_ID, scope, owner, status, `github:${id}`);
    connection(CONNECTION_WORKSPACE, "workspace", null, "healthy");
    connection(CONNECTION_PERSONAL, "personal", PARTICIPANT, "healthy");
    connection(CONNECTION_DISABLED, "workspace", null, "disabled");
  });
}

const groups = (userId: string) => workspace().readSearchAudience({ workspaceId: WORKSPACE_ID, userId });
const expected = async (names: string[]) => (await searchAudienceGroupIds(names)).sort();
const { user, members, sidekick, connection } = searchAudienceGroup;

describe("search audience: the person side", () => {
  it("lists exactly what each person may read under every canonical rule", async () => {
    await seedOrganization();
    // A member: the workspace Sidekick they wrote and the workspace
    // connection, not any Sidekick or connection that is someone else's.
    // Threads and Channels contribute no group.
    expect((await groups(MEMBER)).sort()).toEqual(await expected([user(MEMBER), members(WORKSPACE_ID),
      sidekick(SIDEKICK_WORKSPACE), connection(CONNECTION_WORKSPACE)]));
    // The Sidekick and the connection they own.
    expect((await groups(PARTICIPANT)).sort()).toEqual(await expected([user(PARTICIPANT), members(WORKSPACE_ID),
      sidekick(SIDEKICK_WORKSPACE), sidekick(SIDEKICK_PERSONAL),
      connection(CONNECTION_WORKSPACE), connection(CONNECTION_PERSONAL)]));
    // The personal Sidekick they wrote.
    expect((await groups(BREAKOUT_MEMBER)).sort()).toEqual(await expected([user(BREAKOUT_MEMBER), members(WORKSPACE_ID),
      sidekick(SIDEKICK_WORKSPACE), sidekick(SIDEKICK_OWNED),
      connection(CONNECTION_WORKSPACE)]));
    // Who a Sidekick runs as reads its conversations, as its author does.
    expect((await groups(EXECUTOR)).sort()).toEqual(await expected([user(EXECUTOR), members(WORKSPACE_ID),
      sidekick(SIDEKICK_WORKSPACE), sidekick(SIDEKICK_PERSONAL), connection(CONNECTION_WORKSPACE)]));
    // A guest gets nothing workspace-wide: not the Organization's group, not a
    // workspace Sidekick or connection. They read the Sidekick they wrote.
    expect((await groups(GUEST)).sort()).toEqual(await expected([user(GUEST), sidekick(SIDEKICK_GRANTED)]));
    // A member re-added after removal reads what any member does.
    expect((await groups(REJOINED)).sort()).toEqual(await expected([user(REJOINED), members(WORKSPACE_ID),
      sidekick(SIDEKICK_WORKSPACE), connection(CONNECTION_WORKSPACE)]));
    // Relationship status overrides everything; so does being unknown.
    expect(await groups(SUSPENDED)).toEqual([]);
  });

  it("learns who a Sidekick runs as from its directory row", async () => {
    await seedOrganization();
    const automationId = "00000000-0000-7000-8000-00000000d005";
    const [runsAs] = await searchAudienceGroupIds([sidekick(automationId)]);
    await writeSidekickDirectoryRow(env, {
      automationId, workspaceId: WORKSPACE_ID, authorUserId: MEMBER, runAsUserId: EXECUTOR,
      lifecycle: "active", scope: "personal", title: "Brief", description: "",
    });
    expect(await groups(EXECUTOR)).toContain(runsAs);
    expect(await groups(BREAKOUT_MEMBER)).not.toContain(runsAs);
  });
});

describe("search audience: an Organization held below the parent schema", () => {
  it("omits a Channel-owned Sidekick rather than failing every search", async () => {
    // Meeting-notes retirement can hold an Organization below schema 58, which
    // has no parent tables. Its own object, with those tables removed.
    const heldId = "00000000-0000-7000-8000-00000000a0d2";
    const held = env.WORKSPACE_DOS.getByName(workspaceDOName("global", asWorkspaceId(heldId)));
    await held.initializeWorkspace(heldId, "wnam");
    await held.applyMemberStatus({ workspaceId: heldId, sequence: 1, removed: false,
      relationship: WorkspaceRelationshipSchema.parse({ workspaceId: heldId, userId: MEMBER, accessClass: "member",
        role: "member", status: "active", incarnation: `incarnation-${MEMBER}`, revision: 1 }) });
    await runInDurableObject(held, (_instance, state) => {
      const sql = state.storage.sql;
      for (const { name } of sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'parent\\_%' ESCAPE '\\'").toArray()) {
        sql.exec(`DROP TABLE ${name}`);
      }
      // Nor the Channel-rail triggers of a later migration, which read them.
      for (const { name } of sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'channel\\_rail\\_%' ESCAPE '\\'").toArray()) {
        sql.exec(`DROP TRIGGER ${name}`);
      }
      sql.exec(`INSERT INTO automation_directory (automation_id, workspace_id, author_user_id, run_as_user_id, source_version,
          payload_hash, lifecycle, scope, owning_workstream_id, title, description, projected_at)
        VALUES (?, ?, ?, ?, 1, 'hash', 'active', 'workstream', ?, 'Sidekick', '', 1)`,
      SIDEKICK_OWNED, heldId, PARTICIPANT, PARTICIPANT, PRIVATE);
    });
    expect(await held.readSearchAudience({ workspaceId: heldId, userId: MEMBER }))
      .toEqual(await expected([user(MEMBER), members(heldId)]));
  });
});
