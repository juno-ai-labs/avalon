# Activity events and scheduled digests

Two things live here because the second is the first's only consumer today. The
**activity log** is Rally's first-party record of what happened that someone
should hear about. The **digest** is a scheduled agent run that reads a person's
slice of that log and writes them a summary.

Read this before adding a notification surface, adding something a digest should
mention, or changing what a connector can deliver to a person.

## Where the code lives

| Concern | File |
| --- | --- |
| The log: writes, visibility-scoped reads, cursors | `apps/api/src/services/activity-event-service.ts`, backed by WorkspaceDO SQLite |
| Digest configuration, RRULE derivation, schedule rows | `apps/api/src/services/digest-service.ts` |
| Firing one occurrence, the window, the hidden work stream, the brief | `apps/api/src/services/digest-run-service.ts` |
| The `digests-enabled` kill switch | `apps/api/src/services/digest-flags.ts` |
| Getting the brief in front of the model | `loadRunPromptContext` in `apps/api/src/services/integrations.ts`, rendered by `renderScheduledDigestBriefMessage` |
| Deciding whether a connector activity may be digested | `activityIsDigestible` in `apps/api/src/queues/activity-consumer.ts` |
| Recording and sending what a run wrote | `apps/api/src/services/digest-run-settlement.ts` |
| Destination dispatch | `apps/api/src/services/digest-delivery-service.ts` |
| Email HTML | `apps/api/src/services/digest-email-content.ts` |
| Access-request acknowledgements using the shared renderer | `apps/api/src/services/access-request-service.ts`; lifecycle in [private access](private-access.md). |
| Markdown → email HTML | `apps/api/src/services/email-markdown.ts` |
| Which lines are code, for both of the above | `packages/contracts/src/markdown-code.ts` — see [`markdown-code.md`](markdown-code.md) |
| Rendering the email for real people, to look at | `scripts/preview-digest-email.mjs` |
| Settings screen | `apps/desktop/src/renderer/components/digest-settings.tsx` |
| The work-stream list every renderer surface shares | `apps/desktop/src/renderer/lib/use-workstreams-query.ts`, served by `WorkspaceDO` |

## How it works

### Why a second activity table exists

`WorkspaceDO.workspace_connector_events` is provider ingest authority. It is
keyed by connection-scoped provider identity and dedupe constraints, written
before anyone has decided what an event means, and settled by its processing
Workflow. It answers *what did GitHub tell this workspace*. Legacy regional D1
`activities` rows are maintenance import input and are scrubbed before cutover;
live ingest writes no D1 event body.

`WorkspaceDO.workspace_activity_events` answers a different question: *what happened in Rally that
this person should hear about*. A Rally mention has no connection. A
work-stream message has no provider event id. Neither has a dedupe key a
provider controls. Widening `activities` to hold both would leave first-party
rows carrying a column of synthetic nulls for every provider concept they do not
have, and would make every consumer filter ingest state out of a feed.

So the two stay separate, and connector activity is **projected** into
that workspace-local log once it has been processed. Every surface that wants "what
happened, for this person, since this instant" reads one table.

### Private child notifications

Substream mentions and participant additions use the existing direct Slack/email
notification pipeline with child-addressed links. Their activity events remain
inside the parent and are excluded from the shared activity log and digests.
Direct notification delivery does not require publishing child activity or
aggregating its unread count into the work stream.

### The log

`workspace_activity_events` is append-only. Four things make it generic rather than a
digest-shaped table with a general name.

**`event_type` and `subject_type` are open strings.** A producer adds a value; no
consumer enumerates them. An unrecognized event still renders, because whoever
knew what happened wrote `title` and `body` at the time.

**Audience is a rule, not a recipient list.** `audience_kind` is one of:

| Kind | Who reads it | Used by |
| --- | --- | --- |
| `workspace` | every active member | workspace-scoped connector activity |
| `user` | exactly one person | a personal connection's activity |
| `workstream` | the work stream's current active participants | work-stream messages |

It is resolved against the reader at read time, in
`listActivityEventsForUser` and nowhere else. After membership is revalidated
against D1, WorkspaceDO performs the audience join against its own authoritative
directory/viewer rows in the same local database. Storing recipients instead would
freeze the audience at write time: someone added to a work stream today would
never see what happened in it yesterday. System work streams are excluded there
too, so digest machinery can never appear inside a digest — visible in the
sidebar or not.

**`workspace_activity_event_targets` is involvement, not audience.** Audience says who
*may* see an event; a target row says the event is *about* someone — `mentioned`,
`involved`, and whatever a later producer needs. That is what lets a digest lead
with "you were tagged" rather than burying it in a list of everything that moved.
A target outside the audience is stored anyway; the read query still filters by
audience, so recording involvement never grants visibility.

**`event_sequence` is the cursor axis.** A consumer resumes where it stopped, so it
needs a total order that an insert can only ever extend. Timestamps cannot give
one — two events written in the same millisecond tie, and any tiebreak (a UUID, a
hash) can place the second one *below* a cursor taken after the first, dropping
it from every future read. `event_sequence` is `INTEGER PRIMARY KEY AUTOINCREMENT`:
`AUTOINCREMENT` is what makes it strict, because plain rowids are reused after a
delete and a reused one would appear beneath a cursor that has already passed.

`created_at` is display and retention only. Never cursor on it, and never cursor
on `occurred_at` — a connector poll inserts events whose provider timestamp is
hours old.

#### Retention

The WorkspaceDO alarm drops events older than ninety days oldest-first in
bounded batches and lets the cascade take their targets. The oldest retained
row schedules the next expiry; an idle workspace does not wake on a polling
cadence. The log is append-only and would otherwise grow forever.

Ninety days is far longer than anything reads: a first run looks back 72 hours
and every run after that starts from its own cursor, so the window only has to
survive a schedule being paused and resumed. Reaping never disturbs a cursor —
an expired `event_sequence` sits below every live one, so a window that has lost
its rows reads as empty rather than as new. A surface that wants to read further
back than ninety days needs this number raised, not a second table.

#### Digestible: what a person should be *told*

Audience answers who *may* hear about an event. `digestible` answers whether
anybody wants to. They are different questions, and collapsing them is how a
digest becomes a transcript of continuous integration: a repository under active
development emits two events per check run and three per workflow run, so the
oldest two hundred events in a window can be seventeen minutes of one morning's
builds while the reviews, merges and comments sit behind them unread.

**Every event carries the answer on its row**, in `workspace_activity_events.digestible`,
and `listActivityEventsForUser` takes a required `digestibleOnly` — required
rather than defaulted because both readings are legitimate and the wrong one is
invisible. An activity feed wants everything that happened; a digest, which
interrupts somebody on a schedule, wants the subset. A digest passes `true`.

**A withheld event is not a lesser event.** It is ingested, routed, matched
against automations and watches, recorded in the log, and readable by everyone
its audience covers. It simply does not interrupt anybody.

**The column's own `DEFAULT 1` is the one part of this that fails open**, and it
is deliberately left that way — see the changelog entry below for what it cost
and why changing it is expensive. It governs only an insert that does not name
the column, which no production code path performs, so anything reaching
the workspace activity log outside `recordActivityEvent` must set `digestible` itself
rather than expect the column to withhold on its behalf.

**The window still ends at the top of the log.** The cursor steps over what was
withheld, so a quiet occurrence settles as `empty` and moves on; stopping at the
last digestible event would make every later occurrence re-scan the same
withheld rows forever.

For connector activity the answer comes from the connector's own manifest —
`digestible` on each activity type, plus a polling stream's veto over its own
output — which [`connectors.md`](connectors.md#declaring-what-a-digest-may-read)
owns. Nothing about which events matter is written here or in the digest.

#### Adding a producer

Call `recordActivityEvent` with a `dedupeKey` that is stable per workspace, so a
retry or a replayed queue message resolves to the row the first attempt wrote.
It never throws into its caller: an event log that can fail a message post is
worse than one that occasionally misses a row. Use
`recordActivityEventOrThrow` when the write genuinely has to land.

`digestible` is a required field of that call, with no default. A producer that
has not decided whether it is writing news or machinery should not get the
benefit of the doubt in somebody's inbox, and the compiler asks at the call site
rather than letting the question be answered weeks later by whoever receives the
email. A first-party producer knows the answer where it stands; a connector
producer resolves it from the manifest.

Producers today:

| Producer | Event type | Audience | Digestible |
| --- | --- | --- | --- |
| `WorkstreamService.createMessage` | `workstream.message.posted` | the work stream; mentions become `mentioned` targets | always — everything Rally records here is somebody addressing somebody |
| Authoritative `SubstreamAgent` regional-effect outbox | `workstream.message.posted` and later first-party work-stream events | the work stream; named targets travel in the same immutable effect | decided by the object mutation; messages are digestible |
| `WorkstreamObjectProduct.addParticipant`, `WorkstreamObjectProduct.initialize` | `workstream_participant_added` | the work stream; the person added is an `added` target | always — being put in a room is addressed at exactly one person. `initialize` writes one per name in `participantUserIds`, never for the creator |
| `activity-consumer` after routing | `connector.<provider>.<manifest event type>` — so `connector.github.github.push`, and `connector.google.email.received`, because GitHub's manifest ids carry a provider prefix and Google's do not | the connection's own scope | whatever the connector's manifest declared for that activity type |

### The digest

One digest per person per workspace: a set of days, a set of times, and a set of
destinations. It deliberately cannot vary times per day — that is one integer
day mask and a set of times rather than a seven-way join.

**A digest is on by default**, for people who already exist and for anyone who
joins later: weekdays at 09:00 in their own timezone, by email. Nobody should
have to find a settings screen to be told what they missed.

**There is no digest timezone.** A digest's times are wall-clock times in its
owner's own day, and `users.timezone` already says when that is. A second copy
would be a second answer to the same question, and the two would disagree the
first time somebody moved. The derived `schedules` rows carry the resolved zone
because that is the scheduler's contract, and `rebuildDigestSchedulesForTimezone`
re-derives them whenever the account timezone changes — the configuration does
not change, only the instants it resolves to. The settings screen shows the zone
and links to Account rather than offering a second control.

#### Who gets one

`reconcileDigestDefaults` runs on the ordinary cron and makes two things true.
It is where "on by default" is implemented, rather than at the four places a
membership is created: a reconciler covers the path someone adds next as well as
the four that exist today, and repairs a half-written save instead of leaving it.

1. **An active member with no digest gets the default.** Absence is unambiguous —
   switching a digest off keeps its row with `enabled = 0` — so this can never
   resurrect something somebody turned off. A member with no account address is
   skipped, because the default destination is that address.
2. **An enabled digest with days and times but no `schedules` rows gets them.**
   That is the state a fresh default lands in, and the state a save leaves if it
   fails between writing the configuration and deriving the rows.

Both passes are idempotent and bounded per tick, and the workspace alarm is
refreshed once per workspace rather than once per digest.

#### Scheduling

Each **time** gets its own `schedules` row, not each digest. A single RRULE
cannot carry a list of times: `BYHOUR` and `BYMINUTE` multiply out, so 09:00 plus
12:30 would also fire at 09:30 and 12:00. One rule per time says exactly what was
asked for, and the workspace's alarm already advances, retries and disables each
row independently.

A digest is recurring timing with no payload, which is what `schedules` is for —
unlike `workstream_wakeups`, which is one-shot and carries a prompt, and so keeps
its own table. `schedules` gained `digest_schedule_id` and a CHECK that exactly
one target column is set.

Saving replaces everything: destinations are resolved and frozen *before*
anything is written, so a destination that has gone away fails the request rather
than leaving a schedule that fires into nowhere. A disabled digest keeps its
configuration and loses its schedule rows, so re-enabling is a save rather than a
rebuild. The workspace alarm is refreshed *after* the write — the scheduler
reads WorkspaceDO, so refreshing early would arm it from the rows the save just replaced.

#### The run

Before anything else, the scheduler checks `digests-enabled` — a Flagship
Boolean, and the fourth reader of `env.FLAGS` alongside the three
[`feature-flags.md`](feature-flags.md) already names. It is checked
immediately after the schedule's own `enabled` bit and before anything is
written, so an occurrence it skips claims nothing and moves no cursor: the
next occurrence to fire reads `previousCursor` exactly as it always does and
catches up on whatever was missed while the flag was off. It fails **open** —
the opposite of the four presentation-only product Booleans Ace already
managed — because a digest is already on by default for every existing
person, so the behavior a Flagship outage has to reproduce is delivery
*continuing*, not stopping; only an operator's explicit `false` variation
turns it off. It is Ace's fifth managed flag and the first that is not
presentation-only in the usual sense, but it *is* client-visible: it defaults
**on** rather than off, which is why `apps/ace/scripts/deploy.mjs` provisions
it with an explicit third argument instead of relying on `ensureFlag`'s
ordinary default, and `client-feature-flags.ts` serves it as `digestsEnabled`
so Electron can hide the Digest settings section for whoever it resolves
`false` for — through the identical evaluation the scheduler uses, never a
second check the client derives on its own. See [`ace.md`](ace.md) and
[`feature-flags.md`](feature-flags.md#provisioning).

A digest runs on the ordinary agent loop, with the ordinary tool surface. The
scheduler:

1. Re-validates the execution principal and the membership.
2. Freezes the window: `cursor_from` is the last settled delivery's
   `cursor_through`; `cursor_through` is the workspace's current maximum
   `event_sequence`. Freezing the top is what makes events arriving mid-run belong
   to the *next* digest rather than being skipped.
3. Claims the occurrence by inserting `digest_deliveries`, unique on
   `(digest_schedule_id, planned_for)`. A retried alarm resolves to the attempt
   already in flight.
4. Creates this occurrence's work stream and links it to the delivery. The claim
   is what makes this safe to do unconditionally: exactly one attempt per
   occurrence gets past step 3, so there is no second creator to race.
5. Writes the window into that transcript as a system message and launches the
   harness with it as the trigger.

An empty window settles as `empty` without running the model, and its cursor
still advances so the next digest does not re-scan it. It never reaches step 4,
so an occurrence with nothing to say costs no work stream either.

An attempt that throws before the harness is launched releases both the claim and
the work stream, so the scheduler's retry starts clean rather than accumulating
an empty transcript per failure. Whether the launch happened is read from the
returned run id and not from the row's status: the status write is itself inside
the attempt, so a launch that succeeded and failed only to record itself still
leaves the row `planned`, and releasing that would strand a live run.

**The brief reaches the model through the run's trigger context, not through the
transcript.** Step 5 puts it in `messages` as a `system` row, and system rows are
UI state that the protocol projector deliberately drops — they answer "why did
this start on its own?" for a person opening the work stream, and admitting them
to the model would replay unlabelled connector text as history on every later
turn. So `loadRunPromptContext` re-reads the brief through the delivery, whose
`digest:<delivery-id>` client message id makes it impossible to pick up another
occurrence's window, and renders it as a labelled user-role message beside a
wake-up's and a trigger activity's.

Without that message a digest run reaches the model as a bare system prompt
carrying only the work stream's objective, and a model asked to summarize a
window it cannot see does not report that it cannot see one — it goes looking in
memory and durable tables, finds nothing, and writes that nothing happened. That
shipped: `digest-run-context.test.ts` is the regression, and it also pins the
transcript row staying invisible, so the two halves cannot drift apart.

A run that cannot find its brief throws rather than proceeding. An unsettled
delivery folds its window into the next occurrence; one that runs blind consumes
the window and delivers nothing.

**Digests never touch `workstream_read_states`.** A digest cursor means "what you
have already been told"; a read waterline means "what you have read". Collapsing
them would let skimming an email on a phone silently clear the unread badges in
the app.

#### The system work stream

The agent loop is work-stream shaped end to end — the transcript is `messages`,
and compaction, tool invocations and the realtime room all key off
`workstream_id`. Running the *normal* loop therefore means having a work stream,
and reusing that abstraction is the point: a digest run gets compaction, tool
receipts, the realtime room and the transcript for free.

Two columns, answering two different questions. A digest's work stream carries
both.

- **`scope` — who may read it.** `personal` means an active participant and
  nobody else; `workspace` means anyone in the workspace. This is the same
  column and the same vocabulary `notes.scope` uses, so "private" means one
  thing in Rally and is declared on the row rather than inferred by each
  caller. A digest's work stream has exactly one participant, its recipient,
  which is also what makes every tool the run reaches for resolve against their
  own access. Another member cannot open it knowing its id, because the brief
  inside is assembled from their private activity.
- **`system_kind` — whether it is machinery.** This decides whether the row is
  *listed*: off by default, and the WorkspaceDO directory request's
  `includeSystem: true` asks for it, which the desktop sends when Application → Developer → **Debug enabled**
  is on. It widens what is shown, never who may read it. A private work stream
  that is not machinery is protected exactly the same way.

In the interface, a personal work stream's sidebar row paints the existing
`AvatarStack` of the other people in it rather than the lock a personal note still wears.
The work-stream header keeps its **Private** badge. A digest occurrence is
almost always an empty trailing slot, because the pile omits the reader.

Shown, they render one level down: dimmed, with a small gear, full opacity on
hover and while active — hierarchy should not cost legibility once you are in it.

The debug preference changes what the desktop *asks for*, never where the answer
is stored. Every work-stream list reads `WORKSTREAMS_QUERY_KEY`, an
unparameterized `['workstreams']`, because realtime handlers, renames and
read-state callbacks patch that cache entry directly; a key that varied with the
preference would strand every one of those writes on an entry nobody observes.
`useWorkstreamsQuery` owns the key, the fetcher and the refetch that a toggle
asks for.

**One work stream per occurrence, not per person.** It is created when the
occurrence claims itself and recorded on `digest_deliveries.workstream_id`, so
the transcript has exactly the lifetime of the thing it is a transcript of. A
digest run is a pure function from a frozen window to a summary, and the only
state that has to survive between occurrences is the cursor, which the delivery
already carries.

The title is the occurrence in the recipient's own timezone and nothing else,
compactly: `Digest · 12 Aug · 5:30 PM`. A listing of these is a list of
occurrences rather than one row per person, and a sidebar row title is
ellipsized, so whatever sits in front survives truncation and the *time* — the
one thing telling two occurrences on the same day apart — is what gets cut. The
email's `occurrenceLabel` ("Tuesday 11 August · 5:00 PM") is deliberately not
reused: it is right above a message somebody is reading and about nine characters
too long for the sidebar, which was enough to render both of one day's rows
identically. The recipient's name is left out for the same reason, and because it
identifies nobody to the only person who can open one.

Nothing reaps them, so they accumulate — roughly one per digest per person, which
a weekday digest makes about 260 a year each. That is a deliberate trade for
being able to open any past run and read what it actually did; the rows are
small, and `digest_deliveries.summary_markdown` keeps the digest text whether the
   transcript survives or not. If the volume ever stops being worth it, a
   bounded maintenance Workflow driven by the workspace scheduler is the shape
   it should take, and the cascade already takes the transcript's dependent rows.

**They are listed the same way everything else is**, paged by recency, with no
cap and no separate section. WorkspaceDO filters them out unless the caller
passes `includeSystem`, and when it does they simply take their place in
the order. With Debug enabled a daily digest therefore does take the newest
pages — but the sidebar follows `nextCursor` as it scrolls, so that costs a
scroll rather than the rows themselves. Lifting them out into a bounded set was
tried and reverted: it put a second population inside one method, with its own
cap and its own ordering, to solve a reachability problem that paging had already
solved. See [`workstream-pinning.md`](workstream-pinning.md), which owns
workspace-directory paging.

What the accumulation does change is the index. The ordinary WorkspaceDO query
uses `workspace_workstream_directory_list_idx` over archive, system kind,
recency, and work-stream ID, so hidden digest rows do not require a fan-out or a
scan of child databases. A listing that asks for machinery uses the same bounded
local SQLite authority and simply widens its predicate.

#### Delivery

Email is the built-in default and needs no connector. Every other destination is
a connection whose connector declares a `userDelivery` surface in its manifest —
the same declaration [`connectors.md`](connectors.md) describes and the same one
personal automations use. The settings screen renders whatever the API offers, so
a connector that starts declaring a surface becomes a digest destination with no
UI change.

Adding transport for a new surface is one entry in `CONNECTOR_DELIVERIES` in
`digest-delivery-service.ts`. A target type with no entry is skipped rather than
failing the run — it was saved by a region that has the connector and this one
does not.

Each destination settles independently and records its own
`last_delivered_delivery_id`, so a retried workflow step re-sends only what has
not landed. The delivery is marked `delivered` only after every destination has
settled. A destination the provider permanently rejects is moved to
`needs_input` and surfaced on the digest rather than failing silently forever.
Digest configuration, schedule rows, frozen targets, occurrence cursors, and
per-target `last_delivered_delivery_id` fences all live in WorkspaceDO. The
regional sender resolves current D1 member/user identity before sending. A
future transport needing a multi-destination lease has to model one — the
`external_delivery_attempts` ledger reserved for it was retired unused — and D1
is never a delivery-state projection or fallback.

#### The email

`digest-email-content.ts` wraps the run's Markdown, rendered to email-safe HTML by the shared `email-markdown.ts`, in the digest's own shell.

It is dark, and deliberately only dark: the email is a copy of a Rally surface
and the app has one appearance. Every colour is the app's own token from
`app.css`, written inline — a mail client will strip a `<style>` block, and
several repaint a page that declares a light scheme, so the palette is stated on
the elements themselves and `color-scheme: dark` is declared three ways.

The canvas runs the height of the reading pane rather than stopping at the last
line, so a short digest does not end in a hard edge with the client's own white
below it. `height: 100%` on the document and on the body is the whole of it.

A body background propagates to the canvas and paints the pane by itself, so in
most clients this changes nothing. It exists for the one that paints its own
background onto `html`: propagation happens only while the root element has none,
so that client breaks it, and a full-height body paints the pane itself instead.

The percentage is load-bearing and a viewport unit would be wrong. A webmail
client strips `<body>` and injects the markup into its own page, where the
percentage meets an auto-height ancestor and collapses — leaving the message the
height of its content, which is what a thread card wants. `100vh` would measure
the browser window there and hang a tall dark tail off the bottom of the card.
Nothing carries a height on a layout table for the same reason: the Word engine
reads that as a minimum against the page box.

All three are worth checking when this changes, and `preview-digest-email.mjs`
only shows the first. Injecting `html { background: #fff !important }` into the
preview reproduces the second; rendering the body markup into a container inside
a taller page reproduces the third.

The structure is: preheader (what a phone shows beside the subject, leading with
the count that decides whether this gets opened now), wordmark, title and
occurrence, count pills with the "for you" pill in brand, the body, a primary
action, and a footer. Layout is tables and inline styles only — no flexbox, no
grid, nothing a 2007 renderer has to guess at.

A general Markdown library is the wrong tool here: clients ignore most of what
one emits, and rendering raw HTML would mean rendering model output into an
email. The renderer covers `#` document titles, `##` sections with a brand
rule, `###` subheads, bullets one level deep, numbered lists, links, bold,
`*` or `_` emphasis, inline code, and blockquote, and escapes everything before
a single tag is added, so an `href` can only ever be one it built itself — with
`*`, `_` and backticks encoded inside it, so the emphasis passes that follow
cannot match within the attribute. A table or a fenced block is kept verbatim in
a `<pre>`; other unknown syntax degrades to visible text.

**Citations are reduced before the renderer sees them.** A model's answer may
carry `resource://` link and image targets and GFM footnotes
([`markdown-rendering.md`](markdown-rendering.md)), none of which a mail client
has heard of — so `markdownToEmailHtml`, `markdownToEmailText` and
`markdownToEmailPreheader` each run `rewriteCitationsAsPlainText` first. Chips
and embeds become the words the model wrote; footnotes become numbered markers
over one trailing source list, with an internal source as its title and an
external one as a real link, because a link is the only way a reader outside
Rally can follow it. Without that pass all three leak: the HTML path links only
`http(s)` targets, so a `resource://` link arrives as literal bracket syntax;
the text path appends whatever target it is handed; and neither part has any
footnote handling at all.

**The order is load-bearing:** citations first, then `normalizeModelMarkdown`.
The TeX repair escapes Markdown punctuation in what it unwraps, and a `\[` it
manufactured would stop looking like the link the citation pass has to find.

The brief names exactly that subset, so what the model writes and what the
template styles are the same list. Each source group carries its canonical link,
so the digest points at the real thing rather than describing it.

#### Looking at it

`scripts/preview-digest-email.mjs` renders the template for every active member
of a workspace and writes one HTML file each. Run it through `tsx`, because it
imports the real template rather than a copy:

```bash
pnpm exec tsx scripts/preview-digest-email.mjs            # the local D1
pnpm exec tsx scripts/preview-digest-email.mjs --db /tmp/global.sqlite
```

It uses regional D1 only for active-member identity and renders a sample body
chosen to stress the template — a priority section, a blockquote, bold, and one
bullet long enough to wrap. Delivered bodies, schedules, and work-stream titles
live in WorkspaceDO and are deliberately not queried from D1. **Every visible change to
the template should be looked at here before it is called done**; a test proves
the markup contains a string, not that the hierarchy reads.

For a remote workspace, export its D1 first — Wrangler holds those credentials,
this script does not:

```bash
pnpm --filter @rally/api exec wrangler d1 export DB --remote \
  --config wrangler.global.jsonc --output /tmp/global.sql
sqlite3 /tmp/global.sqlite < /tmp/global.sql
```

### Product measurement

Saving a schedule emits its actual durable enabled state, cadence class, bounded
day/time counts, delivery target types, and result. A delivery emits once when
settlement reaches a terminal state, with its opaque delivery ID, bounded
activity count, target types, and whether it is the member's first delivery.
Schedule times, timezones, email addresses, activity IDs/content, generated
digest text, work-stream title, and delivery-provider responses never enter
telemetry. The schedule/delivery tables remain authoritative; reporting failure
cannot change a saved schedule, cursor, or settlement.

## Invariants

- **Audience is resolved against the reader at read time**, in
  `listActivityEventsForUser` and nowhere else. Storing recipients instead freezes
  the audience at write time, so someone added to a work stream today would never
  see what happened in it yesterday.
- **After the DO authority switch, work-stream audience uses the versioned
  WorkspaceDO viewer directory**, not the frozen legacy participant table.
  System work streams are excluded through the matching common row. Before the
  switch, the legacy rows remain the authority for the same query.
- **Recording involvement never grants visibility.** A target row outside the
  audience is stored and still filtered out on read.
- **`event_sequence` is the only cursor axis.** Never cursor on `created_at`, which
  is display and retention only, and never on `occurred_at` — a connector poll
  inserts events whose provider timestamp is hours old. Timestamps tie within a
  millisecond and any tiebreak can place the second event below a cursor taken
  after the first, dropping it from every future read.
- **`digestible` is fixed on the row when it is written**, and
  `listActivityEventsForUser` takes a *required* `digestibleOnly` — required rather
  than defaulted because both readings are legitimate and the wrong one is
  invisible.
- **Anything reaching `workspace_activity_events` goes through the typed
  `recordActivityEvent` contract and sets `digestible` itself.** The strict
  object-local column has no default, so an undecided producer cannot fail open.
  Legacy D1 rows use their historical default only while being imported and are
  scrubbed before the WorkspaceDO route activates.
- **The window ends at the top of the log, not at the last digestible event.** The
  cursor steps over what was withheld; stopping short would make every later
  occurrence re-scan the same withheld rows forever.
- **Which events matter is declared by the connector's manifest**, not here and not
  in the digest.
- **The top of the window is frozen before the run starts.** That is what makes
  events arriving mid-run belong to the *next* digest rather than being skipped.
- **The occurrence is claimed before its work stream is created.** Exactly one
  attempt per occurrence gets past the unique `(digest_schedule_id, planned_for)`
  insert, so there is no second creator to race.
- **Whether a launch happened is read from the returned run id, never from the
  row's status.** The status write is itself inside the attempt, so a launch that
  succeeded and failed only to record itself still leaves the row `planned`, and
  releasing that would strand a live run.
- **A run that cannot find its brief throws rather than proceeding.** An unsettled
  delivery folds its window into the next occurrence; one that runs blind consumes
  the window and delivers nothing.
- **Digests never touch `workstream_read_states`.** A digest cursor means "what you
  have already been told"; a read waterline means "what you have read". Collapsing
  them would let skimming an email on a phone silently clear the unread badges in
  the app.
- **A digest has no timezone of its own.** `users.timezone` answers when its
  wall-clock times are, and a second copy would disagree the first time somebody
  moved.
- **Destinations are resolved and frozen before anything is written on save**, so a
  destination that has gone away fails the request rather than leaving a schedule
  that fires into nowhere. The workspace alarm is refreshed *after* the write,
  because the scheduler reads WorkspaceDO.
- **A digest row is never deleted.** Switching one off keeps the row with
  `enabled = 0`, so absence unambiguously means "never had one" and the reconciler
  cannot resurrect it.
- **`digests-enabled` gates firing and client visibility, never a person's own
  configuration.** It is checked before the occurrence is claimed, so a skip
  moves no cursor and the reconciler keeps creating and repairing digest
  defaults exactly as if the flag did not exist. It fails open to keep
  sending — the opposite fail direction from the four presentation-only
  client flags, even though it is now client-visible like they are — see
  [`feature-flags.md`](feature-flags.md).
- **The Digest settings section reads the identical evaluation the scheduler
  uses.** `client-feature-flags.ts` calls the same `resolveDigestsEnabled`,
  never a second "is it off for the workspace" check the client combines with
  it. One evaluation, reused, so the section's visibility and the scheduler's
  behavior can never disagree about the same person in the same workspace.

## Boundary

This document owns the WorkspaceDO activity log and the scheduled digest that is its
first consumer. It does not own:

| For | Read |
| --- | --- |
| Which connector activity types are worth telling someone about | [`connectors.md`](connectors.md#declaring-what-a-digest-may-read), [`connector-digestibility.md`](connector-digestibility.md) |
| The WorkspaceDO connector-event authority, global route, Queue, and processing Workflow | [`connectors.md`](connectors.md) |
| The agent loop a digest run rides on | [`agent-harness.md`](agent-harness.md) |
| WorkspaceDO directory paging, which digest work streams take their place in | [`workstream-pinning.md`](workstream-pinning.md) |
| The scheduler and its alarm | [`architecture.md`](architecture.md) |
| The columns and their constraints | [`data-model.md`](data-model.md) |
| The other consumer of a connector's `userDelivery` surface | [`workstream-email-addresses.md`](workstream-email-addresses.md) |
| The `FLAGS` binding, the other three resolvers, and how each one fails | [`feature-flags.md`](feature-flags.md) |

A surface that wants "what happened, for this person, since this instant" reads
the workspace activity log through `listActivityEventsForUser`. Nothing else is a supported
entry point, and nothing else resolves audience correctly.

## Failure modes and limits

- **Events older than ninety days are reaped**, oldest-first, by the owning
  WorkspaceDO's one alarm in bounded batches. Reaping never disturbs a cursor —
  an expired `event_sequence` sits below every
  live one, so a window that has lost its rows reads as empty rather than as new. A
  surface that wants to read further back needs this number raised, not a second
  table.
- **`recordActivityEvent` never throws into its caller.** An event log that can fail
  a message post is worse than one that occasionally misses a row; use
  `recordActivityEventOrThrow` where the write genuinely has to land.
- **An empty window settles as `empty` without running the model**, and its cursor
  still advances. It never creates a work stream, so an occurrence with nothing to
  say costs nothing.
- **An attempt that throws before the harness is launched releases both the claim
  and the work stream**, so the scheduler's retry starts clean rather than
  accumulating an empty transcript per failure.
- **A target type with no `CONNECTOR_DELIVERIES` entry is skipped rather than
  failing the run** — it was saved by a region that has the connector and this one
  does not.
- **Each destination settles independently** and records its own
  `last_delivered_delivery_id`, so a retried workflow step re-sends only what has
  not landed. The delivery is marked `delivered` only after every destination has
  settled, and one the provider permanently rejects moves to `needs_input` and is
  surfaced on the digest rather than failing silently forever.
- **A member with no account address is skipped by the reconciler**, because the
  default destination is that address.
- **Digest work streams accumulate and nothing reaps them** — roughly one per digest
  per person, about 260 a year each for a weekday digest. That is a deliberate trade
  for being able to open any past run and read what it actually did; the rows are
  small, and `digest_deliveries.summary_markdown` keeps the digest text whether the
  transcript survives or not. If the volume ever stops being worth it, a bounded
  maintenance Workflow driven by the workspace scheduler is the shape it should
  take, and the cascade already takes the transcript's dependent rows.
- **The email is dark only** — not because the app has one appearance, which it
  does not, but because a mail client cannot report the reader's chosen theme, so
  it renders in the shipped default. It renders a Markdown subset: titles,
  sections, subheads, bullets one level deep, numbered lists, links, bold,
  emphasis, inline code, blockquote, and tables or fenced blocks kept verbatim in
  a `<pre>`. Other unknown syntax degrades to visible text rather than being
  passed through as HTML.
- **`digests-enabled` resolves to enabled on every failure mode** — no binding,
  a binding that throws, an unresolved flag, a non-boolean value — and only an
  explicit `false` variation turns it off. `digest-flags.ts` never throws, so a
  Flagship outage cannot stop a digest that would otherwise have sent.
- **A resolution to disabled logs at `info`, not the `debug` every other
  outcome uses.** No `digest_deliveries` row is written when the flag skips an
  occurrence, by design, so the log line is the only trace an operator has
  that the switch took effect — `debug` sits below both regions' configured
  production level and would leave the skip invisible.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test-workers/workspace-read-cost.test.ts` | Activity first-page, resumed, and empty cursor results plus workerd rows-read cost; run with `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/workspace-read-cost.test.ts`. |
| `apps/api/test/activity-event-projection.test.ts` | Projection from `activities`, audience resolution, target rows, and the cursor. |
| `apps/api/test/digest-run-context.test.ts` | That the brief reaches the model through the run's trigger context **and** that the transcript row stays invisible to it. The two halves are pinned together deliberately, because a digest run that reaches the model without its window does not report that it cannot see one — it writes that nothing happened, and that shipped. |
| `apps/api/test/digest-email-content.test.ts` | The digest shell: inline styles, counts, and the preheader. |
| `apps/api/test/email-markdown.test.ts` | The shared Markdown subset, escaping, refused link targets, and the preview line. |
| `apps/api/test/digest-schedule.test.ts` | The day mask, one `schedules` row per time, timezone re-derivation, and the reconciler's two passes. |
| `apps/api/test/digest-run.test.ts` | The frozen window, the claim, the empty settle, the release on a pre-launch throw, and that a `digests-enabled` skip claims nothing and moves no cursor. |
| `apps/api/test/digest-flags.test.ts` | That `digests-enabled` fails open on every failure mode and only an explicit `false` variation turns it off. |
| `apps/api/test/digest-delivery.test.ts` | Independent per-destination settlement, the skipped unknown target type, and `needs_input` on a permanent rejection. |

Run one with
`pnpm --filter @rally/api exec vitest run test/digest-run-context.test.ts` — the
path is package-relative.

**A test proves the markup contains a string, not that the hierarchy reads.** Every
visible change to the email template is looked at through
`scripts/preview-digest-email.mjs` before it is called done — see
[Looking at it](#looking-at-it), which also names the two rendering failures the
preview does *not* reproduce on its own.

## Changelog

### 2026-09-09 — Preserve digest identity when introducing authored access mail

**What changed:** The shared Resend caller accepts a trusted per-message From
override for the authored acknowledgement.

**Why:** New access mail comes from Adam while digests retain their configured
notification identity.

**Considered and rejected:** Changing the global sender would also rename digest
and unrelated transactional mail.

**Consequences:** Existing caller resolution is unchanged. [Private access](private-access.md)
owns freezing the new message's sender and its domain-verification requirement.

### 2026-09-09 — Seek directly to the activity cursor

**What changed:** Activity reads add a direct sequence lower bound when a cursor
exists. The RPC regression test covers zero, resumed, and empty cursors, mixed
filters, and the first digest's non-null time floor.

**Why:** The optional-cursor OR prevented SQLite from seeking past history.
Production inspection measured 108,665 reads versus 1 for an empty direct range.

**Considered and rejected:** Adding an index or migration: the primary key
already supports the range. Retained the explicit no-cursor branch instead of
substituting zero, preserving its unbounded semantics. Fixed SQL fragments and
their conditional binding must change together.

**Consequences:** Keep the supplied cursor as a direct range, guarded by workerd
rows-read assertions. This guarantee concerns the main-table resumed seek only:
the first digest's time-filtered, sequence-ordered path can still scan history,
and target aggregation can read targets outside the cursor window. Neither cost
is claimed fixed here. Audience and other filters retain their existing behavior.

Shipped in [#628](https://github.com/juno-ai-labs/avalon/pull/628).

### 2026-09-08 — Deliver substream notifications without publishing child activity

Direct child mention and membership notifications now reach their recipient
through the existing transport. The parent still suppresses child activity, so
making a tag audible does not put private conversation excerpts into shared
activity or digest inputs. Notification links open the addressed child; email
reply routing remains unchanged.

### 2026-08-30 — A bare `<br/>` becomes a line break in email prose

**What changed:** `email-markdown.ts` rewrites a bare break tag to `<br>` in the
HTML part (after escaping, after parking code spans) and to a newline in the
plain-text part (outside code spans and preformatted pipe rows).

**Why:** The desktop renderer now honours the same tag, and these two surfaces
showing different bytes for the same briefing is the drift this module already
paid for once. Tables stay preformatted here, so a break tag inside a pipe row
is still characters — this renderer has no table model.

**Considered and rejected:** Flattening email tables into real HTML tables just
to honour the tag. That is a second table renderer, not a break-tag fix.

### 2026-08-30 — Sidebar facepile omits the current viewer

**What changed:** A personal sidebar row no longer paints the signed-in person's
face. If they are the only participant, the trailing slot is empty rather than a
one-person pile. Overflow subtracts them when they sat past the three painted
ids. The public globe and each remaining face use the standard tooltip — "This
is a public work stream", and the person's name.

**Why:** a facepile of yourself is noise, not information: you already know you
can see the row. The directory preview is still the same payload for every
participant, so the omission is a render-time filter rather than a per-viewer
wire field. Native `title` on the globe and on non-present faces was a second
tooltip language next to the Radix chrome the rest of the row already uses.

**Considered and rejected:** dropping the viewer from WorkspaceDO's preview so
each recipient got a different id list. Membership is common state for everyone
who can see the row; a per-viewer cap would split that. Also rejected: keeping
native `title` beside the Radix tooltip, which would show both on a long hover.

**What a future change has to respect:** the wire may still include the viewer.
The desktop is what omits them. Do not add a second tooltip language for this
slot.

### 2026-08-30 — Facepile order is join time

**What changed:** The three faces on a digest (and every other personal)
sidebar row are the most recently added participants, not the most recently
rewritten overlay rows. Overflow counts unresolved ids, and the pile is hidden
from the row's accessible name.

**Why:** overlay `projected_at` is not join recency, and the original entry's
"newest" reading collapsed to UUID order after a message. Join time is the
clock both directory and `summary()` already share.

**Considered and rejected:** a digest-specific clock. Digests are personal work
streams; they take the same preview as every other personal row.

**What a future change has to respect:** do not sort this pile by overlay
`projected_at`.

### 2026-08-30 — Sidebar facepile is the existing AvatarStack, not a compact variant

**What changed:** Digest (and every other personal) sidebar rows use `AvatarStack`
at its existing 24px size. The compact size that had been added for the trailing
slot is gone.

**Why:** a second visual was a parallel facepile, not reuse of the one the header
and participant chips already paint. The Air row is 31px; 24px faces already fit.

**Considered and rejected:** CSS-shrinking the stack only in the sidebar. That
would still be a second look. `extraCount` stays because the directory list is
already truncated to three ids; inventing dummy members so the native overflow
could fire would pollute the accessible name.

**What a future change has to respect:** `AvatarStack` itself is the sidebar
facepile. Do not add a size for this slot.

### 2026-08-30 — Digest sidebar rows wear a facepile, not the note lock

**What changed:** A personal work stream's sidebar trailing slot is a compact
facepile of its participants (three newest, then `+x`), and a workspace-scoped
row wears a globe. Digest occurrences are personal, so Debug-enabled digest
rows pick up a one-person pile. The work-stream header **Private** badge is
unchanged. Notes still wear the lock.

**Why:** the lock on every personal work-stream row was read as "only you",
which is true of a digest but not of a private work stream that several people
are in. The pile is the people the row is closed to; the lock stays on notes
because a note has no participant set to pile.

**Considered and rejected:** keeping the lock on machinery rows so a digest
still looked like a private note. That reintroduces a second marker for the
same `scope = 'personal'` column, which is the thing the original private
marker existed to avoid. Also rejected: a REST fetch of participants for the
sidebar. The directory already holds viewer rows; the wire carries three ids
and a count.

**What a future change has to respect:** workspace-scoped rows must not carry
participant ids. The directory paints a globe, not a pile, and must not send
what it does not paint.

### 2026-08-29 — Digest settlement receives only saved canonical result text

**What changed:** Digest terminal settlement now receives the same normalized
text rendered from a reloaded canonical turn as other external destinations. A
run with no saved result, or only whitespace, passes `null`; the digest
settlement authority marks that occurrence failed and does not advance its
cursor or synthesize a replacement summary.

**Why:** External delivery previously manufactured a generic completion or
failure sentence when a run had no result text. That made a host-authored
sentence look like the digest the model was required to save and could consume
the window without delivering its contents.

**Considered and rejected:** Keeping a digest-only fallback because email is not
a chat stream. The authority problem is the same for every destination: content
that is absent from the canonical transcript cannot become the external result.

**What a future change has to respect:** Digest delivery may format saved text,
but it must not replace missing saved content with status prose. A missing result
fails the occurrence so its events remain eligible for the next digest.

### 2026-08-29 — The digest tables answer to typed WorkspaceDO methods, not routed SQL

**What changed:** Every digest statement the services sent through the
workspace runtime facade — the settings read and wholesale save, the
reconciler's on-by-default insert and derived-row repair, the timezone rebuild,
the occurrence claim and its lifecycle transitions, settlement, and the
per-destination delivery records — is now a typed method on `WorkspaceDO`
(`workspace-digests-protocol.ts` for the contracts,
`workspace-digests-storage.ts` for the SQL). Three read-then-write sequences
became single object transactions with returned witnesses: the first save
decides create-versus-update inside the write, the reconciler's default answers
`created` from the branch it took rather than from a physical write counter,
and settlement is a compare-and-set whose loser is told `already_settled`. One
routed statement deliberately remains: the settings read that joins
`digest_delivery_targets` to `connector_connections` for display names, which
is the connectors domain's conversion to make. The digest names stay on
`WORKSPACE_LOCAL_TABLES` so an accidental generic statement still routes to the
object rather than failing as D1's `no such table`.

**Why:** the facade classifies each statement by the table names in it, and a
WorkspaceDO table missing from its list is silently answered by regional D1 —
the routing defect that took automation run work streams down in production
(PR #401). A typed method cannot be routed to the wrong database, because its
tables are named inside the object that has them. The round trips were also
live races, not just latency: two concurrent first saves both read "no digest
yet" and `UNIQUE (workspace_id, user_id)` 500ed the loser, and two settlement
attempts of one retried workflow step could both read `running`, both settle,
and both emit the terminal telemetry and append the delivery note.

**Considered and rejected:** converting the delivery-targets display-name join
by splitting it into two typed reads. Both tables live in this object, so the
split is possible — but `connector_connections` belongs to the connectors
domain, whose conversion lands separately in this stack, and carving one of its
reads out here would leave that domain's boundary drawn in two places. Also
rejected: moving the RRULE derivation into the object with the write it feeds.
The recurrence policy is the service's; the object writes exactly the derived
rows it is handed, so *when* a digest fires never becomes a storage question.

**Consequences:** digest state in a Node test now lives in the object database
`createTestWorkspaceDO` stands up, not in the regional fixture — a test that
seeds or asserts digest rows must use the object store, and the suites in
`apps/api/test/digest-*.test.ts` are the worked examples. Settlement side
effects (terminal telemetry, the transcript delivery note) belong to the
attempt whose settle returned `settled`; a new settlement branch must check
that witness rather than assume it won. The methods that rewrite derived
`schedules` rows re-arm the workspace alarm themselves, mirroring the generic
SQL path's backstop, so a future caller that forgets `refreshWorkspaceSchedule`
degrades to a late alarm rather than a dark one.

Shipped in the facade-to-RPC stack (PR 6 of 9), on top of
[#401](https://github.com/juno-ai-labs/avalon/pull/401)'s routing repair.

### 2026-08-28 — Both email passes read one shared answer for where a fence ends

**What changed:** `email-markdown.ts` no longer tracks fenced blocks itself.
`blocksFromMarkdown` — which keeps a fenced block whole in a `<pre>` rather than
flattening it into a paragraph — and `markdownToEmailText` — which drops the
delimiters and indents the body four columns — both read `markdownLineKinds`
from `@rally/contracts/markdown-code`. No output changed for any input the
suite covers.

**Why:** the two passes here were two of five copies of the same question, and
they did not agree with each other, let alone with the citation reduction and
the TeX repair that run immediately before them on the same string.
`markdownToEmailText`'s copy was the loosest of the lot — a bare toggle, so any
fence line flipped the state regardless of its character or length — and
`blocksFromMarkdown` recorded only the first three characters of an opener, so a
```` ``` ```` line closed a ```` ````` ````-opened block.
[`markdown-code.md`](markdown-code.md) records the extraction and why the shared
rule is the citation copy's.

Measured against a vendored copy of the old renderer over 5,832 documents, 2,109
differ and every one is a fence-rule convergence: a closer must now repeat the
opener's character and reach its length, and a delimiter indented four or more
columns, or by a tab, is an indented block rather than a fence. The first two
leave a block whole where the old rules ended it early — `blocksFromMarkdown`
used to accept a closer whose leading whitespace it had trimmed away. None of
them is an input any test pinned.

Both passes read the *fence* kinds only, not the classifier's indented-code
answer. This is a renderer rather than a rewriter: an indented chunk is not a
block boundary in its model, and the rules below it already give one a
paragraph. Reading the extra kind would change what an indented block renders
as, which is a separate decision from where a fence ends.

**Consequences:** the citation reduction, the TeX repair and this renderer can
no longer disagree about which lines of the same email are code, which was the
failure worth removing — all three run over one string in sequence, and a
disagreement between them shows up as a rewritten code sample in somebody's
inbox with nothing failing anywhere.

### 2026-08-28 — The reduction leaves indented code alone too

**What changed:** The shared grammar's three passes read one `codeLines`
classifier, which recognises indented code blocks as well as fenced ones. A
destination may also carry one level of balanced parentheses.

**Why:** An indented example is the other ordinary way a model shows this
syntax, and the reduction was rewriting it — a taught `[the deck](resource://abc)`
arrived here as `the deck`, editing the sample. The parenthesis half is narrower
and just as visible: stopping at the first `)` truncated
`…/Function_(mathematics)` in the delivered source list, naming a URL that goes
nowhere.

**What a future change has to respect:** What counts as code is `codeLines`'
decision and nothing else's; a caller that grows its own fence tracking is how
the transcript and the delivered copy start disagreeing about numbering again.

### 2026-08-28 — The reduction is written for the surface that renders it

**What changed:** `rewriteCitationsAsPlainText` takes a `sources` option:
`markdown` (the default, for the HTML and text paths here, which render Markdown
and reduce its marks), `plain`, and `none`. `markdownToEmailPreheader` uses
`none`, and so does `mention-email-service.messageExcerpt`.

**Why:** The reduction emits Markdown — a `**Sources**` heading and
`[label](url)` for an external source — and two of the surfaces it was given
render none. A mention excerpt is HTML-escaped into a table cell and quoted into
the plain-text body, so the list arrived as literal syntax; it is also a single
line, and `singleLine` flattened a bibliography into the quote, where it
competed with the length budget and truncated mid-entry. The preheader is the
160 characters an inbox shows beside the subject, and appending the source list
before truncating spent them on `Sources 1. Q3 deck` for any answer short enough
to reach it. Both call sites want the reduction and neither wants the list.

**What a future change has to respect:** A new caller picks the shape its
consumer can render, the way `normalizeModelMarkdown` and `normalizeModelText`
are already two entry points for the same reason. The default is the Markdown
one, so a caller that renders nothing has to say so.

### 2026-08-28 — The reduction reads code and titled links the way the parser does

**What changed:** Two corrections in `rewriteCitationsAsPlainText`, both in
`@rally/contracts/citations` rather than here. A `[^1]` inside an inline code
span no longer counts as a footnote reference, and the inline-link pattern now
matches a label carrying balanced brackets, an angle-bracketed target, and a
trailing title.

**Why:** Both were silent leaks of the kind this reduction exists to close, and
both are reachable from ordinary model output. A message explaining the citation
syntax — an ordinary thing to ask Rally for — was delivered with a `Sources`
list it never claimed, and any real footnote beside it was renumbered, so the
delivered copy and the transcript disagreed about which source was `[1]`. And a
link the desktop drew as a chip but this pattern did not match arrived with its
raw `resource://` target in the text: `[the deck](resource://abc "Q3")` is a
link to every Markdown parser in the path, including the one Rally renders with.

**What a future change has to respect:** The pattern here is meant to be as wide
as the renderer's parser, not as wide as the guidance's examples. Anything the
desktop turns into a chip and this leaves alone becomes raw internal syntax in
front of a recipient.

### 2026-08-27 — Every email reduces a model's citations before rendering

**What changed:** All three `email-markdown.ts` entry points run
`rewriteCitationsAsPlainText` ahead of their existing work — before
`normalizeModelMarkdown` on the two that call it. Chips and embeds reduce to
their label text; footnotes reduce to numbered markers over one trailing source
list.

**Why:** Model answers began carrying `resource://` targets and GFM footnotes,
and this renderer had no rule for any of it — the HTML path links only
`http(s)`, so an internal link passed through as literal bracket syntax; the
text path appends any target it is given; footnotes were unhandled in both. A
reader would have got a raw internal URL and a page of `[^1]` markers above
nothing. The rejected alternative was teaching this renderer to render
citations: there is nothing for a mail client to render them *as*, and a
trailing source list is the one place a source can live on a surface with no
rail to open.

**Consequences:** The ordering is a constraint, not an accident — widening what
`normalizeModelMarkdown` escapes breaks citation rewriting in email, several
modules from the cause. The reduction is idempotent, so a path that grows a
second call does not double-renumber. Shipped in
[#381](https://github.com/juno-ai-labs/avalon/pull/381). Design:
[`docs/PRDs/2026-08-27_inline-resource-citations/prd.md`](PRDs/2026-08-27_inline-resource-citations/prd.md).

### 2026-08-25 — The Digest settings section hides when digests-enabled is off

**What changed:** `ClientFeatureFlagsSchema` gained `digestsEnabled`, resolved
in `client-feature-flags.ts` through the same `resolveDigestsEnabled` the
entry below already added. Electron's Settings screen drops the Digest nav
item and section entirely — not a disabled state, an absent one — for
whoever it resolves `false` for.

**Why:** The entry below deliberately kept this flag off the client, on the
grounds that nothing needed a value pushed to a connected socket. That left a
real gap: a person whose digest was turned off from outside their control
would open Settings and see it reported as configured and on, with nothing
telling them why nothing was arriving. Hiding the section is the honest
answer to "is this available to me right now," which showing it — disabled
or not — is not.

**Considered and rejected:** Showing the section with a "paused" notice
instead of hiding it. Reasonable on its own, but not what was decided here;
recorded as the alternative in case the hidden version turns out to need
revisiting once this has real usage behind it.

**Consequences:** The Ace-save Queue fan-out this flag already triggered —
previously a harmless no-op, since nothing read the result — now has a real
client effect: a save through Ace propagates to a person's Settings screen
the same way an `automation-workspace-templates-enabled` change already does.
`reconcileDigestDefaults` and `digest_schedules` are untouched by this — the
row a person configured is exactly what it was — but their digest has in
fact stopped arriving, the same `flag_disabled` skip the scheduler already
returns for them. The section is withdrawn because this screen has no copy
for a paused state, not because nothing changed.

### 2026-08-25 — Scheduled digests get an operational kill switch

**What changed:** `digest-flags.ts` adds `digests-enabled`, a Flagship boolean
checked at the top of `fireDigestSchedule` — right after the schedule's own
`enabled` bit and before the occurrence is claimed. It fails open: no binding,
a throw, an unresolved flag, and a non-boolean value all resolve to enabled,
and only an explicit `false` variation actually served by Flagship stops
delivery. It is managed through Ace, alongside the four existing product
Booleans, but is provisioned **on** rather than off — the one call to
`ensureFlag` in `apps/ace/scripts/deploy.mjs` that passes an explicit default.

**Why:** Every kill switch already in the codebase — the four Ace-managed
product Booleans — defaults off and is presentation-only: Electron hides a
surface while the API keeps serving it underneath. Digests are the opposite
case: on by default for every existing person, fired from a cron reconciler
nobody visits a settings screen to trigger. Copying the product-flag pattern
verbatim, default and all, would have silently stopped every digest the
moment the flag was first provisioned. What was wanted was a real stop: an
operator able to turn digest delivery off, from the same editor they already
use for every other flag, without touching anyone's saved schedule,
destinations, or cursor.

**Considered and rejected:** A CLI-only path outside Ace, parallel to the
agent-model flags — the more surgical choice, since nothing here needs a value
pushed to a connected desktop socket the way Ace's fan-out exists to do. It
was rejected for the same reason the presentation flags are not split across
two editors: a second, undiscoverable way to change a Boolean flag is worse
than one editor doing slightly more than its fan-out strictly needs. Also
rejected: gating `reconcileDigestDefaults` instead of the fire path, which
would conflate "does this person have a digest configured" — a product
default, adjustable per person — with "are digests currently allowed to
send" — an operational switch — and would leave a flipped-off flag fighting
the reconciler's own idempotent repair on every cron tick.

**Consequences:** `digest-flags.ts` is the fourth module reading `env.FLAGS`
directly, alongside the three [`feature-flags.md`](feature-flags.md) already
named, and is the only one of the four not consulted through
`client-feature-flags.ts` — it is Ace-managed but not client-visible, so a
save still enqueues Ace's ordinary Queue fan-out even though no connected
client reads this key. That is harmless rather than free: the fan-out always
re-evaluates and re-sends the complete client contract regardless of which
key changed, so this simply repeats work already safe to repeat. A flag skip
is indistinguishable from a quiet schedule from the delivery table alone, the
same ambiguity an `empty` settlement already carries; unlike an `empty`
settlement, though, a flag skip claims nothing, so the cursor does not move
and the missed window is fully recovered the moment the flag serves `true`
again.

### 2026-08-23 — Every email repairs a model's TeX, and consumes the escapes that repair writes

**What changed:** `email-markdown.ts` normalizes on all three of its outputs —
`markdownToEmailHtml` through `normalizeModelMarkdown`, the plain-text
alternative and the preheader through `normalizeModelText` — so `$\rightarrow$`
reaches an inbox as `→` in the digest and in an automation's result alike. The
inline pass parks Markdown escapes behind the same placeholder the code spans
use, before the link pass runs, and restores them as their characters at the
end.

**Why:** the branch that built the TeX repair originally carried its own
enriched digest renderer — tables, task marks, per-width nesting — and that
work was superseded mid-flight when the shared renderer landed and the digest
moved onto it; the enrichment was dropped with its tests rather than fought
over, since the shared renderer's leaner scope is a recorded decision. What
could not be dropped is the repair itself, and its contract: the normalizer
escapes what it unwraps on the promise that the parser downstream eats the
backslash. This renderer is that parser, so without the escape pass a repaired
`$\text{a\_b}$` reached readers as `a\_b` — the artifact class the repair
exists to remove. The escapes are parked *before* the link pass, not unescaped
after it, because `\[a\](https://…)` read through its escapes is a link with a
target its label promised was plain text; and a backslash inside backticks — a
regex's `\.` — is stepped over, because there it is code. Both directions are
pinned by tests that fail without the pass.

**Consequences:** a future email that carries a *person's* words verbatim needs
an opt-out at the entry points first, the way `MarkdownBody` grew one — every
body rendered today is a model's. The plain-text alternative deliberately uses
the entry point that manufactures no escapes; swapping the two entry points is
the failure the normalizer's module document names as its first invariant.

Shipped in #257.

### 2026-08-22 — Being added to a work stream is an event, and a notification

**What changed:** `addParticipant` writes a `workstream_participant_added`
activity event, audience `workstream`, `digestible = 1`, with the person added
as an `added` target. It also emits a `participant_notification` regional
effect, which becomes a `workstream_notification_intents` row under
`notification_kind = 'participant_added'` and reaches the person as a Slack DM,
or as email when no Slack account resolves. `WorkstreamObjectProduct` is now the
log's second first-party producer.

**Why:** this log exists so that "what happened for this person" is one query
rather than a fan-out, and being added to a work stream was missing from it
entirely — so the daily digest could not mention it, and neither could anything
else. The gap showed up as a support report: a colleague added to a work stream
heard about it from nobody. Adding the event without the notification would have
left the person waiting up to a day to find out; adding the notification without
the event would have left the digest still unable to say it.

**Considered and rejected:** `digestible = 0`, on the grounds that a person
already got a DM about it. The two answer different questions — the intent is
whether one person is told now, `digestible` is whether the event is worth
recalling in a summary of the day — and somebody who was added while away
should still see it in the digest that covers that day. Also rejected: an event
per participation change, including removals. Being removed is not something
Rally should announce to the person it happened to, and nobody asked for the
audit trail.

### 2026-08-22 — The Markdown renderer moves out of the digest

**What changed:** The Markdown-to-email-HTML renderer and the shared palette now
live in `email-markdown.ts`. `digest-email-content.ts` keeps the digest's own
shell and calls it. The renderer also gained one level of list nesting and
`*asterisk*` emphasis, both of which it previously passed through as
punctuation.

**Why:** The automation result email needed the same rendering — it was escaping
Markdown into HTML and mailing `##` and `**` to readers — and a second copy of a
security-sensitive renderer is a second place for an escaping rule to be missed.

**Considered and rejected:** Importing `digestMarkdownToHtml` from the digest
module. It works, and it makes every later reader of the automation email believe
the digest owns rules that are common to both.

**Consequences:** The renderer is shared, so a change to it changes the
automation result email too, and both emails' tests have to be read before one
is edited. The digest's own From address moved with it: with
`RESEND_NOTIFICATION_FROM_EMAIL` now configured, a digest arrives from
`notifications@with-avalon.com` rather than the invitations address it had been
falling back to.

### 2026-08-20 — The email preview stops querying retired D1 product tables

**What changed:** The preview still uses D1 to enumerate real active members,
but its body and work-stream labels are representative samples. It no longer
queries `digest_deliveries` or product columns on `workstreams`, both of which
are absent after migration 0090.

**Why:** A visual fixture may read identity data without turning D1 back into a
digest or directory serving surface. The old queries made the preview fail on
the production schema after the authority cutover.

**Considered and rejected:** Reading WorkspaceDO SQLite files directly. That
would couple a template preview to local Miniflare object layout and would not
work for a remote D1 export anyway.

**Consequences:** The preview proves the real template with real recipient and
workspace names, but not a previously delivered body. Product-content review
must obtain that body through the product API or an explicit fixture.

### 2026-08-18 — Slack-only members still receive schedule repair

**What changed:** Digest reconciliation pages across every active member rather
than excluding blank email addresses in the regional query. A member without an
email still does not receive a newly invented email target, but an existing
Slack-backed digest has its missing or timezone-stale scheduler rows repaired.

**Why:** Email availability is a delivery-target concern, not a prerequisite
for maintaining an existing digest. Applying it to the outer member scan made
a Slack-only member's enabled digest silently stop after partial creation or a
timezone change.

**Considered and rejected:** Synthesizing an email destination or skipping the
member entirely. The former is invalid product state; the latter also skips
delivery-independent schedule repair.

**Consequences:** The keyset sweep covers more members, still in bounded pages.
New defaults remain email-backed only when a real nonblank address exists.

### 2026-08-18 — Digest scheduling and delivery move beside the activity log

**What changed:** Digest schedules/times/targets/deliveries, their canonical
`schedules` rows, and external-delivery attempts now live in WorkspaceDO with
the activity cursor they consume. WorkspaceScheduler reads those rows through
typed RPC; the sender rechecks D1 identity but settles attempts in WorkspaceDO.

**Why:** A digest and all of its state belong to one workspace. Keeping timing
and delivery state in D1 split each occurrence across two authorities.

**Considered and rejected:** D1 schedule/delivery projections and copying the
activity cursor into D1. Either makes the control plane authoritative again.

**Consequences:** Save-before-arm and idempotent occurrence semantics are
unchanged, but their transaction boundary is local to WorkspaceDO. An object
outage fails closed rather than reading or writing legacy D1 rows.

### 2026-08-18 — The first-party activity log moves into WorkspaceDO, and digest projection starts from a WorkspaceDO-owned connector event

**What changed:** `workspace_activity_events` and target edges now live in the
owning WorkspaceDO. The same object resolves work-stream audience against its
directory, maintains the monotonic cursor, and reaps retention by alarm. The
maintenance importer preserves existing D1 cursor values before writer fences
make the source immutable.

Connector ingest authority is also the owning WorkspaceDO, and the
connector-event Workflow performs the projection into that insertion-ordered
first-party activity log. D1 `activities` is documented as a 24-hour handoff,
not provider history.

**Why:** Every event belongs to one workspace, and its only non-membership
visibility join is already WorkspaceDO-owned. Keeping the log in D1 made digest
serving depend on two product authorities and retained a regional serving table
solely for a join the object could execute locally. On the ingest side, the
normalized provider event belongs to one workspace, while the derived log has
separate audience/cursor semantics; conflating either with a long-lived regional
staging row preserved an unnecessary second authority.

**Considered and rejected:** For the log: copying directory visibility back into
D1, fanning out one event per recipient, and keeping a D1 read projection. Those
alternatives either restore split authority or freeze a mutable audience at
write time. For projection: reading raw provider deliveries during a digest and
keeping D1 activity bodies indefinitely for convenience. The former cannot
reproduce normalized visibility; the latter defeats WorkspaceDO ownership.

**Consequences:** D1 still owns schedules, delivery destinations, active
membership, and notification transport state. Digest windows and user-facing
activity reads are WorkspaceDO RPCs; a WorkspaceDO outage fails closed and never
falls back to frozen D1 rows. Digest projection retries from the durable
Workflow claim. The activity log remains a derived first-party product and never
becomes the source for reconstructing the normalized provider event.

### 2026-08-18 — Activity audience and system-work-stream lists use WorkspaceDO

**What changed:** Post-cutover activity-event audience resolution asks
WorkspaceDO for visible work-stream IDs, and renderer list pagination/system-row
filtering is served from the same object's authoritative directory. D1 retains
the insertion-ordered `activity_events` log and digest schedules/deliveries, but
not work-stream audience or sidebar projections.

**Why:** The log is a relational workspace-wide workload, while participant
visibility and list placement are work-stream product state. Keeping the former
in D1 does not require copying the latter there.

**Considered and rejected:** Reading every WorkstreamDO for each digest page and
retaining D1 common/user projections only for audience joins. The former is
unbounded; the latter restores a second authority solely to make one join local.

**Consequences:** Activity reads perform one bounded WorkspaceDO visibility call
before their D1 query. A WorkspaceDO outage fails the audience read closed;
frozen legacy participant rows are never a post-cutover fallback.

### 2026-08-17 — WorkstreamDO events enter the regional activity log durably

**What changed:** Authoritative work-stream mutations emit first-party activity
events through their local outbox and the regional Queue/D1 inbox. Audience
resolution switches to common/user directory projections after cutover.

**Why:** Digests still require one regional insertion-ordered log, while message
and participant authority no longer lives in D1.

**Considered and rejected:** Reading every WorkstreamDO during a digest or
continuing to resolve post-cutover audience from frozen legacy rows.

**Consequences:** Activity delivery is eventually consistent and idempotent;
membership remains evaluated at read time from the current regional projection.

### 2026-08-13 — Digest telemetry cannot interrupt required settlement

**What changed:** Every terminal digest telemetry call now isolates its entire
context lookup and emission. A telemetry query failure after delivery cannot
skip the occurrence transcript's delivered note.

**Why:** The provider delivery and status update are authoritative product work.
Only the final emitter had been caught, leaving its preceding context queries
able to throw after the digest was already marked delivered.

**Considered and rejected:** Retrying the settlement step. Its terminal-status
guard correctly prevents duplicate email, but would also return before writing
the omitted transcript note.

**Consequences:** Digest telemetry remains best effort around the whole helper;
required settlement work must never be placed after an uncaught analytics read.

### 2026-08-13 — Digest configuration and delivery become one measurable lifecycle

**What changed:** Durable schedule replacement and terminal delivery settlement
now emit bounded product events with cadence, target, activity-count, result, and
first-delivery dimensions.

**Why:** A configured schedule did not show whether it ever delivered, while a
delivery row alone could not explain the cadence and destination choices that led
to it.

**Considered and rejected:** Exact schedule times, recipient addresses, activity
identifiers or bodies, generated summaries, and provider error text. None is
needed to measure adoption or reliability, and each adds sensitive or
high-cardinality content.

**Consequences:** Product analytics can join configuration cohorts to delivery
outcomes without becoming the cursor or delivery source of truth. A retry keeps
the delivery's stable event identity.
### 2026-08-12 — The schedule's work-stream pointer is dropped, now that the window it was waiting on has closed

**What changed:** `0070_drop_digest_schedule_workstream.sql` drops
`digest_schedules.system_workstream_id`. Nothing else — no code, no other
schema, and none of the work streams it named.

**Why:** This is the second half of the two-phase drop the entry below left open,
and the only thing it was ever waiting on was a deployment. The rule is that a
migration lands before either Worker deploys, so a column may only be dropped
once every *live* Worker already ignores it. `0068` shipped in #119 and both
regional Workers went live behind it — Global at 05:51:53 UTC, EU nine seconds
earlier — so the Worker running while this migration lands is one that never
touches the column. The condition is met, and the phasing has no further purpose.

Leaving it indefinitely was the alternative and is worse than it looks. A column
the code no longer maintains still reads as *the current work stream* to whoever
finds it next, and it points at work streams that were real when they were
written and are now just the ones a person's earliest digests happened to run in.
`digest_deliveries.workstream_id` is the answer to "where did this run", and two
answers to one question is the thing this document keeps arguing against.

**Considered and rejected:** Deleting the work streams the column pointed at
along with it, on the reasoning that nothing links to them any more. They are
real transcripts their owners can open, and the same argument that keeps
per-occurrence work streams unreaped keeps these: a pointer being dropped is not
a reason to delete somebody's history. They are reachable by URL and, with Debug
enabled, in the sidebar.

**Consequences:** SQLite refuses `DROP COLUMN` for a column that is indexed or
named in a CHECK, a UNIQUE constraint, or a partial-index predicate; this one was
none of those, so the drop is the whole migration and no table rebuild was
needed. That matters for the next person who tries to drop something here —
`activity_events.digestible` would not go the same way, for the reasons in the
entry two below. The migration test now applies `0068` and `0069` in sequence
against the same fixture, so the pair is exercised as the phased change it is
rather than as two unrelated statements.

### 2026-08-12 — A digest run has nowhere to put its summary except the message it ends with

**What changed:** `renderDigestBrief` now opens by telling the run that its final
message *is* the digest and is mailed verbatim — that no summary of it, report
about it, or closing sentence may take its place — and `settleDigestRun` refuses
to settle on a final message too short to be one. The `create_artifact` tool a
digest run could reach — every digest executes the ordinary work-stream loop, so
it loaded `rally_workstream` like any other run — no longer exists. See
[`agent-harness.md`](agent-harness.md#changelog).

**Why:** A run wrote its digest into an artifact and ended with "Outcome: Digest
artifact created (id …)". `deliverResultsDurably` passes `message.textContent` to
`settleDigestRun`, so that sentence became `summary_markdown` and was mailed as
the digest. Nothing failed: the text was non-empty and the run completed, so the
delivery settled as `delivered` and `cursor_through` advanced past events the
recipient was never actually told about. That is the specific failure the "a run
that could not write a digest sends nothing" branch exists to prevent, and it
could not catch this one — from the settlement layer's position a one-line
receipt and a real digest are both just text.

**Considered and rejected:** Reading the artifact when the final message looks
like a receipt. It puts a heuristic between a run and what gets mailed, and every
delivery surface would need its own copy of it.

**Bounded rather than trusted.** The prompt alone would have left the expensive
half of this open — a run can still end on a sign-off, and settlement cannot tell
one from a digest — so `settleDigestRun` now refuses to settle on a final message
shorter than `MINIMUM_DIGEST_CHARACTERS`. That is deliberately a floor on
*implausibility*, not the "does this look like a digest" test rejected above: a
run only reaches settlement when its window held an event, and the brief mandates
an opening sentence, `## ` sections and `- ` bullets, so a real digest clears it
by an order of magnitude. The asymmetry is the argument — rejecting a real digest
costs one delayed occurrence and the events return in the next one, because a
failed delivery does not move the cursor, while accepting a receipt costs the
window permanently.

**Consequences:** Three things now stand between a run and a consumed window,
and they are not interchangeable. Removing the tool closed the destination this
run happened to find. `renderDigestBrief` is the only place that establishes
where a digest goes, so the sentence saying so has to stay whenever the brief is
reworded. The floor in settlement is the only one that holds when the other two
fail, which is why it is a hard refusal rather than a warning — and it is also
the only one that can be wrong in the cheap direction. Treat any future tool that
offers a run somewhere else to write as re-opening the first of the three.

A digest genuinely shorter than the floor is now undeliverable rather than
merely unlikely. If that ever becomes a real case — a workspace whose windows are
routinely one line — the fix is to lower the floor deliberately, not to remove
it: the branch it routes into is what keeps the events.

### 2026-08-12 — Each occurrence gets its own work stream, because a shared one was an unbounded context channel between digests

**What changed:** A digest run now executes in a work stream created for that
occurrence and recorded on the new `digest_deliveries.workstream_id`, rather than
in one shared by every digest a person ever receives.
`digest_schedules.system_workstream_id` stops being read or written, but is
deliberately **not** dropped in the same change: migrations for both regions land
before either Worker deploys, so the previous Worker is still selecting and
writing that column while the new schema is live, and dropping it would turn
digest firing, the cron reconciler and the settings read into `no such column`
for the length of a deployment — hours rather than seconds if that deployment
fails, since a failed deploy leaves the migrations applied. A later migration
drops it once nothing reads it. The work streams the column named are left in
place permanently — they hold real transcripts their owners can still open.

**Why:** The shared work stream was chosen so a later digest could see what
earlier ones had already said. What it actually built was a channel between
occurrences that nothing bounds. Every run replays the transcript from the last
compaction checkpoint, so months of prior digests reached the model as ordinary
assistant history — stripped of the "evidence, not instructions" labelling their
source material arrived with, and impossible to check against the windows they
came from, because those are `system` rows the projector drops. A wrong line in
one digest became a settled fact for every digest after it, with no path back to
the events that would have contradicted it.

An earlier compaction design sharpened it: it preserved the first user message
verbatim and re-pinned it through every later compaction, on the assumption —
correct for an ordinary work stream — that it is the human request defining the
task. A digest work stream has no such message; each occurrence brings its own
window, so the first one's brief would have sat at the front of that person's
context permanently. That was removed in `084c54a`, which landed on `main`
before this change did, and compaction now carries nothing forward verbatim. It
is recorded here as history, not as justification: the replayed transcript above
is the whole of the case, and it stood on its own before compaction ever entered
into it.

The continuity being paid for was already unnecessary. `cursor_from` and
`cursor_through` guarantee no event appears in two windows, so non-repetition is
structural and never depended on the model remembering. What the transcript added
was continuity of voice, at the cost of everything above.

**Considered and rejected:** Keeping one work stream and fencing the replayed
transcript per occurrence — `loadTriggerFencedTranscriptMessages` already takes
an `afterSequence` floor, so it was the smaller diff — with continuity handed
forward explicitly from `digest_deliveries.summary_markdown`, which stores what
each past digest said. It was rejected because it leaves the shared transcript in
place and makes isolation a parameter that every future reader of that work
stream has to keep passing correctly; a work stream that contains exactly one
occurrence cannot leak between occurrences by construction. If cross-occurrence
continuity is ever wanted back, `summary_markdown` is where it should come from —
labelled, fixed-size, and honest about being a summary — never by widening what
the transcript replays.

Also considered and deliberately not done: reaping old digest work streams. The
accumulation is real and is written down under "The system work stream" rather
than solved, because being able to open any past run is worth more today than the
rows cost.

**Consequences:** A digest run is now a pure function from its frozen window to a
summary, and anything that wants it to remember something has to put that
somewhere durable rather than upstream in a transcript. Work streams accumulate
without bound — about 260 per person per year on a weekday digest — and nothing
reaps them. Settlement's delivery note resolves through
`digest_deliveries.workstream_id` instead of joining back through `harness_runs`,
so it lands even when the launch never recorded a run id; it no longer feeds the
next run, and exists for whoever opens the transcript looking for why an email
never arrived. A failed launch now releases its work stream along with its claim,
and decides that on the returned run id rather than the row's status, because
deleting a work stream out from under a live run is worse than leaking an empty
one.

Two things this change had to buy that the split itself did not imply. The
sidebar had to page — it asked for one screenful and dropped the cursor, which
was survivable only while nothing but people made work streams; that is
[`workstream-pinning.md`](workstream-pinning.md)'s entry of the same date. An
attempt to solve the same crowding inside `list`, by lifting machinery out of the
recency order and capping it, was written and then reverted: it added a second
population to one method, with its own bound and its own ordering, to answer a
reachability question paging had already answered.

And the cleanup of a released claim had to get *stricter*, then more precise.
`launchWorkstreamHarness` creates the Cloudflare Workflow instance before it
records the instance id, and marks its own run row `failed` on the way out of
either failure — so neither the run row's existence nor its status distinguishes
"nothing started" from "started, and only the record of it failed". The launch
marks the error instead, and both the claim release and the work-stream delete
read that mark. Guarding on the row, which was the first attempt, orphaned a work
stream on every ordinary launch outage.

The titles were shortened after looking at them: the first version reused the
email's `occurrenceLabel` behind the recipient's name, and in a real sidebar the
row ellipsized at the weekday, so two occurrences on the same day rendered as the
same row. A component test asserting the title string would have passed on every
version of this.

### 2026-08-11 — The digestible default stays permissive, and the deployment window that exposed it is written down instead

**What changed:** Nothing in the code or the schema. `activity_events.digestible`
keeps `DEFAULT 1`. What changed is that the reason is now recorded here, in
[`data-model.md`](data-model.md), and — as an operational rule rather than a fact
about this column — in [the runbook](runbook.md#the-window-between-a-migration-and-the-worker-that-needs-it).

**Why:** Deploying the entry below produced six wrong rows. The deploy job
applies migrations before it deploys the Workers, so between `0063` landing at
`18:56:00` and the Global Worker going live at `18:56:23`, the *previous* Worker
inserted six `activity_events` rows without naming `digestible`. They took the
column default of `1` and are marked digestible although every one of
them is operational under the manifests that shipped in the same commit. As
stored in `activity_events.event_type`, which is the form that will match a row:

```sql
SELECT * FROM activity_events
 WHERE digestible = 1 AND event_type IN (
   'connector.github.github.check_run.completed',      -- 2 rows
   'connector.github.github.pull_request.edited',      -- 1 row
   'connector.google.email.updated',                   -- 2 rows
   'connector.google.sheets.spreadsheet_changed'       -- 1 row
 );
```

The doubled `github.` is not a typo, and it is the one place the two namespaces
meet: `projectActivityEvent` writes `connector.<provider>.<manifest event
type>`, and GitHub's manifest ids already carry a `github.` prefix while
Google's do not. A manifest id alone matches no row. The default was chosen to leave pre-existing rows alone.
For connector rows the migration's own backfill then overrode it — but not for
first-party ones: `0063`'s `UPDATE` is `WHERE source_kind = 'activity'`, and
work-stream messages and mentions keep `DEFAULT 1` deliberately, because Rally
has always known those are worth telling somebody about. So the default was the
real answer for a whole class of existing rows, and picking `0` instead would
have cost a second backfill (`WHERE source_kind <> 'activity'`) rather than
nothing. What nobody asked was what the *old code* would write through it, and
for twenty-three seconds that was the only thing the default governed.

**Considered and rejected:** Flipping it to `DEFAULT 0`, which was the first
instinct and is wrong twice over. It buys almost nothing: every deployed version
from here on sets `digestible` explicitly, so no future deployment window can
produce a defaulted row, and the only remaining reader of the default is a raw
`INSERT` that no code path performs. And it is not a one-line change — SQLite
cannot alter a column default, so it means rebuilding `activity_events`, which
means staging every `activity_event_targets` row around a parent drop that would
otherwise cascade them away, and restoring `sqlite_sequence` by hand because
`log_sequence` is `AUTOINCREMENT` and a rebuild of an empty table resets the
counter to zero. The EU copy of this table is empty today, so that reset would
have reissued sequences beneath cursors already stored in `digest_deliveries` —
the exact failure the `AUTOINCREMENT` comment in `0059` exists to prevent. A
rebuild of the log to change a default that will never again be read is a large
risk for no benefit.

Also considered: correcting the six rows in a migration. There is no structural
marker that identifies them — only a production timestamp, which would be wrong
in the EU database and wrong in every fresh deployment. They are a one-off
correction against one region's data, not a schema change.

**Consequences:** The default is now load-bearing documentation rather than a
safety net: anything that inserts into `activity_events` outside
`recordActivityEvent` must set `digestible` itself, because the column will not
withhold on its behalf. The six rows were left in place — they are six lines of
noise in one digest window and they age out — so a reader comparing the log
against the manifests will find that many disagreements and should not treat it
as drift. The general rule this produced now lives in the runbook, where the
next person adding a `NOT NULL` column to a hot table will meet it before they
pick a default rather than twenty seconds after.

Shipped in #104.

### 2026-08-11 — A digest run is handed its window, and only hears about what a connector confirmed is worth hearing

**What changed:** Two things, because the same digest exposed both. A scheduled
run now receives its frozen window as a labelled user-role trigger message
rendered by `renderScheduledDigestBriefMessage`, instead of relying on the
transcript row the brief is written to. And the window itself is filtered:
`activity_events.digestible` carries a per-event answer, `listActivityEventsForUser`
takes a required `digestibleOnly`, and a digest passes `true`.

**Why:** A production digest arrived reading "No changes since last digest; no
prior baseline or connected activity found", beside a pill counting 200 updates.
The recorded inference for every turn of that run held exactly one message — the
system prompt. The brief is written to `messages` as a `system` row, and the
protocol projector drops system rows as UI state, so the window never reached the
model; asked to summarize something it could not see, it searched memory and
durable tables, found nothing, and reported that nothing had happened. The count
in the email came from `event_count`, which never passes through the model, so
the two halves of the same email disagreed.

The window was also the wrong 200 events. It covered seventeen minutes of one
morning and was 84% GitHub check runs and workflow transitions, because the log
could not tell a connector's machinery from its news. Against the workspace that
produced the empty digest, per-event digestibility withholds 1,610 of 1,937
events, which is the difference between a digest that covers a day and one that
covers a quarter of an hour.

**Considered and rejected:** Making the projector carry `system` rows, which
would have delivered the brief with a one-line change. It would also replay
unlabelled connector text as ordinary history on every later turn of every run
that has a system row, which is what the projector exists to prevent. Also
rejected: filtering the noisy GitHub event types at projection time inside the
digest. That puts a list of one provider's event names inside the digest, where
nobody adding a connector would ever find it — the connector manifest is where
somebody is already deciding what an event means.

**Consequences:** A digest run now fails its attempt when it cannot find its
brief, rather than running blind; the unsettled delivery folds its window into
the next occurrence. The cursor deliberately still advances past withheld
events, so a window that was all machinery settles as `empty` rather than being
re-scanned forever — which means a genuinely quiet week and a week of pure
machinery are indistinguishable from the delivery table alone. Anything that
starts a run from a schedule has to hand the host something to render as a
trigger; a transcript row is not a channel to the model. The reasoning behind
everything in this document before this entry is not recorded, and was not
reconstructed.

Shipped in #93.
