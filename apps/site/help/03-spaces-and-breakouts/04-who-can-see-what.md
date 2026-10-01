---
title: Who can see what
description: Understand public and private Channels, Space audiences, roles, and what happens when access changes.
---

Before you paste a contract, a salary or a customer's details into a Channel, you
should know who can read it. This page explains how Rally decides, how to check
for any Channel, and what happens the moment you change it.

## Two kinds of Channel

Every Channel is one of two things:

- **Public to organization.** Everyone in your Organization can find it, open it
  and read it. It wears a small globe in the Channels rail. Hover over the globe
  and Rally explains that everyone in the Organization can see the Channel.
- **Private.** Only the people listed as its participants can open it. The
  Channel's header shows a padlock **Private** badge, as you saw in
  [People in the room](../02-working-in-a-channel/05-people-in-the-room.md).

A new Channel takes its starting point from the Space you create it in. Start it
in a Space open to the whole Organization and it begins public. Start it in a
Space limited to its participants and it begins private.

## Where access comes from

Here is the idea that makes the rest of this page make sense. **A person can read
a Channel if any one of these lets them in:**

- **The Channel itself.** Either the Channel is public to the Organization, or
  the person is one of its participants.
- **Each Space that holds the Channel.** A Space open to the whole Organization
  lets everyone read every Channel in it. A Space limited to its participants
  lets those participants read every Channel in it.

It takes only one open door. That has two consequences worth remembering:

- A Channel that is "private" in its own setting is still readable by everyone if
  it sits in an Organization-wide Space.
- Making a Space private does not make a Channel private if the Channel is also
  public in its own right or through another Space.

Spaces and their audiences are set up as described in [Spaces](01-spaces.md).

## Manage access

To see exactly who can read a Channel, and why, right-click it in the Channels
rail and choose **Manage access**. The window opens with **Everyone listed here
can read** followed by the Channel's name, and lists every source of access:

- **This channel.** The Channel's own setting, with a sentence such as **Only the
  3 people in the channel.** or **Everyone in the organization, from the channel
  itself.** Next to it is a **Make private** or **Make public to organization**
  button.
- **One row for each Space that holds the Channel.** Each says who that Space
  lets in, such as **Everyone in the organization, through this space.** or **The
  5 people in this space.**, with a **Remove from space** button.

Click **Done** when you have finished.

Rally will not call a Channel private while an Organization-wide Space still
makes it readable by everyone. In that case the **This channel** row says the
Channel is **public through** that Space, and the **Make private** button does
not appear. To make the Channel private, first remove it from that Space (or
narrow the Space), then come back and click **Make private**.

A few rows you may meet:

- **A space you can't see.** The Channel is also in a Space you are not part of.
  You can see that it exists, but you cannot change it.
- A Space you only reach through this very Channel has no **Remove from space**
  button.
- **Access from this space is still being applied.** or **This channel has left
  this space; its access is still being withdrawn.** A change is still taking
  effect. Give it a moment.

If the list cannot be loaded, Rally says **Who can see this channel couldn't be
loaded.** Click **Try again**.

**Manage access** is not offered on Rally's own built-in Channels, or to guests.

### Making a Channel public from the Channel itself

You can also open a Channel up from inside it: right-click the main conversation
row in the Channel sidebar and choose **Make public to organization**. That menu
has no way back. To make the Channel private again, use **Manage access** in the
Channels rail.

### Breakouts are separate

A Breakout has its own participants and starts private to whoever made it.
Adding someone to a Breakout lets them read that Breakout only, not the rest of
the Channel. See [Breakouts](03-breakouts.md#who-can-see-a-breakout).

## Roles

Who may change things depends on each person's role in the Organization.

| Role | In short |
| --- | --- |
| **Owner** | The person who created the Organization. Can do everything an administrator can. |
| **Administrator** | Runs the Organization. Can change roles, and is the only kind of member who can take someone else out of a Space. |
| **Member** | Can create Spaces and Channels, and add people to Spaces. |
| **Guest** | Someone from outside the Organization who was shared into particular conversations by email. Sees only those, cannot create Spaces, and has no **Manage access**. |

Rally draws its buttons according to your role, and checks every change again
when you make it, so a button that has stopped applying to you will
refuse. Roles, and how to change them, are covered in
[Roles: owners, administrators, members and guests](../10-running-an-organization/01-roles.md).

## When access narrows

Rally applies a narrowing straight away, including to people who have the
Channel open at that moment. Nobody keeps reading a conversation because they
happened to have it on screen.

**Someone is removed from a Channel or Breakout.** As described in
[People in the room](../02-working-in-a-channel/05-people-in-the-room.md), you
remove a participant from the participants window with **Remove from main
conversation** or **Remove from breakout**.

- If the Channel is private, it disappears from their sidebar, and if they had it
  open Rally moves them to the next Channel in their list.
- If they are removed from a Breakout, the Breakout closes and they land back in
  the Channel.
- Removing someone from a Channel's main conversation also ends their access to
  Sidekicks that belong to that Channel.
- You cannot remove the last participant.

**A Channel becomes private.** People who could read it only because it was
public, and who are not participants, are cut off. If they had it open, it
closes.

**Someone loses a Space.** When a person is taken out of a Space, or the Space is
narrowed so they are no longer in its audience, the Channels they could reach
only through that Space close for them. If they open the Space, they see **Space
not found** and **It may have been archived or you may no longer have access.**
Rally shows the same words for an archived Space and for one you cannot reach,
on purpose, so the message gives nothing away.

> [!IMPORTANT]
> Taking away one source of access does not take away the others. Removing
> someone from a Channel's participants does nothing if the Channel is public to
> the Organization or sits in a Space they belong to: they can still read it
> through that route. Likewise, someone who is a direct participant of a Channel
> keeps it after losing a Space that also held it. Open **Manage access** to see
> every route, and close each one that should be closed.

> [!WARNING]
> Narrowing access stops people reading from now on. It cannot take back what
> they have already read, copied or downloaded.

Next: [Sharing with people outside your Organization](05-sharing-with-guests.md).
