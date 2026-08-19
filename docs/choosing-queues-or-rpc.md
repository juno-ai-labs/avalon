# Choosing between a Queue and RPC

Avalon's Workers and Durable Objects talk to each other two ways: a **Cloudflare
Queue**, where the sender writes a message and walks away, and **Workers RPC**
over a service binding or a Durable Object stub, where the caller invokes a
method and waits for what comes back. This document says which to reach for.

**The default is a Queue.** Reach for RPC when the hop has a property from the
[list below](#you-must-use-rpc-when) that a Queue cannot provide — most often a
return value the caller acts on. That is a real list, not a formality: roughly
half of Avalon's inter-resource hops are on it. But when neither list decides it,
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
  the fact is recorded somewhere durable.
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
before you abandon the mechanism.** Avalon's activity queue runs at
`max_batch_timeout: 1` for exactly this reason: at five seconds a Slack unfurl
appeared six seconds after the message, which was a real complaint with a real
user story behind it. The fix was one second, not a service binding.

## What a Queue makes you handle

These are consequences of the platform, not of Avalon, and every consumer has to
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
  your own admission control before you have measured a queue near either.

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
  queues, sharded queues, and fan-out topologies are answers to a measured
  problem. Add them when you have measured it.

The test for all of this: if you find yourself writing infrastructure — retry
schedules, correlation ids, backpressure, delivery receipts — stop and check
whether you have chosen the wrong mechanism and are now paying to reimplement the
right one, or whether you have chosen the right one and are paying to distrust
it.

## Where Avalon stands today

| Hop | Mechanism | Why |
| --- | --- | --- |
| Connector activity into the regional consumer (`ACTIVITY_QUEUE`) | Queue | Fan-in from webhooks and polls; nothing waits on the outcome. |
| Durable Object migration reports into the tracker | Queue | Many objects converge on one registry object, and a deploy or a cutover wakes them together. See [`durable-object-migration-tracking.md`](durable-object-migration-tracking.md). |
| Global ↔ EU bridges (`EU_IDENTITY_BRIDGE`, the routing bridges) | RPC | The caller needs the answer — a membership, a region, a verified delivery. [`regionalization.md`](regionalization.md) owns them. |
| Worker to `SubstreamAgent` product calls (`WorkstreamObjectClient`) | RPC | Reads and writes whose results the request returns to the desktop. |
| `WorkspaceDO` typed product SQL | RPC | A conversation with one specific object, with rows coming back. |

## Related documents

- [`architecture.md`](architecture.md) — the deployment surfaces these hops run
  between.
- [`regionalization.md`](regionalization.md) — what a message is allowed to carry
  across the Global/EU boundary, whichever mechanism carries it.
- [`workstream-durable-object.md`](workstream-durable-object.md) — the Durable
  Object hierarchy and its RPC contracts.
- [`type-safety-boundaries.md`](type-safety-boundaries.md) — why every hop parses
  its payload at the boundary rather than trusting a build-time interface.
