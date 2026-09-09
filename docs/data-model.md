# Data model

Rally's regional data is split by declared authority. D1 is the thin regional
control plane: it owns workspace/member/user identity, object and connector
ingress routing, migration coordination, global-provider handoff receipts, and
operational audit/telemetry. `WorkspaceDO` owns every workspace-scoped product
that is not intrinsically one work stream or automation: connector credentials
and local handoff state, Terminal egress policy history, digests and shared
schedules, resources/notes/watches and R2 lifecycle references, shared memory,
external-delivery intents/attempts, inbound-email processing receipts,
dictation socket admission, the cross-work-stream directory,
first-party activity, and suggested work.

Each automation is authoritative in its own `AutomationDO`, a conversation
parent beside `WorkstreamDO`. WorkspaceDO stores only its content-free sidebar
row plus the external-event registrations that fan a connector event out. See
[`automation-lifecycle.md`](automation-lifecycle.md). D1 keeps no rebuildable
workspace product serving projection. Serving contract 1 makes each `SubstreamAgent` SQLite database the product authority for
one independently ordered substream after the guarded regional generation opens;
its non-agent parent (`WorkstreamDO` for a work stream, `AutomationDO` for an
automation) owns the aggregate metadata and the parent outbox. Legacy D1 workspace-product activity/opportunity rows are
maintenance import input and are scrubbed before each verified WorkspaceDO route
becomes active. Migration 0090 removes those sources, the per-work-stream source
tables, and their writer fences after the authority is open. Neither family is a
serving fallback or part of the current D1 schema. The checked-in migrations are the authoritative D1 schema and the
object schema registry is the authoritative DO schema. This document maps both
rather than duplicating their DDL. Application
contracts expose camel-cased TypeScript values; storage uses explicit
snake-cased columns, and JSON only where provider- or model-shaped data is not
relationally queried.

Read it before adding a table, a column, or a migration, and before assuming that
knowing an object's ID is enough to read it — it never is.

Migration 0101 adds Global pre-workspace `access_requests` and hashed
`download_grants`. Their lifecycle and regional boundaries are in
[private access](private-access.md). The shared migration creates empty EU schema;
public acquisition writes only in Global. Migration 0102 adds nullable
`expires_at`: null retains single-use admission, while a UTC deadline permits
repeat downloads until expiry. `used_at` remains the first-use timestamp. Migration 0103 adds nullable
`acknowledgement_from` to freeze the authored sender for new requests; legacy
rows preserve transactional sender resolution.

## Personal work-stream access history

WorkspaceDO migration 37 adds `workspace_workstream_access`, keyed by user and
workstream, with an integer server timestamp and cascading deletion from the
directory row. It is private object state, accessed through the workspace socket
and directory RPCs, not the generic D1 facade. Foreground visits update it;
read-watermark and child projection writes do not. See
[sidebar ordering](workstream-pinning.md#recent-work-streams).

## Sidekick loading and attachment storage

SidekickDO migration 3 adds automation.loadable, atomically maintained with the accepted revision. WorkspaceDO migration 35 projects this value, using null for unresolved legacy eligibility. Substream migration 43 adds sidekick_attachments and sidekick_execution_skills for conversation ownership and retry-stable instruction snapshots. Existing namespace lookup keys remain unchanged.

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
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Canonical transcript fact ownership, participant and exact Bind projections, range snapshots, activities, and compaction checkpoints. |
| `apps/api/src/durable-objects/workspace-do.ts`, `workspace-product-schema.ts`, `workspace-domain-schema.ts`, `workspace-product-storage.ts`, `workspace-runtime-sql.ts`, `workstream-do.ts` | SQL schemas and repositories for authoritative workspace product state, typed compatibility SQL, sync/command routing, bounded invalidation replay, non-agent child aggregation, and work-stream metadata sockets. |
| `apps/api/src/services/workspace-runtime-database.ts` | D1-compatible routing port that sends an allowlisted workspace-product statement to typed WorkspaceDO RPC while leaving global/regional control SQL in D1; mixed-authority batches fail closed, and so does any single statement — read or write — naming both a WorkspaceDO table and a regional-only one. |
| `apps/api/src/durable-objects/workspace-directory-protocol.ts` | Typed, runtime-validated cross-object query and effect contracts joining WorkstreamDO facts to WorkspaceDO serving state without cross-database SQL. |
| `packages/contracts` | The camel-cased shapes the columns are mapped into. |

## How it works

### Early-access acquisition

- `access_requests`: Global normalized email uniqueness, original request time,
  frozen acknowledgement sender/subject/body and provider-acceptance state.
- `download_grants`: SHA-256 token digest, manual/invitation source attribution,
  operator, first admission, revocation and optional exact UTC expiry. Null expiry
  means single-use without time expiry; a deadline allows repeated admission.
- `access_request_rate_buckets`: hashed edge IP and current hourly count, written
  only for a finite configured intake cap. Old buckets are removed on the next
  guarded request; raw IPs are never stored.

All arrive in `0101_private_access.sql`. These pre-workspace records have no
workspace association; existing workspace deletion does not erase them. Both
regions share schema, while this slice writes only Global. [Private access](private-access.md)
owns their lookup, erasure, admission and delivery semantics.

### Search projection state

WorkspaceDO migration 33 owns `resource_search_versions`: a retained resource revision, pending flag, and dispatch time. Resource insert/delete and search-relevant update triggers advance it in the same transaction as the canonical write. SubstreamAgent migration 42 adds `conversation_search_links` and transcript-triggered `search_projection_v1` entries in `durable_outbox`. Both migrations enqueue existing records; these are projections, never new content authority. See [text search](text-search.md).

WorkspaceDO migration 39 adds partial indexes for draft upload cleanup
(`resources_expired_drafts_idx`), missing slugs (`resources_missing_slug_idx`),
and pending search revisions (`resource_search_pending_due_idx`). They bound
these reads to pending work rather than the entire retained resource inventory;
completed search watermarks remain durable. No table or authority is replaced.

WorkspaceDO migration 43 replaces the resource search update trigger with a
comparison of search content/category inputs. Non-search metadata and bookkeeping
updates preserve the revision and pending/retry state; insert/delete triggers
remain unchanged. `resource-update-cost.test.ts` verifies a populated v42 upgrade.

### Identity and tenancy

Account presentation and new-user eligibility are added by migration 0099.
Global identity owns the revisioned name, initials, avatar and color, projected
narrowly to EU. WorkspaceDO migration 34 owns resumable per-person
onboarding and confirmed connector selections. See [new-user onboarding](new-user-onboarding.md).

- `users` stores Google identity subjects and display information, plus the
  account's IANA `timezone` and the `timezone_source` that says who put it
  there. `client` means a desktop sign-in seeded it from the machine and a
  later sign-in may seed it again; `user` means somebody chose it in settings,
  and sign-in leaves it alone from then on. It is one column per region —
  `users` is regional — so it answers for every workspace the person belongs to
  in that region, and a second region's row keeps its own. `syncRegionalProfile`
  deliberately syncs `email`, `name`, and `avatar_url` and not `timezone`, so a
  zone chosen in one region does not cross to another.
- `workspaces` pins an immutable `global` or `eu` region plus its immutable
  west/east Durable Object placement affinity. `abandoned_at` closes the
  workspace without deleting retained authority; application authorization
  treats a non-null value as unreachable. The Global
  `platform_workspace_bindings` rows carry the same opaque routes, one per
  account/workspace/region; `wnam` and `weur` are
  migration/background/missing-request-metadata defaults only. A partial unique
  index permits at most one `pending` route per account while any number of
  `active` or reconciled `inactive` routes coexist.
- `workspace_members` authorizes users as owner, admin, or member.
- `sessions`, `oauth_states`, and `desktop_login_tickets` support revocable
  sessions, PKCE, and single-use Electron deep-link completion. A session that
  simply expires is also marked `revoked_at` by the five-minute reaper, which is
  what makes announcing the expiry exactly-once; see
  [`access-revocation.md`](access-revocation.md). `oauth_states`
  is the signed pre-workspace callback route/security receipt; the user-visible
  `connector_oauth_attempts` status row lives in the selected WorkspaceDO.
- `workspace_invitations` supports explicit membership growth. Acceptance adds
  one row to the already-many-to-many `workspace_members` authority; it does not
  replace another membership.
- `platform_workspace_operations` maps one client operation id and request
  fingerprint to the destination chosen for workspace creation or invitation
  acceptance. It contains opaque routing identifiers, not workspace names or
  invited addresses, so replay can resume a regional write without moving EU
  product data into Global.

Every workspace-scoped table that remains in regional D1 carries `workspace_id`,
and every D1 repository lookup includes it. Imported compatibility rows inside
WorkspaceDO may retain that column for repository shape, but singleton triggers
force it to the object's workspace. Native Durable Object tables instead store their external workspace/work
stream/substream identity once in a singleton and omits those repeated keys from
local child rows; every request is checked against that identity before local
SQL runs. Knowing either a D1 row ID or a Durable Object ID is never sufficient
authorization.

### Realtime synchronization records

Each main `SubstreamAgent` transcript has one semantic fact/payload owner and
two ordering projections. `participant_transcript_turns` assigns
`transcript_sequence` to participant-visible conversation turns and safe status
events; `participant_transcript_blocks` orders text, tool, and generic thinking
blocks inside a turn. `bind_loop_heads` and `bind_loop_state_messages` assign
the exact provider-facing state revision and `loop_sequence`, including private
protocol messages and compaction replacements. Both projections reference
`transcript_facts`; identical payloads are not independently copied merely to
serve another ordering. Each fact also records whether it is canonical,
protocol-only, a model-facing derivative, or a system projection. Derivatives
must carry a typed source identity and optional source revision; system
projections point to the exact prompt-input hash and renderer revision. These
fields are fact metadata rather than a second payload copy, and the source index
makes the ownership trail directly inspectable.

The admitted feed socket's hibernation attachment owns its half-open range
snapshot fence and room event waterline; there is no append-only snapshot table
or guessed expiry window. `transcript_activities` and
`transcript_activity_intervals` store
nestable response, assistant-turn, plugin, tool, thinking, and compaction
lifecycle edges with UTC boundaries. `transcript_compaction_checkpoints` keeps
the principal/inventory-fenced private continuation. Query-shape indexes cover
latest conversation turns, unread attention anchors, sequence ranges, active
activities, exact loop reconstruction, provider-boundary verification, and
compaction lookup.

`participant_transcript_turns` is the sole participant-visible identity and
ordering boundary. Each turn references one content-addressed root fact;
`participant_transcript_attachments` and `participant_transcript_mentions`
reference the turn directly.
`transcript_compaction_checkpoints` references the
exact model-only checkpoint fact. The pre-v27 projection, payload-transfer
receipts, and temporary message-record identity shim were migration evidence and
are gone after schema v33; they are not runtime sources of truth.

`WorkspaceDO` is the relational authority for workspace product state and
cross-work-stream serving. It stores connector/product configuration, Terminal
policy revisions, the automation directory, digests/schedules,
resource/note/watch/memory records, external-delivery state, inbound-email processing receipts and their
exclusive leases, dictation admission (one-time transcription ticket receipts
and the concurrency session leases the per-user/per-workspace caps count), the
common directory, per-viewer overlays, pins, inverted indexes, activity,
opportunities, receipts, consumed socket tickets, and a bounded monotonic
`workspace_sync_events` log. A sync row names
typed query topics; it never embeds the underlying row. Membership, invitations,
user profiles, placement routes, and migration control remain D1 authorities.

`WorkstreamDO.workstream_metadata` is different: it is the authoritative
parent metadata projected from Main. Its revision covers complete common metadata;
only Main entries in `substream_user_directory` produce the parent viewer overlay.
Child title and lifecycle live in `conversation_children`, whose nullable
`archived_at` is independent of creation readiness. Archive retains membership
and transcript while excluding the child from the visible directory. A WebSocket
snapshot includes nulls so a client can delete a former email,
archive/system marker, or schedule rather than accidentally retain it.
`SubstreamAgent` continues to own ordered parts, active output, and replay; token
frames are never database joins or metadata patches.

Each `SubstreamAgent` owns one stable `substream_loops` row (which, since v45,
carries `transcript_projected_through` — the highest transcript sequence the
model's conversation has considered, so a turn that started no run is appended
at the next admission rather than lost),
not-yet-canonical `pending_loop_inputs` whose prepared content is immutable
and whose `input_sequence` is the live promotion order, minimal immutable
`delivered_loop_inputs` replay receipts, exact `assistant_turn_reservations`,
subordinate execution receipts in `runs`, and a
Bind head rebuilt from canonical participant history when no stable projection
exists. These are connected by typed, hash-checked RPCs rather than cross-object
SQL joins.

### Work streams

- The main `SubstreamAgent`'s object-local `workstream` row is the product root;
  each provisioned child carries the bounded root facts needed to authorize and
  project its own context, while `WorkstreamDO.workstream_metadata` is the
  Main-derived parent view. `workstream_key` is the conversation parent id and
  `parent_kind` (v39) says whether that parent is a work stream or an
  automation; `origin_type`, `automation_subscription_id`, `automation_run_id`,
  and `planned_for` are dead columns, kept only because the released
  runtime-compat triggers name them. `objective` is the work
  stream's description; `description_source` records whether a person wrote it
  (`authored`) or it was derived at creation or by the refresh loop (`derived`),
  which is what lets an automatic rewrite weigh a deliberate line differently from
  a copied opening message. `title_status` is the same question for the title:
  `naming` while the naming agent is choosing the first one and the stored title
  is a placeholder clients render as a skeleton, `automatic` once Rally has named
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
  checks, resource reads, and Suggested Work all use that
  same rule. Creation seats the creator, but `created_by_user_id` is attribution,
  not a permanent authorization grant: `removeParticipant` revokes a creator in
  exactly the same way it revokes anybody else. Any current reader may remove
  themself or another participant, but the object commits removal only while at
  least one other active participant remains; a work stream never has an empty
  participant room.
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
  **An automation's conversations are `personal` too, whatever the automation's
  scope**: its own chat seats the author, and each run, a child substream under
  the automation, seats exactly the run-as principal, for every trigger. A run
  is a nested execution record rather than a room; who may read the
  automation's conversations is the `AutomationDO`'s decision, carried down at
  admission. [`automation-lifecycle.md`](automation-lifecycle.md) owns that
  rule. A suggestion carries its own
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
  `system_kind` row is machinery assembled from one person's activity. An
  automation's conversation has no scope toggle at all; its readers are its
  parent's decision. Its creator is also seated as a participant.
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
  removed from their audience cannot make it visible again.
  An archived or narrowed work stream contributes no row while remaining
  removable by its owner. See [`workstream-pinning.md`](workstream-pinning.md).
- `projects`, `project_participants`, and `workspace_project_order` in
  WorkspaceDO hold project identity/presentation, project-level readers, and
  each person's fixed server order. Presentation, audience, and lifecycle use
  separate revisions so a rename does not stale an audience operation. Project
  names are unique after normalization across active and inactive rows, and the
  icon/color columns accept only the shared V1 registries. See
  [`projects.md`](projects.md).
- Object-local `participants` records explicit participation reasons, and
  `first_opened_at` — null until that person opens the work stream, which is
  what makes "you were added to this and have never been here" a state the
  sidebar can show. It is on the membership row rather than on `member_attention`
  because the attention row does not exist for somebody who has only been added.
  See [`workstream-markers.md`](workstream-markers.md). Viewer presence is
  intentionally absent from durable storage.
- Object-local `participant_transcript_turns` has a per-work-stream
  `transcript_sequence`; the root
  `workstream.next_sequence_number` allocates ordered events. Conversation rows
  belong to a `substreams` row, with the main chat fixed at substream `0`.
- `participant_transcript_mentions` stores validated person and connector spans
  keyed to their canonical turn.
- `participant_transcript_attachments` relates a resource to one exact owning
  turn. A
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
  `slug` is a short workspace-unique alias minted from the work-stream address
  generator, allocated once and never rewritten; it is `NULL` until the
  allocator or the `resource_slugs` maintenance pass reaches the row, and the
  UUID is the primary key regardless.
  `current_version` identifies the latest semantic state and `resource_versions`
  retains every state from version 1 onward, including its original and
  model-readable R2 refs, its provenance (`author_kind` with the one identity
  column that kind admits, and `cause`), and a `storage_kind` naming the shape
  of the refs — one value today, deliberately unconstrained so a later storage
  shape needs no table rebuild. Provenance reaches a version through
  `revision_author_*` and `revision_cause` on `resources`, set by the same
  statement that swaps the pointers; a trigger refuses a version whose identity
  does not match its kind, which aborts that swap rather than storing a wrong
  attribution. Rows captured before provenance existed carry none. Inserts create version 1. Writes to identity, display,
  content, hash, or hydration fields increment it; derivative claim/processing
  writes enrich that same version. A successful external refresh increments the
  version through `last_hydrated_at`, even when the provider returns the same bytes.
  Each new original or derivative generation is pre-registered in
  `resource_object_deletion_outbox` with `cleanup_eligible = 0` while its writer
  owns publication. Successful pointer publication cancels the new row and
  queues the former pointer; a known failure promotes the row to
  `cleanup_eligible = 1`. An ambiguous response stays staged because it cannot
  prove whether the pointer transaction committed. Cleanup rechecks current and
  historical version refs before deleting R2, and deleting or superseding a
  resource/version promotes any existing staged row before queuing every
  retained original and derivative. Inactive staged rows do not arm cleanup
  maintenance because that pass cannot safely act on them. Publisher cleanup
  deletes only rows still fenced at zero, while maintenance rechecks the active
  reference in the same statement that retires staging, so neither can erase a
  deletion trigger's later cleanup handoff. A staging response lost before R2
  is attempted is released because there are no bytes to protect; detaching one
  relationship leaves shared resource objects intact.
  WorkspaceDO `pending_attachment_reservations` is the deletion fence between a
  draft upload and one preparing or ready work-stream input. It freezes workspace,
  work-stream, author, input, and resource identity. Canonical
  `workspace_workstream_resource_links` projection marks the upload attached and
  removes the effect's exact input/resource reservations in the same transaction;
  failed preparation uses an idempotent typed release RPC. SubstreamAgent's
  `pending_attachment_reservation_recovery` is only the cross-object recovery
  obligation, not a second resource or message authority.
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
  workspace watches, and the inverted workspace index. `relationship_type` is
  constrained to `attachment`, `message_attachment`, `origin`, `generated`,
  `inbound_email`, or `context`. The work-stream-facing
  `direction` is derived from that relationship: `generated` is an `artifact`;
  every other relationship is a `source`. Direction is not stored on the shared
  resource because the same resource may be an artifact here and a source elsewhere.
  The `origin` relationship records what a work stream was created from — see
  [work-stream origin attachments](workstream-origin-attachments.md).
- `elicitation_requests` is operational human-input state tied to a run.

D1 retains a `workstreams` identity/routing anchor because control tables have
foreign keys to the stable ID. It contains only `id`, `workspace_id`, and
`do_identity_anchor`; a post-cutover row has `do_identity_anchor = 1`. The id
is a **conversation parent id**: a work stream's or an automation's, since an
automation's conversations are bootstrapped through the same path, and
`workstream_authority_routes.workstream_id` is keyed the same way. The column
names are kept because D1 migrations are immutable and every reader of the
route keys on the same pair. Likewise `workstream_email_routes.automation_subscription_id`
keeps its name and holds the automation id. Common/per-user
list queries, pins, and resource discovery use `WorkspaceDO`'s
`workspace_workstream_*` tables. D1 has
no projection fallback when that object is unavailable.

### Automations and execution

**An automation's own state is not here.** Each automation is a named
`AutomationDO` Durable Object, a conversation parent like `WorkstreamDO`, that
owns its definition revisions, lifecycle, schedules, runs (each a child
substream under it), and inbound-email receipts.
[`automation-lifecycle.md`](automation-lifecycle.md) is that schema's map and
[`workstream-durable-object.md`](workstream-durable-object.md#automationdo) its
column catalog; what follows is only what WorkspaceDO still holds.

- `automation_directory` is the content-free projection the sidebar, the
  connector fan-out, and access revocation find an automation by: id,
  workspace, author, `source_version`, payload hash, lifecycle (`draft`,
  `active`, `paused`, `deleted`), scope (`personal`, `workspace`,
  `workstream`), the owning work stream a `workstream` scope must name, title,
  description, next run time, and when it was projected. It holds no
  definition, no instructions, and no run content, and a row can locate an
  automation but never authorize a read of one. The object publishes it as a
  `directory_automation` effect through the same parent outbox its children's
  aggregates use; `applyAutomationDirectory` accepts a strictly newer
  `source_version`, ignores an older one, and refuses an equal one carrying a
  different hash.
- `workspace_external_event_registrations` holds one row per active trigger
  route, an automation's typed evaluator document or a work stream's watched
  resource, indexed on `(connection, event type, resource, state)` for
  candidate selection and on `(destination kind, destination key, state)` for
  replacement. A destination's set is replaced whole by
  `applyExternalEventRegistrations`, ordered by the destination generation in
  `external_registration_generations`;
  `effective_after_event_sequence` is the cutoff, so an event admitted before
  the call is never matched by a rule that did not exist when it arrived.
  Removed rows are reaped after a day.
- There is no delivery ledger. `matchExternalEventDestinations` returns one
  complete Queue message per match, and the destination is idempotent on the
  event and registration ids, which is all a lease ever guaranteed.
- `schedules` carries no automations. A row names exactly one of a connector
  connection or a digest schedule; an automation's timers are alarm entries
  inside its own object.
- Migration 31 dropped `workspace_external_event_deliveries`,
  `automation_creation_claims`, `automation_cutover_campaign`,
  `automation_templates`, and `automation_template_versions`, rebuilt
  `automation_directory` and the registrations without their coordinates, and
  deleted every work-stream directory row an automation run had made. The
  directory's `origin_type`, `origin_label`, `automation_subscription_id`,
  `automation_run_id`, `planned_for`, and `automation_exposed` remain as dead
  columns inside the released CHECK constraints; nothing reads or writes them.
  The cutover of 2026-08-28 that once dropped `automation_subscriptions`,
  `automation_runs`, `automation_delivery_targets`, `automation_resources`,
  `automation_email_receipts`, and `automation_email_rate_windows` is history
  the changelog carries; a fresh WorkspaceDO still creates them inside frozen
  migration 1 and drops them with its identity row.

- `memory_scopes` owns durable work-stream, user, workspace, and automation
  memory authority. `memory_items` stores compact prose facts; `memory_tables`,
  `memory_table_columns`, `memory_table_rows`, and `memory_table_cells` store typed
  collections with natural-key deduplication and targeted queries. An
  automation's chat and its runs resolve one scope of kind `automation` keyed by
  the automation id, beside the workspace scope; there is no automation memory
  engine elsewhere. A run creates the tables its definition describes through
  the memory tables plugin under that scope the first time it needs them.
- A run's convergence is its `AutomationDO`'s `runs.occurrence_key`, unique per
  automation and derived per trigger: `schedule:<scheduleId>:<plannedFor>` for a
  timer, `inbound_email:<resendEmailId>` for mail, `manual:<idempotencyKey>` for
  a **Run now**, and `external:<workspaceEventId>` for a connector event. The run
  id is the child substream id, and `harness_run_id` is unique per run.
- Object-local `runs` records each bounded model loop. `tool_effects` is unique on
  `(run_id, tool_call_id)` and stores input hashes plus side-effect state.
- `transcript_compaction_checkpoints` references the model-only fact that owns
  the raw LLM continuation summary per execution principal and immutable
  run/sequence event, with its
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
- `resident_context_blocks` and `resident_context_compactions` are the
  conversation's context-residency ledger (substream migration 51): per
  `(kind, block_id, sha256)` the bounded content a checkout's `AGENTS.md`
  delivered, where it lives (`transcript`, `system`, `none`), its remaining
  prompt lifetime, and whether a delivery is pending; and one row per
  compaction event whose transitions were applied. Rows are never deleted.
  See [`resident-context.md`](resident-context.md).

### Activity log and digests

- `WorkspaceDO.workspace_workstream_effect_receipts` is the inbox for queued
  WorkstreamDO directory, activity, resource-link, and
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
  remain regional — meaning *per region rather than Global*, not *in regional
  D1*. All three are WorkspaceDO tables, reached through
  `withWorkspaceRuntimeDatabase`; regional D1 has not had them since migration
  0090. Reading the distinction the other way is what produced the
  `slackUserIsLinked` incident below, and again the automation delivery-target
  500 of 2026-08-31.
- An automation has no destinations anywhere: `AutomationDO` stores none, and
  a run's loop input is a reference to its definition revision. A room-owned
  automation's result reaches the room through the run's own
  `automation_post_result` tool; any other destination is the run's own work,
  sent with its connector tools.
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
  constraints select one canonical event; processing status, processing owner,
  claim, error, and settlement timestamps stay beside the body. The separate
  `workspace_connector_event_ingress_receipts` maps each Queue/provider ingress
  UUID and content hash to that canonical event.
- Legacy regional D1 `activities` rows are maintenance import input only. The
  verified cutover imports them into `workspace_connector_events`, scrubs the
  source, and permanently fences D1 writers. Live provider ingress resolves an
  opaque global/regional route and sends the bounded normalized event through
  the workspace's regional Queue. The consumer commits it to exactly one
  WorkspaceDO and then sends an ID-only processing pointer back to that same
  Queue. A later delivery claims and settles the canonical event by typed RPC.
  Large/raw provider bytes stay in R2; D1 is never an event-body relay.
  Global provider receipts and setup routes may remain in D1 only when they
  exist before a workspace can be selected.
- `resource_watches` records explicit direct relationships.
- `audit_events` records security- and side-effect-relevant actions without copying
  sensitive bodies.

### Demo workspaces and object retirement

Five tables belong to the demo-workspace lifecycle, and they sit at three
different authorities on purpose. [`demo-workspaces.md`](demo-workspaces.md)
owns the three in D1 and [`workspace-retirement.md`](workspace-retirement.md)
the two in the objects; this entry exists so somebody adding a table finds them.

- **Regional D1 `demo_operations`** is the preparation and the register in one
  row per operation the operator started — company, presenter, pack version,
  cast, the workspace once allocated, status, attempt, failed phase and
  reason, and the instants the workspace was published (`ready_at`) and closed
  (`retired_at`). The operation is the identity the PRD requires — repeated
  submission resolves to the same row — and it exists before a workspace does.
  `workspace_id` is nullable, unique, written before the workspace is created
  so a retry reuses it, and deliberately carries no foreign key to
  `workspaces`: D1 enforces one on the write, and the write precedes the row it
  would reference. Discovery withholds a row with no `ready_at`, and the Demos
  page lists every row. It is not an authorization input for retirement — that
  gate was built and dropped; retirement is an operator action on any
  workspace behind Ace's Access policy. It carries no `region` column for the
  same reason `workspace_members` does not: it derives region from which
  regional D1 it lives in.
- **Regional D1 `demo_operation_phases`** holds one row per phase per
  operation with its status, attempt, a small detail object the page renders
  and its error. The phase names are the contract's, not a `CHECK`: they are a
  product decision that will move, and SQLite cannot widen a `CHECK` in place.
- **Regional D1 `demo_seed_receipts`** records what the seeder confirmed, one row
  per pack action of one operation: its kind and room, the work stream and human
  turn it wrote, the run and how it settled, the elicitation a question opened,
  the resource an upload attached. It references `demo_operations` by
  `operation_id`, so a receipt cannot describe a demo no operation started, and
  it is written only after the action's outcome is confirmed — preparation
  resumes from it and the readiness barrier generates its expected manifest
  from it, both of which need rows that mean "done" rather than "attempted".
- **`object_retirement`, in every gated object's own SQLite**, is one permanent
  row: the tombstone. It is not in D1 because the gate has to answer during
  constructor recovery, before anything cross-authority could be consulted.
  It arrives through each class's own append-only migration ledger, from one
  shared constant, exactly as `_internal_durable_alarms` does.
- **`workspace_retirement_graph`, in WorkspaceDO**, holds one row per conversation
  parent with a nullable `retired_at` receipt, captured *before* the tombstone
  lands. Completion is the absence of unreceipted rows plus the workspace's own
  tombstone, rather than a flag somebody sets.

In D1, retirement writes no table of its own: the operator door sets
`workspaces.abandoned_at`, the column the last member leaving already writes and
every authority read already fences on, before any object is closed.

All three D1 tables arrive in one migration, `0100_demo_workspaces.sql`.
Retirement is not deletion. Every other row stays exactly where it is; the
tombstone is what stops anything reading or draining them.

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
   retains a validated IANA timezone, and an account timezone somebody chose
   is never overwritten by a client's. Calendar intent separately retains the
   IANA timezone a person named for it; a trigger that names none resolves in
   the order explicit trigger, personal owner, then workspace, read where the
   schedule is derived: a digest's on its WorkspaceDO `schedules` row, an
   automation's inside its own object when a revision is applied (the run-as
   user's zone for a personal automation, the workspace's otherwise). The
   resolved zone is then frozen on that row and does not follow a later change
   to the account, unlike a digest's, which is re-derived;
   `docs/potential-bugs.md` carries the question of whether it should.
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
14. **An effect is acknowledged to the Queue only after the owning receiver
    commits the effect and its receipt together, and the sender's outbox row is
    deleted when `sendBatch` accepts the message, because retry is the Queue's.**
    A child's effects commit in its parent (`WorkstreamDO` or `AutomationDO`);
    directory/user effects, an automation's row, and first-party
    activity/mention effects commit in WorkspaceDO. External notification
    intent and delivery state also commit there; D1 supplies only current
    member/user identity and opaque provider routing. Queue order and
    uniqueness are never trusted, generation/version fences mutable state, and
    immutable effects use stable IDs. Nothing loads an envelope back from a
    sender and nothing acknowledges one to it.

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
| The automation lifecycle and every table `AutomationDO` owns | [`automation-lifecycle.md`](automation-lifecycle.md) |
| The conversation-parent contract and the effect legs between the objects | [`workstream-durable-object.md`](workstream-durable-object.md) |
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
- **A deleted automation's object is kept forever.** Its lifecycle moves to
  `deleted` and its directory row records that; the object itself is never
  destroyed, because its run history, its conversations, its memory scope, and
  the permanent Global email tombstone all still name it. Its conversations
  become unreadable rather than deleted: `authorizeViewer` answers unauthorized
  and archived from then on.
- **A `system_kind` work stream refuses a scope change** with
  `scope_change_unsupported`. That is deliberate, not a missing case.
- **A migration deployed ahead of the code that needs it is the safe order; the
  reverse is not.** A `CHECK` relaxed before the enum widens means rows the new
  schema accepts fail the readers still running. The destructive 0090 retirement
  is the documented exception: the replacement Worker supports both anchor
  shapes, and the deployment workflow keys its Worker-first barrier from each
  remote pending ledger before deleting schema the previous Worker still names.

## Testing

`pnpm --filter @rally/db test` is the suite that covers the schema itself:

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
`apps/api/test/workstream-object-schema.test.ts` and
`apps/api/test/workspace-do-schema.test.ts`; the latter applies the WorkspaceDO
ledger version by version and proves publication-fence defaults, constraints,
and deletion promotion. The real-workerd suites in
`apps/api/test-workers/durable-object-runtime.test.ts` and
`apps/api/test-workers/resource-object-cleanup.test.ts` cover constructor
migration, object isolation, eviction, compaction state, pagination, agent
checkpoint behavior, routed cleanup SQL, and actual R2 retention/deletion.
These tests are required because the regional D1 suite cannot validate
object-local SQLite lifecycle semantics.

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

### 2026-09-09 — Add pre-workspace access requests and download grants

**What changed:** Migration `0101_private_access.sql` creates normalized requests
with frozen acknowledgement sender/content, hashed grants with nullable expiry,
and an IP-hash rate bucket table populated only when the intake cap is enabled.

**Why:** Intake precedes workspace membership, while retrying email and download
authorization both need durable state independent of the browser.

**Considered and rejected:** Three incremental migrations for this never-deployed
schema added fictitious legacy states. One founding migration defines the complete
shape. Email uniqueness replaces duplicate request rows, and only token hashes
persist rather than reusable bearer URLs.

**Consequences:** Both regions receive schema; active intake stays Global. Timed
grants preserve first admission while allowing repeats until expiry. The lifecycle
and erasure procedure are in [private access](private-access.md).

### 2026-09-09 — The context-residency ledger

**What changed:** Substream migration 51 adds `resident_context_blocks` and
`resident_context_compactions` to the conversation object.

**Why:** A checkout's instruction files need a durable record of what was
delivered and where it currently lives, per conversation, so a compaction can
move them into the prompt and later retire them without re-reading a sandbox
that may be gone. `content` carries no byte `CHECK` yet: its bound is an open
placeholder in TypeScript until the team sets it, and a `CHECK` is not an inert
site. [`resident-context.md`](resident-context.md) owns the rows.

### 2026-09-08: Keep child archive separate from creation readiness

WorkstreamDO migration 9 adds nullable `conversation_children.archived_at`.
An additive column preserves preparation and membership rows and allows restore;
changing the creation-state CHECK would conflate readiness with archive and
require a table rebuild. Main remains the sole source of parent attention and
participation. Child notification delivery may install a neutral parent viewer
row for its existing delivery barrier, but never merges child unread ordinals
or membership into it.

### 2026-09-08 — Preserve search revisions across non-content updates

**What changed:** WorkspaceDO migration 43 replaces only the resource update
trigger, leaving existing rows, pending work, and deletion watermarks intact.

**Why:** Broad update invalidation amplified routine resource bookkeeping into
indexing reads and requests. Editing migration 33 would not upgrade deployed
objects and would violate the migration ledger.

**Consequences:** Search extraction changes must update the trigger in a new
migration; no-op discovery leaves `updated_at` at the last meaningful change.

PR: #611.

### 2026-09-08 — Index pending WorkspaceDO resource work

Migration 39 adds partial indexes for expired upload drafts, missing resource
slugs, and pending resource-search deadlines. Empty maintenance/search queries
were reading roughly 71,000 completed rows per derivation in the busiest
workspace. Indexing the demonstrated predicates preserves the existing ownership,
cleanup exclusions, and revision fences; deleting retained watermarks or caching
due times would weaken those guarantees. Future queries must retain predicates
that select the pending indexes, and migration history remains immutable.

### 2026-09-08 — Store per-user sidebar access history

Migration 37 records visits separately from activity and read state because the
sidebar must follow one person's access across sessions. The table stays in the
regional WorkspaceDO and is not exposed through the generic database facade.


### 2026-09-08 — Order Sidekick registration replacement

Sidekick owner migration 4 stores `registration_generation`; WorkspaceDO migration
36 stores the latest per-destination generation and activation cutoff. A stale
publication tail previously could reinstall old predicates after new acceptance.
Equal-generation retries now preserve the boundary and empty replacements retain
the fence. These are object-owned SQLite migrations, not regional D1 migrations.
The Cloudflare class stays `AutomationDO` for the compatibility deployment.

### 2026-09-07 — Sidekick loading and attachment storage

SidekickDO migration 3 adds automation.loadable, atomically maintained with the accepted revision. WorkspaceDO migration 35 projects this value, using null for unresolved legacy eligibility. Substream migration 43 adds sidekick_attachments and sidekick_execution_skills for conversation ownership and retry-stable instruction snapshots. Existing namespace lookup keys remain unchanged.

This composes knowledge with existing execution machinery while keeping one Sidekick identity and preserving authorization boundaries.
### 2026-09-07 — Persist new-user identity and learning progress

Onboarding needs the same appearance and resumable setup across sessions.
Migration 0099 stores the revisioned account presentation in identity D1;
WorkspaceDO migrations 34–35 store the per-member journey and connector choices.
Existing accounts are exempted. A second execution store was rejected: first
work uses ordinary workstream creation and the existing durable agent loop.

### 2026-09-07 — One migration, and the operation row is the register

**What changed:** The three demo migrations written on the combined branch —
the register (`0099`), the seeder's receipts (`0100`) and the operation
(`0101`) — are folded into one file before any of them ships — `0099` as
written, `0100_demo_workspaces.sql` once `main` took `0099` for account
onboarding while this branch was open. `demo_workspaces` is gone: `demo_operations` carries `ready_at` and
`retired_at`, `workspace_id` is unique with no foreign key to `workspaces`,
`demo_seed_receipts` references `demo_operations`, and the phase name has no
`CHECK`. The entries below describe the shape as it was written and are kept
as the record of why each table exists.

**Why:** Review found the register duplicating the operation row with two
extra columns and a reader nothing called, two children of one operation id
referencing different parents, and a foreign key that refused the very write
the column was designed for — the creating phase allocates the id before the
workspace row exists, and D1 enforces the constraint on the write, so
preparation could not pass its second phase. One table is one identity, and
one migration is what the repository asks of one coherent change.

**Considered and rejected:** Keeping the register and dropping only the
foreign key — the duplicate would still have to be kept in step on every field
a demo gains. A `CHECK` on the phase name — a product decision that will move,
and SQLite cannot widen one in place.

**Consequences:** Anything that asks which workspaces the demo feature made,
or whether one is published, reads `demo_operations`. The migration is one
unshipped file and is the place a further schema change goes until it ships.

### 2026-09-07 — The preparation operation's rows

**What changed:** `demo_operations` and `demo_operation_phases` in regional D1
(`0101` as written; folded into `0100_demo_workspaces.sql` before release, see
above), one migration because they are one thing: the operation and its phases.

**Why:** The Demos page shows an operation's current phase, its completed
items and its failure from real receipts, and resumes it by id. Those receipts
have to outlive a Workflow instance and be readable without one, and the
operation has to exist before the workspace it makes. Owned by
[`demo-workspaces.md`](demo-workspaces.md).

### 2026-09-07 — The seeder's receipts

**What changed:** `demo_seed_receipts` in regional D1 (`0100` as written;
folded into `0100_demo_workspaces.sql` before release, see above), keyed by
operation and action,
referencing the register's `operation_id` and `workspaces(id)`, with `run_outcome` closed to the two outcomes a seeded run
may settle in. `runs.execution_context_json` in a seeded room's object gains an
optional `seed`.

**Why:** The seeder plays a pack through write paths that do not know they are
seeding, so nothing in those paths can say which pack action produced which
row. A receipt written after confirmation is what preparation resumes from and
what the barrier will compare the workspace against; a receipt written at
admission would let a run that failed count as seeded. The first row wins on
conflict because its ids are the ones already handed onward. Owned by
[`demo-workspaces.md`](demo-workspaces.md).

### 2026-09-05 — Two tables for closing a workspace permanently

**What changed:** `object_retirement` in the SQLite of all four object classes
that can belong to a workspace, and `workspace_retirement_graph` in WorkspaceDO.
Conversation-object schema v48 carries the tombstone, after `main`'s v46 and v47.

**Why:** A demo workspace is replaced rather than cleared, and "replaced" has to
mean an object that can never write again — including after eviction, when the
platform recovers an alarm and a Queue redelivers an effect. That needs an
authority the object itself can read before it admits anything, which is its own
SQLite and not D1.

**Considered and rejected:** The tombstone in D1 — the gate answers during
constructor recovery, where a cross-authority read is a second failure mode in
the one path that must have none. Deleting a retired workspace's rows —
retirement is reversible for nobody but auditable for everybody, and the
tombstone is cheaper and safer than a cascade. A regional register of what may
be retired — built, then dropped: retirement takes any workspace, and the
register was bookkeeping for a surface one Access policy already admits.

**Consequences:** Adding a table to any of the five gated classes now means
deciding what retirement does to the methods that read it — the default is
refusal.

### 2026-09-05 — Search projection state

**What changed:** Added resource revision watermarks, transcript intents, and captured-link rows.

**Why:** Delayed indexing must observe edits and deletions without resurrecting stale text.

**Considered and rejected:** Physical deletion without a retained watermark cannot reject old writes.

**Consequences:** Canonical stores remain authority; index revisions are projection concurrency controls.

### 2026-09-05 — The loop remembers how far it has read

**What changed:** Conversation-object schema v45 adds
`substream_loops.transcript_projected_through`, backfilled to the transcript's
high-water mark.

**Why:** The Bind projection is appended one admission at a time and never
re-read from the transcript, so a human turn that started no run was invisible
to the model forever. The column is the record of which turns the projection has
considered; the next admission appends the ones above it and advances the
column to what its scan covered, never to its own turn. Owned by
[`workstream-durable-object.md`](workstream-durable-object.md).

### 2026-09-04: Private work-stream children gain parent and local authority tables

**What changed:** WorkstreamDO migration 7 adds child readiness/title fields,
retryable preparation receipts, the authoritative per-child roster, and its
durable membership-effect outbox. SubstreamAgent migration 43 adds the
per-user/version membership mirror used for socket and command admission.

**Why:** A private non-main conversation needs an authority distinct from both
the main work-stream participant projection and the child-local product rows.
The parent decides visibility; the local mirror fences already-issued tickets
and closes removals without asking the parent on every frame.

**Considered and rejected:** A single global child membership counter. An
unrelated change to user B would make user A's still-valid receipt appear stale.

**Consequences:** Membership versions advance per `(child, user)`. Reserved and
failed membership effects are durable but not alarm-eligible; the readiness RPC
delivers them to the provisioned child before publishing it.

### 2026-09-03: Automations become conversation parents; the effect legs lose their acknowledgement

**What changed:** `AutomationAgent`'s thirteen-migration database is gone with
the class; `AutomationDO` starts at one migration holding the automation, its
revisions, schedules, runs, and receipts beside the shared parent tables.
WorkspaceDO migration 32 rebuilt `automation_directory` (versioned by the
automation's own `source_version`) and `workspace_external_event_registrations`
(no generation, version, or hash), dropped the delivery ledger, the creation
claims, the cutover campaign, and both template tables, and deleted the
work-stream directory rows automation runs had made. The SubstreamAgent root
gained `parent_kind` (v39) and WorkstreamDO gained `conversation_children`
(v6). Invariant 14 changed: a sender deletes its outbox row when the Queue
accepts the message, and nothing acknowledges an effect back to it.

**Why:** [`workstream-durable-object.md`](workstream-durable-object.md) and
[`automation-lifecycle.md`](automation-lifecycle.md) carry the reasoning in
full. The short form for this document: a run had a work stream of its own
because nothing else could be a conversation's parent, and every automation
column on the work-stream directory existed to hide those rows; the delivery
ledger and the registration coordinates existed to distrust a Queue that
retries and a matcher whose destinations are idempotent; and the previous
invariant 14 described an acknowledgement RPC whose only job was to delete a
row the sender no longer needs to keep.

**Considered and rejected:** Dropping the dead directory and root columns.
They sit inside CHECK constraints in released migration text, so removing them
is a table rebuild in both objects for columns nothing reads; recorded here so
the next reader does not take their presence as a live contract.

**Consequences:** `workstreams.id`, `workstream_authority_routes.workstream_id`,
and `workstream_email_routes.automation_subscription_id` are misnomers to live
with: the first two hold a conversation parent id of either kind and the third
an automation id, because D1 migrations are immutable. A directory row is
versioned by one clock per source now (the parent's waterline for a work
stream, the automation's `source_version` for an automation), and a second
writer of either number silently drops updates. Nothing before this entry in
this document's automation bullets was reconstructed; the entries below record
what was believed when each shipped.

### 2026-09-03 — The connector vocabularies admit a configured MCP server

**What changed:** WorkspaceDO migration 31 rebuilds `connector_connections` and
`connector_oauth_attempts` so their `connector_type` and `provider` CHECKs admit
`custom_mcp`. The rebuild holds each of the parent's thirteen dependents in a
scratch table, replaces the parent, and puts the rows back.

**Why:** SQLite cannot widen a CHECK in place, and `DROP TABLE` on a parent runs
an implicit delete that fires every `ON DELETE CASCADE` beneath it — a
workspace's Slack sessions, unfurls, ingress jobs, and webhook receipts. The
released escape from that is `foreignKeys: "disabled_during_rebuild"`, and it
does not work: `PRAGMA foreign_keys = OFF` is silently a no-op once an object
event has touched SQLite, which a populated workerd test caught by watching a
receipt disappear.

**Considered and rejected:** Rebuilding all thirteen dependents child-first, as
the guide's foreign-key-enforced recipe describes. Each would have had to restate
a schema that later migrations have already altered, and nothing in the test
suite would notice a column quietly not carried across. Holding rows instead
means the migration never names a dependent's shape at all.

**Consequences:** A future change to `connector_connections`' own shape should
copy this recipe rather than the disabled-foreign-keys mode, and
`CONNECTOR_CONNECTION_DEPENDENTS` in `workspace-do.ts` is the list it depends on
— a new table referencing `connector_connections` has to be added there or its
rows will be lost by the next such rebuild.

### 2026-09-03 — HyperSight storage is retired at every live authority

**What changed:** WorkstreamDO schema v5 and SubstreamAgent schema v38 drop the
dashboard configuration, run, preference, outbox, and receipt tables and remove
the pending refresh job.

**Why:** Disabling reads would leave feature data and retry work live inside
Durable Objects. Complete removal requires a forward cleanup at each authority.

**Consequences:** The older schema steps remain unchanged so existing objects
can migrate deterministically before the cleanup step runs.

Shipped in #541.

### 2026-09-03 — Stored automation state carries no delivery targets

**What changed:** The automation bullet above no longer describes a frozen
`deliveryTargets` set. AutomationAgent schema v13 dropped
`automation_acceptance.delivery_targets_json` and stripped `$.deliveryTargets`
from `automation_runs.context_json`; work-stream object schema v37 strips
`$.automationRunContext.deliveryTargets` from `runs.execution_context_json`, the
child's verbatim copy of the same context.

**Why:** The field left the strict `AutomationRunContextV1Schema`, which both
tables are read through, so any stored copy still carrying it stopped parsing.
The automation object's copy was rewritten in the same change that removed the
field; the child's copy was missed and is never cleared, so an in-flight run
could not be claimed, recovered or settled, and an older failed one could not be
retried. Rewriting stored state was chosen over tolerating the key on read
because a tolerated key is a dead field every future reader has to know to
ignore. The product reasoning is in
[`automation-lifecycle.md`](automation-lifecycle.md).

Shipped in #541.

### 2026-08-31 — Platform identity routes become plural and setup replay becomes durable

**What changed:** `platform_workspace_bindings` is keyed by account, region,
and workspace, gains an `inactive` reconciliation state, and keeps only pending
setup unique per account. `platform_workspace_operations` records the chosen
destination for create/accept operation ids. `workspaces.abandoned_at` provides
a reversible closed lifecycle without deleting retained data.

**Why:** Regional membership has always been many-to-many, but the Global route
primary key and completed-request replay behavior still forced one workspace
per account. Removing that key without a setup journal would let an ordinary
lost create response allocate another workspace on retry; making creation easy
without a reversible close would leave permanent clutter.

**Considered and rejected:** A single mutable current-workspace route, a Global
aggregate of regional membership, and immediate data deletion. They respectively
cannot switch out of an EU-bound session, cross the regional product boundary,
or require a deletion walk over D1, R2, and five Durable Object families that
does not exist.

**Consequences:** Global stores multiple opaque routes but regional membership
remains authoritative. Discovery may mark a missing route inactive only after
both regional reads succeed. Abandonment must fence every authentication and
invitation path before the column is used as a product action.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-30 — Suggested context storage was removed

**What changed:** Current WorkspaceDO and SubstreamAgent schemas no longer
contain feedback or suggested-action tables, and `suggested_activity` is no
longer a valid resource relationship. Forward migrations preserve an accepted
resource as an ordinary `attachment`, preserve its source audience in the
generic `content_audience_fences` table, and discard pending cards and feedback.

**Why:** The Suggested context feature was removed end to end. Keeping its
operational schema would leave a second, unused content-routing authority.

**Considered and rejected:** Leaving empty tables in place for history. The
append-only migration ledger and this changelog retain the history without
making current code or schema continue to own it.

**Consequences:** Historical migration SQL still names the retired tables and
relationship so deployed hashes remain valid; the live schema does not. The
generic fence stores no suggestion status or display state, but remains
immutable for the attachment's lifetime and blocks audience widening.

### 2026-08-30 — Pending loop `input_sequence` is the live queue order

**What changed:** SubstreamAgent schema v34 recreates
`pending_loop_inputs_prepared_immutable` so `input_sequence` can be updated
while every prepared column stays frozen. Visible pending ids are permuted
in place; `next_input_sequence` is not consumed and loop revision does not
move.

**Why:** Promotion order has to be a live, multi-viewer queue. Minting a new
pending row to "move" one would duplicate an immutable prepared payload.
Bumping loop revision would trip the in-flight execution fence.

**Considered and rejected:** Editing shipped v33 to drop `input_sequence`
from the original trigger. Existing objects have already hashed that
migration. Also rejected: assigning fresh sequences from
`next_input_sequence`, which would change the values promotion already
reserved behind a preparing mailbox head.

**Consequences:** A drag is a content-preserving sequence permute of the
currently visible set. Hidden pending rows keep the sequences they already
hold. Prepared-field updates still abort.

### 2026-08-29 — Memory vectors move to a versioned OpenRouter embedding space

**What changed:** WorkspaceDO migration 23 requeues each active memory item's
current vector projection after durable-memory embeddings move from Workers AI
to the fixed `qwen/qwen3-embedding-8b` OpenRouter model. The projection writes
into a namespace derived from the model, dimension contract, and an explicit
space version, so old vectors are never queried while the new corpus rebuilds.

**Why:** Equal vector dimensions do not make embeddings from independently
trained models comparable. Reusing the existing 1,024-dimensional Vectorize
indexes avoids destructive index replacement, but it requires a hard boundary
between the old and new coordinate spaces and a durable way to wake existing
workspace objects for reconstruction.

**Considered and rejected:** Mixing vectors because both providers return
1,024 values, and exposing the embedding model through Flagship. The first
silently corrupts retrieval; the second can change query embeddings without an
atomic corpus rebuild. A future model change therefore requires another schema
migration or an equivalent explicit rebuild and cutover.

**Consequences:** The requeue preserves invalidated, expired, and historical
revisions as retired. Until an active row is re-embedded, vector retrieval
misses it and hybrid search degrades to FTS rather than matching it in the wrong
space.

### 2026-08-29 — The runtime router answers for `automation_directory`, and every object table is now a decision

**What changed:** `automation_directory` joins `WORKSPACE_LOCAL_TABLES`, so the
work stream summary's read of an automation's title routes to WorkspaceDO
instead of to the regional database. `apps/api/test/workspace-runtime-database.test.ts`
gains a coverage test: every table WorkspaceDO's migrations leave standing must
appear either in `WORKSPACE_LOCAL_TABLES` or in that file's
`DO_TABLES_NOT_ROUTED_THROUGH_THE_FACADE`, the tables reached only by typed RPC
from inside the object.

**Why:** the router's fallthrough is "regional" — `localStatement` returns
`false` for a statement naming no listed table — and migration 22 added
`automation_directory` without adding it to the list. Nothing in D1 has ever
held that table, so the read was not misrouted on a judgement about where the
data lives; it took the default for a name the router did not recognise. It
answered `no such table: automation_directory` from D1 and surfaced as a 500 on
every attempt to open an automation's run work stream in production. The
coverage test exists because the one-line entry fixes this table and nothing
about the next one: a workspace-owned table that nobody routed is silently
regional until somebody opens the surface that reads it.

**Considered and rejected:** inverting the default so an unrecognised table is
refused rather than sent to D1. That needs a complete regional list, which the
2026-08-22 entry below already rejected for the read guard and for the same
reason — the region holds tables neither list enumerates, and the rule would
refuse statements that are correct today. A test that fails when a migration
adds an unrouted table catches the same defect at the only moment anyone can act
on it, and costs nothing at runtime. Also rejected: adding all 39 unrouted
object tables to `WORKSPACE_LOCAL_TABLES` on the theory that local is always the
safer answer. Some of those names — `projects`, `resources` in an earlier life —
are generic enough that a regional table could take them later, and claiming a
name the facade never sees buys nothing.

### 2026-08-28 — Automation product state moves out of WorkspaceDO

**What changed:** Named `AutomationAgent` objects own draft turns, compiled
definitions, lifecycle, timers, occurrences, generated-run history, delivery
receipts, inbound-email receipts, and automation-scoped memory. WorkspaceDO
migration 22 adds what is left of the workspace's side — `automation_directory`,
`automation_creation_claims`, `workspace_external_event_registrations`,
`workspace_external_event_deliveries`, and `automation_cutover_campaign` — and a
one-shot cutover then drops `automation_subscriptions`, `automation_runs`,
`automation_delivery_targets`, `automation_resources`,
`automation_email_receipts`, and `automation_email_rate_windows`, rebuilds
`schedules` without `automation_subscription_id`, deletes private
`automation_templates` rows, and deletes `memory_scopes` of kind `automation`.
Shared templates and their immutable versions stay. Two audience rules changed
with it: every automation-generated work stream is now `personal` with the
automation's author as its only participant regardless of the automation's scope,
and automation memory is no longer a workspace memory scope at all.

**Why:** One automation needs one transactional authority from first turn
through deletion; the workspace remains the correct fan-in authority for events
shared by many destinations. Automation state in WorkspaceDO also meant a
generated run's audience was answered twice — once by the automation's scope and
once by the work stream's — and the two could disagree.

**Considered and rejected:** Keeping the subscription tables as a read fallback,
which is what makes a dual-authority migration reversible and also what makes its
failure modes irreducible; there are no customer automations to carry through a
compatibility window. Deleting the automation memory rows rather than importing
them, which would have lost accepted behavior during an authority move.

**Consequences:** D1 and WorkspaceDO cannot reconstruct AutomationAgent state,
and a projection can locate an automation but never authorize a read of one — a
stale directory row is a wrong sidebar, never an access decision. A fresh
WorkspaceDO still creates the retired tables, because they live in the frozen
migration 1 and a released migration is never edited; it drops them in the same
statement that writes its identity row, so `sqlite_master` is the only honest
answer to "does this object still have them". `automation_directory.author_user_id`
became security-relevant on the way: the
[access-revocation](access-revocation.md) walk reads it to find the rooms a
person holds.

### 2026-08-28 — Resource publication gains an explicit cleanup fence

**What changed:** WorkspaceDO schema version 21 adds
`resource_object_deletion_outbox.cleanup_eligible`. Uploads and every other
resource writer create staged rows, known failures promote them, and cleanup
acts only on promoted or actively referenced rows. Additional triggers promote
staging when a resource or version is superseded or deleted before maintenance
clears it.

**Why:** Cleanup could run after R2 accepted generated bytes but before the
resource pointer committed, delete the object, and leave current and historical
metadata pointing at 404 content. The same fence also needed a terminal
transition when deletion overtook maintenance, or `INSERT OR IGNORE` would
preserve an unreachable staged row forever.

**Considered and rejected:** A time-based grace period, because no safe request
duration can be derived, and treating any failed WorkspaceDO response as a
failed commit, because the transaction may have committed before its response
was lost.

**Consequences:** Ambiguous, inactive staging requires explicit reconciliation
and does not arm an alarm whose pass cannot act on it. Future resource writers
must stage before R2, release only a known failure, leave ambiguous pointer
writes staged, and preserve both the promotion transition and its atomic handoff
through supersession, deletion, and staging retirement.

Shipped in [#395](https://github.com/juno-ai-labs/avalon/pull/395).

### 2026-08-28 — Resource versions carry provenance, and resources carry an alias

**What changed:** WorkspaceDO schema version 18 adds an author kind, its
matching identity, a cause, and a storage kind to `resource_versions`, staged on
`resources` as `revision_author_*`/`revision_cause` and copied by the capture
triggers, with a fence refusing an identity its kind cannot have. Version 19
adds `resources.slug` under a partial unique index.

**Why:** A version row said which pointers a state held and nothing about who
moved them, so the history the rail lists could not be attributed. The alias is
for the surfaces a model reads and writes identifiers on, where a UUID costs
about thirteen tokens per mention.

**Considered and rejected:** Passing provenance into capture instead of staging
it — capture is a trigger, so anything not on the row needs a second statement
a crash can separate from the swap. A `CHECK` on `storage_kind` — SQLite cannot
alter one on a STRICT table, and the column exists precisely to admit a shape
nobody has built yet. Backfilling provenance for existing rows with `system` —
inventing an author the migration cannot know.

**Consequences:** Every swap site sets provenance in the statement that swaps,
and a mismatch aborts the swap. Nothing in SQL can mint an alias, so existing
rows start without one and a bounded maintenance pass fills them in; `slug IS
NULL` is the durable record that one is owed.

### 2026-08-28 — The cutover's data model: loops, receipts, one canonical transcript

**What changed:** SubstreamAgent schema v33 (one forward-only cutover from
shipped v32) adds the persistent-loop tables — `substream_loops`,
`pending_loop_input_mailbox`, `pending_loop_inputs`, `delivered_loop_inputs`,
`assistant_turn_reservations`, `bind_loop_heads`, `bind_activation_inputs` —
keys every message relation to canonical `participant_transcript_turns`, and
retires the compatibility message/dispatch/steering structures. The facets
below are the decisions this change is made of.

**Why:** Two representations of one datum — a compatibility record beside its
canonical turn, a run-owned order beside the transcript's — are exactly the
split authority the single-owner fact rule above exists to forbid.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).


#### Ambiguous effects remain a first-class activity outcome

**What changed:** The cutover rebuilds the execution-only
`transcript_activities` projection with `ambiguous` as a terminal state and
adds recovered timing provenance directly to its interval table. Canonical
participant turns, facts, and payloads are not rebuilt.

**Why:** Recovery already distinguishes an external write whose result cannot
be proved from an ordinary failure. Rejecting that state at the activity-table
CHECK either crashed recovery or forced the UI to lie that the write failed.

**Considered and rejected:** Editing the frozen v27 migration or mapping
ambiguous effects to `failed`. The former changes shipped migration history;
the latter erases the reason Rally must not retry the operation.

**Consequences:** The forward-only cutover discards old execution timing rows,
which are derived and have no production users, while preserving all canonical
message history. Tool blocks and their activity tree now agree on ambiguity.

#### Canonical delivery retires the prepared pending envelope

**What changed:** `pending_loop_inputs` now contains only inputs that are still
pending. The atomic delivery transaction writes the canonical participant turn
and facts, inserts one small `delivered_loop_inputs` replay receipt, and deletes
the prepared payload, authorization witness, attachment and mention descriptors,
mailbox, and draft-reservation recovery rows. `runs.loop_input_id` references the
delivery receipt rather than the temporary pending envelope.

**Why:** Once a participant turn is canonical, retaining the entire prepared
input made two durable copies appear authoritative and kept private preparation
data alive for the life of the work stream. Recovery needs only the input-to-turn
identity, delivery order, attention ordinal, and timestamp; canonical history
owns everything the participant or model can observe.

**Considered and rejected:** Keeping a delivered state on the pending row or
copying its client identity and payload into the receipt. Both preserve the
duplicate authority this change removes. Client replay already resolves through
the canonical turn, and activation response-loss recovery joins the minimal
receipt to that turn.

**Consequences:** Pending UI queries are simple existence queries. A queued
pending-upsert realtime reference that drains after promotion is hydrated as an
idempotent delivered removal from the receipt. Delivery also retires its mailbox
and attachment-recovery obligation in the transaction that enqueues the
canonical regional effect.

#### Draft deletion is fenced across pending message admission

**What changed:** WorkspaceDO schema v18 adds pending attachment reservations;
The cutover adds the replayable recovery obligation written before
the reservation RPC. Canonical directory projection attaches and releases in one
WorkspaceDO transaction.

**Why:** WorkspaceDO owns resources while SubstreamAgent owns pending inputs, so
validation alone could not stop deletion during the async preparation interval.

**Considered and rejected:** A WorkstreamDO copy of resource state and a
best-effort release call. The former creates two resource authorities; the latter
leaks holds or releases live ones when an RPC response is lost.

**Consequences:** Every draft deleter and TTL eligibility query excludes active
reservations. Recovery may replay reserve and release, while resource history
continues to live only in WorkspaceDO.

#### Bind has one current metadata authority

**What changed:** The cutover replaces the historical
`bind_loop_heads` plus `bind_loop_states` pair with one `bind_loop_heads` row
containing generation, state revision, transition kind, system-projection
identity, projector version, and assistant reservation cursor. Ordered current
message facts now reference that head directly; provider boundaries remain
immutable historical hashes and activation inputs remain immutable replay
receipts.

**Why:** Both former tables described the same current state and therefore
could disagree. The second row existed only because the earlier schema stored a
full snapshot for every transition; the cutover intentionally removes those snapshots
and old run-shaped heads, so carrying the duplicate forward had no remaining
ownership purpose.

**Considered and rejected:** Migrating one of the old per-run heads or retaining
`bind_loop_states` as a compatibility view. There is no authoritative choice
among old run-shaped projections and there are no compatibility users; the
stable loop bootstraps once from canonical participant history instead.

**Consequences:** Current Bind metadata fields are added to the head or not at
all. Message rows may be delta-updated, compaction may replace them, and
provider/activation history remains independently inspectable without becoming
a second current-state authority.

#### Execution ownership closes with its terminal receipt

**What changed:** Safe-step settlement leaves `substream_loops.status` as
`executing` while it advances the step and Bind revisions. The terminal receipt
transaction is the boundary that clears the active execution and returns the
singleton to `idle`. `pending_loop_inputs` contains only immutable
not-yet-canonical inputs; corrections are new rows. A delivered input leaves
only its canonical turn and minimal replay receipt.

**Why:** An idle singleton beside a running subordinate receipt admitted another
activation before recovery had closed the first one. Mutable pending rows would
introduce the same kind of split between admission order and the prepared value
Bind eventually receives.

**Considered and rejected:** Keeping an intermediate idle/running combination
and repairing it by scanning `runs`, or adding pending edit/cancel revisions.
Both add a second state machine to facts already owned by the singleton.

**Consequences:** A safe step is not a lifecycle terminal. Queue delivery becomes
eligible only after receipt terminalization, and every pending replay compares
the exact immutable row admitted under its original FIFO sequence.


#### Stable substream loops replace per-run compatibility state

**What changed:** The cutover makes one `substream_loops` singleton the lifecycle
and execution-fence authority, keeps prepared inputs non-canonical until atomic
delivery, reserves every assistant transcript slot, and treats `runs` as
subordinate receipts that may span multiple model turns. Recovery advances the
current epoch on the singleton and receipt together. The migration drops the
SubstreamAgent-local steering/dispatch tables and deletes obsolete per-run Bind
heads; canonical transcript history survives and bootstraps the stable head.
Bind keeps one current metadata row and ordered message set per loop. Delta
transitions mutate only changed rows, compaction replaces the set, and
`bind_activation_inputs` retains one immutable fact-backed receipt per logical
activation without copying payload or provenance authority.

**Why:** Reconstructing a conversation loop from message-owned runs left two
ordering authorities and crash windows between delivery, Bind state, and
execution recovery. Choosing one old run-shaped head during cutover would turn
ambiguous derived context into new authority.

**Considered and rejected:** Preserving the old tables as compatibility,
assigning transcript or attention order at admission, and migrating whichever
legacy Bind head happened to be newest. Each either retains split authority or
guesses at order the canonical transcript already determines.

**Consequences:** Pending inputs survive eviction without becoming visible or
unread early. Safe-step settlement closes only the singleton; host outcome and
harness terminalization close the receipt. BlockDashboardAgent retains its
separate dispatch ledger because it is a different object authority.

#### Canonical turns become the final relational boundary

**What changed:** SubstreamAgent schema v33 adds canonical conversation metadata,
rebuilds every message-related foreign key against
`participant_transcript_turns(turn_id)`, renames attachment
and mention relations around that turn identity, and deletes the temporary
`workstream_message_records` key shim and detail view.
The metadata additions and relation rebuild are one enforcement-on migration.
Each referenced relation is copied to its canonical parent and old dependent
tables are removed child-first; the cutover never depends on a connection-level
foreign-key toggle.
Human turns also carry immutable display-name and avatar snapshots beside the
stable author user ID; mutable membership remains authorization state, not
historical rendering authority. The one-time v32 upgrade freezes the neutral
`A workspace member` display snapshot for a pre-snapshot human row because a
work stream object cannot query a regional profile inside its synchronous migration;
new writes always resolve and persist the actual profile before entering the
object transaction, and no reader re-resolves old rows from membership.

**Why:** The v32 payload cutover removed duplicate content ownership but left a
compatibility identity table between canonical turns and seven dependent
relations. That table still made a retired message identity look authoritative.

**Considered and rejected:** Keeping an ID-only shim for rolling compatibility.
There are no users to protect, and preserving it would make the supposedly
forward-only model structurally incomplete.

**Consequences:** Canonical turn identity, payload provenance, order, mentions,
attachments, and downstream references now meet at one foreign-key boundary.
Old schemas and clients must migrate forward; runtime transcript composition has
no fallback table. The cutover also names the run's durable terminal reference
`final_turn_id` and active output grouping `stream_id`, so neither operational
identity can be confused with a second persisted message. During a rebuild,
replacement tables reference one another by their temporary names until the
rename; they must never acquire a foreign key to an old table the same migration
is about to drop. Migration tests commit the populated old-schema fixture before
starting the upgrade, matching a real object waking on a newer deployment. The
fixture seeds every dependent relation whose omission could hide a cascade or
failed parent removal.

### 2026-08-27 — Participant removal cannot empty a work stream

**What changed:** The authoritative work-stream transition lets any current
reader remove themself or another participant, but rejects removal of the final
active participant. The membership check, active count, and removal are one
object-local SQLite transaction.

**Why:** The participant picker previously hid people who were already in the
room, so the existing removal endpoint was unreachable from the product. Making
that action visible also exposed that the endpoint could remove the only reader,
leaving a private work stream with no person able to open or repair it.

**Considered and rejected:** Restricting removal of another participant to
workspace owners and admins. Participation is the room's collaborative audience,
not workspace administration, and every current reader can already add somebody
to it. At workspace scope that means every active workspace member; at personal
scope it means the current participants, including an invitee removing the
creator. Also rejected a client-only final-participant guard, because an older
or racing client could still empty the authoritative room.

**Consequences:** Every removal caller must handle
`workstream_participant_required`. The desktop disables the known-final action
for immediacy, while the object remains the concurrency-safe enforcement point.
The one-participant floor applies to both scopes as a stable participant
lifecycle invariant: a workspace-visible stream stays readable without
participants, but does not acquire a separate zero-participant state.
Removing a person from a personal work stream revokes their access, including
when that person created it. Active-project work streams keep their project
audience fence at the regional service boundary, and the object closes revoked
local sockets before fallible realtime publication.

### 2026-08-27 — Canonical transcript records become the sole payload owner

**What changed:** SubstreamAgent schema v32 verifies the v30 transfer receipt
and every source row, atomically swaps foreign keys onto
`workstream_message_records`, removes the old message/relation/checkpoint tables,
and deletes the one-time operator RPCs and scripts.

**Why:** The transition deliberately duplicated writes only long enough to move
historical ownership. Leaving both paths would preserve ambiguity and allow the
copies to drift.

**Consequences:** Runtime code reads canonical records/facts only. Migration
fails before deletion if any message, relation, payload, or legacy checkpoint is
unowned. Participant compaction statuses and activity edges are not part of the
swap and remain byte-for-byte durable.

### 2026-08-27 — Legacy message payloads gain a canonical owner

**What changed:** SubstreamAgent schema v30 adds `workstream_message_records`,
canonical attachment/mention relations, and a one-row ownership-transfer
receipt. Message records contain ordering, provenance, visibility, and lifecycle
metadata while their text and structured content live once in the referenced
content-addressed transcript fact. New writes populate both the transitional
legacy row and this canonical shape until the stacked retirement release.

**Why:** The v28 projection correctly avoided copying legacy payloads, but that
left `parts`, `part_attachments`, `part_mentions`, and
`compaction_checkpoints` as indispensable owners. Removing them without a
separate content-sized operation would corrupt retained work streams.

**Considered and rejected:** Treating participant and Bind projections as new
payload stores, and performing a fleet-sized copy in constructor migration SQL.
Both violate the one-owner model; the latter also makes ordinary object startup
scale with retained transcript size.

**Consequences:** Every legacy scalar/payload/relation is reconciled inside the
object transaction before its receipt commits. The next stacked release may
drop legacy owners only after the fleet receipt is complete and must switch all
foreign keys/readers to canonical records first.

### 2026-08-27 — Resource relationships derive direction and semantic writes retain versions

**What changed:** SubstreamAgent constrains resource relationships to seven
stored values and contracts derive `source` or `artifact` per work-stream link.
WorkspaceDO now owns `resources.current_version` and stable-numbered
`resource_versions` snapshots with original and model R2 refs.

**Why:** Source versus artifact describes how a shared resource participates in
one work stream, while edits and external refreshes must not erase the resource
state a previous run used.

**Considered and rejected:** Storing direction on `resources` would make a
generated artifact stay an artifact after another work stream imports it.
Overwriting one canonical R2 pointer would expose only the latest bytes.

**Consequences:** Semantic resource writes and successful hydration observations
increment version; processing-only derivative state enriches the current version.
R2 cleanup must treat every retained version as live until the resource is deleted.

### 2026-08-27 — WorkspaceDO gains project authority

**What changed:** WorkspaceDO schema version 14 adds projects, participants,
per-person project order, and a project-directory waterline with closed
presentation checks and independent revisions.

**Why:** Project visibility and ordering are workspace product state that must
commit beside the cross-work-stream directory rather than becoming D1 product
tables or device-local preferences.

**Considered and rejected:** D1 authority and client-only order. Both split the
single answer needed by authorization, realtime recovery, and multiple devices.

**Consequences:** Later project memberships and propagation operations must
reference this authority through typed RPCs and append new migration versions.

Design: `docs/PRDs/2026-08-26_projects/prd.md`.

### 2026-08-26 — Legacy transcript projections preserve single payload ownership

**What changed:** pre-v27 participant and compaction rows can be projected into
the canonical sequence/checkpoint indexes while their existing object-local
rows remain the sole payload owners. A v28 receipt makes the source set,
recovery bookmark, and unavailable Bind-history boundary inspectable.

**Why:** retained participant order and checkpoint arrays are useful canonical
facts, but copying them would violate the transcript's one-owner invariant and
aggregate participant rows cannot recreate exact provider order.

**Considered and rejected:** duplicate payload rows in the new substrate and a
synthetic pre-v27 Bind generation. The first creates competing truth; the second
claims fidelity the source cannot prove.

**Consequences:** legacy owner rows referenced by a completed receipt are
immutable history. Readers may join them only through explicit canonical
reference facts, and future cleanup must first move ownership atomically rather
than deleting or silently copying those rows.

### 2026-08-26 — Transcript facts own bytes while two projections own order

**What changed:** The SubstreamAgent schema gained canonical payload/fact rows,
participant turn/block ordering, exact Bind-loop states and boundary hashes,
nested activity intervals, and compaction replacement records. Each admitted
feed socket keeps its current range fence in its hibernation attachment, and
range replies carry only the lifecycle rows referenced by their turns plus
required ancestry. Facts classify canonical, protocol-only, derived, and system
projection origins; every derivative carries its typed durable source identity,
and source provenance is indexed without copying the source payload.

**Why:** Participant rendering and provider continuation have different
visibility and ordering domains, but duplicating their common text would create
two sources of truth. Flat parts also had no representation for known gaps or
lossless post-compaction Bind state.

**Considered and rejected:** One sequence containing private protocol rows, and
two independently copied transcripts. The former leaks or forces sparse public
bounds; the latter permits identical semantic bytes to diverge. Persisting every
reader snapshot forever was also rejected, as was expiring it after an invented
TTL: socket-owned fences are naturally bounded by the reader session.

**What a future change has to respect:** One semantic datum has one owner.
Projection rows may add only ordering, visibility, and lifecycle metadata unless
their payload is genuinely different. A genuinely different model-facing
wrapper must point back to its source fact or record. Both sequence domains are
monotonic and provider-boundary hash equality is fail-closed.

### 2026-08-26 — Connector processing ownership becomes Queue-native

**What changed:** The canonical connector event keeps processing owner, attempt,
status, error, and terminal timestamps in WorkspaceDO while the existing
regional `ACTIVITY_QUEUE` owns redelivery. The consumer sends an ID-only process
pointer after ingress and uses typed claim/settle RPCs. The physical
`workflow_instance_id` column temporarily stores the current acquisition's lease
token so pre-cutover Workflow instances and Queue deliveries fence the same row.
For Queue claims the stable processing owner is correlation identity, not the
lease; WorkspaceDO creates a fresh lease on every acquisition. During the drain
window, WorkspaceDO also translates the frozen pre-cutover
`workflowInstanceId` RPC payloads and projects the old strict claim response;
versioned Workflow code cannot migrate its wire contract after creation. The
stored `processing_orchestrator` makes lease semantics explicit: Queue claims
expire, while Workflow claims remain exclusive until settlement because their
processing step can retry several independently timed attempts. `NULL` on an
active row is the migration-safe spelling of a pre-cutover Workflow claim;
Queue claims did not exist before the discriminator was added.

**Why:** A one-callback Workflow duplicated Queue retry and WorkspaceDO terminal
state, and required an external instance-ID contract unrelated to product
identity.

**Considered and rejected:** Splitting the regional activity Queue was rejected
without capacity or isolation evidence. Renaming the SQLite column during the
behavioral cutover was rejected because it would prevent an already-running
Workflow from completing against the new object code.

**What a future change has to respect:** WorkspaceDO remains canonical, Queue
messages remain bounded and region-local, and callers use typed domain outcomes
rather than SQLite write metadata. Settlement must remain fenced by the returned
lease, and native Queue delivery count must not be overloaded as a product
generation. A pointer behind the authoritative product generation is terminally
stale and must be acknowledged, not retried toward the DLQ. Remove the legacy
wire adapter, its `NULL` discriminator compatibility, and rename the physical
compatibility column only after the Workflow binding is safely retired.

### 2026-08-25 — Automation runs copy the subscription audience

**What changed:** All three automation run producers now provision the generated
work stream with the subscription's scope. Personal automations remain
participant-readable; workspace automations create workspace-readable work
streams. Automation detail also reads run history through its already-authorized
subscription instead of authorizing the same subscription twice. Its one
batched WorkspaceDO directory/viewer read preserves the narrower audience of
pre-change personal run objects without per-run child RPCs.

**Why:** `automation_subscriptions.scope` is the product's declared user/workspace
boundary. Discarding it at execution made workspace automations shareable while
their output remained private. The second subscription load added no authority
because detail had just completed the identical predicate.

**Considered and rejected:** Keeping all outputs personal and teaching every
consumer a special automation-derived permission. That would make the work
stream's durable `scope` disagree with its actual readers and duplicate the
visibility model across detail, directory, sockets, and resources.

**What a future change has to respect:** Each run stores its audience on its own
work stream at creation. Public run-history routes must authorize the
subscription; internal reads reached from an already-authorized detail request
must not repeat that query. Historical personal run objects remain filtered by
the WorkspaceDO viewer projection until a durable scope migration replaces that
compatibility boundary.

### 2026-08-25 — Email route identity includes the domain

**What changed:** Migration 0097 replaces `workstream_email_routes.local_part`
with a case-insensitive full `email_address` primary key and migration provenance.
An inferred cutover row may be owner-verified once; every allocator- or
owner-sourced full-address tombstone is immutable.

**Why:** The local-part key reconstructed historical addresses with the Worker's
current domain, which made an old automation disagree with its WorkspaceDO row.
It also made future custom domains unable to reuse a local part safely.

**Considered and rejected:** Keeping local part as the key and tolerating a
legacy-domain mismatch. That changes comparison semantics without making the
pre-workspace inbound route unambiguous.

**Consequences:** Global D1 can route the same local part to different owners on
different domains. Regional owner state verifies the one-time cutover inference;
after that, the full address is a permanent claim.

See [`workstream-email-addresses.md`](workstream-email-addresses.md).

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

### 2026-08-24 — The account timezone is a preference, and a schedule reads it when it is derived

**What changed:** `users` gained `timezone_source` (migration 0096, `client` or
`user`). Choosing a zone in settings records `user`; the desktop sign-in
exchange, which wrote the machine's zone on every sign-in, now writes only where
the source is still `client` and writes nothing at all when the client sends no
zone. A calendar trigger's `timezone` became nullable, and the personal/workspace
fallback moved out of the compiler's normalizer into `AutomationService`, where
it is read at the moment a `schedules` row is derived.

**Why:** somebody set America/New_York and had a briefing created on Pacific
time. Two mechanisms could do that and both were live. The compiler was told to
schedule "in the user's timezone" while never being told what it was, so it
supplied a popular one; and every sign-in stamped the signing-in machine's zone
over whatever the account had chosen, so even a correct choice did not survive
the next login from a laptop somewhere else. A default that only a client can
supply is not a preference, and a fallback resolved when a draft was *compiled*
answers for the scope the compiler guessed rather than the scope the automation
was created with — and freezes into a shared template the zone of whoever wrote
it rather than of whoever adopts it.

**Considered and rejected:** letting the compiler write the resolved zone into
the field, either from the model or from the normalizer. It reads simpler and
keeps the summary and the field in step by construction, but it leaves the one
value the scheduler reads as something a model produced, and — the reason it was
reverted during review — a filled default is byte-identical to a zone somebody
named, which is the distinction every later reader depends on. Null means
"nobody named one", the server answers it, and the model's only remaining job is
prose. Also rejected: overwriting a template's
explicit zone on adoption. A zone the author named may be the point of the
automation — an American market open is not a British one — so an explicit zone
survives adoption and only an unnamed one follows the adopter.

**Consequences:** an account that has never opened settings still follows its
machine, which is what a new account wants. One that has chosen no longer moves,
including when its owner signs in while travelling; changing zones is a settings
change from now on. A calendar trigger with no named zone is stored as `null`,
which is what lets every later reader resolve it; filling the default in before
the draft is returned was tried first and made the resolution above unreachable,
since a filled default is indistinguishable from a zone somebody named. Reads
answer it instead: the automation detail resolves each calendar zone from the
`schedules` row before returning it, so only the draft response carries a null to
a client, and only the builder on a build older than this release is affected.

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
did still cost was runtime — it was most of `pnpm --filter @rally/db test`,
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

**Why:** Work started in Rally was published to the whole workspace on
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

**Why:** Daytona persistence cannot be Rally's authorization or retry ledger.
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
