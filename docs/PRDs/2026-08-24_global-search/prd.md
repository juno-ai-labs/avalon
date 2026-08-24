# Global search

> Created 2026-08-24.
>
> One query field, opened from the sidebar titlebar or `⌘K` anywhere, that
> crosses work streams, messages, meeting notes, documents, automations, people,
> and actions, and always ends by opening one of them. Index mechanics and the
> projection design: [`design.md`](design.md). Standing contract:
> [the Avalon implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A magnifying glass sits in the sidebar titlebar, left of where the sidebar list
begins and clear of the traffic lights. Clicking it — or pressing `⌘K` from any
surface — opens a single query field over whatever is on screen. One query
searches everything the person can already read: work-stream titles and
descriptions, the messages inside them, meeting notes and their transcripts,
documents by name *and by content*, automations, the people in the workspace,
and the handful of things Avalon can start. Results arrive grouped by kind with
one top hit selected; `⏎` opens it, `⌘⏎` starts a work stream from the query
text, `Esc` closes. Nothing is added to the app's navigation: the palette is a
transient overlay that always terminates in a work stream, a note, a document,
or an automation.

What becomes possible that was not before is retrieval of *content*. Today a
person can reach a work stream only by recognising its title in the sidebar's
activity-ordered list. The words inside it — a decision in a message, a passage
in a meeting transcript, a paragraph in an uploaded contract — are extracted,
stored, and made available to the agent, and are reachable by no one else. After
this change, a half-remembered phrase is enough.

## Motivation

**Avalon deliberately removed every other way of finding things.** There are no
channels, no direct messages, no global inbox, and no global activity feed. The
sidebar is the entire index: **Pinned**, then work streams and notes in
last-activity order, with `⌘1`–`⌘9` bound to the first nine of that run
(`apps/desktop/src/renderer/components/sidebar.tsx`). That is a complete answer
for someone holding a handful of work streams, and it degrades in a specific,
predictable way as the count grows: the list is cursor-paged and loads more as
it is scrolled, so a work stream that has been quiet for three weeks is reached
by scrolling past everything that has been busy since.

**The content is unreachable by construction, not by omission.** Avalon already
extracts and stores the text this change would search, for the agent's benefit:

| Text | Where it already is |
| --- | --- |
| Work-stream titles, descriptions, and previews | `workspace_workstream_directory` in WorkspaceDO |
| Messages | `parts.content` in each `SubstreamAgent` |
| Meeting notes and their transcripts | `notes`, `note_transcript_segments` in WorkspaceDO |
| Document contents | `resources.model_content_ref` → R2, with a character count and an extractor version |
| Automations | `automation_templates`, `automation_subscriptions` in WorkspaceDO |

Every row of that table is loadable by the agent as context and by nobody as a
person. The asymmetry is the problem: a member who remembers that *someone
worked out the pricing tiers* can ask the agent to go and find it — spending a
model run, and a wait, on a keyword lookup — or can scroll. `docs/assumptions.md`
has described the work-stream metadata as "searchable" since the object schemas
were written; nothing has ever searched it.

**The evidence here is structural rather than measured, and this document does
not pretend otherwise.** Avalon has no usage history, no metrics stack, and no
support corpus to cite ([`AGENTS.md`](../../../AGENTS.md#where-we-are)); the
first workspaces are small enough that the sidebar still works. The argument is
about the shape of the product rather than about a measurement: an organizing
principle that replaces the inbox is only affordable if finding is cheap, and
finding is currently the one thing Avalon asks a person to do by hand. Waiting
for the measurement means waiting until every early workspace has already learnt
to route around it.

## Goals

1. Search opens in one keystroke from every surface, and closes in one, without
   navigating away from what the person was doing.
2. Names match as the person types, with no perceptible wait: work streams,
   automations, meeting notes, documents, people, and the actions Avalon can
   start.
3. Body text is searchable — messages inside work streams, meeting notes and
   their transcripts, and the extracted contents of documents — so that a
   remembered phrase finds the work it was written in.
4. Results are grouped by kind, ordered within each group by relevance and
   recency, with exactly one row selected so that `⏎` is always meaningful.
5. A query that matches nothing still ends in an action: starting a work stream
   with that text, without retyping it.
6. Search never surfaces anything the person could not already open, and the
   result counts it displays leak nothing about what it filtered out.
7. Search remains a way *into* a work stream and never becomes a place to read
   from: no results route, no persistent view, no second home screen.

## Non-goals

1. **No standalone search-results route or persistent results view.** Rejected
   outright, not deferred. A durable, addressable list of everything recently
   matching a query is the global activity feed the product contract forbids,
   reached through a text box. Results live in a transient overlay that closes
   when something is opened.
2. **No saved searches, pinned searches, or server-stored search history.**
   Deferred. Each carries the same risk as non-goal 1 in miniature — a saved
   search is a channel you subscribed to by keyword.
3. **No cross-workspace search.** Out of scope: V1 has no workspace switcher
   ([`data-model.md`](../../data-model.md)), so there is no second workspace to
   search from.
4. **No cross-region search.** Rejected permanently. A workspace's region is
   immutable and its content stays in it
   ([`regionalization.md`](../../regionalization.md)); a query that spanned
   Global and the EU would be a data-residency breach wearing a search box.
5. **No search of a connector's own corpus.** Rejected as a product boundary.
   Typing `launch` does not search all of Slack, Gmail, or Notion. Only
   resources Avalon has actually ingested as `resources` rows are searchable;
   reaching further into a provider is what the agent's connector tools are for,
   and it is a different act with different authorization.
6. **No semantic or vector search.** Deferred. `MEMORY_INDEX` and the Workers AI
   binding exist and could embed this corpus, but that is a second index, a
   second write path, and a per-query inference cost, in service of a recall
   improvement nobody here can currently measure. Keyword search is the cheaper
   thing to reverse. See key design decision 2.
7. **No agent memory items in results.** Rejected. `memory_items` is the agent's
   working state about a workspace, already FTS-indexed for the agent's own
   retrieval; exposing it in a person's search surface makes an internal
   representation into a product one.
8. **No tool calls, tool results, terminal output, reasoning, or system parts in
   message results.** Rejected for this change. The line is the existing
   `parts.visibility` column: `people` and `both` are searchable, `model` and
   `system` are not. A person searching for their own words should not have to
   scroll past a tool's JSON.
9. **No first-party activity events (`workspace_activity_events`) in results.**
   Rejected. Ranking recent activity by keyword *is* the global activity feed,
   and it would arrive without anyone deciding to build one.
10. **No find-in-page within an open work stream's transcript.** Deferred, and
    genuinely wanted — but it is a different surface with a different
    interaction (in-place highlight, next/previous, scroll-to-match) that would
    distort this one if bolted on.
11. **Not a general command palette.** Actions are limited to what the sidebar
    already offers — **New work stream**, **New automation**, **New
    meeting/notes**, **Settings** — plus starting work from the query text.
    Deferred: exposing arbitrary app commands here is a separate argument about
    discoverability, and every command added is a row competing with a real
    result.
12. **No search operators or filter syntax.** Deferred. `from:`, `in:`, `is:`
    and friends are the natural second version; shipping them in the first makes
    the query field a language to learn before it is a box to type in.
13. **Not available signed out or on the public site.** Out of scope: search
    runs against one workspace under an authenticated session.
14. **Archived work streams and archived notes do not appear.** Deferred, and
    called out because it is the first thing someone will ask for: archiving is
    currently how a person says "stop showing me this", and search re-showing it
    would undo that. Revisit behind an explicit filter, which is non-goal 12.

## Product behavior

### Opening it

**The glyph.** A magnifying-glass `IconButton` sits in `.sidebar-titlebar` — the
48px strip above the sidebar list that today holds nothing on desktop and exists
only as a window-drag region. The glyph is placed at the strip's leading edge,
inset clear of the macOS traffic lights at `x: 18, y: 17`, and carries
`window-no-drag` so that it is clickable rather than draggable. Its accessible
label is `Search`. On hover it shows the `⌘K` hint the sidebar's other affordances
use.

**The shortcut.** `⌘K` (`Ctrl+K` off macOS) opens search from every surface —
home, a work stream, a note, an automation, settings. It is captured at the
window, so it works while the composer has focus; it is the one shortcut that
takes precedence over a focused text field, because a person reaching for search
mid-sentence means search.

**Closing.** `Esc` closes and returns focus to whatever had it. Clicking the
scrim closes. Opening a result closes.

**Interaction with `⌘1`–`⌘9`.** The palette is a `role="dialog"`, and the
sidebar's numbered-shortcut handler already refuses to navigate while a dialog is
open. That is the correct behavior and this change relies on it rather than
working around it: while search is open, digits are query text.

### The overlay

A centered panel over a scrim, above all surfaces, at the app's dark-surface
tokens. It holds a single unlabelled query field with the magnifying glass at
its leading edge and an `Esc` affordance trailing. Results fill the panel below
the field. A footer row states the three keys that do something: `↑↓ NAVIGATE`,
`⏎ OPEN`, `⌘⏎ START`, with the count of results not shown on the right.

The panel does not resize as results arrive — it holds a stable height so that
the row under the cursor does not move while the person is still reading it.

### States

**Empty query.** Recents, under a **Recent** heading: the same pinned-then-recent
run `⌘1`–`⌘9` is bound to, so the two affordances agree about what "recent"
means. Beneath it, the actions group. Nothing is fetched; this is the cached
sidebar directory.

**Typing.** Local name matches paint on the first keystroke, from the directory
the sidebar already holds — work streams, notes, automations, people, actions.
No request has been made yet, so this is instant and works offline. Remote
matches — message bodies, note transcripts, document contents, and names beyond
the locally cached page — are requested as the query settles and merge into their
groups when they arrive.

The selected row is tracked by its identity, not its index. An arriving group
never changes what `⏎` would open.

**Populated.** Groups appear in this order, and a group with no matches is
omitted entirely rather than shown empty:

| Group | A row is | Right-hand metadata |
| --- | --- | --- |
| **Work streams** | title and description match | exact state and relative last activity — `Needs input · 4m` |
| **Automations** | template or subscription name match | `Active · You`, `Draft`, `Active · Workspace` |
| **Messages** | a message body match | the work stream it is in, and when |
| **Meeting notes** | note title, briefing, or transcript match | `Recorded · Jul 28` |
| **Documents** | resource title or extracted-content match | provider and relative time — `Google Docs · 4m ago` |
| **People** | a workspace member | their role |
| **Actions** | something Avalon can start | the key that runs it |

Each row shows an icon for its kind, its title with the matched span
highlighted, and the metadata above. A row that matched on *body* rather than
name additionally shows one line of surrounding text with the term highlighted,
so that the reason it matched is visible without opening it.

**Top hit.** The single highest-ranked row across all groups is selected when
results settle, so `⏎` is meaningful without the person pressing `↓` first.
Ranking is relevance first — a title match outranks a body match, a whole-word
match outranks a prefix — and recency second, which breaks ties the way the
sidebar already orders itself.

**Truncation.** Each group shows at most **five** rows. The count of everything
matching but not shown appears in the footer as `N MORE RESULTS`. That count
counts only results the person may see; it is computed by the same filtered query
that produced the rows, never by counting before authorization.

**No matches.** Search never shows an empty panel. The action row **Start a work
stream: "<query>"** is always present and always last, and becomes the selected
row when nothing else matched. `⏎` on it opens the new-work-stream surface with
the query already in the composer — the same optimistic hand-off
[`workstream-creation.md`](../../workstream-creation.md) describes. `⌘⏎` runs it
from anywhere in the list, without arrowing down to it.

This is the behavior that makes search Avalon-shaped rather than generic: a
failed lookup in a product organized around work streams should produce a work
stream.

**Loading.** There is no spinner over the results. Local matches are already
painted; remote groups are absent until they arrive, and a quiet indeterminate
line sits under the query field while a request is outstanding.

**Error.** If the request fails, local name matches stay on screen and a single
quiet line reads `Couldn't search message and document text.` The palette
remains fully usable for opening things by name. Search never presents a
blocking error dialog — it is an accelerator, and an accelerator that interrupts
is worse than one that degrades.

**Offline.** Identical to the error state, reached without a request. The
`SocketStatusIndicator` already tells the person the app is offline; search does
not repeat that, it just says which half of itself is unavailable.

### Results are a read, not a subscription

Search is a point-in-time `GET`. Results do not live-update while the panel is
open, and a work stream whose activity changes mid-query does not reorder under
the cursor. This is the deliberate answer to
[`choosing-sockets-or-rest.md`](../../choosing-sockets-or-rest.md): it is a thing
one person explicitly went looking for, it is not a surface anyone else's screen
depends on, and pushing search results to every open window would be a second
data plane serving a panel that is open for four seconds at a time.

## Impact on the product contract

**This change moves the contract, and it moves the first sentence of it.** [The
implementation brief](../2026-08-05_avalon-implementation-brief/prd.md) opens:

> Avalon is an AI-native workplace communication and execution environment
> organized around concrete work streams rather than channels, direct messages,
> search, or a global inbox.

Search is named there alongside channels and the inbox, and the reason it is
named is worth stating before proposing to change it. In the products Avalon is
reacting to, search is *the compensation for having no organizing principle*:
everything lands in one undifferentiated stream, nothing has a home, and the
search box is how you survive that. Avalon rejected the stream, so it rejected
the box that the stream requires.

That argument is about search as an **organizing** surface. It does not reach
search as a **retrieval** affordance that always terminates in a work stream —
and the distinction is exactly what non-goals 1, 2, 9, and 11 exist to enforce.
A palette with no route, no history, no feed, and no activity rows cannot become
the thing the clause was written against. What it does instead is make the
organizing principle affordable at a hundred work streams rather than at ten.

**The clause proposed for the brief**, replacing the words `search, or a global
inbox` in that sentence:

> …organized around concrete work streams rather than channels, direct messages,
> or a global inbox. Search exists as a way *into* a work stream — a transient
> query over what a person can already read — and never as a place to read from:
> there is no results route, no saved search, and no keyword feed.

Two other clauses were checked and do **not** move:

- *"Avalon has no global activity feed."* Untouched, and actively defended by
  non-goals 1 and 9.
- *"Viewing does not create participation."* Untouched. Opening a search result
  is viewing; it seats nobody.

Editing the brief is part of this change and lands with the first implementing
pull request, not with this document — the brief is the standing contract and it
should not describe a surface that does not exist yet.

## Decision log

None yet.

## Key design decisions

1. **One workspace-wide index inside WorkspaceDO, not a fan-out to every
   `SubstreamAgent`.** WorkspaceDO is already the authority for cross-work-stream
   queries and already runs FTS5 (`memory_items_fts`,
   `memory_table_rows_fts`), and `workspace_workstream_directory` already holds a
   projection of every work stream with a per-viewer visibility row beside it. A
   search index belongs in the same object, answered by one query.
   **Rejected:** querying each `WorkstreamDO`/`SubstreamAgent` per keystroke.
   The object count grows with the workspace's age rather than with the query,
   every keystroke would wake objects that have been asleep for weeks, and the
   latency of the slowest cold object becomes the latency of search. It also
   costs the most in exactly the workspaces where search matters most.

2. **FTS5 keyword search, not embeddings.** The corpus is workplace text where
   people search for words they remember writing — names, identifiers, phrases —
   which is what a lexical index is good at. **Rejected:** embedding the corpus
   into `MEMORY_INDEX`. It is a second write path, a second thing to backfill, an
   inference call in the latency budget of a keystroke, and a recall improvement
   nobody here can currently measure
   ([`choosing-queues-or-rpc.md`](../../choosing-queues-or-rpc.md#deciding-without-measurement)).
   Keyword-first is also the cheaper decision to reverse: adding a semantic pass
   later re-ranks results the lexical index already produced.

3. **Visibility is a join evaluated at query time, never baked into the index.**
   One index row per document; who may see it is decided by joining
   `workspace_workstream_viewers`, `notes.scope`, and the existing resource
   access check at read. **Rejected:** materialising per-user index rows. That
   multiplies the index by the member count, and — the deciding objection — it
   makes access *removal* an indexing job. With a query-time join, a person who
   loses access stops matching on their next keystroke with nothing to sweep.

4. **Name matching happens on the client, before any request.** The sidebar
   already holds the directory page and the member list, and the composer already
   fuzzy-matches members for `@` mentions. Reusing that makes the common case —
   "get me back to the thing I was in yesterday" — instant and offline-capable,
   and it means a failed request degrades to a still-useful palette rather than
   to nothing.

5. **Phased by where the text already lives, not by which source sounds most
   important.** Phase 1 covers every source whose text WorkspaceDO already
   stores; phase 2 covers the two whose text is somewhere else. See
   [Rollout](#rollout). This is what lets the surface ship and be judged before
   the expensive projection is built.

6. **Message text is projected over the regional-effect outbox that already
   feeds the directory**, as a new effect kind beside `directory_common` and
   `directory_user` — not over a new queue, a new RPC, or a scheduled crawl. The
   ordering, waterline, retry, and idempotency machinery is already there and
   already proven by the directory that search is joining against.

7. **The escape hatch is a first-class result, not an empty state.** "Start a
   work stream: `<query>`" is present in every result set, not only when nothing
   matched, and has its own key (`⌘⏎`). A search that fails should cost one
   keystroke to turn into work.

## Data model

Sketch only; [`design.md`](design.md) carries the DDL, the projection protocol,
and the backfill, and [`data-model.md`](../../data-model.md) becomes
authoritative when it ships.

Two new tables in WorkspaceDO, beside the directory they are joined to:

- **`workspace_search_documents`** — one row per searchable thing, keyed by
  `(source_kind, source_id)` where `source_kind` is one of `workstream`,
  `message`, `note`, `note_segment`, `document`, `automation`. Carries the
  `workstream_id` or `note_id` the visibility join needs, a `title`, the indexed
  `body`, `updated_at` for recency ranking, and the `waterline` and
  `payload_hash` that make a re-delivered projection idempotent — the same
  columns `workspace_workstream_directory` already uses for the same reason.
- **`workspace_search_fts`** — an external-content FTS5 table over `title` and
  `body`, mirroring the pattern `memory_items_fts` already establishes.

Rows for work streams, automations, notes, note transcript segments, and
document titles are written from data WorkspaceDO already owns. Rows for messages
arrive over the effect outbox. Rows for document *contents* are written when
extraction completes — the point at which `resources.model_content_status`
becomes `ready` — so indexing rides an existing state transition rather than
polling R2.

Nothing is backfilled synchronously. An unindexed work stream is still findable
by name from the directory, which is what makes a gradual backfill acceptable.

## Regional impact

None crosses the boundary. The index lives in the workspace's own WorkspaceDO,
which is already pinned to that workspace's immutable region and placement, so
indexed content comes to rest exactly where the content it was derived from
already rests. There is no cross-region query, no Global aggregation, and no
change to the single identity endpoint. Non-goal 4 makes this permanent rather
than incidental.

## Security and trust model

**Search is the highest-leverage place in Avalon to get authorization wrong**,
because a leak here is silent, is presented as a feature, and is discovered by
typing a word. The rules below are the change's real acceptance criteria.

1. **Every result passes the same check as opening the thing it points at.**
   Work streams and the messages inside them are filtered by
   `workspace_workstream_viewers.listable` for the calling user — the same flag
   the sidebar list applies. Notes are filtered by `scope` and `owner_user_id`.
   Documents go through the existing resource access check. Automations follow
   their subscription's `You`/`Workspace` scope. Search adds no new authorization
   rule and is permitted to relax none.
2. **The filter is applied inside the query, before ranking and before
   counting.** A `WHERE` that runs after the top-N is chosen leaks the existence
   of private work through the `N MORE RESULTS` count and through ranking
   displacement, which are both readable without ever seeing a title.
3. **Access loss takes effect on the next keystroke**, because the visibility
   join is evaluated at read time (key design decision 3). No sweep, no
   invalidation, no window during which a revoked member's search still matches.
   This is deliberate alignment with
   [`access-revocation.md`](../../access-revocation.md).
4. **`model`- and `system`-visibility parts never enter the index at all**, and
   neither do reasoning, tool arguments, or tool results (non-goal 8). The filter
   is applied at projection, not at query, so text a person may not read is never
   written into a table a person's query touches.
5. **The query string is untrusted input and is never concatenated into a MATCH
   expression.** It goes through the same sanitizer `memory-service.ts` and
   `memory-table-service.ts` already use to turn a person's words into a bound
   FTS5 parameter; a caller must not be able to write their own FTS5 syntax,
   whose operators can otherwise be used to probe for content the ranking would
   not have shown.
6. **Snippets render as text, never as markup.** A snippet is user- or
   model-authored content and does not go through `MarkdownBody`
   ([`markdown-rendering.md`](../../markdown-rendering.md)) or any HTML path; the
   match highlight is applied by the renderer over character offsets the server
   returns, not by the server emitting tags.
7. **Telemetry never carries the query, a title, a snippet, or a document
   name.** [`telemetry.md`](../../telemetry.md) already forbids titles and bodies
   in events, and a search query is more sensitive than either — it is what
   someone was looking for. The events below carry shape, not content.

## Rollout

Behind a Flagship client feature flag, `global-search`, resolved through
`client-feature-flags.ts` and therefore **failing closed**: an unbound binding,
an unreachable Flagship, or an unresolved flag all mean the glyph is absent and
`⌘K` does nothing ([`feature-flags.md`](../../feature-flags.md)).

**Phase 1 — everything WorkspaceDO already holds the text of.** Work streams,
automations, meeting notes and their transcripts, document *titles*, people, and
actions. No new projection and no cross-object transport: one FTS5 table fed from
rows the object already owns, one `GET`, and the whole client surface. This ships
the interaction and lets it be judged before the expensive half is built.

**Phase 2 — the text that lives somewhere else.** Message bodies, via a new
effect kind on the existing regional-effect outbox; and document contents,
indexed when extraction reaches `ready`. Both add rows to the phase 1 table and
groups to the same panel; no client rework.

Turning the flag off hides the surface immediately and leaves the index in place,
inert. Rolling back further means dropping two tables and one effect kind, and
the directory the surface joins against is untouched throughout — which is the
property that makes this cheap to reverse.

## Limits

Split per
[`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).

**Product limits — set here, and cited to this PRD:**

| Limit | Value |
| --- | --- |
| Rows shown per group before truncation | 5 |
| Group order | as tabled under [Product behavior](#states) |
| Minimum query length before a remote request | 2 characters (local matching starts at 1) |
| Rows in the empty-query **Recent** group | 9, matching the `⌘1`–`⌘9` run |

**Defensive limits — the mechanism is this change's to build; the numbers are
not.** Each ships at its open value, marked `LIMIT UNSET`, and is handed back
with its arithmetic in the implementing pull request:

- Maximum accepted query length.
- Maximum candidate rows an FTS query considers before ranking.
- Per-request server time budget for the search read.
- Maximum indexed characters per message and per document.
- Retention horizon for indexed message text — the one that decides whether the
  index grows without bound against the 10 GB object ceiling
  ([`data-model.md`](../../data-model.md)). This one most needs a real answer
  before phase 2 ships, and it is the first entry in
  [Open questions](#open-questions).

The as-you-type request cadence is a product limit doing double duty: it decides
whether search feels instant *and* it bounds how often a keystroke reaches
WorkspaceDO. It is set here at **one request per settled query**, meaning a
request is issued when typing pauses and any outstanding request for a stale
query is abandoned rather than rendered.

## Acceptance

1. `⌘K` from the home screen, a work stream, a note, and settings each open the
   panel with focus in the field; `Esc` returns focus where it was.
2. The glyph is visible in the sidebar titlebar, is not covered by the traffic
   lights at any window width, and is clickable rather than draggable. Verified
   in a real window per
   [`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it),
   not by a component test.
3. Typing three characters of a work stream's title selects it as the top hit and
   `⏎` opens it.
4. A phrase that appears only in the body of one message finds that message,
   shows the work stream it is in and a snippet with the phrase highlighted, and
   opens to it.
5. A phrase that appears only in a meeting transcript finds its note; a phrase
   that appears only inside an uploaded document finds that document.
6. **A second member, signed in separately, searches a phrase that appears only
   inside a `personal` work stream they are not a participant of, and gets no
   row and no increase in the `N MORE RESULTS` count.** Repeated for a
   `personal` note and for a document they cannot access.
7. A member removed from a work stream stops matching its content on their next
   query, with no intervening deploy or sweep.
8. A query matching nothing shows the start-a-work-stream row selected; `⏎`
   opens the new-work-stream surface with the query in the composer.
9. With the API unreachable, the panel still opens and still matches names, and
   shows the single quiet line about message and document text.
10. With `global-search` off, the glyph is absent and `⌘K` does nothing.

Where these become durable checks, they land in [`e2e.md`](../../e2e.md).

## Telemetry

Three events, registered in `packages/contracts/src/telemetry.ts` per
[`adding-new-instrumented-event.md`](../../adding-new-instrumented-event.md),
carrying shape only:

- `search_opened` — how it was opened (`glyph` or `shortcut`) and the surface it
  was opened from.
- `search_results_shown` — query length as a bucket, never the query; the number
  of results per group; whether remote results arrived, failed, or were skipped.
- `search_result_opened` — the result's `sourceKind`, its group, and its position
  within the group; or `start_workstream` when the escape hatch was taken.

Together these answer the one question that decides whether this surface earns
its place: **does search convert into opening something, and which kinds of
result do people actually take?** If phase 1 shows people opening work streams by
name and nothing else, phase 2's cost is not yet justified.

## Open questions

1. **What is the retention horizon for indexed message text?** Blocking for
   phase 2, not for phase 1. Indexing every message body forever grows the
   WorkspaceDO index without bound against a 10 GB ceiling that, when reached,
   stops the object accepting writes — an outage, not a degradation
   ([`data-model.md`](../../data-model.md)). A horizon makes search a recency
   tool; no horizon makes it an archive with an eviction event in its future. The
   answer changes what the product promises, so it is the team's, not the
   implementer's.
2. **Does a work stream a person created but then left appear in their
   results?** Blocking, and not a question this PRD may answer by itself.
   [`data-model.md`](../../data-model.md) records that `personal` visibility
   means two different things in two places — the single-row read also admits
   `created_by_user_id`, while `WorkstreamDO.canRead` and the `listable` flag
   test participation alone — and states that closing the gap is "a product
   decision nobody has made", and that neither half should be copied into a new
   caller until somebody does. **Search is a new caller.** It cannot ship
   silently choosing one: choosing `listable` hides a work stream its creator can
   still open by URL, and choosing the other surfaces content in search that the
   sidebar and the socket both refuse. The decision is needed before phase 1
   ships and is worth making on its own terms, for every caller at once.
3. **Should a message match open the work stream at that message, or at the
   bottom?** Opening at the match needs a scroll-to-sequence path the transcript
   does not currently expose, and
   [`transcript-scrolling.md`](../../transcript-scrolling.md) is deliberate about
   who owns the viewport. Phase 2 can ship opening at the bottom; landing on the
   match is the better behavior and the larger change.
4. **Do automation *runs* deserve their own group?** Every run owns a work
   stream, so runs are already reachable through the **Work streams** group — but
   a person looking for "the competitor digest from last Tuesday" is thinking
   about the automation, not the work stream it produced. Deferred until phase 1
   telemetry says whether automations are being searched for at all.
