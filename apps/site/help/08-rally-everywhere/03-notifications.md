---
title: Activity and notifications
description: The Activity list of what happened to you, and how each kind reaches you by push or email.
nav_title: Activity and notifications
---

Rally keeps one list of the things that happened to you, called Activity, and
it can also tell you about each of them by push or email. The list and
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

If the list is empty when you open Activity, the main pane shows **No
activity yet**. Back returns to the Canvas or Sidekick you were viewing.

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

- **Push** alerts every browser and desktop app where you are signed in and
  have notifications on.
- **Email** goes to your account's address, from **Rally
  <notifications@rallywith.ai>**, with an **Open in Rally** button.
Everything starts on **Push**. With **Off**, that kind still shows in
Activity, but nothing is sent. Notifications do not go to Slack.

Notification text is plain: formatting is removed and mentions appear as
**@Name**. A newer reply in the same conversation replaces the alert before it
rather than stacking up.

## Notifications in your browser

Open **Settings → Notifications**. At the top, under **In this browser**, the
**Show notifications** switch turns alerts in this browser on or off. Your
choices under **Notify me about** still apply to your other devices.

- The first time you turn it on, your browser asks whether Rally may show
  notifications. Say yes. If you said no, the switch is greyed out and the page
  says **Blocked for this site**. Allow notifications for Rally in your
  browser's site settings, then turn the switch on.
- Alerts can arrive when no Rally tab is open, as long as your browser can
  receive them.
- Click an alert and Rally opens the exact Canvas or Sidekick it is about.
- If the page says **Not available in this browser**, this browser cannot show
  Rally's notifications. Try another one, or use email.

The switch belongs to this browser on this computer. Turn it on in each browser
where you want alerts.

### On an iPhone or iPad

Safari sends notifications only to websites added to the Home Screen, so in an
ordinary Safari tab the page says **Add Rally to your Home Screen**.

1. In Safari, tap Share, then **Add to Home Screen**.
2. Open Rally from the new icon on your Home Screen and sign in there.
3. Open **Settings → Notifications** and turn on **Show notifications** under
   **In this browser**.

### The number on the app icon

If you added Rally to your Home Screen, or installed it as an app from your
browser, its icon can carry a badge: the Activity rows you have not seen yet,
the same number as the **Activity** button on the rail.

## Notifications in the desktop app

In the [desktop app](04-the-desktop-app.md) on a Mac, the switch sits under
**On this Mac** instead. It works the same way, and it is on unless you turn it
off. The Linux app cannot show notifications; keep a browser tab signed in, or
choose email, if you want alerts there.

- Alerts arrive even when the app is closed.
- On a Mac, the first time, macOS asks whether Rally may send notifications. If
  you said no, the settings page says **Turned off in macOS** with an **Open
  System Settings** button to change your mind. If notifications are allowed
  but badges are not, it says **Badges turned off in macOS**.
- On a Mac, Rally's icon in the Dock carries the same badge as above. Rally
  keeps it up to date while it is running, for the Organization you have open,
  and an alert that arrives while Rally is closed sets it to that alert's count,
  so the number is waiting when you come back.

> [!NOTE]
> The macOS permission prompt, and a few other system messages, may still say
> "workspace". That is Rally's old word for an Organization.

If there is no **In this browser** or **On this Mac** switch at all, push
notifications have not been switched on for your account yet, and **Push** is
not offered; Activity and email still work.

## The small print

- Turning the switch off, or refusing permission, takes that device off the
  list. Rally does not send an email instead unless you chose email.
- Signing out stops notifications to that browser or computer until you sign
  in there again.
- If your device is off or offline, alerts are held for up to 24 hours.
- Now and then the same alert can arrive twice. Rally would rather tell you
  twice than not at all.
- After an alert about replies in a conversation, Rally waits a couple of
  minutes before alerting you about that conversation again. Its Activity row
  keeps moving meanwhile.
- Rally no longer sends a daily digest. Activity is the place to catch up.

Next: [The desktop app](04-the-desktop-app.md).
