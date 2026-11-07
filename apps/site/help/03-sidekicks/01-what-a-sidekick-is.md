---
title: What a Sidekick is
description: Understand the parts of a Sidekick, the two kinds, and who a Sidekick is shared with.
---

A Sidekick is a shared AI agent with these parts:

- a **name**, so you can find it;
- a one-line **description** of what it is for;
- written **instructions**, the know-how it carries, in plain language;
- optionally, one or more **triggers** that tell it when to start working by
  itself;
- the **tools** it uses, including any it has been given of its own;
- one **conversation**, shared by everyone the Sidekick is shared with.

You do not type these into boxes. The Sidekick's drafting assistant writes them
for you while you describe what you want, which is the subject of the
[next page](02-make-a-sidekick.md). This page is about what you end up with.

## Instructions only, or delegated work

Triggers decide which of two kinds a Sidekick is. The Sidekicks section labels
each one, so you can tell them apart at a glance.

| | Available in conversations | Delegated work |
| --- | --- | --- |
| Has triggers | No | Yes |
| Starts by itself | Never | On a schedule, an event, an email, or when someone asks it |
| What it does | Lends its instructions to Rally in a Canvas | Runs a job and reports back |
| Good for | A brand voice guide, a house style for proposals, a checklist | A Monday summary, an inbox sweep, watching a Slack channel |

### Available in conversations

A Sidekick with no triggers is a page of know-how. When you ask Rally for
something it covers, Rally can load the Sidekick's instructions into the
Canvas and follow them, the same way a new colleague might pull the style guide
off the shelf before writing a press release. If you have a "Brand voice"
Sidekick and ask for a launch announcement in a Canvas, Rally can pick up the
brand voice and write in it.

Rally decides when a Sidekick is relevant. Having one does not mean every
answer follows it, and that is deliberate: your proposal checklist has no
business turning up in a conversation about lunch. If you want a particular
Sidekick used, say so ("use the Brand voice Sidekick").

A Sidekick's instructions are guidance only. Loading one never gives Rally a
tool or a connection it did not already have in that Canvas.

### Delegated work

A Sidekick with at least one trigger starts runs on its own, and also when
someone in its conversation asks it to. Each run reads the Sidekick's
instructions, does the job with the tools it has, posts its reply as a row in
the Sidekick's conversation, and sends the result anywhere else the
instructions say. Runs share the Sidekick's files and memory, so a run can pick
up where the last one left off. [Triggers and schedules](04-triggers-and-schedules.md)
lists every way to start one, and
[Where a Sidekick's results go](07-where-results-go.md) covers the reporting
back.

> [!NOTE]
> Adding a trigger to an instructions-only Sidekick turns it into delegated
> work, and it stops being offered for loading into Canvases. If you want both,
> make two Sidekicks: one that holds the know-how and one that runs on a timer.

## Who a Sidekick is shared with

Every Sidekick is shared with a group of people, shown on its row in the
Sidekicks section and in its details column.

| Shared with | Who can open it and talk to it | Who can change it |
| --- | --- | --- |
| **Only you** | You | You |
| Particular people, such as **Shared · 3 people** | You and the people you shared it with | Its managers: its author, and the Organization's owners and administrators |
| **Organization** | Every member of the Organization except guests | Its managers |

A few rules follow from this.

- **New Sidekicks start as Only you.** To share one, ask the drafting assistant
  in an **Edit Sidekick** message ("share this with Theo and Priya", "make
  this an Organization Sidekick"), or use **Share** in its details column.
- **Everyone it is shared with gets the same conversation.** There are no
  private side conversations with a shared Sidekick. If you would rather ask it
  something on your own, make a personal Sidekick for that.
- **Personal Sidekicks stay personal.** An **Only you** Sidekick is offered for
  loading only in Canvases where everyone present is you. It will not turn up
  in a Canvas your whole team is in.
- **Sharing is not delegation.** Being able to talk to a Sidekick does not let
  it act as you. That is a separate list, covered next.

## Whose access a run uses

When a Sidekick works in another tool, such as Gmail or Linear, it has to act
as somebody. Each Sidekick keeps a list called **Delegation allowed**: the
people it may act as, using their current access. Whoever creates a Sidekick
is on the list from the start, and anyone else can add or remove themselves
from the Sidekick's details column. Nobody can put you on it but you (or Rally,
when you ask it to).

Which access a run uses depends on how it started:

- **A trigger, or a request from someone on the Delegation allowed list.** The
  run can act as any of the people on the list, choosing whoever has access to
  what the job needs.
- **A request from someone who is not on the list.** The run acts with that
  person's own access only. If a step would need someone else's, the run says so
  and leaves that step out, rather than reading on their behalf.

So a teammate can ask a shared Sidekick anything, and still never read, through
the Sidekick, something they could not read themselves.
[Tools and delegation](06-tools-and-delegation.md) has the details.

> [!IMPORTANT]
> Think about this before you put yourself on a Sidekick's Delegation allowed
> list. Anything a trigger starts runs with your access when it needs it, and
> anyone who can email the Sidekick, or reply to it in Slack, can steer what
> such a run does next. Rally labels text from outside senders as outside
> material rather than as an instruction from a member, but write instructions
> that say plainly what the Sidekick should and should not do.

## Some Sidekicks to try

Here are a few that people make early on.

- **Brand voice** (instructions only, Organization): how your company
  writes, which words it avoids, and an example paragraph.
- **Weekly changelog** (delegated, Organization): "Every Friday at 2pm, write
  up what we shipped this week as a Canvas."
- **Morning inbox** (delegated, Only you): "Check my Gmail every morning and
  send me the top three emails in Slack."
- **Meeting follow-up** (delegated, shared with your team): "When a new
  Granola note lands, list the action items and who owns each."

None of these needs more than a sentence or two to start. The drafting assistant
asks about the rest.
