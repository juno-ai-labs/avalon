# Relative time

Every "7 minutes ago", "just now" and "in 23 hours" in the desktop renderer, and
the one identity line every turn in a feed carries. Two components and a clock:
a label that stays true as now moves and gives up the exact local time on hover,
and the byline that pairs it with a name.

The promise is that a screen left open does not go stale. A relative label is
only correct at the instant it was painted, and Rally is an application people
leave open beside their work — so the label re-reads a shared clock rather than
the render that produced it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/ui/src/lib/clock.ts` (re-exported by `apps/desktop/src/renderer/lib/clock.ts`) | The one clock. `useNow()` subscribes to a single interval shared by every label on screen; `RELATIVE_TIME_REFRESH_MS` is how often it advances. It lives in `@rally/ui` so a shared component (a remembered fact's horizon in `memory-fact-rows.tsx`) ticks on the same interval. |
| `apps/desktop/src/renderer/components/relative-time.tsx` | `RelativeTime` — the only component that renders a relative label, and the only caller of `formatRelative`. Carries the absolute-time tooltip. |
| `apps/desktop/src/renderer/components/message-byline.tsx` | `MessageByline` — the identity line over a turn: who, when, and the optional labels between them. |
| `apps/desktop/src/renderer/lib/format.ts` | The vocabularies. `formatRelative` is the default; `formatDateTime` is what the tooltip says; `formatSidebarActivityTime` is the calendar one the sidebar's hover preview passes in. |
| `packages/ui/src/styles/app.css` | `.message-author`, `.message-block time` and the shared `.message-block > header` — one set of type and colour for the byline, not one per speaker. |
| `config/design-tokens/base.json` | `cmp.feed.byline.font-size`, `cmp.feed.byline.author-weight` and `cmp.feed.byline.time-weight` — one size for the line, and the two weights that separate who from when. |

## How it works

`clock.ts` holds a module-level `now` and a set of listeners. The first
component to call `useNow()` starts one `setInterval`; the last to unmount
clears it. Every tick re-reads `Date.now()` and notifies all listeners at once,
so every label on screen advances on the same beat rather than each drifting
into its own second. The hook is a `useSyncExternalStore` over that set, so a
label re-renders itself when the clock moves without its host re-rendering.

Two reads sit outside the interval. The clock re-reads on `visibilitychange`
when the window becomes visible, because Chromium throttles a hidden window's
timers to roughly once a minute and a person returning to Rally would otherwise
read labels that stopped while they were away. And `getSnapshot` re-reads when
no interval is running, so a component mounting after the last subscriber left
paints its first frame against the live clock rather than the value the store
stopped at.

`RelativeTime` renders a `<time>` carrying the machine-readable instant in
`dateTime` and the human label as its text, wrapped in a tooltip that names the
exact local date and time. Its `format` prop takes the vocabulary — the default
is `formatRelative`, and a surface with its own calendar words ("Yesterday", a
weekday) passes its own function and still ticks. It brings its own
`Tooltip.Provider` rather than requiring one from the host.

`MessageByline` lays down the name, the optional context label, the time and a
settled response's total. Its time is the clock time (`formatTime`), and the
feed (`MessageFeed`) draws a day divider over the first turn of each local day
("Today", "Yesterday", a weekday, a date, through `formatDayLabel`), as
design.html §2 draws a transcript: a full date only where a day changes. It reads outward from the edge the turn is aligned to:
name first on the leading edge, name last on the trailing one, done by reversing
the parts in the markup rather than with CSS ordering, so a screen reader
announces what a sighted reader sees. The avatar (`initial`: Rally's "R", a
colleague's first letter) or the person-accent dot sits inside the name
element, so the two travel together whichever way the line reads, and the name
is its own box so a long one ellipsizes.

## Invariants

- **`formatRelative` has exactly one caller, and it is `RelativeTime`.** A
  surface that formats the string itself renders a label that is right once and
  wrong for the rest of the session, and nothing on screen says so.
  Nothing automated fails when a second importer appears; that guard belongs in `no-restricted-imports`.
- **`useNow` is the only relative-time clock.** A component that arms its own
  `setInterval` to keep a label current adds a timer per label — fifty turns,
  two sidebars and an inspector would arm fifty-odd — and each drifts onto its
  own second, so two labels for the same instant disagree. Same test.
- **The byline is one element, painted once.** The name and the time take one
  size and one pair of greys whoever is speaking. A rule scoped to
  `.agent-message` or `.human-message` that touches the name or the time makes
  Rally's turn and a person's read as different kinds of row for the same two
  facts; no automated test covers this, so check it in a real window. What may still differ per
  speaker is the accent on the dot, which is the only thing that says *whose*
  turn this is.
- **Every relative label carries its instant twice**: as text a person reads and
  as `dateTime` a machine does. Dropping the attribute leaves a timestamp that
  cannot be selected, exported, or read by assistive technology.
- **The tooltip is local time, not UTC.** It is the answer to "when exactly",
  asked by somebody sitting in one timezone.

## Boundary

This module owns how an instant is presented in the renderer and how often that
presentation is refreshed. It does not own the vocabularies — `format.ts` does,
and a surface that needs new words adds one there and passes it in. It does not
own where a byline sits, what a turn is made of, or the feed's spacing;
[`conversation-surfaces.md`](conversation-surfaces.md) owns those. It does not
own colour: the two greys and the type come from tokens that
[`theming.md`](theming.md) owns.

Nothing outside the renderer uses it. Server-side and email timestamps are
formatted where they are produced.

## Failure modes and limits

- **An unparseable instant renders "Unknown time"** rather than throwing, in both
  the label and the tooltip.
- **A hidden window's labels stop at their last tick** until the window is shown
  again, which is Chromium's throttling rather than a choice here. The
  visibility re-read is what keeps the gap invisible.
- **`RELATIVE_TIME_REFRESH_MS` is 10 seconds.** This is a product number, not a
  defensive bound: it is how far a label may lag the truth before the screen
  corrects it, and it was chosen so that a label crosses a minute boundary within
  a blink of it actually doing so. The whole window pays one timer for it.
- **The tick does not fetch.** It re-renders labels against a new clock; it does
  not ask the server whether anything changed.
- **A grouping key is not a label, and stays outside this.**
  `formatSparseRelativeDate` buckets the inspector's version rows under "today"
  or "last week", and `groupActivityItems` does the same for the sidebar. Those
  strings are section headings over many instants, not a `<time>` describing one,
  so they cannot render through `RelativeTime` and the guard test does not cover
  them. They go stale at a calendar boundary rather than by the minute, and the
  sidebar already re-groups itself on `nextRecencyBoundary`; the inspector's
  version list does not, which is a gap in that list rather than in this
  module.
- **A host's own hover affordance wins over the tooltip.** The sidebar row's
  timestamp sits inside a row that already shows a preview card on hover, and
  that card is what a reader gets; the absolute-time tooltip does not also open.
  That is the better outcome — two popovers on one hover is noise — and it is
  recorded rather than fixed, because the label's job there is to stay current,
  which it does.
- **The tooltip is reachable by pointer, not by keyboard.** `Tooltip.Trigger`
  wraps the `<time>` with `asChild`, and a `<time>` is not focusable, so tabbing
  never reaches it. Making it focusable was rejected: a feed of fifty turns would
  become fifty extra tab stops between a reader and the composer, which costs a
  keyboard user more than the tooltip gives them. The instant is still carried in
  `dateTime` for anything reading the document, and this matches how `StatusDot`
  attaches its own tooltip.

## Testing

```bash
pnpm --filter @rally/desktop exec vitest run \
  src/renderer/lib/clock.test.tsx \
  src/renderer/components/relative-time.test.tsx \
  src/renderer/components/message-byline.test.tsx
```

`clock.test.tsx` drives the real store, so it needs Vitest's fake timers and
`vi.setSystemTime`; the late-subscriber case records every value a probe
component was rendered with rather than the one it settled on, because
subscribing re-reads the clock and an assertion on the final value passes
whether or not the first frame was stale.

## Changelog

### 2026-11-08 — A turn's byline reads its clock time under a day divider

**What changed:** The byline shows the clock time, not "7 minutes ago", and the
feed names each day above its first turn. The byline can carry an avatar.

**Why:** The PRD makes design.html the authority, and §2 draws "Today" between
hairlines and "10:42" against each name, with an "R" avatar on Rally's turn
and a person's initial on a colleague's (v1-F9, v4-F8). A turn older than a
week read as a full date on every line.

**What a future change must respect:** the feed's divider is what dates a
turn; a byline that grows a date again repeats it on every line.

### 2026-09-10 — One byline, one clock, one relative label

**What changed:** Three primitives replace nine hand-rolled timestamps. `useNow`
is a shared clock every label subscribes to; `RelativeTime` is the only caller of
`formatRelative` and carries an absolute-time tooltip; `MessageByline` is the one
identity line, used by the assistant turn, the human turn, and the settled
elicitation answer alike. In `app.css` the four rules that painted the name and
the time per speaker collapse to two that paint them once, and
`cmp.feed.author.*` becomes `cmp.feed.byline.*` — one size and two weights —
while `sys.font.size.author` leaves the registry with nothing reading it.

**Why:** Reported as two screenshots of the same two facts drawn two different
ways. Rally's turn read its name at 13px/500 in `neutral-11` under a 0.7 opacity
with the time at 8.5px in `neutral-8`; a person's read theirs at 12px/500 in
`text-subtle` with the time at 12px in `text-muted`. Neither rule looked wrong
beside the others, which is exactly how four of them came to exist — each was
added to fix one surface, and the drift was only visible with both rows on
screen at once. The same shape of defect produced the stale labels: nine callers
each computed a string at render, so a work stream left open over lunch had a
feed, a sidebar and an inspector all still claiming the last message arrived
seven minutes ago, and there was no single place to fix it.

**Considered and rejected.** Keeping the per-speaker rules and hand-tuning them
to agree: that is the arrangement that produced the drift, and a pair of values
that agree today is not an invariant. A `setInterval` inside `RelativeTime`: one
timer per label, each drifting onto its own second, so two labels for the same
instant disagree — the shared store costs one timer for the window. `title` on
the `<time>` instead of a tooltip: the native tooltip is slow, unstyleable, and
does not appear at all for a keyboard user. Ordering the human byline with CSS
`flex-direction: row-reverse` rather than reversing the parts in markup: it
would divorce what a screen reader announces from what is on screen, which is
the reason the September 9 entry in
[`conversation-surfaces.md`](conversation-surfaces.md) put the order in the
markup in the first place.

**Caught in review:** the first cut converted the sidebar's *hover preview*
timestamp and missed the visible row's, because the sweep grepped for
`formatRelative` and the sidebar speaks its own vocabulary
(`formatSidebarActivityTime`). Left alone, a row mounted across midnight would
have read `11:58 PM` under a preview that said `Yesterday` — the same
disagreement this change exists to remove, reintroduced by the guard being
narrower than the idea. The guard now covers that vocabulary too.

**Consequences:** the name no longer resolves through `--person-accent`. That
variable now paints the dot and nothing else, and its `profile ? text-default`
branch — which existed to stop a bright personal hue making the name unreadable
— is gone with the problem it solved. A surface that wants a relative label
renders `RelativeTime`; if the words do not fit, it passes a `format` rather
than formatting the string itself, and the guard test says so when it does not.
The refresh interval is the team's number to change, and it is one constant.
