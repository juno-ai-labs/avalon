---
title: Granola
description: Let Rally read your Granola meeting notes and transcripts, and start Sidekicks when a new note lands.
---

Granola takes notes in your meetings so you can pay attention to them. Connect it and Rally can read those notes and act on them. The meeting may have run long, but at least the follow-up won't.

## What Rally can do

With Granola connected, Rally can:

- list your meetings and folders
- read a meeting's notes
- read a meeting's transcript
- ask Granola questions across your meetings, such as "when did we last talk about pricing?"

With the Organization connection, a new note arriving in Granola can also start a Sidekick. See [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md).

## Connecting for yourself

1. Open **Settings → Connections** and find the **Granola** card.
2. Click **Connect for me**.
3. Sign in to Granola in your browser. There is no key to copy.
4. Come back to Rally. The card says **Connected**.

## Connecting for the Organization

The Organization connection reads your Granola workspace's shared notes. It uses a **Workspace API key**, a long password that Granola makes for you. You need two people for this, or one person wearing both hats: a Granola workspace administrator on Granola's Business or Enterprise plan, and a Rally owner or administrator.

First, make the key in Granola:

1. Open the Granola desktop app.
2. Go to **Settings → Connectors → Workspace API keys**.
3. Click **Create new key**, and copy the key.

Then, in Rally:

1. Open **Settings → Connections** and find the **Granola** card.
2. Click **Connect for organization**. The **Connect Granola workspace** dialog opens.
3. Paste the key into **Workspace API key**. Granola keys start with `grn_`. If what you pasted does not look like one, Rally says so under the box.
4. Click **Connect for organization**.

A workspace key can read public notes in your Granola workspace, and notes in Granola spaces where API access is turned on. It cannot read anyone's other private notes.

> [!IMPORTANT]
> Rally stores the key encrypted and never shows it again. Paste it only into the **Workspace API key** box, never into a Canvas or an email. To use a different key, delete the Organization connection and connect again with the new one.

If setup was interrupted and Rally could not tell whether a connection already exists, the dialog offers **Find existing installation**. Use that rather than starting setup again.

## When it stops working

- For a personal connection showing **Reconnect required**, click **Refresh** and sign in to Granola again.
- The Organization connection has no Refresh, because there is no sign-in to redo. Its row has **Delete** only.
- If shared notes stop arriving, contact support with the connection details rather than changing anything about Rally on the Granola side. [Contacting support](../12-help-and-glossary/03-contact-support.md) says how.

## Things to try

- "Summarise this morning's design review and list the action items with owners."
- "What did the customer say about onboarding across our last three calls with them?"
- "Turn yesterday's planning meeting notes into Linear issues."

Next, [Fireflies](09-fireflies.md).
