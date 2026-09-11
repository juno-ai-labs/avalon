# Sidekick delivery reliability

> Created 2026-09-11.
>
> A scheduled Sidekick that exists to post something somewhere posts it there,
> once, every time, or says why it could not. Companions:
> [`research.md`](research.md), the production investigation this PRD answers,
> and [`design.md`](design.md), the buildable contract for the widened
> `sidekick_post_result` tool.
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Owning documents: [`automation-lifecycle.md`](../../automation-lifecycle.md),
> [`agent-harness.md`](../../agent-harness.md),
> [`agent-tools.md`](../../agent-tools.md),
> [`slack-integration.md`](../../slack-integration.md).

## Summary

A person who sets up "post a joke to #general every hour" gets a joke in
`#general`, top-level, every hour. Today they get one roughly one hour in ten,
sometimes as a reply under the previous joke, sometimes twice, and the rest of
the time nothing, while the Sidekick reports itself active and each run burns
a few hundred model calls failing. This PRD changes four things so that
outcome is structurally impossible rather than merely less likely: where a
Sidekick's result goes becomes a typed object the platform delivers, a tool
parameter the model must not fill becomes one it can decline on the wire, a
provider's refusal of a model-authored argument stops the run instead of
feeding a retry loop, and a run that cannot finish is bounded, visible, and
pauses its Sidekick rather than overlapping the next occurrence.

## Motivation

[`research.md`](research.md) has the evidence in full. The short form: since
the Sidekick was accepted on 2026-09-03 it has attempted `slack_send_message`
about four thousand times a day and succeeded one to eight times a day. Every
failed send carried a malformed `thread_ts` the model invented (`/`, `. `,
`.000001` and so on); every successful send carried either the timestamp of
the Sidekick's own previous joke (so the post landed as a reply to itself) or
no thread at all. The model fills `thread_ts` because the schema it receives
says "a string of at least one character" while only the prose says "or
omit it"; Rally's executor accepts any non-empty string; Slack refuses it; the
refusal reaches the model as an opaque provider error with no field name; a
root run has no tool-call or wall-clock ceiling; and nothing tells anyone.
Runs then last an hour and overlap the next occurrence.

None of that is specific to jokes, to Slack, or to this Sidekick. It is what
happens whenever a Sidekick's only job is a write the model has to author
from scratch every occurrence, through a general-purpose tool whose optional
parameters are presented as required, against a provider whose refusals are
opaque, with no bound on retries and no signal on failure. The repository's
own documents already predicted the first step (a run put `"/"` into a Drive
cursor for the same reason) and counted `thread_ts` among the parameters
deliberately left unconverted. The rest of the chain is the platform's.

The cost of leaving it: every scheduled Sidekick that posts is a coin flip
with a four-figure model-call tax on tails, the person cannot tell whether it
ran, and the failure surfaces only when a teammate asks "what does this even
mean dude" under a joke that landed in the wrong place.

## Goals

1. A Sidekick with a configured Slack channel destination posts there
   top-level, exactly once per occurrence, without the model composing a
   `chat.postMessage` call.
2. A model cannot be handed a tool parameter it must fill but may not
   decline: every optional parameter across every connector's tool surface
   admits absence on the wire, and the sweep that proves it covers the whole
   registry.
3. A provider's refusal of a model-authored argument reaches the model as an
   actionable validation failure naming the field and the provider's reason,
   and the same call is not repeated unchanged.
4. An unattended run is bounded in tool calls and wall clock, one occurrence
   never runs concurrently with the previous one, and the ceilings' numbers are
   the team's to set.
5. A Sidekick that fails to deliver stops failing quietly: the run records
   the provider's reason, the Sidekick profile and run history show it, N
   consecutive failed occurrences pause the Sidekick with a reason and tell
   its author, and operations hears about repeated provider refusals.
6. Every fact in [`research.md`](research.md) that had to be reconstructed
   from four systems is readable from one: the provider error string is
   logged, tool telemetry buckets it, and the engineering tools can open a
   Sidekick run's receipts.

## Non-goals

1. **Re-introducing silent post-run delivery targets.** The 2026-09-03
   decision recorded in `automation-lifecycle.md` removed destinations that
   were chosen at creation and sent by a loop after the run because a run read
   that silence as "Rally has it covered". This PRD keeps that: nothing sends
   unless the run posts to a destination by name. Rejected outright.
2. **Withholding write tools from Sidekick runs.** The same entry removed tool
   narrowing by trigger; a Sidekick that needs an ad-hoc send still makes it
   with its own tools. This PRD makes the configured destination the easy path,
   not the only one. Rejected outright.
3. **A general retry or backoff layer over every connector call.** Provider
   transport faults already traverse Bind's route plan; this PRD touches only
   how a *deterministic refusal of arguments* is classified. Deferred: a
   transport-level retry policy per connector is a separate decision.
4. **Fixing gpt-5.6-terra's tool-call corruption.** The three completion
   defects per run on the send turn are a model or provider fault worth its own
   investigation; this PRD makes the platform robust to whichever model serves
   the turn. Deferred.
5. **Converting every remaining collapsed null branch in this PRD's first
   change.** Goal 2 is met by the registry-wide guard plus the conversions it
   forces; each parameter's meaning of `null` is decided per connector as
   `connectors.md` already requires. Sequenced, not skipped.

## Product behavior

**Setting up.** While drafting, a Sidekick whose instructions say to post to a
Slack channel resolves that channel to a *destination* on the proposal card:
"Posts to #general (top-level) through the Juno Labs Slack installation". The
person sees the destination the way they see a schedule. A destination the
draft could not resolve (no workspace installation, a channel the bot is not
in) blocks acceptance with the same refusal vocabulary a missing connection
uses today, rather than accepting a Sidekick that will fail every hour.

**Running.** The run generates the joke, calls `sidekick_post_result` naming
the destination, and ends. The platform posts the saved text through the
installation's bot token, top-level, with the run id as the idempotency key,
and records the delivery on the run. The model never handles `thread_ts` for
a configured destination. A second call for the same run and destination
answers `replayed` and posts nothing, so a run cannot double-post. Reading the
channel to avoid repeating itself is unnecessary: the run can read its own
Sidekick's delivery ledger.

**Failing.** If Slack refuses the post, the run row records the provider's
reason, the run is `failed` with that reason as its error, and the Sidekick's
run history shows "Slack refused the message: `<reason>`". After N consecutive
failed occurrences the Sidekick pauses itself with `paused_by = 'failure'`,
its sidebar tile and profile show it as paused for failure, its author is
told through the activity log, and operations receives one notice. Resume is
the person's ordinary Resume.

**Bounded.** A Sidekick run that exceeds its tool-call or wall-clock ceiling
ends as `failed` with `run_tool_call_limit_exceeded` or
`run_wall_time_limit_exceeded`, visibly, the way bounded callers already do. A
schedule occurrence that comes due while the previous run is still running is
recorded as skipped on the Sidekick, not admitted, so runs never overlap.

**Any other send.** A Sidekick whose instructions name a place that is not a
configured destination still sends there with its own tools, as today, and the
prompt's result-delivery section still says so; what changes is that the
tools it uses can no longer be given a value for "no thread", and a refusal
comes back as something the model can act on once and then must report.

## Impact on the product contract

None to the brief: Sidekicks remain delegated work, a work stream remains the
place a result lands when a room owns the Sidekick, and no channel, inbox, or
global surface is added. Inside `automation-lifecycle.md` one invariant moves:
"the one way a result reaches a room is `sidekick_post_result`" becomes "the
one way a result reaches a *destination* is `sidekick_post_result`", with the
owning room as the destination every room-owned Sidekick has by construction.
The 2026-09-03 reasoning that "the judgement about where a result should go
belongs with the judgement about what it should say, which is the loop's"
survives intact: the loop still chooses, by naming a destination; what leaves
the loop is the transport.

## Key design decisions

1. **Destinations are objects the run names, delivered by the platform.**
   `AutomationRunDefinitionV1.resultDelivery` becomes a list of typed
   destinations: `{ channel: "workstream", destination }` as today, and
   `{ channel: "slack_channel", connectionId, channelId, channelName }`.
   `sidekick_post_result` gains an optional `destination` (defaulting to the
   only one, refusing ambiguity by name). The SidekickDO owns delivery:
   `deliveries (run_id, destination_key, state, provider_operation_id,
   provider_error, attempted_at)` with `deliveryId = runId` as the idempotency
   key on both sides, so a retried tool call and a retried provider call each
   answer with the delivery already made. *Rejected:* delivering from the run's
   own object with the connector tool under the hood. It would keep the
   model's arguments in the path and put the receipt in an object the
   Sidekick cannot list. *Rejected:* a post-run delivery loop that fires
   without the model calling anything. That is the silent target the
   2026-09-03 entry removed, and Non-goal 1 keeps it out.
2. **Resolve the destination at acceptance, not at run time.** The drafting
   plugin already binds connections at `apply`; a Slack channel destination is
   resolved the same way (installation, channel id, bot membership checked
   through the connector) and stored on the revision. A run reads it by
   revision like everything else. *Rejected:* letting the model resolve the
   channel each run from the instructions. That is the prose-to-tool-call gap
   this PRD exists to close.
3. **Absence is a value on the wire, and a timestamp has a shape.** The
   sanitizer itself stops collapsing a nullable declaration: `@juno-ai/bind`
   14 rewrites `type: [T, "null"]` to `anyOf: [{ type: T, … }, { type: "null" }]`
   for every tool of every consumer, and Rally's `tool-schema-sanitization`
   sweep widens from cursors to every property `droppedNullableBranches`
   reports, so neither a new connector nor a Bind release can ship the
   collapsed shape unnoticed. `send_message.thread_ts` additionally gains a
   `pattern` of `^\\d+\\.\\d+$` on its string branch, and
   `SlackTimestampSchema` enforces the same pattern, so a value that is not a
   Slack timestamp fails as a validation error naming the field before any
   provider call. *Rejected:* converting the 28 collapsed branches one
   connector at a time, which was the first draft of this decision; it fixes
   one repository and leaves the next parameter free to ship the shape. Also
   rejected: description-only repair; `agent-tools.md` records that the
   description was in front of the model four times and lost.
4. **A deterministic provider refusal is a validation failure, not an
   external one.** A connector maps provider codes that mean "your arguments
   are wrong" (Slack `invalid_*`, `channel_not_found`, `msg_too_long`, and
   each connector's equivalents) to a structured failure carrying `field` and
   `reason` through `readStructuredFailure`, so the model reads `kind:
   "validation"` with the field named. The harness additionally refuses to
   execute a `record_before_execute` write whose canonical input hash matches
   a call that already failed with a validation-class error in the same run,
   answering with the earlier failure. *Rejected:* a global "retry at most N
   times per tool per run" counter. It bounds the damage without naming the
   cause, and a model that changes one character each time defeats it; the
   hash rule and the classification together do not.
5. **Unattended runs are bounded, and occurrences do not overlap.** Runs
   with origin `automation_run` get tool-call and wall-clock ceilings through
   the same limit mechanism bounded callers use; the numbers are written open
   and set by the team. `executeSchedule` skips an occurrence whose previous
   run is not terminal and records the skip on the schedule row. *Rejected:*
   stopping the previous run in favour of the new one; a run that is mid-post
   would be cut off to start another that will do the same thing.
6. **Failure is a lifecycle state with an author.** `paused_by` gains
   `'failure'`, set by the SidekickDO after N consecutive occurrences whose
   run ended `failed`, with the run's error carried onto the directory row
   and an `activity_events` entry for the author. `notifyOps` posts once per
   Sidekick per pause. *Rejected:* deleting or disabling the Sidekick; a pause
   the person can resume is the reversible option.
7. **Record what the provider said.** `connector_operation_finished` gains
   `provider_error_code` (the provider's own short code, never its free
   text), `agent_tool_terminal` carries the same bucket, and the engineering
   SQL tool learns to address a Sidekick run's conversation object so a
   receipt's `error_json` is readable during an incident.
8. **Tools that cannot work in an unattended run are not offered to it.**
   `slack_search_messages` and `search` require an `action_token`; a run
   without one does not receive them. *Rejected:* keeping them with a
   description saying so; the first turn of most runs today is that tool
   failing.

## Data model

- `SidekickDO`: `deliveries` table as in decision 1; `schedules` gains
  `last_skipped_at` and `skipped_count`; `automation.paused_by` admits
  `'failure'`; `runs` gains `provider_error_code`.
- `AutomationDraft` / definition revision: destinations stored beside
  bindings; `AutomationRunDefinitionV1.resultDelivery` widened as in decision 1.
- `automation_directory`: `paused_by` and `last_run_error_code` projected for
  the sidebar and profile.
- No backfill: existing accepted revisions have no destinations and behave as
  today until re-accepted.

## Agent behavior

The run gains one typed destination on `sidekick_post_result` and loses two
tools it could never use unattended. The `# Result delivery` prompt section
lists every configured destination by key, kind and label and keeps its empty
arm verbatim for a Sidekick with none. A validation-class refusal now reads as
a failed argument with the field named and the provider's reason; the model is
told to correct once and otherwise report. Everything else the run may do is
unchanged.

The complete contract for the changed tool is [`design.md`](design.md): the
plugin's id, wire prefix, availability and system message; the tool's
capability, `write` mode, idempotency class and timeout; the exact input shape
(`text` required; `destination` optional and nullable, a key copied from the
task context, refused by name when ambiguous or unknown); the delivered and
replayed success object with the next-step ids; every failure with its stable
code, model-visible sentence and forwarded detail keys, and which of them the
model corrects, retries once, or stops on; what is model choice versus
host-derived; and the acceptance tests and evaluations that prove a medium
model can use it. In short: the model chooses the text and, when there is
more than one, the destination; the host owns the channel, the token, the
idempotency key and the delivery record, and never resends a delivery whose
answer was lost.

## Rollout

- **Flag, phase 0 (answered).** The Bind 14 upgrade and the widened guard are
  corrections to what the model is shown, not a feature a person can see, and
  they shipped unflagged on 2026-09-11 at the product owner's direction: the
  owner asked for the sanitizer change in Bind and for this repository to
  adopt the release, which is why `state.md` is `in progress` while the rest
  of the plan is not started. The `thread_ts` pattern and the provider error
  code log line are corrections of the same kind and ship unflagged.
- **Flag, phases 1 and 2 (open).** Failure pausing, ceilings and typed Slack
  channel destinations are behavior a person sees. Whether they ship behind
  `sidekick-typed-destinations-enabled`, default off and registered in Ace in
  the phase that introduces them, is the product owner's call and is recorded
  here as not yet given. No implementing change for those phases lands before
  it is, and the answer is written into this section, either way, in the
  change that lands it.
- **Order.** Phase 0, the same day: pause "Hourly joke in #general"; adopt
  Bind 14 and widen the sweep per decision 3 (shipped alongside this PRD); add
  the `thread_ts` pattern; log `provider_error_code`. Phase 1: decisions 4, 5,
  6, 7. Phase 2: decisions 1 and 2, with the drafting plugin resolving
  destinations. Phase 3: decision 8. A `plan.md` with acceptance gates follows
  approval.
- **Proof.** Each phase carries a test that fails when its behavior is broken
  the way production broke: a `test-workers` run against a Slack double that
  refuses `thread_ts: "/"` must end the run after one refusal; the sanitization
  sweep must fail on a reintroduced type array; the schedule test must record
  a skip while a run is live; the pause test must pause after N failures and
  write the activity row. The e2e lane adds a scheduled Sidekick posting to a
  channel top-level twice with distinct text and no replies.
- **Off switch.** The flag for phase 2; phases 0 and 1 are reverted by
  reverting their changes, and none of them alters stored data a revert
  cannot read.

## Decision log

None yet.
