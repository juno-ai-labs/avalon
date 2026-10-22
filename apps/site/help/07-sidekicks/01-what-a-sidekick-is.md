---
title: What a Sidekick is
description: Understand the two kinds of Sidekick and who each one belongs to.
---

A Sidekick is a reusable helper with four parts:

- a **name**, so you can find it;
- a one-line **description** of what it is for;
- written **instructions**, the know-how it carries, in plain language;
- optionally, one or more **triggers** that tell it when to start working by
  itself.

You do not type these into boxes. The Sidekick's drafting assistant writes
them for you while you describe what you want, which is the subject of the
[next page](02-make-a-sidekick.md). This page is about what you end up with.

## Instructions only, or delegated work

Triggers decide which of the two kinds a Sidekick is. The Sidekicks window
labels each one, so you can tell them apart at a glance.

| | Available in conversations | Delegated work |
| --- | --- | --- |
| Has triggers | No | Yes |
| Starts by itself | Never | On a schedule, an event, an email, or when you press **Run now** |
| What it does | Lends its instructions to Rally in a conversation | Runs a job and reports back |
| Good for | A brand voice guide, a house style for proposals, a checklist | A Monday summary, an inbox sweep, watching a Slack channel |

### Available in conversations

A Sidekick with no triggers is a page of know-how. When you ask Rally for
something it covers, Rally can load the Sidekick's instructions into the
conversation and follow them, the same way a new colleague might pull the
style guide off the shelf before writing a press release. If you have a
"Brand voice" Sidekick and ask a Thread to draft a launch announcement,
Rally can pick up the brand voice and write in it.

Rally decides when a Sidekick is relevant. Having one does not mean every
answer follows it, and that is deliberate: your proposal checklist has no
business turning up in a conversation about lunch. If you want a particular
Sidekick used, say so ("use the Brand voice Sidekick"). In a Thread you can
also recommend one for everyone there, which is covered in
[Sidekicks in a Thread](06-sidekicks-in-channels.md).

A Sidekick's instructions are guidance only. Loading one never gives Rally a
tool or a connection it did not already have in that conversation.

### Delegated work

A Sidekick with at least one trigger starts runs on its own. Each run has a
separate conversation: Rally reads the Sidekick's instructions, does the job
with the tools it has, and sends the result wherever the instructions say.
The setup conversation (the wizard), runs and helpers share the Sidekick's
computer and files, while their conversation histories stay separate.
[Triggers and schedules](03-triggers-and-schedules.md) lists every way to
start one, and [Where a Sidekick's results go](05-where-results-go.md)
covers the reporting back.

> [!NOTE]
> Adding a trigger to an instructions-only Sidekick turns it into delegated
> work, and it stops being offered for loading into conversations. If you
> want both, make two Sidekicks: one that holds the know-how and one that
> runs on a timer.

## Who a Sidekick belongs to

Every Sidekick has a scope, shown as a badge beside its name and on its row
in the Sidekicks window.

| Badge | Belongs to | Who can see it | Who can change it |
| --- | --- | --- | --- |
| **Only you** | You | You | You |
| **Organization** | The whole Organization | Every member of the Organization except guests | Its author, the person it runs as, and the Organization's owners and administrators |
| **Thread** | One Thread or Breakout | The people in that Thread or Breakout | Anyone in that Thread or Breakout |

A few rules follow from this.

- **New Sidekicks start as Only you.** If you want one shared with the whole
  Organization, ask the drafting assistant to make it an Organization
  Sidekick before it is published.
- **Thread Sidekicks are born in a Thread.** You get one by asking Rally
  for a Sidekick from inside a Thread or Breakout. Its scope is fixed: it
  cannot later become personal or Organization-wide. (**Create new
  Sidekick** in a Thread's **Sidekicks** list starts an ordinary new Sidekick, which
  begins as **Only you**.)
- **Personal Sidekicks stay personal.** An Only you Sidekick is offered only
  in conversations where everyone present is you. It will not turn up in a
  Thread your whole team is in.
- **Organization Sidekicks use shared connections.** A Sidekick that belongs
  to everyone can only use the tools the Organization has connected for
  everyone, not your personal Gmail. If a personal Sidekick relies on your own
  connections, it cannot be promoted to Organization scope with those.
  [Settings → Connections](../05-connecting-your-tools/01-connections.md)
  explains the difference between connecting for yourself and for the
  Organization.

Who can see what in Threads and Channels works as described in
[Who can see what](../03-spaces-and-breakouts/04-who-can-see-what.md); a
Thread Sidekick follows its Thread.

## Whose permissions a run uses

When a Sidekick runs, it acts as one person: by default, the person who made
it. A run uses that person's permissions and their connected tools, no matter
what started it. If your Sidekick reads Gmail, it reads your Gmail, whether
the run began on a schedule, from an event, or because a teammate pressed
**Run now**.

> [!IMPORTANT]
> Think about this before you share a Sidekick or give it a way to be
> started by other people. Anyone who can start a run, email the Sidekick, or
> reply in a conversation a run started (such as a Slack thread) can steer
> what that run does next, and the run still acts with its owner's
> connections. Rally labels text from outside senders as outside material
> rather than as an instruction from a member, but write instructions that
> say plainly what the Sidekick should and should not do.

## Finding Sidekicks by scope

The Sidekicks window has four filter buttons above the list: **Everyone**,
**Only you**, **Organization** and **Threads**. Each row also says what kind
of Sidekick it is and who it belongs to, for example "Available in
conversations · Organization" or "Draft · Only you".
[The Sidekicks window](04-the-sidekicks-window.md) has the full tour.

## Some Sidekicks to try

Here are a few that people make early on.

- **Brand voice** (instructions only, Organization): how your company
  writes, which words it avoids, and an example paragraph.
- **Weekly Thread summary** (delegated, Thread): "Every Friday at 4pm,
  summarize what happened in this Thread this week and post it here."
- **Morning inbox** (delegated, Only you): "Check my Gmail every morning and
  send me the top three emails in Slack."
- **Meeting follow-up** (delegated, Organization): "When a new Granola note
  lands, list the action items and who owns each."

None of these needs more than a sentence or two to start. The drafting
assistant asks about the rest.
