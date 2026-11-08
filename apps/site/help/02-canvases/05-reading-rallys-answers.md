---
title: Reading Rally's answers
description: Formatted answers, sources, diagrams and the actions under each message.
---

Rally's answers come with headings, tables, links to their sources and, when it
helps, a diagram. This page shows how to check where an answer came from and how
to take it somewhere else.

## How Rally writes

Rally writes its answers in Markdown, a simple way of marking up text that Rally
then shows as proper formatting. You will see:

- Headings, **bold**, *italics* and ~~strikethrough~~.
- Bulleted, numbered and checkbox lists.
- Quotes, footnotes and links.
- Tables. A wide table scrolls sideways rather than squashing its columns.
- Code, in a shaded block with the language named at the top and colours to
  make it readable.

Rally avoids the special notation mathematicians use for formulas. It writes
symbols such as →, × and ≤ instead, so its answers read the same in the app, in
emails and in Slack. When it refers to a teammate, it writes **@Name** as a link
to that person.

The same formatting works in messages you and your teammates write. Your own
messages also keep your line breaks exactly as you typed them. A long message
from you is folded with **Show more**, and **Show less** folds it back.

Web links open in your normal web browser, and show the website's little icon
beside them so you can see where you are headed.

### Copying code

Hover a code block and click the copy icon in its top-right corner (**Copy
code**). It changes to **Code copied** to say it worked.

## Diagrams

Ask Rally to draw how something works ("show me our sign-up flow as a
diagram") and it can answer with a flowchart, a sequence diagram or another kind
of chart, drawn in your theme's colours. Rally writes these in a diagram
language called Mermaid, and the app draws them for you.

- While Rally is still writing, you see the diagram's source text. The picture
  appears when the answer is finished.
- A diagram that Rally got wrong, or that tries to load pictures or links from
  the internet, is shown as source text instead.
- Diagrams are pictures to look at. You cannot click things inside them.
- To keep the source, use the copy button on its code block.

## Folding long answers

A long report is easier to skim when you can fold away the parts you have read.
Every heading in Rally's answer (below the top-level title) has a small chevron
beside it.

Click the chevron (**Collapse section**) or the heading itself to fold that
section down to a faded three-line peek. Click the chevron or the faded peek
to open it again.

Sections always start open. A smaller heading belongs to the section above it,
so it folds along with it rather than on its own. Folding only changes what you
see: copying and reading aloud always use the whole answer.

Folding works in the conversation only. What Rally made, in the panel on the right,
and answers you save as an image or PDF, always show everything.

## Where did that come from?

Rally marks the sources it relied on, so you can check its work with one click.

- Source pills. A small round pill with a website's icon, after a sentence,
  is a link to the page Rally read. Hover it to see the source's name and
  something like **example.com · Opens in your browser**. Click to open it.
- Footnote pills. A numbered pill opens a small pop-up that links to a file
  or a web page.
- File chips. A phrase can link straight to a file in the Canvas. Click it
  to open the file.
- File cards. When Rally announces something new it made, such as a
  document, spreadsheet, image or site, it shows a card on its own line with an
  icon, a title and the kind of thing it is. Images appear as thumbnails, and
  several in a row make a little gallery. Audio and video open as players.

Rally only cites things it used. If a claim has no citation, that
means nothing in the run backed it up, so treat it as Rally's own reasoning and
check it if it matters.

If a citation points at a file you are not allowed to open, you see plain text
with no link. A citation never reveals that something exists if you cannot see
it.

The things Rally makes are called artifacts, and they get a whole chapter:
[Artifacts](../06-things-rally-makes/01-artifacts.md).

## Actions under a message

Hover over one of Rally's finished answers and a row of actions appears under
it:

| Action | What it does |
| --- | --- |
| **Oopsie** | Tells the Rally team something went wrong with this answer. A short form asks **What happened, and what did you expect?**, and **Send** sends it with a reference to the message. |
| **Copy** | Copies the whole answer, exactly as Rally wrote it, in Markdown. |
| **Speak** | Reads the answer aloud. The button changes to **Stop speaking**. |
| **Image** | Saves the answer as a picture. |
| **PDF** | Saves the answer as a PDF. |

The actions stay hidden while Rally is still writing. **Image** and **PDF** are
in the Mac app only, not in the web browser version. What they produce, and
how to share it, is in
[Saving and sharing what Rally wrote](../06-things-rally-makes/05-saving-and-exporting.md).
If a save fails, the button says **Image failed** or **PDF failed**.


## The right-click menu

Right-click any message, yours, a teammate's or Rally's, for:

- **Copy** copies the text with its formatting, ready to paste into an email
  or a document. If you selected part of the message first, only that part is
  copied.
- **Copy as markdown** copies the plain Markdown, which is what you want for
  pasting into GitHub, Notion or another app that understands Markdown.
- **Speak** reads the message aloud (**Stop speaking** ends it).
- **Look Up** shows your Mac's dictionary entry for the word you selected. It is
  greyed out until you select something.
- **Share** hands the text to your Mac's Share menu, for Messages, Mail, Notes
  and the like.

**Speak** is hidden while a message is still being written.

Right-click a cited file or a file attached to a message and you may get a menu
with actions for that file instead.

## Reading aloud

**Speak** reads a finished message out loud with a computer-generated voice.
It starts almost at once, and reads long messages in pieces without a pause
between them. It reads the whole message, including any sections you folded.

Only one message plays at a time: start another and the first stops. There is
one voice and no setting to change it. If speaking fails, the button quietly
goes back to **Speak**, so try again.

Next: point at exactly what you mean, in [Comments](06-comments.md).
