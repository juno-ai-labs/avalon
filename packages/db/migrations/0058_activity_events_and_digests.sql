-- Two things land together here because the second is the first's first
-- consumer: a generic first-party activity log, and the scheduled digest that
-- reads it.
--
-- `activities` stays exactly what it is — the provider ingest table, keyed by
-- connection and provider event id. It answers "what did GitHub tell us", not
-- "what happened in Avalon that a person should hear about". Those are
-- different questions: an Avalon mention has no connection, a work-stream
-- message has no provider event id, and neither has a dedupe key a provider
-- controls. `activity_events` below is the second question's table. Connector
-- activity is projected into it once it has been processed, so every surface
-- that wants "what happened, for this person, since this instant" reads one
-- table rather than unioning ingest tables it should not have to know about.

PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Generic first-party activity log
-- ---------------------------------------------------------------------------

CREATE TABLE activity_events (
  -- The cursor axis, and the reason this table has an integer key at all.
  --
  -- A consumer resumes where it stopped, so it needs a total order that an
  -- insert can only ever extend. A timestamp cannot provide one: two events
  -- written in the same millisecond tie, and whichever tiebreak is chosen —
  -- a UUID, a hash — can place the second one *below* a cursor taken after the
  -- first, which silently drops it from every future read. AUTOINCREMENT is
  -- what makes this strict: plain rowids are reused after a delete, which would
  -- let a new event appear beneath a cursor that has already passed.
  log_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- A dotted, past-tense verb: 'workstream.message.posted',
  -- 'workstream.mention.created', 'connector.activity.received'. A new producer
  -- adds a value, never a column, and no consumer has to enumerate them — the
  -- digest groups by subject and renders `title`/`body`, so an event type it has
  -- never seen still reads correctly.
  event_type TEXT NOT NULL,
  -- The Avalon object the event is about. `subject_id` is intentionally not a
  -- foreign key: the table it points at varies by `subject_type`, and an event
  -- is a historical record that must outlive the row it describes.
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  -- Position within the subject, when the subject has an ordering. Work-stream
  -- events carry the message sequence number, which is the same unit
  -- `workstream_read_states.read_through_sequence_number` is expressed in, so a
  -- consumer can compare an event against a reader's waterline without joining
  -- back to `messages`.
  subject_sequence_number INTEGER,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'external')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Display name frozen at write time. An external actor has no Avalon user to
  -- resolve later, and a member who leaves should not blank out history.
  actor_label TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  canonical_url TEXT,
  -- Who may read this event. Resolved at read time rather than fanned out into
  -- one row per recipient: a work stream's participant set changes, and an event
  -- should follow the current set rather than the set that existed when it was
  -- written.
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('workspace', 'user', 'workstream')),
  audience_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  audience_workstream_id TEXT REFERENCES workstreams(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  -- Wall-clock insertion time, for display and retention only. Deliberately not
  -- a cursor axis — `log_sequence` above is — because a connector poll inserts
  -- events whose provider timestamp is hours old and a clock can move backwards.
  created_at TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT,
  -- Producer-chosen identity for the event, so a retried write, a replayed
  -- queue message, or a re-processed activity resolves to the row the first
  -- attempt made instead of duplicating it in someone's digest.
  dedupe_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (workspace_id, dedupe_key),
  CHECK (
    (audience_kind = 'workspace' AND audience_user_id IS NULL AND audience_workstream_id IS NULL)
    OR (audience_kind = 'user' AND audience_user_id IS NOT NULL AND audience_workstream_id IS NULL)
    OR (audience_kind = 'workstream' AND audience_user_id IS NULL AND audience_workstream_id IS NOT NULL)
  )
);

-- Every consumer reads a half-open window of one workspace's log in insertion
-- order, so this is the one index that matters.
CREATE INDEX activity_events_cursor_idx
  ON activity_events(workspace_id, log_sequence);
-- The two audience-scoped reads. A workspace-audience event matches every
-- member and needs no index of its own beyond the cursor above.
CREATE INDEX activity_events_audience_user_idx
  ON activity_events(workspace_id, audience_user_id, log_sequence)
  WHERE audience_user_id IS NOT NULL;
CREATE INDEX activity_events_audience_workstream_idx
  ON activity_events(workspace_id, audience_workstream_id, log_sequence)
  WHERE audience_workstream_id IS NOT NULL;

-- Named involvement, separate from audience. Audience says who is allowed to
-- see the event; this says who the event is *about*, which is what lets a
-- digest lead with "you were mentioned" instead of burying it in a list of
-- everything that moved.
CREATE TABLE activity_event_targets (
  event_id TEXT NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'mentioned', 'assigned', 'review_requested', … Open for the same reason
  -- `event_type` is.
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id, relation)
);

CREATE INDEX activity_event_targets_user_idx
  ON activity_event_targets(workspace_id, user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Hidden system work streams
-- ---------------------------------------------------------------------------

-- The agent loop is work-stream shaped end to end: the transcript is `messages`,
-- compaction, tool invocations, artifacts and the realtime room all key off
-- `workstream_id`. An internal run that needs the whole loop therefore needs a
-- work stream, but not a place in anybody's sidebar. `system_kind` marks those:
-- NULL is a normal, user-visible work stream, and any non-NULL value is
-- machinery that every listing surface filters out.
ALTER TABLE workstreams ADD COLUMN system_kind TEXT
  CHECK (system_kind IS NULL OR system_kind IN ('digest'));

-- ---------------------------------------------------------------------------
-- Digest schedules
-- ---------------------------------------------------------------------------

CREATE TABLE digest_schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Bit 0 is Sunday through bit 6 Saturday. A digest picks days and, separately,
  -- times; it deliberately cannot vary the times per day, so one integer and a
  -- set of times is the whole model rather than a seven-way join.
  --
  -- There is no timezone column. A digest's times are wall-clock times in the
  -- owner's own day, and `users.timezone` already says when that is. A second
  -- copy here would be a second answer to the same question, and the two would
  -- disagree the first time somebody moved. The derived `schedules` rows carry
  -- the resolved zone, because that is the scheduler's own contract, and they
  -- are rebuilt when the account timezone changes.
  day_mask INTEGER NOT NULL CHECK (day_mask BETWEEN 0 AND 127),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- The hidden work stream this schedule's runs execute in, created lazily on
  -- the first firing.
  system_workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
  -- Re-validated at fire time, exactly as an automation subscription's is, so a
  -- schedule cannot outlive the authority it was saved with.
  execution_principal_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- One digest configuration per person per workspace. Several delivery times
  -- live in `digest_schedule_times` below; several *schedules* would be a second
  -- way to say the same thing.
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE digest_schedule_times (
  digest_schedule_id TEXT NOT NULL REFERENCES digest_schedules(id) ON DELETE CASCADE,
  -- Local wall-clock minute in the owner's own timezone, 0..1439.
  minute_of_day INTEGER NOT NULL CHECK (minute_of_day BETWEEN 0 AND 1439),
  PRIMARY KEY (digest_schedule_id, minute_of_day)
);

-- Where a digest goes once it is written. Email is the default and needs no
-- connector; every other destination is a connection whose connector declares a
-- `userDelivery` surface, frozen here against the provider identity it resolved
-- to — the same freeze `automation_delivery_targets` performs, for the same
-- reason: a workspace-wide installation addresses nobody until a specific person
-- is named.
CREATE TABLE digest_delivery_targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  digest_schedule_id TEXT NOT NULL REFERENCES digest_schedules(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Open rather than enumerated: the shape check below is written per *family*
  -- (email versus connector-addressed), so a connector that declares a new
  -- delivery surface becomes selectable without a migration.
  target_type TEXT NOT NULL,
  connection_id TEXT REFERENCES connector_connections(id) ON DELETE CASCADE,
  provider_tenant_id TEXT,
  provider_user_id TEXT,
  email_address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_input', 'disabled')),
  last_delivered_at TEXT,
  last_delivered_delivery_id TEXT,
  last_error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (digest_schedule_id, target_type),
  CHECK (
    (target_type = 'email'
      AND connection_id IS NULL AND provider_tenant_id IS NULL
      AND provider_user_id IS NULL AND email_address IS NOT NULL)
    OR (target_type <> 'email'
      AND connection_id IS NOT NULL AND provider_tenant_id IS NOT NULL
      AND provider_user_id IS NOT NULL AND email_address IS NULL)
  )
);

CREATE INDEX digest_delivery_targets_connection_idx
  ON digest_delivery_targets(connection_id, status);

-- One row per fired occurrence. This is both the idempotency record and the
-- cursor: `cursor_through` of the latest settled delivery is where the next one
-- starts reading, which is why the digest never repeats itself and never touches
-- `workstream_read_states`. A person's unread badges mean "what I have not
-- read"; a digest cursor means "what I have already been told". Collapsing them
-- would make skimming an email on a phone silently clear the app.
CREATE TABLE digest_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  digest_schedule_id TEXT NOT NULL REFERENCES digest_schedules(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The scheduled instant this delivery belongs to, which is what makes a
  -- re-fired alarm resolve to the existing row instead of digesting twice.
  planned_for TEXT NOT NULL,
  -- Exclusive lower bound on `activity_events.log_sequence`; NULL on a person's
  -- first ever digest, which reads a bounded look-back window instead.
  cursor_from INTEGER,
  -- Inclusive upper bound, frozen when the window is taken so that events
  -- arriving mid-run belong to the next digest rather than being skipped.
  cursor_through INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  -- How many of those events name this person directly. Counted from the window
  -- the run was actually given, and stored rather than recomputed, because a
  -- later count would have to re-derive the audience filter, the look-back
  -- floor, and the per-run cap to reach the same number.
  highlight_count INTEGER NOT NULL DEFAULT 0 CHECK (highlight_count >= 0),
  harness_run_id TEXT REFERENCES harness_runs(id) ON DELETE SET NULL,
  -- 'empty' is a settled outcome, not a failure: nothing happened, nothing was
  -- sent, and the cursor still advances so the next digest does not re-scan it.
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'running', 'delivered', 'empty', 'failed')),
  summary_markdown TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (digest_schedule_id, planned_for)
);

-- Reading the cursor is "the newest settled delivery for this schedule".
CREATE INDEX digest_deliveries_cursor_idx
  ON digest_deliveries(digest_schedule_id, status, planned_for DESC);

-- ---------------------------------------------------------------------------
-- Digests join the workspace scheduler
-- ---------------------------------------------------------------------------

-- A digest is recurring timing with no payload, which is precisely what
-- `schedules` is for — unlike a work-stream wake-up, which is one-shot and
-- carries a prompt, and so kept its own table. Adding the column means widening
-- the "exactly one target" CHECK, and SQLite only rewrites a CHECK by rebuilding
-- the table.
--
-- One `schedules` row is created per delivery *time*, not per digest. A single
-- RRULE cannot express an arbitrary list of times: BYHOUR and BYMINUTE multiply
-- out, so 09:00 and 12:30 would also yield 09:30 and 12:00. One rule per time
-- says exactly what the person asked for, and the scheduler already retries,
-- advances, and disables each row independently.
CREATE TABLE schedules_with_digests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_subscription_id TEXT REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
  connector_connection_id TEXT REFERENCES connector_connections(id) ON DELETE CASCADE,
  digest_schedule_id TEXT REFERENCES digest_schedules(id) ON DELETE CASCADE,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('calendar', 'interval')),
  rrule TEXT,
  interval_seconds INTEGER,
  timezone TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((automation_subscription_id IS NOT NULL)
       + (connector_connection_id IS NOT NULL)
       + (digest_schedule_id IS NOT NULL) = 1),
  CHECK ((schedule_type = 'calendar' AND rrule IS NOT NULL) OR (schedule_type = 'interval' AND interval_seconds IS NOT NULL))
);

INSERT INTO schedules_with_digests (
  id, workspace_id, automation_subscription_id, connector_connection_id,
  digest_schedule_id, schedule_type, rrule, interval_seconds, timezone,
  next_run_at, last_run_at, enabled, version, created_at, updated_at
)
SELECT id, workspace_id, automation_subscription_id, connector_connection_id,
       NULL, schedule_type, rrule, interval_seconds, timezone,
       next_run_at, last_run_at, enabled, version, created_at, updated_at
FROM schedules
-- The old CHECK allowed both target columns to be set at once. Nothing writes
-- that, but the new CHECK forbids it, so a stray row would fail the copy rather
-- than the migration silently dropping it.
WHERE (automation_subscription_id IS NOT NULL) + (connector_connection_id IS NOT NULL) = 1;

DROP TABLE schedules;

ALTER TABLE schedules_with_digests RENAME TO schedules;

CREATE INDEX schedules_due_idx ON schedules(workspace_id, enabled, next_run_at);
CREATE INDEX schedules_digest_idx ON schedules(digest_schedule_id)
  WHERE digest_schedule_id IS NOT NULL;

PRAGMA defer_foreign_keys = OFF;
