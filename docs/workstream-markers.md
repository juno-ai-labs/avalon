# Work-stream markers

Each work stream can show a person one coloured dot, and this is what decides
which colour it is. Eight states compete for that dot: five belong to the run
(`running`, `needs_input`, `completed`, `stopped`, `failed`) and three belong
to the reader alone — **unread**, **mentioned**, and **unseen**, a
work stream somebody put them in that they have never opened. The ranking
between them is a product decision, written down once, and every surface that
draws a marker reads it from here.

Read this before changing a marker colour, adding a state, reordering the
ranking, or changing what the home screen's **Needs attention** section holds.
The colours themselves are tokens, so [`theming.md`](theming.md) still owns how
a colour is written down; this document owns which state gets which token and
which state wins.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/format.ts` | `WorkstreamMarkerStatus`, the labels and descriptions, `MARKER_PRECEDENCE`, `workstreamMarkerStatus`, and `workstreamNeedsAttention`. The ranking exists here and nowhere else. |
| `apps/desktop/src/renderer/components/primitives.tsx` | `StatusDot` — the one component that draws a marker, for every surface. |
| `apps/desktop/src/renderer/components/sidebar.tsx` | The sidebar row's compact dot. |
| `apps/desktop/src/renderer/screens/new-workstream.tsx` | The home screen's **Needs attention** section and its rows. |
| `config/design-tokens/registry.json` | The `sys.color.workstream` group: one token per state. |
| `apps/desktop/src/renderer/styles/app.css` | `.status-<state> .status-dot` — one rule per state, each naming its token. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | The authority for the three personal states: `member_attention` for unread and mentions, `participants.first_opened_at` for unseen. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Migration v18: the column, its backfill, and the rebuilt `_runtime_workstream_participants` triggers that keep a re-add through the compatibility views unseen. |
| `apps/api/src/durable-objects/workspace-do.ts` | `workspace_workstream_viewers`, the per-person projection the sidebar list is read from. |

## How it works

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
`workspace_workstream_viewers`, so the sidebar's list, the work-stream socket's
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
not in the list — it has no personal state to lose to, and falls through as the
run's own status.

Only one run state is ever in the set at a time, so their order relative to each
other decides nothing; what the list actually decides is each run state against
`unread`. **`failed` sits below `unread`, and that is load-bearing:** a run that
fails almost always leaves a message nobody has read, so a failed work stream
usually shows **Unread** rather than **Needs intervention**. The reading is that
a failure a person has not read about is first of all something to read — the
transcript says what broke, and the marker's job is to get them there. A failure
they *have* read shows as **Needs intervention**, because nothing outranks it
any more. If the product wants a failure to shout over an unread message
instead, that is one line: move `failed` above `unread` in `MARKER_PRECEDENCE`
and update `workstreamNeedsAttention`, which today lists a failed run only when
a mention or an unseen membership puts it there.

### Sidebar

The sidebar omits the dot and its tooltip when the ranked marker is `completed`.
Unread, mentioned, and unseen markers still appear on completed work streams
when those personal states win the ranking.

### Needs attention

The home screen's **Needs attention** section holds the work streams that name
this person: **unseen**, **mentioned**, or a run **stopped for an answer**. That
is `workstreamNeedsAttention`, which asks the states rather than the marker, so
a work stream showing a different dot can still be listed — a room somebody was
added to is `unseen` here whatever its run is doing. The list is ordered by
`lastActivityAt`, newest first, so what moved most recently is at the top
regardless of which state put it there.

**Unread is deliberately not one of them.** It was, and it swamped the section:
unread is the ordinary condition of a work stream somebody is working in, so a
person with a normal backlog saw most of what they had listed here and the one
mention among them read exactly like the rest. The three that remain each have
somebody's hand behind them — you were put in this room, you were named in it,
or the agent stopped and asked you a question — and that is what keeps the list
short enough to be worth reading. Unread has not gone anywhere: it is still a
marker in the sidebar, in its own colour.

That also bounds what a row can show. Only three markers can reach one: `unseen`
and `mentioned` outrank everything in the ranking, and `needs_input` is the run's
own state — so `app.css` carries a colour for those three and nothing else.

## Invariants

- **At most one marker per work stream per person.** Every surface calls
  `workstreamMarkerStatus`; nothing reads `harnessStatus` to colour a dot. A
  surface that decided for itself would show one work stream two different
  colours on two screens, which reads as a bug in the data.
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
  `commitWithRegionalEffects`, so the sidebar hears about the change the same way
  it hears about every other viewer change. Anything that bypasses that commit
  leaves a lit dot on a work stream the person is looking at.

## Boundary

This module owns which state a person sees and what colour it is. It does not
own:

- **What the run's status means** — [`workstream-durable-object.md`](workstream-durable-object.md).
- **Unread and mention arithmetic** — the attention ordinals, the manual
  mark-unread generation, and the read acknowledgement are the work-stream
  object's, described in the same document.
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
- **Needs attention has no cap.** Its membership is bounded in practice by the
  fact that all three states need somebody to have named this person, so the
  section is short for the same reason it is worth reading. It is not bounded in
  principle: somebody added to fifty work streams at once sees fifty rows above
  the composer. No cap is written here on purpose — a limit is a decision with a
  number, and the number belongs to the team rather than to whoever noticed
  ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)).
  What a cap would need to decide: how many rows, what the overflow affordance
  is, and which states survive the trim, since dropping the oldest unseen is not
  the same call as dropping everything below a mention.
- **Existing memberships at deploy.** Both backfills — `first_opened_at =
  added_at` in the object's schema migration, and `unseen` defaulting to 0 in the
  workspace projection — read every membership that already existed as seen. A
  release that lit every dot in the product would be indistinguishable from a
  bug.

## Testing

| Suite | What it proves | How to run |
| --- | --- | --- |
| `apps/desktop/src/renderer/lib/format.test.ts` | The ranking, pair by pair, and the **Needs attention** membership rule. | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/format.test.ts` |
| `apps/desktop/src/renderer/components/sidebar.test.tsx` | The sidebar row draws the ranked marker, and its tooltip explains it. | `pnpm --filter @rally/desktop exec vitest run src/renderer/components/sidebar.test.tsx` |
| `apps/desktop/src/renderer/screens/new-workstream.test.tsx` | **Needs attention** holds the three addressed states, omits a merely unread work stream, and orders rows by recency. | `pnpm --filter @rally/desktop exec vitest run src/renderer/screens/new-workstream.test.tsx` |
| `apps/api/test-workers/unseen-workstream-state.test.ts` | On real workerd: added at creation, added later, cleared by the first open, unchanged by a duplicate add, set again by a re-add. | `pnpm --filter @rally/api test:workers` |
| `apps/api/test-workers/workspace-directory-reads.test.ts` | The flag survives the workspace projection as the viewer's rather than the row's. | as above |
| `apps/api/test/workstream-object-schema.test.ts` | Both compatibility views reset the column on a re-add, and leave it alone on a removal. | `pnpm --filter @rally/api exec vitest run test/workstream-object-schema.test.ts` |

The workers suite starts with no schema and seeds the D1 tables it needs; the
unseen tests reach the state through the real product endpoint rather than by
writing `participants` directly, which is what makes them evidence that the add
paths set it.

## Open questions

- **How long may Needs attention get?** See the entry under **Failure modes and
  limits**. Dropping unread took the everyday pressure off it, but it is still
  uncapped; the cap, its overflow affordance, and which states survive the trim
  are the team's to set if it ever needs one.
- **Should a failed run outrank an unread message?** The ranking says no today,
  and the reasoning is under [The ranking](#the-ranking). It is one line to
  reverse if the product disagrees.

## Data model

| Table | Column | Meaning |
| --- | --- | --- |
| `participants` (WorkstreamDO object SQL) | `first_opened_at INTEGER` | When this person first opened the work stream. Null means unseen. |
| `workspace_workstream_viewers` (WorkspaceDO) | `unseen INTEGER NOT NULL DEFAULT 0` | The projected flag the sidebar list reads. |

Schema migrations: work-stream object v18, WorkspaceDO v10. Both backfill
existing rows as seen.

## Changelog

### 2026-09-07 — Default startup opens a real conversation

Startup selects the first sidebar work stream and opens it through the normal
conversation route. That open settles unseen, and visible messages are acknowledged
under the existing focus, visibility, and transcript-position rules. This follows
the requested first-stream landing; skipping unseen or unread rooms would select a
different destination from the sidebar. Explicit deep links retain an inert
intermediate route while resolving, to avoid opening an unrelated conversation.

### 2026-09-07 — Omit completed markers in the sidebar

The sidebar hides the completed marker and its tooltip at the user's request.
This is a sidebar presentation rule, so the shared ranking and other surfaces
retain completion status. Personal attention markers on completed work streams
must remain visible; hiding every row whose run completed would lose them.

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
