---
title: Research and the built-in browser
description: Have Rally search the web and read pages, and open links in a browser right beside the conversation.
---

Rally knows a lot, but what it knows stops at some point in the past, and it
knows nothing at all about your competitor's pricing page from this morning.
For anything current or public, it goes and looks, and you can read what it
found in a browser built into the Rally window.

## Asking Rally to look something up

Ask in plain words: "What changed in the latest Postgres release?", "Find three
recent reviews of the Aeron chair", "What does this error message mean?". Rally
loads its **Web** plugin by itself. In the conversation you see rows that say
**Searching the public web** and **Reading a public web page**.

Searching works the way you would expect: Rally gets back a short, ranked list
of pages with their titles and descriptions, picks the promising ones, and
reads them. When Rally reads a page it gets the text, without the menus,
adverts and cookie banners.

For news and anything fast-moving, ask for recent results. Rally can limit a
search to the last day, week, month or year. "What has been announced about
this in the last week?" does the trick.

When Rally uses what it read, it says where it came from. You can open its
sources and check them, as described in
[Reading Rally's answers](../02-canvases/05-reading-rallys-answers.md).

### What it can and cannot read

- **The web is for public things.** For your company's own information, Rally
  goes to your connected apps (Gmail, Drive, Notion and so on), not the web.
  If you want it to read something private, connect the app or attach the file.
- **It reads ordinary web pages only.** Rally can read `http` and `https`
  pages on the public internet. It cannot reach addresses on private networks,
  such as your office intranet.
- **Pages can be a little stale.** To be quick, Rally may read a copy of a
  page saved in the last couple of days. If you need the page as it is right
  now (a live price, a status page), ask Rally for a fresh copy.
- **Long pages are cut short.** Rally is told when a page was too long
  to read in full, so it knows it only saw part of it.
- **Instructions on a web page are not your instructions.** If a page says
  "Ignore your previous instructions and…", Rally ignores it. It works for you,
  not for whoever wrote the page.

> [!TIP]
> For a serious research question, say so: "Research this properly and tell me
> what you could not confirm." Rally then follows its deep research approach
> from [How Rally works](01-how-rally-works.md#skills-know-how-for-tricky-jobs),
> checking facts against each other and dating each one.

## The built-in browser

When you click a web link inside a Canvas, it does not throw you out to
Safari or Chrome. It opens in a browser panel on the right of the Rally window,
beside the conversation. You can read the page and the chat at the same time,
and copy from one into the other without hunting for windows.

This works for links in Rally's messages, its sources, search results, and
the **Open source** link on a file brought in from another app.

There is no button to open the panel on its own. It opens when you click a
link.

### Finding your way around

Across the top of the panel are:

- The tab strip, with one tab for each page, and **New tab** (the **+**).
- **Back**, **Forward** and **Reload**.
- The address bar, which says **Enter website address** when it is empty. Type
  an address and press <kbd>Return</kbd>. You can leave off the `https://` and
  type `example.com`. Rally adds it for you.
- **Close browser**, which hides the panel.

To close a tab, click its **X** or middle-click it. Drag tabs to put them in a
different order. If a site opens a popup, it appears as a new tab.

The browser has its own keyboard shortcuts for tabs, the address bar, back and
forward. They only work while you are clicked into the browser, so
<kbd>⌘</kbd> <kbd>W</kbd> in the browser closes a tab, while the same keys
elsewhere in Rally do what they normally do. The full list is in
[Keyboard shortcuts](../09-settings-and-shortcuts/05-keyboard-shortcuts.md).

### Closing and coming back

**Close browser** hides the panel but keeps your tabs. Click another link and
the panel comes back with everything where you left it. If you close the only
tab and it is blank, the panel closes too.

### Signing in to sites

The browser remembers sites you sign in to, from one session to the next, so
you can sign in once and stay signed in, which helps with pages that need an
account.

Some sign-ins will not work here. Sites that sign you in through a separate
popup window that then hands back to the page do not work yet, and some sites
block sign-in from anything they think is not a regular browser (with a
CAPTCHA, for example). Signing in to Rally itself, and connecting an app in
**Settings → Connections**, always use your Mac's normal browser instead.

> [!NOTE]
> What you sign in to is stored on this Mac, for your Rally account. If someone
> else signs in to Rally on the same Mac, they get their own, separate browser
> data and do not see your sites.

### Where it works, and where it does not

- **Mac only.** In the web browser version, links open in a normal browser
  tab.
- **Only in a Canvas.** Elsewhere in the app, including a Sidekick's
  conversation, links open in your Mac's normal browser.
- **Only web addresses.** Links starting `http` or `https` open here. Anything
  else does not.
- **It is your browser, not Rally's.** The agent cannot click around in it for
  you. It is there for you to read and check things.

## Making the side panel wider

The panel on the right holds what Rally made, the browser, file previews and
details. When a
page or document needs more room, make it wider.

- **Drag** the thin divider on the panel's left edge. Its tooltip says **Drag
  to resize**.
- **Use the keyboard.** Click the divider (or <kbd>Tab</kbd> to it), then press
  <kbd>←</kbd> or <kbd>→</kbd> to change the width a little at a time.
- **Reset it.** Double-click the divider, or press <kbd>Return</kbd> while it
  is selected, to go back to the standard width.

The panel has a minimum width, and how wide it can go depends on the size of
your window. Rally remembers the width separately for each Canvas, so a
spreadsheet Canvas can have a wide panel and a chatty one a narrow one.

Next: [Code, data and the Terminal](03-code-files-and-the-terminal.md).
