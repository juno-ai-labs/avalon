# Naming a work stream

A work stream is created faster than a model can name it, so it is created with a
placeholder and named a moment later. This document owns that gap: the
provisional title creation writes, the two passes that replace it, the
`title_status` column that says which of those has happened, the sixty-second
grace that bounds how long a reader is asked to wait, and the skeleton every
surface renders while the wait is on.

The promise the whole design turns on is narrow and worth stating plainly: **a
title skeleton means a name is seconds away.** Everything below exists so that
promise is kept even when the model is unreachable, the isolate goes away
mid-call, or the event carrying the name never lands.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/workstream-naming-service.ts` | Both passes, the provisional title, the model call, the compare-and-set that advances `title_status`, and the rename event. The single source of every generated title. |
| `packages/agent-harness/src/prompts/` | `renderWorkstreamNameMessages` — the naming agent's prompt. See [`writing-prompts.md`](writing-prompts.md). |
| `packages/contracts/src/index.ts` | `WORKSTREAM_NAMING_GRACE_MS`, `WorkstreamNameResultSchema`, and `titleStatus` on every work-stream shape. |
| `apps/api/src/services/workstream-object-creation-service.ts` | The first pass's caller on the desktop create path, and the routed environment it is given. |
| `apps/api/src/services/slack-workspace-workstream-service.ts` | The first pass's caller for a work stream summoned from Slack. |
| `apps/api/src/durable-objects/substream-agent.ts` | The second pass's caller, at the end of a run (`settleAgentRun`). |
| `apps/api/src/durable-objects/workspace-do.ts`, `workstream-object-product.ts` | Where the grace is applied to a read: `directoryWorkstream` for a sidebar row, `summary` for the work stream itself. |
| `apps/desktop/src/renderer/lib/naming-skeleton.ts` | `useNamingSkeleton` — the same rule applied to what the client already holds. Every renderer surface that shows a skeleton reads it from here. |

## How it works

### The title a work stream is created with

A model call cannot sit on the create path — the person who pressed enter is
waiting on the response — so creation writes `provisionalWorkstreamTitle`: the
first non-empty line of the objective, truncated to the 180 characters `title`
accepts, or a caller-supplied fallback when the objective is blank. The row is
written `title_status = 'naming'`, and that value is the promise that a name is
coming.

A create that carries its own title is not named at all: it is written `settled`,
and neither pass will look at it.

### The two passes

**The first pass** runs once, off the caller's clock, from the opening request
alone. It asks the naming agent for a label, normalizes the answer, and advances
`title_status` to `automatic` — *whether or not a name was produced*. A pass that
produced nothing still settles the promise, because a skeleton that never
resolves is worse than the provisional title standing for good.

**The second pass** (`refreshWorkstreamName`) looks again once the work stream
has become a conversation, and replaces the name if the transcript says something
better. It is eligible only while `title_status` is `naming` or `automatic`, and
only past `RENAME_AFTER_MESSAGE_COUNT` (5) member-or-agent text messages — the
first name was chosen from a request, and the identifier, the person, or the
actual problem usually arrives in the replies. It reads the *first*
`RENAME_CONTEXT_MESSAGE_LIMIT` (12) messages, 600 characters each: a name
describes what the work stream is for, which is established in its opening
exchange rather than in whatever is in flight now. A successful pass sets
`settled`, after which nothing generated will change the title again.

The two passes differ in what they do with a model that cannot be reached. The
first settles anyway, because a skeleton is on screen waiting for it. The second
leaves an `automatic` row alone, because nothing is waiting — an `automatic`
title and a `settled` one render identically — and the next run tries again. The
one exception is a row still in `naming`: that is a first pass that never
finished, and its promise is the one that has to be kept.

### The shape of a generated name

Two to four words in sentence case, thirty characters or less. The prompt asks
for it and `normalizeGeneratedTitle` repairs what comes back: a quoted phrase, a
Markdown heading, TeX, a trailing full stop, an answer that starts mid-sentence.

**Thirty is where the cut stops doing the naming.** The length was chosen by
replaying 89 named work streams from the Global directory through the prompt at
each candidate, and counting how often the model answered past it:

| Cap | Model answered over it | What that looked like |
| --- | --- | --- |
| 40 | 1 in 89 | Names sit well inside; the cap is a pure backstop. |
| 30 | 4 in 89 | Names sit inside; the cap is a backstop. |
| 20 | 37 in 89 | Two names in five are a truncation, not a name. |

At twenty the truncation was naming the work stream: names ended on the word the
model meant to continue — *Podcast from*, *Essay on rust and*, *Work on* — and
work streams differing only past the cut collided, with six QA work streams all
arriving as *PRODUCTION HARNESS*. Thirty keeps almost all of the brevity and
almost none of that. The cut still lands on a word boundary and still takes any
comma it exposes, because the four that reach it deserve the least bad cut.

Two lines of the prompt exist because the replay showed the model ignoring the
rule without them. *Count the characters before you answer* took the overshoot at
twenty from 56 in 89 to 37. And *never capitalize every word* is what stopped it
title-casing — at these lengths "capitalized as a sentence" alone returned *Logo
For Oslo Coffee*. Casing cannot be repaired afterwards: lowercasing every word
but the first would spell *Rally*, *Slack*, *IBM* and *INV-2291* wrong, so
`sentenceCased` only capitalizes a first word that is already all lowercase.

It capitalizes *before* the cut, which is what makes the cap a real bound. An
uppercase mapping can be longer than the letter it replaces — `ß` becomes `SS`,
`ﬁ` becomes `FI` — so a capital added after the cut can hand back 31 characters
from a cap of 30.

Two titles are deliberately longer, because neither was generated: the
provisional title, which is the person's own first line, and a title a person
typed. So a sidebar holds both kinds, and nothing downstream may assume a title
is short.

### Advancing the title is a compare-and-set

`advanceTitle` writes `title = COALESCE(<generated>, title)` and the new status
only `WHERE title_status = <the status the pass started from>`. A person can
rename a work stream from its header while a model call is in flight, and their
rename settles the title; a generated name arriving afterwards must not undo it.
Losing that race writes nothing and publishes nothing, because the rename they
made already told everyone.

### How the name reaches people

Two paths, and both matter because they serve different readers:

- **The work stream's room.** `publishWorkstreamEvent` publishes
  `workstream_renamed` with the title and the new status, which reaches anyone
  with that work stream open — in practice, the person who just created it.
- **The workspace directory.** The `UPDATE` names `workstreams`, so the
  work-stream object commits a `directory_common` effect beside it, which flows
  `SubstreamAgent -> WorkstreamDO -> WorkspaceDO` and is pushed to every
  subscribed workspace socket as `workspace_workstream_state`. This is the only
  path to a sidebar row, and therefore the only path to somebody who is a
  participant in the work stream and has not opened it.

### The grace, and why it is applied twice

`WORKSTREAM_NAMING_GRACE_MS` is 60 seconds from creation. Past it, `naming` is
reported as `automatic`: the provisional title is the title, whatever the row
says. That relaxation is applied in two places, and both are load-bearing.

**On a read**, by the authority that serves it — `directoryWorkstream` in
WorkspaceDO and `summary` in the work-stream object. A surface that fetches, like
the menu bar's `/workstreams` page, needs nothing else.

**On what the client already holds**, by `useNamingSkeleton`. No renderer surface
refetches a title on its own: the sidebar list is `staleTime: Infinity` and is
fed by socket pushes, and the work-stream detail is replaced by snapshots. So a
client that held a `naming` row when the rename push failed to reach it would
keep that row for the session. Nothing later corrects it either — the read-time
relaxation is derived and advances no row version, so a fresh directory page
carrying `automatic` is dropped by the state ledger as a repeat of what the
client already has. The hook closes both by applying the same rule to the cached
row.

It decides on every render from that row's own `createdAt` and the clock, and
holds no state of its own; the timer it arms for the remainder of the grace only
schedules the render at the instant the grace lapses. That is what makes it safe
on the work-stream header, which stays mounted while the work stream under it
changes: an answer kept in state would be the previous work stream's until an
effect corrected it after paint, which is a frame of one work stream's request
text under another's header.

## Invariants

- **`title_status = 'naming'` is a promise that something will settle it.** Any
  path that writes it must schedule a first pass in the same request. A creation
  path that writes `naming` and never calls `nameWorkstream` leaves a permanent
  skeleton on every surface, with nothing in the product able to repair it.
- **The first pass advances the status even when it produced no name.** Returning
  early on a model failure is the one change that turns a bad title into a
  broken screen.
- **Every advance is a compare-and-set on the status it started from.** Writing
  the title unconditionally silently discards a person's rename.
- **A surface that renders a skeleton from a cached row applies
  `useNamingSkeleton`.** Reading `titleStatus === 'naming'` directly is correct
  only for a value that just came off a fetch; anywhere else it is the
  shimmer-forever bug, and it is invisible to a component test that renders a
  fixture.
- **The grace is one constant, exported from contracts.** A client and a server
  that disagree about it produce a row whose skeleton and whose title come from
  different rules. All three readers import `WORKSTREAM_NAMING_GRACE_MS`:
  `useNamingSkeleton`, `directoryWorkstream` in WorkspaceDO, and `summary` in the
  work-stream object. A fourth that writes the number instead is invisible to
  anyone changing the constant, and to anyone grepping for the rule.
- **Naming never fails its caller.** Both passes swallow everything: they are
  called after a work stream is created, after a run has finished, beside a
  message that is already durable. None of those can be failed by a title.

## Boundary

This module owns the title of a work stream: the placeholder, the passes that
replace it, `title_status`, and when a reader is shown a skeleton instead of
text.

It does not own the objective — that is
[`workstream-descriptions.md`](workstream-descriptions.md), a separate loop over
a separate column. It does not own the create path or the optimistic launch
surface, which are [`workstream-creation.md`](workstream-creation.md); that
document renders this module's skeleton and defers to this one for what the
skeleton means. It does not own how a name is delivered: the room event is
[`workstream-durable-object.md`](workstream-durable-object.md)'s socket and the
sidebar push is its directory projection, and which of the two carries what is
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md). It does not own the
prompt's wording ([`writing-prompts.md`](writing-prompts.md)) or which model runs
it ([`feature-flags.md`](feature-flags.md)). A title a person types is an
ordinary work-stream update and belongs to the object's product service.

## Failure modes and limits

- **`OPENROUTER_API_KEY` is unset, or the model is unreachable.** No name is
  produced. The first pass settles the provisional title as `automatic`; the
  second leaves an `automatic` row for the next run.
- **The model answers with something unusable** — a quoted phrase, a Markdown
  heading, a capitalized sentence, a trailing period, TeX. `normalizeGeneratedTitle`
  repairs it rather than the prompt prohibiting it, and reduces an answer with
  nothing left — a bare emoji, punctuation alone — to `null`, which is treated as
  no name.
- **The isolate goes away mid-call.** The row stays `naming`. Every *read* past
  the grace reports `automatic`, and every cached row stops shimmering at the
  same instant; the second pass repairs the row itself at the end of the next
  run.
- **The rename push is lost.** The client falls back to the provisional title at
  the grace, which is exactly what a fresh read would have said. The generated
  name arrives at the next event that touches the row, or the next reconnect that
  finds the row's version advanced.
- **Limits.** A generated title is capped at 30 characters, cut back to the last
  whole word — `title` holds 180, but a generated name is a label rather than a
  sentence, and the tail of a word cut mid-way reads as a typo. At this length
  the cut is a backstop: it fired on 4 of the 89 replayed work streams. The
  provisional title is capped at the column's 180. The second pass reads at most
  12 messages of 600 characters and runs at most once. The grace is 60 seconds.

## Testing

- `apps/api/test/workstream-naming.test.ts` (Node) covers both passes against the
  checked-in schema and a real work-stream object store: the compare-and-set, the
  message-count threshold, the unreachable model, the normalizer, and that
  nothing it does can fail its caller. It executes the object's SQL directly, so
  it proves the write and the room event but not the directory effect.
- `apps/api/test-workers/durable-object-runtime.test.ts` covers the other half on
  real workerd — *"pushes a generated name to a participant who never opened the
  work stream"* runs the naming statement through the runtime port and asserts the
  frame that arrives on a second member's workspace socket, with no work-stream
  room socket anywhere in the test. Break it by removing `workstreams` from the
  `affectsDirectory` pattern in `workstream-runtime-sql.ts`; it then times out
  waiting for a push that is never enqueued.
- `apps/desktop/src/renderer/components/sidebar.test.tsx` and
  `screens/workstream.test.tsx` cover the two surfaces of `useNamingSkeleton`,
  each with a row inside the grace and one past it. The rule is a function of
  `createdAt`, and both files' fixtures carry dates older than the grace, so a
  naming case has to supply its own: the inside-the-grace tests build one from
  the current clock, and the past-the-grace tests take fake timers, set the system
  clock to the creation instant, and advance past it. A naming fixture left on the
  file's hard-coded date asserts nothing.

## Changelog

### 2026-09-05 — Sentence case, two to four words, thirty characters

**What changed:** The channel styling is gone. A generated name is two to four
words in sentence case, thirty characters or less; `normalizeGeneratedTitle` is
back to repairing an answer rather than reshaping it — no lowercasing, no
hyphenating, and the apostrophe rule the hyphenating needed is gone with it. It
keeps the whole-word cut, which now also strips a comma the cut exposes, and
`sentenceCased` is back.

**Why:** Chosen by replaying 89 named work streams from the Global directory
through the prompt at 40, 30 and 20 characters against the model production
uses. Twenty was tried first and rejected on that evidence: the model answered
past it 37 times in 89, so two names in five were a truncation rather than a
name. Thirty costs 4 in 89. The table in the section above is that measurement.

Two lines of the prompt are the replay's findings rather than the author's
judgement. The model title-cases at these lengths unless told *never capitalize
every word* in as many words — "capitalized as a sentence" alone produced *Logo
For Oslo Coffee*. And it answers over the cap unless told to count the
characters, which at twenty took the overshoot from 56 in 89 to 37.

**Considered and rejected:** Enforcing sentence case in the normalizer, by
lowercasing every word after the first. It cannot tell a proper noun from an
ordinary one, so it would spell *Rally*, *Slack*, *IBM* and *INV-2291* wrong;
casing has to come from the prompt. Also considered and not built: asking the
model again when its answer is too long, rather than cutting. At twenty that
would have mattered — it would have rewritten two names in five — but at thirty
it would buy four names in 89 at the price of a second model call on each, and a
rewrite is not obviously better than a truncation while nobody has compared them.

**Consequences:** Changing the length is one constant in the naming service and
two sentences in the prompt, and they have to move together — the constant feeds
the JSON Schema the model is handed as well as the cut. The replay that chose
the number is reproducible: it lifts the prompt from the tree rather than
carrying a copy, and asserts its normalizer port against this module's own test
vectors before it calls anything, which is what caught the vectors going stale
when the cap moved.

### 2026-09-05 — An apostrophe is elided rather than separating a word

**What changed:** `normalizeGeneratedTitle` removes `'` and `’` before turning
everything else a channel name cannot hold into the separator, so `what's rally`
becomes `whats-rally`. The prompt also now says which half of a name to drop when
it will not fit: the words that frame the work, never the detail that identifies
it.

**Why:** 89 model-named work streams from the Global directory were replayed
through this prompt and the one it replaced, against the same model production
uses. The apostrophe was the only defect the normalizer itself introduced —
`what-s-rally` reads as a typo, and a possessive is among the commonest things a
name leads with. The prompt change answers the one regression the replay showed
against the old prompt: asked to search two places for one subject, the model
kept the two places and dropped the subject, which is the opposite of the rule
about the distinguishing detail. Forty characters is not what squeezes it — one
name in 89 was long enough for the cut to fire at all.

**Consequences:** An apostrophe is the single exception to "everything else
becomes the separator", and it is in the normalizer rather than the prompt
because it is a repair, not a rule a model has to follow. The replay is
reproducible: it lifts each prompt from the tree and from git rather than
carrying a copy, and asserts both normalizer ports against this file's own test
vectors before it calls anything.

### 2026-09-05 — Generated names are channel-style, and forty characters

**What changed:** The naming prompt asks for a name written the way a Slack
channel is — two to four lowercase words joined by hyphens, forty characters or
less — and `normalizeGeneratedTitle` enforces that shape rather than
sentence-casing the answer. The generated cap dropped from 80 characters to 40,
and a name past it is cut back to its last whole word instead of mid-word.

**Why:** A product decision about how a list of work streams should read: a
column of hyphenated labels is scannable in a way a column of sentence
fragments is not, and it is the shape people already read lists of rooms in.
Forty characters is the team's number for it.

**Considered and rejected:** Changing the prompt alone. The model does this
correctly most of the time and not all of the time, and the surface that would
show the difference is the sidebar, where one prose title among hyphenated ones
is the thing a person notices. The normalizer was already where an unusable
answer is repaired, so the shape is guaranteed there and the prompt keeps one
rule rather than a list of prohibitions. Also rejected: rejecting an over-long
name at `WorkstreamNameResultSchema`, whose ceiling stays at 80 — a name eight
characters long is a name, and failing the parse would leave the work stream
with its provisional title instead.

**Consequences:** `sentenceCased` is gone; anything that wants a generated title
capitalized has to do it at the surface. Nothing downstream may assume a title
is hyphenated: the provisional title and a title a person typed are still prose,
and both sit in the same list. Changing the length again is one constant in the
naming service and one sentence in the prompt, and they have to move together.

### 2026-08-24 — Both server read sites import the grace they were spelling out

**What changed:** `directoryWorkstream` in WorkspaceDO and `summary` in the
work-stream object now import `WORKSTREAM_NAMING_GRACE_MS` instead of comparing
against a literal `60_000`.

**Why:** Review on #271. The invariant above says the grace is one constant, and
the code did not hold it: the constant had exactly one non-test importer — the
client hook this change added — while both authorities wrote the number. Nobody
grepping for `60_000` would have found the client rule, and nobody changing the
constant would have found the server ones. The pull request that writes an
invariant down is the cheapest place to make it true.

**Consequences:** Changing the grace is now one edit. The three readers agree by
construction rather than by review.

### 2026-08-24 — The grace is derived per render rather than held in state

**What changed:** `useNamingSkeleton` no longer keeps an `expired` flag. It
computes the answer from the row's deadline and the current clock on every
render, and the timer only forces the render at the moment the grace lapses.

**Why:** Review on #271. The flag was initialised at mount and reconciled by an
effect, and the work-stream header stays mounted across work streams by design —
so moving from a settled work stream to a freshly created one rendered the new
one's provisional request text for a frame before the effect replaced it with the
skeleton, and moving the other way flashed a skeleton. Sidebar rows are keyed by
work-stream id and remount, which is why the surface that reported the original
bug never showed this one.

**Consequences:** The hook reads `Date.now()` during render, which is honest for
a value that is a function of the clock and is what makes the answer correct on
the first paint. Its own suite records what the hook returned on *every* render
rather than asserting on the DOM after effects have flushed, because Testing
Library flushes them before an assertion can see the frame that was painted.

### 2026-08-24 — The sidebar row honours the naming grace it renders a skeleton for

**What changed:** `useNamingSkeleton` moved out of `screens/workstream.tsx` into
`lib/naming-skeleton.ts`, and the sidebar's work-stream row now decides its
skeleton with it instead of reading `titleStatus === 'naming'` directly. A row
whose creation time cannot be read is treated as past the grace rather than as
inside it.

**Why:** A participant who was not the creator, and who had not opened the work
stream, watched a sidebar row shimmer indefinitely. The row is a cache entry, not
a read: the sidebar's query is `staleTime: Infinity` and is fed by socket pushes,
so the server's read-time relaxation of `naming` never reached it — and could
not, because that relaxation is derived and advances no row version, so the
versioned state ledger drops a fresh page carrying `automatic` as a repeat.
Opening the work stream was the only repair, and it repaired the header rather
than the row. The header already had this rule, for this exact reason; the
sidebar was the surface it was never applied to.

**Considered and rejected:** Making the client accept a page whose row version
has not advanced. That is the rule that stops a paged answer from walking back a
state the direct WorkstreamDO socket already advanced, and trading a permanent
skeleton for a title that can flicker backwards is the worse bug. Also rejected:
having the server stamp a new row version when the grace elapses. Nothing is
awake at that instant to stamp it — the whole point is that no further write is
coming — so it would mean a timer per unnamed work stream in the authority that
holds it, to change a value both sides can derive from `createdAt`.

**Consequences:** The grace is now enforced in three places against one exported
constant, and a fourth surface that renders a title from cached state has to use
the hook rather than the column. The API's read-time relaxation stays as it is;
it is what a fetching surface like the menu bar relies on. Where a rename push is
genuinely lost, the sidebar now shows the provisional title — the same answer a
fresh read gives — instead of a skeleton.

This document itself is new. Naming had no owner: `workstream-creation.md`
pointed at `workstream-descriptions.md` for it, and that document disclaims the
title in its own boundary section. The pointer now names this file.
