import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  HARNESS_RUN_OPERATIONS,
  mutatesRunState,
} from "../src/durable-objects/workstream-harness-run-protocol";
import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamHarnessRunStorage } from "../src/durable-objects/workstream-harness-run-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const NOW = 1_787_000_000_000;
const RUN = "00000000-0000-7000-8000-0000000000b1";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function open() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = createTestSqlStorage(database);
  const binding = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql,
  });
  applyWorkstreamObjectSchema(binding, "harness-run-protocol-test", NOW);
  sql.exec(`INSERT INTO workstream (
      id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
      authority_mode, authority_generation, title, description, preview, scope,
      exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
      unread_tracking_start_ordinal, authority_epoch, scope_epoch,
      source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
      created_at, last_people_activity_at, state_changed_at, updated_at
    ) VALUES (1,'S','W',NULL,0,'global','authoritative',1,'T','','','workspace',
              'idle','s',1,1,0,0,0,0,0,0,0,1,1,1,1)`);
  sql.exec(`INSERT INTO substreams (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
    VALUES ('0','main','none',0,'none','workspace','full','open',1)`);
  return { storage: new WorkstreamHarnessRunStorage(binding), sql };
}

function seedRun(sql: SqlStorage, runId: string): void {
  sql.exec(
    `INSERT INTO runs
       (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
        next_action_cursor, input_fence_seq, revision, started_at,
        active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
        tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
        origin, execution_principal_json, chain_depth, created_at, updated_at)
     VALUES (?, '0', 'admitted', '{}', 0, 0, '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
             'member_message', '{}', 0, 1, 1)`,
    runId,
  );
}

/** The whole `workstream` row, so no column's change goes unnoticed. */
function workstreamRow(sql: SqlStorage): Record<string, unknown> {
  return sql.exec(`SELECT * FROM workstream WHERE id = 1`).one() as Record<string, unknown>;
}

describe("which harness-run operations commit a directory projection", () => {
  it("classifies exactly the operations that write the work stream's own row", () => {
    // Kept as a literal rather than derived, so adding an operation to the set
    // is a decision someone makes here rather than a side effect of editing the
    // list above it. Both lists live in the same file and share entries, which
    // is how nine reads and progress writes once ended up on this one.
    expect(HARNESS_RUN_OPERATIONS.filter(mutatesRunState).sort()).toEqual([
      "admitRun",
      "claimAttempt",
      "failUnlaunchedRun",
      "launchRun",
      // Not a state write, but a transcript one: it appends the run's final
      // message, which moves the preview and the activity clock the sidebar
      // renders. The set is "writes the work stream's own row", and this does.
      "publishFinalMessage",
      "reapStaleRoot",
      "terminalizeAttempt",
      "terminalizeQueuedRun",
    ]);
  });

  it("leaves the work stream untouched for reads and run-local bookkeeping", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    storage.claimAttempt({
      runId: RUN, attemptId: "a1", owner: "o1", now: NOW,
      leaseSeconds: 60, lifecycleEventId: "e1",
    });
    const before = workstreamRow(sql);

    // Every one of these was on `RUN_STATE_WRITES` at some point in this
    // branch's history. A projection costs a walk of the work stream's
    // participants and resource links, and a usage flush runs every few
    // seconds — so the cost of misclassifying one is not theoretical.
    storage.latestRootRun();
    storage.runIsActive({ runId: RUN });
    storage.triggerPartId({ runId: RUN });
    storage.staleLeaseRuns({ blockOnly: false, now: NOW + 90_000, limit: 10 });
    storage.reapableInlineChildren({ now: NOW + 90_000, limit: 10 });
    storage.residualRepairCandidates({
      markerEventKey: "residual_receipts_settled", blockOnly: false, limit: 10,
    });
    storage.recordRunProgress({
      runId: RUN, attemptId: "a1", owner: "o1", now: NOW + 1_000,
      model: "a-model", usageJson: '{"inputTokens":1}',
    });
    storage.bindWorkflowInstance({
      runId: RUN, workflowInstanceId: "wf-1", now: NOW + 1_000,
    });

    expect(workstreamRow(sql)).toEqual(before);
  });

  it("writes the work stream's row for every operation it does classify", () => {
    const { storage, sql } = open();
    seedRun(sql, RUN);
    const before = workstreamRow(sql);

    storage.claimAttempt({
      runId: RUN, attemptId: "a1", owner: "o1", now: NOW,
      leaseSeconds: 60, lifecycleEventId: "e1",
    });

    // The other direction of the same rule: an operation on the list has to
    // earn its place by actually moving what the sidebar renders.
    expect(workstreamRow(sql)).not.toEqual(before);
    expect(workstreamRow(sql)).toMatchObject({ exact_state: "running" });
  });
});
