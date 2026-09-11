# Plugin activity rows

What the work-stream transcript shows in place of an agent's tool calls: one row
per plugin per uninterrupted stretch of work, saying which place Rally is working
in and for how long — "Using Slack for 4m 02s", becoming "Used Slack for 5m 02s"
when the plugin is done.

The same collapse is applied to the model's thinking, which arrives one row per
reasoning segment and reads as one "Thought for …" per run.

Once an answer reports on a stretch of that work, the stretch folds behind one
closed accordion sitting directly above the answer — "Worked for 41m 17s" where
the stretch is the whole response, and the union of when its own rows worked
where the response narrated itself into several.

Read this before changing what a tool call or a thinking segment looks like in
the feed, adding a first-party plugin, changing a plugin's canonical id or
display name, or changing when a tool block learns its owner. The rows a person
actually reads — Rally's own sentences, elicitations, suggestions — are
untouched by any of it; this document is only about the machinery underneath
them.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/plugin-groups.ts` | The only place that decides which row a plugin belongs to, what that row is called, and which glyph it draws. |
| `apps/desktop/src/renderer/lib/plugin-marks.ts` | The company marks, one `@thesvg/react` component per brand, and `connectorBrandMark` — the one table saying which mark a connector wears. |
| `apps/desktop/src/renderer/components/primitives.tsx` | `ConnectorMark`, the one component that draws one. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | Settings' provider cards and installed-connection rows, both reaching a mark from the connector's own type. |
| `apps/desktop/src/renderer/lib/transcript.ts` | `orderedTranscriptMessages` projects tool blocks, thinking blocks, and plugin activities out of the canonical snapshot, and marks the seam where its coverage is not contiguous; `groupPluginToolMessages` collapses the composed feed, `groupThinkingMessages` collapses the thinking left in it, and `collapseSettledWorkIntoAccordion` folds each finished stretch of a run behind the answer that reported on it, carrying the total `foldSettledWorkIntoMessages` resolved where that stretch is the whole response. `thoughtVerb` and `isThinkingEvent` are the one place the two thought rows are told apart. |
| `apps/desktop/src/renderer/screens/workstream.tsx` | Applies the four passes in order, and is the only caller of any of them. |
| `apps/desktop/src/renderer/lib/types.ts` | `WorkTotal` — the one shape a settled total has, carried by `workSummary` in a message header and by `workAccordion` on the row over the run, so the total can move between them without the two drifting apart. `WorkSpan` — when a row's work happened, carried by `workSpans`, which is what a stretch of several rows is added up by. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `PluginGlyph` draws a mark; `PluginActivityBlock` renders one grouped row; `ThinkingGlyph` draws the thinking row's brain and `ThoughtBlock` decides which of the two thought rows gets it; `WorkAccordionBlock` is the closed row a reported-on stretch becomes, and `WorkAccordionRow` draws what is inside it through those same two blocks. |
| `apps/desktop/src/renderer/components/agent-work-timing.tsx` | The shared elapsed-time row; its `icon` slot is what lets a plugin's mark, or the thinking row's brain, stand in for the orb. |
| `apps/desktop/src/renderer/styles/app.css` | `.plugin-face` and `.plugin-face-active` — the transcript's bare mark box and its pulse, shared by the plugin rows and the thinking row; `.work-accordion` and its toggle. |
| `apps/desktop/src/renderer/components/message-feed.tsx` | Holds which rows a reader has opened, above the virtual window, and hands it to every row as `RowDisclosure`. |

## How it works

### What the transcript carries

The canonical ordered transcript
([`workstream-durable-object.md`](workstream-durable-object.md)) delivers the
row's material in one field:

- **`snapshot.pluginRuns`** states, per plugin per assistant turn, its
  `pluginRunId`, `turnId`, `pluginId`, `displayName`, `state`, `durationMs`,
  `timingAccuracy`, and the `toolCallIds` it placed. A client joins a tool block
  to its run on `toolCallIds` and renders what it is told. `durationMs` is
  **nullable**, and null means the timing is unknown rather than zero.
- A **tool block** still carries `pluginId` — `rally:memory` or
  `connection:<uuid>`. The block is written when the model *plans* the call and
  its `pluginId` is filled in when the call *starts*, so a block is briefly
  anonymous.

A plugin activity (`scope: 'plugin'`) still hangs off the assistant turn and is
what `pluginRuns` is computed from. Its elapsed time covers the whole stretch
the plugin was in play, including the gaps between its calls, which no sum of
individual call durations can reproduce. The client no longer reads its
*duration* directly except as the legacy fallback below — but it does read its
**intervals** on the main path, because they are the only place the transcript
says *when* a run worked, and a folded stretch adds its rows up by that. A run
whose activity did not reach the snapshot therefore has an authoritative
duration and no spans, which is a state the accordion is built to expect.

### The five steps

1. **Projection.** `orderedTranscriptMessages` copies `pluginId` and the owning
   run's `displayName` onto each tool row, and turns each entry of
   `snapshot.pluginRuns` into a `plugin_activity` row. When `pluginRuns` is
   empty — an API that predates the field — it falls back to deriving the same
   row from the activity tree.
2. **Composition.** `composeTranscript` interleaves those canonical rows with
   live overlays exactly as before. A live tool row that has not yet been
   replaced by its canonical block carries the connector plugin's display name,
   which is all grouping needs from it.
3. **Grouping.** `groupPluginToolMessages` walks the composed list once. Each
   tool or plugin-activity row resolves to a group through `pluginGroup`; the
   first row of a group becomes the group's row, at that position, and every
   later row of the same group folds into it and disappears.
4. **Collapsing the thinking.** `groupThinkingMessages` walks the result the
   same way, over the same run boundary, and sums a run's thinking rows into
   the first of them. The response's own total is not thinking and is left
   alone; see [the thinking rows](#the-thinking-rows).
5. **Closing a reported-on stretch.** `foldSettledWorkIntoMessages` resolves
   the settled response total to the answer it belongs to, and
   `collapseSettledWorkIntoAccordion` folds the rows above *every* agent answer
   into one closed row — carrying that total where the response produced a single
   accordion; see
   [when an answer reports on the work above it](#when-an-answer-reports-on-the-work-above-it).

### The thinking rows

A thinking block is the model reasoning, and the transcript gives each one its
own activity and so its own row. The model thinks between every pair of tool
calls, so a run that used one plugin four times reaches the feed as one grouped
plugin row and four thinking rows stacked under it — "Thought for 29s / Thought
for 38s / Thought for 17s / Thought for 14s". Each is true and none is what a
reader wanted to know, which is the same complaint the per-call tool rows
answered: what places Rally worked in, and for how long.

So `groupThinkingMessages` sums a run's thinking into one row — "Thinking for
1m 39s" while any segment is still going, "Thought for 1m 38s" once they have
all settled — sitting where the run's first thinking row sat.

That row draws a **brain** where a plugin row draws its mark, in the same box
and with the same pulse while its activity is still reported active — which is
the plugin mark's own condition, and a looser one than the ticking number's:
a row whose intervals have all closed keeps the pulse and freezes the number. The orb it replaces said only
that something was running, which the shimmering label already said; every other
row in the column names the place the work happened, and reasoning is one of
those places. The response's own total keeps the orb — it covers tool calls as
well as thinking, and the orb is the shape that stands for work in general.

Two rows deliberately stay out of it:

- **The response's own total**, the "Worked for …" row at the foot of a live
  run, which `foldSettledWorkIntoMessages` moves onto the message it produced
  when it settles — and which then becomes the label of that response's single
  accordion, or stays in the header where there is no accordion or more than
  one. It is one fact about the whole
  response, not a step inside it. The two are told apart by the row's verb,
  which is the same signal that fold already keys on.
- **The plugin rows the thinking surrounds.** They keep their own places, since
  grouping has already anchored each at its plugin's first call in the run.

A run also stops at a stretch of transcript this client has not loaded, which
the projection marks for both passes — see the invariant below.

The arithmetic follows the plugin row's, for the same reasons: one segment with
an unknown duration makes the whole run's total unknown rather than shorter, a
recovered segment's `upper_bound` accuracy carries to the whole row, and every
still-running segment contributes its own monotonic start so the live number
advances at the rate its own total accrues.

### What the groups are

`rally:core`, `rally:discovery`, `rally:memory`, `rally:tables`, and
`rally.skills` are all Rally reasoning about its own workspace, and are drawn as
one **Rally** row. `rally:terminal` and `rally:workstream` are Rally operating a
machine, and are drawn as one **Computer** row. The
`rally:multimodal-generation` plugin keeps its own **Multimodal generation** row;
its canonical id maps it to Tabler's dedicated **image-generation** glyph rather
than the generic plug, and `rally:sidekicks` keeps its own **Sidekicks** row
the same way, drawing Tabler's **keyframes** glyph; `rally:automations`, the id
transcripts recorded before the rename, maps to the same row so a stored row
keeps its glyph. A first-party plugin that is
absent from that map *and* has no display name of its own — which is how an
undecided one appears, since the transcript falls back to the raw id as its
label — joins Rally, so an internal identifier never reaches the feed. Every
other plugin keeps its own row.

A connector's row is keyed on its **display name**, not its id. Two connections
to the same service are one place as far as a reader is concerned, and the name
is also the only key the live pre-canonical row and the canonical block that
replaces it can both produce: they identify the same plugin by different ids
(`plugin_slack` against `connection:<uuid>`).

The glyph comes from the display name too. The canonical transcript identifies a
connector only by connection id, and the icon the backend does resolve travels on
the live tool-invocation row alone, so the name is the one signal available on
both paths. It is a manifest string, not user input. Every connector Rally has an
adapter for is named in that mapping; the generic plug is for one that arrives
before the mapping learns about it.

### The marks

A company draws its own mark, from `@thesvg/react`.
[`using-company-brand-icons.md`](using-company-brand-icons.md) owns that — where
a mark comes from, why it is imported one subpath at a time, and why it is
monochrome. Rally's own mark, the two
virtual groups, the public web, and an unbranded webhook are not companies and
keep their existing artwork.

**The mark belongs to the connector, not to this feed.** `connectorBrandMark`
maps a connector's own type to its mark, and every surface that draws a
connector goes through it: a transcript row, Settings' provider cards, and
Settings' installed-connection rows. That is what keeps one company looking like
one company — before this, GitHub was a `GitBranch` in Settings and a
`brand-github` in the feed, and Granola and Notion shared a `FileText`.

A transcript row is the one caller that does not hold a connector type: the
canonical transcript names a plugin by connection id, so `connectorTypeForName`
recovers the type from the display name first and then asks the same table. The
two routes are pinned together by a test, per plugin, because a table reached
two ways is a table that can disagree with itself.

Two things about how a mark is drawn are load-bearing:

- **It is a React component, not markup and not a string.** Each brand is a
  component imported from its own subpath, so a mark reaches the page as real
  React elements — nothing is injected, and `dangerouslySetInnerHTML` stays
  absent from this renderer. It also has to be imported one subpath at a time:
  the barrel costs a cold CI lint run its heap.
  [`using-company-brand-icons.md`](using-company-brand-icons.md) holds the
  measurement and `scripts/eslint-rules/thesvg-subpath-imports.mjs` enforces it.
- **The mark is monochrome.** That is what this feed wants: one contrasting
  neutral across both appearances, instead of brand palettes of which several
  vanish against one ground or the other — X and Notion in dark, Granola in
  light. It also means no appearance-specific artwork and no component that
  knows which appearance is on.

Monochrome is asked for rather than imposed. Six of the eight brands ship a
`mono` variant already drawn in `currentColor`, and `PLUGIN_BRAND_MARKS` records
which ones — so a brand that gains or loses `mono` upstream fails that table
rather than the render. Slack and Granola ship none, and `.connector-mark`
recolours their palette in CSS instead.

### Where a run ends

A group only merges rows that sit in one uninterrupted stretch of agent
activity. Thinking rows do not end that stretch — the model thinks between
almost every pair of calls, so ending on one would mean nothing ever grouped.
Anything a person reads or answers does end it: after a sentence from Rally, a
plugin picked up again starts a second row under that sentence, because folding
later work back into a row printed above the sentence would put the feed out of
order with its own narration.

### The row itself

`PluginActivityBlock` is `AgentWorkTiming` with the plugin's verbs and its mark
in the orb's slot. Rally is the agent and is the subject of its own sentence —
"Rally worked for 5s" — while every other plugin is something Rally reached for
and reads that way: "Used Slack for 5s". The Computer group is the one whose
name is a common noun rather than a proper one, so it is the one that takes an
article: "Used a computer for 11s". A row whose duration is unknown drops the
duration rather than printing `0ms`, running or settled: printing the active
segment alone would read as the whole.

Every row's label opens with a capital, and `AgentWorkTiming` is what puts it
there rather than each producer. A plugin group already names itself in
sentence shape, but the thought rows carry bare English verbs, and a
`sentenceCase` at the point the sentence is assembled is what keeps "Thought
for 7s" from having to be spelled that way in the projection — where the same
string is also the identifier that tells a thinking row from a response total.
That covers the rows only: the message header and the accordion toggle are
`workSummaryLabel`'s own sentence, which hard-codes "Worked" and deliberately
ignores the row's verb.

The mark is drawn bare — no chip, no ring, no per-connector brand fill — and
pulses its opacity while the group is active, which is the whole of the "still
going" signal. A column of enclosed glyphs down a transcript reads as a toolbar
of controls, and these are labels; the single neutral is also the only colour
with guaranteed contrast, because a connector's brand foreground was chosen
against its own chip and the transcript has two appearances and no chip.

A **settled response total** is not a plugin row and does not live in the feed
as one. While it runs it is progress and stays a row; once it settles
`foldSettledWorkIntoMessages` moves it onto the message it produced, and it is
printed either as the label of that response's single accordion or, where the
response produced no accordion or more than one, in the message header — "Rally ·
11 minutes ago · Worked for 2m 52s". Either way a spent timer stops sitting under
the answer, where it reads like another step still to come.

### When an answer reports on the work above it

Every row above is progress, and progress is worth a line each: while Rally is
working, a reader watches which places it is in and how long each is taking. An
answer is Rally's own report on that work, so the moment one is posted none of
the rows above it is progress any more. Four spent timers stacked above a
sentence that already summarizes them are a receipt.

So `collapseSettledWorkIntoAccordion` folds that stretch into a single closed
row, sitting where the stretch's first row sat, directly above the answer. A
reader who wants the breakdown opens it and gets the same rows, unchanged, drawn
by the same components.

**The answer is the signal, not the settled response timer.** A long run narrates
itself — it works, says what it found, works again, says what that found — and
its response timer settles once, at the very end. Keying the collapse on that
timer folded the last stretch only and left every earlier one expanded above the
sentence that had already summarized it, which is the stack of spent timers this
feature exists to remove. Keying it on the answer folds each stretch as its own
report arrives, and the live tail — the rows with no answer under them yet — is
the only thing left open, which is exactly the part still worth watching.

**Nothing a reader is still watching is folded away, and the pass says so
directly** rather than leaning on where the rows sit. Every row of a stretch is
asked whether it is still reporting work, and one that is keeps the whole
stretch in the feed until it settles. Position looks like it would answer the
same question — the projection puts a response's own timer after every block of
its last turn, so ordinarily it is the final row with no answer beneath it — but
a streaming answer overlay is inserted at `transcriptSequence - 1` and can
arrive *below* that still-running timer, which put a live timer inside a closed
drawer.

The control is the markdown headings' collapse chevron — the same `ChevronRight`
at 14px and 1.8, the same muted neutral, the same quarter turn on the same
140ms — because the reader has already learned it on the answer immediately
below, and a second collapse drawn a second way a few pixels above the first
reads as a different kind of thing. It hangs in the gutter the same way too:
outdented into the margin, so the total starts on the transcript's own left
edge — level with the author line and with the answer's paragraphs — and the
chevron is the only thing outside that edge. The horizontal offset is the
heading's exactly — both a flat `left: -20px` — so an alignment change moves
both. Only the vertical box differs: the heading sizes its own against a
heading's line in `em`, and this row's is a flat 20px of its own — not
`height: 100%` against the toggle, which resolves to 20px today but would
stretch and centre the glyph across two lines if the label ever wrapped.

Three things about it are decisions rather than details:

- **The total moves onto the accordion only when that accordion is the whole
  response.** `foldSettledWorkIntoMessages` has already resolved the settled
  response timer to the answer it belongs to, and where the response produced a
  single accordion, that accordion stands for the whole of what the timer
  measured, so the pass takes `workSummary` off the message as it builds the row
  — printing it there *and* in the header a line below would be one duration
  competing with itself. Where the response narrated itself into several
  stretches, no one of them is the whole response: a total covering all of them
  printed on the last would claim "Worked for 3m 12s" for a drawer holding 21s
  of rows. It stays in the final answer's header instead. **Both renderings
  stay**, and a turn that reached for nothing has no accordion to move the total
  to either; its header keeps the line, as before.
- **The total is never a sum over the rows inside — it is the union of when they
  worked.** A run's thinking overlaps its plugin work — the model reasons between
  calls, and a plugin's activity covers the gaps between its own — so adding the
  rows' durations up would overstate the stretch by however much of it ran
  concurrently. Adding up *when* they worked does not: every machinery row
  carries the `workSpans` of the activity that measured it, and
  `foldedStretchTotal` unions them, counting a second two rows shared once. A
  stretch whose rows cannot all say when they worked still reads a plain
  "Worked" — the same sentence an unknown duration produces, from the same
  function — because a union over the rest would print a number quietly missing
  the row that could not answer.
- **The rows are nested inside the accordion row, not hidden in place.** The
  transcript is virtualized. A collapse that left its rows in the list would
  still cost one measured item each, and opening one would grow N items whose
  heights the cache has to be told about separately; one row is one measurement.
  For the same reason the open flag is held by `MessageFeed` rather than by the
  row — see `RowDisclosure`, whose set the clamped system row already uses.

The boundary is the stretch's: the rows immediately above the answer, back to
the first thing a person read, or to a stretch of transcript nobody has loaded.
That is the boundary `groupPluginToolMessages` and `groupThinkingMessages`
already grouped within, so an accordion holds exactly one stretch's worth of
rows, each of them already one per plugin.

The unloaded-stretch half of that boundary is checked at **both** ends of the
scan, which is the one place this pass differs in shape from the two before it.
They walk forward and close the run on any row carrying
`precededByTranscriptGap`, the row that would close it included; this one walks
backward from the answer, so it has to read the flag on that answer too. The
projection sets it on a turn's *first* row only, so an answer that opens its
turn is exactly where it lands — and such an answer opens a newly loaded island,
which makes the machinery above it in the list some earlier island's. It has no
stretch of its own to fold, so it keeps its total in the header.

Counting a response's accordions needs a boundary of its own, and **the settled
response total is the only one this feed carries**. It runs wherever the answer
carrying it ended up, folded or not; without it a second response following the
first would be counted as a continuation and would never take its own total.

A row a person read is deliberately *not* a boundary, which is the
counter-intuitive half. A steer is committed as its own canonical turn *between*
two answers of one response — [`agent-harness.md`](agent-harness.md) has the
promotion rule — while the response activity, and the total it settles to, spans
both sides of it. Resetting there let the stretch after the steer take a total
covering the work before it too, which is the exact mislabel this counter exists
to prevent.

The count is also only a proxy for "this accordion is the whole response", and
the proxy fails across a seam: a response whose earlier stretches sit in an
unloaded island shows one accordion while having produced several. So a seam
marks the response's coverage **partial**, and a partial response never hands its
total to a drawer — the number would claim time the drawer does not contain, and
would jump from the drawer back to the header the moment the gap was filled. That
mark clears where the count does, at the next settled total: the response it ends
is the one that might have been partly unloaded, and what follows it is loaded.

## Invariants

- **No tool row survives grouping in the work-stream feed.** A tool row that
  resolves to no plugin is dropped rather than rendered, because the only thing
  it carries is a tool name — the thing this feature exists to hide. Rendering
  it as a fallback would put the old surface back on screen for exactly the runs
  where the transcript is least settled.
- **A group's timing comes from plugin activities when it has any, and from
  summed call durations only when it has none.** The two are not additive: an
  activity already contains the calls. Adding them would roughly double a
  plugin's reported time.
- **The live number advances by every contribution still running, not by one of
  them.** Bind runs a batch's non-activation tool calls concurrently, so two
  first-party plugins in the Rally group are active at the same time and the
  row's completed total counts both. A single start would advance the row at
  half the rate its own total accrues, and the number would jump to the real
  total at the moment they settled. This is why `monotonicStartedAt` is a list
  on both `PluginActivityData` and `AgentWorkTiming`.
- **A collapsed thinking row's total is the run's, and its position is the
  run's first thought.** Both follow the plugin row's rule, and for the same
  reason: the feed's order is the order work started in. The response's own
  timer is never part of that total — it is the whole response, not a step in
  it, and summing it into a turn's thinking would double-count it and put it out
  of reach of `foldSettledWorkIntoMessages`.
- **A group row's position is its plugin's first row in the run, never its
  last.** The feed's order is the order work started in; the alternative makes a
  row jump downward as the plugin is used again.
- **A run never crosses transcript nobody has loaded.** A snapshot's coverage
  is not one interval — the opening one commonly holds an unread island and a
  separate latest island — and the projection flattens both into one list, so
  two rows either side of that seam look adjacent and are not. The projection
  marks the first row after a gap with `precededByTranscriptGap`, computed from
  the snapshot's own coverage, and **both** passes close their run on it. A jump
  in `transcriptSequence` is not the signal: it cannot tell a hidden turn from a
  sequence the transcript never assigned.
- **`pluginGroup` is the only mapping.** A second table anywhere — a component
  branching on `pluginId`, a screen naming Rally itself — is how the feed and
  the row it draws come to disagree about what a group is.
- **A group row carries no attention ordinal.** It stands for machinery, not
  for something a person read. The tool row it is built from carries its
  *turn's* ordinal — the same one that turn's text carries — so keeping it would
  let a group scrolling into view acknowledge an answer still below the fold,
  through a read receipt the server stores.
- **A plugin id this module cannot name is not a row.** Naming a row after
  `connection:<uuid>` leaks an internal identifier into the feed and keys the
  group on the id, so the display name arriving later opens a second row beside
  the first instead of merging.
- **Every caller that overrides `activeVerb` also passes `activeName`.** The
  visible label ticks ten times a second, so a live region carries the name
  instead; deriving it from the verb left a thinking row announcing the bare
  word "thinking".
- **A producer's verb stays as it is written; only `AgentWorkTiming` cases it.**
  `activeVerb` is also the identity three readers compare a thought row's scope
  with — `isThinkingEvent`, `foldSettledWorkIntoMessages`, and `ThoughtBlock`'s
  choice of the brain over the orb — and each of them resolves a mismatch by
  returning the wrong row rather than failing. Rewording a verb for how it
  reads therefore moves rows between scopes silently. The row's sentence is
  shaped where it is assembled, which is the one place that has no other job.
- **A mark is sized through the surface that owns it.** `.connector-mark` holds
  the default low in the stylesheet, so a per-surface size written as a bare
  class ties it and loses on source order — an inert rule that reads as if it
  applies.
- **No brand palette reaches the document.** A mark is alpha painted in the
  row's own colour. Drawing one in its brand colours would put eight
  independently-chosen palettes on four grounds, and several of them disappear
  on one or the other; it would also make the mark the only thing in the row a
  theme cannot restyle.
- **A brand's artwork is never injected as markup.** `dangerouslySetInnerHTML`
  is absent from this renderer, and `plugin-marks.ts` is the module a reader
  would copy from if it were not.
- **One connector, one mark, on every surface.** A surface that picks its own
  glyph for a connector — a hardcoded icon in a settings catalog, a second table
  keyed on something else — is how the same company comes to look like two.
  `connectorBrandMark` is the table; `ConnectorMark` is the component.
- **A mark is drawn where the surface already had one.** The transcript's is
  bare because its row is a label; Settings' provider card keeps its tinted
  chip because that card is a control somebody clicks. Adding the mark did not
  restyle either.
- **A stretch collapses when an answer reports on it, not when the response
  timer settles.** An answer is Rally's own account of the rows above it, and a
  response that narrates itself posts several. Keying on the response timer folds
  only the last stretch. Keying on "every row in the stretch reports itself
  settled" was rejected for the reason it always was: it would close the drawer
  mid-run, in the window between one plugin finishing and the next starting.
- **Nothing a reader is still watching is folded away.** A stretch holding a row
  that still reports live work stays in the feed until it settles. This is asked
  of the rows, never inferred from where they sit: a streaming overlay is
  inserted at `transcriptSequence - 1` and can arrive below the response's own
  still-running timer.
- **The settled response total is the only response boundary the feed carries.**
  A row a person read is not one — a steer is its own canonical turn inside a
  single response — so nothing else resets the accordion count or the coverage
  mark.
- **The accordion's total is the response's where the drawer is the response,
  and otherwise the union of its rows' spans — never a sum of their durations.**
  Thinking overlaps plugin work and a plugin activity covers the gaps between
  its own calls, so a sum overstates the stretch by whatever ran concurrently; a
  union of the wall-clock stretches those rows occupied does not. A stretch of
  several rows, one of whose spans never reached this client, says "Worked" and
  no number; a stretch of exactly *one* row reports that row's own duration,
  because there is nothing for it to be overlapping with. One holding a
  recovered boundary reads "Worked for at most …" —
  that accuracy rides on the span itself, because a plugin group assembled from
  tool rows alone has no aggregate accuracy to read it from.
- **A response the client has only part of never labels a drawer.** Counting
  accordions is a proxy for "this drawer is the whole response", and the proxy
  fails across a seam: a response whose earlier stretches were never loaded shows
  one accordion and produced several. A seam on the response's own work marks its
  coverage partial and the total stays in the header, where it is a fact about
  the answer rather than a claim about a drawer.
- **A settled total is printed in exactly one place.** On the accordion where
  that accordion is the response's only one, in the message header otherwise —
  where the turn reached for nothing, and where the response narrated itself
  into several stretches that the total does not describe one of. All the
  renderings exist; none is a fallback for another failing.
- **The accordion takes a derived id.** The row it sits in place of is still in
  the feed — inside it — and two elements answering to one `message-<id>` anchor
  is worse than none. The rows inside carry no anchor at all.
- **The run's seam is checked at both ends of the scan.** An answer that itself
  carries `precededByTranscriptGap` opens a newly loaded island, so the
  machinery above it in the list belongs to an earlier one. The projection marks
  only a turn's *first* row, so this is the shape where an answer carries the
  flag: a turn whose first block is its text. Scanning back from it would fold a
  previous island's rows into this answer's drawer.
- **The accordion carries an attention ordinal but never acknowledges one.**
  Two different questions, and the grouped plugin row answers only the second.
  The unread divider is placed at the first row carrying an ordinal, so a row
  that swallowed the ones that carried it has to carry it too — otherwise the
  divider slides down past the accordion and an unread turn's work sits in the
  read section above it. Acknowledgement is separate:
  `highestVisibleAttentionSequence` excludes `work_accordion` the way it already
  excludes a tool row, because an accordion scrolling into view — or a long one
  being scrolled through — says nothing about having read the sentence below it.
- **The grouped list is renumbered.** `sequenceNumber` is a dense display index
  and dropped rows have to be squeezed out of it, or the unread divider and the
  virtualizer key off positions that no longer exist.
- **Adding a first-party plugin is a decision about this map.** Ship it with a
  display name and it gets its own row; ship it without one and it joins Rally.
  Neither is wrong, but nothing else decides it.

## Boundary

This module owns the work-stream transcript's presentation of tool activity, and
nothing else. It reads the canonical snapshot and the live overlays; it writes
no state, requests nothing, and never changes what a run does.

It deliberately does **not** cover:

- **Nothing else.** The automation draft wizard's feed, which used to be a
  second adapter showing one row per tool call, is gone; an automation's chat
  is the same `SubstreamAgent` feed as a work stream's and collapses the same
  way (see [`conversation-surfaces.md`](conversation-surfaces.md)).
- **What the backend records.** Tool blocks, plugin activities, ids, and labels
  are [`workstream-durable-object.md`](workstream-durable-object.md)'s and
  [`agent-harness.md`](agent-harness.md)'s; this module adds nothing to the wire
  and asks for nothing new on it.
- **What `workSummary` means.** Whether a settled response total exists, and
  what it measures, is the authority's — this module only decides where it is
  printed once it has.
- **The run-level timer** at the foot of the transcript, and what a thinking
  row *is*. Both remain `AgentWorkTiming` with the thinking orb, and the
  transcript's thinking blocks and activities are the authority's, not this
  module's. What this module owns is how many of those rows a reader sees:
  `groupThinkingMessages` collapses a run of them the way the plugin rows are
  collapsed.
- **Colour and theme tokens**, which are [`theming.md`](theming.md)'s.

## Failure modes and limits

- **A plugin the transcript has not named yet** produces no row at all. This is
  the window between a tool block being planned and the call starting, which is
  sub-second, and the run's own timer is on screen throughout it.
- **A plugin activity that never arrives** leaves the group timed by its calls
  alone, which undercounts by the gaps between them. The row is still correct
  about which plugin worked and roughly how long for.
- **A live overlay row that outlives its canonical block** — a connector tool
  whose block has not landed — groups by display name, so it joins the same row
  its canonical replacement will. A first-party tool in that state carries no
  plugin information at all and is dropped until the block arrives.
- **A connector with no mark in the mapping** draws the generic plug. Nothing
  breaks; the row is just less recognizable until the mapping names it.
- **A failed tool call** is not marked. The row says how long the plugin worked
  and no more, which is what the per-plugin activity row said before this change
  too; a run's failures reach the reader through Rally's own words and the run
  failure notice.
- **A run that spans a stretch of transcript this client has not loaded** is
  cut at the seam, so a reader can see two rows where one session had one run.
  That is deliberate and is the safe direction: the turn that would have ended
  the run may be in the part nobody loaded, and joining across it would report
  work as one stretch that a sentence from Rally had in fact separated. Loading
  the gap closes it and the two rows become one, which is a **remount**, not
  just a row disappearing: the surviving row takes the earlier thought's id.
- **A collapsed thinking total is a sum over rows**, and each row's duration is
  its whole activity's. It stays honest only while a turn contributes one
  thinking block, which is what the authority writes today — one block per
  assistant turn, pointed at that turn's own thinking activity. A second block
  on one turn would resolve to the same activity and be counted twice, as one
  row quietly doubled rather than two rows visibly repeating a number. Whoever
  projects thinking per attempt or per segment has to key the sum on the
  activity instead.
- **A response the client holds only part of** collapses each stretch it can see,
  and none of those drawers takes the response's total — the total stays in the
  header until the gap is filled, at which point the drawers are recounted and
  one may take it. That is the safe direction: a number covering the whole
  response is never printed over a drawer that cannot account for it. Each
  drawer still reports its own stretch, which is a fact about the rows inside it
  and stays true however much of the response was never loaded.
- **A response whose settled total never found a host answer** never resets the
  count, so every later response in that window keeps its total in the header
  rather than on its drawer. Nothing is wrong on screen — the header is where a
  total is always correct — but the drawers stop taking one until a total lands
  on an answer again. Scoping the count to a real response identity, if the
  projection ever carries one into this pass, would fix it.
- **A stretch whose response total never arrived** still collapses, and reports
  the union of its own rows' spans. Where those rows cannot say when they worked
  the drawer reads a plain "Worked": the rows are behind the answer that
  reported on them either way, and summing durations to invent a number would
  report a figure the transcript never established.
- **A stretch's own total is the union of its rows, not of the turns they came
  from**, so work that produced no row at all — a plugin whose id resolves to no
  group, a turn whose activity never reached this client — is missing from it.
  The drawer is then honest about the rows it can show and quiet about the rest,
  which is the direction that never claims time a reader cannot open and see.
  An interval the authority closed without recording a duration is unmeasurable
  for the same reason, timestamps or not: `activityDuration` already counts it
  as nothing, so a span read off its boundaries would put time in the drawer
  that no row inside can account for.
  Spans reach the client through the activity tree, whose joins are the nullable
  ones [`pluginRuns`](#where-the-code-lives) exists to stop depending on; a run
  the tree never reached has a duration but no spans, and one such row in a
  stretch is what makes the whole drawer read "Worked". Resolving spans
  server-side, on `TranscriptPluginRun` beside the duration, is the fix if that
  turns out to be common.
- **Work that trails an answer with no answer of its own after it** stays in the
  feed as it was. Nothing has reported on it, so there is nothing to fold it
  behind — which is also what keeps a live run's rows on screen.
- **A reader who opens an accordion and scrolls away** keeps it open, because
  the flag lives in `MessageFeed`. It lasts until that component actually
  unmounts, which is *not* every navigation: `WorkstreamScreen` stays mounted
  across work streams and its `MessageFeed` is not keyed by work stream, so a
  drawer opened here is still open on coming back to the same work stream. The
  set is keyed on message ids, which are unique across work streams, so what it
  retains is inert everywhere else. This is the lifetime the clamped system rows
  already had; sharing the set did not change it.
- No caps, quotas, or timeouts: the whole module is a pure function over a list
  that is already bounded by the transcript's own paging.

## Testing

| Suite | Command | What it proves |
| --- | --- | --- |
| `lib/plugin-groups.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/plugin-groups.test.ts` | The map: the two virtual groups, the unnamed-first-party fallback, name keying across the two id families, every glyph, and that no shipped connector still draws the plug. |
| `lib/plugin-marks.test.ts` | same, `src/renderer/lib/plugin-marks.test.ts` | The marks: the monochrome variant asked for wherever a brand ships one, and one distinct mark per brand. |
| `lib/transcript.test.ts` | same, `src/renderer/lib/transcript.test.ts` | Grouping over a composed feed: position, run boundaries, which timing wins, dropped rows, renumbering. Collapsing thinking: the summed run, the run boundary, the response total left out of it, the unknown segment, and the concurrent starts. Closing a reported-on stretch: what goes in the drawer, every stretch of a self-narrating run folding rather than only the last, the total moving out of the header and staying there when the response produced several drawers, the settled-total response boundary and a steer not being one, the two seam checks, a partially loaded response withholding its total until the next settled total, a stretch held open by a live timer or by a plugin run still marked active and closing once it settles, a final answer that folds nothing keeping its total in the header, and the derived id. A stretch's own total: the union of its rows' spans rather than the sum of their durations, the response total still winning where the drawer is the whole response, an upper-bound row making the stretch one, a row that cannot say when it worked making the drawer say nothing, and the spans surviving both grouping passes. |
| `components/workstream-blocks.test.tsx` | same, `src/renderer/components/workstream-blocks.test.tsx` | The row: its wording in both tenses, its stable accessible name while the number ticks, the pulsing mark, the absent orb, and the thinking row's brain. The accordion: closed and open, the unknown and recovered totals, and the open flag taken from the feed. |
| `screens/workspace-settings.test.tsx` | same, `src/renderer/screens/workspace-settings.test.tsx` | Settings: an installed row and the provider card it came from carrying the same mark, and a webhook carrying none. |

The trap is the elapsed-time format: `formatDuration` zero-pads the seconds of a
minute, so the string is `4m 02s`, not `4m 2s`.

A change here is visible, so it also needs a real window —
[`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it). A local
stack cannot run a real turn, so the way to get a multi-plugin transcript on
screen is to write a hand-built `WorkstreamTranscriptSnapshot` into the
renderer's `['ordered-transcript', <id>]` query, which exercises the whole
projection, composition, grouping, and render path from real inputs.

## Changelog

### 2026-09-10 — The Sidekicks plugin's canonical id is `rally:sidekicks`

**What changed:** `GROUPED_PLUGIN_IDS` pins the keyframes glyph to
`rally:sidekicks`, and keeps the `rally:automations` entry beside it for the
rows transcripts recorded under the old id. The row's key is still
`name:Automations`, which is the group's name rather than the plugin's display
name, so old and new rows merge on it the way every other row does.

**Why:** The canonical id was renamed with the rest of the Sidekick vocabulary
([`automation-lifecycle.md`](automation-lifecycle.md#2026-09-10--the-stored-names-follow-the-model-facing-ones)),
and a stored row is not rewritten: dropping the old id from the map would have
turned every earlier Sidekick row back into the generic plug.

### 2026-09-10 — The connector fill tokens are gone

**What changed:** The sixteen `cmp.connector.*` background and foreground
tokens that the "Tool calls collapse into one row per plugin" entry left
declared are removed from the registry.

**Why:** That entry kept them because the vocabulary was still a valid one for
a connector chip elsewhere. No chip arrived, and the token set now holds the
line that every declared token has a reader (`themes.css.node.test.ts`), which
a vocabulary held in reserve cannot pass. A chip that wants a connector's
colour adds the tokens back in the same change as the rule that reads them;
[`theming.md`](theming.md) records the removal.

### 2026-09-10 — The row's label opens with a capital

**What changed:** `AgentWorkTiming` sentence-cases the label it prints, so a
thought row reads "Thought for 7s" and "Thinking for 7s" where it read "thought
for 7s", and the response's own live total reads "Working for 8s". The plugin
rows are unchanged, because their verbs were already written that way.

**Why:** the thought rows were the only ones in the column starting lowercase.
Under a header reading "Worked for 8s" and beside "Used Slack for 5s", a
lowercase "thought for 7s" reads as a fragment of some other sentence rather
than as the row's own line — the capitalization was carrying a distinction
between the rows that does not exist.

The fix belongs in the component and not in the projection, which is the part a
future change has to respect: `activeVerb` is not only wording. `isThinkingEvent`
and `foldSettledWorkIntoMessages` compare it against `'thinking'` and
`'working'` to decide which of the two thought rows they are looking at, and
`ThoughtBlock` reads the same field to choose the brain over the orb — all three
returning the wrong row silently rather than failing, as the brain entry below
already warns. Capitalizing the verbs where they are produced would have made a
row's appearance and its identity the same string to keep in step, so a later
wording change would have quietly moved rows between scopes. The component owns
the sentence it prints, so it is where the sentence is shaped, and
already-capitalized verbs pass through untouched.

**Considered and rejected:** `text-transform: capitalize` in the stylesheet,
which capitalizes every word ("Used Slack For 5s") and leaves the accessible
name of a settled row — the same string — lowercase. Also a `::first-letter`
rule, which fixes what is seen and not what is read aloud.

**Consequences:** the casing covers the rows only. The message header and the
accordion toggle are `workSummaryLabel`'s own sentence, which hard-codes
"Worked" because it deliberately ignores the row's verb; the two agree today,
and a header that ever took a verb from a row is the change that has to
reconcile them. A row whose duration is unknown now reads as the bare
capitalized verb — a thinking row renders "Thought" beside its brain — which is
a noun as readily as a past tense. No producer emits a null duration today.

Shipped in #647.

### 2026-09-09 — A drawer reports its own stretch, from when its rows worked

**What changed:** every machinery row now carries `workSpans` — the wall-clock
stretches the activity that measured it occupied — through both grouping passes,
and `collapseSettledWorkIntoAccordion` labels a drawer that does not take the
response's total with `foldedStretchTotal`: the union of the spans of the rows
inside it. A self-narrating response's drawers therefore read "Worked for 15s"
and "Worked for 9s" instead of two identical "Worked"s, while the response's own
"Worked for 1m 24s" stays in the final answer's header.

**Why:** the drawers said nothing about what was behind them. A reader deciding
whether to open one had the chevron and the word "Worked", which is the same
thing every other drawer said, so the only way to find the stretch that took a
minute was to open all of them. The rule that produced that — a stretch not known
to be the whole response has no total — was right about durations and was read as
a rule about time in general: rows overlap, so a *sum* of them overstates the
stretch, and the response total was the only number anyone had.

Spans are what breaks the tie. The transcript already records when every activity
started and stopped; a union over those counts a second two rows shared exactly
once, so it can never overstate the drawer the way a sum does, and it needs no
authority beyond the intervals the snapshot already carries. The response total
still wins where the drawer is the whole response — it is the authority's own
measurement of that run, and the union is only as complete as the rows this
client happens to hold.

What a future change has to respect: **a drawer never prints a number it cannot
account for with the rows inside it.** One row that cannot say when it worked
makes the whole drawer read "Worked", for the same reason a thinking run with one
unmeasured segment reports no total rather than a shorter one — a union over the
rest is a number with a piece silently missing, presented as certain. Resist
filling that hole by falling back to a sum, to the response total, or to the
longest row.

Rejected: crediting each drawer with the assistant turns its rows came from,
which is authoritative and non-overlapping across turns but does not line up with
the drawers — a turn's thinking row sits above the answer it narrates while the
plugin row for the same turn sits below it, so the turn's duration would be
claimed by two drawers at once. Also rejected: adding the spans to
`TranscriptPluginRun` server-side in this change. It is the more robust source
and the reason `pluginRuns` exists at all — the activity tree reaches a snapshot
through the nullable joins that contract was written to stop depending on, and
this module's own `brokenJoinSnapshot` fixture is the shape where it does not
arrive. What makes the client-side read worth starting with is the cost of being
wrong: a run with no spans keeps its authoritative duration and its drawer says
what it said before, so the failure is the status quo rather than a wrong
number. Move it server-side when a drawer is seen reading "Worked" in the field.

Also rejected: two scalars per row and `max(end) − min(start)`, which would
delete `unionDurationMs` and about half of what this added. It is the same
number for the common shape and wrong for the one this feature exists to serve:
a stretch of a self-narrating response holds a thought and a call that ran after
it, and a start-to-end measure would count the handoff between them as work.

### 2026-09-03 — Every stretch of a run collapses, not just the last one

**What changed:** `collapseSettledWorkIntoAccordion` builds an accordion above
*every* agent answer that has machinery above it, instead of only above an answer
carrying a settled `workSummary`. The response's total still moves onto that
accordion when the response produced exactly one; where it produced several, the
total stays in the final answer's header and each drawer reads a plain "Worked".
The pass counts accordions per response and resets that count at anything that is
not the response's own work, and at the answer carrying the settled total — the
one signal in the feed saying a response is over.

**Why:** A long run narrates itself. It works, says what it found, works again,
says what that found — and the response timer settles once, at the very end. The
old trigger fired on that timer, so it folded the last stretch and left every
earlier one expanded above the sentence that had already summarized it. A
screenshot of a five-minute run was three stacks of spent timers with three
answers threaded between them, which is exactly the receipt this feature was
built to remove; it removed it only from the bottom of the transcript. An answer
is Rally's own report on the rows above it, so an answer arriving *is* the "that
stretch is done" signal, and it arrives once per stretch rather than once per
response.

**Considered and rejected:** collapsing only once every row of the *transcript*
reports itself settled — the whole feed waiting on the slowest thing in it. That
stays rejected: it closes nothing during a run, in the window between one plugin
finishing and the next starting, which is most of a run. What replaced it is the
narrower form, per stretch, which review forced and which is now the rule (see
the follow-up below).

Also rejected: printing the response total on the last of several accordions,
which is what the unchanged move-rule would have done. It would have labelled a
drawer holding 21s of rows "Worked for 3m 12s" — the total is one fact about the
whole response, and the last stretch is not the whole response. Summing the rows
in a stretch to give each drawer its own number stays rejected too, and for the
original reason: thinking overlaps plugin work, so a sum overstates by however
much ran concurrently.

**Three follow-ups in the same change, all from review.**

*A partly loaded response must not label a drawer.* Counting accordions is only a
proxy for "this drawer is the whole response", and the proxy fails across a seam:
a response whose earlier stretches were never loaded shows one accordion and
produced several, so the total landed on a drawer that could not account for it
and then jumped back to the header when the gap filled. A seam now marks the
response's coverage partial and withholds the total. The alternative — carrying a
real response identity through the projection so the count could be exact — buys
a better answer for a case that already renders honestly without it.

*A steer is not a response boundary.* The count reset at any row a person read,
which is wrong for the one case that matters: a steer is committed as its own
canonical turn between two answers of a single response, while the response
activity spans both sides of it, so the stretch after the steer took a total
covering the work before it too. The settled response total is now the only
boundary, which is the one signal in the feed that actually means "this response
is over". The cost is named under **Failure modes**: an orphaned total no longer
resets anything, so later responses keep their totals in the header — the safe
direction, and the same thing a response identity would fix.

*Live work must not be folded away, and position does not prove it isn't.* The
first version leaned on the projection positioning a response's own timer after
every block of its last turn — true of canonical rows, and not true once a
streaming answer overlay is inserted at `transcriptSequence - 1`, which puts an
answer *below* a still-running timer and folded that timer into a closed drawer.
Review raised the same doubt from the other end: a plugin run is anchored at its
own last call inside `run.turnId`, so one still reading `active` sits above an
answer arriving in the next turn, and its pulsing mark went into the drawer too.
The invariant is now stated directly: every row of a stretch is asked whether it
still reports live work, and one that does holds the stretch open. This is the
narrow, per-stretch form of what the original entry rejected as a whole-feed
rule, and it costs nothing during a run because the stretch a reader is watching
is the one with no answer under it yet.

**What a future change has to respect:** the collapse boundary is still the run
boundary the two grouping passes use, checked at both ends for the unloaded-island
seam — an accordion must never reach past a sentence or across a gap, and must
never print a total for work it cannot show. The
response total is still printed in exactly one place, and is still never computed
from the rows inside a drawer. And nothing a reader is still watching may be
folded away: if a future projection ever positions the response's live timer
above an answer, this pass will swallow it, and the trigger will need a
still-running guard that the feed's shape makes unnecessary today.

### 2026-09-02 — The accordion's chevron hangs in the margin, not inside the column

**What changed:** `.work-accordion-chevron` is absolutely positioned at
`left: -20px` on a `position: relative` toggle, instead of taking
`.plugin-face`'s 20px box and the timing row's 7px gap in flow. The total now
starts on the transcript's own left edge — level with the author line and the
answer's paragraphs — and the chevron is the only thing outside that edge.

**Why:** In flow, the chevron and the gap pushed the total 27px inside the edge
every other row in the column starts at, so the closed row read as one that had
drifted rather than one hung off the column. A gutter is the margin *outside*
the text, which is what the heading collapse does and what this now does.

**Considered and rejected:** Keeping the in-flow version because it put the
chevron within three pixels of the heading chevrons below it. That alignment was
real but it is not what a reader sees: a heading's text is itself indented 20px
inside the body, so its chevron lands at the body edge, while this row's text
*is* the body edge. Matching the chevrons meant mismatching the text, and the
text is the thing a column is read down.

**Also:** the heading collapse moved its own gutter from padding to margin in
the same change ([`markdown-rendering.md`](markdown-rendering.md)), because the
padding had been indenting the whole answer. The two chevrons now sit at the
same x, which is what they were always meant to do — matching them by moving
this one *into* the column had matched the glyphs by mismatching the text.

**What a future change has to respect:** the two chevrons share one horizontal
offset, a flat `left: -20px` in both rules, and they are meant to line up — so
an alignment change has to move both or it breaks the thing this entry exists
to establish. Only their vertical boxes differ, the heading's sized in `em`
against a heading's line and this one's against a fixed 20px row. And the
chevron sits outside the content column, so the transcript's left padding is
now load-bearing: it has to clear the 20px outdent *plus* the 3px a focused
heading chevron's ring reaches beyond its own box, and `.transcript-scroll` is
`overflow-x: hidden`, so anything less is cut off rather than scrolled to. The
`max-width: 760px` override was 18px and had to be raised to 24px in this
change for exactly that reason — review caught it clipping 2px off both
chevrons and 5px off the focus ring.

### 2026-09-02 — A finished run closes behind its own total

**What changed:** `collapseSettledWorkIntoAccordion` is a fourth pass in
`workstream.tsx`'s pipeline, after `foldSettledWorkIntoMessages`. Once a turn's
response timer has settled, the plugin and thinking rows immediately above that
turn's answer fold into one `work_accordion` row — "Worked for 41m 17s" behind
the markdown headings' own collapse chevron, outdented into the transcript's
gutter — sitting where the run's first row sat, holding those rows in
`workAccordion.rows` and drawing them through `PluginActivityBlock` and
`ThoughtBlock` when a reader opens it. The total it prints is the answer's
`workSummary`, taken off the message rather than copied, so the header prints it
only for a turn that reached for nothing. `SystemRowDisclosure` is now
`RowDisclosure` and `MessageFeed` holds one open-row set for both kinds of
collapsible row.

**Why:** The rows are progress, and progress deserves a line each — while the
loop runs. When it finishes they stop being progress: four spent timers stacked
above an answer say, between them, what the response's own total already says on
the line below. A reader coming back to a settled turn wants the answer, and was
being given a machinery report to scroll past first; the breakdown is still one
click away for the times they want it.

**Considered and rejected:** Keeping the total in the message header *and*
labelling the accordion with it. It is the same duration twice, a line apart,
with nothing to distinguish the two — the reader has to work out that they are
one fact, and the moment they ever disagree the feed is lying twice. Moving it
makes the accordion the receipt and the header what it was before the total
landed there.

Also rejected: computing the accordion's label by summing the rows it holds,
which would have let a run with no response total collapse too. The rows overlap
— the model reasons between calls, and a plugin's activity covers the gaps
between its own — so the sum overstates the run by whatever ran concurrently.
A run whose total never arrived stays expanded instead.

Also rejected: leaving the collapsed rows in the feed and hiding them with CSS.
The transcript is virtualized: hidden rows still cost one measured item each,
and opening a drawer would grow N items whose heights the size cache has to be
told about separately. Nesting them makes an accordion one row, one measurement,
and one thing for `RowDisclosure` to remember.

Also rejected: a chevron of this row's own, inline after the total. The reader
meets two collapses within a few pixels of each other — this one and the
heading sections of the answer under it — and drawing them differently makes
them read as unrelated affordances. The horizontal offset is copied exactly —
a flat `left: -20px`, the same declaration the heading uses. Only the vertical
box is this row's own: the heading sizes its against a heading's line in `em`,
and this row's line is a fixed 20px.

**What a future change has to respect:** the collapse keys on the settled
response total and nothing else — that is the loop's completion signal, and a
proxy for it (every row inside reporting settled, say) closes the drawer
mid-run, in the window between one plugin finishing and the next starting. And a
settled total stays printed in exactly one place: adding a second is how the
same fact starts competing with itself again.

### 2026-09-02 — Multimodal generation gets a media-specific glyph

**What changed:** The `rally:multimodal-generation` activity row now draws
Tabler's `image-generation` icon instead of the generic plug fallback. The
canonical plugin id selects a dedicated group, so its icon does not depend on a
display-name heuristic.

**Why:** A plug communicates an unspecified integration, while this first-party
plugin performs a specific, recognizable media-generation task. Its activity
row should identify that task at a glance.

**Considered and rejected:** Lucide's `pencil-ruler` icon, because the
unbranded plugin glyph table on this surface uses Tabler icons. Also rejected
matching only the display name, which would make first-party presentation
depend on mutable prose instead of the plugin's stable identity.

**Consequences:** The generic plug remains the fallback for unknown connectors.
Future multimodal display-name changes retain the media glyph as long as the
canonical plugin id remains `rally:multimodal-generation`.

### 2026-09-02 — The thinking row wears a brain

**What changed:** `ThoughtBlock` passes a `ThinkingGlyph` — Tabler's `IconBrain`
in the plugin marks' own `.plugin-face` box, pulsing through `.plugin-face-active`
while the row runs — into `AgentWorkTiming`'s `icon` slot for a thinking row.
The response's overall "working / worked" row, which the same block draws, keeps
the `ThinkingOrb`.

**Why:** Every other row in that column names the place the work happened
through a mark, and the thinking row was the one that did not: the orb said only
that something was running, which the shimmering label beside it already said.
A brain names reasoning the way the Slack mark names Slack, so the column reads
as one vocabulary rather than a set of marks plus a spinner.

**Considered and rejected:** Giving both thought rows the brain, which is the
whole of `ThoughtBlock` and needs no verb check. The other row is the response's
total — tool calls, waiting, and thinking together — and a brain would claim it
was all reasoning. The verb is already how this block, `groupThinkingMessages`,
and `foldSettledWorkIntoMessages` each tell the two apart, so the check adds no
new way for them to disagree. Also rejected: a `.thinking-face` class of its
own. It would have restated `.plugin-face` verbatim, and the two would drift the
first time the column's size or neutral changed.

**What a future change has to respect:** the brain rides on the row's
`activeVerb` being `thinking`. A projection that renames that verb silently
returns this row to the orb rather than failing, so the verb, the fold, and the
collapse move together — which is why the comparison is `isThinkingEvent` in
`transcript.ts` rather than a third copy of the string in the renderer. The fold
still names `'working'` outright: not-thinking is a wider set than the
response's own total, and a scope added later must not reach a message header
just because it is not reasoning.

### 2026-09-02 — A run of thinking is one row

**What changed:** `groupThinkingMessages` collapses a run of thinking rows into
one, summing their durations, over the same run boundary the plugin grouping
uses. The row reads "thinking for …" while any segment is still going and
"thought for …" once they have all settled. `ThoughtEventData.monotonicStartedAt`
widened to a list to carry every still-running segment, the way
`PluginActivityData`'s already does.

**Why:** The model thinks between every pair of tool calls, so a real run
reached the feed as one grouped plugin row followed by four spent timers —
"thought for 29s / thought for 38s / thought for 17s / thought for 14s" — each
of them true and none of them the thing a reader wanted, which is that Rally
reasoned and for how long. It is the same complaint the per-call tool rows
answered, one row type later: the feed's machinery should say what happened, not
enumerate the steps it took. Collapsing to a total also stops the row count
scaling with how many tools a run happened to call.

**Considered and rejected:** Collapsing only strictly adjacent thinking rows.
It handles the screenshot that prompted this and nothing else — a run that
alternates between two plugins puts a group row between two thoughts and would
have left them apart, which is the arrangement that produces the most rows in
the first place. Reusing `continuesPluginActivityRun` means one definition of a
run for both passes, so the two collapses can never disagree about where a run
ended. Also rejected: folding a turn's thinking into the response's own timer,
which would make the header the only place reasoning appeared and erase the
progress a reader watches during a live run — the same trade the 2026-08-29
entry rejected in the other direction.

**Found in review, and fixed here:** a run could cross a stretch of transcript
this client had not loaded. `orderedTranscriptMessages` flattens every range of
a snapshot into one list, and a snapshot's coverage is not one interval — the
opening one carries an unread island and a separate latest island whenever the
unread anchor is away from the tail, which is the ordinary case for someone
returning to a busy work stream. The two rows either side of that seam look
adjacent and are not, so a run joined work across turns nobody had seen — a
sentence from Rally among them, which is exactly what is supposed to end a run.
A three-island fixture summed 29s + 38s + 17s into one 1m 24s row that stood for
two unrelated stretches. The projection now marks the first row after a gap with
`precededByTranscriptGap`, computed from the snapshot's own coverage, and both
passes close their run on it. **This was already true of the plugin grouping**,
which has flattened the same list since it shipped; fixing only the new pass
would have left the two disagreeing about where a run ends, which is the one
thing sharing `continuesPluginActivityRun` exists to prevent.

A jump in `transcriptSequence` was rejected as the signal. It is derivable from
the rows alone and needs no new field, but it cannot tell a turn the client did
not load from a sequence the transcript never assigned, so it would cut runs
that are genuinely contiguous. Coverage is what the snapshot actually states.

**Consequences:** A thought row can now stand for several activities, so
anything reading a duration off one is reading a run's total rather than one
segment's, and `monotonicStartedAt` on it may be a list. The response-scope row
is told apart by its verb — `activeVerb === 'thinking'` is a turn's own
reasoning — so a future scope that reuses either verb joins whichever collapse
that verb names. Any future pass that reasons about a run of adjacent rows owes
the same `precededByTranscriptGap` check; `continuesPluginActivityRun` answers
what a row *is*, not whether the row before it is really the row before it.

### 2026-08-30 — Multimodal generation keeps a named plugin row

**What changed:** The new `rally:multimodal-generation` plugin deliberately
uses the existing named-first-party fallback, producing its own Multimodal
generation row with the plug glyph. The mapping test pins that decision.

**Why:** Media generation is recognizable work with provider-scale latency; a
person should be able to distinguish it from Rally's internal reasoning and
from a Terminal session while it runs.

**Considered and rejected:** Folding it into Rally, which would hide the useful
latency boundary, and folding it into Computer, which currently means a
stateful workstream/Terminal machine surface rather than a hosted model call.

**Consequences:** Giving the plugin a dedicated media glyph later is a visible
design change in `plugin-groups.ts`; until then the generic plug is intentional,
not an unhandled connector mark.

### 2026-08-30 — The two run sources compose instead of one shadowing the other

**What changed:** The client no longer chooses between the snapshot's
`pluginRuns` and the activity tree. `pluginRunsFromActivities` derives runs from
the tree and `resolvePluginRuns` overlays them onto the server's, per run,
keeping the server's `toolCallIds` when the tree reports none. `pluginRuns` now
also travels on a `TranscriptRangeResult`, survives `mergeTranscriptRange`, and
is retained for the turns a `mergeCanonicalTranscriptSnapshot` keeps. The
separate activity-tree emission loop is gone; derivation replaced it.

**Why:** Review found two holes in the first cut, both created by making a
non-empty `pluginRuns` suppress the fallback wholesale. A plugin active when the
snapshot was taken completes over the socket as a `transcript_activity_upserted`
frame, which `mergeRealtimeTranscriptActivity` applies to `activities` only — so
its run stayed `active` and its timer ran forever. And the server resolved runs
only for opening and active turns, so history paged in later arrived with none;
because any run anywhere disabled the fallback, those older turns lost their
duration or their row entirely. The first cut turned a bug that showed a wrong
number into one that showed a number climbing without end.

The fix is not a third code path but the removal of the choice. The snapshot's
run is the one that exists when the tree cannot reach the activity — the case
this contract was built for — and the tree is the one realtime keeps current.
Neither is authoritative alone, so both are read and the fresher field wins.

**Considered and rejected:** Patching `mergeRealtimeTranscriptActivity` to
rewrite the matching run. It fixes the ticking timer and nothing else: a plugin
that starts after the snapshot still has no run to rewrite, and paged history
still arrives with none. Deriving at render time covers all three because it
reads whatever the tree currently holds.

**Consequences:** `toolCallIds` is the one field where empty means "not known"
rather than "none", because it is what positions the row; a run with none falls
back to matching a tool block's `pluginId`, which is how positioning worked
before runs existed and is why a tree carrying no `tool_call` activities still
produces a row. Any new path that adds turns to a snapshot has to carry their
runs too — ranges and reconciliation both do now, and a test pins each.

### 2026-08-29 — The server says which plugin ran and for how long, and Rally works while everything else is used

**What changed:** `WorkstreamTranscriptSnapshot` gained `pluginRuns`: per plugin
per turn, its display name, state, duration, timing accuracy and tool call ids,
built by `pluginRunsForTurns` in the transcript storage. The renderer builds its
rows from that and joins tool blocks to runs on `toolCallIds`. `durationMs` is
nullable end to end, and an unknown duration renders as no duration. The
activity-tree derivation is kept only as a fallback for an API that predates the
field.

A group also carries its own `activeVerb` and `completedVerb`. Rally reads
"Rally is working" / "Rally worked"; every other plugin reads "Using Slack" /
"Used Slack"; the Computer group reads "Using a computer" / "Used a computer". A
settled response total moves out of the feed into the header of the message it
produced, via `foldSettledWorkIntoMessages`.

**Why:** A grouped row rendered `Rally worked for 0ms` for runs that really
worked — one production run logged `tool_calls=2` and `tool_time_ms=6770` while
the feed reported nothing. The renderer was never *told* which plugin owned
which call; it rebuilt that from three separately-derived id families, over a
snapshot that only carried activities reachable by an upward walk seeded from
`turn.activity_id` and `block.activity_id`. Both columns are nullable — the
development-seeded tool turn leaves both NULL — so for a settled run in that
state the plugin and tool_call activities never reached the client at all.

Every one of those failures produced the same number, because `activityDuration`
sums `durationMs ?? elapsedMsAtSnapshot ?? 0`. A missing activity, an
unreachable one, and an interval closed without a duration all read as zero, so
the client could not tell "took no time" from "I cannot see the timing" and
rendered the second as the first. That is what made the bug a confident
falsehood rather than a gap, and it is why the nullable duration matters as much
as the new field: even if some upstream join still misses, the row now says
nothing rather than something false.

"Slack worked for 5s" makes the connector the actor, which it is not — Rally
decided to call it. Naming the agent as the subject everywhere would be worse,
because "Rally worked" is then indistinguishable from the response-level total.
So the agent keeps the working voice and the tools take the used voice, which
also reads as what a person would say about their own work. Computer is the only
group named with a common noun, so it is the only one needing an article; every
connector is a proper name and takes none.

The response total moved because it stops being progress the moment it settles.
Left in the feed it is a spent timer sitting under the answer, which reads like
another step still to come; in the header it sits with the rest of that
message's provenance, beside the author and the time.

**Considered and rejected:** Putting `pluginRunId` and a resolved duration on
the tool block instead. It needs no new array, but a plugin's total spans
several blocks, so the number would be duplicated across them and a reader would
have to know which copy was authoritative. Also rejected: making `pluginRuns`
required. A desktop build updates on its own schedule and has to parse a
snapshot from an older API, so the field is defaulted and an empty array means
"this server does not report runs" rather than "no plugin ran".

Deriving the phrasing in the component from the group's name and a boolean. It
puts a grammar rule in the renderer, and the article case would have been a name
comparison against "Computer" — a string match that breaks the day the group is
renamed. Also rejected: folding a turn's *thinking* row into the header too.
Thinking annotates one step inside a run and several belong to a single message;
only the response's own total is a fact about the finished message.

**Consequences:** The plugin↔tool relationship is the authority's to state, and
a client that recomputes it has reintroduced this defect. `pluginRunsForTurns`
must keep seeding from the turn's own id and walking *down*; a workers test pins
that a turn whose blocks carry no `activityId` still reports its runs, and it
fails if the seed goes back to `turn.activityId`. Anywhere a duration is summed,
one unknown contribution makes the total unknown rather than smaller — adding
only the parts that reported understates the work by exactly the part that did
not, and presents the shortfall as certain. The legacy fallback can be deleted
once no deployed API omits `pluginRuns`.

A new group decides its own phrasing, and a group whose name is a common noun
needs the article written into its verbs. A message can now carry `workSummary`,
and the header renders it; a surface that shows agent messages without that
header will drop the total silently.

### 2026-08-29 — Marks come from `@thesvg/react`, one subpath at a time

**What changed:** The brand marks moved from the `thesvg` string package, drawn
as CSS masks, to `@thesvg/react` components imported one subpath at a time. A
lint rule bans the barrel form, and
[`using-company-brand-icons.md`](using-company-brand-icons.md) is the note that
now owns the subject.

**Why:** The string package's per-icon declaration imports a type from its own
index, so eight icon imports pulled **all ~6,500 brand declarations** into the
TypeScript program — the desktop renderer went from 575 files to 7,095, 92% of
them icon types. Type-aware linting held that program per worker, and a cold
`pnpm lint` on CI died with `JavaScript heap out of memory`. It passed locally
only because `pnpm lint` caches and CI runs cold, which is the divergence
`AGENTS.md` warns about. Lint no longer builds that program — `projectService` is
scoped to `apps/api/src`, see
[dev-environment.md](dev-environment.md#what-pnpm-lint-costs-in-memory) — so the
barrel is a `pnpm typecheck` and editor cost now rather than a lint one. The rule
stands either way. The `@thesvg/react` per-icon declarations import only
from `react`: the program is 583 files again.

**Considered and rejected:** Keeping the mask and vendoring the eight SVGs into
the repository, which also removes the type cost. It loses the reason to have
the package at all — the next connector's mark being free — and puts artwork in
the tree that nobody would remember to update. Also rejected: rendering the
`default` variant for every brand, which avoids the SVG `<title>` the `mono` art
carries. Google's default art has 19 element ids and 18 `url(#…)` references and
two Google cards share the Settings page, so that trades a title for duplicated
ids; the title is handled instead, by ignoring it in text queries and killing
its tooltip.

**Consequences:** A barrel import of `@thesvg/react`, `@thesvg/icons`, or
`thesvg` is a lint error, because the cost is invisible to the person who writes
it. `PLUGIN_BRAND_MARKS` now records which brands ship `mono` art, so a brand
that gains or loses it upstream fails the table rather than the render.
`dangerouslySetInnerHTML` is no longer even a question here — the components
build real elements — but it stays absent from this renderer. The renderer's
test setup ignores `title` in text queries; a component that puts real page text
in one would now be missed.

Shipped in #412.

### 2026-08-29 — A grouped row times every plugin running in it at once

**What changed:** `monotonicStartedAt` became a list, on `PluginActivityData` and
on `AgentWorkTiming`. A grouped row now advances by the elapsed time of every
contribution still running rather than by the last one the grouping pass saw.

**Why:** Bind executes a batch's non-activation tool calls concurrently, pooled
per tool name, so `rally:memory` and `rally:tables` in one model turn are two
plugin activities active at the same instant — and both land in the Rally row,
whose completed total sums them. Keeping one start advanced the live number at
half the rate its own total was accruing, so the row ticked up slowly and then
jumped to the real figure the moment both activities settled. Found by Codex's
review on the pull request and confirmed against Bind's tool loop, which
documents the concurrent pool.

**Considered and rejected:** Making the group's duration wall-clock — the union
of its activities' intervals rather than their sum — which is arguably the more
truthful number, since summing overlapping work reports more time than the
reader watched pass. It was rejected here for scope and risk, not merit: the
union needs interval data this projection deliberately reduces to a scalar, and
the only interval bounds available are server UTC timestamps, which is exactly
the clock-skew coupling `activityTiming` avoids by working from elapsed
durations. The sum is also what the per-plugin rows this feature replaced showed
between them. Worth revisiting as its own change.

**Consequences:** A caller passing a freshly built array must not put it in an
effect's dependencies — `AgentWorkTiming` keys its interval on the starts'
values for that reason. The row can still report more time than the run's own
timer when plugins in one group overlap; that is the sum semantics above, not a
regression, and it is what the rejected alternative would address.

Shipped in #412.

### 2026-08-29 — A connector's mark belongs to the connector, so Settings wears it too

**What changed:** `connectorBrandMark` maps a connector's own type to its mark,
and every surface that draws a connector now goes through it — the transcript
row, Settings' provider cards, and Settings' installed-connection rows, which
had no mark at all. `ConnectorMark` in `primitives.tsx` is the one component
that paints one.

**Why:** The marks arrived attached to the transcript feed rather than to the
connector, which meant Settings kept its own hardcoded Lucide glyphs and the same
company looked like two things: GitHub was a `GitBranch` on one screen and the
octocat on another, and Granola and Notion shared a single `FileText`. A person
connecting Slack from a provider card and then finding it in a row should see
the same company both times. Attaching the mark to the connector type is also
what makes adding a connector one edit instead of three.

**Considered and rejected:** Keying the shared table on the plugin display name,
which is what the transcript already had. Settings holds a connector type and
never sees the plugin's display name, so that would have made the surface with
the *better* identity translate down to the weaker one. It is now the other way
round: the type is the key, and the transcript — the only caller without one —
recovers it from the name first. Also rejected: giving Settings' provider cards
the transcript's bare treatment. That card is a control somebody clicks and its
tinted chip is deliberate; only the glyph inside it changed.

**Consequences:** Adding a connector means adding it to `connectorBrandMark`;
a surface that hardcodes a glyph for one has reintroduced the split this entry
closed. The two routes into the table — by type, by display name — are pinned
together by a per-connector test, because a table reached two ways can disagree
with itself. Six Lucide icons left `workspace-settings.tsx` with the catalog
entries that used them. An inbound webhook is not a company and deliberately
draws nothing rather than a placeholder; a row's status dot and name carry it.

Shipped in #412.

### 2026-08-29 — Company marks come from `thesvg`, drawn as masks

**What changed:** Every connector now draws its own company mark instead of a
Tabler approximation, taken from the `thesvg` package and painted as a CSS mask
in the row's own colour. Granola and X had no mark at all and drew the generic
plug; Linear drew a generic stack. The backend's icon names are translated into
this renderer's own vocabulary rather than the enum being widened.

**Why:** The row exists to tell a reader *where* Rally is working, and a plug is
the one glyph that says nothing. Two of the eight connectors drew one, because
the shared icon enum has no name for Granola or X and Tabler ships no glyph for
Granola or Linear. `thesvg` has all eight, and its 6,500 marks mean the next
connector needs no artwork decision at all.

**Considered and rejected:** Rendering the package's SVG strings with
`dangerouslySetInnerHTML`, which is what its own documentation shows. These
strings are build-time constants so the injection is safe here — but the
renderer has no other use of it, and the pattern that gets copied out of this
module would not be constant. A mask cannot carry markup into the document.
Also rejected: drawing the marks in their brand colours. It was built and looked
at side by side, and it fails on its own terms — X and Notion are near-black and
disappear on a dark theme, Granola's is near-black and disappears on a light one,
and only some brands ship the light/dark art that would fix it. The masked
neutral is legible in both appearances with no appearance-specific artwork.

**Consequences:** `PluginGroupIcon` is now the renderer's own vocabulary rather
than the contract's, so a surface that carries `AutomationPluginIcon` must go
through `pluginGroupIconForContract`. A brand mark can never be drawn in colour
without abandoning the mask, which would also reintroduce the injection
question. `--plugin-mark` carries artwork rather than a colour and is listed as
runtime-set in the theme-token test, which would otherwise reject it. `thesvg`
tree-shakes through its subpath exports — only the eight imported brands reach
the bundle, about 10 kB — so importing a ninth is cheap, but a barrel
`import { … } from 'thesvg'` would pull all 6,500 in. Granola's entry is marked
`brand-use` rather than an open licence, meaning it is the company's mark shown
under its own guidelines; identifying a connector by its logo is the ordinary
use, but it is not a public-domain asset to reuse elsewhere.

Shipped in #412.

### 2026-08-29 — Tool calls collapse into one row per plugin

**What changed:** The work-stream transcript no longer shows a row per tool call.
Each plugin gets one row per uninterrupted stretch of agent activity, named for
the plugin and timed for as long as it worked, with its mark pulsing while it is
still going. Rally's five workspace plugins share a **Rally** row and its two
machine plugins share a **Computer** row. Plugin marks everywhere lost their
chips.

**Why:** A single run put a dozen rows like `table_insert_rows` and
`workstream_cancel_wakeup` between a person's question and Rally's answer. None
of it means anything to the people this product is for, and all of it buried the
conversation it belonged to — while the thing they do want from a run in
progress, *where is it working and is it stuck*, was the one thing the list did
not say. The per-plugin timing row that already existed said exactly that, so
this promotes it and drops what it was annotating. Grouping Rally's own five
plugins together is the same judgement one level down: `rally:memory` and
`rally.skills` are one actor as far as a reader is concerned, and the transcript
was printing their raw ids because they have no display names.

**Considered and rejected:** Keeping the calls behind a disclosure on each group
row. It preserves a debugging surface, but it also keeps the virtualizer's
open-row state problem, and the calls are already recoverable from the run's
archived inference ([`runbook.md`](runbook.md#inspecting-a-runs-raw-inference))
by the only people who would open them. Also rejected: grouping across a whole
agent loop regardless of what Rally says in the middle of it — the row's position
would then contradict the sentences printed after it.

**Consequences:** The feed is now lossy about individual calls by design, so
anything a reader must not miss cannot rely on a tool row to carry it — a failed
call in particular is now invisible in the transcript, which is the same as the
per-plugin activity row before it and is accepted. Adding a first-party plugin
is now a decision about `GROUPED_PLUGIN_IDS`: with a display name it gets its own
row, without one it joins Rally. Connector rows key on display name, so renaming
a connector splits its row for the length of one run. The `--av-cmp-connector-*`
background and foreground tokens are no longer referenced by any rule; they are
left declared because the vocabulary is still a valid one for a connector chip
elsewhere.

Shipped in #412.
