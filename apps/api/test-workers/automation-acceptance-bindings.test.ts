/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Where AutomationAgent reads the connector rows a plugin binding is made of.
 *
 * `connector_connections` is a WorkspaceDO table — migration 0090 dropped it
 * from regional D1 — so the object has to reach it through the workspace
 * runtime port rather than through its own `env.DB`. Reading it on the regional
 * binding raised `no such table`, which is not one of this object's snake_case
 * codes, so `withAutomationErrors` let it through as `500 internal_error`:
 * choosing a connector plugin failed at acceptance with "An unexpected error
 * occurred".
 *
 * These tests keep the table where it actually lives and nowhere else, so a
 * statement pointed back at D1 fails here the way it failed in production.
 *
 * This file used to cover delivery destinations as well, read from the same
 * tables. Automations no longer have destinations of their own: a run sends
 * its own result with its own connector tools, and the only thing that follows
 * from the automation itself is the room that owns it. What remains here is the
 * half that was never about delivery — binding the plugins a draft recommends.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asAutomationId, asUserId, asWorkspaceId } from "@rally/contracts";

import type { AutomationAgent } from "../src/durable-objects/automation-agent";
import { automationDOName, workspaceDOName } from "../src/durable-objects/names";
import { AutomationAgentService } from "../src/services/automation-agent-service";
import type { Env } from "../src/env";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000d7000");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-0000000d7001");
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-0000000d7002");
/** The room the fixture drafts in, since a draft always has one now. */
const AUTHORING_WORKSTREAM_ID = "00000000-0000-7000-8000-0000000d7020";
const SLACK_CONNECTION_ID = "00000000-0000-7000-8000-0000000d7010";
const SLACK_LINK_ID = "00000000-0000-7000-8000-0000000d7011";
const AUTHOR_EMAIL = "author@example.com";
const SLACK_TEAM_ID = "T0DELIVERY";
const SLACK_USER_ID = "U0DELIVERY";
const NOW = "2026-08-29T10:00:00.000Z";

const DEFINITION = {
  name: "Manual helper",
  description: "Runs on request",
  overview: "A manual automation",
  instructions: "Do the requested work.",
  triggers: [{ type: "manual" as const }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  suggestedScope: "personal" as const,
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

/**
 * The object is driven through `runInDurableObject` rather than over its stub.
 * `AutomationDetail` is not RPC-serializable, so the stub types the return as
 * `never` and no assertion about the destinations it answers with typechecks;
 * a rejection over the stub is also reported a second time as an unhandled
 * one, which fails the run even when the assertion held. The environment inside
 * is the real one either way — the calls this file is about are the ones the
 * object makes *outward*, to D1 and to WorkspaceDO.
 */
function automationStub() {
  return env.AUTOMATION_AGENTS.get(env.AUTOMATION_AGENTS.idFromName(
    automationDOName("global", WORKSPACE_ID, AUTOMATION_ID),
  ));
}

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

/**
 * The regional half: identity, and the email route the detail projection reads.
 * Deliberately no `connector_connections` and no `slack_user_links` — that is
 * the state of a migrated region, and creating them here would let the defect
 * this file covers pass.
 */
async function seedRegionalDatabase(): Promise<void> {
  // `IF NOT EXISTS` / `OR REPLACE` rather than the bare forms: `reset()` is
  // supposed to drop D1's schema, but `participant-notification.test.ts` records
  // an incomplete wipe leaving tables standing, where a bare `CREATE TABLE` then
  // fails as `already exists` and buries the original failure.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, abandoned_at TEXT
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces (id, region, abandoned_at)
      VALUES (?, 'global', NULL)`).bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO users (id, email, name, avatar_url, timezone, created_at)
      VALUES (?, ?, 'Author', NULL, 'UTC', ?)`).bind(AUTHOR_ID, AUTHOR_EMAIL, NOW),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id),
      UNIQUE (region, workspace_id, automation_subscription_id))`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, automation_subscription_id, created_at, updated_at)
      VALUES ('amber-cobalt-jade-brook', 'global', ?, NULL, ?, ?, ?)`)
      .bind(WORKSPACE_ID, AUTOMATION_ID, NOW, NOW),
  ]);
}

/** The workspace half: the connector rows a Slack destination is resolved from. */
async function seedWorkspaceObject(): Promise<void> {
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, granted_scopes_json, status, cursor_json, config_json,
          created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'slack', 'workspace', NULL, ?, 'Juno Labs', '[]', 'healthy',
               '{}', '{}', ?, ?, 'plugin_slack')`,
      SLACK_CONNECTION_ID,
      WORKSPACE_ID,
      SLACK_TEAM_ID,
      NOW,
      NOW,
    );
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO slack_user_links
         (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      SLACK_LINK_ID,
      WORKSPACE_ID,
      SLACK_CONNECTION_ID,
      AUTHOR_ID,
      SLACK_TEAM_ID,
      SLACK_USER_ID,
      NOW,
      NOW,
    );
  });
}

/** Change the seeded connector rows, in the object that owns them. */
async function mutateWorkspaceObject(statements: Array<[string, ...unknown[]]>): Promise<void> {
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    for (const [sql, ...bindings] of statements) state.storage.sql.exec(sql, ...bindings);
  });
}

/** An accepted, active automation, ready to have its destinations changed. */
async function acceptAutomation(input: {
  /**
   * What the draft recommends, because that is where acceptance now reads the
   * plugins it binds. It used to be a field on the accept request; the last
   * caller that could fill one in went with the create wizard, so the draft is
   * the only source left and the only one that was ever authoritative.
   */
  recommendedPluginIds: string[];
}): Promise<void> {
  await runInDurableObject(automationStub(), async (instance: AutomationAgent) => {
    (instance as unknown as { workspace(): unknown }).workspace = async () => ({
      applyExternalEventRegistrations: async () => ({ applied: true, effectiveAfterEventSequence: 7 }),
      applyAutomationProjection: async () => ({ applied: true }),
    });
    // Drafted the way a draft is made now: in a work stream, through the
    // authoring path, rather than through the compiler loop that is gone.
    await instance.admitAuthoredDraft({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      authorUserId: AUTHOR_ID,
      region: "global",
      authoredInWorkstreamId: AUTHORING_WORKSTREAM_ID,
      draft: {
        ...DEFINITION,
        recommendedPlugins: input.recommendedPluginIds.map((pluginId) => ({
          pluginId,
          recommendedTools: [],
          reason: "Needed by this automation",
        })),
      },
    });
    await instance.acceptDraft({
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      workspaceId: WORKSPACE_ID,
      authorUserId: AUTHOR_ID,
      definitionRevision: 1,
      scope: "personal",
      modelOverride: null,
    });
  });
}

beforeEach(async () => {
  await reset();
  await seedRegionalDatabase();
  await seedWorkspaceObject();
});

describe("AutomationAgent delivery targets", () => {
  // First, because it is the premise every other test in this file rests on.
  it("keeps the connector tables out of regional D1, which is what makes the rest of this file evidence", async () => {
    await expect(env.DB.prepare(`SELECT id FROM connector_connections LIMIT 1`).all())
      .rejects.toThrow(/no such table: connector_connections/u);
    await expect(env.DB.prepare(`SELECT id FROM slack_user_links LIMIT 1`).all())
      .rejects.toThrow(/no such table: slack_user_links/u);
  });

  it("binds a connector plugin at acceptance from the workspace object's connections", async () => {
    await acceptAutomation({ recommendedPluginIds: ["plugin_slack"] });

    await runInDurableObject(automationStub(), (_instance: AutomationAgent, state) => {
      expect(JSON.parse(state.storage.sql.exec<{ connector_bindings_json: string }>(
        `SELECT connector_bindings_json FROM automation_acceptance WHERE id = 1`,
      ).one().connector_bindings_json)).toEqual({ plugin_slack: SLACK_CONNECTION_ID });
    });
  });

  // The acceptance-side refusal, which reads the same rows as the binding above
  // and would equally have raised `no such table` before the fix.
  it("refuses acceptance for a plugin the workspace object has no connection for", async () => {
    await expect(acceptAutomation({ recommendedPluginIds: ["plugin_absent"] }))
      .rejects.toThrow("automation_plugin_unavailable");
  });

  // A disabled row no longer reserves its plugin id, so a reconnect can leave
  // two rows sharing one. Read together, `new Map` keeps whichever an
  // ORDER BY-less scan happened to return last, and a disabled winner refused a
  // plugin the create screen had just offered.
  it("binds the live connection when a disabled row still holds the same plugin id", async () => {
    await mutateWorkspaceObject([[
      `INSERT OR REPLACE INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, granted_scopes_json, status, cursor_json, config_json,
          created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'slack', 'workspace', NULL, ?, 'Juno Labs (old)', '[]', 'disabled',
               '{}', '{}', ?, ?, 'plugin_slack')`,
      "00000000-0000-7000-8000-0000000d7020",
      WORKSPACE_ID,
      SLACK_TEAM_ID,
      NOW,
      NOW,
    ]]);

    await acceptAutomation({ recommendedPluginIds: ["plugin_slack"] });

    await runInDurableObject(automationStub(), (_instance: AutomationAgent, state) => {
      expect(JSON.parse(state.storage.sql.exec<{ connector_bindings_json: string }>(
        `SELECT connector_bindings_json FROM automation_acceptance WHERE id = 1`,
      ).one().connector_bindings_json)).toEqual({ plugin_slack: SLACK_CONNECTION_ID });
    });
  });

  // The reported defect was an HTTP status, and the object throwing nothing is
  // only half of that: `withAutomationErrors` is the hop that turned the D1
  // failure into `500 internal_error`, and only a real stub exercises it.
  it("answers the service with a detail rather than an unmapped server fault", async () => {
    await acceptAutomation({ recommendedPluginIds: [] });
    // Annotated, not cast: the workers-suite `env` already satisfies `Env`, and
    // the lint rule is right that a cast here would hide binding drift.
    const testEnv: Env = env;
    const service = new AutomationAgentService(testEnv, {
      sessionId: "development",
      userId: AUTHOR_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "member",
    });

    await expect(service.detail(AUTOMATION_ID)).resolves.toMatchObject({
      id: AUTOMATION_ID,
      status: "active",
    });
  });
});
