import type { HarnessSkill } from "../types";

const POLLING_FOR_EVENTS_BODY = `When work should happen **after an external change**, configure a Sidekick:
saved instructions that start a separate run when a schedule or event triggers
it. Doing the work once in this conversation does not set up future runs.

The whole procedure runs through the Sidekicks plugin; load it before you start.

## Terms used in this skill

- **Event:** A message from a connected service saying that something changed.
- **Polling:** Checking the source on a timer for new or changed items.
- **Rally resource ID:** The ID returned by Rally's resource search or
  registration for a file or other source recorded in Rally's resource catalog.
  It differs from the external service's URL or file ID.
- **Binding:** Limiting an event rule to changes associated with one resource
  through the selected connection. For example, a rule bound to one spreadsheet
  ignores changes to other spreadsheets on that connection. Binding does not
  grant access to the file. It is optional: an event with no binding covers the
  whole connected account. New mail anywhere in a mailbox is \`email.received\`
  with no binding; bind a \`gmail_thread\` only to watch one thread, and skip
  step 2.

## 1. Choose the trigger from the request and the available evidence

Follow the branch that matches the request:

- **An explicitly requested schedule:** Keep that schedule and choose its
  trigger in step 3. Event binding may be suggested as an alternative; do not
  silently replace the requested schedule.
- **Work after an external change:** Inspect the named connector's declared
  event types, then resolve the specific source through step 2 **before choosing
  a timer**. If a suitable event and binding can express the watch, configure
  them and continue with steps 4 and 5; no polling cadence is needed.
- **A change that available events cannot express:** Use polling in step 3 only
  after identifying the concrete gap: no suitable event, an event that cannot
  be limited to the requested resource or condition, or a source that remains
  unresolved after step 2.
  An empty lookup establishes an unresolved resource, not an unsupported event.

For a supported event, use a \`connector_activity\` trigger when its filter
fields can express the requested match. Use \`semantic_activity\` when each event
also needs to be checked against a written condition, and the account watched
is the person's you are working for or an Organization connection. When
another person's own account should start the Sidekick, load
\`setting-up-a-filtered-trigger\` as well: the topic goes in that person's
source filter, which they approve, and the trigger stays a plain
\`connector_activity\` one. Inspect which resource types and filter fields the
event supports.

For a change-triggered request, use a suitable event by default: it reacts to
the matching change and avoids repeated unchanged checks. Registering the
requested source through an authorized connection is part of setup; do it
without asking the person to choose registration or polling. Preserve an
explicitly requested schedule unless the person chooses the alternative.

Save a short explanation of the trigger choice in the Sidekick definition's
run instructions:
the selected event and resolved Rally resource (or declared filter when no
resource binding is needed), the concrete reason polling is necessary, or the
explicitly requested schedule. For polling, also explain the actual gap and
expected delay in the user-friendly description. Do not describe an unresolved
resource as a connection that announces no changes.

Do not use \`resource_watch\`: a Sidekick accepted with only that trigger is
never started by anything. Use the source's declared events or justified polling.

## 2. Resolve the specific external resource before binding it

To bind the rule, find the file or other source using Rally's resource search.
When configuring the Sidekick's event rule, put the returned \`id\` in
\`source.resourceId\` and its \`pluginId\` in \`source.suggestedSourcePluginId\`.
Choose an event that supports binding to that resource type. The external
service's URL or file ID cannot replace the Rally resource ID.

Search Rally's registered resources for the external file or resource the
Sidekick should monitor. This searches **registered Rally resources**, not the
external service. Reading a file through its connection does not automatically
register it. Read an empty result alongside
\`searchableResourceTypes\`:

- First inspect which resource types the selected event can bind to. The search
  types cover all connected plugins; a nonempty list does not establish that
  this particular event supports the requested type.
- If that event supports the source's type and the type is listed, register a
  missing external file through the Sidekicks plugin using its URL or external
  file ID and a source plugin that supports registration. Registration verifies
  access and returns the new or existing Rally resource ID and source plugin;
  no second search is needed. Bind that result to the suitable event and submit
  the ready definition without asking for confirmation. Never invent a Rally
  ID or substitute the external service's file ID.
- For a plugin without registration support, use its connector to confirm
  access and obtain the actual title, then search Rally again with that title.
  If the readable source still cannot be found, report that it has no resolved
  Rally resource ID and this connection cannot register it. Do not call that
  a permission denial.
- If registration or binding fails, report the actual failure. Ask only if a
  missing connection, ambiguous source, or fallback would change the requested
  behavior. Offer only actions that the available tools can perform; a search
  miss alone is not a reason to ask for polling or reattachment.
- If the selected event does not support the source's type or that type is
  absent from the list, registration cannot make it bindable. Use a supported
  parent resource, such as a folder, and the event's filter fields to limit
  which changes count. Use polling if those cannot express the requested watch.
  This applies whether other types are listed or the list is empty.

A search error means the lookup failed. An empty result means no match was
found. Neither establishes that the external service or resource type is
unsupported.

## 3. Configure an explicit schedule or the justified polling fallback

Event-triggered watches skip this step. For an explicitly requested schedule or
a polling fallback established in steps 1 and 2, choose the timing as follows.
For a time of day rather than a frequency — "every morning", "at 5pm on Fridays"
— use a \`calendar\` trigger with a recurrence rule
instead of an interval, then carry on through steps 4 and 5, which a timed
watcher needs exactly as much.

For a requested frequency or the polling fallback, use an \`interval\` trigger
and set \`intervalSeconds\`.

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
  the floor and say so. What they actually want is an event: use the
  connector's declared event when it has one, and otherwise say that the
  connector cannot announce this change and the interval is the closest Rally
  can come.
- **Reaching for \`resource_watch\`.** Nothing starts a Sidekick from it. Use the
  source's declared events, or an interval.
- **A run that posts to say it found nothing.** Post nothing; say so in one line in the run's own conversation instead.`;

/**
 * How to configure work after an external change and justify any polling fallback.
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
    "How to set up a Sidekick that acts after a change: inspect available events, find the resource to watch, use timed checks only when needed, and load tracking-seen-or-done-items so later runs skip completed work.",
  whenToUse:
    "When configuring work that should happen after an external change—for example, refreshing a website when a spreadsheet changes, processing new files, or notifying someone. Check whether events can watch the requested resource before choosing a timer.",
  body: POLLING_FOR_EVENTS_BODY,
  // Spelled out rather than imported from the drafting tools, which import
  // from `../index`, which imports this file: the literal keeps that cycle out
  // of the module graph, and matches how `building-live-sites` names Terminal.
  ownerPlugin: "rally:sidekicks",
};
