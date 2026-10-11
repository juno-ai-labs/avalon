---
title: Bring in a conversation from Claude or ChatGPT
description: Turn a conversation you had elsewhere into a Rally Thread, and pull in its new messages later.
nav_title: Import from Claude or ChatGPT
---

Plenty of good work starts in a chat with Claude or ChatGPT. When that work
turns into something your team should share, you can bring the whole
conversation into Rally as a new Thread. Your teammates can read the history,
Rally can build on it, and nobody has to paste forty screens of chat into a
message.

## Importing a conversation

You need the Rally app on your Mac for this, and at least one Channel you are
allowed to add Threads to.

1. Click **Import a conversation** (a cloud with a down arrow) at the top of
   the sidebar's list.
2. A browser window opens, titled **Import a conversation**. It lists four
   steps. Click **claude.ai** or **chatgpt.com** to go there.
3. Log in to your Claude or ChatGPT account in that window.
4. Open the chat you want to bring in. A shared link to a chat works too.
5. Click **Import**.
6. The **Import thread** window asks which **Channel** the new Thread goes in, and for a **Name of thread**.
   The name starts as the chat's own title, and you can change it (up to 180
   characters).
7. Click **Import**. Rally reads the conversation in the window. A box titled
   **Importing conversation** covers the page, which shows blurred behind it,
   and lists what Rally is doing, a step at a time. The page is locked while
   Rally reads it, so nothing you click can get in its way. A long chat with
   many files can take a few minutes. When it is done, the new Thread opens and
   the import window closes.

The Thread appears in your **Threads** list as soon as the import starts, but it
opens only once the import has finished. To stop an import, click **Cancel** in
the box; the half-made Thread is removed from your list. If you close the import
window instead, the half-made Thread is removed once Rally notices the import
has stopped.

The **Import** button stays greyed out until you are looking at an actual
conversation. Hover it and it says **Open a Claude or ChatGPT chat to import
it**.

If the window says **There is no Channel to import into. Create one in Rally
first.**, make a Channel you can add to (see
[Channels](../03-spaces-and-breakouts/01-spaces.md)) and try again.

### What comes across

- The conversation itself: what you wrote and what the assistant replied, in
  order. Your side shows as the Claude or ChatGPT user, with a small cloud icon
  that says who imported it.
- Attached files are copied into Rally, up to 25 MB each. A bigger file is
  left behind and listed as unavailable.
- Not the behind-the-scenes steps, such as the assistant's thinking or the
  tools it used. Only what you could see in the chat comes across.
- A file Rally found but could not copy is listed in the Thread as
  unavailable, with the reason, so you know it is missing.

There is no preview before importing, so open the right chat before you click.

> [!TIP]
> Shared links on claude.ai do not include attachments. If the chat had files you
> need, open your own copy of the conversation rather than a shared link.

Rally treats the imported conversation as background: something it has read, not
something it said. It does not start working on anything when the import
finishes. Ask it for something when you are ready.

## Pulling in new messages later

Conversations have a habit of carrying on. If you keep chatting in Claude or
ChatGPT after importing, you can bring the new messages into the same Thread
instead of importing a second copy.

1. Open the imported Thread's main conversation (not a Breakout).
2. Click the Thread's name in its title pill, choose **More**, then **Import
   updates**.
3. The **Import source updates** window says Rally will read the conversation
   again in its browser. Click **Import updates**. The import window opens on
   the original conversation.
4. Click **Import updates** in the import window. Rally reads the conversation
   again, the same way as the first time.

When it finishes, the window closes and any new messages appear in the Thread.
There is no summary. If nothing had changed, nothing is added.

### How updates work

- Only from the same conversation. Rally remembers exactly which conversation
  the Thread came from and rereads that one. There is no way to point it at a
  different chat. To bring in another conversation, import it as a new Thread.
- Through Rally's browser, with your sign-in. Rally reads the conversation in
  the import window, so if the site asks you to sign in again you can do it
  right there. Sign in to Claude or ChatGPT once in Rally's browser and updates
  work from then on. Shared links need no sign-in. (More on the browser in
  [Research and the built-in browser](../04-working-with-rally/02-research-and-the-web.md).)
- New messages go at the end. They land after anything you and your
  teammates have written in Rally since the import. Nothing already in the
  Thread is moved, changed or removed. New attachments are copied in, with the
  same 25 MB limit.
- Changed messages are added, not replaced. If a message you imported has
  changed since (for example, a reply that was still being written when you
  imported), the new version arrives as a fresh message labelled **Updated
  source message**. The old one stays where it was, so you can see both.
- It does not wake Rally. The new messages are history. Rally reads them the
  next time it works in the Thread.
- Only when you ask. Rally never checks for updates by itself.

> [!NOTE]
> Only the person who imported the Thread sees **Import updates**. Everyone else
> can read and add to the Thread as usual. Threads imported by older versions
> of Rally, including from Claude Code files on your Mac, can still be read but
> cannot be updated.

### When an import will not go through

If Rally cannot finish, the import window stays open with a message at the top.
Fix the cause and click **Import** (or **Import updates**) again. Trying again
never adds the same messages twice.

| Message | What to do |
| --- | --- |
| Sign in to the conversation’s site in this window, then import again. | Sign in to Claude or ChatGPT in the import window, then click again. |
| This tab does not show a conversation. Open one, then import again. | Open the chat itself, not the home page or a list of chats. |
| The conversation’s page would not load. Reload it, then import again. | Reload the page in the window and try again. |
| The import did not finish. Try again, or cancel. | Click again. Rally starts reading from the beginning. |
| The conversation was imported, but Rally could not open it. Find it in your Threads. | The import worked. Open the new Thread from your **Threads** list. |
| The source removed or reordered earlier messages. Import this branch into a new thread | See below. |

### Why Rally refuses a branched conversation

In Claude and ChatGPT you can go
back and edit an earlier message, which starts a new branch of the
conversation, or delete messages. Rally only ever adds to the end of a Thread,
so it cannot fit a rewritten history in without making a muddle. Rather than
guess, it refuses. To keep the new branch, import it as a new Thread with
**Import Thread from Claude or ChatGPT**.

Rally reads Claude and ChatGPT through their ordinary web pages, the same ones
you see, working out each page as it goes. If one of those services asks for a
CAPTCHA or changes its sign-in rules, importing can stop until you get past it
in the window.
For a Claude conversation where you edited or regenerated a reply, Rally reads
the version you currently have on screen.

Next chapter: keeping a lot of Threads in order, in
[Channels, Breakouts and keeping things tidy](../03-spaces-and-breakouts/index.md).
