---
title: Bring in a conversation from Claude or ChatGPT
description: Turn a conversation you had elsewhere into a Rally Channel, and pull in its new messages later.
nav_title: Import from Claude or ChatGPT
---

Plenty of good work starts in a chat with Claude or ChatGPT. When that work
turns into something your team should share, you can bring the whole
conversation into Rally as a new Channel. Your teammates can read the history,
Rally can build on it, and nobody has to paste forty screens of chat into a
message.

## Importing a conversation

You need the Rally app on your Mac for this, and at least one Space you are
allowed to add Channels to.

1. Click **Import from ChatGPT or Claude** (a cloud with a down arrow) at the
   top of the sidebar. Or right-click an empty part of the Channel list and
   choose **Import Channel from Claude or ChatGPT**. If you have a Space's pill
   selected, the new Channel goes in that Space.
2. A browser window opens, titled **Import a conversation**. It lists four
   steps. Click **claude.ai** or **chatgpt.com** to go there.
3. Log in to your Claude or ChatGPT account in that window.
4. Open the chat you want to bring in. A shared link to a chat works too.
5. Click **Import**.
6. The **Import channel** window asks for a **Space** and a **Name of channel**.
   The name starts as the chat's own title, and you can change it (up to 180
   characters).
7. Click **Import**. The new Channel opens and the import window closes.

The **Import** button stays greyed out until you are looking at an actual
conversation. Hover it and it says **Open a Claude or ChatGPT chat to import
it**.

If the window says **There is no Space to import into. Create one in Rally
first.**, make a Space you can add to (see
[Spaces](../03-spaces-and-breakouts/01-spaces.md)) and try again.

### What comes across

- The conversation itself: what you wrote and what the assistant replied, in
  order. Your side shows as the Claude or ChatGPT user, with a small cloud icon
  that says who imported it.
- Attached files are copied into Rally, up to 25 MB each. A bigger file is
  left behind and listed as unavailable.
- Not the behind-the-scenes steps, such as the assistant's thinking or the
  tools it used. Only what you could see in the chat comes across.

There is no preview before importing, so open the right chat before you click.

> [!TIP]
> Shared links on claude.ai do not include attachments. If the chat had files you
> need, open your own copy of the conversation rather than a shared link.

Rally treats the imported conversation as background: something it has read, not
something it said. It does not start working on anything when the import
finishes. Ask it for something when you are ready.

## Pulling in new messages later

Conversations have a habit of carrying on. If you keep chatting in Claude or
ChatGPT after importing, you can bring the new messages into the same Channel
instead of importing a second copy.

1. Open the imported Channel's main conversation (not a Breakout).
2. Click the Channel's name in its title pill, choose **More**, then **Import
   updates**.
3. The **Import source updates** window says Rally will read the conversation
   again through its browser and add its updates to this Channel. Click
   **Import updates**. It says **Importing…** while it works.

When it finishes, the window closes and any new messages appear in the Channel.
There is no summary. If nothing had changed, nothing is added.

### How updates work

- Only from the same conversation. Rally remembers exactly which conversation
  the Channel came from and rereads that one. There is no way to point it at a
  different chat. To bring in another conversation, import it as a new Channel.
- Through Rally's browser, with your sign-in. Rally reads the conversation in
  its own built-in browser. If you already have it open in a tab, Rally reads
  that tab. If not, it opens the link in the background, reads it and closes it
  again. Sign in to Claude or ChatGPT once in Rally's browser and updates work
  from then on. Shared links need no sign-in. (More on the browser in
  [Research and the built-in browser](../04-working-with-rally/02-research-and-the-web.md).)
- New messages go at the end. They land after anything you and your
  teammates have written in Rally since the import. Nothing already in the
  Channel is moved, changed or removed. New attachments are copied in, with the
  same 25 MB limit.
- Changed messages are added, not replaced. If a message you imported has
  changed since (for example, a reply that was still being written when you
  imported), the new version arrives as a fresh message labelled **Updated
  source message**. The old one stays where it was, so you can see both.
- It does not wake Rally. The new messages are history. Rally reads them the
  next time it works in the Channel.
- Only when you ask. Rally never checks for updates by itself.

> [!NOTE]
> Only the person who imported the Channel sees **Import updates**. Everyone else
> can read and add to the Channel as usual. Channels imported by older versions
> of Rally, including from Claude Code files on your Mac, can still be read but
> cannot be updated.

### When an update will not go through

If something goes wrong, the window stays open with a message in red. Fix the
cause and click **Import updates** again. Trying again never adds the same
messages twice.

| Message | What to do |
| --- | --- |
| Sign in to Claude and open this conversation, then try again. (or the same for ChatGPT) | Sign in to that service in Rally's browser, then click again. |
| The source removed or reordered earlier messages. Import this branch into a new channel | See below. |
| The source must match the conversation originally imported into this channel. | Rally found a different conversation. Updates only come from the original one. |
| The source was updated concurrently; retry the import | Click **Import updates** again. |
| The conversation could not be read. Reload the page and try again. | Reload the conversation in Rally's browser and try again. |

### Why Rally refuses a branched conversation

In Claude and ChatGPT you can go
back and edit an earlier message, which starts a new branch of the
conversation, or delete messages. Rally only ever adds to the end of a Channel,
so it cannot fit a rewritten history in without making a muddle. Rather than
guess, it refuses. To keep the new branch, import it as a new Channel with
**Import Channel from Claude or ChatGPT**.

Rally reads Claude and ChatGPT through their ordinary web pages, the same ones
you see. If one of those services changes its website, asks for a CAPTCHA or
changes its sign-in rules, importing can stop working until Rally catches up.
For a Claude conversation where you edited or regenerated a reply, Rally reads
the version you currently have on screen.

Next chapter: keeping a lot of Channels in order, in
[Spaces, Breakouts and keeping things tidy](../03-spaces-and-breakouts/index.md).
