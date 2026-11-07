---
title: Helpers, other conversations and receipts
description: How Rally splits big jobs between helper agents, reaches other conversations, and avoids doing the same thing twice.
nav_title: Helpers and receipts
---

Some jobs are too big for one conversation, and some go wrong halfway. This
page covers the helpers Rally calls in, the other conversations it can reach,
and the records it keeps so that a dropped connection never turns into a
duplicate email.

## Helpers: background agents

Some jobs split naturally into pieces. "Compare these eight suppliers" is
eight pieces of research and one comparison. Rather than doing the pieces one
after another, Rally can start **background agents**: helpers that each take
one piece and work on it at the same time. Rally hands out the work, waits for
the answers, and pulls them together.

This has two benefits. Big jobs finish sooner, and the conversation stays
tidy, because each helper does its digging out of sight and reports back only
what Rally needs.

You do not have to ask for helpers. Rally decides when a job is worth
splitting, usually when the pieces need a lot of reading but only a short
answer each. If you want it to, you can nudge it: "Research each of these
companies in parallel."

### Seeing them work

While helpers are running, a quiet, shimmering line above the message box
counts them, such as **2 background agents running**. It disappears when they
are all done. (You met this line in
[While Rally works](../02-canvases/04-while-rally-works.md).)

In the conversation you see rows such as **Delegating to a background agent**,
**Messaging a teammate** and **Stopping a background agent**. "Teammate" here
means another agent, not one of your colleagues. Helpers do not get their own
rows in the sidebar.

### What a helper knows and can do

- **It acts with your authority.** A helper can do what Rally could do for you
  in that conversation, with the same tools and connections. No more, no less.
- **It starts without your conversation history.** Rally gives a helper
  instructions and attachments. It can read files on their shared computer,
  but does not automatically load the skills Rally used. If its work misses
  something you said earlier, that detail probably did not
  make it into its brief. Tell Rally, and it passes it on.
- **It shares the computer it works on.** Helpers use the same sandbox as
  their conversation or Sidekick (see
  [Code, data and the Terminal](03-code-files-and-the-terminal.md)). If two
  want to write to it at once, one waits a moment.
- **It has no memory.** Helpers cannot read or save the memories from
  [Memory and coming back later](05-memory-and-coming-back-later.md).

### Stopping a helper

Rally can stop a helper, and you can ask it to: "Stop the helper working on
the Acme research." Stopping a helper also stops any helpers that it started
itself. Anything a helper had already done stays done. Stopping does not undo.
A stopped helper can be picked up again later if Rally sends it another
message.

## Reaching other conversations

Rally in a Canvas works in that Canvas. It does not go reading your other
Canvases. A Sidekick's runs reach a little further, because their job needs it:
a run can read and post to its Sidekick's own conversation, and publish to the
Canvases it writes to. This is how a Sidekick reports its results where the
team will see them. See
[Where a Sidekick's results go](../03-sidekicks/07-where-results-go.md).

You see this as rows that say **Reading a conversation** and **Posting to a
conversation**.

A few rules hold this in place:

- Rally can only reach conversations that the person it is working for can
  open. It cannot use this to see something you are not allowed to see.
- Archived conversations are skipped.
- Which conversations are in reach is decided by Rally's setup, not by the
  agent. Rally cannot widen it, however nicely you ask.
- A post from a Sidekick into another conversation does not set Rally off in
  that conversation. It is a message for the people there to read.

## Receipts: never doing the same thing twice

Things go wrong on the internet. A connection drops halfway through sending an
email. A service is slow to answer. A run fails and you press **Retry**. The
question is always: did that email go out, or not?

Rally keeps a receipt for every action that changes something, whether that is
sending an email, posting a message, updating an issue or editing a file. It
writes the receipt down before the action and again after it. When a run is
retried, Rally checks its receipts and skips anything it already did, so a
retry does not send the same email twice.

Click any activity row in the conversation to see what Rally sent to the tool
(**Input**) and what came back (**Result**), as described in
[While Rally works](../02-canvases/04-while-rally-works.md).

### When Rally cannot tell

Sometimes Rally asks another app to do something and never hears back. The
email may have gone, or it may not. In that case Rally does not guess, and it
does not try again in case it sends a second copy. Instead, the tool's card
shows a warning icon and says:

**Rally could not confirm whether this external action completed. It will not
retry automatically.**

> [!WARNING]
> When you see this message, check the other app yourself (your Sent folder,
> the Slack channel, the Linear issue) before you ask Rally to try again. If
> the action did go through, asking again would do it twice.

### Rally fixes its own small mistakes

Most of the time when a tool says no, it also says why, in words Rally can act
on: a file changed since Rally last read it, an edit matched more than one
place, or a connection needs renewing. So you will often see a row fail and
the next one succeed, as Rally reads the file again, narrows its edit or asks
you to reconnect. A failed row followed by a working one is Rally
correcting itself, not a problem for you to chase.

These messages never contain passwords or the other app's internal details.

## What comes next

So far Rally has worked on the web, on its own computer and inside Rally. The
next chapter connects it to the apps your team already uses, so it can read
your email, update your issues and file things in your Drive.

Next: [Connecting your other tools](../05-connecting-your-tools/index.md).
