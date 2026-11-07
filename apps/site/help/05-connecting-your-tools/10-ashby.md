---
title: Ashby
description: Let recruiters ask Rally about candidates and jobs, and start Sidekicks when candidates move through Ashby.
---

Ashby is a recruiting system. Rally's Ashby connection has two halves that do different things, and you can set up either one first, or only one.

| | Personal connection | Organization connection |
| --- | --- | --- |
| Who sets it up | Any member, for themselves | An owner or administrator |
| How | Sign in with your Ashby account | Paste an Ashby API key |
| What it gives Rally | Tools to look up and update candidates, jobs and applications | News of recruiting events, for starting Sidekicks |
| Look-up tools? | Yes | No |

## The personal connection: asking about candidates and jobs

With your own Ashby account connected, Rally can look up and update candidates, jobs and applications, as far as your Ashby account is allowed to. The tools come from Ashby itself.

1. Open **Settings → Connections** and find the **Ashby** card.
2. Click **Connect for me**.
3. Sign in to Ashby in your browser and approve Rally.
4. Come back to Rally. The card says **Connected**.

> [!NOTE]
> Ashby offers these tools as a beta that your company has to opt into, and your Ashby account has to be eligible. If signing in fails with no clear reason, this is the most likely cause. Ask whoever runs Ashby at your company to check.

Things to try:

- "Which candidates for the Senior Designer role are waiting on feedback?"
- "Summarise where we are with the backend engineer pipeline."
- "Move this candidate to the onsite stage."

Rally does not ask before each action, so it will update a record when you ask it to.

## The Organization connection: events for Sidekicks

The Organization connection does not give Rally any tools for looking things up. It tells Rally when things happen in Ashby, such as an application being submitted or a candidate being hired, so those moments can start Sidekicks.

You need an Ashby API key, made by someone who administers Ashby, with the **Read API Keys** and **Write API Keys** permissions.

1. Open **Settings → Connections** and find the **Ashby** card.
2. Click **Connect for organization**. The **Connect Ashby for organization** dialog opens.
3. Follow the link in the dialog to Ashby's API key page, and create a key with **Read API Keys** and **Write API Keys** switched on.
4. Paste the key into **Ashby organization API key**.
5. Click **Connect for organization**.

Rally then subscribes to all 27 kinds of event Ashby announces. There are no boxes to tick during setup. You choose which events matter when you build a Sidekick, as [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md) describes.

> [!WARNING]
> Paste the API key only into the **Ashby organization API key** box in Settings. Never paste it into a Canvas, an email or a support message. Rally stores it encrypted.

Events can be about candidates and jobs that a person's own Ashby account would not show them. Consider that when you decide which Sidekicks use them and where those Sidekicks post.

## Manage events

Owners and administrators see a **Manage events** button on the Organization Ashby row in **Settings → Connections**. It opens a window showing:

- the connection's status, such as **Connected** or **Needs attention**
- **Last event received**, or "None yet"
- **Test**, which checks that events can reach Rally and tries to repair delivery if they cannot
- **Get help**, which appears when the connection needs attention and opens Rally support for a problem **Test** does not fix

Under **Advanced** are tools for administrators and support:

- **Refresh status** reads the saved state again.
- **Replace organization API key** swaps in a new key from the same Ashby account. Existing subscriptions are kept.
- **Verify existing webhook** is for when Rally could not tell whether Ashby created its event subscription. Look in Ashby for it first, then give Rally its ID here, rather than setting the connection up again.
- **Retry cleanup** appears after you delete the connection, when Rally still has a subscription to remove, and asks Ashby again to remove it.
- **Forget local cleanup credential** stops Rally trying to clean up, and leaves removing any remaining subscription in Ashby to your Ashby administrator.

Deleting the Organization connection stops Rally's access straight away. Removing the subscription on Ashby's side can take a little longer.

## When it stops working

The two halves have separate status. For the personal connection, click **Refresh** on its row and sign in again. For the Organization connection, open **Manage events** and try **Test**.

If you contact support, send the connection ID, your region, the error and roughly when it happened. Never send API keys, sign-in codes or candidate information.

Next, [Canva](11-canva.md).
