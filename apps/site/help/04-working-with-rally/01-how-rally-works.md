---
title: How Rally works
description: "Meet the agent: how it decides what to do, which tools it reaches for, and why it rarely stops to ask."
---

You have given Rally a few jobs by now. This page lifts the lid on how it
chooses what to do, and how to ask so you get what you meant.

## One Rally per conversation

Each Canvas has one agent, called Rally, working in the conversation
alongside the people. Each Sidekick has its own conversation too, and each of
its runs works on its own. It is one ongoing thread of work per conversation,
not a fresh agent for every message. That is why you can say "now do the same
for March" and Rally knows what "the same" was.

When you are alone in a Canvas, every message goes to Rally. When other people
are there too, Rally decides whether each message is meant for it. Mention
**@Rally** to be sure. The details are in
[People in a Canvas](../02-canvases/07-people-in-a-canvas.md).

A message you send while Rally is busy does not interrupt it. Rally finishes
the step it is on, then reads your message and takes it into account (that is
steering, from [While Rally works](../02-canvases/04-while-rally-works.md)).

## How it goes about a job

Rally has a working style, and it is the same in every conversation.

**It gets on with it.** Ask Rally to draft a reply, look something up or fix a
spreadsheet, and it starts. It does not check whether you are sure.

**It keeps you informed when something changes.** For a larger job, Rally
briefly explains its approach before starting. While you work with it, Rally
posts an update if it hits a blocker, takes longer than expected, changes its
approach, or needs a decision from you. You can steer it at any point.

**It does not guess.** Dates, addresses, links and numbers have to come from
somewhere real: a tool, you, or a file you attached. That is why you sometimes
see a row that says **Checking the current time**. Rally does not trust its own
sense of what day it is, which is more than most of us can say on a Monday. For
arithmetic, Rally runs actual code on its own computer instead of doing sums in
its head (more in [Code, data and the Terminal](03-code-files-and-the-terminal.md)).

**It asks only when it must.** If a detail is missing and no tool can find it,
Rally asks you. If a decision is yours, it puts a question card in the
conversation, as described in
[While Rally works](../02-canvases/04-while-rally-works.md).

**It knows where to look.** For public facts, news and documentation, Rally
searches the web. For your company's own information (your email, your issues,
your documents) it goes to the apps you have connected instead.

> [!NOTE]
> Rally treats what it finds as evidence, not gospel. Web pages and things it
> remembered from earlier conversations are both treated as possibly out of
> date. When something matters, check it yourself.

## Rally never asks you to approve each tool

This is deliberate. Rally does not pop up
"Allow Rally to send this email?" or "Approve this change?" before each action.
There is no approval queue and no setting that adds one. When you ask Rally to
do something, you have given it the go-ahead.

That does not mean anything goes. Rally can only do what the connection behind
it allows. If you connected Gmail with your own account, Rally can do in Gmail
what you can do there, and nothing more. And it is careful in the places where
care matters: when Rally writes an email, for example, it makes a draft unless
you clearly asked it to send, and it tells you which it did.

> [!WARNING]
> Because Rally acts without asking, be clear about what you want. "Send the
> update to the team" will be sent. If you want to see it first, say "draft
> the update to the team".

## Where its abilities come from: plugins

Rally's abilities come in bundles called **plugins**. There is one for each of
these:

| Plugin | What it lets Rally do |
| --- | --- |
| **Web** | Search the public web and read pages. |
| **Terminal** | Use its own private computer to run code and work with files. |
| **Multimodal generation** | Make pictures and voice recordings. |
| **Background agents** | Hand pieces of a big job to helpers. |
| **Memory** | Remember things from one conversation to the next. |
| One per connected app | Work in Gmail, GitHub, Linear, Notion and the rest. |

Rally does not carry everything at once. It keeps a short catalogue of
what is available and loads a plugin when a request needs it. You see this as
a row that says **Loading a plugin**. Loading a plugin never gives Rally more
access than it already had.

If a job needs an app you have not connected, or a connection that needs
renewing, Rally says why and shows a card in the conversation that lets you
connect it there and then. These cards appear only when a person is in the
conversation. A Sidekick running on its own cannot stop to ask you to connect
something. [Connecting your other tools](../05-connecting-your-tools/index.md)
covers connections in full.

## Skills: know-how for tricky jobs

Some jobs have well-known ways to go wrong. An email to the wrong address. A
meeting invite in the wrong time zone. A research report that quietly states
a guess as a fact. For these, Rally has **skills**: short guides it reads before
starting. They load by themselves when your request matches. You never need to
ask for one.

The built-in skills are:

- **Deep research.** Rally breaks the question into claims it can check, uses
  your connected apps before the web, cross-checks and dates every fact, and
  tells you what it could not establish. The first pass of a research job only
  reads. It will not send or change anything.
- **Writing an email.** Rally finds real recipients through your account,
  never invents an address or a link, makes a draft unless told to send, and
  keeps replies in the right thread.
- **Scheduling a calendar event.** Rally settles the real time zones, finds
  the right attendees, and tells you who the invite will notify.
- **Watching for events.** When you ask Rally to keep an eye on something, it
  sets up a Sidekick that watches for it. It prefers the other app's own
  notifications, and otherwise checks no more often than every ten minutes.
  Sidekicks have their own chapter, starting at
  [What a Sidekick is](../03-sidekicks/01-what-a-sidekick-is.md).
- **Building live sites.** How to build and host a small web page or app (see
  [Live sites](../06-things-rally-makes/03-live-sites.md)).

A skill is guidance only. It never gives Rally a new tool or permission. There
is a limit on how many skills can be loaded at once in a single run. If Rally
reaches it, it carries on with the ones it already has.

## Long conversations

Rally reads the conversation before it answers, but there is only so much it
can hold in mind at once. When a long run fills about four fifths of that
space, Rally writes itself a tidy summary of the job so far: what you asked
for, what was decided, what is done, the important facts, the files that
matter and what is still open. It then carries on from that summary. You do
not have to do anything.

This only affects Rally's working notes. You and your teammates still see the
whole conversation, every message of it.

A few things to know:

- A detail that did not make it into the summary is gone from Rally's working
  memory. If something is critical, say it again, put it in a file, or ask
  Rally to remember it (see
  [Memory and coming back later](05-memory-and-coming-back-later.md)).
- Rarely, a conversation is too big for Rally to take in at all.
  You then see a message that begins **This conversation is longer than the
  selected model will accept. Start a new Canvas to continue**. Start one
  and tell Rally what it needs to know.
- Rally does not reach into your other Canvases to fill gaps. Each
  conversation stands on its own.

## What you will not find

Two things people often look for:

- **A model picker.** You cannot choose which AI model Rally uses.
- **A meter.** There is no price, token count or credit counter in the
  Canvas, the message box or the conversation.

## Asking well

A good request saves a round trip. These habits help:

- **Say what done looks like.** "A one-page summary I can paste into an
  email" beats "summarize this".
- **Point at the source.** "From the Q3 board deck in Drive" saves Rally
  searching your whole Drive and picking the wrong deck.
- **Say draft or send.** Rally takes you at your word, so choose the word.
- **Give the deadline and time zone** when dates matter, for example "by
  Friday, London time".
- **Attach the file** rather than describing it. Rally always answers a
  message with an attachment.
- **Steer, don't restart.** If the first answer is close, tell Rally what to
  change in the same Canvas. It remembers the rest.

Next: [Research and the built-in browser](02-research-and-the-web.md).
