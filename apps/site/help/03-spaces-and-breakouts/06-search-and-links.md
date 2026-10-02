---
title: Search and links
description: Find any message, link, artifact or file, and share links that open the right place in Rally.
---

Shelves keep things tidy. Search is how you find something when you have
forgotten which shelf you put it on. Links are how you point someone else at the
exact spot.

## Search your Organization

Press <kbd>⌘</kbd> <kbd>⇧ Shift</kbd> <kbd>F</kbd> from anywhere in the main
window, or click **Search organization** (the magnifying glass) at the top of
the sidebar. A search window opens
over everything else.

Start typing. Results appear after a short pause, with no need to press
anything. Search looks through:

- **Messages** in every Channel and Breakout you can read.
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

- **A message** opens its Channel or Breakout and jumps to that exact message.
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
- **Spaces and Channels by name.** Search looks inside conversations, not at
  their titles. To find a Channel by name, look in the sidebar.
- **Anything, while you are signed out.** The Search button is greyed out and the
  shortcut does nothing until you are signed in.

Results can be up to about 30 seconds old. If you repeat a search straight away,
you may briefly see something that changed a moment ago. Opening it shows the
current state.

When something goes wrong, the search window says **Search could not be
completed. Please try again.** If more results fail to load as you scroll,
click **Retry loading more results**.

## Links to the right place

Every Space, Channel, Breakout and Sidekick has a web link of its own. Send one
to a teammate and it opens Rally at exactly that place.

| To copy a link to | Do this |
| --- | --- |
| A Space | Click **Copy space link** on the Space's page. |
| A Channel | Click the Channel's name in its title pill and choose **Copy link**. |
| A Breakout | Click the Breakout's name in its title pill and choose **Copy link**. |

If the copy fails, Rally says so and you can try again.

The links are ordinary web addresses starting with `https://rallywith.ai/app/`,
which beats a link only the app understands in two ways:

- **They look right in other places.** Paste a Channel link in Slack and it
  unfurls into a small card with the Channel's name and when it was last active.
  While Rally is running in it, waiting for input, or has failed, the card shows
  that too. See [Rally in Slack](../08-rally-everywhere/01-rally-in-slack.md).
- **They work in email and documents**, anywhere a normal link works.

### What happens when someone clicks one

On a Mac with Rally installed, the link opens straight in the app. Otherwise it
opens a short web page that says **Opening this channel in Rally** (or space,
breakout or sidekick) and hands over to the app a moment later. If nothing
happens, click **Open Rally**. If Rally is not installed, the page says to
install it and come back.

On an iPhone, links to Channels and Breakouts open in the Rally app. Links to
Spaces and Sidekicks ask you to use the Mac. See
[Rally on your iPhone](../08-rally-everywhere/06-rally-on-iphone.md).

If you belong to several Organizations and the link is for a different one,
Rally switches to that Organization first.

> [!IMPORTANT]
> A link is an address, not a key. Opening one uses the person's own Rally
> account and permissions, so it grants nothing by itself. A teammate who cannot
> see a private Channel still cannot see it after you send them the link. To let
> them in, add them as a participant or follow
> [Who can see what](04-who-can-see-what.md). For someone outside your
> Organization, see [Sharing with people outside your Organization](05-sharing-with-guests.md).

### For the curious: rallywithai:// links

Behind the scenes, the web page hands over to the app with a link that starts
`rallywithai://`. Sign-in, connecting your tools and accepting invitations use
the same kind of link to bring you back to the right place in the app. You will
rarely see one, and you never need to type one.

Links from the earliest days of Rally began with `avalon://`, Rally's old code
name. They still open, though Rally no longer makes them. Older web links in an
earlier format keep working too, so nothing in your inbox goes stale.

If a link will not open, Rally tells you why in a small window. Every message,
and what to do about it, is in
[When a link won't open](../12-help-and-glossary/01-when-a-link-wont-open.md).
