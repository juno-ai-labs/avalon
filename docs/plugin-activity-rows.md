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
| `apps/desktop/src/renderer/lib/transcript.ts` | `orderedTranscriptMessages` projects tool blocks and plugin activities out of the canonical snapshot; `groupPluginToolMessages` collapses the composed feed. |
| `apps/desktop/src/renderer/screens/workstream.tsx` | Applies `groupPluginToolMessages` to the composed transcript, and is the only caller. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `PluginGlyph` draws a mark; `PluginActivityBlock` renders one grouped row. |
| `apps/desktop/src/renderer/components/agent-work-timing.tsx` | The shared elapsed-time row; its `icon` slot is what lets a plugin's mark stand in for the thinking orb. |
| `apps/desktop/src/renderer/styles/app.css` | `.plugin-face` and `.plugin-face-active` — the bare mark and its pulse. |

## How it works

### What the transcript already carries

Nothing here is new backend state. The canonical ordered transcript
([`workstream-durable-object.md`](workstream-durable-object.md)) already
delivers both halves:

- A **tool block** carries `pluginId` — the plugin's canonical id, `rally:memory`
  or `connection:<uuid>`. The block is written when the model *plans* the call
  and its `pluginId` is filled in when the call *starts*, so a block is briefly
  anonymous.
- A **plugin activity** (`scope: 'plugin'`) hangs off the assistant turn, one per
  plugin per turn, carrying that plugin's `label` and its intervals. Its elapsed
  time covers the whole stretch the plugin was in play, including the gaps
  between its calls, which no sum of individual call durations can reproduce.

### The three steps

1. **Projection.** `orderedTranscriptMessages` copies `pluginId` and the owning
   activity's `label` onto each tool row, and turns each plugin activity into a
   `plugin_activity` row rather than the generic thinking row it used to be.
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

The glyph comes from the display name too, mirroring the backend's own
`connectorAutomationPluginIcon`. The canonical transcript identifies a connector
only by connection id, and the icon the backend does resolve travels on the live
tool-invocation row alone, so the name is the one signal available on both
paths. It is a manifest string, not user input.

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
in the orb's slot. The mark is drawn bare — no chip, no ring, no per-connector
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
- **A group row's position is its plugin's first row in the run, never its
  last.** The feed's order is the order work started in; the alternative makes a
  row jump downward as the plugin is used again.
- **`pluginGroup` is the only mapping.** A second table anywhere — a component
  branching on `pluginId`, a screen naming Rally itself — is how the feed and
  the row it draws come to disagree about what a group is.
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
- **A failed tool call** is not marked. The row says how long the plugin worked
  and no more, which is what the per-plugin activity row said before this change
  too; a run's failures reach the reader through Rally's own words and the run
  failure notice.
- No caps, quotas, or timeouts: the whole module is a pure function over a list
  that is already bounded by the transcript's own paging.

## Testing

| Suite | Command | What it proves |
| --- | --- | --- |
| `lib/plugin-groups.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/plugin-groups.test.ts` | The map: the two virtual groups, the unnamed-first-party fallback, name keying across the two id families, and every glyph. |
| `lib/transcript.test.ts` | same, `src/renderer/lib/transcript.test.ts` | Grouping over a composed feed: position, run boundaries, which timing wins, dropped rows, renumbering. |
| `components/workstream-blocks.test.tsx` | same, `src/renderer/components/workstream-blocks.test.tsx` | The row: its wording in both tenses, its stable accessible name while the number ticks, the pulsing mark, and the absent orb. |

The trap is the elapsed-time format: `formatDuration` zero-pads the seconds of a
minute, so the string is `4m 02s`, not `4m 2s`.

A change here is visible, so it also needs a real window —
[`dev-environment.md`](dev-environment.md#driving-and-screenshotting-it). A local
stack cannot run a real turn, so the way to get a multi-plugin transcript on
screen is to write a hand-built `WorkstreamTranscriptSnapshot` into the
renderer's `['ordered-transcript', <id>]` query, which exercises the whole
projection, composition, grouping, and render path from real inputs.

## Changelog

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
