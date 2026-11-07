---
title: The Settings window
description: Open Settings, find any setting by searching, and set up your profile and time zone.
---

Everything you can adjust in Rally is in the Settings window. It opens beside the main window rather than on top of it, so you can change
something and watch the effect in the conversation behind.

## Opening Settings

There are three ways in:

- Press <kbd>⌘</kbd> <kbd>,</kbd> (Command and comma). This is the same key
  that opens settings in almost every Mac app, so your fingers may already know
  it.
- Choose **Rally → Settings…** from the menu bar at the top of the screen.
- Click **Settings** at the bottom of the rail, on the left edge of the window.

Some links and buttons elsewhere in Rally open Settings straight at the right
section, so you may land in the middle of it rather than at the top.

Settings opens in the main window, in place of whatever you had open. Close it
and you are back where you were.

Changes take effect the moment you make them. There is no **Save** button to
forget.

### Closing it

Click the **X** (**Close settings**), press <kbd>⌘</kbd> <kbd>W</kbd>, or press
<kbd>Esc</kbd>. Escape is polite about it: it will not close the window while a
dialog or menu is open, while you are halfway through typing something you have
not saved, or while there is text in the search box. In that last case the first
<kbd>Esc</kbd> clears the search and the second closes the window.

## The sections

The list down the left side has two groups. The first, headed **Settings**, is
about you and your Organization. The second, headed **Desktop app**, is about
Rally on this Mac.

| Section | What you find there | More in |
| --- | --- | --- |
| **Account** | Your profile, your default time zone, and **Sign out of Rally**. | This page, and [Signing in, signing out and Lockdown mode](../11-privacy-and-security/01-signing-in-and-out.md) |
| **Notifications** | Whether this Mac shows alerts, and how mentions, Needs input and finished runs reach you. | [Notifications](../08-rally-everywhere/03-notifications.md) |
| **Organization** | The Organization's name, its default time zone, its members and invitations. | [Organization settings](../10-running-an-organization/03-organization-settings.md) |
| **Security** | Where code Rally runs is allowed to connect. | [Organization settings](../10-running-an-organization/03-organization-settings.md) |
| **Connections** | Every tool you or your Organization have connected, and the ones you could add. | [Settings → Connections](../05-connecting-your-tools/01-connections.md) |
| **GitHub** | Which repositories Rally may touch. Indented under **Connections**. | [GitHub](../05-connecting-your-tools/04-github.md) |
| **MCP tools** | The tools offered by a custom MCP server. Indented under **Connections**. | [Custom MCP server](../05-connecting-your-tools/14-custom-mcp-server.md) |
| **Application** | Security, privacy, appearance, the menu bar, the app icon, updates, startup and the version number. | The rest of this chapter |

Not everyone sees every section, and a missing one is not a fault:

- **On this Mac**, inside **Notifications**, appears only once notifications
  on the Mac have been turned on for your account.
- **GitHub** appears only after someone has connected GitHub, and **MCP tools**
  only after a custom MCP server is connected.

## Searching Settings

At the top of the list is a **Search** box. It searches every setting by its
label, its description and the names of its options, and it also knows the
everyday words people reach for. A few examples:

| You type | It finds |
| --- | --- |
| theme | **Appearance** |
| colour | Your profile **Color** |
| time zone | Both **Default timezone** pickers (yours and the Organization's) |
| startup | **Open Rally at login** |
| privacy, diagnostics | **Product analytics** |
| workspace | The **Organization** settings |

Once you have typed something:

- <kbd>Return</kbd> opens the first result.
- <kbd>↓</kbd> moves from the box into the list of results, so you can pick
  another one.
- <kbd>Esc</kbd> clears the box.

Settings that only administrators can change are left out of the results if you
are not one, so you will not be sent somewhere you cannot touch. Secret values,
such as an API key or a password you typed into a connection, are never
searchable.

> [!TIP]
> You do not need to remember which section a setting is in. Press
> <kbd>⌘</kbd> <kbd>,</kbd>, type a word, press <kbd>Return</kbd>. It is the
> fastest way to anything in this chapter.

## Your profile

**Account** opens on **Profile**, which is how the rest of your Organization
sees you. The subtitle under it still says "Your Rally identity and access in
this workspace". Workspace is the old word for Organization; they are the same
thing.

At the top is a preview of your avatar next to your name, your email address and
a badge with your role in the current Organization. The email address and the
role are shown here for reference only. Roles are changed by an administrator,
as [Roles](../10-running-an-organization/01-roles.md) explains.

Below that you can change three things:

- **Name**: your display name, the one teammates see on your messages and when
  they @-mention you.
- **Avatar initials**: the letters inside your avatar. Rally suggests two from
  your name, but you can type your own.
- **Color**: your avatar colour, which also tints parts of Rally for you. Pick
  one of the round swatches. [The next page](02-appearance-and-icon.md#your-personal-colour)
  explains what it changes.

The preview updates as you go, so you can try a colour on before you commit to
it. Since there is no Save button, you have, in fact, already committed to it.
Pick another one if it does not suit.

Your profile belongs to your account, not to this Mac, so it follows you to any
computer you sign in on.

## Your time zone

Under **Account → Preferences** is **Default timezone**. Pick your time zone
from the list.

Rally uses it for:

- **Your Sidekicks.** When one of your personal Sidekicks runs "every weekday at
  9" and does not name a time zone of its own, it means 9 in this one. The
  description under the setting still calls them "personal automations", which
  is the old name for Sidekicks. See
  [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md).

This is your own time zone. The Organization has a separate **Default timezone**
under **Organization**, used for Sidekicks that belong to the whole
Organization. That one only an administrator can change.

## Signing out

**Account → Session** has **Sign out of Rally** and its **Sign out** button,
which removes your saved session from this Mac. What that means, and how long
Rally keeps you signed in otherwise, is in
[Signing in, signing out and Lockdown mode](../11-privacy-and-security/01-signing-in-and-out.md).

## Which version you are running

At the bottom of **Application** is **About**, with a **Version** row that
shows which release of Rally this Mac is running. You can also choose
**Rally → About Rally** from the menu bar. If the version cannot be read, the
row says **Unknown**.

It is the first thing support will ask for. Find it now, while nothing is on
fire. [Contacting support](../12-help-and-glossary/03-contact-support.md)
has the rest of what to include.
