---
title: Leaving, removing and closing
description: Leave an Organization, remove someone from one, and understand what happens when the last person leaves.
---

People move on from teams, and teams sometimes wind down. This page covers
leaving an Organization yourself, what happens when someone's access ends, and
closing an Organization when the last person leaves. Read it before you click
anything red.

## Leave an Organization

Any member can leave, including administrators. Leaving ends your membership
on every device you use, not only the one in front of you.

1. Open **Settings → Organization** and scroll to the bottom, to
   **Organization access**. It says **Leaving removes this organization from
   your Rally account on every device.**
2. Click **Leave this organization**.
3. A dialog asks **Leave** *Organization name*?, and explains that the
   Organization stays available to its other members.
4. Click **Leave organization** to confirm, or **Cancel**.

The button stays greyed out until Rally has loaded the members list, because it
needs to know whether you are the last person in the Organization. If the list
cannot load, Rally says **Rally could not verify whether anyone else belongs to
this workspace.** "Workspace" is the old word for Organization. Check your
connection and open Settings again.

### What happens when you leave

- The Organization disappears from your account on every device.
- On the Mac you left from, Rally deletes that Organization's unsent drafts and
  the copies of its conversations it kept on your computer.
- Rally then opens your next Organization, if you belong to another one, or
  takes you back to the screen for joining or creating one.
- Work you did in the Organization stays there with the people who remain.
  The Organization carries on without you.

To get back in later, you need a new invitation from an owner or
administrator.

### If you are the only owner

An owner cannot leave while they are the only owner and other people are still
in the Organization. Rally refuses with **You are the only owner of this
workspace. Another owner has to exist before you can leave.**

There is no button in the app to make someone else an owner. If you need to
hand over an Organization and step away, write to
[help@rallywith.ai](mailto:help@rallywith.ai), and say which Organization it
is and who should take it over.

### Leaving from your iPhone

On the iPhone app, open **Settings**, and under **Organization** tap **Leave
this organization**. Rally asks **Leave this organization?** Tap **Leave** to
confirm, or **Cancel**.

The dialog says you will stop seeing the Organization *on this device*, but
leaving from the phone ends your membership everywhere, exactly as it does from
the Mac.

The iPhone cannot close an Organization. If you are its last member, leaving
from the phone fails with **Couldn't leave this organization.** Use the Mac, as
described next.

## The last person out: closing an Organization

When you are the only member left, the Mac changes the wording to make the
consequence plain. Under **Organization access** the row reads **Leave and
close this organization**, with the note **You are the last member. The
organization will become unavailable without deleting its retained data.**

1. Click **Leave and close organization**.
2. The dialog asks **Leave and close** *Organization name*? and says **You are
   the last member.** *Organization name* **will close, and nobody will be able
   to open it again.**
3. Click **Leave and close** to confirm, or **Cancel**.

> [!WARNING]
> Closing is permanent from inside the app. Nobody can open the Organization
> again afterwards, and there is no undo button. If you closed one by mistake,
> write to [help@rallywith.ai](mailto:help@rallywith.ai) straight away.

What closing does:

- **It closes the Organization, it does not delete it.** Its content is kept
  under Rally's normal retention rules, but nobody can reach it. If you want the
  data deleted as well, see [What Rally keeps, and deleting your data](../11-privacy-and-security/03-what-rally-keeps.md).
- **Invitations stop working.** Any invitations still waiting are revoked, and
  their download links stop working too.
- **Open windows close.** Any window still showing the Organization, on any
  device, is cut off with the message **This workspace has been closed**. The
  message uses the old word for Organization.

## Removing someone from an Organization

Settings has no button for removing a member today. The buttons on the members
list change roles (see [Roles](01-roles.md)); taking away administrator rights
does not remove anyone.

To remove a person, write to [help@rallywith.ai](mailto:help@rallywith.ai),
naming the Organization and the person. A few rules apply however it is done: an administrator cannot remove
the owner, and nobody removes themselves (they leave instead, as above).

For someone who has not joined yet, revoke their invitation instead, as
described in [Inviting people](02-inviting-people.md).

### What the removed person sees

Removal takes effect without a warning to the person removed.

- Within a few seconds, every Rally window they have open, on every device,
  loses the Organization. Channels, Breakouts, Sidekick conversations and open
  live pages all stop.
- On their Mac, Rally signs that Organization out, deletes its unsent drafts
  and the copies of its conversations kept on the computer, closes any of its
  artifacts popped out into their own windows, and moves to their next
  Organization or the sign-in screen.
- Anything they try to do in it is refused with **You can no longer access this
  organization.** If they pick it in the account menu later, they see **You are
  no longer a member of this organization.**
- Their Rally account itself is untouched. They can still sign in, and use any
  other Organizations they belong to.

The people who remain see the removed person drop out of the room shortly
after.

Rally cannot reach back into someone's computer for things that already left
the app. Text they copied, files they downloaded and screenshots they took stay
with them.

## When access to one Channel ends

Access can also end for a single conversation, for instance when someone is
taken out of a private Channel or a guest's share is revoked (see
[Who can see what](../03-spaces-and-breakouts/04-who-can-see-what.md)).

The open window stops updating and does not try to reconnect. Rally deletes the
copy of that Channel, and every Breakout under it, that it kept on the computer.
The person sees **Channel could not be opened** (or **Sidekick could not be
opened**) with a **Try again** button, which will keep failing, because the
access is gone rather than the connection. The Channel's row leaves their
sidebar shortly afterwards.

## Signing out is different

Signing out, or a sign-in that expires, ends only that device's session. The
windows that used it close and Rally asks you to sign in again with **Your
session is no longer active. Sign in again.** Your membership is untouched, and
your other devices carry on as before. An expired session can take a few
minutes to close its windows. More in
[Signing in, signing out and Lockdown mode](../11-privacy-and-security/01-signing-in-and-out.md).

## Rejoining after removal

If someone who was removed is invited back, they join as a fresh member. They
need a new invitation and must accept it like anyone else. The drafts and
saved copies Rally deleted from their computer when they were removed do not
come back.

Very occasionally, a late notice about the old removal can close a rejoined
person's windows once. Rally reconnects them, and their access is not
affected.
