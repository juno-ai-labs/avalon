# Naming a schema failure

A `ZodError` knows exactly what was wrong and where. This document is about the
boundaries that throw that away, why each one looked reasonable when it was
written, and the one primitive that closes them.

## The rule

**A rejection that reaches a log, an operator notice, a caller across an RPC
hop, or a person must name the field it rejected.** The rule is in
[`AGENTS.md`](../AGENTS.md#naming-a-schema-failure); this is the reasoning and
the catalogue behind it.

## Why this needs a rule

Between 2026-09-14 and 2026-09-15, four boundaries in one incident each
reported a failure as something that named nothing. They were not all the same
underlying bug — two were `fireflies` missing from `ConnectorTypeSchema`, one
was a Fireflies response whose shape had drifted, one was a Granola webhook
endpoint that was never provisioned. What they share is the pattern: a reason
that had already been computed, discarded at the boundary that existed to report
it, so each cost its own diagnosis.

| Boundary | What it reported | What it had |
| --- | --- | --- |
| Durable Object RPC (`applyExternalEventRegistrations`) | `ZodError` | `evaluators.0.source.connectorType:invalid_value` |
| `scheduledAlarmErrorCode` → operator notice | `handler_error:Error` | the same, once the message survived |
| `connectorObservationErrorCode` (`get_meeting_summary`) | `unexpected_error` | the path in the provider's response |
| `healthCheck` instrumentation (Granola) | `unhealthy` | "Granola webhook endpoint identity is missing" |

Each is a real diagnosis, already computed, discarded at the boundary that
existed to report it. The cost was not four log lines. It was a week in which a
Sidekick showed as published, delivered nothing, and gave nobody a reason.

None of the four was careless. Each is a sensible-looking default:

- **The RPC one is a platform behaviour, not a choice.** Workers RPC reduces a
  thrown `ZodError` to a bare `Error` — `structuredClone` of one keeps `stack`
  and nothing else. Code that "just throws" silently loses everything.
- **The two `*ErrorCode` helpers are correctly conservative.** They refuse to
  copy an arbitrary runtime message into an indexed log field, which is right:
  provider prose and member content must not land there. They were simply never
  told that a schema rejection is the one such error whose *structure* is safe.
- **The health-check one is an asymmetry.** An adapter that throws gets a `code`
  logged; an adapter that returns `{ ok: false, message }` got nothing. Granola
  returns.

## What is safe to carry

**Issue codes and *declared* field names are schema shape. Everything else is
data.** The API's `errorHandler` draws the same line when it records
`validation_issues` but withholds `detail_keys`' values.

So `summary.topics_discussed.0:invalid_type` may be logged and may cross an RPC
hop. What was in that array may not.

The line is narrower than "the path is safe", which is where the first version
of this got it wrong:

- **`issue.path` is only schema shape when the schema declares its keys.** Under
  `z.record`, the segments are keys of the rejected *value*. A schema keyed by
  email address, document title, or token would put that key into a log line, a
  code crossing an RPC hop, and — through `scheduledAlarmErrorCode` — an
  operator notice posted to Slack. Sanitizing it to the code's character class
  does not help: `alex@juno-labs.com` becomes `alex_juno-labs.com`, which is the
  same value with the punctuation moved.
- **`issue.keys` on `unrecognized_keys` come from the rejected object**, not the
  schema. Between two of our own binaries that is the whole diagnosis of a
  version skew. On a provider's response it is whatever the provider sent.

`describeZodIssues` therefore emits a path segment only when it is an array
index or looks like a declared property name — a JavaScript identifier — and
replaces anything else with `_key_`. The shape of the segment decides because
nothing on a `ZodIssue` says which kind it is. That bounds the exposure rather
than reasoning about it, which is the trade a diagnostic should make.
`namesUnknownKeys` opts into the `unrecognized_keys` names, and only
`parseRpcInput` passes it, because only there is the caller this deployment's
own code.

## A returned failure owes a code, not its message

An adapter's `message` is written for a person and an adapter may fill it from a
caught provider error — `x.ts` returns the provider body's own `message` field
verbatim. `redact` keys on field names, so nothing downstream would catch that.

So `healthCheck` results carry an optional `reasonCode`: a literal the adapter
writes, naming a condition it already distinguishes, and that is what the
instrumentation logs. An adapter that sets none logs nothing new. Granola sets
`webhook_endpoint_identity_missing` and `webhook_endpoint_absent`, which are the
two conditions that made its connection unusable while the log said `unhealthy`.

## The primitive

`@rally/contracts`' `zod-diagnostics.ts`, reachable from every package:

- `describeZodIssues(error, options?)` — the failing paths and codes, first
  three, with non-declared segments withheld. `namesUnknownKeys` opts into
  `unrecognized_keys` names and belongs only on a boundary between our own
  components.
- `codeShaped(text)` — reduced to the character class and length a code-shaped
  field will carry.
- `isCodeShaped(text)` — whether a message already has that shape, which is
  the test a boundary applies before copying a thrown message into an indexed
  field or a notice: no whitespace, so it cannot be prose.
- `zodDiagnosticCode(error, label)` — a named code, or `null` for anything that
  is not a schema rejection, so a caller keeps its own vocabulary everywhere
  else.
- `DIAGNOSTIC_CODE_MAX_LENGTH` — 120, matched to `scheduledAlarmErrorCode`'s
  bound, which is the narrowest consumer.

One implementation, deliberately. The first version of this idea lived in one
file, spelled the root path `(root)`, and put parentheses outside the character
class the operator notice required — so the whole-value mismatch, the case with
the least other evidence, degraded to `handler_error`. A boundary that writes
its own is a boundary that drifts.

## Where it is used

| Call site | Reports |
| --- | --- |
| `apps/api/src/lib/rpc-input.ts` | `parseRpcInput` throws a message that survives an RPC hop |
| `packages/connectors/src/observability.ts` | `connectorObservationErrorCode` names a provider-response mismatch |
| `packages/connectors/src/observability.ts` | `healthCheck` logs a returned failure's own `reason_code`, never its `message` |
| `packages/connectors/src/observability.ts` | the `poll` wrapper logs `stream_error_codes`, one per distinct failed stream, beside the count that used to be all it said; the `validateToolInput` wrapper logs the returned rejection's paths as `code` beside `outcome: "invalid"` |
| `packages/connectors/src/types.ts` | `streamFailure` names a provider's off-schema poll body as `response_invalid:<path>:<code>` where it said `poll_failed`, the word a network fault also says; the code reaches the connection row as the stream's degradation reason |
| `packages/connectors/src/granola.ts`, `packages/connectors/src/slack.ts` | the OAuth stage helpers attach `responseIssues` — the failing paths — to a `provider_error` whose body did not parse, beside `responseInvalid` |
| `apps/api/src/lib/connector-oauth-error.ts` | `connector_oauth_callback_failed` carries `response_issues` from that detail, admitted only in code shape, and from a raw `ZodError` |
| `apps/api/src/durable-objects/scheduled-alarm-report.ts` | `scheduledAlarmErrorCode` names the field a handler's own `ZodError` rejected, as `handler_error:ZodError:<paths>`, and passes any code-shaped message through |
| `apps/api/src/observability/logger.ts` | `diagnosticErrorCode` names a `ZodError` behind the caller's own code (`external_event_delivery_failed:event.eventSequence:invalid_type`), and carries a `parseRpcInput` message across the hop instead of reducing it to the fallback |
| `apps/api/src/middleware/errors.ts` | `request_failed` carries a code-shaped message a Durable Object threw, as `error_code`, where the row said `internal_error` and `Error` |
| `apps/api/src/services/workspace-schedule-execution.ts` | the `workspace_schedule_target_failed` audit row names a handler's own rejection the way the notice does |
| `apps/api/src/durable-objects/sidekick-do.ts` | every RPC entry point, through `parseRpcInput`, labelled by method (`admit_external_event_invalid:…`) |
| `apps/api/src/durable-objects/workspace-do.ts` | the entry points on the Sidekick's publication tail and the connector-event pipeline: `applyExternalEventRegistrations`, `ensureMemoryScope`, `createMemoryTable`, `memoryTableWithColumns`, `recordMemoryTableOpenReceipt`, `memoryTableMutationReceipt`, `applyAutomationDirectory`, `ingestConnectorEvent`, `claimConnectorEvent`, `settleConnectorEvent`, `matchExternalEventDestinations` |
| `apps/api/src/durable-objects/substream-agent.ts` | `appendWatchedResourceEvent`, the other destination an external event is delivered to |
| `apps/api/src/durable-objects/conversation-parent-object.ts` | `receiveChildEffects`, which every conversation effect crosses |

The label a Durable Object entry point passes to `parseRpcInput` is the RPC
method, in snake case, not the schema: seven Sidekick methods share one actor
schema, and the caller knows which method it called. `rpc-contracts.ts`'
envelope-shaped `parseRpcInput`, which the regional bridges use, already
labels by method for the same reason.

Adopt it at the next boundary you touch that would otherwise say
`unexpected_error`. Converting every RPC entry point and every adapter blind is
how a diagnostic fix becomes a risk. What still parses its input with a bare
`.parse(input)`, by object: the remaining `WorkspaceDO` methods (about 160,
reached from routes and from the maintenance alarms), `WorkstreamDO` (24),
`SubstreamAgent` (`applyPrivateChildLifecycle`, `applyPrivateChildMembership`,
the batch-update and search-projection entry points), the conversation
parent's `listChildren` and `retirementChildren`, and
`InternallyInspectableDurableObject.runInspectionSql`. A rejection at any of
those still crosses the hop as a bare `Error`; the reporters above then carry
its empty message as `""`, `handler_error:Error`, or the caller's fallback.

Known and not yet converted:

- `packages/agent-harness/src/index.ts` — `if (error instanceof z.ZodError)
  return "validation_error"` names the class and discards the path.
- The Durable Object RPC entry points listed above by object, which still
  open with a bare `Schema.parse(input)`.

## What it costs

`codeShaped` truncates at `DIAGNOSTIC_CODE_MAX_LENGTH`, so a rejection with
three deep paths can lose its third issue without saying so. That is the right
trade against `scheduledAlarmErrorCode` degrading the whole message to
`handler_error`, but the failure mode is "quietly shorter", not "rejected" —
worth knowing when a code looks truncated mid-path.

The label is the caller's and describes the *boundary*, not the side that was
wrong. `connectorObservationErrorCode` says `schema`, not `response`, because it
classifies every adapter operation and `executeTool` parses the model's own
arguments through the same `.parse`.

## What this does not fix

A generic code is a symptom of a boundary that had the reason and dropped it.
It is not the only way a failure hides. The one still open from this episode: a
Sidekick whose `applied_effects_revision` trails its accepted revision reads as
published, so the product asserts health while the tail never landed. Naming the
error made that diagnosable in minutes; it did not make it visible.

## Changelog

### 2026-09-15 — A connector's returned rejection is named like its thrown one

**What changed:** The connectors package names a schema rejection it returns
rather than throws. A poll stream whose provider answered off-schema reports
`response_invalid:<path>:<code>` instead of `poll_failed`; the `poll`
wrapper logs the distinct codes of the streams that failed, not only their
count; the `validateToolInput` wrapper logs the returned `ZodError`'s paths
beside `outcome: "invalid"`; and the Slack and Granola OAuth stage helpers
attach `responseIssues` to a `provider_error` whose body did not parse, which
`connector_oauth_callback_failed` carries as `response_issues`.

**Why:** The first entry named a rejection at the boundary where it is
thrown — `connectorObservationErrorCode` — and left the same rejection
unnamed at the boundaries where an adapter returns it. `streamFailure`
reduced a provider's off-schema body to `poll_failed`, the word an outage
also says, and that word is what reached the connection row as the stream's
reason. The `validateToolInput` wrapper held the whole `ZodError` and logged
the word `invalid`. The OAuth stage helpers already knew a body had not
parsed and said only that it had not.

**Considered and rejected:** Logging a stream's `message` beside its code.
The message is built from the provider's own error text and already reaches
the connection row; an indexed field is not where it belongs. Also rejected:
adding a `reason` to the `repair` wrapper for symmetry with `healthCheck`.
No adapter declares `repair` today, so the wrapper drops nothing; the live
repair runs in `connection-service.ts` outside the wrapper, and is listed in
the pull request as found and not changed.

**Consequences:** A stream's `code` is no longer a closed set: a caller
that matched `poll_failed` exactly sees a longer value for the schema case,
and `connector_activity_streams_degraded` on the connection row carries it.
`response_issues` on the callback log is admitted only through
`isCodeShaped`, so an adapter that put anything but paths in that detail
would see it dropped, not logged. `responseIssues` is the one new key the
OAuth stage helpers attach; an adapter adding a stage helper of its own
should attach the same key or its rejection stays unnamed at the log.

Shipped in the pull request for this change.

### 2026-09-15 — The reporters read what the primitive writes

**What changed:** The three reporters a Durable Object's failure reaches now
name a schema rejection, and the Sidekick pipeline's entry points throw one
that survives the hop. `diagnosticErrorCode` answers a `ZodError` with its
paths behind the caller's own code and carries a `parseRpcInput` message
through instead of reducing it to the fallback; `scheduledAlarmErrorCode`
names the field a handler's own `ZodError` rejected instead of answering
`handler_error:ZodError`; and `request_failed` carries a code-shaped message
a plain `Error` arrived with, as `error_code`. Every `SidekickDO` entry
point, the `WorkspaceDO` methods on the Sidekick's publication tail and the
connector-event pipeline, `SubstreamAgent.appendWatchedResourceEvent` and
`receiveChildEffects` parse through `parseRpcInput`. `isCodeShaped` joins the
primitive so the notice and the logger test one character class.

**Why:** The first entry closed the boundary the incident was diagnosed at
and left the ones beside it open. The queue consumer that delivers an
external event to a Sidekick reduced a refused admission to the constant
`external_event_delivery_failed` and retried until the Queue gave up, so a
rule-shape change read as an outage. `materializeAutomationMemoryTables` sits
on the same `sidekick_publication` alarm one write after the registration
write that was fixed, and a rejection there still reached the failure row as
`code: ""` and the notice as `handler_error:Error`. And `diagnosticErrorCode`
— thirty call sites, every queue consumer among them — refused the `:` and
`.` a `parseRpcInput` message is built from, so a rejection named on one side
of the hop was reduced to its fallback on the other, by the helper that
existed to read it. Two character classes for one idea is the drift the
primitive was written to end.

**Considered and rejected:** Converting every `.parse(input)` entry point in
one pass — about 250. The change is mechanical, but a `ZodError` thrown inside
an object today is indistinguishable, to any caller, from a plain `Error`,
and nothing proves which callers or tests depend on that. The set converted
here is the set on the paths that demonstrably lost the reason: the incident's
object, its publication tail, and the event pipeline that feeds it. The rest
are listed above by object for the next change to adopt. Also rejected:
making `diagnosticErrorCode` log any message. A code-shaped message has no
whitespace and cannot be prose, which is the same test the notice already
applied; a sentence still reduces to the fallback.

**Consequences:** A reporter that reads a thrown message now accepts the
whole code class — uppercase, `-`, `:`, `.` — not only `[a-z][a-z0-9_]*`, so
a saved query that matched a `reason` or `error_code` exactly may see a
longer value carrying the path after the code it matched. The label an entry
point passes to `parseRpcInput` is the RPC method, so a caller's log names
which of an object's methods refused, not only which schema. The bare-`catch`
sites that log nothing at all — the project-default consumer, the Slack
reaction ticker, push delivery — are unchanged: naming a reason they never
record is a logging decision for their owners, not this rule.

Shipped in #768.

### 2026-09-15 — One place to name a schema rejection

**What changed:** `@rally/contracts/zod-diagnostics.ts` is added and three
boundaries adopt it. `connectorObservationErrorCode` answers a schema rejection
with its failing paths instead of `unexpected_error`; the `healthCheck`
instrumentation logs the `reason` of an adapter that returns `{ ok: false }`
rather than only of one that throws; `parseRpcInput` and
`scheduledAlarmErrorCode` now share the bound and the description rather than
restating them.

**Why:** One bug was diagnosed four times in a day because four boundaries each
reported it as something that named nothing — the table above. The fourth was
the one that hurt: a Fireflies Sidekick finally received its event, ran, called
`get_meeting_summary` twice against a provider answering HTTP 200, and both
calls failed as `unexpected_error`. The run had no summary to write and sent no
email. Two identical log lines, no field, no path, and a schema where every
member but `id` is `nullish()` on a `looseObject` — so the shape alone could not
narrow it.

The conservatism in those helpers was right and stays: an arbitrary runtime
message still does not reach an indexed field. What changed is that a schema
rejection is recognised as the one error whose structure is safe to name.

**How it is proved:** `packages/contracts/src/zod-diagnostics.test.ts` covers
nested paths, the root sentinel, `unrecognized_keys`, the `null` answer for
non-Zod errors, and the code shape over a path the schema does not control.
`packages/connectors/src/observability.test.ts` reconstructs the real Fireflies
rejection; restoring `return "unexpected_error"` fails it with
`expected 'unexpected_error' not to be 'unexpected_error'`.

**What a future change has to respect:** the value/shape line, and that it is
narrower than "the path is safe". Declared field names and issue codes cross;
record keys, unrecognized key names on an untrusted boundary, and rejected values
do not. A boundary that starts carrying more because the path was not enough has
answered the wrong question — an unhelpful path means the schema needs better
field names, not that the diagnostic needs more of the value.

The first version of this change did claim the wider line, in the docstring and
in its own tests: it sanitized a record key to `seat_row_3` and asserted that as
a feature. Sanitizing is not redaction. A reviewer caught it before it shipped.

**Considered and rejected:** logging a health check's `message` instead of
adding `reasonCode`. It is the shortest path to Granola's diagnosis and it
carries every adapter's caught provider text with it. Also rejected: sanitizing
record keys rather than withholding them — the character class was never a
privacy boundary, only a formatting one. Also rejected: making
`connectorObservationErrorCode` log `error.message` for any error. That is how provider prose and member content
reach an indexed field, which is the thing those helpers were written to
prevent. Also rejected: a lint rule banning `unexpected_error`. The string is
correct for an error that genuinely carries no structure; what is wrong is
reaching it with a `ZodError` in hand.

Shipped in the pull request for this change.
