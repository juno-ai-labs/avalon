---
title: Rally on your Mac
description: Keep Rally in the menu bar, start it at login, and understand its windows and menus.
---

Rally is a Mac app, and it tries to behave like one. This page covers the habits
it has as a resident of your Mac: an icon in the menu bar, starting when you log
in, staying open when you close its window, and the menus along the top of the
screen. The settings for the first two are in **Settings → Application**.

## Rally in the menu bar

The menu bar is the strip across the top of your screen, and its right-hand end
is where small icons for the Wi-Fi, the battery and the clock live. Rally keeps
its mark there too, unless you tell it not to.

Click the Rally mark and you get:

- **Your recent Channels**, up to ten, grouped under the same date headings the
  sidebar uses. Click one to open it in Rally. Very long names are shortened to
  fit, and a Channel Rally has not finished naming yet shows as **Untitled
  channel**.
- **Open Rally**, which brings the main window forward.
- **Quit Rally**, which really does quit it.

If you have no recent Channels, the menu says **No recent channels**. If you are
signed out, it says **Sign in to Rally**. The list refreshes when you click the
icon, so it is always current.

Why bother? It is the fastest way back into something you were working on an
hour ago, from any app, without hunting for the Rally window. It also gives
Rally somewhere to live when no window is open, which matters more than it
sounds (see [Closing the window is not quitting](#closing-the-window-is-not-quitting)).

### Turning it on or off

The switch is **Show Rally in the menu bar**, in **Settings → Application**
under **Appearance**. It is on by default.

> [!NOTE]
> The description under the switch mentions starting a new meeting or note, a
> new automation and Rally's suggestions from the menu bar. Today the menu holds
> your recent Channels, **Open Rally** and **Quit Rally**, and nothing more.
> ("Automation" is also the old name for a Sidekick.)

If the switch is on but the mark has not appeared, Settings says "Rally could not
add itself to the menu bar. Turn this off and on to try again, or restart Rally."
Do as it says; one of the two almost always works.

## Opening Rally at login

**Settings → Application → Startup** has **Open Rally at login**. With it on,
Rally starts by itself whenever you log in to your Mac, so it is ready when you
sit down and notifications reach you without you having to remember to open it.

How it starts depends on the menu bar setting:

- **With Rally in the menu bar**, it starts quietly there, with no window. Click
  the mark, or the Dock icon, when you want it.
- **Without it**, a window opens as usual.

When you install Rally, it turns this on for you the first time it runs. Switch
it off and it stays off.

macOS has the final say over what opens at login. If you remove Rally from the
Mac's own **System Settings → General → Login Items**, Rally respects that, and
the switch in Settings shows whatever macOS reports. If macOS wants you to
approve the change first, the switch reflects that too, until you do.

## Closing the window is not quitting

On a Mac, closing Rally's window with the red button or <kbd>⌘</kbd>
<kbd>W</kbd> does not quit Rally. It keeps running in the background, so the
menu bar mark stays and notifications keep arriving. This is normal Mac
behaviour, the same as Mail or Messages, but it can be a surprise if you
expected the app to go away.

To bring a window back, click Rally in the Dock, click **Open Rally** in the menu
bar, or open Rally again from Applications.

To really quit, do one of these:

- Press <kbd>⌘</kbd> <kbd>Q</kbd>.
- Choose **Rally → Quit Rally** from the menu bar at the top of the screen.
- Click the Rally mark in the menu bar and choose **Quit Rally**.

Only one copy of Rally runs at a time. Opening it again while it is already
running brings the existing window forward instead of starting a second copy.

## Rally's windows

Most of the time you work in the main window, but Rally opens a few others. Each
is an ordinary Mac window: you can move it, resize it, or put it on another
display, and Rally remembers where you left it, including which display.

| Window | How to open it |
| --- | --- |
| The main window | It is the one you are reading Channels in. |
| **Settings** | <kbd>⌘</kbd> <kbd>,</kbd>, or the account menu → **Settings**. See [The Settings window](01-the-settings-window.md). |
| **Rally Sidekicks** | The account menu → **Sidekicks**. See [The Sidekicks window](../07-sidekicks/04-the-sidekicks-window.md). |
| **Import Channel** | When you bring in a conversation from elsewhere. See [Bring in a conversation from Claude or ChatGPT](../02-working-in-a-channel/08-import-from-claude-or-chatgpt.md). |
| An artifact in its own window | **Open in a new window** in an artifact's header. See [Opening, docking and downloading](../06-things-rally-makes/02-opening-and-downloading.md). |

Pop-out artifact windows are especially handy on a second monitor: keep a
document open on one screen while you discuss it on the other. Ones you leave
open come back after you quit and reopen Rally.

In the Settings and Sidekicks windows, <kbd>Esc</kbd> closes the window, as long
as no dialog is open and you are not in the middle of typing something.

## The menus at the top of the screen

When Rally is the app in front, the Mac's menu bar shows Rally's menus.

| Menu | What is in it |
| --- | --- |
| **Rally** | **About Rally**, **Check for Updates…**, **Settings…**, and the usual Mac items: **Services**, **Hide Rally**, **Hide Others**, **Show All** and **Quit Rally**. |
| **File** | **Close Window** (<kbd>⌘</kbd> <kbd>W</kbd>). |
| **Edit** | The standard editing commands: undo, redo, cut, copy, paste, select all. |
| **View** | The standard view commands, such as zooming in and out and entering full screen. |
| **Window** | The standard window commands, such as minimise. |
| **Help** | **Rally website**, which opens rallywith.ai in your browser. |

The **Check for Updates…** item changes its wording as an update arrives; the
[next page](04-updates.md) explains each stage. The help you are reading is on
the website, so **Help → Rally website** is one way back to it.

> [!TIP]
> **View** is where to zoom. If text in Rally is too small to read comfortably,
> zooming in makes everything larger, not only one Channel.
