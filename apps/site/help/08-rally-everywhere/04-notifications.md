---
title: Notifications
description: Get told on your Mac or iPhone when someone mentions you or adds you to a Channel.
---

Rally does not ping you about everything. It notifies you in exactly two
situations:

- Someone **@mentions you** in a Channel or a Breakout.
- Someone **adds you to a Channel**. (If you created the Channel yourself,
  Rally assumes you already know.)

That is the whole list. Rally finishing a job, a teammate posting, a Sidekick
running: none of those send you a notification. For those, look at the
[status dots and badges](../02-working-in-a-channel/06-status-dots-and-badges.md)
in the app, or let the [digest](05-the-digest.md) round them up for you.

## How a notification reaches you

Rally tries the quickest route it has for you, in this order:

1. **Slack.** If Rally is installed in your Slack workspace, you get a direct
   message from the Rally bot, such as “Sam mentioned you in ‘Q3 plan’” or “Sam
   added you to ‘Q3 plan’”, with an **Open in Rally** link.
2. **Your Mac and iPhone.** If you have turned on notifications on a Mac or an
   iPhone, it gets an alert as well. One mention can reach Slack and your phone
   at the same time.
3. **Email, as a last resort.** Only if neither Slack nor a device took the
   notification, Rally emails you from **Rally <notifications@rallywith.ai>**,
   with a subject such as "Sam mentioned you in Q3 plan" and an **Open in Rally**
   link. You can reply to that email to post into the Channel, as
   [Email into Rally](03-email-into-rally.md#replying-to-a-notification-email)
   explains.

For Slack, Rally sends the message to the Slack account you linked with
**Connect Rally** (see [Rally in Slack](01-rally-in-slack.md#linking-your-slack-account-with-connect-rally)).
If you have not linked one, Rally looks for a single Slack account whose email
address exactly matches your Rally sign-in. If it finds none, or more than one,
you get email instead. Linking your account removes the guesswork.

Notification text is plain: formatting is removed and mentions appear as
**@Name**.

## Notifications on your Mac

Open **Settings → Notifications**. Under **On this Mac** there is one switch:
**Notify me on this Mac about mentions and additions**. It is on unless you
turn it off.

- Alerts arrive even when Rally is closed.
- Click an alert and Rally opens the exact Channel or Breakout it is about.
- Alerts are grouped by Channel, with its Breakouts in the same group, so a
  busy Channel does not bury the others.
- The first time, macOS asks whether Rally may send notifications. If you said
  no, the settings page says **Notifications are turned off in macOS.** with an
  **Open System Settings** button to change your mind.

> [!NOTE]
> The macOS permission prompt, and a few other system messages, may still say
> "workspace". That is Rally's old word for an Organization.

If you cannot find **Notifications** in Settings at all, notifications have not
been switched on for your account yet. Your teammates will have to keep
mentioning you the old-fashioned way, loudly, across the office.

### The number on the app icon

Rally's icon in the Dock carries a badge: the number of Channels in your
Organization that are unread or waiting for your input. Each Channel counts once,
however many messages it has. If you belong to several Organizations, the badge
shows the count for whichever one notified you most recently, not a total.

## Notifications on your iPhone

The [iPhone app](06-rally-on-iphone.md) sends the same alerts. Tap your avatar
at the top left of the **Channels** tab to open Settings, and use **Notify me on
this iPhone about mentions and additions** under **Notifications**. Tap an alert
and the app opens that Channel or Breakout.

If you turned notifications off for Rally in iOS, the switch says
**Notifications are turned off in iOS Settings.** with an **Open Settings**
button.

## Things to know

- Turning the switch off, or refusing permission, takes that device off the
  list, so Rally can fall back to email for you instead.
- Signing out of Rally on a Mac stops notifications to that Mac.
- If your device is off or offline, Apple holds alerts for up to 24 hours.
- Very occasionally the same alert can arrive twice. Rally would rather tell you
  twice than not at all.
- There is no setting to choose between mentions and additions. You get both
  or, by turning the switches off, neither.

## Notifications or the digest?

Notifications are for the things aimed at you, the moment they happen. The
[digest](05-the-digest.md), on the next page, is for everything else: a calm
written summary of what moved, on the days and at the times you choose. Most
people want both. The notifications for "come here now", and the digest for
"here is what you missed".
