---
title: Attaching files
description: Give Rally a PDF, a spreadsheet, a screenshot or a whole folder of things to read.
---

Describing a spreadsheet to Rally is slow, and you will get a column wrong.
Attach the spreadsheet instead. Rally reads what you attach, and so does everyone
else in the Canvas.

## Four ways to attach

1. **The + button.** Click **+** at the left of the message box (its label is
   **Composer actions**) and choose **Attach files**. The file picker lets you
   choose several files at once.
2. **The `/attach` command.** Type `/attach` into an empty box and press
   <kbd>Return</kbd>. The file picker opens. (More on slash commands in
   [The message box](02-the-message-box.md#slash-commands).)
3. **Drag and drop.** Drag files from Finder onto the message box, onto the
   conversation, or onto the panel on the right. The area lights up while a file
   is over it. Selecting a pile of files in a folder and dragging them all at
   once works too.
4. **Paste.** Copy a file or an image and press <kbd>⌘</kbd> <kbd>V</kbd>. You do
   not have to click into the box first. Pasting works anywhere in the Canvas
   as long as you are not typing in some other field or dialog.

## The tiles above the box

Each file you add shows as a small tile above the message box.

- A **progress ring** turns while the file uploads.
- A **retry** button (a circle of arrows) appears if the upload fails. Hover it
  to see what went wrong, and click it to try again.
- The **X** removes the file from the message.
- Click the tile itself to preview the file before you send.

You cannot send while a file is still uploading. Wait for the ring to finish,
then press <kbd>Return</kbd> as usual. Attachments are part of your draft, so
they come back with it if you leave the Canvas and return later (see
[The message box](02-the-message-box.md#your-draft-waits-for-you)).

### Pasted screenshots get a sensible name

When you paste a screenshot, Rally names it after the moment you pasted it, for
example **Pasted image 2026-10-01 at 14.03.22.png**. Paste three in the same
second and the next ones get **(2)** and **(3)** on the end. This saves you from
a message full of files all called "image.png", which is nobody's idea of a good
filing system.

A file you copied from Finder keeps its own name. And if you copy cells from a
spreadsheet, you get the text of those cells in the box, not a picture of them.

## Limits

| Limit | What you see |
| --- | --- |
| Up to 10 files in one message | **You can attach up to 10 files to one message.** |
| Each file 25 MB or smaller | **Files must be 25 MB or smaller.** |
| No empty files | **Empty files cannot be attached.** |
| The same file twice is skipped | **Skipped 1 duplicate attachment.** (or the number skipped) |

Duplicates are judged by the file's contents, not its name, so two different
files called "notes.txt" are both welcome.

## What Rally can read

Rally sorts every file into a kind and reads the ones it understands:

| Kind | Examples |
| --- | --- |
| Text and code | Plain text, Markdown, and code or data files such as .py, .json, .yaml, .html |
| PDF | Including scanned PDFs, where Rally recognises the text on the page |
| Documents | Word, Pages, RTF, OpenDocument text |
| Spreadsheets | Excel, Numbers, CSV, OpenDocument spreadsheets |
| Presentations | PowerPoint, Keynote, OpenDocument presentations |
| Images | PNG, JPEG, GIF, WebP, HEIC and TIFF |

With a file in hand, Rally can read it page by page, search inside it, summarise
it, and answer questions about it. It can look at up to eight images at once.
While a Word file or PDF is being turned into readable text, its preview shows
**Preparing preview...**.

Some things Rally cannot read:

- Sound and video. You can attach a recording and people can play it, but
  Rally cannot listen to it or watch it.
- Locked files, such as password-protected or encrypted PDFs and Office files.
- Damaged files, and file types Rally does not recognise.

> [!NOTE]
> A file can be small enough to attach but too big for Rally to read. Rally turns
> PDFs and Office files into text only when the file is 8 MB or less, and PDFs
> only up to 200 pages. Images can be up to 20 MB each. For a big file,
> attach the part you care about, or split it up.

When a file is long, Rally reads it in pieces. If it only managed part of it,
it is meant to say so rather than pretend it read the lot. And if Rally could not
open a file at all, it will not state facts from it.

> [!TIP]
> Rally treats what is inside your files as material to read, not as orders to
> follow. A document that says "ignore your instructions" gets read, not obeyed.

## Rally always answers a message with a file

In a Canvas full of people, Rally sometimes stays quiet and lets the humans talk
(see [People in the room](07-people-in-a-canvas.md)). A message with an
attachment is different. Rally always responds to it, on the reasonable guess
that you did not attach a contract for decoration.

## Things to ask

- "Here's last quarter's sales sheet. Which three products grew fastest?"
- "Summarise this contract and list anything about termination."
- "What's wrong in this screenshot? The button should be blue."
- "Compare these two PDFs and tell me what changed."

## Files that stay with the Canvas

An attachment belongs to the message you sent it with. If you want a file to be
part of the Canvas itself, where Rally and your teammates can always find it,
add it as a resource. That is covered in
[Resources: things you bring in](../06-things-rally-makes/04-resources.md).

Next: what happens after you press send, in [While Rally works](04-while-rally-works.md).
