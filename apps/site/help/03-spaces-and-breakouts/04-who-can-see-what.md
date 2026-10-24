---
title: Who can see what
description: Understand public and private Threads, private Channels, roles, and what happens when access changes.
---

Before you paste a contract, a salary or a customer's details into a Thread, you
should know who can read it. This page explains how Rally decides, how to check
for any Thread, and what happens the moment you change it.

## Two kinds of Thread

Every Thread is one of two things:

- **Public to organization.** Everyone in your Organization can find it, open it
  and read it.
- **Private.** Only the people listed as its participants can open it.

To check which one a Thread is, click its name in the title pill. The
**People** row says **Public** or **Private**, as you saw in
[People in the room](../02-working-in-a-channel/05-people-in-the-room.md).

A new Thread takes its starting point from the Channel you start it in. Start it
in a Channel open to the whole Organization and it begins public. Start it in a
private Channel and it begins private to you and anyone you mention in your
first message.

## Channels do not open Threads

A Channel decides who can see the Channel: its name, its feed and its message
box. It does not decide who can read the Threads in it. Every Thread has its own
setting, and that setting is the answer. A person can read a Thread if the
Thread is public to the Organization, or if they are one of its participants.

The one exception is for guests. A guest added to a Channel can read the public
Threads in it, as a member of your Organization can. It never opens a private
Thread to them. See
[Add a guest to a Channel](05-sharing-with-guests.md#add-a-guest-to-a-channel).

Two things follow from that:

- A private Thread in an Organization-wide Channel stays private. It is not in
  the Channel's feed for anyone outside the Thread, who sees nothing of it: not
  its name, its summary, who is in it, or that it exists.
- A public Thread in a private Channel is still public. Anyone in the
  Organization can open it from a link or find it in search, even though they
  cannot see the Channel.

Channels and their privacy switch are covered in [Channels](01-spaces.md#private-channels).

## Change who can read a Thread

To open a Thread up to the whole Organization, or close it again:

1. Click the Thread's name in its title pill and choose **More**.
2. Turn **Public to organization** on to make it public, or off to make it
   private to its participants.

The switch is there for people who can change the Thread. It is not offered on
Rally's own built-in Threads, or to guests.

To change who the participants are, use **Add people** and **People** in the same
menu, as described in
[People in the room](../02-working-in-a-channel/05-people-in-the-room.md).

### Breakouts are separate

A Breakout has its own participants and starts private to whoever made it.
Adding someone to a Breakout lets them read that Breakout only, not the rest of
the Thread. See [Breakouts](03-breakouts.md#who-can-see-a-breakout).

### Asking to join from a link

If you open a link to a private Thread or Breakout you are not in, Rally shows
its name, color and icon and a **Request access** button. Pressing it sends the
request to whoever created it. Once they approve, you are added, the Thread
opens on its own within about half a minute, and you get an email. You get an
email if they decline, too. Guests do not see this; they are shared in by email
instead.

If you created it, the request reaches you in four places:

- **By email**, with an **Approve access** button that works in one click.
- **In Activity.** Click **Activity** at the left edge of the window. The
  request sits at the top, under **Requests**, with a check to approve and a
  cancel sign to decline. Click the request itself to see it in a dialog with
  **Approve** and **Decline**. It also counts towards the number on the
  **Threads** button until you decide.
- **In the Mac menu bar**, under **Needs attention**. Choosing it opens Rally
  on the same dialog.
- **Among the conversation's people.** Open the Thread's or Breakout's menu
  and choose **Add people**: requests are listed under **Asked to join**,
  above **Suggested**, with the same check and cancel buttons.

## Roles

Who may change things depends on each person's role in the Organization.

| Role | In short |
| --- | --- |
| **Owner** | The person who created the Organization. Can do everything an administrator can. |
| **Administrator** | Runs the Organization. Can change roles. |
| **Member** | Can create Channels, start Threads, and add people to Channels and Threads. |
| **Guest** | Someone from outside the Organization who was shared into particular conversations by email, or added to a Channel. Sees only those conversations, the Channels they are in with their public Threads, and who is in the Organization. Cannot create Channels or start Threads, and cannot change who can read a Thread. |

Rally shows buttons according to your role and checks every change again when
you make it, so a button that has stopped applying to you will refuse. Roles, and how to change them, are covered in
[Roles: owners, administrators, members and guests](../10-running-an-organization/01-roles.md).

## When access narrows

Rally applies a narrowing within moments, including to people who have the
Thread open at that moment. Nobody keeps reading a conversation because they
happened to have it on screen.

**Someone is removed from a Thread or Breakout.** As described in
[People in the room](../02-working-in-a-channel/05-people-in-the-room.md), you
remove a participant from the participants window with **Remove from main
conversation** or **Remove from breakout**.

- If the Thread is private, it disappears from their Threads list, and if they
  had it open, it closes.
- If they are removed from a Breakout, the Breakout closes and they land back in
  the Thread.
- Removing someone from a Thread's main conversation also means they can no longer
  open or manage Sidekicks that belong to that Thread, unless they created them.
- You cannot remove the last participant.

**A Thread becomes private.** People who could read it only because it was
public, and who are not participants, are cut off. If they had it open, it
closes.

**Someone loses a Channel.** When a person is taken out of a private Channel, or
an open Channel is made private without them, the Channel leaves their Channels
list. If they open it, they see **Channel not found** and **It may have been
archived, made private, or you may no longer have access.** Rally shows the same
words whichever it is, on purpose, so the message gives nothing away. Losing a
Channel does not take away any Thread from a member: they keep every Thread they
are a participant in, and every public one. A guest loses the public Threads
they could read only through that Channel, and any they had open close.

> [!IMPORTANT]
> Taking away one route to a Thread does not take away the other. Removing
> someone from a Thread's participants does nothing if the Thread is public to
> the Organization: they can still read it. To shut someone out of a Thread,
> make it private and make sure they are not one of its participants.

> [!WARNING]
> Narrowing access stops people reading from now on. It cannot take back what
> they have already read, copied or downloaded.

Next: [Sharing with people outside your Organization](05-sharing-with-guests.md).
