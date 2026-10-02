---
title: Status dots
description: Learn what each coloured dot and a bold name mean, so you know what needs you at a glance.
---

Once you have a few Channels going, the question stops being "what is Rally
doing?" and becomes "where am I needed?". Rally answers it with small coloured
dots. Learn them once and you can read your whole workload in
the time it takes to say "hang on, let me check".

## The dots

A status dot is a small coloured circle with a label beside it. It tells you one
thing about a Channel or a Breakout. There are eight:

| Colour | Label | It means |
| --- | --- | --- |
| Violet | **New to you** | Someone added you to this Channel and you have not opened it yet. |
| Pink | **You were mentioned** | Someone named you in a message you have not read. |
| Blue, gently pulsing | **Running** | Rally is working on it. |
| Amber | **Needs input** | Rally is waiting for you to answer a question. |
| Green | **Unread** | There are messages here you have not read. |
| Grey | **Latest run completed** | Rally finished, and nothing is running now. |
| Brown | **Latest run stopped** | Someone stopped the last run on purpose. |
| Red | **Needs intervention** | The last run failed. |

Blue is the only dot that moves. The exact shades shift a little between light
and dark mode, but the colours stay the same family. On a Space's page the label
sits next to the dot, so you never have to tell pink from violet by eye alone.

A run that is waiting its turn to start counts as **Running**.

## Where you see them

- **The sidebar.** A Channel's row carries one small dot at its start. It shows
  the first dot that applies, in the order below, and leaves out **Latest run
  completed**, since a finished run needs nothing from you. A Breakout that
  needs you counts on its Channel's row.
- **A Space's page.** The **Needs attention** list on a Space's page shows a dot
  and its label beside every Channel and Breakout that wants you. That page is
  described in [Spaces](../03-spaces-and-breakouts/01-spaces.md).
- **A Channel's Breakouts.** In a Channel's menu, **Breakouts** puts a dot
  beside each one with something new. See
  [Breakouts](../03-spaces-and-breakouts/03-breakouts.md).

## When several things are true at once

A Channel can be running, unread and have mentioned you all at the same time,
but it only shows one dot. The first one that applies in this order wins:

1. New to you
2. You were mentioned
3. Running
4. Needs input
5. Unread
6. Latest run completed
7. Latest run stopped
8. Needs intervention

So a busy Channel where someone named you shows pink, not blue, because a
message addressed to you is more pressing than a Rally that is busy anyway. But
plain unread messages rank below a running Rally.

> [!NOTE]
> A failed run usually leaves an error you have not read yet, so the Channel
> first shows green **Unread**. It turns red **Needs intervention** once you have
> read it. If you see green on a Channel you expected to be busy, open it and
> look for a **Run failed** card (see
> [While Rally works](03-while-rally-works.md#when-a-run-fails)).

## A closer look at two of them

**New to you** lights up when someone adds you to a Channel: when they create it
with you in it, add you later, or confirm an @-mention that adds you. It goes
away the first time you open the Channel, and it never comes back for that
Channel. Later messages make it Unread instead. The exception is being removed
and then added again, which lights it afresh. You never see it on a Channel you made
yourself.

**You were mentioned** goes away once you have read past the message that named
you. A Channel's main conversation and each of its Breakouts keep track of
mentions separately.

## Bold names in the sidebar

A Channel with something you have not read has its name in bold in the sidebar,
as in most mail apps. A Breakout waiting on you makes its Channel bold too, so
nothing hides one level down. Open it and read, and the name goes back to
normal.

## Times in the sidebar

Each Channel in the sidebar shows when it last had activity.
These times read like a calendar rather than a stopwatch:

- A clock time for today, such as **3:42 PM**.
- **Yesterday**.
- A weekday, such as **Tuesday**, for the last few days.
- A short date, such as **Sep 3**, for anything older.

They update themselves too, so **3:42 PM** turns into **Yesterday** after
midnight without you doing anything. The format follows your Mac's language and
region.

The same self-updating times you met on messages (see
[People in the room](05-people-in-the-room.md#times-that-keep-themselves-current))
also turn up elsewhere: at the end of each row on a Space's page, in search results, and on a Sidekick's
page for its next run and its recent runs.

Next: give a Channel a name and a face, in [Names, icons and colours](07-name-icon-and-colour.md).
