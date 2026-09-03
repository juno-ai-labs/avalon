import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { AutomationRunContextV1Schema } from "@rally/contracts";

import { AUTOMATION_AGENT_SCHEMA_MIGRATIONS } from "../src/durable-objects/automation-agent";

const AUTOMATION_ID = "00000000-0000-7000-8000-0000000000b3";
const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000b1";
const AUTHOR_ID = "00000000-0000-7000-8000-0000000000b2";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000b4";

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of AUTOMATION_AGENT_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

/** One accepted automation, as an object upgrading from version 8 holds it. */
function seedAcceptedAutomation(database: DatabaseSync): void {
  database.exec(`INSERT INTO automation_identity
    (id, automation_id, workspace_id, author_user_id, region, authority_generation, created_at, updated_at)
   VALUES (1, '${AUTOMATION_ID}', '${WORKSPACE_ID}', '${AUTHOR_ID}', 'global', 1, 1, 1)`);
  database.exec(`INSERT INTO automation_state
    (id, lifecycle, title, definition_revision, accepted_definition_revision, event_sequence,
     created_at, updated_at)
   VALUES (1, 'active', 'Weekly changelog', 1, 1, 0, 1, 1)`);
  database.exec(`INSERT INTO automation_acceptance
    (id, definition_revision, request_hash, scope, default_plugin_ids_json,
     activity_source_plugin_ids_json, connector_bindings_json, delivery_targets_json,
     model_override, evaluator_projection_json, evaluator_source_hash,
     effective_after_event_sequence, accepted_at, activated_at)
   VALUES (1, 1, 'sha256:request', 'workspace', '[]', '{}', '{}', '[]', NULL, '[]',
           'sha256:evaluators', 7, 100, 101)`);
}

describe("the AutomationAgent ownership migration", () => {
  it("carries an accepted automation across the rebuild, owning nothing", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 8);
    seedAcceptedAutomation(database);

    apply(database, 9, 8);

    // Every column the acceptance row carries has to survive a rebuild, not
    // just the ones this change is about: an acceptance that lost its evaluator
    // hash or its effective-after sequence would re-register triggers or
    // re-admit events the object had already settled.
    expect(database.prepare(`SELECT * FROM automation_acceptance`).get()).toEqual({
      id: 1,
      definition_revision: 1,
      request_hash: "sha256:request",
      scope: "workspace",
      owning_workstream_id: null,
      default_plugin_ids_json: "[]",
      activity_source_plugin_ids_json: "{}",
      connector_bindings_json: "{}",
      delivery_targets_json: "[]",
      model_override: null,
      evaluator_projection_json: "[]",
      evaluator_source_hash: "sha256:evaluators",
      effective_after_event_sequence: 7,
      accepted_at: 100,
      activated_at: 101,
    });
    // The scratch table must not survive: a rebuild that left it behind would
    // pass a fresh-schema test and leave every upgraded object holding two
    // acceptance rows, one of them frozen at the moment of the upgrade.
    expect(database.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'automation_acceptance_v9'`,
    ).get()).toBeUndefined();
  });

  it("holds the scope and the room it names to each other", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 9);
    database.exec(`INSERT INTO automation_identity
      (id, automation_id, workspace_id, author_user_id, region, authority_generation, created_at, updated_at)
     VALUES (1, '${AUTOMATION_ID}', '${WORKSPACE_ID}', '${AUTHOR_ID}', 'global', 1, 1, 1)`);

    const accept = (scope: string, owning: string | null): void => {
      database.exec(`INSERT INTO automation_acceptance
        (id, definition_revision, request_hash, scope, owning_workstream_id,
         default_plugin_ids_json, activity_source_plugin_ids_json, connector_bindings_json,
         delivery_targets_json, model_override, evaluator_projection_json, evaluator_source_hash,
         accepted_at)
       VALUES (1, 1, 'sha256:request', '${scope}',
               ${owning === null ? "NULL" : `'${owning}'`}, '[]', '{}', '{}', '[]', NULL, '[]',
               'sha256:evaluators', 100)`);
    };

    // A room's automation names its room, and no other scope may — otherwise
    // "which room owns this" and "which room receives this" become two facts
    // that can disagree.
    expect(() => accept("workstream", null)).toThrow();
    expect(() => accept("personal", WORKSTREAM_ID)).toThrow();
    accept("workstream", WORKSTREAM_ID);
    expect(database.prepare(`SELECT scope, owning_workstream_id FROM automation_acceptance`).get())
      .toEqual({ scope: "workstream", owning_workstream_id: WORKSTREAM_ID });
  });

  it("separates who an automation runs as from who wrote it", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 9);
    seedAcceptedAutomation(database);

    apply(database, 10, 9);

    // NULL means nobody has taken it over. The author still answers, and the
    // identity row is untouched — it is provenance, and the run history goes on
    // saying who wrote this long after somebody else is running it.
    expect(database.prepare(`SELECT run_as_user_id FROM automation_state`).get())
      .toEqual({ run_as_user_id: null });
    expect(database.prepare(`SELECT author_user_id FROM automation_identity`).get())
      .toEqual({ author_user_id: AUTHOR_ID });

    database.exec(`UPDATE automation_state SET run_as_user_id = '${WORKSTREAM_ID}' WHERE id = 1`);
    expect(database.prepare(`SELECT author_user_id FROM automation_identity`).get())
      .toEqual({ author_user_id: AUTHOR_ID });
  });

  it("keeps what a takeover moved, and what it could not", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 10);

    database.exec(`INSERT INTO automation_principal_claims
      (claim_id, claimed_by_user_id, previous_user_id, rebound_plugin_ids_json,
       unbound_providers_json, claimed_at)
     VALUES ('claim-1', '${AUTHOR_ID}', '${WORKSTREAM_ID}', '["plugin_gmail"]', '[]', 1)`);
    expect(database.prepare(
      `SELECT claimed_by_user_id, rebound_plugin_ids_json FROM automation_principal_claims`,
    ).get()).toEqual({
      claimed_by_user_id: AUTHOR_ID,
      rebound_plugin_ids_json: '["plugin_gmail"]',
    });

    // Both lists are arrays or the audit cannot be read back: a claim that
    // recorded a bare string would say nothing about which bindings moved.
    expect(() => database.exec(`INSERT INTO automation_principal_claims
      (claim_id, claimed_by_user_id, previous_user_id, rebound_plugin_ids_json,
       unbound_providers_json, claimed_at)
     VALUES ('claim-2', '${AUTHOR_ID}', NULL, '"plugin_gmail"', '[]', 2)`)).toThrow();
  });

  it("remembers the room a draft was written in, before anybody owns it", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 10);
    seedAcceptedAutomation(database);

    apply(database, 11, 10);

    // Null until an agent authors one inside a room. Ownership is the
    // acceptance's column; this is a fact about the draft, and the only place a
    // workstream acceptance can honestly get its room — the model never names
    // one, and no other room is reachable from an authoring loop.
    expect(database.prepare(`SELECT authored_in_workstream_id FROM automation_state`).get())
      .toEqual({ authored_in_workstream_id: null });

    database.exec(
      `UPDATE automation_state SET authored_in_workstream_id = '${WORKSTREAM_ID}' WHERE id = 1`,
    );
    // Independent of the acceptance: a draft can name its room long before
    // anybody decides whether it belongs to one.
    expect(database.prepare(
      `SELECT scope, owning_workstream_id FROM automation_acceptance`,
    ).get()).toEqual({ scope: "workspace", owning_workstream_id: null });
  });

  it("records why a paused automation is paused, and admits only the two reasons", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 9);
    database.exec(`INSERT INTO automation_state
      (id, lifecycle, title, definition_revision, accepted_definition_revision, event_sequence,
       created_at, updated_at)
     VALUES (1, 'paused', 'Weekly changelog', 1, 1, 0, 1, 1)`);

    database.exec(`UPDATE automation_state SET paused_reason = 'workstream_archived' WHERE id = 1`);
    expect(database.prepare(`SELECT paused_reason FROM automation_state`).get())
      .toEqual({ paused_reason: "workstream_archived" });

    // Free text here would make the resume decision unanswerable: unarchiving a
    // room resumes only what the archive paused, and it has to be able to tell.
    expect(() => database.exec(
      `UPDATE automation_state SET paused_reason = 'because' WHERE id = 1`,
    )).toThrow();
  });
});

describe("the AutomationAgent destination removal (v13)", () => {
  /** A frozen run context as an object at v12 holds it, destinations and all. */
  const frozenAtV12 = {
    schemaVersion: 1,
    automationId: AUTOMATION_ID,
    workspaceId: WORKSPACE_ID,
    runId: "00000000-0000-7000-8000-0000000000c1",
    authorityGeneration: 1,
    definitionRevision: 1,
    definition: {
      name: "Weekly changelog",
      description: "Summarizes the week.",
      overview: "Every Friday.",
      instructions: "Summarize what shipped.",
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
    },
    defaultPluginIds: [],
    activitySourcePluginIds: {},
    connectorBindings: {},
    deliveryTargets: [{ type: "email", emailAddress: "author@example.com" }],
    owningWorkstreamId: WORKSTREAM_ID,
    scope: "workstream",
    authoringOrigin: null,
    modelOverride: null,
    executionPrincipal: { type: "user", userId: AUTHOR_ID },
    trigger: { kind: "manual", requestedByUserId: AUTHOR_ID },
    opening: null,
    memoryScope: { automationId: AUTOMATION_ID, authorityGeneration: 1 },
  };

  function seedAtV12(database: DatabaseSync): void {
    database.exec(`INSERT INTO automation_acceptance
      (id, definition_revision, request_hash, scope, owning_workstream_id,
       default_plugin_ids_json, activity_source_plugin_ids_json, connector_bindings_json,
       delivery_targets_json, model_override, evaluator_projection_json, evaluator_source_hash,
       effective_after_event_sequence, accepted_at, activated_at)
     VALUES (1, 1, 'sha256:request', 'workstream', '${WORKSTREAM_ID}', '["plugin_slack"]', '{}',
             '{"plugin_slack":"conn-1"}', '[{"type":"email","emailAddress":"author@example.com"}]',
             NULL, '[]', 'sha256:evaluators', 7, 100, 101)`);
    database.prepare(`INSERT INTO automation_runs
      (run_id, occurrence_key, trigger_type, admission_state, execution_state, delivery_state,
       context_json, source_version, created_at, updated_at)
     VALUES (?, 'manual:1', 'manual', 'claimed', 'pending', 'pending', ?, 1, 1, 1)`)
      .run(frozenAtV12.runId, JSON.stringify(frozenAtV12));
    // A context that never had the key, so the rewrite's guard has something to
    // skip. Its bytes must come out identical.
    const neverHadIt = Object.fromEntries(
      Object.entries(frozenAtV12).filter(([key]) => key !== "deliveryTargets"),
    );
    database.prepare(`INSERT INTO automation_runs
      (run_id, occurrence_key, trigger_type, admission_state, execution_state, delivery_state,
       context_json, source_version, created_at, updated_at)
     VALUES ('00000000-0000-7000-8000-0000000000c2', 'manual:2', 'manual', 'claimed', 'pending',
             'pending', ?, 1, 1, 1)`).run(JSON.stringify(neverHadIt));
  }

  it("leaves a frozen context the strict contract can still read", () => {
    // The whole reason the migration exists. `AutomationRunContextV1Schema` is
    // strict, so the moment `deliveryTargets` left the contract every stored
    // context still carrying it — a claimed run waiting to execute, a
    // historical row the detail path reads — would have failed to parse.
    const database = new DatabaseSync(":memory:");
    apply(database, 12);
    seedAtV12(database);
    // Established, not assumed: the seeded context is one the contract refuses.
    expect(AutomationRunContextV1Schema.safeParse(frozenAtV12).success).toBe(false);

    apply(database, 13, 12);

    const rows = database.prepare(
      `SELECT run_id, context_json FROM automation_runs ORDER BY run_id`,
    ).all() as Array<{ run_id: string; context_json: string }>;
    for (const row of rows) {
      const parsed = AutomationRunContextV1Schema.safeParse(JSON.parse(row.context_json));
      expect(parsed.success, row.run_id).toBe(true);
      expect(JSON.parse(row.context_json)).not.toHaveProperty("deliveryTargets");
    }
    // The room survived the rewrite; it is the one destination that was never
    // in `deliveryTargets` and the one the classifier still gates.
    expect(JSON.parse(rows[0]!.context_json).owningWorkstreamId).toBe(WORKSTREAM_ID);
  });

  it("rebuilds the acceptance row without the column and without losing anything else", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 12);
    seedAtV12(database);

    apply(database, 13, 12);

    const columns = (database.prepare(`PRAGMA table_info(automation_acceptance)`).all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).not.toContain("delivery_targets_json");
    // Every other column, with its value: a rebuild that dropped the owning
    // room would detach the automation from the room that manages it, and one
    // that dropped the bindings would run it without its connectors.
    expect(database.prepare(`SELECT * FROM automation_acceptance`).get()).toEqual({
      id: 1,
      definition_revision: 1,
      request_hash: "sha256:request",
      scope: "workstream",
      owning_workstream_id: WORKSTREAM_ID,
      default_plugin_ids_json: '["plugin_slack"]',
      activity_source_plugin_ids_json: "{}",
      connector_bindings_json: '{"plugin_slack":"conn-1"}',
      model_override: null,
      evaluator_projection_json: "[]",
      evaluator_source_hash: "sha256:evaluators",
      effective_after_event_sequence: 7,
      accepted_at: 100,
      activated_at: 101,
    });
    // The scope/room CHECK came across with the table, or a later write could
    // record a room-scoped acceptance that owns no room.
    expect(() => database.exec(
      `UPDATE automation_acceptance SET owning_workstream_id = NULL WHERE id = 1`,
    )).toThrow(/CHECK constraint failed/u);
    expect(database.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });

  it("is a no-op the second time, which is what a resumed migration group needs", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 12);
    seedAtV12(database);
    apply(database, 13, 12);
    const before = database.prepare(`SELECT context_json FROM automation_runs ORDER BY run_id`).all();

    // Only the rewrite can be replayed — the rebuild renames a table away — and
    // the rewrite is the statement a crash between groups would replay.
    const rewrite = AUTOMATION_AGENT_SCHEMA_MIGRATIONS.find((m) => m.version === 13)!.statements[0]!;
    database.exec(rewrite);

    expect(database.prepare(`SELECT context_json FROM automation_runs ORDER BY run_id`).all()).toEqual(before);
  });
});
