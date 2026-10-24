---
title: "Roles: owners, administrators, members and guests"
description: What each role can do, and how to change someone's role.
nav_title: Roles
---

Everyone in an Organization has one role, and it decides what they can change.
There are four kinds of person on the members list, and owners and
administrators can move people between some of them.

## The four kinds of person

**Owner.** The person who created the Organization. The owner can do every
administrative thing, and their role is fixed: nobody can demote them, and
there is no way in the app to hand ownership to someone else. An owner who
wants to step away while other people remain needs another owner to exist
first (see [Leaving, removing and closing](05-leaving-and-removing.md)).

**Administrator.** Someone the owner, or another administrator, has trusted
with the same powers. Inside Rally, "administrator" means "owner or
administrator" for every administrative action. The only things an
administrator cannot do that the owner can are change the owner's role and
remove the owner.

**Member.** An ordinary member of the team. Members can do everything the
earlier chapters describe: start Threads and Channels, work with Rally, build
Sidekicks, connect their own tools, and use the connections the Organization
shares. They cannot invite people or change Organization-wide settings.

**Guest.** Someone from outside who was invited into one conversation, as
described in [Sharing with people outside your Organization](../03-spaces-and-breakouts/05-sharing-with-guests.md).
A guest holds no role at all. They see only the conversations shared with them,
and nothing else in the Organization.

## Who can do what

| What | Owner | Administrator | Member | Guest |
| --- | --- | --- | --- | --- |
| See the members list | Yes | Yes | Yes | No |
| Invite people and revoke invitations | Yes | Yes | No | No |
| Make someone an administrator, or remove that | Yes | Yes | No | No |
| Turn a guest into a member | Yes | Yes | No | No |
| Change the Organization's default time zone | Yes | Yes | No | No |
| Change the Terminal's internet access | Yes | Yes | No | No |
| Add, refresh and delete Organization connections | Yes | Yes | No | No |
| Set GitHub repository access and MCP tool rules for shared connections | Yes | Yes | No | No |
| Connect, refresh and delete your own personal connections | Yes | Yes | Yes | No |
| Use the Organization's shared connections in Threads | Yes | Yes | Yes | Only in conversations shared with them |
| Leave the Organization | Yes, with one exception | Yes | Yes | No |

The exception: an owner who is the only owner cannot leave while other people
are still in the Organization.

Members find most administrative controls missing or greyed out. The
**Invitations** section and the **Connect for organization** buttons do not
appear for them at all, and the time zone and internet access settings are
shown read-only. If a teammate asks why they cannot find something, this is
usually why.

Guests see even less. Their Settings has only **Account** and **Application**,
so they never see the members list or any Organization setting. When Rally
works in a conversation shared with a guest, it can still use the
Organization's shared connections there, including when the guest asks.
A guest cannot leave the Organization themselves; to end their access, see
[Taking access back](../03-spaces-and-breakouts/05-sharing-with-guests.md#taking-access-back).

> [!NOTE]
> Each connected tool keeps its own rules too. Being a Rally administrator does
> not make you an administrator in Slack, Granola or GitHub, and some
> connections need one. The pages in [Connecting your other tools](../05-connecting-your-tools/index.md)
> say when.

## The members list

Open **Settings → Organization** and scroll to **Members**. Under the heading
it says **People with access to** and your Organization's name, with a count of
everyone on the list beside it.

Each row shows:

- the person's picture or initials,
- their name, with their email address underneath,
- a badge with their role: **owner**, **admin** or **member**, or **Guest** for
  a guest.

Everyone can see this list. Only owners and administrators see buttons on the
rows.

## Make someone an administrator

1. Open **Settings → Organization** and find the person under **Members**.
2. Click **Make administrator** on their row.

Their badge changes to **admin**, and the change takes effect at once. Rally
checks roles on every request, so they do not need to restart or sign in again.

To take the role away, click **Remove administrator** on the same row. Their
badge goes back to **member**.

A few rows never show these buttons:

- **The owner.** Their role cannot be changed, so Rally shows no button rather
  than one that could only fail.
- **People whose invitation is still pending.** They are not members yet. Set
  the role on the invitation instead (see [Inviting people](02-inviting-people.md)).
- **Guests.** They get a different button, described next.

Rally also refuses to remove the last administrator. In practice the owner
always counts, so you will rarely meet this.

> [!TIP]
> Make at least one other person an administrator. If the owner is on holiday,
> somebody else can still invite the new starter.

## Turn a guest into a member

When a client or contractor becomes part of the team, you do not need to
re-invite them. Their row in **Members** shows a **Guest** badge and a **Make
member** button.

1. Click **Make member** on the guest's row.
2. A dialog titled **Make guest a member** explains that they will gain normal
   organization membership, and that their existing conversations and
   contributions stay with their account.
3. Click **Make member** to confirm, or **Cancel**.

They become an ordinary member, with the same history they had as a guest.
Nothing they wrote is lost and none of their windows are closed. You can make them an
administrator from there if you want to.

There is no button to turn a member back into a guest.
