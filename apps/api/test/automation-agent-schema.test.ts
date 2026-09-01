import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

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
