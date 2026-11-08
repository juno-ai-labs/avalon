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
instrumentation logs, for a failed result and for a degraded `ok` one alike. An
adapter that sets none logs nothing new. Granola sets
`webhook_endpoint_identity_missing`, `webhook_endpoint_absent` and
`webhook_endpoint_disabled`; the first two were the conditions that made its
connection unusable while the log said `unhealthy`, and all three now travel
with the warning the check reports instead of failing.

## The primitive

`@rally/contracts`' `zod-diagnostics.ts`, reachable from every package:

- `describeZodIssues(error, options?)` — the failing paths and codes, first
  three, with non-declared segments withheld. `namesUnknownKeys` opts into
  `unrecognized_keys` names and belongs only on a boundary between our own
  components.
- `codeShaped(text)` — reduced to the character class and length a code-shaped
  field will carry.
- `isCodeShaped(text)` — whether a message already has that shape: no
  whitespace, so it cannot be prose. A bound on what a value can be, never a
  reason to trust it — `memory_table_value_type:${column.name}:string` passes.
- `isDiagnosticCode(text)` — whether a message is one this module composed: a
  label, `_invalid`, then the issues. The test a reporter applies before
  carrying a *thrown* message with separators in it, because only
  `zodDiagnosticCode` and `parseRpcInput` produce that shape.
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
| `apps/api/src/durable-objects/agent-loop-do.ts` | Product RPC failures preserve schema field codes in the response and log, so demo preparation names a malformed participant field without including its rejected value |
| `apps/api/src/lib/rpc-input.ts` | `parseRpcInput` throws a message that survives an RPC hop |
| `packages/connectors/src/observability.ts` | `connectorObservationErrorCode` names a provider-response mismatch |
| `packages/connectors/src/observability.ts` | `healthCheck` logs a returned failure's own `reason_code`, never its `message` |
| `packages/connectors/src/observability.ts` | the `poll` wrapper logs `stream_error_codes`, one per distinct failed stream, beside the count that used to be all it said; the `validateToolInput` wrapper logs the returned rejection's paths as `code` beside `outcome: "invalid"` |
| `packages/connectors/src/types.ts` | `streamFailure` names a provider's off-schema poll body as `schema_invalid:<path>:<code>` where it said `poll_failed`, the word a network fault also says; the code reaches the connection row as the stream's degradation reason |
| `packages/connectors/src/granola.ts`, `packages/connectors/src/slack.ts` | the OAuth stage helpers attach `responseIssues` — the failing paths — to a `provider_error` whose body did not parse, beside `responseInvalid` |
| `apps/api/src/lib/connector-oauth-error.ts` | `connector_oauth_callback_failed` carries `response_issues` from that detail, admitted only in code shape, and from a raw `ZodError` |
| `apps/api/src/services/slack-agent-service.ts`, `slack-notification-service.ts`, `slack-workstream-card.ts` | the three Slack reason helpers answer a `ZodError` with `invalid_slack_data:<path>:<code>` — the reason persisted on an ingress job and written to the connection's `error_json` |
| `apps/api/src/routes/telemetry.ts` | the four catch sites rethrow a `ZodError` as itself, so `request_failed` logs the route and the failing paths behind the same `internal_error` |
| `apps/api/src/services/connection-service.ts` | the managed repair on the Test path answers with its sentence only for an installation that stopped — `failed` or `action_required` — so one still in flight, whose health check passed, is not reported as needing attention |
| `apps/api/src/services/connector-installation-service.ts`, `connector-maintenance-service.ts` | a step that failed logs `connector_installation_step_failed` with `diagnosticErrorCode`; a maintenance target that stopped logs `connector_maintenance_target_failed`, and its `reason` is the receipt's own sentence when the receipt has one |
| `apps/api/src/durable-objects/workspace-do.ts` | `connector_event_authority_terminal` carries the settler's `error` as `error_code` when it is code-shaped |
| `apps/api/src/services/demo-preparation.ts` | a phase stopped by a stored record that no longer parses names the field as its operator-facing code, where it said `demo_internal_error` |
| `apps/ace/src/regional-api.ts`, `index.ts`, `private-access.ts` | a regional answer the contract refuses names the field in the message beside `regional_api_contract_mismatch`; the fallback handler logs `error_code`; a refused download grant says which field |
| `apps/api/src/services/integrations.ts` | `dynamic_connector_tools_unavailable` carries `error_code` beside the class name, so a tool catalog that drifted out of `ToolDefinitionSchema` names its path on both the creator-catalog and initial-activation surfaces; `connector_plugin_reauthorization_failed` carries a schema rejection's paths as `code`, the way it already carried a connector's own |
| `apps/api/src/durable-objects/scheduled-alarm-report.ts` | `scheduledAlarmErrorCode` names the field a handler's own `ZodError` rejected, as `handler_error:ZodError:<paths>`, and passes any code-shaped message through |
| `apps/api/src/observability/logger.ts` | `diagnosticErrorCode` names a `ZodError` behind the caller's own code (`external_event_delivery_failed:event.eventSequence:invalid_type`), and carries a `parseRpcInput` message across the hop through `isDiagnosticCode`; every other thrown message is admitted only in the bare constant class it always was, so an identifier interpolated after a colon still reduces to the fallback; a Workers runtime failure, which arrives as a sentence, is named behind the caller's code by matching the sentence or the runtime's `overloaded` flag (`parent_export_failed:durable_object_code_updated`), never by copying it; an `ObjectPortError` is named by the conversation object's refusal code (`workstream_runtime_authority_fenced`) when that code is a bare constant |
| `apps/api/src/middleware/errors.ts` | `request_failed` carries what `diagnosticErrorCode` admits of a plain `Error`'s message, as `error_code` and in the row's summary, where the row said `internal_error` and `Error` |
| `apps/api/src/services/workspace-schedule-execution.ts` | the `schedule.failed`, `resource_watch.failed` and `workspace_schedule_target_failed` records name a stored row's rejection behind each record's own constant; the schedule and watch rows are the two whose targets parse a stored row |
| `apps/api/src/durable-objects/hosted-sidekick.ts` | every RPC entry point, through `parseRpcInput`, labelled by method (`admit_external_event_invalid:…`) |
| `apps/api/src/durable-objects/workspace-do.ts` | the entry points on the Sidekick's publication tail and the connector-event pipeline: `ensureMemoryScope`, `createMemoryTable`, `memoryTableWithColumns`, `memoryTableMutationReceipt`, `ingestConnectorEvent`, `claimConnectorEvent`, `settleConnectorEvent`, `matchExternalEventDestinations` |
| `apps/api/src/durable-objects/agent-loop-do.ts` | `appendWatchedResourceEvent`, the other destination an external event is delivered to |
| `apps/api/src/durable-objects/conversation-parent-object.ts` | `receiveChildEffects`, which every conversation effect crosses |
| `apps/api/src/queues/activity-consumer.ts` | an effect envelope the consumer's contract refuses logs `effect_queue_message_invalid` with its failing paths, including unknown key names (the Queue's producers are our own objects, so they are the diagnosis of a deploy skew), where it logged `legacy_message_after_cutover` under a connector-event code; it is still acked |
| `packages/contracts/src/platform-diagnostics.ts` | `platformErrorCode` names a Workers runtime, D1 or SQLite failure (`d1_overloaded`, `sqlite_unique_constraint`) from its fixed sentence or its `cause`, never copying the table, column or value the sentence quotes; `diagnosticErrorCode` and the engineering MCP read it |
| `packages/connectors/src/observability.ts` | `connectorDiagnosticCode` is `connectorObservationErrorCode` plus the provider's HTTP status, its rate limit, or the platform failure behind a request that never completed (`provider_error:http_403:rate_limited`) |
| `apps/api/src/lib/api-error.ts` | `ApiError.diagnosticCode` carries what a log may say beyond the public `code`, across an RPC hop and through every regional bridge envelope (`diagnosticCodeField`), and never into the response body; `request_failed` and `diagnosticErrorCode` log it |
| `apps/api/src/middleware/validation.ts`, `apps/api/src/routes/canvases.ts` | `namedZValidator(label, message)` answers a route's schema rejection to its caller as `<label>_invalid:<path>:<issue>` with the route's own sentence as the message, where `zValidator` says `invalid_request`; the Canvas routes use it for a malformed Canvas id (`canvas_id_invalid:id:invalid_format`) and a retitle's `title` (`canvas_rename_invalid:title:too_small`) |
| `apps/api/src/queues/access-revocation-consumer.ts` | `access_revocation_message_invalid` names each failing field of a queue message it cannot read, where it formatted the issues by hand and spelled the whole-value case `(root)` |

The label a Durable Object entry point passes to `parseRpcInput` is the RPC
method, in snake case, not the schema: seven Sidekick methods share one actor
schema, and the caller knows which method it called. `rpc-contracts.ts`'
envelope-shaped `parseRpcInput`, which the regional bridges use, already
labels by method for the same reason.

Adopt it at the next boundary you touch that would otherwise say
`unexpected_error`. Converting every RPC entry point and every adapter blind is
how a diagnostic fix becomes a risk. What still parses its input with a bare
`.parse(input)`, by object: the remaining `WorkspaceDO` methods (about 160,
reached from routes and from the maintenance alarms), the hosted
Canvas parent methods `WorkspaceDO` dispatches to, `AgentLoopDO` (the
batch-update and search-projection entry points), the conversation parent's
`listChildren`, and
`InternallyInspectableDurableObject.runInspectionSql`. A rejection at any of
those still crosses the hop as a bare `Error`; the reporters above then carry
its empty message as `""`, `handler_error:Error`, or the caller's fallback.

Known and not yet converted:

- The Durable Object RPC entry points listed above by object, which still
  open with a bare `Schema.parse(input)`.
- `packages/agent-harness/src/index.ts` — `if (error instanceof z.ZodError)
  return "validation_error"` names the class and discards the path, and stays
  that way on purpose: `failure_kind` is a small vocabulary `integrations.ts`
  matches on, and the `validate`-stage diagnostic emitted for the same
  `inferenceRequestId` already carries the paths as `validationIssues`.

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

### 2026-11-08 — A route can name its rejection to the caller

**What changed:** `namedZValidator(label, message)` in `middleware/validation.ts` is
`zValidator` with a public code built by `zodDiagnosticCode`: declared field
names and issue codes, never a value and never a caller's unknown key. Its
message is the route's own sentence, because a client shows the message to
the person and a code-shaped string is no sentence. The Canvas routes use it
for the id parameter and the retitle's body.

**Why:** The end-to-end pass found `PATCH /canvases/:id` refusing an empty,
blank or 301-character title, and a malformed id, as `invalid_request` "The
request is invalid", which tells the person retitling nothing to fix, while a
well-formed missing id already said `canvas_not_found`.

**Considered and rejected:** Naming every route's rejection by changing
`zValidator` itself: the generic envelope is a deliberate public contract
and every client and test that reads `invalid_request` would move with it in
one change nobody asked for. A route opts in where a person's input reaches it.

**Consequences:** A route that adopts it answers a schema refusal with a code
that is no longer a closed set; a client branches on its prefix.

### 2026-10-19 — A conversation object's refusal is named by its code

**What changed:** `diagnosticErrorCode` answers an `ObjectPortError` with its
`code`, the refusal the conversation object returned, when that code is a
bare constant. `ObjectPortError` moved to `runtime/object-port-error.ts` so
the logger can read it without importing the port.

**Why:** A thread backfill row retried over 380 times against an object that
refused every read as `workstream_runtime_authority_fenced`. The error's
message is a sentence written for members, so every failure was logged as the
bare `thread_backfill_failed`, and the cause had to be found by reading the
object's rows. Every caller that logs a port failure through this helper had
the same blind spot.

**Considered and rejected:** Putting the code in the message: members see
that sentence where a port failure reaches a response. Importing the port
module into the logger: the port's stub resolution imports the logger.

**Consequences:** Logs that reported a caller's fallback for a port refusal
now report the object's code. A code outside the bare constant class still
reduces to the fallback, as a thrown message does.

### 2026-09-29 — Platform failures and provider statuses are named where a code hid them

**What changed:** A new primitive, `platformErrorCode` in
`@rally/contracts/platform-diagnostics`, maps the Workers runtime, D1 and
SQLite sentences to words of ours; the runtime table that lived in the API's
logger moved there. `connectorDiagnosticCode` adds a provider's HTTP status and
rate limit to a connector's code. `ApiError` gained `diagnosticCode`, which a
log reads and a response never does. Six logs use them: `connector_poll_failed`,
the queue's `workstream_maintenance` refusal, `request_failed` and
`github_delivery_retry` for a GitHub 502, `engineering_mcp_tool_failed`, and
`workspace_scheduled_alarm_phase_failed`.

**Why:** A log review found six codes standing in for a reason already in hand.
The poll workflow logged `error_name: "Error"` because the Workflow step
boundary serializes what an attempt threw. The work-stream fence answered
`quarantined:0` for a D1 read that failed, which is also the value of a real
quarantine. GitHub's 404, 403 rate limit and 500 all logged as 502
`provider_error`. A D1 outage behind a route logged `internal_error`, because
its message is prose. The engineering MCP logged the constant `tool_failed`,
and the alarm phase failure logged no code at all.

**Considered and rejected:** Adding the provider's status to
`connectorObservationErrorCode`. `connection-service.ts` compares and persists
that code, so a finer value would split one known state into many; the new
helper sits beside it. Carrying table and column names from a SQLite
constraint message: a member's memory table names its own columns, so the
kind of failure crosses and the names do not. Putting the provider status in
`ApiError.details`: that goes to the caller, and the rule is not to widen what
the caller sees.

Every regional bridge's error envelope carries the log-only code, since each
one runs the work-stream fence and rebuilds its refusal on the Global side.

**Consequences:** `request_failed` now carries `error_code` for a
`ConnectorError` whose details name a status, rate limit or platform failure,
and for an `ApiError` that has a `diagnosticCode`.
A sentence the platform table does not know still reduces to the caller's
fallback; add it to `PLATFORM_ERRORS` when a log shows it. The queue refusal's
message grows a fourth segment only when the fence failed closed.


### 2026-09-26 — A Workers runtime failure is named behind the caller's code

**What changed:** `diagnosticErrorCode` gives a platform failure a name of ours
after the caller's own code: the fixed runtime sentences (an object reset
because its code was updated, a storage timeout reset, an inactive instance, a
lost connection, a hung Worker) and, failing those, the runtime's
`overloaded` flag.

**Why:** Deploying the hosted-parent change reset legacy `WorkstreamDO`s while
`WorkspaceDO` was exporting from them, and five imports logged
`parent_export_failed` and nothing else. They retried fine, but the log could
not tell a deploy reset from a refusal, which is the generic-code defect this
document exists to stop.

**Considered and rejected:** Copying the runtime's message: it is code-shaped
in no case and the rule here is to name, not to quote. Reading `retryable`:
this tree's own provider errors (Firecrawl, the Azure media providers, the
harness plugin activation) carry a property of that name, so it would label
them runtime failures. A table per boundary:
the runtime's sentences are the same at every hop, so one helper names them.

**Consequences:** A sentence the table does not know, without the `overloaded` flag, still
reduces to the bare fallback; add it to `PLATFORM_ERRORS` when a log shows it.

### 2026-09-15 — The plugin host names a catalog and an authorization that failed their schemas

**What changed:** The two host logs behind a plugin the model could not
load name the field. `dynamic_connector_tools_unavailable` carries
`error_code` beside `error_name` on both surfaces that emit it, and
`connector_plugin_reauthorization_failed` carries a schema rejection's paths
as `code`, the key it already used for a connector's own code.

**Why:** A hosted MCP server's tool catalog that drifted out of
`ToolDefinitionSchema` failed identically on every activation, and the host
logged the word `ZodError`; the model was told `plugin_tools_unavailable`
and to retry once later. A reauthorization whose cause was a schema
rejection logged the rejection's JSON message as `reason` and no code, and
became `indeterminate` — `plugin_authorization_unavailable`, "retry after
the authorization service is available" — for a failure that no wait would
change. Naming the field at the host log is what tells an operator reading
that row that the blocker is deterministic.

**Considered and rejected:** Changing `structuredFailureKind`'s
`validation_error` to a per-path code. The kind is a small vocabulary that
`integrations.ts` matches on to derive a member-facing classification, and
the `validate`-stage diagnostic emitted two lines earlier already carries
`validationIssues` for the same `inferenceRequestId`; the paths are on the
row beside it. Also rejected: naming the rejection inside the harness's
`plugin_tools_unavailable` catch. The only slot that reaches the log is the
one that reaches the model, and what the model is told about a deterministic
blocker is the fabricated-blocker decision recorded in the pull request, not
a diagnostics change. And rejected: converting `onToolCallRejected`'s
`error.name` defensively. Nothing in this repository can be shown to hand a
`ZodError` to that callback — the rejection hook returns a structured refusal
rather than throwing — so a conversion there would be a guess with no test
able to fail.

**Consequences:** `error_code` on `dynamic_connector_tools_unavailable`
carries the catalog's failing path only for a schema rejection and the
fallback constant otherwise, so a query on that field separates a drifted
catalog from an unreachable server. The two `plugin_*_unavailable` codes and
their retry guidance are unchanged; the fabricated-blocker finding stands
against them until their owners decide on a third verdict.

Shipped in #771.

### 2026-09-15 — The services and the admin Worker name what they already knew

**What changed:** The catch sites in the API's services, routes, and the Ace
Worker that reduced a schema rejection to a fixed string now name its field,
and the returned failures around the connector lifecycle carry the reason
they computed. The three Slack reason helpers answer
`invalid_slack_data:<path>:<code>`; the description refresh records
`description_decision_invalid:<path>:<code>` where it recorded
`model_unavailable`; the telemetry routes rethrow a `ZodError` so the error
handler logs its paths behind the same `internal_error`; an installation
step that failed and a maintenance target that stopped each log a code, and
the maintenance target's `reason` is the receipt's own sentence when it has
one; the event settlement row carries the settler's own `errorCode`; the
managed repair on the Test path speaks only for an installation that stopped;
a demo phase stopped by a stored record that no longer parses names the
field; and Ace names the field in a contract mismatch, its fallback log, and
a refused download grant.

**Why:** Each of these had the reason in hand. The Slack reason is
persisted on the ingress job and the connection row, so the word
`invalid_slack_data` was what an operator and the re-drive read. The
description refresh recorded `model_unavailable` for a model that had
answered — with JSON the schema did not model — and sent an operator to look
at the provider. The telemetry routes mapped every unknown error to an
`ApiError` before the handler could see it, so the one branch that logs
`validation_issues` never ran for them. The managed repair on the Test path
— whose unrepaired reason `main` began returning while this change was under
review — spoke for an installation still in flight as if it had stopped. The
installation runner logged
nothing at all, and the maintenance sweep's bare `catch {}` wrote a pointer
to go and read a receipt whose sentence it was holding.

**Considered and rejected:** Answering the telemetry routes' schema
rejections with a 400 that names the field. A `CrashMetadataSchema` rejection
is the desktop's payload, so a 400 may well be right — but that is a status
change, and this rule is about what a log says. Also rejected: renaming the
settlement row's `reason`, which holds a mechanical value where a reader
expects the cause. Saved queries filter on it; `error_code` is added beside
it instead.

**Consequences:** `slack_ingress_jobs.error_code` and the exhausted-job notice
are keyed on the reason, so a path-specific code makes the one-notice-per-code
window finer for schema rejections: two fields failing in one hour are two
notices. A maintenance target's `reason` is now whatever sentence the stopped
registration carries, so an operator screen shows the receipt's words. The
telemetry routes' 500 bodies say `An unexpected error occurred` rather than
each route's own sentence for a schema rejection; the code and status are
unchanged.

Shipped in #770.

### 2026-09-15 — A connector's returned rejection is named like its thrown one

**What changed:** The connectors package names a schema rejection it returns
rather than throws. A poll stream whose provider answered off-schema reports
`schema_invalid:<path>:<code>` instead of `poll_failed`; the `poll`
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
would see it dropped, not logged — which is why every source shapes it with
`codeShaped` first: a three-issue nested rejection measures past the gate's
bound, and unshaped it would have been dropped for exactly the rejection an
operator most wants named, where shaped it truncates. `responseIssues` is the
one new key the OAuth stage helpers attach; an adapter adding a stage helper
of its own should attach the same key, shaped, or its rejection stays unnamed
at the log. The poll workflow's result contract admits a stream code as long
as the primitive produces; at its old cap of 100 one deep path failed the
whole poll result, and the step recorded the connection failing for a
degradation the result had already described.

Shipped in #769.

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
are listed above by object for the next change to adopt. Also rejected, after
review: letting the logger carry any code-shaped message. The first draft
did, on the argument that a string with no whitespace cannot be prose, and
the reviewers showed what else it cannot be: bounded. The tree throws
`memory_table_value_type:${column.name}:string`, an R2 key after a colon, a
target id, and `${component}_schema_hash_mismatch:${version}`, and each of
those in an indexed field or the OTel `error.type` is a member's value or one
grouping key per object. Shape is a limit on a value, not its provenance. So
the logger admits a thrown message in the bare constant class it always
trusted, plus the family only the primitive composes, and nothing between.

**Consequences:** `diagnosticErrorCode` and the `request_failed` row carry a
`parseRpcInput` message across the hop and still reduce an interpolated
message to the fallback, so a saved query on `reason` or `error_code` sees a
longer value only for a schema rejection. `error_code` joins the row summary,
so the Workers Logs list shows the code without expanding the entry. The
label an entry point passes to `parseRpcInput` is the RPC method, so a
caller's log names which of an object's methods refused, not only which
schema. The bare-`catch` sites that log nothing at all — the project-default
consumer, the Slack reaction ticker, push delivery — are unchanged: naming a
reason they never record is a logging decision for their owners, not this
rule.

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
