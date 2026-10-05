import { asAutomationId, asWorkspaceId, IdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { z } from "zod";

import type { Env } from "../env";
import { assertDurableObjectJurisdiction, durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { parseRpcInput } from "../lib/rpc-input";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { type SidekickExport } from "./automation-do-protocol";
import { CONVERSATION_PARENT_SCHEMA_STATEMENTS } from "./conversation-parent-object";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import { automationDOName, workspaceDOName } from "./names";
import {
  OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
  applyRetirementGate,
  retiredObjectResponse,
} from "./object-retirement";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import {
  SCHEDULED_ALARM_SCHEMA_STATEMENTS,
  ScheduledDurableObject,
  type ScheduledAlarm,
  type ScheduledAlarmOutcome,
} from "./scheduled-alarms";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";

/**
 * A Sidekick's legacy object, reduced to what moving it needs.
 *
 * Every Sidekick's parent now lives in its Organization's `WorkspaceDO`
 * (`HostedSidekick`). What is left here is the migration ledger, so an object
 * that has not woken since an earlier release reaches the schema the export
 * reads; `exportForImport`, which freezes the object and hands over every
 * row; and an alarm that asks the Organization to import it, so a schedule
 * still armed here starts the move rather than firing. Every other method
 * answers `sidekick_parent_moved`, which a Queue consumer retries against the
 * new route. The class is deleted once every Organization has imported; see
 * docs/PRDs/2026-10-03_sidekick-parent-into-workspace-do/.
 */

const MIGRATION_COMPONENT = "automation_do";

/** The methods this object answered before the move; each now says where the Sidekick went. */
const MOVED_METHODS = [
  "create", "saveDefinition", "submitDefinition", "apply", "reconcileLoadable", "setAppearance", "pause", "resume",
  "remove", "setOwningRoomArchived", "runNow", "runSeeded", "externalEventAdmissionPlan", "admitExternalEvent",
  "admitInboundEmail", "readSkillSummary", "readSkillSource", "readRunDefinition", "readRunState", "continueRun",
  "readDetail", "listRuns", "claimExecutionPrincipal", "authorizeViewer", "authorizationDiscoveryChildren",
  "readAuthorizationFacts", "authority", "reserveAgentChild", "reserveChild", "receiveChildEffects", "listChildren",
  "childTerminalDeadlines",
] as const;

const ExportRequestSchema = z.strictObject({ workspaceId: WorkspaceIdSchema, automationId: IdSchema });

export const AUTOMATION_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "an automation, its definition revisions, schedules, runs, and the shared parent tables",
  statements: [
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE automation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      automation_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      author_user_id TEXT NOT NULL,
      run_as_user_id TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'paused', 'deleted')),
      paused_by TEXT CHECK (paused_by IS NULL OR paused_by IN ('person', 'room_archive')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'workstream')),
      owning_workstream_id TEXT,
      owning_room_archived_at INTEGER CHECK (owning_room_archived_at IS NULL OR owning_room_archived_at >= 0),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      current_definition_revision INTEGER NOT NULL CHECK (current_definition_revision >= 0),
      accepted_definition_revision INTEGER
        CHECK (accepted_definition_revision IS NULL OR accepted_definition_revision > 0),
      connector_bindings_json TEXT NOT NULL CHECK (json_valid(connector_bindings_json)),
      default_plugin_ids_json TEXT NOT NULL CHECK (json_valid(default_plugin_ids_json)),
      activity_source_plugin_ids_json TEXT NOT NULL CHECK (json_valid(activity_source_plugin_ids_json)),
      evaluator_projection_json TEXT NOT NULL CHECK (json_valid(evaluator_projection_json)),
      model_override TEXT,
      email_address TEXT COLLATE NOCASE,
      effective_after_event_sequence INTEGER,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK ((scope = 'workstream') = (owning_workstream_id IS NOT NULL))
    ) STRICT`,
    `CREATE TABLE definition_revisions (
      definition_revision INTEGER PRIMARY KEY CHECK (definition_revision > 0),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      definition_hash TEXT NOT NULL,
      evaluator_rules_json TEXT CHECK (evaluator_rules_json IS NULL OR json_valid(evaluator_rules_json)),
      ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
      submitted_by_run_id TEXT,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE schedules (
      schedule_id TEXT PRIMARY KEY,
      definition_revision INTEGER NOT NULL,
      schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('calendar', 'interval')),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      next_due_at INTEGER CHECK (next_due_at IS NULL OR next_due_at >= 0),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      occurrence_key TEXT NOT NULL UNIQUE,
      trigger_json TEXT NOT NULL CHECK (json_valid(trigger_json)),
      definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
      harness_run_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'needs_input', 'completed', 'failed', 'stopped')),
      summary TEXT,
      opening_json TEXT CHECK (opening_json IS NULL OR json_valid(opening_json)),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX runs_history_idx ON runs(created_at DESC, run_id)`,
    `CREATE TABLE inbound_email_receipts (
      resend_email_id TEXT PRIMARY KEY,
      run_id TEXT,
      outcome_code TEXT NOT NULL,
      payload_ref TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      received_at INTEGER NOT NULL
    ) STRICT`,
    ...CONVERSATION_PARENT_SCHEMA_STATEMENTS,
    ...SCHEDULED_ALARM_SCHEMA_STATEMENTS,
  ],
}, {
  version: 2,
  description: "which revision's apply effects landed, so a replayed apply reconciles instead of returning",
  statements: [
    `ALTER TABLE automation ADD COLUMN applied_effects_revision INTEGER`,
  ],
}, {
  version: 3,
  description: "stored Sidekick loading capability, independent of lifecycle and authorization",
  statements: [
    `ALTER TABLE automation ADD COLUMN loadable INTEGER NOT NULL DEFAULT 0 CHECK (loadable IN (0, 1))`,
    // Every legacy accepted definition implicitly permits email execution.
    // It therefore remains non-loadable without rewriting its immutable revision.
  ],
}, {
  version: 4,
  description: "fence external registration effects across publication and lifecycle changes",
  statements: [`ALTER TABLE automation ADD COLUMN registration_generation INTEGER NOT NULL DEFAULT 0`],
}, {
  version: 5,
  description: "record a permanent retirement tombstone",
  statements: [
    // A retired workspace never reopens, and the fence in front of every
    // method here reads this table. It lives in the object rather than D1
    // because the gate answers during constructor recovery, before anything
    // else this object could consult is admitted.
    ...OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
  ],
}, {
  version: 6,
  description: "where a scripted run's model bytes come from",
  statements: [
    // Null on every run but a seeded one, which is every run in production:
    // only `runSeeded` writes it, and only a demo's seeder calls that. It is a
    // run-scoped fact, so it lives on the run rather than on the definition or
    // the schedule, and `provisionRun` hands it to the loop the same way it
    // hands over the trigger.
    `ALTER TABLE runs ADD COLUMN seed_json TEXT CHECK (seed_json IS NULL OR json_valid(seed_json))`,
  ],
}, {
  version: 7,
  description: "the Sidekick's chosen icon and colour",
  statements: [
    // Null means nobody has chosen, which is not the same as choosing the
    // default: the mark derived from the automation's id is what a null
    // renders, and it moves if the catalog is ever reordered. A stored value
    // is a person's decision and never moves.
    `ALTER TABLE automation ADD COLUMN appearance_json TEXT
       CHECK (appearance_json IS NULL OR json_valid(appearance_json))`,
  ],
}, { version: 8, description: "allow configured deployment identifiers", statements: [
  "PRAGMA defer_foreign_keys = ON",
  "CREATE TABLE \"_region_copy_automation\" AS SELECT * FROM \"automation\"",
  "DELETE FROM \"automation\"",
  "DROP TABLE \"automation\"",
  "CREATE TABLE automation (\n      id INTEGER PRIMARY KEY CHECK (id = 1),\n      automation_id TEXT NOT NULL UNIQUE,\n      workspace_id TEXT NOT NULL,\n      region TEXT NOT NULL,\n      author_user_id TEXT NOT NULL,\n      run_as_user_id TEXT NOT NULL,\n      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'paused', 'deleted')),\n      paused_by TEXT CHECK (paused_by IS NULL OR paused_by IN ('person', 'room_archive')),\n      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'workstream')),\n      owning_workstream_id TEXT,\n      owning_room_archived_at INTEGER CHECK (owning_room_archived_at IS NULL OR owning_room_archived_at >= 0),\n      title TEXT NOT NULL,\n      description TEXT NOT NULL,\n      current_definition_revision INTEGER NOT NULL CHECK (current_definition_revision >= 0),\n      accepted_definition_revision INTEGER\n        CHECK (accepted_definition_revision IS NULL OR accepted_definition_revision > 0),\n      connector_bindings_json TEXT NOT NULL CHECK (json_valid(connector_bindings_json)),\n      default_plugin_ids_json TEXT NOT NULL CHECK (json_valid(default_plugin_ids_json)),\n      activity_source_plugin_ids_json TEXT NOT NULL CHECK (json_valid(activity_source_plugin_ids_json)),\n      evaluator_projection_json TEXT NOT NULL CHECK (json_valid(evaluator_projection_json)),\n      model_override TEXT,\n      email_address TEXT COLLATE NOCASE,\n      effective_after_event_sequence INTEGER,\n      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL, applied_effects_revision INTEGER, loadable INTEGER NOT NULL DEFAULT 0 CHECK (loadable IN (0, 1)), registration_generation INTEGER NOT NULL DEFAULT 0, appearance_json TEXT\n       CHECK (appearance_json IS NULL OR json_valid(appearance_json)),\n      CHECK ((scope = 'workstream') = (owning_workstream_id IS NOT NULL))\n    ) STRICT",
  "INSERT INTO \"automation\" SELECT * FROM \"_region_copy_automation\"",
  "DROP TABLE \"_region_copy_automation\"",
  "PRAGMA defer_foreign_keys = OFF"
]
}, {
  version: 9,
  description: "the appearance the setup chat last submitted",
  statements: [
    // What the chat last asked for, kept apart from what the Sidekick wears so
    // a repeat of that request is not mistaken for a new one. Null until the
    // chat first submits; see `submitDefinition`.
    `ALTER TABLE automation ADD COLUMN chat_appearance_json TEXT
       CHECK (chat_appearance_json IS NULL OR json_valid(chat_appearance_json))`,
  ],
}, {
  version: 10,
  description: "republish the directory row with who the Sidekick runs as",
  // The WorkspaceDO's directory learned `run_as_user_id` (its migration 81)
  // for search's person side. A row only carries it once this Sidekick
  // publishes again, so `afterMigrations` republishes once, as it did for 3.
  // The statement changes nothing; a migration must run at least one.
  statements: ["UPDATE automation SET updated_at = updated_at WHERE id = 1"],
}, {
  version: 11,
  description: "a home conversation that can be a Breakout",
  statements: [
    // Beside `owning_workstream_id` rather than in place of it: replacing that
    // column would rebuild a table whose CHECK names it. A Channel's Main
    // conversation is substream "0", so every existing Sidekick keeps its home
    // with no backfill. See docs/automation-lifecycle.md.
    `ALTER TABLE automation ADD COLUMN owning_substream_id TEXT NOT NULL DEFAULT '0'`,
  ],
}, {
  version: 12,
  description: "a counter every Sidekick-side stop of open runs moves",
  statements: [
    // The fence a continued run's authority check compares instead of a
    // wall-clock time: a pause that stops runs after `continueRun` approved a
    // continuation moves it, however close together the two land. Zero on
    // every existing Sidekick; only its movement is compared, never its value.
    `ALTER TABLE automation ADD COLUMN stop_generation INTEGER NOT NULL DEFAULT 0 CHECK (stop_generation >= 0)`,
  ],
}, {
  version: 13,
  description: "who each run runs as",
  statements: [
    // A run's transcript is its run-as user's: their connectors read it and
    // wrote it. `continueRun` refuses a continuation whose Sidekick now runs
    // as somebody else rather than handing that history to them. Existing
    // runs take the Sidekick's current run-as user, which is who they ran as
    // unless a claim moved it since; no earlier value was recorded anywhere.
    `ALTER TABLE runs ADD COLUMN run_as_user_id TEXT`,
    `UPDATE runs SET run_as_user_id = (SELECT run_as_user_id FROM automation WHERE id = 1)`,
  ],
}, {
  version: 14,
  description: "the freeze an export to the Organization object leaves behind",
  statements: [
    // One row, written by the first export. From then on this object answers
    // nothing but the same export again: its rows are the Organization's.
    `CREATE TABLE sidekick_export_freeze (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      frozen_at INTEGER NOT NULL CHECK (frozen_at >= 0)
    ) STRICT`,
    // The alarm entries as the first export found them. The live list is
    // emptied by that export, so nothing fires here again, and a retried
    // import reads these instead.
    `CREATE TABLE sidekick_export_alarms (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    ) STRICT`,
  ],
}];

export class SidekickDO extends ScheduledDurableObject {
  private readonly state: DurableObjectState;
  private readonly initialized: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    this.env = env = withDurableObjectSelf(env, {
      namespace: env.AUTOMATION_DOS,
      name: () => this.selfObjectName(),
      id: state.id,
      instance: this,
    });
    this.initialized = this.initializeDurableObject(async () => {
      await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: AUTOMATION_DO_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
      await this.armNextAlarm();
    });
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return { component: MIGRATION_COMPONENT, className: "SidekickDO", migrations: AUTOMATION_DO_SCHEMA_MIGRATIONS };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  private identity(): { workspace_id: string; automation_id: string } | null {
    return this.state.storage.sql.exec<{ workspace_id: string; automation_id: string }>(
      `SELECT workspace_id, automation_id FROM automation WHERE id = 1`,
    ).toArray()[0] ?? null;
  }

  private selfObjectName(): string | null {
    let row: { workspace_id: string; automation_id: string } | null;
    try {
      row = this.identity();
    } catch {
      return null;
    }
    return row ? automationDOName(this.env.AVALON_REGION, asWorkspaceId(row.workspace_id), asAutomationId(row.automation_id)) : null;
  }

  private frozen(): boolean {
    return this.state.storage.sql.exec(`SELECT 1 FROM sidekick_export_freeze WHERE id = 1`).toArray().length > 0;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      return Response.json({ ok: true, role: "automation", frozen: this.frozen(), databaseBytes: this.state.storage.sql.databaseSize });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  /**
   * Hand every row to the Organization object, and freeze.
   *
   * The freeze is written in the same transaction as the read, so the rows
   * returned are the rows this object will hold for good: nothing else in this
   * class writes. Asked again, it returns the same rows, so a retried import
   * reads what the first attempt read. The native alarm is cleared: a
   * schedule armed here is the Organization's to fire now.
   */
  async exportForImport(input: unknown): Promise<SidekickExport> {
    await this.initialized;
    const request = parseRpcInput(ExportRequestSchema, input, "export_for_import");
    const sql = this.state.storage.sql;
    const exported = this.state.storage.transactionSync((): SidekickExport => {
      if (!this.frozen()) {
        sql.exec(`INSERT INTO sidekick_export_freeze (id, frozen_at) VALUES (1, ?)`, Date.now());
        for (const alarm of this.scheduledAlarms.list()) {
          sql.exec(`INSERT INTO sidekick_export_alarms (kind, key, due_at) VALUES (?, ?, ?)`, alarm.kind, alarm.key, alarm.dueAt);
          this.scheduledAlarms.cancel(alarm.kind, alarm.key);
        }
      }
      const automation = sql.exec(`SELECT * FROM automation WHERE id = 1`).toArray()[0];
      if (!automation) return { status: "missing" };
      if (automation.workspace_id !== request.workspaceId || automation.automation_id !== request.automationId) {
        throw new Error("sidekick_export_identity_mismatch");
      }
      return {
        status: "ok",
        automation: automation as never,
        revisions: sql.exec(`SELECT * FROM definition_revisions ORDER BY definition_revision`).toArray() as never,
        schedules: sql.exec(`SELECT * FROM schedules ORDER BY schedule_id`).toArray() as never,
        runs: sql.exec(`SELECT * FROM runs ORDER BY created_at, run_id`).toArray() as never,
        emailReceipts: sql.exec(`SELECT * FROM inbound_email_receipts ORDER BY resend_email_id`).toArray() as never,
        children: sql.exec(`SELECT * FROM conversation_children ORDER BY substream_id`).toArray() as never,
        childProjections: sql.exec(`SELECT * FROM substream_directory ORDER BY substream_id`).toArray() as never,
        alarms: sql.exec<{ kind: string; key: string; due_at: number }>(
          `SELECT kind, key, due_at FROM sidekick_export_alarms ORDER BY kind, key`,
        ).toArray().map((alarm) => ({ kind: alarm.kind, key: alarm.key, dueAt: alarm.due_at })),
        outboxKinds: sql.exec<{ effect_kind: string }>(`SELECT DISTINCT effect_kind FROM durable_outbox ORDER BY effect_kind`)
          .toArray().map((row) => row.effect_kind),
      };
    });
    await this.state.storage.deleteAlarm();
    return exported;
  }

  /**
   * Something here is due: a schedule, a run start, an unsent directory row.
   * None of it is this object's to do any more, so the Organization is asked
   * to import it, which freezes this object and re-arms the entries there.
   */
  private async requestImport(): Promise<void> {
    if (this.frozen()) return;
    const identity = this.identity();
    if (!identity) return;
    const workspace = await durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, identity.workspace_id,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(identity.workspace_id)));
    await workspace.requestSidekickImport({ workspaceId: identity.workspace_id, automationId: identity.automation_id });
  }

  protected override async runScheduledAlarm(alarm: ScheduledAlarm): Promise<ScheduledAlarmOutcome> {
    void alarm;
    await this.requestImport();
    return { progressed: true };
  }

  protected override async runDueAlarmWork(): Promise<void> {
    if (this.nextOutboxDueAt() !== null) await this.requestImport();
  }

  protected override nextDerivedAlarmCandidates(): readonly number[] {
    const due = this.nextOutboxDueAt();
    return due === null ? [] : [due];
  }

  private nextOutboxDueAt(): number | null {
    if (this.frozen()) return null;
    return this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM durable_outbox WHERE state IN ('pending', 'inflight')`,
    ).toArray()[0]?.due_at ?? null;
  }

  protected override scheduledAlarmDeferral(): Promise<number | null> {
    return Promise.resolve(null);
  }

  protected override onScheduledAlarmFailure(alarm: ScheduledAlarm, error: unknown, attempt: number): void {
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "sidekick_scheduled_alarm_failed",
      summary: "A legacy Sidekick object could not ask its Organization to import it; `code` is why.",
      attempt,
      fields: { automation_id: this.identity()?.automation_id ?? null, alarm_kind: alarm.kind, alarm_key: alarm.key },
      error,
    });
  }

  protected override onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void {
    logWarn(this.env, "sidekick_scheduled_alarm_stalled", {
      automation_id: this.identity()?.automation_id ?? null, alarm_kind: alarm.kind, alarm_key: alarm.key, attempt,
      code: diagnosticErrorCode(null, "sidekick_scheduled_alarm_stalled"),
    });
  }
}

/** The error every moved method answers: retryable, because the new route serves it. */
function parentMoved(): never {
  throw new Error("sidekick_parent_moved");
}

for (const method of MOVED_METHODS) {
  Object.defineProperty(SidekickDO.prototype, method, {
    value: async function moved() {
      parentMoved();
    },
    // The retirement gate below wraps every prototype method, these included.
    writable: true,
    configurable: true,
  });
}

applyRetirementGate(SidekickDO, {
  drop: {
    fetch: () => retiredObjectResponse(),
    // No socket callbacks: a Sidekick's transcript is served by its substream
    // agent, not by this object.
    alarm: () => Promise.resolve(),
  },
});
