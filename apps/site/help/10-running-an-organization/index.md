---
title: Running an Organization
description: "For owners and administrators: roles, invitations, Organization settings, several Organizations, and what happens when people leave."
---

Every Organization has an administrator, and very few of them applied for the
job. Usually it goes like this: somebody on the team installs Rally first,
creates the Organization to try it out, and a week later finds that eleven
colleagues are asking them how to get in. Congratulations. If that somebody is
you, this chapter is for you.

If you are an ordinary member, you can read it too. Nothing here is secret, and
knowing who can change what saves a lot of "is it me, or is it broken?"

## What the job involves

Rally gives an Organization a small set of roles. The person who created it is
the **owner**. The owner can make other people **administrators**, and from
then on owners and administrators can do the same administrative things.
Everyone else is a **member**, and people you invited into a single
conversation are **guests**, who hold no role at all and see only what was
shared with them.

What separates an administrator from a member is short enough to fit on a
postcard:

- Inviting people into the Organization, choosing whether they join as a member
  or an administrator, and taking back invitations nobody has used.
- Making members into administrators, and back again, and turning a guest into
  a full member.
- Setting the Organization's default time zone, which Organization Sidekicks use
  when they do not name one of their own.
- Deciding where code that Rally runs in its Terminal may reach on the internet.
- Adding, refreshing and deleting the connections the whole Organization
  shares, and the settings that come with them, such as which GitHub
  repositories Rally may touch.

Everything else, from starting Channels to building Sidekicks, is open to every
member. Rally is light on administration on purpose. There is no approval queue
for new Channels, no form to fill in before someone connects their own Google
account, and nothing to tick before Rally is allowed to use a tool. You set up
the shared parts once and then get on with your actual work.

## What you will not find

It saves time to know what is not there before you go looking for it. Rally's
settings have no section for billing, plans or subscriptions, no single sign-on
(SSO or SAML), and no verified email domains. People join an Organization one
way only: by an invitation sent to their email address. If you need something
from that list, write to [help@rallywith.ai](mailto:help@rallywith.ai) and talk
to a person.

## The two ideas that make the rest click

**An Organization is a separate world.** Channels, Spaces, Sidekicks,
connections and members all belong to exactly one Organization, and nothing
mixes between them. If you belong to two, you switch between them; you never
see both at once.

**Access follows membership, right now.** Rally checks someone's role and
membership every time they ask for something, so a change you make takes
effect straight away, even in windows that were already open. That is good news
when you promote someone and they do not have to restart anything. It matters
more when someone leaves, which the last page of this chapter covers with the
care it deserves.

Most of what follows lives in one place: **Settings → Organization**, which you
met in [The Settings window](../09-settings-and-shortcuts/01-the-settings-window.md).
Open it with <kbd>⌘</kbd> <kbd>,</kbd> and keep it handy.
