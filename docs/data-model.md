# Data model

Avalon's regional data is split by declared authority. D1 is the thin regional
control plane: it owns workspace/member/user identity, object and connector
ingress routing, migration coordination, global-provider handoff receipts, and
operational audit/telemetry. `WorkspaceDO` owns every workspace-scoped product
that is not intrinsically one work stream: connector credentials and local
handoff state, Terminal egress policy history, automations, digests and
schedules, resources/notes/watches and R2 lifecycle references, memory,
external-delivery intents/attempts, inbound-email processing receipts,
dictation socket admission, the cross-work-stream directory,
first-party activity, and suggested work. D1 keeps no rebuildable workspace
product serving projection. Serving contract 1 makes each `SubstreamAgent` SQLite database the product authority for
one independently ordered substream after the guarded regional generation opens;
its non-agent `WorkstreamDO` parent owns aggregate work-stream metadata and the
regional effect outbox plus HyperSight configuration/published results. Each
stable HyperSight block has a separate `BlockDashboardAgent` execution ledger,
while its fenced transcript and Bind runtime rows remain in main
`SubstreamAgent("0")`. Legacy D1 workspace-product activity/opportunity rows are
maintenance import input and are scrubbed before each verified WorkspaceDO route
becomes active. Migration 0090 removes those sources, the per-work-stream source
tables, and their writer fences after the authority is open. Neither family is a
serving fallback or part of the current D1 schema. The checked-in migrations are the authoritative D1 schema and the
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
| `packages/db/test/baseline-migration.test.ts` | Replays every migration in order and proves the checked-in baseline leaves the same schema. |
| `packages/db/seed.sql` | The local development seed. |
| `apps/api/src/mappers/connection.ts` | D1 row schemas parsed at the read — the pattern the remaining hand-coercing control-plane readers are converging on. |
| `apps/api/src/telemetry/` | The only services that interpret telemetry rows, deadlines, destination state, and EU analysis projections. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | The separate versioned authority schema local to one `SubstreamAgent`. |
| `apps/api/src/durable-objects/workspace-do.ts`, `workspace-product-schema.ts`, `workspace-domain-schema.ts`, `workspace-product-storage.ts`, `workspace-runtime-sql.ts`, `workstream-do.ts` | SQL schemas and repositories for authoritative workspace product state, typed compatibility SQL, sync/command routing, bounded invalidation replay, non-agent child aggregation, HyperSight fan-out/results, and work-stream metadata sockets. |
| `apps/api/src/services/workspace-runtime-database.ts` | D1-compatible routing port that sends an allowlisted workspace-product statement to typed WorkspaceDO RPC while leaving global/regional control SQL in D1; mixed-authority batches fail closed, and so does any single statement — read or write — naming both a WorkspaceDO table and a regional-only one. |
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
  sessions, PKCE, and single-use Electron deep-link completion. A session that
  simply expires is also marked `revoked_at` by the five-minute reaper, which is
  what makes announcing the expiry exactly-once; see
  [`access-revocation.md`](access-revocation.md). `oauth_states`
  is the signed pre-workspace callback route/security receipt; the user-visible
  `connector_oauth_attempts` status row lives in the selected WorkspaceDO.
- `workspace_invitations` supports explicit membership growth without introducing
  a workspace switcher in V1.

Every workspace-scoped table that remains in regional D1 carries `workspace_id`,
and every D1 repository lookup includes it. Imported compatibility rows inside
WorkspaceDO may retain that column for repository shape, but singleton triggers
force it to the object's workspace. Native Durable Object tables instead store their external workspace/work
stream/substream identity once in a singleton and omits those repeated keys from
local child rows; every request is checked against that identity before local
SQL runs. Knowing either a D1 row ID or a Durable Object ID is never sufficient
authorization.

### Realtime synchronization records

`WorkspaceDO` is the relational authority for workspace product state and
cross-work-stream serving. It stores connector/product configuration, Terminal
policy revisions, automations/digests/schedules, resource/note/watch/memory
records, external-delivery state, inbound-email processing receipts and their
exclusive leases, dictation admission (one-time transcription ticket receipts
and the concurrency session leases the per-user/per-workspace caps count), the
common directory, per-viewer overlays, pins, inverted indexes, activity,
opportunities, receipts, consumed socket tickets, and a bounded monotonic
`workspace_sync_events` log. A sync row names
typed query topics; it never embeds the underlying row. Membership, invitations,
user profiles, placement routes, and migration control remain D1 authorities.

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
  `personal`/`workspace` vocabulary `notes.scope` uses. Privacy is a declared
  property of the row rather than a rule each caller has to remember. WorkstreamDO
  enforces the authoritative participant/scope rule and publishes its viewer
  projection to WorkspaceDO, whose directory applies it for lists and socket
  admission without consulting D1.
- **`personal` means “an active participant” at every serving
  boundary.** Detail authorization, sockets, workspace lists, pins, visibility
  checks, resource reads, Suggested Work, and contextual routing all use that
  same rule. Creation seats the creator, but `created_by_user_id` is attribution,
  not a permanent authorization grant: `removeParticipant` revokes a creator in
  exactly the same way it revokes anybody else.
- **Cross-work-stream content moves from a source audience to an equal or
  narrower target audience.** Workspace activity may enter a workspace work
  stream or a private work stream a particular member may read. Suggested Work
  evaluates that public activity in a separate personal window for every active
  member; the personal window is an inference boundary, not a narrowing of the
  source. Restricted activity may enter a personal work stream only when every
  active participant is in its permitted user set. Suggested
  context persists that source audience and WorkstreamDO rechecks it before
  storing, reading, or resolving a card; a legacy row with no auditable audience
  is not visible.
- **A work stream is born `personal`, and every path that means otherwise says
  so.** `POST /workstreams` carries no scope — a request on the wire cannot claim
  an audience — so the creator is seated beside whoever they named in
  `participantUserIds`, and those active participants are the room. The bootstrap row
  the object is created with is `personal` too, which matters because the runtime
  compatibility insert writes `COALESCE(NEW.scope, scope)`: a path that names no
  scope inherits that row's, so the default has to be the narrow one for the
  omission to be safe. A thread in a public Slack channel states `workspace`
  outright because its room is the channel rather than a participant list.
  **Every automation-generated work stream is `personal`**, regardless of the
  automation's sharing scope: a manual or inbound-email run seats the member who
  started it, while scheduled and activity-triggered runs seat the automation
  owner (falling back to the template owner). A suggestion carries its own
  `audience_scope` across the same
  way: a `workspace` one was shown to every member before anyone started it, and
  the work stream it becomes stays readable by the people it was offered to. A `system_kind` row — a digest occurrence — is the other
  direction: `personal` with its single recipient seated, so every tool the run
  reaches for resolves against that person's access.
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
  automation-generated row is an immutable private execution record — opening it
  would expose the run to the workspace, while closing it is already its fixed
  state. Its creator is also seated as a participant.
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
- `workspace_workstream_pins` in WorkspaceDO is one person's pinned work streams
  and the order they arranged them in. It belongs beside the authoritative
  workspace directory because it is a cross-work-stream ordering owned by one
  user. The corresponding read/mention waterlines live in the
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
- Object-local `participants` records explicit participation reasons, and
  `first_opened_at` — null until that person opens the work stream, which is
  what makes "you were added to this and have never been here" a state the
  sidebar can show. It is on the membership row rather than on `member_attention`
  because the attention row does not exist for somebody who has only been added.
  See [`workstream-markers.md`](workstream-markers.md). Viewer presence is
  intentionally absent from durable storage.
- Object-local `parts` has a per-work-stream `sequence_number`; the root
  `workstream.next_sequence_number` allocates ordered events. Conversation rows
  belong to a `substreams` row, with the main chat fixed at substream `0`.
- `part_mentions` stores validated person and connector spans.
- `part_attachments` relates a resource to one exact owning part. A
  resource can appear in multiple work streams, so projections that report
  attachment state must use the current object's link; existence anywhere in the
  workspace is not the relationship for the current work stream.
- WorkspaceDO `resources` holds metadata while `content_ref` points at the user-visible
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
  Each SubstreamAgent's `workstream_resource_links` owns its attachment
  relationship and resource-inventory fence; WorkspaceDO owns resource metadata,
  workspace watches, and the inverted workspace index. `relationship_type` distinguishes an ordinary
  `attachment` from the `origin` a work stream was created from — see
  [work-stream origin attachments](workstream-origin-attachments.md).
- `elicitation_requests` is operational human-input state tied to a run.
  `suggested_actions` is an audience-scoped operational overlay and is never
  model or shared transcript input merely because it exists. Acceptance may
  explicitly author a new audience-safe `parts` row; that new part, not the
  private card body, enters conversation history.

D1 retains a `workstreams` identity/routing anchor because control tables have
foreign keys to the stable ID. It contains only `id`, `workspace_id`, and
`do_identity_anchor`; a post-cutover row has `do_identity_anchor = 1`. Common/per-user
list queries, pins, resource discovery, and resolved work-stream
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
  status and also disables the schedules. The address is not released — the
  Global ledger records only that a local part is taken — so nothing is written
  there. A deleted row is
  kept, never removed: automation runs, generated work streams, the memory scope,
  and the permanent email tombstone all reference it. Every path that starts a run
  — scheduler alarm, activity matching, inbound email — requires
  `status = 'active' AND lifecycle_state = 'visible'`, so a hidden automation cannot
  run. `model_override` is the same pin as the work-stream column above, held here
  because the runs it applies to do not exist yet; every path that creates a run
  copies it onto the work stream it creates rather than joining back, so a run reads
  its model from its own row and a run that already happened keeps describing the
  model it was pinned to. Three separate places build that row —
  `AutomationService.createRun`, the workspace schedule runner's `startAutomation`, and
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
  `(run_id, tool_call_id)` and stores input hashes plus side-effect state.
- `compaction_checkpoints` stores the raw LLM continuation
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
- WorkspaceDO `schedules` is canonical, and the same object's single alarm reads
  the due rows and advances them transactionally/idempotently — each due time
  mirrored into its `_internal_durable_alarms` index, per
  [`durable-object-alarms.md`](durable-object-alarms.md). Exactly one of
  `automation_subscription_id`, `connector_connection_id`, and `digest_schedule_id`
  is set on a row.
- Object-local `workstream_wakeups` holds one-shot prompt wake-ups a run scheduled
  for itself, each mirrored into that SubstreamAgent's own alarm index.
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

- `WorkspaceDO.workspace_workstream_effect_receipts` is the inbox for queued
  WorkstreamDO directory, activity, suggestion-feedback, resource-link, and
  mention-delivery effects. Message ID and payload hash detect replay or
  conflict; generation and per-key waterlines reject stale mutable state.
- `WorkspaceDO.workspace_workstream_directory` and
  `workspace_workstream_viewers` are authoritative common and viewer-specific
  query rows; `viewers.unseen` is the projection of the membership row's
  `first_opened_at`, so the sidebar reads it without a cross-object call. Equal
  generation/waterline with a different hash is rejected.
  WorkspaceDO `workstream_notification_intents` temporarily retains a bounded
  person-notification payload — a mention, or somebody added to the work stream
  — plus its required viewer waterline. Delivery resolves current
  membership/profile state from D1 and current destination state from
  WorkspaceDO; a newer revocation/listability row wins;
  terminal delivery or skip erases `payload_json` rather than retaining a second
  transcript. Effect receipts and terminal intent shells are retained for 30
  days; a redelivery past that window converges on the idempotent product
  identities (directory waterline, activity dedupe key, intent ID) rather than
  a receipt row. Activity and mention effects commit their receipt in the same
  WorkspaceDO transaction as the event or intent they acknowledge; no regional
  D1 receipt exists for them.
- `WorkspaceDO.workspace_activity_events` is the first-party derived record of what happened that someone should
  hear about, separate from the WorkspaceDO-owned normalized provider event.
  `audience_kind`
  stores a visibility *rule* — `workspace`, `user`, or `workstream` — resolved
  against the reader at read time, so a work stream gaining a participant
  retroactively gains them its history. `workspace_activity_event_targets` is the different
  question of who an event is *about* (`mentioned`, `involved`, …), which is what
  lets a consumer lead with it; a target outside the audience is stored but still
  filtered out on read. `event_type` and `subject_type` are open strings so a
  producer adds a value rather than a column.
- `workspace_activity_events.digestible` is the separate question of whether anybody *wants*
  to hear about an event, as opposed to who *may*. It is fixed when the row is
  written — from the connector's manifest for connector activity, at the call site
  for a first-party producer — because the question is asked far more often than it
  is answered, and re-deriving it on read would need a manifest that may have
  changed or that this region does not register. It carries no index: the reads
  that use it are already anchored on the `event_sequence` primary key, and a two-value
  column ahead of that range would only widen an index for every other reader.
  [`digests.md`](digests.md#digestible-what-a-person-should-be-told) owns the rule,
  and the WorkspaceDO column deliberately has no default: every producer must
  make the decision explicitly. Frozen D1 migration input retains its historical
  `DEFAULT 1`, but no post-cutover writer can use it.
- `workspace_activity_events.event_sequence` is `INTEGER PRIMARY KEY AUTOINCREMENT` and is the
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
- `WorkspaceDO.webhook_receipts` stores connection-scoped signed-delivery replay
  receipts for generic and Granola webhooks. `provider_webhook_receipts` remains
  in D1 only for a provider-global delivery that may precede/fan out across the
  workspace routes it matches.
- `WorkspaceDO.workspace_connector_events` stores the complete authoritative
  normalized connector event. Its provider identity and connection-scoped dedupe
  constraints select one canonical event; processing status, Workflow instance,
  claim, error, and settlement timestamps stay beside the body. The separate
  `workspace_connector_event_ingress_receipts` maps each Queue/provider ingress
  UUID and content hash to that canonical event.
- Legacy regional D1 `activities` rows are maintenance import input only. The
  verified cutover imports them into `workspace_connector_events`, scrubs the
  source, and permanently fences D1 writers. Live provider ingress resolves an
  opaque global/regional route and sends the bounded normalized event through
  the workspace's regional Queue. The consumer commits it to exactly one
  WorkspaceDO and then starts its Workflow. Large/raw provider bytes stay in R2;
  D1 is never an event-body relay.
  Global provider receipts and setup routes may remain in D1 only when they
  exist before a workspace can be selected.
- `resource_watches` records explicit direct relationships.
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
  internal-only. Global rows also carry the independent
  `analytics_lakehouse_state` pointer-outbox lifecycle (`pending`, `queued`,
  `delivered`, `suppressed`, or terminal `rejected`); EU and pre-feature rows
  keep it null so no
  event crosses into the Global Data Catalog. `telemetry_eu_events` is an independently expiring semantic
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
8. R2 objects are addressed through opaque references. Raw/large provider
   payloads never enter Queue or Workflow inputs; the regional Queue carries
   only the bounded normalized connector event needed to reach WorkspaceDO.
9. **Who may read a work stream is decided by Durable Object authority.**
   WorkstreamDO owns scope and participants; WorkspaceDO serves the projected
   viewer decision for cross-work-stream lists and admission. D1 is never a
   visibility fallback.
10. **Migration files are immutable after deployment.** New schema changes receive
    a monotonically numbered SQL file; local and hosted databases are migrated with
    Wrangler *before* code that depends on the new schema is deployed. Editing a
    deployed migration leaves every database that already ran it permanently
    diverged from every database that has not. This is also what makes the local
    baseline in `packages/db/baselines/` safe to derive — its input cannot change
    under it — and a digest over the subsumed files fails the suite if one ever
    does. See [`d1-baseline-migrations.md`](d1-baseline-migrations.md).
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
    and first-party activity/mention effects commit in WorkspaceDO. External
    notification intent and delivery state also commit there; D1 supplies only
    current member/user identity and opaque provider routing. RPC and Queue order are never trusted, generation/version fences
    mutable state, and immutable effects use stable IDs.

## Boundary

This document owns what the tables mean, how rows are keyed, and the rules the
schema enforces. It does not own the behavior built on top of them — each of those
has a document, and the column notes above point at it rather than restating it:

| For | Read |
| --- | --- |
| The DDL itself | `packages/db/migrations/` — authoritative, always |
| The local-only snapshot a fresh development database starts from | [`d1-baseline-migrations.md`](d1-baseline-migrations.md) |
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

- **The historical D1 `activity_events.digestible` defaulted to `1`;
  WorkspaceDO does not.** That source table existed only through migration 0089
  and is absent from the current D1 schema. `workspace_activity_events.digestible` is
  `NOT NULL` with no default, and the typed RPC requires it, so every live
  producer must choose fail-open or fail-closed explicitly.
- **`artifacts` is retired and absent from current D1.** It remained through
  migration 0089 so the previous Worker could still read it; 0090 removes it
  with the rest of the product schema. Do not add a reader or recreate it.
- **A work-stream wake-up is at-most-once, not at-least-once.** `status` moves
  `pending → fired` under a version guard before the run launches, so a wake-up
  lost between the guard and the launch does not fire at all rather than firing
  twice.
- **`workspace_workstream_pins.position` is not uniquely indexed**, because any intermediate
  state of the dense rewrite collides with itself. Uniqueness is a property the
  rewrite maintains, not one the database enforces.
- **A deleted `automation_subscriptions` row is kept forever.** Automation runs,
  generated work streams, the memory scope, and the permanent email tombstone all
  reference it, so a hard delete would orphan four things at once.
- **A `system_kind` or automation-generated work stream refuses a scope change**
  with `scope_change_unsupported`. That is deliberate, not a missing case.
- **A migration deployed ahead of the code that needs it is the safe order; the
  reverse is not.** A `CHECK` relaxed before the enum widens means rows the new
  schema accepts fail the readers still running. The destructive 0090 retirement
  is the documented exception: the replacement Worker supports both anchor
  shapes, and the deployment workflow keys its Worker-first barrier from each
  remote pending ledger before deleting schema the previous Worker still names.

## Testing

`pnpm --filter @avalon/db test` is the suite that covers the schema itself:

- `packages/db/test/baseline-migration.test.ts` replays every `.sql` file in
  `packages/db/migrations/` in sorted order into an in-memory `node:sqlite`
  database. There is no longer a per-migration suite asserting on each step: all
  95 migrations sit at or below the baseline boundary and are immutable once
  deployed, and `scripts/d1-baseline.test.mjs` fails if one is edited or a file
  is inserted below it — so a step-by-step assertion could not catch a change the
  digest does not catch first.
- `packages/db/test/dev-seed.test.ts` covers `seed.sql` and `seed-product.json`,
  which — unlike the migrations — are live editable files. Its standing job is to
  fail if the D1 seed ever recreates a product table that migration 0090 dropped.
- `packages/db/src/index.test.ts` covers the repository SQL and the identifier
  primitives against a mocked `D1DatabaseLike` — `vi.fn()` statements and string
  assertions on the SQL they were handed. Nothing in this package drives the
  repositories over a migrated database; the queries that need real SQL are
  proved in the api Node suite, over the fixtures in
  `apps/api/test/helpers/sqlite-d1.ts`.
- `packages/db/test/baseline-migration.test.ts` proves the checked-in baseline
  leaves the same database as replaying the migrations it subsumes, comparing
  through `PRAGMA` introspection rather than SQL text. It is the reason a fresh
  local database can skip the chain; see
  [`d1-baseline-migrations.md`](d1-baseline-migrations.md).

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

Maintenance import validates JSON by its target contract, not merely by
`json_valid`: object columns reject arrays/scalars and array columns reject
objects/scalars before any row is inserted. The workspace runtime SQL router
also rejects a regional mutation whose subquery names a WorkspaceDO-local
table. That is a cross-authority join; callers commit the local fact first and
perform the regional audit/control write explicitly through
`workspaceRegionalDatabase`, with idempotent repair on retry.

## Changelog

### 2026-08-24 — Accepted Global telemetry gains a second durable projection

**What changed:** Migration 0095 adds nullable
`pending`/`queued`/`delivered`/`suppressed`/`rejected` analytics-lakehouse state
and a delivery timestamp to `telemetry_accepted_events`, indexes active Global
projection work newest-first, and seeds new Global inserts. Existing and EU rows
remain null.

**Why:** A Queue pointer needs a durable source and retry state, while copying
the already validated envelope into another D1 table would pay twice for the
same data and create a second policy boundary.

**Considered and rejected:** Full-envelope Queue messages, a new D1 event table,
and adding the state to `delivery_state`. Those respectively exceed transport
limits for valid events, duplicate the canonical row, or couple independent
PostHog and lakehouse delivery lifecycles.

**Consequences:** D1 remains operational telemetry rather than analytical
authority. New Global acceptance rows start pending; permanent poison rows stop
at rejected; historical and EU rows plus all product state remain outside this
projection. Omitting a historical backfill keeps live recovery from waiting
behind months of accepted rows.

Shipped in the pull request for this change. See
[`analytics-lakehouse.md`](analytics-lakehouse.md).

### 2026-08-24 — Active participation is the sole private-reader authority

**What changed:** Every private work-stream read now follows active participant
state only. Creation still seats the creator, but removing that participant
revokes detail, directory, socket, resource, Suggested Work, automation-history,
and routing access. The main SubstreamAgent exposes its authoritative current
reader audience for content-movement and run-history checks; callers no longer
use WorkspaceDO's eventually delivered projection for those permanent writes.
Accepted activity resources retain their source audience as a lifetime fence,
so adding a participant or widening scope is refused if it would expose one.
Schema migration 22 installs the same rule as a WorkstreamDO storage trigger,
covering compatibility writers such as connector identity reconciliation that
do not enter through the product service. It also makes an accepted source
audience immutable and retained so the fence cannot disappear before the
content it governs.

**Why:** Treating creator attribution as an implicit reader made
`removeParticipant` and participant-only queries lie. Separately, a directory
projection can lag a committed removal; using it to inject content or disclose a
run made that lag a permanent privacy defect rather than temporary list staleness.

**Considered and rejected:** Preserving creator access as ownership, deleting an
accepted activity's provenance after attachment, and trusting the workspace
projection immediately before delivery. Those respectively create a second
authorization model, forget the audience of still-attached content, or authorize
from stale state.

**What a future change has to respect:** `created_by_user_id` explains origin; it
does not grant access. Every audience widening must preserve all attached
restricted-content fences, and permanent content moves read current authority
from the work stream that owns scope and participants. New direct participant or
scope writers must preserve migration 22's storage-level containment backstop.

### 2026-08-24 — Generated runs default private and viewer permission is one rule

**What changed:** Manual, inbound-email, scheduled, and activity-triggered
automation runs now create personal work streams with a concrete creator and
creator participant. WorkspaceDO and WorkstreamDO visibility reads consistently
admit active participants; directory
inference APIs require explicit workspace or user audiences instead of nullable
authorization predicates. Restricted contextual routing and watched-resource
delivery additionally require the source audience to contain the target work
stream's complete reader audience.

**Why:** Automation sharing controls who can use an automation, not who may read
the contents of each execution. Treating generated work streams as workspace
rows exposed their transcripts and inbound mail. Separately, interpreting a null
viewer as “all rows” let workspace inference inspect private titles and
objectives, while creator-only detail permission disagreed with lists and sockets.

**Considered and rejected:** Inheriting automation scope, authorizing generated
runs through automation ownership without participants, and retaining null as a
trusted internal scheduler bypass. Those respectively widen execution content,
create a second visibility model, and make omission indistinguishable from
privilege.

**What a future change has to respect:** New work-stream creation paths default
personal unless they state and justify a broader audience. Every private read
uses active-participant permission, every cross-work-stream inference
names its audience before it queries the directory, and permission to read one
target cannot be mistaken for permission to widen the source content to all of
that target's readers.

### 2026-08-24 — Membership records when somebody first opened the work stream

**What changed:** work-stream object schema v18 adds `participants.first_opened_at`
and WorkspaceDO schema v10 adds `workspace_workstream_viewers.unseen`, the
projection of it the sidebar reads. Both migrations backfill every existing row
as already opened.

**Why:** being added to a work stream was not a state anything could store. The
question is not whether messages have arrived since somebody looked but whether
they have ever looked, and only the membership row spans that — it exists from
the instant somebody is put in the room, while `member_attention` is written by
being read to and by being mentioned and is simply absent for somebody who has
done neither.

`hasUnread` could not stand in for it, though not for the reason it first
appears: a newly added person's waterline is 0, so the whole transcript *is*
unread for them and the row does light up. What unread cannot do is stay put.
It returns on the next message and on a manual mark-unread, so a work stream
somebody has been in for months would keep announcing itself as new. The
membership column is settled once and never set again except by a re-add.

**Considered and rejected:** deriving it from `member_attention.last_seen_at`.
The row's absence would have to mean "never opened", and it also means "never
mentioned, never acknowledged" — including for people who have been in the work
stream since it started, which is the population a deploy would have lit up.

**Consequences:** the backfills are what keep the deploy quiet, and any future
migration touching either column has to keep that property — a column that
defaults to unseen turns every existing membership into a notification. The flag
is per-person state on a table whose other columns are the room's; a bulk update
of `participants` that forgets it can un-open a work stream for everybody in it.

Shipped in TBD.

### 2026-08-22 — Two object schemas admit a second notification kind, and the router refuses a cross-authority read

**What changed:** WorkspaceDO schema version 9 rebuilds
`workstream_notification_intents` so `notification_kind` accepts
`participant_added` beside `mention`, and WorkstreamDO version 3 rebuilds its
`durable_outbox` so `effect_kind` accepts `participant_notification`. Both are
table rebuilds — new table, copy, drop, rename — because SQLite cannot widen a
CHECK in place, and both restate the indexes and identity-fence triggers the
dropped table took with it. Separately, `workspace-runtime-database.ts` now
throws `workspace_runtime_cross_authority_statement:<table>` for a *read* that
names both a WorkspaceDO table and a regional-only one, which it previously
sent into the object to fail there.

**Why:** the CHECKs are worth keeping — an unroutable effect kind should fail
where it is written rather than in a Queue consumer — so admitting a second
notification kind meant widening them rather than dropping them. The read guard
closes the hole the write guard left: `slackUserIsLinked` joined
`slack_user_links` to `workspace_members`, was claimed by the router because it
named a local table, and executed inside an object that has no
`workspace_members`. It failed as `no such table: workspace_members` on every
Slack run-outcome delivery in production, which the ingress retried until its
budget was spent. A read has no more correct destination than a write does when
it names both sides.

**Considered and rejected:** keying the guard off "any table not in
`WORKSPACE_LOCAL_TABLES`". The object holds tables that list does not enumerate
— `workspace_workstream_directory`, `workspace_activity_events`,
`work_opportunities` and their neighbours — so that rule would refuse statements
that are correct today. The explicit regional-only list is longer to maintain
and is the only version that can be right. Also rejected: leaving the two
CHECKs narrow and storing the new kind as `mention`, which would have made the
delivery branch guess from the payload shape.

### 2026-08-22 — The per-migration test suite is retired

**What changed:** `packages/db/test/migrations.test.ts` is deleted — 3062 lines
and 48 tests that applied the chain step by step and asserted on each
intermediate schema. `baseline-migration.test.ts` still replays all 95 files and
diffs the result against the checked-in baseline, so the chain is still executed
on every run; what is gone is the per-step assertion. The three tests in that
file that covered the development seed rather than a migration moved to
`packages/db/test/dev-seed.test.ts`.

**Why:** Every migration now sits at or below the 0090 baseline boundary, and a
deployed migration is immutable. `scripts/d1-baseline.test.mjs` already fails if
a subsumed migration is edited or a file is inserted below the boundary — the
manifest digest covers the file list *and* the contents. A test asserting that
`0037` leaves a particular column therefore could not catch a regression the
digest does not catch first: the file it describes cannot change. What the suite
did still cost was runtime — it was most of `pnpm --filter @avalon/db test`,
which drops from ~24s to ~3s.

**The alternative that was rejected:** keeping the ~14 tests that assert on
pre-0090 legacy shapes and deleting the rest. It draws the line in the wrong
place — those are the *least* relevant, describing tables 0090 dropped, and
keeping them would have left the impression that a per-migration test is still
the thing to write when adding a migration. It is not: a new migration is
covered by the baseline equivalence check and by the service test for the
behaviour it enables.

**What a future change has to respect:** a migration above the baseline boundary
is still *replayed* — `baseline-migration.test.ts` builds one database from the
whole chain and another from the baseline plus everything above it, then diffs
their tables, columns, foreign keys, indexes, triggers and seeded rows. `0091` is
the first such migration and is covered that way today. What it does not get is
the digest: the manifest pins only what the baseline subsumes, so an edit to a
migration above the boundary is not caught the way an edit below it is. That
makes the boundary worth moving when the chain above it grows, and it means a
migration whose point is a *data backfill* — which an empty-database replay never
exercises — still needs a test where its behaviour is used. And `seed.sql` and
`seed-product.json` are not migrations: they stay editable, so `dev-seed.test.ts`
keeps asserting that the D1 seed never recreates a product table 0090 dropped.

### 2026-08-21 — A work stream is born private

**What changed:** A new work stream's scope defaults to `personal` rather than
`workspace`. `WorkstreamObjectProductService.initialize` takes the scope as
input instead of hardcoding `'workspace'` into its authoritative `UPDATE`, the
bootstrap row `insertIdentity` writes is `personal`, and `WorkstreamService`
now carries the connector ingresses' `scope` through to the object instead of
losing it at `CreateWorkstreamRequestSchema.parse`. The three automation
inserts — `AutomationService.createRun`, the activity consumer, and the
workspace scheduler — state `scope = 'workspace'` in their own SQL, and the
`Workstream` contract's read default flips to `personal` for the same
fail-closed reason. The resolved scope also joins the `workstream_create_receipts`
request hash, so two creates under one `clientMessageId` that resolved different
audiences are two requests rather than one.

**Why:** Work started in Avalon was published to the whole workspace on
creation, and the person who started it had to notice and close it. The default
now matches what a work stream is when nobody has said otherwise: the creator,
the people they named, and nobody else. The same change repairs a real leak the
Durable Object cutover introduced — `CreateWorkstreamRequestSchema` is not
`.strict()`, so the `scope` the Slack ingress computed for a private channel or
a DM was silently stripped by `parse` and every such work stream was created
`workspace`-readable.

**Considered and rejected:** Accepting `scope` on `POST /workstreams` so the
client could ask. A request on the wire cannot assert an audience — an audience
is something an ingress *knows* — and the composer has nothing to ask with;
the right-click menu already moves a work stream either way afterwards.
Defaulting the automation rows to `personal` along with everything else was
rejected outright: those rows seat no participants and are reached by owning
the automation, so the narrow default would have hidden them from the only
person who can read them. Leaving the bootstrap row `workspace` and relying on
each caller to pass `personal` was rejected because the runtime compatibility
insert writes `COALESCE(NEW.scope, scope)` — with a `workspace` bootstrap, the
one thing a future caller forgets is the thing that publishes it. Keeping the
scope *out* of the create receipt's request hash was rejected once the rest of
this change landed, and the first reasoning was wrong: the cost of adding it is
one deploy's worth of `workstream_create_idempotency_conflict` on receipts the
previous Worker reserved, and the cost of omitting it is permanent and silent.
A Slack event id is a stable create key across the redeliveries Slack makes on
an ack timeout, while `resolveSlackChannelType` runs per delivery and answers
`unknown` — failing closed to `personal` — whenever `conversations.info` times
out or the token has lost the scope for it. Unhashed, a redelivery that resolved
`private` matched the receipt of an attempt that had already committed a
`workspace` row, replayed it, and handed the caller the audience it had just
decided against.

**Consequences:** Every surface that renders `scope` now renders the private
state on a freshly created work stream: the sidebar's privacy marker and the
work-stream header's **Private** badge. A work stream is discoverable by the
rest of the workspace only after somebody in it chooses **Make public to
workspace**, so a workspace that relied on new work being visible to everyone
will see less of it. Existing rows are untouched — this changes what a create
writes, not what any row already says. Any new create path must decide its
scope deliberately: omitting it is now a decision for private, and the two
places that mean `workspace` say so in SQL a reader can see. A create retried
under a create key that has already been used with a different audience is
refused with `workstream_create_idempotency_conflict` rather than replayed;
`workstream-import-hash.ts` now records what may be added to the hashed value
and what the addition costs.

### 2026-08-21 — Four reader-less object tables dropped

**What changed:** The SubstreamAgent table inventory loses `compaction_jobs`,
`terminal_commands`, `_data_migrations`, and `_migration_command_receipts` in
WorkstreamDO schema migration 11.

**Why:** All four outlived the work they were built for — a claimable
compaction job, a per-command Terminal receipt, and the retired authority
cutover campaign's bookkeeping — and none had a reader or a writer. This
document is the map people trust for what state exists, so a table listed here
that nothing uses misroutes design work.

**Considered and rejected:** Marking them deprecated in prose and leaving the
tables. Prose does not stop a query; the drop does.

**Consequences:** `compaction_checkpoints` and `terminal_tasks` are the sole
authorities in their areas. `content_refs` remains listed and remains unwritten
— `parts` holds a foreign key to it, so it is retired separately or not at all.


### 2026-08-20 — D1 product state is retired completely

**What changed:** Migration 0090 removes every legacy product table and product
trigger after the Durable Object authority opens. The resulting D1 schema is
an exact allowlist of 42 identity, membership, routing, migration/control, and
operational audit/telemetry tables with 26 control-plane triggers. It also
reduces the retained `workstreams` identity anchor to `id`, `workspace_id`, and
`do_identity_anchor`. The regional work-stream list, viewer mapper,
pin implementation, and creator read-state write are deleted; list, pin, and
socket visibility now use WorkspaceDO's authoritative directory. Frozen
repository SQL is tested against an explicit through-0089 import fixture, while
current-topology assertions use the final D1 schema and real workerd objects.

**Why:** Empty compatibility shells were not safety rails. The creator
read-state insert reached regional D1 after cutover and hit the still-armed
0079 fence, throwing only after the object-side creation had committed. More
generally, an empty shell can let a misrouted read return a plausible empty
result. Removing the whole product schema makes authority mistakes fail at the
first statement and makes the documented thin-plane boundary mechanically
auditable.

**Considered and rejected:** Leaving the tables as tombstones — silence is
the hazard, not the storage. Relaxing only the read-state fence would repair
the reported creation failure while retaining the second schema and its other
misrouting traps. Dropping in name order was also rejected: SQLite resolves an
FK parent while compiling statements against a child, so the migration uses an
explicit child-before-parent order and proves the result with foreign-key
checking over both empty and populated pre-0090 databases.

**Consequences:** The D1 `workstreams` row is an index, not a product record;
its three fields provide only the stable FK/routing identity. Separate
control-plane tables own the object route, immutable email route, and creation
receipt. There is no product projection to query or fall back to.
Compatibility repository tests must deliberately stop at 0089;
current authority behavior belongs in the workerd Durable Object suite. Because
the previous Worker still names the removed schema, the deploy workflow applies
0090 after installing a replacement Worker that can reserve anchors against
both the through-0089 and final table shapes; the remote pending ledger keeps
that ordering safe across retries.



### 2026-08-20 — The development seed touches no product table

**What changed:** `packages/db/seed.sql` shrank to the regional control plane
— users, workspaces, members, and the `workstreams` index rows. Product
content moved to `packages/db/seed-product.json` and reaches the Durable
Objects through the Worker's dev-gated `POST /dev/seed-product`, which
`pnpm db:open-authority` invokes: workspace-authority rows (resources,
connections, automations, schedules) through the workspace runtime router,
work-stream rows (participants, runs, tool invocations, messages) through the
work-stream compat views, attachments through the product attach flow. A
migration test pins the contract: the listed product tables must be empty
after the seed, and a product row reappearing in seed.sql fails the suite.

**Why:** The legacy D1 product tables cannot be dropped while anything writes
them, and the seed was the last writer. It was also the last consumer the
old import route scraped rows from — a circular dependency between the seed
and the tables it was keeping alive.

**Considered and rejected:** Seeding through the public API — it cannot
fabricate historical transcripts, tool events, or terminal runs, which is
what the fixtures are for; and keeping a parallel legacy seed for
pre-open stacks — the pre-open configuration is no longer supported.

**Consequences:** Two seeded behaviors changed deliberately: the fixture run
is terminal rather than `running` (a running run with no executor is the
phantom the reaper kills), and local automations are visible again on an
opened stack — they previously existed only in fenced D1. The D1 product
tables now have no writers outside migrations, which is the precondition the
drop migration was waiting for.



### 2026-08-20 — `agent_run_dispatches` carries a lease in both agent objects

**What changed:** `lease_token` and `lease_expires_at`, plus an index on
`(state, lease_expires_at, available_at)`, appended as schema v2 to the
`SubstreamAgent` and `BlockDashboardAgent` dispatch tables. The reasoning and
the scheduling rules the columns exist to support live in
[`workstream-durable-object.md`](workstream-durable-object.md)'s same-day
changelog.

**Why:** `state = 'running'` was a claim with no deadline, so a run interrupted
by an eviction or a cancelled invocation was indistinguishable from one still
executing, and the scheduler had no durable time at which to look again. Every
other queue in these schemas — `memory_index_outbox`,
`workstream_notification_intents`, `automation_email_receipts` — already
carried this pair; the dispatch tables were the outliers.

**Considered and rejected:** Inferring abandonment from `started_at` age, which
guesses at a timeout the writer never declared, and editing the v1 migrations,
which are hashed and immutable once deployed.

**Consequences:** A null lease on a row carried through the upgrade reads as
immediately reclaimable, which is the recovering direction; the D1 harness
attempt claim turns away a reclaim that races a run still genuinely in flight.

### 2026-08-19 — Object tables audited: retention, byte bounds, and promoted discriminators

**What changed:** A per-object table audit and platform-limits research pass
reshaped the Durable Object schemas (the authoritative catalog and full
rationale live in
[`workstream-durable-object.md`](workstream-durable-object.md)'s same-day
changelog): generous reaps for every growth-only ledger and receipt table,
payload bounds measured in bytes just under the platform's 2 MB per-row
ceiling and aligned producer-to-consumer so a committed effect is always
deliverable, the parent outbox's `effect_kind` and the block dispatch
freshness tuple promoted from JSON to CHECK-enumerated columns, one `pending`
admission token across the opportunity batch tables, unix-ms socket-ticket
receipts everywhere, `*_s`-suffixed names for the epoch-seconds transcription
columns, and removal of the historical/writerless tables and dead indexes
from the single initial migrations. This document's `tool_effects` uniqueness
now names the real column (`tool_call_id`).

**Why:** The audit found the transactional machinery sound and the defects
concentrated where schemas were silent: unbounded growth against the 10 GB
object ceiling, character-counted CHECKs against a byte-counted platform
limit, and load-bearing discriminators invisible to schema inspection.

**Considered and rejected:** Treating 10 GB as license to skip retention
(a full object stops accepting writes — deletes still work, but that is an
outage, not a policy), and sizing bounds to the 32 MiB RPC transport rather
than the 2 MB storage row.

**Consequences:** Every state machine's terminal rows now have a retention
story; imports map the renamed vocabulary so legacy D1 rows land unchanged in
meaning; and new near-cap TEXT bounds must guard
`length(CAST(… AS BLOB))`, never `length()` alone.

### 2026-08-19 — Dead tables drop and the last unfenced object table gains its tripwire

**What changed:** `attachment_tool_receipts` received the same phase-conditional
`workstream_do_authoritative` writer fences as its `tool_invocations` siblings
in unshipped `0079` — its authority had already moved to the SubstreamAgent
runtime port, but the D1 shell alone accepted direct writes silently.
`workstream_authority_commands`, created in `0079` and referenced by nothing,
was removed from that unshipped migration. New migration
`0085_retire_dead_tables.sql` drops `web_usage_log` and
`workspace_opportunity_versions`, and the workspace activation scrub no longer
names the dropped counter.

**Why:** An object-owned table without a fence is exactly how split authority
comes back: every other moved table rejects a stray D1 writer loudly, and this
one did not. The two dropped tables have no reader or writer on this branch
*or* on the deployed Worker, so — unlike `artifacts`, whose live reader forces
the deferred-drop procedure — nothing serves during the migration window that
could touch them.

**Considered and rejected:** Fencing the two dead tables instead of dropping
them (a fence protects an authority; these have none), and keeping
`workstream_authority_commands` for a future operator command ledger (nothing
was ever designed to write it, and an unshipped migration is the one place a
table can simply not exist).

**Consequences:** A new direct D1 write to `attachment_tool_receipts` aborts
after cutover instead of silently diverging from the object. Anything wanting
web-usage metering or an opportunity version counter starts from a new design
rather than a dead shell.

### 2026-08-18 — The last workspace-scoped receipts leave regional D1

**What changed:** Three residues of the cutover moved behind WorkspaceDO
authority. `workstream_email_receipts` (inbound-email idempotency and its
processing lease) and the two `realtime_transcription_*` dictation-admission
tables joined the workspace product import/scrub/fence campaign, with the
resend and transcription services routing through the workspace runtime port
on the open phase. The regional activity/mention effect receipt table was
removed from unshipped migration `0080` outright: the effect and its replay
receipt now commit in one WorkspaceDO transaction via a typed RPC, reusing
`workspace_workstream_effect_receipts`.

**Why:** All three were workspace-scoped product state written after the
workspace was fully resolved, failing this document's own retention test —
"Global provider receipts and setup routes may remain in D1 only when they
exist before a workspace can be selected." The effect receipt additionally
violated invariant 14: it could never commit atomically with the WorkspaceDO
row it acknowledged, and its correctness already rested on the object-side
idempotency guards. Dictation's concurrency caps were D1 compare-and-set races
that object serialization removes.

**Considered and rejected:** Fencing the D1 effect-receipt shell instead of
deleting it (`0080` is unshipped, so the table simply never exists), moving
email receipts into WorkstreamDO (one email may intentionally name several
work streams, and ingestion already addresses the workspace object), and
keeping transcription admission regional for latency (the object hop is one
RPC on a path that then opens a cross-continent Azure WebSocket).

**Consequences:** D1's live surface for these flows is reduced to the
pre-workspace routing rows (`workstream_email_routes`,
`resend_webhook_receipts`). Effect receipts age out after 30 days uniformly;
redeliveries older than that converge on product identities. The legacy
pre-cutover email path still claims and settles its receipt in regional D1 so
one phase never splits a lease across two stores.

### 2026-08-18 — Opportunity batches have an indexed retention boundary

**What changed:** WorkspaceDO's initial SQLite schema adds partial indexes for
processing leases and completed-window retention. Its alarm query now reads
queued and processing windows through separate indexable predicates, and each
alarm reaps a bounded page of completed windows older than 30 days; event rows
cascade with their window.

**Why:** Completed admission batches are operational receipts, not permanent
workspace history. Keeping them forever made every alarm scan grow with the
workspace's lifetime even though the product state they produced already lives
in `work_opportunities` and provenance tables.

**Considered and rejected:** An unbounded periodic delete and retaining every
input event indefinitely. Bounded local cleanup preserves alarm latency and the
30-day window remains long enough for incident diagnosis.

**Consequences:** Opportunity product state is unchanged; only terminal batch
machinery expires. Because the Durable Object schema has not shipped, these
indexes remain part of its single initial migration.

### 2026-08-18 — Imports and compatibility SQL enforce authority shape

**What changed:** Workspace product imports distinguish JSON-object and
JSON-array columns, and the runtime database router rejects regional writes
that reference WorkspaceDO-local tables in a subquery. Migration tests now
exercise connector-route backfill/triggers, authority phase edges, and every
workspace-domain drain category.

**Why:** Syntactically valid JSON can still violate the target contract, and
classifying a mutation from any table name in its SQL can silently send a
regional audit write into the wrong database.

**Considered and rejected:** Relying only on SQLite `json_valid`, permitting
implicit cross-authority SQL, and testing only the happy-path maintenance
transition.

**Consequences:** Import failures surface before activation. Cross-object work
uses separate durable/idempotent operations, and control-plane migration
changes must extend the trigger matrix tests.

### 2026-08-18 — Workspace product domains move behind WorkspaceDO authority

**What changed:** WorkspaceDO's single initial SQLite schema now owns connector
connections, connection-scoped webhook replay receipts, OAuth attempt status,
and workspace-local handoff rows, Terminal egress policy and its
revisioned mutations, Slack workspace state, automations, digest configuration
and deliveries, schedules, resources/watches/notes, R2 reference/deletion
outboxes, memory, mention intents, and external delivery state. Existing
repositories use an allowlisted D1-compatible port that sends local SQL through
typed native RPC; a statement batch that names both object-local and D1/control
tables is rejected. The maintenance campaign imports these tables in foreign-key
order, verifies them with the rest of the workspace route, scrubs the legacy
connector-event body rows, and permanently fences their D1 writers.
Terminal mention shells are retained for 30 days and reaped through the owning
WorkspaceScheduler, never by a fleet-wide D1 product scan.

**Why:** Each row belongs to exactly one workspace and is frequently consumed
with other workspace state. Leaving it in D1 made D1 a product database and
forced object-owned workflows, sockets, and schedulers back through a second
authority for every operation.

**Considered and rejected:** D1 serving projections, live dual writes, one
Durable Object per workspace domain, and cross-object SQL joins. A maintenance
window permits a clean authority switch; separate domain objects would add
routing and distributed transactions without improving ownership; SQL cannot
provide atomicity across Durable Object databases.

**Consequences:** D1 remains necessary for identities, membership, placement,
ingress routing before the workspace is known, migration control, and bounded
operational audit/telemetry. WorkspaceScheduler reads due workspace product
rows from WorkspaceDO. R2 still owns bytes, while WorkspaceDO owns every pointer
and lifecycle intent. Cross-object resource and Terminal operations perform
separate, version-fenced reads rather than pretending a join spans
WorkspaceDO and SubstreamAgent.

### 2026-08-18 — Workspace activity and suggested work leave D1 product authority

**What changed:** WorkspaceDO's single initial SQLite schema now owns the
first-party activity log/targets and the complete work-opportunity lifecycle:
batch windows, opportunity records, provenance graph, user links/resolutions,
rankings, impressions/dismissals, and immutable start snapshots. D1 migration
`0083` adds only a maintenance import ledger and permanent writer fences for the
legacy source table shells. Route activation atomically scrubs imported rows;
only redacted opportunity ID anchors needed by the unshipped D1 workstream
foreign key survive. Opportunity-start RPCs return authorized activity roots
from the same object so origin resources enter the new SubstreamAgent's initial
SQL transaction before its first run dispatch.

**Why:** Both datasets belong to exactly one workspace and are consumed beside
the workspace directory. Keeping them in regional D1 made the nominal control
plane a product serving plane and forced delayed connector processing to retain a
second body source.

**Considered and rejected:** Keeping D1 projections for relational convenience,
dual-writing through rollout, and splitting opportunity provenance from its
opportunity/user state. The maintenance window makes dual authority unnecessary,
and splitting the graph loses the atomic boundary that makes a resolved
suggestion explainable.

**Consequences:** Activity visibility joins the WorkspaceDO directory locally;
opportunity admission and ranking run in Workflows against fenced WorkspaceDO
leases; dormant rankings create no polling loop; opportunity-origin attachment
does not race the first agent context read. D1 retains membership and connector
identity inputs, migration receipts, and opaque opportunity identity anchors,
but no activity rows, opportunity content/provenance/user state, or active read
or write path for these products.

### 2026-08-18 — Connector event bodies move into WorkspaceDO

**What changed:** The table catalog now makes
`workspace_connector_events`/`workspace_connector_event_ingress_receipts` the
normalized provider-event authority. The regional Queue carries the bounded
normalized event to WorkspaceDO; D1 `activities` is legacy maintenance input
only and is scrubbed/fenced at activation.

**Why:** Connector events have exactly one workspace owner. Persisting their
long-lived body in the regional relational control plane created a second
authority without enabling a valid cross-workspace join.

**Considered and rejected:** A provider-delivery row shared by multiple
workspaces, and an indefinite D1 read projection. The former crosses visibility
boundaries; the latter keeps D1 authoritative in practice regardless of what
the object schema says.

**Consequences:** Long-lived readers resolve events through WorkspaceDO. Raw
provider bodies remain in R2, Queue retries converge on object-local provider
identity/dedupe constraints, and no D1 row is required between verification and
WorkspaceDO admission.

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
origins, errors, and import mappings now use `block_dashboard_*`. Deployed D1
migration `0043_hypersight.sql` remains byte-for-byte immutable; the forward
`0078_rename_hypersight_to_block_dashboard.sql` migration performs that rename. The
per-block execution owner is `BlockDashboardAgent`; API shapes use
`BlockDashboard` types.

**Why:** Persistence should name the authority it implements rather than a
product label. The common prefix now joins configuration, dispatch, execution,
socket receipts, and publication state in schema inspection and telemetry.

**Considered and rejected:** Keeping old physical table names while renaming
only TypeScript, and renaming the historical migration file. The former leaves
misleading storage vocabulary; the latter replays because D1 tracks the full
filename rather than only its numeric prefix.

**Consequences:** The unshipped DO baseline uses the final name directly, while
D1 reaches it through a new forward migration. Tests assert both historical
migration immutability and the resulting schema. Visible dashboard text still
says HyperSight and is not derived from storage identifiers.

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
the maintenance generation opens. D1 migration `0079` records the phase/routes
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
