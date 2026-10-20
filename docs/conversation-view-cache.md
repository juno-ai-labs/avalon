# Conversation view cache

WorkspaceDO keeps a compact display projection of its conversations. A client
opening a conversation requests its first page over the Organization socket
it already holds, while the authoritative SubstreamAgent socket connects.
The preview is read-only and the live snapshot replaces it unconditionally.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/conversation-view.ts` | Display allowlist, projection function, request and response contracts. |
| `apps/api/src/durable-objects/conversation-view-projection.ts` | Source change ledger, SQL triggers, migration 78, and reference-only Queue publication. |
| `apps/api/src/durable-objects/substream-agent.ts` | Reloads current source content for delivery and schedules publication through its existing alarm coordinator. |
| `apps/api/src/durable-objects/workspace-conversation-view.ts` | Destination tables, migration 124, version fences, and opening-page reads. |
| `apps/api/src/durable-objects/workspace-do.ts` | Admits each socket request through the conversation's own viewer authorization. |
| `apps/api/src/queues/activity-consumer.ts` | Reloads the source and commits the projection before acknowledging delivery. |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Requests previews on the existing socket; cancels obsolete requests and reissues unanswered requests after reconnect. |
| `apps/desktop/src/renderer/lib/conversation-cache.ts` | Seeds empty feed state with the existing read-only cache marker. |

## How it works

Source triggers record changed turns in `conversation_view_changes`, under a
monotonic conversation clock. Text, block, activity, interval, and header
changes are covered. Activity triggers walk upward to the assistant turn; they
do not copy a tool's arguments or results. Repeated mutations coalesce into one
pending reference per turn. A deletion keeps a small reference so its destination
can remove the old text.

The source's alarm publishes references through the existing activity Queue,
using its existing 100-message batch size and five-second dispatch retry.
Publication clears only the version it sent: a mutation during the send remains
pending. The consumer reloads current content from SubstreamAgent, applies it
to WorkspaceDO, then acknowledges. A failed destination write retries through
the Queue. Neither publication nor destination delivery gates the agent loop.

The allowlist retains text blocks, author snapshots, mention and attachment
references, and plugin display summaries with measured timing. Tool blocks,
call identities, inputs, results, errors, reasoning, and arbitrary structured
message payloads are excluded. A turn with no visible text or plugin work has
no content row. The display of interactive structured messages and inherited
context is completed by the live socket.

WorkspaceDO stores one header per conversation and one current value or
deletion fence per turn. Generation advances clear the previous generation's
turns. Within a generation, older and duplicate writes are ignored separately
for each turn, so an unordered Queue cannot resurrect deleted text. Every
visible turn is retained; the initial response reads the latest five visible
turns, following the existing five-turn opening policy. Older history and
unread-position reconciliation remain on the authoritative socket.

The subscribe answer advertises `conversationViews` support. New clients send
no preview command to an older server that omits it, preserving the existing
connection throughout a rolling deployment.

`conversation_view` requests carry a request ID, parent ID, and substream ID.
The server validates the current session and relationship and calls the same
hosted-parent viewer authorization as a conversation open. Reading a parent
does not grant access to its private children. Missing and unauthorized views
both return `view: null`. Responses stay within the existing realtime frame
budget, dropping the oldest preview turns when necessary; an oversized single
turn falls back to the normal socket opening.

The renderer seeds only empty caches, using `local_cache` as the existing
read-only lineage. Resident disk, optimistic, and live data win. A preview
does not acknowledge reading, advance a realtime cursor, complete an opening,
enable editing or sending, or persist itself as authoritative data. Active
cached plugin work does not start a ticking timer. A late response after
navigation is ignored, and any live conversation snapshot replaces the seed.

### Backfill and rollout

SubstreamAgent migration 78 queues every historical turn and the conversation
header. WorkspaceDO migration 124 also fills the existing
[`thread_backfill`](thread-backfill.md) lane from `parent_children` and
`sidekick_children`. Its `conversation_view` job includes Channel, Thread,
Breakout, and Sidekick conversations, including archived conversations. Unlike
the older summary jobs, this job does not use the open-thread directory as its
universe.

Each backfill delivery wakes the listed SubstreamAgent and marks its references
pending. It completes only after that durable intent and its alarm are recorded.
A registered child whose source object no longer exists reports `missing` so
it cannot hold the backfill lane indefinitely.
The source then drains pages of references through the normal delivery path.
A repeated backfill is harmless.

After deploying, force the WorkspaceDO fleet through the
[migration tracker](durable-object-migration-tracking.md), as for other
workspace backfills. This wakes Organizations that have no current users;
their work lists then wake their existing conversations. These code migrations
do not themselves deploy a release or force a production fleet.

## Invariants

- The strict display schema excludes tool payloads at both ends of delivery.
  Copying the full transcript would multiply storage use across the
  Organization and defeat the purpose of the projection.
- Version checks are per turn. A newer delivery for one turn must not suppress
  an older, still-needed delivery for another.
- Deletion fences survive content removal. Dropping them would permit delayed
  writes to resurrect deleted messages.
- Every read is authorized for its exact conversation. Sidebar visibility is
  insufficient for a private Breakout.
- The cache marker never becomes a live snapshot marker. Otherwise the preview
  could enable writes or prevent the authoritative snapshot from applying.

The contract, migration, cache, socket, and workerd tests named below exercise
these boundaries.

## Boundary

This is a disposable display projection. SubstreamAgent retains transcript and
execution authority. WorkspaceDO retains relationship and viewer admission
authority. The cache supplies an opening view; it does not supply tool details,
editing, history paging, inherited-context hydration, or realtime resume.
[`local-cache.md`](local-cache.md) owns the client's seed semantics.

## Failure modes and limits

A missing, delayed, refused, or oversized preview leaves the normal conversation
open running. A cached view can lag current activity, and the connecting card
remains until the authoritative socket answers. Queue failures retain the usual
retry and dead-letter behavior.

The workspace's 10 GB SQLite limit still applies. Excluding execution payloads
and keeping only current visible content substantially reduces duplication,
but visible text itself is not capped or evicted by this change. No new product
retention limit is invented. If visible history alone approaches the quota, a
retention policy or a different storage boundary is required.

## Testing

- `packages/contracts/src/conversation-view.test.ts`: display allowlist and
  exclusion of tool-only turns.
- `apps/api/test/conversation-view-migrations.test.ts`: populated schema
  upgrades, mutation triggers, and the complete backfill universe.
- `apps/api/test-workers/conversation-view-projection.test.ts`: real source
  projection, plugin timing, deletion and generation fences, Queue publication,
  and historical upgrades.
- `apps/api/test-workers/workspace-socket-fanout.test.ts`: cached reads over a
  real socket, private-child admission, and membership removal.
- `apps/desktop/src/renderer/lib/conversation-cache.test.ts` and
  `workspace-socket.test.tsx`: read-only seeding, live-data precedence, existing
  socket requests, and cancellation.

## Changelog

### 2026-10-20 — Preview conversations through the connected Organization

Opening a conversation previously waited on its own socket unless this device
already held a local copy. WorkspaceDO now retains a compact display projection
and answers over the Organization socket, allowing first-time viewing during
attachment. Full transcript replication was rejected because tool inputs and
results would consume the workspace SQLite quota. Source mutations and the
existing-conversation backfill share one durable reference-delivery path.
Future changes must preserve exact-conversation admission and the distinction
between a view seed and an authoritative socket snapshot.
