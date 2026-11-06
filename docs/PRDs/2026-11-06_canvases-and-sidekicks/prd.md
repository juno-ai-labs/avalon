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

Most of the change is removal. Everything a person used Channels, Threads and
Breakouts for is either a Canvas (a shared thing to work on) or a Sidekick (a
shared agent to ask).

## Motivation

The team decided to pivot to these two modes. The evidence behind that decision
is not recorded here yet; the team should add it before this PRD is approved.

## Goals

1. The section rail shows exactly two sections, Canvases and Sidekicks, on
   macOS and web.
2. A person can see, from the sidebar, which Canvases have people in them now
   and which Sidekicks need an answer from them.
3. Several people and Rally can edit one Canvas at once and see each other's
   cursors, selections and pending edits.
4. Several people can talk to one Sidekick in one shared conversation.
5. A Sidekick's output that people work on afterwards is a Canvas, reachable
   from both the Sidekick conversation and the Canvases list.

## Non-goals

1. **iOS.** Deferred; iOS is a prototype and follows once desktop and web ship.
2. **A grouping layer above Canvases and Sidekicks** (folders, teams,
   Channels). Rejected for now; sharing is per Canvas and per Sidekick.
3. **A separate notification inbox.** Rejected; unread dots, "Needs input" and
   rail badges carry what Activity did.
4. **Migrating every Thread's transcript into a Canvas.** Not decided. How
   existing Threads and Breakouts are kept, exported or archived needs its own
   decision.

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
- **Sidekicks sidebar.** Needs you, then Pinned, then all Sidekicks. Rows show
  the hexagon mark and current state (working, next run, paused).
- **Sidekicks home.** Today's library, moved into the main window, as rows with
  status, who it is shared with, and when it next wakes.
- **Sidekick open.** One shared conversation, with runs as collapsed rows and
  Canvases as cards. The details column keeps today's Sidekick page (status,
  Pause, delegation, schedule) and adds triggers, tools and the Canvases it
  writes to.

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

This changes the contract. The brief's model of work streams as the unit of
work, and the Channel and Thread navigation built on it, are replaced by two
units: the Canvas and the Sidekick. The brief needs its own update once this
PRD is approved.

## Decision log

None yet.
