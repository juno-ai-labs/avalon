---
title: Status dots and badges
description: Learn what each coloured dot and number badge means, so you know what needs you at a glance.
---

Once you have a few Channels going, the question stops being "what is Rally
doing?" and becomes "where am I needed?". Rally answers it with small coloured
dots and number badges. Learn them once and you can read your whole workload in
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
and dark mode, but the colours stay the same family. The label always sits next
to the dot, so you never have to tell pink from violet by eye alone.

A run that is waiting its turn to start counts as **Running**.

## Where you see them

- **The Channel's header.** Under the Channel's name, a dot and label show what
  Rally is doing in this Channel right now.
- **A Space's page.** The **Needs attention** list on a Space's page shows a dot
  beside every Channel and Breakout that wants you. That page is described in
  [Spaces](../03-spaces-and-breakouts/01-spaces.md).

The sidebar on the left does not use dots. It uses number badges, explained
below.

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

The Channel header does not use this order. You are already reading the
Channel, so the header only shows what the run is doing: **Running**, **Needs
input**, **Latest run completed**, **Latest run stopped** or **Needs
intervention**. It never says Unread, You were mentioned or New to you.

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

## The number badges in the sidebar

Each Channel in the left sidebar can carry a small number. It counts how many
conversations in that Channel need you: the main conversation counts as one,
and each Breakout counts as one more. (Screen readers announce it as, for
example, "2 conversations need attention".)

The badge counts conversations, not messages. A Breakout with one unread
message and a Breakout with fifty both count as one. A conversation counts when
it is **Running**, **Needs input**, **Unread**, **You were mentioned** or **New to
you**.

A failed, stopped or completed run that you have already read does not add to
the badge. To spot a failure, look at the Channel's header or the Space page.

## Times in the sidebar

When a Channel in the sidebar has something new, it shows when that happened.
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
