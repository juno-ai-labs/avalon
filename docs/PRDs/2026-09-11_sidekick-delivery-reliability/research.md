# Why "Hourly joke in #general" posts into its own threads, posts twice, and skips hours

> Investigation record for [the PRD](prd.md), written 2026-09-11 from
> production evidence. Every number below was read from a system named in the
> table at the end; nothing here is inferred from a screenshot alone.

## The Sidekick

| Field | Value |
| --- | --- |
| Workspace | Juno Labs, `019fc068-22e8-739a-8394-a760fdc7c376`, Global |
| Sidekick | `01a06d30-f7be-75da-800c-013620b3d756`, "Hourly joke in #general" |
| Scope | `workspace`, no owning work stream, lifecycle `active` |
| Trigger | one `interval` schedule, every 3,600 seconds |
| Accepted 2026-09-03 22:55 UTC | instructions: "1. Generate one original, concise joke appropriate for a general workplace channel. 2. Do not repeat a joke posted by this automation recently; vary topics and formats. 3. Post only the joke, with no preamble, to the Slack channel #general (channel ID C0A4UF9RWAU)." |
| Recommended plugin | `plugin_slack`, recommended tool `slack_send_message` |
| Sidekick memory scope | exists, zero items, zero durable tables |
| Connector-event registrations | none |

Because no room owns it, every run starts with `resultDelivery` empty and the
`self_delivery` output surface: the prompt tells the run that nothing sends for
it and that posting is its own work with its own tools. The run holds the full
Slack workspace-bot tool surface (`search`, `search_messages`, `read_channel`,
`read_thread`, `send_message`, `add_reaction`, `create_conversation`, and the
rest), the core tools, and the work-stream tools including wake-up scheduling.

## What Slack shows

Every post by the Rally bot since 2026-09-08 is in `#general`; the bot posted in
no other public channel. The three complaints in the screenshot are three
faces of one mechanism:

| Slack time (PDT) | What happened |
| --- | --- |
| 09-10 19:18:06 | joke posted top-level |
| 09-10 20:18:03 | the next joke posted **as a reply under the 19:18 joke** |
| 09-10 20:18:38 | **the same joke** posted again, top-level |
| 09-10 22:18:09 | a joke posted only as a reply under the 19:18 joke |
| 09-11 00:18:11 | a joke posted as a reply under the 20:18 joke |
| 09-11 00:18:38 | **the same joke** posted again, top-level |
| 09-10 21:18, 23:18, 01:18 and every hour after | nothing posted at all |

## What each run did

Harness run ids carry their start time. The six runs of the evening, from the
regional D1 `audit_events` table, Workers Logs, and the Slack channel:

| Run start (PDT) | Model calls | Tool calls | Slack result |
| --- | --- | --- | --- |
| 19:17 | 12 | `search_messages` failed, `send_message` ok | top-level post |
| 20:17 | 14 | `read_channel` ok, `send_message` ok, `send_message` ok | reply under 19:18 joke, then the same text top-level |
| 21:17 | 339 | `read_channel` ok, then `send_message` failed for 13 minutes | nothing; attempt resumed once on a new object instance |
| 22:17 | 12 | `read_channel` ok, `send_message` ok | reply under 19:18 joke only |
| 23:17 | 323 | `send_message` failed until the harness threw | nothing; three resumes, two `workstream_harness_threw` |
| 00:17 | 14 | `read_channel` ok, `send_message` ok, `send_message` ok | reply under 20:18 joke, then the same text top-level |
| 01:17 to 08:17 | hundreds each | `send_message` failed 294, 402, 279, 245, 458, 76, 205 and 62 times in a row | nothing for eight hours; runs of 45 to 100 minutes, each overlapping the next |

The four short runs each spent exactly three inference attempts on
`completion_defect` (gpt-5.6-terra through OpenRouter, attempts 0, 1, 2 of
loop turn 3, the send turn), after which the route's fallback model served the
rest of the run. Success is not logged per attempt, so which model produced
the successful sends is not recorded.

## Since the Sidekick was accepted

Product telemetry (`agent_tool_terminal`, PostHog) for this Sidekick's
`send_message` calls, by day in Pacific time:

| Day | Failed sends | Runs failing | Successful sends |
| --- | --- | --- | --- |
| 09-04 | 3,093 | 15 | 1 |
| 09-05 | 3,542 | 24 | 2 |
| 09-06 | 4,910 | 23 | 3 |
| 09-07 | 4,213 | 22 | 8 |
| 09-08 | 4,233 | 21 | 5 |
| 09-09 (partial) | 2,068 | 14 | 0 |

Every failure is classified `provider_error`: Slack answered the request and
refused it. None is `authorization_denied` or `validation_error`. The Sidekick
has never posted reliably; it has posted roughly one hour in ten and spent
around four thousand model calls a day failing to post the rest.

## The arguments the model sent

The connector observability log (`connector_operation_finished`) copies every
Slack timestamp-shaped argument verbatim as `provider_thread_ts`. For
2026-09-11, 02:00 to 16:30 UTC, grouped by that value:

| `thread_ts` the model sent | Outcome | Count |
| --- | --- | --- |
| `. ` (a dot and a space) | failed | 1,248 |
| `/` | failed | 880 |
| `.000000`, `.000001`, … `.000237` (incrementing across retries) | failed | one each, hundreds |
| `/null`, `.` | failed | a few |
| a fragment of corrupted tool-call text containing other scripts and the literal `assistant to=functions.slack_send_message` | failed | 1 |
| `1789093086.270489` (the `ts` of its own 19:18 joke) | succeeded | 2 |
| `1789096718.980359` (the `ts` of its own 20:18 joke) | succeeded | 1 |
| `1744459200.000000` (well-formed, invented; that instant is 2025-04-12) | succeeded, posted top-level | 1 |
| absent | succeeded | 2 (the two "same text again" top-level posts) |

That table is the whole diagnosis. **Every failed send carried a malformed
`thread_ts`. Every successful send carried a well-formed one, or none.** When
the model had read the channel, the well-formed value at hand was the `ts` of
its own previous joke, so the post became a reply to itself. When it invented a
well-formed one, Slack posted top-level and the hour looked fine. When it
invented a malformed one, Slack refused, and the model retried with another
invented one until something stopped the run.

## Why the model fills `thread_ts` at all

The authored schema for `send_message.thread_ts` is
`{ type: ["string", "null"], minLength: 1, description: "… Omit it, or send null, to post a new top-level message …" }`.
Bind's sanitizer collapses the type array before the model sees it. Run through
`sanitizeToolSchema` and `droppedNullableBranches` in this repository, the
model receives:

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Post as a reply inside an existing thread, as that thread's parent `ts` copied exactly, for example `1735689600.123456`. Omit it, or send `null`, to post a new top-level message in the conversation. Accepts string or null."
}
```

with `droppedNullableBranches` reporting
`thread_ts: authored-null-branch-not-delivered`. The machine-readable half says
"a string of at least one character"; only the prose says "or nothing". The
repository already knows what a caller does with that shape:
[`agent-tools.md`](../../agent-tools.md) records a run that put `"x"`, `" "`,
`"undefined"`, `"null"` and `"/"` twice into a Drive cursor with the same kind
of description in front of it, and its 2026-09-03 rule says a parameter that
may be "none" must say so as a value, spelled `anyOf`, never as a type array.
[`connectors.md`](../../connectors.md) counts 28 collapsed branches still
declared as type arrays, Slack's `thread_ts` among its six, deliberately left
for a per-parameter decision because they are "ids and filters rather than
cursors". `thread_ts` on a write is the one whose wrong answer posts into the
wrong place or posts nothing.

Two things then let a wrong value travel all the way to Slack and back
without correction:

1. **The executor accepts any non-empty string.** `SlackTimestampSchema` is
   `z.string().min(1)`, so `"/"` passes Rally's own validation and is sent.
   A `pattern` of `^\d+\.\d+$` on both the model-facing schema and the
   executor would have refused it as `kind: "validation"` naming the field,
   before any provider call, with an actionable message.
2. **The refusal comes back as an opaque provider error.** Slack's `ok: false`
   becomes `ConnectorError("provider_error", <slack error string>)`; the model
   sees the code and the bare string, no field name and no guidance, and treats
   it as transient. A root run has 1,000 model iterations and no tool-call,
   wall-clock, or cost ceiling, so it keeps inventing values, every 12 to 15
   seconds, for an hour or more, overlapping the next scheduled occurrence.

Slack's own error string is not recorded anywhere reachable by the engineering
tools: the connector log carries only `code: provider_error`, and the receipt
row that holds `error_json` lives in the run's conversation object, which the
SQL tool cannot address for a Sidekick run (it resolves substreams through the
work-stream registry). The `invalid_thread_ts` reading is inferred from the
argument table, not read from Slack.

## Ruled out

- **Sidekick memory** steering the model into threads: the scope has no items
  and no tables.
- **A connector-event trigger** reacting to its own posts: no registrations.
- **Slack ingress** answering its own posts as an agent session: no
  `slack_agent_sessions` row was created during any of these runs.
- **Self-scheduled wake-ups**: no `workstream_schedule_wakeup` call in the
  audit trail.
- **The run-authority fence** (`assertRunAuthorityStillValid`, writes only):
  the failures are `provider_error`, never `authorization_denied`, and sends
  with a well-formed `thread_ts` succeeded in the same runs.
- **Posting elsewhere**: Slack search for the bot's posts finds only `#general`.

## Two side observations

- `slack_search_messages` fails on the first turn of most runs: the bot search
  needs the short-lived `action_token` that only a user-initiated Slack message
  carries, which a scheduled run never has. The tool is offered anyway, costs a
  turn and a failure, and pushes the model toward `read_channel`, which is what
  puts its own message timestamps in front of it.
- Querying the automation's id through the engineering SQL tool's work-stream
  path instantiated an empty `WorkstreamDO` shell under that id (schema only,
  zero rows in every table, no alarms). It is inert. The tool needs a
  Sidekick-aware path before anyone can read a run's receipts.

## Where each fact came from

| Fact | Source |
| --- | --- |
| Definition, triggers, instructions | the authoring conversation's `tool_effects` (`automation_submit_draft`), via `run_substream_sql` on substream `0` |
| Directory row, memory scope, registrations, Slack sessions | `run_workspace_sql` on the WorkspaceDO |
| Posts and threads | Slack `#general` (`C0A4UF9RWAU`) read through the Slack connector |
| Per-run model call counts, defects, resumes, throws | Workers Logs, needle on the Sidekick id, grouped by `substream_id` and `$metadata.message` |
| Per-run tool sequence and outcomes | regional D1 `audit_events`, `workstream_id` = the Sidekick id |
| Per-day send outcomes since acceptance | PostHog `agent_tool_terminal`, `properties.automationId` = the Sidekick id |
| The `thread_ts` values sent | Workers Logs `connector_operation_finished`, `tool_name` = `send_message`, grouped by `provider_thread_ts` |
| The schema the model receives | `sanitizeToolSchema` and `droppedNullableBranches` run locally over the authored schema |
