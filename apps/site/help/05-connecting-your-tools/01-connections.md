---
title: Settings → Connections
description: Add, check, refresh and delete connections, and choose between connecting for yourself or the whole Organization.
nav_title: Connections
---

Every connection in Rally, whatever the tool, is added, checked and removed in one place. Learn this screen once and every page after it in this chapter gets shorter.

If you went through [the guided setup](../01-getting-started/03-guided-setup.md) when you created your Organization, you have already met the same connectors there. Anything you connected then shows up here, and anything you skipped is waiting for you.

## Opening it

Open Settings with <kbd>⌘</kbd> <kbd>,</kbd> (or **Rally → Settings…** in the menu bar) and click **Connections** in the list on the left. You can also type "connectors" or "integrations" into the Settings search box and it will take you there.

You can manage connections in the Mac app or the browser version. The browser version can connect every tool except Canva, which you connect from the Mac app.

The page is headed **Your connections**. It has two halves.

## The two tables

The top half is two tables:

- **Personal connections** are the ones that act as you.
- **Organization connections** are the shared ones every member can use.

Each table has the same columns:

| Column | What it tells you |
| --- | --- |
| **Connection** | The tool's name and logo. |
| **Status** | Whether the connection is working. See [Status, Refresh and Delete](#status-refresh-and-delete). |
| **Tools** | How many separate abilities Rally has through this connection, such as "search mail" or "create an issue". |
| (no heading) | The buttons for fixing or removing it. |

If **Tools** shows a dash instead of a number, hover over it to see why. It might be that the connection is disabled, that Rally is still counting, that the last attempt to list the tools failed, or that the tool is not available in your region. A dash never means zero.

## The cards

The bottom half is a grid of cards, one for each kind of tool Rally can connect to. Above the grid is a filter with **Not connected**, **Connected** and **All**. The filter starts on **Not connected**, which is handy for finding something new to connect and confusing when you are looking for something you already have. Click **All** if a card seems to be missing.

Each card shows the tool, a one-line description, and one of these words under its name:

- **Available**: you can connect it.
- **Connected**: there is already a connection.
- **Waiting for authorization**: you have started connecting and Rally is waiting for you to finish in your browser.
- **Checking availability**: Rally is still finding out what your region offers.
- **Unavailable**: this tool is not set up in your Organization's Rally region. Hover over the button and it says so. This is not something you can fix from your side.

## Connect for me, or Connect for organization

A card can have two buttons.

**Connect for me** makes a personal connection. Rally signs in to the tool as you, sees what you can see there, and acts with your name on it. Nobody else in the Organization can use it. Sharing a Canvas or a Sidekick with someone does not lend them your connections.

**Connect for organization** makes one shared connection. Every member can ask Rally to use its tools in their Canvases and Sidekicks. It acts for the Organization, or as the one account the administrator signed in with when setting it up, never as the member who happened to ask. Only owners and administrators see this button.

Not every tool offers both. A card shows only the buttons that apply to it, and each page in this chapter says which ones its tool has. For example, Google Mail + Calendar, Canva and Fireflies are personal only, and X is Organization only.

Most tools can have one personal connection per person and one Organization connection. Once you have one, the button turns grey and its tooltip points you to the table above. The exceptions are **Custom MCP server** and **Inbound webhook**, which you can add as many times as you like.

### What happens when you click

For most tools, your web browser opens on that tool's own sign-in page, where you approve Rally's access. Keep Rally open while you do this. When the browser says it worked, come back to Rally and the card says **Connected**, and the new connection appears in the table.

A few tools ask for a key or an address instead of a browser sign-in. Their pages walk you through it.

> [!WARNING]
> A personal connection is private, but what Rally finds with it is not, once it is in a conversation. If you ask Rally to look something up in your personal Gmail inside a Canvas your teammates share, they can read the answer. Use a Canvas only you can open when the results are private.

### What Organization Sidekicks use

A Sidekick uses personal connections only through the people on its **Delegation allowed** list, and only for runs they or its triggers start. A teammate who talks to a shared Sidekick never borrows someone else's personal account that way. [Tools and delegation](../03-sidekicks/06-tools-and-delegation.md) has the details.

## Status, Refresh and Delete

The **Status** column shows one of these:

- **healthy**: working.
- **Reconnect required**: the tool has stopped accepting Rally. A changed password, access withdrawn on the tool's side, or a sign-in that expired will all do it.
- **disabled**: switched off.

Only **Reconnect required** means you need to do something. A background check that did not get an answer does not change the status, because one missed answer does not prove the sign-in is broken.

At the end of each row are two small icons.

**Refresh** (the circular arrows) sends you back to the tool's sign-in page to approve Rally again. Click it, then **Continue** in the **Refresh** dialog. Refresh is how you fix **Reconnect required**. It does not fetch new data. Rally reads fresh data every time it uses a connection anyway.

**Delete** (the rubbish bin) removes the connection and its tools. Click it, then **Continue**. For an Organization connection, the dialog warns that this removes it from everyone in the Organization. For a personal one, it removes it from your Rally account only. Some older help pages call this **Disconnect**. Same button.

> [!NOTE]
> Deleting a connection in Rally stops Rally using it. It does not uninstall anything on the other tool's side. For example, the Rally app stays installed in your Slack workspace or GitHub account until someone with the right access removes it there. Each tool's page says what is left behind.

A few tools have no Refresh, because there is no sign-in to redo. Each page says what to do instead, which is usually to delete the connection and connect it again.

### Refresh the one that broke

Your personal connection to a tool and the Organization's connection to the same tool are separate. A healthy personal Linear connection does nothing for a broken Organization one, and the other way round. When something stops working, find the row that says **Reconnect required** and refresh that one.

## Who can do what

- Members can add, refresh and delete their own personal connections. Nobody else can touch them, not even an administrator.
- Owners and administrators can also add, refresh and delete Organization connections, and they set the options some tools have, such as which GitHub repositories Rally may use.

[Organization settings](../10-running-an-organization/03-organization-settings.md) has the full list of what administrators control.

## When Rally asks you to connect

You do not always have to come to this screen. If you ask for something that needs a tool you have not connected, Rally can drop a card into the conversation with a button such as **Connect Linear**, or **Reconnect** if the connection has broken. The card says whether it wants a **Personal connection** or an **Organization connection**.

Click the button, finish signing in in your browser, and the card changes to **Connected** on its own. Then carry on where you were.

The button says **Waiting…** while your browser is open, **Admin required** if the card asks for an Organization connection and you are not an owner or administrator, and **Unavailable** if the tool is not offered in your region. These cards work in the Mac app only.

A card that once said **Connected** keeps saying it, even if the tool later withdraws access. Settings → Connections is where you see the current state.

## Connector names in Rally's replies

When Rally mentions a tool in a reply, the name often appears as a small chip with the tool's logo and its status: **Connected**, **Reconnect**, **Disabled** or **Not connected**. Some replies show a larger card with a description of the tool and whether you and the Organization each have it connected.

These are for reading at a glance. Clicking them does not do anything, and typing a tool's name yourself does not turn it into a chip. Typing <kbd>@</kbd> in the message box suggests people, not tools.

## How your credentials are kept

When you connect a tool, the key or sign-in that lets Rally in is encrypted and kept on Rally's servers in your Organization's region. The Mac app never receives keys or tokens back, and Rally does not show them to the AI.

Connecting is the permission, as the [chapter opener](index.md#rally-does-not-ask-before-each-action) says. If you want Rally to have less power, connect less: for example, set GitHub to read-only, or limit a custom MCP server to read-only tools, as described in [Keeping connected tools to reading only](14-custom-mcp-server.md#keeping-connected-tools-to-reading-only).

Some changes to other tools are recorded before they are made. If Rally is interrupted in the middle of one and cannot tell whether it went through, it does not try again on its own. The conversation waits for you instead.

## Every connector

Every connector card in Settings has its own page in this chapter:

- [Google Mail and Calendar](02-google-mail-and-calendar.md)
- [Google Drive, Docs and Sheets](03-google-drive.md)
- [GitHub](04-github.md)
- [Linear](05-linear.md)
- [Notion](06-notion.md)
- [Slack](07-slack.md)
- [Granola](08-granola.md)
- [Fireflies](09-fireflies.md)
- [Ashby](10-ashby.md)
- [Canva](11-canva.md)
- [X](12-x.md)
- [Inbound webhook](13-inbound-webhook.md)
- [Custom MCP server](14-custom-mcp-server.md)
