# Scope grant directory

The scope grant directory is a discovery index in `WorkspaceDO` of the
conversations a person holds a direct grant in, keyed by their membership
incarnation. It never authorizes a read. Its producer was the Channel's hosted
parent and its readers the guest directory and navigation routes; both went
with Channels and Threads. A Canvas share's grant has its own directory step
(`HostedCanvas.applyGrant`, which adds the guest to `canvas_participants`) and
writes nothing here, and a guest's Canvases reach them through the workspace
socket's Canvas list ([`canvases.md`](canvases.md#guests)). What remains is the
table, its apply path and its candidate query, kept because a grant effect
already in the Queue still lands through them.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/scope-grant-directory.ts` | `SCOPE_GRANT_DIRECTORY_SCHEMA`, `applyScopeGrantDirectory` (the versioned projection) and `scopeGrantCandidates` (the incarnation-specific candidate query). |
| `apps/api/src/durable-objects/workspace-do.ts` | `applyScopeGrantDirectory` and `listScopeGrantCandidates`, the typed RPC boundary; the second has no caller. |
| `apps/api/src/queues/activity-consumer.ts` | Applies a `scope_grant_directory` effect that arrives on the Queue. |
| `packages/contracts/src/conversation-effects.ts` | The typed parent effect carrying the grant. |

## How it works

A `scope_grant_directory` parent effect names a grant at a version; the
consumer hands it to `WorkspaceDO.applyScopeGrantDirectory`, which upserts the
row if the version is newer and keeps a revoked row as a versioned tombstone.
`scopeGrantCandidates` lists the parent ids where a person holds a live grant
under their current membership incarnation. A Canvas share's grant is written
by `ScopeGrantStorage` with the Canvas's own directory step, so no new effect
reaches this index.

## Invariants

- Revocation retains its version. Deleting the row would let a delayed
  addition recreate a stale candidate.
- Membership incarnation is part of lookup. Rejoining a workspace must not
  expose grants from the user's previous membership lifetime.
- A candidate is never access. Nothing may treat a row, or its absence, as an
  authorization answer; the owner's admission decides.
- The generic WorkspaceDO SQL API rejects this table. Only the typed projection
  and candidate RPCs own its lifecycle.

## Boundary

This module owns the index alone. Canonical grants and their receipts are
`ScopeGrantStorage`'s ([`scope-invitations.md`](scope-invitations.md)); who may
read a Canvas is `canvasAdmits` ([`authorization.md`](authorization.md)).

## Failure modes and limits

Identical deliveries are idempotent; older deliveries are ignored.
Equal-version conflicting payloads fail rather than silently selecting one.
Malformed addresses or hashes fail delivery. No numeric limits.

## Testing

`apps/api/test-workers/scope-grant-directory.test.ts` (`pnpm --filter @rally/api
test:workers`) projects queued grants without letting a late addition undo a
revocation, isolates membership incarnations and fences previous parent
generations, and retains legacy grants without a current relationship without
making them discoverable.

## Changelog

### 2026-11-07 — The index has no producer or reader left

**What changed:** The Channel host that wrote this index and the
`/sharing/directory` and `/sharing/navigation` routes that read it are deleted
(plan steps C-1 and C-2). A Canvas share's grant uses the Canvas's own
directory step, which adds the guest to the participant list, and writes no
row here; `listScopeGrantCandidates` has no caller.

**Why:** In the [Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)
a guest reaches what is shared with them through the workspace socket's
Canvas list, decided by each Canvas's audience, so there is no cross-parent
discovery for this index to narrow.

**Considered and rejected:** Writing Canvas grants here as well: nothing reads
the index, and the participant list is already the Canvas's answer.

**Consequences:** The table, the apply path and the candidate query stay so
an effect already in the Queue still lands; removing them is a WorkspaceDO
migration that drops `scope_grant_directory` with the consumer branch.

Shipped in juno-ai-labs/avalon#1490.

### 2026-09-28 — Admit every shared Channel in one Organization call

**What changed:** `listSharedNavigationDirectory` and `listSharedDirectory`
hand all of a person's candidate Channels to one
`WorkspaceDO.readSharedWorkstreams` call instead of calling
`readSharedWorkstream` once per Channel. The object loops its hosted parents
and answers in candidate order; each Channel's own admission is unchanged. The
single-Channel RPC is gone.

**Why:** Production measurements on 2026-09-27 showed `/sharing/navigation`
making one Organization call per shared Channel. The fan-out has the shape of
the time when each Channel was its own object (its reasoning is not otherwise
recorded); every Channel is now a hosted parent of the one Organization
object, so it was N round trips to the same place, and navigation latency grew
with the number of Channels shared with a person. It is now three calls in
total: candidates, admission, and Space marks — and no admission call when
there are no candidates, which is most members.

**Considered and rejected:** Folding the candidate lookup and the Space marks
into the same call. That would make one RPC decide discovery, admission and
containment together, where today each is a separately tested primitive; the
two remaining hops are constant, not per Channel.

**Consequences:** A candidate that fails `channelParent` (for example a Space
id) still fails the whole read, as one of the concurrent calls failing did
before. The batch reads its Channels one after another inside the object;
each read is local SQLite, so that costs less than one round trip did.

### 2026-09-23 — Project guest Breakout attention in opt-in navigation

**What changed:** The hierarchical navigation read can include a viewer-scoped
attention boolean for each canonically admitted conversation when the caller
opts in. Existing callers receive the old response shape.

**Why:** A guest with multiple Breakout grants could see only the selected
Breakout's badge. The guest does not have a Main control connection, so the
member child directory cannot fill the sibling rows.

**Considered and rejected:** Opening Main's control socket for child-only
guests would cross its authorization boundary. Fetching each Breakout detail
separately would add requests to navigation. The grant owner already holds
both projections alongside the admission decision.

**What a future change has to respect:** Only admitted conversations receive
attention state. The response is a snapshot and older strict clients must keep
the original shape unless they opt in.

### 2026-09-21 — Project shared Channels into guest Space navigation

**What changed:** `/sharing/navigation` combines canonically admitted shared
Channels with a bounded WorkspaceDO projection of their Space marks and
containment edges. Child-only shares include the Channel title only in that
hierarchical response, while Main and unshared siblings remain absent and the
compatibility response retains its prior nullable-title boundary.

**Why:** Two direct Breakout grants under Channels in different Spaces were
discoverable but collapsed into one flat browser list. The candidate index
could find each Channel, but it did not own either the canonical Channel label
or the Organization's Space placement.

**Considered and rejected:** Extending the strict compatibility response would
break older browser bundles, and returning the member Space directory would
release unrelated Space state. Trusting the service's requested Channel IDs
without re-intersecting them with the candidate index would make the RPC a
Space-name oracle.

**What a future change has to respect:** WorkstreamDO still decides which
Channel and Breakout labels may cross; WorkspaceDO returns Space presentation
only for visible Spaces containing those admitted Channel IDs, and the service
relationship-fences the combined response before returning it. An admitted
Channel with no visible placement remains valid; the browser keeps it reachable
under a local **Shared channels** fallback rather than treating containment as
access authority.

### 2026-09-19 — An absent candidate row is not absent access

**What changed:** A grant a Space seats is written with
`scope_grants.source_kind = 'space'` and does not invoke the projection writer,
so this index is now complete for direct grants and deliberately incomplete for
Space-derived ones. Direct provenance wins where both apply, in both directions:
a Space can neither claim a row the Channel already held directly nor deactivate
one, so such a row stays published.

**Why:** Every Channel in an Organization is in General, so publishing one row
per Space-derived reader per Channel would size this flat candidate index at the
Organization's membership times its Channels — and buy nothing, because that
reader finds the Channel through the Space directory rather than through here.

**Considered and rejected:** publishing them and filtering at read time. The
index exists to keep a directory read from scanning every parent; an index that
has to be filtered by a second authority is the scan it replaced, and it would
still have to be written.

**What a future change has to respect:** nothing may read a missing candidate
row as a negative answer. It narrows a search and the owner's admission decides,
which was always true of a stale row and is now true of a whole class of live
access. A feature that wants to *enumerate* a person's Channels has to ask the
Space directory as well, not tighten this one.

### 2026-09-17 — Discover independent shares through the existing outbox

Guests can hold unrelated grants under multiple parents, so the member directory
cannot serve as their discovery authority. A small WorkspaceDO candidate index
avoids scanning every parent. Reusing the durable parent outbox preserves retry
and ordering semantics without introducing a second transport. Canonical owner
admission remains mandatory because an asynchronous index can be stale. The
serving endpoint now performs that admission and withholds Main-derived labels
for independent child grants. Browser navigation consumes those results without
opening the member directory. Grant transactions now enqueue directly into that
outbox; retaining an intermediate delivery table and alarm duplicated its
responsibility. Migration 17 moves pending old intents transactionally before
retiring their alarm. Parent reads run concurrently with a final relationship fence.
