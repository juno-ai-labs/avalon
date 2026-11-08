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
| A red **Run failed** card appears in the conversation. | Usually something temporary on the way to the model or a tool. | Press **Retry**. If it fails again, copy the **Request ID** and [contact support](03-contact-support.md). The messages are listed in [While Rally works](../02-canvases/04-while-rally-works.md). |
| Rally did not answer your message in a busy Canvas. | Rally decided the message was for the people in the room, not for it. | Mention **@Rally** in the message. See [People in a Canvas](../02-canvases/07-people-in-a-canvas.md). |
| You cannot see a Canvas a teammate is talking about. | It was not shared with you. A new Canvas is open only to its creator. | Ask its creator, or an owner or administrator, to add you with **Share**. See [Who can see what](../02-canvases/08-who-can-see-what.md). |
| A Canvas link says **You don't have access to this Canvas**. | The Canvas exists, but it has not been shared with you. | Click **Request access**. Its creator and your Organization's administrators are asked. See [Who can see what](../02-canvases/08-who-can-see-what.md#requests-to-open-a-canvas). |
| A Canvas link says **This Canvas does not exist.** | The link is wrong, or it is for another Organization. | Check you are in the right Organization, and ask whoever sent the link. See [What a Canvas is](../02-canvases/01-what-a-canvas-is.md#when-a-canvas-will-not-open). |
| As a guest, a Canvas link says **This Canvas could not be opened.** and **Only a member of the Organization can ask to open a Canvas**. | The Canvas has not been shared with you, or does not exist. Guests cannot ask to be let in. | Ask whoever sent the link to share the Canvas with you. See [Sharing with people outside your Organization](../02-canvases/09-sharing-with-guests.md). |
| A Slack mention of @Rally does nothing. | Mentions in Slack do not start work by themselves. | Make a Sidekick that watches that Slack channel. See [Rally in Slack](../08-rally-everywhere/01-rally-in-slack.md#what-rally-does-in-slack). |
| Notifications are not arriving on your Mac. | The switch is off in **Settings → Notifications**, or macOS was told no. | Turn on **Show notifications** under **On this Mac**, and check that **Push** is chosen for that kind under **Notify me about**. If the page says **Turned off in macOS**, click **Open System Settings**. See [Activity and notifications](../08-rally-everywhere/03-notifications.md). |
| You chose email or Slack for a kind, and nothing arrives. | Email and Slack are sent only for mentions and for being added to a Canvas today. | Choose **Push** as well, and check Activity. See [Activity and notifications](../08-rally-everywhere/03-notifications.md). |
| An update has downloaded but not installed. | Rally waits for you to restart, so it does not interrupt your work. | Click **Restart to Update**, or quit Rally and the update installs. See [Keeping Rally up to date](../09-settings-and-shortcuts/04-updates.md). |
| Rally says **Couldn't update automatically**. | The download failed several times. | Click **Download Latest** and install over the copy in Applications. See [Keeping Rally up to date](../09-settings-and-shortcuts/04-updates.md). |
| A Sidekick did not run when you expected. | It is **Paused** or still a **Draft**, its schedule is read in a different time zone from the one you meant, or its trigger never fired. | Open it in the Sidekicks section and check its badge and its latest run rows. Use **Run now** to test it. See [The Sidekicks section](../03-sidekicks/05-the-sidekicks-section.md) and [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md). |
| Rally's code cannot download something or reach a website. | Your Organization's **Security** setting is **Trusted only**, and that site is not on the list. | Ask an owner or administrator to approve the domain, or to choose **Full internet**. See [Organization settings](../10-running-an-organization/03-organization-settings.md). |
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
- **Settings → Connections** says **Connection management is unavailable while
  offline.** You cannot add, refresh or delete connections until Rally is back,
  and the statuses you see may be out of date.
- A Canvas you have opened before shows what it last loaded, with **Rally
  can’t reach the server right now.** and a **Try again** button, until Rally
  reconnects.

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
   (click your avatar at the bottom of the rail) to see which Organization
   you are in. A surprising number of
   "Rally cannot see my thing" problems are "I am signed in as my other self".
3. Check **Settings → Connections** for anything marked **Reconnect required**.
4. Make sure Rally is up to date. Use **Rally → Check for Updates…** in the
   menu bar.

If none of that worked, [Contacting support](03-contact-support.md) is next.
It says what to send so the first reply can be the helpful one.
