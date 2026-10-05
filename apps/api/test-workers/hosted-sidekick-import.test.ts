/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Moving a Sidekick from its legacy `SidekickDO` into its Organization's
 * `WorkspaceDO`.
 *
 * Every case starts from a real legacy object holding the rows and alarm
 * entries an earlier release left behind, and a directory row that object
 * published, which is what puts the Sidekick on the import ledger. The move is
 * then driven the ways production drives it: a request that needs the
 * Sidekick, a direct import request, and the Organization's own alarm. See
 * docs/PRDs/2026-10-03_sidekick-parent-into-workspace-do/.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { asAutomationId, asUserId, asWorkspaceId, type AutomationDraft } from "@rally/contracts";
import { conversationEffectHash, type ParentEffect } from "@rally/contracts/conversation-effects";

import { automationDOName, workspaceDOName } from "../src/durable-objects/names";
import { SidekickDO } from "../src/durable-objects/sidekick-do";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ee00");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000ee01");
const SESSION_ID = "00000000-0000-7000-8000-00000000ee02";
const SCHEDULE_ID = "00000000-0000-7000-8000-00000000ee03";
const RUN_ID = "00000000-0000-7000-8000-00000000ee04";

/** Reassigned per test, so leftover work of a finished test lands on its own objects. */
let ordinal = 0;
let SIDEKICK_ID = asAutomationId("00000000-0000-7000-8000-0000000000ee");

const DEFINITION: AutomationDraft = {
  name: "Hourly helper",
  description: "Runs every hour",
  overview: "An hourly Sidekick",
  instructions: "Say the hour.",
  triggers: [{ type: "interval", intervalSeconds: 3_600, summary: "Every hour" }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  suggestedScope: "personal",
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

useHeldEffectQueue();

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function legacy(id: string = SIDEKICK_ID) {
  return env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(automationDOName("global", WORKSPACE_ID, asAutomationId(id))));
}

/**
 * A legacy object as an earlier release left it: an active Sidekick on its
 * second revision, an hourly schedule that came due while nothing ran it, a
 * pending manual run, its main conversation, an unsent sidebar row, and the
 * alarm entries for the schedule and the run.
 */
async function seedLegacySidekick(options: { runAsUserId?: string } = {}): Promise<void> {
  const now = Date.now();
  await runInDurableObject(legacy(), async (instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `INSERT INTO automation (id, automation_id, workspace_id, region, author_user_id, run_as_user_id, lifecycle,
         paused_by, scope, owning_workstream_id, owning_room_archived_at, title, description,
         current_definition_revision, accepted_definition_revision, connector_bindings_json, default_plugin_ids_json,
         activity_source_plugin_ids_json, evaluator_projection_json, model_override, email_address,
         effective_after_event_sequence, authority_generation, created_at, updated_at, loadable)
       VALUES (1, ?, ?, 'global', ?, ?, 'active', NULL, 'personal', NULL, NULL, 'Hourly helper', 'Runs every hour',
         2, 2, '{}', '[]', '{}', '[]', NULL, NULL, 0, 1, ?, ?, 0)`,
      SIDEKICK_ID, WORKSPACE_ID, AUTHOR_ID, options.runAsUserId ?? AUTHOR_ID, now, now,
    );
    for (const revision of [1, 2]) {
      sql.exec(
        `INSERT INTO definition_revisions (definition_revision, definition_json, definition_hash, evaluator_rules_json,
           ready, submitted_by_run_id, created_at) VALUES (?, ?, ?, NULL, 1, NULL, ?)`,
        revision, JSON.stringify({ ...DEFINITION, instructions: `Revision ${revision}.` }), `hash-${revision}`, now,
      );
    }
    sql.exec(
      `INSERT INTO schedules (schedule_id, definition_revision, schedule_kind, definition_json, next_due_at, updated_at)
       VALUES (?, 2, 'interval', ?, ?, ?)`,
      SCHEDULE_ID, JSON.stringify({ intervalSeconds: 3_600, acceptedAt: now - 3_600_000 }), now - 1_000, now,
    );
    sql.exec(
      `INSERT INTO runs (run_id, occurrence_key, trigger_json, definition_revision, harness_run_id, state, created_at,
         updated_at, run_as_user_id) VALUES (?, 'manual:legacy', ?, 2, ?, 'pending', ?, ?, ?)`,
      RUN_ID, JSON.stringify({ kind: "manual", requestedByUserId: AUTHOR_ID }), crypto.randomUUID(), now, now, AUTHOR_ID,
    );
    sql.exec(`INSERT INTO conversation_children (substream_id, kind, created_by_user_id, created_at) VALUES ('0', 'main', ?, ?)`,
      AUTHOR_ID, now);
    sql.exec(
      `INSERT INTO durable_outbox (message_id, partition_key, source_version, source_epoch, effect_kind, payload_json,
         payload_hash, state, attempts, not_before, created_at)
       VALUES ('legacy-sidebar-row', 'automation', 3, 1, 'directory_automation', '{}', 'hash', 'pending', 0, ?, ?)`,
      now, now,
    );
    const alarms = (instance as unknown as {
      scheduledAlarms: { schedule: (alarm: { kind: string; key: string; dueAt: number }, now: number) => void };
    }).scheduledAlarms;
    alarms.schedule({ kind: "automation_schedule", key: SCHEDULE_ID, dueAt: now - 1_000 }, now);
    alarms.schedule({ kind: "automation_run", key: RUN_ID, dueAt: now }, now);
    // The import is the test's to start; a native alarm firing on its own
    // would race it.
    await state.storage.deleteAlarm();
  });
}

/** The sidebar row a legacy object published, which is what enrols it on the ledger. */
async function publishLegacyDirectory(id: string = SIDEKICK_ID): Promise<void> {
  const effect = {
    kind: "directory_automation",
    automationId: id,
    authorUserId: AUTHOR_ID,
    lifecycle: "active",
    scope: "personal",
    owningWorkstreamId: null,
    title: "Hourly helper",
    description: "Runs every hour",
    nextRunAt: null,
  } satisfies Extract<ParentEffect, { kind: "directory_automation" }>;
  await workspace().applyAutomationDirectory({
    workspaceId: WORKSPACE_ID,
    envelope: {
      kind: "parent_effect", contractVersion: 1, region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "automation", parentId: id, generation: 1, messageId: `legacy-${id}`,
      partitionKey: "automation", sourceVersion: 1, requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect), effect,
    },
  });
}

async function ledger(id: string = SIDEKICK_ID) {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
    state: string; attempts: number; last_error_code: string | null;
  }>(`SELECT state, attempts, last_error_code FROM sidekick_imports WHERE sidekick_id = ?`, id).toArray()[0] ?? null);
}

/** This Sidekick's alarm entries in the Organization object, keyed as the Sidekick keys them. */
async function hostedAlarms(): Promise<{ kind: string; key: string; dueAt: number }[]> {
  const prefix = `${SIDEKICK_ID}:`;
  const rows = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
    kind: string; alarm_key: string; due_at: number;
  }>(
    `SELECT kind, alarm_key, due_at FROM _internal_durable_alarms WHERE substr(alarm_key, 1, ?) = ? ORDER BY kind, alarm_key`,
    prefix.length, prefix,
  ).toArray());
  return rows.map((row) => ({ kind: row.kind, key: row.alarm_key.slice(prefix.length), dueAt: row.due_at }));
}

async function hostedRuns(): Promise<{ run_id: string; occurrence_key: string; state: string }[]> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
    run_id: string; occurrence_key: string; state: string;
  }>(`SELECT run_id, occurrence_key, state FROM sidekick_runs WHERE sidekick_id = ? ORDER BY created_at, run_id`,
    SIDEKICK_ID).toArray());
}

/** A request that needs the Sidekick, asked inside the object so a refusal is not reported twice. */
async function touch(): Promise<unknown> {
  return runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.sidekickReadRunState({
    workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID, runId: RUN_ID,
  }).then((value) => value, (error: unknown) => error));
}

beforeEach(async () => {
  ordinal += 1;
  SIDEKICK_ID = asAutomationId(`00000000-0000-7000-8000-${String(ordinal).padStart(4, "0")}000000ee`);
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("importing a Sidekick from its legacy object", () => {
  it("enrols a Sidekick on the ledger when its legacy directory row lands, and serves it until it moves", async () => {
    // An export the schema refuses keeps the move from finishing, so what
    // serves the listing below is the legacy directory row and nothing else.
    await seedLegacySidekick({ runAsUserId: "not-a-user" });
    await publishLegacyDirectory();

    expect(await ledger()).toMatchObject({ state: "pending" });
    const listed = await workspace().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID });
    expect(listed.items.map((item) => item.id)).toEqual([SIDEKICK_ID]);
    expect(await ledger()).toMatchObject({ state: "pending" });
  });

  it("imports on first use, re-arms what came due during the freeze, and drops the unsent sidebar row", async () => {
    await seedLegacySidekick();
    await publishLegacyDirectory();

    expect(await touch()).toMatchObject({ state: "pending", lifecycle: "active" });

    expect(await ledger()).toMatchObject({ state: "imported", last_error_code: null });
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      region: string | null; lifecycle: string; accepted_definition_revision: number | null; revisions: number; children: number;
    }>(
      `SELECT d.region, d.lifecycle, d.accepted_definition_revision,
              (SELECT COUNT(*) FROM sidekick_revisions WHERE sidekick_id = d.automation_id) AS revisions,
              (SELECT COUNT(*) FROM sidekick_children WHERE sidekick_id = d.automation_id) AS children
         FROM automation_directory d WHERE d.automation_id = ?`, SIDEKICK_ID,
    ).one())).toMatchObject({ region: "global", lifecycle: "active", accepted_definition_revision: 2, revisions: 2 });
    expect((await hostedRuns()).find((run) => run.run_id === RUN_ID)).toMatchObject({ occurrence_key: "manual:legacy" });
    // Both entries the legacy object held are now the Organization's to fire.
    // Its own alarm may already have fired them by now; either way each is
    // still armed, the run until it is provisioned, the schedule for its next hour.
    expect((await hostedAlarms()).map(({ kind, key }) => [kind, key])).toEqual(expect.arrayContaining([
      ["automation_run", RUN_ID],
      ["automation_schedule", SCHEDULE_ID],
    ]));
    // The legacy object is frozen with nothing left to fire, and its unsent
    // sidebar row went nowhere: the Organization's row is the Sidekick's own.
    expect(await runInDurableObject(legacy(), (_instance, state) => ({
      frozen: state.storage.sql.exec(`SELECT 1 FROM sidekick_export_freeze`).toArray().length,
      live: state.storage.sql.exec(`SELECT 1 FROM _internal_durable_alarms`).toArray().length,
    }))).toEqual({ frozen: 1, live: 0 });
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM parent_outbox WHERE parent_id = ?`, SIDEKICK_ID,
    ).one().count)).toBe(0);

    // The overdue schedule fires once, and the pending run is handed on.
    await runDurableObjectAlarm(workspace());
    await runDurableObjectAlarm(workspace());
    const runs = await hostedRuns();
    expect(runs.filter((run) => run.occurrence_key.startsWith(`schedule:${SCHEDULE_ID}:`))).toHaveLength(1);
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ substream_id: string }>(
      `SELECT substream_id FROM sidekick_children WHERE sidekick_id = ? AND substream_id = ?`, SIDEKICK_ID, RUN_ID,
    ).toArray())).toHaveLength(1);
  });

  it("imports once when a request and an import request arrive together", async () => {
    await seedLegacySidekick();
    await publishLegacyDirectory();
    // Counted on the prototype, which is what an RPC call dispatches to.
    const exports = vi.spyOn(SidekickDO.prototype, "exportForImport");

    const [requested, touched] = await Promise.all([
      workspace().requestSidekickImport({ workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID }),
      touch(),
    ]);

    expect(requested).toEqual({ state: "imported", lastErrorCode: null });
    expect(touched).toMatchObject({ state: "pending" });
    expect(exports).toHaveBeenCalledTimes(1);
    exports.mockRestore();
    expect((await hostedRuns()).filter((run) => run.occurrence_key === "manual:legacy")).toHaveLength(1);
  });

  it("leaves a refused export pending with the field it named, still listed, until a repair and a retry", async () => {
    await seedLegacySidekick({ runAsUserId: "not-a-user" });
    await publishLegacyDirectory();

    const refused = await touch();
    expect(refused).toMatchObject({ status: 503 });
    expect((refused as { code: string }).code).toContain("run_as_user_id");
    const pending = await ledger();
    expect(pending).toMatchObject({ state: "pending", attempts: 1 });
    expect(pending?.last_error_code).toContain("run_as_user_id");
    const listed = await workspace().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID });
    expect(listed.items.map((item) => item.id)).toEqual([SIDEKICK_ID]);

    // An operator repairs the frozen row, then retries.
    await legacy().runInspectionSql({ sql: "UPDATE automation SET run_as_user_id = ? WHERE id = 1", bindings: [AUTHOR_ID] });
    expect(await workspace().retrySidekickImport({ workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID }))
      .toEqual({ state: "imported", lastErrorCode: null });
    expect(await touch()).toMatchObject({ state: "pending", lifecycle: "active" });
  });

  it("refuses its old methods on the legacy object, which the Organization then answers", async () => {
    await seedLegacySidekick();
    await publishLegacyDirectory();
    const moved = await runInDurableObject(legacy(), (instance) =>
      (instance as unknown as { readRunState: (input: unknown) => Promise<unknown> })
        .readRunState({ workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID, runId: RUN_ID })
        .then(() => null, (error: unknown) => error));
    expect((moved as Error).message).toBe("sidekick_parent_moved");
    expect(await touch()).toMatchObject({ state: "pending", lifecycle: "active" });
  });

  it("migrates a legacy object last opened before the export existed, then imports it", async () => {
    await seedLegacySidekick();
    await publishLegacyDirectory();
    // As a release before the freeze shipped left it.
    await runInDurableObject(legacy(), (_instance, state) => {
      state.storage.sql.exec(`DROP TABLE sidekick_export_freeze`);
      state.storage.sql.exec(`DROP TABLE sidekick_export_alarms`);
      state.storage.sql.exec(`DELETE FROM _sql_schema_migrations WHERE version >= 14`);
    });
    await evictDurableObject(legacy());

    expect(await touch()).toMatchObject({ state: "pending", lifecycle: "active" });
    expect(await ledger()).toMatchObject({ state: "imported" });
  });

  it("marks a Sidekick whose legacy object never held a row as done, and drops its stale listing", async () => {
    await publishLegacyDirectory();

    expect(await workspace().requestSidekickImport({ workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID }))
      .toEqual({ state: "imported", lastErrorCode: null });
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      `SELECT 1 FROM automation_directory WHERE automation_id = ?`, SIDEKICK_ID,
    ).toArray())).toEqual([]);
  });
});
