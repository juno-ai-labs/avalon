---
title: The guided setup
description: If you created the Organization, Rally walks you through connecting tools, choosing your look and inviting teammates.
---

A new Organization is an empty house. Before you start moving in, Rally offers a short guided setup to get the essentials done: connect the tools your team already uses, decide how you look to everyone else, and send out invitations.

If you created the Organization, you see all of it, in this order:

1. **Connect tools for your organization**
2. **Connect your personal tools**
3. **This is you in Rally**
4. **Invite your teammates**

If you joined an existing Organization, you see only step 3.

Every step is optional, and everything here can be done again later in Settings. If you close Rally partway through, your choices so far are saved and it picks up where you left off.

## Connecting your tools

Rally is far more useful when it can read and work in the tools your team already uses: your email and calendar, your documents, your issue tracker, your meeting notes. A **connection** is the permission that lets it do that. Connecting at this point saves you a trip to Settings later.

There are two pages, because there are two kinds of connection.

- **Organization connections** (page 1 of 2) are shared. Everyone in your Organization can ask Rally to use them, along with the data you grant access to. Use these for team-wide things like the company's GitHub or Linear.
- **Personal connections** (page 2 of 2) are yours alone. Only you can use them through Rally. Teammates do not gain access to them by being in a Channel with you.

> [!WARNING]
> A personal connection stays personal, but what Rally finds with it does not stay hidden once it is in a conversation. If you ask Rally to look something up in your personal Gmail inside a Channel your teammates share, they can read the answer. Ask in a Channel only you are in when the results are private.

### How to connect a tool

1. Search the grid with **Search**, or scroll it, and click the tiles of the tools you want. Clicking a tile again unticks it.
2. Click **Next**. Rally shows only the tools you picked, each with its own button: **Connect for organization** on the first page, **Connect for me** on the second.
3. Click a tool's button. For most tools, your browser opens so you can sign in to that tool and approve Rally's access. When you come back, the tile says **Connected**.
4. When you have connected what you want, click **Continue**.

**Skip for now** moves on without connecting anything on that page. **Back** returns to the previous page.

A few tools need a key, an address or a secret rather than a browser sign-in. For those, the button opens **Settings → Connections** so you can finish there. That includes **Custom MCP server** and **Inbound webhook** on either page, and **Ashby** and **Granola** when you connect them for the whole Organization.

### Which tools are offered

The grid shows only the tools available to your Organization, and only on the page where they make sense. At the time of writing it can include:

| Tool | Organization page | Personal page |
| --- | --- | --- |
| Google Mail + Calendar | | ✓ |
| Google Drive + Docs + Sheets | ✓ | ✓ |
| GitHub, Linear, Notion, Slack | ✓ | ✓ |
| Ashby, Granola | ✓ | ✓ |
| Custom MCP server, Inbound webhook | ✓ | ✓ |
| Canva, Fireflies | | ✓ |
| Public X via TwitterAPI.io (read-only) | ✓ | |

When you connect Canva, Rally tells you up front that it will be able to read and change your Canva designs, folders, assets and brand kit.

Each of these tools has its own page in [Connecting your other tools](../05-connecting-your-tools/index.md), and [Settings → Connections](../05-connecting-your-tools/01-connections.md) explains how to add, check and remove connections later.

## This is you in Rally

This screen sets how you appear to your teammates: **Your team will see your avatar and color. They follow you across devices.**

1. Check your **Name**. Rally fills it in from your Google account.
2. Check your **Avatar initials**, the letters in your little round avatar. These start from your Google name too.
3. Pick a colour under **Your color**. There are eight: rose, orange, lime, emerald, blue, violet, fuchsia and black.
4. Click **Continue with this look**.

A preview beside the form shows a sample sidebar, with **Your next idea starts here** and a **New channel** button, wearing your colour. Try a few. Nobody is watching. Yet.

The button stays greyed out until both the name and the initials are filled in.

Your look belongs to your account, not to this Mac, so it follows you to your other devices and to every Organization you belong to. To change it later, open **Settings → Account**, where changes save as you make them. [Light, dark and your own colour](../09-settings-and-shortcuts/02-appearance-and-icon.md) has more.

## Invite your teammates

The last step is for bringing your team in: **Add email addresses to invite people to your organization.**

1. Type or paste email addresses into **Email addresses**. Separate them with a space, a comma or a semicolon. Pasting a whole list works too.
2. Each address turns into a chip when you type a separator, press <kbd>Return</kbd> or click elsewhere. Click the **×** on a chip to remove it.
3. Click **Invite 3 teammates** (the number counts your chips). Rally sends the invitations.

Everyone you invite here joins as a **Member** and can use your organization connections. As the screen says, your private Channels stay private.

If an address is not complete, Rally says **Enter a complete email address for each teammate.** If some invitations fail to send, it lists them after **Could not invite:** and leaves them in the box to fix and retry. Retrying never sends a second invitation to someone who already has one, or who is already a member.

Not ready to invite anyone? Click **Invite later**. (Once you have sent some, the same button reads **Continue**.) You can invite people, and make some of them administrators, at any time; see [Inviting people](../10-running-an-organization/02-inviting-people.md).

## When setup is done

Rally takes you into your new Organization. Finishing setup does not create a Channel for you or set Rally to work on anything; it waits for you. Before you type anything, take [a tour of the window](04-a-tour-of-the-window.md) so you know where everything is.
