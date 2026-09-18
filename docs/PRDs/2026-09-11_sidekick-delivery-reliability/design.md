# Design: the `sidekick_post_result` destination contract

> Companion to [`prd.md`](prd.md), written 2026-09-11. Decision 1 of the PRD
> widens the one tool that reaches a Sidekick's owning room into the one tool
> that reaches any configured destination. This is the buildable contract for
> that change, in the shape [`prds.md`](../../prds.md#required-documentation-for-agent-tools-and-plugins)
> requires and against the rules in [`agent-tools.md`](../../agent-tools.md).
> Everything marked *today* is read from `createAutomationPostResultPlugin` in
> `apps/api/src/services/integrations.ts`; everything else is proposed.

## 1. Plugin contract

| Field | Today | Proposed |
| --- | --- | --- |
| Canonical id | `rally:sidekick-result` | unchanged |
| Model id and wire prefix | `rally_sidekick_result`, prefix `sidekick` | unchanged |
| Availability | registered only for a Sidekick run whose `readRunDefinition().owningWorkstreamId` is not null; absent otherwise | registered for a Sidekick run whose definition carries at least one destination; the owning room is always one for a room-owned Sidekick, so today's population is a subset |
| Selection and authority | preloaded, not explicit; run-scope authority, no connector credential of its own | preloaded; the Slack delivery uses the workspace installation's bot token held by the SidekickDO's delivery, never a credential the run holds |
| Tool order | one tool | one tool |
| System message | "When the instructions say the work stream should hear the result, post it with sidekick_post_result, once, in full." | "When the instructions say a configured destination should hear the result, post it with sidekick_post_result, once per destination, in full. The destinations are listed in the task context's sidekick.resultDelivery; anything not listed there is your own work with your own tools." |
| What loading starts | nothing; loading authorizes no delivery and persists nothing | unchanged |

## 2. Tool catalog

| Field | Today | Proposed |
| --- | --- | --- |
| Canonical name | `post_result` | unchanged |
| Model-visible name | `sidekick_post_result` | unchanged |
| Description | "Post this run's result into the work stream that owns this Sidekick. Call it once, with the complete result the people in that work stream should read. Nothing else delivers a result there: a run that does not call this leaves the work stream unchanged." | "Post this run's result to one of this Sidekick's configured destinations. Call it once per destination, with the complete result its readers should see. Nothing else delivers a result there: a run that does not call this leaves the destination unchanged. Destinations are the `key` values in the task context's sidekick.resultDelivery." |
| Capability | `rally.sidekick.result.post` | unchanged |
| Mode | `write` | unchanged; Bind runs writes sequentially, so two destinations are two serial calls |
| Idempotency | `safe`, because the destination dedupes on `deliveryId = runId` and answers `replayed` | `record_before_execute`, because a Slack delivery leaves the platform and a lost answer must not be repeated blind; see section 5 |
| Timeout | none set; the harness's default per-tool deadline | a per-tool `timeoutMs` covering one provider call; the number is the team's to set, and it ships open with the delivery marked `unconfirmed` on expiry rather than retried |

## 3. Exact wire shapes

Input, `additionalProperties: false`:

| Property | Today | Proposed |
| --- | --- | --- |
| `text` | required, `string`, `minLength: 1`, `maxLength: MESSAGE_MAX_CHARACTERS`; the result as the destination should read it | unchanged |
| `destination` | absent | optional, `anyOf: [{ type: "string", minLength: 1 }, { type: "null" }]`; a `key` from sidekick.resultDelivery, copied exactly. Omitted or `null` means the only configured destination; with two or more configured, omitting it is refused (section 5). Unknown keys are refused; the field is never invented |

Strict unknown-field rejection is enforced by `additionalProperties: false` on the advertised schema and by the executor's `z.object(...)` parse, which the harness checks against the same JSON Schema so a rejection reads as `kind: "validation"` naming the key.

Successful output, today: the string "Posted the result to the work stream." or "The result was already posted to the work stream.", with the same text as `summary`.

Successful output, proposed, one object:

```json
{
  "outcome": "delivered" | "replayed",
  "destination": { "key": "slack_channel:conn_…:C0A4UF9RWAU", "kind": "slack_channel", "label": "#general" },
  "deliveryId": "<runId>",
  "providerOperationId": "C0A4UF9RWAU:1789093086.270489"
}
```

`providerOperationId` is present for a provider destination and absent for the owning room. `summary` carries a one-line human reading of the same outcome and nothing the model needs.

## 4. Discovery and sequencing

- Destination keys come from the run's own task context: `sidekick.resultDelivery` is rendered into the system prompt on every turn as a list of `{ key, kind, label }`, and the `# Result delivery` section names the tool. There is no lookup tool; a key is copied from that list.
- Keys are stable for the life of a definition revision. A room destination is `workstream:<workstreamId>`; a Slack channel destination is `slack_channel:<connectionId>:<channelId>`. They are resolved at acceptance, not at run time (decision 2), and stored on the revision beside the bindings.
- Common sequence: do the work, then `sidekick_post_result({ text })` when one destination is configured, or `sidekick_post_result({ text, destination: "<key>" })` per destination when more than one is. A second call for the same run and destination answers `replayed` and posts nothing.
- There is no `expectedRevision`; the run is pinned to a definition revision already, and the delivery ledger is keyed by run and destination.

## 5. Failure and self-healing contract

Every failure is a `kind: "validation"` result where the model can correct the call and an `external` result where it cannot; the sentence is the model-visible message and includes the next action. Structured detail rides only in the keys `readStructuredFailure` forwards (`reason`, `field`, `available`, `retryAfterMs`).

| Code | Class | Model-visible sentence | Details |
| --- | --- | --- | --- |
| `sidekick_destination_required` | validation | "This Sidekick has several configured destinations. Name one in `destination`, copied from sidekick.resultDelivery: <keys>." | `field: "destination"`, `available: [keys]` |
| `sidekick_destination_unknown` | validation | "No destination named `<key>` is configured on this Sidekick. Use one of: <keys>." | `field: "destination"`, `available: [keys]` |
| `sidekick_owning_room_archived` (today: thrown as a bare error) | external | "The work stream that owns this Sidekick is archived, so the result cannot be posted there. Put the complete result in your final message and stop." | `reason` |
| `sidekick_owning_room_missing` (today: bare error) | external | "The work stream that owns this Sidekick no longer exists. Put the complete result in your final message and stop." | `reason` |
| `sidekick_post_result_refused:<code>` (today) | external | "The work stream refused the result (<code>). Put the complete result in your final message and stop." | `reason` |
| `sidekick_delivery_refused` | external | "<Provider> refused the message: <provider code>. Do not resend the same message; put the complete result in your final message and stop." | `reason: <provider code>` |
| `sidekick_delivery_unconfirmed` | ambiguous write | "The message may have been delivered, but <provider> did not answer in time. Rally will not send it again. Put the complete result in your final message and stop." | `reason` |
| `sidekick_delivery_rate_limited` | external | "<Provider> asked Rally to wait before posting. Retry once after the wait; if it is refused again, put the complete result in your final message and stop." | `retryAfterMs` |

Distinctions the model has to be able to read from the result: a `validation` result is the model's to correct and retry; `refused` and the room outcomes are final for this run; `unconfirmed` is final and is the one case a person resolves from the run history; `rate_limited` is the one external outcome with a bounded retry. A destination refusal is also written onto the run (`runs.provider_error_code`) and counts toward the Sidekick's failure pause (decision 6).

## 6. Authority, safety, and lifecycle

- What is model choice: the text, and which configured destination. What is host-derived: the destination's channel, connection, thread mode (always top-level for a channel destination), the bot token, the idempotency key, and the delivery record. The model cannot address a channel that is not a configured destination through this tool; an ad-hoc send is a connector tool call and stays subject to that tool's own contract.
- The SidekickDO owns delivery. It records `deliveries(run_id, destination_key, state, provider_operation_id, provider_error_code, attempted_at)` with `state` in `started`, `delivered`, `refused`, `unconfirmed`, `replayed`, writes `started` before the provider call, and moves it on the answer. A retried tool call for a `started` row that never moved is answered `unconfirmed`, never re-sent.
- Cancellation and timeout: the harness's abort signal cancels the wait, not the provider call; a call already in flight settles the record on its own answer or expires to `unconfirmed`.
- Replay: a completed receipt replays the persisted object without a provider call, as every `record_before_execute` write does.
- Cleanup: nothing to clean; a delivery record is history and is listed on the run.

## 7. Next-step outputs

The successful object carries the destination key and kind (so a run posting to several can tick them off), the `deliveryId` (the run id, which is what the run history shows), and the provider operation id (the Slack channel and timestamp, which a person can turn into a permalink from the run history). A replay returns the persisted object with `outcome: "replayed"`. Output is small enough that truncation does not apply.

## 8. Model-usability acceptance

- Schema snapshot and contract tests for the tool: required `text`, optional and nullable `destination`, the strict-unknown-field rejection, the delivered and replayed success shapes, and every failure row above, in `apps/api/test-workers/automation-post-result.test.ts` beside the room case that exists today.
- A `test-workers` run against a Slack double: one configured channel destination posts top-level once; a second call replays; a refused post ends the run `failed` with the provider code on the run and no second send; a lost answer ends as `unconfirmed` with no second send.
- Prompt and tool evaluations on the configured medium fallback model covering discovery of the key from the task context, one two-destination sequence, the predictable wrong first call (omitting `destination` with two configured), the refused case ending in a final message rather than a retry, and the absence of a blind resend after `unconfirmed`.
