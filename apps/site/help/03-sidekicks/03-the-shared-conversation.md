---
title: Talking to a Sidekick
description: Every Sidekick has one conversation shared by everyone it is shared with. Ask it for work, watch its runs, answer its questions.
---

Open a Sidekick and the middle of the window is its conversation. There is only
one, and everyone the Sidekick is shared with sees the same thing: what people
said, what the Sidekick did, and what it made. It works like a team channel
where one member happens to be an agent who never takes lunch.

## What is in the conversation

| You see | What it is |
| --- | --- |
| Messages from people | Teammates talking to each other, or to the Sidekick |
| A folded run row | One run of the Sidekick, with its reply showing |
| A Canvas card | Something the run made for people to work on, such as **Checkout latency · Nov 6** |
| Setup messages | Managers changing the Sidekick with its drafting assistant |

The message box at the bottom names the Sidekick, as in **Message Incident
triage and the team…**. It is the same box as in a Canvas, with mentions,
attachments and dictation (see [The message box](../02-canvases/02-the-message-box.md)).

## Asking the Sidekick for work

Write to the Sidekick the way you would write to the colleague who does that
job: "can you rerun this week's numbers with the refunds taken out?". A message
addressed to the Sidekick starts a run, the same kind of run its schedule or
triggers start, with your message as the opening request.

Not every message is for the Sidekick. "Theo, is the fix going out today?" is
for Theo, and the Sidekick leaves it alone. Rally reads each new message and
decides whether it is for the Sidekick, for the people, or (from a manager) a
change to the Sidekick itself. To be sure, mention the Sidekick by name, or
mention **@Rally**.

A run started from a message uses the access of the person who sent it, unless
that person is on the Sidekick's **Delegation allowed** list. So asking a
shared Sidekick for something never reads anything you could not read
yourself. [Tools and delegation](06-tools-and-delegation.md) explains the rule.

## Run rows

Every run, whatever started it, appears in the conversation as one row. Folded,
the row shows how the run started (a schedule, an event, an email, or a
person's message), its state and, once it has finished, its reply. Click the
row to unfold it and see each step the run took, with the same activity rows
and receipts as a run in a Canvas (see
[While Rally works](../02-canvases/04-while-rally-works.md#following-along)).

| State | It means |
| --- | --- |
| **Running** | The run is working now. |
| **Needs input** | The run is waiting for something only a person can give it. |
| **Latest run completed** | It finished. |
| **Latest run stopped** | Someone stopped it. |
| **Needs intervention** | It failed. The row has a **Retry** button and a Request ID. |

A run can wake up again. If someone replies to something it posted, such as a
Slack thread it started, the same run carries on and its row updates. It does
not start a second row.

## When the Sidekick needs input

Sometimes a run is missing something only a person has: which status page gets
the update, which of two spreadsheets is the real one, a sign-in that has
expired. The run asks in the conversation and waits. The Sidekick moves to the
**Needs input** group at the top of your Sidekicks sidebar, with its question
under its name, and the **Sidekicks** button on the rail counts it.

Answer in the conversation, in plain words or with the question card's
choices, and the run carries on. Anyone the Sidekick is shared with can answer,
unless the Sidekick asked one person by name.

"Needs input" never means a Sidekick is waiting for permission to use a tool.
Sidekicks do their work without asking anyone to approve each step.

## Canvases in the conversation

When a run makes something people will work on afterwards, such as a weekly
report, an incident timeline or a cleaned-up spreadsheet, it makes a Canvas, and
a card for it appears in the conversation. Click the card to open the Canvas.
It is also in your Canvases list, under **From Sidekicks**.

From there, it is a Canvas like any other: talk to Rally about it, comment on
it, share it further. The next time the Sidekick runs, it can update the same
Canvas with a new version rather than making another one, if its instructions
say so. The Canvases a Sidekick writes to are listed in its details column.

## Managers change the Sidekick here too

The people who manage a Sidekick change it in this same conversation, by
talking to its drafting assistant: "run it at 8 instead of 9", "leave out
weekends". Everyone in the conversation can see the change being made, and the
assistant says when it has saved a new version. A run already going finishes
with the version it started with.

People who are not managers can still suggest a change in the conversation,
and a manager can take it up. Who manages a Sidekick is covered in
[What a Sidekick is](01-what-a-sidekick-is.md#who-a-sidekick-is-shared-with).

Next: [Triggers and schedules](04-triggers-and-schedules.md), for everything
that can start a run when nobody asks.
