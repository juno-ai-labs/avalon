---
title: Signing in, signing out and Lockdown mode
description: How you sign in, how long Rally keeps you signed in, how to sign out, and how the desktop app can protect its saved sign-in.
nav_title: Signing in and out
---

You signed in to Rally back in
[Chapter 1](../01-getting-started/01-open-rally-and-sign-in.md). Since then
Rally has kept you signed in, so you do not see the sign-in page every morning.
This page explains how long that lasts, how to end it, and, for the desktop
app, how to make its saved sign-in harder to misuse.

## How you sign in

In the web app there are three ways in: **Continue with Google**, **Continue
with Apple**, and **Continue with email**, which sends you a code and a link.
There is no password to forget. Whichever you use, the email address is your
identity in Rally.

The [desktop app](../08-rally-everywhere/04-the-desktop-app.md) offers only
Google and Apple. It opens your usual browser to sign in and hands you back. If
you signed up in the browser with an email code, sign in to the app with a
Google or Apple account that uses the same address.

## How long you stay signed in

In the web app, your sign-in works in every tab of that browser and renews
itself quietly while you use Rally. Leave Rally alone for a long time and it
asks you to sign in again. Your Canvases, Sidekicks, settings and connections
are still there afterwards. Only the sign-in was renewed.

The desktop app saves a sign-in on your computer and renews it the same way.

- Each renewal gives it another 30 days. If you do not open the app for 30
  days, the sign-in lapses.
- However often you use it, a sign-in never lasts more than 90 days from the
  moment you signed in.

These limits exist so that a sign-in left on an old laptop, or copied from one,
does not stay useful forever.

> [!NOTE]
> In the desktop app, switching to another Organization can also ask you to
> finish signing in in your browser. That is expected, and you come straight
> back to the app afterwards.
> [Belonging to several Organizations](../10-running-an-organization/04-several-organizations.md)
> covers switching.

## Signing out

Sign out when you are on a shared or borrowed computer, handing yours to
someone else, or want to sign in with a different account.

There are two ways:

- Click your avatar at the bottom left of the window to open the
  account menu (the one from the
  [tour of the window](../01-getting-started/04-a-tour-of-the-window.md)), then
  choose **Log out**. (Some older layouts call it **Sign out**.)
- Open **Settings → Account**, find **Session**, and click **Sign out** beside
  **Sign out of Rally**.

Signing out tells Rally's servers to end that sign-in, so it cannot be used
again even if a copy of it exists somewhere. It also deletes your unsent drafts
and the copies of conversations Rally kept on the device.

- **In a browser,** signing out in one tab signs you out in every Rally tab in
  that browser. Other browsers and the desktop app stay signed in until you
  sign out there too.
- **In the desktop app,** signing out deletes the saved sign-in from that
  computer and closes any artifact windows you popped out. Your browsers stay
  signed in.

### Signing out is not leaving

People mix these two up, and they do different things.

| | Signing out | Leaving an Organization |
| --- | --- | --- |
| Where it applies | This browser or computer only | Every device you use |
| What you lose | Nothing; sign in again and everything is back | Access to that Organization's Canvases and Sidekicks |
| How to undo it | Sign in again | Someone has to invite you again |

Leaving is covered in
[Leaving, removing and closing](../10-running-an-organization/05-leaving-and-removing.md).

### Signed in with the wrong account

If you notice that you signed in with the wrong account (a personal one instead
of your work one, say), click **Sign out** at the bottom of **Your
organizations**, or on the first-run screens, and sign in again with the right
one.

## Lockdown mode

Lockdown mode is a setting of the
[desktop app](../08-rally-everywhere/04-the-desktop-app.md). The web app keeps
your sign-in in the browser, which looks after it for you, and has no
equivalent switch.

The desktop app encrypts the sign-in it saves on your computer. By default it uses an
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

Lockdown mode is a setting for this computer only.

On Linux, Lockdown mode uses your system's own password store instead of the
keychain, where there is one. Its messages still say "this Mac", which you can
read as "this computer".

### When the keychain is not available

Lockdown mode depends on macOS letting Rally use the keychain. If that ever
stops working:

- If Lockdown mode is off, the switch is greyed out and reads **Lockdown mode
  is off because this Mac's keystore is unavailable.**
- If Lockdown mode was on, Rally cannot read the protected sign-in. It turns
  Lockdown mode off and asks you to sign in again. If this happens
  while Rally is already open, the page reads **This Mac's keystore is
  unavailable. Turn off Lockdown mode to keep using the loaded session.** Turn
  the switch off and you can carry on.

> [!WARNING]
> Change Lockdown mode only with the switch in Settings. If Rally's settings
> file is edited by hand to turn Lockdown mode off, Rally deletes the protected
> sign-in rather than unlock it, and you have to sign in again.
