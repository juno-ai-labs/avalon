# Data model

Rally's regional data is split by declared authority. D1 is the thin regional
control plane: it owns workspace/member/user identity, object and connector
ingress routing, migration coordination, global-provider handoff receipts, and
operational audit/telemetry. `WorkspaceDO` owns every workspace-scoped product
that is not intrinsically one conversation: connector credentials and local
handoff state, Terminal egress policy history, shared schedules,
resources/notes/watches and R2 lifecycle references, shared memory,
external-delivery intents/attempts, inbound-email processing receipts,
dictation socket admission, and every Canvas's and Sidekick's
conversation-parent state, keyed by parent id
([`hosted-conversation-parents.md`](hosted-conversation-parents.md)).

Each Sidekick is a conversation parent hosted in `WorkspaceDO` beside the
Canvases: its `automation_directory` row is its definition
row, and its revisions, schedules, runs and receipts are the `sidekick_*`
tables keyed by `sidekick_id` (WorkspaceDO migration 91; migration 92 drops
the import ledger after `SidekickDO` was deleted). See
[`automation-lifecycle.md`](automation-lifecycle.md). D1 keeps no rebuildable
workspace product serving projection. Serving contract 1 makes each `AgentLoopDO` SQLite database the product authority for
one independently ordered substream after the guarded regional generation opens;
its non-agent parent (a hosted Canvas or Sidekick in `WorkspaceDO`) owns the
aggregate metadata. The stored `workstream.parent_kind` admits `automation`
and `canvas` for a live conversation (conversation migration 83); its
`workstream` and `space` values are retired Threads' and Spaces'. Legacy D1
workspace-product activity/opportunity rows are maintenance import input and
are scrubbed before each verified WorkspaceDO route becomes active. Migration
0090 removes those sources, the per-conversation source tables, and their
writer fences after the authority is open. Neither family is a
serving fallback or part of the current D1 schema. The checked-in migrations are the authoritative D1 schema and the
object schema registry is the authoritative DO schema. This document maps both
rather than duplicating their DDL. Application
contracts expose camel-cased TypeScript values; storage uses explicit
snake-cased columns, and JSON only where provider- or model-shaped data is not
relationally queried.

WorkspaceDO migrations 128–131 add Sidekick grants, prepared mutations, immutable
receipts, run coordinators, source-reconciliation wakes and legacy enrollment
backfill. [Sidekick lifecycle](automation-lifecycle.md#delegation-consent-authority)
owns the policy. The claim-access table from 129 and D1 migration 0124's
`sidekick_delegation_locations` are unused; the applied migrations are retained
without using either table for access or cross-Organization discovery.

**Storage words and product words differ.** The product has two sections,
Canvases and Sidekicks ([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)).
A conversation parent id is still a `WorkstreamId` and lands in
`workstream_id` columns, D1 `workstreams` and `workstream_authority_routes`; a
stored **automation** is a Sidekick; a **substream** is a conversation under
its parent (`"0"`, or a Sidekick's run). The retired storage words keep their
retired meaning: `spaces` held Channels, and `channels` held Threads. Tables,
columns, RPCs and telemetry keep the storage words; only user-facing copy uses
the product ones. WorkspaceDO migration 97 adds `workspace_pins` (one pin list
per person per kind, now `canvas` and `sidekick`; [`pinning.md`](pinning.md)).

Read it before adding a table, a column, or a migration, and before assuming that
knowing an object's ID is enough to read it — it never is.

Passwordless challenge storage is defined by migration 0111 and documented in
[email sign-in](email-login.md). Challenge redemption records an identity-only
session receipt; workspace relationships and grants remain separate authorities.

## Message issue reports

[Message issues](message-issues.md) owns the separate `MESSAGE_ISSUES_DB` schema
for Oopsie reports and their message, conversation and reporter references.

## Signup lineage

Regional migration 0121 adds an opaque telemetry flow to OAuth state, desktop
login tickets, and email challenges. Tickets and challenges preserve whether the
proof created a new identity. Email challenges also preserve their entry surface.
New user insertion records `signup_flow_id` (unless another account already
holds that flow) and `signup_client_platform`;
`signup_path` and `signup_completed_at` record first organization readiness and
one completion. These are analytics bookkeeping, never authorization or a gate
on authentication. Existing identities and old proofs remain without lineage.
See [complete signup measurement](telemetry.md#complete-signup-measurement).

## Impersonation relationships

WorkspaceDO migration 67 adds `workspace_impersonation_relationships`, keyed by
workspace, impersonating user, and represented user. The row carries its
authority basis plus creation and revocation timestamps; it carries no action,
destination, purpose, or read/write sub-permission. Exact direction is the
authority and self-impersonation is an ordinary self-pair. Message rows remain
unchanged; dual-principal correlation belongs to `audit_events`. See
[impersonation](impersonation.md).

D1 migration 0123 adds `organization_name_suggestions`, one row per email
domain holding what reading its homepage found (`outcome`: `named`, `unnamed`,
`missing`, `not_html`, `too_large` or `refused`), the organization name exactly
when `named`, and when it was read. Only Global writes it; a row older
than 30 days is read again. [New-user onboarding](new-user-onboarding.md) owns it.

D1 migration 0122 adds Rally access. `support_access_grants` holds at most one
row per Organization: who granted it, when, and when it runs out; revoking
deletes the row. `sessions.impersonator_user_id` marks a support session, an
ordinary session of the represented person that names the Rally staff member
acting, and `sessions.impersonator_incarnation` the staff membership that
admitted them. NULL means a login session, which every row written before 0122 is.
See [impersonation](impersonation.md#support-access).

## Agent communication relationships

WorkspaceDO migration 59 adds `agent_teams`, `agent_team_members`,
`agent_delegations`, and `agent_message_routes`. These hold implicit communication
scope, additive membership, separate execution ownership, and immutable reply
addresses. They contain no message bodies or task state. The typed host RPCs and
their invariants are described in [Agent communication](agent-communication.md).

## Sidekick loading and attachment storage

SidekickDO migration 3 adds automation.loadable, atomically maintained with the accepted revision. WorkspaceDO migration 35 projects this value, using null for unresolved legacy eligibility. Conversation migration 43 adds `sidekick_execution_skills` for retry-stable instruction snapshots; the `sidekick_attachments` table it added beside it, which only a Thread's conversation wrote, is dropped by conversation migration 86. `parent_sidekicks` in `WorkspaceDO` (a Channel's default Sidekicks) stays for the Thread retirement and nothing writes it. Existing namespace lookup keys remain unchanged.

WorkspaceDO migration 86 adds `sidekick_conversation_attachments` (`automation_id`, `parent_kind`, `parent_id`, `substream_id`, `attached_by_user_id`, `attached_at`), the conversations a Sidekick may read and post to beyond its own; migration 140 widens `parent_kind` to admit `canvas`, the only kind now attached. It is typed-RPC only, and it is not `parent_sidekicks`, which recorded skill loading. The same migration's `automation_directory.owning_substream_id` is a dead column. [`conversation-tools.md`](conversation-tools.md) and [`automation-lifecycle.md`](automation-lifecycle.md) own them.

WorkspaceDO migration 85 adds `external_conversation_bindings`, keyed by provider installation (`slack:<team>`, deliberately not a `connector_connections` row, so a binding survives a reconnect) and a JSON path of provider identifiers: a thread binds to a Sidekick run child. Room bindings are no longer written or read. It is typed-RPC only. [`external-conversation-bindings.md`](external-conversation-bindings.md) owns it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/NNNN_*.sql` | The authoritative regional D1 schema. Monotonically numbered, immutable once deployed. |
| `packages/db/src/index.ts` | Region-aware repositories and the D1 wrapper every service is handed. |
| `packages/db/test/baseline-migration.test.ts` | Replays every migration in order and proves the checked-in baseline leaves the same schema. |
| `packages/db/seed.sql` | The local development seed. |
| `apps/api/src/mappers/connection.ts` | D1 row schemas parsed at the read — the pattern the remaining hand-coercing control-plane readers are converging on. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | The separate versioned authority schema local to one `AgentLoopDO`. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Canonical transcript fact ownership, participant and exact Bind projections, range snapshots, activities, and compaction checkpoints. |
| `apps/api/src/durable-objects/workspace-do.ts`, `workspace-product-schema.ts`, `workspace-domain-schema.ts`, `workspace-runtime-sql.ts`, `hosted-parent-schema.ts`, `canvas-schema.ts`, `hosted-sidekick-schema.ts`, `retired-workspace-schema.ts` | SQL schemas and repositories for authoritative workspace product state, typed compatibility SQL, sync routing, bounded invalidation replay, and the Canvas and Sidekick parents' state and child aggregation. `hosted-parent-schema.ts` and `workspace-product-schema.ts` hold shipped migrations whose tables are retired; `retired-workspace-schema.ts` holds the shipped statements of deleted modules byte for byte, and migration 147's drops. |
| `apps/api/src/services/workspace-runtime-database.ts` | D1-compatible routing port that sends an allowlisted workspace-product statement to typed WorkspaceDO RPC while leaving global/regional control SQL in D1; mixed-authority batches fail closed, and so does any single statement — read or write — naming both a WorkspaceDO table and a regional-only one. |
| `apps/api/src/durable-objects/workspace-directory-protocol.ts` | Typed, runtime-validated query and effect contracts joining conversation-parent facts to WorkspaceDO serving state. |
| `packages/contracts` | The camel-cased shapes the columns are mapped into. |

### Early-access acquisition

- `access_requests`: Global normalized email uniqueness, original request time,
  frozen acknowledgement sender/subject/body, first-attempt time, generation and provider-acceptance/suppression state.
- `download_grants`: SHA-256 token digest, manual/invitation source attribution,
  operator, first admission, revocation and optional exact UTC expiry. Null expiry
  means single-use without time expiry; a deadline allows repeated admission. Minute bucket/count fields coordinate download starts.
- `access_request_rate_buckets`: hashed edge IP and current hourly count, written
  only for a finite configured intake cap. Old buckets are removed on the next
  guarded request; raw IPs are never stored.

`access_email_budget` holds one hourly aggregate attempt counter in Global; it is distinct from IP counters. Stable `(created_at, id)` indexes support request/grant paging.

All arrive in `0101_private_access.sql`. These pre-workspace records have no
workspace association; existing workspace deletion does not erase them. Both
regions share schema, while this slice writes only Global. [Private access](private-access.md)
owns their lookup, erasure, admission and delivery semantics.

### Scoped share lookup

`scope_share_recipients` says which Canvas to ask about a share addressed to an
email: `(email COLLATE NOCASE, workspace_id, parent_id)`, written once the
Organization object records the share and deleted by it once nothing for that
address is pending there. Signing in reads it by the user's verified addresses.
A row is a hint, never authority: the object decides. Shares pending before the
table existed are indexed once by WorkspaceDO migration 93.
[`scope-invitations.md`](scope-invitations.md) owns it.

`link_payloads` (0114) is no longer read or written: its only kind was the
invitation token that claiming retired. Drop it in a migration after this
Worker has shipped; the previous Worker still reads it until then.

### Search projection state

WorkspaceDO migration 33 owns `resource_search_versions`: a retained resource revision, pending flag, and dispatch time. Resource insert/delete and search-relevant update triggers advance it in the same transaction as the canonical write. AgentLoopDO migration 42 adds `conversation_search_links` and transcript-triggered `search_projection_v1` entries in `durable_outbox`. Both migrations enqueue existing records; these are projections, never new content authority. See [text search](text-search.md).

WorkspaceDO migration 39 adds partial indexes for draft upload cleanup
(`resources_expired_drafts_idx`), missing slugs (`resources_missing_slug_idx`),
and pending search revisions (`resource_search_pending_due_idx`). They bound
these reads to pending work rather than the entire retained resource inventory;
completed search watermarks remain durable. No table or authority is replaced.

WorkspaceDO migration 43 replaces the resource search update trigger with a
comparison of search content/category inputs. Non-search metadata and bookkeeping
updates preserve the revision and pending/retry state; insert/delete triggers
remain unchanged. `resource-update-cost.test.ts` verifies a populated v42 upgrade.

WorkspaceDO migration 52 sets `metadata_json.listing` to `unlisted` on the
Terminal recovery backups already stored, scoped by their
`terminal-workspace-backup:` provider identity. The key is read by every
statement that enumerates resources and by none that resolves one by id, so it
changes presentation without touching the authority or the access decision. The
same migration enqueues those rows in `resource_search_versions` rather than
relying on the update trigger: migration 43 narrowed that trigger to the columns
search reads plus `metadata_json`'s `description`, so a `listing` write fires
nothing, and a row indexed before the upgrade would never be re-projected. **Any
write that changes `listing` on an indexed resource carries its own enqueue.**

`resources_create_semantic_version` is the opposite case and fires, because it
watches `metadata_json` wholesale. Each marked backup therefore gains a
`resource_versions` row identical to its predecessor but for the flag. The
migration accepts that and stages `revision_author_kind = 'system'` in the same
statement so the row is attributed: suppressing it means bumping
`current_version` to make the trigger's `WHEN` false, which leaves the counter
ahead of the history it indexes. `revision_cause` stays null — this is none of
`created`, `published`, `refetched` or `replaced`. See
[agent attachments](agent-attachments.md).

### Identity and tenancy

- `users` stores provider-independent identity and display information, plus the
  account's IANA `timezone` and the `timezone_source` that says who put it
  there. `client` means the account follows the device: a desktop sign-in seeds
  it, and the desktop and browser clients report the device's zone through
  `PUT /workspace/me/device-timezone` at launch and on every focus; the server
  writes only when the zone moved. `user` means somebody fixed a zone in
  Account → Default timezone, and no report moves it; turning **Set timezone
  automatically** back on sets `client` again. It is one column per region —
  `users` is regional — so it answers for every workspace the person belongs to
  in that region, and a second region's row keeps its own. `syncRegionalProfileStatement`
  deliberately syncs `email`, `name`, and `avatar_url` and not `timezone`, so a
  zone chosen in one region does not cross to another.

- `workspace_members` records member/guest access class separately from the
  owner/admin/member administrative role. A guest's role is null. Incarnation
  identifies one membership lifetime; revision orders admission changes within
  it. Promotion changes the existing row without replacing its user or sessions.
  One row per person per workspace, so a workspace may hold any number of
  administrators; [`workspace-member-roles.md`](workspace-member-roles.md) owns
  what each role means, the one write that assigns one, why a guest has none,
  and the guard against demoting a workspace's last administrator.

- WorkspaceDO's `scope_grant_directory` is a typed-RPC-only candidate projection
  keyed by parent, user and exact scope. It retains generation/version tombstones
  and filters by membership incarnation. It never replaces canonical grant
  admission; see [scope grant directory](scope-grant-directory.md).

- `user_login_identities` holds each verified sign-in method as provider and
  subject. Migration 0120 checks the provider's shape rather than listing
  `google` and `email`, so a new identity provider needs no schema change. It is
  also how a deployment links a person to their regional user; see
  [multiple workspaces](multiple-workspaces.md#authority-and-data-flow).

- `sessions`, `oauth_states`, and `desktop_login_tickets` support revocable
  sessions, PKCE, and single-use Electron deep-link completion. A session that
  simply expires is also marked `revoked_at` by the five-minute reaper, which is
  what makes announcing the expiry exactly-once; see
  [`access-revocation.md`](access-revocation.md). `oauth_states`
  is the signed pre-workspace callback route/security receipt; the user-visible
  `connector_oauth_attempts` status row lives in the selected WorkspaceDO.

- `browser_sessions` stores the hash of an opaque browser credential against an
  ordinary identity session. `browser_workspace_sessions` maps each browser and
  workspace to an ordinary incarnation-bound workspace session. There is no
  shared active-workspace field or separate browser user ledger. See
  [browser sessions](browser-sessions.md).

- `workspace_invitations` supports explicit membership growth. Acceptance adds
  one row to the already-many-to-many `workspace_members` authority; it does not
  replace another membership.

- `workspaces` is the regional identity and deterministic WorkspaceDO route.
  `workstream_authority_control` carries the region-wide generation and serving
  fence, while `workstream_authority_routes` routes work-stream objects.
  Migration 0115 removes the completed `workspace_product_authority_routes`
  cutover ledger; it is not part of the current schema and must not be restored
  as a live per-workspace authority.

Every workspace-scoped table that remains in regional D1 carries `workspace_id`,
and every D1 repository lookup includes it. Imported compatibility rows inside
WorkspaceDO may retain that column for repository shape, but singleton triggers
force it to the object's workspace. Native Durable Object tables instead store their external workspace/work
stream/substream identity once in a singleton and omits those repeated keys from
local child rows; every request is checked against that identity before local
SQL runs. Knowing either a D1 row ID or a Durable Object ID is never sufficient
authorization.

### Realtime synchronization records

Each main `AgentLoopDO` transcript has one semantic fact/payload owner and
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

`WorkspaceDO` is the relational authority for workspace product state. It
stores connector/product configuration, Terminal policy revisions, the
automation directory, schedules, resource/note/watch/memory records,
external-delivery state, inbound-email processing receipts and their
exclusive leases, dictation admission (one-time transcription ticket receipts
and the concurrency session leases the per-user/per-workspace caps count), the
Canvas directory and audiences, the hosted-conversation tables, pins,
receipts, consumed socket tickets, and a bounded monotonic
`workspace_sync_events` log. A sync row names
typed query topics, and for a per-person change the people it was sent to; it
never embeds the underlying row. Membership, invitations,
user profiles, placement routes, and migration control remain D1 authorities.

`WorkspaceDO.parent_metadata` was different: one row per retired Channel or
Space, it was the parent's identity, generation and revision; what Main said
about the parent lived on its `channels` or `spaces` row. Child title and
lifecycle lived in `parent_children`, whose nullable
`archived_at` is independent of creation readiness. Archive retains membership
and transcript while excluding the child from the visible directory. A WebSocket
snapshot includes nulls so a client can delete a former email,
archive/system marker, or schedule rather than accidentally retain it.
`AgentLoopDO` continues to own ordered parts, active output, and replay; token
frames are never database joins or metadata patches.

Each `AgentLoopDO` owns one stable `substream_loops` row (which, since v45,
carries `transcript_projected_through` — the highest transcript sequence the
model's conversation has considered, so a turn that started no run is appended
at the next admission rather than lost),
not-yet-canonical `pending_loop_inputs` whose prepared content is immutable
and whose `input_sequence` is the live promotion order (since v68,
`starts_run = 0` marks a message for the room that waits behind earlier input
so it lands in send order, but starts no run), minimal immutable
`delivered_loop_inputs` replay receipts, exact `assistant_turn_reservations`,
subordinate execution receipts in `runs`, and a
Bind head rebuilt from canonical participant history when no stable projection
exists. These are connected by typed, hash-checked RPCs rather than cross-object
SQL joins.

### Conversations

- Each `AgentLoopDO`'s object-local `workstream` row is its conversation's
  root; each provisioned child carries the bounded root facts needed to
  authorize and project its own context. `workstream_key` is the conversation
  parent id and `parent_kind` says which kind of parent owns it: `automation`
  (a Sidekick) or `canvas` (conversation migration 83). A stored `workstream`
  or `space` row is a retired Thread's or Space's and is refused on open
  except for the Thread retirement's own read. `origin_type`,
  `automation_subscription_id`, `automation_run_id`, and `planned_for` are dead
  columns, kept only because the released runtime-compat triggers name them;
  `title_status`, `description_source`, `system_kind` and the
  `description_refresh_state` table served the retired Thread naming,
  description and digest passes and are no longer written.
- Who may read a conversation is its parent's decision, never the row's:
  `canvasAdmits` over a Canvas's `canvas_directory` row and participants, or
  `sidekickAdmits` over a Sidekick's audience
  ([`authorization.md`](authorization.md)). `workstream.scope`
  (`personal`/`workspace`) is still the object's own participant check, and
  the Worker seats every reader the parent admits as a participant before it
  issues a ticket, so the parent's audience is what decides.
- `workstream.model_override` pins one conversation's runs to an OpenRouter
  model, ahead of the `agent-model-workstream` flag. `NULL` — the overwhelming
  majority — means the flag decides; see
  [`feature-flags.md`](feature-flags.md#a-conversations-own-model). The column
  carries no `CHECK` enumerating the ids: the selectable set lives in
  `AGENT_MODEL_OVERRIDES` and is re-validated on read, which lets a model be
  retired without a migration.
- The Canvas parent's own rows are `canvas_directory`, `canvas_participants`
  and `canvas_artifacts` in `WorkspaceDO` ([`canvases.md`](canvases.md#data-model));
  both kinds share `sidekick_children`, `sidekick_child_projections`,
  `sidekick_child_receipts` and `sidekick_viewer_reads`, keyed by the parent id
  in `sidekick_id` ([`hosted-conversation-parents.md`](hosted-conversation-parents.md)).
  `workspace_pins` holds each person's Canvas and Sidekick pins
  ([`pinning.md`](pinning.md)).
- Each person's Activity is `workspace_activity_items`, one row per mention,
  add and Sidekick run notice they were sent, keyed by its notification
  intent's id, and `workspace_activity_seen`, their Mark all seen, in
  `WorkspaceDO` (migration 148, [`activity.md`](activity.md#data-model)).
- The retired Thread, Channel and Breakout state — `channels`,
  `channel_viewers`, `spaces`, `space_viewers`, `breakouts`,
  `breakout_viewers` and the `parent_*` tables — stays in `WorkspaceDO` after
  migration 147 because the Thread retirement's inventory reads it; nothing
  else does ([`workspace-retirement.md`](workspace-retirement.md)). Migration
  64 dropped the Project tables, and 147 dropped the Space ledgers, the
  Thread pins, order, access and resource links, and the batch dispatches.
- **What the Thread era left.** The shipped migrations are the map of the
  Thread, Channel, Space and Project tables as they were; this list says only
  what is still in the schema. WorkspaceDO migration 64 dropped the eight
  Project tables, and migration 147 (`THREAD_ERA_TABLES_DROP_MIGRATION` in
  `retired-workspace-schema.ts`) dropped the Space ledgers (`space_intents`,
  `space_defaults` and its staging, `space_bootstrap`, `space_invitees`,
  `space_reads`, `space_channel_memberships`, `workspace_space_state`), the
  Thread pins and orders (`workspace_workstream_pins`, `workspace_pinned_order`,
  `workspace_container_order`), `workspace_workstream_access`,
  `conversation_access_requests`, the Channel colour and rail ledgers, the
  batch dispatches and the import-reservation reclaim. What remains unwritten
  are the directory tables migration 72 renamed (`channels`, `channel_viewers`,
  `breakouts`, `breakout_viewers`, `spaces`, `space_viewers`) and the `parent_*`
  tables of the retired Channel and Space host
  ([`hosted-conversation-parents.md`](hosted-conversation-parents.md)), which
  the Thread retirement's inventory reads, and
  `workspace_workstream_effect_receipts`, the Thread host's effect inbox. The
  partial unique index on `spaces.system_role` that made General singular
  stays with its table.
- `member_personal_system_prompts` (migration 88) is each member's personal
  system prompt for this Organization, copied into each conversation object's
  `personal_system_prompt_copies` (its migration 72); see
  [`personal-system-prompt.md`](personal-system-prompt.md).
- `member_preferences` (migration 89) holds each member's display preferences;
  see [`member-preferences.md`](member-preferences.md).
- `workspace_pins` (migration 97) is one person's pins of every kind, keyed
  `(user_id, item_kind, item_id)`; migration 141 admits `canvas` and
  `sidekick`, the only kinds written now, and 147 deleted every row of the
  Thread-era kinds the shipped CHECK still admits. It is the one source of pin
  state; see [`pinning.md`](pinning.md).
- `workspace_member_status` (migration 72), one row per person: their
  workspace relationship as `relationship_json` (null for someone with none or
  removed), `active`, the D1 delivery `sequence` of the last relationship event
  applied (0 when only a D1 read has been recorded), and `removed_incarnation`,
  the incarnation a removal event ended. It is a projection of D1's
  `workspace_members`, fed by `workspace_relationship_changed` events; access
  checks inside `WorkspaceDO` read it instead of D1. A D1 read or write a
  request makes replaces a row only when provably newer (a new incarnation over
  a removed one, or a higher revision of the same one), and a removed
  incarnation never comes back.

- Object-local `participants` records explicit participation reasons, and
  `first_opened_at` — null until that person opens the conversation. It is on
  the membership row rather than on `member_attention` because the attention
  row does not exist for somebody who has only been added. The conversation
  snapshot still carries it as `unseen` and opening settles it, but no surface
  draws it since the Thread list's marker was deleted. Viewer presence is intentionally absent from durable storage.
- Object-local `participant_transcript_turns` has a per-conversation
  `transcript_sequence`; the root
  `workstream.next_sequence_number` allocates ordered events. Conversation rows
  belong to a `substreams` row, with the main chat fixed at substream `0`.
- `participant_transcript_mentions` stores validated person and connector spans
  keyed to their canonical turn.
- `participant_transcript_attachments` relates a resource to one exact owning
  turn. A
  resource can appear in multiple conversations, so projections that report
  attachment state must use the current object's link; existence anywhere in the
  workspace is not the relationship for the current conversation.
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
  column that kind admits, and `cause`: `created`, `published`, `refetched`,
  `replaced` or `renamed`), and a `storage_kind` naming the shape
  of the refs — one value today, deliberately unconstrained so a later storage
  shape needs no table rebuild. Provenance reaches a version through
  `revision_author_*` and `revision_cause` on `resources`, set by the same
  statement that swaps the pointers; a trigger refuses a version whose identity
  does not match its kind, which aborts that swap rather than storing a wrong
  attribution. An agent version also names the person its run acted for
  (`on_behalf_of_user_id`, staged as `revision_on_behalf_of_user_id`), so a
  reader can tell whose change it was; NULL when nobody started the run or the
  row predates the column. Rows captured before provenance existed carry none. Inserts create version 1. Writes to identity, display,
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
  draft upload and one preparing or ready conversation input. It freezes workspace,
  conversation, author, input, and resource identity. The upload is marked
  attached, and the effect's exact input/resource reservations removed, in the
  same transaction that records the attachment (for a Thread, the
  `workspace_workstream_resource_links` projection did this; migration 147
  keeps that table because `convert_threads_to_canvases` reads it and
  `deleteRetiredThreadParent` deletes a Thread's rows);
  failed preparation uses an idempotent typed release RPC. AgentLoopDO's
  `pending_attachment_reservation_recovery` is only the cross-object recovery
  obligation, not a second resource or message authority.
  Object-local `attachment_tool_receipts` relates a versioned read, search, view, or summary
  receipt to every derivative it used. Replacing that version or deleting the
  resource invalidates the whole invocation and queues its JSON replay object;
  the table never contains attachment content or ephemeral image data. Every
  dependency registration, invalidation, replay, and cleanup mutation
  carries the workspace/conversation identity even though resource and invocation
  IDs are globally unique.
  `resource_inventory_revision` holds one monotonic revision in the object.
  Local triggers advance it when resource membership, message
  attachment relationships, resource classification/content identity, or
  private-note visibility can change the authorized inventory. Derivative claim,
  processing, and hydration timestamp updates do not advance it; it is a race
  fence, not an attachment catalog.
  Each AgentLoopDO's `workstream_resource_links` owns its attachment
  relationship and resource-inventory fence; WorkspaceDO owns resource metadata,
  workspace watches, and the inverted workspace index. `relationship_type` is
  constrained to `attachment`, `message_attachment`, `origin`, `generated`,
  `inbound_email`, or `context`. The conversation-facing
  `direction` is derived from that relationship: `generated` is an `artifact`;
  every other relationship is a `source`. Direction is not stored on the shared
  resource because the same resource may be an artifact here and a source elsewhere.
  The `origin` relationship recorded what a Thread was created from; nothing
  writes it since Threads were deleted, and stored rows keep the label.
- `elicitation_requests` is operational human-input state tied to a run.

D1 retains a `workstreams` identity/routing anchor because control tables have
foreign keys to the stable ID. It contains only `id`, `workspace_id`, and
`do_identity_anchor`; a post-cutover row has `do_identity_anchor = 1`. The id
is a **conversation parent id**: a Canvas's or a Sidekick's, both
bootstrapped through the same path, and
`workstream_authority_routes.workstream_id` is keyed the same way. The column
names are kept because D1 migrations are immutable and every reader of the
route keys on the same pair. A retired Thread's row stays, which keeps a new
Canvas from taking its id and its stale search rows unreachable
([`text-search.md`](text-search.md)). Likewise `workstream_email_routes.automation_subscription_id`
keeps its name and holds the automation id. The Canvas and Sidekick lists and
pins are `WorkspaceDO`'s; D1 has no projection fallback when that object is
unavailable.

### Automations and execution

**An automation's own state is hosted in `WorkspaceDO`.** Each automation is
a conversation parent like a Canvas, whose rows (`automation_directory` and
the `sidekick_*` tables) hold its definition revisions, lifecycle, schedules,
runs (each a child substream under it), and inbound-email receipts.
[`automation-lifecycle.md`](automation-lifecycle.md) is that schema's map and
[`workstream-durable-object.md`](workstream-durable-object.md#hosted-sidekicks) its
column catalog; what follows is only what WorkspaceDO still holds.

- `automation_directory` is the Sidekick's definition row, which the sidebar,
  the connector fan-out, and access revocation find a Sidekick by: id,
  workspace, author, `source_version`, payload hash, lifecycle (`draft`,
  `active`, `paused`, `deleted`), scope (`personal`, `workspace`; a stored
  `workstream` reads as `workspace` since migration 137), the dead owning
  columns, title, description, next run time, the chosen icon and colour (null until somebody
  picks one), and when it was projected. Migration 91 added the definition
  columns (accepted revision, bindings, run-as user, pause reason and the rest);
  the revisions, schedules and runs are the `sidekick_*` tables.
  `HostedSidekick` writes the row in place inside the change's own
  transaction, so nothing publishes it over the Queue; a late
  `directory_automation` message from the deleted `SidekickDO` is acknowledged
  and ignored.
- `workspace_external_event_registrations` holds one row per active trigger
  route, an automation's typed evaluator document (the
  `workstream_resource_update` kind a Thread's watched resource registered has
  no writer since Threads were retired), indexed on `(connection, event type, resource, state)` for
  candidate selection and on `(destination kind, destination key, state)` for
  replacement. A Sidekick's set is replaced whole inside its own transaction
  (`writeSidekickRegistrations`), which orders its writes; the
  `external_registration_generations` fence the retired projection RPC kept is
  no longer read or written. `effective_after_event_sequence` is the cutoff, so an event admitted before
  the call is never matched by a rule that did not exist when it arrived.
  Removed rows are reaped after a day.
- There is no delivery ledger. `matchExternalEventDestinations` returns one
  complete Queue message per match, and the destination is idempotent on the
  event and registration ids, which is all a lease ever guaranteed.
- `schedules` carries no automations. A row names a connector connection's
  poll; an automation's timers are alarm entries keyed by its id.
- Migration 31 dropped `workspace_external_event_deliveries`,
  `automation_creation_claims`, `automation_cutover_campaign`,
  `automation_templates`, and `automation_template_versions`, rebuilt
  `automation_directory` and the registrations without their coordinates, and
  deleted every conversation directory row an automation run had made. The
  directory's `origin_type`, `origin_label`, `automation_subscription_id`,
  `automation_run_id`, `planned_for`, and `automation_exposed` remain as dead
  columns inside the released CHECK constraints; nothing reads or writes them.
  The cutover of 2026-08-28 that once dropped `automation_subscriptions`,
  `automation_runs`, `automation_delivery_targets`, `automation_resources`,
  `automation_email_receipts`, and `automation_email_rate_windows` is history
  the changelog carries; a fresh WorkspaceDO still creates them inside frozen
  migration 1 and drops them with its identity row.

- `memory_scopes` owns durable user, workspace, and Sidekick
  table authority. `memory_tables`,
  `memory_table_columns`, `memory_table_rows`, and `memory_table_cells` store typed
  collections with natural-key deduplication and targeted queries. Prose
  memory is `memory_facts`, keyed by subject and carrying its source
  conversations, with `memory_sweep_receipts`, `memory_fact_receipts`, and the
  digest copy-sync lane's `memory_digest_holders`, `memory_digest_holder_facts`,
  `memory_digest_sync`, `memory_digest_sync_state` and `memory_revision` beside it (WorkspaceDO migration 117; each
  conversation object holds its `memory_digest_copies`, migration 77)
  ([`agent-memory.md`](agent-memory.md#data-model)); the retired
  `memory_items`, `memory_mutations` and `memory_index_outbox` were imported
  and dropped by WorkspaceDO migration 116. A
  Sidekick's chat and its runs resolve one scope of kind `sidekick` (stored as
  `automation` before WorkspaceDO migration 50) keyed by the Sidekick id, beside
  the workspace scope; there is no Sidekick memory engine elsewhere. A run creates the tables its definition describes through
  the memory tables plugin under that scope the first time it needs them.
- A run's convergence is its Sidekick's `sidekick_runs.occurrence_key`, unique per
  automation and derived per trigger: `schedule:<scheduleId>:<plannedFor>` for a
  timer, `inbound_email:<resendEmailId>` for mail, `manual:<idempotencyKey>` for
  a **Run now**, and `external:<workspaceEventId>` for a connector event. The run
  id is the child substream id, and `harness_run_id` is unique per run.
- Object-local `runs` records each bounded model loop. `tool_effects` is unique on
  `(run_id, tool_call_id)` and stores input hashes plus side-effect state. A
  `code_execute` program's nested calls are rows of their own whose
  `tool_call_id` is the program's with a `:call:<index>` suffix
  ([`code-mode.md`](code-mode.md)).
- AgentLoopDO `tool_pages` maps `(run_id, page_id)` to private continuation
  arguments, producing/consuming receipts, operation, principal, connection, and
  forward ancestry. Migration 61 adds it alongside the receipt authority; the
  lifecycle and scope checks are owned by [tool pagination](tool-pagination.md).
- `transcript_compaction_checkpoints` references the model-only fact that owns
  the raw LLM continuation summary per execution principal and immutable
  run/sequence event, with its
  sequence boundary, resource-inventory revision, and deterministic template
  version. Current authorized totals are regenerated on apply and replay and
  are intentionally absent from the principal-scoped row. A final conditional
  insert rejects a summary when the inventory revision changed after rendering.
- Object-local `active_agent_compaction` is the owning AgentLoopDO's
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
  for itself, each mirrored into that AgentLoopDO's own alarm index.
  It is separate from `schedules` because a wake-up is one-shot, belongs to a work
  stream rather than a subscription or connection, and carries the prompt text that
  becomes the resulting run's trigger. The common WorkspaceDO directory row exposes
  only the next due time so the workspace alarm can call the owner; it does not
  copy the wake-up. `idempotency_key` is unique inside the object,
  so a replayed tool receipt resolves to the wake-up its first attempt created;
  `status` moves `pending → fired` under a version guard before the run is launched,
  making a wake-up at-most-once rather than at-least-once.
- Terminal's conversation-specific durable rows are object-local.
  `terminal_workspace` owns one generation, authority fingerprint, provider
  reconciliation identity, exclusive operation lease, lifecycle deadlines, and
  final-diff pointer per conversation: the main conversation's sandbox is the
  parent's, a run has its own, and a background agent uses the
  one of the conversation that started it, with `operation_run_substream_id`
  naming the holder's conversation while a run from elsewhere holds the lease
  (conversation schema 63). `terminal_tasks` binds one command to one
  harness tool receipt and retains only command hash, terminal state, exit,
  termination reason, byte counts, and bounded head/tail plus an optional full-log
  resource; since conversation schema 65 it no longer keys the run and the
  receipt to this object's own tables, because a background agent's command
  records its task in its owner's object while its run and receipt stay in its
  own, named by `run_substream_id`. `terminal_imported_resources` records planned and completed imports
  per generation, destination, source hash, and byte size so a retry never trusts
  pre-existing sandbox bytes, and since conversation schema 64 the conversation
  whose attachment authorized the import when that is not the row's own
  (`attached_substream_id`). `workspace_sandbox_network_policies`, `_domains`, and `_mutations`
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

### Notifications and connectors

- A conversation's effects, a mention or an add among them, are receipted
  by its Canvas or Sidekick in `WorkspaceDO.sidekick_child_receipts`; message
  ID and payload hash detect replay or conflict, and a mention's intent commits
  in the same transaction. An `activity_event` is receipted and stored nowhere:
  the Activity log it fed is retired, and migration 147 dropped
  `workspace_activity_events` and its targets, reads and pushes.
  `WorkspaceDO.workspace_workstream_effect_receipts`, the Thread host's inbox,
  is unwritten since 2026-11-07; migration 147 left it in place.
- WorkspaceDO `workstream_notification_intents` temporarily retains a bounded
  person-notification payload — a mention, or somebody added to the
  conversation — and the Sidekick run pushes (Needs input, finished;
  migration 145). Delivery resolves current membership/profile state from D1
  and checks the recipient against the parent's own reader rule
  (`notificationDirectoryState`); terminal delivery or skip erases
  `payload_json` rather than retaining a second transcript. Effect receipts
  are retained for 180 days and terminal intent shells for 30; a redelivery
  past that window converges on the idempotent intent ID rather than a receipt
  row. A mention commits its receipt in the same WorkspaceDO transaction as the
  intent it acknowledges; no regional D1 receipt exists for it.
- The Thread-era Activity log and the digests are gone: migration 147 dropped
  `workspace_activity_events` with its targets, reads and pushes, and every
  digest table except `digest_schedules`, kept empty because a foreign key on
  `schedules` names it. Their shapes are in the shipped migrations. Activity as
  it is now is `workspace_activity_items` and `workspace_activity_seen`
  (migration 148), above.

- `WorkspaceDO.connector_installations` owns a connection's unique setup attempt,
  initiating user and input digest, generation, typed registration document, and
  separate cleanup credential envelope. `connector_installation_steps` records
  exact dispatched intents and outcomes so an uncertain provider create cannot
  be replayed as a fresh create. Both tables are typed-only object authority.
  WorkspaceDO migrations 53/54/55 add Ashby discriminators, installation state,
  and Fireflies to both connector vocabularies; partial unique indexes permit one
  active Ashby workspace connection, one active Fireflies workspace connection,
  and one active personal connection of each per owner/workspace. Credentials are replaced only
  against the current generation and envelope; cleanup never restores ordinary
  access. See [installation lifecycle](connector-installation-lifecycle.md).

- Global D1 `ashby_connection_routes` maps only connection ID to region, active or
  disabled status, and update time (migration 0104). The regional
  `connector_ingress_routes` projection then resolves the owning workspace.
  Neither directory contains provider credentials or payloads.

- Regional D1 `connector_maintenance_operations` stores an operation ID and a
  validated JSON document with the frozen regional selection, operator identity,
  planned registration changes and per-target progress (migration 0105). This
  administrative operation record is distinct from installation authority.
  Atomic JSON-path updates preserve concurrent target outcomes; cancellation
  fences later lifecycle work.

- `connector_connections` owns scope, encrypted provider credentials,
  capabilities, cursors, and health. Migration
  `0072_notion_connection_scope_split.sql` uses the capability dialect to move
  historical Notion public-integration bot rows from personal to workspace
  scope while preserving new `notion.personal.mcp` ownership. WorkspaceDO
  migration 73 adds `discovered_tool_count`, the number of tools a connection
  with a live-discovered tool surface exposed at its last discovery (NULL until
  the first, and again after a discovery that failed for any reason but an
  authorization refusal), and `tool_count_backfill_attempted_at`, which spends the
  connection list's one background discovery;
  [`connectors.md`](connectors.md#settings-tool-counts) owns when each is
  written.

- `slack_installation_routes` is the opaque Global team-to-region directory;
  `slack_user_links`, `slack_agent_sessions`, and durable `slack_ingress_jobs`
  remain regional — meaning *per region rather than Global*, not *in regional
  D1*. All three are WorkspaceDO tables, reached through
  `withWorkspaceRuntimeDatabase`; regional D1 has not had them since migration
  0090. Reading the distinction the other way is what produced the
  `slackUserIsLinked` incident below, and again the automation delivery-target
  500 of 2026-08-31. A session row is delivery state (status, reaction, who
  started the thread); where a Slack message routes is decided by
  `external_conversation_bindings`, below. Each AgentLoopDO's
  `run_absorbed_slack_origins` (its migration 73) recorded the Slack origin of
  every steer a Thread's run absorbed; nothing writes or reads it since plan
  step C-3, and it stays as an unwritten table.

- An automation has no destinations anywhere: its rows store none, and
  a run's loop input is a reference to its definition revision. A run's result
  is its row in the Sidekick's shared conversation; it reaches an attached
  Canvas through the run's own `conversation_post` tool, and attachments are
  `sidekick_conversation_attachments` in WorkspaceDO, keyed by the Sidekick and
  the conversation address. Any other destination is the run's own work, sent
  with its connector tools.

- `slack_unfurled_links` records which Slack message carries which Rally
  link, plus a hash of the attachment posted on it. Slack reports a shared link
  only once, so a row that is not written as the card is posted can never be
  recovered — see [`links.md`](links.md); posted cards are no longer refreshed
  ([`slack-integration.md`](slack-integration.md)).

- `WorkspaceDO.webhook_receipts` stores connection-scoped signed-delivery replay
  receipts for generic, Granola and Ashby webhooks. `provider_webhook_receipts` remains
  in D1 only for a provider-global delivery that may precede/fan out across the
  workspace routes it matches.

- `WorkspaceDO.workspace_connector_events` stores the complete authoritative
  normalized connector event. Its provider identity and connection-scoped dedupe
  constraints select one canonical event; processing status, processing owner,
  claim, error, and settlement timestamps stay beside the body. The separate
  `workspace_connector_event_ingress_receipts` maps each Queue/provider ingress
  UUID and content hash to that canonical event. A `processed` event is deleted
  90 days after it was received, by the alarm's `connector_event_reap` phase;
  see [`workstream-durable-object.md`](workstream-durable-object.md).

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

- `audit_events` in the independent `AUDIT_DB` records security- and side-effect-relevant actions without copying
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
  per pack action of one operation: its kind and room, the conversation and human
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

The tables have distinct lifecycles rather than one catch-all event store:

- `telemetry_identity_links` records the one anonymous-epoch-to-person link.
  `telemetry_profile_jobs` separates that non-superseding transition from
  coalescible person and workspace profile updates.

- `telemetry_destination_state`, `telemetry_ingest_rate_buckets`,
  `telemetry_rejection_buckets`, and `telemetry_replay_audit` hold bounded
  operational control and audit data without product payloads.

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
   schedule is derived: an automation's inside its own object when a revision
   is applied (the run-as user's zone for a personal automation, the
   workspace's otherwise). The resolved zone is then frozen on that row and
   does not follow a later change to the account;
   `docs/potential-bugs.md` carries the question of whether it should.

8. R2 objects are addressed through opaque references. Raw/large provider
   payloads never enter Queue or Workflow inputs; the regional Queue carries
   only the bounded normalized connector event needed to reach WorkspaceDO.

9. **Who may read a conversation is decided by Durable Object authority.**
   Its Canvas or Sidekick in WorkspaceDO owns the audience (`canvasAdmits`,
   `sidekickAdmits`), and the lists and admission read it there. D1 is never a
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

13. **A Terminal sandbox row is unique by `(workspace_id, workstream_id)` and its
    provider/stable names are unique inside that workspace.** Two live generations
    for one stream would defeat mutation serialization and make authority
    revocation nondeterministic.

14. **An effect is acknowledged to the Queue only after the owning receiver
    commits the effect and its receipt together, and the sender's outbox row is
    deleted when `sendBatch` accepts the message, because retry is the Queue's.**
    A child's effects commit in its parent (a hosted Canvas or Sidekick in
    WorkspaceDO); an automation's row and mention effects commit in
    WorkspaceDO. A hosted parent's list rows are written in the parent write's
    own transaction, with no Queue hop and no outbox row. External notification
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
| Pinning and the pinned sidebar section | [`pinning.md`](pinning.md) |
| The automation lifecycle and every `sidekick_*` table | [`automation-lifecycle.md`](automation-lifecycle.md) |
| The conversation-parent contract and the effect legs between the objects | [`workstream-durable-object.md`](workstream-durable-object.md) |
| Canvas and Sidekick parent tables in WorkspaceDO, and how they moved from the legacy objects | [`hosted-conversation-parents.md`](hosted-conversation-parents.md) |
| A Canvas's directory, audience and artifacts | [`canvases.md`](canvases.md) |
| Model pinning and the flags it overrides | [`feature-flags.md`](feature-flags.md) |
| Telemetry routing, identities, lifecycle, and destinations | [`telemetry.md`](telemetry.md) |
| Running and reverting migrations against hosted databases | [`runbook.md`](runbook.md) |
| Daytona Terminal sandbox, task, policy, and publication behavior | [`terminal-workspaces.md`](terminal-workspaces.md) |

## Failure modes and limits

- **Retired (WorkspaceDO migration 147 dropped this table).** **The historical D1 `activity_events.digestible` defaulted to `1`;
  WorkspaceDO does not.** That source table existed only through migration 0089
  and is absent from the current D1 schema. `workspace_activity_events.digestible` is
  `NOT NULL` with no default, and the typed RPC requires it, so every live
  producer must choose fail-open or fail-closed explicitly.
- **`artifacts` is retired and absent from current D1.** It remained through
  migration 0089 so the previous Worker could still read it; 0090 removes it
  with the rest of the product schema. Do not add a reader or recreate it.
- **A conversation's wake-up is at-most-once, not at-least-once.** `status` moves
  `pending → fired` under a version guard before the run launches, so a wake-up
  lost between the guard and the launch does not fire at all rather than firing
  twice.
- **Retired (WorkspaceDO migration 147 dropped this table).** **`workspace_workstream_pins.position` is not uniquely indexed**, because any intermediate
  state of the dense rewrite collides with itself. Uniqueness is a property the
  rewrite maintains, not one the database enforces.
- **An archived Sidekick's object is kept forever.** Its stored lifecycle moves
  to the compatibility tombstone `deleted` and its directory row records that;
  the object itself is never destroyed, because its run history, its
  conversations, its memory scope, and the permanent Global email tombstone all
  still name it. Its conversations become unreadable rather than deleted:
  `authorizeViewer` answers unauthorized and archived from then on. Rally does
  not currently expose an archived-Sidekick browser or an unarchive operation.

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

The connector connection rebuild inventory is frozen through WorkspaceDO v55,
whose list is `CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55` in `workspace-do.ts`.
Each version's list stays exactly as the migration that used it left it — a
later rebuild declares its own, without editing v31/v53/v55 statements or their
stored fingerprints. `apps/api/test/connector-connection-dependents.test.ts`
derives the true set from `PRAGMA foreign_key_list` over the migrated schema and
fails when a table referencing `connector_connections` is added without being
declared, which is the failure that otherwise waits until the next rebuild drops
its rows.

## Grants and invitations

`parent_grants`, the invitation tables and their delivery receipts in
`WorkspaceDO` are keyed by `parent_id`. A Canvas's guest share writes them, and
the claim's directory step adds the guest to `canvas_participants`; the grant
is the share's receipt, not who may read
([`scope-invitations.md`](scope-invitations.md)). The other `parent_*` grant
and audience tables (`parent_grant_operations`, the participant migration and
delivery tables, `parent_direct_audience`, `parent_space_sources`,
`parent_space_readers`, `parent_access_operations`) held a Channel's roster
handoff and Space-derived access; nothing writes them now, and they stay with
the Thread retirement's inventory.

## Usage metering

Migration 0118 adds `workspaces.plan` (`starter` or `growth`, default
`starter`), with no CHECK: the plan set is a moving product decision, and
`PlanIdSchema` parses it on every read. The ledger itself is in a separate D1 database, `USAGE_DB`, with
its own migrations in `packages/db/usage-migrations/`: `usage_events`, one row
per metered call keyed by `event_id` and kept 90 days, and `usage_rollups`,
one row per workspace per quota week and monthly period, kept for good. Every
event is also in the Iceberg table `avalon.usage_events` in R2. Overage is not
stored; it is derived on read. See [usage metering](usage-metering.md).

## Push devices

Migration 0107 adds regional `user_push_devices`, `user_push_device_sessions`, and
`push_delivery_receipts`. Devices belong to a person and installation; live
sessions bound by registration establish delivery eligibility. Receipts identify
one workspace intent and device. Notification content remains in WorkspaceDO,
read through typed RPC. Migration 0117 adds a browser subscription's key
columns for `webpush` devices. See [Push notifications](push-notifications.md).

## Observational databases

The regional Worker binds `TELEMETRY_DB` and `AUDIT_DB` separately from identity
`DB`. `packages/db/telemetry-migrations` owns `telemetry_accepted_events`,
`telemetry_delivery_receipts`, and `telemetry_replay_audit`;
`packages/db/audit-migrations` owns `audit_events`. Their user, workspace, and
workstream IDs have no cross-database foreign keys. Audit writes are best-effort
background work using the existing runtime deferral. See [telemetry](telemetry.md#storage-and-background-writes)
for the fresh cutover and delivery behavior. Regional migration `0113_drop_legacy_observability_tables.sql` drops the four
inactive legacy tables after deploying the Worker that no longer reaps them.
The dedicated stores are unchanged; no applied migration is rewritten.

## Changelog

### 2026-11-08 — Each person's Activity is stored beside their notification intents

**What changed:** WorkspaceDO migration 148 adds `workspace_activity_items`
and `workspace_activity_seen`, and widens `workspace_sidebar_list_state`'s
CHECK to `activity` by copying the table.

**Why:** Activity returns as a per-person feed written in the transaction of
the push intent it mirrors ([`activity.md`](activity.md)). It is WorkspaceDO
state because the intents, the read cursors that decide seen, and the
workspace socket that carries it all live there.

**Considered and rejected:** A `seen_at` column. Seen is derived from
`sidekick_viewer_reads` and the one Mark all seen row.

**Consequences:** Nothing prunes either table; retention is an open decision.

### 2026-11-07 — Thread, Channel and Activity subsystems retired from the server

**What changed:** The server half of the Canvases and Sidekicks pivot (plan
steps C-1 and C-2) deletes the code that read and wrote the Thread, Channel,
Breakout, Activity, digest and suggested-work rows. Retired so far:

- **Suggested work.** `work-opportunity-service.ts`,
  `work-opportunity-batching.ts`, `workflows/work-opportunity.ts` and its
  `WORK_OPPORTUNITY_WORKFLOW` binding, `WorkspaceProductStorage`,
  `workspace-opportunity-protocol.ts`, and the WorkspaceDO RPCs and product
  alarm they served. A `product` alarm an object armed before the deploy is
  answered with nothing to do. The verified-identity sync that ran inside the
  admission step went with it; `external_user_identities` rows it wrote are
  still read by `connector-actor-identity.ts`. `docs/suggested-work.md` is
  deleted; its tables (`opportunity_batch_*`, `work_opportunit*`,
  `opportunity_provenance_*`, `suggested_work_*`) stay until the WorkspaceDO
  drop migration of step C-7, and `workspace-product-schema.ts` stays because
  migration 1 still spreads its statements.
- **Digests.** `digest-service.ts`, `digest-run-service.ts`,
  `digest-delivery-service.ts`, `digest-email-content.ts`,
  `digest-personal-channel.ts`, `workspace-digests-protocol.ts`,
  `workspace-digests-storage.ts`, the WorkspaceDO digest RPCs, the cron's
  default reconciler and the timezone re-derivation. A `schedules` row that
  names a digest is advanced and sends nothing until C-7 drops the digest
  tables and those rows. `docs/digests.md` is deleted; the email converter it
  also owned, `email-markdown.ts`, is now
  [`markdown-rendering.md`](markdown-rendering.md)'s, with the decisions that
  still bind it.
- **Merge, Channel access requests and session import.**
  `conversation-merge-service.ts` and the agent's `conversation_merge` tool
  backend, `conversation-access-request-service.ts` (its WorkspaceDO storage
  goes with the Channel host) and `session-import-run-service.ts`; their
  routes went in C-1. `docs/conversation-merge.md` and
  `docs/channel-access-requests.md` are deleted.
- **Thread backfill and Channel colour sync.** `thread-backfill.ts`,
  `channel-color-sync.ts`, their alarm lanes and RPCs, and their activity-Queue
  handlers. A message of either type still in the Queue at deploy is
  acknowledged by the consumer's retired-message tombstone (with Projects'),
  rather than dead-lettered. The migration statements they exported (99, 100,
  115, 133, and the trigger migration 102 restates) moved byte for byte to
  `retired-workspace-schema.ts`, the home for statements whose module is gone;
  the colour triggers keep marking rows until C-7 drops their tables.
  `docs/thread-backfill.md` is deleted.
- **Breakout creation.** `substream-creation-service.ts` and
  `substream-context-summary.ts` (its one structured inference, and the
  `substream-context-summary-policy` routing it used) had no caller after
  C-1; `docs/substream-creation.md` is deleted. The engineering MCP's
  `create_channel`, `create_thread`, `read_channel`, `list_channels`,
  `list_threads` and `list_breakouts` go with the services they called
  ([`engineering-mcp.md`](engineering-mcp.md)).
- **Spaces and Channels.** `space-service.ts`, `space-bootstrap-service.ts`,
  `workspace-space-storage.ts`, `workspace-space-default-publication.ts`,
  `workspace-space-protocol.ts`, `system-channels.ts`, `channel-rails.ts`,
  `workspace-channel-read-storage.ts`, `unread-state.ts`,
  `channel-message-search-projection.ts`, `channel-access-service.ts` and
  `shared-directory-service.ts`, with their WorkspaceDO RPCs and socket
  commands. Onboarding seats a new member nowhere. The Sidekick list SQL that
  lived in `channel-rails.ts` moved to `sidekick-directory-sql.ts`. Queue
  messages of the `space_default`, `space_bootstrap` and `space_intent_resume`
  types are acknowledged by the tombstone. `docs/spaces.md` is kept as a
  retired record for its changelog.
- **The Thread and Breakout host.** `hosted-parent.ts` (the Channel and Space
  parent; [`hosted-conversation-parents.md`](hosted-conversation-parents.md)),
  `workspace-breakout-storage.ts`, `conversation-access-request-storage.ts`,
  `workspace-people-ranking.ts`, `workstream-object-creation-service.ts`,
  `workstream-directory-service.ts`, `workstream-batch-update.ts`,
  `workstream-origin-resource.ts`, `connector-workstream-audience.ts` and
  `slack-workspace-workstream-service.ts`. `workstream-service.ts` keeps only
  the harness launch, wake-up and external-message admission a Sidekick or
  Canvas conversation still uses. Slack starts no conversation any more: a
  mention or an App Home prompt is answered with
  `conversation_ingress_retired`'s copy, and a bot joining a channel binds no
  room (`room_bindings_retired`). The unfurl refresh sweep
  (`slack-unfurl-refresh.ts`) is deleted; a shared link still unfurls once.
  Session import's desktop action and reservation reclaim
  (`session-import-plugin.ts`, `session-import-reclaim.ts`,
  `import-reservation-reclaim.ts`), its share-URL and file helpers
  (`session-import.ts`, `session-import-files.ts`) and the `session_import`
  agent profile went with the Thread host; `docs/session-import.md` is kept as
  a retired record.
  `docs/workstream-creation.md` is kept as a retired record.
- **Activity.** `activity-event-service.ts`, `activity-email-service.ts`,
  `workspace-activity-feed.ts`, `workspace-activity-push.ts`,
  `workspace-activity-event-protocol.ts`, `activity-clear-rules.ts`,
  `activity-audience.ts` and `breakout-activity.ts`. A regional
  `activity_event` effect is receipted and stored nowhere; a push Queue
  message for an Activity item is logged `activity_item_retired` and
  acknowledged; `GET /artifact-pins` answers an empty list.
- **Listing rules.** `listing-rules.ts`, the ladder of who may be told a
  Space, Channel or Breakout exists, once agent memory's fact visibility was
  re-derived from Canvas and Sidekick participation
  ([`agent-memory.md`](agent-memory.md)); `docs/listing-rules.md` is kept as a
  retired record.
- **Moved, not changed.** Every migration statement those modules exported is
  in `retired-workspace-schema.ts`, byte for byte: the WorkspaceDO migration
  ledger's statement hashes are identical before and after.
- **The tables (plan step C-7).** WorkspaceDO migration 147 drops 49 of them
  (Activity, digests but `digest_schedules`, suggested work, a Channel's own
  ledgers, `workspace_workstream_pins` and the other Thread pin and order
  tables, Thread access and resource links, batch dispatches,
  `conversation_access_requests`, `thread_backfill`, the import-reservation
  reclaim, `workstream_email_receipts`), and the Thread rows of the shared
  tables; AgentLoopDO migration 86 drops `sidekick_attachments`. The Thread,
  Channel and Breakout directories, their viewers and the `parent_*` tables
  stay until the operator's Thread retirement has run everywhere, and
  `digest_schedules` stays empty under the `schedules` foreign key; the why is
  in [`workspace-retirement.md`](workspace-retirement.md#changelog).

**Why:** After the client cutover nothing shows a suggestion, a Thread or a
Channel; the PRD's decision log removes them from the product. Code that only
served them is deleted rather than left dormant so the next change does not
have to reason about it. Tables are dropped worker-first: the Worker that no
longer reads them deploys before the migration that drops them.

**Consequences:** WorkspaceDO migration 147 (plan step C-7) dropped the
Activity, digest (but `digest_schedules`), suggested-work, Space-ledger,
Thread pin, order, access, resource-link and batch-dispatch tables, the
Channel-rail and Channel-colour triggers and the Thread rows of shared tables;
AgentLoopDO migration 86 dropped `sidekick_attachments`. `channels`, `spaces`,
`breakouts`, their viewer tables and `parent_*` stay until the operator has
run `retire_threads` in every Organization, since its inventory reads them;
`digest_schedules` stays emptied because `schedules` names it in a foreign
key; D1 `workstreams` and the authority tables stay because Canvas and
Sidekick creation read them.

### 2026-10-18 — A rename is a version cause of its own

**What changed:** WorkspaceDO migration 113 admits `renamed` in
`resources.revision_cause` and `resource_versions.cause`. A person renaming an
artifact stages a `member` author and that cause; the same title writes
nothing.

**Why:** Any write to `title` records a version, so a rename had to name a
cause or record none. `replaced` would have made every rename news to the
artifact's pinners and told history something false.

**Considered and rejected:** Rebuilding both tables to widen the CHECK.
`resources` is a referenced parent, which needs the hold-and-restore recipe
and its risks. Instead each column is replaced: a wider one is added and
filled, the three triggers that read the old one are dropped, the old one is
dropped and the new one renamed into its place, and the triggers return with
their text unchanged.

**Consequences:** `GET /resources/:id/versions` sends a `renamed` version
with no cause, because a desktop build from before it parses the history
with a closed enum; send it once those builds are gone. The contract now
reads an unknown cause as none, so a later cause needs no such hold. An
agent republish that repeats the title it last set keeps a person's rename
(`AGENT_RESOURCE_TITLE_SQL`); one that names a new title takes it. A
later cause takes the same migration steps, and the capture triggers and the
pin ledger's trigger are named constants so that it can.
Rows are kept; `navigation-migrations.test.ts` upgrades a populated 112 and
checks them.

### 2026-10-17 — An agent's resource version names the person it acted for

**What changed:** WorkspaceDO migration 112 adds `on_behalf_of_user_id` to
`resource_versions`, staged through `resources.revision_on_behalf_of_user_id`
and copied and cleared by both capture triggers like the rest of provenance.
The Terminal republish and the image edit fill it with the person who asked for
the run (`runRequesterUserId`): for a Sidekick, the member who sent the turn's
input or started the run by hand, never its run-as user for a scheduled or
inbound one.

**Why:** A pinned artifact's updates (Activity rows, pushes, the pin's unread
state) must never come from the person's own change. An agent version named
only its run, and the run's person lives in the thread's object, so nothing in
WorkspaceDO could tell a revision someone asked for from one somebody else
did.

**Considered and rejected:** Putting the person in `author_user_id`. The
provenance fence admits a user only for a member's version, and the rail reads
that column as who wrote it; the run still wrote it. Looking the run up in the
thread's object at read time would add a hop to every pin and Activity read.

**Consequences:** Versions from before the migration name nobody, and a writer
that never sets the column records nobody: both read as somebody else's change.
A new agent writer of a later version should set it from
`runRequesterUserId`, not the principal, which a Sidekick run fills with a
person nobody asked.

### 2026-10-16 — The account timezone follows the device by default

**What changed:** The desktop and browser clients now report the device's
zone, not only a desktop Google sign-in, so an account on `client` stays in the
zone its person is actually in; digests are re-derived when it moves. Account
gained a **Set timezone automatically** switch above Default timezone, which
returns a fixed account to `client`.

**Why:** Email and browser sign-in never sent a zone, sessions renew without a
sign-in, and the column defaults to `America/Los_Angeles`, so most accounts
held a zone nobody chose and digests arrived at the wrong local hour. A fixed
zone still wins over a report, for the reason `assumptions.md` item 22 gives.

**Consequences:** Every launch and focus sends a report, because another
device may have moved the account since; the device in use wins, and a report
that changes nothing writes nothing. Personal automations keep the zone they
were created in: only digests are re-derived when the account moves. A support
session never reports.

### 2026-09-21 — Scope Channel pins to Space placements

WorkspaceDO migration 66 replaces the per-person Channel pin key with
`(user_id, space_id, workstream_id)` and intentionally copies no legacy rows.
The old records had no authoritative Space identity, so preserving them would
either pin every placement or choose one arbitrarily. Pin order and dense
rewrites are per person and Space; the existing per-person cap still bounds the
combined first-page supplement across all Spaces.

### 2026-09-20 — Remove the completed WorkspaceDO cutover ledger

Migration 0115 drops `workspace_product_authority_routes` and replaces the two
regional phase guards with versions that fence only the live per-workstream
routes. The table was one-time import evidence with no post-cutover writer, but
its retained route-shaped rows were repeatedly mistaken for current WorkspaceDO
authority. Keeping it with comments was rejected because that ambiguity had
already broken operator inspection. The migration is Worker-first: compatible
code resolves deterministic WorkspaceDO identity before the old table is
removed. Historical migrations and the migration-0090 baseline remain immutable.

### 2026-09-19 — Admit Canva in persisted connector vocabularies

WorkspaceDO migration 62 rebuilds connector connections and OAuth attempts to
admit Canva and enforces one active personal Canva connection per member. The
real Electron login reached an older SQL CHECK despite the TypeScript vocabulary
already accepting the provider. Editing old migrations would invalidate receipts,
so this is a forward rebuild. It holds and restores every connector dependent,
including installations and OAuth connection pointers, retains the existing
indexes and identity fences, and preserves configured deployment identifiers.
A populated workerd upgrade test covers preservation and Canva admission.

### 2026-09-19 — Separate Canva access material from resource metadata

WorkspaceDO migration 61 adds `resources.protected_access_json`. The versioned
envelope is bound to the workspace, connection and design identity; it is excluded
from public resource representations and revision metadata. A separate field is
necessary because Canva share URLs may carry authorization, so treating every
provider URL as ordinary navigation would disclose credentials. Resource deletion
removes the envelope with its owner row.

### 2026-09-16 — Separate guest relationship from administrative role

Migration 0109 adds workspace-specific access class, membership incarnation and
admission revision. SQL forbids a guest from carrying an administrative role.
`workspace-relationship-service.ts` creates or reuses the ordinary membership
row without demoting members or reactivating suspended guests. Promotion checks
the current administrator, target incarnation and revision in the same update.
The desktop Make member action submits that observed incarnation/revision through
`POST /workspace/members/:id/promote`; it never creates a replacement identity
or workspace relationship. Ordinary refresh exposes the new role on the same
session binding.
An accepted full membership invitation explicitly promotes an existing guest.

Membership insertion, admission changes and removal record durable
`workspace_relationship_deliveries` rows in their transaction. Existing writers
that change role/status also advance revision; last-seen activity does not.
Removal intents survive deletion of the relationship and a later rejoin receives
a fresh incarnation. The cron dispatches pending intents to the existing access
revocation queue; root processing publishes invalidation or starts the revocation
walk. Dispatch and root-processing markers are separate from the still-pending
per-descendant acknowledgement and guest-serving integration.
The existing member middleware does not admit null-role guests as full members.

Migration 0110 binds sessions to `workspace_members.incarnation`. Backfill
preserves current sessions, insert/workspace-selection triggers bind new ones,
and a same-workspace update cannot revive an older membership's credentials.
Promotion retains the binding; removal/rejoin invalidates it. Auth and refresh
compare against the active relationship, as do all three socket authorities.

Real migrated SQLite tests in `workspace-relationship-service.test.ts` cover
promotion, stale incarnations, suspended relationships and atomic intent writes.

### 2026-09-16 — Support verified email identities without duplicate users

Guest invitations need an ordinary user ID before any Google login or workspace
onboarding. Migration 0108 makes the legacy Google subject nullable and adds
`user_login_identities` and `user_verified_emails`. Existing Google sign-in
already verifies the mailbox before creating an identity, so migration carries
those verified bindings forward. It preserves the complete foreign-key
dependency closure with enforcement on, including sessions, memberships and
routing anchors, and restores the existing immutability/authority triggers.

`login-identity-service.ts` records provider verification in a D1 batch. Email
resolution reuses only an explicitly verified primary address, creates a normal
email-only identity without a fabricated Google subject, and converges concurrent
first logins. It does not silently link a new Google subject to an existing
email-only account. A verified Google mailbox change removes prior email login
bindings so the old address cannot authenticate as the same person. User IDs,
authorship and workspace relationships are unchanged. Google subject remains a
compatibility field while existing clients and identity flows continue to use it.

This is identity persistence, not an email authentication endpoint: mailbox
challenge verification, browser sessions and invitation acceptance must precede
exposing email login. `test/login-identity-service.test.ts` uses the real migrated
SQLite schema and a populated pre-0108 upgrade to cover these invariants.

### 2026-09-15 — Recommend Sidekicks at workstream scope

WorkstreamDO migration 13 stores workspace Sidekick recommendation links once per workstream. Recommendations are execution-snapshot metadata, not active instructions: copying links into child attachment tables would conflate discovery with loading. Existing SubstreamAgent attachments remain local to each substream, including main, while recommendation removal clears only the currently addressed local attachment.

### 2026-09-14 — Retire built-in meeting data

Workspace migration 57 purges built-in note rows and captures content-free resource deletion addresses. Conversation migration 58 removes meeting attachment snapshots. The old tables remain empty until external deletion is verified; shipped migration history remains immutable. Dictation and connector resources remain independent. See [meeting retirement](meeting-notes.md) for rollout and verification.

### 2026-09-13 — Rebuilding a referenced parent empties its dependents first

**What changed:** WorkspaceDO migration 55 admits `fireflies` to
`connector_connections.connector_type` and `connector_oauth_attempts.provider`,
adds the two Fireflies cardinality indexes, and declares
`CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55` — v53's list plus
`connector_installations`. Unlike v31 and v53 it deletes every held dependent
*before* replacing the parent.

**Why:** `connector_installations` (v54) declares its connection foreign key with
no `ON DELETE` action, so the implicit delete inside `DROP TABLE
connector_connections` does not empty it — it **aborts the drop**, inside a
`transactionSync` group, on objects that have already committed earlier groups.
The published recipe in `durable-object-sqlite.md` said to replace the parent and
then restore the dependents, which is the order that fails; it now carries the
correction. The alternative considered and rejected was
`foreignKeys: "disabled_during_rebuild"`, which is a silent no-op inside an
object event and would have hidden the problem rather than solved it.

**What a future change must respect:** each version's dependent list is frozen
with the migration that used it, so a later rebuild declares a new one rather
than extending v55's; and `apps/api/test/connector-connection-dependents.test.ts`
now derives the true set from the schema, so a new table referencing
`connector_connections` fails a test on the day it is added rather than on the
day somebody rebuilds the parent. A dependent whose foreign key *does* declare a
cascade still needs the explicit delete: relying on which of the two a table
happens to use is how the next recipe goes wrong.

### 2026-09-12 — WorkspaceDO owns connector installations and dispatch receipts

**What changed:** Object migrations 53/54 add Ashby discriminators and typed installation/step tables. D1 migrations 0104/0105 add opaque routing and frozen regional maintenance operations.

**Why:** Remote create uncertainty and cleanup after disablement need durable intent and credential ownership beside the connection. Fleet progress must survive concurrent Queue deliveries without overwriting sibling results.

**Considered and rejected:** Storing canonical installation state in routing D1 or rewriting the entire maintenance document for one target. Those split authority or lose concurrent progress.

**Consequences:** Installations and exact step receipts remain WorkspaceDO authority; D1 operation records do not grant provider access. Preserve generation/envelope fences and cleanup ciphertext until verified removal or explicit forgetting. See [lifecycle invariants](connector-installation-lifecycle.md#invariants).

PR #737. Design: [connector installation lifecycle](PRDs/2026-09-12_connector-installation-lifecycle/prd.md).

### 2026-09-11 — A resource can be reachable without being enumerated

**What changed:** `metadata_json.listing` carries one value, `unlisted`. Every
statement that enumerates resources applies `listedResourceVisibilitySql`; every
point lookup deliberately does not. WorkspaceDO migration 52 backfills the
Terminal recovery backups written before their producer set it.

**Why:** The `resources` table had no way to say that a row exists for recovery
rather than for reading. Terminal's pre-replacement archive has to stay resolvable
by id and absent from the rail, the workspace list, the model's inventory and
search, and those are the same fact only for content someone asked for.

**Considered and rejected:** A typed column on `resources` or on
`workstream_resource_links`, which is the right shape once a second producer
needs one; today it is a Durable Object migration and, on the link, a protocol
and mirror change for a single writer. A distinct `provider` value was rejected
because `provider` feeds `requiresAttachment` in `authorizationResourceFacts`.

**What a future change has to respect:** Listing is presentation. No read
decision may be derived from it, and no enumerating statement may omit the
predicate. Because it lives inside `metadata_json` it sits on the wrong side of
two triggers at once: invisible to the migration 43 search trigger, which
watches named columns and `description`, so a write that flips it on an indexed
row enqueues `resource_search_versions` itself or the row stays in search
forever; and visible to `resources_create_semantic_version`, which watches
`metadata_json` wholesale, so the same write mints a version and should stage an
author for it. Promote it to a column when a producer needs something a single
flag cannot express — that also settles both triggers — and migrate the stored
key in the same change.

### 2026-09-09 — Bound and recover early-access operations

**What changed:** Added the singleton `access_email_budget`, acknowledgement generations and suppression, per-grant minute counters, and stable paging indexes in the still-undeployed migration 0101. These coordinate budget and recovery without another storage service; generation checks prevent stale send completions from reversing an operator decision.

**Why:** Public acquisition needs predictable failure and recoverable operator actions before launch, without imposing account approval or building a campaign system.

**Consequences:** [Private access](private-access.md) owns configuration, undecided numerical limits, and recovery procedures. PR #637.

### 2026-09-09 — Add pre-workspace access requests and download grants

**What changed:** Migration `0101_private_access.sql` creates normalized requests
with frozen acknowledgement sender/content, hashed grants with nullable expiry,
and an IP-hash rate bucket table populated only when the intake cap is enabled.
The first acknowledgement-attempt timestamp and sending/review states preserve
exclusive provider admission and stop uncertain retries after deduplication expires.

**Why:** Intake precedes workspace membership, while retrying email and download
authorization both need durable state independent of the browser.

**Considered and rejected:** Three incremental migrations for this never-deployed
schema added fictitious legacy states. One founding migration defines the complete
shape. Email uniqueness replaces duplicate request rows, and only token hashes
persist rather than reusable bearer URLs.

**Consequences:** Configured deployments receive schema; active intake stays Global. Timed
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

### 2026-09-08 — Keep child archive separate from creation readiness

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

### 2026-09-08 — Order Sidekick registration replacement

Sidekick owner migration 4 stores `registration_generation`; WorkspaceDO migration
36 stores the latest per-destination generation and activation cutoff. A stale
publication tail previously could reinstall old predicates after new acceptance.
Equal-generation retries now preserve the boundary and empty replacements retain
the fence. These are object-owned SQLite migrations, not regional D1 migrations.
The Cloudflare class stays `AutomationDO` for the compatibility deployment.

### 2026-09-07 — Persist new-user identity and learning progress

Onboarding needs the same appearance and resumable setup across sessions.
Migration 0099 stores the revisioned account presentation in identity D1;
WorkspaceDO migrations 34–35 store the per-member journey and connector choices.
Existing accounts are exempted. A second execution store was rejected: first
work uses ordinary workstream creation and the existing durable agent loop.

### 2026-09-07 — One demo-workspace migration: the operation row is the register, beside its phases and the seeder's receipts

**What changed:** The three demo migrations written on the combined branch —
the register (`0099`), the seeder's receipts (`0100`) and the operation
(`0101`) — are folded into one file before any of them ships — `0099` as
written, `0100_demo_workspaces.sql` once `main` took `0099` for account
onboarding while this branch was open. `demo_workspaces` is gone:
`demo_operations` carries `ready_at` and `retired_at`, `workspace_id` is
unique with no foreign key to `workspaces`, `demo_seed_receipts` references
`demo_operations`, and the phase name has no `CHECK`.

The tables as they were written, kept as the record of why each exists:

- `demo_operations` and `demo_operation_phases` in regional D1 (`0101` as
  written), one migration because they are one thing: the operation and its
  phases.
- `demo_seed_receipts` in regional D1 (`0100` as written), keyed by operation
  and action, referencing the register's `operation_id` and `workspaces(id)`,
  with `run_outcome` closed to the two outcomes a seeded run may settle in.
  `runs.execution_context_json` in a seeded room's object gains an optional
  `seed`.

**Why:** Review found the register duplicating the operation row with two
extra columns and a reader nothing called, two children of one operation id
referencing different parents, and a foreign key that refused the very write
the column was designed for — the creating phase allocates the id before the
workspace row exists, and D1 enforces the constraint on the write, so
preparation could not pass its second phase. One table is one identity, and
one migration is what the repository asks of one coherent change.

The operation and its phases exist because the Demos page shows an
operation's current phase, its completed items and its failure from real
receipts, and resumes it by id. Those receipts have to outlive a Workflow
instance and be readable without one, and the operation has to exist before
the workspace it makes.

The seeder's receipts exist because the seeder plays a pack through write
paths that do not know they are seeding, so nothing in those paths can say
which pack action produced which row. A receipt written after confirmation is
what preparation resumes from and what the barrier will compare the workspace
against; a receipt written at admission would let a run that failed count as
seeded. The first row wins on conflict because its ids are the ones already
handed onward.

All of these rows are owned by [`demo-workspaces.md`](demo-workspaces.md).

**Considered and rejected:** Keeping the register and dropping only the
foreign key — the duplicate would still have to be kept in step on every field
a demo gains. A `CHECK` on the phase name — a product decision that will move,
and SQLite cannot widen one in place.

**Consequences:** Anything that asks which workspaces the demo feature made,
or whether one is published, reads `demo_operations`. The migration is one
unshipped file and is the place a further schema change goes until it ships.

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

### 2026-09-04 — Private work-stream children gain parent and local authority tables

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

### 2026-09-03 — Automations become conversation parents; the effect legs lose their acknowledgement

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
copy this recipe rather than the disabled-foreign-keys mode, declaring its own
frozen dependent list in `workspace-do.ts` — the per-version constants are named
`CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V<n>`, and v55 below records what the
recipe itself had to gain.

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

### 2026-08-24 — Accepted Global telemetry gains a second durable projection

**Why:** A Queue pointer needs a durable source and retry state, while copying
the already validated envelope into another D1 table would pay twice for the
same data and create a second policy boundary.

**Considered and rejected:** Full-envelope Queue messages, a new D1 event table,
and adding the state to `delivery_state`. Those respectively exceed transport
limits for valid events, duplicate the canonical row, or couple independent
PostHog and lakehouse delivery lifecycles.

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

### 2026-08-18 — Workspace product domains move behind WorkspaceDO authority, and imports and compatibility SQL enforce its shape

**What changed:** WorkspaceDO's single initial SQLite schema now owns connector
connections, connection-scoped webhook replay receipts, OAuth attempt status,
and workspace-local handoff rows, Terminal egress policy and its
revisioned mutations, Slack workspace state, automations, digest configuration
and deliveries, schedules, resources/watches/notes, R2 reference/deletion
outboxes, memory, mention intents, and external delivery state. Existing
repositories use an allowlisted D1-compatible port that sends local SQL through
typed native RPC; a statement batch that names both object-local and D1/control
tables is rejected, and the runtime database router also rejects regional
writes that reference WorkspaceDO-local tables in a subquery. The maintenance
campaign imports these tables in foreign-key order, verifies them with the rest
of the workspace route, scrubs the legacy connector-event body rows, and
permanently fences their D1 writers; the imports distinguish JSON-object and
JSON-array columns. Terminal mention shells are retained for 30 days and reaped
through the owning WorkspaceScheduler, never by a fleet-wide D1 product scan.
Migration tests now exercise connector-route backfill/triggers, authority phase
edges, and every workspace-domain drain category.

**Why:** Each row belongs to exactly one workspace and is frequently consumed
with other workspace state. Leaving it in D1 made D1 a product database and
forced object-owned workflows, sockets, and schedulers back through a second
authority for every operation. On the import and routing side, syntactically
valid JSON can still violate the target contract, and classifying a mutation
from any table name in its SQL can silently send a regional audit write into
the wrong database.

**Considered and rejected:** D1 serving projections, live dual writes, one
Durable Object per workspace domain, and cross-object SQL joins. A maintenance
window permits a clean authority switch; separate domain objects would add
routing and distributed transactions without improving ownership; SQL cannot
provide atomicity across Durable Object databases. Also rejected: relying only
on SQLite `json_valid`, permitting implicit cross-authority SQL, and testing
only the happy-path maintenance transition.

**Consequences:** D1 remains necessary for identities, membership, placement,
ingress routing before the workspace is known, migration control, and bounded
operational audit/telemetry. WorkspaceScheduler reads due workspace product
rows from WorkspaceDO. R2 still owns bytes, while WorkspaceDO owns every pointer
and lifecycle intent. Cross-object resource and Terminal operations perform
separate, version-fenced reads rather than pretending a join spans
WorkspaceDO and SubstreamAgent; cross-object work in general uses separate
durable/idempotent operations. Import failures surface before activation, and
control-plane migration changes must extend the trigger matrix tests.

### 2026-08-18 — Workspace activity, suggested work, and connector event bodies leave D1 for WorkspaceDO

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

The table catalog also makes
`workspace_connector_events`/`workspace_connector_event_ingress_receipts` the
normalized provider-event authority. The regional Queue carries the bounded
normalized event to WorkspaceDO; D1 `activities` is legacy maintenance input
only and is scrubbed/fenced at activation.

**Why:** All three datasets belong to exactly one workspace. Activity and
opportunities are consumed beside the workspace directory, and keeping them in
regional D1 made the nominal control plane a product serving plane and forced
delayed connector processing to retain a second body source. Persisting a
connector event's long-lived body in the regional relational control plane
created a second authority without enabling a valid cross-workspace join.

**Considered and rejected:** Keeping D1 projections for relational convenience,
dual-writing through rollout, and splitting opportunity provenance from its
opportunity/user state. The maintenance window makes dual authority unnecessary,
and splitting the graph loses the atomic boundary that makes a resolved
suggestion explainable. For connector events: a provider-delivery row shared by
multiple workspaces, and an indefinite D1 read projection. The former crosses
visibility boundaries; the latter keeps D1 authoritative in practice regardless
of what the object schema says.

**Consequences:** Activity visibility joins the WorkspaceDO directory locally;
opportunity admission and ranking run in Workflows against fenced WorkspaceDO
leases; dormant rankings create no polling loop; opportunity-origin attachment
does not race the first agent context read. D1 retains membership and connector
identity inputs, migration receipts, and opaque opportunity identity anchors,
but no activity rows, opportunity content/provenance/user state, or active read
or write path for these products. Long-lived readers resolve connector events
through WorkspaceDO. Raw provider bodies remain in R2, Queue retries converge on
object-local provider identity/dedupe constraints, and no D1 row is required
between verification and WorkspaceDO admission.

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

### 2026-08-18 — Active compaction is operational state, and derived block output gains a reconnect-safe checkpoint

**What changed:** The work-stream object map now names
`active_agent_compaction` separately from immutable compaction jobs/checkpoints
and from transcript `parts`. Each `BlockDashboardAgent` now stores one full
active-output checkpoint and its own one-time socket receipts beside the
existing dispatch ledger; its source transcript and Bind tool rows remain in
main `SubstreamAgent("0")`, and the checkpoint contains only the block's
derived output.

**Why:** The desktop needs a durable phase indicator across reconnect, but a
progress marker has neither the semantics nor the retention of a model message
or completed context checkpoint. A block loop likewise must resume a visible
in-progress stream after socket reconnect or object eviction without
duplicating deltas, losing text, or writing token-sized rows.

**Considered and rejected:** Inferring the compaction phase from missing token
deltas and authoring synthetic compaction parts — both confuse presentation
with durable conversation semantics. For block output: copying source messages
into the block object, per-token rows, and transient in-memory text — they
create a second transcript authority, amplify writes, or lose the recovery
boundary.

**Consequences:** The compaction singleton may be rebuilt/cleared from ordered
lifecycle events; a finish must match run, attempt, and index. Completed
summaries retain their existing immutable fences and canonical messages remain
unchanged. The block agent commits a complete revisioned checkpoint before
broadcast, Electron replaces rather than appends on resume, and completion
collapses the transient checkpoint into the terminal result authority.

### 2026-08-18 — Substream-agent cutover: overlays stay out of the transcript, HyperSight splits authority, routes gain immutable affinity, and sockets have three authorities

**What changed:**

- Object-local `parts` is documented as the provider-neutral semantic order,
  compaction rows retain immutable event identities, and `suggested_actions`
  is explicitly operational state rather than transcript. Durable Object
  timestamps are integer milliseconds even though D1/API values remain ISO
  strings.
- WorkstreamDO now stores configured/published HyperSight state, one
  `BlockDashboardAgent` stores each stable block's execution ledger, and main
  `SubstreamAgent("0")` stores the fenced Bind runtime rows used during
  execution.
- `workspaces`, the Global `platform_workspace_bindings` route, and
  `WorkspaceDO.workspace_identity` now carry the same region-compatible
  `wnam`/`enam`/`weur`/`eeur` affinity. D1 triggers backfill region defaults
  and reject changes once a compatible value exists.
- WorkspaceDO gained workspace-scoped socket receipts and a bounded
  topic-version log; WorkstreamDO gained socket receipts plus a revisioned
  complete metadata projection. SubstreamAgent remains the transcript/stream
  authority.

**Why:**

- A suggestion may be private or revoked and must not become shared model
  history by storage accident. A derived run also needs a stable lossy prefix
  and exact post-prefix tool pairs, not whichever summary is newest when it
  starts.
- HyperSight configuration and results are work-stream metadata, execution
  recovery is block-local, and transcript-related receipts must stay beside
  the transcript authority they reference.
- Every child creator needs a cheap regional route to the parent's one-time
  placement choice. Querying Global on each operation violates the data plane
  boundary, while recomputing from the current caller can split the object
  graph.
- Live multi-client workspace data needs durable change notification, while
  aggregate work-stream data needs a model-free authoritative snapshot.
  Neither requirement justifies copying relational workspace rows or token
  feeds into another database.

**Considered and rejected:**

- Treating every UI block as a message and storing timestamps in mixed
  formats inside object SQL. Both make authorization and ordering rules
  implicit at read time.
- Copying the transcript into block objects, putting model execution in
  WorkstreamDO, and treating a block as a conversation substream. Each either
  duplicates data, loads the control plane, or invents a false user-visible
  message authority.
- Keeping affinity only in WorkspaceDO and treating it as mutable workspace
  settings. The former makes the parent a read bottleneck; the latter suggests
  a row update can move Durable Objects when it cannot.
- Duplicating D1 workspace records in WorkspaceDO and deriving aggregate state
  from the current token stream. The first splits authority; the second fails
  whenever no model is running or a nullable field is cleared.

**Consequences:**

- Projectors have one explicit semantic source, operational cards require
  explicit authorship to enter it, and SQL range/order comparisons use one
  timestamp representation.
- HyperSight's cross-object consistency is explicit: source refresh signal,
  parent dispatch, block-to-source runtime SQL, and block result receipt. The
  complete SQL catalog and failure rules are in
  [`workstream-durable-object.md`](workstream-durable-object.md).
- Regional D1 is an immutable routing projection cached per Worker isolate,
  not a second placement authority. A true affinity change requires a
  maintenance migration of the complete hierarchy.
- Workspace mutation paths publish topics after commit, WorkstreamDO sends
  full snapshots by revision, and cross-object updates remain typed RPC/outbox
  operations rather than cross-database SQL.

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

### 2026-08-17 — Object-local SQL is named separately from canonical D1, and work-stream product rows acquire an authority boundary

**What changed:** The data map now identifies the versioned SQLite schema owned
by each existing `SubstreamAgent` and points to its module contract; at that
stage, canonical work-stream metadata and completed transcript rows still
remained in regional D1. The map then distinguishes workspace/control/projection
tables that remain in D1 from normalized product tables owned by one
WorkstreamDO after the maintenance generation opens. D1 migration `0079`, the
maintenance campaign's separately fenced authority migration, records the
phase/routes and permanently fences the legacy product tables after open.

**Why:** Cloudflare stores the room's former key/value data inside its SQLite
database, but hidden storage is still a different authority boundary from D1.
Leaving it undocumented makes named local tables look like a second canonical
product database. The physical copy and the authority switch are also separate
facts: without an explicit generation and writer fence, the same logical row
could continue to accept mutations in both databases.

**Considered and rejected:** Adding the object DDL to `packages/db/migrations`
— those migrations run against regional D1 and cannot safely version millions
of independently activated Durable Object databases. Treating all D1 rows with
`workstream_id` as one ownership class — pins, schedules, connector delivery,
automation, audit, and telemetry cross the work-stream boundary for valid
workspace/control reasons.

**Consequences:** Code must consult the ownership map, not infer authority from
an ID column. D1 schema changes — control and projection changes included —
still use numbered package migrations; object-local schema changes use the
Workstream Object registry.

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

**Considered and rejected:** One polymorphic event table, a mutable crash-issue
aggregate, product primary keys as PostHog identities, and extending retention on
retry. Each would either erase distinct policy lifecycles, keep old contributions
alive indefinitely, leak internal identifiers, or defeat the published ceiling.

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
`setup_generation` records the nonce row's monotonic generation on configured deployments.

This document predates the changelog rule; reasoning for earlier schema decisions
beyond the inline prose was not reconstructed. The migrations, `git log`, and the
PRDs under `docs/PRDs/` are the remaining record.
