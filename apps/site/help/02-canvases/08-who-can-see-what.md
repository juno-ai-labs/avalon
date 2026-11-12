---
title: Who can see what
description: Understand who can open a Canvas, how to share it with people or the whole Organization, and what happens when access changes.
---

Before you paste a contract, a salary or a customer's details into a Canvas,
you should know who can read the conversation and who can use its artifacts. This page explains how Rally decides, how to
check for any Canvas, and what happens the moment you change it.

## Each Canvas decides for itself

There are no folders or teams in Rally that hand out access to a group of
Canvases. Every Canvas has its own list of who can open it, and that list is
the whole answer. Sidekicks work the same way, with their own sharing, covered
in [What a Sidekick is](../03-sidekicks/01-what-a-sidekick-is.md#who-a-sidekick-is-shared-with).

**Who can edit** chooses who can read the conversation, send messages to Rally and change its artifacts:

| Setting | Who can open it |
| --- | --- |
| **Only you** (**Only the creator**, to anyone else) | The person who created it. This is where every new Canvas starts. |
| **Specific people** | The creator and the people chosen, guests among them. |
| **Everyone in the Organization** | Every member of the Organization, and any guests you add. |

To check, click **Share** at the top right of the Canvas. The **Share Canvas**
window shows the editor audience and a separate artifact audience.

Whoever can open a Canvas can read all of it: the conversation, every version
of what Rally made, and every comment. There is no way to show someone the
latest version but not the conversation behind it.

## Share a Canvas

1. Click **Share** at the top right.
2. Under **Who can edit**, choose **Only you**, **Specific people** or
   **Everyone in the Organization**. **Add people** opens a searchable list;
   tick the editors you want.
3. Under **Who can interact with artifacts**, choose **Editors only**,
   **Specific people**, **Everyone in the Organization** or **Anyone with the
   link**. Use its own **Add people** picker for artifact users. When
   **Everyone in the Organization** can edit, **Editors only** and **Specific
   people** are turned off here, since the whole Organization can already use
   the artifacts: the choice is **Everyone in the Organization** or **Anyone
   with the link**.
4. Click **Save**. **Cancel** discards the changes.

Editors can always use the artifacts. Artifact users can open and use published
outputs without seeing the conversation or asking Rally to change them. For
example, two people can edit a planner while anyone with its link uses it.
These settings apply to every published artifact in the Canvas.

New Canvases start with artifact access set to **Editors only**. Choose public
access explicitly. Changing access takes a short time to reach the published
artifacts. Previously downloaded content cannot be taken back.

Organization-wide audiences include active members, plus the guests you select.
Guests do not gain access just by belonging to the Organization. Inviting a guest
by email from this window grants editor access, including the conversation;
[Sharing with guests](09-sharing-with-guests.md) explains that invitation.

### Who can change the sharing

The creator of a Canvas, and the Organization's owners and administrators,
decide who can open it: they choose people, invite guests, open it to the
Organization or close it again, and answer requests to open it. Everyone else
in the Canvas, members and guests alike, reads it and takes part, and sees the
**Share** window read-only, with a note saying who can change it. If you want
someone added, ask the creator. For a Canvas a Sidekick made, the Sidekick's
managers decide too.

## Requests to open a Canvas

A member who opens a link to a Canvas they cannot see is told **You don't have
access to this Canvas**, without its name, and can click **Request access**,
with an optional message. The people who decide on the Canvas each get an
Activity row, such as **Theo asked to open Launch plan**, with **Approve** and
**Deny** beside it, and a notification if they chose one for **Access
requests** (see [Activity and notifications](../08-rally-everywhere/03-notifications.md)).
The same request is listed under **Requests** at the top of the Canvas's
**Share** window.

- **Approve** adds the person to the Canvas. They get an Activity row saying
  you let them in, and the Canvas opens for them, even if they are still
  looking at the request page.
- **Deny** turns it down. Nobody tells them, and they may ask again later.
- Once someone has answered, every decider's row says who approved or denied
  it.

Guests cannot ask. A guest who opens a link to a Canvas not shared with them
sees **This Canvas could not be opened.** with **Only a member of the
Organization can ask to open a Canvas**, whether or not the Canvas exists.

## Canvases from a Sidekick

A Canvas a Sidekick makes starts out open to the people the Sidekick is shared
with, so everyone who can talk to the Sidekick can read what it made. From then
on, the Sidekick's managers, and the Organization's owners and administrators,
decide who else can open it. Changing who the Sidekick is shared with later
does not change the Canvases it already made.

## Artifact links

**Copy link** copies an artifact's address. Its Canvas's artifact audience
decides who can open it. **Anyone with the link** allows unsigned visitors;
other audiences require the right account. Making artifacts public never makes
the conversation public. [Live sites](../06-things-rally-makes/03-live-sites.md)
explains how this works for websites.

## Roles

Who may change things depends on each person's role in the Organization.

| Role | In short |
| --- | --- |
| **Owner** | The person who created the Organization. Can do everything an administrator can. |
| **Administrator** | Runs the Organization. Can change roles and change the sharing of any Canvas. |
| **Member** | Can create Canvases and Sidekicks, and decides who can open the Canvases they created. |
| **Guest** | Someone from outside the Organization who was added to particular Canvases. Sees only those Canvases, and who is in the Organization. Can write in those Canvases. Cannot create Canvases or Sidekicks, and cannot change who can open anything. |

Rally shows buttons according to your role and checks every change again when
you make it, so a button that has stopped applying to you will refuse. Roles,
and how to change them, are covered in
[Roles: owners, administrators, members and guests](../10-running-an-organization/01-roles.md).

## When access narrows

Rally applies conversation changes within moments; published artifacts follow as the sharing update reaches them, including to people who have the
Canvas open at that moment. Nobody keeps reading a Canvas because they happened
to have it on screen.

- **Someone is removed from a Canvas.** It leaves their Canvases list, and if
  they had it open, it closes.
- **A Canvas stops being open to the whole Organization.** Members who are not
  participants are cut off, and if they had it open, it closes.
- **Someone opens a Canvas they have lost.** A member sees **You don't have
  access to this Canvas**, without its name, and can ask to be let back in. A
  guest sees **This Canvas could not be opened.**

> [!IMPORTANT]
> Taking away one route to a Canvas does not take away the other. Removing
> someone does nothing while the Canvas is open to everyone in the
> Organization: they can still read it. To shut someone out, choose **Specific
> people** and leave them unticked.

> [!WARNING]
> Narrowing access stops people reading from now on. It cannot take back what
> they have already read, copied or downloaded.

Next: [Sharing with people outside your Organization](09-sharing-with-guests.md).
