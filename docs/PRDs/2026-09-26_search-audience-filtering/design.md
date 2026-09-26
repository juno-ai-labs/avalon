# Search audience filtering: design

> Companion to [`prd.md`](prd.md). Facts about Turbopuffer and Cloudflare were
> read from their documentation on 2026-09-26; each carries its link.

## The groups

A group is a name hashed to a UUID:
`uuid = first 16 bytes of sha256("rally-search-audience:v1:" + name)`, formatted
as an RFC 9562 version 8 (custom) UUID. One function,
`searchAudienceGroupId` in `apps/api/src/services/search-audience.ts`, builds
every group ID; nothing else hashes a group name.

| Group name | Who holds it (person side) | Which rows carry it (row side) |
| --- | --- | --- |
| `user:<userId>` | That user, when active in the Organization | Resources they uploaded |
| `members:<workspaceId>` | Every active member whose `access_class` is `member` (never a guest) | Resources whose provider makes them readable by every member (not attachment-gated) |
| `conversation:<parentId>/<substreamId>` | Everyone who may read that Channel/Space conversation (Main is substream `0`; a Breakout is its own substream) | Turns and captured links in it; resources attached in it |
| `sidekick:<automationId>` | Everyone who may read that Sidekick's conversations (all of its children share one reader set) | Turns and captured links in any of its conversations; resources attached in them |
| `connection:<connectionId>` | Everyone who may read that connection (not disabled; owner, or workspace-scoped and a member) | Every resource that connection synced |

Notes are never indexed, so no group covers them. Memory is not in Turbopuffer
and has no group.

## Person side: `readSearchAudience(userId, membership)`

A new WorkspaceDO RPC returns the searcher's group UUIDs. It is a read over
tables the object already holds, and the one place the person side is computed.
The route passes the request's trusted membership observation (active status,
`access_class`, incarnation), as the artifact-open route already does, so the
object does not re-read D1.

For an inactive or unknown relationship it returns an empty list, and the
search returns nothing.

Otherwise it returns:

1. `user:<userId>`.
2. `members:<workspaceId>`, when `access_class = 'member'`.
3. For each hosted parent conversation, `conversation:<parent>/<substream>`
   when the person may read it, decided the way canonical authorization decides
   it today, per substream:
   - **Grant-authority substreams** (a `parent_participant_migrations` row):
     `resolveScopedAccess` over `parent_metadata.scope`, `parent_children`
     status and audience, and `parent_grants` bound to the current incarnation.
     This is the same function canonical reads call, not a copy.
   - **Legacy Main:** workspace scope and `access_class = 'member'`, or an
     active participant in `channel_viewers`.
   - **Legacy Breakout:** an active row in `parent_breakout_members` for a
     `ready` child.
   Archived Channels and Breakouts stay readable, as today; the index's
   `archived` filter hides their rows at display.
4. For each non-deleted Sidekick in `automation_directory`,
   `sidekick:<automationId>` when:
   - it is workspace-scoped and the person is a member; or
   - the person is its author or its executor (`run_as_user_id`, added by this
     change); or
   - it is workstream-scoped and the person is an active participant of the
     owning Channel's Main, which is not archived. A workspace-scoped owning
     Channel does not widen this.
   - A guest qualifies only through the last rule, and only with a workstream
     grant on the owning Channel (management access), as today.
5. For each connection in `connector_connections` whose status is not
   `disabled`, `connection:<connectionId>` when the person owns it, or it is
   workspace-scoped and `access_class = 'member'`.

Juno Labs today: at most about 520 groups (320 parents, 154 children, 14
Sidekicks, 26 connections, plus two). Turbopuffer states no cap on the number
of values in a `ContainsAny` list, and its permissions guide claims "10 000s of
user ids without performance degradation"
([permissions](https://turbopuffer.com/docs/permissions)).

## Row side: who writes `audience`

Every producer writes `audience` beside the text and display it already writes,
from its own tables, through the one row-side function:

- **Turns and captured links** (SubstreamAgent): the conversation's own group,
  `conversation:<parentId>/<substreamId>`, or `sidekick:<automationId>` when the
  parent is a Sidekick. A conversation never moves, so these rows are never
  patched.
- **Resources** (WorkspaceDO `prepareResourceSearch`):
  - connector-synced: `[connection:<connectionId>]`. A resource's connection
    never changes after insert, so never patched.
  - an upload not yet attached (a draft): `[user:<uploader>]`.
  - attachment-gated (an upload or generated artifact, or a Resend email):
    `user:<uploader>` plus the group of every location in the canonical
    inventory (`authorization_locations` for this resource).
  - every other provider: `members:<workspaceId>`, `user:<uploader>`, plus location groups,
    so a guest can still reach it through a conversation they may read.

  A resource's audience changes only when it is attached or detached, or when a
  draft is published. Those paths already bump `resource_search_versions`
  through the inventory outbox, so the existing re-projection rewrites the row.
  No separate patch job is needed if that holds; the build phase must confirm
  the trigger fires on location changes and add one if it does not.
- **Semantic chunk rows** copy `audience` from their document, as they copy
  every other attribute.

A row whose audience cannot be computed is written with an empty list and is
therefore invisible. It is logged with the source, so it is noticed.

## The query

`TextSearchIndex.readPage` adds one clause to its existing `And`:

```
["audience", "ContainsAny", <searcher's group UUIDs>]
```

and drops nothing else: `deleted`, `record_type`, `archived`, `source`,
`text IGlob` and the cursor stay. The per-source loaders stop calling
`checkMany`; they still validate each row's display attributes and literal
match, as today.

Hops per search after the change: D1 session read (unchanged); one WorkspaceDO
RPC `readSearchAudience`; one Turbopuffer query; D1 session re-read
(unchanged). Today's up-to-50 KV reads, the deferred fill, and its DO RPCs are
gone.

Filter behaviour, from Turbopuffer's documentation:
- Filters are served from an inverted index built from array elements
  ([write: filterable](https://turbopuffer.com/docs/write#param-filterable)).
- With a vector, the planner combines the attribute index with ANN and stays
  recall-aware
  ([query: filters](https://turbopuffer.com/docs/query#param-filters)).
- An empty array cannot be served by the index and forces a post-filter scan,
  which is one more reason an empty audience must mean no access
  ([permissions](https://turbopuffer.com/docs/permissions)).

## Memory search

`resolveMemorySearchAccess` stops constructing a `SearchAuthorizationResolver`.
It calls `resolveMemoryAccess`, the canonical check the run already relies on,
and filters the scope list with it. No subject with a `delegation` is ever
registered, so no key is created per run, and nothing is cached across runs.

## Every readability rule and where it lands

The canonical rules, from the readability survey, and how each is kept:

| Rule | Where it is enforced after this change |
| --- | --- |
| Guests never get implicit workspace-public access | Person side: `members` and workspace-scope conversations and Sidekicks require `access_class = 'member'` |
| Relationship status overrides every grant | Person side: inactive returns no groups |
| Grants bind the membership incarnation | Person side: `resolveScopedAccess` with the current incarnation |
| Not-ready conversation is unavailable, not denied | Person side: not listed; search omits it (search never distinguished the two) |
| Legacy versus grant authority per substream | Person side: chosen per substream exactly as `hosted-parent.ts` chooses |
| A Breakout's roster is independent of Main | Separate groups per substream; nothing inherits unless `inherits_workstream` is set, which is honoured through `resolveScopedAccess` |
| Resources: base facts AND (owned, or member-readable, or a readable location in the inventory) | Row side: audience lists exactly the uploader, `members` where the provider allows it, and inventory locations; connector rows carry only their connection |
| Negative resource decisions need complete discovery | Row side: a resource whose locations are not yet discovered carries only what is known, so it is invisible to location readers until discovery lands (fails closed, as today's `unavailable`) |
| A disabled connection denies everyone | Person side: disabled connections are never listed |
| Archive differs by kind | Channels and Breakouts: readable, hidden at display by `archived`; Sidekick inheritance: dropped when the owning Channel is archived |
| Sidekick guests need management on the owning Channel | Person side, item 4 |
| Existence is part of the proof | Person side: only existing, non-deleted parents, children and Sidekicks are listed |
| Memory is keyed by execution principal and parent | Memory search, above |
| Role never grants reads | Not consulted on either side |
| Space membership is copied onto each Channel | Nothing new: Space-derived readers are already seated as participants or `source_kind = 'space'` grants, which the person side reads |

Known differences from today, which the differential test asserts rather than
hides:
- guests lose search access to workspace-connector rows (PRD decision 7);
- the legacy Main roster is read from `channel_viewers`, the WorkspaceDO copy
  the current push universe already reads, not from the main SubstreamAgent;
  its lag is the directory projection's.

## What is deleted

In the final phase, and not before the read path has moved:

- `SearchAuthorizationResolver`, `pushSearchAuthorization`,
  `createSearchAccessContext`, `searchAuthorizationKey`, the
  `search_authorization_push_v1` job and its consumer branch.
- `durable-objects/search-authorization-universe.ts`,
  `durable-objects/search-authorization-projection.ts`.
- WorkspaceDO RPCs `registerSearchAuthorization`,
  `listSearchAuthorizationSnapshots`, `writeSearchAuthorizationSnapshots`,
  `readSearchAuthorizationSnapshots`, `enumerateSearchAuthorization`, and the
  alarm's push flush.
- Tables `search_authorization_keys`, `search_authorization_dependencies`,
  `search_authorization_push`, `authorization_snapshots`, and their triggers,
  dropped by a forward migration.
- `AUTHORIZATION_CACHE` reads and writes for search, and the binding once
  nothing else uses it.
- The `authz_push_*` logs and the KV visibility probe script.

The authorization discovery pipeline (`authorization_inventories`,
`authorization_locations`, backfill) stays: the row side reads it.

## Testing

- **Differential test (the gate for phase 3).** A `test-workers/` suite builds
  an Organization in real workerd covering every row of the rule table: members
  and guests; workspace and private Channels; legacy and grant-authority
  substreams; Breakouts; Sidekicks of each scope with author, executor and
  owning-Channel readers; attached, draft, member-readable and connector
  resources; disabled connections; suspension; re-added members with a new
  incarnation. For every (person, row) pair it asserts that "the person's groups
  intersect the row's audience" equals canonical `AuthorizationService.checkMany`
  returning `allowed`, except for the listed differences, which it asserts
  explicitly. Proved able to fail by breaking one person-side rule (for example
  dropping the guest check on `members`) and watching it fail.
- **Query test:** the audience clause against a disposable live Turbopuffer
  namespace, confirming `ContainsAny` over `[]uuid`, that a row with an empty
  audience never returns, and that the clause composes with `IGlob` and the
  cursor.
- **Backfill check:** a Turbopuffer count of live rows with a null or empty
  `audience` must be zero in each region before phase 3.
- **Memory:** an existing memory-search test extended to assert no row is
  written to the decision store and no key per run.

## Limits handed back

No new defensive limit is introduced. The platform limits this design leans on,
transcribed with their sources:

- `patch_by_filter` affects at most 50,000 rows per request
  ([limits](https://turbopuffer.com/docs/limits)); resource audience changes
  use the re-projection by ID, not `patch_by_filter`.
- Max concurrent queries per unpinned namespace: 16
  ([limits](https://turbopuffer.com/docs/limits)); unchanged by this design,
  which adds no queries.
- A Durable Object's soft limit of 1,000 requests per second
  ([Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/));
  this design adds one read RPC per search and removes about 130,000 RPCs a day
  from the Juno Labs object.

## When to revisit a separate store

The person-side function is the only thing that would move to Postgres (via
Hyperdrive) or to a per-person KV list. Move it when either is measured:

- `readSearchAudience` wall time is a visible share of `search_response_timing`
  on the searches that reach the Worker; or
- a person's group list grows large enough that Turbopuffer query latency
  climbs measurably with it.

Neither needs a number set now; both are read from logs that already exist.
