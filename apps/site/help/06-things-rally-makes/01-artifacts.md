---
title: Artifacts
description: Rally writes documents, images and other files as artifacts that live in a Canvas and keep every version.
---

An artifact is a file Rally made for you in a Canvas. Most of the time it is a document, but pictures, voice recordings, zip archives and small websites all arrive the same way. Here is how Rally decides to make one, and what happens to it afterwards.

## When Rally writes a document instead of a reply

Some requests are requests for a document: a product brief, a contract, a memo, a report, a plan, a spec, a blog post, a press release. For those, Rally does not paste a wall of text into the conversation. It writes the document as a file, publishes it to the Canvas, opens it in the panel on the right, and posts a small card in the chat with the title and a line inviting you to ask for changes. It does not repeat the whole document in the chat as well, so the conversation stays readable.

Try something like:

- "Write a one-page brief for the new onboarding flow."
- "Draft a press release for the spring launch."
- "Turn our discussion above into a project plan."

Click the card to open the document. [Opening, docking and downloading](02-opening-and-downloading.md) covers everything you can do once it is open.

### Choosing for yourself

Rally guesses from what you asked, and you can overrule the guess either way.

- Say **"make that a document"** and Rally makes a file, however short the thing is.
- Say **"answer in chat"** and Rally keeps the text in the conversation.

### What kind of file you get

Documents are written in Markdown, a plain-text format with headings, lists, tables and links that Rally shows nicely formatted. A document is not a Word file. If you need Word or another format, ask Rally for it in the Canvas, and see [Opening, docking and downloading](02-opening-and-downloading.md#download-the-original-file) for what to expect.

Rally can also make other kinds of files: pictures and voice recordings (see [Pictures and voices](../04-working-with-rally/04-pictures-and-voices.md)), spreadsheets and data from its own computer (see [Code, data and the Terminal](../04-working-with-rally/03-code-files-and-the-terminal.md)), and whole websites, which have their own page: [Live sites](03-live-sites.md).

> [!NOTE]
> Rally makes files on its private computer, the Terminal. If that computer cannot be reached at the moment, Rally tells you it could not create the file and gives you the content in the chat instead, so nothing is lost. Ask again later if you still want the file.

## Asking for changes

To revise an artifact, say what you want changed, in the same Canvas, or point at the part you mean with a [comment](../02-canvases/06-comments.md): "make the tone warmer", "add a section on pricing", "cut it to half a page". Rally publishes a new version of the same file. The title stays the same, the card in the conversation still points at it, and the old wording is kept as an earlier version.

A request for something new makes a new artifact. "Write a second brief for the mobile app" gives you a second file in the same Canvas rather than overwriting the first. If the new thing is really a separate piece of work, start a new Canvas for it.

> [!TIP]
> Rally never renames a document it has published. If you want a different title, ask for a new document with that title.

## Everything in a Canvas

Everything Rally has made in a Canvas shows as cards in the panel on the right. Click a card to open that artifact. A Canvas with one artifact opens straight on it; a brand-new Canvas has no panel at all until Rally makes something. Rally does not label an empty shelf.

Things brought into the Canvas from outside are the subject of [Resources: things you bring in](04-resources.md).

## Versions

Every time an artifact changes, Rally keeps the version before it. You can open any earlier version and read it, which is handy for rescuing a sentence you liked or checking exactly what changed.

To see an artifact's history:

1. Open the artifact.
2. Click the clock icon labelled **Versions** in its header.
3. Pick a version from the list.

The list runs newest first. Each row shows the version number, such as **V4**, and who made it: **Rally**, a teammate's name, or the name of the connected tool the change came from. A version with no recorded author says **Unattributed**. The newest one carries a **Current** badge and cannot be picked, because you are already looking at it.

Versions are grouped under broad date headings: today, yesterday, this week, last week, this month, last month, and then a month and year such as Aug 2025. Weeks start on Sunday.

When you open an older version, a banner reads **Version 2 · not current** (with the right number). Older versions are read-only. Click **Return to current** to go back to the latest one.

### Versions you cannot open

- Text, Markdown, image and audio versions open. PDF and Word versions are listed but greyed out, because earlier copies are kept as the original file and Rally cannot show them here.
- Sites keep versions too, but this list does not preview an old site.
- A resource that never changes, such as an email a Sidekick run started from, shows **No versions yet.**

While the list loads you see **Loading versions…**. If it cannot load, you see **Resource history couldn't be loaded.** Close the list and try again.

Next: everything you can do with an artifact once it is open, in [Opening, docking and downloading](02-opening-and-downloading.md).
