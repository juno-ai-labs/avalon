---
title: Organization settings
description: Set the Organization's name and time zone, decide where Rally's code may reach on the internet, and control shared connections.
---

A handful of settings apply to everyone in the Organization at once. They live
in three places in the Settings window: **Organization**, **Security**, and
**Connections**. Everyone can look at them. Only
owners and administrators can change them.

## Organization preferences

Open **Settings → Organization**. The first block, **Organization
preferences**, holds the Organization's details and the defaults its
Sidekicks share. It has three rows.

- **Organization** shows the Organization's name. An owner or administrator
  can double-click it to rename it; a name needs 2 to 120 characters.
- **Default timezone** is the time zone an Organization Sidekick uses when it
  does not name one of its own. Pick one from the list and it saves straight
  away.
- **Allow Rally access** lets the Rally team help you set up and fix your
  Organization by signing in as people in it. See
  [Letting the Rally team in](#letting-the-rally-team-in) below.

The default time zone matters for anything scheduled. A Sidekick set to run "at
9 every weekday" needs to know whose 9 o'clock. If most of your team is in one
place, set it to theirs, and nobody gets their morning report at 2 in the
afternoon. Schedules are covered in [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md).

Your own time zone is a different setting, under **Settings → Account**,
described in
[The Settings window](../09-settings-and-shortcuts/01-the-settings-window.md).

Below the preferences, **What Rally remembers about the Organization** lists
what Rally has saved to the Organization's shared memory (see
[Memory and coming back later](../04-working-with-rally/05-memory-and-coming-back-later.md)).

## Plan and usage

The **Usage** block shows the Organization's plan and its shared weekly quota.

- **Plan** is **Starter plan** ($100 a month) or **Growth plan** ($250 a
  month). It sets the weekly quota everyone in the Organization shares. Only
  owners and administrators can change it.
- **Weekly quota** shows how much of this week's quota is left, with a meter,
  and when it resets.
- If the Organization has used more than its quota this month, a **Usage
  beyond quota this month** row says so, marked **Not billed**: Rally is not
  charging for it yet.

The same meter sits in the account menu, under your avatar, for everyone.

## Letting the Rally team in

Sometimes the quickest way for us to help is to see Rally the way one of your
people sees it: set up a Sidekick for them, check why a connection fails, or
look at a Canvas that will not behave. **Allow Rally access** lets the Rally team do that for seven
calendar days.

Press **Grant access**. The row then counts down how long is left (**6 days
left**, then hours, then minutes) and shows **Revoke access**. Press **Revoke
access** at any time and it ends at once, including for anyone on the Rally
team who is signed in as one of your people at that moment. When the seven
days run out, the row goes back to **Grant access** by itself.

While access is on, someone on the Rally team can sign in as any member or
guest of your Organization and act as them, with exactly what that person can
see and do. What they do shows up as that person. Rally keeps a separate record
of who on the Rally team started each session.

Only owners and administrators can grant or revoke access. Someone on the Rally
team signed in as one of your administrators can revoke it, but cannot grant it
or extend it.

## Internet access for the Terminal

Rally has its own private computer for running code, the Terminal, which you
met in [Code, data and the Terminal](../04-working-with-rally/03-code-files-and-the-terminal.md).
This setting decides where code running on that computer may connect on the
internet. It is the one setting in this chapter that is mainly about security,
so read this section slowly.

Open **Settings → Security** and find **Terminal network access**. The
Terminal runs on cloud computers, so wherever the page says "cloud computers",
it means Rally's Terminal.

### The two choices

Under **Outbound access**, choose one:

| Choice | What code in the Terminal can reach | Pick it when |
| --- | --- | --- |
| **Trusted only** | What Rally itself needs, which covers GitHub, the usual places software packages are downloaded from, and sites published with Rally, plus any domains your Organization approves. | You want to limit where your data could go. Code Rally runs cannot reach a site that is not on that list. |
| **Full internet** | Any public website or service. Private networks stay blocked either way. | Rally's code keeps needing to fetch from sites you have not listed, and you would rather allow them all than keep adding domains. |

**Trusted only** is the careful choice. If Rally writes code that tries to
reach a site not on the list, the connection fails. That protects you from
code that would otherwise send your files somewhere unexpected, at the cost of
the occasional "I could not download that" from Rally. **Full internet**
removes that limit for public sites.

The list includes every site published with Rally, not only your own, so
Rally can check a site it built at its published address. A site published by
someone outside your Organization can keep what is sent to it, so Trusted
only narrows where data can go but does not rule out every place outside your
Organization.

Rally's built-in list of trusted places is managed by Rally and is not shown on
the page. You only see, and edit, the domains your Organization adds.

### Approve extra domains

With **Trusted only** selected, a box labelled **Organization-approved domains**
appears. Type one domain per line, for example:

```text
packages.example.com
*.downloads.example.com
```

A `*.` at the start covers every address under that domain. Type domains only:
no `https://`, no port numbers, no paths after a slash, no IP addresses and no
address ranges. Rally rejects anything else.

There is room for only a limited number of domains, shared with Rally's own
built-in list. Under the box, Rally shows how many slots remain, for example
**3 organization domain slots remain.** Spend them on domains you need.

These domains apply only under **Trusted only**. Switching to **Full internet**
makes them irrelevant, though Rally remembers them.

### Save the change

1. Make your change, then click **Save network change**.
2. Rally asks **Change network access?** and warns that cloud computers running
   now may be interrupted.
3. Click **Continue** to apply it, or **Cancel** to back out.

> [!WARNING]
> Continuing stops every Terminal that is running in the Organization. Rally
> cancels the work those Terminals are doing, keeps a record of the unsaved
> changes in each, and does not restart them on its own. Terminals that are
> not running are left as they are, files included. Pick a quiet moment.

Sidekick runs are not stopped. Each run uses the rules that were in place when
it started.

Next to the **Save network change** button, Rally shows a status badge and a
**Revision** number, which goes up by one with each change you save.

### When the Terminal is unavailable

The page may show **Terminal unavailable** with one of two explanations:

- **Temporarily disabled by the regional safety switch.** Rally has switched
  the Terminal off for now, usually while fixing a problem. Try again later.
- **Cloud computer not enabled.** The Terminal is
  not available for your Organization's region.

Either way the controls are greyed out until it comes back.

## Shared connections

Chapter 5 covers connections, starting with
[Settings → Connections](../05-connecting-your-tools/01-connections.md). This
section is the administrator's share of it.

Every member can connect their own accounts as **Personal connections** and
manage them. Connections the whole Organization shares are different, and only
owners and administrators can:

- Add Organization connections, with the **Connect for organization**
  button next to a connector. Members do not see that button.
- Refresh, reconnect and delete Organization connections. Deleting one
  removes it and its tools from everyone in the Organization, and Rally says so
  before you confirm.
- Issue and replace API keys for connectors that use one for the whole
  Organization, such as [Ashby](../05-connecting-your-tools/10-ashby.md) and
  [Granola](../05-connecting-your-tools/08-granola.md).
- Create and refresh Organization webhooks, as described in
  [Inbound webhook](../05-connecting-your-tools/13-inbound-webhook.md).
  Refreshing replaces the signing secret, and the old one stops working at
  once.
- Choose which GitHub repositories Rally may use, and whether it may change
  them, under the GitHub settings described in [GitHub](../05-connecting-your-tools/04-github.md).
- Choose which tools of a shared [custom MCP server](../05-connecting-your-tools/14-custom-mcp-server.md)
  Rally may use: **All tools** or **Read-only tools**.
- Use **Manage events** for Ashby, which decides what Ashby activity reaches Rally.

> [!IMPORTANT]
> An Organization connection is shared in full. Every member can use every tool
> it grants, in any Canvas or Sidekick, and Rally acts with the account you connected it
> with. Before you connect an account with wide access for the whole
> Organization, ask whether a personal connection would do.

The tools themselves still have the last word. Some connections need you to be
an administrator on the other side as well: for example, an Organization-wide
Granola key needs a Granola workspace administrator on a Business or Enterprise
plan, and adding or removing Rally in Slack needs a Slack administrator.
