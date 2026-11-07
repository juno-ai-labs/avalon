---
title: Where a Sidekick's results go
description: Tell a Sidekick where to post its work, and let it remember what it has already seen.
nav_title: Where results go
---

A Sidekick that does its work and tells nobody is keeping a diary. This page
covers getting the results in front of the right people, and keeping a
repeating Sidekick from telling you the same thing twice.

## Its own conversation, always

Every run posts its reply as a row in the Sidekick's conversation, so everyone
the Sidekick is shared with can see how it went. Beyond that, where the work goes is part of the
Sidekick's instructions, which means you choose it in plain words while you
make the Sidekick, and you can change it the same way.

A Sidekick can also deliver its work:

- **into a Canvas.** "Write the changelog up as a Canvas" makes a new Canvas on
  each run, and "keep the incident Canvas up to date" publishes a new version
  of the same one. A card for the Canvas appears in the conversation, and the
  Canvas joins the Canvases list under **From Sidekicks**.
- **out through your connected tools.** "Send me a Slack DM", "post in
  #status", "email the team", "add a comment to the Linear issue". Anything
  Rally can do with a connected tool, a run can do (see
  [Connecting your other tools](../05-connecting-your-tools/index.md)).

Different runs can send to different places, too: "Update the Canvas on
routine weeks, but DM me if anything is on fire."

A Sidekick's post appears under the Sidekick's own name, so everyone can tell
it apart from a person or from Rally answering a question. Now and then a post
is labelled "Automation", the old name for a Sidekick.

## Canvases it writes to

A Canvas a Sidekick makes starts out open to the people the Sidekick is shared
with. From then on people can talk to Rally about it and comment on it like any
other Canvas, and the Sidekick's managers decide who else can open it, as
[Who can see what](../02-canvases/08-who-can-see-what.md#canvases-from-a-sidekick)
explains. When the Sidekick runs again and its instructions say to update that
Canvas, it publishes a new version, and the version says it came from the
Sidekick.

Every Canvas a Sidekick writes to is listed in its details column, so you can
find the latest report without scrolling back through the conversation.

Three things trip people up.

- **Say where.** If people outside the Sidekick's conversation need the result,
  say so in its instructions. A Sidekick that only replies in its own
  conversation is easy to miss.
- **It can only post where its access allows.** A Sidekick delivers through the
  access of the person it is acting as (see
  [Tools and delegation](06-tools-and-delegation.md)), so it can post only
  where that person could.
- **Describing is not sending.** A run that only says it sent a message has
  not sent one. If nothing arrived, unfold the run's row; the run may have
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
the same run carries on with their reply in mind, and its row in the
Sidekick's conversation updates. More on that in
[Slack: reading, replies and your own connection](../08-rally-everywhere/02-more-from-slack.md).

## Remembering between runs

Every run starts fresh, but can reuse files left by the drafting assistant or
earlier runs. Sharing files does not automatically tell it what work was
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
- **Quiet runs stay quiet.** A run that finds nothing new sends nothing
  anywhere else. Its row in the conversation says so, such as **No changes this
  week**.
- **What you tell it while drafting sticks.** The drafting conversation and
  every run share the Sidekick's memory. Say "remember I prefer short
  summaries" in the Sidekick's conversation and its runs will know.
- **Your personal memory is not used.** A run works for the Sidekick, so it
  uses the Sidekick's own memory plus your Organization's shared memory, not
  the things Rally remembers about you personally. Memory in general is
  covered in
  [Memory and coming back later](../04-working-with-rally/05-memory-and-coming-back-later.md).
