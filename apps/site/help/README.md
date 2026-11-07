# Writing the Rally manual

This folder is the help center at [rallywith.ai/help](https://rallywith.ai/help/).
Every page is a Markdown file. The build turns the folder into the website, a
Markdown copy of every page, `/help/llms.txt`, and a search index. This README is
not published.

## Folder layout

```
help/
  index.md                       -> /help/            (the cover and contents)
  01-getting-started/
    index.md                     -> /help/getting-started/          (chapter opener)
    01-install-rally.md          -> /help/getting-started/install-rally/
    05-your-first-canvas.md      -> /help/getting-started/your-first-canvas/
    images/first-canvas.png      (only published if a page uses it)
  02-canvases/
    ...
```

- A **chapter** is a folder named `NN-slug`. It must have an `index.md`, which
  is the chapter's opening page.
- A **page** is a file named `NN-slug.md` inside a chapter. Chapters are one
  level deep: no pages in subfolders.
- The number only sets the order and never shows up in a URL. Readers see
  chapters counted 1, 2, 3 and pages as 3.1, 3.2, whatever the folder numbers
  are, so leave gaps (`10-`, `20-`) if you expect to slot things in.
- Renaming a file changes its URL. Do it only when you mean it, and add a 301
  for the old address (and its `.md` copy) to `apps/site/public/_redirects` in
  the same change, because old links live on in emails, Slack and search.

## Front matter

Every file starts with this:

```markdown
---
title: Invite your team
description: Bring people into your Organization and decide what they can see.
---
```

| Key | Required | What it does |
| --- | --- | --- |
| `title` | yes | The page heading, the tab title, and the link text everywhere. |
| `description` | yes | The line under the title, the search snippet, and the summary in `llms.txt`. One sentence. |
| `nav_title` | no | A shorter label for the sidebar when the title is long. |
| `draft` | no | `true` keeps the page out of the build. It still shows, marked Draft, in `pnpm dev:site`. |

Any other key fails the build, so a typo cannot quietly do nothing.

## Markdown

Everything GitHub renders works here: tables, task lists, footnotes,
strikethrough, autolinks, fenced code with a language, `<details>`, `<kbd>`,
and alerts:

```markdown
> [!TIP]
> Press <kbd>⌘</kbd> <kbd>K</kbd> to search.
```

The alert kinds are `NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION`.

- **Don't write the title as an `#` heading.** The front matter title is the
  page's heading. Start sections at `##`. The right-hand outline lists every
  `#`, `##` and `###`.
- **Link to other pages by their file**, relatively, the way GitHub would:
  `[Sidekicks](../03-sidekicks/index.md)` or `[schedules](02-schedules.md#weekly)`.
  The build rewrites these into site URLs, and fails if the file or the heading
  doesn't exist. Heading anchors are the heading text lowercased with spaces as
  hyphens, as on GitHub.
- **Images** sit next to the pages that use them (an `images/` folder in the
  chapter is tidy) and are linked relatively. Always write alt text. An image
  on another site fails the build: the site's security policy only loads images
  it serves itself.
- Mermaid blocks show as code; diagrams are not drawn.

## Preview and check

```bash
pnpm dev:site                      # then open http://localhost:5173/help/
pnpm --filter @rally/site build    # fails, listing every problem, if anything is broken
```

## How the manual reads

The manual is a book, not a pile of articles. Chapters run from "I just
installed this" to "I run Sidekicks across my whole Organization", and each
page assumes the reader has read the ones before it. A chapter's `index.md` is
its opener: a short, readable essay on what the chapter is about and why
anyone would care, then the pages follow.

When you add a page, find where it belongs in the story. If nothing fits, the
story probably needs a new page that leads into it, not a page bolted onto the
end.

### Voice

Write like a person who likes the reader and has used the product a lot.

- **Plain words.** The reader is smart and not an engineer. Say "the agent
  reads your Linear issues", not "the connector exposes Linear's tools via MCP".
  If a technical word is the only accurate one, explain it the first time.
- **Short sentences, active voice, second person.** "Click **New Canvas**", not
  "A new canvas can be created by clicking".
- **Be funny, a little.** A dry aside or a dad joke now and then, never two in a
  row, never in a warning or anything about data, privacy, money or access.
  The joke has to be about the thing on the page.
- **Name things exactly as the app does.** Bold UI labels: **Settings →
  Connections**. Use today's names: Organization, Canvas, Sidekick, run,
  comment, the **Pinned** group, **Needs input**. Capitalise Organization,
  Canvas and Sidekick; "run" and "comment" are ordinary words. Channels, Threads, Breakouts, Spaces and
  Activity were removed; mention them only in the past tense, to tell a reader
  where something went.
- **Say what happens, then why it matters.** Every feature gets: what it is,
  why you'd want it, how to do it, and what to watch out for.

### Words and habits to avoid

They make writing sound machine-made, and readers notice.

- Filler openers and closers: "In today's fast-paced world", "Let's dive in",
  "In conclusion", "Happy collaborating!"
- Puffed-up words: *seamless, robust, powerful, leverage, unlock, empower,
  elevate, streamline, cutting-edge, game-changer, delve, harness, tapestry,
  realm, journey, navigate the landscape, supercharge*.
- Em dashes. Use a full stop, a comma, a colon or brackets.
- "It's not just X, it's Y" and other set-ups for a reveal.
- Lists of exactly three adjectives, and triplets in general when two will do.
- Bold on every other phrase, emoji as bullets, and headings ending in a colon.
- Hedging and throat-clearing: "simply", "just", "easily", "it's worth noting
  that", "please note".
