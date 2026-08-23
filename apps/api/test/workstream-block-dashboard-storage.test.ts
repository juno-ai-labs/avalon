import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import {
  type BlockRunFence,
  WorkstreamBlockDashboardStorage,
} from "../src/durable-objects/workstream-block-dashboard-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const RUN = "00000000-0000-7000-8000-0000000000b1";
const ATTEMPT = "attempt-1";
const OWNER = "owner-1";
const NOW = 1_787_000_000_000;

const fence: BlockRunFence = { harnessRunId: RUN, attemptId: ATTEMPT, owner: OWNER };

const databases: DatabaseSync[] = [];

/**
 * A work stream with a live block-dashboard run holding its lease.
 *
 * `runs` rather than a `harness_runs` view: the object's own table is what the
 * fence reads, and seeding the view would be seeding the thing this slice
 * deletes.
 */
function open(): {
  storage: WorkstreamBlockDashboardStorage;
  sql: ReturnType<typeof createTestSqlStorage>;
} {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = createTestSqlStorage(database);
  const binding = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql,
  });
  applyWorkstreamObjectSchema(binding, "v", 1);
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
  return { storage: new WorkstreamBlockDashboardStorage(binding), sql };
}

/** The dispatch every test starts from: version row, run row, block row. */
function dispatch(overrides: Record<string, unknown> = {}) {
  return {
    configurationVersionId: "configuration-1",
    versionNumber: 1,
    blocksJson: JSON.stringify([{ id: "block-1", prompt: "What changed?" }]),
    createdByUserId: "W",
    configurationCreatedAt: NOW,
    blockRunId: "block-run-1",
    blockId: "block-1",
    prompt: "What changed?",
    triggerSequence: 3,
    harnessRunId: RUN,
    executionPrincipalJson: JSON.stringify({ type: "workspace", workspaceId: "W" }),
    model: "an-agent-model",
    createdAt: NOW,
    ...overrides,
  };
}

/** Put the seeded run's lease where the fence will accept it. */
function holdLease(sql: ReturnType<typeof createTestSqlStorage>): void {
  sql.exec(
    `UPDATE runs SET status = 'running', legacy_attempt_id = ?, lease_owner = ?,
       lease_expires_at = ? WHERE run_id = ?`,
    ATTEMPT,
    OWNER,
    NOW + 600_000,
    RUN,
  );
}

describe("admitting a HyperSight dispatch", () => {
  it("writes the configuration, the run and the block row as one fact", () => {
    const { storage, sql } = open();

    expect(storage.admitDispatch(dispatch())).toBe("admitted");

    // All three, because the block row's foreign key is the run row and the
    // version row. A dispatch that landed some of them would leave a block
    // pointing at nothing.
    expect(sql.exec(`SELECT COUNT(*) AS count FROM block_dashboard_configuration_versions`)
      .one().count).toBe(1);
    expect(sql.exec(`SELECT origin, status FROM runs WHERE run_id = ?`, RUN).toArray())
      .toEqual([{ origin: "block_dashboard_block", status: "admitted" }]);
    expect(sql.exec(
      `SELECT block_run_id, status, trigger_sequence FROM block_dashboard_block_runs`,
    ).toArray()).toEqual([
      { block_run_id: "block-run-1", status: "queued", trigger_sequence: 3 },
    ]);
  });

  it("reports a redelivered dispatch rather than writing it twice", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());

    // A queue redelivery names the same block run. The routed version learned
    // this by catching a UNIQUE violation and re-reading; the operation answers
    // it directly.
    expect(storage.admitDispatch(dispatch())).toBe("already_admitted");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM block_dashboard_block_runs`).one().count)
      .toBe(1);
  });

  it("admits a second block of the same refresh against one configuration version", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());

    // Concurrent blocks of one refresh all name the version row, which is why
    // it takes `INSERT OR IGNORE`; each still gets its own run and block row.
    expect(storage.admitDispatch(dispatch({
      blockRunId: "block-run-2",
      blockId: "block-2",
      harnessRunId: "00000000-0000-7000-8000-0000000000b2",
    }))).toBe("admitted");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM block_dashboard_configuration_versions`)
      .one().count).toBe(1);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM block_dashboard_block_runs`).one().count)
      .toBe(2);
  });

  it("refuses a dispatch naming an admitted pair for a different block", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());

    // `blockRunId` is a fresh uuidV7 per dispatch, not a value derived from
    // `blockId`, so this pair can only recur for the block it was admitted
    // under. Calling a mismatch a redelivery would let one block's markdown be
    // written under another block's row; the retired rescue compared `block_id`
    // for this reason and rethrew, and refusing here is that answer made
    // explicit rather than an exception nobody could read.
    expect(storage.admitDispatch(dispatch({ blockId: "block-9" })))
      .toBe("dispatch_conflict");
    expect(sql.exec(`SELECT block_id FROM block_dashboard_block_runs`).toArray())
      .toEqual([{ block_id: "block-1" }]);
  });
});

describe("the lease a block result is written under", () => {
  it("settles the block when the attempt still holds its run", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    holdLease(sql);

    expect(storage.settleBlockRun({
      blockRunId: "block-run-1",
      status: "completed",
      markdown: "## What changed\\n\\nPlenty.",
      errorJson: null,
      fence,
      now: NOW,
    })).toBe("written");
    expect(sql.exec(
      `SELECT status, markdown, completed_at FROM block_dashboard_block_runs`,
    ).toArray()).toEqual([
      { status: "completed", markdown: "## What changed\\n\\nPlenty.", completed_at: NOW },
    ]);
  });

  it("refuses a result from an attempt the run has replaced", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    holdLease(sql);
    sql.exec(`UPDATE runs SET legacy_attempt_id = 'a-successor' WHERE run_id = ?`, RUN);

    // The block is what a member reads. A stale executor writing here would
    // publish the result of work the run has already stopped believing in.
    expect(storage.settleBlockRun({
      blockRunId: "block-run-1",
      status: "completed",
      markdown: "from the loser",
      errorJson: null,
      fence,
      now: NOW,
    })).toBe("ownership_lost");
    expect(sql.exec(`SELECT status, markdown FROM block_dashboard_block_runs`).toArray())
      .toEqual([{ status: "queued", markdown: null }]);
  });

  it("refuses a result once the lease deadline has passed", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    holdLease(sql);

    // `now` is the caller's clock, and the fence compares against it rather
    // than against SQLite's — so a caller cannot pass an instant the lease does
    // not cover and have the write land anyway.
    expect(storage.settleBlockRun({
      blockRunId: "block-run-1",
      status: "completed",
      markdown: "too late",
      errorJson: null,
      fence,
      now: NOW + 600_001,
    })).toBe("ownership_lost");
    expect(sql.exec(`SELECT status FROM block_dashboard_block_runs`).toArray())
      .toEqual([{ status: "queued" }]);
  });

  it("refuses to settle a block that is already terminal", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    holdLease(sql);
    storage.settleBlockRun({
      blockRunId: "block-run-1", status: "completed", markdown: "first",
      errorJson: null, fence, now: NOW,
    });

    // Terminal is terminal. A second settle would rewrite a result a member may
    // already have read, and the routed statement scoped itself to
    // `('queued', 'running')` for the same reason. `already_terminal` rather
    // than `ownership_lost`: this attempt still holds the lease, and saying it
    // lost one would describe a takeover that did not happen.
    expect(storage.settleBlockRun({
      blockRunId: "block-run-1", status: "failed", markdown: null,
      errorJson: '{"code":"second"}', fence, now: NOW,
    })).toBe("already_terminal");
    expect(sql.exec(`SELECT status, markdown FROM block_dashboard_block_runs`).toArray())
      .toEqual([{ status: "completed", markdown: "first" }]);
  });

  it("records partial markdown under the same fence", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    holdLease(sql);

    expect(storage.submitMarkdown({
      blockRunId: "block-run-1", markdown: "in progress", fence, now: NOW,
    })).toBe("written");
    sql.exec(`UPDATE runs SET lease_owner = 'a-successor' WHERE run_id = ?`, RUN);
    expect(storage.submitMarkdown({
      blockRunId: "block-run-1", markdown: "from the loser", fence, now: NOW,
    })).toBe("ownership_lost");
    expect(sql.exec(`SELECT markdown FROM block_dashboard_block_runs`).toArray())
      .toEqual([{ markdown: "in progress" }]);
  });

  it("tells a late submission apart from a lost lease", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    holdLease(sql);
    storage.settleBlockRun({
      blockRunId: "block-run-1", status: "completed", markdown: "final",
      errorJson: null, fence, now: NOW,
    });

    // The submission tool racing its own run's terminal write: the lease is
    // still this attempt's, so nothing was taken from it — the block is simply
    // finished. The routed statement folded this into the same zero
    // `meta.changes` a lost lease produced, which is what made the two
    // indistinguishable to the caller.
    expect(storage.submitMarkdown({
      blockRunId: "block-run-1", markdown: "too late", fence, now: NOW,
    })).toBe("already_terminal");
    expect(sql.exec(`SELECT markdown FROM block_dashboard_block_runs`).toArray())
      .toEqual([{ markdown: "final" }]);
  });
});

describe("the dispatching agent's own lifecycle writes", () => {
  it("stamps started_at once and never moves it", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());

    expect(storage.recordBlockRunProgress({
      blockRunId: "block-run-1", harnessRunId: RUN, status: "running",
      errorJson: null, now: NOW,
    })).toBe(1);
    storage.recordBlockRunProgress({
      blockRunId: "block-run-1", harnessRunId: RUN, status: "running",
      errorJson: null, now: NOW + 5_000,
    });

    // When the block first began, not when it was last touched — a retried
    // dispatch must not make a long block look like it just started.
    expect(sql.exec(`SELECT started_at, completed_at FROM block_dashboard_block_runs`).toArray())
      .toEqual([{ started_at: NOW, completed_at: null }]);
  });

  it("is not fenced on the run lease, because the agent writes before one exists", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());

    // No lease has been claimed at all here. `BlockDashboardAgent` decided this
    // block would run and says so before an executor exists to hold one; the
    // fenced write is `settleBlockRun`, which is a claim about the *result*.
    expect(storage.recordBlockRunProgress({
      blockRunId: "block-run-1", harnessRunId: RUN, status: "running",
      errorJson: null, now: NOW,
    })).toBe(1);
    expect(sql.exec(`SELECT status FROM block_dashboard_block_runs`).toArray())
      .toEqual([{ status: "running" }]);
  });
});

describe("closing a block whose run was reaped", () => {
  it("closes it against the exact terminal stamp the reaper wrote", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    sql.exec(
      `UPDATE runs SET status = 'failed', terminalized_at = ? WHERE run_id = ?`,
      NOW,
      RUN,
    );

    expect(storage.abandonBlockRun({
      harnessRunId: RUN, terminalizedAt: NOW, errorJson: '{"code":"stale_run_reaped"}',
    })).toBe(1);
    expect(sql.exec(
      `SELECT status, error_json, completed_at FROM block_dashboard_block_runs`,
    ).toArray()).toEqual([
      { status: "failed", error_json: '{"code":"stale_run_reaped"}', completed_at: NOW },
    ]);
  });

  it("still closes the block when the sweep's instant is stale, because the run is over", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    sql.exec(
      `UPDATE runs SET status = 'failed', terminalized_at = ? WHERE run_id = ?`,
      NOW,
      RUN,
    );

    // The named write does not match — this sweep holds a stale instant and did
    // not perform the terminalization it is claiming. It used to stop there.
    //
    // The repair pass closes the block anyway, and that is the point: a
    // terminalized run's block must not stay open no matter which sweep
    // notices, because nothing else will ever look at it again. The instant
    // recorded is the run's own `terminalized_at`, not this caller's, so the
    // block still reports when its run actually ended rather than when the
    // repair happened.
    expect(storage.abandonBlockRun({
      harnessRunId: RUN, terminalizedAt: NOW - 1, errorJson: '{"code":"stale_run_reaped"}',
    })).toBe(1);
    expect(sql.exec(`SELECT status, completed_at FROM block_dashboard_block_runs`).toArray())
      .toEqual([{ status: "failed", completed_at: NOW }]);
  });

  it("repairs a block orphaned by a failed reap, on the next reap of the work stream", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    storage.admitDispatch(dispatch({
      configurationVersionId: "configuration-2",
      versionNumber: 2,
      blockRunId: "block-run-2",
      harnessRunId: "00000000-0000-7000-8000-0000000000b2",
    }));
    // The first run was terminalized in the regional database but its block was
    // never closed — the RPC that would have closed it failed. No later sweep
    // finds it: the selector is `status = 'running' AND terminalized_at IS
    // NULL`, which a terminalized run no longer matches.
    sql.exec(
      `UPDATE runs SET status = 'failed', terminalized_at = ? WHERE run_id = ?`,
      NOW - 60_000,
      RUN,
    );
    // Then a *different* run in the same work stream is reaped.
    sql.exec(
      `UPDATE runs SET status = 'failed', terminalized_at = ? WHERE run_id = ?`,
      NOW,
      "00000000-0000-7000-8000-0000000000b2",
    );

    expect(storage.abandonBlockRun({
      harnessRunId: "00000000-0000-7000-8000-0000000000b2",
      terminalizedAt: NOW,
      errorJson: '{"code":"stale_run_reaped"}',
    })).toBe(2);

    // Both closed: the one being reaped, and the orphan. The orphan reports the
    // instant its own run ended, not the instant the repair happened.
    expect(sql.exec(
      `SELECT block_run_id, status, completed_at FROM block_dashboard_block_runs
        ORDER BY block_run_id`,
    ).toArray()).toEqual([
      { block_run_id: "block-run-1", status: "failed", completed_at: NOW - 60_000 },
      { block_run_id: "block-run-2", status: "failed", completed_at: NOW },
    ]);
  });

  it("closes nothing while the run is still live", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    holdLease(sql);

    expect(storage.abandonBlockRun({
      harnessRunId: RUN, terminalizedAt: NOW, errorJson: '{"code":"stale_run_reaped"}',
    })).toBe(0);
    expect(sql.exec(`SELECT status FROM block_dashboard_block_runs`).toArray())
      .toEqual([{ status: "queued" }]);
  });
});

describe("what the parent terminalization reads", () => {
  it("reports a persisted result only once markdown exists", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    holdLease(sql);

    expect(storage.hasPersistedResult({ harnessRunId: RUN })).toBe(false);
    storage.settleBlockRun({
      blockRunId: "block-run-1", status: "completed", markdown: null,
      errorJson: null, fence, now: NOW,
    });
    // Completed with no markdown is not a result. A HyperSight run that has not
    // produced markdown has not produced the thing it exists for, and calling
    // it completed leaves a member looking at an empty block.
    expect(storage.hasPersistedResult({ harnessRunId: RUN })).toBe(false);

    sql.exec(`UPDATE block_dashboard_block_runs SET markdown = 'done'`);
    expect(storage.hasPersistedResult({ harnessRunId: RUN })).toBe(true);
  });

  it("answers nothing for a run that is not a block run at all", () => {
    const { storage, sql } = open();
    storage.admitDispatch(dispatch());
    sql.exec(
      `INSERT INTO runs
         (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
          next_action_cursor, input_fence_seq, revision, started_at,
          active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
          tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
          origin, execution_principal_json, chain_depth, model, created_at, updated_at)
       VALUES (?, '0', 'running', '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
               'member_message', '{}', 0, 'a-model', ?, ?)`,
      "00000000-0000-7000-8000-0000000000c1",
      NOW,
      NOW,
      NOW,
    );

    // The terminalization asks this of *every* run to find out whether it is a
    // HyperSight one, so "no block" is an ordinary answer rather than a miss —
    // it is what routes an ordinary run past the block settlement entirely.
    // A block run of the same work stream is present throughout, so answering
    // by run rather than by "the work stream has blocks" is what is under test.
    expect(storage.blockRunForHarnessRun({
      harnessRunId: "00000000-0000-7000-8000-0000000000c1",
    })).toBeUndefined();
    expect(storage.blockRunForHarnessRun({ harnessRunId: RUN })?.block_run_id)
      .toBe("block-run-1");
  });

  it("reads the newest configuration version by number, not by insertion", () => {
    const { storage } = open();
    storage.admitDispatch(dispatch());
    storage.admitDispatch(dispatch({
      configurationVersionId: "configuration-3",
      versionNumber: 3,
      blockRunId: "block-run-3",
      harnessRunId: "00000000-0000-7000-8000-0000000000b3",
    }));
    storage.admitDispatch(dispatch({
      configurationVersionId: "configuration-2",
      versionNumber: 2,
      blockRunId: "block-run-2",
      harnessRunId: "00000000-0000-7000-8000-0000000000b2",
    }));

    // Written out of order deliberately: the caller compares this against the
    // version a block was planned against to decide whether its result is
    // stale, so "newest" has to mean the highest version rather than the last
    // row written.
    expect(storage.latestConfigurationVersionId()).toBe("configuration-3");
  });
});
