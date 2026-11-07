---
title: Memory and coming back later
description: Rally can remember things across conversations, keep running lists, and set itself a reminder to continue later.
---

Inside one Canvas, Rally already remembers the conversation. This page is
about the things that last longer than that: facts Rally keeps from one
conversation to the next, lists it keeps up to date between runs, and
reminders it sets itself to come back and finish a job.

## Memory

Without memory, you would tell Rally in every new Canvas that your financial
year starts in April, that you like summaries as bullet points, and that "the
board" means four specific people. With memory, you tell it once.

### What a memory is

Each memory is one sentence that makes sense on its own, such as "Priya
prefers weekly reports as a table, not prose". It can carry a date when it
stops being true ("until the end of the quarter") and a note on why Rally
saved it.

Rally can search its memories, add new ones, update them and retire ones that
are no longer true. You see this in the conversation as rows that say
**Searching memory**, **Saving to memory**, **Updating memory** and
**Clearing a memory entry**.

When a run starts from something other than a message from you, such as a
Sidekick running on a schedule, Rally also looks up relevant memories by
itself before it begins.

### Asking Rally to remember or forget

Tell it in plain words:

- "Remember that our launch date moved to 14 November."
- "Remember that I want drafts, never sent emails, unless I say send."
- "Forget what I said about the Berlin office. We closed it."
- "What do you remember about how I like reports?"

There is no screen for browsing or editing memories. You do all of it by
asking Rally.

### Where a memory lives

Every memory belongs to one of four places, and that decides who it helps.
Rally picks the narrowest one that fits, and you can tell it which you mean.

| Kept for | Used by | Example |
| --- | --- | --- |
| **This Canvas** | Rally in this Canvas only | "In this Canvas, amounts are in euros." |
| **A Sidekick** | That Sidekick's future runs | "Already reported the outage on 2 May." |
| **You** | Rally when it is working for you, in any Canvas | "I am in the London office." |
| **The Organization** | Rally for everyone in the Organization | "Our financial year starts on 1 April." |

Anyone can ask Rally to remember things for themselves. Only owners and
administrators can have Rally save a memory for the whole Organization.

A Sidekick's memory is its own. Every run of that Sidekick shares it, and it is
kept apart from the memory of the person who made the Sidekick.

### Where memory falls short

- **Memory can be out of date.** Rally treats a memory as a helpful hint, not
  a fact, and checks it when getting it right matters. If Rally keeps relying
  on something that has changed, tell it, and it updates or retires the memory.
- **Retiring is permanent.** A retired memory cannot be brought back. If you
  change your mind, ask Rally to remember it again.
- **Helpers have no memory.** The helper agents described in
  [Helpers, other conversations and receipts](06-helpers-and-receipts.md)
  cannot read or save memories.
- **Memory is not a store for your other tools' data.** Rally will not copy
  your Linear issues or Drive files into memory. It looks them up in the app
  instead, where they are always current.

> [!WARNING]
> Never ask Rally to remember a password, an API key or any other secret. It
> is instructed not to store them. Think about who a memory is for before you
> ask: anything saved for the Organization is used by Rally when it works for
> everyone in it, so keep private matters in your own memory or out of memory
> entirely.

## Running lists: durable tables

Some jobs need more than a sentence. A Sidekick that checks for new support
tickets every hour needs to know which tickets it has already seen. A
watchlist of competitors needs one row per company. For these, Rally keeps
**durable tables**: proper tables with columns, which last between runs and
can grow large.

You will see rows such as **Creating a durable table**, **Querying a durable
table** and **Adding durable table rows**. Rally reads only the rows it needs,
so a long list does not slow it down.

Mostly you will meet these inside Sidekicks, where Rally sets them up for you
when a Sidekick has to keep track of what it has handled. You can also ask for
one directly: "Keep a list of every customer who mentions pricing in a call,
and add to it each week."

Like memory, there is no screen for viewing these tables. Ask Rally what is in
one and it tells you. Rally
does not keep secrets or whole copies of the original messages in them, only
what it needs to keep track.

Sidekicks themselves are covered in
[Where a Sidekick's results go](../03-sidekicks/07-where-results-go.md).

## Coming back later: scheduled wake-ups

Some jobs cannot be finished now. The deploy has not finished. The client has
not replied. The recap should go out on Friday, and it is Tuesday. For these,
Rally can set itself a reminder and pick the work back up later, in the same
Canvas.

Ask in plain words:

- "Come back in two hours and check whether the deploy finished."
- "On Friday at 5pm, send the team the weekly recap."
- "Check again in 30 minutes. If the build is still red, tell me what broke."

Rally replies with when it will wake up. The row says **Scheduling a
wake-up**. You can ask what is waiting ("What wake-ups have you got
scheduled?") and cancel one ("Cancel the Friday recap"), and you will see
**Checking scheduled wake-ups** and **Cancelling a wake-up**.

When the time comes, Rally starts a new run in the Canvas with the note it
wrote itself. It first checks whether the conversation has already settled the
matter. If someone already sent the recap, it says so briefly rather than
sending it twice.

### The rules for wake-ups

- **Times are in your time zone,** or the Organization's if Rally does not know
  yours. Say "London time" or "Pacific" if you mean somewhere else.
- **At least a minute, at most a year.** A wake-up has to be at least 60
  seconds away and no more than a year away.
- **Up to 20 waiting per Canvas.** If a Canvas already has 20, one has to be
  cancelled before Rally can add another.
- **Rally does not put things off.** It will not schedule a wake-up for work it
  can finish now. Patience is a virtue, but not one Rally needs at 10 a.m. on a
  Tuesday.
- **The note has to stand alone.** Rally writes the instructions for its future
  self in full (what to do, where, and what done looks like), so the later run
  is not relying on a detail buried in the conversation.

> [!TIP]
> A wake-up is a one-off. For something that should happen every Friday, not
> only this Friday, make a Sidekick with a schedule instead. See
> [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md).

Next: [Helpers, other conversations and receipts](06-helpers-and-receipts.md).
