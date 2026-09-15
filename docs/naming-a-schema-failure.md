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
| `packages/connectors/src/observability.ts` | `healthCheck` logs a returned failure's own `reason` |
| `apps/api/src/durable-objects/scheduled-alarm-report.ts` | `scheduledAlarmErrorCode` shares the bound |

Adopt it at the next boundary you touch that would otherwise say
`unexpected_error`. Converting every RPC entry point and every adapter blind is
how a diagnostic fix becomes a risk.

Known and not yet converted:

- `packages/agent-harness/src/index.ts` — `if (error instanceof z.ZodError)
  return "validation_error"` names the class and discards the path.
- Every other Durable Object RPC entry point that opens with `Schema.parse(input)`.
  Only `applyExternalEventRegistrations` uses `parseRpcInput` so far.

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
