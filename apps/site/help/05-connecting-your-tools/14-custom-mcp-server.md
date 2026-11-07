---
title: Custom MCP server
description: Give Rally the tools from any MCP server you run or trust, and decide which of them it may use.
nav_title: Custom MCP
---

The last connector is the most open-ended. If your team runs its own tools, or uses a service that has no card in Settings, you can often still connect it to Rally through MCP. Like the inbound webhook, this page leans a little technical.

MCP (Model Context Protocol) is a standard way for a tool to tell an AI what it can do, and to let the AI do it. A service that speaks MCP runs an MCP server: a web address that lists its tools and carries them out when asked. Point Rally at one and Rally can use its tools in your Canvases and Sidekicks, alongside everything else in this chapter.

## Adding a server

1. Open **Settings → Connections** and find the **Custom MCP server** card.
2. Click **Connect for me** for a server only you can use, or **Connect for organization** (owners and administrators) to share it with everyone. The **Connect an MCP server** dialog opens.
3. Fill in **Name**. This is only how the server is listed in Rally.
4. Fill in **Server URL**, the server's address. It must start with `https://`, and the server must use the "Streamable HTTP" kind of MCP, which most current servers do. The server's own documentation gives the address.
5. Choose how Rally signs in under **Authorization** (see below).
6. For an Organization server, choose **Tools Rally may use** (see below).
7. Click **Authorize server** or **Add server**, depending on how it signs in.

Before reporting success, Rally checks that the server answers and offers at least one tool this connection may use. A mistyped address or a wrong header shows up now, rather than days later in the middle of a task.

You can add as many custom servers as you like.

### Authorization

**Sign in through the server (OAuth)** sends you to the server's own sign-in page in your browser, the same as most connectors in this chapter. For a personal connection, Rally acts as whoever you sign in as. For an Organization connection, the one account you sign in with is the account every member reaches the server as, so choose it with care.

**Send request headers I provide** is for servers that want a key with every request. Add each header's name (such as `Authorization`) and its value. Click **Add another header** for more. Rally encrypts the values, sends them with every request, and never shows them again. To change one, add the server again with the new value and delete the old connection.

> [!WARNING]
> Header values are secrets. Type them only into this dialog, never into a chat, a Canvas, an email or a support message.

### Tools Rally may use

An Organization server has a setting that decides how much of it Rally may use:

- **All tools**: everything the server offers.
- **Read-only tools**: only the tools the server marks as read-only.

That marking is the server's own claim about its tools. Rally cannot check it, and a tool with no marking counts as one that makes changes. Choosing read-only narrows what Rally is offered. It does not give the server's account any extra access.

The small print in the dialog says "every call asks first". That is out of date. Rally never asks before each call. **Tools Rally may use** is the control: if you only want Rally reading from a shared server, choose **Read-only tools**.

A personal server has no such setting. It acts as you, nobody else can use it, so it offers exactly what you can already do there.

## The MCP tools page

Once you have connected a custom server, **MCP tools** appears under **Connections** in the Settings list. If you have more than one server, pick it from the **Connection** menu. The page shows:

- the server's address, and how it signs in
- **Authorize again**, for servers that use OAuth sign-in
- **Tools Rally may use**, which administrators can change for an Organization server at any time
- **Tools**, every tool the server currently offers, with its description

Each tool is tagged **Read-only**, **Write** or **Destructive**, and **Available** or **Withheld**. Withheld tools are the ones the policy is holding back. They stay on the list so you can see what changing the policy would allow.

Rally reads this list from the server live each time the page opens, and each time it uses the server, so the server is always the authority on what it offers.

## Keeping connected tools to reading only

Two connectors let an administrator keep Rally looking but not touching. Here, set an Organization server to **Read-only tools**. On [GitHub](04-github.md), limit Rally to **Selected repositories** and set them to **Read-only remote**. Because Rally does not ask before each action, these settings are where you draw the line.

## When a server stops working

1. Open **MCP tools** in Settings. It shows what the server is answering right now.
2. For a server you signed in to, click **Authorize again**. Access can be withdrawn on the server's side without Rally being told.
3. For a server that uses headers, add it again with the current values and delete the old connection.

If you contact support, send the server address, whether the connection is personal or for the Organization, roughly when it happened, your Rally region and any request ID you can see. Never send header values or access tokens.

That is the last connector. The next chapter is about what Rally hands back: [Things Rally makes](../06-things-rally-makes/index.md).
