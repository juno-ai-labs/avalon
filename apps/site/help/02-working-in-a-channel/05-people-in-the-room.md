---
title: People in the room
description: Bring teammates into a Thread, see who is here, and know when Rally will chime in.
---

A Thread is better with company. This page covers who is in a Thread, how to
bring someone in, and how Rally behaves when the room gets busy.

## Who is in this Thread

The people in a Thread are its **participants**. To see them, click the
Thread's name in its title pill and choose **People**. (The row shows how many
there are, and whether the Thread is **Public** or **Private**.)

The list opens with who can read the Thread: **Private** (only people added
here) or **Public to organization**. Then come the participants, each with
their email and whether they are a **Member**, an **Admin** or a **Guest**. A
small dot beside a name means that person has this Thread open right now, so
if you ask a question, someone may be there to answer it. Who can see which
Threads, and why, is explained in
[Who can see what](../03-spaces-and-breakouts/04-who-can-see-what.md).

## Adding and removing people

The quickest way is the menu itself:

1. Click the Thread's name in its title pill and choose **Add people** (or
   **People**).
2. Type in **Add someone by name or email**, or pick from the people listed.
3. Click **Add** beside the person.

**Suggested** shows up to five people, prioritizing Rally replies and @mentions
in this Channel, then across your Organization, then other Members and Guests.
Each person appears once. Search by name or email to find anyone else.

For the full list, click **Change** beside **Private** or **Public to
organization** at the top of **People**. The **Add a participant** window lists
the active members of your Organization; click a person to add them. To take
someone out, click the **…** beside their name and choose **Remove from main
conversation** (or **Remove from breakout**).

A Breakout's title pill has the same **Add people** and **People**.

A few rules:

- Opening or reading a Thread does not make you a participant. You join when
  someone adds you.
- You cannot remove the last participant. Someone has to keep the lights on.
- Only people whose membership in the Organization is active appear in the list.
  To bring in someone from outside your Organization, such as a client, see
  [Sharing with people outside your Organization](../03-spaces-and-breakouts/05-sharing-with-guests.md).

You can also type `/participants` or <kbd>@</kbd> in the message box to start
mentioning someone, as described in
[The message box](01-the-message-box.md#mentioning-people-and-rally).

## Mentioning someone who is not here yet

In a private Thread, if you @-mention someone who is not a participant, Rally
stops before sending and asks: **Add participant?** (or **Add participants?** for
several people). The message explains that the person is not currently a
participant, and that if you do not add them, they will not be able to see the
mention or the Thread.

- **Add and mention** (or **Add all and mention**) adds them and sends your
  message.
- **Cancel** sends nothing, so you can think again.

> [!IMPORTANT]
> Adding someone lets them read the whole Thread, not only your message. If the
> Thread holds anything they should not see, cancel and start a separate
> conversation with them instead.

This saves you from the awkward moment of tagging a colleague in a conversation
they cannot open, and from sharing a private Thread by accident.

## Does Rally answer every message?

No, and you would not want it to. When several people are talking in a Thread,
not every message is a request for Rally. "Can you send me the deck, Priya?" is
for Priya.

Rally reads each new message and decides whether it is meant for Rally, for the
humans, or both:

- A clear request for work gets an answer.
- A message that mentions **@Rally** gets an answer.
- A message with a file attached always gets an answer.
- People chatting among themselves, or telling a mentioned teammate something,
  are usually left alone.
- If Rally cannot tell, it replies only when it is already in the middle of
  some work in the Thread.

Rally makes this call by looking at the last ten or so messages, and it does not
show you its decision. When you want to be sure, mention **@Rally**.

Messages Rally did not answer are not ignored. Rally still reads them the next
time it works in the Thread, so a decision your team made in passing becomes
part of what it knows.

## Who said what, and when

Every message carries a short line saying who wrote it and when.

- Your messages sit on the right, with your name on the outside edge, a
  small coloured dot (your personal colour) and the time.
- Everyone else's, Rally's included, sit on the left, with the name first and
  then the time. Rally's replies are signed **Rally**. Answers from a Sidekick
  show the Sidekick's name.
- Messages that came in from Slack read like **Name · Slack**.
- Messages brought in from Claude or ChatGPT carry a small cloud icon. Hover it
  to see **Imported by** and who imported them (see
  [Bring in a conversation from Claude or ChatGPT](08-import-from-claude-or-chatgpt.md)).

On a finished answer from Rally, the line may also show how long the work took.

### Times that keep themselves current

Times on messages read like **just now**, **7 minutes ago** or **3 hours ago**,
and they update by themselves while you watch. Leave Rally open all afternoon
and "7 minutes ago" will not still be claiming to be 7 minutes ago at teatime.

- Under a minute reads **just now**. Then it counts minutes, then hours, then
  days.
- After seven days it switches to a fixed date and time, such as **Sep 10,
  2026, 3:42 PM**, written the way your Mac's language and region settings like.
- Labels move on about every ten seconds, so one can lag behind by a few
  seconds.
- When Rally's window is hidden or minimised the labels rest, and catch up the
  moment you bring the window back.

Rest your pointer on any of these times for a moment and a small tip shows the
exact date and time, in your own time zone. That is handy when "3 days ago" is
not precise enough for a deadline. The tip appears for the mouse or trackpad
only; you cannot reach it with the keyboard.

Next: [Status dots](06-status-dots-and-badges.md), so you can tell at a
glance where you are needed.
