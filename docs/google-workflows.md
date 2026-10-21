# Google mail and calendar workflows

Rally's native Google connector handles scheduling and mailbox work through the
Google REST APIs. Its tool shapes take cues from Google's preview MCP servers,
while authorization, receipts, pagination and error reporting stay in Rally's
existing connector platform. Read this when changing calendar targeting, inbox
mutations, draft composition, or availability suggestions.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/connectors/src/google-workflows.ts` | Semantic action tools and shared provider operations. |
| `packages/connectors/src/google-selectors.ts` | Exact-ID alternatives, unique Gmail queries and structured local-date selection. |
| `packages/connectors/src/google-availability.ts` | Intersect requested local hours with common calendar availability. |
| `packages/connectors/src/google-recurrence.ts` | Translate calendar repeat schedules to Google recurrence rules. |
| `packages/connectors/src/google-mail-mime.ts` | Multipart email bodies and attachments. |
| `packages/connectors/src/google-tool-schema.ts` | Preserve strict object closure through the provider schema sanitizer. |
| `packages/connectors/src/index.ts` | Credential door, existing readers, reply threading, event creation and output projections. |
| `apps/api/src/services/connection-service.ts` | Map Rally capabilities onto OAuth scopes and refresh the full mail preset on reauthorization. |
| `apps/api/src/services/integrations.ts` | Capability-specific discovery and worked examples. |
| `packages/agent-harness/src/tool-activity.ts` | Distinct transcript labels for mailbox changes, cancellation and RSVP. |

## How it works

### Precise targets without mandatory ID bookkeeping

Known resource IDs are first-class inputs. They bypass discovery and keep a
resource already selected by a person or tool precise. When an ID is unknown,
the connector can resolve a structured selection internally. IDs and selectors
are mutually exclusive; it never silently prefers one over a conflicting other.

Calendar actions accept an exact known `eventId`, or a local `date` with optional
exact `title` and `startTime`. Without an ID, the connector resolves the calendar
time zone, lists expanded occurrences across all pages, filters that selection,
and requires exactly one match. It never chooses the first result. Calendar
read/update tools accept the same alternatives. `calendarId` accepts an ID,
`primary`, or an unambiguous calendar name.

Gmail actions accept the corresponding known `messageId`, `threadId`, or
`draftId`, or a `query` using Gmail operators. Queries require a unique match
before proceeding. This is a deterministic provider search, not interpretation
of a natural-language request. IDs remain in outputs for follow-up operations.

### Cancellation and RSVP

`calendar.cancel_event` cancels one occurrence or a non-recurring event;
`calendar.cancel_recurring_series` cancels its entire series. RSVP has matching
`calendar.respond_to_event` and `calendar.respond_to_recurring_series` tools.
These actions are separate so a model does not have to interpret a scope switch
before a consequential write.

Series actions follow `recurringEventId` to the master internally; single-event
actions refuse a master rather than changing all its instances. A series action
on a non-recurring event is a field-named refusal. Read and write capabilities
are both needed for cancellation and RSVP.

Cancellation requires the selected calendar copy to identify its organizer as
`self`; an attendee receives a pointer to the RSVP tool. RSVP modifies only the
self attendee, preserving other guest records, and refuses an omitted attendee
list. If Google supplies an etag, conditional writes refuse concurrent changes.
`sendUpdates` accepts `all`, `externalOnly`, or `none`, defaulting to `all`.
Tools do not prompt for individual execution approval.

### Event creation and conferencing

`calendar.create_event` creates one timed event using offset-bearing RFC 3339
`start` and `end`. `calendar.create_all_day_event` takes local dates with an
exclusive end. `calendar.create_recurring_event` accepts either form for the
first occurrence and a `repeat` schedule: daily, weekly, monthly or yearly,
optional interval, weekly weekdays, and an inclusive ending date or occurrence
count. The connector builds the RRULE. Recurrence requires an explicit IANA
`timeZone` so daylight-saving transitions preserve the intended local time.

`addGoogleMeetUrl` requests a new Google Meet conference. `googleMeetUrl`
attaches an existing HTTPS Meet URL; using both is invalid. Provider conference
generation can be pending: `conferenceStatus` and `conferenceUrl` report what
Google actually returned. A success receipt does not promise a conference URL
already exists. Updates default to notifying guests about actual event field
changes, while a no-op relative guest change does not mail them.

### Availability

`calendar.suggest_time` takes attendees, an interval, and a duration. It includes
the connected account's primary calendar alongside the attendees. Free/busy
requests are partitioned at Google's published maximum of 50 calendars. Missing
or inaccessible availability refuses the operation; unknown availability never
becomes an empty busy list.

The intersection merges overlapping busy intervals and applies optional local
`startHour`, `endHour` and `excludeWeekends` preferences in the selected IANA
zone. Each result gives the proposed start and duration-sized end, plus
`availableUntil` for the remaining free window. `preferences.maxResults` is an
optional caller-selected result count; omission imposes no new count cap.

### Inbox management

Inbox actions have distinct semantic tools: `gmail.archive`, `move_to_inbox`,
`mark_read`, `mark_unread`, `star`, `unstar`, `mark_important`, `unmark_important`,
`mark_spam`, `unmark_spam`, `trash`, and `restore_from_trash`. Each accepts an
exact known `threadId` or a unique Gmail query. Restore and unmark Spam add the
corresponding folder search internally. Exact IDs bypass search.

`gmail.label` and `gmail.remove_label` apply custom label names or known IDs to
the selected conversation, resolving names and refusing ambiguity internally.
`gmail.list_labels` discovers IDs and exact names; `gmail.create_label` creates
a custom label. Shared private label and trash primitives implement these
public actions without making the model compose provider operations. Thread
changes affect current messages, not future messages. Restore removes Trash;
it does not promise Inbox placement. No permanent-delete tool is exposed.

Inbox mutations require **`gmail.modify`**, a separate Rally capability. Its
Google OAuth scope is `gmail.modify`, already used by the existing mail preset.
New connections and explicit refreshes of the complete Mail + Calendar preset
request the expanded preset. A refresh of narrower custom grants preserves them.
Starting OAuth does not change stored grants; the authorized callback commits
the new list. Existing stored grants are not silently upgraded: `gmail.read`, `gmail.draft`, and
`gmail.send` retain their previous authority. Calendar operations use existing
calendar scopes.

### Drafts and rich messages

`gmail.list_drafts` returns draft and message IDs separately, metadata and an
openable address. `gmail.read_draft` retrieves bounded body text and attachment
metadata using a known draft ID or unique query. Lists use the existing opaque
continuation mechanism and echo their applied query.

`gmail.create_draft` and `gmail.send` create new conversations with flat `to`,
`subject` and `body` arguments. `gmail.create_reply_draft` and `gmail.reply` take
`body` plus a known `messageId` or unique Gmail query; they read the source and
resolve subject, ancestry and Reply-To/From recipients internally (the original To for sent mail). Optional `to`
overrides the reply recipient; this is not automatic reply-all. There is no
public new/reply kind switch or caller-supplied threading state.

Both draft and send accept optional `bcc`, `htmlBody`, `attachments`, and
`includeSignature`. `body` is the plain text alternative; HTML is explicit.
Attachments carry standard base64 bytes, MIME type and filename. Reply subject
and ancestry come from the original message on the same account. Signature
lookup requires `gmail.read` and reads the default send-as signature; it does
not infer a signature from correspondence.

MIME contains a plain/HTML alternative when requested, wrapped in multipart/mixed
when files are attached. Base64 lines follow RFC 2045; filenames use RFC 2231
encoding. Header line breaks in filenames and invalid MIME types are refused.
The plain-text-only path and its reply/subject header folding remain unchanged.

Strict schemas are converted in input mode. Composition and workflow objects
use `additionalProperties: { not: {} }` to reject unknown keys. Bind preserves
this schema-valued constraint while removing boolean
`additionalProperties: false` for xAI compatibility. This replaces optional-key
combination expansion, whose size would multiply with each composition option.
Execution remains strict. Cross-field requirements such as ID versus query run
through the validation hook; provider schema roots remain plain objects as
required by the tool platform.

## Invariants

- A single-event tool cannot mutate a series master; cancellation tests assert
  the exact DELETE target and refusal without a DELETE.
- RSVP preserves everyone else's invitation and response; tests check the
  complete resulting attendee list.
- Known IDs bypass discovery; selector tests assert literal provider targets.
  Queries and calendar selection refuse ambiguity, because choosing the first
  match could silently mutate the wrong resource.
- Inaccessible availability never produces a suggestion; tests refuse a single
  unreadable attendee calendar.
- A read-only Rally grant cannot mutate a mailbox despite the broader provider
  token; the inbox authority test asserts no HTTP call. OAuth handoff tests
  verify that explicit Refresh updates only the complete Mail + Calendar preset
  and leaves stored grants unchanged until authorization finishes.
- Unknown mail write keys remain invalid in actual provider request schemas;
  `apps/api/test/tool-schema-sanitization.test.ts` runs Ajv over captured
  OpenRouter and Azure requests and compares validation with execution.
- Writes retain `record_before_execute` receipts. An ambiguous or uncertain
  write is not blindly retried. Tool surface changes fence older receipts.

## Boundary

This module owns tool intent and provider translation. The connector host owns
credential renewal, principal checks, capability intersection, receipts, and
continuation handles; see [connectors](connectors.md) and
[agent tools](agent-tools.md). It does not adopt Google's preview MCP transport
or expose fuzzy calendar search, advanced reminders, guest permissions,
visibility controls or special event types. Attachment download and platform
file-to-MIME resolution are outside this module; composition takes supplied
base64 bytes.

## Failure modes and limits

Invalid input names its field through shared Zod diagnostics and validation
hooks. Ambiguous selectors/labels, unavailable calendar access, master versus
occurrence mistakes, and missing organizer/attendee authority have typed
recovery guidance. A failed calendar etag condition refuses the mutation and
requires a fresh read. Provider authorization and quota failures use the existing
credential door.

Existing Google response/text bounds remain authoritative. Draft pages use
Google's published 500-item maximum. Availability follows the published
50-calendar free/busy maximum. MIME's 76-character base64 lines are a protocol
requirement. No new timeout, retry ceiling, attachment count cap, or arbitrary
scheduling horizon is introduced.

## Testing

```bash
pnpm --filter @rally/connectors exec vitest run src/google-workflows.test.ts src/google-selectors.test.ts src/google-recurrence.test.ts src/google-availability.test.ts src/google-mail-mime.test.ts src/index.test.ts src/agent-plugin.test.ts
pnpm --filter @rally/api exec vitest run test/tool-schema-sanitization.test.ts test/tool-schema-descriptions.test.ts test/connector-tool-selection.test.ts test/connector-oauth-handoff.test.ts
```

Only Google's HTTP API is doubled. Tests verify requests, typed failures,
projections and MIME output without sending mail or changing live events. They
do not establish production OAuth consent or live delivery. Historical Google
tool definitions are retained as a fixture so the pagination compatibility test
does not depend on today's expanded tool surface.

## Google preview MCP comparison

The 2026-10-21 audit queried unauthenticated JSON-RPC `tools/list` on Google's
Calendar and Gmail endpoints; it did not call tools or access user data. The
live catalogs returned **9 Calendar tools and 23 Gmail tools**. The Gmail
reference index lagged the live catalog, so inventory counts came from the
servers. These are separate product servers in Google's
[Workspace developer preview](https://developers.google.com/workspace/guides/configure-mcp-servers),
with official [Calendar setup](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server)
and [Gmail setup](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)
guides. Preview inventories can change; this comparison is a dated observation.

| Google Calendar MCP tool | Rally equivalent or remaining gap |
| --- | --- |
| `list_events` | `calendar.list_events` |
| `get_event` | `calendar.read_event` |
| `list_calendars` | `calendar.list_calendars` |
| `suggest_time` | `calendar.suggest_time` |
| `create_event` | Distinct timed, all-day and recurring creation tools |
| `update_event` | `calendar.update_event`; advanced reminder/guest/visibility settings remain absent |
| `delete_event` | Distinct single-event and recurring-series cancellation tools |
| `respond_to_event` | Distinct single-event and recurring-series RSVP tools |
| `search_events` | Bounded `list_events` query and structured dated selection; no equivalent broad semantic-search tool |

| Google Gmail MCP tool | Rally equivalent or remaining gap |
| --- | --- |
| `create_draft` | Distinct `gmail.create_draft` and `gmail.create_reply_draft` |
| `list_drafts` | `gmail.list_drafts` |
| `get_draft` | `gmail.read_draft` |
| `get_thread` | `gmail.read_thread` |
| `get_message` | `gmail.read_message` |
| `search_threads` | `gmail.search` returns message hits with thread IDs; direct conversation selection uses unique Gmail queries |
| `label_thread` | `gmail.label` |
| `unlabel_thread` | `gmail.remove_label` |
| `apply_sensitive_thread_label` | Distinct inbox/read/star/important tools |
| `trash_thread` | `gmail.trash` |
| `untrash_thread` | `gmail.restore_from_trash` |
| `mark_thread_spam` | `gmail.mark_spam` |
| `unmark_thread_spam` | `gmail.unmark_spam` |
| `list_labels` | `gmail.list_labels` |
| `create_label` | `gmail.create_label` |
| `label_message` | Gap: mailbox mutations currently operate on conversations |
| `update_message_labels` | Gap: no atomic combined per-message label changes |
| `unlabel_message` | Gap: no single-message label removal |
| `apply_sensitive_message_label` | Gap: single-message inbox/read/star/important state |
| `trash_message` | Gap: single-message Trash |
| `untrash_message` | Gap: single-message restore |
| `mark_message_spam` | Gap: single-message Spam |
| `unmark_message_spam` | Gap: single-message Spam removal |

Google's composition parameters informed BCC, explicit HTML/plain alternatives,
signature inclusion, MIME attachment parts, conferencing and notification
controls. Rally deliberately composes parent-series resolution, reply ancestry,
recipient lookup and label-name resolution inside semantic actions. It retains
known IDs rather than forcing searches for already-resolved resources. Rally
also retains direct sending, profile identity and correspondence-based contact
finding, which were absent from these live MCP catalogs.

Remaining work beyond these workflows includes: broad event search,
advanced event configuration, message-level mailbox actions, broader recurrence
editing and attachment download/platform-file resolution. Conversational inbox
actions do not claim message-level parity with Google's catalog. A future
message-level action should be a distinct semantic tool rather than a target
kind switch on today's conversation action.

## Changelog

### 2026-10-21 — Everyday mail and calendar actions share the connector boundary

**What changed:** Added distinct occurrence/series cancellation and RSVP,
availability suggestions, recurring/all-day events and Meet conferencing,
reversible inbox mutations, draft discovery and rich composition.

**Why:** Rally could locate a recurring standup but could not cancel one dated
occurrence. Google's live MCP inventories also exposed missing everyday inbox
and scheduling actions. Semantic actions compose provider reads/writes internally
to reduce model bookkeeping; known IDs stay available and selectors refuse
ambiguity. Rich composition made optional-key schema expansion impractical, so
closed objects use a preserved schema-valued unknown-property constraint. Existing Refresh reused the old grant list, so
reauthorizing the complete preset explicitly requests its new inbox capability;
narrower custom grants keep their authority.

**Considered and rejected:** Replacing the native adapter with preview MCP
servers would discard existing send, profile and contact tools and add a second
transport/OAuth lifecycle. A general operation selector makes medium models
choose both a tool and operation; banning IDs makes resolved targets less
precise. Granting inbox writes through `gmail.read` merely because Google's
provider token is broader would break Rally's independent frozen-grant boundary.

**Consequences:** Existing connections need an explicit reconnect to acquire
`gmail.modify`; Refresh expands only the complete Mail + Calendar preset at
explicit reauthorization, preserving narrower custom grants. Future recurring operations must preserve the occurrence/series
distinction and exact-ID alternatives. New mail options must retain unknown-key
rejection through the provider schema sanitizer.
