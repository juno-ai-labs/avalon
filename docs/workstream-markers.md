# Work-stream markers

Some work-stream surfaces show a person one coloured dot, and this is what decides
which colour it is. Eight states compete for that dot: five belong to the run
(`running`, `needs_input`, `completed`, `stopped`, `failed`) and three belong
to the reader alone — **unread**, **mentioned**, and **unseen**, a
work stream somebody put them in that they have never opened. The ranking
between them is a product decision, written down once, and every surface that
draws a ranked dot reads it from here, the sidebar's Channel rows included.

Read this before changing a marker colour, adding a state, or reordering the
ranking. The colours themselves are tokens, so [`theming.md`](theming.md) still
owns how a colour is written down; this document owns which state gets which
token and which state wins.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/format.ts` | `workstreamMarkerStatus` owns the ranking, reading `MARKER_PRECEDENCE` from `apps/desktop/src/renderer/lib/attention-ranking.ts`, where it sits beside `readerMarkerStatus` (the three personal states alone, for the Threads button's count and the dock badge; see the retired attention menu). Shared vocabulary, labels and `harnessMarkerStatus` live in `packages/ui/src/lib/format.ts` and are re-exported here. |
| `packages/ui/src/components/primitives.tsx` | `StatusDot` — the one component that draws a marker, for every surface. |
| `apps/desktop/src/renderer/components/navigation-sidebar.tsx` | Not a reader since 2026-10-12: a Threads-tab row (`ThreadRow`) draws only the reader's own states, collapsed to one unread dot (`threadUnread`: unread, mentioned or unseen). The run's states are the thread header's to show ([`desktop-shell.md`](desktop-shell.md#the-sidebar)). |
| `apps/desktop/src/renderer/screens/workstream.tsx` | The work-stream header's status line, which names the run's own marker rather than this viewer's. |
| `apps/desktop/src/renderer/components/automation-header.tsx` | The Sidekick run history, the one surface that still draws `scheduled` under its own name. |
| `config/design-tokens/registry.json` | The `sys.color.workstream` group: one token per state. |
| `packages/ui/src/styles/app.css` | `.status-<state> .status-dot` — one rule per state, each naming its token. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | The authority for the three personal states: `member_attention` for unread and mentions, `participants.first_opened_at` for unseen. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Migration v18: the column, its backfill, and the rebuilt `_runtime_workstream_participants` triggers that keep a re-add through the compatibility views unseen. |
| `apps/api/src/durable-objects/workspace-do.ts` | `channel_viewers`, the per-person projection the sidebar list is read from. |

### The three personal states

**Unread** and **mentioned** are derived from attention ordinals: the work
stream numbers every message that asks for attention, each person has a seen
waterline, and anything above it is unread — with `youAreMentioned` true when
the newest mention of them is above that same waterline. Both are described in
[`workstream-durable-object.md`](workstream-durable-object.md).

**Unseen** is not an ordinal comparison, and deliberately so. It is a column on
the membership row, `participants.first_opened_at`, null until the person opens
the work stream:

- **Being added sets it.** Everybody named at creation except the creator, and
  everybody added later — through the participant control, through a mention the
  author confirmed, or by an agent tool — gets a row with `first_opened_at`
  null. The creator's is stamped at creation, because they are looking at the
  work stream they just started. Somebody who joins by acting — writing a
  message, answering an elicitation, narrowing the work stream to themselves —
  is stamped too: they are already inside it.
- **Opening clears it.** `WorkstreamObjectProductService.get` — the single
  assembler behind `GET /workstreams/:id` and the socket snapshot — calls
  `markOpened` before it reads, so the detail that open returns already says
  seen. Deliberately the *open*, not the read acknowledgement the client sends
  afterwards: that one is withheld unless the window is focused, the document
  visible, and the transcript settled at its initial position, none of which is
  what "have you been here" is asking.
- **Being removed and re-added sets it again**, on every path that can do it.
  The work stream moved on without them, and the add is announced to them again;
  the participant epoch beside it says the same thing. Two of those paths are
  not this object's own code — `admitConnectorAudience` re-admits somebody the
  moment they speak in the Slack thread a work stream came from, and an agent
  tool can clear `removed_at` through the update view — so the compatibility
  views' INSTEAD OF triggers reset the column too, keyed to exactly the
  transition each already bumps the epoch for.

Both halves ride the same `directory_user` regional effect into
`channel_viewers`, so the sidebar's list, the work-stream socket's
boot frame, and `GET /workstreams/:id` cannot answer differently.

### The ranking

`workstreamMarkerStatus` collects every state that is true for this viewer and
returns the first one in `MARKER_PRECEDENCE`:

1. `unseen`
2. `mentioned`
3. `running`
4. `needs_input`
5. `unread`
6. `completed`
7. `stopped`
8. `failed`

The personal states are deliberately not grouped: being named outranks a run
that is working, while merely having unread messages does not. `scheduled` is
not in the list because it never reaches it under its own name — see
[A queued run is an active one](#a-queued-run-is-an-active-one).

Only one run state is ever in the set at a time, so their order relative to each
other decides nothing; what the list actually decides is each run state against
`unread`. **`failed` sits below `unread`, and that is load-bearing:** a run that
fails almost always leaves a message nobody has read, so a failed work stream
usually shows **Unread** rather than **Needs intervention**. The reading is that
a failure a person has not read about is first of all something to read — the
transcript says what broke, and the marker's job is to get them there. A failure
they *have* read shows as **Needs intervention**, because nothing outranks it
any more. If the product wants a failure to shout over an unread message
instead, that is one line: move `failed` above `unread` in
`MARKER_PRECEDENCE`.

### A queued run is an active one

`harnessMarkerStatus` turns a run's status into a marker, and folds `scheduled`
into `running`. A work stream whose next run is queued is presented as one that
is already working: the difference is real in the data and worth nothing to
somebody scanning a list, because either way the agent has the work and nobody
is being asked for anything. Nobody can act on "about to start" differently from
"started".

It also finishes a mapping the API had already made. The compat view folds
`preparing_context` and `waiting_capacity` into `running` on the wire
(`workstream-runtime-compat-schema.ts`), so `scheduled` was the last
non-executing run state still drawn as something of its own. Know what it
actually is before reasoning about it: the **admission window** between the run
being inserted and the Workflow launching — written at creation and manual
retry, cleared to `running` at launch — not a resting state. A schedule fires by
creating work and admitting a run at fire time; between occurrences the row is
`completed`.

There are two boundaries, not one, and the difference is load-bearing:

- **`harnessMarkerStatus` — the run's own marker.** What the work-stream header
  draws, because a header describes the run rather than the reader. Routing it
  through the ranking instead would put **Unread** or **You were mentioned** in
  the header of a work stream somebody is looking at, which is nonsense: they
  are reading it.
- **`workstreamMarkerStatus` — this viewer's marker.** What a list draws. It
  calls `harnessMarkerStatus` first and then ranks the result against the
  personal states, so a folded `scheduled` is what enters the ranking.

Both therefore agree about the run, and only the second has an opinion about the
reader. **That is the fold's real job.** A component that reads `harnessStatus`
and hands it to `StatusDot` directly is reintroducing the second opinion, and
`scheduled` is still in `WorkstreamMarkerStatus` for it to reach — though
`harnessMarkerStatus` returns `Exclude<WorkstreamMarkerStatus, 'scheduled'>`, so
the state cannot come back out of the fold.

**The fold governs presentation, not control.** Run-control affordances keep
reading the real status on purpose: the composer tests
`harnessStatus === 'running'` for queued delivery, the `/stop` command, and the
Stop button, so during the admission window a work stream reads **Running** in
its header while the composer sends immediately and offers no Stop. That is
correct rather than an oversight — `stopWithAuthority` needs a live execution to
fence, and there is none yet — but it is the first thing a reader of the diff
will take for a bug, so it is written down here.

It is there for the Sidekick **run history**, which lists runs rather than work
streams: a pending run is exactly what somebody opened that list to find, so it
draws `scheduled` under its own name and keeps its `.status-scheduled` rule.
That is the only surface allowed to, and it is not a work-stream surface — which
is what makes it an exception to the invariant below rather than a violation of
it.

`scheduled` entering the ranking as `running` also settles it against the
personal states, which it never faced before: it now outranks `unread` and loses
to `mentioned` and `unseen`, in the one place those pairs were already decided.

### Channel row

The per-Channel rail and its per-conversation count badges were removed with
the shell redesign ([`desktop-shell.md`](desktop-shell.md)). The sidebar's
Channel row counts accessible Main (by `conversationNeedsViewer`) plus
`breakoutAttentionCount`, and any count marks the row unread: a semibold title
and a red dot. The count is spoken in the row link's accessible name ("N
conversations need attention") rather than drawn as a badge. A scheduled,
running or needs-input run counts even when there is nothing unread. A read,
failed run does not count on run state alone; the Space dashboard and the open
Channel header still show its failure state.

### Project space

The project space lists a project's work streams and draws the ranked marker on
each row. It is the list that draws **the ranked per-person dot** — the Sidekick
run history draws a dot too, but from a run's own status rather than this
viewer's. The sidebar's Channel row uses the unread treatment above.

**The dot carries the state; the label beside it is not coloured.** These rows
are the home screen's retired **Needs attention** rows, reused wholesale, and
they arrived carrying a label colour for `unseen`, `mentioned`, and
`needs_input` — a complete set under that section's three-state membership rule,
and an arbitrary three-of-eight under the full ranking. Those three rules are
gone, so a project row uses a quiet label beside its coloured dot.

Its first column is a **fixed track**, so every title in the list starts on the
same edge whatever marker precedes it. A per-row `auto` column cannot do that —
each row is its own grid, so it would size to that row alone and leave a ragged
edge down a list whose whole value is that it can be scanned.

The track is sized to the widest label `statusLabel` holds. It was 112px, which
four of the nine labels overflowed, and the dot absorbed all four: it is a flex
item beside the label, so it is what gives way, and under the widest two it was
crushed to nothing and the row showed no marker at all. The track is now 130px,
above the 125.5px "Latest run completed" measures with its dot and gap, and
`.status-dot` sets `flex: 0 0 auto` so it can never be the thing that yields
again. The label ellipsizes instead, which is the backstop for a label that
outgrows the track: it clips where somebody can see it rather than sliding under
the title. **A label added to `statusLabel` is still a reason to re-measure this
row** — the numbers above are one platform's font.

## Invariants

- **At most one marker per work stream per person.** Every work-stream surface
  routes the run's status through `harnessMarkerStatus`; a viewer-aware one
  calls `workstreamMarkerStatus`, which routes through it in turn. Nothing reads
  `harnessStatus` and colours a dot from it. A surface that decided for itself
  would show one work stream two different colours on two screens, which reads
  as a bug in the data. Only a **run-history** surface — one listing runs rather
  than work streams, the Sidekick history being the only one today — may pass
  `scheduled` to `StatusDot` under its own name.
- **The ranking lives in one array.** Reordering is editing `MARKER_PRECEDENCE`.
  A second copy — in a component, in a query, in a sort — silently forks the
  product decision.
- **Every state has a token in `sys.color.workstream`, and `app.css` names only
  tokens.** A colour written into a rule is invisible to every theme but the one
  it was eyeballed in; the stylesheet test fails on it.
- **`unseen` is settled once.** Nothing sets `first_opened_at` back to null
  except a removal followed by a re-add. A later message makes a work stream
  unread, never new again — that difference is the whole reason the column
  exists rather than a derivation from the attention waterline, which a newly
  added person also trips but which comes back on every message after it.
- **A new writer of `participants` owes the column an answer.** The membership
  row is reachable through the runtime compatibility views as well as through
  this object's own methods, and a writer that reactivates a removed row without
  resetting `first_opened_at` produces a person who is notified about a work
  stream, has their epoch bumped, and is shown no marker. The rule that keeps
  the three honest: **wherever the participant epoch bumps for removed → active,
  `first_opened_at` resets.**
- **Only a participant can be unseen.** Somebody reading a workspace-scoped work
  stream they are not in was never put there, so there is nothing for them to
  have missed.
- **Clearing it is a write on a read path.** `get` commits through
  `commitWithRegionalEffects`, so navigation hears about the change the same way
  it hears about every other viewer change. Anything that bypasses that commit
  leaves a stale attention badge on a Channel the person is looking at.

## Boundary

This module owns which state a person sees and what colour it is. It does not
own:

- **What the run's status means** — [`workstream-durable-object.md`](workstream-durable-object.md).
- **Unread and mention arithmetic** — the attention ordinals, the manual
  mark-unread generation, and the read acknowledgement are the conversation
  object's, described in the same document. Each conversation keeps its own,
  Main and every private substream alike, which is why a read is acknowledged
  against the conversation that was read rather than against the work stream;
  the Channel row receives each Breakout's viewer state from the Channel parent.
- **How a colour reaches the screen** — [`theming.md`](theming.md) owns the
  token vocabulary, the theme files, and the generated stylesheet.
- **Notifications.** Being added to a work stream also produces an activity
  event and a person-notification intent; those are separate effects with their
  own delivery rules, and a marker is not one of them.

## Failure modes and limits

- **An old client, or an effect written before this shipped.** `unseen` is
  optional on the regional effect and defaults to false in the contract, so a
  work stream whose viewer row predates the column simply shows the run's own
  marker. It is never wrongly lit.
- **A work stream opened while offline.** The clear is a server-side write on
  the open, so an open that never reached the region leaves the dot lit; the
  next open clears it.
- **A person added to hundreds of work streams at once** sees hundreds of
  markers. There is no cap and no digest: the sidebar is already a list, and the
  states below it behave the same way.
- **Existing memberships at deploy.** Both backfills — `first_opened_at =
  added_at` in the object's schema migration, and `unseen` defaulting to 0 in the
  workspace projection — read every membership that already existed as seen. A
  release that lit every dot in the product would be indistinguishable from a
  bug.

## Testing

| Suite | What it proves | How to run |
| --- | --- | --- |
| `apps/desktop/src/renderer/lib/format.test.ts` | The ranking, pair by pair, and the queued-run fold. | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/format.test.ts` |
| `apps/desktop/src/renderer/screens/workstream.test.tsx` | The header draws a queued run as running, which is what holds the second call site to the fold. | `pnpm --filter @rally/desktop exec vitest run src/renderer/screens/workstream.test.tsx` |
| `apps/desktop/src/renderer/components/sidebar.test.tsx` | A Channel row counts Main and Breakout attention together and marks Breakout-only news as unread. | `pnpm --filter @rally/desktop exec vitest run src/renderer/components/sidebar.test.tsx` |
| `apps/api/test-workers/unseen-workstream-state.test.ts` | On real workerd: added at creation, added later, cleared by the first open, unchanged by a duplicate add, set again by a re-add. | `pnpm --filter @rally/api test:workers` |
| `apps/api/test-workers/workspace-directory-reads.test.ts` | The flag survives the workspace projection as the viewer's rather than the row's. | as above |
| `apps/api/test/workstream-object-schema.test.ts` | Both compatibility views reset the column on a re-add, and leave it alone on a removal. | `pnpm --filter @rally/api exec vitest run test/workstream-object-schema.test.ts` |

The workers suite starts with no schema and seeds the D1 tables it needs; the
unseen tests reach the state through the real product endpoint rather than by
writing `participants` directly, which is what makes them evidence that the add
paths set it.

## Open questions

- **Should a failed run outrank an unread message?** The ranking says no today,
  and the reasoning is under [The ranking](#the-ranking). It is one line to
  reverse if the product disagrees.

## Data model

| Table | Column | Meaning |
| --- | --- | --- |
| `participants` (Main conversation's SubstreamAgent SQL) | `first_opened_at INTEGER` | When this person first opened the work stream. Null means unseen. |
| `channel_viewers` (WorkspaceDO) | `unseen INTEGER NOT NULL DEFAULT 0` | The projected flag the sidebar list reads. |

Schema migrations: work-stream object v18, WorkspaceDO v10. Both backfill
existing rows as seen.

## Changelog

### 2026-09-23 — Put conversation attention on shared count badges

**What changed:** Channel navigation replaced its icon-corner ranked dot with
one count badge for Main and its Breakouts. The Channel rail now badges Main
and each visible Breakout independently, including guest-granted Breakouts.

**Why:** A dot on the Channel icon could not identify which conversation needed
attention. Main's mention, unseen, unread, and active-run states still need a
signal before the Channel opens, so Main contributes to the Channel's count.

**Considered and rejected:** Keeping a second state marker on the glyph would
retain the cutout the product asked to remove and make two competing signals
for the same Channel. Fetching every Breakout detail on open would delay the
rail; its parent and guest navigation already have viewer-scoped projections.

**Consequences:** The numeric badge means a conversation needs attention, not
that it has one unread message. Scheduled, running, and needs-input runs count;
plain unread, mentions, and unseen state count too. A read failed run has no
attention badge from failure alone: the Space dashboard's ranked dot and the
open Channel header still name that state. Guest sibling badges come from a
canonically admitted navigation snapshot and refresh with that directory.

### 2026-09-10 — Needs attention is retired, and the rule it carried is unhoused

**What changed:** `workstreamNeedsAttention` and the tests that were its only
callers are deleted, and this document no longer describes a **Needs attention**
section — including the **Stale:** marker the entry below left on its row. The
surface itself went on 2026-09-04 in #551; what this change removes is the code
and the description it left standing. The three label colours the section
justified are gone too, and `.status-dot` no longer shrinks.

**Why:** The section was never retired on its own terms — it went with the
screen it lived on. #551 replaced the New work stream launcher's home dashboard
with a bare composer, and the reasoning is recorded in
[`workstream-creation.md`](workstream-creation.md)'s 2026-09-01 entry:
work-stream navigation already owned ongoing work, so an attention list and a
suggestion list inside the launcher amounted to a second, visually unrelated
home product between the person and the conversation shell. That is a reason not
to put the list *there*. **It is not a judgement on the membership rule**, and no
such judgement exists: #551 deleted the markup and left
`workstreamNeedsAttention`, this document, and the row colours in place, which is
what a change that was not thinking about them looks like. So the 2026-08-24
entry below is not overturned here. Its argument — that a list is worth scanning
only when a person is behind every row on it — is unhoused, not withdrawn, and
whoever builds an "addressed to me" surface next inherits it intact rather than a
decision against it.

**The label colours went because the project space inherited these rows.** It
draws them from the full ranking, so the section's three-of-eight colour map
stopped being exhaustive and became arbitrary. Rendering all eight states in a
real window settled which way to close the gap: three loud rows among five quiet
ones read as noise rather than emphasis, the amber `needs_input` label was the
least legible text in the list, and the five uncoloured rows were already doing
the legible thing — a coloured dot against a quiet label, which is what the
sidebar does. Removing three rules beat adding five, and it is the reading the
sidebar had already committed to.

**That window also found a real defect, which is why it is worth opening one.**
`.status-dot` is a flex item in `.status-indicator`, so it is what gives way
when a label outgrows the row's fixed first column — and four of the nine
labels outgrew the 112px that column was, by 13.5, 8, 1.2 and 0.2px. The dot
absorbed all four and was crushed to zero under the widest two, so those rows
showed **no marker at all**. `completed` is the ordinary state of a finished
work stream, so this was not an edge case. Nothing asserted on the dot's width,
which is how it survived: the class was present and the tests looked at the
class.

`flex: 0 0 auto` alone would only move the overflow from the dot to the label,
where it is worse — a missing dot is visible, text sliding under a title is not,
and "Latest run completed" overran by more than the 10px gap before the title.
So the track is sized to fit instead, at 130px against a measured 125.5px, and
the label ellipsizes as the backstop for whatever outgrows *that*. The numbers
are one platform's font, which is why the slack is there and why the body still
tells the next person to re-measure.

**Considered and rejected:** Keeping `workstreamNeedsAttention` against a future
attention surface. Six days without a caller is what produced this cleanup: it
type-checked, it had tests, and both this document and `app.css` cited it as
live, so nothing on the way past would have told the next reader the product had
moved. The rule itself is three lines and is preserved in prose in the
2026-08-24 entry, which survives a rewrite of the screen in a way a function
signature does not. Also rejected: giving the remaining five states a label
colour, per the window above.

**Consequences:** `unseen` and `mentioned` did **not** lose their last
non-sidebar surface, which was the live question when this was found — the
project space picked up the rows — but they no longer have a colour there beyond
their dot. Bringing an attention surface back means writing the membership rule
again from the 2026-08-24 entry; it does not mean bringing these colours back,
which are now a separate decision with the window above behind it. The first
column stays a fixed track so titles share an edge, so **a label added to
`statusLabel` needs re-measuring against it**; the ellipsis is a backstop, not a
substitute for that. Two rules
from the section's own markup, `.waiting-workstream-projects` and
`.waiting-workstream-source`, are still dead: they belong to the row's six-track
grid, which the project space inherited and only partly fills. The project
space's markers still have no test.

Follows #551, which removed the surface.

### 2026-09-10 — A queued run is drawn as an active one

**What changed:** `scheduled` no longer draws a marker of its own. The new
`harnessMarkerStatus` folds it into `running` on the way from a run's status to
a marker, and both `workstreamMarkerStatus` and the work-stream header's status
line go through it. The `running` tooltip lost the word "now" — it now covers a
run that is admitted as well as one mid-work.

**Why:** a hollow outlined dot with its own tooltip appeared on a work stream
that had done nothing yet, in a list of rows that were otherwise plain. There is
nothing for a reader to do about it: the agent has the work either way, nobody
is being asked for anything, and "about to start" is not a state a person acts
on differently from "started".

The stronger reason is that the API had already made this mapping and stopped
one state short. The compat view folds `preparing_context` and
`waiting_capacity` into `running` on the wire
(`workstream-runtime-compat-schema.ts`), so admitted-but-not-launched was the
last non-executing run state still drawn as something of its own. This finishes
that mapping in the renderer.

**An earlier draft of this entry claimed `scheduled` is "the state a
schedule-driven row sits in most of the time". That is wrong, and it is
recorded here because a wrong *why* in a changelog is what the next person
builds on.** `scheduled` is the admission window and nothing else: written at
work-stream creation and manual retry (`workstream-object-product.ts`), cleared
to `running` the moment the Workflow launches
(`workstream-harness-run-storage.ts`). A schedule fires by creating work and
admitting a run at fire time; between occurrences the row is `completed`. So the
window is seconds, and the honest reading of the visible payoff is smaller than
that draft implied — mostly the optimistic launch seed in
`launched-conversation.ts`. The ranking consequence below is the permanent one.

**Considered and rejected:** drawing no marker at all for `scheduled`, treating
it as a resting state alongside `completed`. That was the first attempt on this
branch, and it is the wrong reading of the same complaint — a queued run is not
a finished one, and hiding it means the moment a schedule fires is invisible
until the run has already produced something. Also rejected: giving `scheduled`
the running colour and label while leaving it a separate state. Two states with
identical presentation is the drift the ranking's single array exists to
prevent, and the next person to touch either would have to work out which one a
surface meant.

**Consequences:** `scheduled` now enters the ranking as `running`, which settles
it against the personal states for the first time — it outranks `unread` and
loses to `mentioned` and `unseen`, exactly as a started run does. A scheduled
work stream with unread messages therefore shows **Running** where it used to
show **Unread**; that is the point rather than a side effect, since the two runs
are indistinguishable to the reader.

`scheduled` stays in `WorkstreamMarkerStatus`, with its label, description, and
`.status-scheduled` rule, because the Sidekick run history lists *runs* and a
pending one is what somebody opened that list to find. That leaves the state
reachable, so the fold is what keeps work-stream surfaces honest rather than the
type: a component that hands `harnessStatus` to `StatusDot` directly is a second
opinion about one work stream, which is the invariant below.

**The first invariant was rewritten in the same change,** because it read "every
surface calls `workstreamMarkerStatus`" and that was now wrong in two directions
at once — the header calls `harnessMarkerStatus`, and the run history calls
neither. Left as it was, a maintainer following it literally would route the
header through the viewer's ranking and put **Unread** in the header of a work
stream somebody is reading, or fold the run history's pending run and erase the
distinction that list exists for. It now names both boundaries and the one
exception. Caught by a review bot on this pull request, which is worth recording:
the sentence had been loosely wrong before this change and became a live hazard
only once the difference between the two helpers started carrying weight.

Shipped in the pull request for this change.

### 2026-09-07 — Omit completed markers in the sidebar

**What changed:** The sidebar omits the completed marker and its tooltip.

**Why:** Completion alone should no longer produce a sidebar indicator. A read,
completed work stream needs no completion badge; personal attention still needs
its own marker when present.

**Considered and rejected:** Filtering by raw run status would also hide unread,
mentioned, and unseen markers on completed work streams. Changing the shared
ranking would extend this sidebar request to other surfaces.

**Consequences:** Suppression must use the ranked `workstreamMarkerStatus`
result. Other surfaces retain completion status, and the sidebar still renders
personal attention on completed runs.

Shipped in #585.

### 2026-08-24 — Needs attention drops plain unread

**What changed:** `workstreamNeedsAttention` no longer lists a work stream for
being unread. The section holds unseen, mentioned, and a run stopped for an
answer. A work stream that is unread *and* one of those three is still listed,
on their account. The row colour map in `app.css` shrank to the three markers
that can now reach a row.

**Why:** it was unreadable in practice. On a real account nine rows were listed
and seven of them were plain unread, so the single **You were mentioned** row —
the one thing in the list somebody had actually addressed to this person — sat
in the middle of a wall of identical green labels and read as more of the same.
Unread is the ordinary condition of a work stream somebody is working in; it is
not a request. The three remaining states each have a person behind them, which
is what makes a section worth scanning rather than scrolling.

**Considered and rejected:** capping the list instead, which was already the
open question here. A cap makes the section shorter without making it more
relevant — the mention is as likely to be trimmed as kept, because recency is
what orders it and unread rows are the freshest thing in the workspace. Also
rejected: ranking unread below the others inside the section, which keeps every
row on the screen and only moves the noise down the page.

**Consequences:** the sidebar is now the only place plain unread is surfaced,
which is what its own marker colour is for; anything that wants an
"everything I have not read" view is building a new surface, not widening this
one. The cap question stays open but is no longer urgent — the states that
remain are bounded by somebody having named this person. Two colour rules were
deleted rather than left dead, so widening the membership rule again means
adding the rule back for whatever state is admitted.

**It also takes a failed run off this screen**, which is worth stating plainly
because nothing here ever tested for one. `workstreamNeedsAttention` has never
checked `harnessStatus === 'failed'`; a broken run reached the section because a
run that fails almost always leaves a message nobody has read, so it arrived
through `hasUnread` — by accident rather than by design. It now appears here
only if the person was mentioned in it or newly added to it, and otherwise its
only surface is the sidebar dot. That follows the line this change draws — a
failure is the run's own state, not somebody addressing you — but if the product
wants failures on the home screen, the honest fix is to name `failed` in the
membership rule rather than to let unread smuggle it back in, and that decision
belongs with the ranking question below.

Shipped in #272.

### 2026-08-24 — One ranked marker per work stream, with unseen as its own state

**What changed:** A work stream now shows each person a single dot chosen from
eight ranked states rather than from the run's status alone. Three of them are
the reader's: `unread` and `mentioned`, which existed in the data but had no
colour, and `unseen` — a work stream they were put in and have never opened,
which did not exist at all. Every marker colour moved to a new
`sys.color.workstream` token group, one token per state. The home screen's
**Waiting for input** section became **Needs attention** and now holds all four
states that ask something of the reader, ordered by recency.

**Why:** Being added to a work stream was invisible. The dot showed whatever the
agent happened to be doing — usually `running` or `completed` — so a room a
colleague had just put somebody in looked exactly like the forty rooms they had
already read, and the only signal was a notification they may not have been
looking at. `hasUnread` could not carry it either. It is true for a newly added
person — the root's tracking start is 0 and the add writes no attention row, so
their waterline is 0 and the whole transcript sits above it — but it is true
again after every subsequent message and after a manual mark-unread. Reusing it
would mean a work stream somebody has been in for months turning violet and
reading **New to you** because a colleague posted. The state being asked about
is "have you ever been here", which is answered once and then never again;
unread answers "is there something to read", which is answered continuously. Once three personal
states could be true at once with one dot to show them, an ordering had to exist
somewhere; putting it in one array is what stops each surface from inventing its
own.

**Considered and rejected:** Reusing `hasUnread`, which is free and is already
true at the moment of the add — rejected because it does not stay true-once, as
above, and because the ranking needs the two to be separable: `unseen` outranks
a mention and a working run, `unread` sits below both, and one fact cannot hold
two places in one order. Deriving unseen from the *existence* of a
`member_attention` row — the closest cheap approximation — rejected because a
mention writes that row, so being named in a work stream you have never opened
would clear the very marker that should be shouting; and because no existing
membership has one, so the deploy would light every dot in the product. Clearing it on `acknowledgeRead` — that is
the client reporting what it has *read*, and it is withheld unless the window is
focused, the document visible, and the transcript settled at its initial
position, so an open can produce no acknowledgement at all; the clear is on the
object's own open path instead, which is a durable write inside what reads like
a read and depends on none of those conditions. Keeping the
old per-state colours (`sys.color.warning` for needs-input, the accent for both
running and unread) — with eight states competing, two of them shared the accent
and neither could be told from the other.

**Also:** the two runtime compatibility triggers that write `participants`
were rebuilt in the same migration, because both reactivate a removed
participant and neither knew about the new column — a member re-admitted by
`admitConnectorAudience` when they next spoke in a Slack thread was notified
again, had their epoch bumped again, and saw no marker.

**Consequences:** `get` now writes on first open, which is a durable commit on
the work-stream open path — guarded so it happens once per participant, but any
future change that adds a caller of `get` for a non-viewing principal would
mark that principal as having seen the work stream. The ranking is a product
decision in `MARKER_PRECEDENCE`: reorder it there and every surface follows.
Adding a ninth state means a token in `sys.color.workstream` for all four
themes, a rule in `app.css`, an entry in the ranking, and a label — and the
label is what the screen reader hears, so it is not optional. The two backfills
mean nobody sees a wave of markers at the deploy; a future migration that
touches either column must keep that property.

Shipped in #267.
