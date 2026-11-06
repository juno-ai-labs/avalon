# Canvases and Sidekicks

> Created 2026-11-06.
>
> Rally narrows to two modes: Canvases (live artifacts several people edit with
> Rally) and Sidekicks (AI agents several people share). Channels, Threads,
> Breakouts, Activity and the Pinned section are removed. Mockups:
> [design.html](design.html). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Replaces the navigation in
> [Channels and Threads navigation](../2026-10-10_channels-threads-navigation/prd.md).

## Summary

The desktop and browser clients show two sections instead of five. **Canvases**
lists live pages that people and Rally build together; opening one shows who is
in it, their cursors, and a side panel with the Canvas's own chat with Rally and
its comments. **Sidekicks** lists shared AI agents; opening one shows a single
conversation everyone it is shared with can join, with its runs and the Canvases
it writes inline, beside its settings.

The change has two halves of very different size. Removing Channels, Threads,
Breakouts, Activity and the Pinned section is mostly deletion. Making a Canvas
something several people and Rally edit at once is **new work and the larger
half**: today a live artifact is a directory a Thread's run publishes, and
nobody edits it directly. Live editing, presence, cursors and Rally's pending
edits need a real-time collaboration layer that does not exist yet.

## Motivation

The team decided to pivot to these two modes. The evidence behind that decision
is not recorded here yet; the team must add it before this PRD is approved, and
the pull request that introduces it should not merge until it has.

## Goals

1. The section rail shows exactly two sections, Canvases and Sidekicks, on
   macOS and web.
2. A person can see from the sidebar which Canvases have people in them now.
3. A person can see from the sidebar which Sidekicks need input from them.
4. Several people and Rally can edit one Canvas at once and see each other's
   cursors, selections and pending edits.
5. Several people can talk to one Sidekick in one shared conversation.
6. A Sidekick's output that people work on afterwards is a Canvas, reachable
   from both the Sidekick conversation and the Canvases list.

## Non-goals

1. **iOS.** Deferred; iOS is a prototype and follows once desktop and web ship.
2. **A grouping layer above Canvases and Sidekicks** (folders, teams,
   Channels). Rejected for now; sharing is per Canvas and per Sidekick.
3. **A separate notification inbox.** Rejected; unread dots, "Needs input" and
   rail badges carry what Activity did.

## Product behavior

See [design.html](design.html) for every screen in light and dark.

- **Rail.** Canvases and Sidekicks, then Settings at the bottom. Each section
  shows a badge for unread items.
- **Canvases sidebar.** A Pinned group, then all Canvases sorted by recent
  activity. Each row shows the Canvas mark, its name, a green dot and names
  when people are in it, otherwise the last editor. Unread rows are bold with a
  red dot.
- **Canvases home.** Title, New Canvas, search, filter chips (Everyone, Made by
  me, Shared with me, From Sidekicks), a Live now group, then Recent.
- **Canvas open.** The header pill names the Canvas; to its right are the
  people present, Share and a menu. The Canvas fills the pane. The right panel
  has two tabs: Chat (the Canvas's conversation with Rally, open to everyone in
  it, where a quoted selection travels with the message) and Comments (the
  current artifact annotations). Rally's pending edit shimmers where it lands.
- **Sidekicks sidebar.** Needs input, then Pinned, then all Sidekicks. Rows
  show the hexagon mark and current state (working, next run, paused). "Needs
  input" means the Sidekick is missing information only a person has; it never
  means a Sidekick is waiting to be allowed to run a tool.
- **Sidekicks home.** Today's library, moved into the main window, as rows with
  status, who it is shared with, and when it next wakes.
- **Sidekick open.** One shared conversation, with runs as collapsed rows and
  Canvases as cards. The details column keeps today's Sidekick page (status,
  Pause, delegation, schedule) and adds triggers, tools and the Canvases it
  writes to.

### States

- **Empty.** A first-run Canvases list shows only New Canvas and a "Start from
  a prompt" card; the Sidekicks list shows New Sidekick and the existing library
  empty copy.
- **Loading.** Lists draw the existing sidebar skeleton. An opening Canvas draws
  its last cached version and joins the live session behind it, so opening is
  never blocked on presence.
- **Error.** A Canvas that cannot be opened, or that the person lost access to,
  shows the existing unavailable state for a resource.
- **Offline.** A Canvas opened offline shows its last cached version read-only,
  with a notice that live edits resume on reconnect; other people's cursors are
  hidden rather than frozen. Chat and Comments queue the same way the composer
  does today.

### What each feature becomes

| Today                                                 | After                                                 |
| ----------------------------------------------------- | ----------------------------------------------------- |
| Channels, Channel feed, General, Personal Channel     | Removed                                               |
| Threads and the Thread conversation                   | Removed; the Canvas Chat tab and Sidekicks replace it |
| Breakouts, merge-back, breakout and merge suggestions | Removed                                               |
| Activity section                                      | Folded into unread dots, "Needs input" and badges     |
| Pinned section                                        | A Pinned group in each list                           |
| Artifacts section, live web artifacts, annotations    | Become Canvases                                       |
| Sidekicks window and library                          | Move into the main window                             |

## Impact on the product contract

This changes the contract. These clauses of
[the brief's Product contract](../2026-08-05_avalon-implementation-brief/prd.md#product-contract)
move:

- **A Thread is the durable, multiplayer home for a task.** Replaced: a Canvas
  is the shared home for work, and a Sidekick is the shared home for an agent.
- **A Channel is a stable, named list of Threads.** Removed.
- **A Breakout is a private or shared conversation inside a Thread.** Removed.
- **Rally is inherent in every Thread.** Becomes: Rally is inherent in every
  Canvas's Chat.
- **Every admitted automation run owns exactly one Thread.** Becomes: every run
  is a child of its Sidekick's shared conversation.
- **Connected activities … appear as an in-stream routing suggestion; Activity
  lists events about the viewer.** Open: with no streams, routing suggestions
  have no home, and Activity is removed. See Open questions.
- **Where structured elicitation appears.** Moves to the Canvas Chat tab and
  the Sidekick conversation.

The brief needs its own update once this PRD is approved.

## Decision log

None yet.

## Key design decisions

1. **Sidekicks move into the main window.** As one of only two sections, they
   need the same sidebar and shell as Canvases. Rejected: keeping the separate
   Sidekicks window, which would leave the main window with one section.
2. **A Canvas carries its own Chat with Rally.** With Threads gone, talking to
   Rally about shared work happens next to the Canvas, open to everyone in it.
   Rejected: a separate Rally conversation that links to Canvases, which brings
   back a Thread under another name.
3. **A Sidekick's output is a Canvas.** This links the two modes without a third
   concept. Rejected: Sidekick-only output (messages, files) that people cannot
   edit together.

## Security and trust model

Two trust boundaries change, and neither has a decided answer yet. Both block
the build:

- **Who can open a Canvas.** Today an artifact inherits the audience of the
  Thread that published it. With Threads gone, a Canvas needs its own access
  model: who can open it, who can invite, and how that interacts with the public
  per-artifact origin described in
  [live web artifacts](../../live-web-artifacts.md).
- **Whose access a shared Sidekick uses.** Today a Sidekick acts as anyone on
  its Delegation allowed list, using their current access
  ([Sidekick delegation](../2026-10-22_sidekick-delegation/prd.md)). Joining its
  conversation grants no delegation. Once anyone it is shared with can ask it
  things, the PRD must say whether a person who is not a delegate can have the
  Sidekick read, through a delegate's connector, something that person cannot
  read themselves.

## Agent behavior

- In a Canvas's Chat, Rally runs with the Canvas's current content and the
  Chat transcript as context. It edits the Canvas through typed tools that
  change part of it in place, so people see each edit land; republishing a whole
  directory is not how a Canvas changes.
- Rally's edits run without asking anyone first, per the
  [tool execution product policy](../../../CLAUDE.md#tool-execution-product-policy),
  and each one is attributed to Rally in the Canvas's history.
- A Sidekick acts within the access it already has, and asks people only for
  information it lacks.

The tool contract itself belongs in the build PRD.

## Rollout

Per [`docs/prds.md`](../../prds.md), the default is that this ships to everyone
on merge, with no flag. That default cannot hold until the open question on
existing data is answered, because shipping removes surfaces that hold users'
Threads and Breakouts. Whether to stage it behind a flag is an engineer's call
when the build starts.

The [Channels and Threads navigation](../2026-10-10_channels-threads-navigation/prd.md)
PRD is `in progress`. Its build stops when this PRD is approved, and its
`state.md` gains a supersession note in the same change.

## Open questions

1. **What happens to existing Threads, Breakouts and their transcripts?** Keep
   them read-only, export them, or convert them into Canvases. **Blocks the
   build**, because the answer decides whether shipping deletes user data.
2. **Who can open a Canvas, and whose access a shared Sidekick uses.** See
   Security and trust model. **Blocks the build.**
3. **Where connector routing suggestions go** once there are no streams to
   suggest routing into.
