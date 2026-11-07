# Operator alerting

How the API Worker tells an operator that something has stopped working, rather
than waiting to be asked. Every diagnostic in this Worker is a structured log
row, and the saved Workers Logs views in [`runbook.md`](runbook.md#observability-views-and-retention)
are where an operator is expected to look; nothing in that arrangement reaches
out. This module is the reach-out: one bounded `chat.postMessage` from a small
internal Slack app into an operator channel, for the handful of events that
mean a thing has stopped, written beside the log row and never instead of it.

Read this before adding an event that notifies, changing what a notice may
contain, or changing how the channel is reached.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/observability/ops-slack-notifier.ts` | `notifyOps`: the one place a notice is rendered and posted. The single source. |
| `apps/api/src/env.ts` | `OPS_SLACK_BOT_TOKEN` and `OPS_SLACK_CHANNEL_ID`, the optional per-region pair. |
| `apps/api/src/durable-objects/scheduled-alarm-report.ts` | `reportScheduledAlarmAttempt`: the one policy for a gated alarm entry — which attempt warns, errors, and notifies — and `scheduledAlarmErrorCode`, which reduces a thrown error to what may leave. |
| `apps/api/src/durable-objects/workspace-do.ts`, `workstream-do.ts`, `substream-agent.ts` | The failure and stall hooks, each reporting through that policy with its own identity fields. |
| `apps/api/src/services/slack-agent-service.ts` | The exhausted-ingress-job notice, in `processQueuedIngress`. |
| `apps/api/src/routes/health.ts` | `opsNotifications` — configured, half configured, or not, never required. |
| `scripts/sync-dev-env.mjs`, `.env.example` | How the secret reaches a local `.dev.vars.*` file. |

## How it works

A caller that has just logged an event it considers alert-worthy calls
`notifyOps(env, { event, summary, fields })`. The notifier:

1. Answers `"skipped"` outside a deployed region (`APP_ENV` other than
   `production` or `staging`), and unless both `OPS_SLACK_BOT_TOKEN` and
   `OPS_SLACK_CHANNEL_ID` are set. The first guard is the same one Resend has:
   the sandbox has full network access and a developer's `.dev.vars` can carry
   the secrets, and neither may page the channel. The second is the ordinary
   answer in a region whose operator has not set it up.
2. Renders one Slack message: `[region] event` as the first line, the summary,
   then one `• key: value` line per field, each value collapsed to one line,
   cut at 200 characters with a visible mark, and escaped for `mrkdwn`, so no
   value can form a mention, a link, a channel-wide ping, or a line the reader
   takes for another field.
3. Posts it to `https://slack.com/api/chat.postMessage` with the token in the
   `Authorization` header, under a five-second cancellable deadline
   (`withDeadline`, so the call can sit inside a Durable Object alarm or a
   queue consumer without holding the invocation open).
4. Reads Slack's answer: `ok: true` is `"sent"`; `ok: false` is `"failed"`
   with Slack's own code (`channel_not_found`, `invalid_auth`, `not_in_channel`)
   on the `ops_notification_failed` row; an HTTP error, an unparsable body, a
   thrown request, or the deadline are `"failed"` with a fixed code.

It never throws. The caller has already recorded the event; a notification that
could take down the path it describes would be a second incident.

The events that notify today:

| `event` | Posted from | When |
| --- | --- | --- |
| `workspace_scheduled_alarm_failed`, `workspace_scheduled_alarm_stalled`, and the `workstream_object_` and `substream_` forms | the three objects' `onScheduledAlarmFailure` and `onScheduledAlarmStalled` hooks, through `reportScheduledAlarmAttempt` | An alarm entry is on its third consecutive attempt without progress — it threw, or ran and came back due at the same instant, and the gate in [`durable-object-alarms.md`](durable-object-alarms.md) has held it across a couple of minutes of growing backoff. The counter is shared, so the notice fires at exactly attempt three whichever hook sees it: once per episode. Every attempt writes a log row, at `warn` for the first two and `error` from the third. |
| `slack_ingress_job_exhausted` | `SlackAgentService.processQueuedIngress` | A Slack ingress job has reached the 20-attempt ceiling, by a non-retryable error or by its twentieth attempt. The claim refuses a job at the ceiling, so a Queue redelivery cannot run, pin, or report it again; only the reauthorization re-drive, which resets the count, brings it back. The `error` row of the same name is written for every job; the notice is one per installation and error code within an hour, because a broken installation fails every event the same way and a notice per job would track the channel's message volume. |

## Invariants

- **Log first, notify second, never notify instead.** The log row is the
  record; the notice is a pointer to it. A notice with no row beside it leaves
  an operator with a message and nothing to query. Breaking this makes the
  Failures view incomplete exactly when it matters.
- **A notice carries codes, counts, and opaque ids only.** Workspace and job
  ids, error codes, attempt counts, alarm kinds and keys. Never a prompt, a
  message body, connector content, a person's name or email, or a workspace
  name — this text leaves Rally for a third party, and the channel may be
  shared by configured deployments. The same rule `telemetry_operations_snapshot` keeps.
- **The token travels in a header, never in a URL.** The platform's automatic
  tracing records every outbound fetch's `url.full`, and Global exports those
  spans; a credential in a URL path — an incoming webhook's whole design — would
  have been exported on every notice. A header is what no span captures, and
  it is the shape every other provider secret in this Worker has. About the
  destination the notifier logs a status and a code, nothing else, and the
  logger's redaction list covers `token` besides.
- **Absent is a supported state, everywhere.** Neither secret is in
  `productionOnlySecrets` or required by the env contract; `/health` reports
  the pair and does not gate on it. Making either required takes a region
  offline over a Slack setting.
- **One notice per episode.** Each call site decides what an episode is — the
  third attempt of one entry, one installation failing one way within an hour
  — and posts once. A call site that posts on every occurrence of a repeating
  condition turns the channel into the log it was meant to summarize.
- **The notice is attached the way its caller can afford.** Inside a Durable
  Object hook it rides `waitUntil`, because a hook cannot await and the gate
  is already durable; inside the queue consumer's failure path it is awaited,
  bounded by the deadline, because the consumer is about to ask for a retry
  anyway and has nothing else to do with the five seconds.
- **One fixed destination.** The endpoint is a constant; the channel is the
  configured id. A mistyped token or channel fails closed as Slack's own
  `invalid_auth` or `channel_not_found` on the log row, not as operator data
  posted somewhere else.

## Boundary

Owns: rendering and posting one notice, the deadline, Slack's answer, and the
delivery outcome log rows. Exposes `notifyOps`, `renderOpsNotification`, and
`opsNotificationsConfigured`. Depends on the logger and `withDeadline`; on
nothing else in the Worker.

Any Worker or Durable Object code path that has just logged something an
operator should act on may call it. It is deliberately *not* the Rally Slack
app: that app is a product surface with a connection lifecycle of its own, and
on 2026-08-22 the thing that had stopped working *was* the Slack connector. An
operator channel must not depend on the path it may be reporting on. The
internal app it posts as is a separate Slack app with `chat:write` and nothing
else, installed once, and a member of the one channel.

It does not dedupe, rate-limit, or keep state. Each call site owns its own
"once" (see *Invariants*); if a future site needs a cooldown it cannot express
as a transition, that state is a new concern, not a field on this one. It does
not post to a channel of its own, page anyone, or read Cloudflare's API —
Cloudflare administration credentials never become Worker variables
([`security.md`](security.md#secrets)).

## Failure modes and limits

- **Slack is unreachable or refuses the post.** `"failed"`, with
  `ops_notification_failed` carrying `code`: Slack's own (`invalid_auth`,
  `channel_not_found`, `not_in_channel` — the bot was not invited), or
  `request_failed`, `timeout`, `http_error`, `response_unreadable`,
  `response_malformed`, `response_too_large`, each with `status` where there
  was one. The caller continues; the original log row stands.
- **The post takes longer than five seconds.** The deadline aborts it and the
  timer is cleared, so a Durable Object alarm or queue invocation ends when its
  work does.
- **A field value is enormous.** Cut at 200 characters per field; a notice
  cannot flood the channel.
- **The secrets are set locally or in a sandbox.** The sandbox's network
  access is full ([`sandbox.md`](sandbox.md)) and a `.dev.vars` file can carry
  them, so neither the host nor the secrets' absence protects the channel; the
  `APP_ENV` guard does. A local Worker answers `"skipped"` with both set.
- **A handler's error is not a code.** The failure report carries the thrown
  message on the log row, but the notice carries it only when it has the shape
  of a code — `isCodeShaped` from `@rally/contracts`, the one class every such
  field shares; a parse error quoting a row becomes `handler_error:<ErrorClass>`.
  A Zod issue list is the exception with structure worth keeping: the notice
  names its failing paths and issue codes, `handler_error:ZodError:<path>:<code>`,
  and never the rejected values
  ([`naming-a-schema-failure.md`](naming-a-schema-failure.md)).
- **A stall resolves and recurs.** The alarm gate resets when the entry's
  instant moves, so a new episode notifies again at its own third attempt.
  That is the intended reading: each message is one continuous stall.

## Testing

- `apps/api/test/ops-slack-notifier.test.ts` — the notifier in the Node suite
  with an injected `fetch`: skipped without either secret or outside a
  deployed region, the token in the header and in no log row, the message
  shape, Slack's refusal by code, a rejected or unparsable answer, a throwing
  request, the deadline, field truncation and `mrkdwn` escaping.
- `apps/api/test/workspace-alarm-stall-alert.test.ts` — `WorkspaceDO`'s
  failure and stall hooks: warn on attempts one and two, error from three, post
  exactly once, an episode that mixes throws and stalls posts once, a
  thrown message that is not a code reaches the channel as the error's class,
  and a handler's own schema rejection reaches it naming the field and not
  the value.
- `apps/api/test/slack-workspace-assignment.test.ts` (deleted in plan step C-2) ("Slack ingress jobs given
  up on") — the exhausted-job notice is posted once at the ceiling, a Queue
  redelivery of the dead job posts nothing, and a failure the queue will retry
  posts nothing.
- Fixture token: `xoxb-ops-test`. Gitleaks runs its default Slack token rules,
  which want digit groups, over the commits a pull request adds; a
  realistic-looking token in a test trips the gate on the pull request that adds
  it.

## Operations

Create a small internal Slack app — "Rally Ops" — with the `chat:write` bot
scope and nothing else, install it to the workspace, create the operator
channel, and invite the app to it (`/invite @Rally Ops`; without this Slack
answers `not_in_channel`). Then set the bot token and the channel id in each
region. Wrangler authenticates with the Cloudflare token in `.env.local`, the
way every other deployment command in `package.json` does:

```bash
pnpm exec dotenv -e .env.local -- pnpm --filter @rally/api exec wrangler secret put OPS_SLACK_BOT_TOKEN --config wrangler.global.jsonc
```

```bash
pnpm exec dotenv -e .env.local -- pnpm --filter @rally/api exec wrangler secret put OPS_SLACK_CHANNEL_ID --config wrangler.global.jsonc
```

### 2026-08-22 — Created

**What changed:** `notifyOps`, posting as a small internal Slack app with the
`OPS_SLACK_BOT_TOKEN` and `OPS_SLACK_CHANNEL_ID` secrets, with two callers: the
gated-alarm report every scheduling object's failure and stall hooks share, at
the third consecutive attempt, and a Slack ingress job reaching its attempt
ceiling.

**Why:** On 2026-08-22 two `@Rally` mentions died on `session_revoked`, and the
workspace's alarm then hot-looped for hours writing an error row a second. Both
were on record in Workers Logs from the first minute, and neither was seen
until someone opened the logs for a different reason. The repository's standing
answer — let the platform's own failures be the monitoring — assumes a failure
somebody will notice; a log row nobody is reading is not one. This is the
smallest thing that turns those two rows into a message.

**Considered and rejected:** Posting through the Rally Slack app's own bot
token: the incident was in the Slack connector, and the alert path cannot share
its failure modes. A Slack incoming webhook — the first draft: its credential
is the URL path, the platform's automatic tracing records every outbound fetch
as `url.full` with no redaction hook, and Global exports those spans to
PostHog, so the secret would have left on every notice; a bot token travels in
a header, which no span captures. A Cloudflare notification policy: none exists
for log patterns. A scheduled Worker that queries the observability API and
posts a digest: it would need a Cloudflare API token as a Worker variable,
which the security model forbids, and it reports on a cadence rather than on
the event. A dedupe or rate-limit table: no call site needs one yet, and a
notifier with state is a different, larger thing.

**Consequences:** Every alert-worthy condition is a code change at the call site
that already logs it, under the one-notice-per-episode rule. The secrets are
optional in every region, so nothing about a deployment changes until an
operator sets both. Setting up the channel means creating one more Slack app,
which is the price of keeping the credential out of every URL.
