---
title: The digest
description: Get a written summary, on the days and times you choose, of everything that moved since the last one.
---

[Notifications](04-notifications.md) tell you about the things aimed at you, the
moment they happen. The digest is the other half: a short written summary,
delivered when you choose, of everything that moved since your last one. It
reads like a morning paper about your own work, written for one reader and
without the crossword.

## What is in it

Rally writes each digest itself, looking at what happened since the previous
one:

- the Channels you are in,
- anything that tagged you,
- activity from your connected tools.

It puts the things that need you first. A digest by email arrives from **Rally
<notifications@rallywith.ai>** with a subject like "Your Juno Labs digest ·" followed by the
date, a preview line such as "2 need you · 7 updates in Juno Labs", a section
of items for you, and a button that opens Rally.

What it leaves out, on purpose:

- Private conversations between other people.
- Noise. Each connected tool holds back its own busy-work, such as every
  automated build check, so the digest stays readable.
- Quiet days. If nothing happened since the last one, Rally sends nothing. No
  "nothing to report" emails.

Your first digest looks back over the previous three days. After that, each
one starts where the last one ended.

Reading a digest does not mark anything as read in Rally. Your unread dots and
badges stay as they were.

## Setting it up

The digest is on from the start: weekdays at 9:00 AM in your own time zone, by
email to the address you sign in with. To change it, open **Settings →
Digest**.

1. **Send me a digest** turns it on or off. While it is on, the line under it
   says when the next one is due.
2. **Days.** Click a preset (**Every day**, **Weekdays** or **Weekends**), or
   click the individual day buttons, which run Sunday to Saturday.
3. **Times.** Type a time in the time box and click **Add time** (or press
   <kbd>Return</kbd>). Add as many as you like, up to 12 a day; each one has an
   × to remove it. The same times apply to every day you picked.
4. **Deliver to.** Turn on **Email**, which goes to your Rally account address,
   and any connected messaging service that can reach you. A Slack direct
   message appears here as **Slack DM ·** followed by the Slack connection's
   name.
5. Click **Save digest**.

This is the one corner of Settings with a save button. Everywhere else, changes
take effect as you make them. Here they wait until you click **Save digest**.

To be switched on, a digest needs at least one day, one time and one place to
go. If something is missing, Rally will not save it.

> [!TIP]
> For a digest at the start and the end of the day, add two times, say 8:30
> and 17:30. Each digest covers only what is new since the last one, so the
> afternoon edition will not repeat the morning's news.

## Time zones

Digest times use your own default time zone, the one in your account. The
**Times** section shows which zone that is, with a **Change in Account** link to
change it (see [The Settings window](../09-settings-and-shortcuts/01-the-settings-window.md)).
There is no separate time zone for the digest.

## Getting it in Slack

To have your digest arrive as a direct message from the Rally bot, two things
need to be true: Rally is [installed in your Slack
workspace](01-rally-in-slack.md), and you have linked your Slack account with
**Connect Rally**. Then a **Slack DM** switch appears under **Deliver to**.
Until then, a note under **Deliver to** suggests connecting a tool, like Slack,
that can message you.

You can pick only one destination of each kind. If you are in two Slack
workspaces that both have Rally, choose one of them.

If a destination stops accepting the digest, for example because a connection
was removed, Rally marks the digest as needing your attention instead of
failing quietly.

## One digest per Organization

You get one digest per Organization you belong to. If you are in two, each sends
its own, on its own schedule, and you set each one up in that Organization's
Settings.

On the iPhone you can turn the digest on and off and see its schedule. Changing
days, times and destinations happens on the Mac; see [iPhone
settings](07-iphone-settings-and-limits.md).

> [!NOTE]
> If you cannot find **Digest** in Settings, the digest has been turned off for
> your account or Organization by the Rally team.
