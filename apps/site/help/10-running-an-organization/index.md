---
title: Running an Organization
description: "For owners and administrators: roles, invitations, Organization settings, several Organizations, and what happens when people leave."
---

Every Organization has an administrator, and few of them applied for the job.
It usually goes like this: somebody installs Rally first, creates the
Organization to try it out, and a week later eleven colleagues are asking them
how to get in. Congratulations. If that somebody is you, this chapter is yours.

Members can read it too. Nothing here is secret, and knowing who can change
what saves a lot of "is it me, or is it broken?"

## What the job involves

Rally gives an Organization a small set of roles. The person who created it is
the **owner**. The owner can make other people **administrators**, and from
then on owners and administrators can do the same administrative things.
Everyone else is a **member**, and people you invited into a single
conversation are **guests**, who hold no role at all and see only what was
shared with them.

The difference between an administrator and a member fits on a postcard:

- Inviting people into the Organization, choosing whether they join as a member
  or an administrator, and taking back invitations nobody has used.
- Making members into administrators, and back again, turning a guest into
  a full member, and suspending someone.
- Setting the Organization's default time zone, which Organization Sidekicks use
  when they do not name one of their own.
- Deciding where code that Rally runs in its Terminal may reach on the internet.
- Adding, refreshing and deleting the connections the whole Organization
  shares, and the settings that come with them, such as which GitHub
  repositories Rally may touch.

Everything else, from starting Canvases to building Sidekicks, is open to every
member. That is deliberate. Rally has no approval queue for new Canvases, no
form to fill in before someone connects their own Google account, and nothing
to tick before Rally may use a tool. Every gate an administrator has to mind is
a gate somebody is waiting at, so Rally keeps them few. You set
up the shared parts once and go back to your own work.

## What you will not find

Better to know what is missing before you go looking for it. Rally's
settings show the Organization's plan and weekly quota, but have no invoices
or payment details, no single sign-on (SSO or SAML), and no verified email
domains. People join an Organization one
way only: by an invitation sent to their email address. If you need something
from that list, write to [help@rallywith.ai](mailto:help@rallywith.ai) and talk
to a person.

## Separate worlds, checked every time

First, an Organization is a separate world. Canvases, Sidekicks,
connections and members each belong to exactly one Organization, and nothing
crosses between them. If you belong to two, you switch from one to the other.
You never see both at once.

Second, access follows membership, right now. Rally checks someone's role and
membership every time they ask for something, so a change you make takes
effect straight away, even in windows that were already open. When you promote
someone, that means they do not have to restart anything. When someone leaves,
it means their access ends while you are still closing the dialog. The last
page of this chapter goes through that slowly.

Most of what follows lives in one place: **Settings → Organization**, which you
met in [The Settings window](../09-settings-and-shortcuts/01-the-settings-window.md).
Open it with <kbd>⌘</kbd> <kbd>,</kbd> and keep it handy.
