# Plugin activity rows

What the work-stream transcript shows in place of an agent's tool calls: one row
per plugin per uninterrupted stretch of work, saying which place Rally is working
in and for how long — "Slack is working for 4m 02s", becoming "Slack worked for
5m 02s" when the plugin is done.

Read this before changing what a tool call looks like in the feed, adding a
first-party plugin, changing a plugin's canonical id or display name, or
changing when a tool block learns its owner. The rows a person actually reads —
Rally's own sentences, elicitations, suggestions — are untouched by any of it;
this document is only about the machinery underneath them.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/plugin-groups.ts` | The only place that decides which row a plugin belongs to, what that row is called, and which glyph it draws. |
| `apps/desktop/src/renderer/lib/plugin-marks.ts` | The company marks, one `@thesvg/react` component per brand, and `connectorBrandMark` — the one table saying which mark a connector wears. |
| `apps/desktop/src/renderer/components/primitives.tsx` | `ConnectorMark`, the one component that draws one. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | Settings' provider cards and installed-connection rows, both reaching a mark from the connector's own type. |
| `apps/desktop/src/renderer/lib/transcript.ts` | `orderedTranscriptMessages` projects tool blocks and plugin activities out of the canonical snapshot; `groupPluginToolMessages` collapses the composed feed. |
| `apps/desktop/src/renderer/screens/workstream.tsx` | Applies `groupPluginToolMessages` to the composed transcript, and is the only caller. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `PluginGlyph` draws a mark; `PluginActivityBlock` renders one grouped row. |
| `apps/desktop/src/renderer/components/agent-work-timing.tsx` | The shared elapsed-time row; its `icon` slot is what lets a plugin's mark stand in for the thinking orb. |
| `apps/desktop/src/renderer/styles/app.css` | `.plugin-face` and `.plugin-face-active` — the bare mark and its pulse. |

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

### The three steps

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

### What the groups are

`rally:core`, `rally:discovery`, `rally:memory`, `rally:tables`, and
`rally.skills` are all Rally reasoning about its own workspace, and are drawn as
one **Rally** row. `rally:terminal` and `rally:workstream` are Rally operating a
machine, and are drawn as one **Computer** row. A first-party plugin that is
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
duration rather than printing `0ms`.

A **settled response total** is not a plugin row and does not live in the feed
at all. While it runs it is progress and stays a row; once it settles
`foldSettledWorkIntoMessages` moves it into the header of the message it
produced — "Rally · 11 minutes ago · Worked for 2m 52s" — because a spent timer
under the answer reads like another step still to come. The mark is drawn bare — no chip, no ring, no per-connector
brand fill — and pulses its opacity while the group is active, which is the
whole of the "still going" signal. A column of enclosed glyphs down a transcript
reads as a toolbar of controls, and these are labels; the single neutral is also
the only colour with guaranteed contrast, because a connector's brand foreground
was chosen against its own chip and the transcript has four themes and no chip.

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
- **A group row's position is its plugin's first row in the run, never its
  last.** The feed's order is the order work started in; the alternative makes a
  row jump downward as the plugin is used again.
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
- **The run-level timer** at the foot of the transcript, and the thinking rows.
  Both remain `AgentWorkTiming` with the thinking orb.
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
- No caps, quotas, or timeouts: the whole module is a pure function over a list
  that is already bounded by the transcript's own paging.

## Testing

| Suite | Command | What it proves |
| --- | --- | --- |
| `lib/plugin-groups.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/plugin-groups.test.ts` | The map: the two virtual groups, the unnamed-first-party fallback, name keying across the two id families, every glyph, and that no shipped connector still draws the plug. |
| `lib/plugin-marks.test.ts` | same, `src/renderer/lib/plugin-marks.test.ts` | The marks: the monochrome variant asked for wherever a brand ships one, and one distinct mark per brand. |
| `lib/transcript.test.ts` | same, `src/renderer/lib/transcript.test.ts` | Grouping over a composed feed: position, run boundaries, which timing wins, dropped rows, renumbering. |
| `components/workstream-blocks.test.tsx` | same, `src/renderer/components/workstream-blocks.test.tsx` | The row: its wording in both tenses, its stable accessible name while the number ticks, the pulsing mark, and the absent orb. |
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
them icon types. Type-aware linting holds that program per worker, and a cold
`pnpm lint` on CI died with `JavaScript heap out of memory`. It passed locally
only because `pnpm lint` caches and CI runs cold, which is the divergence
`AGENTS.md` warns about. The `@thesvg/react` per-icon declarations import only
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
