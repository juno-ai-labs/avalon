---
title: "Slack: reading, replies and your own connection"
description: What Rally can read and do in Slack, how link previews and Sidekick threads work, and when to connect your own Slack account.
nav_title: More from Slack
---

The [previous page](01-rally-in-slack.md) was about giving Rally work from
Slack. This one is about Slack as a source and a destination: what Rally can
look up there, what it can post, how Rally links look when you paste them, and
how a Sidekick can talk to you in Slack and listen to your reply.

## What Rally can do with the Organization install

Once an owner or administrator has installed Rally in Slack, you can ask Rally,
in Slack or in the Mac app, to use Slack as part of a job. With the bot alone it
can:

- Search messages in public Slack channels, when you have asked it something
  with a direct message or a mention.
- Read the history and threads of conversations the bot has been invited to.
- Find people and channels, and list who is in a channel.
- Read text files shared in those conversations.
- Post messages, add reactions, create a channel, or open a direct message or
  group message, all as the Rally bot.

So "@Rally what did the design channel decide about the logo last week?" works,
as long as Rally can see the design channel.

The bot has two limits. Its search covers public channels only. And it
searches only when you have asked it something, never quietly in the
background.

## Your own Slack connection

The bot sees what the bot can see. For anything private to you, there is a
second, separate connection: your personal Slack connection.

With it, Rally can also see your private channels, your direct messages and
group messages, your canvases and Slack's search as you, and it can act as you,
including writing to canvases. That is what lets you ask "what did we decide in
that private thread with Sam?" and get an answer.

To connect it, open **Settings → Connections**, find the **Slack** card and
click **Connect for me**. Clicking **Connect Rally** on the Slack Home tab can
also carry on into the same step.

- It is optional. You do not need it to talk to Rally in Slack.
- It is independent of the Organization install. Neither one stands in for the
  other: the install lets people use Rally in Slack, and your personal
  connection lets Rally use Slack as you.
- Disconnecting it removes Rally's access to your Slack. It does not delete any
  work in Rally.

[The Slack page in chapter 5](../05-connecting-your-tools/07-slack.md) covers
connecting and refreshing in more detail.

> [!WARNING]
> Your personal connection can read your private Slack messages. If you ask
> Rally about them in a shared Channel, everyone in that Channel can read the
> answer. Ask in a Channel only you are in when the subject is private.

## Talking back to a Sidekick in Slack

A [Sidekick](../07-sidekicks/01-what-a-sidekick-is.md) can post its results into
Slack through the Rally bot. When it does, the Slack thread under its post is
connected to that run. Reply in the thread and the Sidekick reads your reply and
carries on, so you can answer its question, correct it or give it the go-ahead
right where it spoke. Rally reacts to your reply with the usual eyes emoji to
show it heard you.

- Your reply runs with the Sidekick's own access, not yours.
- If the Sidekick is paused or archived, your reply gets the stop sign and
  nothing happens.
- Guests in your Slack workspace, and people in channels shared with another
  company through Slack Connect, cannot continue a Sidekick's run this way.

[Where a Sidekick's results go](../07-sidekicks/05-where-results-go.md) explains
how to tell a Sidekick to post in Slack in the first place.

## Rally links in Slack

Paste a link to a Rally Channel into Slack and it opens out into a small card.
The card shows the Channel's title, when it last had activity, and whether a
Sidekick started it. While the Channel is running, waiting for input, has
failed or was stopped, the card also shows a status badge, and the badge updates as the status
changes. Your team can see that the report is still cooking before anyone
clicks.

To get a link, use **Copy link** in the Channel's title pill menu in Rally, as described in [Search and
links](../03-spaces-and-breakouts/06-search-and-links.md).

- The card carries no content from the Channel. Opening the link still needs
  normal access in Rally.
- A Channel from a different Organization, an archived Channel, or any link
  pasted into a Slack Connect channel shows a plain card with no details.
- Old Rally links that start with `rallywithai://` do not get a card.

## A recipe: your morning email briefing in Slack

This is the example Rally itself suggests, and a good first Sidekick if you
start the day buried in email. Send Rally this, in Slack or in the app:

```text
Check my Gmail every morning at 9 AM and send me the stack-ranked top 3 emails in Slack.
```

Rally saves a personal Sidekick that runs every morning and sends you a Slack
direct message with up to three emails, ranked. Each one has the sender, the
subject, why it matters, what Rally suggests you do, and a link to open it in
Gmail. The **Morning email briefing** starter in Rally's Slack messages tab
sends the same request.

- You need your own [Gmail connection](../05-connecting-your-tools/02-google-mail-and-calendar.md)
  and a linked Slack account (see [Connect
  Rally](01-rally-in-slack.md#linking-your-slack-account-with-connect-rally)).
- On a morning with nothing worth telling you, it stays quiet rather than
  sending an empty message.
- If you disconnect Gmail or Slack, the next run shows that it needs your
  input instead of guessing.
- Saving the Sidekick is your say-so for it to read your Gmail and message you
  on schedule. It will not ask again each morning.

Your inbox will not get any smaller, but at least it will arrive in order.

## Slack and your data

What Rally's Slack app does with what it sees in Slack:

- Rally does not copy Slack. It keeps no mirror or searchable index of your
  Slack workspace. It keeps the work done in a task, such as your request, its
  answer and anything Rally wrote down while working.
- The bot reads only conversations it is in. It is there because someone
  invited it, or because a Sidekick that watches a public Slack channel needed
  it to join.
- Bot search covers public channels only.
- Your personal connection uses your own Slack permissions, and only yours.
- Disconnecting stops new access. It does not delete work in Rally that
  already includes Slack content. To remove the Rally app from Slack entirely, a
  Slack administrator removes it in Slack's App Management.

For the wider picture, see [What Rally shares, and with
whom](../11-privacy-and-security/02-what-rally-shares.md).

Next, Slack's quieter cousin: [email](03-email-into-rally.md).
