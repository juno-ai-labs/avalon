---
title: Common problems and fixes
description: Quick fixes for connections that need reconnecting, runs that fail, offline moments and other everyday snags.
---

This page is a quick reference in the old style: find the symptom, read the
likely cause, do the thing in the last column. Each row links to the page that
explains the feature properly, in case the short version is not enough.

## At a glance

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| A row in **Settings → Connections** says **Reconnect required**. | The tool stopped accepting Rally's saved sign-in. A changed password or withdrawn access will do it. | Click **Refresh** on that row and approve Rally again. For an Organization connection, ask an owner or administrator. See [Settings → Connections](../05-connecting-your-tools/01-connections.md). |
| Rally says it cannot use a tool, but your connection looks fine. | Your personal connection and the Organization's connection to the same tool are separate. The broken one may be the other one. | Check both rows in **Settings → Connections**. See [Settings → Connections](../05-connecting-your-tools/01-connections.md). |
| A red **Run failed** card appears in the conversation. | Usually something temporary on the way to the model or a tool. | Press **Retry**. If it fails again, copy the **Request ID** and [contact support](03-contact-support.md). The messages are listed in [While Rally works](../02-working-in-a-channel/03-while-rally-works.md). |
| Rally did not answer your message in a busy Channel. | Rally decided the message was for the people in the room, not for it. | Mention **@Rally** in the message. See [People in the room](../02-working-in-a-channel/05-people-in-the-room.md). |
| You cannot see a Channel a teammate is talking about. | It is private and you are not a participant, or it sits in a Space you are not in. | Ask someone in the Channel to add you, or an owner or administrator to add you to the Space. See [Who can see what](../03-spaces-and-breakouts/04-who-can-see-what.md). |
| A Space shows **Space not found**. | The Space was archived, or you no longer have access. Rally uses the same words for both on purpose. | Ask someone who can see it. See [Who can see what](../03-spaces-and-breakouts/04-who-can-see-what.md). |
| Notifications are not arriving on your Mac. | The switch is off in **Settings → Notifications**, or macOS was told no. | Turn on **Notify me on this Mac about mentions and additions**. If the page says **Notifications are turned off in macOS.**, click **Open System Settings**. See [Notifications](../08-rally-everywhere/04-notifications.md). |
| There is no **Notifications** page in Settings. | Notifications have not been switched on for your account yet. | Nothing to fix on your side. Mentions still reach you in Slack or by email. See [Notifications](../08-rally-everywhere/04-notifications.md). |
| An update has downloaded but not installed. | Rally waits for you to restart, so it does not interrupt your work. | Click **Restart to Update**, or quit Rally and the update installs. See [Keeping Rally up to date](../09-settings-and-shortcuts/04-updates.md). |
| Rally says **Couldn't update automatically**. | The download failed several times. | Click **Download Latest** and install over the copy in Applications. See [Keeping Rally up to date](../09-settings-and-shortcuts/04-updates.md). |
| **Import updates** says **The source removed or reordered earlier messages.** | Someone edited or deleted an earlier message in the original Claude or ChatGPT conversation, which made a new branch. | Import that conversation as a new Channel instead. See [Bring in a conversation from Claude or ChatGPT](../02-working-in-a-channel/08-import-from-claude-or-chatgpt.md). |
| A Sidekick did not run when you expected. | It is **Paused** or still a **Draft**, its schedule is read in a different time zone from the one you meant, or its trigger never fired. | Open it in the Sidekicks window and check its badge and **Run history**. Use **Run now** to test it. See [The Sidekicks window](../07-sidekicks/04-the-sidekicks-window.md) and [Triggers and schedules](../07-sidekicks/03-triggers-and-schedules.md). |
| Rally's code cannot download something or reach a website. | Your Organization's **Internet access** is set to **Trusted only**, and that site is not on the list. | Ask an owner or administrator to approve the domain, or to choose **Full internet**. See [Organization settings](../10-running-an-organization/03-organization-settings.md). |
| A link will not open, and a small window says why. | Rally refused the link. | Look up the message in [When a link won't open](01-when-a-link-wont-open.md). |

## When Rally is offline

Rally keeps a live connection to its service while it is open. If your Wi-Fi
drops, your Mac wakes from sleep, or the service has a wobble, that connection
goes away for a moment. Rally reconnects by itself as soon as it can. You do
not need to restart anything.

While it is waiting, a few things change:

- Scrolling back through a conversation stops at the top with
  **Waiting to reconnect…** in place of the older messages.
- Sending waits. A card says **Sending is available once Rally connects**.
  You can carry on typing and attaching files; your draft and attachments are
  kept on your Mac and go when you press send after the connection is back.
- Starting a Breakout waits too, with **Starting a breakout is available
  once Rally connects**.
- **Settings → Connections** says **Connection management is unavailable while
  offline.** You cannot add, refresh or delete connections until Rally is back,
  and the statuses you see may be out of date.
- The Channel directory says it cannot be loaded while offline.

There is no full offline mode. You can read what Rally already has on your Mac,
but anything that needs Rally's service, such as sending a message or starting
a run, needs the connection. Runs that were already going carry on without
you, since they happen on Rally's side, not on your Mac.

> [!TIP]
> If Rally stays on "waiting" for a long time while your other apps are online,
> quit Rally and open it again. If that does not help either, note the time and
> [contact support](03-contact-support.md).

## Before you write to support

A few things fix more problems than they have any right to:

1. Try it once more. Press **Retry** on a failed run, or click the link
   again. Many failures are temporary.
2. Check which account and Organization you are in. Open the account menu
   (click your name) to see the email address you signed in with. A surprising number of
   "Rally cannot see my thing" problems are "I am signed in as my other self".
3. Check **Settings → Connections** for anything marked **Reconnect required**.
4. Make sure Rally is up to date. Use **Rally → Check for Updates…** in the
   menu bar.

If none of that worked, [Contacting support](03-contact-support.md) is next.
It says what to send so the first reply can be the helpful one.
