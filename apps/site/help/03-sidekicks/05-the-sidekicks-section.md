---
title: The Sidekicks section
description: Browse every Sidekick shared with you, see what each is doing, run it now, pause it, or archive it.
---

Sidekicks have a section of their own in the main window, beside Canvases.
Click **Sidekicks** in the rail and the sidebar lists every Sidekick shared
with you, including drafts and paused ones. This is where you open a Sidekick
to check on it, talk to it or change it.

## The sidebar

The sidebar has three groups:

- **Needs input** holds the Sidekicks waiting for something only a person can
  give them. Each row shows the question, such as **Which status page gets the
  update?**. Click it to answer.
- **Pinned** holds the Sidekicks you pinned. Drag a Sidekick in to pin it, or
  right-click a row and choose **Pin** or **Unpin**.
- **All sidekicks** lists the rest, the most recently active first.

Each row shows the Sidekick's hexagon, its name and a line saying what it is
doing: **Working · 4 tickets**, **Runs Friday 2:00 PM**, **No changes this
week**, or **Paused by Theo**. A bold name and a red dot mean something new in
its conversation since you last looked.

## The home page

The Sidekicks home page, headed **Sidekicks**, shows every Sidekick on one page.

- **New Sidekick** starts a new one (see [Make a Sidekick](02-make-a-sidekick.md)).
- **Search** finds Sidekicks by name or description.
- The filter chips **Everyone**, **Only you**, **Organization** and **Paused**
  narrow the list.

Below them is the list, titled **Your Sidekicks** (or **Search results**
while you search) with a count. Each row shows the Sidekick's hexagon, its
name, its description, its **Status** (such as **Active**, **Working**,
**Needs input** or **Paused**), who it is **Shared with**, and when it wakes
up **Next**: a time, or **On alert** or **On email** for one that waits for an
event. Click a row to open the Sidekick.

If you have none yet, the list says **No Sidekicks yet**. If a search finds
nothing, it says **No matching Sidekicks**; try a different word or filter.

## A Sidekick's page

Opening a Sidekick shows its shared conversation, covered in
[Talking to a Sidekick](03-the-shared-conversation.md), beside a details
column. The people the Sidekick is shared with show as faces at the top. When
the window is narrow, Rally shows one side at a time; use the
**Conversation** and **Details** switch at the top to flip between them.

The details column shows:

- the hexagon (click it to change the icon and colour);
- the name and description;
- a lifecycle badge: **Draft**, **Active** or **Paused**;
- who it is shared with, such as **Shared · 3 people**, with **Share** to
  change it;
- the controls: **Pause** or **Resume**, always visible beside the **…** button
  with the rest. Unavailable controls and menu items stay visible but disabled;
  hover or focus them for an explanation. Drafts must finish setup in the
  conversation first;
- **Delegation allowed**, the people the Sidekick may act as (see
  [Tools and delegation](06-tools-and-delegation.md));
- **When to expect it**, always visible: the triggers in plain words, and
  **Next** with how long until the next scheduled run, when there is one.
  With neither available, it says **No timing details yet.**
- its tools, including any custom tools of its own;
- the Canvases it writes to, each of which opens the Canvas;
- **Email this Sidekick**, if it has an email address (see
  [Triggers and schedules](04-triggers-and-schedules.md#email-a-sidekick)).

If an action fails, the error appears under the description.

## Run now

To start a run straight away, outside the schedule, click **…** → **Run
now**. It reads **Starting…** while Rally sets the run going. There is no "are
you sure?"; the run starts and its row appears in the conversation. This is
the quickest way to test a Sidekick you have made, rather than waiting until
Monday to find out it misunderstood you.

**Run now** works only when the Sidekick is **Active** and has at least one
trigger. The item is always visible and is greyed out when unavailable,
including on drafts, paused Sidekicks and instructions-only Sidekicks.

You can also ask for a run in the conversation, in words. That works on any
active Sidekick, and the run uses your own access unless you are on its
Delegation allowed list.

## Run history

Click **…** → **Run history** to see the Sidekick's runs, newest first. The
dialog is subtitled "Technical details for troubleshooting this Sidekick."

Each row shows:

- a status dot, coloured the same way as elsewhere in Rally (see
  [Status dots and badges](../02-canvases/10-status-dots-and-badges.md));
- how the run started: **Manual**, **Scheduled**, **Event** or **Email**;
- a short summary of the result, or "Running" with how long it has been
  going, or when it finished;
- a status badge, such as **Running**, **Needs input**, **Latest run
  completed** or **Latest run stopped**.

If there have been no runs yet the dialog says **No runs yet**. If it says
**Could not load runs**, close it and try again in a moment.

Run history is a summary for troubleshooting. To read what a run actually did,
unfold its row in the Sidekick's conversation.

A run can wake up again. If someone replies to something a run posted, such as
a Slack thread it started, the same run carries on, and it keeps one row in
the history.

Runs do not get rows of their own in the sidebar. A finished run marks the
Sidekick as unread, and a run that needs input moves the Sidekick into
**Needs input**. You see a run's work in the conversation, and anywhere else it
posts it (see [Where a Sidekick's results go](07-where-results-go.md)).

The **Run history** item is always visible. It is disabled until the Sidekick
has triggers or has already run.

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

A paused Sidekick shows **Paused by** whoever paused it in the sidebar, and
**Paused** on the home page, until someone resumes it.

## Archive

When you no longer need a Sidekick, click **…** → **Archive Sidekick** (or
**Archive draft** for a draft). Rally asks you to confirm: the Sidekick will
be removed from your Sidekicks and its schedules will stop, and its
conversation and run history will stay stored but can no longer be viewed.
Click **Archive** to go ahead, or **Cancel**. You land back on the Sidekicks home page.

> [!WARNING]
> There is no way to unarchive a Sidekick. Once archived, it is gone from the
> Sidekicks section for good, there is no list of archived Sidekicks, and you cannot
> open its conversation or run history again. If you might want it back,
> **Pause** it instead.

Archiving also stops any runs in progress. If the Sidekick had an email
address, that address is retired and will not be given to anyone else.

## Copy a link to a Sidekick

To send a teammate straight to a Sidekick, click **…** → **Copy sidekick
link** and paste the link wherever you like. Opening it in the Rally app
opens that Sidekick's page.

The link only works for people in the same Organization who are allowed to
see the Sidekick. A teammate cannot open your **Only you** Sidekick from a
link. If copying fails, Rally says **The Sidekick link
could not be copied.**

## Pausing, archiving and changing need permission

Pause, Resume, Archive and changes to the icon or colour need permission to
manage the Sidekick. Who has it is set out in
[What a Sidekick is](01-what-a-sidekick-is.md#who-a-sidekick-is-shared-with).

Next: [Tools and delegation](06-tools-and-delegation.md), for what a Sidekick can use and whose access it runs with.
