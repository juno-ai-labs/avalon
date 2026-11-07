---
title: Live sites
description: Ask for a web page or small app and Rally builds it, hosts it and gives it its own address.
---

Some requests are not for documents at all. A landing page, a dashboard, a tip calculator, a habit tracker, a poll, a sign-up sheet for the team offsite: what you want there is a page people can open and click. For those, Rally builds a small website, puts it on the internet, and gives it its own web address. It does not paste a screenful of code into the chat and wish you luck.

These are **live sites**, and they are artifacts like any other. They sit in their Canvas like any other artifact, they keep their versions, and you change them by asking.

## Asking for a site

Describe the page or tool you want in a Canvas. A few examples:

- "Make a landing page for our bake sale, with the date, the place and a menu."
- "Build a simple dashboard that shows the numbers in this spreadsheet as charts."
- "Make a sign-up sheet for the offsite where people add their name and dietary needs."
- "Make a poll for where we go for the team lunch."

Rally builds the site on its private computer (the Terminal, from [Code, data and the Terminal](../04-working-with-rally/03-code-files-and-the-terminal.md)), publishes it, and posts a card in the conversation labelled **Site**.

A site can be one of three things, and Rally picks from what you asked for:

- **A plain page** that looks the same for everyone, like the bake-sale page.
- **A page with some logic behind it**, which works things out when someone visits.
- **A page that remembers things**, like the sign-up sheet or the poll, where visitors add entries and the site keeps them in its own small database.

### Changing a site

Ask for changes in the same Canvas, or leave a [comment](../02-canvases/06-comments.md) on the part of the page you mean: "make the button green", "add a field for t-shirt size". Rally updates the same site, and it stays at the same address, so a link you already sent keeps working and shows the new version.

A request for a new thing makes a new site at a new address, even if it looks a lot like an existing one.

## Looking at a site inside Rally

Click the **Site** card to open the site view, which shows the live page itself. Its header has these buttons:

- **Stored data**, only on sites that remember things (below).
- **Open in a new window**, which gives the site its own window, handy for a dashboard on a second monitor. The window behaves as described in [Opening, docking and downloading](02-opening-and-downloading.md#giving-an-artifact-its-own-window).
- **Copy public link**, which copies the site's address.
- **Open in browser**, which opens the site in your usual web browser.

You can also dock a site beside the conversation with **Open in a righthand sidebar**, the same way you dock a document.

While the site loads you see **Opening…**. If it cannot load, Rally says **This site could not be opened**, with the reason underneath.

In the web browser version of Rally, the live page cannot be shown inside Rally itself, so the site view says **Preview unavailable here** and suggests opening it in your browser with **Open in browser**.

> [!NOTE]
> Viewing sites inside the Mac app is switched on for some Organizations and not yet for others. If yours does not have it, a site shows as an ordinary card with its title, when it was last updated, its versions and **Archive**, and none of the buttons above. The site itself is still published and still works for anyone who opens its address.

## Seeing what visitors submitted

A site that remembers things, such as a poll or a sign-up sheet, has a **Stored data** button (a database icon) in its header. Click it to swap the page for a table of everything visitors have saved. The button stays pressed while the table is showing; click it again to go back to the page.

- If the site keeps more than one table, switch between them with the buttons along the top. Hover one to see how many rows it has.
- Empty cells show a dash.
- **Copy as CSV** copies the table so you can paste it into a spreadsheet.
- The table is read-only.

While the table loads you see **Reading…**. Before anyone has submitted anything, the view says **No data yet** and **Nothing has been submitted yet.** If it cannot read the data, it says **Data unavailable** and **Could not read this site's data.**

> [!IMPORTANT]
> The table shows at most the first 200 rows, and **Copy as CSV** copies those same 200 rows. If your sign-up sheet is more popular than that, ask Rally in the Canvas about the full data. Rally can read what a site has collected and tell you about it.

## Sharing a site, and who can see it

Every site has a public web address made of four ordinary words, ending in `rallyusercontent.com`. **Copy public link** puts it on your clipboard, ready to paste into an email, a chat or a slide.

> [!WARNING]
> **Sites are public by default.** Anyone who has the address can open the latest version of the site without signing in to anything. The address is made of readable words, not a secret code, so treat a site as visible to anyone who comes across its link. Search engines are asked not to list it, but that is a request, not a lock.
>
> Before you share a link, check what is on the page. Do not put anything on a public site that you would not put on a public notice board.

Some more detail on access:

- Visitors can read a public site. They cannot change it.
- If a site must be private, say so when you ask for it, for example "make this sign-up sheet only open to people in our Rally Organization". Rally then builds a site that checks who is visiting and turns away anyone who is not signed in to Rally. A plain page that looks the same for everyone cannot be made private.
- The public address always shows the latest version. Earlier versions are only visible inside Rally, and they show the page as it was, never live data.
- **Open in browser** and **Open in a new window** sign you in to the site as yourself for that visit. That sign-in lasts 24 hours. Use the buttons each time rather than reusing an address from your browser's history, because the sign-in part of that address only works once and expires within a minute.
- People you have invited into the Canvas as guests (see [Sharing with people outside your Organization](../02-canvases/09-sharing-with-guests.md)) can open a site that is part of what was shared with them.

## Limits

- Each published version of a site can be at most about 25 MB. That is a lot of web page, unless your bake sale has an ambitious photo gallery.
- Rally does not paste a site's code into the chat. The site is the answer.

Next: things that come in from outside, in [Resources: things you bring in](04-resources.md).
