---
title: Organization settings
description: Set the Organization's name and time zone, decide where Rally's code may reach on the internet, and control shared connections.
---

A handful of settings apply to everyone in the Organization at once. They live
in three places in the Settings window: **Organization**, its child page
**Internet access**, and **Connections**. Everyone can look at them. Only
owners and administrators can change them.

## Organization preferences

Open **Settings → Organization**. The first block, **Organization
preferences**, says it holds **organization details and defaults shared by
organization automations**. "Automations" is the old name for Sidekicks; the
screen has not caught up yet.

It has two rows.

- **Organization** shows the Organization's name. It is for reference only:
  there is no control to rename the Organization on this screen.
- **Default timezone** is the time zone an Organization Sidekick uses when it
  does not name one of its own. Pick one from the list and it saves straight
  away.

The default time zone matters for anything scheduled. A Sidekick set to run "at
9 every weekday" needs to know whose 9 o'clock. If most of your team is in one
place, set it to theirs, and nobody gets their morning report at 2 in the
afternoon. Schedules are covered in [Triggers and schedules](../07-sidekicks/03-triggers-and-schedules.md).

Your own time zone is a different setting, under **Settings → Account**,
described in
[The Settings window](../09-settings-and-shortcuts/01-the-settings-window.md).

## Internet access for the Terminal

Rally has its own private computer for running code, the Terminal, which you
met in [Code, data and the Terminal](../04-working-with-rally/03-code-files-and-the-terminal.md).
This setting decides where code running on that computer may connect on the
internet. It is the one setting in this chapter that is mainly about security,
so it is worth a careful read.

Open **Settings → Organization → Internet access**. The page is headed
**Terminal network access**, and its description mentions **Daytona**. Daytona
is the company that runs the computers behind Rally's Terminal, so wherever
you read "Daytona" on this page, think "Rally's Terminal".

### The two choices

Under **Outbound access**, choose one:

| Choice | What code in the Terminal can reach | Pick it when |
| --- | --- | --- |
| **Trusted only** | What Rally itself needs, which covers GitHub and the usual places software packages are downloaded from, plus any domains your Organization approves. | You want to know where your data could go. Code Rally runs cannot send anything to a site you have not approved. |
| **Full internet** | Any public website or service. Private networks stay blocked either way. | Your team's work needs Rally's code to fetch from many different sites, and the convenience is worth the wider reach. |

**Trusted only** is the careful choice. If Rally writes code that tries to
reach a site not on the list, the connection fails. That protects you from
code that would otherwise send your files somewhere unexpected, at the cost of
the occasional "I could not download that" from Rally. **Full internet**
removes that limit for public sites.

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
**3 organization domain slots remain.** Choose the domains you add with care.

These domains apply only under **Trusted only**. Switching to **Full internet**
makes them irrelevant, though Rally remembers them.

### Review and confirm the change

Changing this setting takes two steps, because it affects everyone's work in
progress.

1. Make your change, then click **Review network change**.
2. Rally shows a confirmation, for example **Confirm Trusted only**, with a
   warning and how many active sandboxes (Terminals currently running) will be
   stopped.
3. Open **Review exact before and after targets** to see the approved domains
   **Before** and **After**, and the **Channels stopped** by the change.
4. If you want a copy of the new list for your records, click **Download
   organization domains**. Rally saves it as a text file.
5. Click **Confirm network change** to apply it, or **Cancel** to back out.

> [!WARNING]
> Confirming stops every Terminal that is running in the Organization, in every
> Channel listed. Rally cancels the work those Terminals are doing, keeps a
> record of the unsaved changes in each, and does not restart them on its own.
> Pick a quiet moment, and tell the people in the listed Channels.

Sidekick runs are not stopped. Each run uses the rules that were in place when
it started.

Next to the **Review network change** button, Rally shows a status badge and a
**Revision** number, which goes up by one with each change you confirm.

### When the Terminal is unavailable

The page may show **Terminal unavailable** with one of two explanations:

- **Temporarily disabled by the regional safety switch.** Rally has switched
  the Terminal off for now, usually while fixing a problem. Try again later.
- **This regional service has not enabled Daytona Terminal.** The Terminal is
  not available for your Organization's region.

Either way the controls are greyed out until it comes back.

## Shared connections

Chapter 5 explains connections in detail, starting with
[Settings → Connections](../05-connecting-your-tools/01-connections.md). Here is
the part that belongs to administrators.

Every member can connect their own accounts as **Personal connections** and
manage them. Connections the whole Organization shares are different, and only
owners and administrators can:

- **Add Organization connections**, with the **Connect for organization**
  button next to a connector. Members do not see that button.
- **Refresh, reconnect and delete** Organization connections. Deleting one
  removes it and its tools from everyone in the Organization, and Rally says so
  before you confirm.
- **Issue and replace API keys** for connectors that use one for the whole
  Organization, such as [Ashby](../05-connecting-your-tools/09-ashby.md) and
  [Granola](../05-connecting-your-tools/07-granola.md).
- **Create and refresh Organization webhooks**, as described in
  [Inbound webhook](../05-connecting-your-tools/12-inbound-webhook.md).
  Refreshing replaces the signing secret, and the old one stops working at
  once.
- **Choose which GitHub repositories** Rally may use, and whether it may change
  them, under the GitHub settings described in [GitHub](../05-connecting-your-tools/03-github.md).
- **Choose which tools** of a shared [custom MCP server](../05-connecting-your-tools/13-custom-mcp-server.md)
  Rally may use: **All tools** or **Read-only tools**.
- **Manage events** for Ashby, which decides what Ashby activity reaches Rally.

> [!IMPORTANT]
> An Organization connection is shared in full. Every member can use every tool
> it grants, in any Channel, and Rally acts with the account you connected it
> with. Before you connect an account with wide access for the whole
> Organization, consider whether a personal connection would do.

The tools themselves still have the last word. Some connections need you to be
an administrator on the other side as well: for example, an Organization-wide
Granola key needs a Granola workspace administrator on a Business or Enterprise
plan, and adding or removing Rally in Slack needs a Slack administrator.

## What is not here

You may go looking for these, so to save you the search: Rally's settings have
no billing, plan or subscription section, no single sign-on (SSO or SAML), and
no verified email domains. The only domains anywhere in Settings are the ones
on the Internet access page. If you need any of these, write to
[help@rallywith.ai](mailto:help@rallywith.ai).
