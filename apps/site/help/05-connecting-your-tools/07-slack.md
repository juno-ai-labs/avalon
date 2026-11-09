---
title: Slack
description: Install Rally in your Slack workspace for everyone, and connect your own Slack account so Rally can see what you can.
---

Slack connects in two parts, and they do different jobs. The Organization install puts Rally into your Slack workspace so people can talk to it there. A personal connection lets Rally see your own corner of Slack and act as you. You can have either, or both.

This page covers connecting. For what to do with Rally once it is in Slack (Sidekicks that listen and post there, replies to a run, and the Home tab), read [Rally in Slack](../08-rally-everywhere/01-rally-in-slack.md) and [Slack: reading, replies and your own connection](../08-rally-everywhere/02-more-from-slack.md).

## Installing Rally in Slack for everyone

An owner or administrator in Rally does this once for the whole Organization.

1. Open **Settings → Connections** and find the **Slack** card.
2. Click **Connect for organization**.
3. Approve Rally in Slack in your browser. Grant every permission Slack lists. If any is turned down, the install is rejected.
4. Come back to Rally. The card says **Connected**.

What you need:

- A Rally owner or administrator to click the button.
- A paid Slack plan. On Slack's free plan the install undoes itself and tells you the Rally Agent needs a paid workspace plan.
- One Slack workspace per Rally Organization.

Once installed, Rally has a bot in Slack called Rally. It does not join public Slack channels by itself. Invite it into the channels where you want it, as [Rally in Slack](../08-rally-everywhere/01-rally-in-slack.md) explains.

### Each person links their Slack account

After the install, each person opens Rally's **Home** tab in Slack and clicks **Connect Rally**, so Rally knows which Rally account belongs to which Slack person. [Rally in Slack](../08-rally-everywhere/01-rally-in-slack.md) walks through it.

### When Slack needs attention

- If the Slack row in **Settings → Connections** says **Reconnect required**, an owner or administrator clicks **Refresh** and approves again in Slack.
- When Rally gains new abilities in Slack, an existing install may need to be approved once more to pick up the new permissions. Until then, some Slack features may not work.
- Deleting the Slack connection in Rally stops Rally using it. It does not remove the Rally app from Slack, and it does not delete Rally work that already contains Slack content. A Slack administrator removes the app separately, in Slack's App Management.

## Connecting your own Slack account

**Connect for me** on the **Slack** card gives Rally your own view of Slack. It is optional. You do not need it to talk to Rally in Slack.

Without it, Rally sees only what its bot can see, and anything it does in Slack is done by the bot. With it, Rally can see what you can see, including your private channels, direct messages, group messages, canvases and search, and it can act as you, including writing to canvases.

1. Open **Settings → Connections** and find the **Slack** card.
2. Click **Connect for me** and approve in Slack.
3. Come back to Rally. The card says **Connected**.

Clicking **Connect Rally** on Rally's Home tab in Slack can carry straight on into this step, and finishing it also links your Slack account to Rally.

The list of things Rally can do with your personal connection comes live from Slack, so it can change without a Rally update. If you connected before Rally combined these steps, your connection may have fewer permissions than a new one. Click **Refresh** on its row to get the full set.

> [!WARNING]
> Your personal Slack connection can read your private messages. If you ask Rally to look something up in them inside a shared Canvas, everyone in that Canvas can read the answer. Ask in a Canvas only you can open when it is private.

## Slack as a place for results

With the Organization install in place and your Slack account linked, Slack can be where things are delivered to you: a Sidekick's results, or a [notification](../08-rally-everywhere/03-notifications.md), arriving as a direct message from Rally. See [Where a Sidekick's results go](../03-sidekicks/07-where-results-go.md).

Next, [Granola](08-granola.md).
