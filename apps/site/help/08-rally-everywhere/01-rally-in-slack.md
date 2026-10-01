---
title: Rally in Slack
description: Install Rally in your Slack workspace and start work from a DM, a mention, /rally or a shortcut.
---

If your team lives in Slack, Rally can live there too. Once it is installed,
anyone can hand Rally a job without leaving Slack: send it a direct message,
mention it in a channel, type `/rally`, or use a shortcut on a message. Rally
does the work in your Organization and posts the finished answer back in the
same Slack thread, with a link to the full Channel in Rally.

## Before you start

Two things have to happen, once each.

**An owner or administrator installs Rally in Slack.** This is the **Connect for
organization** button on the **Slack** card in **Settings → Connections**, and
[the Slack page in chapter 5](../05-connecting-your-tools/06-slack.md) walks
through it. It needs a paid Slack plan, and one Slack workspace connects to one
Rally Organization. After the install, your Slack workspace has a new member: a
bot called **Rally**.

**Each person links their Slack account to their Rally account.** This is how
Rally knows that the Slack person typing is you, so it can work with your own
access and your own connected tools, and show the work under your name.

### Linking your Slack account with Connect Rally

1. In Slack, open the Rally app (under **Apps** in Slack's sidebar) and go to
   its **Home** tab.
2. Click the green **Connect Rally** button.
3. A pop-up called **Connect Rally** appears. Click **Open Rally**.
4. The Rally app opens on your Mac and finishes the link. Make sure you are
   signed in to the Organization that installed Rally in Slack.

Rally may then carry straight on and ask you to approve your own Slack
connection as well. That part is optional and is explained on the
[next page](02-more-from-slack.md#your-own-slack-connection).

Rally can also send you a private prompt with the same button, when a task
needs your Rally account to continue.

Things to know:

- The link works once and expires after 15 minutes. If it has expired, or you
  clicked it twice, click **Connect Rally** again for a fresh one. Each new link
  retires the old ones.
- Your Rally account must belong to the Organization that installed Rally in
  Slack. If you are signed in to a different one, the link is refused.
- If Rally says the installation has been disabled, clicking again will not
  help. A Rally owner or administrator has to reconnect Slack in **Settings →
  Connections**.
- Linking is per Slack workspace. If you belong to two Slack workspaces that
  both have Rally, you link twice.

You can use Rally in Slack without linking, too. You will get the
Organization's shared tools only, not your personal ones (your Gmail, your
calendar), and the work is credited to your Slack name rather than your Rally
account.

## Four ways to start work

### Send Rally a direct message

Open the Rally app in Slack, go to its **Messages** tab and type what you want.
Slack offers a few starter ideas, such as **Morning email briefing**, **Analyze a
business idea** and **Investigate an issue**.

Rally starts the task and replies in a thread under your message. To keep
going, reply in that thread. You do not need to mention Rally again.

- If a task is still running and you send a new message at the top level, Rally
  does not start a second job. It asks you, once, to reply in the thread of your
  original request, and gives you a link to it. Once the first request is
  finished, a new top-level message starts fresh work.
- Send the word `help` on its own and Rally replies with a short how-to.

### Mention @Rally in a channel

Type **@Rally** and your request in any Slack channel, private channel or group
message that Rally has been invited to. Rally replies in a thread under your
message, and that whole thread becomes one task. Anyone in the thread can carry
on without another mention, which makes it a good way to pull Rally into a
team discussion and let everyone see the result.

- Rally only pays attention to threads it is part of. It ignores the rest of
  the channel.
- Each message runs with the access of the person who sent it. Linked members
  work as themselves; everyone else gets the Organization's shared tools.
- If Rally asks a question of one particular person, only that person can
  answer it.
- Who can see the task in Rally follows the Slack room. A public Slack channel
  makes a public Channel in Rally. A private channel, direct message or group
  message makes a private Channel for the people in that conversation.

If Rally refuses to start, for example because it could not tell whether the
Slack channel is public or private, or because its Slack permissions need
updating, it says so in the thread. Once the problem is fixed, reply **try
again** in the thread. Rally keeps your request for up to a day.

### Type /rally

`/rally` works in any Slack message box. Type it with your request after it:

```text
/rally summarize the launch thread
```

Or type `/rally` on its own and a pop-up called **Start a Rally task** asks
**What should Rally do?**. Type your request and click **Start**.

Either way, Slack shows you a private note, "Rally queued your request. I'll
continue in your Agent conversation.", and the work continues in your direct
messages with Rally, not in the channel where you typed the command. That makes
`/rally` handy when you want Rally's help without starting a conversation in
front of everyone.

### Use a shortcut

Rally adds two shortcuts to Slack.

- **Start a Rally task** opens the same pop-up as `/rally`. Find it in the
  shortcuts menu (the lightning bolt) in Slack's message box.
- **Work on this with Rally** sits on every message. Hover over a message, open
  its **More actions** menu (the three dots) and choose it. The pop-up opens
  with that message already filled in. Add what you want done and click
  **Start**.

The second one is the quickest way to turn a bug report or a customer question
into a job for Rally. Two clicks, and nobody has to retype anything.

## Watching Rally work

Rally does not type its answer into Slack word by word. Instead, it puts a
single emoji on the message that started the task, and changes it as the work
moves along.

| Emoji | Meaning |
| --- | --- |
| Eyes (`:eyes:`) | Rally has picked up your request. |
| Brain, magnifying glass, writing hand and gear, taking turns | Rally is working. |
| Green tick (`:white_check_mark:`) | Done. The answer is in the thread. |
| Question mark (`:question:`) | Rally needs your input. |
| Warning sign (`:warning:`) | The task failed. |
| Stop sign (`:octagonal_sign:`) | The task was stopped. |

Rally only ever has one of its own emoji on a message, and it never touches
yours. When you send a new request in the same thread, the emoji moves to that
message. It is, in effect, a very small progress bar that went to art school.

When the answer is ready, Rally posts it in the thread in one go. A very long
answer is split over several messages, breaking between paragraphs and keeping
code blocks whole. Each answer has two buttons, **Open task** to see the full
Channel in Rally, and **Give feedback** to tell the team whether it helped. A
note under it reminds everyone that the answer was generated by AI, so check
important facts and actions before relying on them.

## The Home tab

Rally's **Home** tab in Slack is your own small dashboard.

- **Before you link**, it says **Meet Rally**, with the **Connect Rally** button
  and some example requests.
- **After you link**, it says **Welcome** and your name, with three buttons:
  **Start a task** (opens the task pop-up), **Create automation** and
  **Notifications**. Below them, **Needs attention & recent tasks** lists your
  running tasks and anything waiting on you, and **Automations** lists your
  scheduled helpers with their next run time.
- **Owners and administrators** also see a **Workspace administration** card
  showing whether the Slack connection is healthy, with a **Manage** button that
  opens **Settings → Connections** in the Mac app.

> [!NOTE]
> The Home tab still uses the old word: an "automation" here is a
> [Sidekick](../07-sidekicks/01-what-a-sidekick-is.md). **Create automation**
> opens Rally on your Mac so you can make one, and the **Automations** list
> shows your Sidekicks. Same helpers, older name tag.

The **Notifications** button opens a pop-up with **Notify me in Slack** choices.
How Rally tells you about mentions and new Channels is covered properly in
[Notifications](04-notifications.md).

## Inviting Rally into a Slack channel

Rally's bot does not wander into Slack channels on its own. To use **@Rally** in
a channel, invite it first, with `/invite @Rally` or from the channel's
settings (**Integrations → Add apps**).

When Rally joins, it creates a matching [Space](../03-spaces-and-breakouts/01-spaces.md)
in your Organization for that Slack room, and posts one line: "Rally is here.
Mention @Rally in a thread to start work on it; each thread becomes a Channel in
this conversation's Rally Space." From then on, every Slack thread where
someone mentions Rally becomes its own Channel inside that Space. Your Slack
room gets a tidy home in Rally, with one Channel per job.

- A public Slack channel makes a public Space everyone in the Organization can
  see. A private Slack channel or group message makes a private Space for the
  people in it whom Rally can match to Rally accounts. [Who can see
  what](../03-spaces-and-breakouts/04-who-can-see-what.md) explains the
  difference.
- If a linked Slack channel later becomes private, Rally refuses new threads
  there with a notice, rather than letting them land in a Space the whole
  Organization can see.
- If Rally is removed from the Slack channel, or the channel is archived, the
  link is paused. Invite Rally again, or mention it, to bring the link back.
  Unarchiving the Slack channel on its own is not enough.
- If the Space in Rally has been archived, Rally does not start work in that
  Slack room and says so. A Rally administrator can restore the Space.

## When Rally stops answering in Slack

Work through this list, which is also on Rally's [Slack support
page](https://rallywith.ai/support/connectors/slack/):

1. Open **Settings → Connections** in the Mac app and find the Slack row.
2. If its status says **Reconnect required**, ask an owner or administrator to
   click **Refresh** and approve Rally in Slack again.
3. Open Rally's **Home** tab in Slack and check that your account is linked.
4. Try your mention, command or shortcut again.

There is a public overview of all this at
[rallywith.ai/slack](https://rallywith.ai/slack/), handy for sending to a Slack
administrator who wants to know what they are agreeing to. Its **Open
Connections in Rally** button opens the right screen in the Mac app.

Next, [what Rally can read and do once it is in Slack](02-more-from-slack.md).
