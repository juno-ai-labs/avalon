import { asUserId, asWorkspaceId } from "@rally/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { templateRoutes } from "../src/routes/automations";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import {
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";
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
const W = asWorkspaceId("74000000-0000-7000-8000-000000000001");
const OTHER_W = asWorkspaceId("74000000-0000-7000-8000-00000000000f");
const U = asUserId("74000000-0000-7000-8000-000000000002");
const AT = "2026-08-21T17:02:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

interface SeededTemplate {
  id: string;
  versionId: string;
  name: string;
  triggers: string;
  subscriptionId?: string;
  /** Defaults to the shared state; `'private'` is one member's own automation. */
  sharingState?: "private" | "workspace";
  archivedAt?: string;
  /** Defaults to this workspace; a second one proves the tenant predicate. */
  workspaceId?: string;
  capabilities?: string;
  /** A second subscription on the same template, to prove the count's filter. */
  hiddenSubscriptionId?: string;
}

function fixture(templates: SeededTemplate[]): { app: Hono<HonoAppEnv>; env: Env } {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // The gallery is the object's now, so the templates are seeded into a real
  // WorkspaceDO's own schema — STRICT, with the `json_valid` CHECKs the
  // through-0089 stand-in does not have. The regional database keeps the
  // identity rows the owner-name lookup joins, which is a separate authority
  // in production and now is here too.
  const workspaceObject = createTestWorkspaceDO({
    workspaceId: W,
    regionalDatabase: database,
    register: (created) => { databases.push(created); },
  });
  const objectDatabase = workspaceObject.objectDatabase;
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
     VALUES (?, 'template-catalog', 'catalog@example.com', 'Robin', ?, ?)`,
  ).run(U, AT, AT);
  for (const [id, slug] of [[W, "template-catalog"], [OTHER_W, "other-catalog"]] as const) {
    database.prepare(
      `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
       VALUES (?, 'Catalog', ?, 'global', ?, ?, ?)`,
    ).run(id, slug, U, AT, AT);
    database.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'owner', 'active', ?)`,
    ).run(id, U, AT);
  }
  for (const template of templates) {
    const owningWorkspace = template.workspaceId ?? W;
    objectDatabase.prepare(
      `INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state,
         latest_version_number, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, 'Shared with the workspace.', ?, 1, ?, ?, ?)`,
    ).run(
      template.id, owningWorkspace, U, template.name,
      template.sharingState ?? "workspace", AT, AT, template.archivedAt ?? null,
    );
    objectDatabase.prepare(
      `INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json,
         required_capabilities_json, expected_outputs_json, default_behavior_json,
         created_by_user_id, created_at)
       VALUES (?, ?, 1, 'Do the thing.', ?, ?, '[]', '{}', ?, ?)`,
    ).run(
      template.versionId, template.id, template.triggers,
      template.capabilities ?? "[]", U, AT,
    );
    const subscription = (id: string, lifecycle: string) => objectDatabase.prepare(
      `INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, connector_bindings_json, overrides_json, status,
         lifecycle_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'workspace', NULL, ?, '{}', '{}', 'active', ?, ?, ?)`,
    ).run(
      id, owningWorkspace, template.id, template.versionId,
      JSON.stringify({ type: "workspace", workspaceId: owningWorkspace }), lifecycle, AT, AT,
    );
    if (template.subscriptionId) subscription(template.subscriptionId, "visible");
    if (template.hiddenSubscriptionId) subscription(template.hiddenSubscriptionId, "deleted");
  }
  // Two rungs are dropped here deliberately, per `docs/testing.md`. These three
  // tables' live authority is `WORKSPACE_DOMAIN_SCHEMA_STATEMENTS` in
  // `durable-objects/workspace-domain-schema.ts`, not regional D1 — migration
  // 0090 dropped them from D1 — so `preRetirementProductSqliteDatabase()` is a
  // frozen through-0089 stand-in for that schema; it agrees on every column
  // this route reads, and is the looser of the two (the object's tables are
  // STRICT with `json_valid` CHECKs). And with no `WORKSPACE_DOS` binding,
  // `withWorkspaceRuntimeDatabase` leaves the port alone, so the catalog query
  // and the owner-name lookup — separate authorities in production — read one
  // database here. Neither the port nor the object's DDL is this file's
  // subject; the response contract over the SQL is.
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    WORKSPACE_DOS: testWorkspaceObjectBinding(workspaceObject.instance, [
      "listAutomationTemplates",
    ]),
  });
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
// An unzoned calendar trigger — the ordinary shape now — beside an activity
// trigger that does produce a source. `templateTriggers` answers a parse
// failure with an empty list for the whole array, so a contract that rejected
// the null would silently drop the GitHub source next to it rather than fail
// loudly. Mixed on purpose: a calendar-only template lists no sources either
// way, so it could not tell the two apart.
const UNZONED_CALENDAR = JSON.stringify([
  {
    type: "calendar",
    rrule: "FREQ=DAILY;BYHOUR=9",
    timezone: null,
    summary: "Every morning at 9:00 AM",
  },
  {
    type: "connector_activity",
    connectorType: "github",
    sourceBindingKey: "github_pushes",
    suggestedSourcePluginId: "plugin_github",
    eventTypes: ["push"],
    deterministicFilters: {},
  },
]);
const SEMANTIC_ACTIVITY = JSON.stringify([
  {
    type: "semantic_activity",
    connectorType: "slack",
    sourceBindingKey: "slack_mentions",
    suggestedSourcePluginId: "plugin_slack",
    deterministicPrefilter: {},
    condition: "Someone asks the team a question nobody has answered.",
  },
  {
    type: "semantic_activity",
    connectorType: null,
    sourceBindingKey: "any_source",
    deterministicPrefilter: {},
    condition: "Anything that reads like an escalation.",
  },
]);

describe("the workspace template catalog", () => {
  it("does not use the Electron visibility flag as API authorization", async () => {
    const { app, env } = fixture([]);
    const evaluate = vi.fn(async (flagKey: string) => ({
      flagKey, value: false, variant: "off", reason: "STATIC",
    }));
    env.FLAGS = createCloudflareTestBinding<Flagship>({ getBooleanDetails: evaluate });

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("serves a template whose trigger binds a connector", async () => {
    const { app, env } = fixture([{
      id: "74000000-0000-7000-8000-000000000011",
      versionId: "74000000-0000-7000-8000-000000000012",
      name: "Review watcher",
      triggers: CONNECTOR_ACTIVITY,
      subscriptionId: "74000000-0000-7000-8000-000000000013",
    }]);

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{
        id: "74000000-0000-7000-8000-000000000011",
        name: "Review watcher",
        author: "Robin",
        description: "Shared with the workspace.",
        usedBy: 0,
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
        id: "74000000-0000-7000-8000-000000000021",
        versionId: "74000000-0000-7000-8000-000000000022",
        name: "Review watcher",
        triggers: CONNECTOR_ACTIVITY,
      },
      {
        id: "74000000-0000-7000-8000-000000000023",
        versionId: "74000000-0000-7000-8000-000000000024",
        name: "Changelog",
        triggers: WEEKLY_CALENDAR,
      },
      {
        id: "74000000-0000-7000-8000-000000000025",
        versionId: "74000000-0000-7000-8000-000000000026",
        name: "Briefing",
        triggers: UNZONED_CALENDAR,
      },
    ]);

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<Record<string, unknown>> };
    expect(body.items.map((item) => [item.name, item.activitySources])).toEqual([
      ["Briefing", [{
        bindingKey: "github_pushes",
        connectorType: "github",
        suggestedPluginId: "plugin_github",
      }]],
      ["Changelog", []],
      ["Review watcher", [{
        bindingKey: "github_reviews",
        connectorType: "github",
        suggestedPluginId: "plugin_github",
      }]],
    ]);
    // A template nobody has installed yet reports zero rather than dropping out
    // of the catalog: `usedBy` counts visible subscriptions, and none of these
    // has one.
    expect(body.items.map((item) => item.usedBy)).toEqual([0, 0, 0]);
  });

  it("binds a semantic trigger that names a connector, and skips one that cannot", async () => {
    // The third producer branch. `semantic_activity` is the only trigger whose
    // `connectorType` is nullable, and a null one is dropped by
    // `activitySourceDefinitions` rather than bound — there is nothing for an
    // installer to pick. Both triggers sit on one template so the drop is
    // visible as an absence next to a sibling that did bind, rather than as an
    // empty array that an unrelated bug could also produce.
    const { app, env } = fixture([{
      id: "74000000-0000-7000-8000-000000000041",
      versionId: "74000000-0000-7000-8000-000000000042",
      name: "Escalation watcher",
      triggers: SEMANTIC_ACTIVITY,
    }]);

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ activitySources: unknown[] }> };
    expect(body.items[0]!.activitySources).toEqual([{
      bindingKey: "slack_mentions",
      connectorType: "slack",
      suggestedPluginId: "plugin_slack",
    }]);
  });

  it("serves only this workspace's shared, unarchived templates", async () => {
    // Neither predicate was exercised by the cases above, so both could be
    // deleted with the suite still green — and each is an intra-workspace
    // confidentiality rule: a private template is one member's unshared
    // automation, and its name and description are not the gallery's to show.
    //
    // Another workspace's template is no longer among them. The gallery is read
    // from the workspace's own object now, and the object refuses a row bearing
    // a different `workspace_id` outright — the case below proves that, which
    // is a stronger guarantee than a predicate this query could lose.
    const { app, env } = fixture([
      {
        id: "74000000-0000-7000-8000-000000000051",
        versionId: "74000000-0000-7000-8000-000000000052",
        name: "Shared",
        triggers: WEEKLY_CALENDAR,
      },
      {
        id: "74000000-0000-7000-8000-000000000053",
        versionId: "74000000-0000-7000-8000-000000000054",
        name: "Someone's private draft",
        triggers: WEEKLY_CALENDAR,
        sharingState: "private",
      },
      {
        id: "74000000-0000-7000-8000-000000000055",
        versionId: "74000000-0000-7000-8000-000000000056",
        name: "Retired",
        triggers: WEEKLY_CALENDAR,
        archivedAt: AT,
      },
    ]);

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ name: string }> };
    expect(body.items.map((item) => item.name)).toEqual(["Shared"]);
  });

  it("refuses to hold another workspace's template at all", async () => {
    // One object per workspace, and its identity trigger enforces that on the
    // way in. So the gallery cannot leak across workspaces by losing a
    // predicate: there is nothing to leak, because the row cannot be stored.
    expect(() => fixture([{
      id: "74000000-0000-7000-8000-000000000057",
      versionId: "74000000-0000-7000-8000-000000000058",
      name: "Another workspace's",
      triggers: WEEKLY_CALENDAR,
      workspaceId: OTHER_W,
    }])).toThrow("workspace_identity_mismatch");
  });

  it("counts only the subscriptions still on show", async () => {
    // `lifecycle_state` takes its 'visible' default everywhere else in this
    // file, so the count's filter was passing on the column's default rather
    // than on the predicate. A deleted subscription must not keep inflating a
    // template's install count.
    const { app, env } = fixture([{
      id: "74000000-0000-7000-8000-000000000061",
      versionId: "74000000-0000-7000-8000-000000000062",
      name: "Changelog",
      triggers: WEEKLY_CALENDAR,
      subscriptionId: "74000000-0000-7000-8000-000000000063",
      hiddenSubscriptionId: "74000000-0000-7000-8000-000000000064",
    }]);

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ usedBy: number }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.usedBy).toBe(0);
  });

  it("keeps serving a catalog that holds a row it cannot represent", async () => {
    // The defect this endpoint was fixed for once, reached the other way. Both
    // JSON columns are read with an assertion rather than a parse, so a blob no
    // current writer produces — an older deploy's, a hand-run backfill's —
    // reaches the response contract unchecked. A binding key with a space fails
    // the read boundary's regex; a capability object fails `z.array(z.string())`;
    // a non-array trigger blob never reaches the contract at all, because the
    // derivation would throw iterating it. Each one used to take the entire
    // workspace's catalog down with it.
    const { app, env } = fixture([
      {
        id: "74000000-0000-7000-8000-000000000071",
        versionId: "74000000-0000-7000-8000-000000000072",
        name: "Bad binding key",
        triggers: JSON.stringify([{
          type: "connector_activity",
          connectorType: "github",
          sourceBindingKey: "GitHub Reviews",
          eventTypes: ["pull_request"],
          deterministicFilters: {},
        }]),
      },
      {
        id: "74000000-0000-7000-8000-000000000073",
        versionId: "74000000-0000-7000-8000-000000000074",
        name: "Bad capabilities",
        triggers: WEEKLY_CALENDAR,
        capabilities: JSON.stringify([{ name: "web.read" }]),
      },
      {
        id: "74000000-0000-7000-8000-000000000075",
        versionId: "74000000-0000-7000-8000-000000000076",
        name: "Not even an array",
        triggers: JSON.stringify({ type: "connector_activity" }),
      },
      {
        id: "74000000-0000-7000-8000-000000000077",
        versionId: "74000000-0000-7000-8000-000000000078",
        name: "Zealous",
        triggers: CONNECTOR_ACTIVITY,
      },
    ]);

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    const body = await response.json() as {
      items: Array<{ name: string; activitySources: unknown[]; requiredCapabilities: unknown[] }>;
    };
    // The healthy template still reaches the browser — that is the whole point.
    expect(body.items.find((item) => item.name === "Zealous")?.activitySources).toEqual([{
      bindingKey: "github_reviews",
      connectorType: "github",
      suggestedPluginId: "plugin_github",
    }]);
    // An unrepresentable row degrades to a template with nothing to bind, which
    // the subscribe path already refuses with a typed 422.
    expect(body.items.map((item) => [item.name, item.activitySources, item.requiredCapabilities]))
      .toEqual(expect.arrayContaining([
        ["Bad binding key", [], []],
        ["Bad capabilities", [], []],
        ["Not even an array", [], []],
      ]));
  });

  it("serves a binding key at the full length the write path allows", async () => {
    // 63 characters is the ceiling `ActivitySourceBindingKeySchema` sets, and
    // the read boundary now restates that schema. This fails the moment the two
    // are tightened out of step.
    const bindingKey = `a${"b".repeat(62)}`;
    expect(bindingKey).toHaveLength(63);
    const { app, env } = fixture([{
      id: "74000000-0000-7000-8000-000000000081",
      versionId: "74000000-0000-7000-8000-000000000082",
      name: "Long key",
      triggers: JSON.stringify([{
        type: "connector_activity",
        connectorType: "github",
        sourceBindingKey: bindingKey,
        eventTypes: ["pull_request"],
        deterministicFilters: {},
      }]),
    }]);

    const response = await app.request("/automation-templates", undefined, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ activitySources: unknown[] }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.activitySources).toEqual([{ bindingKey, connectorType: "github" }]);
  });

  it("omits a suggested plugin the trigger never proposed", async () => {
    const { app, env } = fixture([{
      id: "74000000-0000-7000-8000-000000000031",
      versionId: "74000000-0000-7000-8000-000000000032",
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
    //
    // The absence is deliberate slack, not an observed shape: no current write
    // path can store an activity trigger without a suggestion. `publishTemplate`
    // and `create` require `draft.ready`, whose `superRefine` demands
    // `suggestedSourcePluginId` on every activity trigger; `addTemplateVersion`
    // skips that check but `assertActivityTriggerBindings` 422s on a binding key
    // with no suggestion; and `shareSubscription` refuses a draft outright. The
    // read boundary describes what the projection spreads rather than what
    // today's writers happen to produce — which is the direction that keeps a
    // future writer from 500ing the page.
    expect(body.items[0]!.activitySources).toEqual([{
      bindingKey: "inbound_hook",
      connectorType: "generic_webhook",
    }]);
  });
});
