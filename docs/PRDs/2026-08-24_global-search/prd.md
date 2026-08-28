# Global search

> Created 2026-08-24.
>
> One query field, opened from the sidebar titlebar or `⌘K` anywhere in the
> main window, that searches everything a person can already open and always
> ends by opening one thing or starting a work stream. Index and delivery
> design: [`design.md`](design.md). Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Avalon gains a transient, workspace-wide search palette. It searches work-stream
titles and descriptions, visible messages, meeting notes and transcripts,
document names and extracted contents, automations, people, and the small set of
actions already available from the sidebar. Results are grouped by kind and
open the existing destination; search does not become a route, feed, inbox, or
new place to read.

The searchable corpus is projected into one Turbopuffer namespace per workspace.
Turbopuffer provides BM25 full-text search, type-ahead prefix matching,
structured filters, result diversification, and a later path to hybrid search.
Cloudflare remains the product and trust boundary: Workers authenticate the
request, WorkspaceDO makes the final authorization decision, Queues deliver
index updates, and a Workflow performs backfills and rebuilds. Turbopuffer is a
disposable retrieval projection, never an authority.

## Motivation

Avalon deliberately has no channels, global inbox, or global activity feed. The
sidebar is therefore the only index of a workspace: pinned items followed by
recent work. That works for a small number of work streams and degrades
predictably as old work falls below the cursor-paged directory.

The sharper problem is content retrieval. Avalon already stores message text,
meeting transcripts, and extracted document contents for the agent, but a person
cannot search any of it. Someone who remembers that a pricing decision was made
can scroll or spend a model run asking the agent to perform a keyword lookup.
Search makes that remembered phrase sufficient.

The evidence is structural rather than measured. Avalon has no usage history or
search-quality dataset yet, so this PRD does not invent either. It chooses the
smallest architecture that removes the known product constraint, can be judged
with real use, and can be rebuilt from canonical data if the provider or schema
changes.

## Goals

1. Search opens from every main-window surface in one keystroke and closes
   without losing the person's place.
2. Names already cached by the client match immediately; server results add
   names outside the cached page and matches from body text.
3. A remembered phrase can find a visible message, meeting transcript, or
   extracted document and open the destination at the matching evidence.
4. Results are grouped by destination kind and contain at most one row per thing
   that can be opened, regardless of how many fragments matched.
5. A failed lookup can become a new work stream without retyping the query.
6. Search never reveals a destination the caller cannot currently open, through
   either a row, a snippet, ranking displacement exposed to the client, or a
   result count.
7. Canonical writes never wait for Turbopuffer and never fail because indexing
   is delayed or unavailable.
8. Global and EU workspaces keep their search corpus in their own approved
   region, with no cross-region query or replication.

## Non-goals

1. **No search-results route, persistent results view, saved search, or keyword
   feed.** A search exists only while the palette is open. A persistent search
   surface would recreate the global inbox/activity feed the product rejects.
2. **No cross-workspace or cross-region search.** A query is bound to the active
   workspace and its immutable region.
3. **No live search of Slack, Gmail, Notion, or another connector.** Only content
   Avalon has ingested is indexed. Searching a provider directly remains an
   agent-tool action with separate authorization.
4. **No semantic retrieval in V1.** Turbopuffer can add vectors and hybrid
   ranking later, but V1 is BM25 and prefix search. Semantic recall adds an
   embedding model, a second relevance variable, and cost before Avalon has a
   query set with which to judge it.
5. **No agent memory, reasoning, tool arguments, tool results, terminal output,
   or system-only parts.** Only text already visible to people may be projected.
6. **No find-in-page within the open transcript.** That is a separate surface
   with next/previous and in-place highlighting behavior.
7. **Not a general command palette.** The actions group mirrors the sidebar's
   existing primary actions; it is not an open command registry.
8. **No search operators or typed filter language.** Group scoping is the only
   V1 filter. `from:`, `in:`, dates, and status filters are deferred.
9. **Archived work streams and notes stay hidden.** Reintroducing archived work
   requires an explicit product decision and filter.
10. **No second local full-text index or provider abstraction.** Avalon builds
    directly against Turbopuffer. The exit strategy is a deterministic rebuild
    from canonical sources, not two implementations maintained in parallel.
11. **Cloudflare AI Search is not the V1 index.** It now offers keyword and
    hybrid retrieval through a Workers binding, but its current metadata model
    permits only five custom fields and cannot filter stored arrays. Avalon's
    result kinds, destination identities, versions, scopes, and participant ACLs
    need a richer structured document. Revisit it when those constraints change;
    do not wrap both providers now.

## Product behavior

### Opening and closing

A magnifying-glass button sits in the sidebar titlebar. Clicking it or pressing
`⌘K` (`Ctrl+K` off macOS) opens a centered palette over the current main-window
surface with focus in its query field. `Esc`, clicking the scrim, or opening a
result closes it and restores focus appropriately.

Settings and meeting notes use standalone Electron windows without the app shell
or a route to work-stream destinations. Search is absent there until Avalon has
a deliberate main-window navigation bridge.

### Empty, typing, and populated states

With an empty query the palette shows the same pinned-then-recent run used by
the sidebar's `⌘1`–`⌘9` shortcuts, followed by actions. Nothing is fetched.

As the person types, locally cached names match immediately. After the query
settles and contains at least two characters, the regional API queries the
workspace's Turbopuffer namespace. Remote results replace or enrich local rows
by stable destination identity; they never append a duplicate.

Groups appear in this order when non-empty:

| Group | Searchable evidence | Destination |
| --- | --- | --- |
| **Work streams** | title, description, preview, visible messages | the work stream, anchored to the best message when applicable |
| **Automations** | template/subscription name and description | the automation |
| **Meeting notes** | title, briefing, visible transcript segments | the note, anchored to the evidence when applicable |
| **Documents** | title and extracted content | the document/resource |
| **People** | cached member name | the workspace-member surface |
| **Actions** | the fixed sidebar action set | the existing action |

Each remote row shows the destination title, kind-specific metadata, and at most
one bounded plain-text snippet when body evidence produced the match. Snippets
are rendered as text with client-applied highlights, never as Markdown or HTML.

The result unit is the destination, not the fragment. Five matching messages in
one work stream produce one work-stream row. Turbopuffer keeps fragments
separate for incremental writes and evidence ranking, then `limit.per` restricts
the ranked response to one fragment for each `(result_type, result_id)` pair.

Each group previews five rows. `→`, the group heading, or its **more** affordance
scopes the palette to that group without creating a route or changing the query.
The scoped view exposes at most the best 50 authorized destinations and asks the
person to refine the query if more may exist. `←` returns to all groups; `Esc`
still closes the palette.

One row is always selected. Before the person moves the selection it follows
the best result as remote evidence arrives; after the first `↑` or `↓`, arrival
of a response cannot move it. `⏎` opens the selection.

The final row for a non-empty query is always **Start a work stream:
“<query>”**. It becomes selected when nothing else matches, and `⌘⏎` invokes it
from anywhere in the palette.

### Loading, failure, offline, and freshness

There is no blocking spinner. Local matches remain visible while a quiet progress
line indicates that remote search is running.

If Turbopuffer, the regional API, or the network is unavailable, local results
stay usable and the palette says `Couldn't search message and document text.`
No fallback full-text engine runs and no error dialog interrupts the user.

The search index is eventually updated even though each Turbopuffer query uses
strong consistency. “Strong” means the query observes every write already
accepted by Turbopuffer; it cannot remove the delay before Cloudflare's indexer
delivers a canonical change. When the durable projection backlog is non-empty,
the response may say `Search is catching up on recent changes.`

Authorization is never eventual. Turbopuffer ACL attributes reduce the candidate
set, but WorkspaceDO rechecks every destination and the current visibility and
version of its matching source fragment before a title, snippet, count state, or
anchor reaches the client. A stale index may omit newly granted or newly written
content, but it cannot preserve access that has been revoked or quote text that
is no longer person-visible.

Search is a point-in-time `GET`; results do not live-update while the palette is
open.

## Impact on the product contract

This changes the implementation brief's opening sentence, which currently says
Avalon is organized around work streams “rather than channels, direct messages,
search, or a global inbox.” The prohibition is preserved at the product level
but narrowed from all search to search as an organizing surface.

When the first implementation ships, the sentence becomes:

> Avalon is an AI-native workplace communication and execution environment
> organized around concrete work streams rather than channels, direct messages,
> or a global inbox. Search exists as a transient way into something a person
> can already open; it is never a results route, keyword feed, or second place
> to read.

The corresponding release gate in [`implementation-plan.md`](../../implementation-plan.md)
must change in the same implementation pull request. “Avalon has no global
activity feed” and “Viewing does not create participation” do not move.

## Decision log

None yet.

## Key design decisions

1. **Turbopuffer is the V1 search engine.** It supplies BM25, trailing-token
   prefix matching, array filters for ACL hints, per-destination diversification,
   strong reads, and an incremental upgrade path to hybrid retrieval. Public
   production use on large multi-tenant workspace corpora makes it a better fit
   than adopting a less-proven engine for minor query conveniences.
2. **One namespace per workspace.** A workspace is the natural isolation and
   deletion boundary. It prevents one customer's corpus affecting another's
   candidate scan and follows Turbopuffer's recommendation to use namespaces for
   isolated document spaces.
3. **Cloudflare owns correctness.** Turbopuffer returns candidates, not
   authorization decisions. The regional Worker authenticates; WorkspaceDO
   performs the final current-state check and produces the response.
4. **One physical document per searchable fragment; one result per
   destination.** Deterministic fragment IDs make upsert/delete idempotent, and
   `limit.per` over destination identity stops verbose work from crowding out
   other results.
5. **Cloudflare Queues carry live indexing; a Workflow carries history.** Live
   writes record an outbox intent after canonical commit and enqueue only a
   wake-up identity. The queue consumer batches current source snapshots into
   Turbopuffer. A resumable Workflow enumerates history for initial backfill or
   an operator-requested rebuild.
6. **The projection is disposable.** Turbopuffer contains no fact that cannot be
   regenerated from WorkspaceDO, WorkstreamDO/SubstreamAgent, or R2. An
   incompatible schema creates a new namespace generation, backfills it, and
   flips one WorkspaceDO pointer after validation.
7. **Lexical first, hybrid later.** V1 combines title and body BM25 with a small
   recency tie-break. Exact weights are chosen against a reviewed query set, not
   guessed in the PRD. Embeddings are added only when failed-query evidence says
   lexical recall is the problem.

## Data and regional impact

Search adds an external subprocessor for message, note, automation, and document
text. Production enablement therefore requires Turbopuffer's DPA, current SOC 2
Type II report, penetration-test material, subprocessor list, deletion terms,
and region commitment to pass Avalon's security review.

Each Avalon deployment uses credentials scoped to its own Turbopuffer
organization and an approved nearby region. Global and EU Workers never share a
key or namespace. Turbopuffer states that customer data remains exclusively in
the selected region; Avalon must make that contractual before enabling EU
workspaces. Namespace copy/export across regions is not used.

The API key is a server secret and never enters renderer configuration, logs,
Queue messages, or index documents. Queue messages contain opaque source
identities and versions; the consumer reads current text from its canonical
regional authority.

Deleting a source schedules deletion of its deterministic fragment IDs.
Deleting a workspace schedules deletion of its entire namespace after the
canonical workspace deletion is committed. Provider deletion is retryable and
observable; it never becomes the canonical deletion transaction.

## Security and trust model

1. Only `people`- and `both`-visible message parts are eligible for projection.
   Model/system parts and tool payloads never enter Turbopuffer.
2. Candidate queries include an ACL optimization: workspace-scoped documents or
   personal documents whose `viewer_ids` contains the caller. Missing or stale
   ACL attributes fail toward omission, not admission.
3. WorkspaceDO re-authorizes every returned destination using the same rule as
   opening it, then validates that the matching source still exists at that
   version and remains person-visible. A source kind without an explicit
   predicate is excluded. Provider text is never returned solely because its
   destination still exists.
4. If stale ACL data returns an unauthorized candidate, it is discarded and the
   server continues a bounded candidate scan. The client receives neither the
   discarded row nor Turbopuffer's raw match count. `hasMore` is true only after
   the server has found an additional canonically authorized destination.
5. Access revocation takes effect on the next query even while its index update
   is pending. Access grants may take the normal projection delay to appear.
6. Search text is untrusted input and is passed as data in Turbopuffer's JSON
   query expression, never interpolated into a filter or URL path.
7. Queries, titles, snippets, document names, and index payloads are prohibited
   from application logs and telemetry.

## Rollout

The `global-search` Flagship client feature flag fails closed.

**Phase 1 — surface and names.** Ship the palette, recents, client-side name
matching, people, actions, and Turbopuffer indexing for work-stream, automation,
note, and document metadata already owned by WorkspaceDO. This validates the
interaction and the end-to-end vendor path without moving message bodies.

**Phase 2 — body evidence.** Add visible messages, transcript segments, and
extracted document chunks through the same projection contract. Anchored opening
ships with message/segment search; a body match that opens at the destination's
tail does not meet acceptance.

**Phase 3 — relevance only if earned.** Build a small reviewed evaluation set
from non-sensitive synthetic examples plus team-authored expected results. Tune
field weights and recency against it. Add semantic/hybrid retrieval only if real
failed queries show a lexical recall gap; do not add it merely because the
provider supports vectors.

Before production enablement, run the acceptance corpus against both configured
regions, verify deletion, inspect a forced Queue failure in the DLQ, and complete
the vendor-security gate. Turning the flag off hides the surface immediately;
canonical writes and local navigation remain unchanged.

## Limits

Product limits fixed by this PRD:

| Limit | Value |
| --- | --- |
| Rows shown per group | 5 |
| Destinations exposed in a scoped group | at most 50 |
| Minimum query length for remote search | 2 characters |
| Maximum accepted query length | 200 characters, matching `GET /resources?q=` |
| Empty-query recents | 9, matching `⌘1`–`⌘9` |

The implementation must set, with platform arithmetic recorded in the
implementing change, the maximum indexed bytes per fragment, chunks per source,
Queue batch entities and bytes, candidates scanned during canonical
authorization refill, Turbopuffer request timeout, and Workflow page size. These
new paths may not ship unbounded, and this PRD does not guess the values.

No independent “search retention horizon” is introduced. Search follows the
canonical product lifecycle: retained content is searchable; deleted content is
removed. If cost later forces a recency horizon, that is a visible product-scope
change and requires a new decision rather than a defensive constant.

## Acceptance

1. `⌘K` opens the palette from home, a work stream, a note, and an automation;
   `Esc` restores focus. The sidebar glyph is usable in a real desktop window.
2. With no network request, an empty query shows the same nine-item
   pinned-then-recent run as the sidebar and typing a cached title finds it.
3. A phrase present only in an authorized message finds one work-stream row,
   shows plain-text evidence, and opens around that message even when it is not
   in the transcript's tail page.
4. Multiple matching messages in one work stream and multiple matching segments
   in one note still produce one result per destination.
5. A phrase present only in an authorized meeting transcript or extracted
   document opens the corresponding note or document.
6. Entering a group exposes its sixth result, returns at most 50 authorized
   destinations, and never displays an exact corpus total.
7. Personal work-stream, note, inbound-email, and document fixtures invisible to
   a second member produce no row, snippet, displacement state, or `hasMore`
   signal. A revoked member stops seeing a result on the next query while the
   ACL projection is deliberately held stale.
8. A once-visible message part that becomes `model`-visible or is deleted cannot
   return its old snippet while its stale index fragment is deliberately retained.
9. A workspace-scoped work stream remains searchable by a member with no viewer
   row, proving the authorization check follows workspace scope rather than
   participation alone.
10. If Turbopuffer is unreachable, local results and start-a-work-stream remain
   usable and canonical writes continue to succeed.
11. Queue redelivery cannot overwrite a newer fragment, resurrect a deletion,
    or create duplicate results. A forced permanent failure reaches the DLQ and
    leaves a repairable outbox intent.
12. Backfill resumes after interruption, indexes live writes while history is
    still running, and can rebuild into a fresh namespace generation before an
    atomic pointer switch.
13. Global test content never appears in the EU organization/region and EU test
    content never appears in Global. Workspace deletion removes its namespace.
14. With `global-search` disabled, the glyph is absent and `⌘K` does nothing.

Durable manual checks are added to [`e2e.md`](../../e2e.md); runtime-dependent
Queue, Durable Object, and authorization cases belong in the Workers suite.

## Telemetry

Three content-free events:

- `search_opened` — glyph or shortcut, and originating surface.
- `search_results_shown` — query-length bucket, rendered count per group,
  remote outcome (`arrived`, `failed`, `offline`, `catching_up`), and scoped kind.
- `search_result_opened` — kind and position, or `start_workstream`.

No event contains the query, title, snippet, document name, provider score, or
exact match total. The initial question is whether opening search converts into
opening work and whether body results are used enough to justify their indexing
cost.

## Open questions

1. **Does the creator of a personal work stream retain access after leaving it?**
   This is a pre-existing disagreement between the creator-inclusive and
   participation-only read paths documented in [`data-model.md`](../../data-model.md).
   Search must not create a third answer. Resolve the product rule before Phase
   1 and apply it to opening, listing, sockets, and search together.
2. **Which Turbopuffer regions and contractual controls pass Avalon's vendor
   review?** Global and EU production rollout remain blocked until the DPA,
   security evidence, deletion terms, region commitment, and separate
   credentials are accepted. A technical proof may use isolated test
   organizations with synthetic content before that review.
