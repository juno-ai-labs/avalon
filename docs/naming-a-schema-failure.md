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

Between 2026-09-14 and 2026-09-15, one bug — `fireflies` missing from
`ConnectorTypeSchema` — was diagnosed four separate times, because four
different boundaries reported it as something that named nothing:

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

**Paths and issue codes are schema shape. Rejected values are data.** The API's
`errorHandler` already draws exactly this line when it records
`validation_issues` but withholds `detail_keys`' values, and the same line
applies at every boundary here.

So `summary.topics_discussed.0:invalid_type` may be logged and may cross an RPC
hop. What was actually in that array may not.

`unrecognized_keys` is the one issue whose subject is not on its path: Zod
reports the offending names in `issue.keys` and leaves `path` empty. Those names
are schema shape too — they are what a caller sent, not what it contained — and
they are the entire diagnosis of a version skew, so `describeZodIssues` carries
them.

## The primitive

`@rally/contracts`' `zod-diagnostics.ts`, reachable from every package:

- `describeZodIssues(error)` — the failing paths and codes, first three.
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

**What a future change has to respect:** the value/shape line. Paths and issue
codes cross; rejected values do not. A boundary that starts logging the value
because the path was not enough has answered the wrong question — the path not
being enough means the schema needs a better field name.

**Considered and rejected:** making `connectorObservationErrorCode` log
`error.message` for any error. That is how provider prose and member content
reach an indexed field, which is the thing those helpers were written to
prevent. Also rejected: a lint rule banning `unexpected_error`. The string is
correct for an error that genuinely carries no structure; what is wrong is
reaching it with a `ZodError` in hand.

Shipped in the pull request for this change.
