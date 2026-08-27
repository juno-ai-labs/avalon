# Resource versioning layer

> Created 2026-08-27.
>
> An automatic history layer beneath the existing resource system: whenever
> a resource's content pointers change — a generated document republished,
> an external document re-fetched, an upload replaced — the superseded
> pointer set is recorded as a version instead of being destroyed. Versions
> are pointer snapshots with provenance, never copies of content. Companion:
> [state](state.md). Supersedes the version-ledger scope of
> [work-stream artifacts](../2026-08-26_workstream-artifacts/prd.md).
> Siblings:
> [terminal artifact generation](../2026-08-27_terminal-artifact-generation/prd.md)
> (the first producer of pointer updates),
> [inline resource citations](../2026-08-27_inline-resource-citations/prd.md).
> Subsystem references: [agent attachments](../../agent-attachments.md),
> [data model](../../data-model.md), [connectors](../../connectors.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Resources are current-state objects today: a `resources` row holds a
pointer to the original content object and a pointer to its
model-converted representation, and when either pointer moves, the
lifecycle machinery deletes what it superseded. This PRD adds history
beneath that contract without changing it: the single place a resource's
pointer set changes also records the superseded set — original pointer,
original hash, derivative pointer, derivative hash, extractor version —
as an immutable version row with provenance: who moved it (agent run,
member, connector, system) and why (published, re-fetched, replaced).
Prior versions' content objects survive instead of being reaped, and the
right rail's resource detail can list versions and open a prior one
read-only.

Because capture happens at the pointer-swap site itself, every producer
gets history automatically and identically: a generated document
republished from the Terminal sandbox, an externally owned document
re-fetched after its source changed, an uploaded file replaced by a newer
copy. The layer also defines how change notifications from externally
owned resources enter the system — a watched resource's change arrives as
connected activity, the agent decides whether to re-fetch, and the
re-fetch lands as a new current state with the old one versioned — without
building continuous synchronization.

The layer is deliberately storage-shape-agnostic: a version row names
what kind of thing its pointer references. Today that is always an
immutable object in the region's bucket; a future collaborative editor
whose live state is OT/CRDT-backed materializes snapshots into this same
history at its own boundaries. Designing that seam is in scope;
collaborative editing itself is explicitly not.

## Motivation

Three pressures, one of them now urgent:

1. **The terminal-generation sibling ships destructive updates.** Its
   republish-updates-the-same-resource behavior is right, but until this
   layer exists, every revision permanently destroys the prior draft: the
   existing update trigger enqueues the superseded content object for
   deletion the moment the pointer moves, and the sweeper deletes anything
   no resource row still references. Drafting works; history does not.
2. **External documents go stale silently.** A Google Doc or Notion page
   enters a work stream as a snapshot and never changes again, however
   much the source moves. A re-fetch today would simply overwrite —
   losing what the model and the participants actually read when
   decisions were made. Freshness without history destroys provenance;
   this layer makes freshness safe.
3. **Versioning cannot be retrofitted.** History not captured is gone.
   Every roadmap the product has sketched for documents — human edits,
   diffs computed between versions, export, eventually an editor — stands
   on version history existing from before those features arrive. The
   superseded PRD established this argument; what it got wrong was scope,
   building an artifact-specific ledger written by dedicated tools. The
   durable insight is that inputs and outputs share one object system, so
   they should share one history mechanism — captured automatically where
   pointers change, not written by whichever producer remembered to.

## Goals

1. Every change to a resource's content pointer set, from every producer,
   automatically records the superseded set as an immutable version row —
   original pointer and hash, derivative pointer and hash where one
   existed, extractor version — with no producer-side participation
   required.
2. Every version row carries provenance: an author kind (`agent`,
   `member`, `connector`, `system`), the matching author identity, and a
   cause (`published`, `refetched`, `replaced`).
3. Superseded content objects referenced by version rows survive: the
   swap-time reaping that deletes them today is replaced by version
   capture, and the sweeper never deletes an object a version references.
4. A participant can see a resource's versions in the right rail's
   resource detail — author and time per row — and open a prior version
   read-only through the existing authorized preview surface, version
   addressed.
5. A change notification from an externally owned, explicitly watched
   resource reaches the work stream as connected activity; a re-fetch —
   agent-decided or participant-asked — lands as the new current state
   with the previous state versioned.
6. The layer accommodates future storage shapes: a version row names the
   kind of thing it points at, so a collaborative editor's materialized
   snapshots join the same history without schema change.
7. No backfill: existing resources need nothing done to them, and a
   resource that has never changed simply has no version rows.

## Non-goals

1. **Collaborative editing.** Rejected from this PRD outright, per its
   commission. The layer defines only the seam an editor would meet: live
   OT/CRDT state lives wherever that future system puts it, and what
   enters *this* history is immutable snapshots at boundaries that PRD
   will define.
2. **A diff surface.** Deferred. Complete stored versions are the
   substrate diffs will be computed from — externally, by comparison,
   never from a producer's account of its own edits.
3. **Version UI beyond the rail's list-and-open.** Deferred. No compare
   view, no restore button, no pinning. (Restore is cheap later — it is
   one more pointer swap, which versions the state it supersedes — but it
   is a product decision, not a free ride-along.)
4. **Continuous or bidirectional external synchronization.** Rejected.
   Notifications mark staleness and invite a re-fetch; nothing mirrors,
   polls aggressively, or writes back.
5. **Versioning overwrite-in-place surfaces.** Deferred. Meeting notes
   deliberately overwrite fixed storage keys so that the objects *are*
   the current note; a producer that reuses keys destroys bytes before
   the layer could preserve them. Participation requires writing a new
   object per update, which the publish and re-fetch paths already do.
   Migrating notes onto per-version objects is that module's own later
   decision.
6. **Retention and cap numbers.** Version rows and retained objects grow
   without bound by design; any ceiling is the team's to set under the
   open-limit rule, and nothing here ships one.
7. **New agent tools.** Rejected. The model needs no version tools in this
   change; it always reads current content through the existing
   attachment rails. Exposing version history to the model is deferred
   until something needs it.

## Product behavior

The layer is mostly invisible, which is the point. What a participant
sees:

- **A generated document revised** (the terminal sibling's flow): the rail
  still shows one entry; its detail now shows **Versions** — "V3 · Rally ·
  2:14 PM", "V2 · Rally · 1:40 PM", "V1 · Rally · 11:02 AM". Selecting a
  prior row opens it read-only in the existing preview surface, plainly
  labeled as not current, with one action: return to current. The current
  version opens exactly as today.
- **A watched external document whose source changed**: the change
  arrives as connected activity in the work stream, per the contract's
  existing watched-resource clause. When the agent (or a participant's
  ask) re-fetches, the resource's current content updates and the prior
  snapshot appears in the version list with `connector` provenance — so
  "what did we actually read last Tuesday" has an answer forever.
- **An uploaded file replaced**: uploads are create-only today — no
  replace affordance exists — so `member` provenance ships dormant. When
  a replace affordance arrives, its pointer swap is versioned with
  `member` provenance automatically, which is the point of capturing at
  the swap site.

States: a resource with no history shows no version section. Version-list
loading and failure states follow the rail's existing detail-view
patterns; opening a prior version that fails to fetch shows the preview
surface's ordinary retry. Offline, the version list renders if cached and
prior versions open only if previously viewed. Deleting a resource deletes
its versions and their objects through the existing deletion lifecycle.

## Impact on the product contract

None — this refines behavior within the existing contract. Resources
remain the persistent kind they are; "connected activities … enrich an
explicitly watched resource" is the clause the notification path already
lives under, now made concrete; nothing changes who participates, what
the agent may do, or what a participant may see. No clause moves.

## Decision log

None yet.

## Key design decisions

1. **Capture at the swap site, not in producers.** The resource authority
   owns the one place a pointer set changes, so version capture lives
   there and every producer — publish, re-fetch, replace, and producers
   not yet imagined — is versioned identically and unavoidably. The
   rejected alternative, producer-written history (the superseded PRD's
   dedicated-tool ledger), versions only the producers that remember to
   write it, which is how histories get holes.
2. **A version is a pointer snapshot, never a content copy.** Version rows
   reference the same immutable objects the resource system already
   stores; nothing is duplicated, and row cost stays in the hundreds of
   bytes. The requirement this imposes on producers — write a new object
   per update rather than overwriting keys — is already how the publish
   and derivative machinery behave, and is exactly the boundary that
   excludes overwrite-in-place surfaces (non-goal 5).
3. **Record-on-swap replaces reap-on-swap.** Today's update trigger
   enqueues the superseded original for deletion; this layer's capture
   *is* that trigger's replacement, and the sweeper additionally treats
   version references as live. Deletion of history happens only when the
   resource itself is deleted, or under a future retention policy the
   team sets. The rejected alternative — capturing versions while leaving
   reaping in place — would produce rows pointing at deleted objects,
   which is worse than no history.
4. **The derivative pointer is part of the snapshot.** A version records
   the model-converted representation alongside the original, so "what
   did the model read at V2" is answerable without re-running extraction,
   and a prior version opens for people without waiting on conversion.
   Where no derivative existed at swap time, the version says so
   honestly.
5. **Version numbers are allocated by the authority and count superseded
   states.** The current state lives on the resource row, as today;
   version rows are the past, numbered from 1 in the order they were
   superseded. A never-changed resource has zero version rows and no UI.
   The rejected alternative — modeling current as the newest version
   row — rewrites every existing reader of the resources table for
   symmetry nothing needs.
6. **Notifications mark, agents decide, re-fetches version.** The
   external-change path composes machinery that is live today, plus one
   missing hook. Live: the `resource_watches` poll schedule (a watched
   resource buys its connection a recurring poll; Google, Granola,
   Linear, Notion, and GitHub declare watch support), and the
   `watch_enabled` link routing that injects a matched connected
   activity into the watching work stream as a system message. Missing —
   and this PRD's addition: nothing today re-fetches the resource's
   bytes when a watch fires; the content re-fetch (`hydrate`) is invoked
   only from its own endpoint. The layer wires the loop closed: a
   watch-routed activity invites a re-fetch — agent-decided or
   participant-asked — and that re-fetch is the ordinary pointer swap
   the layer versions with `connector` provenance. The rejected
   alternative — auto-refetch on every notification — is synchronization
   by another name (non-goal 4) and spends quota on changes nobody asked
   about.
7. **Storage-shape agnosticism is one column, not a framework.** Each
   version row names the kind of reference it holds; today every row says
   the same thing (an immutable object in the region's bucket). The
   future editor's snapshots arrive as a new kind with the same
   semantics — immutable, openable, diffable. The rejected alternative,
   designing the CRDT storage itself now, is exactly what the commission
   forbade.

## Data model

Sketch level; the authoritative record is the migration and
[`data-model.md`](../../data-model.md). One new append-only table beside
the resource authority:

- `resource_id`, `version_number` — unique together; allocated by the
  authority; numbered from 1 in supersession order.
- `content_ref`, `content_sha256` — the superseded original pointer and
  identity.
- `model_content_ref`, `model_content_sha256`,
  `model_content_extractor_version` — the superseded derivative pointer
  set, null where none existed.
- `storage_kind` — the reference's shape; one value today, the
  editor-snapshot seam later.
- `author_kind` (`agent` | `member` | `connector` | `system`) plus the
  matching identity column (run, user, connection), and `cause`
  (`published` | `refetched` | `replaced`).
- `created_at`.

Lifecycle integration, named precisely because it is the risky part.
Today *two* triggers enqueue superseded pointers into the deletion
outbox — `resources_track_original_after_update` for `content_ref` and
`resources_track_model_content_after_update` for `model_content_ref` —
and a third enqueues both on resource delete; the sweeper then deletes
any enqueued object no `resources` row still points at. This layer
replaces both update triggers' enqueue with version capture in the same
transaction as the swap, extends the sweeper's liveness check to
"referenced by a resources row or a version row", and leaves the
delete-time trigger in place with version objects enumerated into the
same outbox. The one existing swap producer is the connector re-fetch
path (`ResourceService.hydrate`), which compare-and-swaps `content_ref`
and resets the derivative to pending — version capture hooks exactly
that swap, plus the terminal sibling's republish once it lands. No
regional D1 involvement; no backfill — the first swap after deploy
writes the first version row.

## Regional impact

None beyond the substrate's guarantees: version rows live beside their
resource authority in the workspace's region, version objects in that
region's bucket, and nothing crosses. External-change notifications
arrive through each region's own connector ingress as connected activity
does today.

## Security and trust model

- Version reads ride the existing authorized preview route with a version
  parameter; authorization is the resource's, and version numbers grant
  nothing. Knowing a UUID still grants nothing.
- Version capture introduces no new writer: it observes swaps performed
  by already-authorized paths.
- External change notifications are untrusted connector input, handled by
  the existing webhook/polling verification rules; a notification can
  mark staleness but cannot itself modify content — only an authorized
  re-fetch does.

## Rollout

1. Deploy order inside one release: the sweeper learns version references
   first (a no-op while the table is empty), then the capture replaces
   the reap trigger. This ordering means no window exists in which
   version rows reference reapable objects.
2. The rail's version list ships in the next desktop release; the layer
   is inert but correct without it.
3. Rollback: re-instating the reap trigger returns to today's latest-only
   behavior; version rows already written remain valid history.

**Migration and compatibility risks, stated plainly:**

- The trigger replacement is the highest-risk edit in the change — it
  sits on every resource update. It must land with the workerd tests
  proving capture-and-swap atomicity and proving the sweeper spares
  version-referenced objects (and each test shown to fail when the
  behavior is broken).
- Storage growth becomes unbounded by design; the open-limit handover
  gives the team the retention decision with the arithmetic.
- Producers that overwrite storage keys in place (meeting notes) must be
  positively excluded from capture, or their version rows would point at
  bytes that no longer exist.
- Until the desktop ships the version list, history accumulates
  invisibly; that window is harmless but should be short so dogfooding
  exercises the read path.

## Acceptance

1. Republishing a generated document (per the terminal sibling) leaves
   one rail entry whose detail lists V1 and V2 with agent provenance;
   opening V1 shows the prior draft read-only; the current preview is
   unchanged.
2. A simulated external change on a watched resource produces a connected
   activity; a re-fetch updates current content and adds a
   `connector`-provenance version of the prior snapshot.
3. The sweeper, run after a republish, deletes nothing a version row
   references; deleting the resource removes rows and objects through
   the deletion lifecycle.
4. A resource that never changed shows no version section anywhere.
5. A crash injected between capture and swap leaves either both or
   neither, proven on real workerd.
6. `pnpm lint` (zero warnings), `pnpm typecheck`, and `pnpm test` pass;
   the version list and prior-version preview captured from a real
   window; every new test shown to fail when its protected behavior is
   broken.

## Open questions

1. **Per-connector change fidelity.** Five connectors declare watch
   support today (Google, Granola, Linear, Notion, GitHub), but the poll
   is connection-scoped and Google has no provider push — so which
   sources produce *timely, resource-specific* change activities at
   launch varies by connector and is settled per connector during
   implementation. Blocks nothing in the layer itself.
2. **Should the model ever see version history?** Deliberately out (non
   goal 7); the question returns with diffs or restore, and the answer
   shapes whether attachment reads grow a version parameter.
