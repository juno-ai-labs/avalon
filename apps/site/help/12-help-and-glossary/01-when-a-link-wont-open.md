---
title: When a link won't open
description: What each 'Rally could not open that link' message means and what to do about it.
---

Lots of things hand you into Rally by link: an invitation email, the browser
page you sign in on, the page where you approve a connection to Google or
Slack, a Canvas link a teammate pasted into Slack. Most of the time the link
does its job and you land where you meant to. This page is for the other
times.

## The "Rally could not open that link" window

When the Rally app on your Mac is given a link it will not follow, a small
window appears in front of whatever you were doing. It is titled **Rally could
not open that link**. Under the title is one sentence saying why, and under
that is a single **Continue** button.

Read the sentence, then click **Continue**. The button is already selected
when the window opens, so <kbd>Return</kbd> does the same thing. Closing the
window with the red close button at its top left works too.

A few things about this window:

- **Continue** does not try the link again. It only closes the window. Rally
  never replays a failed link by itself, because sign-in and connection links
  are often good for one use only. Fix the cause, then click the original link
  again or start the action again from inside Rally.
- There is only ever one. If a second failure arrives while the window is
  open, the new message replaces the old one and the window comes back to the
  front. Usually both are the same failure reported twice, so you have not
  missed much.
- It floats on top. It stays in front of every Rally window, including
  Settings, until you dismiss it. That is deliberate: a failed connection used
  to leave no message at all, which was worse.
- It works whatever state Rally is in, even while it is starting up or
  after your session has expired.
- It is on the Mac only. The browser version does not have it.

## When you are signed out

If you are not signed in at all, Rally does not open the window. The sign-in
screen is the only thing showing, so the message appears there instead, under
the sign-in buttons. For example:

> Sign in before creating an automation.

Sign in, then click the link again. Rally forgot the link when it refused it,
so it will not open the place it pointed at for you after you sign in.

You may also see **Your session expired. Sign in again to continue.** on the
sign-in screen. That is not a link problem: your sign-in ran out and
Rally brought you back to the start. Sign in again and carry on.
[Signing in, signing out and Lockdown mode](../11-privacy-and-security/01-signing-in-and-out.md)
explains how long a sign-in lasts.

If you are signed in but have not joined an Organization yet, failures still
use the window, not the sign-in screen.

## What each message means

Find the sentence you saw in the left column. The text in angle brackets, like
`<email>`, stands for whatever Rally filled in.

### Invitations

| Message | What it means | What to do |
| --- | --- | --- |
| This invitation is invalid, expired, or no longer available. | The invitation has run out (they last seven days), was cancelled, or has already been used. Rally is not told which, on purpose. | Ask an owner or administrator of that Organization to send you a new invitation. |
| This invitation is for `<email>`. Sign in with that account to continue. | You are signed in with a different account from the one the invitation was sent to. Upper and lower case do not matter, but every other character does. | Choose **Log out** from the account menu, sign in with the address in the message, then click the invitation link again. |

Rally forgets an invitation once it fails, so after you fix the cause you
always need to open the link from the email again. Invitations themselves are
covered in [Create or join an Organization](../01-getting-started/02-create-or-join-an-organization.md)
and, for the person sending them, [Inviting people](../10-running-an-organization/02-inviting-people.md).

### Signing in

| Message | What to do |
| --- | --- |
| Sign in could not be completed: `<reason>` | Click **Continue** and start signing in again from Rally. |
| Sign in could not be completed. | The same: start signing in again. |
| The sign-in link did not match Rally's identity service. | Start signing in again from Rally, not from an old browser tab. |
| Rally received an unexpected sign-in link. | Start signing in again from Rally. |
| Sign in to Rally again, then reopen this link. | Your account sign-in needs renewing before Rally can open a link into an Organization. Sign in, then click the link again. On some Macs Rally opens the browser sign-in for you and then carries on to the link by itself. |

The reason after "Sign in could not be completed:" comes from the sign-in page
itself, so it can read oddly, something like "access denied" or "unknown
error". If the same reason keeps appearing, it is exactly what support needs
to see.

If you started signing in twice, Rally ignores the return from the older
attempt without a word. Only the newest one counts.

### Connecting a tool

When you connect Google, GitHub, Slack and friends, you approve Rally on the
tool's own page in your browser, which then sends you back to Rally. If that
return trip goes wrong you see one of these. `<Connector>` is the tool's name,
or "Connector" on its own when Rally cannot tell which tool it was.

| Message | What it means | What to do |
| --- | --- | --- |
| `<Connector>` authorization was cancelled. | You pressed cancel or deny on the tool's page. | If you meant to connect, open **Settings → Connections** and click **Connect** again. |
| `<Connector>` could not be connected. Try again. | The tool reported a failure. | Try **Connect** again. If it fails twice, contact support. |
| Rally received an invalid connector completion link. | The link was damaged, you have no Organization open, or it came from a different Rally region from the Organization you have open. | Open the right Organization, then start **Connect** again from **Settings → Connections**. |
| Your Slack account could not be linked. | Linking your Slack account to Rally did not work. Sometimes the window shows a more specific reason instead. | Try linking again. |
| Slack was linked, but personal Slack tools could not be connected: `<reason>` | Your Slack account is linked to Rally, but your own Slack connection did not finish. | The link is kept. Add your personal Slack connection again from **Settings → Connections**. |
| Sign in to the matching Rally organization before connecting your Slack account. | You are not in the Organization the Slack link is for. | Switch to, or sign in to, that Organization, then click the link again. |

When a connection succeeds, nothing pops up. Rally refreshes the list in
**Settings → Connections** and usually opens it so you can see the new row.
[Settings → Connections](../05-connecting-your-tools/01-connections.md)
covers the rest, and [Slack](../05-connecting-your-tools/07-slack.md) explains
the two kinds of Slack connection.

### Links into an Organization

Links to a Canvas, a Sidekick or a page of Settings belong to one
Organization. Before Rally follows one, it switches to that Organization. If it
cannot, you see one of these and nothing changes: you stay exactly where you
were.

| Message | What it means | What to do |
| --- | --- | --- |
| Rally could not access the organization this link belongs to. | You are not a member of that Organization, or no longer are. | Ask an owner or administrator there to invite you again. |
| Rally could not reach that organization. Check your connection, then reopen this link. | A network problem, on your side or ours. | Check your internet connection, then click the link again. |
| Sign in to Rally again, then reopen this link. | Your sign-in needs renewing. | Sign in, then click the link again. |

The first message is also what Rally says when something unexpected goes wrong
on the way in, so it does not always mean your membership has ended. If you
are sure you are still a member, try the link once more, then contact support.

A link is an address, not a key. If a teammate sends you a link
to a Canvas that was not shared with you, it will open Rally but not the Canvas.
[Who can see what](../02-canvases/08-who-can-see-what.md) explains
why, and how to be let in.

### Other messages

| Message | What to do |
| --- | --- |
| Sign in before creating an automation. | Sign in, then click the link again. "Automation" is the old name for a Sidekick; this message has not caught up yet. |
| Rally could not open that note link. | The link is damaged. Ask whoever sent it to copy it again from inside Rally. |
| Rally could not open that link. | Something unexpected went wrong. Try the link once more. If it keeps happening, contact support with the time it happened. |

A link to make a new Sidekick opens the app's home. That is not a failure. It
is a link with modest ambitions.

A link to a Channel, a Thread or a Breakout no longer opens anything: those
were the conversations Rally had before Canvases, and they were removed. Ask
whoever sent it what they meant to show you; it may be in a Canvas now.

## When a browser link does not open Rally at all

Links to Canvases and Sidekicks are ordinary web addresses starting
with `https://rallywith.ai/app/`. If Rally is installed, the link should open
straight in the app. Otherwise you see a short web page that hands you over,
as described in [Search and links](../02-canvases/11-search-and-links.md).

If you end up staring at a browser page and no Rally:

1. Check Rally is installed. If the page says to install Rally, it could
   not find the app. Follow [Install Rally and sign in](../01-getting-started/01-install-rally.md),
   then come back to the link.
2. Click **Open Rally** on the page, if there is one. Your browser may ask
   whether it may open Rally. Say yes.
3. Open Rally first, then the link again. Start Rally from Applications,
   wait for it to finish opening, then click the original link once more.
4. Search instead. If the link is to a Canvas you can open, the search box on
   the Canvases home page gets you there as well. Search for its name.

## Who to ask

- An invitation, a role, or an Organization you cannot get into: an owner
  or administrator of that Organization. Only they can send a new invitation or
  change who belongs. [Roles: owners, administrators, members and guests](../10-running-an-organization/01-roles.md)
  explains who can do what.
- A Canvas you cannot open: whoever shared it, or anyone in it who can add
  you.
- An Organization connection that will not connect: an owner or
  administrator, since only they can manage those.
- Anything that keeps failing after you have tried the fix above: the
  Rally team. [Contacting support](03-contact-support.md) says how, and copying
  the exact sentence from the window into your email saves a round trip.
