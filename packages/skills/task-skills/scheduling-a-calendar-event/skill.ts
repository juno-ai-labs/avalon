import type { HarnessSkill } from "../../types";

const SCHEDULING_A_CALENDAR_EVENT_BODY = `Putting something in a calendar is an outward-facing write: it appears in other
people's days and usually mails them about it. Treat creating an event and
changing one as the same job, because the same three things decide whether it
goes well — when it is, who is on it, and what the write will notify.

This applies to whichever calendar connector this run has, whatever its tools
are named.

## 1. Settle the time, with a real zone

A time without a zone is not a time. Resolve every time to an explicit offset or
named zone before writing anything.

Get the current date and zone from the clock rather than inferring them from
timestamps in the transcript, which may be old. Relative dates — "next
Tuesday", "tomorrow morning" — resolve against the actual current date, and
should be echoed back as an absolute date when you report.

If the request gives no zone and the participants sit in more than one, that is
worth one question rather than a guess.

## 2. Settle which calendar

A connection may see several. If the request names one, use that; if it names
one ambiguously and more than one matches, ask which, listing them. Otherwise
use the connection's default.

## 3. Resolve every attendee to a real address

Look each person up the way **writing-an-email** describes: through the
connection's contact or correspondence search, used exactly as returned, never
built from a name and a domain. An invented attendee either bounces or invites a
stranger.

## 4. Know what the write will send before you make it

Adding attendees sends real invitations. Changing an event's attendees, time, or
place notifies everyone still on it. That is usually correct — but it means a
careless write is not a private mistake, and a no-op write still mails people.

If you are unsure whether a change is wanted, say what you are about to do and
ask, rather than sending and apologizing.

## 5. Changing an event: say what changes, not what the list should be

"Add Katherine to the Tuesday call" is a **relative** change. Express it as the
addition it is. Where the only available shape is the complete resulting list,
read the event first and carry every existing guest across, including their
responses — replacing a list with the one person you meant to add removes
everybody else and mails them about it.

If the guest list you read back looks **incomplete or truncated**, stop. Do not
reconstruct a list from a partial view; say what you could see and ask.

Change only the fields the request names. Leave the rest alone.

## 6. Look for the event before creating another one

"The recurring Tuesday call" is an existing event, not a new one. Search before
creating, and when you find a series, be explicit about whether the request
means one occurrence or all of them — they are different writes with different
blast radii. Ask when the request does not say.

## 7. Verify, then report

Do not describe an event as created or updated unless the tool result says so.
Report the absolute date and time with its zone, the calendar, who is on it, and
who was notified. If you changed a guest list, say who is on it now.

## Anti-patterns

- **Setting the whole guest list when asked to add one person.** Express the
  addition; if you must send a full list, read the current one first and carry
  it across.
- **Writing a time without a zone**, or resolving "next Tuesday" against a
  transcript timestamp. Ask the clock.
- **Inventing an attendee address.** Look it up, or ask.
- **Creating a second copy of an event that already exists.** Search first.
- **Making a no-op write.** If nothing actually changes, do not write — the
  notification still goes out.
- **Reporting success from an unconfirmed call.** Say what the result said.

Composing the message rather than the invitation? Use **writing-an-email**.`;

/**
 * How to put something in someone's calendar without disturbing what is there.
 *
 * Creating and amending are one skill because they share the decisions that go
 * wrong: the zone, the guest list, and who the write notifies. The relative
 * attendee rule is the load-bearing part — the failure it prevents empties a
 * guest list and mails everyone about it.
 */
export const SCHEDULING_A_CALENDAR_EVENT_SKILL: HarnessSkill = {
  name: "scheduling-a-calendar-event",
  description:
    "How to create or change a calendar event safely: settle the time with a real zone, resolve attendees through the connection, express a guest-list change as what changes, and know what the write notifies.",
  whenToUse:
    "When a request asks to schedule, move, or change a meeting or event on a connected calendar, including adding or removing attendees.",
  body: SCHEDULING_A_CALENDAR_EVENT_BODY,
};
