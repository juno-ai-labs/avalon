# Plugin activity rows

What the work-stream transcript shows in place of an agent's tool calls: one row
per plugin per uninterrupted stretch of work, saying which place Rally is working
in and for how long — "Slack is working for 4m 02s", becoming "Slack worked for
5m 02s" when the plugin is done.

The same collapse is applied to the model's thinking, which arrives one row per
reasoning segment and reads as one "thought for …" per run.

Once the loop finishes, the whole run folds behind one closed accordion carrying
its own total — "Worked for 41m 17s" — sitting directly above the answer it
produced.

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
| `apps/desktop/src/renderer/lib/transcript.ts` | `orderedTranscriptMessages` projects tool blocks, thinking blocks, and plugin activities out of the canonical snapshot, and marks the seam where its coverage is not contiguous; `groupPluginToolMessages` collapses the composed feed, `groupThinkingMessages` collapses the thinking left in it, and `collapseSettledWorkIntoAccordion` folds a finished run's rows behind the total `foldSettledWorkIntoMessages` resolved. `thoughtVerb` and `isThinkingEvent` are the one place the two thought rows are told apart. |
| `apps/desktop/src/renderer/screens/workstream.tsx` | Applies the four passes in order, and is the only caller of any of them. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `PluginGlyph` draws a mark; `PluginActivityBlock` renders one grouped row; `ThinkingGlyph` draws the thinking row's brain and `ThoughtBlock` decides which of the two thought rows gets it; `WorkAccordionBlock` is the closed row a settled run becomes, and `WorkAccordionRow` draws what is inside it through those same two blocks. |
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
individual call durations can reproduce. The client no longer reads it directly
except as the legacy fallback below.

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
5. **Closing a finished run.** `foldSettledWorkIntoMessages` resolves the
   settled response total to the answer it belongs to, and
   `collapseSettledWorkIntoAccordion` folds the rows above that answer into one
   closed row carrying it; see [when the loop finishes](#when-the-loop-finishes).

### The thinking rows

A thinking block is the model reasoning, and the transcript gives each one its
own activity and so its own row. The model thinks between every pair of tool
calls, so a run that used one plugin four times reaches the feed as one grouped
plugin row and four thinking rows stacked under it — "thought for 29s / thought
for 38s / thought for 17s / thought for 14s". Each is true and none is what a
reader wanted to know, which is the same complaint the per-call tool rows
answered: what places Rally worked in, and for how long.

So `groupThinkingMessages` sums a run's thinking into one row — "thinking for
1m 39s" while any segment is still going, "thought for 1m 38s" once they have
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

- **The response's own total**, the "worked for …" row at the foot of a live
  run, which `foldSettledWorkIntoMessages` moves onto the message it produced
  when it settles — and which then becomes the accordion's label, or stays in
  the header where there is no accordion. It is one fact about the whole
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
than the generic plug, and `rally:automations` keeps its own **Automations** row
the same way, drawing Tabler's **keyframes** glyph. A first-party plugin that is
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
  neutral across four themes, instead of eight brand palettes of which several
  vanish against one ground or the other — X and Notion on a dark theme, Granola
  on a light one. It also means no per-theme artwork and no component that knows
  which theme is on.

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

The mark is drawn bare — no chip, no ring, no per-connector brand fill — and
pulses its opacity while the group is active, which is the whole of the "still
going" signal. A column of enclosed glyphs down a transcript reads as a toolbar
of controls, and these are labels; the single neutral is also the only colour
with guaranteed contrast, because a connector's brand foreground was chosen
against its own chip and the transcript has four themes and no chip.

A **settled response total** is not a plugin row and does not live in the feed
as one. While it runs it is progress and stays a row; once it settles
`foldSettledWorkIntoMessages` moves it onto the message it produced, and it is
printed either as that run's accordion label or, where the turn reached for
nothing, in the message header — "Rally · 11 minutes ago · Worked for 2m 52s".
Either way a spent timer stops sitting under the answer, where it reads like
another step still to come.

### When the loop finishes

Every row above is progress, and progress is worth a line each: while Rally is
working, a reader watches which places it is in and how long each is taking. The
moment the loop finishes none of that is progress any more. Four spent timers
stacked above an answer are a receipt, and the receipt was already printed — it
is the response's own total, which by then reads "Worked for 41m 17s" one line
below them.

So `collapseSettledWorkIntoAccordion` folds the run into a single closed row
carrying that total, sitting where the run's first row sat, directly above the
answer. A reader who wants the breakdown opens it and gets the same rows,
unchanged, drawn by the same components.

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

- **The total moves; it is not copied.** `foldSettledWorkIntoMessages` has
  already resolved the settled response timer to the answer it belongs to, which
  is exactly the "the loop is complete" signal and exactly the total the
  accordion wants. Printing it on the accordion *and* in the header a line below
  would be one duration competing with itself. So the pass takes `workSummary`
  off the message as it builds the row. **Both renderings stay**, because a turn
  that reached for nothing has no machinery to fold and no accordion to move the
  total to; its header keeps the line, as before.
- **The total is not a sum over the rows inside.** A run's thinking overlaps its
  plugin work — the model reasons between calls, and a plugin's activity covers
  the gaps between its own — so adding the rows up would overstate the run by
  however much of it ran concurrently. The response activity measured the whole
  stretch once, and it is the only honest answer available. A run with no
  response total therefore has no accordion at all rather than a computed one.
- **The rows are nested inside the accordion row, not hidden in place.** The
  transcript is virtualized. A collapse that left its rows in the list would
  still cost one measured item each, and opening one would grow N items whose
  heights the cache has to be told about separately; one row is one measurement.
  For the same reason the open flag is held by `MessageFeed` rather than by the
  row — see `RowDisclosure`, whose set the clamped system row already uses.

The boundary is the run's: the rows immediately above the answer, back to the
first thing a person read, or to a stretch of transcript nobody has loaded. That
is the boundary `groupPluginToolMessages` and `groupThinkingMessages` already
grouped within, so an accordion holds exactly one run's worth of rows, each of
them already one per plugin.

The unloaded-stretch half of that boundary is checked at **both** ends of the
scan, which is the one place this pass differs in shape from the two before it.
They walk forward and close the run on any row carrying
`precededByTranscriptGap`, the row that would close it included; this one walks
backward from the answer, so it has to read the flag on that answer too. The
projection sets it on a turn's *first* row only, so an answer that opens its
turn is exactly where it lands — and such an answer opens a newly loaded island,
which makes the machinery above it in the list some earlier island's. It has no
run of its own to fold, so it keeps its total in the header.

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
- **A run collapses only once its response total has settled.** That timer is
  the loop's own completion signal, and it is the one the fold already keys on.
  Collapsing on anything else — every row in the run reporting itself settled,
  say — would close the drawer during a live run in the window between one
  plugin finishing and the next starting.
- **The accordion's total is the response's, never a sum of the rows in it.**
  Thinking overlaps plugin work and a plugin activity covers the gaps between
  its own calls, so a sum overstates the run by whatever ran concurrently.
- **A settled total is printed in exactly one place.** On the accordion where
  there is one, in the message header where the turn reached for nothing. Both
  renderings exist; neither is a fallback for the other failing.
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

- **The automation draft wizard's feed** (`screens/new-automation.tsx`), which
  is the other adapter over the shared conversation family — see
  [`conversation-surfaces.md`](conversation-surfaces.md). It still shows one row
  per tool call. That feed has no plugin activities behind it, so a grouped row
  there could only ever sum call durations, and the wizard's tool calls are a
  handful of authoring steps rather than the screenful a work-stream run
  produces. It does share `.plugin-face`, so its plugin marks are bare too.
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
- **A run whose response total never arrived** does not collapse. Its rows stay
  in the feed as they were, which is the honest rendering: there is no total to
  label a drawer with, and summing the rows would report a number the transcript
  never established. The same happens to work that trails an answer with no
  answer of its own after it.
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
| `lib/transcript.test.ts` | same, `src/renderer/lib/transcript.test.ts` | Grouping over a composed feed: position, run boundaries, which timing wins, dropped rows, renumbering. Collapsing thinking: the summed run, the run boundary, the response total left out of it, the unknown segment, and the concurrent starts. Closing a finished run: what goes in the drawer, the total moving out of the header, the two boundaries, the live run left open, and the derived id. |
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
chevron sits outside the content column, so any surface that reduces the
transcript's left padding below 20px clips it; at the narrowest window the
shell allows it still has 18px of room.

### 2026-09-02 — Automations draws Tabler's keyframes glyph

**What changed:** The `rally:automations` activity row draws Tabler's
`keyframes` icon instead of the generic plug. Like multimodal generation, it is
pinned in `GROUPED_PLUGIN_IDS` under its canonical id and keeps its own
**Automations** row, so the glyph does not ride on the display-name heuristic
that would otherwise land it on the plug.

**Why:** The plug is the glyph for a connector this surface has not learned
about yet; reading it on a first-party plugin tells a reader nothing about what
Rally was doing. Automations are a scheduled or triggered sequence, and
keyframes is the shape that says so.

**Consequences:** The plug stays the fallback for an unrecognized connector. A
later rename of the plugin's display name keeps the keyframes glyph as long as
its canonical id stays `rally:automations` — but the row's key is still
`name:Automations`, so the live pre-canonical row and the canonical block merge
on that name the way every other row does.

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


### 2026-08-29 — The server says which plugin ran, and for how long

**What changed:** `WorkstreamTranscriptSnapshot` gained `pluginRuns`: per plugin
per turn, its display name, state, duration, timing accuracy and tool call ids,
built by `pluginRunsForTurns` in the transcript storage. The renderer builds its
rows from that and joins tool blocks to runs on `toolCallIds`. `durationMs` is
nullable end to end, and an unknown duration renders as no duration. The
activity-tree derivation is kept only as a fallback for an API that predates the
field.

**Why:** A grouped row rendered `Rally worked for 0ms` for runs that really
worked — one production run logged `tool_calls=2` and `tool_time_ms=6770` while
the feed reported nothing. The renderer was never *told* which plugin owned
which call; it rebuilt that from three separately-derived id families, over a
snapshot that only carried activities reachable by an upward walk seeded from
`turn.activity_id` and `block.activity_id`. Both columns are nullable — the
development-seeded tool turn leaves both NULL — so for a settled run in that
state the plugin and tool_call activities never reached the client at all.

Every one of those failures produced the same number, because
`activityDuration` sums `durationMs ?? elapsedMsAtSnapshot ?? 0`. A missing
activity, an unreachable one, and an interval closed without a duration all read
as zero, so the client could not tell "took no time" from "I cannot see the
timing" and rendered the second as the first. That is what made the bug a
confident falsehood rather than a gap, and it is why the nullable duration
matters as much as the new field: even if some upstream join still misses, the
row now says nothing rather than something false.

**Considered and rejected:** Putting `pluginRunId` and a resolved duration on
the tool block instead. It needs no new array, but a plugin's total spans
several blocks, so the number would be duplicated across them and a reader would
have to know which copy was authoritative. Also rejected: making `pluginRuns`
required. A desktop build updates on its own schedule and has to parse a
snapshot from an older API, so the field is defaulted and an empty array means
"this server does not report runs" rather than "no plugin ran".

**Consequences:** The plugin↔tool relationship is the authority's to state, and
a client that recomputes it has reintroduced this defect. `pluginRunsForTurns`
must keep seeding from the turn's own id and walking *down*; a workers test
pins that a turn whose blocks carry no `activityId` still reports its runs, and
it fails if the seed goes back to `turn.activityId`. Anywhere a duration is
summed, one unknown contribution makes the total unknown rather than smaller —
adding only the parts that reported understates the work by exactly the part
that did not, and presents the shortfall as certain. The legacy fallback can be
deleted once no deployed API omits `pluginRuns`.

### 2026-08-29 — Rally works; everything else is used

**What changed:** A group carries its own `activeVerb` and `completedVerb`.
Rally reads "Rally is working" / "Rally worked"; every other plugin reads "Using
Slack" / "Used Slack"; the Computer group reads "Using a computer" / "Used a
computer". A settled response total moves out of the feed into the header of the
message it produced, via `foldSettledWorkIntoMessages`.

**Why:** "Slack worked for 5s" makes the connector the actor, which it is not —
Rally decided to call it. Naming the agent as the subject everywhere would be
worse, because "Rally worked" is then indistinguishable from the response-level
total. So the agent keeps the working voice and the tools take the used voice,
which also reads as what a person would say about their own work. Computer is
the only group named with a common noun, so it is the only one needing an
article; every connector is a proper name and takes none.

The response total moved because it stops being progress the moment it settles.
Left in the feed it is a spent timer sitting under the answer, which reads like
another step still to come; in the header it sits with the rest of that
message's provenance, beside the author and the time.

**Considered and rejected:** Deriving the phrasing in the component from the
group's name and a boolean. It puts a grammar rule in the renderer, and the
article case would have been a name comparison against "Computer" — a string
match that breaks the day the group is renamed. Also rejected: folding a turn's
*thinking* row into the header too. Thinking annotates one step inside a run and
several belong to a single message; only the response's own total is a fact
about the finished message.

**Consequences:** A new group decides its own phrasing, and a group whose name
is a common noun needs the article written into its verbs. A message can now
carry `workSummary`, and the header renders it; a surface that shows agent
messages without that header will drop the total silently.


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

### 2026-08-29 — Four defects review found in the grouped row

**What changed:** A group row now carries `attentionSequenceNumber: null`; a
plugin id with no display name produces no row rather than one named after the
id; `AgentWorkTiming` takes the accessible name as `activeName` instead of
deriving it from the visible verb; and Settings sizes its marks through
`.provider-icon .connector-mark` and `.settings-connection-name .connector-mark`
rather than bare classes.

**Why:** All four came out of review on the pull request, and three were
regressions this feature introduced rather than pre-existing gaps. The group row
inherited the tool row's ordinal, which is its *turn's* ordinal — the same one
the turn's text carries — and changing the row's type walked it past the
`tool_event` exclusion in `highestVisibleAttentionSequence`, so a group scrolling
into view acknowledged an answer still below the fold through a server-stored
read receipt. Sniffing `activeVerb === 'working'` to pick an accessible name
treated "not the default" as "is a plugin row", but thinking rows are the other
caller that overrides the verb, so an active thought announced the bare word
"thinking". The two Settings sizes tied `.connector-mark` on specificity and lost
on source order, so both rules were inert and both marks drew at the shared 16px
— a difference small enough to survive the visual check that was supposed to
catch it. The id fallback was the one that was merely wrong rather than new: it
contradicted this document's own invariant that an internal identifier never
reaches the feed.

**Consequences:** The read-receipt path now has one rule for both sources of
`plugin_activity` rows, so neither can acknowledge a turn. A connector whose
plugin activity never arrives shows nothing rather than a UUID, which is the same
trade the unattributed tool row already makes. `activeName` is a required
consideration for any caller that sets `activeVerb`. The stylesheet suite pins
that a per-surface mark size out-specifies the shared rule, and the Settings
component test pins that a mark carries no second class to hang one on.

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
neutral is legible on all four themes with no per-theme artwork.

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
