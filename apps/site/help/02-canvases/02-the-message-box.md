---
title: The message box
description: Write to Rally and your teammates, with mentions, lists, slash commands and your voice.
---

Everything you say in a Canvas starts in the message box at the bottom of the
window. It is where you ask Rally for work, answer its questions and talk to the
people in the room. It looks like an ordinary chat box, and it mostly behaves
like one, with a few extras.

## Writing and sending

Open a Canvas and click the box that says **Ask Rally or the people here…**. Type your
message and press <kbd>Return</kbd> to send it.

- <kbd>Shift</kbd> <kbd>Return</kbd> starts a new line without sending.
- The box starts one line tall and grows as you write. Past a certain height it
  stops growing and scrolls inside itself, so a long message never pushes the
  conversation off the screen.
- The send button is the up arrow on the right. It is always there, and it is
  greyed out when there is nothing to send, while a file is still uploading, or
  while the Canvas is still connecting.

The wording in the box changes with the place you are in. A Sidekick's
conversation names the Sidekick, as in **Message Incident triage and the team…**.
It is the same box underneath.

> [!NOTE]
> <kbd>Return</kbd> deliberately does nothing in three cases: when the box is
> empty, when a mention list is open (it picks the highlighted person instead),
> and when you are partway through a word in a Japanese, Chinese or Korean input
> method.

### How long can a message be?

Up to 100,000 characters, which is roughly a novella. If you paste in more,
Rally refuses to send and shows **This message is over 100,000 characters,
please shorten it.** under the box. Your text stays in the box, so you can trim
it and try again, or attach the long material as a file instead (see
[Attaching files](03-attaching-files.md)).

## Your draft waits for you

If you are halfway through a message and switch to another Canvas, close the
window or quit Rally, the draft is still there when you come back. That includes
the text, the files you attached and the people you mentioned. Each Canvas and
each Sidekick conversation keeps its own draft.

Some things to know about drafts:

- They are kept on this computer only. A draft does not follow you to another
  Mac or to your phone.
- A draft is thrown away 12 hours after you last changed it.
- If your Mac is out of storage, Rally warns you: **This device is out of room to
  hold attachments, so they will be lost if you quit before sending.** Send the
  message, or free up some space, before you quit.
- If a message fails to send, it goes back into the box rather than vanishing.

## Mentioning people and Rally

Type <kbd>@</kbd> at the start of a line or after a space, and a list pops up.
**Rally** sits at the top. Below it, people are grouped under **Participants**,
**Org members**, and **Guests**, with their email addresses. Guests already in
the conversation appear under **Participants**.

1. Keep typing to narrow the list by name or email. Scroll to see more matches.
2. Use the arrow keys to move through it (it wraps round from the bottom to the
   top) and press <kbd>Return</kbd>, or click a name.
3. The name goes into your message as a highlighted **@Name**.

Press <kbd>Esc</kbd> to close the list without picking anyone.

Mention a teammate when you want them to notice a message. Mention **@Rally**
when you want to be sure Rally answers. In a busy Canvas, Rally decides for
itself which messages are meant for it, and
[People in a Canvas](07-people-in-a-canvas.md#does-rally-answer-every-message)
explains how.

Things that catch people out:

- People under **Org members** or **Guests** cannot open this Canvas yet.
  If you mention them, Rally asks
  whether to add them first. [People in a Canvas](07-people-in-a-canvas.md) has
  the details.
- Only people and Rally can be mentioned here. Your connected tools and your
  Sidekicks are not in the list. You talk to a Sidekick in its own conversation, covered in
  [Talking to a Sidekick](../03-sidekicks/03-the-shared-conversation.md).
- If you edit the middle of an **@Name** after picking it, it turns back into
  plain text and no longer points at that person. Delete it and mention them
  again.

## Slash commands

The message box has four small commands. Type <kbd>/</kbd> into an empty box and
a **Commands** menu appears:

| Command | What it does |
| --- | --- |
| `/participants` | Starts a mention, the same as typing <kbd>@</kbd>. |
| `/attach` | Opens the file picker so you can attach files. |
| `/clear` | Clears the draft. |
| `/stop` | Stops Rally's current run. Only listed while Rally is working. |

Keep typing to narrow the menu, then press <kbd>Return</kbd> or <kbd>Tab</kbd> to
run the first match, or click one. <kbd>Esc</kbd> closes the menu.

These only work when the whole draft is a slash followed by a word. A slash in
the middle of a sentence stays a slash, so "and/or" is safe.

> [!TIP]
> These commands belong to the message box, not to Rally. Rally never sees
> `/clear`. If you want Rally to do something, ask it in words.

## Lists while you type

When you are writing a set of steps or requirements, the box helps you keep the
list tidy.

- Press <kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>8</kbd> to turn the current line, or the
  lines you have selected, into a bulleted list.
- Press <kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>7</kbd> for a numbered list.
- On a list line, <kbd>Shift</kbd> <kbd>Return</kbd> starts the next item, so you
  never type a dash or a number by hand. (Plain <kbd>Return</kbd> still sends.)
- <kbd>Tab</kbd> indents an item and <kbd>Shift</kbd> <kbd>Tab</kbd> moves it back
  out. Lists go up to five levels deep, which is about four more than most
  meetings need.
- <kbd>⌘</kbd> <kbd>Z</kbd> undoes only the last list change.

<kbd>Tab</kbd> indents only when the cursor is in a list. Anywhere else it moves
to the next control, as usual.

## Talking instead of typing

The microphone button sits to the left of the send arrow (its label is **Start
voice input**). Rally writes down what you say as you say it, and the words
appear in the box.

There are two ways to use it:

- Tap: click the microphone once to start, speak, and click it again to stop.
- Hold: press and hold the microphone, speak, and let go when you are done,
  like a walkie-talkie. Rally treats a press of about a third of a second or
  longer as a hold.

If you press the send arrow while you are still talking, Rally stops listening,
finishes writing out the last few words, and then sends. While it is finishing,
the button reads **Finalizing dictation**. If you change your mind, click the
button while it says **Cancel sending**: your words stay in the box but are not
sent.

Things to know about dictation:

- Your spoken words are added after anything you had already typed.
- You cannot type in the box while you are dictating.
- The first time, your Mac asks for permission to use the microphone. If you
  said no, Rally shows **Microphone access is blocked. Allow it in System Settings
  and try again.** Open **System Settings → Privacy & Security → Microphone** and
  turn Rally on.
- If Rally heard nothing, it says so and sends nothing.
- In a Canvas there is no microphone picker. Rally uses the microphone you chose
  last, or your Mac's default. If that one has been unplugged, you see **The
  selected microphone is unavailable.**
- The microphone is available only once Rally is signed in and connected.
- If a lot of people are dictating at once you may see **Too many dictation
  sessions are already active**. Wait a moment and try again.
- Rally does not save your recording. Only the words end up in the message.

## More keys

This page covers the keys you use in the message box. Every other shortcut is
listed in [Keyboard shortcuts](../09-settings-and-shortcuts/05-keyboard-shortcuts.md).

Next, you will give Rally something to read: [Attaching files](03-attaching-files.md).
