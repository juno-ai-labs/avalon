---
title: Linear
description: Let Rally search, create and update your Linear issues, and start Sidekicks when issues change.
---

Linear is where a lot of teams keep the list of things they have promised to do. Connect it and Rally can read that list, add to it and keep it tidy, which is more than most of us manage on a Friday afternoon.

## What Rally can do

With Linear connected, Rally can:

- search recent issues
- read an issue along with its comments
- list your teams, projects and workflow states (the columns, such as Todo, In Progress and Done)
- create issues
- update issues: move them to another state, change who they are assigned to, or change their priority
- add comments

Search looks for plain words in issue titles and descriptions. It does not understand Linear's own filter syntax, so ask in ordinary language ("issues about the export bug") rather than typing Linear filters.

## Connecting

Linear offers both kinds of connection.

- **Connect for me** acts as you. Issues Rally creates and comments it writes appear under your name, and it sees what you can see.
- **Connect for organization** (owners and administrators) installs Rally into your Linear workspace for shared use. As well as the tools above, it sends Rally live news of issue and comment changes, which can start Sidekicks.

1. Open **Settings → Connections** and find the **Linear** card.
2. Click **Connect for me** or **Connect for organization**.
3. Approve Rally in Linear in your browser.
4. Come back to Rally. The card says **Connected**.

## Starting Sidekicks from Linear

With the Organization connection in place, a change in Linear, such as a new issue or a new comment, can start a Sidekick. You might have one that tidies up every new bug report, or one that updates a release Canvas when an issue moves to Done. [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md) shows how to set one up.

## Things to try

- "What is still open in the Mobile team's current project?"
- "Create a Linear issue for the broken export button, priority high, in the Web team."
- "Move the onboarding copy issue to In Review and add a comment linking this Canvas."
- "Summarise what changed in our Linear issues this week."

## When it stops working

1. In **Settings → Connections**, check the **Status** of the connection you expected Rally to use, personal or Organization.
2. If it says **Reconnect required**, click **Refresh**, or ask an owner or administrator to do so for the Organization connection.
3. Check that the connected Linear account can open the team, project or issue itself.

Refresh the connection that failed. A healthy personal Linear connection does not repair a broken Organization one, and the other way round.

Next, [Notion](06-notion.md).
