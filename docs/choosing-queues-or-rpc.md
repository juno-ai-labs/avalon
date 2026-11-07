# Choosing between a Queue and RPC

Rally's Workers and Durable Objects talk to each other two ways: a **Cloudflare
Queue**, where the sender writes a message and walks away, and **Workers RPC**
over a service binding or a Durable Object stub, where the caller invokes a
method and waits for what comes back. This document says which to reach for.

**The default is a Queue.** Reach for RPC when the hop has a property from the
[list below](#you-must-use-rpc-when) that a Queue cannot provide — most often a
return value the caller acts on. That is a real list, not a formality — several
of the hops in [the table at the end](#where-avalon-stands-today) are on it. But when neither list decides it,
the Queue is the answer, because the failure it prevents is the one that only
appears under load, in production, at the worst moment.

Read this before adding any hop between two Workers, between a Worker and a
Durable Object, or between two Durable Objects.

## Why the default is a Queue

A synchronous call couples the caller's fate to the callee's. The caller stays
alive until the callee answers; if the callee is slow, the caller is slow; if the
callee is saturated, the caller queues behind everyone else; and if the callee is
down, the caller has to invent its own retry. None of that is visible in a code
review, and none of it shows up in a test. It shows up as a herd.

The specific shape it takes here: **a Durable Object is single-threaded, with a
soft ceiling of about 1,000 requests per second to one object.** Any design where
many callers converge on one object has a serialization point, and the Nth caller
waits behind the other N-1. A Queue moves that convergence onto infrastructure
built for it — 5,000 messages per second per queue, 25 GB of backlog as a shock
absorber — and then hands the expensive side **batches of up to 100 messages**, so
the object does one unit of work per batch rather than one per message. That
batching, not the decoupling, is usually the win worth the most.

A Queue also owns retry. RPC failure is the caller's problem, and the caller is
frequently a Durable Object that will not exist again for hours. A Queue retries
up to 100 times and then writes the message to a dead-letter queue where a person
can find it.

There is a second reason the default matters more here than it would somewhere
with a real metrics stack: **the two mechanisms fail differently when nobody is
watching.** An overloaded Queue produces a backlog and eventually a dead-letter
queue with messages in it — a binary, zero-setup signal that something is wrong.
An overloaded synchronous hop produces latency and timeouts smeared across
unrelated requests, which presents as "the product feels slow today" and is
diagnosable only with tooling Rally does not have. Prefer the failure you will
notice.

## You must use RPC when

Each of these is a correctness requirement, not a preference. A Queue cannot be
made to satisfy them without rebuilding RPC on top of it, which
[you should not do](#do-not-reinvent-one-in-terms-of-the-other).

- **The caller uses the return value.** `queue.send()` resolves when the message
  is accepted, not when it is handled — it can tell you the work was *asked for*
  and nothing else. If the caller branches on the answer, it is RPC.
- **The caller must not proceed until the callee has committed.** Authorization
  decisions, admission control, uniqueness reservations, read-your-writes.
  Continuing on state that has not landed yet is a correctness bug, not latency.
- **The value being passed is not plain data.** A stub, an `RpcTarget`, a
  WebSocket, a stream, a live handle. A queue message is serialized bytes; none
  of these survive it. RPC also has real lifetime rules here — a stub keeps the
  server-side object alive until it is disposed — so read
  [the RPC lifecycle docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)
  before passing one.
- **You are having a conversation with one specific stateful object.** Several
  ordered calls against the same Durable Object inside one request, where its
  state changes between them. Queues do not guarantee ordering at all.
- **A person would notice the delay.** Not "a person is waiting" — those are
  different claims, and [the difference](#be-honest-about-question-three) decides
  more of these than anything else in this document. When it is genuinely
  perceived, RPC over a service binding is same-thread with zero added latency
  and does not count against the simultaneous-connection limit.
- **The error has to reach the caller.** When a failure must become a 4xx or 5xx
  for a user on this request, the caller needs to see it happen.

## You should use a Queue when

- **Many senders converge on one receiver.** This is the case the default exists
  for. See the single-threaded ceiling above.
- **The sender must not be held open.** A Durable Object awaiting an RPC inside
  `waitUntil` stays alive and billable for as long as the callee takes. A send
  resolves as soon as the message is accepted.
- **Retry has to outlive the sender.** If the sender is a hibernating object,
  "retry on the next wake" can mean days — or never, for an object nobody
  touches again.
- **The work is genuinely fire-and-forget**: telemetry, projections,
  notifications, audit trails, anything where the sender's job is done the moment
  the fact is recorded somewhere durable. A runtime `waitUntil` deferral is not
  that durable hand-off: use it only for observational work that may be lost
  before acceptance, never when retry must survive deployment or runtime reset.
- **The two sides should deploy independently.** A service binding names a
  *script*, and deploying a caller before its target script exists fails the
  deploy. A queue is a resource both sides bind to, so neither ordering breaks.
- **Spikes need absorbing.** A backlog is a shock absorber; an overloaded Durable
  Object is an error.

## Deciding when neither list settles it

Ask these in order and stop at the first yes:

1. Does the caller read the result? → **RPC.**
2. Is it wrong for the caller to carry on as though this already happened? →
   **RPC.**
3. Would the delay actually change what a person sees or does? → **RPC.**
4. Otherwise → **Queue.**

### Be honest about question three

**This is the one that gets answered wrong, and it is answered wrong in the same
direction every time.** Real-time synchronisation feels like the safe choice, so
it gets chosen by default, and the cost is paid forever by a system that is more
coupled than the product ever needed it to be.

The delay a Queue actually costs is the batch window plus consumer scheduling —
call it a few hundred milliseconds to a second with a tuned `max_batch_timeout`.
So the question is not "is this in a request path" but **"name the user story
that breaks if this lands a second later."** If you cannot name one, the delay is
acceptable, and you should stop arguing from discomfort.

Most hops cannot name one. A projection catching up, a counter incrementing, an
audit row landing, a notification going out, a search index refreshing, a
dashboard learning something — a person waiting on a page does not perceive that
the work behind it settled 800 ms after the response. "A person is waiting" and
"a person would notice" are different claims, and only the second one buys RPC.

What that second buys you is **resource isolation**, which is a real product
property and usually worth more than the latency: the slow side cannot slow the
fast side, a saturated consumer cannot make the producer's request time out, and
a spike is absorbed rather than shed. Trading a second of invisible delay for a
failure mode that never reaches a user is a good trade, and it is available far
more often than it is taken.

Where the second does genuinely matter: **read-your-writes**, where someone acts
and immediately expects to see the result, and anything a person will refresh to
check. Those are worth naming precisely, because naming them is what stops the
requirement from spreading to everything nearby.

And when a Queue is right but the default window is too slow, **tune the window
before you abandon the mechanism.** Rally's activity queue was set to
`max_batch_timeout: 1` for exactly this reason: at five seconds a Slack unfurl
appeared six seconds after the message, which was a real complaint with a real
user story behind it. The fix was one second, not a service binding. Slack
ingress, unfurls included, now rides the [interactive queue](interactive-queue.md),
which keeps the same one-second window.

### Deciding without measurement

Rally has no load history, no queue-depth dashboard, and no capacity model. A
rule in this document that said "measure it first" would be a rule nobody could
follow: it would either block the decision indefinitely or get waved through with
a guess wearing the costume of data. So **none of the criteria here depend on
measurement.** Three things replace it.

**Arithmetic against the published limits.** You cannot measure throughput, but
you can multiply. Five thousand messages a second is 432 million a day. If the
hop you are adding emits one message per user action and the product has
thousands of users, it sits four orders of magnitude under the ceiling and the
capacity question is settled on a napkin. Do that sum, record the answer in a
comment next to the resource, and move on — being wrong by a hundredfold still
leaves you inside the limit. The
[limits table](#the-limits-that-decide-the-argument) exists to make this sum
possible.

**Reversibility over correctness under invisible load.** When you cannot see the
load, optimise for how cheap the decision is to undo rather than for being right
about a future you cannot observe. Splitting a shared queue later is a
configuration change and a deploy; merging two split queues is the same. Neither
is a rewrite, so take the simpler shape now and change it when something tells
you to.

**Let the platform's own failures be the monitoring.** This is the other half of
[trusting the primitives](#trust-the-primitives): you do not have to build
observability to find out you were wrong, because the platform reports it.

- **A non-empty dead-letter queue** is the highest-signal, zero-setup alarm
  available anywhere in this system. No dashboard, no instrumentation — messages
  are in there or they are not, and if they are, something is broken. This is
  the concrete reason a DLQ is not optional.
- **Cloudflare's overloaded errors** on a Durable Object are the capacity signal
  you would otherwise have built a metric to approximate.
- **The structured log line each consumer already writes** — one per batch, with
  counts — is a queryable record in Workers Logs that costs nothing extra.
- **Somebody saying it feels slow** is a real signal, and at this size it is
  usually the first one to arrive. The activity queue's batch window was found
  that way, not on a chart.

None of this makes guessing acceptable. It means the guess should be arithmetic
against a published number, written down where the next person can check it.

## What a Queue makes you handle

These are consequences of the platform, not of Rally, and every consumer has to
account for them:

- **Delivery is at-least-once.** A message can arrive twice. The consumer needs a
  dedupe key — an id on the message with a unique index behind it — or has to be
  naturally idempotent. "It probably will not happen twice" is not a design.
- **Ordering is not guaranteed**, within a batch or across batches. If a message
  overwrites state, guard the write with the sender's own timestamp or sequence
  rather than trusting arrival order.
- **A thrown consumer fails the whole batch.** Unless individual messages were
  acknowledged with `msg.ack()`, one bad message causes every message in the
  batch to be redelivered. Acknowledge per message, or make the batch handler
  total.
- **A dead-letter queue is not optional.** Without one, a message that exhausts
  `max_retries` is deleted. Configure a DLQ on any queue whose messages matter.

Handle these four, and nothing beyond them — see
[Trust the primitives](#trust-the-primitives).

The queue itself needs no handling. Declare it in the Wrangler file — producer
binding, consumer settings, dead-letter queue — and the deployment preflight
creates it if the account does not hold it; there is no step to run by hand,
and a queue only one side names is refused as a misspelling. The procedure is
in [`runbook.md`](runbook.md#the-durable-object-migration-tracker).

## The limits that decide the argument

Reproduced here because they are what makes one option viable and the other not.
Cloudflare's [Queues limits](https://developers.cloudflare.com/queues/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/), and
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
are authoritative; check them before relying on a number here.

| Queues | Value |
| --- | --- |
| Throughput per queue | 5,000 messages/second |
| Message size | 128 KB |
| `sendBatch` | 100 messages, or 256 KB total |
| Consumer batch size | up to 100 (default 10) |
| `max_batch_timeout` | 0–60 seconds (default 5) |
| Retries | up to 100 (default 3), then the DLQ |
| Backlog per queue | 25 GB |
| Concurrent consumer invocations | 250 (push-based) |
| Consumer wall clock | 15 minutes |
| Message retention | up to 14 days |
| Consumers per queue | one |
| Queues per account | 10,000 |

| RPC and the runtime | Value |
| --- | --- |
| Service-binding latency | zero added; same thread by default |
| Subrequests per invocation | 10,000 paid, 50 free — **a service-binding call counts** |
| Simultaneous open connections | 6 — a service-binding call does **not** count |
| Requests to one Durable Object | ~1,000/second soft limit; single-threaded |
| Worker memory | 128 MB per isolate |
| CPU per invocation | 30 seconds default, up to 5 minutes |

Two of these decide most arguments. A service-binding call is free in latency
terms, which is why RPC is right when someone is waiting. And one Durable Object
tops out around 1,000 requests per second on one thread, which is why RPC is
wrong when everyone is converging on one.

## Splitting per region

[`regionalization.md`](regionalization.md) owns the boundary itself — what is
Global, what is regional, and what is allowed to cross. This section is only
about the shape of the resource carrying it.

### The decisive test

**Would splitting the transport change where the data comes to rest, or who
processes it?** If it would not, do not split. Two pipes into one funnel is not
isolation; it is two of everything to provision, configure, monitor, and keep in
step, bought for nothing.

- **The regions genuinely need different policy** — retention, retry budget, or
  batch window differing for a stated compliance or product reason, not from
  drift.

- **One region's volume alone approaches a per-resource ceiling.** Settle this
  with [arithmetic, not a dashboard](#deciding-without-measurement): estimate
  messages per user action times users, compare against 5,000 a second, and put
  the sum in a comment. At Rally's size the answer is almost always no by
  several orders of magnitude.

### No-go — share one resource when all of these hold

- **The destination is already shared.** One store, one consumer, one object at
  the far end means splitting the near end isolates nothing.
- **The payload is operational metadata, not workspace content** — opaque
  identifiers, versions, class names, error strings that describe code. There is
  nothing here for a residency boundary to protect.
- **The arithmetic puts volume nowhere near the ceiling**, so the split would buy
  no headroom either. One sum, recorded in a comment — see
  [Deciding without measurement](#deciding-without-measurement).

That combination is exactly the migration-report queue: an opaque object id, a
schema version, and an error describing code, all converging on one account-wide
registry object by design. A second queue would have doubled the resources and
isolated nothing, so there is one.

- **Name by region, consistently**: `avalon-<region>-<purpose>`, plus a
  region-named dead-letter queue for each. A shared DLQ behind split queues
  defeats the split at exactly the moment it matters.

- **Keep one binding name across both configs.** `ACTIVITY_QUEUE` points at a
  different queue in each regional Wrangler file, so one code path serves both
  regions and region selection stays deployment configuration rather than
  application logic. Never branch on region in code to pick a binding.

- **Never let a regional consumer reach into the other region's stores.** A
  regional queue with cross-region bindings behind it is not a regional
  subsystem; it is a residency hole with a tidy name.

- **Still carry the region in the message body.** The queue implies it, but a
  message that states it is self-describing in a log and in a stored row, and it
  catches a misrouted producer that the queue's name never would.

- **No Global fallback.** A message that cannot be handled in its region fails
  and retries there; it does not get rerouted to the other one.

### Best practices when you do not split

- **Say why in the configuration**, next to the resource. A name that breaks the
  `avalon-<region>-` convention will look like an oversight to the next reader,
  and they will "fix" it.
- **Put the region in the message body and validate it in the contract.** It is
  the only thing carrying the region now.
- **Hold the payload to the bar that justified sharing**, and make the contract
  enforce it rather than a comment. The migration report's
  `isOpaqueDurableObjectName` guard exists for exactly this: the day a field
  starts carrying something legible, the message is refused rather than
  quietly shipped.
- **Revisit if the destination becomes regional.** The decision follows the far
  end, so a change there reopens this one.

### The same question for RPC

A service binding does not have a per-region shape to choose — it names a script,
and the regional deployment names a different script. The equivalent question is
whether the call crosses the boundary at all, and Rally's answer is that it may,
through a small number of named bridges that parse their argument at the hop
against `apps/api/src/lib/rpc-contracts.ts`. Adding a cross-region RPC is a
change to that boundary and belongs in
[`regionalization.md`](regionalization.md), not here.

## Which Wrangler file each half goes in

Provisioning a queue is not a step any more — declare it and the deployment
preflight creates it, per [the section above](#what-a-queue-makes-you-handle).
What is still a decision is *where* the declaration goes, and that is not a
detail: a queue declared on the wrong Worker is valid JSON, deploys, and fails
in a way the preflight was never asked about.

- **The producer binding goes in the Worker that sends.** It is a binding, so it
  belongs to the sender's config and nowhere else.
- **The consumer goes in the Worker that has to do the work** — the one holding
  the D1, R2, or Durable Object namespaces the messages are about.
- **Exactly one Worker may consume a queue.** A platform limit, not a
  convention, and it is what forces a split when the work has to happen in a
  particular region.
- **A dead-letter queue on every consumer**, named after that consumer's queue.
  A shared dead-letter queue behind split queues defeats the split at exactly
  the moment it matters.
- **Naming**: `avalon-<region>-<purpose>` when split. A shared queue breaks that
  convention, so it has to say why in a comment next to the resource, or the
  next reader will "fix" it.

### Verifying it landed in the right file

Two of the three placement errors are refused by
`scripts/ensure-cloudflare-queues.mjs` before it creates anything, so they fail
the deploy rather than a review:

- **A name only one side declares** — `assertPairedQueues`. A misspelled
  producer would otherwise be created and attached, the deploy would go green,
  and messages would land in a queue nothing drains.
- **A queue two Workers consume** — `assertSingleConsumerPerQueue`. Cloudflare
  allows one, and nothing local refuses a second: the *second* deployment fails,
  after the first has shipped and attached itself.

The third has no automatic check, because it is a judgement rather than a
contradiction: **a consumer on the wrong Worker, where that Worker can still do
the work.** For that, read the queue bindings in each Wrangler file. For what
a deploy would actually carry, the dry-run builds print the resolved bindings per surface:

### What none of that checks

**A consumer that is declared but not routed.** A Worker gets one `queue`
handler for every queue it consumes, so `apps/api/src/index.ts` dispatches on
`batch.queue` by name. A new queue added to a Wrangler file with no matching
branch there is still consumed — its messages fall through to whichever handler
the chain ends in. Nothing fails; the wrong consumer runs. Add the branch in the
same change as the declaration, and prefer a predicate exported beside the
contract over a string literal in the `if`, so the queue's name and the test for
it cannot drift.

## Trust the primitives

**Take Cloudflare's guarantees at face value and build on them optimistically.**
Queues and Workers RPC are production systems with published contracts, operated
by people whose job is keeping them true. Design against what the contract says
and then stop.

Concretely, that means the guarantee replaces the thing you would have built:

- The docs say retries and a dead-letter queue, so you do not need a retry
  ledger, a redelivery alarm, delivery receipts, or a reconciliation sweep that
  asks whether messages really arrived.
- The docs say a service-binding call has zero added latency and runs on the same
  thread, so you do not need a cache in front of one to avoid a network hop that
  does not exist.
- The docs say 5,000 messages per second and a 25 GB backlog, so you do not need
  your own admission control until the arithmetic puts you near either. The
  platform enforces its own ceiling and tells you when you hit it; that is the
  capacity monitoring you have, and it is enough.

Defensive scaffolding is not free. It runs on every message, it has its own bugs,
and it is exercised far less than the platform path it distrusts — so when it
fails it fails in the least tested code you own. The asymmetry is the whole
argument: the platform's failure modes are documented, monitored by someone else,
and fixed without you; your compensation layer is none of those things.

This is not the same as being credulous. **Design for the guarantee you were
given, not a stronger one.** At-least-once means plan for twice. Unordered means
plan for out of order. One consumer per queue means plan for one. Reading the
contract carefully and then relying on it completely is the posture — the failure
is assuming a guarantee nobody made, not trusting the one they did.

## Do not over-engineer

**Use the right tool for the hop in front of you, and do not reinvent one
technology in terms of the other.** Both of these are complete, maintained
products. Rebuilding either one badly inside the other is the most expensive
mistake available here, and it is always made with good intentions.

### Do not reinvent one in terms of the other

- **Do not rebuild a Queue on top of RPC.** A retry ledger in the caller's
  storage, an alarm that re-attempts delivery, a "pending outbox" table whose
  only job is redelivery, a backoff schedule you wrote. That is a queue, with no
  dead-letter queue, no backlog, no observability, and tests that only cover the
  happy path.
- **Do not rebuild RPC on top of a Queue.** A correlation id, a reply queue, and
  a loop that polls for the answer. If you need an answer, the answer is RPC.
- **One hop, one mechanism.** Do not enqueue a message *and* call RPC for the
  outcome, and do not RPC *and* enqueue a follow-up that does the same work.
  Two paths for one message is not defence in depth — it is two failure modes,
  and the one you did not think about is the one that is untested.

### Do not reach for either when neither is needed

- **If it is in the same Worker, call the function.** A binding is for crossing a
  deployment boundary. Splitting code into two Workers so they can talk over a
  binding, when one Worker would do, buys a network contract and a deploy order
  for nothing.
- **A hop carrying one message a minute does not need a queue.** The default
  exists for fan-in and durability. A low-volume call that needs no retry and no
  answer can stay a simple call.
- **Do not add a second queue to shape traffic you do not have.** Priority
  queues, sharded queues, and fan-out topologies are answers to a problem you
  have actually hit. Add one when something told you — a backlog, a dead-letter
  queue with messages in it, a complaint — not when you imagined one.
- **A Durable Object never addresses itself.** An object that resolves its own
  name pays a namespace lookup, a placement-affinity read, and a round trip to
  reach storage it is already holding, competes with itself for its own single
  thread, and cannot include the result in the transaction it is in the middle
  of. This is not a rule you have to remember at each call site, because almost
  every call site is a shared helper that is right for the Worker calling it and
  wrong only when the caller turns out to be the object: `durableObjectSelfForId` in
  `apps/api/src/lib/durable-object-self.ts` recognizes the case and hands back
  the object instead. What you do have to remember is to register a new Durable
  Object class there, in its constructor, the way the four existing ones do.

The test for all of this: if you find yourself writing infrastructure — retry
schedules, correlation ids, backpressure, delivery receipts — stop and check
whether you have chosen the wrong mechanism and are now paying to reimplement the
right one, or whether you have chosen the right one and are paying to distrust
it.

## Where Rally stands today

| Hop | Mechanism | Regional shape | Why |
| --- | --- | --- | --- |
| A Slack event, interaction or command into its regional job (`INTERACTIVE_QUEUE`, `slack_ingress`) | Queue, then typed WorkspaceDO RPC | Split | **A person is waiting on the answer**, so it does not share the activity queue's backlog, which once held Slack replies for 15 minutes. Still a Queue, not RPC: Slack's three-second acknowledgement must not wait on a cold object, and the job needs the Queue's retry and dead-letter queue. See [`interactive-queue.md`](interactive-queue.md). |
| Connector activity into the regional consumer (`ACTIVITY_QUEUE`) | Queue, then typed WorkspaceDO RPC | One shared Queue per region | Fan-in from webhooks and polls; nothing waits on the outcome. After authoritative ingress, an ID-only process pointer returns to the same Queue for native retry, and each delivery claims/settles its named WorkspaceDO by RPC. Product flows intentionally share the regional Queue at Rally's current scale. |
| A verified GitHub delivery into its routing (`ACTIVITY_QUEUE`, `github_webhook_delivery_v1`) | Queue, then in-process call or the regional bridge's RPC | Global's Queue | **Nothing the webhook answers depends on the outcome**, and GitHub gives up after 10 s. The receiver verifies the signature and enqueues; the consumer looks up the installation's regions and hands each the verified bytes. A body over the message limit is staged in `PAYLOADS`. The bridge call is RPC because the consumer must see a region's failure to retry the message. See [`connectors.md`](connectors.md#github-app). |
| A model call's cost into the usage ledger (`USAGE_QUEUE`, `avalon-<region>-usage`) | Queue | Split | Nothing the call site does depends on the outcome, and metering must never slow or fail the call it measures, so the call site sends in `waitUntil` and walks away. Batches of 100 make one D1 transaction cover many events, and one consumer at a time keeps the dedupe and the totals from racing. Split because each event names a workspace whose ledger lives in that region's D1. See [`usage-metering.md`](usage-metering.md). |
| Durable Object migration reports into the tracker | Queue | Shared | Many objects converge on one registry object, and a deploy or a cutover wakes them together. Shared because that registry object is the destination for configured deployments and the payload is opaque infrastructure metadata. See [`durable-object-migration-tracking.md`](durable-object-migration-tracking.md). |
| Forced migrations into the objects that must apply them (`avalon-<region>-migration-commands`) | Queue | Split | An operator picks a class on the migration tracker and every live object of it is woken, which is hundreds of cold starts no single invocation should hold open. Split because a queue has exactly one consumer and only the region's own Worker binds its namespaces — the constraint below decides it outright. The consumer's call into each object is RPC because it reads back the version the object landed on. See [`durable-object-migration-tracking.md`](durable-object-migration-tracking.md). |
| Access revocation into the socket-holding objects (`ACCESS_REVOCATION_QUEUE`) | Queue | Split | The Worker that ends a membership or a session walks away; nothing it returns depends on the sockets closing. Each object is one hop, so a hop that fails retries alone rather than restarting the walk, and the consumer's calls into the objects are RPC because it reads back the children each one names. A hop is a message only where it crosses objects: a Channel's step runs inside the `WorkspaceDO` hop that reaches it (the workspace hop and the narrowing hop), because the Channel's sockets and children are that object's own, so the consumer publishes the conversations directly. Split because the objects, the sessions, and the memberships never cross the boundary. See [`access-revocation.md`](access-revocation.md). |
| Ace product-flag change into connected clients | Shared Queue, then split Queues, then RPC | Shared fan-out; regional delivery | A successful Flagship write must wake every current workspace without holding the operator request open. The shared consumer enumerates both regional D1 directories and sends one key-only message per workspace to the queue consumed by that region's API. The regional Worker RPCs its WorkspaceDO because only that Worker owns the namespace; the object needs the call but no response affects the Queue acknowledgement beyond success. Values never travel through the fan-out because each connected user may match a different rule. See [`ace.md`](ace.md). |
| A conversation's effects into its parent (`ACTIVITY_QUEUE`, `conversation_effect`) | Queue, then typed parent RPC | Split | A `SubstreamAgent` commits a directory, viewer, activity, or notification effect with its product transaction and walks away; the alarm sends the envelope inline and deletes the outbox row when the Queue accepts it, and the consumer calls `receiveChildEffects` on whichever parent the envelope names: `WorkspaceDO` for every parent, a Channel, a Space or a Sidekick. Nothing loads an envelope back and nothing acknowledges one to the child; the parent's receipt makes a redelivery a no-op. This was the one RPC hop in the pipeline, kept for per-stub ordering the receipts made unnecessary. See [`workstream-durable-object.md`](workstream-durable-object.md#durable-object-communication-rpc-versus-queue). |
| A parent's effects into the workspace (`ACTIVITY_QUEUE`, `parent_effect`) | Queue, then typed WorkspaceDO RPC | Split | Retired with the Thread host, which was the only producer: a late activity, notification or directory message is acknowledged as `parent_effect_producer_retired`, a `scope_grant_directory` one still goes to `applyScopeGrantDirectory`, and a late `directory_automation` message from the deleted `SidekickDO` is acknowledged and ignored. A Canvas's or Sidekick's mention never takes this hop: the parent lives in `WorkspaceDO` and records the intent inside the effect's own transaction (see [`hosted-conversation-parents.md`](hosted-conversation-parents.md#the-outbox-is-work-that-leaves-the-object)). Replaces the opaque wake-up, the load-back RPC, and the acknowledge RPC. |
| A matched connector event into its destination (`ACTIVITY_QUEUE`, `workspace_external_event_delivery_v1`) | Queue, then typed RPC | Split | One message per matched registration, carrying the registration, the destination, and the event; `WorkspaceDO.sidekickAdmitExternalEvent` and `SubstreamAgent.appendWatchedResourceEvent` are idempotent on the event, so there is no delivery ledger and no lease. |
| Worker to a conversation parent (`WorkspaceDO` for every parent) | RPC | Same region | The caller needs the answer: `reserveChild` when a Space or a connector path creates a parent (a Channel's ordinary creation reserves inside `reserveChannelInSpaces`, below), because the child cannot be initialized before its parent has recorded it and the provisional directory row has to exist before the creator's first open; `authorizeViewer` and `authority`, because a ticket cannot be issued without the decision. |
| A run's loop to its Sidekick (`WorkspaceDO`) | RPC | Same region | `readRunDefinition` at loop start and `readRunState` before each provider write: the run cannot build its prompt, or spend a credential, without the answer. |
| A Sidekick run child to its Sidekick (`WorkspaceDO`), before continuing the run | RPC | Same region | `sidekickContinueRun`: the activation cannot be built without the run's context, and a refusal settles the input in the same drain. The run row reopening goes the other way, through the Queue, as the child's ordinary `directory_common` projection. |
| A Sidekick's run entry into provisioning, and its review entry into the wizard (`ACTIVITY_QUEUE`, `sidekick_run_provision` and `sidekick_review`) | Queue, then typed RPCs, then a report RPC back | Same region | **The sender must not be held open**: the entry runs inside the Organization object's alarm, and one cold conversation object awaited there would hold every other entry behind it. The consumer's calls are RPC because it reads the run's or the review's context back and because a refusal has to reach it. The report back (`sidekickRunProvisioned`, `sidekickReviewDelivered`) and the entry's own resend are not a second Queue: the Queue's retry covers a failed consumer, and the entry covers a message the Queue accepted and then lost, which the Queue does not report; without the report the entry cannot tell the two apart. A review is admitted under a stable client message id, so a resend racing a delivery is a replay. See [`automation-lifecycle.md`](automation-lifecycle.md#scheduled-self-review). |
| A run's `conversation_post` tool to a Channel or Breakout conversation | RPC | Same region | WorkspaceDO's `resolveConversationToolTarget` (scope and admission) and then the target's `appendConversationPost`; the tool result the model reads is the target's `appended`, `replayed`, or `refused`. |
| Worker to `SubstreamAgent` product calls (`WorkstreamObjectClient`) | RPC | Same region | Reads and writes whose results the request returns to the desktop. |
| `WorkspaceDO` typed product SQL | RPC | Same region | A conversation with one specific object, with rows coming back. |
| Worker to `WorkspaceDO` to create a Space (`admitSpaceCreation`, then `reserveSpace` or `openGeneralSpace`) | RPC | Same region | **The caller uses the return value** and must not proceed until it has committed: the answer is the Space the route returns. One RPC, one transaction: the Space row and its hosted parent (metadata and provisional directory row) are in the same database, and that transaction is the whole Space. The permission is asked first because the D1 anchor is written before the reservation, so a refused caller writes nothing; a D1 failure after it leaves nothing to undo. |
| Worker to `WorkspaceDO` to create a Channel in its Spaces (`reserveChannelInSpaces`) | RPC | Same region | **The caller must not proceed until the callee has committed, and it uses the return value.** One call commits the memberships, the Space defaults, the Channel's parent with its provisional directory row in one SQLite transaction, and answers with the Spaces the conversation's opening audience is derived from. A Space the caller cannot reach refuses here, and **that error has to reach the caller** as the creation's 4xx. It replaced five sequential calls for one Space (General's reservation, the staged membership and its settlement, `reserveChild`) plus a concurrent `flushProvisionalDirectory`, because every row those wrote is in this one object. See [`workstream-creation.md`](workstream-creation.md#what-the-server-makes-you-wait-for). |
| Worker to `WorkspaceDO` to add, remove or move an existing Channel, archive or restore a Space, or place a Channel in General for the cutover (`addSpaceChannel`, `removeSpaceChannel`, `moveSpaceMembership`, `archiveSpace`, `restoreSpace`, `placeChannelInGeneral`) | RPC | Same region | **The caller uses the return value and must not proceed until the callee has committed**: the answer is the Space summary the route returns. Each is one call and one WorkspaceDO transaction that reaches no Channel, because [a Space grants no reader](spaces.md#a-space-starts-organization-wide-and-grants-no-reader). A refusal **has to reach the caller**, so it comes back as a structured refusal naming its code rather than as a thrown `Error`. See [`spaces.md`](spaces.md#membership). |
| A Space's defaults into the Channel that inherits them (`ACTIVITY_QUEUE`, `space_default`) | Queue, then the consumer's typed RPCs | Split | **Genuinely fire-and-forget once the fact is durable.** The resource and Sidekick a Space hands down are staged in `space_default_targets` inside the same transaction that placed the Channel, and nothing the creator sees waits on their delivery. **Retry has to outlive the sender** — the WorkspaceDO that staged them hibernates — so the alarm claims and republishes rather than an invocation being held open. Delivery is fenced on the default's generation, so a redelivery is a no-op. **A Sidekick default on a hosted Channel does not take this hop**: its target, the Channel's `parent_sidekicks` row, is in the same `WorkspaceDO` SQLite as the staging, so it is written in the staging transaction. A resource keeps the Queue because it writes the Channel's main conversation. See [`spaces.md`](spaces.md#defaults). |
| Authorization discovery (`ACTIVITY_QUEUE`, `authorization_projection_v1`) | Queue for conversation jobs; in-object for a hosted Channel's parent job | Split | A conversation job reads a `SubstreamAgent`'s attachments and walks away, retried on its own. A parent job for a Channel hosted in `WorkspaceDO` is not sent: its children are that object's `parent_children` rows, so it registers them in the transaction that enqueued it rather than sending a message whose consumer would call back into the same object three times. Sidekick parents keep the Queue (their children are `sidekick_children` rows, which the in-place path does not read). See [`authorization.md`](authorization.md#migration). |
| An unsettled Space operation (`space_intents`), finished by the alarm | In place | Same object | **Retry has to outlive the sender, and there is no caller left to answer.** The request that staged the intent died between its two transactions; the alarm is the only thing that will ever notice. Every kind, a stored `move` included, is finished by the alarm in `WorkspaceDO` itself, through the same path the request takes, acting as the requester read from the local relationship table: a message whose consumer would call straight back into this object bought a Queue hop and a Worker invocation for nothing. One step per intent per alarm (a walk advances one page), after the alarm's other phases, and single-flight with a request running the same intent. The plan is recorded under ids derived from the intent, so a resume replays it rather than planning against a Channel the first attempt changed, and a walk resumes from the cursor on the row. Nothing publishes `space_intent_resume` now; a message already queued is acknowledged by `RetiredQueueMessageSchema` and does nothing, since Spaces are retired. |
| The one-time Space cutover's next page (`ACTIVITY_QUEUE`, `space_bootstrap`) | Queue, then the consumer's typed RPCs | Split | **The sender must not be held open**, and the work has to make progress on an Organization nobody is signed in to — an alarm is the only thing that wakes without a request, and a request is what a Queue does not need. One page per Organization is claimed at a time, and the napkin arithmetic for a fleet-wide forced pass against this shared queue is recorded beside the producer in `apps/api/src/durable-objects/workspace-space-default-publication.ts`, as [deciding without measurement](#deciding-without-measurement) asks. |

## Related documents

- [`architecture.md`](architecture.md) — the deployment surfaces these hops run
  between.
- [`regionalization.md`](regionalization.md) — what a message is allowed to carry
  across the configured deployment boundary, whichever mechanism carries it.
- [`workstream-durable-object.md`](workstream-durable-object.md) — the Durable
  Object hierarchy and its RPC contracts.
- [`access-revocation.md`](access-revocation.md) — a worked example of the two
  mechanisms in one flow: a queue per hop, RPC inside each hop.
- [`type-safety-boundaries.md`](type-safety-boundaries.md) — why every hop parses
  its payload at the boundary rather than trusting a build-time interface.
