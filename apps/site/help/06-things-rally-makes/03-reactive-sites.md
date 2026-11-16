---
title: Reactive sites
description: Ask for a web page or small app and Rally builds it, hosts it and gives it its own address.
---

Some requests are not for documents at all. A landing page, a dashboard, a tip calculator, a habit tracker, a poll, a sign-up sheet for the team offsite: what you want there is a page people can open and click. For those, Rally builds a small website, puts it on the internet, and gives it its own web address. It does not paste a screenful of code into the chat and wish you luck.

These are **reactive sites**, and they are artifacts like any other. They sit in their Canvas like any other artifact, they keep their versions, and you change them by asking.

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

Ask for changes in the same Canvas, or, in [the desktop app](../08-rally-everywhere/04-the-desktop-app.md), leave a [comment](../02-canvases/06-comments.md) on the part of the page you mean: "make the button green", "add a field for t-shirt size". Rally updates the same site, and it stays at the same address, so a link you already sent keeps working and shows the new version.

A request for a new thing makes a new site at a new address, even if it looks a lot like an existing one.

## Looking at a site inside Rally

Click the **Site** card to open the site view. In the web app, the live page cannot be shown inside Rally, so the view says **Preview unavailable here** and **Open it in your browser to see the live page.** Click **Open in browser** in its header and the site opens in a new tab.

In [the desktop app](../08-rally-everywhere/04-the-desktop-app.md), the site view shows the live page itself, and you can leave comments on it.

The header has these buttons:

- **Stored data**, only on sites that remember things (below).
- **Open in a new window**, which gives the site its own tab or window, handy for a dashboard on a second monitor. It behaves as described in [Opening, docking and downloading](02-opening-and-downloading.md#giving-an-artifact-its-own-tab-or-window).
- **Copy link**, which copies the site's address.
- **Open in browser**, which opens the site in a new browser tab (from the desktop app, in your usual web browser).

A site opens in the panel beside the conversation, the same way a document does.

While the site loads you see **Opening…**. If it cannot load, Rally says **This site could not be opened**, with the reason underneath.

> [!NOTE]
> Viewing sites inside the desktop app is switched on for some Organizations and not yet for others. If yours does not have it, a site shows as an ordinary card with its title, when it was last updated, its versions and **Archive**, and none of the buttons above. The site itself is still published and still works for anyone who opens its address.

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

Every site has a public web address made of four ordinary words, ending in `rallyusercontent.com`. **Copy link** puts it on your clipboard, ready to paste into an email, a chat or a slide.

A site's access comes from **Who can interact with artifacts** in its
Canvas's **Share** dialog. The same audience applies to files and other artifacts
published in that Canvas.

- **Editors only** is the default. Only the Canvas's editors can use it.
- **Specific people** adds selected artifact users without exposing the chat.
- **Everyone in the Organization** admits active members and selected guests.
- **Anyone with the link** allows visitors without signing in.

Editors always have access. Static pages and interactive apps follow the same
sharing setting. Using an app may include submitting a form or changing entries;
that does not grant permission to redesign or republish it through Rally.

Sharing changes reach published artifacts in the background. A visitor who loses
access cannot make further requests once the update reaches the site. Content
already downloaded and work done entirely in the browser cannot be taken back.

**Open in browser** and **Open in a new window** sign you in for that visit.
The sign-in session lasts a year from the last time you open the artifact, but a
change in artifact access takes effect without waiting for it to expire. Earlier versions and administrative
stored-data views are available to editors.


## Limits

- Each published version of a site can be at most about 25 MB. That is a lot of web page, unless your bake sale has an ambitious photo gallery.
- Rally does not paste a site's code into the chat. The site is the answer.

Next: things that come in from outside, in [Resources: things you bring in](04-resources.md).
