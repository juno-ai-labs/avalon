---
title: Search and links
description: Find any message, link, artifact or file, and share links that open the right place in Rally.
---

Pins keep things close. Search is how you find something when you have
forgotten where you left it. Links are how you point someone else at the
exact spot.

## Search your Organization

Press <kbd>⌘</kbd> <kbd>⇧ Shift</kbd> <kbd>F</kbd> from anywhere in the main
window, or click **Search organization** (the magnifying glass) at the top of
the sidebar's list. A search window opens
over everything else.

Start typing. Results appear after a short pause, with no need to press
anything. Search looks through:

- **Messages** in every Canvas and Sidekick conversation you can read.
- **Links** that people and Rally have shared in conversations.
- **Artifacts**, the documents and files Rally has made.
- **Files** that people have attached or brought in.

For artifacts and files, it matches their names and descriptions, and also the
readable text inside documents. That is how you find "the contract that mentions
the break clause" when nobody remembers what the file was called.

The tabs along the top, **All**, **Messages**, **Links**, **Artifacts** and
**Files**, narrow the results to one kind. More results load as you scroll down.

### Opening a result

Click a result, or move to it and press <kbd>Return</kbd>.

- **A message** opens its Canvas or Sidekick and jumps to that exact message.
- **A link** opens in your web browser.
- **An artifact or a file** opens in a preview. See
  [Opening, docking and downloading](../06-things-rally-makes/02-opening-and-downloading.md).

Press <kbd>Esc</kbd> to close the search window without opening anything.

| Key | What it does |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move through the results |
| <kbd>Return</kbd> | Open the highlighted result |
| <kbd>⌘</kbd> <kbd>1</kbd> to <kbd>⌘</kbd> <kbd>9</kbd> | Open the first to ninth result directly |
| <kbd>←</kbd> <kbd>→</kbd> | Switch tabs, when a tab is selected |
| <kbd>Esc</kbd> | Close search |

Every shortcut in Rally is collected in
[Keyboard shortcuts](../09-settings-and-shortcuts/05-keyboard-shortcuts.md).

### What search will not find

- **Things you cannot read.** Search only shows results from conversations you
  have access to, and checks again when you open one.
- **Canvases and Sidekicks by name.** This search looks inside conversations,
  not at their titles. To find a Canvas or a Sidekick by name, use the search
  box on the Canvases or Sidekicks home page.
- **Anything, while you are signed out.** The Search button is greyed out and the
  shortcut does nothing until you are signed in.

Results can be up to about 30 seconds old. If you repeat a search straight away,
you may briefly see something that changed a moment ago. Opening it shows the
current state.

When something goes wrong, the search window says **Search could not be
completed. Please try again.** If more results fail to load as you scroll,
click **Retry loading more results**.

## Links to the right place

Every Canvas and Sidekick has a web link of its own. Send one
to a teammate and it opens Rally at exactly that place.

| To copy a link to | Do this |
| --- | --- |
| A Canvas | Click the Canvas's name in its header pill and choose **Copy link**. |
| A Sidekick | Open the Sidekick, click **…** and choose **Copy sidekick link**. |

If the copy fails, Rally says so and you can try again.

The links are ordinary web addresses starting with `https://rallywith.ai/app/`,
which beats a link only the app understands in two ways:

- **They work in email, Slack and documents**, anywhere a normal link works.
- **They survive being forwarded.** Whoever opens one signs in as themselves,
  so the link shows each person only what they are allowed to see.

### What happens when someone clicks one

On a Mac with Rally installed, the link opens straight in the app. Otherwise it
opens a short web page that says it is opening Rally and hands over to the app a moment later. If nothing
happens, click **Open Rally**. If Rally is not installed, the page says to
install it and come back.

If you belong to several Organizations and the link is for a different one,
Rally switches to that Organization first.

> [!IMPORTANT]
> A link is an address, not a key. Opening one uses the person's own Rally
> account and permissions, so it grants nothing by itself. A teammate who cannot
> open a Canvas still cannot open it after you send them the link. To let
> them in, add them as a participant, as
> [Who can see what](08-who-can-see-what.md) explains. For someone outside your
> Organization, see [Sharing with people outside your Organization](09-sharing-with-guests.md).

### For the curious: rallywithai:// links

Behind the scenes, the web page hands over to the app with a link that starts
`rallywithai://`. Sign-in, connecting your tools and accepting invitations use
the same kind of link to bring you back to the right place in the app. You will
rarely see one, and you never need to type one.

Links from the earliest days of Rally began with `avalon://`, Rally's old code
name. They still open, though Rally no longer makes them. Links to Channels, Threads and
Breakouts, the conversations Rally had before Canvases, no longer open, because
those conversations are gone.

If a link will not open, Rally tells you why in a small window. Every message,
and what to do about it, is in
[When a link won't open](../12-help-and-glossary/01-when-a-link-wont-open.md).
