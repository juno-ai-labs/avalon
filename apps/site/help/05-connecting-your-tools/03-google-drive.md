---
title: Google Drive, Docs and Sheets
description: Let Rally find and read your Drive files, and create and edit Google Docs and Sheets.
nav_title: Google Drive
---

The second Google card, **Google Drive + Docs + Sheets**, covers your files. Unlike mail, Drive can be connected either way: connect your own Drive for your own files, or have an administrator connect one shared Google account whose files every member can ask about.

| Button | What it gives Rally |
| --- | --- |
| **Connect for me** | Your own Drive, as you see it. |
| **Connect for organization** (owners and administrators) | One shared Google account's Drive, for everyone in the Organization. |

As with [Gmail and Calendar](02-google-mail-and-calendar.md), signing in to Rally with Google does not give Rally your Drive. It is a separate connection with its own row in the table.

## What Rally can do

With **Google Drive + Docs + Sheets** connected, Rally can:

- find files in Drive
- read files: Google Docs, Sheets and Slides come through as text, and other files as a limited amount of text (pictures and other non-text files are not passed to the AI)
- read a Doc, or a spreadsheet's tabs and a range of its cells
- create new Docs and Sheets
- add text to the end of a Doc, or find and replace text in it
- write or add cell values in a Sheet

Rally can read Google Slides but cannot edit them.

## Reading is broad, writing is narrow

Rally can read anything the connected Google account can open. Writing is stricter. Rally can change Docs and Sheets it created itself, and other files only once someone allows it, file by file.

When Rally needs to edit an existing file, it puts a card in the conversation saying Google needs you to allow Rally to edit this file, with an **Allow editing** button. Click it and Google opens its own approval page for that one file. Only the person who owns the connection can approve a personal one, and only an administrator can approve for an Organization one. Everyone else sees **Owner required** or **Admin required** on the button.

Text Rally writes into a Doc goes in as plain text. If you see asterisks and hash signs where you expected bold and headings, that is why. Ask Rally to keep formatting out of anything it writes into a Doc.

## Connecting

1. Open **Settings → Connections** and find the **Google Drive + Docs + Sheets** card.
2. Click **Connect for me**, or **Connect for organization** if you are an administrator connecting Drive for everyone.
3. Choose the Google account in the browser and approve access. For the Organization connection, pick the shared account whose files everyone should be able to ask about, not your own.
4. Come back to Rally. The card says **Connected**.

## Watching Google files

Rally has the groundwork for watching a Google file for changes, but the switch for it is not in the Mac app today, as [Resources: things you bring in](../06-things-rally-makes/04-resources.md#bringing-things-in-yourself) explains. When it arrives, expect a short delay: Rally checks Google for changes every few minutes rather than hearing about them the moment they happen.

## Things to try

- "Find the Q3 planning doc in Drive and tell me what changed in the budget section."
- "Read the pipeline sheet and list every deal over 20,000 that has not moved this month."
- "Write up this Canvas's decisions as a new Google Doc."
- "Add this week's numbers to the bottom of the metrics sheet."

## When it stops working

1. In **Settings → Connections**, look at the **Status** column for the Drive row that failed. Your own Drive and the Organization's are separate rows.
2. If it says **Reconnect required**, click **Refresh** and approve again in Google. For the Organization's Drive connection, ask an owner or administrator to do it.
3. If the connection is healthy and Rally still cannot reach a file, open it yourself in Google with the same account. If you cannot open it, neither can Rally.

Next, [GitHub](04-github.md).
