---
title: Signing in, signing out and Lockdown mode
description: How long Rally keeps you signed in, how to sign out, and how to protect your saved sign-in with your Mac's keychain.
nav_title: Signing in and out
---

You signed in to Rally with your Google account back in
[Chapter 1](../01-getting-started/01-install-rally.md). Since then Rally has
kept you signed in, so you do not see the Google screen every morning. This
page explains how long that lasts, how to end it, and how to make the saved
sign-in on your Mac harder to misuse.

## How long you stay signed in

Rally saves a sign-in on your Mac and renews it quietly while you use the app.

- Each renewal gives it another 30 days. If you do not open Rally for 30
  days, the sign-in lapses.
- However often you use Rally, a sign-in never lasts more than 90 days from
  the moment you signed in with Google.

When either limit is reached, Rally asks you to sign in with Google again. Your
Canvases, Sidekicks, settings and connections are still there afterwards. Only the
sign-in was renewed.

These limits exist so that a sign-in left on an old laptop, or copied from one,
does not stay useful forever.

> [!NOTE]
> Switching to another Organization can also ask you to finish signing in in
> your browser. That is expected, and you come straight back to Rally
> afterwards. [Belonging to several Organizations](../10-running-an-organization/04-several-organizations.md)
> covers switching.

## Signing out

Sign out when you are handing the Mac to someone else, selling it, or want to
sign in with a different Google account.

There are two ways:

- Click your avatar at the bottom left of the window to open the
  account menu (the one from the
  [tour of the window](../01-getting-started/04-a-tour-of-the-window.md)), then
  choose **Log out**. (Some older layouts call it **Sign out**.)
- Open **Settings → Account**, find **Session**, and click **Sign out** beside
  **Sign out of Rally**.

Signing out deletes the saved sign-in, and any unsent drafts, from this Mac.
It closes any artifact windows you popped out. It also tells
Rally's servers to end that sign-in, so it cannot be used again even if a copy
of it exists somewhere.

Signing out only affects this Mac. If you also use Rally in a web browser,
you stay signed in there until you sign out there too.

### Signing out is not leaving

People mix these two up, and they do different things.

| | Signing out | Leaving an Organization |
| --- | --- | --- |
| Where it applies | This device only | Every device you use |
| What you lose | Nothing; sign in again and everything is back | Access to that Organization's Canvases and Sidekicks |
| How to undo it | Sign in with Google | Someone has to invite you again |

Leaving is covered in
[Leaving, removing and closing](../10-running-an-organization/05-leaving-and-removing.md).

### Signed in with the wrong Google account

If you notice during the first-run screens that you signed in with the wrong
Google account (a personal one instead of your work one, say), look for the
**Sign out** link on those screens. It takes you back to the start so you can
sign in with the right account.

## Lockdown mode

Rally encrypts the sign-in it saves on your Mac. By default it uses an
encryption key that is built into the Rally app and is the same for every copy
of Rally. That keeps your sign-in working through updates and changes to your
Mac, but it means the saved sign-in is not tied to this particular computer.

**Lockdown mode** changes that. With it on, Rally protects the saved sign-in
with your Mac's keychain: the secure store macOS uses for passwords, which
belongs to your Mac and your user account on it. If someone copied Rally's
files from your Mac to another computer, the sign-in would not come with them.

Turn it on if you share a Mac, travel with it, or work somewhere that asks for
extra care with saved credentials.

### Turning it on or off

1. Open **Settings → Application**.
2. Under **Security**, turn on **Lockdown mode**.

Rally re-encrypts your saved sign-in straight away. While it does, the other
switches on the **Application** page wait for it to finish, so a short pause
there is normal. You stay signed in. Turning Lockdown mode off again
works the same way in reverse.

Lockdown mode is a setting for this Mac only.

### When the keychain is not available

Lockdown mode depends on macOS letting Rally use the keychain. If that ever
stops working:

- If Lockdown mode is off, the switch is greyed out and reads **Lockdown mode
  is off because this Mac's keystore is unavailable.**
- If Lockdown mode was on, Rally cannot read the protected sign-in. It turns
  Lockdown mode off and asks you to sign in with Google again. If this happens
  while Rally is already open, the page reads **This Mac's keystore is
  unavailable. Turn off Lockdown mode to keep using the loaded session.** Turn
  the switch off and you can carry on.

> [!WARNING]
> Change Lockdown mode only with the switch in Settings. If Rally's settings
> file is edited by hand to turn Lockdown mode off, Rally deletes the protected
> sign-in rather than unlock it, and you have to sign in again.
