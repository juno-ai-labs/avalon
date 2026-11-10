import type { HarnessSkill } from "./index";

/**
 * Setting up a Sidekick that starts on several people's events, each person's
 * filtered by a written condition they approve.
 *
 * The procedure is short on rules and long on judgement on purpose. The
 * filter's text is the one thing a classifier sees of the person's intent, and
 * the person approving it sees the same text, so the skill gives the model the
 * facts it needs to write it well (what one event carries, how it is judged,
 * what the person is agreeing to) and a way to try it, and leaves the wording
 * to the model. `docs/sidekick-sources.md` owns the mechanism.
 *
 * `ownerPlugin` is the Sidekicks plugin: every step uses its tools, which is
 * also why the skill may name them.
 */
const SETTING_UP_A_FILTERED_TRIGGER_BODY = `Use this when a Sidekick should start on events from **people's own accounts**
(new mail in two people's inboxes, for example), especially when only events
about one topic should get through. Two records make this work, and they are
separate on purpose:

- The Sidekick's **trigger** says which kind of event starts it. It is part of
  the Sidekick's definition, and anyone who manages the Sidekick can change it.
- A **source** is one person's permission for events from their account to
  start this Sidekick, with an optional **filter** in their own words. Only
  that person can approve it. Nobody who edits the Sidekick can widen it.

A source lets events in and nothing else. It does not let the Sidekick act as
the person or use their account's tools; that is delegation, which is a
separate thing to ask for and usually not needed here.

## 1. Settle what is being asked of whom

From the request, decide: the connector and event type (inspect the
connector's declared events; new mail is the Google connector's
\`email.received\`), the people, and whether each person's events are filtered.
People can have different filters: "all of mine, only the fundraising mail of
hers" is two asks.

Resolve each person to an Organization user before going further. If a name
matches nobody or more than one person, ask which.

## 2. Write the filter as a claim about one event

The filter is judged against **one event at a time**, by a classifier that
sees only that event's title, summary and a short snippet. For new mail that
is the subject, the sender, and the first line or two of the message. It never
sees the rest of the body, the thread, or other mail.

That is all the evidence there is, so write a filter this evidence can settle:

- State what an event must be **about**, as a plain claim: "The email is about
  a pre-seed or seed investment round in a specific company: a pitch, an
  intro to a founder, terms, a data room, or an update from a company being
  considered."
- Say what **counts** and what **does not**, where the line is not obvious.
  Near misses are what a filter gets wrong: a newsletter that mentions
  funding, a calendar invite, an automated receipt. Name the ones this request
  makes likely.
- Use the words the mail itself would use. Senders, company names, and subject
  phrases the person mentioned are strong evidence; include them.
- Keep it to one topic. Two topics are two asks, or one filter that names both
  plainly.
- Leave out what one event cannot show: what happens later, how important it
  is to someone, how many there have been. Those belong in the Sidekick's
  instructions, which run after the event is let in.

The filter is also what the person reads when they are asked. Write it so a
person would recognise it as what they agreed to share, in ordinary words,
with no instructions to a model in it. When the request leaves real doubt
about how wide the person means, ask them before writing it wider.

## 3. Try it before asking anyone

Use \`sidekick_test_source_condition\` to try the draft on recent events from
the account of the person you are working for. Read the result as evidence:

- An event that should get through and did not: find what in its subject or
  snippet the filter failed to name, and name it.
- An event that got through and should not have: add it to what does not
  count.
- Too few recent events to tell, or none on topic: say so, and rely on the
  wording. Do not loosen the filter to make the numbers look better.

Revise and try again until the events it lets in are the ones the request
means. A filter is a person's permission, so when a choice is close, prefer
the narrower wording: a missed event can be widened later by asking again,
and an event that should not have been shared cannot be taken back.

## 4. Save the trigger, then ask

1. Give the Sidekick an ordinary event trigger for that event type on the
   account of the person you are working for, and save the definition. Do not
   also add a written condition to the trigger that repeats the filter: each
   person's filter already decides what gets through, and a second copy only
   judges the same event twice.
2. Ask with \`sidekick_request_source\`: the people, the connector, the event
   types, and the filter. Include the person you are working for when their
   own events should be filtered too; theirs is approved at once. Use one ask
   per filter.
3. Tell the person what happens next, plainly: who was asked, that each of
   them decides in Rally or from the email they were sent, and that a person's
   events start arriving only after they approve. An ask is not an approval;
   never report one as the other.

\`sidekick_sources_list\` shows who has approved and who has not.

## 5. Write the run instructions for what a run actually receives

Each run starts with the event that was let in and, for mail, the full text of
that one message. Write the Sidekick's instructions to work from that. A run
cannot search or read a mailbox whose owner only shared a source, so do not
write instructions that tell it to; if the work truly needs more than the one
message, say so to the person, because that is asking the mailbox's owner for
delegation.

## Changing a filter later

Ask again with the new filter. The person approves the new wording, and until
they do the old one stays in force. Editing the Sidekick's instructions or
trigger never changes anyone's filter.

## Anti-patterns

- **Putting the topic only in the Sidekick's instructions.** Then every event
  from the person's account reaches the run, which is exactly what they did
  not agree to. The topic goes in the filter.
- **A filter that is an instruction** ("ignore spam and only pass important
  deals"). Write a claim about the event instead.
- **A filter that needs the body.** The classifier never sees it. Anchor the
  filter on what a subject, a sender and a first line can show.
- **Enrolling the person as a delegate to get their mail.** That lends the
  Sidekick their whole account. Ask for a source.
- **Reporting the Sidekick as covering someone who has not answered.** Say who
  is still being asked.`;

export const SETTING_UP_A_FILTERED_TRIGGER_SKILL: HarnessSkill = {
  name: "setting-up-a-filtered-trigger",
  description:
    "How to make a Sidekick start on events from people's own accounts, such as new mail in several inboxes, with a written filter each person approves so only matching events get through: write the filter, try it on real events, and ask each person.",
  whenToUse:
    "When a request names another person's account as what should start a Sidekick, or asks for only events about a topic to get through, for example a dashboard fed by two people's email about one subject.",
  body: SETTING_UP_A_FILTERED_TRIGGER_BODY,
  // Spelled out rather than imported, as `polling-for-events` does: the
  // drafting tools import from `./index`, which imports the skill list.
  ownerPlugin: "rally:sidekicks",
};
