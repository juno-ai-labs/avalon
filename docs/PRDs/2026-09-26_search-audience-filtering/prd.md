# Search audience filtering

> Created 2026-09-26.
>
> Member search decides who may see a result inside the Turbopuffer query, by
> matching the audience groups stored on each row against the searcher's
> groups, and stops storing a decision per person per document.
> Companion architecture: [`design.md`](design.md). State: [`state.md`](state.md).
> Standing contract: [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [authorization](../../authorization.md),
> [text search](../../text-search.md),
> [hosted conversation parents](../../hosted-conversation-parents.md) and
> [realtime sockets](../../realtime-sockets.md#an-instance-that-stops-hearing-its-sockets).

## Summary

A member's search results come back already limited to what that member can
read. Each Turbopuffer row carries the groups that can read it: the
conversation it lives in, the Sidekick that owns it, the connection that synced
it, the person who uploaded it. Each search passes the searcher's own groups as
one more filter. Turbopuffer returns only rows the searcher can read, so every
page is full and nothing is checked per result afterwards.

The per-(person, document) decision store goes away: the `search_authorization_*`
tables and `authorization_snapshots` in WorkspaceDO, the search push jobs, the
KV decision cache, and the resolver that reads them. Memory search, which shares
that store today, checks access directly when an agent run starts.

What a person notices: no empty or sparse pages; a new member, Channel or share
is searchable at once instead of after a push; a removal takes effect on the next
search instead of within the push delay.

## Motivation

The decision store is the single largest source of load on the busiest
WorkspaceDO in production, and most of that work changes nothing.

Evidence from Juno Labs (Organization `019fc068…`, WorkspaceDO `0922ab31…`),
read from production on 2026-09-26:

- **The store is small; the work is not.** It holds 6,738 keys for 6 people.
  In the 24 hours to 16:00Z on 2026-09-26, push jobs re-checked about 152,000
  keys, which is the whole store about 22 times. About 78% came out unchanged,
  about 18% were superseded by another push, and about 5% changed a decision.
- **Two search-authorization RPCs dominate the object.** About 82,000
  `registerSearchAuthorization` and 44,000 `writeSearchAuthorizationSnapshots`
  calls a day, 7.3 hours of wall time between them. #976, which stopped pushes
  superseding each other, cut the KV write time by about two-thirds but left the
  call counts where they were (89,000 and 50,000 on 2026-09-24).
- **Memory search leaks keys without bound.** A memory search subject carries
  the agent run ID in its `delegation`, so every run registers keys no later
  request reuses. Each new key's pending row queues a push of the whole memory
  scope. One scope has 628 keys (3 people across hundreds of runs) and was pushed
  109 times in a day, about 580 keys each time. The cost grows with the square
  of the run count.
- **Parent pushes still fight.** 122 parent pushes superseded 26,249 keys in the
  same day, mostly on two Channels.
- **The object that carries this load stopped hearing its sockets twice.** On
  2026-09-23 and 2026-09-24 this object accepted socket upgrades for hours while
  running no socket handler; both stalls persisted across deploys and fresh
  instances. The root cause is not proven, and a Cloudflare ticket is the
  separate path for it. The Sep 24 stall began at 21:30Z, as search-authorization
  RPCs peaked at about 22,000 per 10 minutes. Removing avoidable load from this
  object is worth doing whatever that ticket finds, and it is the most direct
  test of whether load was a factor.
- **The read path is costly too.** A search page reads up to about 50 KV keys,
  one per candidate, across up to 5 parallel batches, and then omits every
  candidate it cannot admit, which is why the modal needs a keep-scanning
  pagination loop over empty pages.

Leaving it costs the object's headroom every working day and guarantees the
memory leak keeps growing.

## Goals

1. A member search returns only rows the searcher may read, decided inside the
   Turbopuffer query, with no admission step after retrieval.
2. No state is stored per (person, document) pair anywhere. Search authorization
   writes happen only when a row's own location changes (a file attached or
   detached), never when a person's access changes.
3. A change to a person's access (joining or leaving a Channel, a share, a
   revocation, suspension) applies to that person's next search.
4. The decision store, the search push pipeline and the KV decision cache are
   deleted, not left idle.
5. Memory search stops registering per-run decisions and holds no cross-request
   authorization state.
6. The readers each row admits equal what canonical authorization admits today,
   proven by a differential test over the same fixtures, with the differences
   listed in this PRD and nowhere else.
7. A search makes at most one WorkspaceDO RPC for authorization, and no KV
   reads.

## Non-goals

1. **Finding the socket-stall root cause.** Handled separately with Cloudflare.
   This change removes load; it does not claim to fix the stall.
2. **Moving memory search to Turbopuffer.** Memory keeps Vectorize and its FTS.
   Only its authorization changes. Deferred.
3. **Changing canonical authorization.** Opening a result (a transcript, a file
   preview, an artifact) keeps its own canonical check. This change decides only
   which rows a search may return. Rejected as scope creep.
4. **A new database.** No Postgres or other store is added; the searcher's
   groups come from WorkspaceDO tables that already hold them. Deferred until a
   measured limit says otherwise; [`design.md`](design.md#when-to-revisit-a-separate-store)
   names the signal.
5. **Collapsing the duplicate copies of Channel scope and roster.** The main
   SubstreamAgent, the hosted parent tables and the WorkspaceDO directory each
   hold one. This change reads the WorkspaceDO directory copy, which the search
   universe already reads, and leaves consolidation to
   [hosted conversation parents](../../hosted-conversation-parents.md). Deferred.
6. **BM25 or semantic modes in the member modal.** The filter works for them and
   the semantic rows carry it, but the modal keeps literal substring search.
   Deferred.
7. **Re-checking a link row on click.** The 30-second desktop result window and
   the unchecked link open recorded in [text search](../../text-search.md) stay
   as they are. Deferred.

## Product behavior

The search modal (All, Messages, Links, Artifacts, Files) looks and behaves as
it does today, with these differences:

- **Populated:** every candidate page Turbopuffer returns is a page of readable
  rows. A page with a continuation is full; the keep-scanning loop over empty
  pages remains for legacy clients and stops being reachable in practice.
- **Newly readable:** a Channel someone was just added to, a share just
  accepted, a file just attached in a Channel they read: searchable on the next
  query once the row exists in the index (for attachment, once the audience
  patch lands, typically seconds).
- **Revoked:** a person removed from a Channel, a revoked share, a suspended
  member: those rows stop appearing on their next search. The desktop's
  30-second repaint window for an identical query is unchanged.
- **Empty and no-match:** unchanged.
- **Error:** if the searcher's groups cannot be read (WorkspaceDO unavailable),
  the search fails with the existing retryable 503 rather than returning an
  unfiltered or empty list.
- **Offline:** unchanged.

Agent memory recall behaves as today, minus the per-run registration.

## Impact on the product contract

None to what Rally is. This refines how search enforces access within the
existing contract. It does reverse two recorded engineering rules, stated here
so they are decided deliberately:

- [Text search](../../text-search.md#invariants): "an index attribute never
  grants access". After this change the `audience` attribute decides which rows
  a search may return. It still grants nothing beyond the row's excerpt: every
  way of opening a row keeps its own canonical check.
- [Authorization](../../authorization.md#changelog), 2026-09-10: readers-in-index
  was "rejected ... a larger reversal for the same outcome". The outcome turned
  out not to be the same: the per-pair store costs work proportional to people
  times documents on every change, and the index filter costs nothing per pair.

## Decision log

### 2026-09-26 — The four design decisions are approved as written

**Decided:** Morgan approved key design decisions 1 to 7 and the four open
decisions put to him: reverse "an index attribute never grants access" for
search; compute each person's groups live per search; narrow guests out of
workspace-connector rows; read classic Channel rosters from `channel_viewers`.

**Why:** Approval was given in the working session that wrote this PRD, before
its pull request merged.

**Changes:** Nothing in the agreed scope.

### 2026-09-26 — Attach and detach rewrite a resource through its existing re-projection

**Decided:** No separate audience patch job. WorkspaceDO migration 76 adds
triggers on `authorization_locations`, and the inventory writer now changes
only the location rows that differ, so an attach or detach bumps that
resource's search revision and the existing pipeline rewrites every row.

**Why:** Building phase 1 found that attach and detach never re-indexed a
resource at all: they change `authorization_locations`, which no search trigger
watched, and the resource update trigger did not watch `attachment_status`
either, so publishing a draft did not re-index it. A new revision rewrites the
lexical row and the semantic chunks with the new audience through machinery
that already handles races. The cost is re-embedding a resource's chunks on
each attach or detach; there were 226 locations in all at Juno Labs.

**Changes:** Supersedes the patch job [`design.md`](design.md) left open as a
fallback. Shipped in the phase 1 pull request.

### 2026-09-26 — The resource-type trigger watches only email-ness

**Decided:** Migration 76's update trigger reacts to a Resend resource becoming
or ceasing to be an email, not to every `resource_type` change.

**Why:** `resource_type` enters a resource's audience only through that rule.
Watching the whole column re-indexed connector resources whose type a
discovery pass rewrites, which an existing cost test forbids.

**Changes:** None to scope.

### 2026-09-26 — `run_as_user_id` moves to the person-side phase

**Decided:** `automation_directory.run_as_user_id` ships with the person-side
function (phase 3), not in phase 1.

**Why:** Only the person side reads it, and phase 1 is kept to what rows carry.

**Changes:** Rollout step 1 no longer includes it. It must land in or before the
deploy that switches the read path.

### 2026-09-26 — Existing semantic chunk rows gain `audience` only on their next content change

**Decided:** The phase 2 re-projection does not rewrite existing semantic chunk
rows. The pipeline skips a chunk whose deterministic ID already exists.

**Why:** Member search reads only the lexical namespace, so phase 3 does not
need them. Rewriting every chunk would re-embed the whole fleet.

**Changes:** Adds a precondition: any future semantic read path must first
backfill `audience` on chunk rows (for example with `patch_by_filter` per
source), recorded in [text search](../../text-search.md#changelog).

### 2026-09-28 — The person side reuses each parent's own conversation check

**Decided:** `readSearchAudience` decides every conversation through
`HostedParent.readableSubstreams`, which applies the parent's existing
`canReadConversation` (grant authority where a substream has migrated, the
legacy roster otherwise). The legacy Main roster is therefore the parent's own
participant projection, the copy `channel_viewers` is built from, rather than
that table itself. A guest reaches a workstream Sidekick only through
management access on its owning Channel (`HostedParent.managementAccess`).
The person's relationship is read from the object's own member table
(`readRelationship`), which carries the incarnation grant checks bind to,
rather than passed in from the route's membership observation. A Sidekick and a
connection are decided by predicates shared with canonical authorization
(`sidekickAdmitsMember`, `owningChannelAdmitsMember`, `connectionAdmits` in
`authorization-policy.ts`).

**Why:** One implementation per rule, which the security model requires, and no
new SQL that could drift from the parent's reads.

**Changes:** Refines "read classic Channel rosters from `channel_viewers`" to its
source; same data, same lag.

### 2026-09-28 — The phase 3 gate test is a rule table, not a comparison with `checkMany`

**Decided:** `test-workers/search-audience-person.test.ts` asserts each person's
exact groups against the rule table in [`design.md`](design.md) rather than
comparing with `AuthorizationService.checkMany` per pair.

**Why:** Canonical legacy-Main and Sidekick decisions read the main
SubstreamAgent and the SidekickDO, which a WorkspaceDO fixture does not host,
so a per-pair comparison would compare against `unavailable`. The table covers
legacy and grant-authority Channels, a guest admitted by a grant and by
management access, and a re-added member whose grant is from an earlier
membership.

**Changes:** The differential test described in the design is narrowed to this.

### 2026-09-28 — Existing Sidekicks publish their executor once

**Decided:** SidekickDO migration 10 republishes each Sidekick's directory row,
as migration 3 did, so `automation_directory.run_as_user_id` (WorkspaceDO
migration 81) fills in as each Sidekick wakes. Until then an executor who is not
also the author reads that Sidekick's conversations through the other rules only.

**Why:** The directory is fed only by each Sidekick's own outbox.

**Changes:** None to scope.

## Key design decisions

1. **Rows carry where they live, not who can read them.** A row's audience is
   its conversation, its Sidekick, its connection, its uploader, and for a
   resource the conversations it is attached to. People's memberships live on
   the person's side. So adding or removing a person, sharing, revoking, or a
   Channel changing scope patches no rows. *Rejected:* storing reader user IDs
   on rows, which is Turbopuffer's simplest example but would patch every row of
   a Channel on every roster change, and each patch is billed at least one query
   over the whole namespace.
2. **Organization-wide access is on the person's side too.** A member's groups
   include every workspace-scoped conversation they can read, rather than rows
   carrying an "everyone" flag that must be patched when a Channel's scope
   changes. The one exception is a property of the row itself: a resource whose
   provider makes it readable by every member carries the `members` group.
   *Rejected:* an `is_public` row flag for workspace-scoped Channels; scope
   changes would need patches, and the person-side list stays small (Juno Labs:
   about 520 groups at most).
3. **The searcher's groups are computed live, on every search, in one WorkspaceDO
   RPC.** It is one read over tables the object already holds, is strongly
   consistent, and replaces today's up-to-50 KV reads. *Rejected for now:* a
   per-person KV list, which adds a write pipeline and 60-second KV propagation;
   and Postgres, which adds a stateful service per region. Either can replace
   the one function later without touching rows or queries.
4. **Groups are stored as UUIDs** derived by hashing the group's name,
   because Turbopuffer's permissions guide says string arrays are "slower and
   more expensive".
5. **An empty audience means no access.** A row the producer could not place
   is invisible, never public. Organization-wide readability is the explicit
   `members` group.
6. **Memory search checks access canonically per run** through the existing
   `resolveMemoryAccess`, the check the run already performs, and caches nothing
   across runs. A run-keyed decision is by construction never reused.
7. **Guests do not get workspace connections.** Today the `connection` decision
   skips the guest rule that every other path applies, so a guest can find
   workspace-connector rows through search but not through the resource path.
   The person-side list applies the guest rule uniformly. This is a deliberate
   narrowing for guests.

## Data model

- **Turbopuffer, lexical and semantic namespaces:** one new attribute,
  `audience`, type `[]uuid`, filterable. Written by every producer on every
  upsert, and patched by id when a resource's attachment locations change.
- **WorkspaceDO:** no new tables. `automation_directory` gains
  `run_as_user_id` so a Sidekick's executor can be listed without a SidekickDO
  read. The `search_authorization_keys`, `search_authorization_dependencies`,
  `search_authorization_push` and `authorization_snapshots` tables, their
  triggers, and migration 46's pending trigger are dropped in the final phase.
- **KV:** the `AUTHORIZATION_CACHE` keys written for search are no longer read
  or written; the binding is removed once no reader remains.
- **Backfill:** every existing row needs `audience`, through a re-projection in
  the deploy after the field ships, per the text-search version-skew rule.

## Regional impact

None across regions. Each regional API Worker queries its own region's
Turbopuffer namespaces, and each Organization's WorkspaceDO computes its members'
groups in the region where it already lives. Nothing new crosses a region
boundary and no data comes to rest anywhere new.

## Security and trust model

- The trust boundary moves from "admit each candidate after retrieval" to
  "retrieve only admitted rows". A bug in computing a person's groups or a row's
  audience now shows rows instead of hiding them. Two controls address that:
  one function computes each side (no second implementation), and a
  differential test compares both against canonical `AuthorizationService`
  decisions on fixtures covering every rule in
  [`design.md`](design.md#every-readability-rule-and-where-it-lands).
- A row's excerpt remains the only content a search exposes. Transcript
  hydration, file preview and artifact open keep their canonical checks.
- Failing closed: an unknown audience is invisible; a failed group read is a 503.
- Group UUIDs are hashes of internal IDs, not secrets; the namespace is still
  per Organization, so a group ID from another Organization matches nothing.

## Rollout

Ships to everybody with no flag, per the default. Order is forced by the
version-skew rule in [text search](../../text-search.md#version-skew-between-producers-and-the-consumer):

1. Producers write `audience`; attachment changes queue an audience patch;
   `automation_directory` gains `run_as_user_id`. Search still reads the old
   store.
2. Next deploy: re-projection migrations rewrite every row with `audience`.
   Force the migration in each region and verify, with a Turbopuffer count, that
   no live row lacks the attribute.
3. The read path switches to the audience filter and memory search to direct
   checks. The old store stops being written and read.
4. Drop the old tables, triggers, push pipeline and KV usage.

Turning it off between phases 3 and 4 is a Worker rollback: the old store is
still intact and simply stale for the time it was not written, so a rollback
should be followed by a full push (migration 48's pass). After phase 4, rollback
is a code revert plus that pass.
