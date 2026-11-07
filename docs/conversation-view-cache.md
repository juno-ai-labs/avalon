# Conversation view cache

WorkspaceDO keeps a compact display projection of its conversations. A client
opening a conversation requests its compact feed over the Organization socket
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
changes are covered, including attachment link renames/removals and mention
edits. Header and block triggers ignore unrelated workstream fields and
tool-only block changes. Activity triggers walk upward to the assistant turn; they
do not copy a tool's arguments or results. Repeated mutations coalesce into one
pending reference per turn. A deletion keeps a small reference so its destination
can remove the old text.

The source's alarm publishes references through the existing activity Queue,
using its existing 100-message batch size and five-second dispatch retry.
Recent edits and the newest historical turns publish first, so opening does
not wait for the oldest history. Only one page per conversation has an unexpired
delivery claim. The consumer reloads current
content from SubstreamAgent, applies it to WorkspaceDO, then confirms the
claimed revision at the source before acknowledging. That confirmation releases
the next page; edits newer than the delivered snapshot remain pending. Queue
acceptance alone does not release a page. A failed destination write retries through
the Queue with exponential backoff. Claims also carry a durable retry gate using
the existing scheduled-alarm backoff, as the thread backfill lane does. If a
delivery or acknowledgement is lost, the source alarm reclaims and republishes
pending rows without waiting for another conversation edit. Neither publication
nor destination delivery gates the agent loop.

The allowlist retains text blocks, author snapshots, mention and attachment
references, and plugin display summaries with measured timing. Tool blocks,
call identities, inputs, results, errors, reasoning, and arbitrary structured
message payloads are excluded. Internal agent-to-agent prose is omitted; an
opening agent message retains only its display discriminator. A turn with no
visible text or plugin work has
no content row. The display of interactive structured messages and inherited
context is completed by the live socket.

WorkspaceDO stores one header per conversation and one current value or
deletion fence per turn. Generation advances clear the previous generation's
turns. Within a generation, older and duplicate writes are ignored separately
for each turn, so an unordered Queue cannot resurrect deleted text. Every
visible turn is retained, as requested for this projection; the initial
response reads the compact feed up to the existing realtime frame budget.
The read walks newest first, charges each normalized row's wire bytes and array
separators once, and stops at that byte budget instead of loading unbounded
history. Authoritative opening snapshots also select a newest suffix by the
same transport budget, so ordinary feeds survive the preview-to-live swap.
Their full tool and activity payloads can make the live suffix smaller for
large feeds. History beyond the frame budget and unread-position reconciliation
remain on the authoritative socket.

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

The renderer starts disk hydration and the workspace preview request together.
Preview application waits for the disk read to settle so a quick response
cannot suppress richer saved state. A preview can refresh a read-only seed
when visible content advances, without rolling back or dropping projectable
held turns. Freshness uses the shared display allowlist, since the disk also
holds internal turns intentionally omitted by the projection. Equal-revision
full turns, hidden turns, older ranges, active state, rendering metadata, detail
fields, and inherited context survive that refresh. Resident live and
optimistic data always win. Only missing or header-only previews retry using
the existing Organization reconnect backoff while the
conversation opens; the authoritative snapshot, terminal opening failure,
access revocation, or unmount cancels pending requests and retries. This is a
read retry over the same admitted socket, not another delivery channel.
Dedicated Sidekick windows relay
correlated requests, responses, and cancellations through the main window
using the existing Organization-sync bridge; publisher changes retry pending
requests. Each window still checks the Organization and conversation identity.
A preview
does not acknowledge reading, advance a realtime cursor, complete an opening,
enable editing or sending, or persist itself as authoritative data. Active
cached plugin work preserves its measured elapsed time without starting a
ticking timer. A late response after
navigation is ignored, and any live conversation snapshot replaces the seed.

### Backfill and rollout

SubstreamAgent migration 78 queues every historical turn and the conversation
header. WorkspaceDO migration 124 also fills the existing
`thread_backfill` (retired) lane from `parent_children` and
`sidekick_children`, plus `channels`, `spaces`, and `parent_metadata`
for legacy parents without a materialized Main child. Work lookup supplies
the implicit Main, matching the hosted parent registry. Its `conversation_view`
job includes Channel, Thread, Breakout, and Sidekick conversations, including
archived conversations. Unlike
the older summary jobs, this job does not use the open-thread directory as its
universe.

Each backfill delivery wakes a listed SubstreamAgent and arms any pending
projection work seeded by migration 78. It does not re-mark delivered history.
The parent remains claimed and later children wait until the current source
has confirmed delivery of its pending rows to WorkspaceDO; the next pass
resumes at that child, and a pass covers only children registered before the
backfill first reached the parent
(`thread-backfill.md` (retired)).
A registered child whose source object is absent, preparing, quarantined, or
has no active authority generation reports `missing`, so it cannot hold later
children behind an undeliverable migration header. Projection publication and
queued reads use the same authority fence. Pending rows are retained; activating
the source through runtime bootstrap arms the ordinary projection lane again.
The source drains pages through the delivery-confirmed path above.
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
  upgrades and mutation triggers; historical workspace coverage is exercised
  in workerd.
- `apps/api/test-workers/conversation-view-projection.test.ts`: real source
  projection, plugin timing, deletion and generation fences, Queue publication,
  historical upgrades, fenced-source backfill/activation recovery, and complete
  opening feeds across plugin-only turns within the realtime frame budget.
- `apps/api/test-workers/thread-backfill.test.ts`: the Queue consumer keeps a
  backfill claimed until the source projection reaches WorkspaceDO.
- `apps/api/test-workers/workspace-socket-fanout.test.ts`: cached reads over a
  real socket, private-child admission, and membership removal.
- `apps/desktop/src/renderer/lib/conversation-cache.test.ts` and
  `workspace-socket.test.tsx`: read-only seeding, live-data precedence, existing
  socket requests, cancellation, parallel hydration, seed refresh, and missing-preview retries.
- `apps/desktop/src/renderer/lib/use-workstream-socket.test.tsx`: opening seed
  acquisition, reconciliation, retry cancellation, and command gating.

## Changelog

### 2026-10-21 — Open the compact feed without a five-turn cutoff

**What changed:** Opening previews read the retained compact feed up to the
existing realtime frame budget, stopping the SQL cursor when that budget is
reached. Each normalized row's complete wire contribution is charged once,
including array separators and range coordinates. Authoritative snapshots also
open a byte-bounded newest suffix, preserving ordinary history on attachment.

**Why:** A first browser open showed only the final reply even though all 29
turns had reached WorkspaceDO. Four of its newest five turns contained only
plugin work, so the five-turn opening policy hid every earlier message.

**Considered and rejected:** Counting only prose toward the five-turn window
would still hide the conversation's earlier messages despite retaining them in
the projection. Reading all history before trimming would waste memory on large
conversations.

**Consequences:** Ordinary conversations show their compact history while the
live socket attaches and after its snapshot replaces the preview. Large feeds
still show a newest suffix within the existing wire budget; older paging and
transcript authority stay on the live socket. Full authoritative tool details
can reduce that suffix relative to the compact preview.

Pull request: [#1390](https://github.com/juno-ai-labs/avalon/pull/1390).

### 2026-10-21 — Refresh stale device seeds and settle fenced backfill sources

A returning device's disk row used to prevent every workspace preview request,
and a first request that missed the backfill was never repeated. Disk and
workspace reads now start together, with preview application following disk
hydration; newer visible content can refresh a read-only seed while preserving
richer equal-revision turns, hidden and active state, older ranges, and inherited
context. Freshness uses the shared display allowlist so internal turns cannot
suppress valid updates. Misses retry with the Organization's
existing reconnect backoff until attachment or cancellation. Unconditional
replacement was rejected because Queue delivery can lag a device's own copy;
only the live conversation may replace a seed without these display guards.

The backfill also treated identity-only placeholders as deliverable. Their
header projection failed the product authority fence forever and kept later
children under the parent waiting. Source publication, projection reads, and
backfill now agree on the existing authoritative-mode/generation predicate.
The pending ledger is retained and runtime bootstrap arms it, so activation
publishes without requiring an unrelated later write.

### 2026-10-20 — Preview conversations through the connected Organization

Opening a conversation previously waited on its own socket unless this device
already held a local copy. WorkspaceDO now retains a compact display projection
and answers over the Organization socket, allowing first-time viewing during
attachment. Full transcript replication was rejected because tool inputs and
results would consume the workspace SQLite quota. Source mutations and the
existing-conversation backfill share one durable reference-delivery path.
Delivery confirmation paces the pass so historical publication cannot race
ahead of the workspace writes. Durable retry gates recover lost deliveries so
an exhausted Queue retry cannot leave deleted text cached permanently. Legacy
parents with an implicit Main are included even without a materialized child row.
Disk hydration precedes preview requests, and
the desktop relay makes the same opening path available to Sidekick windows.
Future changes must preserve exact-conversation admission and the distinction
between a view seed and an authoritative socket snapshot.
