import { asUserId, asWorkspaceId } from "@avalon/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { templateRoutes } from "../src/routes/automations";
import { createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";

/**
 * `GET /automation-templates` through its real response contract.
 *
 * The catalog answered `500 internal_error` — "An unexpected error occurred" in
 * the New automation screen's template browser — for any workspace where a
 * shared template carried a connector-activity or webhook trigger. The route
 * declared `activitySources` as `ConnectorActivityTriggerDescriptorSchema`, a
 * connector manifest's event-type descriptor, while the service produces the
 * connector *bindings* an installer has to fill in. The two share no field, so
 * the page's own parse threw and the whole catalog disappeared — not just the
 * offending row.
 *
 * A template whose triggers are all calendar or interval yields an empty
 * `activitySources`, which parsed cleanly under either schema. That is why both
 * the checked-in fixtures and the first templates in any workspace worked, and
 * it is why this file seeds one of each.
 */
const W = asWorkspaceId("74000000-0000-4000-8000-000000000001");
const U = asUserId("74000000-0000-4000-8000-000000000002");
const AT = "2026-08-21T17:02:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

interface SeededTemplate {
  id: string;
  versionId: string;
  name: string;
  triggers: string;
  subscriptionId?: string;
}

function fixture(templates: SeededTemplate[]): { app: Hono<HonoAppEnv>; env: Env } {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'template-catalog', 'catalog@example.com', 'Robin', '${AT}', '${AT}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Catalog', 'template-catalog', 'global', '${U}', '${AT}', '${AT}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${W}', '${U}', 'owner', 'active', '${AT}');
  `);
  for (const template of templates) {
    database.prepare(
      `INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state,
         latest_version_number, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Shared with the workspace.', 'workspace', 1, ?, ?)`,
    ).run(template.id, W, U, template.name, AT, AT);
    database.prepare(
      `INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json,
         required_capabilities_json, expected_outputs_json, default_behavior_json,
         created_by_user_id, created_at)
       VALUES (?, ?, 1, 'Do the thing.', ?, '[]', '[]', '{}', ?, ?)`,
    ).run(template.versionId, template.id, template.triggers, U, AT);
    if (template.subscriptionId) {
      database.prepare(
        `INSERT INTO automation_subscriptions
          (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
           execution_principal_json, connector_bindings_json, overrides_json, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'workspace', NULL,
                 '{"type":"workspace","workspaceId":"${W}"}', '{}', '{}', 'active', ?, ?)`,
      ).run(template.subscriptionId, W, template.id, template.versionId, AT, AT);
    }
  }
  // No `WORKSPACE_DOS`, so `withWorkspaceRuntimeDatabase` leaves the port alone
  // and both the catalog query and the owner-name lookup read this database —
  // the routing itself is `workspace-runtime-database.test.ts`'s subject, not
  // this file's.
  const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" });
  const app = new Hono<HonoAppEnv>();
  app.use("*", async (context, next) => {
    context.set("auth", {
      sessionId: "session", workspaceId: W, userId: U, region: "global", role: "owner",
    });
    await next();
  });
  app.route("/automation-templates", templateRoutes);
  app.onError(errorHandler);
  return { app, env };
}

const CONNECTOR_ACTIVITY = JSON.stringify([{
  type: "connector_activity",
  connectorType: "github",
  sourceBindingKey: "github_reviews",
  suggestedSourcePluginId: "plugin_github",
  eventTypes: ["pull_request_review_comment"],
  deterministicFilters: {},
}]);
const WEEKLY_CALENDAR = JSON.stringify([{
  type: "calendar",
  rrule: "FREQ=WEEKLY;BYDAY=FR",
  timezone: "America/Los_Angeles",
  summary: "Every Friday at 2:00 PM",
}]);

describe("the workspace template catalog", () => {
  it("serves a template whose trigger binds a connector", async () => {
    const { app, env } = fixture([{
      id: "74000000-0000-4000-8000-000000000011",
      versionId: "74000000-0000-4000-8000-000000000012",
      name: "Review watcher",
      triggers: CONNECTOR_ACTIVITY,
      subscriptionId: "74000000-0000-4000-8000-000000000013",
    }]);

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{
        id: "74000000-0000-4000-8000-000000000011",
        name: "Review watcher",
        author: "Robin",
        description: "Shared with the workspace.",
        usedBy: 1,
        requiredCapabilities: [],
        latestVersion: 1,
        // The binding an installer fills in, not a manifest event type.
        activitySources: [{
          bindingKey: "github_reviews",
          connectorType: "github",
          suggestedPluginId: "plugin_github",
        }],
      }],
    });
  });

  it("keeps serving the rest of the catalog alongside it", async () => {
    // The parse covers the whole page, so one unrepresentable row took every
    // other template down with it. Ordering is `name COLLATE NOCASE`.
    const { app, env } = fixture([
      {
        id: "74000000-0000-4000-8000-000000000021",
        versionId: "74000000-0000-4000-8000-000000000022",
        name: "Review watcher",
        triggers: CONNECTOR_ACTIVITY,
      },
      {
        id: "74000000-0000-4000-8000-000000000023",
        versionId: "74000000-0000-4000-8000-000000000024",
        name: "Changelog",
        triggers: WEEKLY_CALENDAR,
      },
    ]);

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<Record<string, unknown>> };
    expect(body.items.map((item) => [item.name, item.activitySources])).toEqual([
      ["Changelog", []],
      ["Review watcher", [{
        bindingKey: "github_reviews",
        connectorType: "github",
        suggestedPluginId: "plugin_github",
      }]],
    ]);
    // A template nobody has installed yet reports zero rather than dropping out
    // of the catalog: `usedBy` counts visible subscriptions, and neither of
    // these has one.
    expect(body.items.map((item) => item.usedBy)).toEqual([0, 0]);
  });

  it("omits a suggested plugin the trigger never proposed", async () => {
    const { app, env } = fixture([{
      id: "74000000-0000-4000-8000-000000000031",
      versionId: "74000000-0000-4000-8000-000000000032",
      name: "Webhook relay",
      triggers: JSON.stringify([{
        type: "webhook",
        sourceBindingKey: "inbound_hook",
        eventTypes: ["deploy.finished"],
      }]),
    }]);

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ activitySources: unknown[] }> };
    // `generic_webhook` is synthesized for a webhook trigger, which declares no
    // connector type of its own, and the optional key is absent rather than null.
    expect(body.items[0]!.activitySources).toEqual([{
      bindingKey: "inbound_hook",
      connectorType: "generic_webhook",
    }]);
  });
});
