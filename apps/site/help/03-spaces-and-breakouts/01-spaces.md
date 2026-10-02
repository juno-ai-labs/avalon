---
title: Spaces
description: Create Spaces to group related Channels, and decide who belongs in each.
---

A Space holds a set of related Channels and decides who can see them. You met
the Space pills in [A tour of the window](../01-getting-started/04-a-tour-of-the-window.md#the-space-pills).
This page is about making Spaces, looking after them, and putting them away when
the work is done.

## The General Space

Every Organization starts with one Space, **General**. Everyone in the
Organization can see it, and it is where Channels land when they have nowhere
more specific to go. General has no pill in the sidebar, since **All** already
shows its Channels, and a Channel's row never names it.

General is a little different from the Spaces you make yourself:

- You can rename it and change its icon and colour.
- You cannot change who sees it. It is always open to the whole Organization,
  and its page has no audience or participants controls.
- You cannot archive it. It is the Organization's home address, and it stays.

## Create a Space

1. Click **New space**, the round button with a folder and a plus at the start
   of the Space pills.
2. In **Create a new space**, type a **Name of space** and click **Create**.

Rally opens the new Space's page straight away. A new Space starts private to
its participants, which at that moment means you, with a blue briefcase for an
icon. Give it a better icon and decide who else belongs from its page, as
described below.

Any active member of the Organization can create a Space. Guests (people shared
into a single conversation, see
[Sharing with people outside your Organization](05-sharing-with-guests.md))
cannot.

## The Space page

Clicking a Space's pill only narrows the Channel list. To open the Space's own
page, right-click its pill and choose **Open space**, or open any of its
Channels, click the Channel's name in its title pill and click **Open space**
beside the Space's name. The Space's page fills the window. A Space
has no conversation of its own. Its page is the answer to one question: what in
here needs me?

Across the top sit the Space's controls:

- **The icon.** Click it to open **Space icon and color**, and pick an icon and a
  colour. They show wherever the Space is named, so pick something you can spot at a glance.
- **The name.** Double-click it to rename the Space. From the keyboard, focus
  the name and press <kbd>F2</kbd> or <kbd>Return</kbd>. Press <kbd>Return</kbd>
  to save or <kbd>Esc</kbd> to cancel; clicking away also saves. Names can be up
  to 180 characters, which is plenty, even for a committee.
- **The audience menu** (**Space participants** or **Everyone in the
  organization**). See [Who belongs in a Space](#who-belongs-in-a-space).
- **The avatar stack** shows the Space's participants. Click it to change them.
- **Copy space link** puts a link to this Space on your clipboard. Links are
  covered in [Search and links](06-search-and-links.md).
- **Archive space** puts the Space away. See
  [Archive and restore a Space](#archive-and-restore-a-space).

If Rally is still connecting, or you are offline, the page shows what it last
knew with a card saying **Editing is available once Rally connects**. The
controls wake up once the connection is back.

### Needs attention

Below the header is a list headed **Needs attention**. It shows the Channels and
Breakouts in this Space that want something from you right now:

- Rally is running, or waiting to run, in it.
- It needs your input, such as a question from Rally.
- It has messages you have not read, or someone mentioned you.
- It is new to you.

Each row has a status dot, the Channel's name (a Breakout shows which Channel it
is in), a preview of the latest activity and a time. Click a row to open it. The
list keeps itself up to date as messages arrive and runs finish, and a **Load
more** button appears at the bottom when there are a lot. The dots are explained
in [Status dots](../02-working-in-a-channel/06-status-dots-and-badges.md).

Once you have read something and Rally has finished, it drops off the list. The
list is for things waiting on you. Every Channel is still in the sidebar
and in search. When nothing is waiting, the page
says **Nothing here needs you right now**, which is the nicest thing a piece of
software can say to you. A Space with no Channels at all says **No channels
yet**.

## Who belongs in a Space

Every Space has an **audience**, chosen from the menu under its name:

| Audience | Who can see the Space and its Channels |
| --- | --- |
| **Space participants** | Only the people listed as the Space's participants. |
| **Everyone in the organization** | Everyone in the Organization. |

The audience covers every Channel in the Space as well as the Space's page. A
Channel in an Organization-wide Space can be seen and found by
everyone in the Organization. The full rules, including what happens when a
Channel sits in more than one Space, are in
[Who can see what](04-who-can-see-what.md).

### Change the audience

1. Open the Space's page and choose a new audience from the menu under its name.
2. Rally asks **Change who can see this space?** and explains what will happen.
3. Click **Continue**, or **Cancel** to leave things as they were.

> [!WARNING]
> Choosing **Everyone in the organization** makes the Space and every Channel in
> it visible to everyone in the Organization, straight away. Check what the
> Channels hold before you widen a Space. Narrowing it again later stops new
> reading, but it cannot take back what people have already read.

Narrowing a Space back to **Space participants** does not automatically make
every Channel in it private. A Channel that is open to the Organization in its
own right, or through another Space, stays open. The dialog says so: **Channels
stay public if another source still says so.**

Rally may refuse to widen a Space if one of its Channels holds something the
wider audience is not allowed to read. The message names the problem. Move that
Channel out of the Space first.

### Add and remove participants

1. Click the avatar stack on the Space's page. The **Space participants** window
   lists the members of your Organization.
2. Tick the people who should be in the Space and untick those who should not.
3. Click **Save**.

The rules:

- Any member can add people. Taking someone else out needs an Organization
  owner or administrator. For everyone else, a ticked box beside another person
  cannot be unticked.
- You cannot take yourself out of a private Space. Rally refuses with **You
  can’t make a space private without yourself in it.**
- A Space must keep at least one participant.

In an Organization-wide Space, the participant list is mostly a record of who
belongs to it, since everyone can see it anyway. Current participants stay
participants if you narrow it later.

### Spaces you can see but not change

Sometimes a Space appears in your sidebar even though you are not one of its
participants. That happens when someone added you to a Channel that lives in a
private Space. Rally shows you the Space's name, icon and colour so the Channel
has somewhere to sit, but nothing else: no audience, no participants and no
other Channels. You cannot edit or archive it.

## Archive and restore a Space

When a project is finished, archive its Space to take its pill out of the
sidebar.

1. Right-click the Space's pill and choose **Archive space**, or click
   **Archive space** on its page.
2. Rally asks **Archive space?** Click **Archive space** to confirm.

What archiving does and does not do:

- The Space's pill leaves the sidebar. Its Channels are not archived. They keep their
  artifacts, resources and Sidekicks, and they stay in every other Space they
  belong to.
- Every Channel must live in at least one Space, so a Channel whose only home is
  this Space blocks the archive. The dialog lists them under **Channels to move
  first**. Add each one to another Space (see
  [Arranging your Channels](02-arranging-channels.md)), then try again.
- General cannot be archived, and neither can a Space you only see through one
  of its Channels. The menu item does not appear for them.

To bring a Space back, right-click **New space** at the start of the Space
pills and choose **Restore archived space**. It only works while at least one
archived Space exists. Pick the Space from the list. If you have an archived Space's page open, its
**Restore space** button does the same.

> [!NOTE]
> There is no way to delete a Space in Rally. Archiving is as far as it goes,
> and an archived Space can always be restored.

If you open a link to a Space that has been archived, or one you no longer have
access to, Rally shows **Space not found** and **It may have been archived or
you may no longer have access.** Rally deliberately does not say which.

Next: [Arranging your Channels](02-arranging-channels.md), to put the right
Channels on the right shelves.
