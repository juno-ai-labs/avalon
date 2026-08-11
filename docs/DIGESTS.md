# Activity events and scheduled digests

Two things live here because the second is the first's only consumer today. The
**activity log** is Avalon's first-party record of what happened that someone
should hear about. The **digest** is a scheduled agent run that reads a person's
slice of that log and writes them a summary.

Read this before adding a notification surface, adding something a digest should
mention, or changing what a connector can deliver to a person.

## Why a second activity table exists

`activities` is provider ingest. It is keyed by `(connection_id,
provider_event_id)`, written before anyone has decided what an event means, and
rewritten while it is processed. It answers *what did GitHub tell us*.

`activity_events` answers a different question: *what happened in Avalon that
this person should hear about*. An Avalon mention has no connection. A
work-stream message has no provider event id. Neither has a dedupe key a
provider controls. Widening `activities` to hold both would leave first-party
rows carrying a column of synthetic nulls for every provider concept they do not
have, and would make every consumer filter ingest state out of a feed.

So the two stay separate, and connector activity is **projected** into
`activity_events` once it has been processed. Every surface that wants "what
happened, for this person, since this instant" reads one table.

## The log

`activity_events` is append-only. Four things make it generic rather than a
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
`listActivityEventsForUser` and nowhere else. Storing recipients instead would
freeze the audience at write time: someone added to a work stream today would
never see what happened in it yesterday. System work streams are excluded there
too, so digest machinery can never appear inside a digest — visible in the
sidebar or not.

**`activity_event_targets` is involvement, not audience.** Audience says who
*may* see an event; a target row says the event is *about* someone — `mentioned`,
`involved`, and whatever a later producer needs. That is what lets a digest lead
with "you were tagged" rather than burying it in a list of everything that moved.
A target outside the audience is stored anyway; the read query still filters by
audience, so recording involvement never grants visibility.

**`log_sequence` is the cursor axis.** A consumer resumes where it stopped, so it
needs a total order that an insert can only ever extend. Timestamps cannot give
one — two events written in the same millisecond tie, and any tiebreak (a UUID, a
hash) can place the second one *below* a cursor taken after the first, dropping
it from every future read. `log_sequence` is `INTEGER PRIMARY KEY AUTOINCREMENT`:
`AUTOINCREMENT` is what makes it strict, because plain rowids are reused after a
delete and a reused one would appear beneath a cursor that has already passed.

`created_at` is display and retention only. Never cursor on it, and never cursor
on `occurred_at` — a connector poll inserts events whose provider timestamp is
hours old.

### Retention

`reapExpiredActivityEvents`, on the same cron tick as every other reaper, drops
events older than ninety days oldest-first and lets the cascade take their
targets. The log is append-only and would otherwise grow with the workspace
forever.

Ninety days is far longer than anything reads: a first run looks back 72 hours
and every run after that starts from its own cursor, so the window only has to
survive a schedule being paused and resumed. Reaping never disturbs a cursor —
an expired `log_sequence` sits below every live one, so a window that has lost
its rows reads as empty rather than as new. A surface that wants to read further
back than ninety days needs this number raised, not a second table.

### Adding a producer

Call `recordActivityEvent` with a `dedupeKey` that is stable per workspace, so a
retry or a replayed queue message resolves to the row the first attempt wrote.
It never throws into its caller: an event log that can fail a message post is
worse than one that occasionally misses a row. Use
`recordActivityEventOrThrow` when the write genuinely has to land.

Producers today:

| Producer | Event type | Audience |
| --- | --- | --- |
| `WorkstreamService.createMessage` | `workstream.message.posted` | the work stream; mentions become `mentioned` targets |
| `activity-consumer` after routing | `connector.<provider>.<event>` | the connection's own scope |

## The digest

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

### Who gets one

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

### Scheduling

Each **time** gets its own `schedules` row, not each digest. A single RRULE
cannot carry a list of times: `BYHOUR` and `BYMINUTE` multiply out, so 09:00 plus
12:30 would also fire at 09:30 and 12:00. One rule per time says exactly what was
asked for, and the workspace scheduler already advances, retries and disables
each row independently.

A digest is recurring timing with no payload, which is what `schedules` is for —
unlike `workstream_wakeups`, which is one-shot and carries a prompt, and so keeps
its own table. `schedules` gained `digest_schedule_id` and a CHECK that exactly
one target column is set.

Saving replaces everything: destinations are resolved and frozen *before*
anything is written, so a destination that has gone away fails the request rather
than leaving a schedule that fires into nowhere. A disabled digest keeps its
configuration and loses its schedule rows, so re-enabling is a save rather than a
rebuild. The workspace alarm is refreshed *after* the write — the Durable Object
reads D1, so refreshing early would arm it from the rows the save just replaced.

### The run

A digest runs on the ordinary agent loop, with the ordinary tool surface. The
scheduler:

1. Re-validates the execution principal and the membership.
2. Freezes the window: `cursor_from` is the last settled delivery's
   `cursor_through`; `cursor_through` is the workspace's current maximum
   `log_sequence`. Freezing the top is what makes events arriving mid-run belong
   to the *next* digest rather than being skipped.
3. Claims the occurrence by inserting `digest_deliveries`, unique on
   `(digest_schedule_id, planned_for)`. A retried alarm resolves to the attempt
   already in flight.
4. Writes the window into the transcript as a system message and launches the
   harness with it as the trigger.

An empty window settles as `empty` without running the model, and its cursor
still advances so the next digest does not re-scan it.

**Digests never touch `workstream_read_states`.** A digest cursor means "what you
have already been told"; a read waterline means "what you have read". Collapsing
them would let skimming an email on a phone silently clear the unread badges in
the app.

### The system work stream

The agent loop is work-stream shaped end to end — the transcript is `messages`,
and compaction, tool invocations, artifacts and the realtime room all key off
`workstream_id`. Running the *normal* loop therefore means having a work stream,
and reusing that abstraction is the point: a digest run gets compaction, tool
receipts, the realtime room and the transcript for free.

Two columns, answering two different questions. A digest's work stream carries
both.

- **`scope` — who may read it.** `personal` means an active participant and
  nobody else; `workspace` means anyone in the workspace. This is the same
  column and the same vocabulary `notes.scope` uses, so "private" means one
  thing in Avalon and is declared on the row rather than inferred by each
  caller. A digest's work stream has exactly one participant, its recipient,
  which is also what makes every tool the run reaches for resolve against their
  own access. Another member cannot open it knowing its id, because the brief
  inside is assembled from their private activity.
- **`system_kind` — whether it is machinery.** This decides whether the row is
  *listed*: off by default, and `GET /workstreams?includeSystem=true` asks for
  it, which the desktop sends when Application → Developer → **Debug enabled**
  is on. It widens what is shown, never who may read it. A private work stream
  that is not machinery is protected exactly the same way.

In the interface, `scope = 'personal'` renders the private marker — the lock a
personal note already wears in the sidebar, plus a **Private** badge in the
work-stream header.

Shown, they render one level down: dimmed, with a small gear, full opacity on
hover and while active — hierarchy should not cost legibility once you are in it.

The debug preference changes what the desktop *asks for*, never where the answer
is stored. Every work-stream list reads `WORKSTREAMS_QUERY_KEY`, an
unparameterized `['workstreams']`, because realtime handlers, renames and
read-state callbacks patch that cache entry directly; a key that varied with the
preference would strand every one of those writes on an entry nobody observes.
`useWorkstreamsQuery` owns the key, the fetcher and the refetch that a toggle
asks for.

One work stream per person, not per run, so nothing accumulates and a later
digest can see what earlier ones already said.

### Delivery

Email is the built-in default and needs no connector. Every other destination is
a connection whose connector declares a `userDelivery` surface in its manifest —
the same declaration [`CONNECTORS.md`](CONNECTORS.md) describes and the same one
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

### The email

`digest-email-content.ts` renders the run's Markdown to email-safe HTML.

It is dark, and deliberately only dark: the email is a copy of an Avalon surface
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
email. The renderer covers the subset a digest uses — `##` sections with a
brand rule, `###` subheads, bullets, links, bold, inline code, blockquote — and
escapes everything before a single tag is added, so an `href` can only ever be
one it built itself. Unknown syntax degrades to visible text.

The brief names exactly that subset, so what the model writes and what the
template styles are the same list. Each source group carries its canonical link,
so the digest points at the real thing rather than describing it.

### Looking at it

`scripts/preview-digest-email.mjs` renders the template for every active member
of a workspace and writes one HTML file each. Run it through `tsx`, because it
imports the real template rather than a copy:

```bash
pnpm exec tsx scripts/preview-digest-email.mjs            # the local D1
pnpm exec tsx scripts/preview-digest-email.mjs --db /tmp/global.sqlite
```

It prefers a digest that has actually been delivered to that person, and falls
back to a sample body chosen to stress the template — a priority section, links,
a blockquote, bold, and one bullet long enough to wrap. **Every visible change to
the template should be looked at here before it is called done**; a test proves
the markup contains a string, not that the hierarchy reads.

For a remote workspace, export its D1 first — Wrangler holds those credentials,
this script does not:

```bash
pnpm --filter @avalon/api exec wrangler d1 export DB --remote \
  --config wrangler.global.jsonc --output /tmp/global.sql
sqlite3 /tmp/global.sqlite < /tmp/global.sql
```

## Where the code is

| Concern | File |
| --- | --- |
| The log: writes, visibility-scoped reads, cursors | `apps/api/src/services/activity-event-service.ts` |
| Digest configuration, RRULE derivation, schedule rows | `apps/api/src/services/digest-service.ts` |
| Firing one occurrence, the window, the hidden work stream, the brief | `apps/api/src/services/digest-run-service.ts` |
| Recording and sending what a run wrote | `apps/api/src/services/digest-run-settlement.ts` |
| Destination dispatch | `apps/api/src/services/digest-delivery-service.ts` |
| Email HTML | `apps/api/src/services/digest-email-content.ts` |
| Settings screen | `apps/desktop/src/renderer/components/digest-settings.tsx` |
| The work-stream list every surface shares | `apps/desktop/src/renderer/lib/use-workstreams-query.ts` |
| Rendering the email for real people, to look at | `scripts/preview-digest-email.mjs` |
