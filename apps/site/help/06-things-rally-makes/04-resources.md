---
title: "Resources: things you bring in"
description: Bring files and items from your connected tools into a Canvas, and trace a Sidekick run back to what started it.
nav_title: Resources
---

Artifacts are what a Canvas makes. **Resources** are what it was given: a file someone sent in, an item from one of your connected tools, the email that started a Sidekick run. Rally keeps them alongside the artifacts, so you and Rally can always see what a piece of work was built on.

## Where a run came from

When a Sidekick run starts because of something outside Rally, such as an email to the Sidekick (see [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md)), the thing that started it is attached to the run as its **origin**. Rally is told about the origin before it starts work, and it can tell it apart from files added later, so a run asked to "reply to this" knows what "this" is.

An origin is a pointer, not a copy where it can be. For a Slack message, Rally records where the message is, not what it said, and fetches the content with a tool that is authorized to read it.

## Where to find resources

In the web browser version of Rally, click a Canvas's name in its header pill and choose **More**. Below **Artifacts** is a **Resources** list, with an icon and the title of each. Click a row to open its details. Like the Artifacts list, it appears only when there is something in it.

In the Mac app, resources do not have their own list today. Open one from the conversation instead: click a citation or file chip that points to it (see [Reading Rally's answers](../02-canvases/05-reading-rallys-answers.md)), or click **Resource details** in a file preview.

## A resource's details

Opening a resource shows its details. What you see depends on what it is:

- **Last updated** with a date, when Rally knows it.
- **Open source** takes you to the original in the other tool. For a Slack origin, that is the message itself in Slack. The button appears only when Rally has a link to the original.
- **Refresh from source** fetches the latest content from the original right now. It appears only for things whose tool supports it. A Slack thread never shows it.
- The resource's content, when it is a document or an image Rally can show.
- **Versions** in the header, which works exactly as described in [Artifacts](01-artifacts.md#versions). A Slack thread usually shows **No versions yet.**, because nothing replaces its content.
- **Archive** in the header (below).

If Slack is slow to answer when a run starts, Rally still records which message it was, but without a link, so there is no **Open source** button. Rally will not guess a Slack address, because a guess could open the wrong Slack workspace.

If a refresh fails, Rally says **The resource couldn't be refreshed.**

## Bringing things in yourself

To give Rally a file to work from, attach it to a message, as described in [Attaching files](../02-canvases/03-attaching-files.md). To point Rally at something in one of your connected tools, such as a GitHub issue, a Notion page or a Google Doc, mention it or paste its link in the conversation and ask Rally to read it. Chapter 5, [Connecting your other tools](../05-connecting-your-tools/index.md), covers what Rally can reach in each tool.

> [!NOTE]
> Rally has groundwork for adding a resource by hand from a picker, and for a switch that watches an item for changes, but neither is in the Mac app today. When they arrive, this page will explain them.

## Archiving a resource

Archiving takes a resource, or an artifact, out of this Canvas.

1. Open the resource or artifact.
2. Click the **Archive** icon (a box, tinted red) in its header.
3. Read the dialog, **Archive this resource?**, which says the item will leave this conversation and that Rally has no way to bring it back yet.
4. Click **Continue**, or **Cancel** if you have changed your mind.

> [!WARNING]
> **There is no undo.** Once archived, the resource is gone from this Canvas and cannot be restored.
>
> Archiving only removes the item from this Canvas. The original in Slack, GitHub or wherever it lives is not touched, and the same thing in other Canvases stays where it is.

If archiving fails, Rally says **The resource couldn't be archived.**

Next: getting what Rally wrote out of Rally, in [Saving and sharing what Rally wrote](05-saving-and-exporting.md).
