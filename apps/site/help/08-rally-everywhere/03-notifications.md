---
title: Activity and notifications
description: The Activity list of what happened to you, and how each kind reaches you by push, email or Slack.
nav_title: Activity and notifications
---

Rally keeps one list of the things that happened to you, called Activity, and
it can also tell you about each of them by push, email or Slack. The list and
the alerts come from the same place, so an alert is never about something your
Activity does not show.

## Activity

Click **Activity** in the rail. The sidebar lists, newest first:

| Row | When |
| --- | --- |
| **Maya mentioned you in** a Canvas or Sidekick | Someone @mentions you. |
| **Maya in** a Canvas or Sidekick, with the message under it | Someone replies in a conversation you take part in. A busy conversation stays one row, moved up to the newest reply, until you look. |
| **Maya added you to** a Canvas | Someone added you to a Canvas's conversation. |
| **Maya updated** an artifact **in** a Canvas | Someone made a new version of an artifact in a Canvas you pinned. |
| A Sidekick **needs your input**, with its question | A run you asked for, or of a Sidekick you manage, is waiting for an answer. |
| A Sidekick **finished a run** | A run you asked for has finished. |
| **Maya asked to open** a Canvas | Someone wants into a Canvas whose people you decide on. **Approve** and **Deny** sit under the row. |
| **Maya let you into** a Canvas | Your request to open a Canvas was approved. |

Rally's own replies do not make rows: a Canvas Rally answered in shows as
unread in the Canvases list instead. A run a schedule, an event or an email
started has nobody who asked for it, so its finish shows as unread on the
Sidekick rather than in anyone's Activity.

A row you have not seen is bright, with a red dot, and the **Activity** button
on the rail counts them. Click a row to go where it happened: a mention or a
reply opens the Canvas at that message, a new version opens the Canvas with
that artifact, and a Sidekick's row opens its conversation, or the run that is
waiting. The Activity list stays open beside it, so the next row is a click
away.

A row clears when you open the conversation it is about, so reading a Canvas
clears its rows whichever way you got there. **Mark all seen**, the tick at the
top of the list, clears the rest. Once an access request has been answered,
its row says who approved or denied it.

When there is nothing yet, the list says **Nothing yet. Mentions, replies,
Canvases you are added to and Sidekick runs that need you or finish show up
here.**

## Choosing how each kind reaches you

Open **Settings → Notifications**. Under **Notify me about**, each kind has a
row with a button for each way Rally can reach you:

| Row | Covers |
| --- | --- |
| **Mentions** | When someone mentions you. |
| **New messages** | When someone replies in a Canvas you take part in. |
| **Being added** | When someone adds you to a Canvas, or lets you into one you asked to open. |
| **Sidekick runs** | When a Sidekick run you asked for finishes, or a run you asked for or a Sidekick you manage needs your input. |
| **Pinned Canvas updates** | When someone makes a new version of an artifact in a Canvas you pinned. |
| **Access requests** | When someone asks to open a Canvas whose people you manage. |

Click a button to turn that way on or off; a dark button is on. Choose any mix,
or none. When the window is narrow, each row shows one button naming what is
on, such as **Push and Email**, or **Off** with none; click it for a list you
can tick. Your choices apply on every device in that Organization.

- **Push** alerts every Mac and browser where you are signed in and have
  notifications on.
- **Email** goes to your account's address, from **Rally
  <notifications@rallywith.ai>**, with an **Open in Rally** button.
- **Slack** is a direct message from the Rally app. It appears once Rally is
  [installed in your Slack workspace](01-rally-in-slack.md); until you link your
  own Slack account, Rally finds you by your email address.

Everything starts on **Push**, and **Mentions** and **Being added** also start
on **Slack**. With **Off**, that kind still shows in Activity, but nothing is
sent.

> [!NOTE]
> Email and Slack are sent today for **Mentions** and for being added to a
> Canvas. For the other kinds, only push is sent, even if the menu has email
> or Slack ticked.

Notification text is plain: formatting is removed and mentions appear as
**@Name**. A newer reply in the same conversation replaces the alert before it
rather than stacking up.

## Notifications on your Mac

Open **Settings → Notifications**. At the top, under **On this Mac**, the
**Show notifications** switch turns alerts on this Mac on or off. It is on
unless you turn it off, and your choices under **Notify me about** still apply
to your other devices.

- Alerts arrive even when Rally is closed.
- Click an alert and Rally opens the exact Canvas or Sidekick it is about.
- The first time, macOS asks whether Rally may send notifications. If you said
  no, the settings page says **Turned off in macOS** with an **Open System
  Settings** button to change your mind. If notifications are allowed but
  badges are not, it says **Badges turned off in macOS**.

> [!NOTE]
> The macOS permission prompt, and a few other system messages, may still say
> "workspace". That is Rally's old word for an Organization.

In a web browser the same switch sits under **In this browser**; see [Rally in
a web browser](04-rally-in-a-browser.md). If there is no **On this Mac** or
**In this browser** switch at all, push notifications have not been switched on
for your account yet, and **Push** is not offered; Activity, email and Slack
still work.

### The number on the app icon

Rally's icon in the Dock carries a badge: the Canvases with something new for
you plus the Sidekicks waiting for you, the same count as the **Canvases** and
**Sidekicks** buttons on the rail added together. Activity's own count is not
included. Each Canvas or Sidekick counts once, however much has happened in
it. Rally keeps the badge up to date while it is running, for the Organization
you have open. An alert that arrives while Rally is closed clears the badge
rather than setting it, so after a day away the icon may show no number until
you open Rally again.

## The small print

- Turning the switch off, or refusing permission, takes that device off the
  list. Rally does not send an email instead unless you chose email.
- Signing out of Rally on a Mac stops notifications to that Mac.
- If your device is off or offline, Apple holds alerts for up to 24 hours.
- Now and then the same alert can arrive twice. Rally would rather tell you
  twice than not at all.
- After an alert about replies in a conversation, Rally waits a couple of
  minutes before alerting you about that conversation again. Its Activity row
  keeps moving meanwhile.
- Rally no longer sends a daily digest. Activity is the place to catch up.

Next: [Rally in a web browser](04-rally-in-a-browser.md).
