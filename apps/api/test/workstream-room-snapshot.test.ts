import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { loadWorkstreamRoomSnapshot } from "../src/durable-objects/workstream-room";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const workspaceId = "00000000-0000-7000-8000-0000000000b0";
const readerId = "00000000-0000-7000-8000-0000000000b2";
const otherId = "00000000-0000-7000-8000-0000000000b3";
const workstreamId = "00000000-0000-7000-8000-0000000000b1";
const at = "2026-08-11T09:00:00.000Z";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("work-stream room snapshot", () => {
  // The room answers a failed snapshot with `snapshot_unavailable` and the
  // client resynchronizes over REST, so a snapshot that does not satisfy the
  // contract costs every live update between connecting and that refetch —
  // including the rename the naming agent publishes seconds after creation.
  it("satisfies the work-stream contract, read state included", async () => {
    const database = seededDatabase();
    const env = { DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" } as unknown as Env;

    const snapshot = await loadWorkstreamRoomSnapshot(env, {
      workspaceId,
      workstreamId,
      viewerUserId: readerId,
      viewers: [],
    });

    expect(snapshot).toMatchObject({
      id: workstreamId,
      title: "Investigate checkout failures",
      readThroughSequenceNumber: 4,
      latestAttentionSequenceNumber: 6,
      hasUnread: true,
      firstUnreadSequenceNumber: 5,
      manualUnreadFromSequenceNumber: null,
      manualUnreadGeneration: 0,
    });
  });

  // A snapshot replaces the client's whole detail rather than merging into it,
  // so a field the snapshot omits is a field the client loses until its next
  // REST read. Naming only the run's id cost a work stream its work timer for
  // the whole of any run that was already going when its socket connected.
  it("describes the latest harness run, not only its id", async () => {
    const database = seededDatabase();
    database.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, started_at, model, created_at)
       VALUES (?, ?, ?, 'opening_message', ?, 'running', ?, 'x-ai/grok-4.3', ?)`,
    ).run(
      "00000000-0000-7000-8000-0000000000b9",
      workspaceId,
      workstreamId,
      JSON.stringify({ type: "user", userId: readerId }),
      at,
      at,
    );
    const env = { DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" } as unknown as Env;

    const snapshot = await loadWorkstreamRoomSnapshot(env, {
      workspaceId,
      workstreamId,
      viewerUserId: readerId,
      viewers: [],
    });

    expect(snapshot.latestHarnessRunId).toBe("00000000-0000-7000-8000-0000000000b9");
    expect(snapshot.latestHarnessRun).toMatchObject({
      id: "00000000-0000-7000-8000-0000000000b9",
      origin: "opening_message",
      status: "running",
      model: "x-ai/grok-4.3",
      startedAt: at,
      completedAt: null,
      error: null,
    });
  });

  // A `scheduled` run is inserted with a NULL `started_at`, and SQLite sorts
  // NULLs last under DESC. Ordering by it would hand a subscriber the previous,
  // finished run — and because a snapshot replaces the whole detail, that wrong
  // answer would overwrite the right one the client already had.
  it("reports the newest run even when it has not started yet", async () => {
    const database = seededDatabase();
    const insert = database.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, started_at, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "00000000-0000-7000-8000-0000000000c1", workspaceId, workstreamId, "opening_message",
      JSON.stringify({ type: "user", userId: readerId }), "completed",
      "2026-08-11T09:00:00.000Z", "2026-08-11T09:00:30.000Z", "2026-08-11T09:00:00.000Z",
    );
    insert.run(
      "00000000-0000-7000-8000-0000000000c2", workspaceId, workstreamId, "automation_run",
      JSON.stringify({ type: "user", userId: readerId }), "scheduled",
      null, null, "2026-08-11T10:00:00.000Z",
    );
    const env = { DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" } as unknown as Env;

    const snapshot = await loadWorkstreamRoomSnapshot(env, {
      workspaceId,
      workstreamId,
      viewerUserId: readerId,
      viewers: [],
    });

    expect(snapshot.latestHarnessRunId).toBe("00000000-0000-7000-8000-0000000000c2");
    expect(snapshot.latestHarnessRun).toMatchObject({ status: "scheduled", startedAt: null });
  });

  it("stops reporting a work stream as being named long after anything could be", async () => {
    const database = seededDatabase();
    database.prepare("UPDATE workstreams SET title_status = 'naming', created_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", workstreamId);
    const env = { DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" } as unknown as Env;

    // The row was created hours ago and its naming pass never settled it, so
    // the placeholder title is the title — a skeleton in front of it would
    // pulse for as long as the work stream exists.
    const stalled = await loadWorkstreamRoomSnapshot(env, {
      workspaceId,
      workstreamId,
      viewerUserId: readerId,
      viewers: [],
    });
    expect(stalled.titleStatus).toBe("automatic");

    database.prepare("UPDATE workstreams SET created_at = ? WHERE id = ?")
      .run(new Date().toISOString(), workstreamId);
    const fresh = await loadWorkstreamRoomSnapshot(env, {
      workspaceId,
      workstreamId,
      viewerUserId: readerId,
      viewers: [],
    });
    expect(fresh.titleStatus).toBe("naming");
  });

  it("reads the read state of the subscriber it is built for", async () => {
    const database = seededDatabase();
    const env = { DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" } as unknown as Env;

    const other = await loadWorkstreamRoomSnapshot(env, {
      workspaceId,
      workstreamId,
      viewerUserId: otherId,
      viewers: [],
    });

    // No persisted read state: unread starts from the work stream's own
    // tracking boundary rather than from sequence zero.
    expect(other).toMatchObject({ readThroughSequenceNumber: 6, hasUnread: false });
  });
});

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('${readerId}', 'google-reader', 'reader@example.com', 'Reader', '${at}', '${at}'),
      ('${otherId}', 'google-other', 'other@example.com', 'Other', '${at}', '${at}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Avalon', 'avalon', 'global', '${readerId}', '${at}', '${at}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES
      ('${workspaceId}', '${readerId}', 'owner', 'active', '${at}'),
      ('${workspaceId}', '${otherId}', 'member', 'active', '${at}');
  `);
  database.prepare(
    `INSERT INTO workstreams
     (id, workspace_id, title, objective, email_address, email_route_status, origin_type,
      created_by_user_id, harness_status, next_sequence_number, latest_attention_sequence_number,
      unread_tracking_start_sequence_number, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 'Investigate checkout failures', 'Find the cause', ?, 'active', 'ad_hoc', ?, 'running', 7, 6, 6, ?, ?, ?)`,
  ).run(
    workstreamId,
    workspaceId,
    "calm-bright-gentle-otter@automation.with-avalon.com",
    readerId,
    at,
    at,
    at,
  );
  database.prepare(
    `INSERT INTO workstream_participants
     (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
     VALUES (?, ?, ?, 'creator', ?, NULL)`,
  ).run(workstreamId, readerId, readerId, at);
  database.prepare(
    `INSERT INTO workstream_read_states
     (workspace_id, workstream_id, user_id, read_through_sequence_number,
      manual_unread_from_sequence_number, manual_unread_generation, updated_at)
     VALUES (?, ?, ?, 4, NULL, 0, ?)`,
  ).run(workspaceId, workstreamId, readerId, at);
  return database;
}
