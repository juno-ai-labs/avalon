---
title: Opening, docking and downloading
description: Preview any file, keep an artifact open beside the chat, pop it into its own window, or save it to your Mac.
---

Rally gives you four ways to look at a file, depending on how long you want to look at it. A quick glance gets the preview. Reading while you talk gets the docked sidebar. Keeping it in view all afternoon gets its own window. Taking it somewhere else gets a download.

## The preview

Click any file in the conversation, whether it is a picture you attached, a file card Rally posted, or a tile in a message, and Rally opens a large preview over the window. You can look at it without downloading anything or leaving the Canvas.

What you see depends on the kind of file:

| Kind of file | How it shows |
| --- | --- |
| Images, video and audio | Shown or played directly |
| Markdown documents | Formatted, with headings, lists and tables |
| Plain text and code | Monospaced text |
| Word, PDF and similar | Readable text that Rally extracted from the file |
| Web pages saved as HTML files | A locked-down page with no scripts and nothing loaded from the internet |

Audio and video are only fetched when you open them, so a Canvas full of recordings does not slow down.

If Rally cannot show a file, the preview says **This resource has no preview available.** You can still download it.

To close the preview, press <kbd>Esc</kbd>, click the **X** (**Close preview**), or click the dark area around it.

### Buttons in the preview

For documents and other files, the buttons sit in the header:

- **Resource details** (when available) opens the file's details, with its title, versions and other actions.
- **Download** followed by the file's name saves it to your Mac.
- **Close preview** closes it.

For images and video, the buttons sit in the corner: **Download attachment**, **Resource details**, **Close preview**, and a zoom button that switches between **Show preview at full size** and **Fit preview to window**.

### Flipping through a set of pictures

When a message has several pictures, the preview becomes a small gallery. Press <kbd>←</kbd> and <kbd>→</kbd> or click the **Previous attachment** and **Next attachment** arrows to move between them. The gallery wraps around, so going past the last one brings you back to the first. A strip of thumbnails runs along the bottom, and a caption such as **photo.png · 2 / 5** tells you where you are.

A few details:

- The arrows appear only when there is more than one item.
- The arrow keys do nothing while you are typing in a text field or have a video or audio player selected, so they do not fight with scrubbing through a clip.
- The gallery is for the pictures in one message. The document preview has no arrows.

### Reduce Transparency

The preview normally lays a see-through, slightly blurred wash over the window behind it. If you have turned on **Reduce transparency** in your Mac's **System Settings → Accessibility → Display**, Rally respects it: the wash becomes solid and the blur goes away. There is no separate setting in Rally for this.

## Opening an artifact

Click an artifact's card in the conversation, or in the panel on the right, and it opens with its title in the header and a row of buttons beside it:

- **Open in a righthand sidebar** docks it beside the conversation (below).
- **Open in a new window** gives it a window of its own (further below).
- **Versions** shows its history, as described in [Artifacts](01-artifacts.md#versions).
- **Archive** removes it from the Canvas. See [Resources: things you bring in](04-resources.md#archiving-a-resource) before you click it.
- **Close resource preview** closes it.

## Docking an artifact beside the conversation

Sometimes you want to read a document and talk about it at the same time: "the second paragraph is too long", "swap sections three and four". The artifact sidebar keeps one artifact open on the right of the Canvas while you carry on in the conversation. It is where Rally opens what it makes, so most of the time it is already open.

1. Open the artifact.
2. Click **Open in a righthand sidebar** in its header.

The artifact moves into a panel on the right, with only its title and a **Close sidebar** button above it. Drag the panel's left edge to make it wider or narrower. To close it, click **Close sidebar** or click the dimmed area.

This is the best way to give notes on a draft. You point at the paragraph, Rally fixes the paragraph, and nobody has to scroll up forty messages to find out which paragraph you meant.

Good to know:

- Rally remembers which artifact you had docked in each Canvas, on this device, and brings it back the next time you open Rally.
- The button is greyed out for files Rally cannot show, and for sites when the live view of sites is not available to you (see [Live sites](03-live-sites.md)).
- If you open a web link while an artifact is docked, Rally's built-in browser covers the panel. Close the browser and the artifact is back. The browser itself is covered in [Research and the built-in browser](../04-working-with-rally/02-research-and-the-web.md).
- The docked sidebar works in the Mac app and in the web browser version.

## Giving an artifact its own window

For a reference document you want in view all day, or a dashboard on a second monitor, pop the artifact out into a window you can move and resize like any other.

1. Open the artifact.
2. Click **Open in a new window** in its header.

What the window shows:

- Images, audio and video play.
- Everything else shows as read-only text.
- Live sites show the live page. Sites have their own **Open in a new window** button, covered in [Live sites](03-live-sites.md).

The window stays up to date. If Rally publishes a newer version while the window is open, the window switches to it.

Windows you leave open come back when you quit and reopen Rally, on the same monitor if it is still connected, or on one you can see if it is not. Switching to another Organization closes them and brings them back when you switch back. Signing out closes them and forgets them.

If the window cannot open, Rally says **The artifact couldn't be opened in a new window.**

In the web browser version of Rally, this button opens a new browser tab or window instead, and its position is not remembered.

## Download the original file

To save a file to your Mac as the original file:

- On a file card in a message, click the download arrow on the right of the card.
- In the preview, click the download arrow in the header or corner (**Download** followed by the file's name, or **Download attachment**).

A download is the stored file exactly as it is. A Markdown document downloads as a `.md` file, which opens in any text editor and in many writing apps.

There is no button that converts a document to Word or PDF. If you need another format, ask Rally in the Canvas, for example "make a Word version of that brief". It can produce a new file when its private computer is available, which is not guaranteed at every moment. To save one of Rally's replies (rather than a file) as a PDF or image, see [Saving and sharing what Rally wrote](05-saving-and-exporting.md).

Some things to watch for:

- A file that is still uploading or still arriving has no download button yet.
- Files you have attached but not sent yet have no download button. They are already on your Mac.
- If a download fails, Rally says **Download failed. Please try again.**

Next: when the thing Rally makes is a whole website, in [Live sites](03-live-sites.md).
