---
title: The Sidekicks window
description: Browse every Sidekick you can see, check its runs, run it now, pause it, or archive it.
---

Sidekicks live in a window of their own, separate from the main Rally
window. It holds every Sidekick you are allowed to see, including drafts and
paused ones, and it is where you open a Sidekick to check on it or change it.

## Opening the window

There are two ways in.

- **The account menu.** Click your account at the bottom of the sidebar,
  then **Sidekicks**. The window title is **Rally Sidekicks**. Opening it
  again brings the same window to the front rather than starting a second
  one.
- **The hexagon strip.** Above your account at the bottom of the
  sidebar sits a row of hexagon tiles, one for each active Sidekick that is
  yours or the Organization's. Click a tile to open that Sidekick in the
  Sidekicks window. Hover over one to see its name.

A small play triangle at the bottom right of a tile means the Sidekick is
active. Hover over the triangle and Rally explains that it is in service and
waiting on its triggers. If you have more tiles than fit, scroll the strip
sideways. With the sidebar collapsed, the tiles shrink to small squares
without names.

The strip shows only active Sidekicks that belong to you or the
Organization. Drafts, paused Sidekicks and Channel Sidekicks never get a
tile; find those in the Sidekicks window or in the Channel's side panel. If
you have no active Sidekick yet, the strip shows a single dashed hexagon
labelled **New Sidekick** instead. Once you have one, that tile goes away and
you make new ones from the Sidekicks window.

## The library

The window opens on the library, headed **Sidekicks**, with the tagline "A
little help that knows how you work."

- **New Sidekick**, at the top right, starts a new one (see
  [Make a Sidekick](02-make-a-sidekick.md)).
- **Search Sidekicks** finds Sidekicks by name or description.
- The filter buttons **Everyone**, **Only you**, **Organization** and
  **Channels** narrow the list by who a Sidekick belongs to.

Below them is the list, titled **Your Sidekicks** (or **Search results**
while you search) with a count. Each row shows the Sidekick's hexagon, its
name, its description, and a short line saying what state it is in and who
it belongs to:

| First word | Meaning |
| --- | --- |
| **Draft** | Not yet published. Still being described. |
| **Paused** | Switched off for now. |
| **Available in conversations** | Instructions only. Rally can load it in conversations. |
| **Delegated work** | Has triggers and runs by itself. |

The second part is the scope: **Only you**, **Organization** or **Channel**.
Click a row to open the Sidekick.

If you have none yet, the list says **No Sidekicks yet**. If a search finds
nothing, it says **No matching Sidekicks**; try a different word or filter.
Press <kbd>Esc</kbd> to close the window. If the search box has text in it,
the first <kbd>Esc</kbd> clears the search and the second closes the window.

## A Sidekick's page

Opening a Sidekick shows its conversation with the drafting assistant beside
a details panel. A **< Sidekicks** link at the top takes you back to the
library. When the window is narrow, Rally shows one side at a time; use the
**Conversation** and **Details** switch at the top to flip between them.

The details panel shows:

- the hexagon (click it to change the icon and colour);
- the name;
- a lifecycle badge: **Draft**, **Active** or **Paused**;
- the scope badge: **Only you**, **Organization** or **Channel**;
- the description;
- the controls: **Pause** or **Resume**, and a **…** button with the rest;
- **When to expect it**: the triggers in plain words, and **Next** with how
  long until the next scheduled run, when there is one;
- **Make it work for you**, a reminder that you change the Sidekick by
  asking in the conversation;
- **Email this Sidekick**, if it has an email address (see
  [Triggers and schedules](03-triggers-and-schedules.md#email-a-sidekick)).

If an action fails, the error appears under the description.

## Run now

To start a run straight away, outside the schedule, click **…** → **Run
now**. It reads **Starting…** while Rally sets the run going. There is no "are
you sure?"; the run starts. This is the quickest way to test a Sidekick you
have made, rather than waiting until Monday to find out it misunderstood you.

**Run now** works only when the Sidekick is **Active** and has at least one
trigger. It is greyed out on drafts and paused Sidekicks, and missing
altogether on instructions-only Sidekicks, which have nothing to run.

## Run history

Click **…** → **Run history** to see the Sidekick's runs, newest first. The
dialog is subtitled "Technical details for troubleshooting this Sidekick."

Each row shows:

- a status dot, coloured the same way as elsewhere in Rally (see
  [Status dots and badges](../02-working-in-a-channel/06-status-dots-and-badges.md));
- how the run started: **Manual**, **Scheduled**, **Event** or **Email**;
- a short summary of the result, or "Running" with how long it has been
  going, or when it finished;
- a status badge, such as **Running**, **Needs input**, **Latest run
  completed** or **Latest run stopped**.

If there have been no runs yet the dialog says **No runs yet**. If it says
**Could not load runs**, close it and try again in a moment.

Some things to know:

- **Run history is a summary.** Each run is its own conversation, visible
  only to the person the Sidekick runs as. The history shows how each run
  went, not the whole conversation.
- **A run can wake up again.** If someone replies to something a run posted,
  such as a Slack thread it started, the same run carries on. It keeps one
  row in the history.
- **Runs are quiet in the sidebar.** A run does not add a row to your
  sidebar, an unread dot, or a notification of its own. You see its work
  where it posts it (see [Where a Sidekick's results go](05-where-results-go.md)).

The **Run history** item appears only once the Sidekick has triggers or has
already run.

## Pause and Resume

Click **Pause** on an active Sidekick to switch it off without losing it. The
badge changes to **Paused** straight away. Pausing:

- stops any run that is in progress;
- cancels its schedules;
- stops it listening for events;
- makes it refuse email.

Click **Resume** to switch it back on. A resumed Sidekick picks up from now.
It does not catch up on the runs it would have made while paused, and it
ignores events that happened in the meantime. A Sidekick on holiday does not
come back with a fortnight of postcards.

A paused Sidekick shows **Paused** in the library and in Channel side panels,
and its tile leaves the sidebar strip until you resume it.

If you archive the Channel or Breakout that owns a Channel Sidekick, Rally
pauses that Sidekick for you, and it cannot be resumed while the room stays
archived. Unarchiving the room resumes it again, but only if the archive was
what paused it. A Sidekick a person paused stays paused.

## Archive

When you no longer need a Sidekick, click **…** → **Archive Sidekick** (or
**Archive draft** for a draft). Rally asks you to confirm: the Sidekick will
be removed from your Sidekicks and its schedules will stop, and its
conversation and run history will stay stored but can no longer be viewed.
Click **Archive** to go ahead, or **Cancel**. You land back in the library.

> [!WARNING]
> There is no way to unarchive a Sidekick. Once archived, it is gone from the
> library for good, there is no list of archived Sidekicks, and you cannot
> open its conversation or run history again. If you might want it back,
> **Pause** it instead.

Archiving also stops any runs in progress. If the Sidekick had an email
address, that address is retired and will not be given to anyone else.

## Copy a link to a Sidekick

To send a teammate straight to a Sidekick, click **…** → **Copy sidekick
link** and paste the link wherever you like. Opening it in the Rally app
opens that Sidekick's page.

The link only works for people in the same Organization who are allowed to
see the Sidekick. A teammate cannot open your **Only you** Sidekick, however
nicely you send the link. If copying fails, Rally says **The Sidekick link
could not be copied.**

## Pausing, archiving and changing need permission

Pause, Resume, Archive and changes to the icon or colour need permission to
manage the Sidekick. Who has it depends on the scope, as set out in
[What a Sidekick is](01-what-a-sidekick-is.md#who-a-sidekick-belongs-to).

## On iPhone

The iPhone app has a **Sidekicks** tab that lists the Sidekicks you can see,
each with a status word and its description. Tap one to open its
conversation. Making, pausing and archiving Sidekicks happens on the Mac.
See [Rally on your iPhone](../08-rally-everywhere/06-rally-on-iphone.md).
