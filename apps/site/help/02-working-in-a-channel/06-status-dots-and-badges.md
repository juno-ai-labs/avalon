---
title: Status dots
description: Learn what each coloured dot and a bold name mean, so you know what needs you at a glance.
---

Once you have a few Threads going, the question stops being "what is Rally
doing?" and becomes "where am I needed?". Rally answers it with small coloured
dots. Learn them once and you can read your whole workload in
the time it takes to say "hang on, let me check".

## The dots

A status dot is a small coloured circle with a label beside it. It tells you one
thing about a Thread or a Breakout. There are eight:

| Colour | Label | It means |
| --- | --- | --- |
| Violet | **New to you** | Someone added you to this Thread and you have not opened it yet. |
| Pink | **You were mentioned** | Someone named you in a message you have not read. |
| Blue, gently pulsing | **Running** | Rally is working on it. |
| Amber | **Needs input** | Rally is waiting for you to answer a question. |
| Green | **Unread** | There are messages here you have not read. |
| Grey | **Latest run completed** | Rally finished, and nothing is running now. |
| Brown | **Latest run stopped** | Someone stopped the last run on purpose. |
| Red | **Needs intervention** | The last run failed. |

Blue is the only dot that moves. The exact shades shift a little between light
and dark mode, but the colours stay the same family. Rest your pointer on a dot
and Rally says what it means, so you never have to tell pink from violet by eye alone.

A run that is waiting its turn to start counts as **Running**.

## Where you see them

- **The Threads list.** Each Thread and Breakout in your **Threads** list carries
  one small dot at the start of its row. It shows the first dot that applies, in
  the order below, and leaves out **Latest run completed** and **Latest run
  stopped**, since a run that has ended needs nothing from you. Sort the list by
  **Needs attention** to bring the ones that want you to the top. See
  [Arranging your Threads](../03-spaces-and-breakouts/02-arranging-channels.md#sorting-the-threads-list).
- **The Threads button.** The red number on the **Threads** button at the left
  edge of the window counts the Threads that are new to you, mention you or
  have unread messages, plus anyone waiting for you to approve a request to
  join. The dock icon and the Mac menu bar show the same number.
- **A Thread's Breakouts.** In a Thread's menu, **Breakouts** puts a dot
  beside each one with something new. See
  [Breakouts](../03-spaces-and-breakouts/03-breakouts.md).

## When several things are true at once

A Thread can be running, unread and have mentioned you all at the same time,
but it only shows one dot. The first one that applies in this order wins:

1. New to you
2. You were mentioned
3. Running
4. Needs input
5. Unread
6. Latest run completed
7. Latest run stopped
8. Needs intervention

So a busy Thread where someone named you shows pink, not blue, because a
message addressed to you is more pressing than a Rally that is busy anyway. But
plain unread messages rank below a running Rally.

> [!NOTE]
> A failed run usually leaves an error you have not read yet, so the Thread
> first shows green **Unread**. It turns red **Needs intervention** once you have
> read it. If you see green on a Thread you expected to be busy, open it and
> look for a **Run failed** card (see
> [While Rally works](03-while-rally-works.md#when-a-run-fails)).

## A closer look at two of them

**New to you** lights up when someone adds you to a Thread: when they create it
with you in it, add you later, or confirm an @-mention that adds you. It goes
away the first time you open the Thread, and it never comes back for that
Thread. Later messages make it Unread instead. The exception is being removed
and then added again, which lights it afresh. You never see it on a Thread you made
yourself.

**You were mentioned** goes away once you have read past the message that named
you. A Thread's main conversation and each of its Breakouts keep track of
mentions separately.

## Bold names in the Threads list

A row with a dot has its name in bold, as in most mail apps. Open it and read,
and once nothing is left to tell you, the dot goes and the name goes back to
normal.

## Times in the sidebar

Each Channel in the **Channels** list shows when it last had activity, and each
item in **Activity** shows when it happened.
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
also turn up elsewhere: beside each Thread in a Channel's feed, in search results, and on a Sidekick's
page for its next run and its recent runs.

Next: give a Thread a name and a face, in [Names, icons and colours](07-name-icon-and-colour.md).
