---
title: Fireflies
description: Let Rally search your Fireflies meetings and read their summaries and transcripts.
---

Fireflies records and transcribes your calls. Connect it and Rally can go back through them for you, which beats scrubbing through an hour of audio to find the one minute where somebody said "let's circle back".

## What Rally can do

With Fireflies connected, Rally can:

- search your meetings
- read a meeting's AI summary: the overview, the action items and the topics
- read a meeting's transcript

The tools of a personal connection come from Fireflies itself, so the list can change without a Rally update, and some of them change or share meetings. Rally does not ask before each action, so be as clear about sharing as you would be with a colleague.

A new personal connection does not start Sidekicks when a meeting is processed. Only an older Organization connection (see below) does that. See [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md).

## Connecting

Fireflies is personal only: everyone connects their own account.

1. Open **Settings → Connections** and find the **Fireflies** card.
2. Click **Connect for me**.
3. Sign in to Fireflies in your browser.
4. Come back to Rally. The card says **Connected**.

Rally sees your Fireflies meetings and nobody else's.

### Why there is no Organization option

Rally used to offer one shared Fireflies connection for a whole Organization. A shared key reads everything its account can reach, which for a meeting recorder means other people's calls, and Fireflies gives no way to say what a key covers. So each person now connects their own.

If your Organization made a shared Fireflies connection before this changed, it keeps working and its meeting events keep arriving, and those can still start Sidekicks. The only thing you can do to it now is **Delete** it, and it cannot be replaced. If it had a webhook set up in Fireflies, Rally cannot remove that for you: delete it in Fireflies, or leave it, since Rally turns away anything sent to a removed connection.

## When it stops working

Fireflies may ask you to sign in again when Rally's access expires. When that happens the row in **Settings → Connections** says **Reconnect required**. Click **Refresh** and sign in again.

## Things to try

- "What did we agree in yesterday's pricing call?"
- "List every action item assigned to me from this week's meetings."
- "Find the call where the customer mentioned the export problem and quote what they said."

Next, [Ashby](10-ashby.md).
