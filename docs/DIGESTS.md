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
never see what happened in it yesterday. Hidden system work streams are excluded
there too, so digest machinery can never appear inside a digest.

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

One digest per person per workspace: a set of days, a set of times, a timezone,
and a set of destinations. It deliberately cannot vary times per day — that is
one integer day mask and a set of times rather than a seven-way join.

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

### The hidden work stream

The agent loop is work-stream shaped end to end — the transcript is `messages`,
and compaction, tool invocations, artifacts and the realtime room all key off
`workstream_id`. Running the *normal* loop therefore means having a work stream.

`workstreams.system_kind` marks the ones that are machinery: `NULL` is a normal,
user-visible work stream, and any non-`NULL` value is filtered out of every
listing surface. A digest's work stream is created once per person, not once per
run, so the sidebar gains nothing and a later digest can see what earlier ones
already said. The recipient is its sole participant, which is what makes every
tool the run reaches for resolve against their own access.

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

`digest-email-content.ts` renders the run's Markdown to email-safe HTML. A
general Markdown library is the wrong tool: mail clients ignore most of what one
emits, several strip `<style>` entirely, and rendering raw HTML would mean
rendering model output into an email. The renderer covers the subset a digest
uses, escapes everything before a single tag is added, and only ever emits an
`href` it built itself. Unknown syntax degrades to visible text.

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
