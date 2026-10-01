---
title: "Resources: things you bring in"
description: Bring files and items from your connected tools into a Channel, watch them for changes, and trace a Channel back to where it started.
nav_title: Resources
---

Artifacts are what a Channel makes. **Resources** are what it was given: the Slack thread it started in, a file someone sent in, an item from one of your connected tools. They sit on the same shelf as the artifacts, so you and Rally can always see what a piece of work was built on.

## Where a Channel came from

When a Channel exists because of something in another tool, Rally attaches that place to the Channel the moment the Channel is created. This is called the Channel's **origin**.

The most common case is Slack. When someone mentions **@Rally** in Slack, whether in a thread, in a new message in a Slack channel or in a direct message, the new Rally Channel carries that Slack conversation as a resource. (Starting work from Slack is covered in [Rally in Slack](../08-rally-everywhere/01-rally-in-slack.md).) It gets a title such as:

- **Thread in #operations**, for a thread in a Slack channel
- **Slack direct message**, for a direct message
- **Slack thread**, when Slack did not say which channel it was

This works even when the person who mentioned @Rally in Slack is not a Rally user. Their Channel still remembers where it started.

When a Sidekick is started by an email (see [Triggers and schedules](../07-sidekicks/03-triggers-and-schedules.md)), the email that started it is attached to its conversation in the same way.

Why it matters: a week later, when nobody remembers why this Channel exists, the answer is one click away.

### Rally knows where it started too

Rally is told about the origin before it starts its first reply, and it can tell the place it was called from apart from files added later. So you can ask "what was the thread about?" or "summarise where this started", and it knows which thread you mean.

An origin is a pointer, not a copy. Rally records where the thread is, not what it said: no Slack messages are copied into Rally. When Rally needs the content, it fetches it with a tool that is authorized to read it.

### Things to know about origins

- An origin is recorded once, when the Channel is created, and never rebuilt. Channels created before Rally started recording origins do not have one.
- If Rally cannot record the origin for some reason, the Channel is still created, without one, and you see no error.
- Two Channels started from the same Slack thread point to the same thread.

## Where to find resources

In the web browser version of Rally, a Channel's sidebar has a **Resources** section below **Artifacts**. Each row shows an icon, the title, and a line with the kind of thing and its version, such as **slack thread · v1**. Click a row to open its details. Like the Artifacts section, it appears only when there is something in it.

In the Mac app, resources do not have their own list in the sidebar today. Open one from the conversation instead: click a citation or file chip that points to it (see [Reading Rally's answers](../02-working-in-a-channel/04-reading-rallys-answers.md)), or click **Resource details** in a file preview.

## A resource's details

Opening a resource shows its details. What you see depends on what it is:

- **Last updated** with a date, when Rally knows it.
- **Open source** takes you to the original in the other tool. For a Slack origin, that is the thread itself in Slack. The button appears only when Rally has a link to the original.
- **Refresh from source** fetches the latest content from the original right now. It appears only for things whose tool supports it. A Slack thread never shows it.
- The resource's content, when it is a document or an image Rally can show.
- **Versions** in the header, which works exactly as described in [Artifacts](01-artifacts.md#versions). A Slack thread usually shows **No versions yet.**, because nothing replaces its content.
- **Archive** in the header (below).

If Slack is slow to answer when a Channel is created, Rally still records which thread it was, but without a link, so there is no **Open source** button. Rally will not guess a Slack address, because a guess could open the wrong Slack workspace.

If a refresh fails, Rally says **The resource couldn't be refreshed.**

## Bringing things in yourself

To give Rally a file to work from, attach it to a message, as described in [Attaching files](../02-working-in-a-channel/02-attaching-files.md). To point Rally at something in one of your connected tools, such as a GitHub issue, a Notion page or a Google Doc, mention it or paste its link in the conversation and ask Rally to read it. Chapter 5, [Connecting your other tools](../05-connecting-your-tools/index.md), covers what Rally can reach in each tool.

> [!NOTE]
> Rally has groundwork for adding a resource by hand from a picker, and for a switch that watches an item for changes, but neither is in the Mac app today. When they arrive, this page will explain them.

## Archiving a resource

Archiving takes a resource, or an artifact, off this Channel's shelf.

1. Open the resource or artifact.
2. Click the **Archive** icon (a box, tinted red) in its header.
3. Read the dialog, **Archive this resource?**, which says the item "will leave this channel. Rally has no way to bring it back yet."
4. Click **Continue**, or **Cancel** if you have changed your mind.

> [!WARNING]
> **There is no undo.** Once archived, the resource is gone from this Channel and cannot be restored. This includes an origin: archive it and the record of where the Channel started is gone for good.
>
> Archiving only removes the item from this Channel. The original in Slack, GitHub or wherever it lives is not touched, and the same thing in other Channels stays where it is.

Archive is available only from the Channel's main conversation, not from inside a Breakout. If it fails, Rally says **The resource couldn't be archived.**

Next: getting what Rally wrote out of Rally, in [Saving and sharing what Rally wrote](05-saving-and-exporting.md).
