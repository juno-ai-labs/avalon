---
title: Where a Sidekick's results go
description: Tell a Sidekick where to post its work, and let it remember what it has already seen.
nav_title: Where results go
---

A Sidekick that does its work and tells nobody is keeping a diary. This page
covers getting the results in front of the right people, and keeping a
repeating Sidekick from telling you the same thing twice.

## The instructions decide

Rally does not send a run's result anywhere by itself. Where the work goes
is part of the Sidekick's instructions, which means you choose it in plain
words while you make the Sidekick, and you can change it the same way.

A Sidekick can deliver its work:

- **into its home Thread or Breakout.** A Thread Sidekick posts into the
  conversation it belongs to unless you tell it otherwise. "Post the summary
  here" is all it takes.
- **into other conversations you attach to it.** Ask the drafting assistant
  to attach another Thread, and the Sidekick can post there too.
- **out through your connected tools.** "Send me a Slack DM", "email the
  team", "add a comment to the Linear issue". Anything Rally can do with a
  connected tool, a run can do (see
  [Connecting your other tools](../05-connecting-your-tools/index.md)).

Different runs can send to different places, too: "Post routine weeks here,
but DM me if anything is on fire."

A Sidekick's post appears in the conversation under the Sidekick's own name,
so everyone can tell it apart from a person or from Rally answering a
question. Now and then a post is labelled "Automation", the old name for a
Sidekick.

Three things trip people up.

- **Say where.** A personal Sidekick with no home conversation and no
  connected tools to send through can only leave its work in its
  [Run history](04-the-sidekicks-window.md#run-history), where only a
  summary is visible. If a Sidekick seems to run and say nothing, check that
  its instructions tell it where to post.
- **It can only post where you can.** A Sidekick can deliver only to places
  the person who set it up is allowed to post.
- **Describing is not sending.** A run that only says it sent a message has
  not sent one. If nothing arrived, look at the run history; the run may have
  stopped or be waiting for input.

## Delivering to Slack

If your Organization has Rally installed in Slack, a Sidekick can send you
its results as a direct message from Rally. For that to work you also need
to link your own Slack account to Rally, from Rally's **Home** tab in Slack.
[Rally in Slack](../08-rally-everywhere/01-rally-in-slack.md) and
[Slack: reading, replies and your own connection](../08-rally-everywhere/02-more-from-slack.md)
explain both steps.

A good first Sidekick to try is the morning inbox briefing. Ask:

> Check my Gmail every morning and send me the stack-ranked top 3 emails in
> Slack.

Rally sets up a personal Sidekick that reads your Gmail each morning and
sends you a Slack DM with up to three emails worth your attention. On a
morning with nothing worth sending, it stays quiet. If your Gmail or Slack connection
stops working, the run waits for you with **Needs input**.

When a Sidekick starts a Slack thread, people can reply in that thread and
the run carries on with their reply in mind. More on that in
[Slack: reading, replies and your own connection](../08-rally-everywhere/02-more-from-slack.md).

## Remembering between runs

Every run has its own conversation, but can reuse files left by the wizard
or earlier runs. Sharing files does not automatically tell it what work was
completed. Without records, a Sidekick asked to "tell me what is new" could
report the same five issues every hour.

That is why a Sidekick keeps its own memory. It can write notes to itself that later
runs read, and it can keep a small table of things it has already seen. When
you ask a Sidekick to watch for new things, the drafting assistant sets this
up for you. There is no screen for it; it happens inside the runs.

What this means for you:

- **The first run of a watcher sets a baseline.** It notes what already
  exists without reporting it, then reports only what is new from then on.
  If you want to be caught up on everything already there, say so while
  drafting.
- **Quiet runs stay quiet.** A run that finds nothing new finishes without
  posting.
- **What you tell it while drafting sticks.** The drafting conversation and
  every run share the Sidekick's memory. Say "remember I prefer short
  summaries" in the Sidekick's conversation and its runs will know.
- **Your personal memory is not used.** A run works for the Sidekick, so it
  uses the Sidekick's own memory plus your Organization's shared memory, not
  the things Rally remembers about you personally. Memory in general is
  covered in
  [Memory and coming back later](../04-working-with-rally/05-memory-and-coming-back-later.md).
