PRAGMA foreign_keys = ON;

-- The demo feature's regional tables: one preparation per demo, what each of
-- its phases left behind, and what the seeder confirmed.
--
-- The operator initiates one operation per demo, and everything about the demo
-- hangs off that identity: repeated submission of the same operation resolves
-- to the same row and the same progress rather than preparing a second
-- workspace, and two different operations are two demos. The row exists from
-- the moment the operator asks — before a workspace has been allocated — and it
-- is also the register of which workspaces this feature published: a workspace
-- enters it when the creating phase allocates its id, is published when
-- `ready_at` is set, and is closed when `retired_at` is set. Discovery reads it
-- to withhold an unpublished candidate from its members; the Demos page reads
-- it to list every demo, live or not, of which there may be any number at once.
-- It is not an authorization input for retirement; that gate was considered and
-- dropped, and retirement is an operator action on any workspace behind Ace's
-- Access policy.
--
-- `demo-template` is never a row here. It is built by hand and never published.
CREATE TABLE demo_operations (
  operation_id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  presenter_user_id TEXT NOT NULL REFERENCES users(id),
  pack_version TEXT NOT NULL,
  -- Which member plays which pack role, as {role: user id}. Bound when the
  -- operator asks, never by the pack.
  cast_json TEXT NOT NULL,
  -- Allocated by the creating phase and written here *before* the workspace
  -- row exists, so a crash between the two retries the same id rather than
  -- allocating a second workspace. That ordering is why this column carries no
  -- foreign key to `workspaces`: D1 enforces one on the write, and the write
  -- has to precede the row it would reference.
  workspace_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed', 'abandoned')),
  -- Each retry is a new attempt of the same operation. Phases record which
  -- attempt confirmed them, and a driver whose attempt is no longer the row's
  -- writes nothing.
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  failed_phase TEXT,
  error_code TEXT,
  error_message TEXT,
  -- NULL until every viewer's projection matched the pack. A candidate is
  -- withheld from discovery, switching and activation until this is set, so an
  -- early direct activation shows preparation rather than a half-populated
  -- sidebar.
  ready_at TEXT,
  -- NULL until retirement completed its whole graph. Set is the tombstone's
  -- regional shadow: what the Demos page reads to say a demo is gone without
  -- waking the object to ask.
  retired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The Demos page lists operations newest first.
CREATE INDEX demo_operations_recent_idx ON demo_operations(created_at DESC);

-- What the operator sees while a demo is being prepared: the current phase,
-- what it has completed so far, and what stopped it. One row per phase per
-- operation, overwritten by a retry of the same phase; the detail is a small
-- JSON object the page renders — copied connections, confirmed seed actions,
-- the readiness gaps still open — and never a secret. The phase names are the
-- contract's, not a CHECK: they are a product decision that will move, and
-- SQLite cannot widen a CHECK in place.
CREATE TABLE demo_operation_phases (
  operation_id TEXT NOT NULL REFERENCES demo_operations(operation_id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  detail_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (operation_id, phase)
);

-- What the demo seeder wrote, one row per pack action it confirmed.
--
-- The seeder plays a pack through Rally's ordinary write paths — the creation
-- service, the room's message admission, the resource upload — and none of
-- those know they were seeding. This table is where the seeder records that an
-- action reached its specified outcome, and which destination ids it produced:
-- the work stream, the human turn, the run and how it settled, the resource,
-- the elicitation. Two readers. Preparation resumes from it, skipping an action
-- already confirmed instead of writing it twice. And the readiness barrier
-- generates its expected manifest from it, because the pack says what should
-- exist and only the receipts say what does.
--
-- A row is written only once the action's outcome is confirmed — a run that
-- has settled the way its turn said it would, a message that was admitted, a
-- resource that is attached. An action that was applied but never confirmed
-- has no row, and replaying it is safe: every seeded write carries a client
-- message id or resource id derived from the operation and action, so the
-- production path's own receipt answers the replay.
CREATE TABLE demo_seed_receipts (
  operation_id TEXT NOT NULL REFERENCES demo_operations(operation_id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('create_workstream', 'message', 'upload')),
  -- The pack's own name for the room, which is how a later action finds the
  -- work stream an earlier one created.
  room TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  -- The human turn this action wrote, for a create or a message.
  turn_id TEXT,
  -- The run the turn started and how it settled, when it started one.
  harness_run_id TEXT,
  run_outcome TEXT CHECK (run_outcome IN ('completed', 'needs_input')),
  -- The real elicitation an `ask` turn opened.
  elicitation_id TEXT,
  -- The resource an upload created and attached.
  resource_id TEXT,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, action_id)
);

-- Retirement's cascade and a per-workspace audit read by workspace; the
-- barrier reads an operation's receipts by the primary key.
CREATE INDEX demo_seed_receipts_workspace_idx ON demo_seed_receipts(workspace_id);
