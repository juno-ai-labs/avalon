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
transient overlay that always terminates in something that already exists — a
work stream, a note, a document, an automation, a person — or in starting a new
work stream.

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
model run, and a wait, on a keyword lookup — or can scroll.

**One narrow search does exist, and this PRD has to reckon with it.**
`GET /resources?q=` substring-matches four columns with `LIKE` — `title`,
`provider`, `resource_type`, and `provider_resource_id` — and backs the debounced
filter box in the work-stream resource picker. It is scoped to one dialog, it
searches titles rather than contents, and its match semantics are substring
where this change's are tokenized — which is precisely why it cannot be left
beside a second search over the same `resources` table returning different
answers for the same string. Reconciling the two is in scope; see non-goal 15.
The agent's `search_resource` tool searches extracted document contents on the
same corpus, and is the model's path rather than a person's.

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
2. Names match as the person types, with no perceptible wait, for everything the
   client already holds: work streams, automations, meeting notes, people, and
   the actions Avalon can start. Document names match too, on the same round
   trip as body text — the client caches no document list, so they are the one
   name-match that is not instant and not available offline.
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
15. **Changing the resource picker's own match behaviour is out of scope; making
    the two searches agree on *authorization* is not.** The picker matches four
    columns by substring, including `resource_type` and `provider_resource_id`,
    which an FTS index over title and body does not carry — so re-pointing it at
    the shared index would silently narrow it, and "one shared match rule" is not
    available. What *is* available, and is in scope, is one shared set of
    **visibility** fragments: both reads run in WorkspaceDO over the same tables,
    and today they already disagree — the picker's inlined draft-upload predicate
    omits the `uploaded_by_user_id` arm that the single-resource read applies, so
    a person cannot see their own unattached draft in the picker. Search takes the
    read-one form. Whether the picker should be corrected to match is a separate,
    smaller decision this PRD surfaces rather than makes.

## Product behavior

### Opening it

**The glyph.** A magnifying-glass `IconButton` sits in `.sidebar-titlebar` — the
48px strip above the sidebar list that today holds nothing on desktop and exists
only as a window-drag region. The glyph is placed at the strip's leading edge,
inset clear of the macOS traffic lights at `x: 18, y: 17`, and carries
`window-no-drag` so that it is clickable rather than draggable. Its accessible
label is `Search`, and its tooltip names the `⌘K` shortcut. That tooltip is new:
the sidebar's existing shortcut hints are not a hover affordance to match — they
are `aria-hidden` ⌘-digit pills that appear only while the Command key is
physically held, and disappear on `keyup` or window blur.

**The shortcut.** `⌘K` (`Ctrl+K` off macOS) opens search from every surface in
the main window — home, a work stream, a note, an automation. It is captured at
the window, so it works while the composer has focus; it is the one shortcut
that takes precedence over a focused text field, because a person reaching for
search mid-sentence means search.

**Not from the standalone windows.** Settings and meeting notes open as separate
Electron `BrowserWindow`s whose renderer branches before `AppShell` into a
single-route router — no sidebar, no shell, and no route to a work stream, so a
result opened there would have nowhere to go (`App.tsx` returns early on
`surface=settings` and `surface=meeting`; `app-shell.tsx` says so in its own
comment). Reaching search from those windows means either a main-window
navigation bridge over IPC — which does not exist today, the preload surface
exposes only `openSettings`, `openMeetingNotes`, and
`openMeetingAudioSettings` — or mounting a second palette that can only ever
match within that window. Both are out of scope here; `⌘K` is a main-window
affordance, and the acceptance criteria say so.

**Closing.** `Esc` closes and returns focus to whatever had it. Clicking the
scrim closes. Opening a result closes.

**Interaction with `⌘1`–`⌘9`.** The palette is a `role="dialog"`, and the
sidebar's numbered-shortcut handler already refuses to navigate while a dialog is
open. That is the correct behavior and this change relies on it rather than
working around it: while search is open, digits are query text.

### The overlay

A centered panel over a scrim, above all surfaces, drawn entirely in theme
tokens — `--av-sys-color-scrim-default` behind it and a surface token for the
panel, exactly as `.dialog-overlay` and `.dialog-content` already do. **Not a
dark palette:** two of Avalon's four themes are light (`air`, `terra-light`),
there is no `dark` token family in the registry, and
[`theming.md`](../../theming.md) is explicit that nothing in the interface knows
which theme is running and no component reads a colour — a test fails if
`app.css` names one. It holds a single unlabelled query field with the magnifying glass at
its leading edge and an `Esc` affordance trailing. Results fill the panel below
the field. A footer row states the three keys that do something: `↑↓ NAVIGATE`,
`⏎ OPEN`, `⌘⏎ START`, and on the right, the count of matching results that are
not shown.

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

The selected row is tracked by its identity, not its index, so a group arriving
underneath the cursor never changes what `⏎` would open. **Arriving results may
still move the selection, but only before the person has touched it**: until the
first `↑`/`↓`, the selection follows the current top hit and re-resolves when
remote results land; after it, the selection is the person's and nothing but a
new keystroke moves it. Without that first clause a remote message match could
never become the top hit, which is most of what phase 2's ranking is for; without
the second, pressing `⏎` as a response lands opens whatever arrived.

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

Three structural notes the table would otherwise hide. A **Messages** row has no
title of its own — it renders the snippet as its primary line and names its work
stream as metadata, and the indexed row's `title` is deliberately empty, because
stamping the work stream's title onto every message would give all of them a
title-weighted hit and bury the work stream itself. **People** and **Actions**
are not indexed rows and carry no relevance score; they are matched entirely on
the client, sort within their own groups, and never compete for the top hit.
And `⏎` on a person opens the workspace-member surface, not a work stream — the
one result kind whose destination is not one of the four the overlay otherwise
terminates in.

**Top hit.** The single highest-ranked row across all groups is selected when
results settle, so `⏎` is meaningful without the person pressing `↓` first.
Ranking is relevance first — a title match outranks a body match, a whole-word
match outranks a prefix — and recency second, which breaks ties the way the
sidebar already orders itself.

**Truncation.** Each group shows at most **five** rows — per group, which a
single overall cap cannot deliver: one prolific kind would take every slot and
leave groups that genuinely matched rendering as though they had not. The count
of everything matching but not shown appears in the footer as `N MORE RESULTS`.
That count counts only results the person may see, it is produced by the same
filtered statement that produced the rows rather than by a second query that
could drift from it, and it is the total *minus what is on screen* — reporting
the total says `3 MORE RESULTS` when all three matches are already visible.

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

**Offline.** Identical to the error state, reached without a request — the same
quiet line naming which half of search is unavailable. It cannot lean on an
existing offline indicator, because there isn't one on most of these surfaces:
`SocketStatusIndicator` reports *live-update* state ("Reconnecting live
updates", "Live updates unavailable") rather than offline-ness, and its only
mount is the work-stream header. The one surface-wide notice is
`app-shell.tsx`'s connection banner, which renders only after a navigation query
has already errored. So the palette's own line is the whole signal a person gets
on home, notes, and automations, and it has to stand alone.

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

**The brief's opening sentence, as proposed in full** — not a substring
substitution, because the edit both removes a word from the list and appends a
sentence:

> Avalon is an AI-native workplace communication and execution environment
> organized around concrete work streams rather than channels, direct messages,
> or a global inbox. Search exists as a way *into* a work stream — a transient
> query over what a person can already read — and never as a place to read from:
> there is no results route and no keyword feed.

The contract sentence names only the two prohibitions this PRD rejects
*outright* — non-goal 1 (no results route) and non-goal 9 (no keyword feed).
Saved searches are non-goal 2, which is **deferred**, and writing a deferred
"not yet" into the standing contract would mean re-opening the product contract
to undo it later. A contract clause and a deferred non-goal are different
commitments and this document does not conflate them.

**A second statement of the same prohibition moves with it.**
[`implementation-plan.md`](../../implementation-plan.md)'s release gate reads
"The implementation is not considered complete if it … introduces channels,
global search, a terminal, separate named agents, or a global inbox." That is
phrased as a completion blocker, so leaving it while editing the brief would
have the repository simultaneously describe search as shipped and fail the
change for shipping it. It is edited in the same change, to name what is still
prohibited — a results route and a keyword feed — rather than search as such.

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

4. **Name matching happens on the client, before any request.** The client
   already holds the directory page (in the sidebar) and the member list (at the
   app root — a different cache, which the People group reads), which is what
   makes the common case — "get me back to the thing I was in yesterday" —
   instant and offline-capable, and what lets a failed request degrade to a
   still-useful palette rather than to nothing. **The matcher is largely new
   work.** The composer's `@` mention picker is a case-insensitive `includes()`
   over a label list and `mention-highlight.ts` is an exact case-folded slice;
   neither is a fuzzy or prefix matcher. The nearest reusable thing is
   `searchAvailablePlugins` in `packages/agent-harness`, which is the whole
   shape — NFKC normalise, token extract, dedupe, exact/phrase/overlap scoring,
   deterministic tiebreak, cap, and a total — and `workspace-settings.tsx`
   already does grouped client filtering with empty groups dropped. No fuzzy
   library exists in the repo and none should be added. Its semantics still have
   to be reconciled with the server's, which tokenizes and prefixes only the
   trailing term: the same query otherwise returns different sets from the two
   halves of one list, a work stream matched by both has to deduplicate to one
   row with one identity, and a client row carries no `bm25` score, so it cannot
   compete for the top hit on rank — client matches sort within their groups and
   the top hit is chosen among scored rows, falling back to the first client row
   only when no scored row exists.

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
  `message`, `note`, `note_segment`, `document`, `automation`. Carries a single
  `scope_id` naming the row the authorization join runs against, a `title`, the
  indexed `body`, `updated_at` for recency ranking, and the
  `authority_generation`, `waterline`, and `payload_hash` that make a
  re-delivered projection idempotent. All three of those, not two: the directory
  compares generation *then* waterline because `sourceVersion` restarts on an
  authority bump, and a waterline-only test freezes that work stream's index
  silently and permanently.
- **`workspace_search_fts`** — an external-content FTS5 table over `title` and
  `body`, with a `prefix` index because every request prefix-matches its
  trailing token.

Both land as a **new version** of `WORKSPACE_DO_SCHEMA_MIGRATIONS`. They cannot
be appended to `WORKSPACE_DOMAIN_SCHEMA_STATEMENTS`, which is hashed into
version 1 — editing it throws `workspace_do_schema_hash_mismatch:1` in the
constructor of every already-deployed workspace.

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

1. **Every result passes the same check as opening the thing it points at, and
   every source kind has a predicate.** Work streams and the messages inside
   them use the rule the sidebar list actually applies —
   `scope = 'workspace' OR is_participant = 1`, against a viewer row pinned to
   the directory row's `authority_generation`. Notes are filtered by `scope` and
   `owner_user_id`. Documents use the three fragments `resource-service.ts`
   already applies — connector scope, the draft-upload rule, the note-backed
   rule — lifted into shared SQL rather than restated. Automations follow their
   subscription's `You`/`Workspace` scope, plus its template's archive state.
   Search adds no new authorization rule and is permitted to relax none.

   Two traps, both of which the first draft of this PRD fell into and which the
   implementation must not: **`workspace_workstream_viewers.listable` is not the
   sidebar's flag** — no list query reads it, and it is computed through
   `participantVisible`, which also admits `created_by_user_id`, so it is
   *broader* than the rule the socket enforces. And **a source kind with no
   predicate is not a safe default**: a guard shaped `scope_id IS NULL OR (…)`
   returns every row of any kind it forgot, which is how documents and
   automations were briefly returned to every member of the workspace. The
   filter is written as an exhaustive `CASE` so that an unhandled kind is
   excluded rather than admitted; [`design.md`](design.md#the-visibility-join)
   carries the statement.
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

**One product question the team has to settle with the candidate cap**, because
the two cannot both hold: an exact `N MORE RESULTS` counts every authorized
match, but a candidate cap truncates the set being counted, so the footer would
report the cap rather than the remainder. Either the count becomes `N+ more`
above the cap, or the cap is high enough that the difference is theoretical and
the per-keystroke cost is accepted. This PRD does not choose.

**Product limits — set here, and cited to this PRD:**

| Limit | Value |
| --- | --- |
| Rows shown per group before truncation | 5 |
| Group order | as tabled under [Product behavior](#states) |
| Minimum query length before a remote request | 2 characters (local matching starts at 1) |
| Rows in the empty-query **Recent** group | 9, matching the `⌘1`–`⌘9` run |

**Defensive limits — and these mostly may not ship open.**
[`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md)
gates the open value on one test: *does this change introduce the unbounded
path?* Here the answer is yes for all of them — `GET /search`, the FTS index,
and the projection are new paths this change authors, so an open value would be
a regression written by this change rather than the behaviour that already
ships. The same section says to always ask rather than ship open when the path
allocates memory proportional to untrusted input. So these are **asked for, not
placeholdered**, and the implementing change does not start until they are set:

| Limit | Why it cannot ship open | Starting point for the team |
| --- | --- | --- |
| Maximum indexed **bytes** per message and per document | Lands in a SQLite `CHECK` inside a hashed migration. Placeholders live in TypeScript source only, a `CHECK` has no inert value, and a versioned migration is not "one edit away" — so this one must be set *before the migration is written*, not handed back after | Under `durable_outbox.payload_json`'s ~1.9 MB `CHECK` with envelope overhead to spare; an over-large body aborts the *producing* transaction, so the message write itself fails |
| Maximum accepted query length | Allocation sized by untrusted caller input | `GET /resources?q=` already caps a search string at 200 characters; matching it needs no new decision. Note the existing FTS sanitizer also truncates at 96 tokens, which silently pre-empts any larger value |
| Maximum candidate rows before ranking | The statement materialises every authorized match before emitting one, on the single-threaded WorkspaceDO, per settled keystroke | The existing FTS precedent caps candidates at 20 per leg and reports no total. Setting this also decides the `N MORE RESULTS` question below |
| Per-wake backfill batch size | The backfill queues ahead of live directory projections, and there is no natural bound on a drain | `processMemoryIndexOutbox` runs at 50 per wake against a hard cap of 200 — the same outbox shape |

Note the unit: **bytes, not characters.** The `CHECK` is byte-counted per
`data-model.md`, so a character-denominated bound cannot be substituted into it,
and truncating by characters while checking bytes rejects every CJK or
emoji-bearing body permanently. The producer truncates by the same unit.

One number moves to the product column. The **retention horizon for indexed
message text** is filed here as defensive in name only: this PRD's own open
question 1 says a horizon makes search a recency tool and no horizon makes it an
archive, and *that changes what the product promises*. Per the same document, a
number that both shapes and defends is a product limit — the team sets it as
scope, not as a cap, and it is [open question 1](#open-questions) rather than a
row above.

The as-you-type request cadence is a product limit doing double duty: it decides
whether search feels instant *and* bounds how often a keystroke reaches
WorkspaceDO. The *shape* is set here — **one request per settled query**, with
any outstanding request for a stale query abandoned rather than rendered — but
the pause duration is a number, it is not set here, and it is on the list above.

## Acceptance

1. `⌘K` from the home screen, a work stream, a note, and an automation each open
   the panel with focus in the field; `Esc` returns focus where it was. In the
   standalone Settings and meeting-notes windows it does nothing, deliberately.
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
8. **A phrase that appears only inside another member's `personal` meeting note
   returns nothing — including through the Documents group.** Every note is
   backed by a `resources` row that is born `model_content_status = 'ready'`, so
   this is the test that catches the note's text reappearing under the document
   authorization rule rather than the note one.
9. **A member with no viewer row for a `workspace`-scoped work stream still
   finds its messages.** Viewer rows are written only for authors, mentions, and
   participants, so a rule that keys solely on the viewer row makes every shared
   work stream unsearchable to everyone who has not yet spoken in it.
10. A query matching nothing shows the start-a-work-stream row selected; `⏎`
    opens the new-work-stream surface with the query in the composer.
11. With the API unreachable, the panel still opens and still matches names, and
    shows the single quiet line about message and document text.
12. With `global-search` off, the glyph is absent and `⌘K` does nothing.

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
   means two different things in two places, and states that closing the gap is
   "a product decision nobody has made", and that neither half should be copied
   into a new caller until somebody does. **Search is a new caller.**

   That document is also wrong about which half is which, in a way that inverts
   the risk and that this change should correct in the same breath as answering
   the question. Its sentence — "`WorkstreamDO.canRead` and the `listable` flag
   it projects test participation alone" — is right about `canRead`, which does
   test participation alone, and wrong about `listable`:
   `listable` is computed through `participantVisible`, which is
   `scope === 'workspace' || participant || created_by_user_id === userId`. So
   `listable` is the **creator-inclusive** half. Choosing it would not hide a
   creator's work stream — it would surface the full message text of a
   `personal` work stream to someone the socket and the sidebar both refuse,
   permanently, with no revocation path. This PRD therefore specifies the
   sidebar's own rule (`scope = 'workspace' OR is_participant = 1`) as the
   interim predicate, written in one fragment, and still needs the decision
   before phase 1 ships: the answer is worth making for every caller at once,
   and `removeParticipant` permits self-removal with no creator exemption, so
   the gap is reachable rather than theoretical.
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
