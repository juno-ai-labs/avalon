import { ScopeGrantSchema } from "@rally/contracts/scope-grants";
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
import { insertChannelRow } from "./helpers/hosted-parent";

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
const OPEN = "00000000-0000-7000-8000-00000000c001";
const PRIVATE = "00000000-0000-7000-8000-00000000c002";
const GRANTED = "00000000-0000-7000-8000-00000000c003";
const BREAKOUT = "00000000-0000-7000-8000-00000000b001";
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
    // Two legacy-roster Channels: one open to the Organization, one personal
    // whose creator is its only participant (Main has not reported yet, so the
    // creator stands in), with a ready Breakout only its own member reads.
    for (const [parentId, scope] of [[OPEN, "workspace"], [PRIVATE, "personal"]] as const) {
      sql.exec(`INSERT INTO parent_metadata (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
        VALUES (?, 'workstream', ?, 'global', 1, 1, 1)`, parentId, WORKSPACE_ID);
      insertChannelRow(state, parentId, parentId === OPEN ? "Open" : "Private", scope);
      sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, status, updated_at)
        VALUES (?, '0', 'main', ?, 1, 'ready', 1)`, parentId, PARTICIPANT);
    }
    sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, status, updated_at)
      VALUES (?, ?, 'child', ?, 2, 'ready', 2)`, PRIVATE, BREAKOUT, BREAKOUT_MEMBER);
    sql.exec(`INSERT INTO parent_breakout_members (parent_id, substream_id, user_id, active, version, added_by_user_id, added_at, updated_at)
      VALUES (?, ?, ?, 1, 1, ?, 2, 2)`, PRIVATE, BREAKOUT, BREAKOUT_MEMBER, BREAKOUT_MEMBER);
    for (const [parentId, substreamId, userId] of [[OPEN, null, PARTICIPANT], [PRIVATE, null, PARTICIPANT], [PRIVATE, BREAKOUT, BREAKOUT_MEMBER]] as const) {
      const grant = ScopeGrantSchema.parse({ id: crypto.randomUUID(), userId,
        target: substreamId === null ? { kind: "workstream", workspaceId: WORKSPACE_ID, parentId }
          : { kind: "conversation", workspaceId: WORKSPACE_ID, parentId, substreamId },
        active: true, revision: 1, membershipIncarnation: `incarnation-${userId}` });
      sql.exec("INSERT INTO parent_grants(parent_id,user_id,scope_kind,substream_id,grant_json) VALUES (?,?,?,?,?)",
        parentId, userId, grant.target.kind, substreamId ?? "", JSON.stringify(grant));
    }
    // A Channel whose Main has moved to grant authority: only a grant bound to
    // the reader's current membership admits them. The guest holds one; the
    // re-added member holds one from an earlier membership.
    sql.exec(`INSERT INTO parent_metadata (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
      VALUES (?, 'workstream', ?, 'global', 1, 1, 1)`, GRANTED, WORKSPACE_ID);
    insertChannelRow(state, GRANTED, "Granted", "personal");
    sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, status, updated_at)
      VALUES (?, '0', 'main', ?, 1, 'ready', 1)`, GRANTED, GUEST);
    sql.exec(`INSERT INTO parent_participant_migrations (parent_id, substream_id, transfer_id, phase)
      VALUES (?, '0', 'transfer-granted', 'complete')`, GRANTED);
    for (const [userId, incarnation] of [[GUEST, `incarnation-${GUEST}`], [REJOINED, "incarnation-before-removal"]] as const) {
      sql.exec(`INSERT INTO parent_grants (parent_id, user_id, scope_kind, substream_id, grant_json) VALUES (?, ?, 'workstream', '', ?)`,
        GRANTED, userId, JSON.stringify({ id: userId === GUEST ? "00000000-0000-7000-8000-00000000f001" : "00000000-0000-7000-8000-00000000f002", userId, active: true, revision: 1, membershipIncarnation: incarnation,
          target: { kind: "workstream", workspaceId: WORKSPACE_ID, parentId: GRANTED } }));
    }
    const sidekick = (id: string, scope: string, author: string, runAs: string | null, owning: string | null, lifecycle = "active") =>
      sql.exec(`INSERT INTO automation_directory (automation_id, workspace_id, author_user_id, run_as_user_id, source_version,
          payload_hash, lifecycle, scope, owning_workstream_id, title, description, projected_at)
        VALUES (?, ?, ?, ?, 1, 'hash', ?, ?, ?, 'Sidekick', '', 1)`, id, WORKSPACE_ID, author, runAs, lifecycle, scope, owning);
    sidekick(SIDEKICK_WORKSPACE, "workspace", MEMBER, MEMBER, null);
    sidekick(SIDEKICK_PERSONAL, "personal", PARTICIPANT, EXECUTOR, null);
    sidekick(SIDEKICK_OWNED, "workstream", BREAKOUT_MEMBER, BREAKOUT_MEMBER, PRIVATE);
    sidekick(SIDEKICK_DELETED, "workspace", MEMBER, MEMBER, null, "deleted");
    sidekick(SIDEKICK_GRANTED, "workstream", GUEST, GUEST, GRANTED);
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
const { user, members, conversation, sidekick, connection } = searchAudienceGroup;

describe("search audience: the person side", () => {
  it("lists exactly what each person may read under every canonical rule", async () => {
    await seedOrganization();
    // A member: the open Channel, the workspace Sidekick they wrote, the
    // workspace connection. Not the personal Channel, its Breakout, or any
    // Sidekick or connection that is someone else's.
    expect((await groups(MEMBER)).sort()).toEqual(await expected([user(MEMBER), members(WORKSPACE_ID),
      conversation(OPEN, "0"), sidekick(SIDEKICK_WORKSPACE), connection(CONNECTION_WORKSPACE)]));
    // The personal Channel's participant reads its Main but not its Breakout;
    // the Sidekick they wrote, and the one owned by a Channel they are in.
    expect((await groups(PARTICIPANT)).sort()).toEqual(await expected([user(PARTICIPANT), members(WORKSPACE_ID),
      conversation(OPEN, "0"), conversation(PRIVATE, "0"), sidekick(SIDEKICK_WORKSPACE), sidekick(SIDEKICK_PERSONAL),
      sidekick(SIDEKICK_OWNED), connection(CONNECTION_WORKSPACE), connection(CONNECTION_PERSONAL)]));
    // A Breakout's roster is its own: its member reads it without reading Main.
    expect((await groups(BREAKOUT_MEMBER)).sort()).toEqual(await expected([user(BREAKOUT_MEMBER), members(WORKSPACE_ID),
      conversation(OPEN, "0"), conversation(PRIVATE, BREAKOUT), sidekick(SIDEKICK_WORKSPACE), sidekick(SIDEKICK_OWNED),
      connection(CONNECTION_WORKSPACE)]));
    // Who a Sidekick runs as reads its conversations, as its author does.
    expect((await groups(EXECUTOR)).sort()).toEqual(await expected([user(EXECUTOR), members(WORKSPACE_ID),
      conversation(OPEN, "0"), sidekick(SIDEKICK_WORKSPACE), sidekick(SIDEKICK_PERSONAL), connection(CONNECTION_WORKSPACE)]));
    // A guest gets nothing workspace-wide: not the Organization's group, not a
    // legacy open Channel, not a workspace Sidekick or connection. Their grant
    // admits the granted Channel's Main, and management access on it the
    // Sidekick it owns.
    expect((await groups(GUEST)).sort()).toEqual(await expected([user(GUEST), conversation(GRANTED, "0"),
      sidekick(SIDEKICK_GRANTED)]));
    // A grant from an earlier membership admits nothing after being re-added.
    expect((await groups(REJOINED)).sort()).toEqual(await expected([user(REJOINED), members(WORKSPACE_ID),
      conversation(OPEN, "0"), sidekick(SIDEKICK_WORKSPACE), connection(CONNECTION_WORKSPACE)]));
    // Relationship status overrides everything; so does being unknown.
    expect(await groups(SUSPENDED)).toEqual([]);
  });

  it("narrows a Breakout-homed Sidekick to the people who read that Breakout", async () => {
    await seedOrganization();
    const homedInBreakout = "00000000-0000-7000-8000-00000000d007";
    await runInDurableObject(workspace(), (_instance, state) => {
      // Written by the suspended member, so no reader here gets it by
      // authorship or execution; only the home decides.
      state.storage.sql.exec(`INSERT INTO automation_directory (automation_id, workspace_id, author_user_id, run_as_user_id,
          source_version, payload_hash, lifecycle, scope, owning_workstream_id, owning_substream_id, title, description, projected_at)
        VALUES (?, ?, ?, ?, 1, 'hash', 'active', 'workstream', ?, ?, 'Sidekick', '', 1)`,
        homedInBreakout, WORKSPACE_ID, SUSPENDED, SUSPENDED, PRIVATE, BREAKOUT);
    });
    const [group] = await searchAudienceGroupIds([sidekick(homedInBreakout)]);
    // The Channel's Main participant is not in the Breakout.
    expect(await groups(PARTICIPANT)).not.toContain(group);
    expect(await groups(BREAKOUT_MEMBER)).toContain(group);
  });

  it("learns who a Sidekick runs as from its directory row", async () => {
    await seedOrganization();
    const automationId = "00000000-0000-7000-8000-00000000d005";
    const [runsAs] = await searchAudienceGroupIds([sidekick(automationId)]);
    await writeSidekickDirectoryRow(env, {
      automationId, workspaceId: WORKSPACE_ID, authorUserId: MEMBER, runAsUserId: EXECUTOR,
      lifecycle: "active", scope: "personal", owningWorkstreamId: null, title: "Brief", description: "",
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
