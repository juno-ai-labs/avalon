import { BUILDING_LIVE_SITES_SKILL } from "./building-live-sites-skill";
import { READING_AI_CHATS_SKILLS } from "./reading-ai-chats-skills";
import { TRACKING_SEEN_OR_DONE_ITEMS_SKILL } from "./tracking-seen-or-done-items-skill";
import type { HarnessSkill } from "./index";

export { BUILDING_LIVE_SITES_SKILL, TRACKING_SEEN_OR_DONE_ITEMS_SKILL };

/**
 * Skills the harness ships with, for a host that has no library of its own yet.
 *
 * These are ordinary `HarnessSkill` values, not a second source: a host still
 * chooses which to put in `RunHarnessInput.skills`, and the frozen-scope rule is
 * unchanged. They exist because a workspace's first skill should not have to be
 * its own authoring surface, and because a procedure this general — how to
 * research something properly — is the same in every workspace.
 *
 * Authored as TypeScript rather than `SKILL.md` files because this package runs
 * in `workerd`, where there is no filesystem to read them from at startup.
 */

const DEEP_RESEARCH_BODY = `Research is finished when you can say what is true, how you know, and what you
could not establish. An answer without the second and third parts is a guess
with formatting.

## 1. Fix the question before you gather

Write down what would count as an answer. "Look into the Northwind renewal"
becomes: what is the renewal date, what is the amount, who owns it, and has
anything changed since the last time it was discussed. Four checkable claims
beat one vague brief, and they tell you when to stop.

If the request has a decision behind it — a reply to send, a number to commit
to — name that too. It sets how hard you have to work: a date you will put in
front of a customer needs corroboration, a date for your own orientation does
not.

## 2. Go to authorized sources first, public ones second

The connectors loaded for this run see things the public web cannot, and they
are the record this workspace actually runs on. Search them before reaching for
\`web_search\`, and prefer them when the two disagree — a vendor's marketing page
is not evidence about your own contract.

Order that usually holds:

1. The work stream itself and its attached resources — someone may have already
   answered this.
2. Authorized connectors — mail, tickets, documents, messages.
3. The public web, for facts about the outside world only.

If a source you need is not loaded, load its plugin. If it is not available to
this run at all, say so in the answer rather than substituting a public
approximation and hoping.

## 3. Corroborate, and date everything

One source is a claim. Two independent sources agreeing is a finding. Two
sources that turn out to be the same underlying document — a thread quoting an
email, a page summarising the page you already read — are still one source, and
the most common way a research answer is confidently wrong.

Every fact worth reporting has a date. When two sources conflict, the later
dated one usually wins, but say that it was a conflict rather than silently
picking. When nothing is dated, that is itself worth reporting.

Distinguish what was **proposed** from what was **agreed** from what **shipped**.
Most bad research answers are a proposal reported as a decision.

## 4. Track confidence as you go, not at the end

For each claim, keep the source and how directly it supports the claim. A
detail you inferred from two adjacent facts is not the same as one you read.
Doing this while gathering costs nothing; reconstructing it afterwards means
re-reading everything, which is why answers that skip it tend to assert
uniformly and be uniformly trusted.

## 5. Stop deliberately

Stop when the checkable claims from step 1 are answered, or when the next source
is unlikely to change any of them. Exhausting your budget is not a stopping
condition — it is what happens when you never chose one.

If you are running out of room, say what you would have checked next. That is
more useful than a fifth corroboration of the thing you already knew.

## 6. Report the shape of what you found

Lead with the answer, not the search. Then, for each claim, where it came from
and how firm it is. Then — always, not only when it is empty — what you could
not establish: the question you could not answer, the source you could not
reach, the conflict you could not resolve.

Never present an inference as a reading. If you concluded that the renewal is
probably annual because the last two invoices were twelve months apart, say
that; do not write "the contract renews annually".

Research is a read-only activity. It does not send, schedule, or update
anything. If the work needs an action afterwards, prepare it and ask.`;

/**
 * How to answer a question that needs evidence rather than recall.
 *
 * Deliberately about *this run's* sources — the loaded connectors, the work
 * stream, the public web in that order — because the failure mode it exists to
 * prevent is a confident public-web answer about a fact the workspace already
 * holds authoritatively.
 */
export const DEEP_RESEARCH_SKILL: HarnessSkill = {
  name: "deep-research",
  description:
    "How to research a question end to end: scope it into checkable claims, work authorized sources before the public web, corroborate and date every fact, and report what you could not establish.",
  whenToUse:
    "When a request needs evidence gathered and reconciled across more than one source, rather than a single lookup or a direct answer.",
  body: DEEP_RESEARCH_BODY,
};

const WRITING_AN_EMAIL_BODY = `An email leaves the building. Every address, link, and figure in it is a claim
you are making on someone's behalf, so the work is mostly settling those before
you write a word — and the drafting itself is the short part.

This applies to whichever mail connector this run has. Providers differ in what
their tools are called; none of what follows depends on that.

## 1. Settle whether this is a draft or a send

A draft is reviewable and a send is not. Default to a **draft** unless the
request plainly says to send it, and say which you did. When the request is
ambiguous and the message goes to someone outside the work stream, draft it and
say it is waiting for a look.

## 2. Resolve every recipient before composing

Look each person up through the connection's contact or correspondence search.
Use an address exactly as a tool returned it.

- **Never build an address from a name and a company domain.** A person's
  address is a fact about them, not a pattern.
- If the lookup returns **several plausible people**, that is ambiguity, not a
  ranking. Ask which one, listing the candidates and where each was seen.
- If it returns **nothing**, ask for the address — and say what you searched, so
  the person can tell you searched badly rather than that the address does not
  exist.

## 3. Establish who you are sending as

Read the connected account's own identity from the connection rather than
inferring it from a signature, a display name, or a previous message's headers.
Those are somebody's claim about the account; the account is the authority. It
also settles whether you are writing as an individual or a shared mailbox, which
changes how the message should read.

## 4. Source every fact the message asserts

A link, a date, an amount, a name, a quoted decision: each must come from a tool
result in this run, from the task context, or from a person here. A plausible
value is the failure mode, not the fallback — an invented download link is
indistinguishable from a real one until someone clicks it.

A search that returned only identifiers is a **step, not an answer**. Open the
records it named before quoting anything from them.

If a fact cannot be sourced, that is a missing identifier: look it up, or ask.
Do not write around it with something that reads right.

## 5. Decide new thread or reply, then carry the identifiers

A reply belongs in its thread. That usually needs two identifiers from the
**same search result** — the thread's, and the original message's — passed
through exactly as returned. Retyping or mixing them from different results
lands the message somewhere else, or nowhere.

Starting a new thread is the right choice when the subject is genuinely new.
Say which you did.

## 6. Write the message the request actually asked for

Cover every ask in the request, in the recipient's language rather than the
workspace's. Keep it short enough to answer. If the request named things to
include — a link, an address, a question — check each one is present before you
write it out.

## 7. Verify, then report what you did

Do not describe a draft as created or a message as sent unless the tool result
says so. Report the outcome, the recipients you used, and where each address
came from. If you asked for something and are waiting, say that instead.

## Anti-patterns

- **Asking for an address before searching for it.** Search the correspondence
  first; ask only when that comes back empty, and say what you tried.
- **Composing an address from a name and a domain.** Look it up, or ask.
- **Quoting a URL or a figure from memory.** Fetch it, or take it from the
  request. A link nobody verified is the easiest thing in a message to get
  wrong and the hardest for the reader to notice.
- **Answering from a list of search hits.** Read the records before quoting
  them.
- **Sending when a draft was asked for.** Draft by default; sending is the
  irreversible one.
- **Reporting success from an unconfirmed call.** Say what the result said.

Creating a calendar invitation instead? Use **scheduling-a-calendar-event**,
which has the same addressing rule and its own on notifications.`;

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
 * How to send something to a person from an authorized mail connection.
 *
 * Provider-agnostic on purpose: the failures it exists to prevent — an address
 * composed from a name and a domain, a link quoted from memory, a person asked
 * for something the connection could have looked up — are properties of the
 * task, not of any one provider, and the next mail connector will have them too.
 */
export const WRITING_AN_EMAIL_SKILL: HarnessSkill = {
  name: "writing-an-email",
  description:
    "How to write an email that leaves the building: resolve every recipient through the connection before composing, source every link and fact it asserts, thread a reply correctly, and draft rather than send by default.",
  whenToUse:
    "When a request asks for an email to be drafted, replied to, or sent through a connected mail account.",
  body: WRITING_AN_EMAIL_BODY,
};

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

const POLLING_FOR_EVENTS_BODY = `Someone asking to be told **when** something happens is asking for a Sidekick
with a trigger, not for something you can do in this turn. Rally starts a run
only when something tells it to.

Most connectors do declare events Rally can trigger on, so the first move is
always to look. Polling is the fallback for what inspection rules out: a
connection that declares no events at all, or one whose declared events do not
cover what the person described. Reaching for a timer before you have looked is
the most common way to get this wrong.

The whole procedure runs through the Sidekicks plugin; load it before you start.

## Terms used in this skill

- **Canonical Rally resource ID:** Rally's identifier for a registered resource,
  distinct from its provider URL or file ID.
- **Binding:** Restricting an event rule to events associated with one resource
  through the selected connector. For example, a rule bound to one spreadsheet
  ignores changes to other spreadsheets on that connection. Binding does not
  grant access to the file.

## 1. Look for a real event before you settle for a timer

Inspect the plugin for the connector the person named and read the event types
it declares. If one of them covers what they described, trigger on that instead
— a \`connector_activity\` trigger when deterministic filters express the match,
a \`semantic_activity\` one when each event also has to pass a written condition,
a \`webhook\` one when the event types belong to a webhook connection the
workspace has already set up. A real event arrives immediately and costs nothing
while nothing is happening.

Assume the event exists until inspection says otherwise. Notes, meetings,
messages, tickets and mail are exactly the things connectors tend to announce,
so a request about one of them is a request to go and read that plugin's event
types, not a reason to poll.

There is one trigger kind to stay away from: \`resource_watch\` reads as the right
answer for "tell me when this one document changes", and a Sidekick accepted
with only that trigger is never started by anything. Watch the source through
its own declared events, or poll.

Poll only when inspection shows no event type that fits. When you propose the
Sidekick, say in one line that it checks on a timer because that connection does
not announce this — otherwise the person reads the delay as a bug.

## 2. Resolve the specific external resource before binding it

To bind the rule, find the resource's **canonical Rally resource ID** through
resource discovery. When setting evaluator rules, put the returned \`id\` in
\`source.resourceId\` and its \`pluginId\` in \`source.suggestedSourcePluginId\`.
Choose an event whose declared resource relationships include that resource's
type. A provider URL or file ID cannot replace the Rally resource ID.

Search Rally's registered resources for the external file or resource the
Sidekick should monitor. This searches **registered Rally resources**, not the
external provider; reading a file through its connector
does not automatically register it. Read an empty result alongside
\`searchableResourceTypes\`:

- First inspect the selected event's declared resource relationships. The
  search types are a union across connected plugins; a nonempty list does not
  establish that this event supports the requested resource type.
- If that event supports the source's type and the type is listed, use the
  connector to confirm access and obtain the actual title, then search again
  with that title instead of a sentence combining the URL, ID and task. If the
  readable resource still cannot be found, report that the lookup did not
  resolve a registered Rally resource. No connector-resource registration tool
  is exposed here. Name that registration gap rather than a permission denial;
  never invent a Rally ID or substitute the provider's ID.
- If the selected event does not support the source's type or that type is
  absent from the list, registration cannot make it bindable. Use a supported
  container and declared filter fields to express the restriction, or use
  polling when the events cannot express it. This applies even when other
  resource types are listed, as well as when the list is empty.

A search error is a failed lookup; an empty result is a search miss. Neither
establishes that the provider or resource type is unsupported.

## 3. Choose the cadence, no faster than every ten minutes

First, if what they described is a time of day rather than a frequency — "every
morning", "at 5pm on Fridays" — use a \`calendar\` trigger with a recurrence rule
instead of an interval, then carry on through steps 4 and 5, which a timed
watcher needs exactly as much.

Otherwise poll with an \`interval\` trigger and set \`intervalSeconds\`.

**Ten minutes — 600 seconds — is the floor, not the answer.** Every tick spends
a model call and a round of connector reads whether or not anything changed, and
finding nothing is the ordinary outcome.

Slower is usually better, and **the person's own cadence wins** whenever it is
at or above the floor: "check my email hourly" is 3600, "a couple of times a
day" is 43200. Ask what would be soon enough when they have not said; most
people want it less often than you would pick for them. If they asked for
something faster than the floor, use the floor and tell them how often it will
actually check — in words, never in seconds.

Write the trigger's \`summary\` too, in the person's own words — "Every half
hour", "Each weekday morning". It is the line they read on the proposal and
under **When to expect it**, and leaving it out puts a generic phrase there
instead of the cadence they just agreed to.

## 4. Give each run a way to know what it has already seen

Load \`tracking-seen-or-done-items\` to define the memory table, its stable keys, access
steps and first-run baseline. Save that procedure in the Sidekick's run
instructions so both event-triggered and timed runs skip work already completed.

## 5. Write the run so that finding nothing is normal

Most runs will find nothing. Say explicitly in the instructions what such a run
does: finish without posting, sending, or messaging anybody. A Sidekick that
reports "nothing new" every ten minutes is worse than no Sidekick.

Say what a run does when it finds several items at once — one summary covering
all of them is almost always what the person wanted, not one message each.

## Anti-patterns

- **Polling a connector you never inspected.** Most connectors announce the
  thing being asked about. Read the event types first; keep the interval for
  what inspection rules out.
- **An interval under ten minutes because the person said "right away".** Use
  the floor and say so. What they actually want is a webhook: draft one when the
  workspace already has a webhook connection declaring that event, and otherwise
  say that wiring one up is a conversation with the team.
- **Reaching for \`resource_watch\`.** Nothing starts a Sidekick from it. Use the
  source's declared events, or an interval.
- **A run that posts to say it found nothing.** Finish silently instead.`;

/**
 * How to satisfy "tell me when X happens" for a connection with no webhook.
 *
 * Deliberately a loaded skill rather than standing policy: it is irrelevant to
 * almost every turn, and trigger selection plus the cadence floor are
 * too long to carry in the prompt for the few turns that need them.
 *
 * `ownerPlugin` is the Sidekicks plugin, because the procedure is entirely
 * about drafting one — which also keeps it out of the catalog of an automation
 * occurrence, where the drafting tools are deliberately withheld.
 */
export const POLLING_FOR_EVENTS_SKILL: HarnessSkill = {
  name: "polling-for-events",
  description:
    "How to set up a Sidekick that watches for something: inspect declared events, resolve the source resource, choose a polling cadence only when needed, and compose tracking-seen-or-done-items to avoid repeated work.",
  whenToUse:
    "When someone asks to be told whenever something happens — new mail, a finished meeting, a note or ticket added — and you are setting up a Sidekick to watch for it.",
  body: POLLING_FOR_EVENTS_BODY,
  // Spelled out rather than imported from the drafting tools, which import
  // from `./index`, which imports this file: the literal keeps that cycle out
  // of the module graph, and matches how `building-live-sites` names Terminal.
  ownerPlugin: "rally:sidekicks",
};

/** Every skill this package ships. A host picks from these; none is automatic. */
export const BUILT_IN_SKILLS: readonly HarnessSkill[] = [
  DEEP_RESEARCH_SKILL,
  WRITING_AN_EMAIL_SKILL,
  SCHEDULING_A_CALENDAR_EVENT_SKILL,
  // Offered only where the Sidekicks plugin is in scope, by its `ownerPlugin`:
  // the whole procedure is drafting one, and an automation occurrence is
  // deliberately never given the drafting tools.
  POLLING_FOR_EVENTS_SKILL,
  // Available during authoring and execution wherever durable Tables are in scope.
  TRACKING_SEEN_OR_DONE_ITEMS_SKILL,
  // Offered only where the Terminal plugin is in scope, by its `ownerPlugin`:
  // the whole procedure ends in publishing a directory from a sandbox.
  BUILDING_LIVE_SITES_SKILL,
  // Offered only where Rally's browser plugin is in scope: every step reads or
  // drives a page open in it.
  ...READING_AI_CHATS_SKILLS,
];

