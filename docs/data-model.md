# Data model

Avalon's regional data is split by declared authority. D1 owns identity,
membership, connector/automation/activity modules, routing, migration, external
delivery, schedule, and audit state. `WorkspaceDO` owns the authoritative
cross-work-stream directory and query indexes; D1 keeps no rebuildable
work-stream serving projections. Serving contract 1 makes each `SubstreamAgent` SQLite database the product authority for
one independently ordered substream after the guarded regional generation opens;
its non-agent `WorkstreamDO` parent owns aggregate work-stream metadata and the
regional effect outbox plus HyperSight configuration/published results. Each
stable HyperSight block has a separate `BlockDashboardAgent` execution ledger,
while its fenced transcript and Bind runtime rows remain in main
`SubstreamAgent("0")`. Frozen
legacy D1 product rows are migration input and writer tripwires, never a serving
fallback. The checked-in migrations are the authoritative D1 schema and the
object schema registry is the authoritative DO schema. This document maps both
rather than duplicating their DDL. Application
contracts expose camel-cased TypeScript values; storage uses explicit
snake-cased columns, and JSON only where provider- or model-shaped data is not
relationally queried.

The database vocabulary is intentionally `block_dashboard_*`; **HyperSight**
is the product label rendered to users. No authoritative or compatibility table
uses the product name after this unshipped cutover.

Read it before adding a table, a column, or a migration, and before assuming that
knowing an object's ID is enough to read it — it never is.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/NNNN_*.sql` | The authoritative regional D1 schema. Monotonically numbered, immutable once deployed. |
| `packages/db/src/index.ts` | Region-aware repositories and the D1 wrapper every service is handed. |
| `packages/db/test/migrations.test.ts` | Applies every migration in order and asserts on the resulting schema. |
| `packages/db/seed.sql` | The local development seed. |
| `apps/api/src/lib/workstream-visibility.ts` | The single expression of who may read a work stream, parameterized by the SQL naming the reader. |
| `apps/api/src/mappers/connection.ts`, `apps/api/src/mappers/workstream.ts` | Row schemas parsed at the read — the pattern the remaining hand-coercing readers are converging on. |
| `apps/api/src/telemetry/` | The only services that interpret telemetry rows, deadlines, destination state, and EU analysis projections. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | The separate versioned authority schema local to one `SubstreamAgent`. |
| `apps/api/src/durable-objects/workspace-do.ts`, `workstream-do.ts` | SQL schemas for the authoritative workspace directory/query index, sync/command routing, bounded invalidation replay, non-agent child aggregation, HyperSight fan-out/results, and work-stream metadata sockets. |
| `apps/api/src/durable-objects/workspace-directory-protocol.ts` | Typed, runtime-validated cross-object query and effect contracts joining WorkstreamDO facts to WorkspaceDO serving state without cross-database SQL. |
| `apps/api/src/durable-objects/block-dashboard-agent.ts` | Per-block SQL identity, socket receipt, durable execution/retry/result-settlement ledger, and full active-output checkpoint. |
| `packages/contracts` | The camel-cased shapes the columns are mapped into. |

## How it works

### Identity and tenancy

- `users` stores Google identity subjects and display information.
- `workspaces` pins an immutable `global` or `eu` region plus its immutable
  west/east Durable Object placement affinity. The Global
  `platform_workspace_bindings` row carries the same opaque route; `wnam` and
  `weur` are migration/background/missing-request-metadata defaults only.
- `workspace_members` authorizes users as owner, admin, or member.
- `sessions`, `oauth_states`, and `desktop_login_tickets` support revocable
  sessions, PKCE, and single-use Electron deep-link completion.
- `workspace_invitations` supports explicit membership growth without introducing
  a workspace switcher in V1.

Every regional D1 tenant table carries `workspace_id`, and every D1 repository
lookup includes it. A Durable Object instead stores its external workspace/work
stream/substream identity once in a singleton and omits those repeated keys from
local child rows; every request is checked against that identity before local
SQL runs. Knowing either a D1 row ID or a Durable Object ID is never sufficient
authorization.

### Realtime synchronization records

Most workspace modules remain relational D1 authorities. `WorkspaceDO` is the
deliberate exception for cross-work-stream serving: it stores the common
directory, per-viewer overlays, pins, resource-link inverted index, resolved
suggestion-feedback index, hash receipts, consumed socket tickets, and a bounded
monotonic `workspace_sync_events` log. A log row names typed query topics; it
never embeds members, invitations, connector credentials/state, policies,
notes, activity payloads, opportunities, or other D1-owned records. The
directory tables are primary workspace-object state, not D1 copies.

`WorkstreamDO.workstream_metadata` is different: it is the authoritative
cross-substream aggregate. Its revision covers complete common metadata and its
`substream_user_directory` inputs produce the viewer overlay. A WebSocket
snapshot includes nulls so a client can delete a former email, automation link,
plan, archive/system marker, or schedule rather than accidentally retain it.
`SubstreamAgent` continues to own ordered parts, active output, and replay; token
frames are never database joins or metadata patches.

HyperSight is intentionally split by responsibility. WorkstreamDO's
`block_dashboard_configuration_versions`, `block_dashboard_block_runs`, preferences,
dispatch outbox, and result receipts are the product/control authority. A
`BlockDashboardAgent.agent_run_dispatches` row owns the long-running executor.
Its singleton `agent_stream_checkpoint` stores the complete currently visible
derived output, revision, epoch, and sequence;
`block_dashboard_socket_ticket_receipts` provides one-time admission for the block's
direct socket. It stores neither a copy of the source transcript nor one row per
token. The main substream's runtime compatibility rows hold the Bind run/tool state
that references its fenced transcript. These are connected by typed,
hash-checked RPCs rather than cross-object SQL joins.

### Work streams

- The main `SubstreamAgent`'s object-local `workstream` row is the product root;
  each provisioned child carries the bounded root facts needed to authorize and
  project its own context, while `WorkstreamDO.workstream_metadata` is the
  aggregate cross-child view. `origin_type`
  distinguishes ad hoc work
  from automation output without splitting the UI. `objective` is the work
  stream's description; `description_source` records whether a person wrote it
  (`authored`) or it was derived at creation or by the refresh loop (`derived`),
  which is what lets an automatic rewrite weigh a deliberate line differently from
  a copied opening message. `title_status` is the same question for the title:
  `naming` while the naming agent is choosing the first one and the stored title
  is a placeholder clients render as a skeleton, `automatic` once Avalon has named
  it and one later pass may still replace it, `settled` when a person named it, a
  caller supplied it, or that pass has run.
- Object-local `description_refresh_state` holds one row per work stream: the last
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
- `workstream.scope` answers who may read a work stream, in the same
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
- A work stream born from a connector conversation uses that same scope rather
  than introducing a second visibility model: a public conversation starts as
  `workspace`, while a private or unclassified one starts as `personal` with the
  conversation's resolved members seated as participants. This seeds the room at
  creation; later speakers may join it and publish the same `participant_added`
  event as an in-product admission, and the ordinary right-click scope toggle may
  still change it. See
  [`connectors.md`](connectors.md#a-work-streams-audience-is-the-conversation-it-started-in).
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
- `workstream.system_kind` is the different question of whether a work stream is
  *machinery*. `NULL` is ordinary work; any non-`NULL` value (`digest` today) is a
  subsystem's own work stream, so an internal run can reuse the whole agent loop
  rather than inventing a second one. It decides whether the row is *listed* — off
  unless the caller passes `includeSystem`, which the desktop does when Debug
  enabled is on — never who may read it. A digest's work stream carries both:
  `scope = 'personal'` and `system_kind = 'digest'`. See
  [`digests.md`](digests.md).
- `workstream.model_override` pins this one work stream's runs to an OpenRouter
  model, ahead of the `agent-model-workstream` flag. `NULL` — the overwhelming
  majority — means the flag decides. It exists because model *selection* is a
  fleet-wide rollout and this is the opposite question, asked about one piece of
  work at the moment it is created; see
  [`feature-flags.md`](feature-flags.md#a-work-streams-own-model). The column
  carries no `CHECK` enumerating the ids: the selectable set is a product decision
  that moves, so it lives in `AGENT_MODEL_OVERRIDES` and is re-validated on read,
  which lets a model be retired without a migration.
- `workstream_pins` is one person's pinned work streams and the order they
  arranged them in. It remains in D1 because it is a cross-work-stream ordering
  owned by one user. The corresponding read/mention waterlines live in the
  owning object's `member_attention`; a pin is one person's opinion
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
- Object-local `participants` records explicit participation reasons. Viewer
  presence is intentionally absent from durable storage.
- Object-local `parts` has a per-work-stream `sequence_number`; the root
  `workstream.next_sequence_number` allocates ordered events. Conversation rows
  belong to a `substreams` row, with the main chat fixed at substream `0`.
- `part_mentions` stores validated person and connector spans.
- `part_attachments` relates a resource to one exact owning part. A
  resource can appear in multiple work streams, so projections that report
  attachment state must use the current object's link; existence anywhere in the
  workspace is not the relationship for the current work stream.
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
  Object-local `attachment_tool_receipts` relates a versioned read, search, view, or summary
  receipt to every derivative it used. Replacing that version or deleting the
  resource invalidates the whole invocation and queues its JSON replay object;
  the table never contains attachment content or ephemeral image data. Every
  dependency registration, invalidation, replay, and cleanup mutation
  carries the workspace/work-stream identity even though resource and invocation
  IDs are globally unique.
  `resource_inventory_revision` holds one monotonic revision in the object.
  Local triggers advance it when resource membership, message
  attachment relationships, resource classification/content identity, or
  private-note visibility can change the authorized inventory. Derivative claim,
  processing, and hydration timestamp updates do not advance it; it is a race
  fence, not an attachment catalog.
  `workstream_resource_links` owns
  attachment/watch behavior; its `relationship_type` distinguishes an ordinary
  `attachment` from the `origin` a work stream was created from — see
  [work-stream origin attachments](workstream-origin-attachments.md).
- `elicitation_requests` is operational human-input state tied to a run.
  `suggested_actions` is an audience-scoped operational overlay and is never
  model or shared transcript input merely because it exists. Acceptance may
  explicitly author a new audience-safe `parts` row; that new part, not the
  private card body, enters conversation history.

D1 retains a `workstreams` identity anchor because workspace/control tables have
foreign keys to the stable ID. A post-cutover row has `do_identity_anchor = 1`;
its metadata and lifecycle columns are not product authority. Common/per-user
list queries, pins, connector/resource routing, and resolved work-stream
suggestion feedback use `WorkspaceDO`'s `workspace_workstream_*` tables. D1 has
no projection fallback when that object is unavailable.

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
- Object-local `runs` records each bounded model loop. `tool_effects` is unique on
  `(run_id, provider_tool_call_id)` and stores input hashes plus side-effect state.
- `compaction_jobs` and `compaction_checkpoints` store the raw LLM continuation
  summary per execution principal and immutable run/sequence event, with its
  sequence boundary, resource-inventory revision, and deterministic template
  version. Current authorized totals are regenerated on apply and replay and
  are intentionally absent from the principal-scoped row. A final conditional
  insert rejects a summary when the inventory revision changed after rendering.
- Object-local `active_agent_compaction` is the owning SubstreamAgent's
  singleton reconnect checkpoint for an in-progress compaction indicator. It
  stores only run/attempt/index/trigger/start time, is cleared by the matching
  finish or terminal run state, and is not checkpoint history or model-visible
  content.
- `schedules` is canonical. One workspace Durable Object alarm reads due rows and
  advances them transactionally/idempotently. Exactly one of
  `automation_subscription_id`, `connector_connection_id`, and `digest_schedule_id`
  is set on a row.
- Object-local `workstream_wakeups` holds one-shot prompt wake-ups a run scheduled for itself.
  It is separate from `schedules` because a wake-up is one-shot, belongs to a work
  stream rather than a subscription or connection, and carries the prompt text that
  becomes the resulting run's trigger. The common WorkspaceDO directory row exposes
  only the next due time so the workspace alarm can call the owner; it does not
  copy the wake-up. `idempotency_key` is unique inside the object,
  so a replayed tool receipt resolves to the wake-up its first attempt created;
  `status` moves `pending → fired` under a version guard before the run is launched,
  making a wake-up at-most-once rather than at-least-once.
- Terminal's work-stream-specific durable rows are object-local.
  `terminal_workspace` owns one generation, authority fingerprint, provider
  reconciliation identity, exclusive operation lease, lifecycle deadlines, and
  final-diff pointer per work stream. `terminal_tasks` binds one command to one
  harness tool receipt and retains only command hash, terminal state, exit,
  termination reason, byte counts, and bounded head/tail plus an optional full-log
  resource. `terminal_imported_resources` records planned and completed imports
  per generation, destination, source hash, and byte size so a retry never trusts
  pre-existing sandbox bytes. `workspace_sandbox_network_policies`, `_domains`, and `_mutations`
  own the revision-fenced preview/confirm/read-back protocol.
  `terminal_repository` stores the immutable numeric GitHub
  repository ID, canonical name, selected base/ref/SHA, fixed head ref, durable
  requested remote-access ceiling, and connection; `terminal_publication_grants` retains run/principal provenance for
  the optional typed publisher; `repository_publications` converges its
  branch/PR writes. Standard full-access Git/CLI writes do not depend on these
  receipt tables. Provider IDs and
  repository names are facts, never authorization. See
  [`terminal-workspaces.md`](terminal-workspaces.md).

### Activity log and digests

- `workstream_regional_effect_receipts` is the minimal D1 inbox for
  WorkstreamDO activity-log and mention-delivery effects. Its message ID and payload hash detect replay or conflict;
  `(workstream_id, generation, partition_key, source_version)` prevents two
  different commands from claiming one source position. It is delivery evidence,
  not a copy of product state.
- `WorkspaceDO.workspace_workstream_directory` and
  `workspace_workstream_viewers` are authoritative common and viewer-specific
  query rows. Equal generation/waterline with a different hash is rejected.
  `workstream_notification_intents` temporarily retains a bounded mention
  payload plus its required viewer waterline while D1 resolves current
  membership/profile/destination state; notification delivery asks WorkspaceDO
  for that causal waterline, and a newer revocation/listability row wins;
  terminal delivery or skip erases `payload_json` rather than retaining a second
  transcript. Acknowledged receipts and terminal intent shells are retained for
  30 days; pending/unacknowledged rows do not expire.
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

1. **Every regional D1 tenant table carries `workspace_id`, and every repository
   lookup includes it. Each Durable Object stores the external route once in its
   singleton identity row and validates requests against it.** Repeating the same
   key on every local child row adds no isolation; omitting the D1 predicate or
   the object-level identity check is a cross-tenant read waiting for an ID leak.
2. A personal connection must have an owner; a workspace connection must not.
3. Passive viewing never creates `workstream_participants` rows.
4. A human authoring a message or elicitation answer is upserted as a participant
   in the same operation.
5. A personal activity is never promoted to workspace scope implicitly.
6. Repeated provider events, Queue deliveries, alarms, workflow steps, client
   messages, and tool calls converge on unique keys. Without that, at-least-once
   delivery becomes at-least-twice side effects.
7. D1/API timestamps are UTC ISO-8601 strings; Durable Object SQL stores Unix
   milliseconds and converts only at the boundary. Every user and workspace
   retains a validated IANA timezone. Calendar intent separately retains its
   explicit IANA timezone; omitted automation timezones resolve in the order
   explicit trigger, personal user, then workspace.
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
14. **A WorkstreamDO effect is acknowledged only after the owning receiver
    commits the effect and receipt together.** Directory/user/feedback effects
    commit in WorkspaceDO; activity/mention effects commit in D1. RPC and Queue
    order are never trusted, generation/version fences mutable state, and
    immutable effects use stable IDs.

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

Durable Object-local schemas are covered separately by
`apps/api/test/workstream-object-schema.test.ts`; the real-workerd suite in
`apps/api/test-workers/durable-object-runtime.test.ts` covers constructor
migration, object isolation, eviction, compaction state, pagination, and agent
checkpoint behavior. These tests are required because the regional D1 suite
cannot validate object-local SQLite lifecycle semantics.

The trap is that the migration tests execute the SQL through `node:sqlite`, not
through D1. Syntax D1 rejects but SQLite accepts passes here and fails at deploy;
the Wrangler dry-run builds in CI and an actual `pnpm db:migrate` against the local
database are what catch it. Behavior that depends on a column belongs in the owning
service's suite under `apps/api`, not here.

## Changelog

### 2026-08-18 — Work-stream projections gain independent state waterlines

**What changed:** WorkstreamDO now records immutable common and `user:<id>`
state transitions with per-key waterlines and separate common/viewer UUIDv7 row identities before creating
its Queue outbox row. WorkspaceDO common/viewer tables persist those waterlines
and source IDs independently. Its generic synchronization and directory clocks
are explicitly named waterlines. Electron shares the same ledger between the
WorkstreamDO and WorkspaceDO sockets.

**Why:** The direct socket and at-least-once, unordered Queue path can deliver
the same transition in either order. A combined version or separate UI caches
could roll back shared title/status/unread/mention state.

**Considered and rejected:** UUIDv7 as a distributed total clock, overwriting a
single current row before durable delivery, coalescing pending state outbox
rows, and using D1 as the reconciliation authority. UUIDv7 supplies useful time
sorting and trace identity, while authority-local waterlines supply correctness.

**Consequences:** WorkspaceDO accepts only a greater generation/key waterline;
intermediate UI states may be skipped but every source transition remains
deliverable until acknowledged. D1 remains outside this serving path.

### 2026-08-18 — Cross-work-stream indexes move from D1 to WorkspaceDO

**What changed:** WorkspaceDO's single initial SQLite schema now owns common and
viewer directory rows, pins, resource links, resolved suggestion feedback, a
directory waterline, and effect receipts. The unshipped D1 migrations no longer
create the corresponding projection tables; D1 retains only work-stream
identity anchors, migration/routes, activity/mention receipts, notification
intents, and unrelated relational workspace modules.

**Why:** The workspace object is the natural serialized authority for sidebar,
discovery, routing, and interest queries. Keeping rebuildable D1 projections
made correctness cross two authorities and kept product serving coupled to the
regional database.

**Considered and rejected:** Weakening the WorkspaceDO schema to a cache, or
querying every WorkstreamDO at read time. The former preserves split authority;
the latter turns a bounded local query into unbounded cross-object fan-out.

**Consequences:** Every WorkstreamDO directory effect is retried through Queue
to WorkspaceDO from its SQL outbox; migration activation alone synchronously
flushes and verifies that state before
opening a route; Electron pages the WorkspaceDO socket; and D1 cannot recover or
override the directory after cutover.

### 2026-08-18 — HyperSight persistence adopts BlockDashboard identifiers

**What changed:** Regional D1 and object-local SQLite tables, indexes, triggers,
origins, errors, and import mappings now use `block_dashboard_*`. The
per-block execution owner is `BlockDashboardAgent`; API shapes use
`BlockDashboard` types.

**Why:** Persistence should name the authority it implements rather than a
product label. The common prefix now joins configuration, dispatch, execution,
socket receipts, and publication state in schema inspection and telemetry.

**Considered and rejected:** Keeping old physical table names while renaming
only TypeScript. The schema has not shipped, so that would preserve misleading
names without avoiding a data migration.

**Consequences:** The initial D1/DO baselines are renamed in place and tests
assert the new schema. Visible dashboard text still says HyperSight and is not
derived from storage identifiers.

### 2026-08-18 — Active compaction is operational state, not conversation

**What changed:** The work-stream object map now names
`active_agent_compaction` separately from immutable compaction jobs/checkpoints
and from transcript `parts`.

**Why:** The desktop needs a durable phase indicator across reconnect, but a
progress marker has neither the semantics nor the retention of a model message
or completed context checkpoint.

**Considered and rejected:** Inferring the phase from missing token deltas and
authoring synthetic compaction parts. Both confuse presentation with durable
conversation semantics.

**Consequences:** The singleton may be rebuilt/cleared from ordered lifecycle
events; a finish must match run, attempt, and index. Completed summaries retain
their existing immutable fences and canonical messages remain unchanged.

### 2026-08-18 — Derived agent output gains a reconnect-safe SQL checkpoint

**What changed:** Each `BlockDashboardAgent` now stores one full active-output
checkpoint and its own one-time socket receipts beside the existing dispatch
ledger. Its source transcript and Bind tool rows remain in main
`SubstreamAgent("0")`; the checkpoint contains only the block's derived output.

**Why:** A block loop must resume a visible in-progress stream after socket
reconnect or object eviction without duplicating deltas, losing text, or
writing token-sized rows.

**Considered and rejected:** Copying source messages into the block object,
per-token rows, and transient in-memory text. They create a second transcript
authority, amplify writes, or lose the recovery boundary.

**Consequences:** The agent commits a complete revisioned checkpoint before
broadcast, Electron replaces rather than appends on resume, and completion
collapses the transient checkpoint into the terminal result authority.

### 2026-08-18 — Conversation arrays and operational overlays stay separate

**What changed:** Object-local `parts` is documented as the provider-neutral
semantic order, compaction rows retain immutable event identities, and
`suggested_actions` is explicitly operational state rather than transcript.
Durable Object timestamps are integer milliseconds even though D1/API values
remain ISO strings.

**Why:** A suggestion may be private or revoked and must not become shared model
history by storage accident. A derived run also needs a stable lossy prefix and
exact post-prefix tool pairs, not whichever summary is newest when it starts.

**Considered and rejected:** Treating every UI block as a message and storing
timestamps in mixed formats inside object SQL. Both make authorization and
ordering rules implicit at read time.

**Consequences:** Projectors have one explicit semantic source, operational
cards require explicit authorship to enter it, and SQL range/order comparisons
use one timestamp representation.

### 2026-08-18 — HyperSight separates product and execution authority

**What changed:** WorkstreamDO now stores configured/published HyperSight state,
one `BlockDashboardAgent` stores each stable block's execution ledger, and main
`SubstreamAgent("0")` stores the fenced Bind runtime rows used during execution.

**Why:** Configuration and results are work-stream metadata, execution recovery
is block-local, and transcript-related receipts must stay beside the transcript
authority they reference.

**Considered and rejected:** Copying the transcript into block objects, putting
model execution in WorkstreamDO, and treating a block as a conversation
substream. Each either duplicates data, loads the control plane, or invents a
false user-visible message authority.

**Consequences:** Cross-object consistency is explicit: source refresh signal,
parent dispatch, block-to-source runtime SQL, and block result receipt. The
complete SQL catalog and failure rules are in
[`workstream-durable-object.md`](workstream-durable-object.md).

### 2026-08-17 — Workspace routes gain immutable Durable Object affinity

**What changed:** `workspaces`, the Global `platform_workspace_bindings` route,
and `WorkspaceDO.workspace_identity` now carry the same region-compatible
`wnam`/`enam`/`weur`/`eeur` affinity. D1 triggers backfill region defaults and
reject changes once a compatible value exists.

**Why:** Every child creator needs a cheap regional route to the parent's
one-time placement choice. Querying Global on each operation violates the data
plane boundary, while recomputing from the current caller can split the object
graph.

**Considered and rejected:** Keeping affinity only in WorkspaceDO and treating
it as mutable workspace settings. The former makes the parent a read bottleneck;
the latter suggests a row update can move Durable Objects when it cannot.

**Consequences:** Regional D1 is an immutable routing projection cached per
Worker isolate, not a second placement authority. A true affinity change
requires a maintenance migration of the complete hierarchy.

### 2026-08-17 — Control-plane SQL supports three independent socket authorities

**What changed:** WorkspaceDO gained workspace-scoped socket receipts and a
bounded topic-version log; WorkstreamDO gained socket receipts plus a revisioned
complete metadata projection. SubstreamAgent remains the transcript/stream
authority.

**Why:** Live multi-client workspace data needs durable change notification,
while aggregate work-stream data needs a model-free authoritative snapshot.
Neither requirement justifies copying relational workspace rows or token feeds
into another database.

**Considered and rejected:** Duplicating D1 workspace records in WorkspaceDO and
deriving aggregate state from the current token stream. The first splits
authority; the second fails whenever no model is running or a nullable field is
cleared.

**Consequences:** Workspace mutation paths publish topics after commit,
WorkstreamDO sends full snapshots by revision, and cross-object updates remain
typed RPC/outbox operations rather than cross-database SQL.

### 2026-08-17 — Work-stream authority is split across parent and substream SQL

**What changed:** `WorkspaceDO` owns command-ticket SQL, the model-free
`WorkstreamDO` owns child projection receipts and the aggregate regional outbox,
and each `SubstreamAgent` owns one independently ordered message/run context.
Main child `0` receives the maintenance import; new children require explicit
provisioning.

**Why:** Transcript and full-loop ordering are substream-local, while sidebar,
activity, and viewer-interest queries need one work-stream aggregate and one
workspace/regional delivery path.

**Considered and rejected:** Treating the parent as transcript authority and
copying every child message into it. That would restore a single serialization
and storage bottleneck.

**Consequences:** Cross-object relationships are RPC/outbox contracts, never SQL
joins. The authoritative DDL/catalog for all four Durable Object classes is in
[`workstream-durable-object.md`](workstream-durable-object.md).

### 2026-08-17 — Serving names now match the WorkstreamDO authority

**What changed:** The work-stream map now names the normalized object-local root,
parts, participants, runs, tool effects, attention, compaction, wakeup, resource
link, suggestion, and Terminal tables as the serving records. The D1
`workstreams` row is explicitly an identity anchor; directory, resource-link,
and suggestion-feedback rows are explicitly rebuildable projections.

**Why:** Once serving contract 1 routes all product operations to the object,
describing the frozen legacy D1 table names as canonical would invite a new
writer or read fallback and recreate split authority.

**Considered and rejected:** Renaming every established repository and API type
in the same cutover. The local compatibility views preserve those code-level
names without preserving duplicate product storage.

**Consequences:** New schema and query design starts from the normalized local
tables. D1 foreign-key anchors and projections may support regional joins, but
must never be used to reconstruct product state when the object is unavailable.

### 2026-08-17 — D1 gains a durable inbox for WorkstreamDO regional effects

**What changed:** Regional D1 records hash-checked WorkstreamDO effect receipts,
monotonic sidebar projections, and short-lived mention delivery intents.

**Why:** Workspace queries and delivery require relational membership, identity,
and connector state that correctly remains outside a single work stream.

**Considered and rejected:** Copying credentials/users into each object or
retaining notification bodies after settlement.

**Consequences:** D1 can serve cross-workstream lists and external delivery
without becoming work-stream product authority.

### 2026-08-17 — Work-stream product rows acquire an object-local authority boundary

**What changed:** The map now distinguishes workspace/control/projection tables
that remain in D1 from normalized product tables owned by one WorkstreamDO after
the maintenance generation opens. D1 migration `0077` records the phase/routes
and permanently fences the legacy product tables after open.

**Why:** The physical copy and the authority switch are separate facts. Without
an explicit generation and writer fence, the same logical row could continue to
accept mutations in both databases.

**Considered and rejected:** Treating all D1 rows with `workstream_id` as one
ownership class. Pins, schedules, connector delivery, automation, audit, and
telemetry cross the work-stream boundary for valid workspace/control reasons.

**Consequences:** Code must consult the ownership map, not infer authority from
an ID column. Object-local schema changes use the object registry; D1 control and
projection changes use numbered migrations.

### 2026-08-16 — Object-local SQL is named separately from canonical D1

**What changed:** The data map now identifies the versioned SQLite schema owned
by each existing `SubstreamAgent` and points to its module contract. At that
stage, canonical work-stream metadata and completed transcript rows still
remained in regional D1.

**Why:** Cloudflare stores the room's former key/value data inside its SQLite
database, but hidden storage is still a different authority boundary from D1.
Leaving it undocumented makes named local tables look like a second canonical
product database.

**Considered and rejected:** Adding the object DDL to `packages/db/migrations`.
Those migrations run against regional D1 and cannot safely version millions of
independently activated Durable Object databases.

**Consequences:** D1 schema changes still use numbered package migrations.
Room-local schema changes use the Workstream Object registry. The later
maintenance campaign supplies the separately fenced authority migration.

### 2026-08-15 — Connector conversations seed the existing work-stream scope

**What changed:** A work stream started from a connector conversation now chooses
the existing `workstreams.scope` from that conversation: public maps to
`workspace`, while private or unknown maps to `personal` and starts with the
resolved conversation members as participants. Later speakers are admitted to
the same room.

**Why:** A Slack thread previously belonged to the first linked member, so other
members of the conversation could not continue it. The work-stream scope already
expressed the needed public/private split: `personal` has always meant active
participants only, not one owner.

**Considered and rejected:** Renaming `scope` to a second `visibility` column and
renaming the API and socket contract around it. That duplicated an existing
authorization model, introduced a migration window for the same two states, and
broke released desktop clients without enabling the connector behavior.

**Consequences:** Connector code translates provider-facing public/private words
once at creation. The database, PATCH endpoint, socket event, right-click menu,
and feature-flag targeting attribute keep their existing scope contract. Later
connector admissions publish `participant_added`, keeping live clients aligned
with that durable participant room.

### 2026-08-13 — OAuth attempts retain one bounded telemetry contract shape

**What changed:** Connector OAuth attempts retain the negotiated telemetry event
version, requested scope, capability-count integer, and reconnect flag alongside
their operation ID. Existing rows default to V1; current clients bind V2 after
the attempt is durably created. Migration
`0077_connector_oauth_telemetry_shape.sql` adds only these four fields after the
already-shipped regional telemetry migration.

**Why:** Terminal OAuth failures occur after the renderer is gone and often
before a connection exists. Without the admitted shape, the API could either
emit a sparse legacy outcome or guess the dimensions required by the V2 event.

**Considered and rejected:** Provider-state payload inspection at reporting time
and parallel V1/V2 emission. The former couples analytics to encrypted OAuth
secrets; the latter double-counts one setup journey.

**Consequences:** These columns are bounded metadata, not provider payloads.
Future event versions must persist any terminal dimensions at admission and
must not reinterpret an attempt after its operation binding is set.
### 2026-08-13 — Recoverable GitHub status remains a valid Terminal reference

**What changed:** Migration
`0076_terminal_recoverable_github_connections.sql` replaces the Terminal
repository insert guard so every non-disabled GitHub connection remains a valid
reference. It also records the model's selected `remote_access` ceiling on the
work-stream repository row. Repository policy updates atomically invalidate
cached mounted-token expiry in the same D1 batch, while connection disable
atomically revokes affected selections.

**Why:** `error` and `needs_reconnect` are cached observations that provider
revalidation may recover, but the original trigger treated them as permanent
revocation and contradicted the connector contract. Separating a policy write
from token invalidation also admitted a broader credential after interruption.

**Considered and rejected:** Removing the trigger or permitting disabled rows.
The workspace/type guard remains valuable, and `disabled` is the one intentional
durable stop state.

**Consequences:** Code may attempt current provider verification for every
non-disabled connection, while database writes still reject disabled and
cross-workspace references. The stored checkout ceiling and current connector
policy both constrain token minting. Policy, disable, and mounted-credential
state must continue to move transactionally.

### 2026-08-13 — Publication grants become compatibility provenance

**What changed:** Existing Terminal publication-grant rows no longer parse
request prose or limit a run to one write. They remain as provenance/FK records
for the optional typed publisher while full-access sandboxes may use standard
Git and GitHub CLI directly.

**Why:** Connector repository policy is the durable authorization choice, and
normal PR work may push several commits. Rebuilding the shipped migration only
to remove a now-optional receipt relationship would add migration risk without
changing the model-facing behavior.

**Considered and rejected:** Dropping/rebuilding the tables immediately and
keeping single-use semantics. Future schema work may retire the compatibility
rows only with a normal forward migration.

**Consequences:** Code must not treat `consumed_at` as an authorization gate.
Typed publications may share one run provenance row; their own invocation rows
remain the idempotency boundary.

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

**What changed:** Migration `0075_terminal_workspaces.sql` adds tenant-first
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
existing tool invocation; publication retries never replace an earlier
invocation's audit row merely because they target the same branch; and future
schema changes receive a new migration rather than editing `0075` after
deployment.

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
