---
title: While Rally works
description: Follow along, steer, stop, answer its questions, and know what to do if a run fails.
---

You have pressed send. Rally is on it. This page is about the stretch between
your request and its answer, including what to do when things go sideways.

## What a run is

Each time Rally sets off to do something for you, that is a **run**. During a
run Rally reads, thinks, searches, uses your connected tools and writes, step
after step, until it has an answer for you. A simple question might be a run of
a few seconds. A research report across your Gmail, Linear and the web might be
a run of half an hour.

You do not have to watch. Switch to another Canvas or go to a meeting. The run carries on without you, and the Canvas's row in the sidebar tells you
when it is done (see [Status dots](10-status-dots-and-badges.md)).

## Following along

While Rally works, it writes what it is doing into the conversation as short
rows in plain language, not as computer logs. For example:

- **Thought for 4s** when Rally stopped to think.
- **Using Slack for 4m 02s**, which becomes **Used Slack for 5m 02s** once it is
  finished with Slack.
- Rows like **Searching the public web**, **Reading a public web page**,
  **Running a command**, **Writing a file**, **Generating an image** or
  **Opening a pull request**.

There is one row for each tool Rally reaches for in each stretch of work, so a
long run does not flood the screen. Your connected apps (Slack, GitHub, Google,
Notion, Linear and so on) each get their own rows. Rally's own built-in tools
are grouped under **Rally**, and work on its private computer is grouped under
**Computer**. Work with Sidekicks is grouped under **Sidekicks**.

When the answer arrives, all the work above it folds into one closed row, such
as **Worked for 41m 17s**. Click it to open it again, and click any row inside
to see what Rally sent to that tool and what came back. It is the receipt for
what Rally did on your behalf.

A time that is blank means Rally does not know how long that step took. It does
not mean zero.

## Changing course while it works

You do not have to wait for Rally to finish before you speak. Send another
message while it is working, and Rally takes it into account in the run it is
already doing, rather than starting a second one. This is called steering. It is
for the moment you remember you wanted last quarter's numbers.

Your message shows a small **Unseen** label until Rally has read it. Rally
picks it up as soon as it finishes the step it is on. It never abandons a step
halfway through to read your message, so give it a moment.

## Stopping a run

While Rally is working, a small square **Stop** button appears beside the send
arrow. Click it, or type `/stop` into the message box and press
<kbd>Return</kbd>.

A line above the box says **Stopping once the current work finishes…** and,
shortly after, **Run stopped**.

Stopping is polite, not instant. Rally finishes the step it is on, including any
tool it has already started, and then stops. That can take a few seconds or
longer, so you may see a tool finish after you clicked.

> [!WARNING]
> Stopping does not undo anything. If Rally already sent an email or updated an
> issue before you pressed Stop, that action stays done. Check the activity rows
> to see what was completed.

Some other things to know:

- <kbd>Esc</kbd> does not stop a run. Use the button or `/stop`.
- If you press Stop and then send a steering message before Rally has read it,
  the stop wins.
- If stopping fails, you see **The run couldn’t be stopped.** Try again.
- The "stopping" and "stopped" lines are only shown to people who were in the
  Canvas at the time.

## Helpers working in the background

For big jobs Rally sometimes hands parts of the work to helper agents that run
side by side. When it does, rows grouped under **Background agents** in the
conversation say when one starts, what messages pass between them, and when it
finishes or fails. Helpers are explained
properly in [Helpers, other conversations and receipts](../04-working-with-rally/06-helpers-and-receipts.md).

## When Rally asks you a question

Rally tries not to interrupt you (more on that in
[How Rally works](../04-working-with-rally/01-how-rally-works.md)). But when a
decision is yours to make, it pauses and puts a question card in the
conversation. The activity row says **Asking for a decision**, and the run waits
for you.

A question card can ask you to:

- **Pick one** of a few choices, each with a short explanation.
- **Pick several.** The question then ends with **Pick everything that
  applies.** There may be a minimum or maximum, such as **Choose no more than 2
  options.**
- **Write an answer** in a text box.

Most choice questions also offer **Other**, where you can type your own answer.

To answer, click your choice (or choices) and press **Submit**. If you would
rather not answer, press **Skip**, and Rally carries on without your input.

You can also answer by typing a normal message in the message box while the
question is open. Rally takes that message as your answer.

### Answering from the keyboard

Each choice has a small key badge beside it. Press its letter (<kbd>A</kbd>,
<kbd>B</kbd>, <kbd>C</kbd>…) or its number (<kbd>1</kbd>, <kbd>2</kbd>,
<kbd>3</kbd>…) to pick it. **Other** is the last one in the list. Press
<kbd>⌘</kbd> <kbd>Return</kbd> to submit.

The letter and number keys are ignored while you are typing in a text field, so
you can write "B" in your answer without picking option B.

### Putting a question aside

The **X** on the card folds it into a bar that says **Rally needs input**. Click
the bar to open the question again. The run is still waiting, so do come back
to it.

If something goes wrong you may see **Choose or enter a response before
continuing.** (you pressed Submit with nothing chosen) or **Your response
couldn’t be saved. Try again.**

Once answered, your answer appears in the conversation as a message from you,
so everyone can see who decided what. A question Rally withdrew shows as
**Question cancelled**.

## When a run fails

Sometimes a run breaks. When it does, a red **Run failed** card appears in the
conversation. It has:

- A short message in plain words saying what went wrong.
- An error code, in small grey type.
- A **Request ID**, with a copy button beside it.
- A **Retry** button.

Start with **Retry**. Many failures are temporary and clear on their own. If the
retry also fails you see **The run couldn’t be retried.**

If it keeps failing, copy the Request ID and send it to the Rally team. It lets
them find exactly what happened. [Contacting support](../12-help-and-glossary/03-contact-support.md)
says how and what else to include.

A run that you stopped on purpose does not show this card. You meant to do that.

### Messages you might see

| Message | What to do |
| --- | --- |
| The model service could not complete this request. This usually clears on its own | Wait a moment, then press **Retry**. |
| Rally has paused requests to this model. Try again shortly | Try again in a little while. If it keeps happening, copy the Request ID for support. |
| Rally hit a platform limit partway through this run. Trying again usually works | Press **Retry**. |
| The model returned an empty response. Try again in a moment | Press **Retry**. |
| This run reached its model-turn limit | The job was too big for one run. Ask for a smaller piece, or ask Rally to carry on. |
| An external write may have completed, so Rally did not retry it | Rally was changing something in another tool and cannot be sure it worked. Check that tool before you ask again. |
| Rally could not record this tool's durable outcome. Check its card before retrying a write | Open the activity row for that tool to see what happened before you retry. |
| Rally could not complete this run. Retrying is unlikely to help | Copy the Request ID and contact support. |
| This run could not fit safely in the selected model context | The conversation or files were too much to fit in one go. Ask about a smaller part. |

Rally already retries a step once by itself when a network hiccup gets in the
way, so a failure you see has usually been tried twice. And once Rally has shown
you part of an answer, or done something in another tool, it will not quietly
start that step again behind your back.

An ordinary run in a Canvas has no time limit. Its only ceiling is 1,000 model
turns (roughly, 1,000 rounds of "think, then act"), which few requests come near.

## Opening a Canvas, and catching up

Rally opens a Canvas straight away from a copy kept on your Mac, then connects
to the live conversation. Until it is connected, a card says **Sending is
available once Rally connects**. You can type and attach files in the meantime.
Sending waits until the connection is live.

Scroll up and Rally fetches older messages as you go, with **Loading earlier
messages…** at the top. If you are offline it says **Waiting to reconnect…**,
and if loading fails, **Retry loading earlier messages** tries again.

When you come back to a Canvas with new messages, an **Unread messages** line
marks where you left off. Everything below it is new.

Once in a long while a message is too big to show at all, and you see **This message is
too large to display.** in its place.

Next: [Reading Rally's answers](05-reading-rallys-answers.md).
