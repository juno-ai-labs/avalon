---
title: Triggers and schedules
description: "Decide what starts a Sidekick: a time, an interval, an event in another tool, a webhook or an email."
---

A trigger is the "when" of a Sidekick. Give a Sidekick a trigger and it
becomes delegated work: it starts runs on its own whenever the trigger fires.
Leave it without one and it stays a page of instructions that Rally loads in
conversations (see [What a Sidekick is](01-what-a-sidekick-is.md)).

You never pick triggers from a list. You say when you want the Sidekick to
work, in an **Edit Sidekick** message in its conversation, and the drafting
assistant sets it up.
The triggers it chose then appear in plain words in the details column under
**Wakes on**, with a clock for a schedule and a bolt for an event, along with
**Next** and how long until the next run.

## The kinds of trigger

| Trigger | You might say | Shows in Run history as |
| --- | --- | --- |
| By hand | (press **Run now**, or ask it in its conversation) | On request |
| A schedule | "Every Monday at 9am" | Scheduled |
| An interval | "Check my inbox every hour" | Scheduled |
| An event in a connected tool | "Whenever a new Granola note lands" | Event |
| An event that meets a condition | "When a customer emails about pricing, flag it" | Event |
| An inbound webhook | "When our order system sends a new order" | Event |
| An email to the Sidekick | "Let me forward emails to you" | Email |

A Sidekick can have more than one trigger. A weekly report that you also
want to run on demand needs no extra setup: **Run now** works on any active
Sidekick that has at least one trigger, and anyone it is shared with can ask
it for a run in its conversation. Both are covered in
[The Sidekicks section](05-the-sidekicks-section.md#run-now).

## Schedules and intervals

A **schedule** runs at a time of day or on a calendar pattern: every weekday
at 8, the first Monday of the month, Fridays at 4pm. An **interval** runs
every so often: every hour, every 30 minutes.

When you ask for something that needs checking, the drafting assistant
prefers not to poll more often than every 10 minutes, and it tells you how
often it will look. Checking your inbox every ten seconds would not make the
email arrive any sooner.

### Time zones

A schedule is always read in a time zone. Rally picks it like this:

1. If you named one while drafting ("9am Pacific"), that one.
2. Otherwise, for an **Only you** Sidekick, your own default time zone.
3. Otherwise, for a shared Sidekick, the Organization's default
   time zone.

You set your own default with the **Default timezone** setting in your
account settings, and an owner or administrator sets the Organization's with
the **Default timezone** setting in Organization settings. See [The Settings window](../09-settings-and-shortcuts/01-the-settings-window.md)
and [Organization settings](../10-running-an-organization/03-organization-settings.md).

> [!TIP]
> If you never named a time zone, the default is looked up each time the
> Sidekick runs. Change your default later and every such schedule moves with
> it. If a Sidekick must fire at 9am in New York whatever happens, say "9am
> New York time" when you make it.

## Events in your other tools

An event trigger starts a run when something happens in a connected tool.
For example:

- **Slack**: a message or thread reply in channels you choose, Rally being
  mentioned, a direct message to Rally, a reaction added or removed, a file
  shared, a message edited or deleted, a channel created, or someone joining
  or leaving a channel.
- **Linear**: issue and comment changes, such as a new issue or a new
  comment.
- **GitHub**: things like an issue or pull request being opened, closed or
  merged, a review, a comment, or a release.
- **Granola** and **Fireflies**: a new meeting note or a processed meeting.
- **Ashby**: candidates moving through your hiring process.

Each tool's own page in [Connecting your other tools](../05-connecting-your-tools/index.md)
says what it can announce. If the tool you name cannot announce events, the
drafting assistant falls back to checking it on a timer instead, and says so.

Event triggers have a few rules of their own.

- **Only new events count.** A Sidekick reacts to things that happen after
  it is turned on (or resumed). It does not work through the backlog.
- **Some tools need the Organization's connection.** Granola, Fireflies and
  Ashby send events only through a connection made for the whole
  Organization, so a personal connection will not start a Sidekick. See
  [Settings → Connections](../05-connecting-your-tools/01-connections.md).
- **Slack channels you name get a visitor.** When a Sidekick watches a
  public Slack channel, Rally's Slack bot joins that channel so it can hear
  what is said there.
- **Private activity stays private.** Activity that is restricted to certain
  people is not passed to Organization Sidekicks, and reaches a personal
  Sidekick only if its owner was allowed to see it in the first place.

### Events with a written condition

Sometimes "every new email" is too much and you want "every new email from a
customer asking about pricing". You can describe the condition in plain
words, and each event is checked against it by Rally before a run starts.
Events that do not match are skipped.

If the check cannot decide, or cannot run at that moment, the event is
skipped rather than run. A Sidekick with a condition will occasionally miss
a borderline case; it will not suddenly act on everything.

## Inbound webhooks

If a system you use has no ready-made connector, it can still start a
Sidekick by sending an inbound webhook: a small message from that system to
an address Rally gives you. Setting one up is covered in
[Inbound webhook](../05-connecting-your-tools/13-inbound-webhook.md). Once the
webhook exists, tell the drafting assistant to run when it delivers something.

## Email a Sidekick

A Sidekick can have its own permanent email address. Send or forward a
message to it, and a run starts with that email as its starting material.
It suits "here, deal with this" jobs: forward an invoice to be
filed, or a long thread to be summarized.

To set it up, ask the drafting assistant for an email trigger ("I want to be
able to forward emails to you"). Once the Sidekick has an address, its
details column shows an **Email this Sidekick** section. Click it to reveal
the address, which is at `automation.rallywith.ai`.

Who can email it depends on who the Sidekick is shared with.

| Shared with | Accepts mail from |
| --- | --- |
| **Only you** | Its owner |
| Particular people, or the **Organization** | The email address of any active member of the Organization |

Mail from anyone else is refused. A paused Sidekick refuses all mail, and
starts accepting it again when you resume it; the address stays the same.
Archiving a Sidekick retires its address for good.

> [!WARNING]
> The sender check looks at the "From" address, which can be faked. Rally
> treats the content of every email as outside material, not as an
> instruction from a member, but a run started by email still has all of the
> Sidekick's usual tools and connections. Think twice before giving an
> email-triggered Sidekick instructions to send, delete or pay for things,
> and do not share its address more widely than you need to. Anyone who can
> see the Sidekick can see its address.

Instructions-only Sidekicks have no email address, since they never run on
their own. Email sent to Rally anywhere else does not start anything: an
email trigger on a Sidekick is the way to hand Rally work by email.
