---
title: Keeping Rally up to date
description: Rally updates itself; choose how quickly new versions arrive and when to restart.
nav_title: Updates
---

Rally is young and changes often. The good news is that you never have to go
and fetch a new version. Rally does it for you, and the only thing it needs from
you is a restart at a moment that suits you.

## How Rally updates itself

Rally checks for a new version when it starts and then about every three hours
while it runs. When it finds one, it downloads it quietly in the background,
without interrupting anything you are doing. The new version is installed the
next time you restart or quit Rally.

You can see each stage in the **Rally** menu at the top of the screen, where the
update item changes as it goes:

| The menu says | What is happening |
| --- | --- |
| **Check for Updates…** | Nothing is waiting. Click it to check right now. |
| **Checking for Updates…** | Rally is asking whether there is a new version. |
| **Downloading Update… 40%** | A new version is on its way, with how far along it is. |
| **Restart to Update 1.2.3** | The new version is downloaded and ready. Click to restart into it. |

(Your numbers will differ. Version 1.2.3 is an example, not a promise.)

When you check by hand and there is nothing new, Rally tells you **You are
running the latest version**. If it cannot reach the update service, it says
**Couldn't check for updates**; try again later.

## Restarting to finish an update

Once an update has downloaded, Rally gives you three easy ways to finish it:

- A **Restart to update to Rally** button (with the version number) appears in
  the sidebar.
- **Restart to Update** appears at the top of the account menu, which you open
  by clicking your name at the bottom of the sidebar.
- **Rally → Restart to Update** in the menu bar.

Or do nothing, and the update installs the next time you quit Rally anyway.

Rally does not restart behind your back. The one time it speaks up is when the
version you are running is more than a week old and a newer one has already
downloaded. Then it asks, once per version, with an **Update ready** message and
two buttons, **Restart Now** and **Later**. **Later** really does mean later.

Restarting is quick, and your drafts survive it, so there is rarely a bad time.
Have you tried turning it off and on again? For once, that is the official
advice.

> [!NOTE]
> If a restart to update fails, Rally tells you it kept your current session and
> did not install the update. Nothing is lost; try again.

## Stable or Faster

**Settings → Application → Updates** has **Update channel**, which decides how
quickly new versions reach this Mac:

| Channel | What you get |
| --- | --- |
| **Stable** | At most one release every 24 hours. This is the default. |
| **Faster** | Every desktop release, as soon as it is out. |

If several releases come out in one day, **Stable** skips the in-between ones
and gives you one a day at most. **Faster** gives you each one.

### Which to choose

Stay on **Stable** if:

- You use Rally all day and would rather restart less often.
- You give demos or run meetings in Rally and want fewer surprises.

Choose **Faster** if:

- Support has told you a fix for your problem is on its way and you want it the
  moment it ships.
- You like seeing new things first and do not mind the occasional extra
  restart.

You can switch at any time. Moving from **Faster** back to **Stable** never
takes you back to an older version: you stay where you are until **Stable**
catches up. If you switch while an update is downloading, Rally drops that
download and checks again on the new channel.

## When updates are not available

Automatic updates work in the Rally app you downloaded from rallywith.ai and
installed in Applications. A few situations are different:

- **A build that cannot update.** If you somehow run a copy that is not the
  normal installed app, **Check for Updates…** answers **Updates aren't
  available in this build**, and the **Update channel** setting does not appear.
- **Your company has switched updates off.** An IT department can turn off
  automatic updates on a managed Mac. If that is your situation, they will be
  the ones to install new versions.
- **The download keeps failing.** After several failed attempts, Rally shows
  **Couldn't update automatically** with two buttons. **Download Latest** opens
  the newest installer in your browser; open it and replace the copy of Rally in
  your Applications folder, as you did when you
  [first installed it](../01-getting-started/01-install-rally.md). **Later**
  leaves things as they are for now.

If none of that helps, [contact support](../12-help-and-glossary/03-contact-support.md)
and include the version number from **Settings → Application → About**.
