---
title: Google Mail and Calendar
description: Let Rally search and read your Gmail, write drafts, send mail, tidy your inbox, and read and change your Google Calendar.
nav_title: Google Mail and Calendar
---

Google gets two cards on **Settings → Connections**, because mail and documents are different sorts of thing and you may want to share one and not the other. This page covers the first, **Google Mail + Calendar**. The second, for Drive, Docs and Sheets, has [the next page](03-google-drive.md) to itself.

Your mail and calendar are always personal. The card has **Connect for me** only, and there is no shared Organization inbox connection.

Signing in to Rally with Google does not give Rally your Gmail or Calendar. It is a separate permission you give here.

## What Rally can do

With **Google Mail + Calendar** connected, Rally can:

- search your mail, including finding someone's address by their name
- read whole threads and single messages
- write drafts, new ones and replies, which wait in your Gmail **Drafts** until you send them
- send mail and reply to it
- tidy your inbox: archive a conversation or move it back to the inbox, mark it read or unread, star it, mark it important, or mark it as spam
- add and remove labels, and create a new label
- move a conversation to **Trash**, and take it back out again
- list your calendars and read their events
- create events and change them, including adding or removing guests

Rally cannot delete mail for good. The furthest it can go is **Trash**, where a conversation stays, and can be restored, until Gmail empties it.

Finding, reading and summarising mail leaves your mailbox exactly as it was. Rally archives, labels or bins something when you ask it to.

> [!WARNING]
> Rally does not ask before each action. When you ask it to send an email, it sends it, and a sent email cannot be called back. When you ask it to add a guest to an event, Google sends that person a real invitation. When you ask it to archive, label or bin a batch of mail, it does the whole batch. If you want to check first, ask for a draft, ask Rally to show you the event before it saves it, or ask it to list the mail it would change before it changes any.

## Connecting

1. Open **Settings → Connections** and find the **Google Mail + Calendar** card.
2. Click **Connect for me**.
3. Choose your Google account in the browser and approve access.
4. Come back to Rally. The card says **Connected**.

## Things to try

- "Find the thread with Dana about the offsite and draft a reply saying Thursday works."
- "Put a 30-minute call with Sam on Thursday afternoon."
- "What is on my calendar tomorrow, and is anything double-booked?"
- "Summarise the unread mail from this week that needs an answer from me."
- "Label every receipt from this month as Receipts and archive the ones I have read."

## When it stops working

1. In **Settings → Connections**, look at the **Status** column for the **Google Mail + Calendar** row.
2. If it says **Reconnect required**, click **Refresh** and approve again in Google.
3. If the connection is healthy and Rally still cannot find a message or an event, look for it yourself in Gmail or Calendar with the same Google account. If you cannot see it, neither can Rally.

### Rally can read your mail but not tidy it

A connection made before Rally learned to archive, label and bin keeps the permission it was given then: it can still search, read, draft and send, and nothing more. To add the rest, click **Refresh** on the **Google Mail + Calendar** row and approve again in Google.

Next, [Google Drive, Docs and Sheets](03-google-drive.md).
