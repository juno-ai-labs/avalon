---
title: Settings
description: Open Settings, find any setting by searching, and set up your profile and time zone.
---

Everything you can adjust in Rally is in Settings.

## Opening Settings

Click your avatar (**Settings**) at the bottom of the rail and choose
**Settings**.

Some links and buttons elsewhere in Rally open Settings straight at the right
section, so you may land in the middle of it rather than at the top.

In the web app, Settings takes the whole tab, in place of the sidebar and
whatever you had open, and the tab's title changes to **Settings · Rally**.

Changes take effect the moment you make them. Apart from the personal system
prompt, which has its own **Save**, there is no button to forget.

### Closing it

Click the **X** (**Close settings**) at the top right. You are back where you
were, with your Canvases and Sidekicks as you left them.

On a phone, the list of sections sits behind a button in the header (**Open
settings sections**). Tap a section to open it.

### In the desktop app

The [desktop app](../08-rally-everywhere/04-the-desktop-app.md) opens Settings
in a window of its own instead, and gives you two more ways in:

- Press <kbd>⌘</kbd> <kbd>,</kbd> (Command and comma) on a Mac, or
  <kbd>Ctrl</kbd> <kbd>,</kbd> on Linux. This is the same key that opens
  settings in almost every Mac app, so your fingers may already know it.
- Choose **Rally → Settings…** from the menu bar at the top of a Mac's screen.

To close the Settings window there, click the **X**, press <kbd>⌘</kbd>
<kbd>W</kbd>, or press <kbd>Esc</kbd>. Escape is polite about it: it will not
close the window while a dialog or menu is open, while you are halfway through
typing something you have not saved, or while there is text in the search box.
In that last case the first <kbd>Esc</kbd> clears the search and the second
closes the window.

## The sections

The list down the left side starts with a group headed **Settings**, about you
and your Organization.

| Section | What you find there | More in |
| --- | --- | --- |
| **Account** | Your profile, your time zone, **Connected apps** (such as Claude or ChatGPT using Rally for you), **Appearance** (light or dark), and **Sign out of Rally**. | This page, [Light, dark and your own colour](02-appearance-and-icon.md) and [Signing in, signing out and Lockdown mode](../11-privacy-and-security/01-signing-in-and-out.md) |
| **Preferences** | What opens when you start Rally (**On startup**), your personal system prompt, **Show agent work**, and **Product analytics**. Indented under **Account**. | This page and [What Rally shares, and with whom](../11-privacy-and-security/02-what-rally-shares.md) |
| **Memories** | What Rally remembers about you. | [Memory and coming back later](../04-working-with-rally/05-memory-and-coming-back-later.md) |
| **Notifications** | Whether this browser shows alerts, and how each kind of Activity reaches you. | [Activity and notifications](../08-rally-everywhere/03-notifications.md) |
| **Organization** | The Organization's name and default time zone, **Allow Rally access**, what Rally remembers about the Organization, and leaving. | [Organization settings](../10-running-an-organization/03-organization-settings.md) |
| **Members** | Everyone in the Organization, and invitations. Indented under **Organization**. | [Roles](../10-running-an-organization/01-roles.md) and [Inviting people](../10-running-an-organization/02-inviting-people.md) |
| **Billing** | The plan and weekly quota. Indented under **Organization**. | [Organization settings](../10-running-an-organization/03-organization-settings.md) |
| **Security** | Where code Rally runs is allowed to connect. | [Organization settings](../10-running-an-organization/03-organization-settings.md) |
| **Connections** | Every tool you or your Organization have connected, and the ones you could add. Each connection has a page of its own, indented under it. | [Settings → Connections](../05-connecting-your-tools/01-connections.md) |

The desktop app adds a second group, headed **Desktop app**, with one section,
**Application**. It holds the app's security, privacy, appearance, menu bar,
app icon, updates, startup and version number, and the rest of this chapter
covers it. In the desktop app, **Appearance** lives there rather than under
**Account**. The web app has no **Desktop app** group, because there is no app
to set up.

Not everyone sees everything, and a missing piece is not a fault:

- **In this browser**, inside **Notifications**, appears only where Rally can
  send notifications. The desktop app calls it **On this Mac**.
- A guest sees every section, but can open only **Account**, **Preferences**,
  **Members** and, in the desktop app, **Application**.

## Searching Settings

At the top of the list is a **Search** box. It searches every setting by its
label, its description and the names of its options, and it also knows the
everyday words people reach for. A few examples:

| You type | It finds |
| --- | --- |
| theme | **Appearance** |
| colour | Your profile **Color** |
| time zone | Both **Default timezone** pickers (yours and the Organization's) |
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
> You do not need to remember which section a setting is in. Open Settings,
> type a word, press <kbd>Return</kbd>. It is the fastest way to anything in
> this chapter.

## Your profile

**Account** opens on **Profile** ("Your Rally identity and access in this
Organization"), which is how the rest of your Organization sees you.

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

Your profile belongs to your account, not to this browser, so it follows you
everywhere you sign in.

## Your time zone

On the **Account** page, under **Preferences**, **Set timezone automatically**
follows the time zone of the device you are using, so it moves when you travel.
Turn it off to choose one yourself from **Default timezone**.

Rally uses it for your Sidekicks: a new personal Sidekick that runs "every
weekday at 9" and does not name a time zone of its own starts in this one. See
[Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md).

This is your own time zone. The Organization has a separate **Default timezone**
under **Organization**, used for Sidekicks that belong to the whole
Organization. That one only an administrator can change.

## How Rally works for you

The **Preferences** page, under **Agent**, has two settings that apply to you
in this Organization:

- **Personal system prompt**: instructions Rally includes with every message
  you send, such as "Answer briefly. I work in Go and Postgres." Type them and
  click **Save**. Nobody else sees them, and they are not shown in the
  conversation.
- **Show agent work**: whether conversations show Rally's thinking and its
  tool and plugin calls. Turn it off for a quieter conversation. Requests that
  need you, such as connecting an account, always show.

**Memories** lists what Rally has saved about you, under **What Rally remembers
about you**, and lets you remove an entry. See
[Memory and coming back later](../04-working-with-rally/05-memory-and-coming-back-later.md).

## Signing out

**Account → Session** has **Sign out of Rally** and its **Sign out** button.
What that means, and how long Rally keeps you signed in otherwise, is in
[Signing in, signing out and Lockdown mode](../11-privacy-and-security/01-signing-in-and-out.md).

## Which version you are running

The web app is always the newest version: loading the page loads it. There is
no version number to look up.

In the desktop app, the bottom of **Application** has **About**, with a
**Version** row that shows which release of Rally this computer is running. On
a Mac you can also choose **Rally → About Rally** from the menu bar. If the
version cannot be read, the row says **Unknown**.

It is the first thing support will ask a desktop app user for. Find it now,
while nothing is on fire. [Contacting support](../12-help-and-glossary/03-contact-support.md)
has the rest of what to include.
