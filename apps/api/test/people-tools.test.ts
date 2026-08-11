import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import type { Env } from "../src/env";
import { createPeopleTools } from "../src/services/people-service";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const HARNESS_RUN_ID = "00000000-0000-4000-8000-000000000003";
const OWNER_ID = "00000000-0000-4000-8000-000000000004";
const MEMBER_ID = "00000000-0000-4000-8000-000000000005";
const SUSPENDED_ID = "00000000-0000-4000-8000-000000000006";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000007";
const OUTSIDER_ID = "00000000-0000-4000-8000-000000000008";
const SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000009";
const TEMPLATE_ID = "00000000-0000-4000-8000-000000000010";
const TEMPLATE_VERSION_ID = "00000000-0000-4000-8000-000000000011";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000012";

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function workflowInput(
  principal: WorkstreamWorkflowInput["executionPrincipal"] = { type: "user", userId: OWNER_ID },
): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    automationSubscriptionId: null,
    activityId: null,
    executionPrincipal: principal,
    reason: "human_message",
  };
}

function fixture(): Env {
  const database = migratedSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at) VALUES
      ('${OWNER_ID}', 'people-owner', 'dana@example.com', 'Dana Okafor',
       'America/New_York', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('${MEMBER_ID}', 'people-member', 'ash@partner.example', 'ash rivera',
       'Europe/Berlin', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      ('${SUSPENDED_ID}', 'people-suspended', 'gone@example.com', 'Gone Away',
       'UTC', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
      ('${OUTSIDER_ID}', 'people-outsider', 'dana@other.example', 'Dana Elsewhere',
       'UTC', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z');
    INSERT INTO workspaces (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
    VALUES
      ('${WORKSPACE_ID}', 'Avalon', 'avalon', 'global', 'America/Los_Angeles', '${OWNER_ID}',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('${OTHER_WORKSPACE_ID}', 'Elsewhere', 'elsewhere', 'global', 'UTC', '${OUTSIDER_ID}',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES
      ('${WORKSPACE_ID}', '${OWNER_ID}', 'owner', 'active', '2026-01-01T00:00:00.000Z'),
      ('${WORKSPACE_ID}', '${MEMBER_ID}', 'member', 'active', '2026-01-02T00:00:00.000Z'),
      ('${WORKSPACE_ID}', '${SUSPENDED_ID}', 'member', 'suspended', '2026-01-03T00:00:00.000Z'),
      ('${OTHER_WORKSPACE_ID}', '${OUTSIDER_ID}', 'owner', 'active', '2026-01-04T00:00:00.000Z');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
       last_activity_at, created_at, updated_at, archived_at)
    VALUES
      ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Live', '', 'ad_hoc', '${OWNER_ID}', 'running',
       '2026-02-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z', '2026-02-01T00:00:00.000Z', NULL),
      ('00000000-0000-4000-8000-0000000000a1', '${WORKSPACE_ID}', 'Blocked', '', 'ad_hoc',
       '${OWNER_ID}', 'needs_input', '2026-02-03T00:00:00.000Z', '2026-01-06T00:00:00.000Z',
       '2026-02-03T00:00:00.000Z', NULL),
      ('00000000-0000-4000-8000-0000000000a2', '${WORKSPACE_ID}', 'Archived', '', 'ad_hoc',
       '${OWNER_ID}', 'completed', '2026-02-09T00:00:00.000Z', '2026-01-07T00:00:00.000Z',
       '2026-02-09T00:00:00.000Z', '2026-02-10T00:00:00.000Z'),
      ('00000000-0000-4000-8000-0000000000a3', '${WORKSPACE_ID}', 'Somebody else', '', 'ad_hoc',
       '${MEMBER_ID}', 'running', '2026-02-11T00:00:00.000Z', '2026-01-08T00:00:00.000Z',
       '2026-02-11T00:00:00.000Z', NULL);
    INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state,
       latest_version_number, created_at, updated_at)
    VALUES ('${TEMPLATE_ID}', '${WORKSPACE_ID}', '${OWNER_ID}', 'Digest', 'Daily digest',
            'private', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO automation_template_versions
      (id, template_id, version_number, instructions, trigger_definitions_json,
       required_capabilities_json, expected_outputs_json, default_behavior_json,
       created_by_user_id, created_at)
    VALUES ('${TEMPLATE_VERSION_ID}', '${TEMPLATE_ID}', 1, 'Summarize', '[]', '[]', '[]', '{}',
            '${OWNER_ID}', '2026-01-01T00:00:00.000Z');
    INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, connector_bindings_json, overrides_json, status,
       created_at, updated_at)
    VALUES ('${SUBSCRIPTION_ID}', '${WORKSPACE_ID}', '${TEMPLATE_ID}', '${TEMPLATE_VERSION_ID}',
            'personal', '${OWNER_ID}', '{"type":"user","userId":"${OWNER_ID}"}', '{}', '{}',
            'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, display_name, status,
       granted_scopes_json, config_json, model_plugin_id, created_at, updated_at)
    VALUES ('${CONNECTION_ID}', '${WORKSPACE_ID}', 'google', 'personal', '${OWNER_ID}',
            'Dana Google', 'healthy', '[]', '{}', 'plugin_google',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  return { DB: sqliteD1(database) } as Env;
}

function tool(env: Env, name: string, input = workflowInput()) {
  const found = createPeopleTools(env, input).find((entry) => entry.definition.name === name);
  if (!found) throw new Error(`people tool ${name} is not registered`);
  return found;
}

const context = {
  toolCallId: "call-1",
  signal: new AbortController().signal,
  providerIdempotencyKey: "key-1",
} as Parameters<ReturnType<typeof createPeopleTools>[number]["execute"]>[1];

describe("people tools", () => {
  it("declares one read capability family and takes no undeclared parameters", () => {
    const definitions = createPeopleTools(fixture(), workflowInput())
      .map((entry) => entry.definition);

    expect(definitions.map((definition) => definition.name)).toEqual([
      "current_user",
      "search_users",
      "list_users",
    ]);
    for (const definition of definitions) {
      expect(definition).toMatchObject({
        capability: "people.read",
        mode: "read",
        idempotency: "safe",
      });
      expect(definition.inputSchema).toMatchObject({ additionalProperties: false });
    }
  });

  it("returns the current user, their membership, and their activity totals", async () => {
    const result = await tool(fixture(), "current_user").execute({}, context);

    expect(result.output).toEqual({
      executionAuthority: "user",
      user: {
        userId: OWNER_ID,
        name: "Dana Okafor",
        email: "dana@example.com",
        timezone: "America/New_York",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      membership: { role: "owner", status: "active", joinedAt: "2026-01-01T00:00:00.000Z" },
      activity: {
        // The archived work stream and the one another member created are
        // excluded; the blocked one is counted twice, once as open.
        openWorkstreams: 2,
        workstreamsNeedingInput: 1,
        lastWorkstreamActivityAt: "2026-02-03T00:00:00.000Z",
        activePersonalAutomations: 1,
        healthyPersonalConnections: 1,
      },
      workspace: {
        workspaceId: WORKSPACE_ID,
        name: "Avalon",
        slug: "avalon",
        region: "global",
        timezone: "America/Los_Angeles",
      },
    });
  });

  it("names no member for a workspace-authorized run", async () => {
    const input = workflowInput({ type: "workspace", workspaceId: WORKSPACE_ID });
    const result = await tool(fixture(), "current_user", input).execute({}, context);

    expect(result.output).toMatchObject({
      executionAuthority: "workspace",
      user: null,
      membership: null,
      activity: null,
      workspace: { workspaceId: WORKSPACE_ID, name: "Avalon" },
    });
    expect(String((result.output as { note: string }).note)).toContain("no current user");
  });

  it("fails loudly when the current user's membership ended mid-run", async () => {
    const env = fixture();
    const input = workflowInput({ type: "user", userId: OUTSIDER_ID });

    await expect(tool(env, "current_user", input).execute({}, context))
      .rejects.toThrow(/no longer a member/u);
  });

  it("matches a name or email fragment case-insensitively and marks the current user", async () => {
    const env = fixture();

    const byName = await tool(env, "search_users").execute({ query: "ASH" }, context);
    const byEmailDomain = await tool(env, "search_users").execute({ query: "@example.com" }, context);

    expect(byName.output).toMatchObject({
      query: "ASH",
      totalMatches: 1,
      truncated: false,
      matches: [{
        userId: MEMBER_ID,
        name: "ash rivera",
        email: "ash@partner.example",
        timezone: "Europe/Berlin",
        role: "member",
        status: "active",
        joinedAt: "2026-01-02T00:00:00.000Z",
        isCurrentUser: false,
      }],
    });
    // The suspended member shares the domain and the outsider's address is
    // identical up to the workspace, so both absences are the tenancy filter.
    expect((byEmailDomain.output as { matches: Array<{ userId: string }> }).matches
      .map((match) => match.userId)).toEqual([OWNER_ID]);
    expect((byEmailDomain.output as { matches: Array<{ isCurrentUser: boolean }> }).matches[0])
      .toMatchObject({ isCurrentUser: true });
  });

  it("reports the untruncated total when a search is limited", async () => {
    const result = await tool(fixture(), "search_users").execute({ query: "a", limit: 1 }, context);

    expect(result.output).toMatchObject({ totalMatches: 2, truncated: true });
    expect((result.output as { matches: unknown[] }).matches).toHaveLength(1);
  });

  it("ranks an exact email match above a name match", async () => {
    const result = await tool(fixture(), "search_users")
      .execute({ query: "ash@partner.example" }, context);

    expect((result.output as { matches: Array<{ userId: string }> }).matches[0]?.userId)
      .toBe(MEMBER_ID);
  });

  it("treats a wildcard in the query as a literal character", async () => {
    const result = await tool(fixture(), "search_users").execute({ query: "%" }, context);

    expect(result.output).toMatchObject({ matches: [], totalMatches: 0 });
  });

  it("rejects an undeclared search parameter instead of silently dropping it", async () => {
    await expect(tool(fixture(), "search_users")
      .execute({ query: "dana", includeSuspended: true }, context)).rejects.toThrow();
  });

  it("lists active members by name and pages with the returned cursor", async () => {
    const env = fixture();

    const firstPage = await tool(env, "list_users").execute({ limit: 1 }, context);
    const cursor = (firstPage.output as { nextCursor: string | null }).nextCursor;
    const secondPage = await tool(env, "list_users").execute({ limit: 1, cursor }, context);

    expect(firstPage.output).toMatchObject({
      totalUsers: 2,
      users: [{ userId: MEMBER_ID, name: "ash rivera" }],
    });
    expect(cursor).toEqual(expect.any(String));
    expect(secondPage.output).toMatchObject({
      totalUsers: 2,
      nextCursor: null,
      users: [{ userId: OWNER_ID, name: "Dana Okafor", isCurrentUser: true }],
    });
  });

  it("excludes a suspended member and every other workspace's members", async () => {
    const result = await tool(fixture(), "list_users").execute({}, context);
    const listed = (result.output as { users: Array<{ userId: string }> }).users
      .map((user) => user.userId);

    expect(listed).toEqual([MEMBER_ID, OWNER_ID]);
    expect(listed).not.toContain(SUSPENDED_ID);
    expect(listed).not.toContain(OUTSIDER_ID);
  });

  it("rejects a malformed cursor with the remediation in the message", async () => {
    await expect(tool(fixture(), "list_users").execute({ cursor: "not-a-cursor" }, context))
      .rejects.toThrow(/people_cursor_invalid/u);
  });
});
