---
title: Status dots and badges
description: Learn what bold names, red dots, green dots, Needs input and the numbers on the rail mean, so you know what needs you at a glance.
---

Once you have a few Canvases and Sidekicks going, the question stops being
"what is Rally doing?" and becomes "where am I needed?". Rally answers it with
a few small marks. Learn them once and you can read your whole workload in the
time it takes to say "hang on, let me check".

## In the Canvases list

| Mark | It means |
| --- | --- |
| Bold name and a red dot | Something is new since you last opened it: a message, a new version, or a mention of you. |
| Green dot and names, such as **Maya is here** | Those people have the Canvas open right now. |
| **Edited by** a name | Nobody else is in it now; this is who changed it last. |
| **Made by** a name | Nobody has changed it since it was made. |

Opening a Canvas and reading to the bottom clears its red dot and bold name.

## In the Sidekicks list

| Mark | It means |
| --- | --- |
| The **Needs input** group | The Sidekick is waiting for something only a person can give it. Its row shows the question. |
| **Working** | A run is going on right now. |
| **Runs Friday 2:00 PM**, or another time | Nothing is running; this is when it starts next. |
| **Last run** and a time | It has no next run scheduled; this is when it last ran. |
| **Paused** | Someone paused it. It does nothing until someone resumes it. |
| **Active** | It is on, with no next run scheduled and no run yet. |
| **Draft** | It is still being set up. |
| Bold name and a red dot | Something new in its conversation, such as a finished run or a message from a teammate. A Sidekick under **Needs input** keeps its red dot until the question is answered. |

"Needs input" always means missing information, such as which Slack channel to
post to or a sign-in that has expired. It never means a Sidekick is waiting for
someone to approve a tool. Rally does not ask anyone to approve its tool calls.

## The numbers on the rail

The red number on the **Canvases** button counts the Canvases with something new
for you. The number on **Sidekicks** counts the Sidekicks waiting for you: those
that need input, and those with something new. Each Canvas or Sidekick counts
once, however much has happened in it. Rally's icon in the Dock and the Mac
menu bar show those two added together.

The number on **Activity** counts the Activity rows you have not seen. It is
not added to the Dock or the menu bar. Opening the Canvas or Sidekick a row is
about clears that row, and **Mark all seen** at the top of the Activity list clears the rest.

## Inside a Sidekick's conversation

Each run of a Sidekick is a row in its conversation, such as **Run 6 · On
request · Done · 3 steps**: its number, what started it, where it stands, and
how many steps it has taken. The state reads:

| State | It means |
| --- | --- |
| **Starting** | The run has been asked for and is about to begin. |
| **Working**, with a green dot | The run is going now. |
| **Needs input** | The run is waiting for an answer, which you can give on the row. |
| **Done** | It finished. |
| **Stopped** | Someone stopped it. |
| **Failed** | It could not finish. |

> [!NOTE]
> A failed run in a Canvas leaves a **Run failed** card you have not read yet,
> so the Canvas shows as unread. If you see a red dot on a Canvas you expected
> to be busy, open it and look for the card (see
> [While Rally works](04-while-rally-works.md#when-a-run-fails)).

## Times in the sidebar

Each row in the sidebar shows when it last had activity. These times read like
a calendar rather than a stopwatch:

- A short time for the last hour or so, such as **2m** or **32m**.
- **1h**, **3h** and so on later today.
- A weekday, such as **Tue**, for the last few days.
- A short date, such as **Oct 30**, for anything older.

They update themselves, so a time moves on without you doing anything. The
format follows your Mac's language and region.

Next: finding things again, in [Search and links](11-search-and-links.md).
