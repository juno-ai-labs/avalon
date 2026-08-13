# Data model

Avalon's canonical product state is one D1 database per region, and **the
checked-in migrations are authoritative** — this document is the map of what the
tables mean and which rules the schema is holding up, not a second copy of the
DDL. Application contracts expose camel-cased TypeScript values; storage uses
explicit snake-cased columns, and JSON only where provider- or model-shaped data
is not relationally queried.

Read it before adding a table, a column, or a migration, and before assuming that
knowing an object's ID is enough to read it — it never is.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/NNNN_*.sql` | The authoritative schema. Monotonically numbered, immutable once deployed. |
| `packages/db/src/index.ts` | Region-aware repositories and the D1 wrapper every service is handed. |
| `packages/db/test/migrations.test.ts` | Applies every migration in order and asserts on the resulting schema. |
| `packages/db/seed.sql` | The local development seed. |
| `apps/api/src/lib/workstream-visibility.ts` | The single expression of who may read a work stream, parameterized by the SQL naming the reader. |
| `apps/api/src/mappers/connection.ts`, `apps/api/src/mappers/workstream.ts` | Row schemas parsed at the read — the pattern the remaining hand-coercing readers are converging on. |
| `apps/api/src/telemetry/` | The only services that interpret telemetry rows, deadlines, destination state, and EU analysis projections. |
| `packages/contracts` | The camel-cased shapes the columns are mapped into. |

## How it works

### Identity and tenancy

- `users` stores Google identity subjects and display information.
- `workspaces` pins an immutable `global` or `eu` region.
- `workspace_members` authorizes users as owner, admin, or member.
- `sessions`, `oauth_states`, and `desktop_login_tickets` support revocable
  sessions, PKCE, and single-use Electron deep-link completion.
- `workspace_invitations` supports explicit membership growth without introducing
  a workspace switcher in V1.

Every tenant-owned table carries `workspace_id`, and every repository lookup
includes it. Knowing an object ID is never sufficient authorization.

### Work streams

- `workstreams` is the central object. `origin_type` distinguishes ad hoc work
  from automation output without splitting the UI. `objective` is the work
  stream's description; `description_source` records whether a person wrote it
  (`authored`) or it was derived at creation or by the refresh loop (`derived`),
  which is what lets an automatic rewrite weigh a deliberate line differently from
  a copied opening message. `title_status` is the same question for the title:
  `naming` while the naming agent is choosing the first one and the stored title
  is a placeholder clients render as a skeleton, `automatic` once Avalon has named
  it and one later pass may still replace it, `settled` when a person named it, a
  caller supplied it, or that pass has run.
- `workstream_description_refreshes` holds one row per work stream: the last
  evaluation by the loop that rewrites a description once the work stream's
  purpose has moved. `rest_until` is both the admission clock and the
  single-writer claim — it is pushed forward when an evaluation starts, so two
  runs finishing together cannot both spend a window and a failing model is not
  retried by every run behind it. It stores the resolved instant rather than the
  inputs because the rest is earned: `consecutive_keeps` doubles it to a ceiling,
  a rewrite returns it to the floor, and a person editing the description buys a
  full rest outright. `decision` records the outcome including `kept`, because
  knowing the loop looked is what separates a description that still fits from one
  nothing has examined. See
  [`workstream-descriptions.md`](workstream-descriptions.md).
- `workstreams.scope` answers who may read a work stream, in the same
  `personal`/`workspace` vocabulary `notes.scope` uses. `personal` is enforced as
  "an active participant, and nobody else" by both the list query and the
  single-row read, so privacy is a declared property of the row rather than a rule
  each caller has to remember. Existing rows are `workspace`; the one narrower
  rule already in the code — a personal automation's work stream being visible to
  its owner — stays separate, because those rows carry no participants and reading
  them as `personal` would hide them from the person they belong to. The rule
  itself is written once, in `apps/api/src/lib/workstream-visibility.ts`, and
  parameterized by the SQL expression naming the reader so the work-stream room
  can bind by position and its eviction sweep can ask it of a whole column; a call
  site that pastes the rule instead of importing it is how it lost `scope` before.
- **A work stream moves between the two, and privacy is not ownership.**
  `PATCH /workstreams/:id` takes `scope`, and the sidebar's right-click menu offers
  it as **Make private** / **Make public to workspace**, named for the state it
  moves to the way the note item is. Anyone who may read a work stream may move it
  either way, and everyone left inside a private one can read it, write to it, and
  add anyone else in the workspace — `addParticipant` requires only that the caller
  can read the work stream and that the person named is an active member. Two
  consequences fall out of `personal` being enforced against participants: whoever
  makes a work stream private is upserted as one in the same batch as the scope
  itself — either both land or neither does, and a person the upsert genuinely adds
  is announced as a participant — or the one action that closes a work stream would
  be the one that locks its author out of it; and the change has to reach the
  sockets already inside the room, which authorized once at connect time. The room
  evicts the connections that may no longer read it and sends
  `workstream_scope_changed` to the rest. Two kinds of row refuse the change with
  `scope_change_unsupported`, because `scope` is not what decides who reads them: a
  `system_kind` row is machinery assembled from one person's activity, and an
  automation-generated row takes its audience from that automation's scope —
  opening it would broaden nothing and closing it would hide it from the owner, who
  reaches it by owning the automation rather than by being a participant.
- `workstreams.system_kind` is the different question of whether a work stream is
  *machinery*. `NULL` is ordinary work; any non-`NULL` value (`digest` today) is a
  subsystem's own work stream, so an internal run can reuse the whole agent loop
  rather than inventing a second one. It decides whether the row is *listed* — off
  unless the caller passes `includeSystem`, which the desktop does when Debug
  enabled is on — never who may read it. A digest's work stream carries both:
  `scope = 'personal'` and `system_kind = 'digest'`. See
  [`digests.md`](digests.md).
- `workstreams.model_override` pins this one work stream's runs to an OpenRouter
  model, ahead of the `agent-model-workstream` flag. `NULL` — the overwhelming
  majority — means the flag decides. It exists because model *selection* is a
  fleet-wide rollout and this is the opposite question, asked about one piece of
  work at the moment it is created; see
  [`feature-flags.md`](feature-flags.md#a-work-streams-own-model). The column
  carries no `CHECK` enumerating the ids: the selectable set is a product decision
  that moves, so it lives in `AGENT_MODEL_OVERRIDES` and is re-validated on read,
  which lets a model be retired without a migration.
- `workstream_pins` is one person's pinned work streams and the order they
  arranged them in — keyed `(workstream_id, user_id)` like
  `workstream_read_states`, and for the same reason: a pin is one person's opinion
  about a shared row, so it cannot be a column on `workstreams` without imposing
  one member's arrangement on the workspace. `position` is unique and ascending
  per person and is rewritten as a dense run by every unpin and reorder, because a
  tie leaves "what order is this list in" without a single answer; a new pin takes
  `MAX(position) + 1` rather than the row count, so two pins made at once — or one
  made after a cascade delete left a hole — cannot land on the same number. It is
  deliberately not uniquely indexed, since any intermediate state of the rewrite
  collides with itself. A pin is never broadcast — it changes nothing anyone else
  can see — and it never widens what its owner may read: every pinned read still
  applies the visibility rule above, so a pin left behind by a work stream that was
  archived or narrowed contributes no row while remaining removable by its owner.
  See [`workstream-pinning.md`](workstream-pinning.md).
- `workstream_participants` records explicit participation reasons. Viewer
  presence is intentionally absent from D1.
- `messages` has a per-work-stream `sequence_number`;
  `workstreams.next_sequence_number` allocates ordered events.
- `message_mentions` stores validated person and connector spans.
- `message_attachments` relates a resource to one exact owning message. A
  resource can appear in multiple work streams, so projections that report
  message-attachment state must join through `messages.workstream_id`; existence
  anywhere in the workspace is not the relationship for the current work stream.
- `resources` holds metadata while `content_ref` points at the user-visible
  regional R2 object and `content_sha256` identifies the exact bytes selected for
  model extraction. Uploads hash before the row commits; connector hydration
  writes a hash-versioned object and atomically invalidates an older derivative.
  `model_content_status`, extractor version, readable-character count,
  extraction timestamp, bounded error code, and optional derivative ref
  make pending, failed, unsupported, and ready states distinct. Existing image
  attachments may also carry a signature-validated model derivative and bounded
  metadata; animated GIF metadata records dimensions, frame count, duration,
  approximate frame rate, loop behavior, and storyboard timestamps.
  Each new original or derivative generation is pre-registered in
  `resource_object_deletion_outbox`. Successful pointer publication cancels the
  new row and queues the former pointer; resource deletion queues its current
  original and derivative, while detaching one relationship leaves shared
  resource objects intact.
  `attachment_tool_receipts` relates a versioned read, search, view, or summary
  receipt to every derivative it used. Replacing that version or deleting the
  resource invalidates the whole invocation and queues its JSON replay object;
  the table never contains attachment content or ephemeral image data. All
  Both tenant-owned attachment tables carry `workspace_id`, and every
  dependency registration, invalidation, replay, and cleanup mutation supplies
  it even though resource and invocation IDs are globally unique.
  `workstream_resource_inventory_revisions` holds one monotonic revision per
  work stream. D1 triggers advance it when resource membership, message
  attachment relationships, resource classification/content identity, or
  private-note visibility can change the authorized inventory. Derivative claim,
  processing, and hydration timestamp updates do not advance it; it is a race
  fence, not an attachment catalog.
  `workstream_resources` owns
  attachment/watch behavior; its `relationship_type` distinguishes an ordinary
  `attachment` from the `origin` a work stream was created from — see
  [work-stream origin attachments](workstream-origin-attachments.md).
- `elicitations` and `activity_suggestions` are first-class transcript blocks.

### Automations and execution

- `automation_templates` and immutable `automation_template_versions` separate
  shared behavior from credentials. The one exception to that immutability is a
  draft's own version, which the compiler rewrites in place on every turn rather
  than leaving twenty versions behind for a template nobody has run; it is safe
  only because a draft's template is `private` and cannot be shared until the
  automation is created, so nothing else is ever pinned to that row.
  `AutomationService.draftVersionUpdate` is the only writer, and it takes a
  required condition bounding it to a version its own subscription still pins —
  see [`automation-drafts.md`](automation-drafts.md).
- `automation_subscriptions` pins one version and owns scope, principal, connector
  bindings, activity-source bindings, overrides, and schedule state.
  `connector_bindings_json` maps model-facing plugin IDs to frozen connection IDs;
  `activity_trigger_bindings_json` independently maps reusable trigger source slots
  to those plugin IDs so an activity can match only the selected installation.
  `status` is the run state (`draft`, `active`, `paused`, `error`);
  `lifecycle_state` is the separate question of whether the subscription is still
  present (`visible`, `archived`, `deleted`), so a dismissed draft and a deleted
  automation share one enum instead of a flag each, and `updated_at` records when
  the transition happened. A `draft` row is an automation someone is still setting
  up: the compiler writes one on its first turn and updates it on every turn after,
  `draft_conversation_json` holds the conversation so it can be picked back up, and
  creating the automation promotes that same row to `active` and clears the column
  rather than inserting a second one — [`automation-drafts.md`](automation-drafts.md)
  owns that lifecycle and the reasons a draft carries no schedule, no address, and
  no workspace scope. Archiving is restricted to drafts; deleting is allowed at any
  status and also disables the schedules and the email route. A deleted row is
  kept, never removed: automation runs, generated work streams, the memory scope,
  and the permanent email tombstone all reference it. Every path that starts a run
  — scheduler alarm, activity matching, inbound email — requires
  `status = 'active' AND lifecycle_state = 'visible'`, so a hidden automation cannot
  run. `model_override` is the same pin as the work-stream column above, held here
  because the runs it applies to do not exist yet; every path that creates a run
  copies it onto the work stream it creates rather than joining back, so a run reads
  its model from its own row and a run that already happened keeps describing the
  model it was pinned to. Three separate places build that row —
  `AutomationService.createRun`, the workspace scheduler's `startAutomation`, and
  the activity consumer's `startActivityAutomation` — so a column added to one and
  not the others is honoured by manual runs while scheduled and activity-triggered
  runs silently ignore it.
- `memory_scopes` owns durable work-stream, automation, user, and workspace memory
  authority. `memory_items` stores compact prose facts; `memory_tables`,
  `memory_table_columns`, `memory_table_rows`, and `memory_table_cells` store typed
  collections with natural-key deduplication and targeted queries. Automation
  template versions declare table schemas, while every subscription owns an
  independent materialized automation scope and shares it across its generated work
  streams.
- `automation_runs.workstream_id` is unique, enforcing the one-run/one-work-stream
  contract.
- The partial unique index on `(automation_subscription_id, planned_for)` converges
  early-open and alarm-driven scheduled-run creation.
- `harness_runs` records each bounded model loop. `tool_invocations` is unique on
  `(harness_run_id, tool_call_id)` and stores input hashes plus side-effect state.
- `workstream_context_compactions` stores one latest raw LLM continuation
  summary per `(workspace_id, workstream_id, execution_principal_key)`, with its
  sequence boundary, resource-inventory revision, and deterministic template
  version. Current authorized totals are regenerated on apply and replay and
  are intentionally absent from the principal-scoped row. A final conditional
  insert rejects a summary when the inventory revision changed after rendering.
- `schedules` is canonical. One workspace Durable Object alarm reads due rows and
  advances them transactionally/idempotently. Exactly one of
  `automation_subscription_id`, `connector_connection_id`, and `digest_schedule_id`
  is set on a row.
- `workstream_wakeups` holds one-shot prompt wake-ups a run scheduled for itself.
  It is separate from `schedules` because a wake-up is one-shot, belongs to a work
  stream rather than a subscription or connection, and carries the prompt text that
  becomes the resulting run's trigger. The same workspace alarm unions it with
  `schedules` and `resource_watches`. `(workstream_id, idempotency_key)` is unique,
  so a replayed tool receipt resolves to the wake-up its first attempt created;
  `status` moves `pending → fired` under a version guard before the run is launched,
  making a wake-up at-most-once rather than at-least-once.
- Terminal control-plane rows are regional and tenant-first.
  `workstream_sandboxes` owns one generation, authority fingerprint, provider
  reconciliation identity, exclusive operation lease, lifecycle deadlines, and
  final-diff pointer per work stream. `sandbox_tasks` binds one command to one
  harness tool receipt and retains only command hash, terminal state, exit,
  termination reason, byte counts, and bounded head/tail plus an optional full-log
  resource. `sandbox_imported_resources` records planned and completed imports
  per generation, destination, source hash, and byte size so a retry never trusts
  pre-existing sandbox bytes. `workspace_sandbox_network_policies`, `_domains`, and `_mutations`
  own the revision-fenced preview/confirm/read-back protocol.
  `workstream_terminal_repositories` stores the immutable numeric GitHub
  repository ID, canonical name, selected base/ref/SHA, fixed head ref, and healthy
  connection; `terminal_publication_grants` stores current-participant intent;
  `repository_publications` converges the one branch/PR write. Provider IDs and
  repository names are facts, never authorization. See
  [`terminal-workspaces.md`](terminal-workspaces.md).

### Activity log and digests

- `activity_events` is the first-party record of what happened that someone should
  hear about, separate from the `activities` ingest table below. `audience_kind`
  stores a visibility *rule* — `workspace`, `user`, or `workstream` — resolved
  against the reader at read time, so a work stream gaining a participant
  retroactively gains them its history. `activity_event_targets` is the different
  question of who an event is *about* (`mentioned`, `involved`, …), which is what
  lets a consumer lead with it; a target outside the audience is stored but still
  filtered out on read. `event_type` and `subject_type` are open strings so a
  producer adds a value rather than a column.
- `activity_events.digestible` is the separate question of whether anybody *wants*
  to hear about an event, as opposed to who *may*. It is fixed when the row is
  written — from the connector's manifest for connector activity, at the call site
  for a first-party producer — because the question is asked far more often than it
  is answered, and re-deriving it on read would need a manifest that may have
  changed or that this region does not register. It carries no index: the reads
  that use it are already anchored on `activity_events_cursor_idx`, and a two-value
  column ahead of that range would only widen the index for every other reader.
  [`digests.md`](digests.md#digestible-what-a-person-should-be-told) owns the rule,
  and its `DEFAULT 1` is a deliberate fail-open — see
  [Failure modes and limits](#failure-modes-and-limits).
- `activity_events.log_sequence` is `INTEGER PRIMARY KEY AUTOINCREMENT` and is the
  only cursor axis. Timestamps cannot order it: two events written in the same
  millisecond tie, and any tiebreak can place the second below a cursor taken after
  the first, dropping it permanently. `AUTOINCREMENT` is required rather than
  incidental — a reused rowid would appear beneath a cursor that has already
  passed.
- `digest_schedules` is one digest per person per workspace, carrying a `day_mask`
  (bit 0 Sunday). It owns no work stream: those belong to the occurrence, not the
  configuration. Every active member gets one — weekdays at 09:00, by email —
  created by the cron reconciler rather than at the several places a membership is
  made. A row is never deleted, so its absence unambiguously means "never had one"
  and the reconciler cannot resurrect a digest somebody switched off. It
  deliberately has no timezone column — a digest's times are wall-clock times in
  its owner's day, and `users.timezone` already answers that; a second copy would
  disagree the first time somebody moved. The derived `schedules` rows carry the
  resolved zone and are re-derived when the account timezone changes.
  `digest_schedule_times` holds the delivery times, and one `schedules` row is
  derived per *time* — a single RRULE cannot express a list of times, because
  `BYHOUR` and `BYMINUTE` multiply out.
- `digest_delivery_targets` freezes each destination, with a per-family `CHECK`:
  `email` carries an address and no connection, and every other type carries a
  connection plus the frozen provider identity. `target_type` is deliberately not
  an enum, so a connector declaring a new `userDelivery` surface becomes selectable
  without a migration.
- `digest_deliveries` is both the idempotency record and the cursor.
  `(digest_schedule_id, planned_for)` is unique, so a re-fired alarm resolves to the
  attempt already in flight; `cursor_through` of the newest settled row is where the
  next digest starts reading. `empty` is a settled outcome, not a failure.
  `workstream_id` is the work stream this occurrence ran in, created with the claim
  and `SET NULL` rather than `CASCADE` — losing a transcript must never lose the
  delivery, or the cursor it carries would move backwards and re-digest a window
  somebody has already read. Digests never write `workstream_read_states`: a digest
  cursor is what someone has been *told*, a read waterline is what they have *read*.

### Connectors and activities

- `connector_connections` owns scope, encrypted provider credentials,
  capabilities, cursors, and health. Migration
  `0072_notion_connection_scope_split.sql` uses the capability dialect to move
  historical Notion public-integration bot rows from personal to workspace
  scope while preserving new `notion.personal.mcp` ownership.
- `notion_webhook_setup_nonces` exists in both regional schemas but is used only
  by Global. It stores a SHA-256 nonce hash, a 30-minute expiry, and — only after
  consumption — the hash of the Notion verification token that claimed it. Its
  partial unique index permits exactly one `is_current = 1` setup generation.
  `provider_webhook_challenges.setup_nonce_hash` links the active encrypted token
  to the nonce allowed to retry it, and `setup_generation` carries that nonce's
  monotonic row generation into EU. A newer subscription setup therefore makes
  older nonce/token pairs unable to restore a superseded signing secret in either
  region, even when regional RPC calls arrive out of order.
- `slack_installation_routes` is the opaque Global team-to-region directory;
  `slack_user_links`, `slack_agent_sessions`, and durable `slack_ingress_jobs`
  remain regional.
- `automation_delivery_targets` freezes each destination a personal automation
  copies its results to, one row per `target_type`. A `slack_agent_dm` row carries
  the selected Slack installation and linked Slack user; an `email` row carries the
  owner's account address as it stood when the automation was saved and no
  connector connection. A per-type `CHECK` keeps the two shapes from mixing. Avalon
  itself is never a row — every run already owns a work stream.
- `slack_unfurled_links` records which Slack message carries which work-stream
  link, plus a hash of the attachment posted on it, so a posted unfurl card is
  rewritten exactly when it would render differently. Slack reports a shared link
  only once, so a row that is not written as the card is posted can never be
  recovered — see [`workstream-links.md`](workstream-links.md).
- `activities` stores normalized metadata and an optional R2 payload reference.
  `target_user_ids_json` preserves explicit owner/mention routing separately from
  visibility, while `external_people_json` retains bounded provider identities and
  exact mention evidence for workspace-scoped resolution. Provider identity and
  dedupe constraints make at-least-once delivery safe.
- `resource_watches` records explicit direct relationships.
- `webhook_receipts` prevents replay of signed generic-webhook deliveries.
- `audit_events` records security- and side-effect-relevant actions without copying
  sensitive bodies.

### Regional telemetry

Telemetry uses regional D1 as a durable policy boundary, not as product truth.
`users.analytics_person_id` and `workspaces.analytics_workspace_id` are random,
immutable destination identities; they are deliberately unrelated to product
primary keys. The user row also owns the default-on product-analytics preference,
its compare-and-set version, and an opaque handle through which Global projects a
preference change to an EU account without copying its regional user ID.

The tables have distinct lifecycles rather than one catch-all event store:

- `telemetry_onboarding_journeys` binds one anonymous login epoch to an immediate
  coarse Global or EU route while no workspace exists. It is a route record, not a
  region-pending queue.
- `telemetry_accepted_events` and `telemetry_delivery_receipts` make event upload
  idempotent. Global accepted rows are an outbox for PostHog; EU accepted rows are
  internal-only. `telemetry_eu_events` is an independently expiring semantic
  projection with trusted release, platform, channel, launch/session, and
  operation dimensions for regional funnel and reliability queries.
- `telemetry_identity_links` records the one anonymous-epoch-to-person link.
  `telemetry_profile_jobs` separates that non-superseding transition from
  coalescible person and workspace profile updates.
- `telemetry_crash_reports` indexes one raw object and owns processing, retry,
  destination, launch-correlation, and absolute-deletion state. EU occurrences
  also contribute one flat row to `telemetry_eu_crash_contributions`; query-time
  aggregation ages each contribution out independently instead of extending old
  observations when an issue recurs. `telemetry_crash_access_audit` records
  reason-coded support access without copying the object key or report.
- `telemetry_destination_state`, `telemetry_ingest_rate_buckets`,
  `telemetry_rejection_buckets`, and `telemetry_replay_audit` hold bounded
  operational control and audit data without product payloads.

Every telemetry row that retains data carries an absolute deadline, and migration
triggers reject deadline extension. Accepted delivery metadata and full crash
occurrences live for at most 90 days; EU semantic and minimized crash
contributions live for at most 13 months. Raw dumps, source maps, and native
symbols are outside the ordinary regional payload bucket in the region's dedicated
`TELEMETRY_PAYLOADS` R2 bucket. See [`telemetry.md`](telemetry.md) for routing,
collection, opt-out, and destination behavior.

## Invariants

1. **Every tenant-owned table carries `workspace_id`, and every repository lookup
   includes it.** Knowing an object ID is never sufficient authorization; a query
   that omits the column is a cross-tenant read waiting for an ID to leak.
2. A personal connection must have an owner; a workspace connection must not.
3. Passive viewing never creates `workstream_participants` rows.
4. A human authoring a message or elicitation answer is upserted as a participant
   in the same operation.
5. A personal activity is never promoted to workspace scope implicitly.
6. Repeated provider events, Queue deliveries, alarms, workflow steps, client
   messages, and tool calls converge on unique keys. Without that, at-least-once
   delivery becomes at-least-twice side effects.
7. Canonical timestamps are UTC ISO-8601 strings. Every user and workspace retains
   a validated IANA timezone. Calendar intent separately retains its explicit IANA
   timezone; omitted automation timezones resolve in the order explicit trigger,
   personal user, then workspace.
8. R2 objects are addressed through opaque references; raw provider payloads do not
   enter Queue or Workflow inputs — a payload in a Queue message is a payload
   outside the region's storage guarantees.
9. **Who may read a work stream is expressed once**, in
   `apps/api/src/lib/workstream-visibility.ts`. A call site that pastes the rule
   instead of importing it is how it lost `scope` before, and the next such call
   site will lose whatever is added next.
10. **Migration files are immutable after deployment.** New schema changes receive
    a monotonically numbered SQL file; local and hosted databases are migrated with
    Wrangler *before* code that depends on the new schema is deployed. Editing a
    deployed migration leaves every database that already ran it permanently
    diverged from every database that has not.
11. **Runtime request handlers never attempt broad schema migration.** A Worker
    that migrates on demand migrates concurrently, once per isolate.
12. **A telemetry deletion deadline is absolute and immutable.** Delivery,
    processing, replay, recurrence, or destination acknowledgement may change a
    state column but never renew the row. EU aggregate queries operate on
    independently expiring contribution rows rather than a mutable issue lifetime.
13. **A Terminal sandbox row is unique by `(workspace_id, workstream_id)` and its
    provider/stable names are unique inside that workspace.** Two live generations
    for one stream would defeat mutation serialization and make authority
    revocation nondeterministic.

## Boundary

This document owns what the tables mean, how rows are keyed, and the rules the
schema enforces. It does not own the behavior built on top of them — each of those
has a document, and the column notes above point at it rather than restating it:

| For | Read |
| --- | --- |
| The DDL itself | `packages/db/migrations/` — authoritative, always |
| The surfaces, flows, and contract boundaries around this schema | [`architecture.md`](architecture.md) |
| Which region a row lives in and what crosses | [`regionalization.md`](regionalization.md) |
| The description refresh loop | [`workstream-descriptions.md`](workstream-descriptions.md) |
| Pinning and the pinned sidebar section | [`workstream-pinning.md`](workstream-pinning.md) |
| The draft automation lifecycle | [`automation-drafts.md`](automation-drafts.md) |
| The activity log's semantics and the digest that reads it | [`digests.md`](digests.md) |
| Model pinning and the flags it overrides | [`feature-flags.md`](feature-flags.md) |
| Telemetry routing, identities, lifecycle, and destinations | [`telemetry.md`](telemetry.md) |
| Running and reverting migrations against hosted databases | [`runbook.md`](runbook.md) |
| Daytona Terminal sandbox, task, policy, and publication behavior | [`terminal-workspaces.md`](terminal-workspaces.md) |

## Failure modes and limits

- **`activity_events.digestible` defaults to `1`, which fails open rather than
  closed, and is deliberately left that way.** It governs only an insert that does
  not name the column, which no production code path performs — a reaper test does,
  and would silently change what it writes if the default ever flipped — and
  changing it now costs a full rebuild of the log with `activity_event_targets`
  staged around it. [The
  runbook](runbook.md#the-window-between-a-migration-and-the-worker-that-needs-it)
  records what that default cost during the deployment that added it, and why the
  next such column should pick the fail-closed value up front.
- **`artifacts` is retired and no code reads or writes it.** The table is still
  present only because the Worker live during a migration is the previous one,
  which did read it; a later release drops it, and [the
  runbook](runbook.md#finishing-the-artifact-retirement) owns the remaining steps.
  Do not add a reader.
- **A work-stream wake-up is at-most-once, not at-least-once.** `status` moves
  `pending → fired` under a version guard before the run launches, so a wake-up
  lost between the guard and the launch does not fire at all rather than firing
  twice.
- **`workstream_pins.position` is not uniquely indexed**, because any intermediate
  state of the dense rewrite collides with itself. Uniqueness is a property the
  rewrite maintains, not one the database enforces.
- **A deleted `automation_subscriptions` row is kept forever.** Automation runs,
  generated work streams, the memory scope, and the permanent email tombstone all
  reference it, so a hard delete would orphan four things at once.
- **A `system_kind` or automation-generated work stream refuses a scope change**
  with `scope_change_unsupported`. That is deliberate, not a missing case.
- **A migration deployed ahead of the code that needs it is the safe order; the
  reverse is not.** A `CHECK` relaxed before the enum widens means rows the new
  schema accepts fail the readers still running.

## Testing

`pnpm --filter @avalon/db test` is the suite that covers the schema itself:

- `packages/db/test/migrations.test.ts` applies every `.sql` file in
  `packages/db/migrations/` in sorted order into an in-memory `node:sqlite`
  database and asserts on the result. `migrateDatabaseThrough(fileName)` stops
  part-way, which is how a data backfill is tested against the schema as it stood
  when the backfill shipped — that is the fixture to reach for, rather than
  building a bespoke database.
- `packages/db/test/workstreams.test.ts` drives the repositories over that same
  migrated SQLite database through a `D1DatabaseLike` shim.

The trap is that the migration tests execute the SQL through `node:sqlite`, not
through D1. Syntax D1 rejects but SQLite accepts passes here and fails at deploy;
the Wrangler dry-run builds in CI and an actual `pnpm db:migrate` against the local
database are what catch it. Behavior that depends on a column belongs in the owning
service's suite under `apps/api`, not here.

## Changelog

### 2026-08-13 — Telemetry rows enforce independent absolute lifecycles

**What changed:** Migration `0074` adds random analytics identities, the account
preference, regional accepted/outbox and EU projection rows, ordered
identity/profile jobs, native crash indexes and contributions, replay/access
audits, rate buckets, destination circuits, processing leases, and analysis
context. Immutable-deadline triggers cover every retained telemetry record.

**Why:** Offline Electron delivery, destination retries, and recurring crash
issues all need durable state, but none may renew old data or turn Global into a
holding area for an unresolved region. EU analysis also needs useful release and
launch dimensions without a US destination.

**Considered and rejected:** One polymorphic event table, a mutable crash-issue
aggregate, product primary keys as PostHog identities, and extending retention on
retry. Each would either erase distinct policy lifecycles, keep old contributions
alive indefinitely, leak internal identifiers, or defeat the published ceiling.

**Consequences:** New telemetry schema changes are additive migrations; code must
preserve the stored random identities and original deadlines. Operators reap D1
and dedicated R2 together, and EU analysis reconstructs issue and crash-free views
from surviving rows.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — Regional Terminal state separates authority from provider facts

**What changed:** Migration `0074_terminal_workspaces.sql` adds tenant-first
sandbox, task, import, network-policy, repository-selection, publication-grant,
and convergent-publication rows with work-stream/workspace guards and unique
replay keys.

**Why:** Daytona persistence cannot be Avalon's authorization or retry ledger.
Sandbox creation, command submission, egress mutation, and GitHub writes all
have ambiguous provider outcomes that require durable regional intent and
receipts independent of provider state.

**Considered and rejected:** Storing lifecycle only in Daytona labels, reusing
generic tool receipts as the entire command/publication state machine, and
keying repositories only by mutable `owner/name`. None carries the domain state
needed to reconcile races or prove exact GitHub identity.

**Consequences:** Every Terminal query and mutation includes `workspace_id`;
provider identifiers never authorize; command/publication state converges on the
existing tool invocation; and future schema changes receive a new migration
rather than editing `0074` after deployment.

Shipped in the pull request for this change. Design:
[`docs/PRDs/2026-08-12_daytona-terminal-git-github/prd.md`](PRDs/2026-08-12_daytona-terminal-git-github/prd.md).

### 2026-08-12 — One pointer and one outbox replace the model-object catalog

**What changed:** Text derivatives no longer have a companion index object, and
`resource_model_objects` is removed. Generation-unique originals and derivatives
are pre-registered directly in `resource_object_deletion_outbox`; successful
pointer publication cancels the winning generation and enqueues the displaced
pointer. Inventory revisions now ignore processing-only resource updates.

**Why:** The index was downloaded beside the complete derivative and never used
to select candidates, while the catalog retained a row for every superseded
generation after cleanup had already deleted its object. Both duplicated state
without providing a distinct recovery path.

**Considered and rejected:** Reaping catalog rows separately and preserving an
unused index for speculative future search performance. Direct outbox ownership
has fewer states and the same recoverability.

**Consequences:** Current pointers remain on `resources`; every non-current
generation is either pending deletion in the outbox or already gone. A future
search index needs its own measured performance case and lifecycle design.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Attachment state is tenant-scoped and revision fenced

**What changed:** Attachment model-object, cleanup-outbox, and receipt dependency
tables now carry `workspace_id` through their keys and repository operations.
Compaction rows are keyed by work stream and execution principal, while a
trigger-maintained work-stream inventory revision fences paging and checkpoint
persistence without loading every resource row.

**Why:** The tenancy contract requires an explicit workspace predicate even for
globally unique IDs. Review also found that one shared checkpoint let principals
evict each other and that compare-then-write authorization checks admitted a
last-window revocation race.

**Considered and rejected:** Treating UUIDs as tenant scope, keeping a single
work-stream checkpoint, and hashing a fully materialized resource inventory at
every boundary. Those choices respectively weaken defense in depth, discard a
different principal's usable state, or make every point read scale with the
entire sidebar.

**Consequences:** New attachment-owned rows and queries must include
`workspace_id`; resource relationships that affect visibility must advance the
inventory revision; and checkpoint mutations remain scoped to the exact
execution principal.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Message-attachment projections retain their work-stream boundary

**What changed:** The resource visibility projection now resolves
`message_attachments` through the owning message's workspace and work stream,
and includes that relationship bit in its cursor fingerprint.

**Why:** `resources` are reusable workspace objects, while a message attachment
is a relationship to one message. Testing existence by resource ID alone let a
message in work stream B change counts and list output in work stream A.

**Considered and rejected:** Storing a message-attached flag on `resources`.
That denormalizes a many-to-many relationship into a workspace-wide property and
cannot represent a shared resource correctly.

**Consequences:** Any future aggregate over message-introduced resources must
join through `messages.workstream_id`; cursor snapshots must include every
relationship-derived field they return.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Attachment receipts follow derivative identity

**What changed:** `attachment_tool_receipts` records which exact derivative
hashes a completed attachment invocation used. Resource replacement or deletion
deletes dependent invocations and moves their regional JSON replay objects into
the existing cleanup outbox.

**Why:** Replaying a range, citation, or visual inclusion summary after its
derivative changed silently combines old evidence with new bytes. Leaving the
R2 receipt after invalidation also defeats the resource lifecycle guarantee.

**Considered and rejected:** Embedding resource dependencies inside opaque
receipt JSON. D1 cannot invalidate or clean a relationship it cannot query, and
parsing arbitrary replay bodies from a trigger would make deletion brittle.

**Consequences:** Attachment completion registers dependencies before the
receipt becomes model-visible. A multi-resource view receipt is invalidated as
one unit when any included derivative changes.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Attachment derivatives have explicit regional lifecycle state

**What changed:** Resources now identify exact original bytes and carry explicit
model-derivative state, version, coverage metadata, and current index reference.
Every original, current, or superseded model object is registered or copied into
a retryable regional deletion outbox before its resource row disappears.
Compaction rows also record the deterministic checkpoint template version.

**Why:** Eager attachment projection treated a bounded prefix as though it were
the file and offered no durable state that could distinguish pending extraction,
conversion failure, or a reusable image. Adding lazy tools without lifecycle
state would turn those cases into empty reads and leak derivative objects when a
resource was replaced or deleted.

**Considered and rejected:** Eagerly backfilling every historical resource and
deleting objects when any relationship detaches. A backfill would create an
unbounded regional conversion spike; relationship deletion is not object
ownership and could destroy a resource still attached elsewhere.

**Consequences:** Upload and hydration paths must maintain `content_sha256` for
the exact stored object. New derivative writers atomically advance the resource
row and catalog their objects, and new resource owners rely on row deletion—not
relationship detachment—to initiate physical cleanup. Legacy rows remain valid
and are classified lazily on first authorized use.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Notion scope migration follows credential dialect

**What changed:** Migration `0072_notion_connection_scope_split.sql` changes
historical personal Notion rows without `notion.personal.mcp` to workspace scope
and clears their user owner.

**Why:** Those rows contain public-integration bot credentials created before a
separate personal hosted-MCP mode existed. Reusing `personal` for the new DCR
credential shape made the old rows both unusable and incorrectly user-owned.

**Considered and rejected:** Detecting credential fields at runtime. Credentials
are encrypted, so every selection path would need decryption and two dialects
would remain indefinitely. The granted capability is relational, deterministic,
and already distinguishes the modes.

**Consequences:** Existing bot grants become available to the workspace without
rotating provider tokens. New hosted-MCP connections remain personal because
they carry `notion.personal.mcp` before this one-time migration runs.

Shipped in the pull request for this change.

### 2026-08-12 — Notion setup nonces are token-bound and superseding

**What changed:** `notion_webhook_setup_nonces` stores short-lived nonce hashes
and the verification-token hash fixed by first use. A partial unique index permits
one current generation, which the operator replaces in one D1 transaction.
`provider_webhook_challenges.setup_nonce_hash` identifies the setup that owns the
active ciphertext; the challenge upsert succeeds only when that nonce is still the
current consumed generation and is bound to the same token hash.
`setup_generation` records the nonce row's monotonic generation on Global and EU.

**Why:** Notion cannot sign the challenge that establishes its later signing
secret, while Cloudflare records every webhook query string. A reusable URL guard
therefore leaked into observability, and a plain consumed flag was insufficient:
after a subscription rotation, replaying the old valid nonce/token pair could
otherwise restore the old secret. Rechecking current ownership in the ciphertext
write preserves a retry if the Worker fails after claiming the nonce while also
preventing an older paused request from winning after a newer claim. A separate
public token-retrieval table or endpoint was rejected; the existing encrypted
challenge row is joined to the current nonce, read, and decrypted only by local
operator tooling. Replicating the numeric generation rather than relying on RPC
arrival order lets EU reject an older request that crossed the regional boundary
more slowly than its replacement.

This document predates the changelog rule; reasoning for earlier schema decisions
beyond the inline prose was not reconstructed. The migrations, `git log`, and the
PRDs under `docs/PRDs/` are the remaining record.
