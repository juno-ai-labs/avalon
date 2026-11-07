---
title: Tools and delegation
description: What a Sidekick can use, the custom tools it can be given, and whose access each run works with.
---

A Sidekick is only as useful as what it can reach. This page covers the tools a
Sidekick works with, the custom tools it can be given of its own, and the
**Delegation allowed** list that decides whose access it uses in your other
tools.

## The tools a Sidekick uses

A Sidekick's run has the same kinds of tools Rally has in a Canvas: the web,
its private computer, image and voice making, and the tools your Organization
and its people have connected, such as Gmail, Slack, Linear or GitHub (see
[How Rally works](../04-working-with-rally/01-how-rally-works.md) and
[Connecting your other tools](../05-connecting-your-tools/index.md)). The
details column lists the tools the Sidekick uses.

A Sidekick works without stopping to ask permission for each step. Like Rally
in a Canvas, it never shows "are you sure?" before it sends a message or files
an issue. That is why the instructions, and the Delegation allowed list below,
matter.

## Custom tools

Some jobs are the same handful of steps every time: fetch these rows, add up
that column, compare with last week, flag anything over ten per cent. Rather
than working the steps out afresh on every run, a Sidekick can be given a
**custom tool** that does them.

You do not write the tool. Describe the method to the drafting assistant
("every run, total the refunds per region and compare with last week"), and it
can write a small program, test it against your real data in the setup
conversation, and save it as a named tool with the Sidekick. Every run after
that has the tool and uses it like any other. The custom tool shows in the
Sidekick's details column.

A custom tool can only call the tools the run already has, with the same access
checks. It has no internet of its own and no passwords, so it cannot reach
anything the Sidekick could not reach without it. Changing or removing a custom
tool is another request to the drafting assistant, and saves a new version of
the Sidekick.

## Delegation allowed

When a run reads your calendar or posts in Slack, it has to do so as somebody.
The details column has a **Delegation allowed** section: the people the
Sidekick may act as, "using their current access to carry out its work". Each
person on the list shows whether they are **Available** or **Not allowed**.

- **The creator is on the list from the start**, marked **Creator**.
- **Anyone else adds or removes themselves.** Click **Allow this Sidekick to act
  as me** to join, and **Stop allowing this Sidekick to act as me** to leave.
  You can also ask Rally to do it for you.
- **Nobody can add you but you.** Being shared on a Sidekick, or talking in its
  conversation, does not add you to the list.

"Current access" means what the person can reach right now. If someone loses
access to a Google Drive folder, the Sidekick loses it through them at the same
moment. If they leave the Organization, they show as unavailable.

If nobody is on the list, it says **No one currently allows this Sidekick to act
as them**, and the Sidekick can only use tools that need nobody's access.

### Whose access a run uses

| The run was started by | It acts as |
| --- | --- |
| A schedule, an event, a webhook or an email | Anyone on the Delegation allowed list who has the access the step needs |
| A message from someone on the list | The same: anyone on the list |
| A message from someone not on the list | That person only, with their own access |

For a request from someone not on the list, a step that would need another
person's access is refused, and the run says why rather than quietly using
someone else's account. So "what is on Priya's calendar on Friday?" asked by
Theo gets an answer only if Theo could look at Priya's calendar himself.

When several people on the list could do a step, the run picks one who has the
access, and if that person turns out not to, it tries the next. The run's
receipts record who it actually acted as for each step, so you can check later
whose account sent that email.

> [!IMPORTANT]
> Leaving the list stops future steps from using your access. It does not undo
> anything the Sidekick already did as you.

Next: [Where a Sidekick's results go](07-where-results-go.md).
