# Scope grant directory

The scope grant directory finds candidate workstreams for a user's current
workspace relationship. The Channel's parent, hosted in `WorkspaceDO`
([hosted conversation parents](hosted-conversation-parents.md)), remains the
grant authority; `WorkspaceDO` also stores a discovery projection. The projection alone never authorizes a read.
The lite browser consumes a canonical directory endpoint for shared navigation.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/scope-grant-storage.ts` | Grant mutation and existing parent outbox enqueue in one transaction. |
| `packages/contracts/src/conversation-effects.ts` | Typed parent effect carrying the grant. |
| `apps/api/src/queues/activity-consumer.ts` | Applies a grant effect that arrives on the Queue. |
| `apps/api/src/durable-objects/scope-grant-directory.ts` | Versioned projection and incarnation-specific candidate query. |
| `apps/api/src/durable-objects/workspace-do.ts` | Workspace identity checks, schema and typed RPC boundary. |
| `apps/api/src/routes/sharing.ts` | Authenticated compatibility `/sharing/directory` and hierarchical `/sharing/navigation` routes. |

## How it works

Every *direct* grant mutation invokes the parent's existing projection writer
within its SQLite transaction, including a claimed invitation. A grant a Space
seated before WorkspaceDO migration 94 does not
([a Space seats nobody now](authorization.md#space-derived-access)): it carries
`scope_grants.source_kind = 'space'` and the writer is suppressed for it,
because that reader discovers the Channel through the Organization's Space
directory instead. General holds every Channel in the Organization, so publishing one row per Space-derived
reader per Channel would size this index at the Organization times its
Channels. Direct provenance wins where both apply, in both directions — a Space
can neither claim such a row nor deactivate it — so a Channel a person also
holds directly stays published. The parent's `parent_outbox` row owns versioning
and retries. `WorkspaceDO` applies it to this index right after the write, with
no Queue hop and no separate delivery alarm; the alarm only retries an apply that
failed. The one-time import of each legacy parent republished its direct
grants, deduplicated against the projection keys it carried, so a delivery the
legacy object never sent was not lost.

The WorkspaceDO index supplies candidates only, and it is one of two sources:
a Channel where this person may list a Breakout but cannot see the Channel
itself is a candidate too, read from `breakout_viewers`. That is how
a member seated in a legacy Breakout of a Channel they cannot read finds it;
the parent's `canReadConversation` then admits the Breakout alone.
Directory reads admit every candidate at its canonical parent in one
`WorkspaceDO.readSharedWorkstreams` call, which loops the hosted Channels
locally and answers in candidate order; each Channel still makes its own
admission decision. A final relationship
incarnation/revision check fences the combined response. For hierarchical navigation,
a child-only share names its Channel so the browser can place the authorized Breakout
under the right container, while Main, sibling Breakouts, Main participants and Main
transcript remain withheld. The compatibility directory scrubs that title back to
`null` unless Main is admitted, preserving its original response semantics. Channel
appearance is still withheld unless Main is shared. The hierarchical response then
asks WorkspaceDO only for the visible Space marks and containment edges of those
canonically admitted Channels. The response preserves parent archive state separately
from each conversation, so clients do not offer a child restore while its parent is
archived.
The desktop's guest navigation opts into `?attention=1` on `/sharing/navigation`.
The Channel's parent then derives one attention boolean from each *admitted*
conversation's common and requesting-viewer projections. The default response
keeps its previous shape for deployed clients with strict navigation parsers.
`?shell=1` adds each Breakout's `originTurnId` and each Space's `systemRole`
for the single-sidebar shell, behind a flag for the same reason.
This remains a navigation snapshot, refreshed on directory invalidation; it
adds no sidebar rows. The workspace socket lists a guest's Channels and Spaces
([`listing-rules.md`](listing-rules.md)); this read says which conversations of
each the guest holds, and so where a Breakout-only Channel opens.

## Invariants

- Grant mutation and outbox insertion are atomic. Otherwise a crash can
  make an accepted share permanently undiscoverable.
- Revocation retains its version. Deleting the row would let a delayed addition
  recreate a stale candidate.
- Membership incarnation is part of lookup. Rejoining a workspace must not
  expose grants from the user's previous membership lifetime.
- Candidates require current owner admission before returning product content.
  Queue lag must never extend access after revocation.
- The generic WorkspaceDO SQL API rejects this table. Only the typed projection
  and candidate RPCs own its lifecycle.
- The index is complete for direct grants and deliberately incomplete for
  Space-derived ones. An absent candidate row is not absent access, and nothing
  may treat it as a negative answer — it narrows a search, and the owner's
  admission is what decides.

## Boundary

This module owns discovery delivery and candidate indexing. Identity and active
relationships belong to D1; canonical grants belong to the Channel's parent in
`WorkspaceDO`. Claiming an
invitation is described in [scope invitations](scope-invitations.md). Browser
entry and its limited collaboration surface belong to
[browser client](browser-client.md). There is no new Queue or socket multiplexer.

## Failure modes and limits

A failed apply leaves the `parent_outbox` row in place, and the alarm retries
it. Identical deliveries are idempotent;
older deliveries are ignored. Equal-version conflicting payloads fail rather
than silently selecting one. Malformed addresses or hashes fail delivery.
Discovery can lag grant acceptance, but the direct shared link still uses the
canonical owner. No new numeric limits are introduced.

## Testing

Run the API workerd files `scope-grant-authority.test.ts` (deleted in plan step C-2),
`scope-grant-directory.test.ts` and `scope-grant-storage.test.ts` (deleted in plan step C-2). The authority
test refuses Queue transport, inspects the real persisted outbox, and delivers
its exact bodies through the production consumer. Receiver tests exercise
revocation ordering, replay, replacement incarnations and generation fences.
A populated migration test preserves both pending and inflight deliveries.
Negative controls remove the source handoff and stale-delivery guard separately;
the corresponding tests must fail. Additional canonical tests prove that a stale
candidate cannot expose revoked content, a child-only share releases its Channel
label only through hierarchical navigation without releasing Main, two shared
Breakouts in different Channels produce both visible containing Spaces with one
admission call whatever the number of Channels (a counted namespace from
`test-workers/helpers/counting-namespace.ts` records it), one batch withholds a
Channel while releasing the next in candidate order, a private
Space invisible to the guest is withheld, and unready/restricted children are absent.
Negative controls bypass canonical admission, truncate the admitted Channel set, or
flatten the browser's Space filter; the corresponding tests fail.

## Changelog

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
