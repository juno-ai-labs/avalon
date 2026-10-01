---
title: "Google: Gmail, Calendar, Drive, Docs and Sheets"
description: Let Rally search your Gmail, manage your calendar, and find, read and write your Drive files, Docs and Sheets.
nav_title: Google
---

Google gets two cards on **Settings → Connections**, because mail and documents are different sorts of thing and you may want to share one and not the other.

| Card | What it covers | Buttons |
| --- | --- | --- |
| **Google Mail + Calendar** | Gmail and Google Calendar | **Connect for me** only |
| **Google Drive + Docs + Sheets** | Drive files, Google Docs and Google Sheets | **Connect for me**, and **Connect for organization** for owners and administrators |

Your mail and calendar are always personal. There is no shared Organization inbox connection. Drive can be either: connect your own Drive for your own files, or have an administrator connect one shared Google account whose files every member can ask about.

Signing in to Rally with Google does not give Rally your Gmail, Calendar or Drive. Each is a separate permission you give here.

## Gmail and Calendar

With **Google Mail + Calendar** connected, Rally can:

- search your mail, including finding someone's address by their name
- read whole threads and single messages
- write drafts, which wait in your Gmail **Drafts** until you send them
- send mail
- list your calendars and read their events
- create events and change them, including adding or removing guests

Rally cannot delete mail or change labels.

> [!WARNING]
> Rally does not ask before each action. When you ask it to send an email, it sends it, and a sent email cannot be called back. When you ask it to add a guest to an event, Google sends that person a real invitation. If you want to check first, ask for a draft, or ask Rally to show you the event before it saves it.

Things to try:

- "Find the thread with Dana about the offsite and draft a reply saying Thursday works."
- "Put a 30-minute call with Sam on Thursday afternoon."
- "What is on my calendar tomorrow, and is anything double-booked?"
- "Summarise the unread mail from this week that needs an answer from me."

## Drive, Docs and Sheets

With **Google Drive + Docs + Sheets** connected, Rally can:

- find files in Drive
- read files: Google Docs, Sheets and Slides come through as text, and other files as a limited amount of text (pictures and other non-text files are not passed to the AI)
- read a Doc, or a spreadsheet's tabs and a range of its cells
- create new Docs and Sheets
- add text to the end of a Doc, or find and replace text in it
- write or add cell values in a Sheet

Rally can read Google Slides but cannot edit them.

### Reading is broad, writing is narrow

Rally can read anything the connected Google account can open. Writing is stricter. Rally can change Docs and Sheets it created itself, and other files only once someone allows it, file by file.

When Rally needs to edit an existing file, it puts a card in the Channel saying Google needs you to allow Rally to edit this file, with an **Allow editing** button. Click it and Google opens its own approval page for that one file. Only the person who owns the connection can approve a personal one, and only an administrator can approve for an Organization one. Everyone else sees **Owner required** or **Admin required** on the button.

Text Rally writes into a Doc goes in as plain text. If you see asterisks and hash signs where you expected bold and headings, that is why. Ask Rally to keep formatting out of anything it writes into a Doc.

Things to try:

- "Find the Q3 planning doc in Drive and tell me what changed in the budget section."
- "Read the pipeline sheet and list every deal over 20,000 that has not moved this month."
- "Write up this Channel's decisions as a new Google Doc."
- "Add this week's numbers to the bottom of the metrics sheet."

## Watching Google files

You can bring a Google file into a Channel and have Rally watch it for changes. [Resources: things you bring in](../06-things-rally-makes/04-resources.md) shows how. Rally checks Google for changes every few minutes rather than hearing about them the moment they happen, so a change shows up after a short delay.

## Connecting

1. Open **Settings → Connections**.
2. Find the card you want and click **Connect for me** (or **Connect for organization**, if you are an administrator connecting Drive for everyone).
3. Choose your Google account in the browser and approve access.
4. Come back to Rally. The card says **Connected**.

Connect both cards if you want mail and documents. They are separate connections with separate rows in the table.

## When it stops working

1. In **Settings → Connections**, look at the **Status** column for the Google connection that failed. Mail and Drive are separate rows.
2. If it says **Reconnect required**, click **Refresh** and approve again in Google. For the Organization's Drive connection, ask an owner or administrator to do it.
3. If the connection is healthy and Rally still cannot reach something, open it yourself in Google with the same account. If you cannot open it, neither can Rally.

Next, [GitHub](03-github.md).
