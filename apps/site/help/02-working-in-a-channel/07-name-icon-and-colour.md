---
title: Names, icons and colours
description: Rename a Channel or Breakout, pick its icon and colour, and understand the description Rally keeps for it.
---

You name a Channel when you start it, and Rally picks it an icon and a colour.
Conversations that start without a name, such as Breakouts, get one from Rally,
as described in [Your first Channel](../01-getting-started/05-your-first-channel.md#names-and-icons).
Rally's picks are educated guesses. When you have a dozen Channels, a good name and a
recognisable icon are what let you find the right one in a hurry.

## The Channel header

The strip across the top of a Channel holds, from left to right:

- The Channel's **icon**, on a coloured tile.
- Its **name**.
- A **Private** badge, if the Channel is private.
- The **people** in it (see [People in the room](05-people-in-the-room.md)).
- A **…** button (**More channel actions**) with **Copy channel link**,
  **Copy channel ID** and, when the Channel has one, **Copy channel email
  address**. Links are covered in
  [Search and links](../03-spaces-and-breakouts/06-search-and-links.md) and the
  email address in [Email into Rally](../08-rally-everywhere/03-email-into-rally.md).

## Renaming

### From the header

1. Click the Channel's name in the header. (Hovering it shows **Click to rename.
   Press Enter to save.**) You can also move to the name with the keyboard and
   press <kbd>F2</kbd> or <kbd>Return</kbd>.
2. Type the new name.
3. Press <kbd>Return</kbd>, or click the tick (**Save name**), to save. Press
   <kbd>Esc</kbd>, or click the **X** (**Cancel rename**), to leave it as it was.

This works the same way in a Breakout.

When Rally is naming a conversation, such as a new Breakout, the name area
shimmers while it thinks one up. You can rename it once the name has arrived.

### From the sidebar

You do not have to open a Channel to rename it.

1. Right-click the Channel in the sidebar and choose **Rename**.
2. In the **Rename channel** window, type the new name and click **Rename**.

Breakouts work the same way from their own right-click menu, in a window called
**Rename breakout**. The **Rename** button stays greyed out until you have
changed something.

### Things to know about names

- A name can be up to 180 characters, and cannot be empty.
- Once you rename a Channel, Rally leaves its name alone. It never renames
  it automatically again, so your name sticks.
- If a rename does not save, you see **The channel couldn’t be renamed. Try
  again.** (or the same for a breakout).

### Reading a long name

The sidebar is narrow, so long names get cut short. Rest your pointer on a
Channel in the sidebar and a small card shows its icon and full name. The card
also says **Public to organization** if anyone in the Organization can open it.
In the header, a name too long to fit shows in full when you hover it.

## Icon and colour

Click the icon at the left of the Channel's name (**Change channel icon and
color**, or **Change breakout icon and color** in a Breakout). A small palette
opens.

- The top part, **Color**, has 14 round swatches in two rows, in rainbow order:
  Rose, Red, Orange, Amber, Lime, Green and Emerald, then Cyan, Blue, Indigo,
  Violet, Purple, Fuchsia and Pink. The second row runs right to left, so Cyan
  sits under Emerald and Pink under Rose.
- Below it, **Icon** is a scrolling grid of 37 icons. Twelve are abstract shapes
  (such as Atom, Orbit and Sparkles) and 25 are everyday things (such as Rocket,
  Calendar Days, Coins, Megaphone and Heart). Hover any swatch or icon to see its
  name.

Click a colour, click an icon, and you are done. There is no **Save** button:
each click saves straight away, and the palette stays open so you can try a few.
Click outside the palette or press <kbd>Esc</kbd> to close it.

The symbol on the tile switches between white and black by itself so it stays
readable: black on Amber, Lime and Green, white on the rest. Channel and Space
colours stay the same in light and dark mode, so a blue Channel is the same
blue whichever look you choose.

### Things to know about icons and colours

- Everyone sees the same look. The icon and colour belong to the Channel, not
  to you. Change them and everyone's sidebar updates within moments. The last
  person to click wins, so agree on a colour scheme before the office splits
  into Team Rose and Team Fuchsia.
- A Breakout has its own look. Changing a Breakout's icon never changes its
  Channel's, and the other way round.
- You cannot add your own. There is no custom colour, no icon search and no
  way to upload a picture or emoji.
- Older colours: grey, brown, yellow and teal used to be on offer and have
  been retired. A Channel that already has one keeps it, and no colour looks
  selected in the palette. Once you pick a new colour, the old one cannot be
  chosen again.
- Guests, and people who can only reach some of a Channel's conversations, see
  the icon but cannot change it.
- If a change does not save, the palette shows **Couldn’t update the
  appearance. Please choose again.** If you are offline, your clicks wait and
  are sent when the connection returns.
- Picking the icon and colour is a Mac app feature.

## The description Rally keeps

Every Channel also has a short description of what it is for, which Rally
writes and keeps up to date by itself. You do not have to do anything with it,
and you will not find it shown in the Channel or the sidebar.

### What it is for

The description is Rally's one-line answer to "what is this Channel about?".
Rally reads it at the start of every run in the Channel, alongside the name, so
it has the right background without rereading the whole history. It also helps
Rally decide which Channel an update from one of your connected tools belongs
in.

### How Rally writes it

When you create a Channel, Rally writes a first description from the opening line
of the first message. After that, Rally checks now and then whether the Channel
has moved on to something new, and if it clearly has, quietly rewrites the
description.

Rally is slow to change it:

- It only checks after the Channel has had a rest. The wait starts at six hours
  and grows, up to two days, each time the description turns out to still be
  right.
- It only checks after people have had a real conversation since the last check:
  at least ten messages from people, with a fair amount of text, about things the
  current description and name do not mention. Messages from Rally do not count.
- It rewrites only when it is confident, and makes the smallest change that
  makes the description true again.
- It refuses vague descriptions such as "general discussion" or "team chat",
  and keeps a description short (280 characters at most).

So a new Channel keeps its first description until people have talked in it
properly, and a Channel that stays on its subject keeps its description however
long the conversation gets. It will not flip-flop every afternoon.

Channels that belong to a Sidekick and archived Channels are left alone.

Next: [Bring in a conversation from Claude or ChatGPT](08-import-from-claude-or-chatgpt.md).
